import { $, type BunFile } from "bun";
import path from "node:path";
import { truncateFileContent, truncateMessage } from "./context.js";
import { isBatchReady, batchParser, ensureBatchParser } from "./xml-toolcall-parser.js";

// Eagerly initialize sax-wasm WASM at module load time
ensureBatchParser().catch(() => {});

export interface ToolResult {
  content: string;
  isError: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

const readTool: ToolDef = {
  name: "read",
  description: "Read a UTF-8 text file. Args: path (required), offset (1-based line number, optional), limit (number of lines, optional). Use before editing files.",
  async execute(args) {
    const fp = String(args.path);
    const file = Bun.file(fp);
    const exists = await file.exists();
    if (!exists) return { content: `Error: File not found: ${fp}`, isError: true };
    const text = await file.text();
    let lines = text.split("\n");
    const offset = args.offset ? Math.max(0, Number(args.offset) - 1) : 0;
    const limit = args.limit ? Number(args.limit) : undefined;
    if (offset > 0 || limit !== undefined) {
      lines = lines.slice(offset, limit !== undefined ? offset + limit : undefined);
    }
    const output = truncateFileContent(lines.join("\n"));
    const total = text.split("\n").length;
    return {
      content: `[Lines ${offset + 1}-${offset + lines.length} of ${total}]\n${output}`,
      isError: false,
    };
  },
};

const writeTool: ToolDef = {
  name: "write",
  description: "Write a complete file. Creates parent dirs when needed. Args: path (required), content (required). Prefer edit for small changes.",
  async execute(args) {
    const fp = String(args.path);
    await Bun.write(fp, String(args.content));
    return { content: `Wrote ${fp} (${String(args.content).length} chars)`, isError: false };
  },
};

const grepTool: ToolDef = {
  name: "grep",
  description: "Search files with ripgrep. Args: pattern (required), path (optional), include glob like '*.ts' (optional). Use to locate code before reading/editing.",
  async execute(args) {
    try {
      const pattern = String(args.pattern).replace(/'/g, "'\\''");
      const searchPath = String(args.path || ".");
      const proc = Bun.spawn(["rg", "-n", pattern, ...(args.include ? ["-g", String(args.include)] : []), searchPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      if (exitCode === 1) return { content: "(no matches)", isError: false };
      if (exitCode !== 0) return { content: `grep error (${exitCode}): ${stderr.trim()}`, isError: true };
      const lines = stdout.split("\n").filter(Boolean);
      if (lines.length > 200) {
        return { content: `${lines.length} matches. First 200:\n${lines.slice(0, 200).join("\n")}`, isError: false };
      }
      return { content: stdout || "(no matches)", isError: false };
    } catch (e: unknown) {
      return { content: `grep error: ${(e as Error).message}`, isError: true };
    }
  },
};

const bashTool: ToolDef = {
  name: "bash",
  description: "Run a non-interactive shell command. Args: command (required). 120s timeout. Use for ls/find/build/test/status commands.",
  async execute(args) {
    const cmd = String(args.command);
    const shellPath = Bun.which("sh") || Bun.which("bash") || "/bin/sh";
    const proc = Bun.spawn([shellPath, "-c", cmd], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return { content: stderr.trim() || `Exit code: ${exitCode}`, isError: true };
    }
    return { content: stdout.trim() || "(no output)", isError: false };
  },
};

const editTool: ToolDef = {
  name: "edit",
  description: "Find/replace exact text in a file. Args: path (required), old_string (required), new_string (required). Fails if old_string is absent.",
  async execute(args) {
    const fp = String(args.path);
    const oldStr = String(args.old_string);
    const newStr = String(args.new_string);
    const file = Bun.file(fp);
    const exists = await file.exists();
    if (!exists) return { content: `Error: File not found: ${fp}`, isError: true };
    const text = await file.text();
    if (!text.includes(oldStr)) {
      return { content: `Error: couldn't find exact match in ${fp}`, isError: true };
    }
    const result = text.replaceAll(oldStr, newStr);
    await Bun.write(fp, result);
    return { content: `Edited ${fp}`, isError: false };
  },
};

const toolMap: Record<string, ToolDef> = {
  read: readTool,
  write: writeTool,
  grep: grepTool,
  bash: bashTool,
  edit: editTool,
};

export function getTool(name: string): ToolDef | undefined {
  return toolMap[name];
}

export function getAllTools(): ToolDef[] {
  return Object.values(toolMap);
}

export function getToolDescriptions(): string {
  return getAllTools().map(
    (t) => `- ${t.name}: ${t.description}`
  ).join("\n");
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = toolMap[name];
  if (!tool) {
    return {
      content: `Unknown tool: '${name}'. Available tools: ${Object.keys(toolMap).join(", ")}`,
      isError: true,
    };
  }
  return tool.execute(args);
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function extractDirectToolTags(text: string): ToolCall[] {
  const directToolRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
  const calls: ToolCall[] = [];
  const seenNames = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = directToolRegex.exec(text)) !== null) {
    const name = match[1];
    if (!['bash', 'read', 'write', 'edit', 'grep'].includes(name) || seenNames.has(name)) continue;
    seenNames.add(name);
    const content = match[2];
    try {
      const parsed = JSON.parse(content);
      calls.push({ name, arguments: parsed });
    } catch {
      const args: Record<string, unknown> = {};
      const allArgs = content.matchAll(/"(\w+)":\s*("[^"]*"|\{[^}]*\}|[\d.]+)/g);
      for (const m of allArgs) {
        try { args[m[1]] = JSON.parse(m[2]); } catch { args[m[1]] = m[2]; }
      }
      if (Object.keys(args).length > 0) calls.push({ name, arguments: args });
    }
  }
  return calls;
}

function extractJsonBlock(text: string, startIdx: number): string | null {
  let depth = 0;
  let inStr = false;
  for (let i = startIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return text.substring(startIdx, i + 1); }
  }
  return null;
}

function normalizeToolArgs(c: any): Record<string, unknown> {
  if (c.arguments != null) {
    return typeof c.arguments === "string" ? JSON.parse(c.arguments) : c.arguments as Record<string, unknown>;
  }
  if (c.function?.arguments != null) {
    return typeof c.function.arguments === "string" ? JSON.parse(c.function.arguments) : c.function.arguments as Record<string, unknown>;
  }
  return {};
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function coerceDsmlParam(value: string, attrs: string): unknown {
  const decoded = decodeXmlText(value);
  if (/\bstring=["']true["']/.test(attrs)) return decoded;
  if (/\bnumber=["']true["']/.test(attrs)) {
    const n = Number(decoded);
    return Number.isNaN(n) ? decoded : n;
  }
  if (/\bboolean=["']true["']/.test(attrs)) {
    if (decoded === "true") return true;
    if (decoded === "false") return false;
    return decoded;
  }
  if (/\bjson=["']true["']/.test(attrs)) {
    try { return JSON.parse(decoded); } catch { return decoded; }
  }
  try { return JSON.parse(decoded); } catch { return decoded; }
}

function extractDeepSeekDsmlToolCalls(text: string): ToolCall[] | null {
  const calls: ToolCall[] = [];
  const invokeRegex = /<｜｜DSML｜｜invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/｜｜DSML｜｜invoke>/g;
  let invokeMatch: RegExpExecArray | null;

  while ((invokeMatch = invokeRegex.exec(text)) !== null) {
    const name = invokeMatch[1];
    if (!toolMap[name]) continue;

    const args: Record<string, unknown> = {};
    const body = invokeMatch[2];
    const paramRegex = /<｜｜DSML｜｜parameter\s+name=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;
    let paramMatch: RegExpExecArray | null;

    while ((paramMatch = paramRegex.exec(body)) !== null) {
      args[paramMatch[1]] = coerceDsmlParam(paramMatch[3], paramMatch[2] ?? "");
    }

    calls.push({ name, arguments: args });
  }

  return calls.length > 0 ? calls : null;
}

function extractJsonToolCalls(text: string): ToolCall[] | null {
  let startIdx = -1;
  const patterns = ['{"tool_calls"', '{"_calls"', '{"tool"'];
  for (const p of patterns) {
    const idx = text.indexOf(p);
    if (idx !== -1) { startIdx = idx; break; }
  }
  if (startIdx === -1) {
    // Whitespace-flexible: find key anywhere with any whitespace between { and key
    const m = text.match(/\{\s*"(tool_calls|_calls|tool)"/);
    if (m) startIdx = m.index!;
  }
  if (startIdx === -1) return null;

  const jsonStr = extractJsonBlock(text, startIdx);
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    // Format 1: {"tool_calls": [...]} or {"_calls": [...]}
    const callsArr = (parsed?.tool_calls ?? parsed?._calls) as any[] | undefined;
    if (Array.isArray(callsArr) && callsArr.length > 0) {
      return callsArr.map((c) => ({
        name: String(c.name || (c.function?.name ?? "")),
        arguments: normalizeToolArgs(c),
      }));
    }
    // Format 2: {"tool": "name", ...} — single tool call with top-level args
    if (typeof parsed?.tool === "string" && parsed.tool) {
      const args = { ...parsed };
      delete (args as any).tool;
      if (Object.keys(args).length > 0) {
        return [{ name: parsed.tool as string, arguments: args as Record<string, unknown> }];
      }
    }
    return null;
  } catch { return null; }
}

function extractXmlToolCalls(text: string): ToolCall[] | null {
  const dsml = extractDeepSeekDsmlToolCalls(text);
  if (dsml) return dsml;

  // Try sax-wasm first (synchronous once WASM is loaded)
  if (isBatchReady() && batchParser && batchParser.isReady) {
    batchParser.reset();
    batchParser.feed(text);
    batchParser.end();
    const calls = batchParser.getToolCalls();
    if (calls.length > 0) return calls;
  }

  // Fallback: regex-based DSML extraction
  const wrappers = ['<tool_calls>', '<function_calls>', '<pi-tool-calls>'];
  type Wrapper = { ws: string; we: string; si: number; ei: number };
  const found: Wrapper[] = [];
  for (const w of wrappers) {
    const ws = w;
    const we = w.replace('<', '</');
    const si = text.indexOf(ws);
    if (si === -1) continue;
    const ei = text.indexOf(we, si);
    if (ei === -1) continue;
    found.push({ ws, we, si, ei });
  }
  found.sort((a, b) => a.si - b.si);
  for (const { ws, we } of found) {
    const si = text.indexOf(ws);
    const ei = text.indexOf(we, si);
    const inner = text.slice(si + ws.length, ei);
    const calls: ToolCall[] = [];
    const invokeRegex = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/g;
    let m: RegExpExecArray | null;
    while ((m = invokeRegex.exec(inner)) !== null) {
      const params: Record<string, unknown> = {};
      const paramRegex = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/g;
      let pm: RegExpExecArray | null;
      while ((pm = paramRegex.exec(m[2])) !== null) params[pm[1]] = pm[2].trim();
      if (m[1]) calls.push({ name: m[1], arguments: params });
    }
    if (calls.length > 0) return calls;
  }
  return null;
}

/**
 * Extract tool calls from inside markdown code blocks.
 * Models sometimes wrap tool calls in ```json ... ``` — we need to look inside.
 */
function extractToolCallsFromCodeBlocks(text: string): ToolCall[] | null {
  const codeBlockRegex = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const inner = match[1].trim();
    // Try JSON extraction on code block content
    const j = extractJsonToolCalls(inner);
    if (j && j.length > 0) return j;
    // Try XML extraction on code block content
    const x = extractXmlToolCalls(inner);
    if (x && x.length > 0) return x;
    // Try direct tool tags on code block content
    const d = extractDirectToolTags(inner);
    if (d.length > 0) return d;
  }
  return null;
}

export function extractToolCalls(text: string): ToolCall[] | null {
  const rawTcCount = (text.match(/<tool_calls>/g) || []).length;
  if (rawTcCount > 50) return null;

  const dsml = extractDeepSeekDsmlToolCalls(text);
  if (dsml) return dsml;

  const d = extractDirectToolTags(text);
  if (d.length > 0) return d;

  const j = extractJsonToolCalls(text);
  if (j) return j;

  const x = extractXmlToolCalls(text);
  if (x) return x;

  // Fallback: look inside markdown code blocks
  const cb = extractToolCallsFromCodeBlocks(text);
  if (cb) return cb;

  return null;
}

export function stripToolCalls(text: string): string {
  let result = text;

  for (const [start, end] of [
    ['<_calls>', '</_calls>'],
    ['<｜｜DSML｜｜tool_calls>', '</｜｜DSML｜｜tool_calls>'],
    ['<tool_calls>', '</｜｜DSML｜｜tool_calls>'],
    ['<tool_calls>', '</tool_calls>'],
    ['<function_calls>', '</function_calls>'],
    ['<pi-tool-calls>', '</pi-tool-calls>'],
  ] as const) {
    let idx = result.indexOf(start);
    while (idx !== -1) {
      const endIdx = result.indexOf(end, idx);
      if (endIdx !== -1) {
        result = result.slice(0, idx) + result.slice(endIdx + end.length);
      } else {
        result = result.slice(0, idx);
        break;
      }
      idx = result.indexOf(start);
    }
  }

  const dsmlStart = '<｜｜DSML｜｜tool_calls>';
  const dsmlEnd = '</｜｜DSML｜｜tool_calls>';
  let dsmlIdx = result.indexOf(dsmlStart);
  while (dsmlIdx !== -1) {
    const endIdx = result.indexOf(dsmlEnd, dsmlIdx);
    if (endIdx !== -1) {
      result = result.slice(0, dsmlIdx) + result.slice(endIdx + dsmlEnd.length);
    } else {
      break;
    }
    dsmlIdx = result.indexOf(dsmlStart);
  }

  const piTcStart = '<pi-tool-calls>';
  const piTcEnd = '</pi-tool-calls>';
  let piIdx = result.indexOf(piTcStart);
  while (piIdx !== -1) {
    const endIdx = result.indexOf(piTcEnd, piIdx);
    if (endIdx !== -1) {
      result = result.slice(0, piIdx) + result.slice(endIdx + piTcEnd.length);
    } else {
      break;
    }
    piIdx = result.indexOf(piTcStart);
  }

  const funcStart = '<function_calls>';
  const funcEnd = '</function_calls>';
  let funcIdx = result.indexOf(funcStart);
  while (funcIdx !== -1) {
    const endIdx = result.indexOf(funcEnd, funcIdx);
    if (endIdx !== -1) {
      result = result.slice(0, funcIdx) + result.slice(endIdx + funcEnd.length);
    } else {
      break;
    }
    funcIdx = result.indexOf(funcStart);
  }

  result = result.replace(/```(?:json)?\s*\n?[\s\S]*?```/g, '');

  const tcOpen = '<tool_calls>';
  const tcClose = '</tool_calls>';
  let tcOpenIdx = result.indexOf(tcOpen);
  while (tcOpenIdx !== -1) {
    const endIdx = result.indexOf(tcClose, tcOpenIdx);
    if (endIdx !== -1) {
      result = result.slice(0, tcOpenIdx) + result.slice(endIdx + tcClose.length);
    } else {
      break;
    }
    tcOpenIdx = result.indexOf(tcOpen);
  }

  result = result.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
  result = result.replace(/<thinking>[\s\S]*/g, '');
  result = result.replace(/\[Tool:\w+\]\s*\n?/g, '');
  result = result.replace(/\[Tool Result\].*?\n?/g, '');

  const customMarker = '<|tool_calls|[';
  let idx = result.indexOf(customMarker);
  while (idx !== -1) {
    const bracketIdx = result.indexOf(']', idx + customMarker.length - 1);
    if (bracketIdx !== -1) {
      result = result.slice(0, idx) + result.slice(bracketIdx + 1);
    } else {
      break;
    }
    idx = result.indexOf(customMarker);
  }

  for (const key of ['{"tool_calls', '{"_calls', '{"tool']) {
    while (true) {
      const idx = result.indexOf(key);
      if (idx === -1) break;
      let depth = 0;
      let inStr = false;
      let end = idx;
      let foundEnd = false;
      for (let i = idx; i < result.length; i++) {
        const c = result[i];
        if (inStr) {
          if (c === '\\') { i++; continue; }
          if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { end = i + 1; foundEnd = true; break; } }
      }
      if (!foundEnd) {
        result = result.slice(0, idx);
        break;
      }
      result = result.slice(0, idx) + result.slice(end);
    }
  }

  result = result.replace(/<(bash|read|write|edit|grep)>[\s\S]*?<\/\1>/g, '');
  result = result.replace(/  +/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n');

  let tcOpenCount = (result.match(/<tool_calls>/g) || []).length;
  let tcCloseCount = (result.match(/<\/tool_calls>/g) || []).length;
  if (tcOpenCount > 0 || tcCloseCount > 0) {
    result = result.replace(/<tool_calls>\s*/g, '').replace(/\s*<\/tool_calls>/g, '');
    const lines = result.split('\n');
    result = lines.filter(l => l.trim() && !l.includes('<tool_calls>') && !l.includes('</tool_calls>')).join('\n');
  }

  result = result.replace(/\[Tool:\w+\]\s*\n?/g, '');
  result = result.replace(/\[Tool Result\].*?\n?/g, '');

  return result.replace(/\n{3,}/g, "\n\n").trim();
}
