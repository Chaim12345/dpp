# DeepSeek Native Stream Adapter — Bug Report & Fixes

**File:** `src/deepseek-native-stream.ts`  
**Date:** 2026-05-27

---

## Overview

The `createDeepSeekNativeStream` function bridges DeepSeek's chat API (chat.deepseek.com) to Pi's `Agent` class. It converts Pi's structured `Context` into a plain text prompt, streams SSE events from DeepSeek, parses tool calls from the text using regex + XML parsers, and emits `AssistantMessageEventStream` events.

**Core architectural problem:** DeepSeek's web API does not support native tool calling. The adapter must detect tool calls from free-form text, which is inherently fragile.

---

## Bug 1: Regex Parsers Match Instructional Text as Tool Calls (Spurious Tool Invocations)

**Severity:** High  
**Lines:** ~22-58 (parsers), ~175-230 (mid-stream detection loop)

**Root Cause:**  
`extractReactToolCalls`, `extractToolParenCalls`, and `extractToolColonCalls` all run against `accumulatedText` — the full concatenation of all chunks seen so far, checked **mid-stream**. Any instructional mention of tool syntax in the model's response matches these patterns.

**Example:**  
If the model outputs: *"To read a file, use `Tool: read\n\nArguments: {"path": "foo.ts"}`"* as explanatory text, the `extractToolColonCalls` parser finds it and emits a spurious tool call.

**Impact:** Tools are called with garbage arguments extracted from instructional text. The real text response is truncated when the stream is killed (see Bug 2).

**Fix:** Only parse accumulated text for tool calls **after** the stream completes (in the `done` handler), not mid-stream. Move all parser calls from the content-delta loop to the stream-end handler.

```typescript
// BEFORE (in content delta loop):
const reactCalls = extractReactToolCalls(accumulatedText);
// ... emit and return immediately

// AFTER (in stream done handler):
// Phase 1: collect all text, stream text_delta events
// Phase 2: parse tool calls from final accumulatedText
const colonCalls = extractToolColonCalls(accumulatedText);
const reactCalls = extractReactToolCalls(accumulatedText);
```

---

## Bug 2: Early Stream Termination After First Detected Tool Call (Multi-Call Truncation)

**Severity:** High  
**Lines:** ~178-230 (repeated after every parser check)

**Root Cause:**  
After **any** tool call is detected by any parser, the stream is immediately terminated with `stream.end()` and `return`. This happens after XML, ReAct, paren, and colon parser checks. If the model outputs multiple tool calls or text after tool calls, everything after the first detected call is dropped.

**Example:**
```
Let me look at that file.

Tool: read

Arguments: {"path": "foo.ts"}

Now let me also check the config with:

Tool: read

Arguments: {"path": "config.json"}
```

Only `read(foo.ts)` fires. "Now let me also check..." and the second `read` are silently dropped.

**Fix:** Collect all text first (Phase 1). Parse all tool calls at the end (Phase 2). Emit all detected tool calls sequentially (Phase 3). Do not `return` early.

```typescript
// Phase 1: Collect all text in content loop, no early returns
for await (const event of parseSseStream(resp.body)) {
  if (event.type === "content") {
    accumulatedText += event.delta;
    // stream text_delta for real-time UI
  } else if (event.type === "done") {
    break; // exit loop, don't end stream
  }
}

// Phase 2: Parse ALL tool calls from final text
const allToolCalls = [...extractToolColonCalls(accumulatedText), ...];

// Phase 3: Emit all calls, then end stream
for (const call of allToolCalls) emitToolCall(call);
```

---

## Bug 3: `text_end` Event Emitted with Wrong `contentIndex` (Text in Wrong Widgets)

**Severity:** Medium  
**Lines:** ~135-141 (`closeTextBlock` function)

