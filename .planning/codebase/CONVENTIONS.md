# CONVENTIONS.md — Coding Conventions & Patterns

## 1. Language & Runtime

- **TypeScript** with `target: "ES2022"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"` (`tsconfig.json:3-5`)
- **Bun** primary runtime (detected via `bun.lock`, `#!/usr/bin/env bun` shebangs). Node.js/tsx secondary (`#!/usr/bin/env tsx` in `src/agent-native.ts:1`)
- **ESM only** (`"type": "module"` in `package.json:4`)
- No test framework, no test runner configured

## 2. File Naming

- **kebab-case** for all source files: `web-api-client.ts`, `tool-registry.ts`, `context-compact.ts`, `agent-loop.ts`, `deepseek-native-stream.ts`
- One exception: `capture-raw.ts` at project root (test script, not in `src/`)
- All source files live under `src/` except root-level `capture-raw.ts` and `sha3_wasm_bg.wasm`

## 3. Module Import Style

- All local imports use explicit `.js` extensions per NodeNext resolution:
  ```ts
  import { runAgentLoop } from "./agent-loop.js";  // src/agent.ts:2
  import { executeTool, toolDefs } from "./tools.js"; // src/index.ts:6
  ```
- Node built-ins use `node:*` namespace:
  ```ts
  import { readFile, writeFile, mkdir, access } from "node:fs/promises";  // web-api-client.ts:1
  import path from "node:path";                                           // web-api-client.ts:2
  import * as readline from "node:readline";                              // agent-repl.ts:2
  import { exec } from "node:child_process";                              // tools.ts:1
  import { promisify } from "node:util";                                  // tools.ts:2
  ```
- Third-party imports use bare specifiers:
  ```ts
  import { Agent } from "@mariozechner/pi-agent-core";                    // index.ts:1
  import { getModel } from "@mariozechner/pi-ai";                         // index.ts:3
  ```
- Bun-specific imports used only in `tool-registry.ts`:
  ```ts
  import { $, type BunFile } from "bun";                                  // tool-registry.ts:1
  ```
- Import type with `type` keyword for type-only imports:
  ```ts
  import type { AgentTool } from "@mariozechner/pi-agent-core";           // index.ts:2
  import type { HarnessState } from "./types.js";                        // agent-loop.ts:2
  import type { AgentMessage } from "@mariozechner/pi-agent-core";        // context-compact.ts:1
  ```
- One bare path traversal import (avoid this pattern):
  ```ts
  import { createAssistantMessageEventStream } from "../node_modules/@mariozechner/pi-ai/dist/utils/event-stream.js";  // deepseek-native-stream.ts:2
  ```

## 4. Naming Conventions

| Construct | Convention | Examples |
|-----------|-----------|----------|
| Functions | `camelCase` | `runAgentLoop`, `extractToolCalls`, `compactHistory`, `loadAuth`, `createSession`, `parseSseLine` |
| Variables | `camelCase` | `fullText`, `lineBuf`, `toolCalls`, `cleanText`, `responseMessageId` |
| Classes | `PascalCase` | `DeepSeekPoWSolver`, `StaleAuthError`, `WafTokenExpiredError`, `RetryableError` |
| Interfaces | `PascalCase` | `HarnessState`, `NativeStreamEvent`, `ToolResult`, `ToolDef`, `ToolCallFingerprint`, `AuthResult`, `ChatStreamOptions` |
| Types | `PascalCase` | `ToolCall`, `DeepSeekSseEvent`, `SseParseState`, `FlareSolverrCookie`, `PowChallenge` |
| Constants | `UPPER_SNAKE_CASE` | `MAX_FILE_CHARS`, `MAX_MESSAGE_CHARS`, `MAX_TURNS`, `COMPACTION_THRESHOLD` (`context.ts:1-4`), `MAX_CONTEXT_TOKENS` (`agent-loop.ts:71`), `DEEPSEEK_URL` (`web-api-client.ts:4`) |
| File names | `kebab-case` | `web-api-client.ts`, `tool-registry.ts`, `agent-loop.ts` |
| JSON API fields | `snake_case` | `chat_session_id`, `parent_message_id`, `model_type`, `thinking_enabled`, `response_message_id` (`web-api-client.ts:568-580`) |

