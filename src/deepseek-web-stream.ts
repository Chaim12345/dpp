// ── DeepSeek Web API Stream Provider ──────────────────────
import type { Api, Model, Context, SimpleStreamOptions, AssistantMessage, TextContent, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, registerApiProvider } from "@earendil-works/pi-ai";
import { createEventParser } from "vectorjson";
import {
  loadAuth, createSession, chatStream, parseSseStream, withRetry,
  WafTokenExpiredError, StaleAuthError,
} from "./web-api-client.js";
import type { HarnessState } from "./types.js";
import { extractToolCalls, stripToolCalls, type ToolCall as HarnessToolCall } from "./tool-registry.js";

export type DeepSeekWebApi = "deepseek-web";

function baseAssistant(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };
}

async function ensureSessionId(state: HarnessState, modelType: string): Promise<string> {
  if (state.chatSessionId) return state.chatSessionId;
  if (!state.authToken) { const auth = await loadAuth(); state.authToken = auth.token; state.cookieHeader = auth.cookieHeader; }
  if (!state.authToken) throw new Error("No DeepSeek auth token found.");
  state.chatSessionId = await createSession(state.authToken, state.cookieHeader, modelType);
  return state.chatSessionId;
}

// Keep pi's native prompt, append tool format instructions
function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function extractPrompt(context: Context): string {
  const parts: string[] = [];
  const tools = context.tools || [];
  const isPi = Boolean(context.systemPrompt?.includes("expert coding assistant operating inside pi"));
  if (isPi) {
    parts.push(context.systemPrompt ?? "");
    parts.push("\n\n---\n\n**Tool-call format (JSON):**\nWhen you need to use tools, output exactly one JSON object.\n\nJSON examples:\n" +
      '{"tool_calls":[{"name":"bash","arguments":{"command":"ls -la"}}]}\n' +
      '{"tool_calls":[{"name":"read","arguments":{"path":"package.json"}}]}\n' +
      '{"tool_calls":[{"name":"write","arguments":{"path":"test.txt","content":"hello"}}]}\n' +
      '{"tool_calls":[{"name":"grep","arguments":{"pattern":"TODO","path":"src/"}}]}\n' +
      '{"tool_calls":[{"name":"find","arguments":{"pattern":"*.ts","path":"src/"}}]}\n' +
      '{"tool_calls":[{"name":"bash","arguments":{"command":"c1"}},{"name":"bash","arguments":{"command":"c2"}}]}');
    // Append tool descriptions
    if (tools.length > 0) {
      const desc = tools.map(t => {
        const parameters = t.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined;
        const params = parameters?.properties
          ? Object.entries(parameters.properties).map(([k, v]) => {
              const schema = v as { type?: string; description?: string };
              const req = (parameters.required || []).includes(k) ? "(req)" : "(opt)";
              return "  - " + k + " [" + (schema.type || "any") + "]: " + (schema.description || "");
            }).join("\n")
          : "";
        return t.name + ": " + (t.description || "") + "\n" + params;
      }).join("\n\n");
      parts.push("\n\n**Available tools:**\n" + desc);
    }
  } else if (context.systemPrompt) {
    parts.push(context.systemPrompt);
  }
  // Conversation history
  for (const m of context.messages ? context.messages.slice(-20) : []) {
    if (m.role === "user") {
      const text = textFromContent(m.content);
      parts.push("\n[User]\n" + text);
    } else if (m.role === "assistant") {
      const tp = m.content.filter((c): c is TextContent => c.type === "text").map(c => c.text);
      if (tp.length) parts.push("\n[Assistant]\n" + tp.join("\n"));
    } else if (m.role === "toolResult") {
      const text = textFromContent(m.content);
      parts.push("\n[Tool:" + m.toolName + "]\n" + text);
    }
  }
  return parts.join("");
}

// Extract XML <invoke> and bold-markdown <**Calling:**> tool calls
function extractNonJsonToolCalls(buf: string, toolNames: Set<string>): HarnessToolCall[] {
  const results: HarnessToolCall[] = [];
  const seen = new Set();
  function addResult(n: string, args: Record<string, unknown>) {
    if (!toolNames.has(n)) return;
    const key = n + JSON.stringify(args);
    if (seen.has(key)) return; seen.add(key);
    if (Object.keys(args).length > 0) results.push({ name: n, arguments: args });
  }
  // XML: <invoke name="tool">...parameters...</invoke>
  const invokeRe = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/g;
  let m;
  while ((m = invokeRe.exec(buf)) !== null) {
    const name = m[1];
    if (!toolNames.has(name)) continue;
    const args: Record<string, unknown> = {};
    const paramRe = /<(?:parameter|param)\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:parameter|param)>/g;
    let pm;
    while ((pm = paramRe.exec(m[2])) !== null) {
      let val: unknown = pm[2].trim();
      try { val = JSON.parse(String(val)); } catch {}
      args[pm[1]] = val;
    }
    addResult(name, args);
  }
  // Bold markdown "Calling:" format
  const callingRe = /\*\*Calling:\*\*\s+(\w+)([\s\S]*?)(?=\*\*Calling:|\*\*FINAL:|$)/g;
  let cm;
  while ((cm = callingRe.exec(buf)) !== null) {
    const name = cm[1];
    if (!toolNames.has(name)) continue;
    const args: Record<string, unknown> = {};
    const paramRe2 = /\*\*parameter name=["']([^"']+)["']\*\*\s*([^\n*]+(?:\n(?!\s*\*\*)[^\n]*)*)/g;
    let pm2;
    const body = cm[2];
    while ((pm2 = paramRe2.exec(body)) !== null) {
      let val: unknown = pm2[2].trim();
      try { val = JSON.parse(String(val)); } catch {}
      args[pm2[1]] = val;
    }
    addResult(name, args);
  }
  return results;
}

