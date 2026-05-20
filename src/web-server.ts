// ── DeepSeek Agent Web UI Server ──────────────────────
// Bun HTTP server serving a single-page web UI.
// POST /api/chat → starts PiAgentLoop, streams events as SSE.
// Uses pi's SessionManager, AuthStorage, SettingsManager for persistence.

import { PiAgentLoop } from "./pi-agent-loop.js";
import {
  AuthStorage,
  SessionManager,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
const PORT = parseInt(process.env.PORT || "3456", 10);

// ── Configuration ─────────────────────────────────────
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || String(24 * 60 * 60 * 1000), 10); // 24 hours default
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || "30000", 10); // 30 seconds
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || String(60 * 60 * 1000), 10); // 1 hour for long-running agent tasks
const MAX_RECONNECT_ATTEMPTS = parseInt(process.env.MAX_RECONNECT_ATTEMPTS || "10", 10);
const MAX_CONVERSATIONS = parseInt(process.env.MAX_CONVERSATIONS || "50", 10);

const HTML = await Bun.file(import.meta.dirname + "/../public/index.html").text();

// ── Pi Session Management ─────────────────────────────
// Use pi's SessionManager for persistent sessions, AuthStorage for credentials,
// and SettingsManager for configuration.

const authStorage = AuthStorage.create();
const settingsManager = SettingsManager.create(process.cwd(), getAgentDir());
const sessionManager = SessionManager.create(process.cwd());

// ── Conversation Management ───────────────────────────
interface Conversation {
  id: string;
  loop: PiAgentLoop;
  createdAt: number;
  lastUsedAt: number;
  messageCount: number;
  activeRun: boolean;
  sessionFile?: string;
}

const conversations = new Map<string, Conversation>();
let lastActivityTime = Date.now();
let activeConnections = new Set<ReadableStreamDefaultController>();
let idleTimeoutTimer: Timer | null = null;

function generateConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getConversation(id: string): Conversation | undefined {
  return conversations.get(id);
}

async function createConversation(modelType?: string, thinkingEnabled?: boolean): Promise<Conversation> {
  // Evict oldest conversation if at limit
  if (conversations.size >= MAX_CONVERSATIONS) {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, conv] of conversations) {
      if (!conv.activeRun && conv.lastUsedAt < oldestTime) {
        oldestTime = conv.lastUsedAt;
        oldestId = id;
      }
    }
    if (oldestId) {
      conversations.delete(oldestId);
    }
  }

  const id = generateConversationId();
  const loop = new PiAgentLoop({
    modelType: modelType || "expert",
    thinkingEnabled: thinkingEnabled ?? false,
    maxRounds: 25,
  });
  await loop.init();

  const conv: Conversation = {
    id,
    loop,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    messageCount: 0,
    activeRun: false,
    sessionFile: sessionManager.getSessionFile() || undefined,
  };
  conversations.set(id, conv);
  return conv;
}

