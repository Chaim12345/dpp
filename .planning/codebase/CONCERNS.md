# CONCERNS — Technical Debt, Bugs, Security Issues & Risks

## Technical Debt

### 1. Two Parallel Tool Systems (Duplication)
`src/tools.ts` (53 lines, Pi AI format, 2 tools: read + bash) and `src/tool-registry.ts` (486 lines, custom, 5 tools: read + write + grep + bash + edit) are redundant implementations serving different entry points. The Pi AI path (`src/index.ts`) only has 2 tools and can't write/edit/grep files. This creates a confusing developer experience where capability depends on which entry point you use.
- **Files**: `src/tools.ts`, `src/tool-registry.ts`, `src/index.ts`, `src/agent-loop.ts`

### 2. Two Parallel Context Management Systems
`src/context.ts` (custom loop, 97 lines) and `src/context-compact.ts` (Pi AI bridge, 32 lines) duplicate similar truncation/compaction logic. The compact version only keeps last 8 messages, which can drop important context during long conversations.
- **Files**: `src/context.ts`, `src/context-compact.ts`

### 3. Stale Compiled Output in `dist/`
`dist/` and `dist/src/` contain compiled JavaScript from an earlier build that does not match current source code. `tsconfig.json` sets `rootDir: "src"` but `dist/src/` suggests a previous run with different config. No cleanup or rebuild script ensures freshness.
- **Files**: `dist/`, `dist/src/`

### 4. Dual Lockfiles (`bun.lock` + `package-lock.json`)
Both lockfiles present, allowing dependency resolution drift between Bun and npm installs. If one is updated without the other, builds become non-reproducible.

### 5. All Dependencies Use `"latest"` Version Specifier
`package.json:14-15,18-19` — `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@types/node`, `typescript` all use `"latest"`. This breaks reproducible builds. A `bun.lock` resolves versions but `bun install` with an updated registry could pull breaking changes.
- **File**: `package.json:13-19`

### 6. Bare Path Traversal Import
`src/deepseek-native-stream.ts:2` imports from `../node_modules/@mariozechner/pi-ai/dist/utils/event-stream.js` — a fragile path that bypasses the package resolution system and will break if the package restructures its internals.
- **File**: `src/deepseek-native-stream.ts:2`

### 7. No `.gitignore`
No `.gitignore` file exists. `dist/`, `node_modules/`, `.pi/agent/` (auth tokens!), `.claude/` are all vulnerable to accidental commit.

### 8. `process.cwd()` Evaluated at Module Load Time
`src/web-api-client.ts:84` — `DEFAULT_CWD = process.cwd()` is captured when the module is first imported, not when functions are called. Any code that `chdir`s before calling these functions will get the wrong working directory. Since the file is a single module, first import determines CWD.

## Bugs & Logic Issues

### 9. Context Compaction Destroys All History
`src/agent-loop.ts:117-125` — When compaction triggers, `messages.length = 0` wipes all history and only re-adds the original prompt + 5 recent messages. This loses system messages, tool results, and intermediate assistant turns. Compaction should use `compactHistory()` from `context.ts` instead of this ad-hoc reset.
- **File**: `src/agent-loop.ts:115-126`

### 10. Weak Token Estimation
`src/context.ts:59` — `estimateTokens` uses `Math.ceil(text.length / 4)`. This is inaccurate for code-heavy or non-English text. Over-estimation triggers premature compaction; under-estimation causes context overflows and silent truncation by the API.
- **File**: `src/context.ts:58-60`

### 11. `process.stdout.write("")` No-Op Hack
`src/agent-repl.ts:375` — `process.stderr.write("");` appears to flush stderr but is a no-op and does nothing meaningful. This is likely a debugging artifact.

### 12. Infinite Loop Detection Gap
`src/agent-repl.ts:175` — The REPL's `executeTurn` calls `detectRepeatedCalls(toolCalls, [])` with an always-empty history array instead of `toolCallHistory`. This means the infinite loop guard never works in the REPL. Compare with `src/agent-loop.ts:174` which correctly uses `toolCallHistory`.
- **File**: `src/agent-repl.ts:175`

### 13. `shouldExit` Flag Race in REPL
`src/agent-repl.ts:182-204` — The tool execution loop checks `shouldExit` at the start of each iteration but `shouldExit` is set asynchronously by the line processor. If a `/quit` command is issued during tool execution, it may not be honored until the current turn cycle completes (potentially 25 rounds).

