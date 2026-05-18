# Architecture

## Pattern

**Tool-using agent loop** consuming DeepSeek V4 chat API via SSE streaming. The agent sends prompts, receives streaming text + tool calls, executes tools locally, and feeds results back in a multi-turn loop. Two parallel implementations exist: one using the Pi Agent Core framework (`src/index.ts`) and one custom (`src/agent-loop.ts` / `src/agent-repl.ts`).

## Layers

### 1. Transport Layer — `src/web-api-client.ts` (870 lines)
HTTP client for `https://chat.deepseek.com`. Responsibilities:
- **Auth loading**: Token from `DEEPSEEK_TOKEN` env → `.pi/agent/deepseek_token.txt` → `.pi/agent/deepseek_auth.json` (Chrome localStorage export)
- **WAF management**: FlareSolverr-based `aws-waf-token` refresh on 403 (`refreshWafToken`, `withWafRetry`)
- **Proof-of-Work**: WASM-based PoW solver (`DeepSeekPoWSolver`) using `sha3_wasm_bg.wasm`, `DeepSeekHashV1` algorithm
- **Session management**: Create session, ensure session, persist auth state
- **SSE streaming**: DeepSeek V4 SSE parser (`parseSseLine`, `parseSseStream`) handling fragment setup/append, content vs thinking routing, `[DONE]`/`FINISHED` signals
- **Retry**: Exponential backoff via `withRetry` (skips retry for `StaleAuthError`, `WafTokenExpiredError`)

### 2. Agent Loop Layer — `src/agent-loop.ts` (216 lines) + `src/agent-repl.ts` (433 lines)
Orchestrates the prompt→execute→feed-back loop:
- Builds prompt from system instructions + message history (`buildPrompt`)
- Sends to DeepSeek API via `chatStreamParsed` with retry
- Extracts tool calls from streaming text via 8+ extraction strategies
- Executes tools, truncates results, appends to message history
- Detects repeated tool calls (infinite loop guard)
- Compacts context when token threshold exceeded (16K tokens, 80% threshold)
- REPL adds interactive mode with `/help`, `/model`, `/thinking`, `/clear`, `/new`, etc.

### 3. Tool Registry Layer — `src/tool-registry.ts` (486 lines)
Tool definitions + extraction logic:
- **5 tools**: `read`, `write`, `grep`, `bash`, `edit` — Bun-powered implementations
- **Multi-strategy tool call extractor** (`extractToolCalls`): 8+ strategies for parsing model output — direct XML tags (`<bash>{...}</bash>`), `<favorite><tool_calls>` wrapper, `<|tool_calls|` custom marker, `{"tool_calls":[...]}` JSON, `{"_calls":[...]}` (DeepSeek V4 thinking mode), code block JSON, `<function_calls>` XML, `<tool_calls>` with invoke/JSON
- **Stripper** (`stripToolCalls`): Removes tool call markup from text for clean assistant messages

### 4. Context Management Layer — `src/context.ts` (97 lines) + `src/context-compact.ts` (32 lines)
- `estimateTokens`: `text.length / 4`
- `truncateFileContent`/`truncateMessage`: head 60% + tail 30%
- `compactHistory`: budget-aware message dropping (system preserved)
- `detectRepeatedCalls`: fingerprint-based duplicate detection
- `compactMessages` (Pi AI bridge): caps to last 8 messages, truncates tool results to 4K chars

### 5. Pi AI Bridge Layer — `src/deepseek-native-stream.ts` (128 lines)
Bridges DeepSeek SSE events to Pi AI's `StreamFn` interface:
- `createDeepSeekNativeStream` returns a `StreamFn` that converts `content`/`done`/`error` events to Pi AI event stream (`text_delta`, `text_end`, `done`, `error`)
- Used by `src/index.ts` via `@mariozechner/pi-agent-core` `Agent` class

