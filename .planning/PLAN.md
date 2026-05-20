# Full Pi SDK Integration Plan

## Research Findings

### pi-coding-agent (127 exports)
- **Session Management**: `SessionManager`, `AuthStorage`, `SettingsManager` - all work independently
- **Agent Session**: `createAgentSession()` creates full session with built-in API providers (OpenAI, Anthropic, etc.)
- **AgentSession**: Full-featured class with `prompt()`, `subscribe()`, `compact()`, `steer()`, etc.
- **Key constraint**: `createAgentSession()` uses `modelRegistry.getApiKeyAndHeaders()` + `streamSimple()` internally - cannot use custom DeepSeek streamFn
- **Tools**: `createReadTool`, `createBashTool`, `createEditTool`, `createWriteTool`, `createGrepTool`, `createFindTool`, `createLsTool`, `createCodingTools`
- **Message conversion**: `convertToLlm` - converts pi-agent-core messages to LLM format
- **Theme**: `initTheme()` (sets global), `getMarkdownTheme()` (returns theme object), `Theme` class
- **InteractiveMode**: Full TUI class requiring `runtimeHost` (wraps AgentSession) - too coupled for our custom API

### pi-tui (56 exports)
- **Components**: `TUI`, `Container`, `Box`, `Text`, `TruncatedText`, `Input`, `Markdown`, `SelectList`, `SettingsList`, `Editor`, `Image`, `Loader`, `CancellableLoader`, `ProcessTerminal`
- **Key API**: `addChild()` not `add()`, `setText()` for Text/Markdown
- **Markdown**: Requires manual `md.theme = getMarkdownTheme()` after `initTheme()`
- **TUI.render()**: Requires `setCellDimensions({ cols, rows })` first
- **Input handling**: `parseKey()`, `Key`, `getKeybindings()`, `TUI_KEYBINDINGS`, `StdinBuffer`

### pi-agent-core (6 exports)
- `Agent`, `agentLoop`, `agentLoopContinue`, `runAgentLoop`, `runAgentLoopContinue`, `streamProxy`

### pi-ai (60 exports)
- `AssistantMessageEventStream`, `EventStream`, `streamSimple`, `stream`, `complete`
- Provider registration: `registerApiProvider`, `getApiProviders`, `registerBuiltInApiProviders`

## Integration Strategy

### Architecture Decision
Keep our custom `PiAgentLoop` (DeepSeek web API + PoW + WAF + custom tool parsing) but properly wrap it with pi's session management and TUI components.

### Phase 1: Fix pi-session.ts
- Use pi's `SessionManager` for message persistence (already done, working)
- Use pi's `AuthStorage` for credential management (already done)
- Use pi's `SettingsManager` for configuration (already done)
- Fix `prompt()` to properly extract text from assistant messages (content can be string or array)
- Add `getSessionStats()`, `getContextUsage()` from SessionManager

### Phase 2: Rewrite terminal-mode.ts
- Use pi-tui components with correct API (`addChild` not `add`)
- Initialize theme with `initTheme()` + `getMarkdownTheme()`
- Use `Markdown` component with proper theme assignment
- Use `Input` component from pi-tui for text input
- Use `Container` + `Box` for layout
- Use `setCellDimensions()` before rendering
- Handle stdin with `StdinBuffer` and `parseKey()` from pi-tui
- Subscribe to `PiAgentLoop` events and update TUI components
- Show tool execution with pi-tui `Text` components
- Display assistant responses with `Markdown` component
- Status bar with session info from `SessionManager`

### Phase 3: Fix web-server.ts
- Already integrated with `SessionManager`, `AuthStorage`, `SettingsManager`
- Add session history loading from `.jsonl` files
- Add session tree navigation endpoint
- Add session restore endpoint

### Phase 4: Build and Test
- Verify all files compile with `bun build`
- Test terminal mode startup and basic interaction
- Test web server endpoints
- Test session persistence across restarts

## Key Technical Details

### pi-tui Component Usage
```typescript
import { TUI, Container, Box, Text, Markdown, Input, setCellDimensions, parseKey, StdinBuffer } from '@earendil-works/pi-tui';
import { initTheme, getMarkdownTheme } from '@earendil-works/pi-coding-agent';

// Setup
setCellDimensions({ cols: process.stdout.columns, rows: process.stdout.rows });
initTheme();

// Markdown needs theme
const md = new Markdown();
md.theme = getMarkdownTheme();
md.setText('# Response');

// Container layout
const container = new Container();
const box = new Box();
box.addChild(new Text('Status: Ready'));
container.addChild(box);
container.addChild(md);

// Render
const tui = new TUI();
const lines = tui.render(container);
process.stdout.write(lines.join('\n'));
```

### SessionManager Usage
```typescript
const sessionManager = SessionManager.create(process.cwd());
sessionManager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: Date.now() });
sessionManager.getEntries(); // All messages
sessionManager.getTree(); // Session tree
sessionManager.getSessionFile(); // Path to .jsonl file
sessionManager.buildSessionContext(); // Rebuild context from file
```
