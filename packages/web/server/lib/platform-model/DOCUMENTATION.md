# UniHub model transport

## Ownership

This module owns SuperWagie's managed quukk provider, authenticated task admission, the local model proxy and its durable journal. `platform-account` owns the bounded OIDC session. UniHub owns membership and credits. llmrouter owns model selection, upstream attempts, usage and settlement.

Web and Electron use the managed backend. External OpenCode has no managed plugin and refuses this feature. VS Code has no corresponding server and does not offer platform account controls. Hosted mobile and Capacitor retain an explicit unsupported platform account page. No relay wire format changes.

The product currently starts this transport with new managed dispatch suspended.
The account, BYOK and local-model paths remain available. Existing authenticated
owners can inspect and reconcile journaled calls, but cannot start a new managed
call. This safeguard takes effect when the updated server starts; an older server
process must be stopped or restarted to revoke its existing listener and token.

## Invariants

- `OPENCHAMBER_UNIHUB_GATEWAY_URL` pins an HTTPS gateway, or a loopback HTTP gateway for development, with `/platform/v1` as its path. `OPENCHAMBER_UNIHUB_MODELS` is a JSON array of `{id,name,context,maxOutput}`. Missing configuration leaves ordinary providers unchanged.
- The managed config adds provider `unihub`, displayed as `quukk`, and the plugin together. Its default base URL is an unusable loopback destination. The user selects quukk in the ordinary model picker. Existing BYOK and default selections remain unchanged.
- **The current child-process capability is not a trusted caller boundary.** A
  controlled OpenCode test showed that a shell child can inherit the callback
  token and submit a forged request while a prompt is active. The listener's
  prompt checks do not distinguish that request from the plugin. Do not treat
  this implementation as isolated or ready for production paid model access
  until a trusted execution boundary has been implemented and verified.
- Enterprise mode refuses provider admission and gateway IO at every use. The provider is omitted from managed config while enterprise mode is active. There is no new administrator policy exception.
- Product startup irrevocably suspends new managed model admissions, dispatches,
  plugin creation and child-token injection. The low-level transport remains
  independently testable, but product entrypoints use the suspended factory.
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
- The dedicated listener binds `127.0.0.1` on a random port and requires a per-runtime callback capability. No public session metadata or actor/account header can pick a payer. Login access tokens and model capabilities remain in backend memory. The callback capability reaches the managed child environment and can be inherited by its shell children; it must not be treated as proof of a trusted plugin caller.
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
- The journal is private, schema-validated and atomically replaced after fsync. It stores no prompt text, output text, access token or model capability. A second writer for the same data directory fails. Existing locks, including stale locks, are never removed automatically. Corrupt state and the 32 MiB capacity bound fail closed. After restart a new authenticated admission from the original runtime identity is required.
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

### Why product dispatch is suspended

The current callback token is inherited by ordinary OpenCode shell children,
which can imitate a model hook while an agent prompt is active. Suspending new
work preserves history and reconciliation while a caller-authentication boundary
is established; hiding the provider alone would not protect an existing token.

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

The journal uses fsync and atomic replacement, with an exclusive lock spanning its lifetime. Cross-process coordination of simultaneous billing writers would require a transactional store. Configured platform services sharing a data directory refuse the second writer; separate instances can use separate data directories.

Graceful shutdown closes admission, aborts active proxy responses, waits for their final journal writes, and removes only the process's own lock before exiting. After a crash, an administrator must stop all instances using that data directory, verify no such process remains, preserve `state.json`, and remove only `unihub-model/writer.lock` before starting one instance. A stale-PID check followed by unlink is unsafe because competing starters can replace the file between those operations. Unresolved calls remain in `state.json` and require gateway receipt reconciliation after restart.
