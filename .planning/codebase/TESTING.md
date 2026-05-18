# TESTING.md — Testing Patterns & Practices

## 1. Current State

**No test framework is installed or configured.** There are no `*.test.ts`, `*.spec.ts`, or test suite files anywhere in the project. The `package.json` has no `"test"` script and no test-related dependencies (`jest`, `vitest`, `mocha`, `ava`, `tap`, etc.).

Testing is performed indirectly through:
- Manual script execution (ad-hoc)
- Self-test entry in `src/web-api-client.ts`
- A standalone capture utility at project root

## 2. Existing Test-Like Artifacts

### 2.1 `src/web-api-client.ts` self-test (line 850-870)
```ts
const isMainModule = process.argv[1]?.endsWith("web-api-client.ts");
if (isMainModule) {
  const result = await loadAuth();
  console.log(`token: ${result.token ? result.token.slice(0, 20) + "..." : "none"}`);
  console.log(`cookieCount: ${result.cookieHeader ? result.cookieHeader.split(";").length : 0}`);

  if (!result.token) {
    console.error("No auth token available...");
    process.exit(1);
  }

  const solver = new DeepSeekPoWSolver();
  await solver.init();
  console.log("powSolver: ready");

  const sessionId = await createSession(result.token, result.cookieHeader, "default");
  console.log(`sessionId: ${sessionId}`);
  process.exit(0);
}
```

**Run with**: `bun run src/web-api-client.ts` or `npm run test-auth`

**Tests**: auth loading, PoW solver init, session creation

### 2.2 `capture-raw.ts` — standalone test/utility script (root, 140 lines)
**Run with**: `bun run capture-raw.ts`

**Purpose**: Captures raw V4 API SSE output across 7 model configurations to validate tool call extraction. Tests each combination of model type (`expert`, `default`) and thinking mode (`true`, `false`) against all 5 tool types:
- `bash` tool with expert/no-think, default/no-think, expert/think
- `read` tool (expert/no-think)
- `write` tool (expert/no-think)
- `grep` tool (expert/no-think)
- `edit` tool (expert/no-think)

**Pattern** (`capture-raw.ts:16-24`):
```ts
const tests = [
  { prompt: "List files using bash tool.", modelType: "expert", thinking: false, label: "expert-no-think" },
  { prompt: "List files using bash tool.", modelType: "default", thinking: false, label: "default-no-think" },
  // ... 5 more
];
```

**What it captures**:
- Raw SSE data lines saved to `/tmp/capture_<label>.txt`
- Accumulated thinking content length
- Accumulated response content (first 300 chars)
- Extracted tool calls via `extractToolCalls()`
- Stripped clean text (first 200 chars)

## 3. How Tests are Currently Run

| "Test" | Command | Files Tested |
|--------|---------|-------------|
| Auth + session | `bun run src/web-api-client.ts` | `web-api-client.ts` (loadAuth, createSession, DeepSeekPoWSolver) |
| V4 API capture | `bun run capture-raw.ts` | `web-api-client.ts`, `tool-registry.ts` (extractToolCalls, stripToolCalls) |
| Agent loop | `bun run src/agent.ts` | full stack (manual test) |
| REPL | `bun run src/agent-repl.ts` | full stack (manual interactive test) |

## 4. Recommended Test Framework for Future Tests

Based on the tech stack (Bun runtime, TypeScript ES2022+):

- **Primary choice**: Bun's built-in test runner (`bun test`) — zero config, Jest-compatible API, native TypeScript support, fast. Replaces the need for Jest/vitest.
- **Alternative**: Vitest (if Node.js/tsx compatibility needed)

