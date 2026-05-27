// ── DeepSeek Agent REPL TUI ───────────────────────────
// neo-blessed + plain ANSI fallback. Mouse never enabled.
// Proper SPA with virtual scrollback, content capping, and stable scrolling.

export const term = {
  red(s: string)  { process.stderr.write(`\x1b[31m${s}\x1b[0m`); },
  dim: { gray(s: string) { process.stderr.write(`\x1b[2m\x1b[90m${s}\x1b[0m`); } },
};

const ROOT = "/root/deepseek-full-api";
export function shortPath(s: string): string {
  return s.replaceAll(ROOT, "~");
}

export interface TuiSection {
  id: string; title: string; detail: string;
  collapsed: boolean; color: string; status: string;
}

const A: Record<string, string> = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m",
  green: "\x1b[32m", white: "\x1b[97m", gray: "\x1b[90m",
  purple: "\x1b[35m", blue: "\x1b[34m",
};
function ansi(c: string) { return A[c] ?? A.cyan; }
function ico(c?: string) {
  if (c === "yellow") return "⚠";
  if (c === "red")    return "✗";
  if (c === "green")  return "✓";
  return "•";
}

const TN = {
  bg: "#1a1b26", header: "#1f2335", input: "#24283b", border: "#3b4261",
  text: "#c0caf5", muted: "#565f89",
  cyan: "#73daca", yellow: "#e0af68", red: "#f7768e",
  green: "#9ece6a", white: "#c0caf5", gray: "#565f89",
  blue: "#7dcfff", purple: "#bb9af7", dim: "#565f89",
};
function tc(c: string): string { return (TN as any)[c] ?? TN.cyan; }

// ── Spinner frames ──
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerIdx = 0;
function spinnerFrame(): string { return SPINNER[spinnerIdx++ % SPINNER.length]; }

// ── Scrollback ring buffer ─────────────────────────────
// Keeps only the last MAX_LINES to prevent memory growth and crashes.
const MAX_LINES = 5000;
const MAX_CHARS = 500_000; // ~500KB cap

class ScrollbackBuffer {
  private lines: string[] = [];
  private totalChars = 0;

  append(line: string): void {
    this.lines.push(line);
    this.totalChars += line.length + 1;
    this.trim();
  }

  appendMultiple(lines: string[]): void {
    for (const l of lines) {
      this.lines.push(l);
      this.totalChars += l.length + 1;
    }
    this.trim();
  }

  private trim(): void {
    // Trim by lines first
    while (this.lines.length > MAX_LINES) {
      const removed = this.lines.shift()!;
      this.totalChars -= removed.length + 1;
    }
    // Then by chars
    while (this.totalChars > MAX_CHARS && this.lines.length > 100) {
      const removed = this.lines.shift()!;
      this.totalChars -= removed.length + 1;
    }
  }

  getContent(): string {
    return this.lines.join("\n");
  }

  getLineCount(): number {
    return this.lines.length;
  }

  clear(): void {
    this.lines = [];
    this.totalChars = 0;
  }
}

const scrollback = new ScrollbackBuffer();

let sections: TuiSection[] = [];
let promptLabel = "> ";
let statusMsg = "Ready";
let screen: any = null;
let contentBox: any = null;
let statusBar: any = null;
let inputBox: any = null;
let headerBox: any = null;
let blessedMode = false;
let turnCount = 0;
let modelType = "expert";
let onLineCb: ((line: string) => void | Promise<void>) | null = null;

// ── Input history for up/down arrow recall ──
const inputHistory: string[] = [];
let historyIdx = -1;
let currentInput = "";

function pushHistory(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (inputHistory.length === 0 || inputHistory[inputHistory.length - 1] !== trimmed) {
    inputHistory.push(trimmed);
  }
  if (inputHistory.length > 100) inputHistory.shift();
  historyIdx = inputHistory.length;
}

// ── Render batching: coalesce rapid screen.render() calls ──
let renderScheduled = false;
let renderPending = false;

