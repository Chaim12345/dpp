# STACK.md — Technology Stack

## Languages & Runtime

- **TypeScript** (ES2022 target, NodeNext module) — all source code in `src/`
- **Bun** — primary runtime and build tool (v1.x, bun.lock detected)
- **Node.js** — secondary runtime via `tsx` (ESM, `"type": "module"` in package.json)

## Build System

- **Bun build**: `bun build src/index.ts --outdir ./dist` produces CommonJS/ESM output in `dist/`
- **No bundled optimizer** (no webpack/vite/esbuild config beyond Bun's built-in bundler)
- **Build output**: `dist/index.js`, `dist/tools.js`, `dist/deepseek-native-stream.js`, `dist/context-compact.js`, `dist/types.js`, `dist/src/` (mirror)

## Project Structure

```
pi-harness/
├── src/
│   ├── index.ts              # Entry point: single-prompt agent harness
│   ├── agent.ts              # CLI agent runner with flags (--thinking, --model, --max-rounds)
│   ├── agent-native.ts       # tsx-based agent runner
│   ├── agent-loop.ts         # Core tool-calling agent loop
│   ├── agent-repl.ts         # Interactive REPL agent
│   ├── web-api-client.ts     # DeepSeek Chat API client (auth, sessions, streaming)
│   ├── deepseek-native-stream.ts  # Adapter: DeepSeek SSE → pi-agent-core StreamFn
│   ├── tool-registry.ts      # Tool definitions (read, write, grep, bash, edit)
│   ├── tools.ts              # Alternative tool definitions (read, bash only; pi-ai Tool type)
│   ├── context.ts            # Context management, token estimation, compaction
│   ├── context-compact.ts    # pi-agent-core context compaction adapter
│   └── types.ts              # Shared types (NativeStreamEvent, HarnessState)
├── dist/                     # Compiled JavaScript output
├── capture-raw.ts            # V4 API capture and tool-call extraction test script
├── sha3_wasm_bg.wasm         # WASM PoW solver binary
├── package.json              # Package manifest
├── package-lock.json         # npm lockfile
├── bun.lock                  # Bun lockfile
└── tsconfig.json             # TypeScript config
```

## Direct Dependencies

### Runtime (`dependencies` in `package.json`)
| Package | Version | Purpose |
|---------|---------|---------|
| `@mariozechner/pi-agent-core` | 0.73.0 | Agent framework: Agent class, StreamFn, multi-turn state |
| `@mariozechner/pi-ai` | 0.73.0 | AI model abstraction: getModel(), Type system, event streams |

### Dev (`devDependencies` in `package.json`)
| Package | Version | Purpose |
|---------|---------|---------|
| `@types/node` | 25.6.0 | Node.js type definitions |
| `tsx` | 4.21.0 | TypeScript execution for Node.js (used in `agent-native.ts`) |
| `typescript` | 6.0.3 | TypeScript compiler |

## Transitive Dependencies (Notable)

Resolved via `bun.lock`:

| Package | Version | Source (transitive via) | Purpose |
|---------|---------|------------------------|---------|
| `@anthropic-ai/sdk` | 0.91.1 | pi-ai | Anthropic API client |
| `openai` | 6.26.0 | pi-ai | OpenAI API client |
| `@aws-sdk/client-bedrock-runtime` | 3.1042.0 | pi-ai | AWS Bedrock runtime client |
| `@google/genai` | 1.52.0 | pi-ai | Google GenAI (Gemini) client |
| `@mistralai/mistralai` | 2.2.1 | pi-ai | Mistral AI client |
| `undici` | 7.25.0 | pi-ai | HTTP/1.1 client (fetch polyfill) |
| `zod` | 4.4.3 | various | Schema validation |
| `zod-to-json-schema` | 3.25.2 | pi-ai | Zod → JSON Schema conversion |
| `proxy-agent` | 6.5.0 | pi-ai | HTTP/SOCKS proxy support |
| `partial-json` | 0.1.7 | pi-ai | Partial JSON parsing (streaming) |
| `typebox` | 1.1.37 | pi-agent-core, pi-ai | Runtime type system |
| `chalk` | 5.6.2 | pi-ai | Terminal coloring |
| `json-schema-to-ts` | 3.1.1 | @anthropic-ai/sdk | JSON Schema → TS types |

## Configuration Files

| File | Purpose |
|------|---------|
| `package.json:21` | ESM module declaration, scripts, dependency declarations |
| `tsconfig.json:14` | TypeScript compiler options (strict, ES2022, NodeNext) |
| `bun.lock:427` | Bun deterministic lockfile |
| `package-lock.json` | npm deterministic lockfile (dual-locked) |

## Scripts (`package.json:6-11`)

| Script | Command | Purpose |
|--------|---------|---------|
| `build` | `bun build src/index.ts --outdir ./dist` | Compile TypeScript |
| `start` | `bun run src/index.ts` | Single-prompt agent (args: `<prompt>`) |
| `agent` | `bun run src/agent.ts` | CLI agent with flags |
| `repl` | `bun run src/agent-repl.ts` | Interactive REPL |
| `test-auth` | `bun run src/web-api-client.ts` | Auth token verification |
| `agent-native` | `bun run src/agent-native.ts` | Node/tsx agent runner |

## Module Import Style

- All imports use `.js` extensions per NodeNext module resolution (e.g., `from "./tools.js"`)
- Mix of ESM `import` and dynamic `import()` 
- Node built-ins imported from `node:*` namespace (`node:fs/promises`, `node:child_process`, `node:util`, `node:path`, `node:readline`)
- Bun-specific imports in `tool-registry.ts`: `import { $, type BunFile } from "bun"`
- One bare path import: `"../node_modules/@mariozechner/pi-ai/dist/utils/event-stream.js"`

## TypeScript Configuration (`tsconfig.json:3-12`)

- `target`: ES2022
- `module`: NodeNext
- `moduleResolution`: NodeNext
- `strict`: true
- `esModuleInterop`: true
- `skipLibCheck`: true
- `outDir`: dist
- `rootDir`: src
- `types`: ["node"]
- `include`: ["src/**/*.ts"]

## Code Conventions

- **Shebangs**: `agent.ts:1` and `agent-repl.ts:1` use `#!/usr/bin/env bun`; `agent-native.ts:1` uses `#!/usr/bin/env tsx`
- **Error handling**: Custom error classes (`RetryableError`, `StaleAuthError`, `WafTokenExpiredError`) in `web-api-client.ts:6-49`; retry with exponential backoff (`web-api-client.ts:13-35`)
- **Type system**: Zod schemas for tool parameter validation (`src/tools.ts:9-27`); TypeScript interfaces/flags for internal types (`src/types.ts:7-13`)
