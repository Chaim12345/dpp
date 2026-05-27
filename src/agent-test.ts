#!/usr/bin/env bun
/**
 * Non-interactive agent test harness
 * Tests multi-round tool loop, tool result return, and continuation behavior.
 * Uses the harness's own auth flow (loadAuth + createSession + chatStreamParsed).
 *
 * Usage: bun run src/agent-test.ts [--max-rounds N] [--model expert|default] '<prompt>'
 */
import { loadAuth, createSession, chatStreamParsed, withRetry } from "./web-api-client.js";
import type { HarnessState } from "./types.js";
import { executeTool, extractToolCalls, stripToolCalls, getToolDescriptions } from "./tool-registry.js";
import {
 truncateMessage, compactHistory, detectRepeatedCalls,
 checkTurnLimit, estimateTokens, COMPACTION_THRESHOLD, MAX_TURNS,
} from "./context.js";
import { buildSystemPrompt } from "./system-prompt.js";

const args = process.argv.slice(2);
let prompt = "";
let maxRounds = 10;
let modelType = "expert";

for (let i = 0; i < args.length; i++) {
 if (args[i] === "--max-rounds" && i + 1 < args.length) {
 maxRounds = parseInt(args[++i], 10);
 } else if (args[i] === "--model" && i + 1 < args.length) {
 modelType = args[++i];
 } else {
 prompt += (prompt ? " " : "") + args[i];
 }
}

if (!prompt) {
 // Default test prompt that requires multiple tool calls
 prompt = "List all .ts files in the current directory, then read package.json and tell me the project name and version.";
}

console.error("=== Pi-Harness Agent Test ===");
console.error(`Prompt: ${prompt}`);
console.error(`Max rounds: ${maxRounds}`);
console.error(`Model: ${modelType}`);
console.error("");

// Load auth using harness auth flow
const auth = await loadAuth();
const token = auth.token;
if (!token) {
 console.error("ERROR: No DeepSeek auth token found. Run 'bun run start' first to authenticate.");
 process.exit(1);
}
console.error(`Auth: token=${token.slice(0, 10)}... cookie=${auth.cookieHeader ? "present" : "missing"}`);

// Create session
const state: HarnessState = {
 chatSessionId: null,
 parentMessageId: null,
 memorySummary: "",
 authToken: token,
 cookieHeader: auth.cookieHeader,
};

state.chatSessionId = await createSession(token, auth.cookieHeader, modelType);
console.error(`Session: ${state.chatSessionId}`);
console.error("");

const system = buildSystemPrompt();
const messages: Array<{ role: string; content: string; name?: string }> = [
 { role: "user", content: prompt },
];
const toolCallHistory: Array<{ name: string; arguments: Record<string, unknown> }> = [];
const MAX_CONTEXT_TOKENS = 256_000;

let totalToolCalls = 0;
let totalRounds = 0;