function findFirstMarker(text: string, markers: string[]): { index: number; marker: string } | null {
  let first: { index: number; marker: string } | null = null;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index === -1) continue;
    if (!first || index < first.index) first = { index, marker };
  }
  return first;
}

function filterVisibleDelta(delta: string, state: { suppressing: boolean; pending: string }): string {
  const startMarkers = [
    '{"tool_calls"', '{"_calls"', '{"tool"',
    "<tool_calls>", "<function_calls>", "<_calls>", "<pi-tool-calls>",
    "<｜｜DSML｜｜tool_calls>", "<invoke", "<function_call",
  ];
  const endMarkers = [
    "</tool_calls>", "</function_calls>", "</_calls>", "</pi-tool-calls>",
    "</｜｜DSML｜｜tool_calls>", "</invoke>", "</function_call>",
  ];
  const longestMarkerLength = Math.max(...startMarkers.map((marker) => marker.length));
  let rest = state.pending + delta;
  state.pending = "";
  let visible = "";

  while (rest.length > 0) {
    if (state.suppressing) {
      const end = findFirstMarker(rest, endMarkers);
      if (!end) return visible;
      rest = rest.slice(end.index + end.marker.length);
      state.suppressing = false;
      continue;
    }

    const start = findFirstMarker(rest, startMarkers);
    if (!start) {
      const keep = Math.min(longestMarkerLength - 1, rest.length);
      const emitLength = rest.length - keep;
      visible += rest.slice(0, emitLength);
      state.pending = rest.slice(emitLength);
      break;
    }

    visible += rest.slice(0, start.index);
    rest = rest.slice(start.index + start.marker.length);
    state.suppressing = true;
  }

  return visible;
}

