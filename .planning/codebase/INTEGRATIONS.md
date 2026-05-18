# INTEGRATIONS.md — External APIs & Third-Party Services

## 1. DeepSeek Chat API (Primary Integration)

**Base URL**: `https://chat.deepseek.com`

The entire harness is built around the undocumented DeepSeek Chat web API. All endpoints are reverse-engineered.

### 1.1 Session Management

**Create Session**
- **Endpoint**: `POST /api/v0/chat_session/create` (`web-api-client.ts:420`)
- **Body**: `{ agent: "chat", model_type: string }`
- **Response**: JSON with `data.biz_data.chat_session.id` or `data.biz_data.id`
- **Model types**: `"default"`, `"expert"`, `"vision"` (not `"coder"`)
- **Auth required**: Bearer token + cookies

### 1.2 Chat Completion (SSE Stream)

**Endpoint**: `POST /api/v0/chat/completion` (`web-api-client.ts:597`)
**Body**:
```json
{
  "chat_session_id": "string",
  "prompt": "string",
  "model_type": "string",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "preempt": false,
  "client_stream_id": "YYYYMMDD-<uuid-nodashes>",
  "parent_message_id": "number|null"
}
```

**Stream Format**: Server-Sent Events (SSE) with DeepSeek V4 fragment protocol (`web-api-client.ts:630-758`):
- Fragment setup: `{"v": {"response": {"fragments": [{"type": "THINK"|"TEXT"|"RESPONSE", "content": "..."}]}}}`
- Fragment append: `{"p": "response/fragments", "o": "APPEND", "v": [{"type": "THINK"|"RESPONSE", "content": "..."}]}`
- Content append: `{"p": "response/fragments/-1/content", "o": "APPEND", "v": "text"}`
- Thinking append: `{"p": ".../thinking", "o": "APPEND", "v": "text"}`
- Done signal: `{"response_message_id": <n>, "v": "FINISHED"}` or `[DONE]`
- Simple delta: `{"v": "text"}` or `{"type": "delta", "content": "text", "index": 0}`

### 1.3 Proof-of-Work Challenge

**Endpoint**: `POST /api/v0/chat/create_pow_challenge` (`web-api-client.ts:548-555`)
**Body**: `{ "target_path": "/api/v0/chat/completion" }`
**Response**: `data.biz_data.challenge` with `PowChallenge` fields:
- `algorithm`: `"DeepSeekHashV1"`
- `challenge`: `string`
- `salt`: `string`
- `difficulty`: `number`
- `expire_at`: `number` (Unix timestamp)
- `signature`: `string`
- `target_path?`: `string`

**Solver**: `DeepSeekPoWSolver` class (`web-api-client.ts:303-378`) uses `sha3_wasm_bg.wasm` (SHA3-based WASM binary) to solve challenges.
**Transport**: Solved challenge is base64-encoded and sent as `x-ds-pow-response` header on the completion request.

### 1.4 Auth & Request Headers

**Auth token** is sent as `Authorization: Bearer <token>` header.

**Custom headers** (`web-api-client.ts:380-398`):
```js
{
  "x-app-version": "20241129.1",
  "x-client-locale": "en_US",
  "x-client-platform": "web",
  "x-client-timezone-offset": "10800",
  "x-client-version": "2.0.0",
  "x-client-stream-id": "<generated>",
  "x-ds-pow-response": "<base64 PoW solution>",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "priority": "u=1, i"
}
```

### 1.5 Auth Storage & Resolution

**Sources** (checked in order, `web-api-client.ts:107-154`):
1. `process.env.DEEPSEEK_TOKEN` — direct env var
2. `process.env.DEEPSEEK_TOKEN_STATE` — path to token file (default: `.pi/agent/deepseek_token.txt`)
3. `process.env.DEEPSEEK_AUTH_STATE` — path to Chrome auth JSON export (default: `.pi/agent/deepseek_auth.json`)
4. `.pi/agent/deepseek_auth.json` — Chrome DevTools localStorage export with `userToken` key
5. `.pi/agent/deepseek_token.txt` — raw token text file

**Auth persistence** (`web-api-client.ts:156-208`):
- Token persisted to `.pi/agent/deepseek_token.txt` and `.pi/agent/deepseek_auth.json`
- Cookie header persisted under `cookie_header` key in `.pi/agent/deepseek_auth.json`

