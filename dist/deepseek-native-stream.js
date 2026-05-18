import { createAssistantMessageEventStream } from "../node_modules/@mariozechner/pi-ai/dist/utils/event-stream.js";
const BASE_URL = process.env.DEEPSEEK_NATIVE_BASE_URL || "http://127.0.0.1:8001";
async function ensureSession(state, modelType) {
    if (state.chatSessionId)
        return state.chatSessionId;
    const resp = await fetch(`${BASE_URL}/native/session/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model_type: modelType }),
    });
    if (!resp.ok)
        throw new Error(`session create failed: ${resp.status}`);
    const json = await resp.json();
    state.chatSessionId = json.session_id;
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
                const resp = await fetch(`${BASE_URL}/native/chat/stream`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        session_id: sessionId,
                        parent_message_id: state.parentMessageId,
                        prompt,
                        model_type: modelType,
                        thinking_enabled: false,
                        search_enabled: false,
                        ref_file_ids: [],
                    }),
                    signal: options?.signal,
                });
                if (!resp.ok || !resp.body)
                    throw new Error(`native stream failed: ${resp.status}`);
                stream.push({ type: "start", partial: assistant });
                let textStarted = false;
                let textBlock = null;
                const decoder = new TextDecoder();
                let buffer = "";
                for await (const chunk of resp.body) {
                    buffer += decoder.decode(chunk, { stream: true });
                    const pieces = buffer.split("\n\n");
                    buffer = pieces.pop() || "";
                    for (const piece of pieces) {
                        const line = piece.trim();
                        if (!line.startsWith("data: "))
                            continue;
                        const payload = line.slice(6);
                        if (payload === "[DONE]")
                            continue;
                        const event = JSON.parse(payload);
                        if (event.type === "content_delta") {
                            if (!textStarted) {
                                textBlock = { type: "text", text: "" };
                                assistant.content.push(textBlock);
                                stream.push({ type: "text_start", contentIndex: 0, partial: assistant });
                                textStarted = true;
                            }
                            textBlock.text += event.delta;
                            stream.push({ type: "text_delta", contentIndex: 0, delta: event.delta, partial: assistant });
                        }
                        else if (event.type === "thinking_delta") {
                            continue;
                        }
                        else if (event.type === "done") {
                            state.parentMessageId = event.response_message_id;
                            if (textStarted && textBlock) {
                                stream.push({ type: "text_end", contentIndex: 0, content: textBlock.text, partial: assistant });
                            }
                            stream.push({ type: "done", reason: "stop", partial: assistant });
                            stream.end({ ...assistant, stopReason: "stop", responseId: event.response_message_id || undefined });
                            return;
                        }
                        else if (event.type === "error") {
                            const errAssistant = { ...assistant, stopReason: "error", errorMessage: event.error };
                            stream.push({ type: "error", reason: "error", error: errAssistant });
                            stream.end(errAssistant);
                            return;
                        }
                    }
                }
                if (textStarted && textBlock) {
                    stream.push({ type: "text_end", contentIndex: 0, content: textBlock.text, partial: assistant });
                }
                stream.push({ type: "done", reason: "stop", partial: assistant });
                stream.end({ ...assistant, stopReason: "stop", responseId: state.parentMessageId || undefined });
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
