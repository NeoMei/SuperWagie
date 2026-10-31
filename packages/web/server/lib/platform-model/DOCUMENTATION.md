# UniHub model transport

## Ownership

This module owns SuperWagie's managed quukk provider, authenticated task admission, the local model proxy and its durable journal. `platform-account` owns the bounded OIDC session. UniHub owns membership and credits. llmrouter owns model selection, upstream attempts, usage and settlement.

Web and Electron use the managed backend. External OpenCode has no managed plugin and refuses this feature. VS Code has no corresponding server and does not offer platform account controls. Hosted mobile and Capacitor retain an explicit unsupported platform account page. No relay wire format changes.

The product starts this transport through the trusted managed OpenCode boundary.
The account, BYOK and local-model paths remain available. A product runtime must
be created with the trusted boundary enabled; isolated callers and tests retain
the suspended factory until that option is present.

## Invariants

- `OPENCHAMBER_UNIHUB_GATEWAY_URL` pins an HTTPS gateway, or a loopback HTTP gateway for development, with `/platform/v1` as its path. `OPENCHAMBER_UNIHUB_MODELS` is a JSON array of `{id,name,context,maxOutput}`. Missing configuration leaves ordinary providers unchanged.
- The managed config adds provider `unihub`, displayed as `quukk`, and the plugin together. Its default base URL is an unusable loopback destination. The user selects quukk in the ordinary model picker. Existing BYOK and default selections remain unchanged.
- **The legacy child-process capability is not a trusted caller boundary.** A
  controlled OpenCode test showed that a shell child can inherit the callback
  token and submit a forged request while a prompt is active. Product startup
  now gives the managed plugin a one-time bootstrap over OpenCode's private
  parent IPC channel. The plugin creates its HMAC key in memory and signs each
  loopback request; the bootstrap is consumed once and the generated plugin
  directory is removed. The legacy bearer is accepted only by the isolated
  low-level test factory and is never injected into the product child.
- Enterprise mode refuses provider admission and gateway IO at every use. The provider is omitted from managed config while enterprise mode is active. There is no new administrator policy exception.
- Product startup uses the trusted IPC factory. If that boundary is absent, the
  low-level factory still suspends new admissions and does not expose a usable
  product provider.
- `historyAvailable()` indicates that a configured, managed runtime has an open
  journal and enterprise policy permits access. It does not grant access to a
  task: every history and reconciliation request still checks its authenticated
  owner, actor and payer. It remains true when new dispatch is suspended.
- `isMediaOperationConfigured` reports only whether the enabled local runtime
  allows the transport operation and includes the model in its media allowlist;
  it performs no identity, payer, provider capability, tariff or availability
  check and cannot authorize a call.
- Managed synchronous speech, transcription and image generation are temporarily
  unavailable. Their response can be lost after a paid call succeeds, and the
  current client cannot retrieve the original result by call ID. Admission and
  dispatch refuse them until recovery is implemented; image-edit and video use
  their separate asynchronous contracts and remain subject to their own gates.
- The native media transport bounds response bytes while reading, including
  streamed bodies without a Content-Length. Oversized or interrupted responses
  fail without retry; this does not establish that upstream work was unpaid.
- A verified runtime auth identity, verified UniHub actor, selected account, source product, server-generated task ID, OpenCode session and model establish an immutable binding before model IO. A later account selection cannot change it. A different browser/device identity cannot inherit it, including when logged in to the same UniHub user.
- The ordinary prompt route verifies the authoritative OpenCode session and records the exact user message ID. It parses at most 1 MiB of uncompressed JSON only for the selected platform provider. The OpenCode proxy replays the parsed body with corrected framing; BYOK request streams remain untouched. Each model hook verifies that the session still refers to that prompt and has not crossed an idle boundary. Internal/control prompts without admission, child sessions, auxiliary generation, command execution and resumed turns fail before model IO. Unsupported session mutation cannot change a bound task's payer.
- A primary tool loop uses a new logical call ID per generation. The journal commits PREPARED then DISPATCHED and a request digest before network IO. Digests detect conflicting replay and never derive call identity. An existing dispatched call is never posted to llmrouter again.
- The dedicated listener binds `127.0.0.1` on a random port and requires a
  per-runtime HMAC session established over the managed OpenCode parent IPC
  channel. Request nonces are single-use. No public session metadata or
  actor/account header can pick a payer. Login access tokens and model
  capabilities remain in backend memory. The URL may reach the child
  environment, but the HMAC key and bootstrap never do.
- Gateway requests use a restricted model capability for the saved account and task, exact model allowlist, bounded output and usage-enabled Chat SSE. The proxy does not debit cash or calculate charges.
- Stream output is journaled before forwarding. A clean completion requires `[DONE]` and EOF. Transport failure, abort, malformed SSE or missing completion retains an unresolved call. Automatic client retries are disabled, and the legacy limit-failover plugin does not switch a UniHub call to another provider. Gateway retries use the original durable call.
- Receipt GET authenticates the same actor/account/task/model. It never calls the model. SETTLED, RELEASED or REJECTED permit a future generation. Missing receipt, pending settlement and UNKNOWN keep the task blocked. Reconciliation of PREPARED is safe because gateway IO has not begun.
- When dispatch is suspended, reconciliation also queries the original receipt
  for an accepted `ASYNC_PENDING` video or image-edit call. Unknown responses
  preserve its journal state, failed reads fail without changing that state,
  and neither path submits a second task. The original actor and payer are
  checked again after network reads and while writing a terminal receipt.
