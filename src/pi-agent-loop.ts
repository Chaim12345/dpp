// ── Pi-SDK Agent Loop with DeepSeek Custom API ──────────────────
// Uses pi's native tools (read, bash, edit, write, grep, find, ls)
// with our custom DeepSeek API client (auth, PoW, SSE streaming, tool parsing).
//
// Key integration points:
// - streamFn: wraps chatStreamParsed to produce AssistantMessageEventStream
// - convertToLlm: pi's native message converter
// - tools: pi's native AgentTool implementations
// - transformContext: context window management

import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import type { AssistantMessageEvent, Message, AssistantMessage, TextContent, ToolCallContent } from "@mariozechner/pi-ai";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { convertToLlm as piConvertToLlm } from "@earendil-works/pi-coding-agent";
import {
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";
import { chatStreamParsed, type DeepSeekSseEvent, loadAuth, createSession, withRetry, WafTokenExpiredError, StaleAuthError, type PowChallenge, DeepSeekPoWSolver } from "./web-api-client.js";
import { extractToolCalls, stripToolCalls, type ToolCall } from "./tool-registry.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { estimateTokens, compactHistory } from "./context.js";

// ── Configuration ───────────────────────────────────────────────

export interface PiAgentLoopOptions {
  modelType?: string;
  thinkingEnabled?: boolean;
  maxRounds?: number;
  maxContextTokens?: number;
}

// ── Pi Native Tools ─────────────────────────────────────────────

const CWD = process.cwd();

function createPiTools(): AgentTool<any>[] {
  return [
    createReadTool(CWD),
    createBashTool(CWD, { operations: createLocalBashOperations() }),
    createEditTool(CWD),
    createWriteTool(CWD),
    createGrepTool(CWD),
    createFindTool(CWD),
    createLsTool(CWD),
  ];
}

// ── DeepSeek Stream Function ────────────────────────────────────
// Wraps our custom DeepSeek API client to produce an AssistantMessageEventStream
// compatible with pi-agent-core's expectations.

interface DeepSeekStreamState {
  sessionId: string;
  parentMessageId: number | null;
  authToken: string | null;
  cookieHeader: string | null;
  powSolver: DeepSeekPoWSolver | null;
  modelType: string;
  thinkingEnabled: boolean;
}

function createDeepSeekStreamFn(state: DeepSeekStreamState) {
  return function deepSeekStreamFn(
    _model: any,
    context: { systemPrompt: string; messages: Message[]; tools?: any[] },
    options: { signal?: AbortSignal; apiKey?: string }
  ): AssistantMessageEventStream {
    const stream = new AssistantMessageEventStream();

    // Build prompt from messages + system prompt
    const promptParts: string[] = [];
    if (context.systemPrompt) promptParts.push(`[System]\n${context.systemPrompt}`);
    for (const msg of context.messages) {
      if (msg.role === "user") {
        const text = typeof msg.content === "string" ? msg.content : msg.content.map(c => c.type === "text" ? c.text : "").join("");
        promptParts.push(`[User]\n${text}`);
      } else if (msg.role === "assistant") {
        const text = typeof msg.content === "string" ? msg.content : msg.content.map(c => c.type === "text" ? c.text : "").join("");
        promptParts.push(`[Assistant]\n${text}`);
      } else if (msg.role === "toolResult") {
        const text = typeof msg.content === "string" ? msg.content : msg.content.map(c => c.type === "text" ? c.text : "").join("");
        promptParts.push(`[Tool:${(msg as any).toolName || "unknown"}]\n${text}`);
      }
    }
    const promptText = promptParts.join("\n\n");

    // Start async processing in background
    (async () => {
      // Ensure auth is loaded
      if (!state.authToken) {
        try {
          const auth = await loadAuth();
          if (!auth.token) throw new Error("No DeepSeek auth token");
          state.authToken = auth.token;
          state.cookieHeader = auth.cookieHeader;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errorMsg: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: `Error: ${errMsg}` }],
            api: "deepseek",
            provider: "deepseek",
            model: state.modelType,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "error",
            errorMessage: errMsg,
            timestamp: Date.now(),
          };
          stream.push({ type: "error", reason: "error", error: errorMsg });
          stream.end(errorMsg);
          return;
        }
      }

      // Ensure session exists
      if (!state.sessionId) {
        try {
          state.sessionId = await createSession(state.authToken!, state.cookieHeader, state.modelType);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errorMsg: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: `Error: ${errMsg}` }],
            api: "deepseek",
            provider: "deepseek",
            model: state.modelType,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "error",
            errorMessage: errMsg,
            timestamp: Date.now(),
          };
          stream.push({ type: "error", reason: "error", error: errorMsg });
          stream.end(errorMsg);
          return;
        }
      }

      // Initialize PoW solver if needed
      if (!state.powSolver) {
        state.powSolver = new DeepSeekPoWSolver();
        await state.powSolver.init();
      }

      // Initial partial message
      const initialPartial: AssistantMessage = {
        role: "assistant",
        content: [],
        api: "deepseek",
        provider: "deepseek",
        model: state.modelType,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: initialPartial });

      // Process SSE stream
      let fullText = "";
      const toolCalls: ToolCallContent[] = [];
      let toolCallIndex = 0;
      let streamError: Error | null = null;

      try {
        await chatStreamParsed(
          {
            sessionId: state.sessionId,
            prompt: promptText,
            parentMessageId: state.parentMessageId,
            modelType: state.modelType,
            thinkingEnabled: state.thinkingEnabled,
            signal: options.signal,
          },
          {
            authToken: state.authToken,
            cookieHeader: state.cookieHeader,
            powSolver: state.powSolver,
            parentMessageId: state.parentMessageId,
          },
          (event: DeepSeekSseEvent) => {
            if (options.signal?.aborted) return;

            if (event.type === "content") {
              fullText += event.delta;
              const content: (TextContent | ToolCallContent)[] = [{ type: "text", text: fullText }, ...toolCalls];
              const partial: AssistantMessage = {
                ...initialPartial,
                content,
                timestamp: Date.now(),
              };
              stream.push({ type: "text_delta", contentIndex: 0, delta: event.delta, partial });
            } else if (event.type === "tool_calls") {
              for (const call of event.calls) {
                const toolCall: ToolCallContent = {
                  type: "toolCall",
                  id: `tc_${toolCallIndex++}`,
                  name: call.name,
                  arguments: call.arguments,
                };
                toolCalls.push(toolCall);
              }
              const content: (TextContent | ToolCallContent)[] = [{ type: "text", text: fullText }, ...toolCalls];
              const partial: AssistantMessage = {
                ...initialPartial,
                content,
                timestamp: Date.now(),
              };
              stream.push({ type: "toolcall_delta", contentIndex: toolCalls.length - 1, partial });
            }
          }
        );
      } catch (err) {
        streamError = err instanceof Error ? err : new Error(String(err));
      }

      // Build final message
      // Extract tool calls from text content and convert to structured blocks
      const extracted = extractToolCalls(fullText);
      const parsedToolCalls: ToolCallContent[] = [...toolCalls]; // Start with any from SSE events

      if (extracted && extracted.length > 0) {
        for (const tc of extracted) {
          // Avoid duplicates from SSE events
          if (!parsedToolCalls.some(existing => existing.name === tc.name && JSON.stringify(existing.arguments) === JSON.stringify(tc.arguments))) {
            parsedToolCalls.push({
              type: "toolCall",
              id: `tc_${toolCallIndex++}`,
              name: tc.name,
              arguments: tc.arguments,
            });
          }
        }
      }

      // Strip tool call markup from visible text
      const cleanText = stripToolCalls(fullText);

      const finalContent: (TextContent | ToolCallContent)[] = [];
      if (cleanText) finalContent.push({ type: "text", text: cleanText });
      finalContent.push(...parsedToolCalls);

      console.log("[PiAgentLoop] Final content blocks:", finalContent.map(c => c.type === "toolCall" ? `toolCall: ${c.name}` : `text: ${(c as any).text?.slice(0, 50)}`));

      const finalMessage: AssistantMessage = {
        role: "assistant",
        content: finalContent,
        api: "deepseek",
        provider: "deepseek",
        model: state.modelType,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: streamError ? "error" : "stop",
        errorMessage: streamError?.message,
        timestamp: Date.now(),
      };

      if (streamError) {
        stream.push({ type: "error", reason: "error", error: finalMessage });
        stream.end(finalMessage);
      } else {
        stream.push({ type: "done", reason: "stop", message: finalMessage });
        stream.end(finalMessage);
      }
    })();

    return stream;
  };
}

