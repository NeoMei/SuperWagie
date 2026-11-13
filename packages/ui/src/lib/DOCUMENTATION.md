# Shared runtime HTTP transport

`messageSearchNavigation.ts` owns opening indexed-message hits from the sidebar,
archive and command palette. It selects the authoritative session directory and
reveals the matched reasoning message when needed. Search components contain
only their rendering exports.

## Ownership

`runtime-fetch.ts` resolves shared runtime HTTP requests, preserves request data,
applies runtime auth and proxy headers, routes requests through the selected
relay or direct transport, and coalesces eligible concurrent reads. Feature
stores own their catalogs and reject responses from retired owners.

`runtime-auth-expiry.ts` confirms suspicious HTTP responses against
`/auth/session` and publishes shared session expiry. Login gates and native
mobile connection orchestration own their respective authentication flows.

## Invariants

- Coalescing applies only to allowlisted GET reads with matching resolved URL
  and directory header. Signal-bearing requests remain independent.
- Every entry captures its runtime instance when the call begins, before async
  header preparation. A retired call cannot join or replace current entries.
- A runtime round trip retires prior entries even when the URL and directory
  match again. Same-instance credentials retain existing coalescing behavior.
- Each caller gets an independently readable response clone. An entry is removed
  when it settles only if the map still contains that exact entry.
- RuntimeFetch and the installed fetch bridge capture relay selection, resolved
  destination, native dispatch and credential inputs before awaiting headers.
  A runtime switch cannot redirect an earlier call or supply its credentials.
- Retired calls still dispatch through their captured transport. Only current
  calls participate in read coalescing. Explicit auth, method, body, signal,
  query, subpath and proxy headers keep their transport contracts.
- Direct bridge calls preserve external passthrough and do not gain directory
  options or read coalescing. RuntimeFetch supplies those caller contracts.
- A credential provider returning null uses the fallback bearer captured when
  credential preparation began. URL-token minting rejects a changed auth
  generation before dispatch and rejects stale responses from issued requests.
- This transport adds no background work.
- Session-expiry confirmations capture the runtime instance before the deferred
  transport import and validate it before dispatch and result publication.
  Each current instance owns its pending confirmation and 15-second suspicion
  throttle. Retired completions release only their own pending state.
- Issued confirmation requests may finish after a switch, but their results
  cannot affect another instance, including an A-to-B-to-A visit. Same-instance
  credential changes preserve confirmation ownership. Focus and visibility
  revalidation retain one shared 5-minute window interval.

## Decisions

### Why reads capture the runtime instance before preparing headers

Header preparation can await an asynchronous credential provider while the user
switches runtimes. URL and directory alone can also match again after an
A-to-B-to-A visit. Capturing the existing runtime owner preserves isolation
through both cases without adding another runtime generation or a transport
cache lifetime.

### Why prepared requests bypass the installed router

The installed window fetch bridge shares the global fetch binding. Sending a
prepared request through that binding resolves its destination again after
credentials have awaited. Both entry points prepare once and dispatch through
the captured native fetch or relay. A replaced fetch adapter remains selected
at call time, including the VS Code webview adapter.

### Why URL-token minting checks the auth generation before dispatch

Minting awaits credentials before choosing its transport. A switch during that
wait invalidates the mint, so dispatch must stop before reading the new runtime's
URL, headers or relay. The existing response-generation check still prevents an
already-issued mint from publishing a token after credentials change.

### Why expiry confirmations keep their captured scheduling state

A pending confirmation and its throttle can outlive a runtime switch. Keeping
them with the captured instance lets the current instance confirm its own
session immediately and prevents an old finalizer from releasing its pending
work. The state is replaced lazily using the existing runtime-instance predicate;
no runtime listener or retained per-instance map is needed.
