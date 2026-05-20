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
  if (context.systemPrompt) parts.push(`[System]\n${context.systemPrompt}`);
  for (const message of context.messages.slice(-20)) {
    if (message.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : message.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
      parts.push(`[User]\n${text}`);
    } else if (message.role === "assistant") {
      const textParts = message.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text);
      if (textParts.length) parts.push(`[Assistant]\n${textParts.join("\n")}`);
    } else if (message.role === "toolResult") {
      const text = message.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
      parts.push(`[Tool:${message.toolName}]\n${text}`);
    }
  }
  return parts.join("\n\n");
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

        // Accumulate text for ReAct-style detection
        let accumulatedText = "";
        let lastReactCheckPos = 0;

        for await (const event of parseSseStream(resp.body)) {
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

            // Also check for ReAct-style tool calls in accumulated text
            // Only check from last position to avoid re-emitting
            const reactCalls = extractReactToolCalls(accumulatedText);
            if (reactCalls.length > 0) {
              console.error(`[DEBUG] ReAct parser detected ${reactCalls.length} tool call(s):`, reactCalls.map(c => c.name));
            }
            for (const call of reactCalls) {
              // Deduplicate: only emit if we haven't seen this exact call
              const callKey = `${call.name}:${JSON.stringify(call.arguments)}`;
              if (!emittedReactCalls.has(callKey)) {
                emittedReactCalls.add(callKey);
                emitToolCall(call);
              }
            }

            if (!textStarted) {
              startTextBlock();
            }
            textBlock!.text += event.delta;
            stream.push({ type: "text_delta", contentIndex: contentIndex - 1, delta: event.delta, partial: assistant });
          } else if (event.type === "thinking") {
            // DeepSeek web API sends thinking fragments — skip for now
          } else if (event.type === "done") {
            state.parentMessageId = event.responseMessageId;
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
            responseId: state.parentMessageId != null ? String(state.parentMessageId) : undefined,
          },
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const errMessage: AssistantMessage = {
          ...assistant,
          stopReason: "error",
          errorMessage: msg,
        };
        stream.push({ type: "error", reason: "error", error: errMessage });
        stream.end(errMessage);
      }
    })();

    return stream;
  };
}

let registered = false;

export function registerDeepSeekWebApi(state: HarnessState): void {
  if (registered) return;
  registered = true;

  const streamFn = streamDeepSeekWeb(state);

  registerApiProvider({
    api: "deepseek-web" as Api,
    stream: streamFn as any,
    streamSimple: streamFn as any,
  }, "deepseek-web-harness");
}

export function createDeepSeekWebStreamFn(state: HarnessState) {
  return streamDeepSeekWeb(state);
}