function listConversations(): Array<{ id: string; createdAt: number; lastUsedAt: number; messageCount: number; activeRun: boolean; sessionFile?: string }> {
  const result: Array<{ id: string; createdAt: number; lastUsedAt: number; messageCount: number; activeRun: boolean; sessionFile?: string }> = [];
  for (const [id, conv] of conversations) {
    result.push({
      id: conv.id,
      createdAt: conv.createdAt,
      lastUsedAt: conv.lastUsedAt,
      messageCount: conv.messageCount,
      activeRun: conv.activeRun,
      sessionFile: conv.sessionFile,
    });
  }
  return result.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

function deleteConversation(id: string): boolean {
  const conv = conversations.get(id);
  if (conv && !conv.activeRun) {
    conversations.delete(id);
    return true;
  }
  return false;
}

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
    agentInitialized: conversations.size > 0,
    sessionManager: {
      sessionFile: sessionManager.getSessionFile(),
      sessionId: sessionManager.getSessionId(),
      entryCount: sessionManager.getEntries().length,
    },
    settings: {
      defaultModel: settingsManager.getDefaultModel(),
      defaultProvider: settingsManager.getDefaultProvider(),
      thinkingLevel: settingsManager.getDefaultThinkingLevel(),
    },
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

// ── Settings endpoint ─────────────────────────────────
async function handleGetSettings(): Promise<Response> {
  return jsonResponse({
    defaultModel: settingsManager.getDefaultModel(),
    defaultProvider: settingsManager.getDefaultProvider(),
    thinkingLevel: settingsManager.getDefaultThinkingLevel(),
    compactionEnabled: settingsManager.getCompactionEnabled(),
    theme: settingsManager.getTheme(),
    showImages: settingsManager.getShowImages(),
    hideThinkingBlock: settingsManager.getHideThinkingBlock(),
    shellPath: settingsManager.getShellPath(),
  });
}

async function handleUpdateSettings(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (body.defaultModel) settingsManager.setDefaultModel(String(body.defaultModel));
  if (body.defaultProvider) settingsManager.setDefaultProvider(String(body.defaultProvider));
  if (body.thinkingLevel) settingsManager.setDefaultThinkingLevel(String(body.thinkingLevel));
  if (typeof body.compactionEnabled === "boolean") settingsManager.setCompactionEnabled(body.compactionEnabled);
  if (body.theme) settingsManager.setTheme(String(body.theme));
  if (typeof body.showImages === "boolean") settingsManager.setShowImages(body.showImages);
  if (typeof body.hideThinkingBlock === "boolean") settingsManager.setHideThinkingBlock(body.hideThinkingBlock);
  if (body.shellPath) settingsManager.setShellPath(String(body.shellPath));

  await settingsManager.flush();

  return jsonResponse({ status: "updated" });
}

// ── Chat endpoint ─────────────────────────────────────
async function handleChat(req: Request): Promise<Response> {
  resetIdleTimeout();

  let body: { message?: string; modelType?: string; thinkingEnabled?: boolean; conversationId?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { message, modelType, thinkingEnabled, conversationId } = body;

  if (!message || typeof message !== "string") {
    return jsonResponse({ error: "message is required" }, 400);
  }

  // Get or create conversation
  let conv: Conversation;
  if (conversationId) {
    conv = getConversation(conversationId) || await createConversation(modelType, thinkingEnabled);
  } else {
    conv = await createConversation(modelType, thinkingEnabled);
  }

  if (conv.activeRun) {
    return jsonResponse({ error: "Conversation is already processing a message" }, 409);
  }

  conv.lastUsedAt = Date.now();
  conv.messageCount++;

  // Record user message in pi session
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: message }],
    timestamp: Date.now(),
  });

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

      // Map pi-agent-core events to our SSE event format
      let currentRound = 0;
      let toolCallCounter = 0;
      let toolStartTimes = new Map<string, number>();
      let assistantText = "";
      let thinkingText = "";

      const unsub = conv.loop.subscribe(async (ev: any) => {
        switch (ev.type) {
          case "agent_start":
            currentRound = 0;
            toolCallCounter = 0;
            toolStartTimes.clear();
            assistantText = "";
            thinkingText = "";
            send("status", { message: "Starting..." });
            send("conversation", { id: conv.id });
            break;

          case "turn_start":
            currentRound++;
            send("status", { message: `Round ${currentRound}/${conv.loop.maxRounds}` });
            send("stream_start", {});
            break;

          case "message_update":
            if (ev.assistantMessageEvent) {
              const ame = ev.assistantMessageEvent;
              if (ame.type === "text_delta") {
                assistantText += ame.delta || "";
                send("text_delta", { delta: ame.delta || "" });
              } else if (ame.type === "thinking_delta") {
                thinkingText += ame.delta || "";
                send("thinking_delta", { delta: ame.delta || "" });
              } else if (ame.type === "toolcall_delta") {
                // Tool calls detected during streaming
                const content = ame.partial?.content || [];
                for (const block of content) {
                  if (block.type === "toolCall" && block.id && block.name) {
                    const tcId = `tc_${toolCallCounter}`;
                    if (!toolStartTimes.has(tcId)) {
                      toolCallCounter++;
                      toolStartTimes.set(tcId, Date.now());
                      send("tool_call_detected", {
                        toolCallId: tcId,
                        name: block.name,
                        args: block.arguments || {},
                      });
                    }
                  }
                }
              }
            }
            break;

          case "message_end":
            // Assistant message complete (may not fire for assistant, only user)
            if (ev.message?.role === "assistant") {
              send("stream_end", { fullText: assistantText || "" });
            }
            break;

          case "tool_execution_start":
            toolStartTimes.set(ev.toolCallId, Date.now());
            send("tool_call_start", {
              toolCallId: ev.toolCallId,
              name: ev.toolName,
              args: ev.args || {},
            });
            send("status", { message: `Executing ${ev.toolName}` });
            break;

          case "tool_execution_end":
            const startTime = toolStartTimes.get(ev.toolCallId);
            const duration = startTime ? `${((Date.now() - startTime) / 1000).toFixed(1)}s` : "";
            const content = ev.result?.content?.map((c: any) => c.text || "").join("") || "";
            send("tool_result", {
              toolCallId: ev.toolCallId,
              name: ev.toolName,
              content: content.slice(0, 10000),
              isError: ev.isError || false,
              duration,
            });
            break;

          case "turn_end":
            const hasTools = (ev.toolResults?.length || 0) > 0;
            send("round_complete", { round: currentRound, hasToolCalls: hasTools });
            if (!hasTools) {
              send("turn_complete", {
                turns: conv.loop.turnCount,
                messages: conv.loop.messagesSnapshot,
                estimatedTokens: conv.loop.estimateCurrentTokens(),
              });
            }
            break;

          case "agent_end":
            // Record assistant message in pi session
            const msgs = ev.messages || [];
            for (const m of msgs) {
              if (m.role === "assistant") {
                const text = typeof m.content === "string"
                  ? m.content
                  : m.content?.map((c: any) => c.type === "text" ? c.text : "").join("") || "";
                if (text) {
                  sessionManager.appendMessage({
                    role: "assistant",
                    content: [{ type: "text", text }],
                    timestamp: Date.now(),
                  });
                }
              }
            }

            // Ensure stream_end is sent if not already
            send("stream_end", { fullText: assistantText || "" });
            send("turn_complete", {
              turns: conv.loop.turnCount,
              messages: conv.loop.messagesSnapshot,
              estimatedTokens: conv.loop.estimateCurrentTokens(),
            });
            send("done", { status: "complete" });
            break;

          case "error":
            send("error", { message: ev.error?.message || "Unknown error" });
            break;
        }
      });

      try {
        conv.activeRun = true;
        await conv.loop.execute(message);
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
        conv.activeRun = false;
        unsub();
        cleanup();
      }
    },

    cancel() {
      isClosed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (requestTimeoutTimer) clearTimeout(requestTimeoutTimer);
      if (streamController) activeConnections.delete(streamController);
      if (conv.activeRun) {
        conv.loop.abort();
        conv.activeRun = false;
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

// ── Session Management Endpoints ──────────────────────
function handleListSessions(): Response {
  const entries = sessionManager.getEntries();
  const tree = sessionManager.getTree();
  const branch = sessionManager.getBranch();
  return jsonResponse({
    sessionFile: sessionManager.getSessionFile(),
    sessionId: sessionManager.getSessionId(),
    entryCount: entries.length,
    leafId: sessionManager.getLeafId(),
    branchCount: branch.length,
    header: sessionManager.getHeader(),
  });
}

function handleSessionTree(): Response {
  const tree = sessionManager.getTree();
  return jsonResponse({ tree });
}

function handleSessionEntries(): Response {
  const entries = sessionManager.getEntries();
  const branch = sessionManager.getBranch();
  return jsonResponse({
    entries: entries.slice(-50), // Last 50 entries
    branch: branch.slice(-20),
    total: entries.length,
  });
}

function handleSessionStats(): Response {
  const entries = sessionManager.getEntries();
  const branch = sessionManager.getBranch();
  const userMsgs = entries.filter(e => e.type === "message" && e.role === "user").length;
  const assistantMsgs = entries.filter(e => e.type === "message" && e.role === "assistant").length;
  const toolCalls = entries.filter(e => e.type === "tool_call").length;
  return jsonResponse({
    sessionFile: sessionManager.getSessionFile(),
    sessionId: sessionManager.getSessionId(),
    totalEntries: entries.length,
    userMessages: userMsgs,
    assistantMessages: assistantMsgs,
    toolCalls: toolCalls,
    branchLength: branch.length,
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
        return handleUpdateSettings(req);
      }
      if (req.method === "GET" && url.pathname === "/api/settings") {
        return handleGetSettings();
      }
      if (req.method === "POST" && url.pathname === "/api/clear") {
        resetIdleTimeout();
        // Clear all conversations
        for (const conv of conversations.values()) {
          if (!conv.activeRun) {
            conv.loop.clearMessages();
            conv.messageCount = 0;
          }
        }
        return jsonResponse({ status: "cleared" });
      }

      // Conversation management routes
      if (req.method === "GET" && url.pathname === "/api/conversations") {
        return jsonResponse({ conversations: listConversations() });
      }
      if (req.method === "DELETE" && url.pathname === "/api/conversations") {
        const deleteUrl = new URL(req.url);
        const id = deleteUrl.searchParams.get("id");
        if (!id) {
          return jsonResponse({ error: "conversation id is required" }, 400);
        }
        if (deleteConversation(id)) {
          return jsonResponse({ status: "deleted", id });
        }
        return jsonResponse({ error: "conversation not found or is active" }, 404);
      }
      if (req.method === "POST" && url.pathname === "/api/conversations/clear") {
        const clearUrl = new URL(req.url);
        const id = clearUrl.searchParams.get("id");
        if (!id) {
          return jsonResponse({ error: "conversation id is required" }, 400);
        }
        const conv = getConversation(id);
        if (conv && !conv.activeRun) {
          conv.loop.clearMessages();
          conv.messageCount = 0;
          return jsonResponse({ status: "cleared", id });
        }
        return jsonResponse({ error: "conversation not found or is active" }, 404);
      }

      // Session management routes
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        return handleListSessions();
      }
      if (req.method === "GET" && url.pathname === "/api/sessions/tree") {
        return handleSessionTree();
      }
      if (req.method === "GET" && url.pathname === "/api/sessions/entries") {
        return handleSessionEntries();
      }
      if (req.method === "GET" && url.pathname === "/api/sessions/stats") {
        return handleSessionStats();
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
  console.log(`Session file: ${sessionManager.getSessionFile() || "(in-memory)"}`);
  console.log(`Agent dir: ${getAgentDir()}`);
} catch (err) {
  console.error("[FATAL] Failed to start server:", err);
  process.exit(1);
}
