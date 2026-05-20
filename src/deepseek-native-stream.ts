import { type Context, type Model, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "../node_modules/@mariozechner/pi-ai/dist/utils/event-stream.js";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { HarnessState } from "./types.js";
import {
  loadAuth,
  createSession,
  chatStream,
  parseSseStream,
} from "./web-api-client.js";
import { XmlToolCallParser } from "./xml-toolcall-parser.js";

// ReAct-style tool call detection: "Action: <name>\nAction Input: <json>"
function extractReactToolCalls(text: string): { name: string; arguments: Record<string, unknown> }[] {
  const results: { name: string; arguments: Record<string, unknown> }[] = [];
  const re = /Action:\s*(\S+)\s*\n\s*Action Input:\s*(\{[\s\S]*?\})/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    try {
      results.push({ name: match[1], arguments: JSON.parse(match[2]) });
    } catch { /* skip invalid JSON */ }
  }
  return results;
}

// "Tool <name>(<json>)" format detection
function extractToolParenCalls(text: string): { name: string; arguments: Record<string, unknown> }[] {
  const results: { name: string; arguments: Record<string, unknown> }[] = [];
  const re = /Tool\s+(\w+)\s*\(([\s\S]*?)\)\s*$/;
  const match = re.exec(text);
  if (match) {
    try {
      results.push({ name: match[1], arguments: JSON.parse(match[2]) });
    } catch { /* skip invalid JSON */ }
  }
  return results;
}

// "Tool: <name>\n\nArguments: <json>" format detection
function extractToolColonCalls(text: string): { name: string; arguments: Record<string, unknown> }[] {
  const results: { name: string; arguments: Record<string, unknown> }[] = [];
  // Match "Tool: name" followed by newline(s) and "Arguments: {json}"
  // Use non-greedy match and don't require completion
  const re = /Tool:\s*(\w+)\s*\n+\s*Arguments:\s*(\{[\s\S]*\})/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    try {
      results.push({ name: match[1], arguments: JSON.parse(match[2]) });
    } catch { /* skip invalid JSON - might still be streaming */ }
  }
  return results;
}

async function ensureSession(state: HarnessState, modelType: string): Promise<string> {
  if (state.chatSessionId) return state.chatSessionId;
  if (!state.authToken) {
    const auth = await loadAuth();
    state.authToken = auth.token;
    state.cookieHeader = auth.cookieHeader;
  }
  const sessionId = await createSession(
    state.authToken!,
    state.cookieHeader!,
    modelType,
  );
  state.chatSessionId = sessionId;
  return state.chatSessionId;
}

function extractPrompt(context: Context, memorySummary: string): string {
  const parts: string[] = [];
  if (context.systemPrompt) parts.push(`[System]\n${context.systemPrompt}`);
  if (memorySummary) parts.push(`[Memory]\n${memorySummary}`);

  // Add tool definitions so the model knows what's available
  if (context.tools && context.tools.length > 0) {
    const toolDesc = context.tools.map(t => {
      const params = t.parameters?.properties ? Object.entries(t.parameters.properties)
        .map(([k, v]: [string, any]) => `  - ${k}: ${v.description || v.type || 'any'}`)
        .join('\n') : '';
      return `${t.name}: ${t.description}\n${params}`;
    }).join('\n\n');
    parts.push(`[Available Tools]\n${toolDesc}\n\nTo use a tool, output:\nTool: <tool_name>\n\nArguments: {"param": "value"}`);
  }

  for (const message of context.messages.slice(-6)) {
    if (message.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      parts.push(`[User]\n${text}`);
    } else if (message.role === "toolResult") {
      const text = message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      parts.push(`[Tool:${message.toolName}]\n${text}`);
    }
  }
  return parts.join("\n\n");
}

