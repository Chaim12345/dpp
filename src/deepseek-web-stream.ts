// ── DeepSeek Web API Stream Provider ──────────────────────
// Registers a custom "deepseek-web" API type with pi-ai's registry.
// Converts chat.deepseek.com SSE responses into pi-ai's
// AssistantMessageEventStream protocol so InteractiveMode can render them.
//
// This is NOT OpenAI-compatible — it uses our custom web-api-client.ts
// which talks to chat.deepseek.com's undocumented web API directly.

import type { Api, Model, Context, SimpleStreamOptions, AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, registerApiProvider } from "@earendil-works/pi-ai";
import {
  loadAuth,
  createSession,
  chatStream,
  parseSseStream,
  withRetry,
  WafTokenExpiredError,
  StaleAuthError,
} from "./web-api-client.js";
import { XmlToolCallParser } from "./xml-toolcall-parser.js";
import type { HarnessState } from "./types.js";

// ReAct-style tool call detection: "Action: <name>\nAction Input: <json>"
interface ReactToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function extractReactToolCalls(text: string): ReactToolCall[] {
  const results: ReactToolCall[] = [];
  const re = /Action:\s*(\S+)\s*\n\s*Action Input:\s*(\{[\s\S]*?\})/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    try {
      results.push({ name: match[1], arguments: JSON.parse(match[2]) });
    } catch { /* skip invalid JSON */ }
  }
  return results;
}

// JSON tool call detection: {"tool": "<name>", "args": {<json>}}
// DeepSeek web API outputs raw JSON when instructed with the system prompt
function extractJsonToolCalls(text: string): ReactToolCall[] {
  const results: ReactToolCall[] = [];
  // Match standalone JSON tool call objects on their own line
  const re = /\{\s*"tool"\s*:\s*"(\w+)"\s*,\s*"args"\s*:\s*(\{[^}]*\})\s*\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    try {
      const args = JSON.parse(match[2]);
      if (args && typeof args === 'object') {
        results.push({ name: match[1], arguments: args });
      }
    } catch { /* skip invalid JSON */ }
  }
  return results;
}

// Tool calls array format detection: {"tool_calls": [{"name": "<name>", "arguments": {<json>}}]}
// This is the format that pi-coding-agent's system prompt instructs models to use
function extractToolCallsArray(text: string): ReactToolCall[] {
  const results: ReactToolCall[] = [];
  
  // Only try to parse if we have what looks like a complete tool_calls object
  const completeMatch = text.match(/\{\s*"tool_calls"\s*:\s*\[[\s\S]*?\]\s*\}/);
  if (!completeMatch) {
    return results; // No complete tool_calls object found
  }
  
  try {
    // Try to parse the complete JSON object
    const parsed = JSON.parse(completeMatch[0]);
    if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
      for (const call of parsed.tool_calls) {
        if (call.name && call.arguments && typeof call.arguments === 'object') {
          results.push({ name: call.name, arguments: call.arguments });
        }
      }
    }
  } catch (e) {
    // JSON parsing failed, ignore
  }
  
  return results;
}

export type DeepSeekWebApi = "deepseek-web";