## 5. TypeScript Patterns

### 5.1 Type definitions in dedicated file
Shared types live in `src/types.ts:1-13`:
```ts
export type NativeStreamEvent =
  | { type: "content_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "done"; response_message_id: number | null }
  | { type: "error"; error: string };

export interface HarnessState {
  chatSessionId: string | null;
  parentMessageId: number | null;
  memorySummary: string;
  authToken: string | null;
  cookieHeader: string | null;
}
```

### 5.2 Interfaces defined at point of use
Interfaces are co-located with their consuming module rather than centralized:
- `ToolResult`, `ToolDef`, `ToolCall` in `src/tool-registry.ts:5-14,157-160`
- `AgentLoopOptions` in `src/agent-loop.ts:9-16`
- `ConversationState` in `src/agent-repl.ts:8-15`
- `ChatStreamOptions`, `AuthResult`, `LoadAuthOptions` in `src/web-api-client.ts:51-69`
- `SseParseState` in `src/web-api-client.ts:632-635`

### 5.3 Type unions for discriminated events
```ts
export type DeepSeekSseEvent =                    // web-api-client.ts:624-628
  | { type: "content"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "done"; responseMessageId: number | null }
  | { type: "error" };
```

### 5.4 Function signatures with explicit return types
Functions consistently annotate return types:
```ts
export function estimateTokens(text: string): number                    // context.ts:58
export function truncateMessage(text: string, max = MAX_MESSAGE_CHARS): string  // context.ts:51
export function fingerprintToolCall(name: string, args: Record<string, unknown>): ToolCallFingerprint  // context.ts:20
export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult>    // tool-registry.ts:143
```

### 5.5 Optional parameters with defaults
```ts
export function truncateFileContent(text: string, max = MAX_FILE_CHARS): string    // context.ts:44
export function truncateMessage(text: string, max = MAX_MESSAGE_CHARS): string     // context.ts:51
export function checkTurnLimit(round: number, maxRounds = MAX_TURNS): string | null  // context.ts:92
```

### 5.6 Generic types not used in source code
The codebase is not type-heavy beyond interfaces/unions. No generic type parameters appear outside of third-party type imports.

### 5.7 `Record<string, unknown>` for dynamic arguments
```ts
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult>                                                             // tool-registry.ts:143-146
```

### 5.8 `as any` type assertions in Pi AI bridge layer
Used sparingly where Pi AI's generic types are difficult to satisfy:
```ts
stream.push({ type: "text_start", contentIndex: 0, partial: assistant } as any);   // deepseek-native-stream.ts:91
```

## 6. Error Handling Patterns

### 6.1 Custom error classes
Three custom error classes in `src/web-api-client.ts:6-49`:
```ts
export class RetryableError extends Error {          // Transient failures
  constructor(message?: string) {
    super(message ?? "Retryable error");
    this.name = "RetryableError";
  }
}

export class StaleAuthError extends Error {}         // Auth token expired (401)
export class WafTokenExpiredError extends Error {}   // WAF token expired (403)
```
Pattern: `extends Error`, `this.name = "ClassName"`, optional default message.

### 6.2 Retry with exponential backoff — `withRetry`
`src/web-api-client.ts:13-35`:
- Default: 3 retries, 1s base delay, doubles each attempt
- Skips retry for `StaleAuthError` and `WafTokenExpiredError` (non-retryable)
- Callback `onRetry(attempt, err)` for logging

