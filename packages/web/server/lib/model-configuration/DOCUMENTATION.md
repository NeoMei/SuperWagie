# Model configuration

## Ownership

This module owns the purpose and recommendation catalog, reusable provider-family connections, write-only API keys, references to eligible OpenCode API keys, opt-in purpose bindings, protocol probes and server-side resolution. OpenCode owns Agent/auxiliary model selection and its OAuth and credentials; those native purposes are catalog entries, never duplicate bindings here. Consumer modules own feature availability, payloads and application of a resolved model. Existing consumers retain their legacy configuration until explicitly bound.

Web, Electron, hosted mobile and Capacitor mobile use the authenticated active server. Electron starts this backend in process. VS Code without this backend responds with an explicit unsupported route; it retains native OpenCode model settings. No browser stores keys or a snapshot of a resolved credential.

## Invariants

- `model-configuration.json` is a strict version-1 object with an increasing `revision`, connection records and binding records. A connection has either a server-only API key or a credential reference (`opencode` or the private `model-bootstrap` LLMRouter reference), never both. Public responses contain `hasApiKey` and never a key, token, bootstrap reference or credential fingerprint.
- `credentialSources: { status, sources }` publishes eligible native API key identifiers and optional names. `available` with no sources means an authoritative empty list; `unavailable` means no reader exists on this runtime; `failed` means the reader could not be asked. OAuth credentials are excluded, and a failure reading native credentials does not erase manual connections. The injected native reader is called afresh for every resolution.
- A native reference may target only that provider family's enumerated official HTTPS hosts. Subscription-specific provider IDs are not interchangeable. A custom or local endpoint requires trusted server metadata with the same provider ID and exact normalized URL; form input cannot authorize it. Destination policy is checked on save and again on every resolution, so changing a referenced endpoint cannot redirect a stored key.
- A missing file means unconfigured. Unreadable, malformed, duplicate or dangling records fail closed and are never overwritten as empty state. Existing knowledge models, indexes and settings are not migrated by this store.
- Writes serialize within a runtime and use an exclusive lock file across runtimes, an expected revision, a mode-0600 temporary file, file sync and atomic rename. Failed mutations leave the prior file valid. A process interrupted while holding the lock may leave a lock file: after confirming no writer uses this data directory, remove only `model-configuration.json.lock` to resume writes. Reads remain available.
- Connection destinations contain no embedded credentials, query or fragment. Changing endpoint, provider, protocol, region or workspace requires a replacement key or a validated native reference if a key was stored. Omitted credentials on metadata edits preserve the prior key or reference. No OAuth or native environment credential is copied into this store.
- A connection's protocol denotes a provider family, not one endpoint operation. An Alibaba workspace connection can supply the same key to embedding, rerank and image purposes; each consumer chooses its protocol path. A preset must match the purpose, provider family and exact model. Unsupported native API generations are `requires-adapter`, rather than being silently sent to a legacy protocol.
- `resolveBinding(purpose, { supportedProtocols })` reads disk and enterprise policy at invocation. It returns `null` only when no binding exists. Planned purposes, unsupported presets and incompatible consumers throw stable errors. Its resolved `{ purpose, connectionId, providerId, protocol, baseUrl, model, apiKey, parameters, revision }` is server-only and must not be cached, returned to a browser or logged.
- Provider-entry writes are refused in enterprise mode. Existing binding switching/removal remains possible, but actual external resolution/probes are blocked; loopback destinations remain local. Policy is checked again before recording a probe result.
- Binding and associated connection mutations clear verification. A probe records `verified` only after parsing the relevant protocol result. Dimension mismatch, invalid payload and provider errors record `failed` with a sanitized code. A late probe cannot overwrite any newer revision. Source-backed verification has a private credential fingerprint that is stripped from public results; a rotated, missing or unreadable native or bootstrap key projects `untested`, and rotation during a probe refuses its result. Bootstrap verification and `hasApiKey` use the same private credential read, constrained to the current inference destination. Saving an unsupported recommendation does not verify it.
- `POST /api/model-configuration/connections/:id/test` accepts `{ revision, purpose, model, presetId?, parameters }` for a saved connection. It returns only `{ status: 'verified' | 'failed', testedAt, errorCode? }`, never creates or changes a binding, and never changes stored verification or the revision. The purpose must be available, its protocol must have an actual probe, and any preset must be compatible. The saved credential is resolved afresh; a newer configuration revision, native credential rotation or changed enterprise policy refuses a late result. Final checks share the mutation lock without writing configuration.
- Probes are server-side protocol checks, not proof of all downstream skill/runtime environments. Embedding, vision, rerank, compatible speech, images and native Jev classify actual results. Image generation has a 600-second provider deadline; smaller probes have a 30-second deadline except Jev's existing routing deadline. The compatible OCR probe submits one fixed image through the account-key jobs route and polls its terminal progress under a bounded deadline. A completed job must then return the same job ID and exactly one page with nonempty text from a same-key `GET /v1/ocr/:id/document`. An unavailable document route fails the probe. Protocols without a suitable probe remain unverified; a `/models` response never counts as a successful purpose probe.
- Rerank connection probes submit one document with `top_n: 1` and require its corresponding score. This checks the protocol without exceeding a single-document account limit or claiming ranking quality. Ordinary reranking requests retain their existing inputs.
- `prepareBindingChange(purpose, nextResolved, previousResolved)` runs before persistence for a binding and for every binding affected by connection changes. It validates only and must not mutate remote backend state. Knowledge consumers reconcile before their next actual operation. Known index-compatibility errors pass through as stable errors; unexpected failures never expose underlying bodies or secrets.
- File transcription, optional image repair, multimodal embedding and independent video generation remain planned because this checkout has no complete consumer. Private masked-image and video-submit broker actions are scaffolding; they do not make those purposes available until the gateway and artifact consumer are complete. Optional editable-slide repair keeps its safe-background fallback.
- The skill coverage list includes the bundled managed image editor and the slide vision QA consumer. Their presence describes required consumers, not executable managed support: masked editing remains planned and slide vision QA fails closed until its managed transport is implemented.
- Imported-key bootstrap reuses a connection only when its provider, protocol, inference destination and actual server-resolved credential match the selected key. The selected credential is checked again under the configuration mutation lock after asynchronous preparation and temporary-file staging, immediately before atomic rename. A different key receives a separate durable credential and connection; existing bindings keep their connection and verification. Unavailable credentials are excluded from reuse.
- Bootstrap discovery publishes the normalized catalog in both `models` and `catalog`, including nullable `dimensions`. The strict UI parser accepts missing or null dimensions and integers from 1 to 65536, matching binding parameters; malformed dimensions and unrecognized model fields remain errors.
- Account activation uses `GET/POST /api/model-configuration/bootstrap/account-key` with an authenticated runtime owner and the selected platform account. GET is read-only and returns only the actor/account/service-owned receipt. POST accepts explicit `activate`, `resume` or `retest`. Managed web and Electron provide the native helper; unsupported runtimes refuse setup before issuing a key. Enterprise policy is checked before issuance, every configuration boundary and every dispatched model probe.