function baseAssistant(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function ensureSessionId(state: HarnessState, modelType: string): Promise<string> {
  if (state.chatSessionId) return state.chatSessionId;
  if (!state.authToken) {
    const auth = await loadAuth();
    state.authToken = auth.token;
    state.cookieHeader = auth.cookieHeader;
  }
  if (!state.authToken) {
    throw new Error("No DeepSeek auth token found. Set DEEPSEEK_TOKEN or ensure .pi/agent/deepseek_token.txt exists.");
  }
  state.chatSessionId = await createSession(state.authToken, state.cookieHeader, modelType);
  return state.chatSessionId;
}

function extractPrompt(context: Context): string {
  const parts: string[] = [];
  
  const isUsingPiCodingAgent = context.systemPrompt && context.systemPrompt.includes('expert coding assistant operating inside pi');
  console.error(`[DEBUG] Detected pi-coding-agent context: ${isUsingPiCodingAgent}, tools count: ${(context as any).tools?.length || 0}`);
  
  if (isUsingPiCodingAgent) {
    // For pi-coding-agent: use our proven-working system prompt format for DeepSeek
    console.error(`[DEBUG] Replacing pi-coding-agent system prompt with DeepSeek-compatible format`);
    
    const toolDesc = (context as any).tools ? (context as any).tools.map((t: any) => {
      const params = t.parameters?.properties ? Object.entries(t.parameters.properties)
        .map(([k, v]: [string, any]) => {
          const req = (t.parameters?.required || []).includes(k) ? "(required)" : "(optional)";
          return ` - ${k} [${v.type || "any"}] ${req}: ${v.description || ""}`;
        })
        .join('\n') : '';
      return `${t.name}: ${t.description}\n${params}`;
    }).join('\n\n') : '';

    const deepseekSystemPrompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

**Current directory:** ${process.cwd()}

**Tools:**
${toolDesc}

---

**Operating contract:**
1. Continue working until the user's task is actually complete, or until you are blocked by missing credentials, permission, or repeated failing evidence.
2. Use tools for repository facts. Do not guess file contents, command output, test results, or project structure.
3. After each tool result, decide the next concrete action: inspect more, edit, test, or provide the final answer.
4. If tool output shows an error, diagnose it and continue with a corrected action when possible.
5. Do not stop after planning or after the first tool result unless the task is complete.
6. Do not claim success until you have run an appropriate verification command or clearly explain why verification is impossible.

**Tool-call protocol:**
- To use tools, output exactly one JSON object and no markdown fence.
- Do not simulate tool results. The host executes the tool and returns the result.
- Do not use XML tags such as <_calls>, <tool_calls>, or [Tool:name] format.
- You may request multiple independent tool calls in the same JSON object, but prefer sequential calls when later actions depend on earlier results.

**Tool-call JSON examples:**
{"tool_calls":[{"name":"bash","arguments":{"command":"ls -la"}}]}
{"tool_calls":[{"name":"read","arguments":{"path":"package.json"}}]}
{"tool_calls":[{"name":"write","arguments":{"path":"test.txt","content":"hello"}}]}
{"tool_calls":[{"name":"edit","arguments":{"path":"file.txt","old_string":"old","new_string":"new"}}]}

**Final response:**
When the task is complete, answer with a concise summary of what changed, what was verified, and any remaining limitation.`;

    parts.push(deepseekSystemPrompt);
  } else {
    // For agent-test.ts: use original system prompt
    if (context.systemPrompt) {
      console.error(`[DEBUG] Using original system prompt (length: ${context.systemPrompt.length})`);
      parts.push(context.systemPrompt);
    }
    
    // Add fallback tool instructions if needed
    if ((context as any).tools && (context as any).tools.length > 0) {
      const toolDesc = (context as any).tools.map((t: any) => {
        const params = t.parameters?.properties ? Object.entries(t.parameters.properties)
          .map(([k, v]: [string, any]) => {
            const req = (t.parameters?.required || []).includes(k) ? "(required)" : "(optional)";
            return ` - ${k} [${v.type || "any"}] ${req}: ${v.description || ""}`;
          })
          .join('\n') : '';
        return `${t.name}: ${t.description}\n${params}`;
      }).join('\n\n');
      const toolInstructions = `\n[Available Tools]\n${toolDesc}\n\nTo use a tool, output exactly one JSON object per turn:\n{"tool_calls": [{"name": "<tool_name>", "arguments": {"param": "value"}}]}\nDo NOT wrap in markdown fences. Output ONLY the JSON object.`;
      console.error(`[DEBUG] Adding fallback tool instructions for non-pi-coding-agent context`);
      parts.push(toolInstructions);
    }
  }

  for (const message of context.messages.slice(-20)) {
    if (message.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : message.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
      parts.push(`\n[User]\n${text}`);
    } else if (message.role === "assistant") {
      const textParts = message.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text);
      if (textParts.length) parts.push(`\n[Assistant]\n${textParts.join("\n")}`);
    } else if ((message as any).role === "tool") {
      const m = message as any;
      const text = typeof m.content === "string" ? m.content : (m.content || "");
      parts.push(`\n[Tool:${m.name || "unknown"}]\n${text}`);
    } else if (message.role === "toolResult") {
      const text = message.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
      parts.push(`\n[Tool:${message.toolName}]\n${text}`);
    }
  }
  
  const finalPrompt = parts.join("");
  console.error(`[DEBUG] Final prompt length: ${finalPrompt.length}`);
  return finalPrompt;
}

function streamDeepSeekWeb(
  state: HarnessState,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => ReturnType<typeof createAssistantMessageEventStream> {
  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    const assistant = baseAssistant(model);

    void (async () => {
      try {
        const modelType = String((options?.metadata?.model_type as string) || "expert");

        await ensureSessionId(state, modelType);

        const prompt = extractPrompt(context);

        const resp = await withRetry(
          () => chatStream(
            {
              sessionId: state.chatSessionId!,
              prompt,
              parentMessageId: state.parentMessageId,
              modelType,
              thinkingEnabled: false,
              signal: options?.signal,
            },
            {
              authToken: state.authToken,
              cookieHeader: state.cookieHeader,
              powSolver: null,
            },
          ),
          { maxRetries: 2, baseDelayMs: 1000 },
        );

        if (!resp.body) throw new Error("No response body from DeepSeek web API");

        stream.push({ type: "start", partial: assistant });

        // Initialize XML parser for mid-stream tool call detection
        const xmlParser = new XmlToolCallParser();
        let xmlFailed = false;
        xmlParser.init().catch((e) => {
          console.error(`[DEBUG] XML parser init failed:`, e.message);
          xmlFailed = true;
        });

        let textStarted = false;
        let textBlock: { type: "text"; text: string } | null = null;
        let contentIndex = 0;
        let emittedToolCalls = 0;
        const emittedReactCalls = new Set<string>();

        // Track what we've already processed to avoid duplicate parsing
        let lastProcessedLength = 0;

        function closeTextBlock() {
          if (textStarted && textBlock) {
            stream.push({ type: "text_end", contentIndex: contentIndex - 1, content: textBlock.text, partial: assistant });
            textBlock = null;
            textStarted = false;
          }
        }

        function startTextBlock() {
          textBlock = { type: "text", text: "" };
          assistant.content.push(textBlock);
          stream.push({ type: "text_start", contentIndex: contentIndex, partial: assistant });
          textStarted = true;
          contentIndex++;
        }

        function emitToolCall(call: { name: string; arguments: Record<string, unknown> }) {
          closeTextBlock();
          const toolCall = {
            type: "toolCall" as const,
            id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: call.name,
            arguments: call.arguments,
          };
          assistant.content.push(toolCall);
          const tcIndex = contentIndex;
          contentIndex++;
          stream.push({ type: "toolcall_start", contentIndex: tcIndex, partial: assistant });
          stream.push({ type: "toolcall_delta", contentIndex: tcIndex, delta: JSON.stringify(call.arguments), partial: assistant });
          stream.push({ type: "toolcall_end", contentIndex: tcIndex, toolCall, partial: assistant });
          emittedToolCalls++;
        }

        // Accumulate text for tool call detection
        let accumulatedText = "";

        for await (const event of parseSseStream(resp.body)) {
          await new Promise(r => setImmediate(r));
          if (event.type === "content") {
            accumulatedText += event.delta;

            // Feed to XML parser for mid-stream tool call detection
            if (!xmlFailed && xmlParser.isReady) {
              xmlParser.feed(event.delta);
              const xmlCalls = xmlParser.getToolCalls();
              if (xmlCalls.length > 0) {
                console.error(`[DEBUG] XML parser detected ${xmlCalls.length} tool call(s):`, xmlCalls.map(c => c.name));
              }
              for (const call of xmlCalls) {
                emitToolCall(call);
              }
            }

            // Only check for tool calls if we have new content since last check
            if (accumulatedText.length > lastProcessedLength + 10) { // Batch processing
              lastProcessedLength = accumulatedText.length;

              // Check for tool_calls array format ({"tool_calls": [...]})
              const toolCallsArrayCalls = extractToolCallsArray(accumulatedText);
              if (toolCallsArrayCalls.length > 0) {
                console.error(`[DEBUG] ToolCalls array parser detected ${toolCallsArrayCalls.length} tool call(s):`, toolCallsArrayCalls.map(c => c.name));
              }
              for (const call of toolCallsArrayCalls) {
                const callKey = `${call.name}:${JSON.stringify(call.arguments)}`;
                if (!emittedReactCalls.has(callKey)) {
                  emittedReactCalls.add(callKey);
                  emitToolCall(call);
                }
              }

              // Also check for ReAct-style tool calls in accumulated text
              const reactCalls = extractReactToolCalls(accumulatedText);
              if (reactCalls.length > 0) {
                console.error(`[DEBUG] ReAct parser detected ${reactCalls.length} tool call(s):`, reactCalls.map(c => c.name));
              }
              for (const call of reactCalls) {
                const callKey = `${call.name}:${JSON.stringify(call.arguments)}`;
                if (!emittedReactCalls.has(callKey)) {
                  emittedReactCalls.add(callKey);
                  emitToolCall(call);
                }
              }

              // Check for JSON tool calls ({"tool": "...", "args": {...}})
              const jsonCalls = extractJsonToolCalls(accumulatedText);
              if (jsonCalls.length > 0) {
                console.error(`[DEBUG] JSON parser detected ${jsonCalls.length} tool call(s):`, jsonCalls.map(c => c.name));
              }
              for (const call of jsonCalls) {
                const callKey = `${call.name}:${JSON.stringify(call.arguments)}`;
                if (!emittedReactCalls.has(callKey)) {
                  emittedReactCalls.add(callKey);
                  emitToolCall(call);
                }
              }
            }

            // Only start text block if no tool calls were emitted
            if (emittedToolCalls === 0) {
              if (!textStarted) {
                startTextBlock();
              }
              textBlock!.text += event.delta;
              stream.push({ type: "text_delta", contentIndex: contentIndex - 1, delta: event.delta, partial: assistant });
            }
          } else if (event.type === "thinking") {
            // DeepSeek web API sends thinking fragments — skip for now
          } else if (event.type === "done") {
            state.parentMessageId = event.responseMessageId;
            
            // Final check for any remaining tool calls
            const finalToolCalls = extractToolCallsArray(accumulatedText);
            for (const call of finalToolCalls) {
              const callKey = `${call.name}:${JSON.stringify(call.arguments)}`;
              if (!emittedReactCalls.has(callKey)) {
                emittedReactCalls.add(callKey);
                emitToolCall(call);
              }
            }
            
            // Flush any remaining XML tool calls
            if (!xmlFailed && xmlParser.isReady) {
              xmlParser.end();
              const xmlCalls = xmlParser.getToolCalls();
              for (const call of xmlCalls) {
                emitToolCall(call);
              }
            }
            closeTextBlock();
            const doneReason = emittedToolCalls > 0 ? "toolUse" : "stop";
            console.error(`[DEBUG] Emitting done with reason: ${doneReason}, emittedToolCalls: ${emittedToolCalls}`);
            stream.push({
              type: "done",
              reason: doneReason,
              message: {
                ...assistant,
                stopReason: doneReason,
                responseId: event.responseMessageId != null ? String(event.responseMessageId) : undefined,
              },
            });
            xmlParser.destroy();
            return;
          } else if (event.type === "error") {
            const errMessage: AssistantMessage = {
              ...assistant,
              stopReason: "error",
              errorMessage: "DeepSeek web API error",
            };
            stream.push({ type: "error", reason: "error", error: errMessage });
            stream.end(errMessage);
            xmlParser.destroy();
            return;
          } else if (event.type === "tool_calls") {
            // Pre-parsed tool calls from SSE (rare, but handle if they appear)
            for (const call of event.calls) {
              emitToolCall(call);
            }
          }
        }

        // Stream ended without explicit done event
        if (!xmlFailed && xmlParser.isReady) {
          xmlParser.end();
          const xmlCalls = xmlParser.getToolCalls();
          for (const call of xmlCalls) {
            emitToolCall(call);
          }
        }
        closeTextBlock();
        xmlParser.destroy();
        stream.push({
          type: "done",
          reason: emittedToolCalls > 0 ? "toolUse" : "stop",
          message: {
            ...assistant,
            stopReason: emittedToolCalls > 0 ? "toolUse" : "stop",
          },
        });
      } catch (error) {
        if (error instanceof WafTokenExpiredError || error instanceof StaleAuthError) {
          state.authToken = undefined;
          state.chatSessionId = undefined;
          stream.push({ type: "error", reason: "error", error: { ...assistant, stopReason: "error", errorMessage: error.message } });
        } else {
          console.error("DeepSeek stream error:", error);
          stream.push({ type: "error", reason: "error", error: { ...assistant, stopReason: "error", errorMessage: String(error) } });
        }
        stream.end();
      }
    })();

    return stream;
  };
}

let registered = false;

export function registerDeepSeekWebApi(state: HarnessState): void {
  if (registered) return;
  registered = true;

  registerApiProvider<DeepSeekWebApi>({
    api: "deepseek-web",
    provider: "deepseek-web",
    models: {
      "deepseek-web/expert": { name: "DeepSeek Expert (Web)" },
      "deepseek-web/grok": { name: "DeepSeek Grok (Web)" },
    },
    stream: streamDeepSeekWeb(state),
  });
}

export function createDeepSeekWebStreamFn(state: HarnessState) {
  return streamDeepSeekWeb(state);
}