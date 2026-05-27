export const MAX_FILE_CHARS = 32_000;
export const MAX_MESSAGE_CHARS = 24_000;
export const MAX_TURNS = 100;
export const COMPACTION_THRESHOLD = 0.9;

export interface ToolCallFingerprint {
  name: string;
  argsHash: string;
}

function hashArgs(args: Record<string, unknown>): string {
  let s = "";
  const keys = Object.keys(args).sort();
  for (const k of keys) {
    s += k + ":" + String(args[k]).slice(0, 300) + "|";
  }
  return s;
}

export function fingerprintToolCall(name: string, args: Record<string, unknown>): ToolCallFingerprint {
  return { name, argsHash: hashArgs(args) };
}

export function detectRepeatedCalls(
  current: Array<{ name: string; arguments: Record<string, unknown> }>,
  history: Array<{ name: string; arguments: Record<string, unknown> }>,
): string[] {
  const warnings: string[] = [];
  const counts = new Map<string, number>();
  for (const h of history) {
    const key = h.name + ":" + hashArgs(h.arguments);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const c of current) {
    const key = c.name + ":" + hashArgs(c.arguments);
    const count = (counts.get(key) || 0) + 1;
    if (count >= 3) {
      warnings.push(`Repeated tool call: ${c.name}(${JSON.stringify(c.arguments)}) — called ${count} times`);
    }
  }
  return warnings;
}

export function truncateFileContent(text: string, max = MAX_FILE_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.6));
  const tail = text.slice(-Math.floor(max * 0.3));
  return `${head}\n[...${text.length - max} chars truncated...]\n${tail}`;
}

export function truncateMessage(text: string, max = MAX_MESSAGE_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.6));
  const tail = text.slice(-Math.floor(max * 0.3));
  return `${head}\n[...${text.length - max} chars truncated...]\n${tail}`;
}

export function estimateTokens(text: string): number {
  // chars/4 with a 25% safety margin to avoid underestimating for code/symbols
  return Math.ceil((text.length / 4) * 1.25);
}

export function compactHistory(
  messages: Array<{ role: string; content: string; name?: string }>,
  budget: number,
): Array<{ role: string; content: string; name?: string }> {
  const total = messages.reduce((s, m) => s + estimateTokens(m.content), 0);
  if (total <= budget) return messages;

  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  const result: Array<{ role: string; content: string; name?: string }> = [...system];
  let used = system.reduce((s, m) => s + estimateTokens(m.content), 0);

  for (const msg of nonSystem) {
    const tokens = estimateTokens(msg.content);
    if (used + tokens > budget && result.length > system.length) {
      if (msg.role === "tool") {
        result.push({ ...msg, content: `[Tool result: ${msg.name} — ${msg.content.length} chars]` });
      } else {
        result.push(msg);
      }
      break;
    }
    result.push(msg);
    used += tokens;
  }

  return result;
}

export function checkTurnLimit(round: number, maxRounds = MAX_TURNS): string | null {
  if (round > maxRounds) {
    return `Max turns (${maxRounds}) reached. Task incomplete.`;
  }
  return null;
}