for (let round = 1; round <= maxRounds; round++) {
 totalRounds = round;
 const limitMsg = checkTurnLimit(round, maxRounds);
 if (limitMsg) {
 console.error(`\n[${round}] LIMIT: ${limitMsg}`);
 break;
 }

 console.error(`\n[${round}] === Round ${round} ===`);

 // Build prompt - only send recent messages to avoid duplicating server-side history
 const recentMessages = messages.length > 10 ? messages.slice(-9) : messages;
 const promptText = buildSystemPrompt() + "\n\n" + recentMessages.map((m) => {
 if (m.role === "user") return `[User]\n${m.content}`;
 if (m.role === "assistant") return `[Assistant]\n${m.content}`;
 if (m.role === "tool") return `[Tool:${m.name}]\n${m.content}`;
 return "";
 }).filter(Boolean).join("\n\n");

 const estimatedTokens = estimateTokens(promptText);
 console.error(`[${round}] Prompt: ${estimatedTokens} tokens, ${messages.length} messages`);

 if (estimatedTokens > MAX_CONTEXT_TOKENS * COMPACTION_THRESHOLD) {
 console.error(`[${round}] Compacting (${estimatedTokens} > ${MAX_CONTEXT_TOKENS * COMPACTION_THRESHOLD})`);
 const compacted = compactHistory(messages, MAX_CONTEXT_TOKENS);
 messages.length = 0;
 for (const msg of compacted) messages.push(msg);
 }

 let fullText = "";
 try {
 await withRetry(
 () => chatStreamParsed(
 {
 sessionId: state.chatSessionId!,
 prompt: promptText,
 parentMessageId: state.parentMessageId,
 modelType,
 Enabled: false,
 },
 { authToken: state.authToken, cookieHeader: state.cookieHeader, powSolver: null, parentMessageId: state.parentMessageId },
 (ev) => {
 if (ev.type !== "content") return;
 fullText += ev.delta;
 if (!ev.delta.includes('{"tool_calls') && !ev.delta.includes('{"tool":')) {
 process.stdout.write(ev.delta);
 }
 },
 ),
 {
 maxRetries: 3,
 baseDelayMs: 1000,
 onRetry: (attempt, err) => console.error(`[${round}] Retry ${attempt}/3: ${err.message}`),
 },
 );
 } catch (e: unknown) {
 console.error(`[${round}] API ERROR: ${(e as Error).message}`);
 break;
 }

 if (!fullText) {
 console.error(`[${round}] Empty response - stopping`);
 break;
 }

 const toolCalls = extractToolCalls(fullText);
 const cleanText = stripToolCalls(fullText);

 if (!toolCalls || toolCalls.length === 0) {
 console.error(`\n[${round}] No tool calls extracted - task complete`);
 if (cleanText) process.stdout.write(cleanText + "\n");
 break;
 }

 console.error(`[${round}] Extracted ${toolCalls.length} tool call(s): ${toolCalls.map((t) => t.name).join(", ")}`);
 totalToolCalls += toolCalls.length;

 // Check for repeated calls
 const warnings = detectRepeatedCalls(toolCalls, toolCallHistory);
 for (const w of warnings) console.error(`[${round}] WARNING: ${w}`);
 if (warnings.length >= 3) {
 console.error(`[${round}] Breaking: 3+ repeated tool calls (infinite loop protection)`);
 break;
 }
 toolCallHistory.push(...toolCalls);

 // Push assistant message with tool calls
 const assistantText = cleanText || `[Tool calls: ${toolCalls.map((t) => t.name).join(", ")}]`;
 messages.push({ role: "assistant", content: truncateMessage(assistantText) });

 // Execute each tool and push results
 for (const tc of toolCalls) {
 if (!tc.arguments || Object.keys(tc.arguments).length === 0) {
 const msg = `Missing arguments for ${tc.name}`;
 console.error(`[${round}] ${msg}`);
 messages.push({ role: "tool", name: tc.name, content: msg });
 continue;
 }

 const argsStr = JSON.stringify(tc.arguments).slice(0, 200);
 console.error(`[${round}] Executing: ${tc.name}(${argsStr})`);

 try {
 const result = await executeTool(tc.name, tc.arguments);
 const preview = result.content.length > 300
 ? result.content.slice(0, 300) + `... (${result.content.length} chars total)`
 : result.content;
 console.error(`[${round}] → ${result.isError ? "ERR" : "OK"}: ${preview}`);
 messages.push({ role: "tool", name: tc.name, content: truncateMessage(result.content) });
 } catch (e: unknown) {
 const msg = `Error executing ${tc.name}: ${(e as Error).message}`;
 console.error(`[${round}] EXEC ERROR: ${msg}`);
 messages.push({ role: "tool", name: tc.name, content: msg });
 }
 }

 console.error(`[${round}] Round complete. Messages: ${messages.length}, Tool calls so far: ${totalToolCalls}`);
}

console.error(`\n=== Test Complete ===`);
console.error(`Total rounds: ${totalRounds}`);
console.error(`Total tool calls: ${totalToolCalls}`);
console.error(`Final message count: ${messages.length}`);
console.error(`Messages by role:`);
const byRole = new Map<string, number>();
for (const m of messages) byRole.set(m.role, (byRole.get(m.role) || 0) + 1);
for (const [role, count] of byRole) console.error(` ${role}: ${count}`);