## 2. FlareSolverr (Anti-Bot Bypass)

**Default URL**: `http://127.0.0.1:8191` (configurable via `FLARESOLVERR_URL` env var)

**Purpose**: Refresh Cloudflare/AWS WAF tokens when they expire.

**Integration** (`web-api-client.ts:232-291`):
- Sends `request.get` to `https://chat.deepseek.com/` with 120s timeout
- Extracts cookies from FlareSolverr response:
  - `aws-waf-token` — AWS WAF session token
  - `ds_session_id` — DeepSeek session cookie
  - `smidV2` — session management ID
  - `.thumbcache` — browser thumbprint cache
- Falls back to `WafTokenExpiredError` if FlareSolverr is unreachable

**Auth Flow** (`web-api-client.ts:451-504`):
- If `createSession` returns 403 with `x-amzn-waf-action` header → WAF token expired → trigger `refreshWafToken()` via FlareSolverr
- If `createSession` returns 401/403 without WAF header → `StaleAuthError` → reload auth from disk
- `withWafRetry()` wrapper (`web-api-client.ts:506-520`) transparently retries failed requests after WAF refresh

## 3. AWS WAF

**Detection**: `web-api-client.ts:428-434` checks for `x-amzn-waf-action` response header on 403 responses from `chat.deepseek.com`.
**Cookie**: `aws-waf-token` managed via FlareSolverr refresh cycle.

## 4. Pi Agent Core Framework (Internal Integration)

**Package**: `@mariozechner/pi-agent-core@0.73.0`
**Entry points used**:
- `Agent` class (`src/index.ts:1`) — core multi-turn agent with subscription model
- `AgentTool` type (`src/index.ts:2`) — tool interface
- `StreamFn` type (`src/deepseek-native-stream.ts:3`) — streaming adapter function
- `AgentMessage` type (`src/context-compact.ts:1`) — message shape for context compaction

## 5. Pi AI Framework (Internal Integration)

**Package**: `@mariozechner/pi-ai@0.73.0`
**Entry points used**:
- `getModel("deepseek", "deepseek-v4-pro")` (`src/index.ts:36`) — model abstraction
- `Type.Object()`, `Type.String()`, `Type.Number()` (`src/tools.ts:4`) — Zod-like parameter schema builder
- `Tool` type (`src/tools.ts:4`) — tool definition shape
- `Context`, `Model`, `SimpleStreamOptions` types (`src/deepseek-native-stream.ts:1-2`)
- `createAssistantMessageEventStream()` (`src/deepseek-native-stream.ts:2`) — streaming event emitter

## 6. Transitive AI Provider SDKs (via pi-ai)

These are not directly imported but available through pi-ai:

| SDK | Version | Provider |
|-----|---------|----------|
| `@anthropic-ai/sdk` | 0.91.1 | Anthropic Claude |
| `openai` | 6.26.0 | OpenAI |
| `@aws-sdk/client-bedrock-runtime` | 3.1042.0 | AWS Bedrock |
| `@google/genai` | 1.52.0 | Google Gemini |
| `@mistralai/mistralai` | 2.2.1 | Mistral AI |

## 7. WebAssembly

**File**: `sha3_wasm_bg.wasm` (project root)
**Purpose**: DeepSeek PoW challenge solver (`DeepSeekHashV1` algorithm)
**Integration** (`web-api-client.ts:303-378`):
- Loaded via `WebAssembly.instantiate()` with no imports
- Exports `wasm_solve()` function that accepts challenge bytes + prefix bytes + difficulty
- Memory-mapped via `WebAssembly.Memory` for passing strings and reading u64 answer

## 8. Environment Variables Reference

| Variable | Default | Used In | Purpose |
|----------|---------|---------|---------|
| `DEEPSEEK_TOKEN` | — | `web-api-client.ts:112` | Direct auth token |
| `DEEPSEEK_TOKEN_STATE` | `.pi/agent/deepseek_token.txt` | `web-api-client.ts:109` | Token file path |
| `DEEPSEEK_AUTH_STATE` | `.pi/agent/deepseek_auth.json` | `web-api-client.ts:110` | Auth state file path |
| `FLARESOLVERR_URL` | `http://127.0.0.1:8191` | `web-api-client.ts:82` | FlareSolverr service URL |
