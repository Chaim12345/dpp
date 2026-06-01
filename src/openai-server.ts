// ── OpenAI-Compatible API Server ─────────────────────────
// Exposes /v1/chat/completions and /v1/models endpoints
// that proxy to DeepSeek's web API, compatible with the
// official OpenAI Python/JS SDK.

import {
  loadAuth,
  createSession,
  chatStreamParsed,
  parseSseStream,
  chatStream,
  withRetry,
  WafTokenExpiredError,
  StaleAuthError,
  type DeepSeekSseEvent,
} from "./web-api-client.js";
import type { HarnessState } from "./types.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const DEEPSEEK_URL = "https://chat.deepseek.com";

// ── State ────────────────────────────────────────────────
const state: HarnessState = {
  chatSessionId: null,
  parentMessageId: null,
  memorySummary: "",
  authToken: null,
  cookieHeader: null,
  deepseekApiKey: null,
};

// ── Models ───────────────────────────────────────────────
const MODELS = [
  {
    id: "deepseek-chat",
    object: "model",
    created: 1700000000,
    owned_by: "deepseek",
    permission: [],
    root: "deepseek-chat",
    parent: null,
  },
  {
    id: "deepseek-reasoner",
    object: "model",
    created: 1700000000,
    owned_by: "deepseek",
    permission: [],
    root: "deepseek-reasoner",
    parent: null,
  },
];

// ── Helpers ──────────────────────────────────────────────
function generateId(): string {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function corsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

// ── Convert OpenAI messages to DeepSeek prompt ───────────
function messagesToPrompt(
  messages: Array<{ role: string; content: string | null; name?: string; tool_calls?: any[]; tool_call_id?: string }>
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : "";
    switch (msg.role) {
      case "system":
        parts.push(`[System]\n${content}`);
        break;
      case "user":
        parts.push(`[User]\n${content}`);
        break;
      case "assistant":
        if (content) parts.push(`[Assistant]\n${content}`);
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            parts.push(`[Assistant Tool Call]\n${JSON.stringify(tc)}`);
          }
        }
        break;
      case "tool":
        parts.push(`[Tool:${msg.name || "unknown"}]\n${content}`);
        break;
    }
  }

  return parts.join("\n\n");
}

// ── Token estimation ─────────────────────────────────────
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── POST /v1/chat/completions ────────────────────────────
async function handleChatCompletions(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  }

  const { messages, model, stream, temperature, max_tokens, tools, tool_choice } = body;

  if (!messages || !Array.isArray(messages)) {
    return jsonResponse({ error: { message: "messages is required", type: "invalid_request_error" } }, 400);
  }

  const modelType = model === "deepseek-reasoner" ? "expert" : "default";
  const thinkingEnabled = model === "deepseek-reasoner";

  // Ensure auth
  if (!state.authToken) {
    const auth = await loadAuth();
    state.authToken = auth.token;
    state.cookieHeader = auth.cookieHeader;
  }
  if (!state.authToken) {
    return jsonResponse({ error: { message: "No DeepSeek auth token available", type: "authentication_error" } }, 401);
  }

  // Ensure session
  if (!state.chatSessionId) {
    try {
      state.chatSessionId = await createSession(state.authToken, state.cookieHeader, modelType);
    } catch (err) {
      if (err instanceof WafTokenExpiredError || err instanceof StaleAuthError) {
        state.authToken = null;
        return jsonResponse({ error: { message: "Authentication failed", type: "authentication_error" } }, 401);
      }
      throw err;
    }
  }

  const prompt = messagesToPrompt(messages);
  const completionId = generateId();
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    return handleStreamResponse(completionId, created, model || "deepseek-chat", prompt, modelType, thinkingEnabled);
  }

  return handleNonStreamResponse(completionId, created, model || "deepseek-chat", prompt, modelType, thinkingEnabled);
}