### 6.3 Tool execution errors
Two patterns for tool error handling (both in `tool-registry.ts`):
- **Try/catch returning `{ content, isError: true }`** — never throws:
  ```ts
  async execute(args) {
    try {
      // ...
      return { content: stdout.trim() || "(no output)", isError: false };
    } catch (e: unknown) {
      return { content: `grep error: ${(e as Error).message}`, isError: true };
    }
  }
  ```
- **Early return for invalid states**:
  ```ts
  if (!exists) return { content: `Error: File not found: ${fp}`, isError: true };
  ```

### 6.4 Guard pattern — `detectRepeatedCalls`
`src/context.ts:24-42` — fingerprints tool calls by name + partial args hash, warns at 3+ repeats. Loop breaker in `agent-loop.ts:176-186`.

### 6.5 Context compaction guard
`src/agent-loop.ts:114-126` — when `estimateTokens(promptText) > MAX_CONTEXT_TOKENS * COMPACTION_THRESHOLD` (16K * 0.8 = 12.8K), truncates history.

### 6.6 REPL-specific error handling
`src/agent-repl.ts:343-354` — classifies errors by message content:
```ts
if (msg.includes("Authentication") || msg.includes("auth")) { ... }
else if (msg.includes("WAF") || msg.includes("403")) { ... }
else { ... }
```

## 7. Async Patterns

### 7.1 Top-level await
Used in entry point files run directly:
```ts
await runAgentLoop({ prompt, thinkingEnabled, modelType, maxRounds });  // agent.ts:31
await agent.prompt(prompt);                                            // index.ts:54
```

### 7.2 Async generators for streaming
```ts
export async function* parseSseStream(                                   // web-api-client.ts:761
  body: ReadableStream<Uint8Array>
): AsyncGenerator<DeepSeekSseEvent> { ... }
```

### 7.3 IIAFE (Immediately Invoked Async Function Expression)
Used inside `StreamFn` in `deepseek-native-stream.ts:69`:
```ts
void (async () => {
  // ... async stream setup
})();
```

### 7.4 `withRetry` pattern for API calls
```ts
await withRetry(
  () => chatStreamParsed(...),
  { maxRetries: 3, baseDelayMs: 1000, onRetry: ... },
);
```

## 8. Module Structure

### 8.1 Module responsibilities

| Module | Responsibility | Lines | Deps |
|--------|---------------|-------|------|
| `src/web-api-client.ts` | HTTP transport, auth, SSE parsing, PoW | 870 | node:fs/promises, node:path |
| `src/tool-registry.ts` | 5 tool defs + 8-strategy call extractor | 487 | bun, node:path, context.ts |
| `src/agent-repl.ts` | Interactive REPL with command system | 434 | web-api-client, tool-registry, context |
| `src/agent-loop.ts` | Core tool-calling loop orchestration | 216 | web-api-client, tool-registry, context |
| `src/deepseek-native-stream.ts` | Pi AI stream bridge | 128 | pi-ai, pi-agent-core, web-api-client |
| `src/context.ts` | Token estimation, compaction, truncation | 97 | (none) |
| `src/index.ts` | Pi Agent Core entry | 55 | pi-agent-core, pi-ai |
| `src/tools.ts` | Pi AI format tool defs (read, bash only) | 53 | pi-ai, node:child_process, context-compact |
| `src/context-compact.ts` | Pi AI context compaction | 32 | pi-agent-core |
| `src/agent.ts` | CLI argument parser | 31 | agent-loop |
| `src/types.ts` | Shared type definitions | 13 | (none) |
| `src/agent-native.ts` | Minimal entry wrapper | 10 | agent-loop |

### 8.2 Two parallel tool systems
- **`src/tool-registry.ts`** — 5 tools (read, write, grep, bash, edit), Bun-powered, 8-strategy extraction, custom loop
- **`src/tools.ts`** — 2 tools (read, bash only), Pi AI `Type.Object` schema, Node.js `child_process.exec`, Pi Agent Core path