// ── Transform Context (context window management) ───────────────

function createTransformContext(maxTokens: number) {
  return async (messages: AgentMessage[], _signal?: AbortSignal): Promise<AgentMessage[]> => {
    const estimated = estimateTokens(JSON.stringify(messages));
    if (estimated > maxTokens * 0.8) {
      return compactHistory(messages, maxTokens);
    }
    return messages;
  };
}

// ── Pi-Agent Loop (main class) ──────────────────────────────────

export class PiAgentLoop {
  private agent: Agent;
  private streamState: DeepSeekStreamState;
  private options: Required<PiAgentLoopOptions>;
  private subscribers: Array<(event: any) => void | Promise<void>> = [];
  private roundCount = 0;

  constructor(options: PiAgentLoopOptions = {}) {
    this.options = {
      modelType: options.modelType ?? "expert",
      thinkingEnabled: options.thinkingEnabled ?? false,
      maxRounds: options.maxRounds ?? 25,
      maxContextTokens: options.maxContextTokens ?? 16_000,
    };

    this.streamState = {
      sessionId: "",
      parentMessageId: null,
      authToken: null,
      cookieHeader: null,
      powSolver: null,
      modelType: this.options.modelType,
      thinkingEnabled: this.options.thinkingEnabled,
    };

    const streamFn = createDeepSeekStreamFn(this.streamState);
    const transformContext = createTransformContext(this.options.maxContextTokens);

    this.agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(),
        model: {
          id: this.options.modelType,
          name: `DeepSeek ${this.options.modelType}`,
          api: "deepseek",
          provider: "deepseek",
          baseUrl: "https://chat.deepseek.com",
          reasoning: this.options.thinkingEnabled,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: this.options.maxContextTokens,
          maxTokens: 8192,
        },
        thinkingLevel: this.options.thinkingEnabled ? "medium" : "off",
        tools: createPiTools(),
      },
      streamFn,
      convertToLlm: piConvertToLlm,
      transformContext,
      toolExecution: "sequential",
      maxRetryDelayMs: 30000,
    });

    // Subscribe to agent events and re-emit them
    this.agent.subscribe(async (event: AgentEvent, _signal: AbortSignal) => {
      for (const cb of this.subscribers) {
        try {
          await cb(event);
        } catch {
          // ignore subscriber errors
        }
      }
    });
  }

  subscribe(cb: (event: any) => void | Promise<void>): () => void {
    this.subscribers.push(cb);
    return () => {
      const idx = this.subscribers.indexOf(cb);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  get modelType(): string {
    return this.options.modelType;
  }

  set modelType(m: string) {
    this.options.modelType = m;
    this.streamState.modelType = m;
    this.agent.state.model = {
      ...this.agent.state.model,
      id: m,
      name: `DeepSeek ${m}`,
    };
  }

  get thinkingEnabled(): boolean {
    return this.options.thinkingEnabled;
  }

  set thinkingEnabled(enabled: boolean) {
    this.options.thinkingEnabled = enabled;
    this.streamState.thinkingEnabled = enabled;
    this.agent.state.thinkingLevel = enabled ? "medium" : "off";
  }

  set maxRounds(n: number) {
    this.options.maxRounds = n;
  }

  get maxRounds(): number {
    return this.options.maxRounds;
  }

  clearMessages(): void {
    this.agent.reset();
    this.streamState.sessionId = "";
    this.streamState.parentMessageId = null;
    this.roundCount = 0;
  }

  abort(): void {
    this.agent.abort();
  }

  async init(): Promise<void> {
    const auth = await loadAuth();
    if (!auth.token) {
      throw new Error("No DeepSeek auth token found. Set DEEPSEEK_TOKEN or ensure .pi/agent/deepseek_token.txt exists.");
    }
    this.streamState.authToken = auth.token;
    this.streamState.cookieHeader = auth.cookieHeader;
    this.streamState.sessionId = await createSession(auth.token, auth.cookieHeader, this.options.modelType);
  }

  async newSession(): Promise<void> {
    this.agent.reset();
    this.roundCount = 0;
    const auth = await loadAuth();
    if (!auth.token) throw new Error("No DeepSeek auth token found.");
    this.streamState.authToken = auth.token;
    this.streamState.cookieHeader = auth.cookieHeader;
    this.streamState.parentMessageId = null;
    this.streamState.sessionId = await createSession(auth.token, auth.cookieHeader, this.options.modelType);
  }

  async execute(userInput: string): Promise<void> {
    this.roundCount = 0;

    // Add shouldStopAfterTurn to limit rounds
    const originalLoopConfig = (this.agent as any).createLoopConfig;
    (this.agent as any).createLoopConfig = (options: any = {}) => {
      const config = originalLoopConfig.call(this.agent, options);
      config.shouldStopAfterTurn = async (ctx: any) => {
        this.roundCount++;
        if (this.roundCount >= this.options.maxRounds) {
          return true;
        }
        return false;
      };
      return config;
    };

    try {
      await this.agent.prompt(userInput);
      await this.agent.waitForIdle();
    } finally {
      // Restore original createLoopConfig
      (this.agent as any).createLoopConfig = originalLoopConfig;
    }
  }

  get messagesSnapshot(): Array<{ role: string; content: string; name?: string }> {
    return this.agent.state.messages.map((m: any) => ({
      role: m.role === "toolResult" ? "tool" : m.role,
      content: typeof m.content === "string" ? m.content : m.content?.map((c: any) => c.type === "text" ? c.text : "").join("") || "",
      name: m.toolName,
    }));
  }

  get turnCount(): number {
    return this.agent.state.messages.filter((m: any) => m.role === "user").length;
  }

  estimateCurrentTokens(): number {
    return estimateTokens(JSON.stringify(this.agent.state.messages));
  }
}
