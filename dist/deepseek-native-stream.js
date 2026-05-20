import { createAssistantMessageEventStream } from "../node_modules/@mariozechner/pi-ai/dist/utils/event-stream.js";
import { loadAuth, createSession, chatStream, parseSseStream, } from "./web-api-client.js";
async function ensureSession(state, modelType) {
    if (state.chatSessionId)
        return state.chatSessionId;
    if (!state.authToken) {
        const auth = await loadAuth();
        state.authToken = auth.token;
        state.cookieHeader = auth.cookieHeader;
    }
    const sessionId = await createSession(state.authToken, state.cookieHeader, modelType);
    state.chatSessionId = sessionId;
    return state.chatSessionId;
}
function extractPrompt(context, memorySummary) {
    const parts = [];
    if (context.systemPrompt)
        parts.push(`[System]\n${context.systemPrompt}`);
    if (memorySummary)
        parts.push(`[Memory]\n${memorySummary}`);
    for (const message of context.messages.slice(-6)) {
        if (message.role === "user") {
            const text = typeof message.content === "string"
                ? message.content
                : message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
            parts.push(`[User]\n${text}`);
        }
        else if (message.role === "toolResult") {
            const text = message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
            parts.push(`[Tool:${message.toolName}]\n${text}`);
        }
    }
    return parts.join("\n\n");
}
function baseAssistant(model) {
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
export function createDeepSeekNativeStream(state) {
    return (model, context, options) => {
        const stream = createAssistantMessageEventStream();
        void (async () => {
            const assistant = baseAssistant(model);
            try {
                const modelType = String(options?.metadata?.model_type || "expert");
                const sessionId = await ensureSession(state, modelType);
                const prompt = extractPrompt(context, state.memorySummary);
                const resp = await chatStream({ sessionId, prompt, parentMessageId: state.parentMessageId, modelType, thinkingEnabled: false, signal: options?.signal }, { authToken: state.authToken, cookieHeader: state.cookieHeader, powSolver: null });
                if (!resp.body)
                    throw new Error("No response body");
                stream.push({ type: "start", partial: assistant });
                let textStarted = false;
                let textBlock = null;
                for await (const event of parseSseStream(resp.body)) {
                    if (event.type === "content") {
                        if (!textStarted) {
                            textBlock = { type: "text", text: "" };
                            assistant.content.push(textBlock);
                            stream.push({ type: "text_start", contentIndex: 0, partial: assistant });
                            textStarted = true;
                        }
                        textBlock.text += event.delta;
                        stream.push({ type: "text_delta", contentIndex: 0, delta: event.delta, partial: assistant });
                    }
                    else if (event.type === "thinking") {
                        continue;
                    }
                    else if (event.type === "done") {
                        state.parentMessageId = event.responseMessageId;
                        if (textStarted && textBlock) {
                            stream.push({ type: "text_end", contentIndex: 0, content: textBlock.text, partial: assistant });
                        }
                        stream.push({ type: "done", reason: "stop", partial: assistant });
                        stream.end({ ...assistant, stopReason: "stop", responseId: event.responseMessageId ?? undefined });
                        return;
                    }
                    else if (event.type === "error") {
                        const errAssistant = { ...assistant, stopReason: "error", errorMessage: "API error" };
                        stream.push({ type: "error", reason: "error", error: errAssistant });
                        stream.end(errAssistant);
                        return;
                    }
                }
                if (textStarted && textBlock) {
                    stream.push({ type: "text_end", contentIndex: 0, content: textBlock.text, partial: assistant });
                }
                stream.push({ type: "done", reason: "stop", partial: assistant });
                stream.end({ ...assistant, stopReason: "stop", responseId: state.parentMessageId ?? undefined });
            }
            catch (error) {
                const err = error instanceof Error ? error.message : String(error);
                const message = { ...assistant, stopReason: "error", errorMessage: err };
                stream.push({ type: "error", reason: "error", error: message });
                stream.end(message);
            }
        })();
        return stream;
    };
}
