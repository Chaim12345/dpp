#!/usr/bin/env bun
import { expect, test } from "bun:test";
import { createEventParser } from "vectorjson";

function extractXmlToolCalls(buf: string, toolNames: Set<string>): { name: string; arguments: Record<string, unknown> }[] {
  const results: { name: string; arguments: Record<string, unknown> }[] = [];
  const invokeRe = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/g;
  let m: RegExpExecArray | null;
  while ((m = invokeRe.exec(buf)) !== null) {
    const name = m[1];
    if (!toolNames.has(name)) continue;
    const args: Record<string, unknown> = {};
    const paramRe = /<(?:parameter|param)\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:parameter|param)>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(m[2])) !== null) {
      let val: any = pm[2].trim();
      try { val = JSON.parse(val); } catch { /* keep as string */ }
      args[pm[1]] = val;
    }
    if (Object.keys(args).length > 0) results.push({ name, arguments: args });
  }
  return results;
}

function extractFromChunks(chunks: string[], toolNames: Set<string>) {
  const emitted: { name: string; arguments: Record<string, unknown> }[] = [];
  const emittedKeys = new Set<string>();
  const xmlBuf = { value: "" };
  const vjParser = createEventParser();
  vjParser.on('tool_calls[*]', (e: any) => {
    const tc = e.value;
    if (tc && typeof tc === 'object' && tc.name && tc.arguments) {
      const key = `${tc.name}:${JSON.stringify(tc.arguments)}`;
      if (!emittedKeys.has(key)) { emittedKeys.add(key); emitted.push(tc); }
    }
  });
  for (const chunk of chunks) {
    vjParser.feed(chunk);
    xmlBuf.value += chunk;
    for (const call of extractXmlToolCalls(xmlBuf.value, toolNames)) {
      const key = `${call.name}:${JSON.stringify(call.arguments)}`;
      if (!emittedKeys.has(key)) { emittedKeys.add(key); emitted.push(call); }
    }
  }
  try {
    const val = vjParser.getValue() as any;
    if (val?.tool_calls && Array.isArray(val.tool_calls)) {
      for (const tc of val.tool_calls) {
        if (tc?.name && tc.arguments) {
          const key = `${tc.name}:${JSON.stringify(tc.arguments)}`;
          if (!emittedKeys.has(key)) { emittedKeys.add(key); emitted.push(tc); }
        }
      }
    }
  } catch { /* ignore */ }
  for (const call of extractXmlToolCalls(xmlBuf.value, toolNames)) {
    const key = `${call.name}:${JSON.stringify(call.arguments)}`;
    if (!emittedKeys.has(key)) { emittedKeys.add(key); emitted.push(call); }
  }
  vjParser.destroy();
  return emitted;
}

const TOOLS = new Set(["read", "write", "edit", "bash", "grep", "glob", "ls", "find"]);

test("JSON single tool call in one chunk", () => {
  const result = extractFromChunks(['{"tool_calls":[{"name":"bash","arguments":{"command":"ls -la"}}]}'], TOOLS);
  expect(result.length).toBe(1);
  expect(result[0].name).toBe("bash");
  expect(result[0].arguments).toEqual({ command: "ls -la" });
});

test("JSON single tool call streamed across chunks", () => {
  const result = extractFromChunks(['{"tool_calls":[{"name":"read","arg', 'uments":{"path":"package.json', '"}}]}'], TOOLS);
  expect(result.length).toBe(1);
  expect(result[0].name).toBe("read");
  expect((result[0].arguments as any).path).toBe("package.json");
});

test("JSON multiple tool calls", () => {
  const result = extractFromChunks(['{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}},{"name":"bash","arguments":{"command":"pwd"}}]}'], TOOLS);
  expect(result.length).toBe(2);
  expect(result[0].arguments).toEqual({ command: "ls" });
  expect(result[1].arguments).toEqual({ command: "pwd" });
});

test("JSON nested quotes in command", () => {
  const cmd = "awk 'NR==204{sub(/old/,\"new\")}1' main.go";
  const json = JSON.stringify({ tool_calls: [{ name: "bash", arguments: { command: cmd } }] });
  const result = extractFromChunks([json], TOOLS);
  expect(result.length).toBe(1);
  expect(result[0].arguments).toEqual({ command: cmd });
});

test("JSON edits array", () => {
  const json = '{"tool_calls":[{"name":"edit","arguments":{"path":"file.txt","edits":[{"oldText":"foo","newText":"bar"}]}}]}';
  const result = extractFromChunks([json], TOOLS);
  expect(result.length).toBe(1);
  expect(result[0].name).toBe("edit");
  expect((result[0].arguments as any).edits).toEqual([{ oldText: "foo", newText: "bar" }]);
});

