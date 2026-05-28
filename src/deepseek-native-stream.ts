import { type Context, type Model, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "../node_modules/@mariozechner/pi-ai/dist/utils/event-stream.js";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { HarnessState } from "./types.js";
import {
 loadAuth,
 createSession,
 chatStream,
 parseSseStream,
} from "./web-api-client.js";
import { XmlToolCallParser } from "./xml-toolcall-parser.js";

// ── Tool Call Parsers ────────────────────────────────────────

function extractReactToolCalls(text: string): { name: string; arguments: Record<string, unknown> }[] {
 const results: { name: string; arguments: Record<string, unknown> }[] = [];
 const re = /Action:\s*(\S+)\s*\n\s*Action Input:\s*(\{[\s\S]*?\})/g;
 let match: RegExpExecArray | null;
 while ((match = re.exec(text)) !== null) {
 try { results.push({ name: match[1], arguments: JSON.parse(match[2]) }); } catch {}
 }
 return results;
}

function extractToolParenCalls(text: string): { name: string; arguments: Record<string, unknown> }[] {
 const results: { name: string; arguments: Record<string, unknown> }[] = [];
 const re = /Tool\s+(\w+)\s*\(([\s\S]*?)\)\s*$/;
 const match = re.exec(text);
 if (match) {
 try { results.push({ name: match[1], arguments: JSON.parse(match[2]) }); } catch {}
 }
 return results;
}

// Markdown format: **Calling:** `name`\n```json\n{...}\n```
function extractMarkdownToolCalls(text: string): { name: string; arguments: Record<string, unknown> }[] {
 const results: { name: string; arguments: Record<string, unknown> }[] = [];
 const re = /\*\*Calling:\*\*\s*`(\w+)`\s*\n```(?:json)?\s*\n([\s\S]*?)\n```/g;
 let match: RegExpExecArray | null;
 while ((match = re.exec(text)) !== null) {
  try { results.push({ name: match[1], arguments: JSON.parse(match[2]) }); } catch {}
 }
 return results;
}

// JSON format: {"tool": "<name>", "args": {...}} or {"tool": "<name>", "arguments": {...}}
function extractJsonToolCalls(text: string): { name: string; arguments: Record<string, unknown> }[] {
 const results: { name: string; arguments: Record<string, unknown> }[] = [];
 const seen = new Set<string>();

 function addResult(name: string, args: Record<string, unknown>) {
  const key = `${name}:${JSON.stringify(args)}`;
  if (!seen.has(key)) { seen.add(key); results.push({ name, arguments: args }); }
 }

 // Match <|tool|{json}|> format (pipe-delimited)
 const pipeRe = /<\|tool\|(\{[^|]*\})\|>/g;
 let pipeMatch: RegExpExecArray | null;
 while ((pipeMatch = pipeRe.exec(text)) !== null) {
  try {
   const obj = JSON.parse(pipeMatch[1]);
   if (obj.tool && typeof obj.tool === 'string') {
    addResult(obj.tool, obj.args || obj.arguments || {});
   }
  } catch {}
 }

 // Match ```json\n{...}\n``` code blocks containing tool calls
 const codeBlockRe = /```(?:json)?\s*\n(\{[\s\S]*?\})\n```/g;
 let cbMatch: RegExpExecArray | null;
 while ((cbMatch = codeBlockRe.exec(text)) !== null) {
  try {
   const obj = JSON.parse(cbMatch[1]);
   if (obj.tool && typeof obj.tool === 'string') {
    addResult(obj.tool, obj.args || obj.arguments || {});
   }
  } catch {}
 }

 // Match plain JSON lines: {"tool": "name", "args": {...}}
 const lines = text.split('\n');
 for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) continue;
  try {
   const obj = JSON.parse(trimmed);
   if (obj.tool && typeof obj.tool === 'string') {
    addResult(obj.tool, obj.args || obj.arguments || {});
   }
  } catch {
   const toolMatch = trimmed.match(/\{"tool"\s*:\s*"(\w+)"\s*,\s*(?:"args"|"arguments")\s*:\s*/);
   if (toolMatch) {
    const rest = trimmed.slice(toolMatch[0].length);
    const argsJson = extractBalancedJson(rest);
    if (argsJson !== null) {
     try { addResult(toolMatch[1], JSON.parse(argsJson)); } catch {}
    }
   }
  }
 }
 return results;
}