## Account-key activation

`account-key-activation.js` owns one durable workflow per issuer, service, actor
and account within the server data directory. `account-key-store.js` keeps
mode-0600 receipts in `account-key-activation` without discovery's 24-hour TTL.
Secrets stay encrypted in the bootstrap secret store and in OpenCode's owning
credential store; no response contains the key or a credential fingerprint.

The workflow refreshes the original platform session, validates discovery scope,
and records issuance before dispatch. The upstream API has no issuance replay
contract: an uncertain response, including a response discarded because the
account changed, remains unknown and cannot issue another key. Only a key
already validated and safely persisted can resume configuration. Restarting a
dispatched issuance or test projects unknown; interrupted configuration offers
explicit resume. Opening or refreshing never resumes mutations or paid tests.

Configuration adds a preassigned connection ID through the model-store mutation
lock, expected revision, private credential comparison and final owner/policy
guard before atomic rename. An existing ID must match exactly. The native helper
uses the owning provider writer and OpenCode key connection API, verifies exact
provider configuration and credentials, and refuses conflicting edits. The
existing native writer is not a cross-process transaction. A hard exit during
the model-store commit may leave its existing lock file; the lock recovery rule
above still applies.

Activation locks include a PID and token. A serialized recovery can reclaim a
dead process's lock while retaining its receipt's unknown dispatch state. A
hard exit during recovery can leave a `.lock.recovery` file; after confirming
there is no writer, an administrator can remove that file to resume recovery.
Malformed or live-process locks remain blocked.

