// ── DeepSeek Agent Web UI Server ──────────────────────
// Bun HTTP server serving a single-page web UI.
// POST /api/chat → starts UnifiedAgentLoop, streams events as SSE.
// Enhanced with robust network instability handling and long idle timeout.

import { UnifiedAgentLoop, type AgentLoopEvent } from "./agent-loop-unified.js";
const PORT = parseInt(process.env.PORT || "3456", 10);

// ── Configuration ─────────────────────────────────────
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || String(24 * 60 * 60 * 1000), 10); // 24 hours default
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || "30000", 10); // 30 seconds
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || String(60 * 60 * 1000), 10); // 1 hour for long-running agent tasks
const MAX_RECONNECT_ATTEMPTS = parseInt(process.env.MAX_RECONNECT_ATTEMPTS || "10", 10);

const HTML = await Bun.file(import.meta.dirname + "/../public/index.html").text();

let loop: UnifiedAgentLoop | null = null;
let lastActivityTime = Date.now();
let activeConnections = new Set<ReadableStreamDefaultController>();
let idleTimeoutTimer: Timer | null = null;
let activeRun = false;

// ── Idle timeout management ───────────────────────────
function resetIdleTimeout() {
  lastActivityTime = Date.now();
  if (idleTimeoutTimer) clearTimeout(idleTimeoutTimer);
  idleTimeoutTimer = setTimeout(() => {
    console.log(`[IDLE TIMEOUT] No activity for ${IDLE_TIMEOUT_MS / 1000}s. Cleaning up.`);
    // Close all active SSE connections gracefully
    for (const controller of activeConnections) {
      try {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`event: idle_timeout\ndata: ${JSON.stringify({ message: "Server idle timeout reached", timeoutMs: IDLE_TIMEOUT_MS })}\n\n`));
        controller.close();
      } catch {}
    }
    activeConnections.clear();
  }, IDLE_TIMEOUT_MS);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

// ── Health check endpoint ─────────────────────────────
function handleHealth(): Response {
  return jsonResponse({
    status: "ok",
    uptime: process.uptime(),
    activeConnections: activeConnections.size,
    lastActivity: new Date(lastActivityTime).toISOString(),
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    agentInitialized: loop !== null,
    timestamp: Date.now(),
  });
}

// ── Connection info endpoint ──────────────────────────
function handleConnectionInfo(): Response {
  return jsonResponse({
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
    serverTime: Date.now(),
  });
}

async function ensureLoop(modelType?: string, thinkingEnabled?: boolean): Promise<UnifiedAgentLoop> {
  if (!loop) {
    loop = new UnifiedAgentLoop({
      modelType: modelType || "expert",
      thinkingEnabled: thinkingEnabled ?? false,
      maxRounds: 25,
    });
    await loop.init();
    return loop;
  }

  if (modelType) loop.modelType = modelType;
  if (thinkingEnabled !== undefined) loop.thinkingEnabled = thinkingEnabled;
  return loop;
}

