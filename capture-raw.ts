#!/usr/bin/env bun
// V4 API format capture and tool call extraction test
import { loadAuth, createSession, chatStream, DeepSeekPoWSolver } from "./src/web-api-client.js";
import { extractToolCalls, stripToolCalls } from "./src/tool-registry.js";

const auth = await loadAuth();
if (!auth.token) {
  console.error("No auth token found");
  process.exit(1);
}

const solver = new DeepSeekPoWSolver();
await solver.init();

// V4 valid model types: default, expert, vision (NOT coder)
const tests = [
  { prompt: "List files using bash tool.", modelType: "expert", thinking: false, label: "expert-no-think" },
  { prompt: "List files using bash tool.", modelType: "default", thinking: false, label: "default-no-think" },
  { prompt: "List files using bash tool.", modelType: "expert", thinking: true, label: "expert-think" },
  { prompt: "Read package.json using read tool.", modelType: "expert", thinking: false, label: "read-tool" },
  { prompt: "Write 'hello' to test.txt using write tool.", modelType: "expert", thinking: false, label: "write-tool" },
  { prompt: "Search for 'function' in src using grep tool.", modelType: "expert", thinking: false, label: "grep-tool" },
  { prompt: "Edit file.txt replacing 'old' with 'new' using edit tool.", modelType: "expert", thinking: false, label: "edit-tool" },
];

for (const test of tests) {
  console.log(`\n=== Testing: ${test.label} ===`);
  
  const sessionId = await createSession(auth.token, auth.cookieHeader, test.modelType);
  
  const resp = await chatStream(
    {
      sessionId,
      prompt: `[System]
You are a coding assistant with access to local tools.

**Current directory:** /root/deepseek-full-api/pi-harness

**Tools:**
- bash: Run a shell command. Args: command (required). 120s timeout.
- read: Read a file. Args: path (required), offset (number, optional), limit (number, optional)
- write: Write a file. Creates dirs. Args: path (required), content (required)
- edit: Find/replace in a file. Args: path (required), old_string (required), new_string (required)
- grep: Search files with ripgrep. Args: pattern (required), path (string, optional), include (string, optional)

**ONLY use this JSON format for tool calls:**
{"tool_calls":[{"name":"bash","arguments":{"command":"ls -la"}}]}
{"tool_calls":[{"name":"read","arguments":{"path":"package.json"}}]}

Tool results appear automatically after execution.

[User]
${test.prompt}`,
      parentMessageId: null,
      modelType: test.modelType,
      thinkingEnabled: test.thinking,
    },
    { authToken: auth.token, cookieHeader: auth.cookieHeader, powSolver: solver },
  );

  if (!resp.body) {
    console.error("No response body");
    continue;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullRaw = "";
  let thinkingContent = "";
  let responseContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event: ")) continue;
      if (!trimmed.startsWith("data: ")) continue;

      const dataStr = trimmed.slice(6);
      fullRaw += dataStr + "\n";

      if (dataStr === "[DONE]") continue;

      try {
        const parsed = JSON.parse(dataStr);
        
        // Track thinking content
        if (parsed.p?.endsWith("/thinking") && parsed.o === "APPEND") {
          thinkingContent += parsed.v;
        }
        
        // Track response content (simple v deltas)
        if (parsed.v && typeof parsed.v === "string" && !parsed.p) {
          responseContent += parsed.v;
        }
        
        // Track fragment content via APPEND
        if (parsed.p?.includes("fragments") && parsed.o === "APPEND") {
          responseContent += parsed.v;
        }
        
        // Track initial fragment setup (SET operation)
        if (parsed.v?.response?.fragments) {
          for (const frag of parsed.v.response.fragments) {
            if (frag.content) {
              responseContent += frag.content;
            }
          }
        }
      } catch {
        // Not JSON, skip
      }
    }
  }

  console.log(`[Thinking length: ${thinkingContent.length}]`);
  console.log(`[Response content length: ${responseContent.length}]`);
  console.log(`[Response content: ${responseContent.slice(0, 300)}]`);
  
  // Test extraction
  const toolCalls = extractToolCalls(responseContent);
  console.log(`[Extracted tool calls: ${toolCalls ? JSON.stringify(toolCalls) : "null"}]`);
  
  const cleaned = stripToolCalls(responseContent);
  console.log(`[Cleaned text length: ${cleaned.length}]`);
  console.log(`[Cleaned text: ${cleaned.slice(0, 200)}]`);
  
  // Save full raw output
  await Bun.write(`/tmp/capture_${test.label}.txt`, fullRaw);
  console.log(`[Saved to /tmp/capture_${test.label}.txt]`);
}

console.log("\n=== Capture complete ===");