function scheduleRender(): void {
  if (renderScheduled) {
    renderPending = true;
    return;
  }
  renderScheduled = true;
  setImmediate(() => {
    renderScheduled = false;
    if (blessedMode && screen) {
      // Auto-scroll to bottom before rendering
      if (contentBox) {
        contentBox.setScrollPerc(100);
      }
      screen.render();
    }
    // If more renders were requested during this one, schedule another
    if (renderPending) {
      renderPending = false;
      scheduleRender();
    }
  });
}

// ── Debounced content update: batch multiple appends into one setContent ──
let contentUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let contentDirty = false;

function debouncedContentUpdate(): void {
  if (contentUpdateTimer) return;
  contentUpdateTimer = setTimeout(() => {
    contentUpdateTimer = null;
    if (contentDirty && blessedMode && contentBox) {
      contentBox.setContent(scrollback.getContent());
      contentDirty = false;
      scheduleRender();
    }
  }, 16); // ~60fps cap
}

// ── Spinner interval for processing state ──
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

function startSpinner(): void {
  if (spinnerTimer) return;
  isProcessing = true;
  spinnerTimer = setInterval(() => {
    if (blessedMode && statusBar) {
      statusBar.setContent(` ${spinnerFrame()} ${statusMsg}`);
      scheduleRender();
    }
  }, 80);
}

function stopSpinner(): void {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
  isProcessing = false;
}

// ── Core blessed content helpers ───────────────────────
function logLine(text: string): void {
  const clean = text.replace(/\{[^\}]+\}/g, "");
  scrollback.append(clean);
  contentDirty = true;
  debouncedContentUpdate();

  if (!blessedMode) {
    process.stdout.write(clean + "\n");
  }
}

// ── Section rendering ─────────────────────────────────
let sectionIdCounter = 0;

function renderSectionHeader(s: TuiSection): string {
  const icon = ico(s.color);
  const collapse = s.collapsed ? "▶" : "▼";
  const statusSuffix = s.status ? `  {gray-fg}${s.status}{/gray-fg}` : "";
  return `{${s.color}-fg}${collapse} ${icon} ${s.title}{/${s.color}-fg}${statusSuffix}`;
}

function buildSectionsContent(): string {
  const parts: string[] = [];
  for (const s of sections) {
    parts.push(renderSectionHeader(s));
    if (!s.collapsed && s.detail) {
      parts.push(`  {${s.color}-fg}${s.detail}{/${s.color}-fg}`);
    }
  }
  return parts.join("\n");
}

function renderAllSections(): void {
  if (!blessedMode || !contentBox) return;
  // Rebuild scrollback from sections
  scrollback.clear();
  const content = buildSectionsContent();
  scrollback.appendMultiple(content.split("\n"));
  contentBox.setContent(scrollback.getContent());
  contentDirty = false;
  scheduleRender();
}

export function addSection(title: string, detail: string, color = "cyan", collapsed = false): number {
  const id = String(++sectionIdCounter);
  const s: TuiSection = { id, title, detail, collapsed, color, status: "" };
  sections.push(s);

  if (blessedMode) {
    const header = renderSectionHeader(s);
    scrollback.append(header);
    if (!collapsed && detail) {
      scrollback.append(`  {${color}-fg}${detail}{/${color}-fg}`);
    }
    contentDirty = true;
    debouncedContentUpdate();
  } else {
    logLine(`${ansi(color)}── ${title} ──${A.reset}`);
    if (detail && !collapsed) logLine(detail);
  }
  return sections.length - 1;
}

export function updateSection(idx: number, detail: string): void {
  if (idx < 0 || idx >= sections.length) return;
  sections[idx].detail = detail;
  if (blessedMode) {
    renderAllSections();
  } else {
    logLine(detail);
  }
}