An explicit activation or retest means test and apply the account key across
supported functions. Selection starts from the current native selections, saved
purpose bindings and legacy knowledge settings. An existing model remains selected
when the Key catalog declares a compatible operation. A missing or incompatible
choice uses the first compatible candidate in catalog order, as does an
unconfigured supported purpose. Every available purpose with an OpenAI-compatible
Key probe receives a row, including OCR, vision, embedding, rerank, speech and
image generation. A purpose without a compatible candidate has a null model ID
and a skipped `account_key_model_unavailable` result. An unreadable legacy configuration also
stays incomplete. Retaining a model retains its dimensions, voice and language;
a replacement starts with that catalog model's dimensions, when supplied, and
no parameters from the old model. Credentials and endpoints come only from the
account connection. Consumer preparation still protects existing embedding
indexes and can refuse a replacement that requires rebuilding them.
Discovery captures each purpose's binding inputs or legacy
model selection. Native snapshots contain app selection settings and only the
normalized explicit OpenCode default and title model references. The scoped
runtime client's configuration documents supply those references in priority
order. A later title definition replaces the earlier title definition, including
when it omits a model. Invalid explicit references and failed configuration reads
refuse setup. Inferred free-model defaults can change after provider registration
without changing those snapshots.
A change while issuance, scope upgrade or discovery is pending skips
that purpose with a configuration conflict before its probe or apply; unrelated
purposes can finish. Legacy selections are checked again before applying a paid
probe result because their backend changes do not advance the binding revision.
A changed legacy selection leaves that row unconfirmed and unapplied while other
purposes continue. Verification timestamps alone do not invalidate a selection.

Issuance explicitly requests `model_scope: llmrouter_available` and requires
`pricing_source: llmrouter_native` plus a positive `credential_version`. Legacy
receipts default to selected scope. An explicit resume, retest or quick-setup
apply upgrades that same Key through the account/key `/scope` endpoint. The
returned ID, actor, account, product, instance, creation time and expiry must
match; scope changes advance the version. The token stays in its existing secret
store. An uncertain upgrade can be retried idempotently without another issuance.
Dynamic scope follows the current router catalog. Historical `models` arrays
have no authorization role and may be empty in the upstream response.

Pre-issuance discovery requests the dynamic catalog through the authenticated
account API. After issuance, the Key reads its own inference catalog before
configuration and each probe batch. The complete current chat catalog is
registered under the SuperWagie provider. Explicit refresh replaces its catalog,
including additions, removals and name changes, only when the saved provider
matches the exact previous or intended snapshot and its credential still
matches. Recovery retains both snapshots until configuration is confirmed.
Catalog snapshots are bounded to 1000 entries and receipt reads to 8 MiB;
oversized responses fail explicitly. These are schema bounds, independent of
Key authorization. Feature selections do not limit the Key's model access.

`account-key-models.js` owns native registration snapshots. Exact operations map
to Chat Completions, Responses, Anthropic Messages or Gemini model adapters under
one provider and credential. Gemini derives `/v1beta` from the configured
inference root. Adapter metadata and known input modalities join the recovery
snapshot, so protocol changes also require a matching previous provider. An
unknown tools capability does not remove a chat model. The native SDK probe
uses the selected model's adapter; its streaming response must actually finish.

Before paid probes, the same key reads LLMRouter `/v1/models`. Technical metadata
must match the adapter's operation, protocol, endpoint, method and transport and
mark the operation available with a compatible adapter. Executable operations
can be probed. `operation_authorization_unknown` also permits a bounded probe;
a present authorization denial blocks that row.
Missing metadata remains unknown capability and permits a bounded protocol probe;
it never supplies a successful test result. Image input proves vision support
only alongside chat capability; OCR-only entries cannot become vision bindings.

`account-key-provider.js` registers the current chat directory under SuperWagie
and tests selected chat models through OpenCode. Its factory requires an
`assertRuntime` callback that returns the current owned process identity.
Every action captures that identity and checks it before and after native,
configuration-file and settings IO, including the final settings-writer guard
and selection readback. An unavailable or replaced process refuses the action;
a later explicit action can capture the new process.

The server supplies only its owned, ready, running managed process. External
instances, restart and shutdown refuse access. On desktop the lifecycle also
verifies the successful launch used the bundled binary, its captured child
environment has the private paths, and the parent runtime still addresses the
same private configuration and database. A directory or loopback URL alone
cannot establish that ownership. Web retains its managed-runtime contract and
also requires a live owned process. The SDK client stays scoped to that runtime
and its current directory. Desktop native IO uses only the verified private
configuration and has no system OpenCode client or configuration fallback.
`model_configuration_account_runtime_required` identifies an external,
custom or system instance, or a desktop private-boundary mismatch.
`model_configuration_account_runtime_unavailable` identifies an owned process
that is not ready, is restarting, has exited, or changed during an action.
These sanitized codes survive activation errors and existing Key receipts.
A refusal preserves the issued Key and never automatically repeats issuance
or inference. SDK and file-read failures retain their separate provider errors.