function streamDeepSeekWeb(state: HarnessState) {
  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    const assistant = baseAssistant(model);
    const tools = (context.tools || []);
    const toolNames = new Set(tools.map(t => t.name));

    void (async () => {
      try {
        const modelType = String(options?.metadata?.model_type || "expert");
        const sessionId = await ensureSessionId(state, modelType);
        const prompt = extractPrompt(context);
        const resp = await withRetry(
          () => chatStream(
            {
              sessionId,
              prompt,
              parentMessageId: state.parentMessageId,
              modelType,
              thinkingEnabled: false,
              signal: options?.signal,
            },
            { authToken: state.authToken, cookieHeader: state.cookieHeader, powSolver: null },
          ),
          { maxRetries: 2, baseDelayMs: 1000 },
        );
        if (!resp.body) throw new Error("No response body");
        stream.push({ type: "start", partial: assistant });

        let textStarted = false;
        let textBlock: TextContent | null = null;
        let contentIndex = 0;
        let emittedToolCalls = 0;
        const emittedKeys = new Set();
        const visibleFilterState = { suppressing: false, pending: "" };

        // Vectorjson streaming JSON parser
        const vjParser = createEventParser();
        vjParser.on("tool_calls[*]", (e: any) => {
          const tc = e.value as Partial<HarnessToolCall> | undefined;
          if (tc && typeof tc === "object" && typeof tc.name === "string" && tc.arguments && typeof tc.arguments === "object") {
            const key = tc.name + ":" + JSON.stringify(tc.arguments);
            if (!emittedKeys.has(key)) { emittedKeys.add(key); emitToolCall({ name: tc.name, arguments: tc.arguments }); }
          }
        });

        const xmlBuf = { value: "" };

        function closeTextBlock() {
          if (textStarted && textBlock) {
            stream.push({ type: "text_end", contentIndex: contentIndex - 1, content: textBlock.text, partial: assistant });
            textBlock = null; textStarted = false;
          }
        }

        function startTextBlock() {
          textBlock = { type: "text", text: "" };
          assistant.content.push(textBlock);
          stream.push({ type: "text_start", contentIndex: contentIndex, partial: assistant });
          textStarted = true; contentIndex++;
        }

        function emitVisibleText(delta: string) {
          if (!delta) return;
          if (!textStarted) startTextBlock();
          textBlock!.text += delta;
          stream.push({ type: "text_delta", contentIndex: contentIndex - 1, delta, partial: assistant });
        }

        function flushVisiblePending() {
          if (emittedToolCalls > 0 || visibleFilterState.suppressing || !visibleFilterState.pending) return;
          const pending = visibleFilterState.pending;
          visibleFilterState.pending = "";
          emitVisibleText(pending);
        }

        function emitToolCall(call: HarnessToolCall) {
          closeTextBlock();
          const tc: ToolCall = {
            type: "toolCall",
            id: "tc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
            name: call.name,
            arguments: call.arguments,
          };
          assistant.content.push(tc);
          const idx = contentIndex; contentIndex++;
          stream.push({ type: "toolcall_start", contentIndex: idx, partial: assistant });
          stream.push({ type: "toolcall_delta", contentIndex: idx, delta: JSON.stringify(call.arguments), partial: assistant });
          stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: tc, partial: assistant });
          emittedToolCalls++;
        }

        function flushAllParsers() {
          closeTextBlock();
          try {
            const val = vjParser.getValue() as { tool_calls?: HarnessToolCall[] } | undefined;
            if (val?.tool_calls && Array.isArray(val.tool_calls)) {
              for (const tc of val.tool_calls) {
                if (tc && tc.name && tc.arguments) {
                  const key = tc.name + ":" + JSON.stringify(tc.arguments);
                  if (!emittedKeys.has(key)) { emittedKeys.add(key); emitToolCall(tc); }
                }
              }
            }
          } catch {}
          const calls = [
            ...(extractToolCalls(xmlBuf.value) ?? []),
            ...extractNonJsonToolCalls(xmlBuf.value, toolNames),
          ];
          for (const call of calls) {
            const key = call.name + ":" + JSON.stringify(call.arguments);
            if (!emittedKeys.has(key)) { emittedKeys.add(key); emitToolCall(call); }
          }
        }

        for await (const event of parseSseStream(resp.body)) {
          await new Promise(r => setImmediate(r));
          if (event.type === "content") {
            vjParser.feed(event.delta);
            xmlBuf.value += event.delta;
            const nonJson = [
              ...(extractToolCalls(xmlBuf.value) ?? []),
              ...extractNonJsonToolCalls(xmlBuf.value, toolNames),
            ];
            for (const call of nonJson) {
              const key = call.name + ":" + JSON.stringify(call.arguments);
              if (!emittedKeys.has(key)) { emittedKeys.add(key); emitToolCall(call); }
            }
            if (emittedToolCalls === 0) {
              const visibleDelta = filterVisibleDelta(event.delta, visibleFilterState);
              emitVisibleText(visibleDelta);
            }
          } else if (event.type === "done") {
            state.parentMessageId = event.responseMessageId;
            flushVisiblePending();
            flushAllParsers();
            vjParser.destroy();
            const reason = emittedToolCalls > 0 ? "toolUse" : "stop";
            stream.push({ type: "done", reason, message: Object.assign({}, assistant, { stopReason: reason, responseId: event.responseMessageId != null ? String(event.responseMessageId) : undefined }) });
            return;
          } else if (event.type === "error") {
            vjParser.destroy();
            const errMsg = Object.assign({}, assistant, { stopReason: "error", errorMessage: "DeepSeek web API error" });
            stream.push({ type: "error", reason: "error", error: errMsg });
            stream.end(errMsg);
            return;
          } else if (event.type === "tool_calls") {
            for (const call of event.calls) {
              const key = call.name + ":" + JSON.stringify(call.arguments);
              if (!emittedKeys.has(key)) { emittedKeys.add(key); emitToolCall(call); }
            }
          }
        }
        flushVisiblePending();
        flushAllParsers();
        vjParser.destroy();
        stream.push({ type: "done", reason: emittedToolCalls > 0 ? "toolUse" : "stop", message: Object.assign({}, assistant, { stopReason: emittedToolCalls > 0 ? "toolUse" : "stop" }) });
      } catch (error) {
        if (error instanceof WafTokenExpiredError || error instanceof StaleAuthError) {
          state.authToken = null; state.chatSessionId = null;
        }
        console.error("DeepSeek stream error:", error);
        stream.push({ type: "error", reason: "error", error: Object.assign({}, assistant, { stopReason: "error", errorMessage: String(error) }) });
        stream.end();
      }
    })();
    return stream;
  };
}

let registered = false;

export function registerDeepSeekWebApi(state: HarnessState) {
  if (registered) return;
  registered = true;
  registerApiProvider({
    api: "deepseek-web",
    stream: streamDeepSeekWeb(state),
    streamSimple: streamDeepSeekWeb(state),
  });
}

export function createDeepSeekWebStreamFn(state: HarnessState) {
  return streamDeepSeekWeb(state);
}