**Root Cause:**  
`closeTextBlock()` emits `contentIndex - 1` as the `text_end` index. But if a tool call was emitted between `startTextBlock` and `closeTextBlock`, `contentIndex` has been incremented by `emitToolCall()`. So `contentIndex - 1` points to the **tool call's** index, not the text block's.

**Example trace:**
1. `startTextBlock()` → `contentIndex` is 0, text_block at index 0
2. `emitToolCall(read)` → `contentIndex` becomes 1
3. `closeTextBlock()` → emits `text_end` with `contentIndex: 0` (1-1=0, correct)

But if tool call came first:
1. `emitToolCall(read)` → `contentIndex` is 0, toolcall at index 0, then `contentIndex` becomes 1
2. `startTextBlock()` → text_block at index 1, `contentIndex` becomes 2
3. `closeTextBlock()` → emits `text_end` with `contentIndex: 1` (2-1=1, **correct only by luck because we started after tool call**)

If there's NO tool call:
1. `startTextBlock()` → text_block at index 0, `contentIndex` becomes 1
2. `closeTextBlock()` → emits `text_end` with `contentIndex: 0` (1-1=0, correct)

**The real bug:** If a tool call is emitted BETWEEN two text blocks:
1. `startTextBlock()` → text_block_1 at index 0, contentIndex=1
2. `closeTextBlock()` → text_end at index 0 (1-1=0, correct)
3. `emitToolCall(read)` → toolcall at index 1, contentIndex=2
4. `startTextBlock()` → text_block_2 at index 2, contentIndex=3
5. `closeTextBlock()` → text_end at index 2 (3-1=2, **correct in this case**)

The computation `contentIndex - 1` happens to work in most cases but is **fragile** — it assumes text was the last thing pushed before close. If any other content was pushed between the text start and close, the index is wrong.

**Fix:** Store `textBlockIndex` at creation time in `startTextBlock()`, use that stored value in `closeTextBlock()`.

```typescript
let textBlockIndex = -1; // NEW: capture at creation

function startTextBlock() {
  textBlockIndex = contentIndex; // FIXED: store at creation
  // ...
}

function closeTextBlock() {
  if (textStarted && textBlock && textBlockIndex >= 0) {
    stream.push({ type: "text_end", contentIndex: textBlockIndex /* FIXED */, ... });
  }
}
```

---

## Bug 4: No Tool Argument Validation (Tools Called with Incorrect Params)

**Severity:** High  
**Lines:** ~150-160 (`emitToolCall` function)

**Root Cause:**  
Raw arguments extracted from text (via regex or XML) are passed directly to Pi's tool executor. No validation against the tool's `parameters` schema. If the model outputs typos like `{"pth": "foo.ts"}` (missing 'a'), `{"comand": "ls"}` (typo), or wrong types, it propagates.

**Impact:** Tools receive arguments with wrong keys causing silent failures or execution with incorrect params.

**Fix:** Add a `validateToolArgs()` function that:
1. Matches exact schema keys
2. Corrects close Levenshtein-distance typos (e.g., "pth" → "path", distance=1)
3. Filters out keys that don't match any schema property or look like garbage

```typescript
function validateToolArgs(call: ParsedToolCall, tools: ToolSchema[]): ParsedToolCall {
  const tool = tools.find(t => t.name === call.name);
  if (!tool?.parameters?.properties) return call;

  const schema = tool.parameters.properties;
  const validated: Record = {};

  for (const [key, def] of Object.entries(schema)) {
    if (key in call.arguments) {
      validated[key] = call.arguments[key];
      continue;
    }
    // Levenshtein correction for close typos
    const close = Object.keys(call.arguments).find(
      k => levenshteinDistance(k, key)  2 && k.length >= key.length - 2
    );
    if (close) validated[key] = call.arguments[close];
  }

  // Carry over extra valid-looking keys
  for (const [key, val] of Object.entries(call.arguments)) {
    if (!(key in validated) && /^[a-zA-Z_]\w{0,30}$/.test(key)) {
      validated[key] = val;
    }
  }

  return { name: call.name, arguments: validated };
}

// Use in emitToolCall:
function emitToolCall(call: ParsedToolCall) {
  closeTextBlock();
  const validated = validateToolArgs(call, context.tools || []);
  const toolCall = { ...name: validated.name, arguments: validated.arguments };
  // ...
}
```

