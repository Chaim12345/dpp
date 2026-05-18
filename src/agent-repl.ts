// ── DeepSeek Agent REPL ───────────────────────────────
import { loadAuth, createSession, chatStreamParsed, withRetry } from "./web-api-client.js";
import { executeTool, extractToolCalls, stripToolCalls, getToolDescriptions } from "./tool-registry.js";
import { truncateMessage, detectRepeatedCalls, estimateTokens } from "./context.js";
import type { HarnessState } from "./types.js";
import {
  startTui, stopTui, showStatus, clearStatus,
  addSection, updateSection, appendSection, setStatus, setSectionColor,
  clearSections, toggleSection, flushRender, shortPath, term,
  setProcessing, setTurnCount, setModelType,
} from "./tui.js";

interface ConversationState {
  harness: HarnessState;
  messages: Array<{ role: string; content: string; name?: string }>;
  modelType: string;
  thinkingEnabled: boolean;
  maxRounds: number;
  turnCount: number;
}

let state: ConversationState;
let exitRequested = false;
let processingTurn = false;

function buildSystemPrompt(): string {
  const cwd = process.cwd();
  return `You are a coding assistant with access to local tools.

**Current directory:** ${cwd}

**Tools:**
${getToolDescriptions()}

---

**CRITICAL RULES:**
1. NEVER simulate or fake tool results - always output JSON tool calls and wait for actual results
2. NEVER use [Tool:name] format - only use JSON format shown below
3. NEVER guess file contents - use read tool to check
4. NEVER output code blocks as tool results - the system executes tools automatically

**When to use tools:**
- User asks about files/directories → use \`bash\` with \`ls\` or \`find\`
- User asks to read a file → use \`read\` tool
- User asks to write/change files → use \`write\` or \`edit\` tool
- User asks to search code → use \`grep\` tool
- User asks to run commands → use \`bash\` tool

**ONLY use this JSON format for tool calls:**
{"tool_calls":[{"name":"bash","arguments":{"command":"ls -la"}}]}
{"tool_calls":[{"name":"read","arguments":{"path":"package.json"}}]}
{"tool_calls":[{"name":"write","arguments":{"path":"test.txt","content":"hello"}}]}
{"tool_calls":[{"name":"edit","arguments":{"path":"file.txt","old_string":"old","new_string":"new"}}]}
{"tool_calls":[{"name":"grep","arguments":{"pattern":"search term","path":"."}}]}

Tool results appear automatically after execution. Provide a brief summary after seeing results.`;
}

