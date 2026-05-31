// ── Pi Native Tool Registry ─────────────────────────────────────
// Uses @earendil-works/pi-coding-agent's native tool implementations
// (bash, read, write, edit, grep, find, ls) with our DeepSeek-specific
// tool call extraction and stripping logic.

import {
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  createLocalBashOperations,
  withFileMutationQueue,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateTail,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";

// ── Pi Native Tools ─────────────────────────────────────────────

const CWD = process.cwd();

const nativeTools = [
  createReadTool(CWD),
  createBashTool(CWD, { operations: createLocalBashOperations() }),
  createEditTool(CWD),
  createWriteTool(CWD),
  createGrepTool(CWD),
  createFindTool(CWD),
  createLsTool(CWD),
] as AgentTool<any>[];

// ── Tool Interface Compatibility ────────────────────────────────
// Bridge between pi's AgentTool interface and our ToolDef interface
// used by the rest of the harness.

export interface ToolResult {
  content: string;
  isError: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

function agentToolToToolDef(tool: AgentTool<any>): ToolDef {
  return {
    name: tool.name,
    description: tool.description,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        // Validate args against schema if present
        let validatedArgs = args;
        if (tool.parameters) {
          // TypeBox schema validation is best-effort here; pi's execute
          // will handle its own validation.
        }
        const result: AgentToolResult<any> = await tool.execute(
          `call_${Date.now()}`,
          validatedArgs,
          undefined,
          undefined
        );
        const text = result.content
          ?.filter((c: any) => c.type === "text")
          .map((c: any) => c.text || "")
          .join("\n") || "";
        return {
          content: text,
          isError: (result as any).isError || false,
        };
      } catch (err) {
        return {
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

const toolDefs: ToolDef[] = nativeTools.map(agentToolToToolDef);

export function getTool(name: string): ToolDef | undefined {
  return toolDefs.find((t) => t.name === name);
}

export function getAllTools(): ToolDef[] {
  return toolDefs;
}

export function getToolDescriptions(): string {
  return toolDefs.map((t) => `- ${t.name}: ${t.description}`).join("\n");
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) {
    return {
      content: `Unknown tool: '${name}'. Available tools: ${toolDefs.map((t) => t.name).join(", ")}`,
      isError: true,
    };
  }
  return tool.execute(args);
}

// Re-export pi utilities for context truncation
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateTail,
  truncateLine,
  withFileMutationQueue,
};

// ── DeepSeek Tool Call Extraction ───────────────────────────────
// These remain because DeepSend formats tool calls in proprietary ways
// that pi's parsers don't handle.

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function extractDirectToolTags(text: string): ToolCall[] {
  const directToolRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
  const calls: ToolCall[] = [];
  const seenNames = new Set<string>();
  const toolNames = new Set(toolDefs.map((t) => t.name));
  let match: RegExpExecArray | null;
  while ((match = directToolRegex.exec(text)) !== null) {
    const name = match[1];
    if (!toolNames.has(name) || seenNames.has(name)) continue;
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

function extractJsonValue(text: string, startIdx: number): string | null {
  const opener = text[startIdx];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : null;
  if (!closer) return null;

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
    if (c === opener) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return text.substring(startIdx, i + 1);
    }
  }
  return null;
}

function parseToolCallJsonValue(value: unknown, toolNames: Set<string>): ToolCall[] {
  const calls: ToolCall[] = [];
  const arr = Array.isArray(value)
    ? value
    : Array.isArray((value as any)?.tool_calls)
      ? (value as any).tool_calls
      : Array.isArray((value as any)?._calls)
        ? (value as any)._calls
        : value && typeof value === "object"
          ? [value]
          : [];

  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const name = String((item as any).name || ((item as any).function?.name ?? ""));
    if (!toolNames.has(name)) continue;
    calls.push({ name, arguments: normalizeToolArgs(item) });
  }
  return calls;
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
  const toolNames = new Set(toolDefs.map((t) => t.name));
  const calls: ToolCall[] = [];
  const invokeRegex = /<(?:｜｜DSML｜｜|\u{1d9e}\u{1d9a})?invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:｜｜DSML｜｜|\u{1d9e}\u{1d9a})?invoke>/gu;
  let invokeMatch: RegExpExecArray | null;

  while ((invokeMatch = invokeRegex.exec(text)) !== null) {
    const name = invokeMatch[1];
    if (!toolNames.has(name)) continue;

    const args: Record<string, unknown> = {};
    const body = invokeMatch[2];
    const paramRegex = /<(?:｜｜DSML｜｜|\u{1d9e}\u{1d9a})?parameter\s+name=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/(?:｜｜DSML｜｜|\u{1d9e}\u{1d9a})?parameter>/gu;
    let paramMatch: RegExpExecArray | null;

    while ((paramMatch = paramRegex.exec(body)) !== null) {
      args[paramMatch[1]] = coerceDsmlParam(paramMatch[3], paramMatch[2] ?? "");
    }

    if (Object.keys(args).length === 0) {
      const textContent = body.trim();
      if (textContent.startsWith("{") || textContent.startsWith("[")) {
        try {
          const parsed = JSON.parse(textContent);
          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].name) {
            for (const item of parsed) {
              if (item.name === name && item.arguments) {
                Object.assign(args, typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments);
                break;
              }
            }
          } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            Object.assign(args, parsed);
          }
        } catch { /* ignore */ }
      }
    }

    calls.push({ name, arguments: args });
  }

  return calls.length > 0 ? calls : null;
}

