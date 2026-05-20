// ── Terminal Mode using pi-tui ─────────────────────────────────
// Interactive terminal UI for the DeepSeek agent using pi-tui components.
// Features: message history, input area, tool execution display, status bar.

import {
  TUI,
  Text,
  Container,
  Spacer,
  Input,
  Box,
  SelectList,
  Markdown,
  getCapabilities,
  setCellDimensions,
  truncateToWidth,
  parseKey,
  Key,
} from "@earendil-works/pi-tui";
import { initTheme, getMarkdownTheme, renderDiff } from "@earendil-works/pi-coding-agent";
import { createPiSession, type PiSession } from "./pi-session.js";
import { loadAuth, createSession } from "./web-api-client.js";

// ── Terminal Colors / Styles ───────────────────────────────────

const COLORS = {
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
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",
  bgDark: "\x1b[48;5;235m",
  bgDarker: "\x1b[48;5;233m",
  bgBlue: "\x1b[48;5;24m",
  bgGreen: "\x1b[48;5;22m",
  bgYellow: "\x1b[48;5;94m",
  bgRed: "\x1b[48;5;52m",
};

function styled(text: string, ...styles: string[]): string {
  return styles.join("") + text + COLORS.reset;
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  const rawLines = text.split("\n");
  for (const line of rawLines) {
    if (line.length <= width) {
      lines.push(line);
    } else {
      let remaining = line;
      while (remaining.length > 0) {
        const chunk = remaining.slice(0, width);
        lines.push(chunk);
        remaining = remaining.slice(width);
      }
    }
  }
  return lines;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Terminal Mode ──────────────────────────────────────────────

interface TerminalModeOptions {
  modelType?: string;
  thinkingEnabled?: boolean;
  maxRounds?: number;
}

interface MessageEntry {
  role: "user" | "assistant" | "tool" | "system" | "error";
  content: string;
  timestamp: number;
  name?: string;
  duration?: string;
}

export class TerminalMode {
  private session: PiSession | null = null;
  private messages: MessageEntry[] = [];
  private inputBuffer = "";
  private isStreaming = false;
  private currentTool: { name: string; args: string } | null = null;
  private statusText = "Ready";
  private statusColor = COLORS.green;
  private scrollOffset = 0;
  private running = false;
  private stdinRaw = false;

  private options: Required<TerminalModeOptions>;

  constructor(options: TerminalModeOptions = {}) {
    this.options = {
      modelType: options.modelType ?? "expert",
      thinkingEnabled: options.thinkingEnabled ?? false,
      maxRounds: options.maxRounds ?? 25,
    };
  }

  private getTerminalSize(): { cols: number; rows: number } {
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

  private clearScreen(): void {
    process.stdout.write("\x1b[2J\x1b[H");
  }

  private moveCursor(row: number, col: number): void {
    process.stdout.write(`\x1b[${row};${col}H`);
  }

  private hideCursor(): void {
    process.stdout.write("\x1b[?25l");
  }

  private showCursor(): void {
    process.stdout.write("\x1b[?25h");
  }

  private render(): void {
    const { cols, rows } = this.getTerminalSize();
    const headerRows = 2;
    const statusBarRows = 1;
    const inputRows = 3;
    const contentRows = rows - headerRows - statusBarRows - inputRows;

    // Header
    const header = styled(" DeepSeek Agent ", COLORS.bgBlue, COLORS.white, COLORS.bold) +
      styled(` [${this.options.modelType}] `, COLORS.bgDark, COLORS.gray) +
      styled(` Thinking: ${this.options.thinkingEnabled ? "ON" : "OFF"} `, COLORS.bgDark, COLORS.gray) +
      " ".repeat(Math.max(0, cols - 60));

    process.stdout.write(`\x1b[H`); // Move to top
    process.stdout.write(header + "\n");
    process.stdout.write("─".repeat(cols) + "\n");

    // Messages
    const visibleMessages = this.messages.slice(-Math.max(1, contentRows - 2));
    let outputLines: string[] = [];

    for (const msg of visibleMessages) {
      if (msg.role === "user") {
        const prefix = styled("▸ ", COLORS.cyan, COLORS.bold);
        const wrapped = wrapText(msg.content, cols - 2);
        for (let i = 0; i < wrapped.length; i++) {
          outputLines.push(i === 0 ? prefix + wrapped[i] : "  " + wrapped[i]);
        }
        outputLines.push("");
      } else if (msg.role === "assistant") {
        const wrapped = wrapText(msg.content, cols - 2);
        for (const line of wrapped) {
          outputLines.push("  " + line);
        }
        outputLines.push("");
      } else if (msg.role === "tool") {
        const toolLine = styled(`  ⚙ ${msg.name || "tool"}`, COLORS.yellow, COLORS.dim) +
          (msg.duration ? styled(` (${msg.duration})`, COLORS.gray, COLORS.dim) : "");
        outputLines.push(toolLine);
        const contentLines = wrapText(msg.content, cols - 4);
        for (const line of contentLines.slice(0, 3)) {
          outputLines.push(styled("    " + line, COLORS.gray, COLORS.dim));
        }
        if (contentLines.length > 3) {
          outputLines.push(styled(`    ... (${contentLines.length - 3} more lines)`, COLORS.gray, COLORS.dim));
        }
        outputLines.push("");
      } else if (msg.role === "error") {
        outputLines.push(styled(`  ✗ ${msg.content}`, COLORS.red, COLORS.bold));
        outputLines.push("");
      }
    }

    // Streaming indicator
    if (this.isStreaming) {
      outputLines.push(styled("  ⋯ Streaming...", COLORS.cyan, COLORS.dim));
    }

    // Current tool
    if (this.currentTool) {
      outputLines.push(styled(`  ⚙ Executing: ${this.currentTool.name}(${this.currentTool.args})`, COLORS.yellow, COLORS.bold));
    }

    // Trim to content area
    if (outputLines.length > contentRows) {
      outputLines = outputLines.slice(-contentRows);
    }

    // Pad to fill content area
    while (outputLines.length < contentRows) {
      outputLines.push("");
    }

    // Render content lines
    for (const line of outputLines) {
      const display = truncateToWidth(line, cols);
      process.stdout.write(display + "\n");
    }

    // Separator
    process.stdout.write("─".repeat(cols) + "\n");

    // Status bar
    const statusLine = styled(` ${this.statusText} `, this.statusColor, COLORS.bgDark, COLORS.bold) +
      styled(` Messages: ${this.messages.length} `, COLORS.gray, COLORS.bgDark) +
      styled(` Turns: ${this.session?.turnCount || 0} `, COLORS.gray, COLORS.bgDark) +
      styled(` Tokens: ~${this.session?.estimateTokens() || 0} `, COLORS.gray, COLORS.bgDark) +
      " ".repeat(Math.max(0, cols - 50));
    process.stdout.write(statusLine + "\n");

    // Input area
    const inputPrefix = styled("▸ ", COLORS.cyan, COLORS.bold);
    const inputDisplay = this.inputBuffer || styled("Type your message... (Enter to send, Ctrl+C to quit)", COLORS.gray, COLORS.dim);
    const wrappedInput = wrapText(inputDisplay, cols - 2);
    for (let i = 0; i < Math.min(wrappedInput.length, inputRows - 1); i++) {
      process.stdout.write((i === 0 ? inputPrefix : "  ") + wrappedInput[i] + "\n");
    }

    // Move cursor back to input area
    const cursorRow = rows;
    const cursorCol = 3 + stripAnsi(inputPrefix).length;
    this.moveCursor(cursorRow, Math.min(cursorCol, cols));
  }

  private handleKey(key: string): boolean {
    if (key === "\u0003") { // Ctrl+C
      return false; // Stop
    }

    if (key === "\r" || key === "\n") { // Enter
      if (this.inputBuffer.trim() && !this.isStreaming) {
        this.submitMessage(this.inputBuffer.trim());
        this.inputBuffer = "";
      }
      return true;
    }

    if (key === "\x7f" || key === "\b") { // Backspace
      this.inputBuffer = this.inputBuffer.slice(0, -1);
      return true;
    }

    if (key === "\x1b") { // Escape - clear input
      this.inputBuffer = "";
      return true;
    }

    // Regular character
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
    this.statusText = "Processing...";
    this.statusColor = COLORS.cyan;
    this.render();

    try {
      if (!this.session) {
        this.session = await createPiSession({
          modelType: this.options.modelType,
          thinkingEnabled: this.options.thinkingEnabled,
          maxRounds: this.options.maxRounds,
        });
      }

      // Subscribe to events
      const unsub = this.session.subscribe((event) => {
        switch (event.type) {
          case "tool_execution_start":
            this.currentTool = {
              name: event.toolName,
              args: JSON.stringify(event.args || {}).slice(0, 50),
            };
            this.statusText = `Executing ${event.toolName}`;
            this.statusColor = COLORS.yellow;
            this.render();
            break;

          case "tool_execution_end":
            this.messages.push({
              role: "tool",
              content: event.result?.content?.map((c: any) => c.text || "").join("").slice(0, 200) || "",
              timestamp: Date.now(),
              name: event.toolName,
              duration: event.duration,
            });
            this.currentTool = null;
            this.statusText = "Tool complete";
            this.statusColor = COLORS.green;
            this.render();
            break;

          case "message_update":
            if (event.assistantMessageEvent?.type === "text_delta") {
              // Accumulate assistant text
              this.render();
            }
            break;

          case "agent_end":
            // Extract assistant message
            const msgs = event.messages || [];
            for (const m of msgs) {
              if (m.role === "assistant") {
                const text = typeof m.content === "string"
                  ? m.content
                  : m.content?.map((c: any) => c.type === "text" ? c.text : "").join("") || "";
                if (text) {
                  this.messages.push({
                    role: "assistant",
                    content: text,
                    timestamp: Date.now(),
                  });
                }
              }
            }
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
    this.statusText = "Ready";
    this.statusColor = COLORS.green;
    this.render();
  }

  async run(): Promise<void> {
    this.running = true;

    // Initialize session
    this.session = await createPiSession({
      modelType: this.options.modelType,
      thinkingEnabled: this.options.thinkingEnabled,
      maxRounds: this.options.maxRounds,
    });

    // Clear screen and hide cursor
    this.clearScreen();
    this.hideCursor();
    this.setRawMode(true);

    // Welcome message
    this.messages.push({
      role: "system",
      content: `DeepSeek Agent [${this.options.modelType}] - Terminal Mode\nType a message and press Enter. Ctrl+C to quit.`,
      timestamp: Date.now(),
    });

    this.render();

    // Input handling
    const onKey = (data: Buffer) => {
      if (!this.running) return;
      const key = data.toString();
      const shouldContinue = this.handleKey(key);
      if (!shouldContinue) {
        this.running = false;
      } else {
        this.render();
      }
    };

    process.stdin.on("data", onKey);

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
    process.stdin.off("data", onKey);
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

  // Handle SIGINT
  process.on("SIGINT", () => {
    mode.stop();
  });

  await mode.run();
}