### Bun test example (for future use):
```ts
// example: src/__tests__/context.test.ts
import { describe, expect, test } from "bun:test";
import { estimateTokens, truncateMessage, detectRepeatedCalls } from "../context.js";

describe("context utilities", () => {
  test("estimateTokens returns ceil(length/4)", () => {
    expect(estimateTokens("hello")).toBe(2);
  });

  test("truncateMessage keeps head and tail", () => {
    const result = truncateMessage("a".repeat(100), 20);
    expect(result.length).toBeLessThan(100);
    expect(result).toContain("[...");
  });

  test("detectRepeatedCalls warns at 3+ repeats", () => {
    const history = [
      { name: "bash", arguments: { command: "ls" } },
      { name: "bash", arguments: { command: "ls" } },
    ];
    const current = [{ name: "bash", arguments: { command: "ls" } }];
    const warnings = detectRepeatedCalls(current, history);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Repeated tool call");
  });
});
```

Run with: `bun test`

## 5. Component Testability Assessment

| Module | Testability | Key Testing Challenge |
|--------|-------------|----------------------|
| `src/context.ts` | **High** | Pure functions, no dependencies. Ideal unit test candidates: `estimateTokens`, `truncateMessage`, `truncateFileContent`, `detectRepeatedCalls`, `compactHistory`, `checkTurnLimit`, `fingerprintToolCall` |
| `src/context-compact.ts` | **High** | Pure functions, one dependency `pi-agent-core` types. Candidates: `compactText`, `compactMessages`, `summarizeToolOutput` |
| `src/types.ts` | **N/A** | Type definitions only |
| `src/tools.ts` | **Medium** | IO-bound (readFile, exec). Requires mocking `fs` and `child_process`. Pure logic: `toolDefs` schema |
| `src/tool-registry.ts` | **Medium** | IO-bound (Bun APIs). `extractToolCalls` and `stripToolCalls` are pure functions — excellent unit test candidates with the 8 parsing strategies. Tool execution requires mocking Bun file I/O |
| `src/web-api-client.ts` | **Low** | Heavy network dependencies (DeepSeek API, FlareSolverr, WASM PoW). `parseSseLine` and `parseSseStream` are pure (SSE parsing) — excellent unit test candidates. Auth, sessions, WAF refresh require integration test setup |
| `src/agent-loop.ts` | **Low** | Orchestrates everything. Best tested via integration. The `buildPrompt` function is pure and testable |
| `src/agent-repl.ts` | **Low** | Interactive, stateful. `buildPromptText`, `printHelp`, `printBanner`, `processLine` (command parsing) are testable slices |
| `src/deepseek-native-stream.ts` | **Low** | Stream bridge. Event emission pattern hard to unit test |
| `src/index.ts` | **Low** | Entry point wiring |
| `capture-raw.ts` | **N/A** | Test script itself, not source |

## 6. Mocking Strategy

If adding tests, follow these patterns consistent with the codebase:

### 6.1 For pure functions (context.ts, parseSseLine in web-api-client.ts)
No mocking needed — these are deterministic pure functions.

### 6.2 For Bun I/O (tool-registry.ts)
Bun's test runner supports `mock`:
```ts
import { mock, spyOn } from "bun:test";

// Mock Bun.file
const mockFile = { exists: () => true, text: () => "hello\nworld" };
spyOn(Bun, "file").mockReturnValue(mockFile as any);
```

### 6.3 For network calls (web-api-client.ts)
Mock `fetch` at the global level:
```ts
globalThis.fetch = mock(async (url, opts) => {
  return new Response(JSON.stringify({ data: { biz_data: { chat_session: { id: "test-session" } } } }));
});
```

### 6.4 For tool execution results
The `ToolResult { content: string; isError: boolean }` interface (`tool-registry.ts:5-8`) is designed to be deterministic and serializable — perfect for assertions.

## 7. Key Functions for Unit Testing (Highest Priority)

These pure functions have no side effects and should be tested first:

