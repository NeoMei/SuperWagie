# Worktree reads

## Ownership

This module resolves project roots and lists worktree topology through the runtime Git API. The sidebar owns publication of that topology into the session stores.

`worktreeRetention.ts` owns the explicit keep-sessions removal path shared by the desktop and mobile dialogs. `worktreeRemovalFlow.ts` owns its ordering and partial-result contract. Session actions own native activity reads and local relocation. The existing archive path remains the default.

## Invariants

- A worktree list belongs to the instance where it started. An instance change stops it before another request or cache write, including a return to the original instance.
- A root-branch lookup checks its instance owner after resolving the root and before reading that root's status.
- A topology invalidation within the same instance may retry the list, bounded by the existing convergence limit. Same-instance transport changes keep that behavior.
- Failed or retired lists reject. They cannot stand in for an authoritative empty worktree list.
- Keeping sessions requires complete native global pages, including archived sessions, descendants and checkout subfolders. Sidebar visibility never establishes completeness.
- Source and destination paths must exist and resolve through the runtime Git validator. A destination must sit in the same repository's primary checkout, outside the checkout being removed. Canonical primary roots must match exactly before migration and at the final removal guard. A nested independent repository cannot gain ownership through a path prefix.
- Source scans check both stored path spelling and canonical placement. A stored path inside the removed checkout that resolves outside it, or stops resolving, blocks retention. Alias paths outside the checkout that resolve inside it remain linked sessions.
- Running agents, queued inbox work, permission requests, forms and background jobs stop retention. Failed, malformed or unsupported native activity reads are unknown and stop it too.
- Children move before parents in each folder. Every group needs native placement readback before the next group and before deletion. A final complete source scan rejects remaining or newly created sessions.
- The removal manager calls the retention guard after optional remote-branch work and immediately before native Git removal. It checks the captured instance before the request and before publishing topology cleanup.
- An instance change stops later requests and local publication. Already issued server mutations can complete on their original server and require location review.
- Applied groups remain visible in their projects after a later failure. Partial errors report confirmed moved IDs. Retained sessions keep their open tabs and work state.
- Web, Electron, VS Code, hosted mobile and Capacitor mobile use this same flow. Missing native activity or canonical-path support preserves the checkout; the archive choice stays available.

## Decisions

### Why topology revisions and instance ownership are separate

A topology change requires another read of the same project. An instance change makes that project's path obsolete. Retrying both through one generation check sent the old path to the new instance, so reads now retain an instance predicate separately from the topology revision.

### Why retention confirms the native directory before deletion

OpenCode admits a move to its inbox before applying it. The optimistic sidebar update cannot prove the source location is unused. Bounded session reads through each destination establish placement, and complete source reads run again after slow remote work.

### Why applied retention moves stay in the project

Moving back adds another native command whose outcome can also become unknown. Successful groups remain usable in their confirmed project, while failed or uncertain groups keep the source checkout for review and retry. Ordinary chat-to-worktree moves retain their existing rollback behavior.

### Why Hy entries are not relabeled during a move

Conversation memory owns source revisions and authoritative project revalidation. Its source-move path invalidates entries and jobs in the old project, and recall rechecks moved sources even after downtime. Retention uses native moves and preserves this ownership instead of rewriting stored memory or transferring consent.

### Why retention compares repository identities and both path forms

A directory below a primary checkout can become an independent nested repository.
Its own canonical primary root identifies different ownership. Stored session
paths also depend on the directory spelling: removing a checkout removes its
outward symlinks even though their targets still exist. Exact primary-root
comparison and raw-path disagreement checks preserve these sessions until their
safe placement is confirmed.