### 14. Hardcoded WAF Timezone Offset
`src/web-api-client.ts:389` — `x-client-timezone-offset: "10800"` (UTC+3 / Moscow) is hardcoded. Users in other timezones may experience rate limiting or behavioral differences from the DeepSeek API.

### 15. FlareSolverr Session Window Mismatch
`src/web-api-client.ts:242` — `sessionWindowTtl: 7200` (2 hours) is sent to FlareSolverr, but AWS WAF tokens typically have much shorter lifetimes. The combination of long session TTL and no active refresh polling means WAF tokens can silently expire mid-session.

## Security Issues

### 16. Auth Files and Tokens in Working Directory
`.pi/agent/deepseek_token.txt` and `.pi/agent/deepseek_auth.json` contain raw authentication tokens and cookies. Without `.gitignore`, these could be accidentally committed. The `deepseek_auth.json` file includes parsed Chrome localStorage data with `userToken` entries.
- **Files**: `.pi/agent/deepseek_token.txt`, `.pi/agent/deepseek_auth.json`

### 17. Command Injection in Bash Tool
`src/tool-registry.ts:83` — `Bun.spawn([shellPath, "-c", cmd])` passes user-generated command strings directly to the shell without sanitization. While this is "by design" for a shell tool, the model could be tricked into generating malicious commands through prompt injection.
- **File**: `src/tool-registry.ts:81-83`

### 18. Path Traversal in Read/Write Tools
`src/tool-registry.ts:20` — `Bun.file(String(args.path))` accepts arbitrary paths. A prompt-injected instruction could read or write files outside the working directory (e.g., `../../etc/passwd`). No path normalization or sandboxing.
- **File**: `src/tool-registry.ts:17-37`

### 19. Large File Write DoS
`src/tool-registry.ts:45` — `Bun.write(fp, String(args.content))` has no size limit. A model could generate gigabytes of output, exhausting disk space.

### 20. No Timeout on `chatStream` HTTP Request
`src/web-api-client.ts:590-622` — The main chat completion `fetch` call passes `options.signal` for cancellation but there's no default timeout. A stalled API connection could hang indefinitely (only WAF retry has `AbortSignal.timeout(130_000)`).

## Performance Bottlenecks

### 21. Tool Call Extraction Scans Text 8+ Times
`src/tool-registry.ts:162-399` — `extractToolCalls` tries 8+ regex/matching strategies sequentially on the entire response text. Each strategy does its own regex pass. For long responses with many tool calls, this is O(n*m) where n = text length and m = strategy count. A combined single-pass parser would be much faster.

### 22. WASM PoW Solver Re-Init on Demand
`src/web-api-client.ts:327` — `if (!this.exports) await this.init()` in `solveChallenge` means the first call pays WASM instantiation cost (~100-500ms). Worse, if `init()` fails and `this.exports` is never set, every subsequent call also tries and fails to init. Should eagerly initialize in constructor.

### 23. File Content Read Entirely Into Memory
`src/tool-registry.ts:24` — `file.text()` reads entire files into memory, even when only a small portion with offset/limit is requested. For large files, this wastes memory. Should use `file.slice()` for range reads.
- **File**: `src/tool-registry.ts:24`

### 24. SSE Buffer Grows Without Bound
`src/web-api-client.ts:766` — `buffer` accumulates incomplete SSE lines during streaming. While typically small, there's no guard against runaway accumulation if a line contains many bytes without a newline.

### 25. Sequential Tool Execution
`src/agent-loop.ts:193-214` — Tool calls are executed sequentially with `for...of`. Independent tools (e.g., reading two separate files) could run in parallel for significant speedup.

## Fragile Areas

### 26. 8+ Tool Call Extraction Strategies Are Brittle
`src/tool-registry.ts:162-399` — Each strategy uses different regex patterns to match different model output formats (XML tags, JSON, function_calls, code blocks, custom markers). A small change in the model's output format could break all strategies. The fallback strategy (brace-counting) is especially fragile.
- **File**: `src/tool-registry.ts:162-399`

### 27. DeepSeek V4 SSE Protocol is Undocumented
`src/web-api-client.ts:630-758` — The entire SSE parser is reverse-engineered from DeepSeek's proprietary V4 streaming protocol. Any server-side change to the SSE format (field names, fragment structure, completion signals) will break the parser silently or with confusing errors.

### 28. Error Classification by String Matching
`src/agent-repl.ts:345-348` — Error types are identified by `msg.includes("Authentication")` and `msg.includes("WAF")`. This is fragile — a translation change, lowercase error, or slightly different wording breaks the classification.