function extractJsonToolCalls(text: string): ToolCall[] | null {
  const toolNames = new Set(toolDefs.map((t) => t.name));
  let startIdx = -1;
  const patterns = ['{"tool_calls"', '{"_calls"', '{"tool"'];
  for (const p of patterns) {
    const idx = text.indexOf(p);
    if (idx !== -1) { startIdx = idx; break; }
  }
  if (startIdx === -1) {
    const m = text.match(/\{\s*"(tool_calls|_calls|tool)"/);
    if (m) startIdx = m.index!;
  }
  if (startIdx === -1) return null;

  const jsonStr = extractJsonBlock(text, startIdx);
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const callsArr = (parsed?.tool_calls ?? parsed?._calls) as any[] | undefined;
    if (Array.isArray(callsArr) && callsArr.length > 0) {
      return callsArr.map((c) => ({
        name: String(c.name || (c.function?.name ?? "")),
        arguments: normalizeToolArgs(c),
      })).filter(c => toolNames.has(c.name));
    }
    if (typeof parsed?.tool === "string" && parsed.tool) {
      const args = { ...parsed };
      delete (args as any).tool;
      if (Object.keys(args).length > 0 && toolNames.has(parsed.tool as string)) {
        return [{ name: parsed.tool as string, arguments: args as Record<string, unknown> }];
      }
    }
    return null;
  } catch { return null; }
}

function extractFunctionCallToolCalls(text: string): ToolCall[] | null {
  const toolNames = new Set(toolDefs.map((t) => t.name));
  const funcRegex = /<function_call\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/function_call>/gi;
  const calls: ToolCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = funcRegex.exec(text)) !== null) {
    const fname = m[1];
    if (!toolNames.has(fname)) continue;
    const fargs: Record<string, unknown> = {};
    const fparamRegex = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
    let fpm: RegExpExecArray | null;
    while ((fpm = fparamRegex.exec(m[2])) !== null) fargs[fpm[1]] = fpm[2].trim();
    calls.push({ name: fname, arguments: fargs });
  }
  return calls.length > 0 ? calls : null;
}

function extractXmlToolCalls(text: string): ToolCall[] | null {
  const dsml = extractDeepSeekDsmlToolCalls(text);
  if (dsml) return dsml;

  const toolNames = new Set(toolDefs.map((t) => t.name));
  const wrappers = [
    '<tool_calls>', '<function_calls>', '<pi-tool-calls>',
    '<_calls>', '<｜｜DSML｜｜tool_calls>', '<\u{1d9e}\u{1d9a}tool_calls>',
  ];
  type Wrapper = { ws: string; we: string; si: number; ei: number };
  const found: Wrapper[] = [];
  const lowerText = text.toLowerCase();
  for (const w of wrappers) {
    const ws = w;
    const we = w.replace('<', '</');
    const si = lowerText.indexOf(ws.toLowerCase());
    if (si === -1) continue;
    const ei = lowerText.indexOf(we.toLowerCase(), si);
    if (ei === -1) continue;
    const actualWs = text.slice(si, si + ws.length);
    const actualWe = text.slice(ei, ei + we.length);
    found.push({ ws: actualWs, we: actualWe, si, ei });
  }
  found.sort((a, b) => a.si - b.si);
  for (const { ws, we } of found) {
    const si = text.indexOf(ws);
    const ei = text.indexOf(we, si);
    const inner = text.slice(si + ws.length, ei);
    const calls: ToolCall[] = [];

    const invokeRegex = /<(?:｜｜DSML｜｜|\u{1d9e}\u{1d9a})?invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:｜｜DSML｜｜|\u{1d9e}\u{1d9a})?invoke>/gu;
    let m: RegExpExecArray | null;
    while ((m = invokeRegex.exec(inner)) !== null) {
      const params: Record<string, unknown> = {};
      const paramRegex = /<(?:｜｜DSML｜｜|\u{1d9e}\u{1d9a})?parameter\s+name=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/(?:｜｜DSML｜｜|\u{1d9e}\u{1d9a})?parameter>/gu;
      let pm: RegExpExecArray | null;
      while ((pm = paramRegex.exec(m[2])) !== null) params[pm[1]] = pm[2].trim();
      if (m[1] && toolNames.has(m[1])) calls.push({ name: m[1], arguments: params });
    }

    if (calls.length === 0) {
      const trimmed = inner.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        const jsonValue = extractJsonValue(trimmed, 0);
        if (jsonValue) {
          try {
            calls.push(...parseToolCallJsonValue(JSON.parse(jsonValue), toolNames));
          } catch { /* ignore */ }
        }
      }
    }

    if (calls.length === 0) {
      const trimmed = inner.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed);
          calls.push(...parseToolCallJsonValue(parsed, toolNames));
        } catch { /* ignore */ }
      }
    }

    if (calls.length === 0) {
      const funcRegex = /<function_call\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/function_call>/g;
      let fm: RegExpExecArray | null;
      while ((fm = funcRegex.exec(inner)) !== null) {
        const fname = fm[1];
        const fargs: Record<string, unknown> = {};
        const fparamRegex = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/g;
        let fpm: RegExpExecArray | null;
        while ((fpm = fparamRegex.exec(fm[2])) !== null) fargs[fpm[1]] = fpm[2].trim();
        if (fname && toolNames.has(fname)) calls.push({ name: fname, arguments: fargs });
      }
    }

    if (calls.length > 0) return calls;
  }
  return null;
}