---

## Bug 5: Greedy Regex in `extractToolColonCalls` Matches Across Call Boundaries

**Severity:** Medium  
**Lines:** ~50-55

**Root Cause:**  
The regex `/(\{[\s\S]*\})/g` uses greedy `[\s\S]*` which matches across multiple JSON objects. If the model outputs two tool calls, the greedy match captures both as one malformed JSON blob.

**Fix:** Use a non-greedy balanced-brace pattern instead:

```typescript
// BEFORE (greedy, broken):
const re = /Tool:\s*(\w+)\s*\n+\s*Arguments:\s*(\{[\s\S]*\})/g;

// AFTER (non-greedy, balanced):
const re = /Tool:\s*(\w+)\s*\n+\s*Arguments:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/g;
```

This pattern matches individual JSON objects with nested braces up to depth 2 (sufficient for tool arguments like `{"path": "foo.ts", "offset": 10}`).

---

## Bug 6: SAX-Wasm XML Parser Not Initialized Before First Chunk

**Severity:** Low-Medium  
**Lines:** ~160-166

**Root Cause:**  
`xmlParser.init()` is async (reads a WASM file from disk). The stream processing starts immediately without awaiting it. On the first ~100ms of streaming, `xmlParser.isReady` is `false`, so XML tool calls in early chunks are silently missed.

**Fix:** `await xmlParser.init()` before entering the stream processing loop.

```typescript
// BEFORE:
const xmlParser = new XmlToolCallParser();
let xmlFailed = false;
xmlParser.init().catch(() => { xmlFailed = true; });
// ... immediately start for-await loop

// AFTER:
const xmlParser = new XmlToolCallParser();
let xmlFailed = false;
try {
  await xmlParser.init();
} catch {
  xmlFailed = true;
}
// ... now start for-await loop with parser ready
```

---

## Bug 7: `setImmediate` Per Chunk Adds Latency

**Severity:** Low  
**Line:** ~169

**Root Cause:**  
`await new Promise(r => setImmediate(r))` adds a microtask delay per SSE chunk (potentially hundreds per response).

**Fix:** Remove the `setImmediate`. With the new two-phase approach (collect all text then parse), there's no need for per-chunk yields since we're not doing heavy parsing mid-stream.

```typescript
// BEFORE:
for await (const event of parseSseStream(resp.body)) {
  await new Promise(r => setImmediate(r)); // REMOVE

// AFTER:
for await (const event of parseSseStream(resp.body)) {
  // process directly
```

---

## Summary of All Changes

| # | Fix | Lines Affected |
|---|-----|----------------|
| 1 | Parse tool calls only at stream end, not mid-stream | ~22-230 |
| 2 | Don't terminate stream on first tool call; collect all | ~175-230 |
| 3 | Store `textBlockIndex` at creation time | ~135-141, ~145-150 |
| 4 | Add `validateToolArgs()` with Levenshtein correction | New function |
| 5 | Fix greedy regex → balanced-brace pattern | ~50-55 |
| 6 | `await xmlParser.init()` before loop | ~160-166 |
| 7 | Remove `setImmediate` per-chunk delay | ~169 |

**Recommended approach:** Rewrite the streaming function with a clear two-phase design:
1. **Phase 1:** Collect all text from SSE stream, emit `text_delta` events for real-time UI
2. **Phase 2:** Parse tool calls from final accumulated text using all parsers
3. **Phase 3:** Emit all detected tool calls, close text block, end stream

This eliminates all 7 bugs at once while being simpler and more maintainable.