### 29. WASM Binary is an External Symlink
`sha3_wasm_bg.wasm` is a symlink to `/root/deepseek-full-api/sha3_wasm_bg.wasm` (outside the project directory). Deleting or moving the parent project breaks the PoW solver.
- **File**: `sha3_wasm_bg.wasm` (symlink)

### 30. FlareSolverr is a Hard Dependency
`src/web-api-client.ts:232-291` — WAF token refresh requires a running FlareSolverr instance at `http://127.0.0.1:8191`. If FlareSolverr is down, unreachable, or returns unexpected data, the entire agent loop becomes non-functional once the WAF token expires (typically minutes to hours).

### 31. Auth Resolution Chain Has Silent Fallbacks
`src/web-api-client.ts:107-154` — `loadAuth()` tries 5 sources silently. If a stale/invalid token exists in an earlier source, it's returned without validation. A `DEEPSEEK_TOKEN` env var with an expired value will be used without attempting fallback sources.

## Error Handling Gaps

### 32. Empty SSE Response Not Handled
`src/agent-loop.ts:160-163` and `src/agent-repl.ts:157-159` — Both check `if (!fullText)` after streaming but do not distinguish between "API returned no data" and "SSE stream produced no content events." These are different failure modes with different root causes.

### 33. No Rate Limit Handling
`src/web-api-client.ts` — DeepSeek's API likely has rate limits, but there's no `429 Too Many Requests` handling. The `withRetry` function only retries on thrown errors, not on HTTP 429 responses.

### 34. No Signal Propagation to Downstream Calls
`src/agent-loop.ts:131-158` — The `AbortSignal` from `ChatStreamOptions.signal` is passed to the outer `chatStream` but not propagated to the inner `withWafRetry` -> `fetch` call in `chatStream`. If the caller aborts, the fetch continues.
- **File**: `src/web-api-client.ts:590-622`

### 35. WASM PoW Failure Not Degraded Gracefully
`src/web-api-client.ts:557-562` — If the PoW challenge endpoint fails (non-200), `powHeader` remains `null` and the completion request is sent without PoW. This may or may not work depending on the API's current enforcement. No logging or fallback.

### 36. No Validation for Tool Arguments
`src/tool-registry.ts:17-37` — Tool implementations trust `args` directly without schema validation. Missing or malformed arguments produce confusing runtime errors (e.g., `String(undefined)` → `"undefined"` as a file path).

## Missing Tests

### 37. Zero Unit Tests
2564 lines of TypeScript across 13 source files with zero test files. No test framework installed. No `test` script in `package.json`.

### 38. No Integration Tests for Critical Auth Flow
The auth resolution chain (`loadAuth` → 5 sources → fallback → session creation → WAF refresh) has no automated tests despite being the most error-prone part of the system.

### 39. SSE Parser Untested
`parseSseLine` handles 15+ distinct SSE event formats (fragment setup, fragment append, content append, thinking append, simple delta, patch format, [DONE], FINISHED, error, etc.) with zero test coverage.

### 40. Tool Call Extraction Untested Across Model Variants
The 8 extraction strategies are designed to handle different model outputs, but only the ad-hoc `capture-raw.ts` script tests them (requires live API key and network).

## Configuration & Dependency Risks

### 41. TypeScript Config Excludes `capture-raw.ts`
`tsconfig.json:13` — `include: ["src/**/*.ts"]` excludes `capture-raw.ts` at the project root from type-checking. This file imports from `src/` modules and may have type errors that go undetected.

### 42. `tsx` as Secondary Runtime Dependency
`src/agent-native.ts` and `devDependencies` include `tsx` for Node.js execution. But `tsx@4.21.0` is locked only by `bun.lock`, and the `package.json` specifier is `"latest"`. The agent-native path may silently break if a newer tsx version changes behavior.

### 43. No Healthcheck for FlareSolverr
`src/web-api-client.ts:232-291` — `refreshWafToken` calls FlareSolverr without any prior healthcheck. If FlareSolverr is misconfigured, the 120-second timeout must expire before the system falls back to the error message.

### 44. Zone/Region Caveats
Hardcoded `x-client-locale: "en_US"` and `x-client-timezone-offset: "10800"` assume English-speaking user in UTC+3. Non-Moscow timezones send mismatched offset headers.

## Summary Statistics

| Category | Count |
|----------|-------|
| Technical Debt | 8 |
| Bugs & Logic Issues | 7 |
| Security Issues | 5 |
| Performance Bottlenecks | 5 |
| Fragile Areas | 6 |
| Error Handling Gaps | 5 |
| Missing Tests | 4 |
| Configuration & Dependency Risks | 4 |
| **Total** | **44** |
