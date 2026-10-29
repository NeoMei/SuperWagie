# Model configuration

## Ownership

This module owns the purpose and recommendation catalog, reusable provider-family connections, write-only API keys, references to eligible OpenCode API keys, opt-in purpose bindings, protocol probes and server-side resolution. OpenCode owns Agent/auxiliary model selection and its OAuth and credentials; those native purposes are catalog entries, never duplicate bindings here. Consumer modules own feature availability, payloads and application of a resolved model. Existing consumers retain their legacy configuration until explicitly bound.

Web, Electron, hosted mobile and Capacitor mobile use the authenticated active server. Electron starts this backend in process. VS Code without this backend responds with an explicit unsupported route; it retains native OpenCode model settings. No browser stores keys or a snapshot of a resolved credential.

## Invariants

- `model-configuration.json` is a strict version-1 object with an increasing `revision`, connection records and binding records. A connection has either a server-only API key or `credentialSource: { type: 'opencode', providerId }`, never both. A reference never copies an OpenCode key into the file. Public responses contain `hasApiKey` and never a key, token or credential fingerprint.
- `credentialSources: { status, sources }` publishes eligible native API key identifiers and optional names. `available` with no sources means an authoritative empty list; `unavailable` means no reader exists on this runtime; `failed` means the reader could not be asked. OAuth credentials are excluded, and a failure reading native credentials does not erase manual connections. The injected native reader is called afresh for every resolution.
- A native reference may target only that provider family's enumerated official HTTPS hosts. Subscription-specific provider IDs are not interchangeable. A custom or local endpoint requires trusted server metadata with the same provider ID and exact normalized URL; form input cannot authorize it. Destination policy is checked on save and again on every resolution, so changing a referenced endpoint cannot redirect a stored key.
- A missing file means unconfigured. Unreadable, malformed, duplicate or dangling records fail closed and are never overwritten as empty state. Existing knowledge models, indexes and settings are not migrated by this store.
- Writes serialize within a runtime and use an exclusive lock file across runtimes, an expected revision, a mode-0600 temporary file, file sync and atomic rename. Failed mutations leave the prior file valid. A process interrupted while holding the lock may leave a lock file: after confirming no writer uses this data directory, remove only `model-configuration.json.lock` to resume writes. Reads remain available.
- Connection destinations contain no embedded credentials, query or fragment. Changing endpoint, provider, protocol, region or workspace requires a replacement key or a validated native reference if a key was stored. Omitted credentials on metadata edits preserve the prior key or reference. No OAuth or native environment credential is copied into this store.
- A connection's protocol denotes a provider family, not one endpoint operation. An Alibaba workspace connection can supply the same key to embedding, rerank and image purposes; each consumer chooses its protocol path. A preset must match the purpose, provider family and exact model. Unsupported native API generations are `requires-adapter`, rather than being silently sent to a legacy protocol.
- `resolveBinding(purpose, { supportedProtocols })` reads disk and enterprise policy at invocation. It returns `null` only when no binding exists. Planned purposes, unsupported presets and incompatible consumers throw stable errors. Its resolved `{ purpose, connectionId, providerId, protocol, baseUrl, model, apiKey, parameters, revision }` is server-only and must not be cached, returned to a browser or logged.
- Provider-entry writes are refused in enterprise mode. Existing binding switching/removal remains possible, but actual external resolution/probes are blocked; loopback destinations remain local. Policy is checked again before recording a probe result.
- Binding and associated connection mutations clear verification. A probe records `verified` only after parsing the relevant protocol result. Dimension mismatch, invalid payload and provider errors record `failed` with a sanitized code. A late probe cannot overwrite any newer revision. Source-backed verification has a private credential fingerprint that is stripped from public results; a rotated, missing or unreadable native key projects `untested`, and rotation during a probe refuses its result. Saving an unsupported recommendation does not verify it.
- `POST /api/model-configuration/connections/:id/test` accepts `{ revision, purpose, model, presetId?, parameters }` for a saved connection. It returns only `{ status: 'verified' | 'failed', testedAt, errorCode? }`, never creates or changes a binding, and never changes stored verification or the revision. The purpose must be available, its protocol must have an actual probe, and any preset must be compatible. The saved credential is resolved afresh; a newer configuration revision, native credential rotation or changed enterprise policy refuses a late result. Final checks share the mutation lock without writing configuration.
- Probes are server-side protocol checks, not proof of all downstream skill/runtime environments. Embedding, vision, rerank, compatible speech, images and native Jev classify actual results. Image generation has a 600-second provider deadline; smaller probes have a 30-second deadline except Jev's existing routing deadline. OCR and other protocols without a suitable probe remain unverified; no generic `/models` response is treated as purpose verification.
- `prepareBindingChange(purpose, nextResolved, previousResolved)` runs before persistence for a binding and for every binding affected by connection changes. It validates only and must not mutate remote backend state. Knowledge consumers reconcile before their next actual operation. Known index-compatibility errors pass through as stable errors; unexpected failures never expose underlying bodies or secrets.
- File transcription, optional image repair, multimodal embedding and independent video generation remain planned because this checkout has no complete consumer. Private masked-image and video-submit broker actions are scaffolding; they do not make those purposes available until the gateway and artifact consumer are complete. Optional editable-slide repair keeps its safe-background fallback.

## Decisions

### Why a separate credential store and not existing general settings

The general settings parser is not a credential boundary and may be browser-readable. A focused private file can reject malformed state, validate references and project only credential presence. Native Agent credentials remain in their authoritative OpenCode owner instead of duplicating OAuth access tokens.

### Why a provider-family connection and not one key field per purpose

Alibaba and OpenAI compatible APIs expose several operations under one account. A shared connection prevents repeated key entry while purpose-specific consumer checks keep a compatible endpoint from falsely proving an unrelated API capability.

### Why expected revisions and not last writer wins

Connection edits, asynchronous probes and open settings pages can overlap. Rejecting a stale revision prevents an older key edit or probe result from restoring an obsolete model; a caller reloads authoritative state before retrying.

### Why a connection test does not verify a purpose binding

A connection can be tested with a suggested or manually entered model before a purpose is assigned. Returning a separate result avoids changing the model already used by a consumer or claiming that another saved binding was tested. The same protocol probe validates the selected operation rather than treating a generic model list as proof.

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
