// ── DeepSeek Agent REPL (TUI) ─────────────────────────
// Uses UnifiedAgentLoop for the agent loop — event-driven.
import { UnifiedAgentLoop, type AgentLoopEvent } from "./agent-loop-unified.js";
import {
  startTui, stopTui, showStatus, clearStatus,
  addSection, updateSection, appendSection, setStatus, setSectionColor,
  clearSections, toggleSection, flushRender, shortPath, term,
  setProcessing, setTurnCount, setModelType,
} from "./tui.js";

let loop: UnifiedAgentLoop | null = null;
let exitRequested = false;
let processingTurn = false;

// Track active tool section indices by tool name (for parallel execution)
const activeToolSections = new Map<string, number>();
// Track current response section index for streaming text
let currentRespIdx = 0;

function printHelp() {
  addSection("Help", [
    "/model   Switch model (default, expert, coder)",
    "/thinking Toggle thinking mode",
    "/rounds  Set max tool-call rounds per turn",
    "/clear   Clear conversation",
    "/session Show session info",
    "/new     New session",
    "/tokens  Token count",
    "/history Show history",
    "/quit    Exit",
  ].join("\n"), "cyan", false);
}

async function handleCommand(cmd: string, args: string[]): Promise<boolean> {
  switch (cmd) {
    case "quit": case "exit": case "q":
      exitRequested = true;
      return false;
    case "help": case "h": case "?":
      printHelp();
      return true;
    case "clear": case "cls":
      loop?.clearMessages();
      clearSections();
      showStatus("Conversation cleared");
      return true;
    case "model":
      if (!args[0]) showStatus(`Current model: ${loop?.modelType}. Usage: /model default|expert|coder`);
      else {
        if (loop) loop.modelType = args[0];
        showStatus(`Model switched to: ${args[0]}`);
      }
      return true;
    case "thinking": case "think": {
      const newState = loop?.toggleThinking();
      showStatus(`Thinking mode: ${newState ? "ON" : "OFF"}`);
      return true;
    }
    case "rounds": {
      const n = parseInt(args[0], 10);
      if (isNaN(n) || n < 1) showStatus(`Current rounds: ${loop?.maxRounds}. Usage: /rounds <n>`);
      else { if (loop) loop.maxRounds = n; showStatus(`Max rounds set to: ${n}`); }
      return true;
    }
    case "session": case "info":
      showStatus(`Model: ${loop?.modelType} | Turns: ${loop?.turnCount} | Msgs: ${loop?.messagesSnapshot.length} | Tokens: ~${loop?.estimateCurrentTokens()}`);
      return true;
    case "new": {
      showStatus("Creating new session...");
      clearSections();
      try {
        await loop?.newSession();
        showStatus(`New session created`);
      } catch (e: unknown) {
        showStatus(`New session failed: ${(e as Error).message}`);
      }
      return true;
    }
    case "tokens": {
      showStatus(`Estimated tokens: ${loop?.estimateCurrentTokens() ?? 0}`);
      return true;
    }
    case "history": case "hist": {
      if (!loop) { addSection("History", "(no loop)", "gray", false); return true; }
      const lines = loop.messagesSnapshot.map((m) => {
        const role = m.role === "tool" ? `tool:${m.name}` : m.role;
        return `[${role}] ${m.content.length > 80 ? m.content.slice(0, 80) + "..." : m.content}`;
      });
      addSection("History", lines.length ? lines.join("\n") : "(empty)", "gray", false);
      return true;
    }
    default:
      showStatus(`Unknown command: /${cmd}. Type /help for options.`);
      return true;
  }
}

async function executeTurn(userInput: string): Promise<void> {
  if (processingTurn || !loop) return;
  processingTurn = true;
  try {
    // Add user message as a visible section
    addSection("You", userInput, "blue", false);

    // Create response section for this turn
    currentRespIdx = addSection("Response", "", "white", false);
    activeToolSections.clear();

    await loop.execute(userInput);
  } finally {
    processingTurn = false;
  }
}

function setupEventListeners(): void {
  if (!loop) return;

  loop.subscribe(async (event: AgentLoopEvent) => {
    switch (event.type) {
      case "stream_start":
        activeToolSections.clear();
        setProcessing(true);
        showStatus("Thinking...");
        break;

      case "text_delta":
        // Append streaming text to the current response section
        appendSection(currentRespIdx, event.delta);
        break;

      case "thinking_delta":
        // Thinking text shown inline (collapsed by default)
        break;

      case "stream_end":
        setProcessing(false);
        break;

      case "tool_call_start": {
        const idx = addSection(
          `▶ ${event.name}`,
          shortPath(JSON.stringify(event.args, null, 2)),
          "cyan",
        );
        activeToolSections.set(event.name, idx);
        showStatus(`Executing ${event.name}...`);
        setProcessing(true);
        break;
      }

      case "tool_result": {
        const idx = activeToolSections.get(event.name) ?? -1;
        const preview = event.content.length > 500
          ? event.content.slice(0, 500) + `\n… (${event.content.length} chars)`
          : event.content;
        if (idx >= 0) {
          updateSection(idx, shortPath(preview));
          setSectionColor(idx, event.isError ? "red" : "green");
          setStatus(idx, `${event.isError ? "✗ Error" : "✓ OK"} — ${event.content.length} chars`);
        }
        setProcessing(false);
        break;
      }

      case "round_complete":
        if (event.hasToolCalls) {
          showStatus(`Round ${event.round}/${loop!.maxRounds} complete`);
        }
        break;

      case "turn_complete":
        setProcessing(false);
        setTurnCount(event.turns);
        setModelType(loop!.modelType);
        showStatus("Ready");
        break;

      case "warning":
        addSection("Warning", event.message, "yellow");
        break;

      case "error":
        addSection("Error", event.message, "red", false);
        setProcessing(false);
        showStatus(`Error: ${event.message}`);
        break;

      case "status":
        showStatus(event.message);
        break;
    }
  });
}

async function initLoop(modelType: string): Promise<UnifiedAgentLoop> {
  const newLoop = new UnifiedAgentLoop({
    modelType,
    thinkingEnabled: false,
    maxRounds: 25,
  });
  await newLoop.init();
  return newLoop;
}

export async function runRepl(options?: { modelType?: string }): Promise<void> {
  try {
    loop = await initLoop(options?.modelType ?? "expert");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    term.red(`[Failed: ${msg}]\n`);
    term.dim.gray("\nFix: export DEEPSEEK_TOKEN=... or run from parent dir\n");
    process.exit(1);
  }

  setupEventListeners();

  showStatus("Ready — type a message or /help");
  setTurnCount(0);
  setModelType(loop.modelType);
  flushRender();

  await startTui(async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("/")) {
      const parts = trimmed.slice(1).split(/\s+/);
      const keepRunning = await handleCommand(parts[0].toLowerCase(), parts.slice(1));
      if (!keepRunning || exitRequested) { stopTui(); process.exit(0); }
      return;
    }

    try {
      await executeTurn(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addSection("Error", msg, "red", false);
      showStatus(`Turn failed: ${msg}`);
    }
  });
}

if (import.meta.main) {
  runRepl().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}