The provider also reads the actual default and auxiliary
selection, including variant. Candidate tests use this activation's provider and
key without borrowing another provider's credential or variant. The Agent row
keeps a compatible current model or tests the selected catalog chat candidate.
An unavailable or unconfigured auxiliary uses that Agent candidate; a compatible
auxiliary choice remains selected. Both purposes require their own successful
probe before applying. Unreadable native selections stay incomplete. A separate
auxiliary row is included when present. A confirmed
native result is selected through the owning settings writer and then read back.
Known-disabled auxiliary overrides are eligible for replacement; their original
app settings remain in the concurrency snapshot. The native guard compares only
the dependencies of the original app settings. An explicit app default masks the
native default. An explicit app auxiliary override masks native choices;
otherwise the title model takes priority, with the native default checked only
when both the title model and app default are absent. The settings writer repeats
this check before applying each result, using the original settings to choose
dependencies so this run's own Agent write does not conflict with auxiliary
apply. Conflicting concurrent selections refuse the apply. Native probes have a
30-second abort deadline; the SDK supplies no hard output-token limit. Each
request may consume credits. Existing project/session overrides are not changed,
and this runtime-wide receipt does not enumerate every active session override
or device-local voice preference.

The account panel receives `testRunId` and `tests[]` with stable row ID, purpose,
nullable model ID, `queued | testing | verified | failed | unknown | skipped`,
nullable test time, `applied` and a sanitized error code. Every explicit test batch
gets a new ID. Rows cover eligible native models, saved bindings, legacy
configurations and all supported Key purposes. Unrelated catalog entries and
unconfigured purposes without a supported Key probe are omitted. Missing models
for supported purposes stay visible and prevent a ready result. A binding on another connection is tested as a
candidate using the account key. Only a confirmed result can replace that
purpose's connection. Unsupported, unavailable and unreadable configurations
receive an explicit skipped reason and remain incomplete. Legacy single-chat
receipts parse with an empty row list and null run ID and require an explicit
test-and-apply run. A retest can restore a missing supported binding because the
action explicitly applies all selected functions.

At most three requests run together. Purpose probes use `testConnection`, which
does not write a binding or verification revision. Account probes pass the
receipt's expected connection and key through a server-only argument. The exact
connection and resolved key are checked against the probe's dispatch snapshot,
so an edit between setup and planning cannot use another credential or endpoint.
Final revision, credential, policy and owner checks serialize with configuration
mutations; each dispatch
checks the original platform session. Each row transition is durably written in
order. Explicit provider rejection or invalid response is failed; lost response,
timeout, server uncertainty or a changed owner/configuration is unknown. One
failed row does not erase completed rows. After probes finish, confirmed choices
apply serially under expected-revision, credential, session and policy guards.
Each saved binding or native selection is read back before its row receives
`applied: true`. Failed or unknown probes keep their previous configuration.
An apply that fails after persistence can leave the new selection saved without
a confirmed applied receipt; the next explicit run reconciles that state. Already
applied rows remain in place if another row fails. The aggregate is ready only
when every row is verified and applied. Skipped rows prevent ready, and no paid
request retries automatically.

A receipt-write failure stops new dispatch and waits for already dispatched
probes. Confirmed results remain in the final receipt or, if disk still fails,
in an actor/account-scoped in-memory fallback until a later successful write.
This fallback cannot survive process exit. After restart only unfinished rows
project unknown; confirmed terminal rows remain visible. Opening, polling and
refreshing never dispatch tests or resume setup.

A ready-state GET checks the saved connections and every applied binding/native
selection, without a remote model request or a live key-revocation/balance check. A mismatch removes
the ready projection and offers safe recovery without overwriting changed
configuration. The displayed test timestamp is historical and model-specific;
it does not verify unrelated catalog models. Receipt ownership does not change
the runtime's global provider/configuration scope or create multi-user invocation
isolation.

## Decisions

### Why a separate credential store and not existing general settings

The general settings parser is not a credential boundary and may be browser-readable. A focused private file can reject malformed state, validate references and project only credential presence. Native Agent credentials remain in their authoritative OpenCode owner instead of duplicating OAuth access tokens.