export function appendSection(idx: number, delta: string): void {
  if (idx < 0 || idx >= sections.length) return;
  sections[idx].detail += delta;

  if (blessedMode) {
    scrollback.append(`  {${sections[idx].color}-fg}${delta}{/${sections[idx].color}-fg}`);
    contentDirty = true;
    debouncedContentUpdate();
  } else {
    process.stdout.write(delta);
  }
}

export function setStatus(idx: number, status: string): void {
  if (idx < 0 || idx >= sections.length) return;
  sections[idx].status = status;
  if (blessedMode) renderAllSections();
}

export function setSectionColor(idx: number, color: string): void {
  if (idx < 0 || idx >= sections.length) return;
  sections[idx].color = color;
  if (blessedMode) renderAllSections();
}

export function toggleSection(idx: number): void {
  if (idx < 0 || idx >= sections.length) return;
  sections[idx].collapsed = !sections[idx].collapsed;
  if (blessedMode) renderAllSections();
}

export function clearSections(): void {
  sections = [];
  sectionIdCounter = 0;
  scrollback.clear();
  if (blessedMode && contentBox) {
    contentBox.setContent("");
    contentDirty = false;
    scheduleRender();
  }
}

export function getSectionCount(): number {
  return sections.length;
}

// ── Status bar ────────────────────────────────────────
export function showStatus(msg: string): void {
  statusMsg = msg;
  if (blessedMode && statusBar) {
    if (isProcessing) {
      statusBar.setContent(` ${spinnerFrame()} ${msg}`);
    } else {
      statusBar.setContent(` ● ${msg}`);
    }
    scheduleRender();
  } else {
    term.dim.gray(`[Status] ${msg}\n`);
  }
}

export function clearStatus(): void {
  showStatus("Ready");
}

export function setProcessing(on: boolean): void {
  if (on) {
    startSpinner();
  } else {
    stopSpinner();
    if (blessedMode && statusBar) {
      statusBar.setContent(` ● ${statusMsg}`);
      scheduleRender();
    }
  }
}

export function setTurnCount(n: number): void {
  turnCount = n;
  updateHeader();
}

export function setModelType(m: string): void {
  modelType = m;
  updateHeader();
}

function updateHeader(): void {
  if (!blessedMode || !headerBox) return;
  const modelLabel = modelType === "expert" ? "🧠 Expert" : modelType === "coder" ? "💻 Coder" : "🤖 Default";
  const bufInfo = scrollback.getLineCount() > 1000 ? `  {gray-fg}buf:${scrollback.getLineCount()}{/gray-fg}` : "";
  headerBox.setContent(` {bold}DeepSeek Agent{/bold}  │  ${modelLabel}  │  Turn: {cyan-fg}${turnCount}{/cyan-fg}${bufInfo}  │  {gray-fg}/help{/gray-fg}`);
  scheduleRender();
}

export function flushRender(): void {
  if (blessedMode && screen) {
    // Flush any pending content update
    if (contentDirty && contentBox) {
      contentBox.setContent(scrollback.getContent());
      contentDirty = false;
    }
    if (contentBox) contentBox.setScrollPerc(100);
    screen.render();
  }
}

