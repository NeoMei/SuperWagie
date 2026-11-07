# Model configuration

## Ownership

This settings page owns the default purpose overview, purpose selection, recommendation browsing, connection drafts and explicit connection/binding save/test actions. `ModelConnectionEditor` owns write-only credential entry and probe drafts; `ModelConfigurationFields` owns translated preset metadata. The `modelConfiguration` HTTP client parses the server contract. The server owns credentials, protocol support, enterprise policy, binding revisions and verification results.

`ModelTestFeedback` owns the shared animated wait and result presentation for
connection probes, purpose probes and batch results. It names the model and
purpose without exposing credentials or implying that another purpose passed.

Agent conversation and auxiliary generation render the existing `DefaultsSettings` model controls. OpenCode owns their provider catalog and credentials. The Providers page owns native sign-in and custom provider creation. Existing session and agent overrides retain their precedence.

The page is available in web, Electron, hosted mobile and Capacitor through the active server. ModelQuickSetupWizard owns transient discovery, preview, apply and test progress; the bootstrap client owns parsing and transport. VS Code displays native model controls and an explicit unavailable state for the app model service. Search availability follows these boundaries.

## Invariants

- Origins filter the recommendation list. They never write a binding or replace its selected preset, model or dimensions.
- Existing OpenCode API keys can be referenced through the server-provided credential source list. Quick setup keeps imported credentials transient in the active flow and only renders non-secret discovery metadata. OAuth is excluded, and references expose no key material. The server verifies the provider destination at write and invocation time.
- API keys are write-only. An empty replacement preserves an existing key, successful saves clear the entered key, and changing a connection starts a fresh form.
- Configuration read failures retain their error state. They never create a writable empty configuration. Failed writes retain the draft.
- Only the server response marks a binding verified. Binding tests operate on the saved binding, and changing its draft disables the test action. Connection tests use the saved endpoint/key with a selected model and purpose without writing a binding. Unsupported protocols show component-validation guidance. Saving a new connection preserves its public probe draft across the editor remount.
- A test click immediately shows a persistent feedback panel with a spinner and indeterminate activity bar. The selected model and purpose remain visible during long requests, including image generation. Testing hides the previous outcome and timestamp. A confirmed failed probe and an unconfirmed request result have different states; only an explicit action starts another probe.
- Wait indicators subscribe to the existing shared clock only in small visual components. The spinner updates at the shared four-beat-per-second rate; the activity bar changes on the shared second beat and is never a percentage. Completed, failed, unconfirmed and queued results are static. Hidden purpose content uses `PauseClock`; changing reduced-motion preferences or hiding the document pauses the indicators. This adds no model calls or progress polling to single-connection and purpose tests.
- Unmounted or superseded save completions cannot activate voice/routing paths or change global save feedback.
- All writes carry the last read revision. A pristine draft adopts an externally changed binding on refresh. A dirty draft is retained with saving blocked until the user explicitly reloads the saved binding. Older mutation results cannot replace a newer revision.
- A saved, unchanged purpose binding explains why Save is disabled. Editing the model, connection or parameters enables it again.
- A missing unified binding preserves current component configuration. Knowledge purpose details use an opt-in read-only model projection, and unavailable projections stay explicit. Voice source/model details come from existing public preferences. Endpoint displays strip credentials and query parameters.
- Preset note codes render translated, visible retirement and consumer-exclusion warnings alongside their review date. Existing shared connections show provider configuration without pretending to select a model.
- Embedding changes retain a visible index warning. This page never rebuilds an index or silently replaces an existing knowledge model.
- Planned purposes remain browseable with documentation and model recommendations. They expose no binding save action. Presets that require an adapter cannot activate a binding.
- The TTS availability cache is scoped to the active runtime. Saving or clearing a TTS binding invalidates it and refreshes mounted consumers, including configurations with no legacy custom URL. Playback awaits current status before selecting a path. Failed status reads are not cached as absence and cannot enable legacy fallback; explicit VS Code service unavailability preserves its supported local/browser paths.
- A TTS or speech-input binding takes precedence at invocation without changing legacy voice preferences. Clearing it restores the existing local, browser or system configuration. Voice settings explain this precedence and link to the purpose. Routing writes refresh the native routing store.
- Voice and language edits retain an account binding's authoritative native speech operation while its model and connection remain unchanged. Changing either clears that operation; model names never infer a native protocol.
- Every bundled skill appears in the coverage tab. Prompt skills explicitly inherit the Agent model; the unavailable editable-PPT runtime and managed slide vision limitation are identified. The managed image editor is shown as planned. Missing catalog data is shown as unavailable.
- Saved managed speech, short transcription and image generation bindings remain editable but show unavailable in the overview and purpose details while the runtime refuses those operations. Other connections retain their own availability and test state.
- The `models.quick-setup` target selects Overview and carries a transient request to open the wizard. The page consumes that request once, keeps the wizard pending while configuration loads, and refuses it in VS Code. Opening the wizard does not discover models, issue keys or run provider tests.
- Every stable search target selects its tab and purpose before Settings reveals the anchor. Native model search IDs remain stable after moving their registry page.
- Account-key setup can add a SuperWagie native provider and a reusable connection. Its completion requests a fresh provider catalog and a configuration revision read. An already-mounted page keeps its purpose editor and dirty drafts mounted; only authoritative, non-older revisions are accepted. Existing default models, session overrides and purpose bindings are preserved. The account's chat-test receipt is separate from purpose verification.