function buildPromptText(system: string, messages: Array<{ role: string; content: string; name?: string }>): string {
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
      state.messages = [];
      state.turnCount = 0;
      clearSections();
      showStatus("Conversation cleared");
      return true;
    case "model":
      if (!args[0]) showStatus(`Current model: ${state.modelType}. Usage: /model default|expert|coder`);
      else { state.modelType = args[0]; showStatus(`Model switched to: ${args[0]}`); }
      return true;
    case "thinking": case "think":
      state.thinkingEnabled = !state.thinkingEnabled;
      showStatus(`Thinking mode: ${state.thinkingEnabled ? "ON" : "OFF"}`);
      return true;
    case "rounds": {
      const n = parseInt(args[0], 10);
      if (isNaN(n) || n < 1) showStatus(`Current rounds: ${state.maxRounds}. Usage: /rounds <n>`);
      else { state.maxRounds = n; showStatus(`Max rounds set to: ${n}`); }
      return true;
    }
    case "session": case "info":
      showStatus(`Session: ${state.harness.chatSessionId} | Model: ${state.modelType} | Turns: ${state.turnCount} | Msgs: ${state.messages.length}`);
      return true;
    case "new": {
      showStatus("Creating new session...");
      const ns = await initSession(state.modelType);
      state.harness = ns.harness;
      state.messages = [];
      state.turnCount = 0;
      clearSections();
      showStatus(`New session: ${state.harness.chatSessionId}`);
      return true;
    }
    case "tokens": {
      const text = buildPromptText(buildSystemPrompt(), state.messages);
      showStatus(`Estimated tokens: ${estimateTokens(text)}`);
      return true;
    }
    case "history": case "hist": {
      const lines = state.messages.map((m) => {
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
  if (processingTurn) return;
  processingTurn = true;
  try {
    const system = buildSystemPrompt();
    state.messages.push({ role: "user", content: userInput });
    state.turnCount++;
    setTurnCount(state.turnCount);
    setModelType(state.modelType);

    for (let round = 1; round <= state.maxRounds; round++) {
      if (exitRequested) break;

      const recentMessages = state.messages.length > 12 ? state.messages.slice(-11) : state.messages;
      const promptText = buildPromptText(system, recentMessages);
      const estTokens = estimateTokens(promptText);
      if (estTokens > 12000) showStatus(`Context large: ${estTokens} tokens — consider /clear`);

      // fullText holds the COMPLETE response — never slice it
      let fullText = "";
      let thinkingBuf = "";
      clearSections();
      const respSection = addSection("Response", "", "white", false);
      setProcessing(true);
      showStatus("Sending request...");

      const responseMessageId = await withRetry(
        () => chatStreamParsed(
          {
            sessionId: state.harness.chatSessionId!,
            prompt: promptText,
            parentMessageId: state.harness.parentMessageId,
            modelType: state.modelType,
            thinkingEnabled: state.thinkingEnabled,
          },
          {
            authToken: state.harness.authToken,
            cookieHeader: state.harness.cookieHeader,
            powSolver: null,
            parentMessageId: state.harness.parentMessageId,
          },
          (ev) => {
            if (exitRequested) return;
            if (ev.type === "content") {
              fullText += ev.delta;
              // Pass FULL text — updateSection only prints the new delta
              updateSection(respSection, fullText);
            } else if (ev.type === "thinking" && state.thinkingEnabled) {
              thinkingBuf += ev.delta;
            }
          },
        ),
        {
          maxRetries: 2,
          baseDelayMs: 1000,
          onRetry: (attempt, err) => showStatus(`Retry ${attempt}/2: ${err.message}`),
        },
      );

      if (responseMessageId != null) state.harness.parentMessageId = responseMessageId;

      if (!fullText) { setProcessing(false); showStatus("Empty response from API"); break; }
      if (thinkingBuf) addSection("Thinking", thinkingBuf, "dim", true);

      // Extract tool calls from the FULL unsliced response
      const toolCalls = extractToolCalls(fullText);
      const cleanText = stripToolCalls(fullText);

      if (!toolCalls || toolCalls.length === 0) {
        const display = cleanText || fullText;
        setStatus(respSection, `${estimateTokens(display)} tok`);
        setProcessing(false);
        state.messages.push({ role: "assistant", content: truncateMessage(display) });
        return;
      }

      // Has tool calls
      const warnings = detectRepeatedCalls(toolCalls, []);
      for (const w of warnings) addSection("Warning", w, "yellow");

      const assistantText = cleanText || `[Tool calls: ${toolCalls.map((t) => t.name).join(", ")}]`;
      state.messages.push({ role: "assistant", content: truncateMessage(assistantText) });

      for (const tc of toolCalls) {
        if (exitRequested) break;

        if (!tc.arguments || Object.keys(tc.arguments).length === 0) {
          const msg = `Missing arguments for ${tc.name}`;
          addSection(`⚠ ${tc.name}`, msg, "yellow");
          state.messages.push({ role: "tool", name: tc.name, content: msg });
          continue;
        }

        const tcIdx = addSection(`▶ ${tc.name}`, shortPath(JSON.stringify(tc.arguments, null, 2)), "cyan");

        try {
          showStatus(`Executing ${tc.name}...`);
          setProcessing(true);
          // Timeout per tool type: bash=30s, others=10s
          const timeoutMs = tc.name === "bash" ? 30_000 : 10_000;
          const result = await Promise.race([
            executeTool(tc.name, tc.arguments),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Tool ${tc.name} timed out after ${timeoutMs / 1000}s`)), timeoutMs)
            ),
          ]);
          const preview = result.content.length > 500
            ? result.content.slice(0, 500) + `\n… (${result.content.length} chars)`
            : result.content;
          updateSection(tcIdx, shortPath(preview));
          setSectionColor(tcIdx, result.isError ? "red" : "green");
          setStatus(tcIdx, `${result.isError ? "✗ Error" : "✓ OK"} — ${result.content.length} chars`);
          state.messages.push({ role: "tool", name: tc.name, content: truncateMessage(result.content) });
        } catch (e: unknown) {
          const msg = `Error: ${(e as Error).message}`;
          updateSection(tcIdx, shortPath(msg));
          setSectionColor(tcIdx, "red");
          state.messages.push({ role: "tool", name: tc.name, content: msg });
        }
        setProcessing(false);
      }

      showStatus(`Round ${round}/${state.maxRounds} complete`);
    }
  } finally {
    processingTurn = false;
    setProcessing(false);
    showStatus("Ready");
  }
}

async function initSession(modelType: string): Promise<ConversationState> {
  const auth = await loadAuth();
  if (!auth.token) throw new Error("No DeepSeek auth token found. Set DEEPSEEK_TOKEN or ensure .pi/agent/deepseek_token.txt exists.");
  const sessionId = await createSession(auth.token, auth.cookieHeader, modelType);
  return {
    harness: { chatSessionId: sessionId, parentMessageId: null, memorySummary: "", authToken: auth.token, cookieHeader: auth.cookieHeader },
    messages: [], modelType, thinkingEnabled: false, maxRounds: 25, turnCount: 0,
  };
}

export async function runRepl(options?: { modelType?: string }): Promise<void> {
  try {
    state = await initSession(options?.modelType ?? "expert");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    term.red(`[Failed: ${msg}]\n`);
    term.dim.gray("\nFix: export DEEPSEEK_TOKEN=... or run from parent dir\n");
    process.exit(1);
  }

  showStatus("Ready — type a message or /help");
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
