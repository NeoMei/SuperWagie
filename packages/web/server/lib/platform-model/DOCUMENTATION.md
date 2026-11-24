# UniHub model transport

## Ownership

This module owns SuperWagie's managed quukk provider, authenticated task admission, the local model proxy and its durable journal. `platform-account` owns the bounded OIDC session. UniHub owns the managed product model policy, membership and credits. SuperWagie chooses the next product model for a managed chat. LLMRouter selects the upstream channel and handles provider attempts, usage and settlement.

Web and Electron use the managed backend. External OpenCode has no managed plugin and refuses this feature. VS Code has no corresponding server and does not offer platform account controls. Hosted mobile and Capacitor retain an explicit unsupported platform account page. No relay wire format changes.

The product starts this transport through the trusted managed OpenCode boundary.
The account, BYOK and local-model paths remain available. A product runtime must
be created with the trusted boundary enabled; isolated callers and tests retain
the suspended factory until that option is present.

## Invariants

- A bounded gateway HTTP 413 with exact `request_too_large` or
  `platform_request_body_too_large` maps to `platform_gateway_request_too_large`.
  Only the latter code together with `stage: pre_admission` proves that this
  attempt was refused before admission: the current DISPATCHED call becomes
  REJECTED with that proof, without requesting a nonexistent billing receipt.
  Legacy, missing-stage and other-stage size refusals still query the original
  receipt; an unconfirmed call remains UNKNOWN and blocked. Size refusals save
  only the final request's UTF-8 byte count, never its contents. Historical
  UNKNOWN records are not rewritten, no zero charge is invented, and neither
  size error triggers recharge or automatic replay.
- A managed chat HTTP 402 with `platform_insufficient_funds` or legacy `platform_billing_unavailable` maps to a funding refusal only when the same call has a verified REJECTED receipt. A REJECTED receipt may contain an empty `charged` string; this means no amount was supplied, never zero. Other statuses still reject empty amounts. A receipt with a conflicting terminal status cannot overwrite the confirmed state or its amount. Otherwise the existing incomplete-call path preserves reconciliation. Refreshing or funding the account never replays a prompt; the user may send a new one after resolving the shortage.

- `OPENCHAMBER_UNIHUB_GATEWAY_URL` pins an HTTPS gateway, or a loopback HTTP gateway for development, with `/platform/v1` as its path. `OPENCHAMBER_UNIHUB_MODELS` is a JSON array of `{id,name,context,maxOutput}`. Missing configuration leaves ordinary providers unchanged.
- The managed config adds provider `unihub`, displayed as `quukk`, and the plugin together. Its default base URL is an unusable loopback destination. The picker shows the primary chat model from the published product policy. Newly admitted generations use the current product primary. An existing session may rebind to that primary after reconciliation of its outstanding calls, keeping the original payer, task and call receipts. BYOK providers use their own configuration.
- The managed transport reads `GET /v1/products/superwagie/managed-models` from the configured UniHub origin. This response carries a product version and ordered model IDs by operation. Missing operations inherit the previous product behavior and empty lists disable the operation. A failed read blocks new managed dispatch once the 30-second local snapshot expires. The isolated product proxy also checks current policy for new requests. It accepts historical receipt reads with the originally admitted model and payer.
- **The legacy child-process capability is not a trusted caller boundary.** A
  controlled OpenCode test showed that a shell child can inherit the callback
  token and submit a forged request while a prompt is active. Product startup
  gives the managed plugin a bootstrap bound to OpenCode's private parent IPC
  channel. OpenCode loads a separate plugin instance for each location, so each
  instance creates an independent HMAC key in memory and registers it through
  that same child channel. Duplicate handshake nonces and another live child
  are refused. A child has at most 128 signing sessions, including reloads;
  further registrations receive `platform_ipc_session_limit` without evicting
  working sessions. Each session accepts at most 4096 request nonces (16–128
  base64url characters), then returns HTTP 429 `platform_ipc_request_limit`.
  Nonces are never evicted to make room for replay. Reaching either limit
  requires a managed child restart. Disconnect or exit revokes the child's
  signing sessions and prompt permits, aborts active streams through the usual
  journal path, and invalidates pending admissions by generation. Admissions
  remain closed until a replacement child registers; its prompts require fresh
  admission. Tasks, calls and reconciliation identities remain intact. Exit releases
  the child binding so a managed restart can register new instances. The
  generated plugin directory remains until instance shutdown. The legacy bearer is accepted only by the isolated
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
- Product-scoped synchronous speech, transcription and image generation retain
  the logical call ID. A retry reads the settled artifact by that original ID
  and verifies its checksum, scope and receipt. The legacy synchronous task
  path remains closed. Image edit and video use their original asynchronous
  status and result contracts, with the original billing scope recorded.
- When the product broker is configured, the generated signed plugin registers
  `superwagie_managed_media`. A tool action requires the current admitted
  OpenCode session, fixed certified operation and model, and permitted actor
  and payer. Media file inputs resolve inside the authoritative session
  workspace. Validated outputs are published under a stable filename by
  exclusive write, then returned as path and digest. The same call ID drives
  read-only recovery. Images, audio and video are not encoded into the tool
  response or handed to a shell with a gateway key.
- The native media transport bounds response bytes while reading, including
  streamed bodies without a Content-Length. Oversized or interrupted responses
  fail without retry; this does not establish that upstream work was unpaid.