test("JSON complex bash with awk and redirects", () => {
  const cmd = "awk 'NR==204{sub(/originalRequest string\\)/,\"basePrompt string)\")}1' main.go > /tmp/main_new.go && mv /tmp/main_new.go main.go";
  const json = JSON.stringify({ tool_calls: [{ name: "bash", arguments: { command: cmd, timeout: 5000 } }] });
  const result = extractFromChunks([json], TOOLS);
  expect(result.length).toBe(1);
  expect(result[0].arguments).toEqual({ command: cmd, timeout: 5000 });
});

test("XML single invoke", () => {
  const L = "<";
  const G = ">";
  const xml = [
    L + "tool_calls" + G,
    L + "invoke name=" + '"bash"' + G,
    L + "parameter name=" + '"command"' + G + "ls -la" + L + "/parameter" + G,
    L + "/invoke" + G,
    L + "/tool_calls" + G,
  ].join("\n");
  const result = extractFromChunks([xml], TOOLS);
  expect(result.length).toBe(1);
  expect(result[0].name).toBe("bash");
  expect(result[0].arguments).toEqual({ command: "ls -la" });
});

test("XML multiple invokes", () => {
  const L = "<";
  const G = ">";
  const xml = [
    L + "tool_calls" + G,
    L + "invoke name=" + '"bash"' + G,
    L + "parameter name=" + '"command"' + G + "ls" + L + "/parameter" + G,
    L + "/invoke" + G,
    L + "invoke name=" + '"bash"' + G,
    L + "parameter name=" + '"command"' + G + "pwd" + L + "/parameter" + G,
    L + "/invoke" + G,
    L + "/tool_calls" + G,
  ].join("\n");
  const result = extractFromChunks([xml], TOOLS);
  expect(result.length).toBe(2);
  expect(result[0].arguments).toEqual({ command: "ls" });
  expect(result[1].arguments).toEqual({ command: "pwd" });
});

test("XML streamed across chunks", () => {
  const L = "<";
  const G = ">";
  const c1 = L + "tool_calls" + G + "\n" + L + "invoke name=" + '"bash"' + G + "\n" + L + "parameter name=" + '"command"';
  const c2 = G + "ls -la" + L + "/parameter" + G + "\n" + L + "/invoke" + G + "\n" + L + "/tool_calls" + G;
  const result = extractFromChunks([c1, c2], TOOLS);
  expect(result.length).toBe(1);
  expect(result[0].name).toBe("bash");
  expect(result[0].arguments).toEqual({ command: "ls -la" });
});

test("Unknown tool name ignored", () => {
  const L = "<";
  const G = ">";
  const xml = [L + "tool_calls" + G, L + "invoke name=" + '"custom_tool"' + G, L + "parameter name=" + '"x"' + G + "1" + L + "/parameter" + G, L + "/invoke" + G, L + "/tool_calls" + G].join("\n");
  const result = extractFromChunks([xml], TOOLS);
  expect(result.length).toBe(0);
});

test("No duplicates between JSON and XML on same input", () => {
  const L = "<";
  const G = ">";
  const json = '{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}';
  const xml = [L + "tool_calls" + G, L + "invoke name=" + '"bash"' + G, L + "parameter name=" + '"command"' + G + "ls" + L + "/parameter" + G, L + "/invoke" + G, L + "/tool_calls" + G].join("\n");
  const result = extractFromChunks([json, xml], TOOLS);
  expect(result.length).toBe(1);
  expect(result[0].arguments).toEqual({ command: "ls" });
});

test("Mixed text before JSON tool call", () => {
  const result = extractFromChunks([
    "Let me explore the project.\n\n",
    '{"tool_calls":[{"name":"ls","arguments":{"path":"src/"}}]}',
  ], TOOLS);
  expect(result.length).toBe(1);
  expect(result[0].name).toBe("ls");
  expect((result[0].arguments as any).path).toBe("src/");
});

test("tool-registry extraction: JSON from code blocks", () => {
  const result = extractFromChunks([
    "Here's what I found:\n```json\n",
    '{"tool_calls":[{"name":"bash","arguments":{"command":"grep -rn TODO src/"}}]}',
    "\n```\n",
  ], TOOLS);
  expect(result.length).toBe(1);
  expect(result[0].name).toBe("bash");
});

test("empty input produces no tool calls", () => {
  const result = extractFromChunks(["", "no tool calls here"], TOOLS);
  expect(result.length).toBe(0);
});

test("timeout parameter preserved in JSON", () => {
  const json = '{"tool_calls":[{"name":"bash","arguments":{"command":"find . -name *.ts","timeout":5000}}]}';
  const result = extractFromChunks([json], TOOLS);
  expect(result.length).toBe(1);
  expect(result[0].arguments).toEqual({ command: "find . -name *.ts", timeout: 5000 });
});