### 8.3 Two parallel context systems
- **`src/context.ts`** — `estimateTokens` (len/4), `truncateFileContent` (60/30 split), `compactHistory` (budget-aware), `detectRepeatedCalls`
- **`src/context-compact.ts`** — `compactMessages` (last 8, truncate tool results to 4K), Pi AI `AgentMessage` format

### 8.4 Entry points

| File | Shebang | Usage |
|------|---------|-------|
| `src/agent.ts` | `#!/usr/bin/env bun` | CLI with `--thinking`, `--model`, `--max-rounds` flags |
| `src/agent-native.ts` | `#!/usr/bin/env tsx` | Minimal entry, plain prompt arg |
| `src/agent-repl.ts` | `#!/usr/bin/env bun` | Interactive REPL, command system |
| `capture-raw.ts` | `#!/usr/bin/env bun` | Test script — captures V4 API output |

### 8.5 Self-test pattern in `web-api-client.ts`
```ts
const isMainModule = process.argv[1]?.endsWith("web-api-client.ts");  // line 850
if (isMainModule) {
  // runs auth test + session creation when executed directly
  // package.json script: "test-auth": "bun run src/web-api-client.ts"
}
```

## 9. Export Style

- Named exports exclusively (no `export default`)
- Classes, functions, constants, and types all exported with `export` keyword at declaration site
- Internal helper functions are module-private (no export), e.g. `hashArgs` (`context.ts:11`), `buildBaseHeaders` (`web-api-client.ts:380`), `baseAssistant` (`deepseek-native-stream.ts:46`)

## 10. String Formatting

### 10.1 Prompt building with tagged sections
```ts
// agent-loop.ts:52-69
function buildPrompt(system: string, messages: Array<...>): string {
  const parts: string[] = [];
  parts.push(`[System]\n${system}`);
  for (const msg of messages) {
    if (msg.role === "user") parts.push(`[User]\n${msg.content}`);
    else if (msg.role === "assistant") parts.push(`[Assistant]\n${msg.content}`);
    else if (msg.role === "tool") parts.push(`[Tool:${msg.name}]\n${msg.content}`);
  }
  return parts.join("\n\n");
}
```

### 10.2 REPL output styling with ANSI codes
```ts
process.stdout.write(`\x1b[1m╔══════════════════╗\x1b[0m\n`);  // agent-repl.ts:66
process.stdout.write(`\x1b[33m[Context large...]\x1b[0m`);      // agent-repl.ts:107
process.stdout.write(`\x1b[90m[API] Sending...\x1b[0m`);        // agent-repl.ts:112
```
Color codes: `\x1b[31m`=red, `\x1b[32m`=green, `\x1b[33m`=yellow, `\x1b[36m`=cyan, `\x1b[90m`=gray, `\x1b[1m`=bold, `\x1b[0m`=reset.

## 11. Configuration Pattern

- **Environment variables** for runtime config: `DEEPSEEK_TOKEN`, `DEEPSEEK_TOKEN_STATE`, `DEEPSEEK_AUTH_STATE`, `FLARESOLVERR_URL`
- **Constants** at module level for fixed values: `MAX_FILE_CHARS = 8_000`, `MAX_MESSAGE_CHARS = 6_000`, `MAX_TURNS = 25`, `COMPACTION_THRESHOLD = 0.8`, `MAX_CONTEXT_TOKENS = 16_000`
- **Underscore numeric separators**: `8_000`, `6_000`, `16_000` (TypeScript ES2022+ feature)
- **No `.env` file or config loader** — env vars read via `process.env.X`

## 12. Logging / Output Convention

- **User-facing output**: `process.stdout.write()`
- **Diagnostic output**: `process.stderr.write()` or `onErr`/`onStderr` callback parameter
- **Error messages**: `console.error()` or `process.stderr.write()`
- No structured logging library; plain string formatting only
