// ── Terminal Mode using pi-tui ─────────────────────────────────
// Interactive terminal UI for the DeepSeek agent using pi-tui components.
// Uses pi's SessionManager for persistence, pi-tui for rendering.

import {
  TUI,
  Container,
  Box,
  Text,
  Markdown,
  Input,
  SelectList,
  Spacer,
  setCellDimensions,
  truncateToWidth,
  parseKey,
  Key,
  getCapabilities,
} from "@earendil-works/pi-tui";
import {
  initTheme,
  getMarkdownTheme,
  SessionManager,
  AuthStorage,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { createPiSession, type PiSession } from "./pi-session.js";

// ── ANSI Color Helpers ──────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  brightCyan: "\x1b[96m",
  brightYellow: "\x1b[93m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  bgBlue: "\x1b[48;5;24m",
  bgDark: "\x1b[48;5;235m",
  bgDarker: "\x1b[48;5;233m",
};

function s(text: string, ...styles: string[]): string {
  return styles.join("") + text + C.reset;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
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
      // Try to break at word boundary
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
  private stdinRaw = false;
  private cursorVisible = true;
  private lastRenderHeight = 0;

  // Streaming accumulation
  private currentAssistantText = "";
  private currentThinkingText = "";

  private options: Required<TerminalModeOptions>;

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
      this.stdinRaw = raw;
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

  private clearScreen(): void {
    process.stdout.write("\x1b[2J\x1b[H");
  }

  private moveCursor(row: number, col: number): void {
    process.stdout.write(`\x1b[${row};${col}H`);
  }

  /**
   * Render the full terminal UI using pi-tui components where possible,
   * with ANSI fallback for dynamic areas (input, status).
   */
  private render(): void {
    const { cols, rows } = this.getSize();
    setCellDimensions({ cols, rows });

    const headerRows = 2;
    const statusRows = 1;
    const inputRows = 3;
    const contentRows = rows - headerRows - statusRows - inputRows;

    // ── Header ──
    const header = s(" DeepSeek Agent ", C.bgBlue, C.white, C.bold) +
      s(` [${this.options.modelType}] `, C.bgDark, C.gray) +
      s(` Thinking: ${this.options.thinkingEnabled ? "ON" : "OFF"} `, C.bgDark, C.gray) +
      " ".repeat(Math.max(1, cols - 55));

    // ── Build content lines ──
    const contentLines: string[] = [];

    for (const msg of this.messages) {
      if (msg.role === "user") {
        const prefix = s("▸ ", C.cyan, C.bold);
        const wrapped = wrapText(msg.content, cols - 2);
        for (let i = 0; i < wrapped.length; i++) {
          contentLines.push(i === 0 ? prefix + wrapped[i] : "  " + wrapped[i]);
        }
        contentLines.push("");
      } else if (msg.role === "assistant") {
        const wrapped = wrapText(msg.content, cols - 2);
        for (const line of wrapped) {
          contentLines.push("  " + line);
        }
        contentLines.push("");
      } else if (msg.role === "thinking") {
        const prefix = s("💭 ", C.dim);
        const wrapped = wrapText(msg.content, cols - 4);
        for (const line of wrapped.slice(0, 5)) {
          contentLines.push(s("    " + line, C.dim));
        }
        if (wrapped.length > 5) {
          contentLines.push(s(`    ... (${wrapped.length - 5} more lines)`, C.gray, C.dim));
        }
        contentLines.push("");
      } else if (msg.role === "tool") {
        const toolHeader = s(`  ⚙ ${msg.name || "tool"}`, C.yellow, C.dim) +
          (msg.duration ? s(` (${msg.duration})`, C.gray, C.dim) : "");
        contentLines.push(toolHeader);
        const contentWrapped = wrapText(msg.content, cols - 4);
        const maxLines = msg.isError ? 5 : 3;
        for (const line of contentWrapped.slice(0, maxLines)) {
          contentLines.push(s("    " + line, msg.isError ? C.red : C.gray, C.dim));
        }
        if (contentWrapped.length > maxLines) {
          contentLines.push(s(`    ... (${contentWrapped.length - maxLines} more)`, C.gray, C.dim));
        }
        contentLines.push("");
      } else if (msg.role === "error") {
        contentLines.push(s(`  ✗ ${msg.content}`, C.red, C.bold));
        contentLines.push("");
      } else if (msg.role === "system") {
        const wrapped = wrapText(msg.content, cols - 2);
        for (const line of wrapped) {
          contentLines.push(s("  " + line, C.gray, C.dim));
        }
        contentLines.push("");
      }
    }

    // Streaming indicator
    if (this.isStreaming) {
      contentLines.push(s("  ⋯ Streaming response...", C.cyan, C.dim));
    }

    // Current tool execution
    if (this.currentTool) {
      const elapsed = ((Date.now() - this.currentTool.startTime) / 1000).toFixed(1);
      contentLines.push(s(`  ⚙ Executing: ${this.currentTool.name}(${this.currentTool.args}) [${elapsed}s]`, C.yellow, C.bold));
    }

    // Accumulating assistant text during streaming
    if (this.isStreaming && this.currentAssistantText) {
      const wrapped = wrapText(this.currentAssistantText, cols - 2);
      // Show last portion that fits
      const availableRows = contentRows - contentLines.length - 2;
      const showLines = wrapped.slice(-Math.max(1, availableRows));
      for (const line of showLines) {
        contentLines.push("  " + line);
      }
    }

    // Accumulating thinking during streaming
    if (this.isStreaming && this.currentThinkingText) {
      const wrapped = wrapText(this.currentThinkingText, cols - 4);
      const showLines = wrapped.slice(-2);
      for (const line of showLines) {
        contentLines.push(s("    " + line, C.dim));
      }
    }

    // Trim to fit content area
    if (contentLines.length > contentRows) {
      contentLines.splice(0, contentLines.length - contentRows);
    }

    // Pad to fill content area
    while (contentLines.length < contentRows) {
      contentLines.push("");
    }

    // ── Output ──
    process.stdout.write("\x1b[H"); // Home cursor

    // Header
    process.stdout.write(truncateToWidth(header, cols) + "\n");
    process.stdout.write("─".repeat(cols) + "\n");

    // Content
    for (const line of contentLines) {
      process.stdout.write(truncateToWidth(line, cols) + "\n");
    }

    // Separator
    process.stdout.write("─".repeat(cols) + "\n");

    // Status bar
    const sessionInfo = this.session ?
      s(` Turns: ${this.session.turnCount} `, C.gray, C.bgDark) +
      s(` Tokens: ~${this.session.estimateTokens()} `, C.gray, C.bgDark) : "";
    const statusLine = s(` ${this.statusText} `, this.statusColor, C.bgDark, C.bold) +
      s(` Messages: ${this.messages.length} `, C.gray, C.bgDark) +
      sessionInfo +
      " ".repeat(Math.max(1, cols - 50));
    process.stdout.write(truncateToWidth(statusLine, cols) + "\n");

    // Input area
    const inputPrefix = s("▸ ", C.cyan, C.bold);
    const placeholder = s("Type your message... (Enter to send, Ctrl+C to quit, /clear to reset)", C.gray, C.dim);
    const inputDisplay = this.inputBuffer || placeholder;
    const wrappedInput = wrapText(inputDisplay, cols - 2);
    const showInputLines = wrappedInput.slice(0, inputRows - 1);
    for (let i = 0; i < showInputLines.length; i++) {
      process.stdout.write((i === 0 ? inputPrefix : "  ") + truncateToWidth(showInputLines[i], cols - 2) + "\n");
    }
    // Pad remaining input rows
    for (let i = showInputLines.length; i < inputRows - 1; i++) {
      process.stdout.write("\n");
    }

    // Position cursor at end of input
    const inputLineCount = showInputLines.length;
    const lastInputLine = showInputLines[showInputLines.length - 1] || "";
    const cursorCol = 3 + visibleLength(inputPrefix) + visibleLength(lastInputLine);
    const cursorRow = headerRows + contentRows + statusRows + inputLineCount;
    this.moveCursor(Math.min(cursorRow, rows), Math.min(cursorCol, cols));

    this.lastRenderHeight = rows;
  }

  private handleKey(data: Buffer): boolean {
    const key = parseKey(data);

    // Ctrl+C
    if (key === Key.CtrlC || data.toString() === "\u0003") {
      return false;
    }

    // Ctrl+L - clear screen
    if (key === Key.CtrlL || data.toString() === "\x0c") {
      this.clearScreen();
      this.render();
      return true;
    }

    // Escape - clear input
    if (key === Key.Escape || data.toString() === "\x1b") {
      this.inputBuffer = "";
      return true;
    }

    // Enter
    if (key === Key.Enter || data.toString() === "\r" || data.toString() === "\n") {
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

    // Backspace
    if (key === Key.Backspace || data.toString() === "\x7f" || data.toString() === "\b") {
      this.inputBuffer = this.inputBuffer.slice(0, -1);
      return true;
    }

    // Regular printable character
    const ch = data.toString();
    if (ch.length === 1 && ch >= " ") {
      this.inputBuffer += ch;
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
            this.statusText = `Round ${event.round || "?"}`;
            this.statusColor = C.cyan;
            this.render();
            break;

          case "message_update":
            if (event.assistantMessageEvent) {
              const ame = event.assistantMessageEvent;
              if (ame.type === "text_delta") {
                this.currentAssistantText += ame.delta || "";
                this.render();
              } else if (ame.type === "thinking_delta") {
                this.currentThinkingText += ame.delta || "";
                this.render();
              }
            }
            break;

          case "tool_execution_start":
            this.currentTool = {
              name: event.toolName,
              args: JSON.stringify(event.args || {}).slice(0, 60),
              startTime: Date.now(),
            };
            this.statusText = `Executing ${event.toolName}`;
            this.statusColor = C.yellow;
            this.render();
            break;

          case "tool_execution_end": {
            const content = event.result?.content?.map((c: any) => c.text || "").join("") || "";
            this.messages.push({
              role: "tool",
              content: content.slice(0, 500),
              timestamp: Date.now(),
              name: event.toolName,
              duration: event.duration,
              isError: event.isError || false,
            });
            this.currentTool = null;
            this.statusText = `${event.toolName} complete`;
            this.statusColor = event.isError ? C.red : C.green;
            this.render();
            break;
          }

          case "agent_end": {
            // Extract assistant message from final messages
            const msgs = event.messages || [];
            for (const m of msgs) {
              if (m.role === "assistant") {
                const msgText = typeof m.content === "string"
                  ? m.content
                  : m.content?.map((c: any) => c.type === "text" ? c.text : "").join("") || "";
                if (msgText && msgText !== this.currentAssistantText) {
                  this.messages.push({
                    role: "assistant",
                    content: msgText,
                    timestamp: Date.now(),
                  });
                }
              }
            }
            // If we accumulated text but didn't get it from agent_end, use that
            if (this.currentAssistantText) {
              const lastMsg = this.messages[this.messages.length - 1];
              if (!lastMsg || lastMsg.role !== "assistant" || lastMsg.content !== this.currentAssistantText) {
                this.messages.push({
                  role: "assistant",
                  content: this.currentAssistantText,
                  timestamp: Date.now(),
                });
              }
            }
            break;
          }

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
    this.statusText = "Ready";
    this.statusColor = C.green;
    this.render();
  }

  async run(): Promise<void> {
    this.running = true;

    // Initialize pi theme
    initTheme();

    // Initialize session
    this.session = await createPiSession({
      modelType: this.options.modelType,
      thinkingEnabled: this.options.thinkingEnabled,
      maxRounds: this.options.maxRounds,
      persistSessions: true,
    });

    // Setup terminal
    this.clearScreen();
    this.hideCursor();
    this.setRawMode(true);

    // Welcome message
    const sessionFile = this.session.sessionManager.getSessionFile();
    this.messages.push({
      role: "system",
      content: `DeepSeek Agent [${this.options.modelType}] - Terminal Mode\n` +
        `Thinking: ${this.options.thinkingEnabled ? "ON" : "OFF"} | Max rounds: ${this.options.maxRounds}\n` +
        `Session: ${sessionFile || "in-memory"}\n` +
        `Commands: /clear, /new, /quit`,
      timestamp: Date.now(),
    });

    this.render();

    // Input handling
    const onData = (data: Buffer) => {
      if (!this.running) return;
      const shouldContinue = this.handleKey(data);
      if (!shouldContinue) {
        this.running = false;
      } else {
        this.render();
      }
    };

    // Handle resize
    const onResize = () => {
      if (this.running) {
        const { cols, rows } = this.getSize();
        setCellDimensions({ cols, rows });
        this.render();
      }
    };

    process.stdin.on("data", onData);
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
    process.stdin.off("data", onData);
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