async function handleChat(req: Request): Promise<Response> {
  resetIdleTimeout();

  let body: { message?: string; modelType?: string; thinkingEnabled?: boolean };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { message, modelType, thinkingEnabled } = body;

  if (!message || typeof message !== "string") {
    return jsonResponse({ error: "message is required" }, 400);
  }

  if (activeRun) {
    return jsonResponse({ error: "Agent is already processing a message" }, 409);
  }

  try {
    await ensureLoop(modelType, thinkingEnabled);
  } catch (err: unknown) {
    return jsonResponse({ error: `Agent initialization failed: ${(err as Error).message}` }, 500);
  }

  // SSE stream with heartbeat and robust error handling
  let heartbeatTimer: Timer | null = null;
  let requestTimeoutTimer: Timer | null = null;
  let isClosed = false;
  let streamController: ReadableStreamDefaultController | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      streamController = controller;
      activeConnections.add(controller);
      const encoder = new TextEncoder();

      const send = (event: string, data: unknown) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          resetIdleTimeout();
        } catch (err) {
          console.error("[SSE SEND ERROR]", err);
          isClosed = true;
        }
      };

      // Heartbeat to keep connection alive through proxies/load balancers
      heartbeatTimer = setInterval(() => {
        if (!isClosed) {
          send("ping", { timestamp: Date.now() });
        } else {
          clearInterval(heartbeatTimer!);
        }
      }, HEARTBEAT_INTERVAL_MS);

      // Request-level timeout for very long agent executions
      requestTimeoutTimer = setTimeout(() => {
        if (!isClosed) {
          send("timeout", { message: "Request timeout reached", timeoutMs: REQUEST_TIMEOUT_MS });
          cleanup();
        }
      }, REQUEST_TIMEOUT_MS);

      function cleanup() {
        isClosed = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (requestTimeoutTimer) clearTimeout(requestTimeoutTimer);
        activeConnections.delete(controller);
        try { controller.close(); } catch {}
      }

      const unsub = loop!.subscribe(async (ev: AgentLoopEvent) => {
        send(ev.type, ev);
      });

      try {
        activeRun = true;
        await loop!.execute(message);
        send("done", { status: "complete" });
      } catch (err: unknown) {
        const errorMsg = (err as Error).message || "Unknown error";
        console.error("[AGENT EXECUTION ERROR]", err);

        // Detect network-related errors
        if (errorMsg.includes("fetch") || errorMsg.includes("network") || errorMsg.includes("ECONN")) {
          send("network_error", {
            message: "Network error during agent execution. The agent will retry on next request.",
            originalError: errorMsg,
            recoverable: true,
          });
        } else {
          send("error", { message: errorMsg });
        }
      } finally {
        activeRun = false;
        unsub();
        cleanup();
      }
    },

    cancel() {
      isClosed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (requestTimeoutTimer) clearTimeout(requestTimeoutTimer);
      if (streamController) activeConnections.delete(streamController);
      if (activeRun) {
        loop?.abort();
        activeRun = false;
      }
      console.log("[SSE] Client disconnected");
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      // Prevent intermediate proxies from buffering
      "X-Accel-Buffering": "no",
    },
  });
}

async function handleSettings(req: Request): Promise<Response> {
  resetIdleTimeout();

  let body: { modelType?: string; thinkingEnabled?: boolean; maxRounds?: number };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  let currentLoop: UnifiedAgentLoop;
  try {
    currentLoop = await ensureLoop(body.modelType, body.thinkingEnabled);
  } catch (err: unknown) {
    return jsonResponse({ error: `Agent initialization failed: ${(err as Error).message}` }, 500);
  }

  if (body.modelType) currentLoop.modelType = body.modelType;
  if (body.thinkingEnabled !== undefined) currentLoop.thinkingEnabled = body.thinkingEnabled;
  if (body.maxRounds) currentLoop.maxRounds = body.maxRounds;

  return jsonResponse({
    modelType: currentLoop.modelType,
    thinkingEnabled: currentLoop.thinkingEnabled,
    maxRounds: currentLoop.maxRounds,
  });
}

// ── CORS preflight ────────────────────────────────────
function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

// ── Start server with error handling ──────────────────
try {
  const server = Bun.serve({
    port: PORT,
    idleTimeout: 120, // Bun-level idle timeout for regular connections (seconds)
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return handleOptions();
      }

      // Health check
      if (url.pathname === "/api/health" || url.pathname === "/health") {
        return handleHealth();
      }

      // Connection info
      if (url.pathname === "/api/connection-info") {
        return handleConnectionInfo();
      }

      // API routes
      if (req.method === "POST" && url.pathname === "/api/chat") {
        return handleChat(req);
      }
      if (req.method === "POST" && url.pathname === "/api/settings") {
        return handleSettings(req);
      }
      if (req.method === "POST" && url.pathname === "/api/clear") {
        resetIdleTimeout();
        loop?.clearMessages();
        return jsonResponse({ status: "cleared" });
      }

      // Static files
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not found", { status: 404 });
    },

    error(error) {
      console.error("[SERVER ERROR]", error);
      return new Response(
        JSON.stringify({ error: "Internal server error", message: (error as Error).message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  // Start idle timeout
  resetIdleTimeout();

  console.log(`Web UI running at http://localhost:${server.port}`);
  console.log(`Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s | Heartbeat: ${HEARTBEAT_INTERVAL_MS / 1000}s | Request timeout: ${REQUEST_TIMEOUT_MS / 1000}s`);
} catch (err) {
  console.error("[FATAL] Failed to start server:", err);
  process.exit(1);
}