### Why a provider-family connection and not one key field per purpose

Alibaba and OpenAI compatible APIs expose several operations under one account. A shared connection prevents repeated key entry while purpose-specific consumer checks keep a compatible endpoint from falsely proving an unrelated API capability.

### Why expected revisions and not last writer wins

Connection edits, asynchronous probes and open settings pages can overlap. Rejecting a stale revision prevents an older key edit or probe result from restoring an obsolete model; a caller reloads authoritative state before retrying.

### Why a connection test does not verify a purpose binding

A connection can be tested with a suggested or manually entered model before a purpose is assigned. Returning a separate result avoids changing the model already used by a consumer or claiming that another saved binding was tested. The same protocol probe validates the selected operation rather than treating a generic model list as proof.

### Why image probes allow an empty unused image field

OpenAI-compatible image responses can include both `url` and `b64_json`, leaving
the unused representation empty. Each result must still contain a valid URL or
nonblank base64 content; malformed nonempty URLs and non-string fields fail.
Requiring both optional fields to be nonempty rejects valid URL-only results
from providers that serialize their unused fields as empty strings.

### Why validate before persistence and reconcile at use time

Knowledge backend model records and the local file have no shared transaction. Mutating remote records in a pre-save callback could leave them changed after a failed file write. Validation protects indexed embedding spaces before committing, and the consumer owns retryable reconciliation before indexing or retrieval.

### Why native API key references and not copying existing credentials

OpenCode remains the authoritative credential owner, so rotation and disconnection apply to every consumer on its next invocation. A reference is constrained to the provider's known official destination, or a custom destination established by server metadata, to prevent a purpose edit from exporting a stored credential to a different host.

### Why resolve bundled skills through a server helper and not raw JSON

A private child-process resolver applies the same purpose, compatibility and enterprise checks as server consumers. Its normal resolution action emits resolved JSON only to a captured child pipe, emits sanitized error codes to stderr and never runs a provider request. Packaging supplies its bundled path; existing installed skill copies require their normal managed update before adopting this reader. Native key reads use the official OpenCode SDK helper and the managed, injected loopback `SUPERWAGIE_MODEL_OPENCODE_URL`; the inherited OpenCode password stays in headers, and environment integration reads name only the current working directory. No singleton auth source is reconfigured. Without that endpoint native references fail explicitly. Custom native metadata is unavailable to this child resolver, so custom references are currently unsupported there.

### Why share native speech with the child helper

MiniMax playback, probes and SuperVideo narration use `speech.js` for one native
payload, business-code check, bounded hex MP3 response and enterprise URL check
at request time. The resolver's separate `--synthesize-tts` action accepts bounded
stdin with text, optional speed and expected project model/voice. It resolves the
binding afresh and returns only base64 audio and content type. Model/voice changes
fail explicitly instead of generating different narration under a stale receipt.

### Why bootstrap operations are separate from model-configuration.json

Discovery catalogs, idempotency records and rollback snapshots expire independently from durable model bindings. The private `model-bootstrap` store keeps transient workflow state and imported-key references out of the version-1 configuration schema. Runtimes without this backend return `501 model_configuration_bootstrap_unsupported`.

Rollback restores only binding input fields from its snapshot, clears newly added bindings, and removes only the connection created by that operation. Restored bindings retain the normal `saveBinding` verification reset; snapshot verification is not reused.

### Why bootstrap connection reuse includes the credential

A provider endpoint can accept keys with different model scopes. Endpoint-only reuse binds new purposes to an earlier key. The server compares current private credentials without publishing keys or fingerprints; matching keys share a connection, while different keys retain independent durable references.

Apply checks reuse at mutation entry and observes the selected credential again after asynchronous preparation and temporary-file staging, immediately before atomic rename. A mismatch or unreadable credential at this final observation refuses the commit and removes its temporary file. The configuration lock serializes configuration writes; the independent credential store retains its normal reference-resolution behavior for legitimate rotation after that observation.

Discovery expiry and rollback retain the existing credential ownership rules. A refused atomic apply preserves the configuration revision and removes only its uncommitted durable secret; compensation remains limited to the sequential fallback runtime.

### Why bootstrap probes run serially

Each binding probe writes a new configuration revision. A batch deduplicates purposes and passes the revision returned by each probe to the next, so its own writes do not conflict. A concurrent configuration edit marks the affected and remaining pending probes `stale` and stops dispatch without retrying. Each run result follows the returned binding verification; a completed request alone does not mean `verified`. Provider adapters own abort deadlines, so the batch waits for each probe to finish before dispatching another.

