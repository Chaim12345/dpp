// ── Unified Agent Loop ────────────────────────────────
// Single event-driven loop shared by TUI and CLI.
// Encapsulates: auth, session, streaming, tool extraction,
// tool execution, multi-turn loop, context compaction, loop guards.

import { loadAuth, createSession, chatStreamParsed, withRetry, WafTokenExpiredError, StaleAuthError } from "./web-api-client.js";
import { executeTool, extractToolCalls, stripToolCalls, getToolDescriptions, type ToolCall } from "./tool-registry.js";
import { truncateMessage, detectRepeatedCalls, estimateTokens, compactHistory, checkTurnLimit } from "./context.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { HarnessState } from "./types.js";

// ── Events emitted by the loop ────────────────────────

export type AgentLoopEvent =
  | { type: "stream_start" }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "stream_end"; fullText: string }
  | { type: "tool_call_detected"; toolCallId: string; name: string; args: Record<string, unknown>; toolKey: string }
  | { type: "tool_call_start"; toolCallId: string; name: string; args: Record<string, unknown>; toolKey: string }
  | { type: "tool_result"; toolCallId: string; name: string; content: string; isError: boolean }
  | { type: "tool_batch_start"; count: number }
  | { type: "tool_batch_end"; count: number }
  | { type: "round_complete"; round: number; hasToolCalls: boolean }
  | { type: "turn_complete"; turns: number; messages: Array<{ role: string; content: string; name?: string }> }
  | { type: "warning"; message: string }
  | { type: "error"; message: string }
  | { type: "status"; message: string };

type EventCallback = (event: AgentLoopEvent) => void | Promise<void>;

// ── Configuration ─────────────────────────────────────

export interface UnifiedAgentLoopOptions {
  modelType?: string;
  thinkingEnabled?: boolean;
  maxRounds?: number;
  maxContextTokens?: number;
  onEvent?: EventCallback;
}

// ── Unified Agent Loop ────────────────────────────────

export class UnifiedAgentLoop {
  private state: HarnessState;
  private messages: Array<{ role: string; content: string; name?: string }>;
  private options: Required<Omit<UnifiedAgentLoopOptions, "onEvent">> & { onEvent?: EventCallback };
  private subscribers: EventCallback[] = [];
  private toolCallHistory: ToolCall[] = [];
  private aborted = false;
  private malformedToolRetries = 0;

  constructor(options: UnifiedAgentLoopOptions = {}) {
    this.options = {
      modelType: options.modelType ?? "expert",
      thinkingEnabled: options.thinkingEnabled ?? false,
      maxRounds: options.maxRounds ?? 25,
      maxContextTokens: options.maxContextTokens ?? 16_000,
      onEvent: options.onEvent,
    };
    this.state = {
      chatSessionId: null,
      parentMessageId: null,
      memorySummary: "",
      authToken: null,
      cookieHeader: null,
    };
    this.messages = [];
    if (options.onEvent) this.subscribe(options.onEvent);
  }