- The suspended product cannot retrieve historical image-edit or video status
  and output files: their existing skill readback uses the now-closed child
  listener. A financial receipt is not authorization to return private media.
  The gateway's existing media task reads use receipt-purpose credentials, not
  the stricter current-actor result-read authority; do not expose these reads
  through a host endpoint until that boundary and revocation behavior are
  implemented and verified. Settlement readback does not prove artifact recovery.
  The companion gateway source now rejects SuperWagie private video/image-edit
  results, OCR results and native status, output-resource URLs, and video
  cancellation using the original call's product attribution. That protection
  has local fixture evidence only and is not a production deployment claim.
  Existing OCR input URLs retain their bounded lifetime for supplier ingestion.
- Managed media uses the same admitted task and per-model grant for masked image editing and asynchronous video submission. Image editing accepts one bounded source image plus an optional mask and requires inline image output; video returns a provider task ID for the owning consumer to poll.
- A gateway rejection before durable admission may have no receipt. HTTP 400 or a later receipt 404 alone does not establish a reusable terminal result, so that task remains blocked for reconciliation and operator investigation. The current protocol does not automatically recover this case. A new, explicitly created session has its own task binding; it does not clear or replay the unresolved call.
- The journal is private, schema-validated and atomically replaced after fsync. It stores no prompt text, output text, access token or model capability. A kernel-owned SQLite exclusive transaction in `writer-guard.sqlite` serializes writer acquisition and remains held through shutdown. The guard contains no journal records and is never deleted or replaced. Existing guard files are inspected without raw filesystem opens, so an unrelated descriptor close cannot release process-scoped locks during acquisition.
- The legacy `writer.lock` remains for compatibility with older writers. A complete, synced PID/UUID record is published with exclusive hard-link creation. While holding the kernel guard, only an exact valid owner record whose PID reports `ESRCH` can be reclaimed. Live, permission-denied and malformed owners remain protected. A second writer fails, and process death releases the kernel guard automatically. `state.json`, task identity and unresolved call states survive recovery unchanged.
- A journal that cannot be opened disables the platform model transport for that runtime and reports a stable error. Ordinary providers and application startup remain available. The managed provider, plugin and callback capability are withheld; platform admission, reconciliation and model IO remain refused. Corrupt state and the 32 MiB capacity bound fail closed. After restart a new authenticated admission from the original runtime identity is required.
- The isolated `createResilientPlatformModelRuntime` compatibility wrapper uses strict journal opening. It preserves typed lock failures and rejects corrupt state. Product startup uses the default degraded factory, so ordinary providers remain usable when the journal is unavailable. No user setting selects this internal policy.
- Gateway receipt and video status metadata are read from bounded streams;
  oversized, interrupted, malformed or refused responses leave the original
  call's accounting state unresolved and never trigger another dispatch.
- GET `/api/platform-model/sessions/:sessionID` returns payer/model and call states to the bound runtime identity. POST `/reconcile` additionally requires a trusted request origin. An unresolved status is visible to the UI; no response claims a successful refund or free generation without a gateway receipt.
- GET `/api/platform-model/media-tasks` lists independently admitted media tasks
  with calls for the currently authenticated device, actor and selected payer.
  Its bounded, session-ID-ordered pages do not contain content, credentials or
  digests, and listing neither reconciles nor dispatches a call. Status and
  explicit reconciliation still check the immutable original task scope.
- The account page shows the selected OpenCode chat and paginates independent
  media tasks for the current owner and payer. Those entries provide settlement
  status and a user-initiated receipt check, not access to media artifacts.
  It is not a general account-wide model usage history.

## Decisions

### Why the product boundary is private IPC

The old callback token was inherited by ordinary OpenCode shell children, which
could imitate a model hook while an agent prompt was active. The product now
uses the OpenCode child IPC channel for a one-time bootstrap and keeps the HMAC
key in the plugin process. Shell descendants inherit neither the IPC channel nor
the key, and stale bearer requests are rejected.

### Why synchronous media remains closed

After a disconnected client misses a successful response, a fresh call ID can
dispatch the same work again. A receipt alone cannot reconstruct the missing
output, so this runtime refuses these operations until the caller can
recover the original result without a second dispatch.

### Why quukk keeps the internal provider identifier

The user-facing provider name is quukk. Existing sessions, admission hooks and credit telemetry use the stable `unihub` identifier, so changing the display name preserves their authorization and settlement behavior without migrating saved sessions.

### Why a durable local proxy

The pinned OpenCode hooks have session and model identity but no durable generation ID. A plugin alone loses its state on restart. The proxy stores call intent before IO, so plugin reload and process restart cannot create a second payable attempt for an unresolved task.

### Why gateway retries own recovery

A network failure cannot prove the provider did no work. llmrouter has the durable execution and settlement records, so only that layer can retry an upstream attempt. Client receipt checks preserve the original call and never replay model output.

### Why the initial implementation binds one model per task

Model switching can change the meaning of a pending generation and its rate. A bound platform task keeps its original model. Users create another task to use another platform model. Configured BYOK sessions remain independent.

### Why a shared data directory has one writer

The JSON journal uses fsync and atomic replacement. Its lifetime SQLite guard
provides operating-system exclusion without adding a service or a dependency.
Keeping the legacy owner file excludes older app versions that do not know the
guard. All new reclaimers inspect and replace stale ownership under the same
exclusive transaction, so competing starters cannot remove a newly acquired lock.

Graceful shutdown closes admission, aborts active proxy responses, waits for
their final journal writes, removes only its own legacy owner record, then
releases the guard. After a crash, a later owner can reclaim a complete dead-PID
record without modifying `state.json`. Unresolved calls still require gateway
receipt reconciliation. A malformed record, a live owner, or an unavailable
guard leaves platform models unavailable while the app continues to start.