A failed or missing run-state write stops further dispatch and ends the run as `failed`. Obtained results remain valid; only pending purposes receive `model_configuration_bootstrap_test_state_failed`. The runtime attempts to persist this terminal state once, without repeating any provider call. If storage remains unavailable, `readTestRun` returns a private in-memory terminal snapshot containing only public results. Successful terminal persistence clears that fallback; otherwise it remains available in the owning process for the operation store's 24-hour retention period. Failed disk persistence cannot survive a process restart.

### Why account activation separates probes from apply

Account activation needs a per-model progress list without making its own probes
invalidate one another's configuration revision. It uses the existing saved
connection probe instead of the binding mutation probe, caps concurrent provider
requests at three, and waits for probes before applying confirmed choices serially.
`applied` distinguishes a successful provider response from the configuration the
consumer now uses. A later failure preserves earlier applied choices and exposes
the incomplete rows for an explicit retest.
The earlier bootstrap wizard retains its serial binding-verification contract.

### Why account setup replaces unavailable model choices

Activating or retesting a SuperWagie Key configures supported functions from
the models that Key can use. Preserving a missing or incompatible old model
prevented setup from completing even when the Key supplied a suitable model.
Compatible current choices take priority; replacements follow the authoritative
catalog order because the catalog supplies no ranking. Only a successful
purpose probe can apply a candidate, and concurrent edits and embedding-index
compatibility remain guarded. Quick setup's separately reviewed selections
retain their existing fixed-model contract.

### Why native concurrency guards use explicit configuration

Registering a provider can change OpenCode's inferred free default without any
user edit. Comparing effective model rows would skip both native purposes during
an otherwise valid activation. The guard compares app settings and the explicit
native references they depend on, and rechecks them inside the settings writer
after probes. Configuration snapshots contain no provider settings or credentials.

### Why catalog and inference endpoints are separate

`bootstrap-client.js` reads imported-key discovery from the configured inference
service and retains the product, account and instance response-header checks.
The same operation parser supplies account activation and quick setup, including
exact protocol, endpoint, method and transport checks. Authenticated discovery
requests the router-backed dynamic catalog through the account API. Discovery
and preview remain read-only. An explicit quick-setup apply or Key setup uses
`accountKey.prepareCredential` to create or upgrade the durable account Key.
It performs no model probe and never creates a separate quick-setup Key.

Quick setup applies the same Key at `OPENCHAMBER_LLMROUTER_API_URL`, defaulting
to `https://llmrouter.quukk.com/v1`. The reviewed model IDs stay fixed when the
live Key catalog replaces the discovery snapshot, including on a retry. A model
removed from the catalog fails explicitly. Account identity is rechecked under
the configuration mutation lock after consumer preparation and immediately
before rename. Existing managed-session connections remain available for
explicit replacement or rollback; new account setup uses the ordinary Key.

API roots and trailing `/v1/` normalize to one `/v1`. Response URLs and browser
input cannot choose the credential destination. Custom destinations are server
configuration, use HTTPS with HTTP limited to loopback, and cannot use the
managed `/platform/v1` endpoint. Bootstrap references must match that URL when
saved and resolved. A changed destination invalidates a pending discovery.
Existing connections at the former account-catalog URL remain preserved and
excluded from reuse. Their credentials require explicit configuration repair.
The existing Key's funding, limits and expiry remain unchanged.

Quick-setup connections can retain their own connection ID while sharing the
account Key. Consumer ownership resolves that Key to the authenticated account
receipt, then rechecks the current binding's connection, model, endpoint and
credential. A changed account session, Key version or binding invalidates the
capture. A foreign credential cannot acquire account ownership through a
matching provider label or endpoint.

### Why fill-missing is the default bootstrap mode

Existing BYOK, project and session choices remain authoritative. The planner replaces an existing binding only when it belongs to the managed UniHub connection and the caller selects `replace-managed`; native Agent and auxiliary purposes remain owned by OpenCode.

Quick setup creates only OpenAI-compatible or managed connections. Routing
requires the existing Jev consumer, so it is unavailable for a new bootstrap
binding even when the catalog contains chat models. Existing routing bindings
are preserved in both modes. Apply recomputes this plan; a plan without
additions or replacements records an idempotent result without creating a
connection or copying a key, and rollback leaves the model configuration intact.
