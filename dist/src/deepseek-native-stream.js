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
export function createDeepSeekNativeStream(state) {
    return (model, context, options) => {
        const stream = new AssistantMessageEventStream();
        void (async () => {
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
                const assistant = {
                    role: "assistant",
                    api: model.api,
                    provider: model.provider,
                    model: model.id,
                    content: [],
                    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                    stopReason: "stop",
                    timestamp: Date.now(),
                };
                stream.push({ type: "start", partial: assistant });
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
                            stream.push({ type: "text_delta", delta: event.delta });
                        }
                        else if (event.type === "thinking_delta") {
                            stream.push({ type: "thinking_delta", delta: event.delta });
                        }
                        else if (event.type === "done") {
                            state.parentMessageId = event.response_message_id;
                            stream.push({ type: "done", reason: "stop" });
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
                stream.push({ type: "done", reason: "stop" });
                stream.end({ ...assistant, stopReason: "stop", responseId: state.parentMessageId || undefined });
            }
            catch (error) {
                const err = error instanceof Error ? error.message : String(error);
                const message = {
                    role: "assistant",
                    api: model.api,
                    provider: model.provider,
                    model: model.id,
                    content: [],
                    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                    stopReason: "error",
                    errorMessage: err,
                    timestamp: Date.now(),
                };
                stream.push({ type: "error", reason: "error", error: message });
                stream.end(message);
            }
        })();
        return stream;
    };
}
