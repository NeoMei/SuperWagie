# Creation artifact opening

## Ownership

`openWorkArtifact` discovers and opens a work's latest deliverable. Session artifact extraction owns named paths; RuntimeAPIs owns filesystem access; FilesView owns rendering and its existing permissions. Creation directory setup and SourceBoard navigation are separate callers.

## Invariants

- Prefer the newest assistant-named artifact, then retain the existing output-folder search and modification-time ordering. Work directories need not be registered projects; guest `open-file` has a separate registered-owner gate.
- Open absolute targets under the main chat's current effective tab directory, without changing its session, draft, active project, or global directory.
- Derive the actual content root with the same pending-space state and `panelContentDirectory` as FilesView. A preparing space has no root. Source directories and discovered targets must match this root's space ID before stat/list or opening; null space IDs mean the same host, not permission to cross into a space.
- Stat retains an explicit content directory. Recheck runtime, tab directory, and content root after asynchronous discovery and before further reads or opening. Refusal leaves tabs and overlays unchanged.
- Results distinguish `opened`, `refused`, and `not-found`. Only `not-found` permits SourceBoard's existing folder fallback, with a captured `canOpenFolder` check before the native operation and again before a delayed file-surface fallback. This check becomes false after runtime, tab-directory, or content-root changes. Space directories never go to the host's file manager.
- If the native folder open is unavailable, the internal tree can open only when the source equals the captured actual content root (using existing Windows path equivalence). Its tab uses the captured panel key, including ready space drafts. Open the tab idempotently and reveal the tree; do not toggle an already-open panel closed. A different root remains unopened with the overlay intact: file tabs and the tree have no independent root override, and changing navigation or pretending the current tree shows another folder would violate their contract.
- No new outside-workspace grant, HTML CSP exception, or containment bypass is introduced.

## Decisions

### Why tab ownership differs from file ownership

Selecting the artifact's project cannot change which session or draft the context panel follows. Keep the visible tab key and validate the content route separately, including ready pending spaces whose content root differs from that key.

### Why discovery rechecks its captured panel

A file stat or folder listing may complete after navigation or a pending-space transition. Discard that result rather than opening into a different panel or continuing discovery on another runtime.

### Why missing artifacts and refused opens are separate outcomes

Both used to return false, so SourceBoard opened a folder even when the artifact was rejected. An explicit reason preserves ordinary no-artifact navigation without turning a security or readiness refusal into a second opening attempt.