  subscribe(cb: EventCallback): () => void {
    this.subscribers.push(cb);
    return () => {
      const idx = this.subscribers.indexOf(cb);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  private async emit(event: AgentLoopEvent): Promise<void> {
    for (const cb of this.subscribers) {
      try { await cb(event); } catch (e) { /* ignore subscriber errors */ }
    }
  }

  get messagesSnapshot(): Array<{ role: string; content: string; name?: string }> {
    return [...this.messages];
  }

  get turnCount(): number {
    return this.messages.filter(m => m.role === "user").length;
  }

  get modelType(): string {
    return this.options.modelType;
  }

  set modelType(m: string) {
    this.options.modelType = m;
  }

  get thinkingEnabled(): boolean {
    return this.options.thinkingEnabled;
  }

  toggleThinking(): boolean {
    this.options.thinkingEnabled = !this.options.thinkingEnabled;
    return this.options.thinkingEnabled;
  }

  set thinkingEnabled(enabled: boolean) {
    this.options.thinkingEnabled = enabled;
  }

  set maxRounds(n: number) {
    this.options.maxRounds = n;
  }

  get maxRounds(): number {
    return this.options.maxRounds;
  }

  clearMessages(): void {
    this.messages = [];
    this.toolCallHistory = [];
  }

  abort(): void {
    this.aborted = true;
  }

  // ── Initialization ──────────────────────────────────

  async init(): Promise<void> {
    const auth = await loadAuth();
    if (!auth.token) throw new Error("No DeepSeek auth token found. Set DEEPSEEK_TOKEN or ensure .pi/agent/deepseek_token.txt exists.");
    this.state.authToken = auth.token;
    this.state.cookieHeader = auth.cookieHeader;
    this.state.chatSessionId = await createSession(auth.token, auth.cookieHeader, this.options.modelType);
    await this.emit({ type: "status", message: `Session: ${this.state.chatSessionId}` });
  }

  async newSession(): Promise<void> {
    this.messages = [];
    this.toolCallHistory = [];
    this.aborted = false;
    const auth = await loadAuth();
    if (!auth.token) throw new Error("No DeepSeek auth token found.");
    this.state.authToken = auth.token;
    this.state.cookieHeader = auth.cookieHeader;
    this.state.parentMessageId = null;
    this.state.chatSessionId = await createSession(auth.token, auth.cookieHeader, this.options.modelType);
    await this.emit({ type: "status", message: `New session: ${this.state.chatSessionId}` });
  }

  // ── Main execution ──────────────────────────────────

  async execute(userInput: string): Promise<void> {
    this.aborted = false;
    this.malformedToolRetries = 0;
    const system = buildSystemPrompt();
    this.messages.push({ role: "user", content: userInput });

    for (let round = 1; round <= this.options.maxRounds; round++) {
      if (this.aborted) break;

      const limitMsg = checkTurnLimit(round, this.options.maxRounds);
      if (limitMsg) {
        await this.emit({ type: "warning", message: limitMsg });
        break;
      }

      await this.emit({ type: "status", message: `Round ${round}/${this.options.maxRounds}` });

      // Context management
      // When parentMessageId is set, the DeepSeek server already has the conversation
      // history server-side. We should only send NEW information (tool results from
      // this round) to avoid duplicating context and confusing the model.
      const isFirstRound = this.state.parentMessageId === null;
      let promptMessages: Array<{ role: string; content: string; name?: string }>;

      if (isFirstRound) {
        // First round: send all messages (user input)
        promptMessages = this.messages.length > 12
          ? this.messages.slice(-11)
          : this.messages;
      } else {
        // Subsequent rounds: only send tool results since last assistant message
        // The server already has user + assistant context via parent_message_id
        let lastAssistantIdx = -1;
        for (let i = this.messages.length - 1; i >= 0; i--) {
          if (this.messages[i].role === "assistant") {
            lastAssistantIdx = i;
            break;
          }
        }
        const toolResultMessages = lastAssistantIdx >= 0
          ? this.messages.slice(lastAssistantIdx + 1)
          : this.messages;
        promptMessages = [
          ...(toolResultMessages.length > 0 ? toolResultMessages : this.messages.slice(-1)),
          {
            role: "user",
            content:
              "Continue the same task using the tool results above. " +
              "If more work is needed, call the next tool. " +
              "If the task is complete, provide the final concise answer with verification.",
          },
        ];
      }

      const promptText = this.buildPrompt(isFirstRound ? system : "", promptMessages);
      const estimatedTokens = estimateTokens(promptText);

      if (estimatedTokens > this.options.maxContextTokens * 0.8) {
        await this.emit({ type: "warning", message: `Compacting context (${estimatedTokens} tokens)` });
        const compacted = compactHistory(this.messages, this.options.maxContextTokens);
        this.messages.length = 0;
        for (const msg of compacted) this.messages.push(msg);
      }

      // Stream response
      await this.emit({ type: "stream_start" });
      const { fullText, cleanText, streamedToolCalls } = await this.streamRound(round, promptText);

      if (!fullText && streamedToolCalls.length === 0) {
        await this.emit({ type: "warning", message: "Empty response from API" });
        break;
      }

      if (this.aborted) break;

      // Extract tool calls
      const extractedToolCalls = extractToolCalls(fullText);
      const toolCalls = extractedToolCalls && extractedToolCalls.length > 0
        ? extractedToolCalls
        : this.dedupeToolCalls(streamedToolCalls);
      for (let index = 0; index < toolCalls.length; index++) {
        const tc = toolCalls[index];
        await this.emit({
          type: "tool_call_detected",
          toolCallId: this.toolCallId(round, index),
          name: tc.name,
          args: tc.arguments,
          toolKey: this.toolCallKey(tc),
        });
      }
      await this.emit({ type: "stream_end", fullText: cleanText || (toolCalls.length === 0 ? fullText : "") });

      if (!toolCalls || toolCalls.length === 0) {
        if (this.looksLikeMalformedToolCall(fullText) && this.malformedToolRetries < 3) {
          this.malformedToolRetries++;
          await this.emit({
            type: "warning",
            message: `Malformed tool call detected. Retrying with strict JSON (${this.malformedToolRetries}/3).`,
          });
          this.messages.push({ role: "assistant", content: truncateMessage(cleanText || "[Malformed tool call omitted]") });
          this.messages.push({
            role: "user",
            content:
              "Your previous response attempted a tool call but was malformed. " +
              "Output ONLY valid JSON in this exact shape, with no prose and no XML tags: " +
              "{\"tool_calls\":[{\"name\":\"bash\",\"arguments\":{\"command\":\"find . -maxdepth 2 -type f | sort | head -200\"}}]}",
          });
          await this.emit({ type: "round_complete", round, hasToolCalls: false });
          continue;
        }
        // No tool calls — turn is complete
        this.messages.push({ role: "assistant", content: truncateMessage(cleanText || fullText) });
        await this.emit({ type: "round_complete", round, hasToolCalls: false });
        await this.emit({ type: "turn_complete", turns: this.turnCount, messages: this.messagesSnapshot });
        return;
      }

      // Has tool calls — execute them
      const assistantText = cleanText || `[Tool calls: ${toolCalls.map(t => t.name).join(", ")}]`;
      this.messages.push({ role: "assistant", content: truncateMessage(assistantText) });

      // Loop guard
      const warnings = detectRepeatedCalls(toolCalls, this.toolCallHistory);
      for (const w of warnings) await this.emit({ type: "warning", message: w });

      // Check for 3+ repeated calls across prior rounds.
      const repeatCounts = new Map<string, number>();
      for (const tc of this.toolCallHistory) {
        const key = this.toolCallKey(tc);
        repeatCounts.set(key, (repeatCounts.get(key) || 0) + 1);
      }
      for (const tc of toolCalls) {
        const key = this.toolCallKey(tc);
        repeatCounts.set(key, (repeatCounts.get(key) || 0) + 1);
      }
      const excessive = toolCalls.filter((tc) => (repeatCounts.get(this.toolCallKey(tc)) || 0) >= 3);
      if (excessive.length > 0) {
        await this.emit({ type: "warning", message: "Breaking: repeated tool calls detected (possible infinite loop)" });
        break;
      }
      this.toolCallHistory.push(...toolCalls);

      // Execute tools in parallel with async batching
      await this.emit({ type: "tool_batch_start", count: toolCalls.length });

      const executeSingle = async (tc: ToolCall, index: number): Promise<{ tc: ToolCall; content: string; isError: boolean }> => {
        if (this.aborted) return { tc, content: "Aborted", isError: true };

        const toolCallId = this.toolCallId(round, index);
        await this.emit({ type: "tool_call_start", toolCallId, name: tc.name, args: tc.arguments, toolKey: this.toolCallKey(tc) });

        if (!tc.arguments || Object.keys(tc.arguments).length === 0) {
          const msg = `Missing arguments for ${tc.name}`;
          return { tc, content: msg, isError: true };
        }

        try {
          const timeoutMs = tc.name === "bash" ? 30_000 : 10_000;
          const result = await Promise.race([
            executeTool(tc.name, tc.arguments),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Tool ${tc.name} timed out after ${timeoutMs / 1000}s`)), timeoutMs)
            ),
          ]);
          return { tc, content: result.content, isError: result.isError };
        } catch (e: unknown) {
          const msg = `Error: ${(e as Error).message}`;
          return { tc, content: msg, isError: true };
        }
      };

      // Run tools in model order. File operations and shell commands often depend on
      // previous tool output, so deterministic sequencing is safer than batching.
      const results: Array<{ tc: ToolCall; content: string; isError: boolean }> = [];
      for (let index = 0; index < toolCalls.length; index++) {
        const tc = toolCalls[index];
        const r = await executeSingle(tc, index);
        const toolCallId = this.toolCallId(round, index);
        await this.emit({ type: "tool_result", toolCallId, name: r.tc.name, content: r.content, isError: r.isError });
        results.push(r);
      }

      // Add all tool messages to history after all complete
      for (const { tc, content } of results) {
        this.messages.push({ role: "tool", name: tc.name, content: truncateMessage(content) });
      }

      await this.emit({ type: "tool_batch_end", count: results.length });

      await this.emit({ type: "round_complete", round, hasToolCalls: true });
    }

    await this.emit({ type: "turn_complete", turns: this.turnCount, messages: this.messagesSnapshot });
  }

  // ── Streaming helper ────────────────────────────────

  private async streamRound(round: number, promptText: string): Promise<{ fullText: string; cleanText: string; streamedToolCalls: ToolCall[] }> {
    let fullText = "";
    let thinkingBuf = "";
    const streamedToolCalls: ToolCall[] = [];
    const visibleFilterState = { suppressing: false, pending: "" };
    const detectedToolKeys = new Set<string>();

    const responseMessageId = await withRetry(
      () => chatStreamParsed(
        {
          sessionId: this.state.chatSessionId!,
          prompt: promptText,
          parentMessageId: this.state.parentMessageId,
          modelType: this.options.modelType,
          thinkingEnabled: this.options.thinkingEnabled,
        },
        {
          authToken: this.state.authToken,
          cookieHeader: this.state.cookieHeader,
          powSolver: null,
          parentMessageId: this.state.parentMessageId,
        },
        (ev) => {
          if (this.aborted) return;
          if (ev.type === "content") {
            fullText += ev.delta;
            const visibleDelta = this.filterVisibleDelta(ev.delta, visibleFilterState);
            if (visibleDelta) {
              this.emit({ type: "text_delta", delta: visibleDelta });
            }
          } else if (ev.type === "thinking" && this.options.thinkingEnabled) {
            thinkingBuf += ev.delta;
            this.emit({ type: "thinking_delta", delta: ev.delta });
          } else if (ev.type === "tool_calls") {
            for (const call of ev.calls) {
              const toolKey = this.toolCallKey(call);
              if (detectedToolKeys.has(toolKey)) continue;
              const toolCallId = this.toolCallId(round, streamedToolCalls.length);
              detectedToolKeys.add(toolKey);
              streamedToolCalls.push(call);
              this.emit({ type: "tool_call_detected", toolCallId, name: call.name, args: call.arguments, toolKey });
            }
          }
        },
      ),
      {
        maxRetries: 2,
        baseDelayMs: 1000,
        onRetry: (attempt, err) => this.emit({ type: "warning", message: `Retry ${attempt}/2: ${err.message}` }),
      },
    );

    if (responseMessageId != null) {
      this.state.parentMessageId = responseMessageId;
    }

    const cleanText = stripToolCalls(fullText);
    return { fullText, cleanText, streamedToolCalls };
  }

  private toolCallKey(tc: ToolCall): string {
    return `${tc.name}:${JSON.stringify(tc.arguments).slice(0, 200)}`;
  }

  private toolCallId(round: number, index: number): string {
    return `tc_r${round}_${index}`;
  }

  private dedupeToolCalls(toolCalls: ToolCall[]): ToolCall[] {
    const seen = new Set<string>();
    const deduped: ToolCall[] = [];
    for (const tc of toolCalls) {
      const key = this.toolCallKey(tc);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(tc);
    }
    return deduped;
  }

  private filterVisibleDelta(delta: string, state: { suppressing: boolean; pending: string }): string {
    const startMarkers = [
      "<｜｜DSML｜｜tool_calls>",
      "<_calls>",
      "<tool_calls>",
      "<｜｜DSML｜｜invoke",
      "<invoke",
      "<function_calls>",
      "<function_call",
      "<pi-tool-calls>",
 "Tool:",
 "Action:",
    ];
    const endMarkers = [
      "</｜｜DSML｜｜tool_calls>",
      "</_calls>",
      "</tool_calls>",
      "</｜｜DSML｜｜invoke>",
      "</invoke>",
      "</function_calls>",
      "</function_call>",
      "</pi-tool-calls>",
 "\n\n",
    ];
    const longestMarkerLength = Math.max(
      ...startMarkers.map((marker) => marker.length),
      ...endMarkers.map((marker) => marker.length),
    );

    let rest = state.pending + delta;
    state.pending = "";
    let visible = "";

    while (rest.length > 0) {
      if (state.suppressing) {
        const end = this.findFirstMarker(rest, endMarkers);
        if (!end) return visible;
        rest = rest.slice(end.index + end.marker.length);
        state.suppressing = false;
        continue;
      }

      const start = this.findFirstMarker(rest, startMarkers);
      if (!start) {
        const keep = Math.min(longestMarkerLength - 1, rest.length);
        const emitLength = rest.length - keep;
        visible += rest.slice(0, emitLength);
        state.pending = rest.slice(emitLength);
        break;
      }

      visible += rest.slice(0, start.index);
      rest = rest.slice(start.index + start.marker.length);
      state.suppressing = true;
    }

    return visible;
  }

  private findFirstMarker(text: string, markers: string[]): { index: number; marker: string } | null {
    let first: { index: number; marker: string } | null = null;
    for (const marker of markers) {
      const index = text.indexOf(marker);
      if (index === -1) continue;
      if (!first || index < first.index) first = { index, marker };
    }
    return first;
  }

  private looksLikeMalformedToolCall(text: string): boolean {
    const markers = [
      "<_calls>",
      "<tool_calls>",
      "<function_calls>",
      "<function_call",
      "<pi-tool-calls>",
 "Tool:",
 "Action:",
      "<｜｜DSML｜｜tool_calls>",
      "<｜｜DSML｜｜invoke",
      "<invoke",
      "\"tool_calls\"",
      "\"_calls\"",
      "{\"tool\"",
    ];
    if (markers.some((marker) => text.includes(marker))) return true;

    const lower = text.toLowerCase();
    return (
      lower.includes("let me start by") ||
      lower.includes("i need to explore") ||
      lower.includes("i need to read") ||
      lower.includes("i need to run")
    ) && (
      lower.includes("list") ||
      lower.includes("repository") ||
      lower.includes("file") ||
      lower.includes("directory") ||
      lower.includes("codebase")
    );
  }

  // ── Prompt builder ──────────────────────────────────

  private buildPrompt(
    system: string,
    messages: Array<{ role: string; content: string; name?: string }>,
  ): string {
    const parts: string[] = [];
    if (system) parts.push(`[System]\n${system}`);
    for (const msg of messages) {
      if (msg.role === "system") continue;
      if (msg.role === "user") parts.push(`[User]\n${msg.content}`);
      else if (msg.role === "assistant") parts.push(`[Assistant]\n${msg.content}`);
      else if (msg.role === "tool") parts.push(`[Tool:${msg.name}]\n${msg.content}`);
    }
    return parts.join("\n\n");
  }

  // ── Token estimation ────────────────────────────────

  estimateCurrentTokens(): number {
    const system = buildSystemPrompt();
    const promptText = this.buildPrompt(system, this.messages);
    return estimateTokens(promptText);
  }
}