// Extract a balanced JSON object from the start of a string
function extractBalancedJson(s: string): string | null {
 if (s[0] !== '{') return null;
 let depth = 0;
 let inString = false;
 let escape = false;
 for (let i = 0; i < s.length; i++) {
  const ch = s[i];
  if (escape) { escape = false; continue; }
  if (ch === '\\' && inString) { escape = true; continue; }
  if (ch === '"') { inString = !inString; continue; }
  if (inString) continue;
  if (ch === '{') depth++;
  if (ch === '}') { depth--; if (depth === 0) return s.slice(0, i + 1); }
 }
 return null;
}

// Bug 5 fix: balanced-brace pattern instead of greedy [\s\S]*
function extractToolColonCalls(text: string): { name: string; arguments: Record<string, unknown> }[] {
 const results: { name: string; arguments: Record<string, unknown> }[] = [];
 const re = /Tool:\s*(\w+)\s*\n+\s*Arguments:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/g;
 let match: RegExpExecArray | null;
 while ((match = re.exec(text)) !== null) {
 try { results.push({ name: match[1], arguments: JSON.parse(match[2]) }); } catch {}
 }
 return results;
}

// Strip tool call syntax from text so it doesn't appear in the text widget
function stripToolCallSyntax(text: string): string {
 let cleaned = text;
 // Remove "Tool: name\n\nArguments: {json}" blocks
 cleaned = cleaned.replace(/Tool:\s*\w+\s*\n+\s*Arguments:\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '');
 // Remove "Action: name\nAction Input: {json}" blocks
 cleaned = cleaned.replace(/Action:\s*\S+\s*\n\s*Action Input:\s*\{[\s\S]*?\}/g, '');
 // Remove "Tool name(json)" at end
 cleaned = cleaned.replace(/Tool\s+\w+\s*\([\s\S]*?\)\s*$/, '');
 // Remove <|tool_calls|>...</tool_calls> blocks
 cleaned = cleaned.replace(/<\|tool_calls\|>[\s\S]*?<\/tool_calls>/g, '');
 // Remove <|tool|{json}|> blocks
 cleaned = cleaned.replace(/<\|tool\|[\s\S]*?\|>/g, '');
 // Remove **Calling:** `name` + code block blocks
 cleaned = cleaned.replace(/\*\*Calling:\*\*\s*`\w+`\s*\n```[\s\S]*?```/g, '');
 // Remove standalone ```json code blocks with tool calls
 cleaned = cleaned.replace(/```(?:json)?\s*\n\{[\s\S]*?\}\n```/g, '');
 // Clean up excessive blank lines left behind
 cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
 return cleaned;
}

// ── Bug 4 fix: Tool argument validation with Levenshtein correction ──

function levenshteinDistance(a: string, b: string): number {
 const m = a.length, n = b.length;
 const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
 for (let i = 0; i <= m; i++) dp[i][0] = i;
 for (let j = 0; j <= n; j++) dp[0][j] = j;
 for (let i = 1; i <= m; i++)
 for (let j = 1; j <= n; j++)
 dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
 return dp[m][n];
}

function validateToolArgs(
 call: { name: string; arguments: Record<string, unknown> },
 tools: any[],
): { name: string; arguments: Record<string, unknown> } {
 const tool = tools.find((t: any) => t.name === call.name);
 if (!tool?.parameters?.properties) return call;
 const schema = tool.parameters.properties as Record<string, any>;
 const validated: Record<string, unknown> = {};
 for (const key of Object.keys(schema)) {
 if (key in call.arguments) validated[key] = call.arguments[key];
 }
 for (const schemaKey of Object.keys(schema)) {
 if (schemaKey in validated) continue;
 const closeKey = Object.keys(call.arguments).find(
 (k) => !(k in validated) && levenshteinDistance(k, schemaKey) <= 2 && k.length >= schemaKey.length - 2,
 );
 if (closeKey) validated[schemaKey] = call.arguments[closeKey];
 }
 for (const [key, val] of Object.entries(call.arguments)) {
 if (!(key in validated) && /^[a-zA-Z_]\w{0,30}$/.test(key)) validated[key] = val;
 }
 return { name: call.name, arguments: validated };
}

