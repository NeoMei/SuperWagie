# UniHub model transport

## Ownership

This module owns SuperWagie's managed quukk provider, authenticated task admission, the local model proxy and its durable journal. `platform-account` owns the bounded OIDC session. UniHub owns membership and credits. llmrouter owns model selection, upstream attempts, usage and settlement.

Web and Electron use the managed backend. External OpenCode has no managed plugin and refuses this feature. VS Code has no corresponding server and does not offer platform account controls. Hosted mobile and Capacitor retain an explicit unsupported platform account page. No relay wire format changes.

## Invariants

- `OPENCHAMBER_UNIHUB_GATEWAY_URL` pins an HTTPS gateway, or a loopback HTTP gateway for development, with `/platform/v1` as its path. `OPENCHAMBER_UNIHUB_MODELS` is a JSON array of `{id,name,context,maxOutput}`. Missing configuration leaves ordinary providers unchanged.
- The managed config adds provider `unihub`, displayed as `quukk`, and the plugin together. Its default base URL is an unusable loopback destination. Only an admitted plugin call can use the live proxy. The user selects quukk in the ordinary model picker. Existing BYOK and default selections remain unchanged.
- Enterprise mode refuses provider admission and gateway IO at every use. The provider is omitted from managed config while enterprise mode is active. There is no new administrator policy exception.
- A verified runtime auth identity, verified UniHub actor, selected account, source product, server-generated task ID, OpenCode session and model establish an immutable binding before model IO. A later account selection cannot change it. A different browser/device identity cannot inherit it, including when logged in to the same UniHub user.
- The ordinary prompt route verifies the authoritative OpenCode session and records the exact user message ID. It parses at most 1 MiB of uncompressed JSON only for the selected platform provider. The OpenCode proxy replays the parsed body with corrected framing; BYOK request streams remain untouched. Each model hook verifies that the session still refers to that prompt and has not crossed an idle boundary. Internal/control prompts without admission, child sessions, auxiliary generation, command execution and resumed turns fail before model IO. Unsupported session mutation cannot change a bound task's payer.
- A primary tool loop uses a new logical call ID per generation. The journal commits PREPARED then DISPATCHED and a request digest before network IO. Digests detect conflicting replay and never derive call identity. An existing dispatched call is never posted to llmrouter again.
- The dedicated listener binds `127.0.0.1` on a random port and requires a private per-runtime capability. No public session metadata or actor/account header can pick a payer. Login access tokens and model capabilities remain in backend memory. Only the private callback capability reaches the managed child environment.
- Gateway requests use a restricted model capability for the saved account and task, exact model allowlist, bounded output and usage-enabled Chat SSE. The proxy does not debit cash or calculate charges.
- Stream output is journaled before forwarding. A clean completion requires `[DONE]` and EOF. Transport failure, abort, malformed SSE or missing completion retains an unresolved call. Automatic client retries are disabled, and the legacy limit-failover plugin does not switch a UniHub call to another provider. Gateway retries use the original durable call.
- Receipt GET authenticates the same actor/account/task/model. It never calls the model. SETTLED, RELEASED or REJECTED permit a future generation. Missing receipt, pending settlement and UNKNOWN keep the task blocked. Reconciliation of PREPARED is safe because gateway IO has not begun.
- A gateway rejection before durable admission may have no receipt. HTTP 400 or a later receipt 404 alone does not establish a reusable terminal result, so that task remains blocked for reconciliation and operator investigation. The current protocol does not automatically recover this case. A new, explicitly created session has its own task binding; it does not clear or replay the unresolved call.
- The journal is private, schema-validated and atomically replaced after fsync. It stores no prompt text, output text, access token or model capability. A kernel-owned SQLite exclusive transaction in `writer-guard.sqlite` serializes writer acquisition and remains held through shutdown. The guard contains no journal records and is never deleted or replaced. Existing guard files are inspected without raw filesystem opens, so an unrelated descriptor close cannot release process-scoped locks during acquisition.
- The legacy `writer.lock` remains for compatibility with older writers. A complete, synced PID/UUID record is published with exclusive hard-link creation. While holding the kernel guard, only an exact valid owner record whose PID reports `ESRCH` can be reclaimed. Live, permission-denied and malformed owners remain protected. A second writer fails, and process death releases the kernel guard automatically. `state.json`, task identity and unresolved call states survive recovery unchanged.
- A journal that cannot be opened disables the platform model transport for that runtime and reports a stable error. Ordinary providers and application startup remain available. The managed provider, plugin and callback capability are withheld; platform admission, reconciliation and model IO remain refused. Corrupt state and the 32 MiB capacity bound fail closed. After restart a new authenticated admission from the original runtime identity is required.
- GET `/api/platform-model/sessions/:sessionID` returns payer/model and call states to the bound runtime identity. POST `/reconcile` additionally requires a trusted request origin. An unresolved status is visible to the UI; no response claims a successful refund or free generation without a gateway receipt.

## Decisions

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
