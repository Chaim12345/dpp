# Structure

## Directory Layout

```
pi-harness/
├── .claude/                          # Claude project config
│   └── cc10x/                        # Per-session context files
├── .planning/
│   └── codebase/                     # Codebase analysis docs (this dir)
├── dist/                             # Bun build output (JS)
│   ├── context-compact.js
│   ├── deepseek-native-stream.js
│   ├── index.js
│   ├── tools.js
│   ├── types.js
│   └── src/                          # Subdirectory copy
├── node_modules/                     # Dependencies
├── src/                              # Source code (rootDir in tsconfig)
│   ├── agent.ts                      # CLI entry: agent loop wrapper
│   ├── agent-loop.ts                 # Core agent loop implementation
│   ├── agent-native.ts               # Minimal entry: agent loop
│   ├── agent-repl.ts                 # Interactive REPL entry
│   ├── context.ts                    # Token estimation, compaction, truncation
│   ├── context-compact.ts            # Pi AI bridge: message compaction
│   ├── deepseek-native-stream.ts     # SSE → Pi AI stream adapter
│   ├── index.ts                      # Pi Agent Core integration entry
│   ├── tool-registry.ts              # 5 tool defs + 8-strategy call extractor
│   ├── tools.ts                      # Pi AI format: 2 tool defs
│   ├── types.ts                      # Shared types
│   └── web-api-client.ts             # DeepSeek API HTTP client + SSE parser
├── capture-raw.ts                    # Test: V4 API format capture
├── package.json                      # Project manifest + scripts
├── tsconfig.json                     # TypeScript config (ES2022, NodeNext)
├── bun.lock                          # Bun lockfile
├── package-lock.json                 # npm lockfile
└── sha3_wasm_bg.wasm                 # PoW WASM binary
```

## Key File Locations

| Path | Lines | Role |
|------|-------|------|
| `src/web-api-client.ts` | 870 | Largest file — HTTP transport, SSE parsing, auth, PoW |
| `src/tool-registry.ts` | 486 | Tool definitions + multi-strategy extraction |
| `src/agent-repl.ts` | 433 | Interactive REPL with command system |
| `src/agent-loop.ts` | 216 | Core agent loop orchestration |
| `src/deepseek-native-stream.ts` | 128 | Pi AI stream bridge |
| `src/context.ts` | 97 | Context management utilities |
| `src/index.ts` | 55 | Pi Agent Core entry point |
| `src/tools.ts` | 53 | Pi AI tool definitions |
| `src/context-compact.ts` | 32 | Pi AI message compaction |
| `src/agent.ts` | 31 | CLI argument parser for agent-loop |
| `src/types.ts` | 13 | Shared type definitions |
| `src/agent-native.ts` | 10 | Minimal entry wrapper |
| `capture-raw.ts` | 140 | V4 API capture/testing utility |

## Module Organization

### Dependency Graph (Simplified)

```
index.ts
  └── ts → agent.ts → agent-loop.ts
  │                    ├── web-api-client.ts
  │                    ├── tool-registry.ts
  │                    └── context.ts
  ├── ts → agent-native.ts → agent-loop.ts
  │                           (same deps)
  ├── ts → agent-repl.ts
  │         ├── web-api-client.ts
  │         ├── tool-registry.ts
  │         └── context.ts
  ├── deepseek-native-stream.ts
  │     ├── web-api-client.ts
  │     └── types.ts
  ├── tools.ts
  │     └── context-compact.ts
  └── capture-raw.ts
        ├── web-api-client.ts
        └── tool-registry.ts
```

### Circular Dependencies

- `context.ts` provides `truncateFileContent`/`truncateMessage` used by `tool-registry.ts` — no cycle
- `tool-registry.ts` imports from `context.ts` — clean dependency direction

## Naming Conventions

| Convention | Examples |
|------------|----------|
| **camelCase** for functions/variables | `runAgentLoop`, `extractToolCalls`, `compactHistory` |
| **PascalCase** for classes/interfaces | `HarnessState`, `DeepSeekPoWSolver`, `ToolResult` |
| **kebab-case** for files | `tool-registry.ts`, `web-api-client.ts`, `context-compact.ts` |
| **snake_case** for JSON API fields | `chat_session_id`, `parent_message_id`, `model_type` |

## Package Scripts (`package.json`)

| Script | Command | Entry |
|--------|---------|-------|
| `build` | `bun build src/index.ts --outdir ./dist` | `src/index.ts` |
| `start` | `bun run src/index.ts` | `src/index.ts` |
| `agent` | `bun run src/agent.ts` | `src/agent.ts` |
| `repl` | `bun run src/agent-repl.ts` | `src/agent-repl.ts` |
| `test-auth` | `bun run src/web-api-client.ts` | `src/web-api-client.ts` (self-test) |
| `agent-native` | `bun run src/agent-native.ts` | `src/agent-native.ts` |

## Dependencies

| Package | Type | Purpose |
|---------|------|---------|
| `@mariozechner/pi-agent-core` | runtime | Agent class, StreamFn type, AgentMessage type |
| `@mariozechner/pi-ai` | runtime | Model, Type system, createAssistantMessageEventStream |
| `@types/node` | dev | Node.js type definitions |
| `typescript` | dev | TypeScript compiler |

## Notable Patterns

1. **File pair**: `src/tools.ts` (Pi AI format) vs `src/tool-registry.ts` (custom) — two parallel tool systems for different entry points
2. **File pair**: `src/context.ts` (custom loop) vs `src/context-compact.ts` (Pi AI bridge) — parallel context management
3. **Shebang entries**: `src/agent.ts`, `src/agent-repl.ts`, `src/agent-native.ts`, `capture-raw.ts` start with `#!/usr/bin/env bun` or `#!/usr/bin/env tsx`
4. **Self-test module**: `src/web-api-client.ts` runs as script when invoked directly (line 850+)
5. **Auth state persistence**: `.pi/agent/` directory (gitignored) for token and cookie state

## TypeScript Config (`tsconfig.json`)

- Target: `ES2022`
- Module: `NodeNext`, resolution: `NodeNext`
- Strict mode enabled
- Root: `src/`, output: `dist/`