// ── Session & Prompt Helpers ─────────────────────────────────

async function ensureSession(state: HarnessState, modelType: string): Promise<string> {
 if (state.chatSessionId) return state.chatSessionId;
 if (!state.authToken) {
 const auth = await loadAuth();
 state.authToken = auth.token;
 state.cookieHeader = auth.cookieHeader;
 }
 const sessionId = await createSession(state.authToken!, state.cookieHeader!, modelType);
 state.chatSessionId = sessionId;
 return state.chatSessionId;
}

function extractPrompt(context: Context, memorySummary: string): string {
 const parts: string[] = [];
 if (context.systemPrompt) parts.push(`[System]\n${context.systemPrompt}`);
 if (memorySummary) parts.push(`[Memory]\n${memorySummary}`);
 if (context.tools && context.tools.length > 0) {
 const toolDesc = context.tools.map((t: any) => {
 const required: string[] = t.parameters?.required || [];
 const params = t.parameters?.properties
 ? Object.entries(t.parameters.properties)
 .map(([k, v]: [string, any]) => {
 const req = required.includes(k) ? "(required)" : "(optional)";
 return ` - ${k} [${v.type || "any"}] ${req}: ${v.description || ""}`;
 }).join("\n")
 : "";
 return `${t.name}: ${t.description}\n${params}`;
 }).join("\n\n");
 parts.push(`[Available Tools]\n${toolDesc}\n\nTo use a tool, output exactly one JSON object per turn:\n{"tool": "<tool_name>", "args": {"param": "value"}}\nDo NOT wrap in markdown fences. Output ONLY the JSON object.\nIMPORTANT: Always use absolute paths (starting with /) for file operations.`);
 }
 for (const message of context.messages.slice(-6)) {
 if (message.role === "user") {
 const text = typeof message.content === "string" ? message.content
 : message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
 parts.push(`[User]\n${text}`);
 } else if (message.role === "toolResult") {
 const text = message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
 parts.push(`[Tool:${message.toolName}]\n${text}`);
 }
 }
 return parts.join("\n\n");
}

function baseAssistant(model: Model<any>): any {
 return {
 role: "assistant", api: model.api, provider: model.provider, model: model.id,
 content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
 stopReason: "stop", timestamp: Date.now(),
 };
}

// ── Main Stream Function (three-phase design) ────────────────