// ── Blessed TUI init ──────────────────────────────────
export async function startTui(onLine: (line: string) => void | Promise<void>): Promise<void> {
  onLineCb = onLine;

  let blessed: any;
  try {
    blessed = await import("neo-blessed");
  } catch {
    // Fallback: readline-based TUI
    blessedMode = false;
    startReadlineFallback();
    return;
  }

  blessedMode = true;

  screen = blessed.screen({
    smartCSR: true,
    title: "DeepSeek Agent REPL",
    useBCE: true,
    fullUnicode: true,
  });

  // Header
  headerBox = blessed.box({
    top: 0, left: 0, width: "100%", height: 1,
    bg: tc("header"), fg: tc("text"),
    content: ` {bold}DeepSeek Agent{/bold}  │  🧠 Expert  │  Turn: {cyan-fg}0{/cyan-fg}  │  {gray-fg}/help{/gray-fg}`,
    tags: true,
  });
  screen.append(headerBox);

  // Content area with proper scrolling
  contentBox = blessed.box({
    top: 1, left: 0, width: "100%", bottom: 3,
    bg: tc("bg"), fg: tc("text"),
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: "│", style: { fg: tc("border") } },
    tags: true,
    mouse: false,
    keys: true,
    vi: true, // Enable vim-like scrolling (j/k, gg, G, Ctrl+d/u)
  });
  screen.append(contentBox);

  // Scroll key bindings for content area
  contentBox.key(["pageup"], () => {
    contentBox.scroll(-Math.floor(contentBox.height * 0.8));
    scheduleRender();
  });
  contentBox.key(["pagedown"], () => {
    contentBox.scroll(Math.floor(contentBox.height * 0.8));
    scheduleRender();
  });
  contentBox.key(["home"], () => {
    contentBox.setScrollPerc(0);
    scheduleRender();
  });
  contentBox.key(["end"], () => {
    contentBox.setScrollPerc(100);
    scheduleRender();
  });

  // Status bar
  statusBar = blessed.box({
    bottom: 2, left: 0, width: "100%", height: 1,
    bg: tc("border"), fg: tc("muted"),
    content: " ● Ready",
    tags: true,
  });
  screen.append(statusBar);

  // Input box
  inputBox = blessed.textbox({
    bottom: 0, left: 0, width: "100%", height: 1,
    bg: tc("input"), fg: tc("text"),
    inputOnFocus: true,
    style: { focus: { bg: tc("input") } },
    prompt: promptLabel,
  });
  screen.append(inputBox);

  // Global key bindings
  screen.key(["C-c"], () => { stopTui(); process.exit(0); });
  screen.key(["C-l"], () => { clearSections(); showStatus("Screen cleared"); });

  // Allow scrolling content even when input is focused
  inputBox.key(["pageup"], () => {
    contentBox.scroll(-Math.floor(contentBox.height * 0.8));
    scheduleRender();
  });
  inputBox.key(["pagedown"], () => {
    contentBox.scroll(Math.floor(contentBox.height * 0.8));
    scheduleRender();
  });

  inputBox.on("submit", async (line: string) => {
    try {
      pushHistory(line);
      inputBox.setValue("");
      inputBox.focus();
      if (onLineCb) await onLineCb(line);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : "";
      addSection("Error", `${msg}\n${stack?.split("\n").slice(0, 3).join("\n") || ""}`, "red", false);
      showStatus(`Turn failed: ${msg}`);
    }
  });

  inputBox.key(["up"], () => {
    if (inputHistory.length === 0) return;
    if (historyIdx > 0) {
      historyIdx--;
      inputBox.setValue(inputHistory[historyIdx]);
      scheduleRender();
    }
  });

  inputBox.key(["down"], () => {
    if (inputHistory.length === 0) return;
    if (historyIdx < inputHistory.length - 1) {
      historyIdx++;
      inputBox.setValue(inputHistory[historyIdx]);
    } else {
      historyIdx = inputHistory.length;
      inputBox.setValue("");
    }
    scheduleRender();
  });

  inputBox.focus();
  screen.render();
}

// ── Readline fallback ─────────────────────────────────
function startReadlineFallback(): void {
  const readline = require("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptLabel,
    historySize: 100,
  });

  rl.prompt();
  rl.on("line", async (line: string) => {
    try {
      if (onLineCb) await onLineCb(line);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      term.red(`[Error] ${msg}\n`);
      if (err instanceof Error && err.stack) {
        term.dim.gray(err.stack.split("\n").slice(1, 4).join("\n") + "\n");
      }
    }
    rl.prompt();
  });
  rl.on("close", () => { process.exit(0); });
}

export function stopTui(): void {
  stopSpinner();
  if (contentUpdateTimer) {
    clearTimeout(contentUpdateTimer);
    contentUpdateTimer = null;
  }
  if (blessedMode && screen) {
    screen.destroy();
  }
}