### 6. Tools (Pi AI Format) — `src/tools.ts` (53 lines)
Second tool system for the Pi AI code path:
- Only 2 tools: `read`, `bash` (no write/grep/edit)
- Uses Pi AI `Type.Object` schema for parameter definitions
- Uses Node.js `child_process.exec` + `fs.readFile` (not Bun)

### 7. Types — `src/types.ts` (13 lines)
- `NativeStreamEvent`: content_delta, thinking_delta, done, error
- `HarnessState`: chatSessionId, parentMessageId, memorySummary, authToken, cookieHeader

## Data Flow

```
User Prompt
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  buildPrompt(system + message history)                          │
│  → Prepends [System], [User], [Assistant], [Tool:name] sections │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  chatStreamParsed → DeepSeek API POST /api/v0/chat/completion   │
│  Headers: Authorization, Cookie, x-ds-pow-response              │
│  Body: { chat_session_id, prompt, model_type, thinking_enabled }│
└─────────────────────────────────────────────────────────────────┘
    │
    ▼  (SSE stream)
┌─────────────────────────────────────────────────────────────────┐
│  parseSseStream → parseSseLine                                  │
│  Events: content delta, thinking delta, done (with message ID)  │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Accumulate fullText from content deltas                        │
│  extractToolCalls(fullText) → [ToolCall] or null                │
│  stripToolCalls(fullText) → clean assistant text                │
└─────────────────────────────────────────────────────────────────┘
    │
    ├── no tool calls → print output, return
    │
    └── tool calls found →
            ▼
    ┌─────────────────────────────────────────────────────────┐
    │  detectRepeatedCalls → guard against infinite loops     │
    │  For each tool call:                                    │
    │    executeTool(name, args) → ToolResult                 │
    │    Append { role: "tool", name, content } to history    │
    └─────────────────────────────────────────────────────────┘
            │
            ▼
    Loop to top (max 25 rounds)
```

## Entry Points

| File | Command | Purpose |
|------|---------|---------|
| `src/index.ts` | `bun run src/index.ts -- <prompt>` | Pi Agent Core integration |
| `src/agent.ts` | `bun run src/agent.ts [options] '<prompt>'` | CLI agent with flags |
| `src/agent-repl.ts` | `bun run src/agent-repl.ts` | Interactive REPL |
| `src/agent-native.ts` | `npx tsx src/agent-native.ts '<prompt>'` | Minimal agent loop |
| `capture-raw.ts` | `bun run capture-raw.ts` | V4 API format capture/testing |

## Key Design Decisions

1. **Two tool systems**: The Pi Agent Core path (`src/index.ts` + `src/tools.ts`) uses the framework's Tool schema with only 2 tools. The custom path (`src/agent-loop.ts` + `src/tool-registry.ts`) has 5 tools with a sophisticated multi-strategy call extractor.

2. **8+ extraction strategies**: Because DeepSeek V4 varies its tool call format across model types (expert vs default) and modes (thinking vs non-thinking), the extractor tries multiple strategies in sequence.

3. **FlareSolverr dependency**: DeepSeek uses AWS WAF (`aws-waf-token` cookie). When it expires (403), `refreshWafToken` calls a local FlareSolverr instance to solve the challenge and get fresh cookies.

4. **PoW WASM**: DeepSeek V4 requires Proof-of-Work for `/api/v0/chat/completion`. The `DeepSeekPoWSolver` uses a precompiled WASM blob (`sha3_wasm_bg.wasm`) implementing `DeepSeekHashV1`.

5. **Manual prompt formatting**: The prompt is formatted as tagged sections (`[System]`, `[User]`, `[Assistant]`, `[Tool:name]`) rather than standard chat templates.

## Error Handling

- `StaleAuthError` (401): Token expired — reload auth from disk
- `WafTokenExpiredError` (403): WAF token expired — refresh via FlareSolverr
- `RetryableError`: Transient API failures — exponential backoff, 3 retries
- Infinite loop guard: 3+ repeated tool calls with same fingerprint breaks the loop
- Context pressure: Compaction at 80% of 16K tokens, max 25 rounds
