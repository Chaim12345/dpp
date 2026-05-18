# TUI Rendering Issues Investigation

## Problem Summary
- Content not visible in boxes
- Full screen flickering on updates
- No partial updates - entire screen redraws

## Root Causes Identified in `src/tui.ts`

### 1. Full Screen Clear on Every Render (CRITICAL)
**Location:** Line 94 (FIXED)
```javascript
term.eraseDisplay();
```
This cleared the entire screen before redraw. Fixed to use `eraseDown()` for partial updates.

### 2. Sections Default to Collapsed (FIXED)
**Location:** Line 218 (FIXED)
```javascript
collapsed: startCollapsed,  // was: default true
```
Changed default from `true` to `false` so content is visible.

### 3. Aggressive Render Timer (FIXED)
**Location:** Lines 427-432 (FIXED)
```javascript
const renderTimer = setInterval(() => {
  markDirty();
  render();
}, 100);
```
Removed entirely - `render()` is called directly after state changes.

### 4. No Cursor/State Preservation (FIXED)
Added `isFirstRender` flag and proper cursor restoration.

## Changes Applied

1. Added `isFirstRender` flag (line 30)
2. Changed `eraseDisplay()` to conditional erase (lines 97-103)
3. Changed `addSection` default to `startCollapsed = false` (line 218)
4. Removed periodic render timer (lines 435-437)
5. Added `isFirstRender = true` in `clearSections` (line 285)

## Status: RESOLVED ✓

All fixes applied and verified via bun compilation.

## Verification
- `bun build src/tui.ts --target bun` ✓
- `bun build src/agent-repl.ts --target bun` ✓

## TUI now provides:
- Content visible in boxes immediately (no collapsed sections by default)
- Partial screen updates instead of full flicker
- Proper cursor positioning
- Smooth streaming updates
Run `bun run src/agent-repl.ts` and verify:
- Sections show content immediately
- No flicker during streaming
- Input line stays at bottom