- English and Simplified Chinese are the shipped UI locales. Recommendation provider/model identifiers remain unchanged in both.

## Decisions

### Why native selectors retain their original persistence

`DefaultsSettings` accepts a purpose to render its model controls on this page. The same handlers keep OpenCode model identifiers, native variants, default precedence and active-chat overrides consistent with existing Sessions settings.

### Why purpose drafts survive connection setup

The purpose editor stays mounted while the Connections tab opens. Creating a compatible connection returns its ID to the requesting purpose, including when an old connection was already selected, and retains the chosen model and parameters. Credential drafts leave the tree when their tab closes.

### Why recommendations and verification are separate

A documented model can require an adapter that the running consumer does not have. Recommendation status communicates compatibility, while the server's purpose-specific test result records actual validation. Saving a key alone establishes neither.

### Why setup defaults and tests stay explicit

A recommendation seeds its documented endpoint and model ID. Workspace placeholders resolve before save, while manual custom endpoints remain editable. The defaults action restores the selected recommendation. Local loopback endpoints may use an empty key. Probes run only on explicit request against a saved connection, and their result is scoped to that model, protocol and purpose.

## Purpose overview

`modelOverviewRows.ts` projects every catalog purpose into separate configuration and last-test states. `ModelConfigurationOverview` renders configured purposes first, then currently actionable purposes. Planned purposes remain discoverable under a collapsed Other capabilities disclosure with read-only view actions. Connections and component coverage retain their tabs and all existing Settings targets. The overview is the initial tab and has the searchable `models.overview` anchor. Native and inherited component choices remain separate from centrally verified bindings.

The page reads public native preferences, one knowledge-model projection and routing ownership while the overview is visible. Failed reads remain unknown; they never imply empty configuration. Voice preferences come from the existing shared store. Authoritative native settings can clear a user override; only the OpenCode default is a fallback after that read. Routing uses the effective classifier and administrator pin, so an inactive user binding cannot supply its green test status.

Test status describes the last persisted purpose probe. Its timestamp and safe failure guidance are visible without hovering; a generic HTTP 400 asks the user to check model, protocol and request parameters without guessing a batch limit. Connection-only probes and saving a binding cannot mark a purpose healthy. API-key reference changes invalidate verification at the server boundary. Tests run only on explicit click against the current saved revision. A failed test request is unknown until retry or refresh; an accepted subsequent mutation clears that request error. Inherited/native/local choices require component verification. Planned purposes remain listed without being counted as missing configuration.

Overview metadata reads and test completions check runtime identity and request lifetime. Hidden, unvisited purpose controls do not mount until opened; after the first visit purpose drafts stay mounted during tab navigation. The same UI serves web, Electron, hosted mobile and Capacitor. VS Code keeps native configuration links and marks app-owned state unavailable.

## Product-help connection guide

`ModelConnectionEditor` exposes stable Settings anchors for provider selection,
connection details and the explicit test button. It reports only operation
outcomes to the product-help guide, never field values or credentials. A selected
preset/connection advances selection; an authoritative save response advances to
testing; only a verified test of the unchanged form completes the guide. Failed
or superseded tests cannot complete it. When this guide is active, saving keeps
the editor on Connections rather than returning to a previously opened purpose.
The guide completion explicitly leaves purpose binding as a separate operation.


### Why quick setup separates discovery from key creation

Changing the authorization source only changes local form state. Discovery is the primary action; creating a new SuperWagie managed key requires expanding its labeled action. Imported managed keys must match the current account and instance, while native LLMRouter keys use custom connections. Preview and replacement confirmation keep their existing authorization boundary. Purpose labels and translated actions lead the preview; fingerprints, instance identifiers and raw diagnostic codes are available in technical details.

### Why connection tests name their model explicitly

The connection test model is labeled separately from the model saved for a purpose. Saving a connection never marks it tested, and a successful connection test cannot verify a saved purpose binding. Last-test result and timestamp are scoped to the unchanged test form.

### Why test motion does not estimate completion

Single probes return a final result without intermediate provider events. A
continuously visible wait indicator communicates that a request is outstanding;
it cannot establish completed authentication, a response percentage, latency or
usage. Image probes retain their existing longer server deadline and show a
longer-wait explanation. Changed forms, revisions and runtimes cannot adopt a
late result as verification of their new configuration.

Batch setup keeps one overall running indicator and separate model results. Its
server exposes pending results without naming the model currently executing, so
pending rows say they are awaiting a result. Skipped or unavailable models remain
explicit and do not count as passed. A failed status read stops the running
presentation and offers read-only result refresh; it never repeats a model
request. Closing the wizard clears its scheduled status poll. Existing expensive
probe exclusions, test ordering and billing behavior remain unchanged.