function extractToolCallsFromCodeBlocks(text: string): ToolCall[] | null {
  const codeBlockRegex = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const inner = match[1].trim();
    const j = (function extractJson(text: string): ToolCall[] | null {
      let startIdx = -1;
      const patterns = ['{"tool_calls"', '{"_calls"', '{"tool"'];
      for (const p of patterns) {
        const idx = text.indexOf(p);
        if (idx !== -1) { startIdx = idx; break; }
      }
      if (startIdx === -1) {
        const m = text.match(/\{\s*"(tool_calls|_calls|tool)"/);
        if (m) startIdx = m.index!;
      }
      if (startIdx === -1) return null;
      const jsonStr = extractJsonBlock(text, startIdx);
      if (!jsonStr) return null;
      try {
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        const callsArr = (parsed?.tool_calls ?? parsed?._calls) as any[] | undefined;
        if (Array.isArray(callsArr) && callsArr.length > 0) {
          return callsArr.map((c) => ({
            name: String(c.name || (c.function?.name ?? "")),
            arguments: normalizeToolArgs(c),
          }));
        }
        return null;
      } catch { return null; }
    })(inner);
    if (j && j.length > 0) return j;
    const x = extractXmlToolCalls(inner);
    if (x && x.length > 0) return x;
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

  const fc = extractFunctionCallToolCalls(text);
  if (fc) return fc;

  const cb = extractToolCallsFromCodeBlocks(text);
  if (cb) return cb;

  return null;
}

export function stripToolCalls(text: string): string {
  let result = text;

  for (const [start, end] of [
    ['<_calls>', '</_calls>'],
    ['<｜｜DSML｜｜tool_calls>', '</｜｜DSML｜｜tool_calls>'],
    ['<tool_calls>', '</tool_calls>'],
    ['<function_calls>', '</function_calls>'],
    ['<pi-tool-calls>', '</pi-tool-calls>'],
    ['<｜｜DSML｜｜invoke', '</｜｜DSML｜｜invoke>'],
    ['<invoke', '</invoke>'],
    ['<function_call', '</function_call>'],
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

  result = result.replace(/<(?:｜｜DSML｜｜)?parameter\s[^>]*>[\s\S]*?<\/(?:｜｜DSML｜｜)?parameter>/g, '');
  result = result.replace(/```(?:json)?\s*\n?[\s\S]*?```/g, '');

  let jsonIdx = -1;
  const jsonPatterns = ['{"tool_calls"', '{"_calls"', '{"tool"'];
  for (const p of jsonPatterns) {
    const idx = result.indexOf(p);
    if (idx !== -1) { jsonIdx = idx; break; }
  }
  if (jsonIdx === -1) {
    const m = result.match(/\{\s*"(tool_calls|_calls|tool)"/);
    if (m) jsonIdx = m.index!;
  }
  if (jsonIdx !== -1) {
    let depth = 0;
    let endIdx = jsonIdx;
    for (let i = jsonIdx; i < result.length; i++) {
      if (result[i] === '{') depth++;
      if (result[i] === '}') depth--;
      if (depth === 0) { endIdx = i; break; }
    }
    result = result.slice(0, jsonIdx) + result.slice(endIdx + 1);
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

  const toolNames = toolDefs.map((t) => t.name).join('|');
  result = result.replace(new RegExp(`<(${toolNames})>[\\s\\S]*?<\\/\\1>`, 'g'), '');

  result = result.replace(/  +/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n');

  result = result.replace(/<tool_calls>\s*/g, '').replace(/\s*<\/tool_calls>/g, '');
  result = result.replace(/<｜｜DSML｜｜tool_calls>\s*/g, '').replace(/\s*<\/｜｜DSML｜｜tool_calls>/g, '');
  result = result.replace(/<_calls>\s*/g, '').replace(/\s*<\/_calls>/g, '');
  result = result.replace(/<function_calls>\s*/g, '').replace(/\s*<\/function_calls>/g, '');
  result = result.replace(/<pi-tool-calls>\s*/g, '').replace(/\s*<\/pi-tool-calls>/g, '');

  return result.replace(/\n{3,}/g, "\n\n").trim();
}