// ── Streaming response ───────────────────────────────────
async function handleStreamResponse(
  completionId: string,
  created: number,
  model: string,
  prompt: string,
  modelType: string,
  thinkingEnabled: boolean,
): Promise<Response> {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {}
      };

      const sendDone = () => {
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {}
      };

      try {
        // Send initial role chunk
        send(JSON.stringify({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          }],
        }));

        let fullText = "";
        let responseMessageId: number | null = null;

        const resp = await withRetry(
          () => chatStreamParsed(
            {
              sessionId: state.chatSessionId!,
              prompt,
              parentMessageId: state.parentMessageId,
              modelType,
              thinkingEnabled,
            },
            { authToken: state.authToken, cookieHeader: state.cookieHeader, powSolver: null, parentMessageId: state.parentMessageId },
            (ev: DeepSeekSseEvent) => {
              if (ev.type === "content") {
                fullText += ev.delta;
                send(JSON.stringify({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: { content: ev.delta },
                    finish_reason: null,
                  }],
                }));
              }
            },
          ),
          { maxRetries: 3, baseDelayMs: 1000 },
        );

        // Send finish
        send(JSON.stringify({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: estimateTokens(prompt),
            completion_tokens: estimateTokens(fullText),
            total_tokens: estimateTokens(prompt) + estimateTokens(fullText),
          },
        }));

        sendDone();
      } catch (err: any) {
        console.error("[STREAM ERROR]", err);
        send(JSON.stringify({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: null,
          }],
          error: { message: err.message || "Stream error", type: "server_error" },
        }));
        sendDone();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    },
  });
}

// ── Non-streaming response ───────────────────────────────
async function handleNonStreamResponse(
  completionId: string,
  created: number,
  model: string,
  prompt: string,
  modelType: string,
  thinkingEnabled: boolean,
): Promise<Response> {
  try {
    let fullText = "";

    await withRetry(
      () => chatStreamParsed(
        {
          sessionId: state.chatSessionId!,
          prompt,
          parentMessageId: state.parentMessageId,
          modelType,
          thinkingEnabled,
        },
        { authToken: state.authToken, cookieHeader: state.cookieHeader, powSolver: null, parentMessageId: state.parentMessageId },
        (ev: DeepSeekSseEvent) => {
          if (ev.type === "content") {
            fullText += ev.delta;
          }
        },
      ),
      { maxRetries: 3, baseDelayMs: 1000 },
    );

    return jsonResponse({
      id: completionId,
      object: "chat.completion",
      created,
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: fullText },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: estimateTokens(prompt),
        completion_tokens: estimateTokens(fullText),
        total_tokens: estimateTokens(prompt) + estimateTokens(fullText),
      },
    });
  } catch (err: any) {
    return jsonResponse({ error: { message: err.message || "Completion error", type: "server_error" } }, 500);
  }
}

// ── GET /v1/models ───────────────────────────────────────
function handleListModels(): Response {
  return jsonResponse({
    object: "list",
    data: MODELS,
  });
}

// ── GET /v1/model/:id ────────────────────────────────────
function handleGetModel(id: string): Response {
  const model = MODELS.find((m) => m.id === id);
  if (!model) {
    return jsonResponse({ error: { message: `Model '${id}' not found`, type: "invalid_request_error" } }, 404);
  }
  return jsonResponse(model);
}

// ── Start server ─────────────────────────────────────────
console.log(`OpenAI-compatible server starting on port ${PORT}`);
console.log(`Endpoints:`);
console.log(`  GET  http://localhost:${PORT}/v1/models`);
console.log(`  POST http://localhost:${PORT}/v1/chat/completions`);
console.log(`  GET  http://localhost:${PORT}/health`);

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return corsResponse();
    }

    // Health check
    if (url.pathname === "/health") {
      return jsonResponse({
        status: "ok",
        authenticated: !!state.authToken,
        sessionId: state.chatSessionId,
      });
    }

    // GET /v1/models
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return handleListModels();
    }

    // GET /v1/models/:id
    if (req.method === "GET" && url.pathname.startsWith("/v1/models/")) {
      const id = url.pathname.slice("/v1/models/".length);
      return handleGetModel(id);
    }

    // POST /v1/chat/completions
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return handleChatCompletions(req);
    }

    return jsonResponse({ error: { message: "Not found", type: "invalid_request_error" } }, 404);
  },
  error(err) {
    console.error("[SERVER ERROR]", err);
    return jsonResponse({ error: { message: "Internal server error", type: "server_error" } }, 500);
  },
});

console.log(`Server ready at http://localhost:${server.port}`);