- A verified runtime auth identity, verified UniHub actor, selected account, source product, server-generated task ID, OpenCode session and model establish an immutable binding before model IO. A later account selection cannot change it. A different browser/device identity cannot inherit it, including when logged in to the same UniHub user.
- The ordinary prompt route verifies the authoritative OpenCode session and records the exact user message ID. It parses at most 1 MiB of uncompressed JSON only for the selected platform provider. The OpenCode proxy replays the parsed body with corrected framing; BYOK request streams remain untouched. Each model hook verifies that the session still refers to that prompt and has not crossed an idle boundary. Internal/control prompts without admission, child sessions, auxiliary generation, command execution and resumed turns fail before model IO. Unsupported session mutation cannot change a bound task's payer.
- Session-owner authorization precedes the native session read. A missing
  native session returns the SDK's `SessionNotFoundError` contract with HTTP
  404, the requested session ID and a fixed message. Failed transport and
  unrecognized native errors remain HTTP 503 without raw diagnostics. Neither
  failure admits or forwards the prompt.
- Before that native read, the managed backend waits through the shared
  OpenCode request-readiness gate. A short startup or restart holds the unsent
  request for at most six seconds. Timeout returns 503; a disconnected client
  stops the request before native reads or admission. The gate never replays
  a prompt. Account and diagnostic routes keep their existing availability.
- A primary tool loop uses a new logical call ID per generation. The journal commits PREPARED then DISPATCHED and a request digest before network IO. Digests detect conflicting replay and never derive call identity. An existing dispatched call is never posted to llmrouter again.
- The dedicated listener binds `127.0.0.1` on a random port and requires a
  per-plugin HMAC session established over the managed OpenCode parent IPC
  channel. Request nonces are single-use. No public session metadata or
  actor/account header can pick a payer. Login access tokens and model
  capabilities remain in backend memory. The URL may reach the child
  environment, but the HMAC key and bootstrap never do.
- Gateway requests use a restricted model capability for the saved account and task, exact model allowlist, bounded output and usage-enabled Chat SSE. The proxy does not debit cash or calculate charges.
- Stream output is journaled before forwarding. A clean completion requires `[DONE]` and EOF. Transport failure, abort, malformed SSE or missing completion retains an unresolved call. The legacy limit-failover plugin keeps UniHub calls on the managed provider.
- For SuperWagie product credits, HTTP 503 with `platform_model_route_unavailable` and `stage: pre_admission` makes the current attempt terminal without a receipt. The runtime checks the ordered backups against the executable streaming catalog and output and context limits, then journals a fresh call ID for the next model. Each generation keeps its original prompt permit, payer and deadline. Independently purchased or user-configured providers are outside this chain. API Key probes name the model directly and report each result.
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
- The managed account API Key checks use the current UniHub policy lists in
  their published order. Each omitted operation uses its legacy models.
  An empty list disables that operation. Chat and vision have distinct
  probes even when the same model implements both. A batch captures its plan
  and gateway at activation and sends each probe directly to the listed model.
  An explicit
  same-origin request uses the signed-in actor's selected payer and the same
  private product proxy as ordinary model calls. The server sends only fixed
  samples, reads bounded outputs, and requires the matching settled product
  receipt before marking a model as passed. No model credentials, sample
  results or prompts are exposed in the receipt. Each batch runs up to three
  probes at once. The current batch and its logical call IDs are written to
  the private bootstrap store and expire after 24 hours. Refresh performs
  no model IO, and an interrupted probe remains unconfirmed without replay.
- GET `/api/platform-model/sessions/:sessionID` returns payer/model and call states to the bound runtime identity. POST `/reconcile` additionally requires a trusted request origin. An unresolved status is visible to the UI; no response claims a successful refund or free generation without a gateway receipt. Terminal receipts persist the optional original charge asset without reinterpreting legacy amounts. After an interrupted stream the runtime checks the original receipt once so a confirmed release or settlement can unblock the conversation without submitting another call.
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

### Why a missing session retains its native error

Changing the engine's database or reopening a removed session can leave the
client holding an ID that the active engine does not know. A 503 would describe
that as a service outage and conceal the missing-session condition from the
OpenCode SDK. The admission route preserves its typed 404 after checking the
existing task owner.

### Why the product boundary is private IPC

The old callback token was inherited by ordinary OpenCode shell children, which
could imitate a model hook while an agent prompt was active. The product now
uses the OpenCode child IPC channel for bootstrap and keeps each HMAC key in
its plugin instance. Separate locations and plugin reloads register independent
sessions through the same live child. The bootstrap remains valid for managed
restarts, but prompt permits do not survive them. Session and nonce limits
fail closed instead of silently evicting active keys or replay protection.
The bootstrap never authorizes an HTTP handshake. Shell descendants inherit
neither the IPC channel nor the keys, and stale bearer requests are rejected.

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

A confirmed funding rejection whose authoritative receipt asset is `CREDIT/6`
returns `platform_model_credits_required`. The UI opens credit membership or
add-ons for that exact refusal. Missing asset and cash receipts retain
`platform_model_funding_required`. Funding refusals that lack authoritative
pre-admission evidence require the original call's REJECTED receipt. These
responses do not start another model call.

## Product-credit chat

An opted-in chat permit binds each new call to the verified product-credit
mode before dispatch. The journal records that scope with the original call
ID. The isolated operator proxy obtains proof and sends the request and
idempotency key to the gateway. Receipt reads verify the original call ID
or authenticated alias, product scope, SuperWagie funding product and credit
asset. Existing admitted calls continue using the billing mode recorded when
they started. An exact product 402 `platform_model_credits_required` or 403
`product_membership_expired` with `stage: pre_admission` closes the local chat
or media call as rejected and preserves its user-facing error. This trusted
gateway response establishes refusal before a balance hold or provider call.
An uncertain result stays subject to reconciliation under its original mode.