function baseAssistant(model: Model<any>): any {
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

export function createDeepSeekNativeStream(state: HarnessState): StreamFn {
  return (model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const assistant = baseAssistant(model);
      try {
        const modelType = String((options?.metadata?.model_type as string) || "expert");
        const sessionId = await ensureSession(state, modelType);
        const prompt = extractPrompt(context, state.memorySummary);

        const resp = await chatStream(
          { sessionId, prompt, parentMessageId: state.parentMessageId, modelType, thinkingEnabled: false, signal: options?.signal },
          { authToken: state.authToken, cookieHeader: state.cookieHeader, powSolver: null },
        );
        if (!resp.body) throw new Error("No response body");

        stream.push({ type: "start", partial: assistant });
        let textStarted = false;
        let textBlock: any = null;
        let contentIndex = 0;
        let emittedToolCalls = 0;
        const emittedReactCalls = new Set<string>();
        let accumulatedText = "";

        // Initialize XML parser
        const xmlParser = new XmlToolCallParser();
        let xmlFailed = false;
        xmlParser.init().catch(() => { xmlFailed = true; });

        function closeTextBlock() {
          if (textStarted && textBlock) {
            stream.push({ type: "text_end", contentIndex: contentIndex - 1, content: textBlock.text, partial: assistant } as any);
            textBlock = null;
            textStarted = false;
          }
        }

        function startTextBlock() {
          textBlock = { type: "text", text: "" };
          assistant.content.push(textBlock);
          stream.push({ type: "text_start", contentIndex: contentIndex, partial: assistant } as any);
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
          stream.push({ type: "toolcall_start", contentIndex: tcIndex, partial: assistant } as any);
          stream.push({ type: "toolcall_delta", contentIndex: tcIndex, delta: JSON.stringify(call.arguments), partial: assistant } as any);
          stream.push({ type: "toolcall_end", contentIndex: tcIndex, toolCall, partial: assistant } as any);
          emittedToolCalls++;
        }

        for await (const event of parseSseStream(resp.body)) {
          if (event.type === "content") {
            accumulatedText += event.delta;

            // Feed to XML parser for mid-stream tool call detection
            if (!xmlFailed && xmlParser.isReady) {
              xmlParser.feed(event.delta);
              const xmlCalls = xmlParser.getToolCalls();
              for (const call of xmlCalls) {
                emitToolCall(call);
              }
            }

            // If XML parser found tool calls, end stream immediately
            if (emittedToolCalls > 0) {
              closeTextBlock();
              xmlParser.destroy();
              stream.push({ type: "done", reason: "toolUse", message: assistant } as any);
              stream.end({ ...assistant, stopReason: "toolUse", responseId: state.parentMessageId ?? undefined });
              return;
            }

            // Also check for ReAct-style tool calls
            const reactCalls = extractReactToolCalls(accumulatedText);
            for (const call of reactCalls) {
              const callKey = `react:${call.name}:${JSON.stringify(call.arguments)}`;
              if (!emittedReactCalls.has(callKey)) {
                emittedReactCalls.add(callKey);
                emitToolCall(call);
              }
            }

            // If ReAct parser found tool calls, end stream immediately
            if (emittedToolCalls > 0) {
              closeTextBlock();
              xmlParser.destroy();
              stream.push({ type: "done", reason: "toolUse", message: assistant } as any);
              stream.end({ ...assistant, stopReason: "toolUse", responseId: state.parentMessageId ?? undefined });
              return;
            }

            // Also check for "Tool <name>(<json>)" format
            const parenCalls = extractToolParenCalls(accumulatedText);
            for (const call of parenCalls) {
              const callKey = `paren:${call.name}:${JSON.stringify(call.arguments)}`;
              if (!emittedReactCalls.has(callKey)) {
                emittedReactCalls.add(callKey);
                emitToolCall(call);
              }
            }

            // If paren parser found tool calls, end stream immediately
            if (emittedToolCalls > 0) {
              closeTextBlock();
              xmlParser.destroy();
              stream.push({ type: "done", reason: "toolUse", message: assistant } as any);
              stream.end({ ...assistant, stopReason: "toolUse", responseId: state.parentMessageId ?? undefined });
              return;
            }

            // Also check for "Tool: <name>\n\nArguments: <json>" format
            const colonCalls = extractToolColonCalls(accumulatedText);
            for (const call of colonCalls) {
              const callKey = `colon:${call.name}:${JSON.stringify(call.arguments)}`;
              if (!emittedReactCalls.has(callKey)) {
                emittedReactCalls.add(callKey);
                emitToolCall(call);
              }
            }

            // If colon parser found tool calls, end stream immediately
            if (emittedToolCalls > 0) {
              closeTextBlock();
              xmlParser.destroy();
              stream.push({ type: "done", reason: "toolUse", message: assistant } as any);
              stream.end({ ...assistant, stopReason: "toolUse", responseId: state.parentMessageId ?? undefined });
              return;
            }

            if (!textStarted) {
              startTextBlock();
            }
            textBlock.text += event.delta;
            stream.push({ type: "text_delta", contentIndex: contentIndex - 1, delta: event.delta, partial: assistant } as any);
          } else if (event.type === "thinking") {
            continue;
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
            xmlParser.destroy();
            const doneReason = emittedToolCalls > 0 ? "toolUse" : "stop";
            stream.push({ type: "done", reason: doneReason, message: assistant } as any);
            stream.end({ ...assistant, stopReason: doneReason, responseId: event.responseMessageId ?? undefined });
            return;
          } else if (event.type === "error") {
            const errAssistant = { ...assistant, stopReason: "error", errorMessage: "API error" };
            stream.push({ type: "error", reason: "error", error: errAssistant });
            stream.end(errAssistant);
            xmlParser.destroy();
            return;
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
        const doneReason = emittedToolCalls > 0 ? "toolUse" : "stop";
        stream.push({ type: "done", reason: doneReason, message: assistant } as any);
        stream.end({ ...assistant, stopReason: doneReason, responseId: state.parentMessageId ?? undefined });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        const message: any = { ...assistant, stopReason: "error", errorMessage: err };
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
      }
    })();
    return stream;
  };
}