export function createDeepSeekNativeStream(state: HarnessState): StreamFn {
 return (model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
 const stream = createAssistantMessageEventStream();
 void (async () => {
 const assistant = baseAssistant(model);
 try {
 const modelType = String((options?.metadata?.model_type as string) || "expert");
 const sessionId = await ensureSession(state, modelType);
 const prompt = extractPrompt(context, state.memorySummary);

 const resp = await chatStream(
 { sessionId, prompt, parentMessageId: state.parentMessageId, modelType, Enabled: false, signal: options?.signal },
 { authToken: state.authToken, cookieHeader: state.cookieHeader, powSolver: null },
 );
 if (!resp.body) throw new Error("No response body");

 stream.push({ type: "start", partial: assistant });

 // Bug 6 fix: await XML parser init BEFORE processing stream
 const xmlParser = new XmlToolCallParser();
 let xmlFailed = false;
 try { await xmlParser.init(); } catch { xmlFailed = true; }

 // Bug 3 fix: store textBlockIndex at creation time
 let contentIndex = 0;
 let accumulatedText = "";

 // ── Phase 1: Collect ALL text silently (no text_delta yet) ──
 // Bug 1 & 2 fix: NO tool call parsing mid-stream, NO early returns
 // Bug 7 fix: NO setImmediate per chunk
 for await (const event of parseSseStream(resp.body)) {
 if (event.type === "content") {
 accumulatedText += event.delta;
 // Feed XML parser but DON'T emit anything yet
 if (!xmlFailed && xmlParser.isReady) xmlParser.feed(event.delta);
 } else if (event.type === "") {
 continue;
 } else if (event.type === "done") {
 state.parentMessageId = event.responseMessageId;
 break;
 } else if (event.type === "error") {
 xmlParser.destroy();
 const errAssistant = { ...assistant, stopReason: "error", errorMessage: "API error" };
 stream.push({ type: "error", reason: "error", error: errAssistant });
 stream.end(errAssistant);
 return;
 }
 }

 // Flush XML parser
 if (!xmlFailed && xmlParser.isReady) xmlParser.end();

 // ── Phase 2: Parse ALL tool calls from final accumulated text ──
 const allToolCalls: { name: string; arguments: Record<string, unknown> }[] = [];
 const seenKeys = new Set<string>();

 function addUniqueCalls(calls: { name: string; arguments: Record<string, unknown> }[], prefix: string) {
 for (const call of calls) {
 const key = `${call.name}:${JSON.stringify(call.arguments)}`;
 if (!seenKeys.has(key)) { seenKeys.add(key); allToolCalls.push(call); }
 }
 }

 if (!xmlFailed && xmlParser.isReady) addUniqueCalls(xmlParser.getToolCalls(), "xml");
 addUniqueCalls(extractToolColonCalls(accumulatedText), "colon");
 addUniqueCalls(extractReactToolCalls(accumulatedText), "react");
 addUniqueCalls(extractToolParenCalls(accumulatedText), "paren");
 addUniqueCalls(extractMarkdownToolCalls(accumulatedText), "markdown");
 addUniqueCalls(extractJsonToolCalls(accumulatedText), "json");
 xmlParser.destroy();

 // ── Phase 3: Emit clean text (stripped of tool syntax), then tool calls ──
 const cleanText = stripToolCallSyntax(accumulatedText);

 // Emit clean text as a single text block (only if non-empty)
 if (cleanText.length > 0) {
 const textBlock = { type: "text" as const, text: cleanText };
 assistant.content.push(textBlock);
 const textIdx = contentIndex;
 contentIndex++;
 stream.push({ type: "text_start", contentIndex: textIdx, partial: { ...assistant, content: [...assistant.content] } } as any);
 stream.push({ type: "text_delta", contentIndex: textIdx, delta: cleanText, partial: { ...assistant, content: [...assistant.content] } } as any);
 stream.push({ type: "text_end", contentIndex: textIdx, content: cleanText, partial: { ...assistant, content: [...assistant.content] } } as any);
 }

 // Emit all tool calls as proper pi tool widgets
 const tools = (context as any).tools || [];
 let emittedToolCalls = 0;

 for (const rawCall of allToolCalls) {
 const validated = validateToolArgs(rawCall, tools);
 const toolCall = {
 type: "toolCall" as const,
 id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
 name: validated.name,
 arguments: validated.arguments,
 };
  assistant.content.push(toolCall);
  const tcIndex = contentIndex;
  contentIndex++;
  stream.push({ type: "toolcall_start", contentIndex: tcIndex, partial: { ...assistant, content: [...assistant.content] } } as any);
  stream.push({ type: "toolcall_delta", contentIndex: tcIndex, delta: JSON.stringify(validated.arguments), partial: { ...assistant, content: [...assistant.content] } } as any);
  stream.push({ type: "toolcall_end", contentIndex: tcIndex, toolCall, partial: { ...assistant, content: [...assistant.content] } } as any);
 emittedToolCalls++;
 }

 // End stream with correct stopReason so agent loop continues
 const doneReason = emittedToolCalls > 0 ? "toolUse" : "stop";
 stream.push({ type: "done", reason: doneReason, message: assistant } as any);
 stream.end({ ...assistant, stopReason: doneReason, responseId: state.parentMessageId ?? undefined });
 } catch (error) {
 const err = error instanceof Error ? error.message : String(error);
 const message: any = { ...assistant, stopReason: "error", errorMessage: err };
 stream.push({ type: "error", reason: "error", error: message });
 stream.end(message);
 }
 })();
 return stream;
 };
}
