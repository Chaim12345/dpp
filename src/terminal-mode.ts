// ── Terminal Mode using pi-tui ─────────────────────────────────
// Interactive terminal UI for the DeepSeek agent using pi-tui components.
// Uses pi's SessionManager for persistence, pi-tui for rendering.

import {
  Container,
  Text,
  Markdown,
  Spacer,
  StdinBuffer,
  setCellDimensions,
  truncateToWidth,
  Key,
} from "@earendil-works/pi-tui";
import {
  initTheme,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { createPiSession, type PiSession } from "./pi-session.js";

// ── Theme-based Styling ─────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  gray: "\x1b[90m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function s(text: string, ...styles: string[]): string {
  return styles.join("") + text + C.reset;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function cleanAssistantText(text: string): string {
  let cleaned = text.replace(/\[Assistant\]\s*/g, "");
  cleaned = cleaned.replace(/\[Tool:\w+\]\s*\{[^}]*\}\s*/g, "");
  cleaned = cleaned.replace(/^\s*\{[^}]*\}\s*$/gm, "");
  cleaned = cleaned.replace(/\*\*Calling:\*\*\s*`[^`]*`\s*/g, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) { lines.push(""); continue; }
    let remaining = rawLine;
    while (remaining.length > 0) {
      let cut = width;
      if (cut >= remaining.length) {
        lines.push(remaining);
        break;
      }
      const segment = remaining.slice(0, cut);
      const spaceIdx = segment.lastIndexOf(" ");
      if (spaceIdx > width * 0.5) {
        lines.push(remaining.slice(0, spaceIdx));
        remaining = remaining.slice(spaceIdx + 1);
      } else {
        lines.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut);
      }
    }
  }
  return lines;
}

// ── Terminal Mode ──────────────────────────────────────────────

interface TerminalModeOptions {
  modelType?: string;
  thinkingEnabled?: boolean;
  maxRounds?: number;
}

interface DisplayMessage {
  role: "user" | "assistant" | "tool" | "system" | "error" | "thinking";
  content: string;
  timestamp: number;
  name?: string;
  duration?: string;
  isError?: boolean;
}

export class TerminalMode {
  private session: PiSession | null = null;
  private messages: DisplayMessage[] = [];
  private inputBuffer = "";
  private isStreaming = false;
  private currentTool: { name: string; args: string; startTime: number } | null = null;
  private statusText = "Ready";
  private statusColor = C.green;
  private running = false;
  private cursorVisible = true;

  // Streaming accumulation
  private currentAssistantText = "";
  private currentThinkingText = "";
  private currentToolCalls: { id: string; name: string; args: string }[] = [];
  private toolExecutionStarts = new Map<string, number>();
  private currentToolPartialResult = "";
  private renderPending = false;

  private options: Required<TerminalModeOptions>;

  private theme: ReturnType<typeof getMarkdownTheme> | null = null;

  constructor(options: TerminalModeOptions = {}) {
    this.options = {
      modelType: options.modelType ?? "expert",
      thinkingEnabled: options.thinkingEnabled ?? false,
      maxRounds: options.maxRounds ?? 25,
    };
  }

  private getSize(): { cols: number; rows: number } {
    if (process.stdout.isTTY) {
      return {
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
      };
    }
    return { cols: 80, rows: 24 };
  }

  private setRawMode(raw: boolean): void {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(raw);
    }
  }

  private showCursor(): void {
    if (!this.cursorVisible) {
      process.stdout.write("\x1b[?25h");
      this.cursorVisible = true;
    }
  }

  private hideCursor(): void {
    if (this.cursorVisible) {
      process.stdout.write("\x1b[?25l");
      this.cursorVisible = false;
    }
  }

  private renderThrottled(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    setTimeout(() => {
      this.renderPending = false;
      this.render();
    }, 50);
  }

  private buildHeader(cols: number, rows: number): Container {
    const header = new Container();

    const modelTag = s(` ${this.options.modelType} `, C.gray);
    const thinkTag = s(` Thinking: ${this.options.thinkingEnabled ? "ON" : "OFF"} `, C.gray);

    const headerText = s(" DeepSeek Agent ", C.bold) + modelTag + thinkTag;
    const sep = "─".repeat(cols);

    header.addChild(new Text(headerText, 1, 0));
    header.addChild(new Text(sep, 0, 0));
    header.addChild(new Spacer(1));

    return header;
  }

  private buildMessage(msg: DisplayMessage, theme: ReturnType<typeof getMarkdownTheme>): Container {
    const mc = new Container();

    switch (msg.role) {
      case "user": {
        const prefix = s("▸ ", C.cyan, C.bold);
        const wrapped = wrapText(msg.content, 78);
        for (let i = 0; i < wrapped.length; i++) {
          mc.addChild(new Text((i === 0 ? prefix : "  ") + wrapped[i], 1, 0));
        }
        mc.addChild(new Spacer(1));
        break;
      }
      case "assistant": {
        const cleaned = cleanAssistantText(msg.content);
        if (cleaned) {
          const md = new Markdown(cleaned, 2, 0, theme);
          mc.addChild(md);
          mc.addChild(new Spacer(1));
        }
        break;
      }
      case "thinking": {
        const wrapped = wrapText(msg.content, 74);
        for (const line of wrapped.slice(0, 5)) {
          mc.addChild(new Text(s("   " + line, C.dim), 1, 0));
        }
        if (wrapped.length > 5) {
          mc.addChild(new Text(s(`   ... (${wrapped.length - 5} more lines)`, C.gray, C.dim), 1, 0));
        }
        mc.addChild(new Spacer(1));
        break;
      }
      case "tool": {
        const toolHeader = s(`  ⚙ ${msg.name || "tool"}`, C.dim) +
          (msg.duration ? s(` (${msg.duration})`, C.gray, C.dim) : "");
        mc.addChild(new Text(toolHeader, 1, 0));
        const contentWrapped = wrapText(msg.content, 76);
        const maxLines = msg.isError ? 5 : 3;
        for (const line of contentWrapped.slice(0, maxLines)) {
          mc.addChild(new Text(s("    " + line, msg.isError ? C.red : C.gray, C.dim), 1, 0));
        }
        if (contentWrapped.length > maxLines) {
          mc.addChild(new Text(s(`    ... (${contentWrapped.length - maxLines} more)`, C.gray, C.dim), 1, 0));
        }
        mc.addChild(new Spacer(1));
        break;
      }
      case "error": {
        mc.addChild(new Text(s(`  ✗ ${msg.content}`, C.red, C.bold), 1, 0));
        mc.addChild(new Spacer(1));
        break;
      }
      case "system": {
        const wrapped = wrapText(msg.content, 78);
        for (const line of wrapped) {
          mc.addChild(new Text(s("  " + line, C.gray, C.dim), 1, 0));
        }
        mc.addChild(new Spacer(1));
        break;
      }
    }

    return mc;
  }

  private renderContent(cols: number, rows: number): string[] {
    const theme = this.theme!;
    const content = new Container();

    // Header
    content.addChild(this.buildHeader(cols, rows));

    // Messages
    for (const msg of this.messages) {
      content.addChild(this.buildMessage(msg, theme));
    }

    // Streaming indicator + content
    if (this.isStreaming) {
      if (this.currentThinkingText) {
        const thinkLines = wrapText(this.currentThinkingText, 74);
        for (const line of thinkLines.slice(-2)) {
          content.addChild(new Text(s("   " + line, C.dim), 1, 0));
        }
        content.addChild(new Spacer(1));
      }

      if (this.currentAssistantText) {
        const cleaned = cleanAssistantText(this.currentAssistantText);
        if (cleaned) {
          content.addChild(new Markdown(cleaned, 1, 0, theme));
          content.addChild(new Spacer(1));
        }
      }

      // Show tool calls detected during streaming
      for (const tc of this.currentToolCalls) {
        content.addChild(new Text(s(`  ⚙ ${tc.name}(${tc.args})`, C.dim), 1, 0));
      }

      // Streaming ellipsis
      if (!this.currentTool) {
        content.addChild(new Text(s("  ⋯", C.dim), 1, 0));
        content.addChild(new Spacer(1));
      }
    }

    // Current tool with execution progress
    if (this.currentTool) {
      const elapsed = ((Date.now() - this.currentTool.startTime) / 1000).toFixed(1);
      content.addChild(new Text(s(`  ⚙ ${this.currentTool.name} [${elapsed}s]`, C.yellow), 1, 0));

      // Show streaming partial result if available (e.g. edit diff, bash output)
      if (this.currentToolPartialResult) {
        const partialLines = this.currentToolPartialResult.split("\n").slice(0, 8);
        for (const line of partialLines) {
          content.addChild(new Text(s("    " + line, C.gray, C.dim), 1, 0));
        }
        if (this.currentToolPartialResult.split("\n").length > 8) {
          content.addChild(new Text(s("    ... (streaming)", C.gray, C.dim), 1, 0));
        }
      }
      content.addChild(new Spacer(1));
    }

    return content.render(cols);
  }

  private renderFooter(cols: number, rows: number): { inputLine: string; statusLine: string } {
    const inputPrefix = s("▸ ", C.cyan, C.bold);
    const inputText = this.inputBuffer || s("Type a message...", C.gray, C.dim);

    const sessionInfo = this.session
      ? `  T:${this.session.turnCount}  Tok:~${this.session.estimateTokens()}`
      : "";
    const statusStr = s(this.statusText, this.statusColor, C.bold) +
      s(`  M:${this.messages.length}`, C.gray) +
      s(sessionInfo, C.gray);

    return {
      inputLine: inputPrefix + inputText,
      statusLine: " " + statusStr,
    };
  }

  private render(): void {
    const { cols, rows } = this.getSize();
    setCellDimensions({ cols, rows });

    // Fixed footer (always visible, 2 lines)
    const footer = this.renderFooter(cols, rows);

    // Scrollable content area (no padding — flush to footer)
    const maxContentRows = rows - 2;
    const contentLines = this.renderContent(cols, maxContentRows);

    // Show the most recent lines, up to available rows
    const scrollStart = Math.max(0, contentLines.length - maxContentRows);
    const visibleContent = contentLines.slice(scrollStart);

    // Home cursor
    process.stdout.write("\x1b[H");

    // Write content lines (clear each line to prevent ghost characters)
    for (const line of visibleContent) {
      process.stdout.write(truncateToWidth(line, cols));
      process.stdout.write("\x1b[K");
      process.stdout.write("\n");
    }

    // Input line
    process.stdout.write(truncateToWidth(footer.inputLine, cols));
    process.stdout.write("\x1b[K");
    process.stdout.write("\n");

    // Status line
    process.stdout.write(truncateToWidth(footer.statusLine, cols));
    process.stdout.write("\x1b[K");

    // Clear everything below (handles when previous render was taller)
    process.stdout.write("\x1b[J");

    // Position cursor on the input line
    const inputRow = visibleContent.length + 1;
    const cursorCol = 3 + visibleLength(this.inputBuffer);
    process.stdout.write(`\x1b[${inputRow};${Math.min(cursorCol, cols - 1)}H`);
  }

  private handleKey(key: string): boolean {
    if (key === "\u0003" || key === Key.CtrlC) {
      return false;
    }
    if (key === "\x0c" || key === Key.CtrlL) {
      process.stdout.write("\x1b[2J\x1b[H");
      this.render();
      return true;
    }
    if (key === "\x1b" || key === Key.Escape) {
      this.inputBuffer = "";
      return true;
    }
    if (key === "\r" || key === "\n" || key === Key.Enter) {
      if (this.inputBuffer.trim() && !this.isStreaming) {
        const text = this.inputBuffer.trim();
        this.inputBuffer = "";
        if (text === "/clear") {
          this.messages = [];
          this.session?.clearMessages();
          this.render();
          return true;
        }
        if (text === "/new") {
          this.messages = [];
          this.session?.newSession();
          this.render();
          return true;
        }
        if (text === "/quit" || text === "/exit") {
          return false;
        }
        this.submitMessage(text);
      }
      return true;
    }
    if (key === "\x7f" || key === "\b" || key === Key.Backspace) {
      this.inputBuffer = this.inputBuffer.slice(0, -1);
      return true;
    }
    if (key.length > 1 && key !== "\t") {
      return true;
    }
    if (key === "\t") {
      return true;
    }
    if (key.length === 1 && key >= " ") {
      this.inputBuffer += key;
      return true;
    }
    return true;
  }

  private async submitMessage(text: string): Promise<void> {
    this.messages.push({
      role: "user",
      content: text,
      timestamp: Date.now(),
    });

    this.isStreaming = true;
    this.currentAssistantText = "";
    this.currentThinkingText = "";
    this.currentToolCalls = [];
    this.currentToolPartialResult = "";
    this.statusText = "Processing...";
    this.statusColor = C.cyan;
    this.render();

    try {
      if (!this.session) {
        this.session = await createPiSession({
          modelType: this.options.modelType,
          thinkingEnabled: this.options.thinkingEnabled,
          maxRounds: this.options.maxRounds,
          persistSessions: true,
        });
      }

      const unsub = this.session.subscribe((event: any) => {
        switch (event.type) {
          case "turn_start":
            this.statusText = `Turn ${event.round || "?"}`;
            this.statusColor = C.cyan;
            this.render();
            break;

          case "message_update":
            if (event.assistantMessageEvent) {
              const ame = event.assistantMessageEvent;
              if (ame.type === "text_delta") {
                this.currentAssistantText += ame.delta || "";
                this.renderThrottled();
              } else if (ame.type === "thinking_delta") {
                this.currentThinkingText += ame.delta || "";
                this.renderThrottled();
              }
            }
            // Extract tool calls from the partial assistant message
            if (event.message?.content) {
              const calls = event.message.content
                .filter((c: any) => c.type === "toolCall")
                .map((c: any) => ({
                  id: c.id,
                  name: c.name,
                  args: JSON.stringify(c.arguments || {}).slice(0, 80),
                }));
              if (calls.length > 0 || this.currentToolCalls.length > 0) {
                this.currentToolCalls = calls;
                this.renderThrottled();
              }
            }
            break;

          case "message_end": {
            // If this is a tool result message, push it as a tool display message
            if (event.message?.role === "toolResult") {
              const text = event.message.content
                ?.map((c: any) => c.text || "").join("") || "";
              this.messages.push({
                role: "tool",
                content: text.slice(0, 500),
                timestamp: Date.now(),
                name: event.message.toolName || "tool",
                isError: event.message.isError || false,
              });
              this.render();
            }
            break;
          }

          case "tool_execution_start":
            this.toolExecutionStarts.set(event.toolCallId, Date.now());
            this.currentTool = {
              name: event.toolName,
              args: JSON.stringify(event.args || {}).slice(0, 60),
              startTime: Date.now(),
            };
            this.currentToolPartialResult = "";
            this.statusText = `Executing ${event.toolName}`;
            this.statusColor = C.yellow;
            this.render();
            break;

          case "tool_execution_update":
            if (this.currentTool) {
              this.currentToolPartialResult = event.partialResult?.content?.[0]?.text || "";
              this.renderThrottled();
            }
            break;

          case "tool_execution_end": {
            const startTime = this.toolExecutionStarts.get(event.toolCallId);
            const duration = startTime
              ? ((Date.now() - startTime) / 1000).toFixed(1) + "s"
              : "";
            this.toolExecutionStarts.delete(event.toolCallId);
            this.currentTool = null;
            this.currentToolPartialResult = "";
            this.statusText = `${event.toolName} complete`;
            this.statusColor = event.isError ? C.red : C.green;
            this.render();
            break;
          }

          case "agent_end":
            if (this.currentAssistantText) {
              this.messages.push({
                role: "assistant",
                content: cleanAssistantText(this.currentAssistantText),
                timestamp: Date.now(),
              });
            }
            this.currentToolCalls = [];
            break;

          case "error":
            this.messages.push({
              role: "error",
              content: event.error?.message || "Unknown error",
              timestamp: Date.now(),
            });
            break;
        }
      });

      await this.session.prompt(text);
      unsub();

    } catch (err) {
      this.messages.push({
        role: "error",
        content: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });
    }

    this.isStreaming = false;
    this.currentTool = null;
    this.currentAssistantText = "";
    this.currentThinkingText = "";
    this.currentToolCalls = [];
    this.currentToolPartialResult = "";
    this.toolExecutionStarts.clear();
    this.statusText = "Ready";
    this.statusColor = C.green;
    this.render();
  }

  async run(): Promise<void> {
    this.running = true;

    // Initialize pi theme
    initTheme();
    this.theme = getMarkdownTheme();

    // Initialize session
    this.session = await createPiSession({
      modelType: this.options.modelType,
      thinkingEnabled: this.options.thinkingEnabled,
      maxRounds: this.options.maxRounds,
      persistSessions: true,
    });

    // Setup terminal
    process.stdout.write("\x1b[2J\x1b[H");
    this.hideCursor();
    this.setRawMode(true);

    this.messages.push({
      role: "system",
      content: `DeepSeek Agent [${this.options.modelType}] — Terminal Mode\n` +
        `Thinking: ${this.options.thinkingEnabled ? "ON" : "OFF"}  Max rounds: ${this.options.maxRounds}\n` +
        `Commands: /clear /new /quit`,
      timestamp: Date.now(),
    });

    this.render();

    // Input handling using pi-tui StdinBuffer
    const stdinBuffer = new StdinBuffer();

    const onKey = (key: string) => {
      if (!this.running) return;
      const shouldContinue = this.handleKey(key);
      if (!shouldContinue) {
        this.running = false;
      } else {
        this.render();
      }
    };

    const onResize = () => {
      if (this.running) {
        const { cols, rows } = this.getSize();
        setCellDimensions({ cols, rows });
        this.render();
      }
    };

    stdinBuffer.on("data", onKey);
    process.stdin.on("data", (data: Buffer) => stdinBuffer.process(data));
    process.stdout.on("resize", onResize);

    // Wait for exit
    await new Promise<void>((resolve) => {
      const check = () => {
        if (!this.running) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });

    // Cleanup
    stdinBuffer.off("data", onKey);
    stdinBuffer.destroy();
    process.stdout.off("resize", onResize);
    this.setRawMode(false);
    this.showCursor();
    process.stdout.write("\n");

    this.session?.dispose();
  }

  stop(): void {
    this.running = false;
  }
}

// ── Run Terminal Mode ──────────────────────────────────────────

export async function runTerminalMode(options: TerminalModeOptions = {}): Promise<void> {
  const mode = new TerminalMode(options);

  process.on("SIGINT", () => {
    mode.stop();
  });

  process.on("SIGTERM", () => {
    mode.stop();
  });

  await mode.run();
}

// ── Direct execution ───────────────────────────────────────────
if (process.argv[1]?.endsWith("terminal-mode.ts") || process.argv[1]?.endsWith("terminal-mode.js")) {
  runTerminalMode({
    modelType: process.env.MODEL_TYPE || "expert",
    thinkingEnabled: process.env.THINKING === "1" || process.env.THINKING === "true",
    maxRounds: parseInt(process.env.MAX_ROUNDS || "25", 10),
  }).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
