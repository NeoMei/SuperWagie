# Chat output folding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded live shell-output preview to the OpenChamber-style activity fold, then hide it automatically when the command settles.

**Architecture:** Add a focused `LiveCommandPreview` component under the chat components folder. It derives the latest running shell from the existing turn activity records, reads output through the existing `useBackgroundShellOutput` polling boundary, and renders a capped `ScrollableOverlay` below the activity header while the main activity fold remains closed. The existing `ToolPart` and activity expansion continue to own full output and controls.

**Tech Stack:** React, TypeScript, existing OpenCode shell projection, `ScrollableOverlay`, Zustand-backed activity state, Vitest/Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-14-chat-output-folded.md`

## Global Constraints

- Use the existing OpenCode SDK and shell output boundary; do not add a route or dependency.
- Use semantic theme tokens and the shared scroll primitive.
- Keep the existing activity header shimmer/breathing effect unchanged.
- Do not expose output from a shell whose authoritative state is not running.
- Preserve full output access through existing activity/tool expansion.
- Run focused chat tests, `bun run check:changed`, and the affected web build before completion.

### Task 1: Derive the latest live shell

**Files:**
- Create: `packages/ui/src/components/chat/components/liveCommandPreviewModel.ts`
- Create: `packages/ui/src/components/chat/components/liveCommandPreview.tsx`
- Test: `packages/ui/src/components/chat/components/liveCommandPreview.test.tsx`

**Interfaces:**
- Consumes: `TurnActivityRecord[]`, effective directory, and the running shell ID reader from `@/lib/opencode/background-shell`.
- Produces: `LiveCommandPreview` component props `{ activities: TurnActivityRecord[]; directory?: string; visible: boolean }` and a stable latest-running-shell selector used by the component.

- [ ] **Step 1: Write the failing selector tests**

Cover latest running shell selection, completed shell exclusion, missing shell ID, missing directory, and a later non-shell tool after a shell.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `bun test packages/ui/src/components/chat/components/liveCommandPreview.test.tsx`

Expected: module or selector failures because the component does not exist.

- [ ] **Step 3: Implement the selector and component shell**

Select from the end of `activities`, require a tool part recognized by `isShellTool`, require a running status, and require `readRunningShellID`. Keep directory undefined until the caller supplies the effective directory.

- [ ] **Step 4: Run selector tests**

Run the same focused test. Expected: PASS.

### Task 2: Render bounded output and auto-follow

**Files:**
- Modify: `packages/ui/src/components/chat/components/liveCommandPreview.tsx`
- Modify: `packages/ui/src/components/chat/components/LiveTurnActivity.tsx`
- Test: `packages/ui/src/components/chat/components/liveCommandPreview.test.tsx`

**Interfaces:**
- Consumes: selector result from Task 1 and `useBackgroundShellOutput(shellID, directory, enabled)`.
- Produces: a preview below the activity header with `data-live-command-preview`, `max-h-40`, internal scrolling, and user-controlled follow behavior.

- [ ] **Step 1: Write rendering tests**

Assert that a running shell renders command output in the preview, output stays inside a capped scroll container, a completed shell renders no preview, and the component does not render for missing scope.

- [ ] **Step 2: Run the focused rendering tests and confirm the expected failures**

Run: `bun test packages/ui/src/components/chat/components/liveCommandPreview.test.tsx`

- [ ] **Step 3: Implement the preview**

Use the existing polling hook, `ScrollableOverlay` with `useScrollShadow`, and a plain `<pre>` with `whitespace-pre-wrap`. Maintain bottom-follow state with a ref. A wheel gesture toward history pauses follow; reaching the bottom resumes it. Render only when `visible && !expanded && shell.status === running`.

- [ ] **Step 4: Mount it in `LiveTurnActivity`**

Pass `turn.activityParts`, the effective directory and `!isExpanded`. Keep the existing header label and shimmer untouched. Place the preview immediately after the header and before the collapsed activity body.

- [ ] **Step 5: Run focused tests**

Run: `bun test packages/ui/src/components/chat/components/liveCommandPreview.test.tsx packages/ui/src/components/chat/components/LiveTurnActivity.test.tsx`

Expected: PASS.

### Task 3: Documentation and regression checks

**Files:**
- Modify: `packages/ui/src/components/chat/message/parts/DOCUMENTATION.md`
- Modify: `packages/ui/src/components/chat/components/LiveTurnActivity.tsx` comments if needed

- [ ] **Step 1: Document ownership and lifecycle**

Record that the live preview is limited to the latest authoritative running shell, bounded, auto-following, and removed on settlement. Record that full output remains owned by `ToolPart`.

- [ ] **Step 2: Run source validation**

Run: `bun run check:changed`

Expected: type-check, lint, dead-code and anti-slop checks pass.

- [ ] **Step 3: Run the affected UI build**

Run: `bun run --cwd packages/ui build`

Expected: build succeeds and emits no new warnings that change behavior.

- [ ] **Step 4: Commit the implementation**

```bash
git add docs/superpowers/specs/2026-11-14-chat-output-folded.md docs/superpowers/plans/2026-11-14-chat-output-folded.md packages/ui/src/components/chat/components/liveCommandPreview.ts packages/ui/src/components/chat/components/liveCommandPreview.test.tsx packages/ui/src/components/chat/components/LiveTurnActivity.tsx packages/ui/src/components/chat/message/parts/DOCUMENTATION.md
git commit -m "feat(chat): fold live command output into activity"
```
