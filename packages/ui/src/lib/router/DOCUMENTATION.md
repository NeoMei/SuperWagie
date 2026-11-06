# URL routing

## Ownership

The router parses and serializes app URL state. `useRouter` applies routes to
the session and UI owners. `notificationNavigation` routes browser notification
clicks and service-worker requests through the mounted router. The web service worker owns
window focus, acknowledgement deadlines, and document-navigation fallback.

## Invariants

- Web and hosted-mobile PWA notifications use the mounted router for same-origin,
  same-path navigation. Native notification adapters retain their own entrypoints.
- Browser-created notifications use the same router even without service-worker
  support. A mounted router registers its callback for its lifetime; unmounting
  releases it. A missing or declining router leaves document fallback available.
- A request is acknowledged only when the router accepts it. An overlapping synchronous
  route application, an old page without a listener, and an expired request cannot claim acceptance.
- Acceptance does not wait for network-backed session resolution. The existing
  session-link owner resolves the directory and guards against later selection.
- The worker focuses before messaging and waits at most 1500 ms for acceptance.
  Missing or negative acknowledgement falls back to document navigation; a closed
  client does not prevent trying another client or opening a window.
- Message ports and listeners are released after use. Expired requests cannot
  navigate a page after the worker's fallback deadline.
- Accepted routes and session links retire the optional startup workbench
  landing before asynchronous session resolution. This intent survives layout
  mounting and guest discovery. Serializing an automatically restored session
  into the URL does not retire it.
- Session selection, Settings and initial URL normalization apply synchronously.
  A pending global-session read cannot close Settings, replace its page or write
  an older session URL after a user navigates.
- Legacy workspace surfaces wait for session-directory confirmation. A newer
  route, Settings or context-panel choice, session selection, unmount or runtime
  change retires that pending surface. Subscriptions last only until cancellation
  or completion. Session-link directory correction retains its own selection guard.

## Decisions

### Why acknowledged app navigation and not unconditional document navigation

Document navigation reloads the running PWA and discards its in-memory state.
A per-click message port lets a mounted router take ownership without reloading,
while a bounded fallback supports older or unresponsive pages during updates.

### Why only workspace surfaces await session resolution

Settings and URL state depend on the synchronously selected session ID. Waiting
for the global list lets captured route values overwrite later user choices.
Legacy context panels are keyed by directory, so they still wait for the owning
worktree and apply only while their navigation remains current.
