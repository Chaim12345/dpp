// ── DeepSeek Agent REPL TUI ───────────────────────────
// neo-blessed + plain ANSI fallback. Mouse never enabled.
// Streaming: content flows via logBox.add() for O(1) per-chunk perf.
// Renders are batched via setImmediate to prevent freezing.

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

let sections: TuiSection[] = [];
let promptLabel = "> ";
let statusMsg = "Ready";
let screen: any = null;
let logBox: any = null;
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
function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  setImmediate(() => {
    renderScheduled = false;
    if (blessedMode && screen) screen.render();
  });
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

// ── Core blessed log helpers ───────────────────────────
function logLine(text: string): void {
  if (blessedMode && logBox) {
    logBox.add(text);
    scheduleRender();
  } else {
    process.stdout.write(text.replace(/\{[^\}]+\}/g, "") + "\n");
  }
}

function logTagged(text: string): void {
  if (blessedMode && logBox) {
    logBox.add(text);
    scheduleRender();
  } else {
    process.stdout.write(text.replace(/\{[^\}]+\}/g, "") + "\n");
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

function renderAllSections(): void {
  if (!blessedMode || !logBox) return;
  logBox.setContent("");
  for (const s of sections) {
    logBox.add(renderSectionHeader(s));
    if (!s.collapsed && s.detail) {
      const lines = s.detail.split("\n");
      for (const line of lines) {
        logBox.add(`  {${s.color}-fg}${line}{/${s.color}-fg}`);
      }
    }
  }
  logBox.setScrollPerc(100);
  scheduleRender();
}

export function addSection(title: string, detail: string, color = "cyan", collapsed = false): number {
  const id = String(++sectionIdCounter);
  const s: TuiSection = { id, title, detail, collapsed, color, status: "" };
  sections.push(s);
  if (blessedMode) {
    renderAllSections();
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
    renderAllSections();
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
  if (blessedMode && logBox) {
    logBox.setContent("");
    scheduleRender();
  }
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
  headerBox.setContent(` {bold}DeepSeek Agent{/bold}  │  ${modelLabel}  │  Turn: {cyan-fg}${turnCount}{/cyan-fg}  │  {gray-fg}/help{/gray-fg}`);
  scheduleRender();
}

export function flushRender(): void {
  if (blessedMode && screen) screen.render();
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

  // Log area
  logBox = blessed.log({
    top: 1, left: 0, width: "100%", bottom: 3,
    bg: tc("bg"), fg: tc("text"),
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: "│", style: { fg: tc("border") } },
    tags: true,
    mouse: false,
    keys: false,
  });
  screen.append(logBox);

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

  // Key bindings
  screen.key(["C-c"], () => { stopTui(); process.exit(0); });
  screen.key(["C-l"], () => { clearSections(); showStatus("Screen cleared"); });

  inputBox.on("submit", async (line: string) => {
    const fs = require("fs");
    const logPath = "/root/deepseek-full-api/pi-harness/tui-debug.log";
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] submit: ${JSON.stringify(line)}\n`);
      pushHistory(line);
      inputBox.setValue("");
      inputBox.focus();
      if (onLineCb) await onLineCb(line);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : "";
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ERROR: ${msg}\n${stack}\n`);
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
  if (blessedMode && screen) {
    screen.destroy();
  }
}