| Function | File | Line | Description |
|----------|------|------|-------------|
| `estimateTokens(text)` | `src/context.ts` | 58 | Token estimation (len/4) |
| `truncateFileContent(text, max)` | `src/context.ts` | 44 | Head 60% + tail 30% truncation |
| `truncateMessage(text, max)` | `src/context.ts` | 51 | Same pattern for messages |
| `compactHistory(messages, budget)` | `src/context.ts` | 62 | Budget-aware message dropping |
| `detectRepeatedCalls(current, history)` | `src/context.ts` | 24 | Tool call duplicate detection |
| `checkTurnLimit(round, maxRounds)` | `src/context.ts` | 92 | Turn limit gate |
| `fingerprintToolCall(name, args)` | `src/context.ts` | 20 | Creates call fingerprint |
| `extractToolCalls(text)` | `src/tool-registry.ts` | 162 | All 8 extraction strategies |
| `stripToolCalls(text)` | `src/tool-registry.ts` | 402 | Clean text from tool call markup |
| `parseSseLine(dataStr, state)` | `src/web-api-client.ts` | 637 | SSE event parsing |
| `parseSseStream(body)` | `src/web-api-client.ts` | 761 | SSE stream parser |
| `buildPrompt(system, messages)` | `src/agent-loop.ts` | 52 | Tagged section prompt building |
| `compactText(text)` | `src/context-compact.ts` | 5 | Text truncation with head/middle/tail |
| `compactMessages(messages)` | `src/context-compact.ts` | 12 | Last-8 + truncation |
| `parseSessionCreateResponse(json)` | `src/web-api-client.ts` | 401 | Session ID extraction |

## 8. Test Data Patterns

### 8.1 SSE event test data
```ts
// Fragment setup event
const setupEvent = '{"v":{"response":{"fragments":[{"type":"TEXT","content":"Hello"}]}}}';

// Fragment append event
const appendEvent = '{"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":" world"}]}';

// Content append
const contentEvent = '{"p":"response/fragments/-1/content","o":"APPEND","v":"!"}';

// Done
const doneEvent = '{"response_message_id":12345,"v":"FINISHED"}';
```

### 8.2 Tool call extraction test data
```ts
// JSON format
const jsonCall = '{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}';

// XML direct format
const xmlCall = '<bash>{"command":"ls -la"}</bash>';

// function_calls format
const funcCall = '<function_calls><invoke name="read"><parameter name="path">package.json</parameter></invoke></function_calls>';

// DeepSeek V4 thinking mode
const v4ThinkingCall = '{"_calls":[{"name":"bash","arguments":{"command":"ls"}}]}';
```

## 9. Integration Testing Strategy

The codebase's primary value is as a DeepSeek API client. Integration tests require:
1. A valid `DEEPSEEK_TOKEN` (set via env var or auth files at `.pi/agent/`)
2. Optional: FlareSolverr running at `http://127.0.0.1:8191` (for WAF refresh tests)
3. `sha3_wasm_bg.wasm` at project root (for PoW)

Integration tests would cover:
- `loadAuth` → token resolution chain
- `createSession` → new session creation
- `chatStream` → SSE streaming end-to-end
- `chatStreamParsed` → full round trip
- `runAgentLoop` → multi-turn agent loop (requires tool execution)
- `DeepSeekPoWSolver.solveChallenge` → PoW challenge solving

The existing `capture-raw.ts` script is the closest thing to an integration test — it validates auth, session creation, streaming, and tool call extraction end-to-end across multiple model configurations.

## 10. Adding Tests — Quick Start

```bash
# 1. Bun's test runner is built-in, no install needed
# 2. Create test file:
cat > src/context.test.ts << 'EOF'
import { describe, expect, test } from "bun:test";
import { estimateTokens } from "./context.js";

describe("estimateTokens", () => {
  test("empty string", () => expect(estimateTokens("")).toBe(0));
  test("4 chars = 1 token", () => expect(estimateTokens("abcd")).toBe(1));
  test("5 chars = 2 tokens", () => expect(estimateTokens("abcde")).toBe(2));
});
EOF

# 3. Run:
bun test
```

No `package.json` changes needed — Bun auto-discovers `*.test.ts` files.
