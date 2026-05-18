import { loadAuth, createSession, chatStreamParsed, withRetry } from "./web-api-client.js";
import type { HarnessState } from "./types.js";
import { executeTool, extractToolCalls, stripToolCalls, getToolDescriptions } from "./tool-registry.js";
import {
  truncateMessage, compactHistory, detectRepeatedCalls,
  checkTurnLimit, estimateTokens, COMPACTION_THRESHOLD, MAX_TURNS,
} from "./context.js";

export interface AgentLoopOptions {
  prompt: string;
  maxRounds?: number;
  modelType?: string;
  thinkingEnabled?: boolean;
  sessionId?: string;
  onStderr?: (msg: string) => void;
}

function sysPrompt(): string {
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

function buildPrompt(
  system: string,
  messages: Array<{ role: string; content: string; name?: string }>,
): string {
  const parts: string[] = [];
  if (system) parts.push(`[System]\n${system}`);
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      parts.push(`[User]\n${msg.content}`);
    } else if (msg.role === "assistant") {
      parts.push(`[Assistant]\n${msg.content}`);
    } else if (msg.role === "tool") {
      parts.push(`[Tool:${msg.name}]\n${msg.content}`);
    }
  }
  return parts.join("\n\n");
}

const MAX_CONTEXT_TOKENS = 16_000;

export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
  const maxRounds = options.maxRounds ?? MAX_TURNS;
  const modelType = options.modelType ?? "expert";
  const onErr = options.onStderr ?? console.error;

  const auth = await loadAuth();
  const token = auth.token;
  if (!token) throw new Error("No DeepSeek auth token found");

  const state: HarnessState = {
    chatSessionId: options.sessionId ?? null,
    parentMessageId: null,
    memorySummary: "",
    authToken: token,
    cookieHeader: auth.cookieHeader,
  };

  if (!state.chatSessionId) {
    state.chatSessionId = await createSession(token, auth.cookieHeader, modelType);
  }

  const system = sysPrompt();
  const messages: Array<{ role: string; content: string; name?: string }> = [
    { role: "user", content: options.prompt },
  ];
  const toolCallHistory: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  for (let round = 1; round <= maxRounds; round++) {
    const limitMsg = checkTurnLimit(round, maxRounds);
    if (limitMsg) {
      onErr(`[${round}] ${limitMsg}`);
      break;
    }

    onErr(`\n[${round}] ---`);

    const recentMessages = messages.length > 10
      ? messages.slice(-9)
      : messages;

    const promptText = buildPrompt(system, recentMessages);
    const estimatedTokens = estimateTokens(promptText);
    if (estimatedTokens > MAX_CONTEXT_TOKENS * COMPACTION_THRESHOLD) {
      onErr(`[${round}] Compacting history (${estimatedTokens} tokens > threshold)`);
      messages.length = 0;
      messages.push({ role: "user", content: options.prompt });
      for (const msg of recentMessages.slice(-5)) {
        if (msg.role === "tool") {
          messages.push({ ...msg, content: truncateMessage(msg.content, 2000) });
        } else {
          messages.push(msg);
        }
      }
    }

    let fullText = "";
    await withRetry(
      () => chatStreamParsed(
        {
          sessionId: state.chatSessionId!,
          prompt: promptText,
          parentMessageId: state.parentMessageId,
          modelType,
          thinkingEnabled: options.thinkingEnabled ?? false,
        },
        { authToken: state.authToken, cookieHeader: state.cookieHeader, powSolver: null, parentMessageId: state.parentMessageId },
        (ev) => {
          if (ev.type !== "content") return;
          fullText += ev.delta;
          // Stream directly to stdout in real-time — no line buffering
          if (!ev.delta.includes('{"tool_calls') && !ev.delta.includes('{"tool":')) {
            process.stdout.write(ev.delta);
          }
        },
      ),
      {
        maxRetries: 3,
        baseDelayMs: 1000,
        onRetry: (attempt, err) => onErr(`[${round}] API retry ${attempt}/3: ${err.message}`),
      },
    );
    if (!fullText) {
      onErr(`[${round}] empty response`);
      continue;
    }

    const toolCalls = extractToolCalls(fullText);
    const cleanText = stripToolCalls(fullText);

    if (!toolCalls) {
      process.stdout.write("\n");
      break;
    }

    const warnings = detectRepeatedCalls(toolCalls, toolCallHistory);
    for (const w of warnings) onErr(`[${round}] WARNING: ${w}`);
    if (warnings.length > 0) {
      const repeated = toolCalls.filter((tc) => {
        const key = tc.name + ":" + JSON.stringify(tc.arguments).slice(0, 100);
        const count = 1 + toolCallHistory.filter((h) => h.name + ":" + JSON.stringify(h.arguments).slice(0, 100) === key).length;
        return count >= 3;
      });
      if (repeated.length >= 3) {
        onErr(`[${round}] Breaking: 3+ repeated tool calls detected (possible infinite loop)`);
        break;
      }
    }
    toolCallHistory.push(...toolCalls);

    const assistantText = cleanText || `[Tool calls: ${toolCalls.map((t) => t.name).join(", ")}]`;
    messages.push({ role: "assistant", content: truncateMessage(assistantText) });

    for (const tc of toolCalls) {
      if (!tc.arguments || Object.keys(tc.arguments).length === 0) {
        const msg = `Missing arguments for ${tc.name}. Please provide required arguments.`;
        onErr(`[${round}] ${msg}`);
        messages.push({ role: "tool", name: tc.name, content: msg });
        continue;
      }
      const argsStr = JSON.stringify(tc.arguments);
      onErr(`[${round}] ${tc.name}(${argsStr})`);
      try {
        const result = await executeTool(tc.name, tc.arguments);
        const preview = result.content.length > 200
          ? result.content.slice(0, 200) + `... (${result.content.length} chars)`
          : result.content;
        onErr(`[${round}] → ${result.isError ? "ERR" : "OK"}: ${preview}`);
        messages.push({ role: "tool", name: tc.name, content: truncateMessage(result.content) });
      } catch (e: unknown) {
        const msg = `Error executing ${tc.name}: ${(e as Error).message}`;
        onErr(`[${round}] ${msg}`);
        messages.push({ role: "tool", name: tc.name, content: msg });
      }
    }
  }
}
