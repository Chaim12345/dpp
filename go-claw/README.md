# go-claw

Direct integration between [claw-code-go](https://github.com/daolmedo/claw-code-go)
(a Go port of Claude Code) and the [DeepSeek web chat API](https://chat.deepseek.com)
— no DeepSeek-issued API key required. Reuses the session token a logged-in
browser holds, runs the same PoW challenge in an embedded WASM blob, and
emits Anthropic-shaped stream events that the claw-code-go conversation loop
already understands.

This branch lives on the dpp repo (a different Go project that also talks to
the same web API) so all the reversed-engineering work stays in one place.
The actual integration runs inside the claw-code-go fork — see **Applying
the integration** below.

## Layout

```
go-claw/
├── provider/                 # the new claw-code-go deepseek provider
│   ├── provider.go           # api.Provider + api.APIClient impl, retry, output budget
│   ├── webclient.go          # HTTP client to chat.deepseek.com
│   ├── wasm_solver.go        # embedded PoW solver (wazero runtime)
│   ├── sha3_wasm_bg.wasm     # the solver blob
│   ├── models.go             # model name parser + /client/settings fetcher
│   ├── limits.go             # per-variant input/output caps
│   ├── stream.go             # tool-call extraction (JSON, XML, code-block, ReAct)
│   └── types.go              # internal types
├── integration.patch         # git diff of changes applied to claw-code-go
└── README.md                 # this file
```

## What it does

* **Three orthogonal knobs** mirror the web UI's "Instant / Expert / Vision"
  selector plus the per-request `thinking_enabled` and `search_enabled` flags
  the completion endpoint accepts. Friendly names like
  `expert`, `instant-thinking-search`, `vision` map to the right
  `(model_type, thinking, search)` tuple.
* **Per-variant limits** come from `GET /api/v0/client/settings?scope=model`
  — the same endpoint the web UI calls to populate its model picker. The
  `input_character_limit` is converted to a token estimate and used for a
  pre-flight check before the prompt is sent.
* **Graceful max-token handling**:
  * Pre-flight reject with a clear error if the prompt would blow past the
    model-specific cap.
  * Soft warning at 28K tokens (so the conversation loop can compact).
  * Output budget: respect `req.MaxTokens` by truncating the stream
    mid-response with a marker.
  * 3× retry with exponential backoff for transient errors (network blips,
    5xx, PoW failures).
* **Tool-call extraction**: the streamed response is scanned for the model's
  `{"tool_calls":[{...}]}` JSON, XML-formatted tool calls, code-block
  variants, and ReAct-style invocations. Detected calls are re-emitted as
  `EventContentBlockStart` + `EventContentBlockDelta` events so the
  conversation loop can execute them and feed results back.
* **Embedded WASM PoW**: the SHA-3 challenge solver ships as a 26 KB blob
  loaded by `wazero`. No external tools, no Node, no Python.

## Measured limits (web API, 2026-06)

| Variant        | char cap  | ~tokens   | tested up to | fails at       |
|----------------|-----------|-----------|--------------|----------------|
| Instant        | 2,621,440 | 655,360   | 2,500,000    | 2,700,000      |
| Instant+Think  | 2,621,440 | 655,360   | 2,500,000    | 2,700,000      |
| Instant+Search | 2,621,440 | 655,360   | 2,500,000    | 2,700,000      |
| Instant+Both   | 2,621,440 | 655,360   | 2,500,000    | 2,700,000      |
| Expert         |   163,840 |  40,960   | 150,000      | 200,000        |
| Expert+Think   |   163,840 |  40,960   | 150,000      | 200,000        |

Thinking and search do **not** change the input cap; only the
`model_type` does. Vision is `switchable: false` in the web API but works
when addressed directly with `--model vision`.

## Building

The Go provider lives under `internal/api/providers/deepseek/` in a
claw-code-go checkout. Copy the `provider/` directory to that path, apply
`integration.patch` against a fresh claw-code-go clone, then:

```bash
cd claw-code-go
go build -o claw-code-go ./cmd/claw-code-go
```

`go.mod` needs one new direct dependency:

```
require github.com/tetratelabs/wazero v1.11.0
```

## Applying the integration

```bash
# 1. Clone claw-code-go
git clone https://github.com/daolmedo/claw-code-go.git
cd claw-code-go

# 2. Copy the provider package
mkdir -p internal/api/providers/deepseek
cp /path/to/dpp/go-claw/provider/* internal/api/providers/deepseek/

# 3. Apply the integration patch
git apply /path/to/dpp/go-claw/integration.patch

# 4. Add wazero and build
go mod tidy
go build -o claw-code-go ./cmd/claw-code-go
```

## Running

```bash
# Save a session token captured from a logged-in browser
mkdir -p ~/.deepseek
echo "VD6Eukqk..." > ~/.deepseek/deepseek_token.txt
chmod 600 ~/.deepseek/deepseek_token.txt

# Single prompt, Expert model (default)
CLAW_CODE_USE_DEEPSEEK=1 ./claw-code-go --prompt "what does main.go do?"

# Or pick a different variant
CLAW_CODE_USE_DEEPSEEK=1 ./claw-code-go --model instant --prompt "..."
CLAW_CODE_USE_DEEPSEEK=1 ./claw-code-go --model instant-thinking-search --prompt "what's new in deepseek v4?"
CLAW_CODE_USE_DEEPSEEK=1 ./claw-code-go --model vision --prompt "describe image.png"

# Long prompt that exceeds the OS argv limit
CLAW_CODE_USE_DEEPSEEK=1 ./claw-code-go --prompt-file big-prompt.txt
```

The token can also be passed via `DEEPSEEK_TOKEN` env var.

## Companion: src/openai-server.ts

The TypeScript OpenAI-compatible proxy on this same branch is the
sister-tool to this Go provider. It exposes the same DeepSeek web API
behind a `/v1/chat/completions` endpoint so any OpenAI SDK can talk to
chat.deepseek.com without an API key. Use whichever side of the bridge
suits your client:

| Client                  | Bridge to use                |
|-------------------------|------------------------------|
| claw-code-go (Go)       | `provider/` (no HTTP needed) |
| Anything speaking OpenAI| `src/openai-server.ts` (Bun) |
| Anthropic SDK           | the OpenAI bridge (model names don't map, but the call shape does) |
