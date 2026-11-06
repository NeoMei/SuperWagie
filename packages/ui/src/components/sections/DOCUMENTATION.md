# Settings sections

One directory per Settings page. `shared/` holds the page chrome and controls
every page is built from; see `.agents/skills/settings-ui-patterns/SKILL.md` for
which primitive to reach for.

Keyboard instructions in Settings resolve through `formatShortcutForDisplay`
inside render, including sending and modifier-click hints. Search descriptions
resolve the same parameters when results are built, so the UI and search name
the keys on the current client's keyboard.

## About update checks

The About page keeps its check button busy until every check started by that
click has settled: the app, a connected remote server when present, and the
OpenCode status. The existing 800 ms feedback window keeps a fast result
visible. Both layouts show the spinner and checking label inside the disabled
button, with both labels reserving their width. A failed check leaves the mobile
retry button available.

Only a click on this page owns its completion toast. Background checks and
checks started by the menu still update the button state without adding a
second result toast. A failed remote-server check suppresses the page's
up-to-date toast.

### Why the page tracks its full check request

The app's shared update store can finish before the remote server or OpenCode
status does. Page-local pending state keeps the clicked button busy for that
whole request without changing which runtime the shared store updates.

## Remote connections before sign-in

Recovery host switchers render `RemoteConnectionsPage` in their own dialog. It
shares the native host, pairing-link and SSH editor with `RemoteInstancesPage`,
without requiring an active runtime API provider or loading the server's
device-management capability. The authenticated Settings page keeps its normal
device-management behavior. A runtime switch closes the recovery editor and
returns to that runtime's access gate.

## Product help actions

The language picker reports its open action to the active product-help guide.
A language change completes that guide only after its settings write succeeds
and a readback matches the current selection. Later selections, unmounts and
guide restarts invalidate earlier results. The guide receives an action outcome,
not form values. The theme section exposes one stable anchor covering color mode
and both theme pickers.

## Autosave on the OpenCode configuration pages

`agents/`, `commands/`, `skills/`, `mcp/`, `plugins/` and `behavior/` edit files
that OpenCode v2 watches: it picks up a change and applies it within a second or
two, and the server answers every config mutation with a plain
`{ success, message }`. There is no restart to wait for and no restart state to
show, so these pages carry no Save, Apply or Discard button.

The contract, implemented by `shared/SettingsAutosave.tsx`:

- Toggles, chips, selects, pickers and row removals write immediately. They call
  `requestSave()` right after setting state; the hook runs the save after the
  render commits, so the routine reads the value the control just set.
- Text fields write when they lose focus. `SettingsPageLayout` takes the hook's
  `onBlurCapture`, which fires for any input, textarea or editor inside the
  page, so individual fields need no handler. Long editors (the skill document,
  a plugin file) also write on Cmd/Ctrl+Enter.
- A page's save routine compares the form against what it last wrote and returns
  `AUTOSAVE_UNCHANGED`, `AUTOSAVE_SAVED` or `autosaveFailed(reason)`. Success is
  silent and there is no inline "Saving…"/"Saved" indicator: a write is not
  something the user waits for. A failure is an error toast,
  "Couldn't save: <reason>", raised by the hook itself.
- **One page, one save routine.** A section that writes its own request still
  reports through the page: `agents/AgentPermissionsEditor.tsx` hands its save
  routine to `AgentsPage` via `registerSave`, and the page's save runs it, so a
  failure is reported once.
- Saves run serially. A save request received during a write queues one follow-up
  using the latest committed form state. Unmounting prevents that follow-up.

Do not route these pages through `reportSettingsSaveState` / `showSaveStatus`.
That indicator belongs to settings persisted by `updateDesktopSettings`, and it
is deliberately silent on success.

### Reconciliation

OpenCode re-reads files after writes. Store refreshes can arrive before the
save promise settles, while the user is already editing the next version.
Commands compare incoming values with both the saved baseline and the normalized
submitted snapshot. Successful saves keep that normalized baseline for late
echoes. Agents and MCP preserve dirty drafts and their baseline during refreshes
of the same entity; successful saves advance that baseline. Skills and plugins
preserve dirty drafts while updating their server baseline. A failed write leaves
the form dirty for retry. Superseded skill detail reads are ignored.
Behavior only normalizes the submitted prompt if the user has not changed it.

Scope reconciliation to the selected entity and Settings directory. Selecting
another entity hydrates its form, and an older save completion must not replace
its baseline. Runtime endpoint changes remount Settings through the keyed
`SyncProvider` in `App.tsx`.

### Creating an entity

A new agent, command, skill or MCP server is a draft in its store, not a file.
Nothing is written while the draft is being filled in: the page shows Create and
Cancel, Create validates (name, and whatever else the entity needs) and writes
once, and Cancel drops the draft. Abandoning a half-typed entity leaves nothing
on disk. Once the entity exists, the page switches to the autosave rules above.

`skills/` follows the same split for supporting files: editing an existing file
writes when the dialog closes, while a new file is only created on confirm.

MCP mutation dispatch belongs to its rendered, mounted selection and effective
Settings-directory visit. Runtime-instance, effective-directory, selection and
draft subscriptions retire old callbacks before another React commit, including
round trips back to the same values. Create, Delete and queued autosave check
that visit before validation, busy state or the first store mutation.

Create and autosave also require committed form hydration for that visit. An
existing server hydrates from its directory's successful config catalog; a new
server hydrates from its current store draft. Retained fields from an unloaded
or failed new visit cannot acquire write authority. Hydration publishes its
owner with the field state, so an effect updating the saved baseline cannot
authorize the previous rendered values. Same-visit dirty edits survive catalog
refreshes, and a successful save advances only its submitted baseline.
A successful catalog removing the selected entry revokes its form token
synchronously, including removal and reappearance batched before commit. The
retained fields remain visible without write authority; a reappearing entry
hydrates fresh fields and a new token. Failed reads preserve the previous
authoritative catalog and its current dirty form.

MCP create/delete completion keeps its runtime, directory and exact operation
owner. Delete retains ownership when its own store clears the deleted
selection. Every subsequent non-null selection, including the same server name,
or another draft retires it and resets the previous confirmation and busy state.
Create requires `ok`
and waits for its status refresh before clearing the owned draft and showing
the result. Both detail and grid callers discard retired results and toasts.
A retired page's unmount cleanup preserves the next runtime's selection and draft.

### Why MCP mutations retain operation identity in the page

The store captures the runtime at invocation. A callback exposed by an earlier
render therefore checks its own visit before invoking it. After dispatch,
per-operation ownership protects caller continuations and prevents an older
completion from releasing a newer operation's busy state. The MCP-local hook
observes authoritative directory and selection transitions that React combines
into one render. Issued Delete work retains its runtime/directory owner across
its own selection clear; later non-null selections still retire its operation.

### Agent operation ownership

Agent sidebar and editor work belongs to one mounted runtime instance,
Settings-directory visit, selected agent and draft. The shared agent operation
hook observes selection, draft and effective-directory transitions synchronously,
including transitions combined into one React render. Each caller checks that
visit after every await. Individual sidebar and create operation identities
also prevent an older finalizer from ending a newer busy state.

Rename checks ownership after reading the stored entry, after creating its copy
and after deleting its old name. Retirement stops the remaining steps and
feedback. An already submitted write may finish on its original host. If the
copy was created before retirement, both names can remain there; no delete is
issued against the newly selected runtime. Duplicate cannot install a retired
draft. Delete and disable clear only their captured, still-owned selection.

The editor checks ownership between its permissions save and its own PATCH.
Retired saves return an unchanged autosave outcome, preserve the current draft
and baseline, and suppress obsolete errors. Existing-agent saves wait for their
own visit's stored-entry hydration before writing. Current saves retain newer
edits made while their request was pending.

The permission model and baseline receive write authority only after their own
agent, directory and visit have a successful permissions read. A pending or
failed read leaves retained previous-visit values without authority. The
page can still save its separately hydrated config fields. A current permission
write failure keeps its hydrated rules dirty for retry.

### Why agent continuations share visit ownership

A store can reject a retired runtime response while its caller still starts
another mutation or clears a newer draft. Shared visit ownership covers those
continuations without changing the store's transport or the entity formats.

## Providers

`providers/` is not an autosave page. Connecting a provider is an action, not a
setting: an API key is submitted, an OAuth flow is completed, a credential is
removed. OpenCode owns the credential store and announces every change
(`credential.*`, `provider.updated`, `model.updated`), and it watches the config file a custom
provider is written to, so the page never asks for a reload or a restart: it
refetches its own provider sources and integrations and lets the catalog
events refresh the stores. (The old "nudge" went through `/api/config/reload`,
which restarts a managed OpenCode and showed the reload overlay.)

Every credential write (`integration.connect.*`, `integration.oauth.*`) goes
to the location the integration list is read from, through
`getIntegrationClient()` in `lib/opencode/integration-catalog.ts`. OpenCode
registers integrations per location once that location's plugins activate,
and only `integration.list` waits for it. An unscoped write landed in the home
location, which nobody had read yet: it booted there and answered
"Integration not found", so every first connect failed and the retry worked.
`credential.*` routes are not location-bound and stay unscoped. Every new OAuth or external-connect request resolves the current integration client. An active OAuth attempt keeps its starting client for status, completion and cancellation even when the app changes project. After cancellation or completion, the next request resolves the current project again. An explicit directory or integration prop change retires the form's current request, while an ordinary rerender keeps it. A request returned after retirement or unmount cannot publish progress or completion; an OAuth response is cancelled through its original client without opening a browser. Attempt owners also capture the runtime instance. A response after a runtime switch, including an A-to-B-to-A round trip, cannot open the browser, start code completion or publish success before React cleanup runs. Requests already sent retain their original client.

An integration method can declare a `form` (an Azure resource name, a
Cloudflare account id). OAuth, external and API key methods render it through
the same `ProviderFormFields`, check required fields with the helpers in
`provider-oauth.ts`, and send the answers with the connect call. OpenCode
rejects a key whose required fields are missing. A `custom` field with options
(AWS profiles, Azure resources OpenCode found on the server) offers "Other…"
for a value it did not find.

A provider's sign-in buttons come from its integration's `oauth` and
`external` methods in declared order (`getSignInMethods`), both rendered by
`providers/ProviderOAuthMethods.tsx`. An `external` method (2.0.25+: Azure CLI
login, AWS profile for Bedrock) asks only its form and calls
`integration.connect.external`, which stores a reference to credentials managed
outside OpenCode; the account then lists as "External credentials".

A provider's credentials show as one collapsible card per kind: API key,
browser sign-in, credentials on the server machine
(`providers/ProviderAuthMethodCards.tsx`, built on the Integrations page's
`IntegrationCatalogCard`). The same cards serve the connect page and a
connected provider's page, where they are always on screen. A card names its
kind, says in one line how it works, and carries a pill: In use, Not in use,
Sign in again or Not connected. Opened, it lists the stored accounts of its
kind with their Use, Rename and Remove actions, then the field or button that
adds another. Under a stored account that field or button waits behind "Add
account": an empty key field under a key reads as "replace this key" and a bare
Connect as "reconnect", while both add another account that becomes active. A
provider with one kind starts with its card
open. Keys from environment variables are listed above the cards. A key
OpenCode takes from the environment or the config, or credentials on the
server machine, mark their own card In use, or the key card when the provider
has no card of that kind. In enterprise mode the cards keep the stored accounts and
offer nothing new.

The cards replaced a separate account list over an "Add account" panel that
stacked the key form and the sign-in buttons. That panel read as steps to
complete in order: people saved a key and then signed in as well, and only
learned from "not in use" that one replaces the other, while the account list
repeated what the pills now say. A stored credential records its kind (`key`,
`oauth`, `external`) but not the sign-in method that made it, so the sign-in
methods of one kind (OpenAI's ChatGPT and legacy Codex flows) share one card.
Closing a card unmounts its body, which cancels a sign-in still waiting there,
the same as its Cancel button.

Vertex can sign in through Google Application Default Credentials on the server
machine, which OpenCode neither stores nor reports as a connection. When
OpenCode resolved a project for Vertex (`settings.project` on the provider it
serves), `usesMachineCredentials` counts that as credentials: the card shows
"From environment" and the models section stays open. A provider listed in the
OpenCode config is switched on (`activation: "enabled"`) even without a key, so
activation alone is not a sign-in signal.

The custom-provider form can discover models before save through
`POST /api/provider/discover-models`. Discovery is a one-time prefill the user
starts with "Find models": they pick which returned models to add, the review
panel closes, and nothing stays in sync with the provider afterwards (a
maintainer decision; never add a recurring refresh). Provider metadata wins
field by field and models.dev fills the gaps. Discovery failure never removes
rows or blocks saving.

Model rows render collapsed (name, id, limits, non-text inputs) so a provider
with dozens of models stays scannable; a row added by hand opens, and a row
with a validation error opens on submit. Capabilities are written to the
OpenCode config only when they are known (saved config, discovery, or the
user's edit, `capabilitiesKnown`); otherwise the key is left out so a save
never replaces what OpenCode knows about a model with a text-only default.

Custom-provider icons are OpenChamber profile preferences, keyed by provider
ID. They are not written into OpenCode config because OpenCode has no provider
icon field. "Default" stores nothing, so the provider's own logo (or the
generic fallback) still shows; `ProviderLogo` reads a chosen icon before trying
provider logos, so Settings and every model picker agree.

### Why management results keep separate runtime and visit owners

A Disable result publishes its authoritative disabled list and refreshes the
captured Settings directory while its starting runtime instance is current.
Provider navigation does not invalidate that data. The selection clear belongs
to the initiating rendered visit, so a late result preserves a newer provider's
key form. A runtime switch, including an A-to-B-to-A round trip, retires the
follow-up catalog read before it can resolve a new runtime's SDK.

Custom Disconnect captures its editor visit for final editor cleanup. Leaving
and reopening an editor, including the same provider ID, protects that new
visit after either success or failure. The already-authorized credential
removal sequence retains its original SDK and may finish on its original host.
Busy state identifies its exact producer, so an older Disconnect finalizer
cannot release a later custom Save while its request remains pending.
Account Activate, Rename and Remove retain their same-runtime authoritative
integration refreshes after provider navigation.

### Why ordinary key completion retains its provider visit

An ordinary API-key success publishes the page's optimistic connection, provider
selection and source/integration refresh only while its rendered provider visit
is current. Selection and candidate changes retire that visit synchronously,
including leaving and returning to the same provider ID. An earlier success
cannot replace the newer selection or discard its dirty key and method answers.
An authoritative provider list or integration connection can remove the current
ordinary provider candidate before its key response arrives. Clearing that
candidate acknowledges the catalog without retiring the action, whichever read
finishes first. A later user selection or Back still retires it. Missing, MCP
and web-search integrations retire normally, including removal and reappearance.
An already issued key request may finish on its original client, and its existing
success/error feedback remains unchanged.

### Why custom-provider saves retain their editor owner

Custom-provider config, key storage and icon persistence belong to one mounted
runtime instance, effective Settings-directory visit and custom-provider editor
visit. Runtime and directory subscriptions retire the visit synchronously,
including round trips combined into one React render. Provider selection,
candidate changes and edit cancellation retire old rendered submit callbacks.

The actual custom form is keyed by that visit. A new runtime or directory cannot
inherit an earlier form's API key, headers or model edits through a new submit
callback. Edit initial values and source/config snapshots carry their scope;
an unloaded or failed new scope cannot authorize retained fields. Same-visit
rerenders and failed writes keep dirty fields available for retry.

An authorized submit captures the integration list's intended SDK client before
writing config. Config still comes first, and only an integration-not-found
failure receives the existing bounded key retries. Each later phase and retry
checks the original owner. Already dispatched work may finish on its original
host. Retirement stops subsequent writes, icons, optimistic catalog updates,
selection changes and feedback. Exact operation identity prevents an older
finalizer from ending a newer save's busy state.

The "Connect provider" page lists `GET /api/integration` minus the
integrations that already have a connection, MCP OAuth registrations
(`mcp_*`), web search providers (the ones `websearch` lists, and integrations
a plugin marks with `metadata.websearch`, which it lists for search only once
connected), and providers OpenCode already lists (those
connect from their own page); v2's `GET /api/provider` lists only what is
configured or connected right now, so it cannot offer anything new
(`providers/connectableProviders.ts`). Popular providers come first as cards,
in the fixed order of `POPULAR_PROVIDERS`, with a one-line note and a
Recommended pill on the ones the maintainer recommends; every other provider
is a compact row behind "Show all", and the search covers all of them.

The integration list is kept for the app session by
`lib/opencode/integration-catalog.ts`, so the page opens on it without a
loading state. The desktop/web/VS Code app reads it once at startup when the
browser is idle (`hooks/useIntegrationCatalogPrefetch.ts`); the phone layout
and relay connections skip that read, because relay bytes are paid, and read
it when Settings opens. The snapshot is only a starting point: the page reads
the list again on every visit and after every credential write, a read
started earlier never replaces a later one, and a snapshot from another
runtime is ignored.

### Why runtime-only MCP rows wait for the config read

The MCP grid adds runtime-reported servers after the selected directory's first
successful config read. Exact server names merge configured and runtime entries
into one configured card. An absent or failed initial config read keeps runtime
rows hidden; a successful empty catalog permits them. Runtime rows show live
status, policy denial and a translated OpenCode source label. They have no open,
edit, delete or authorization action because no config entry backs them.
Search includes both kinds by name and keeps command and URL search for configured
servers. The shared card grid retains its existing runtime and mobile layouts.

### MCP OAuth

A remote MCP server with OAuth enabled is registered by OpenCode as an
integration (`mcp_<hash>`, `metadata.source: "mcp"`, named after the server)
with `oauth` methods, so signing in is the same connect / status /
complete flow the Providers page runs. `mcp/McpOAuthSignIn.tsx` looks the
integration up by server name in the server's directory (the registration is
per Location) and mounts the shared `providers/ProviderOAuthMethods.tsx`
with that directory. While the server reports `needs_auth`, the status card
shows its sign-in row; once the credential is stored, the page connects the
server again, which is what moves it out of `needs_auth` or `failed`.

The detail page discovers OAuth for an enabled, unblocked failed server or a
configured remote server whose `oauth` field is absent or differs from false.
Discovery belongs to the selected server, Settings directory and runtime
instance. An absent integration stops discovery after 9 reads spaced 750 ms
apart. Cleanup clears its queued retry, and every read and result checks its
owner. Discovery never starts authorization or replaces a credential.

### Why a failed OAuth server's header says "Sign in again"

When the service rejects the stored token (a refresh answered with 403
`access_denied`), OpenCode reports the server `failed`, not `needs_auth`, and
keeps the rejected credential. Connect only sends it again. A fresh sign-in
starts with no tokens (it reuses only the earlier client registration) and
its new credential is the one the next connect uses, so signing in is the
whole recovery; no sign-out call is needed.

So for a `failed` server whose OAuth integration exists
(`useMcpOAuthIntegration`), the header's primary button is "Sign in again" in
place of Connect, and the card shows no second sign-in row: each press mounts
a fresh `McpOAuthSignIn` with `autoStart`. A single method starts with its
start button hidden; multiple methods keep their start controls so the user
can choose one. Test connection stays on the status line for
the other cause of `failed`, a server that was down; it retries with the
stored credential. A `failed` server without OAuth keeps Connect.

The Integrations catalog keeps its sign-in row and labels its button "Sign in
again" for `failed`, gated on the entry's `auth: 'oauth'` so a failed
token-based entry gets no sign-in block. It starts the sign-in by itself after
an install only for `needs_auth`: a first connect that failed for another
reason waits for a click.

### Why a connected OAuth server offers Authorize

A connected transport can expose tools that still require consent. When its
OAuth integration exists, the detail header offers Authorize unless the
server needs initial sign-in, is blocked or already offers Sign in again.
Pressing it opens the same sign-in flow in the status card. One panel remains
mounted if the transport reports `needs_auth` during the attempt. Completion
reconnects the original server and directory while that owner remains active.

The explicit autoStart intent belongs to the server, directory and captured
runtime instance. Changing any owner or disabling/blocking the server retires
that intent and the mounted flow. Returning to the same path or server name
requires another user action.

The Integrations catalog offers Authorize for connected OAuth entries too.
Token-based connected/failed entries, disabled entries and policy-blocked
entries have no sign-in action. Only the existing user-triggered install path
may autoStart initial `needs_auth`; its intent is directory/runtime-scoped.
The catalog is mounted by web and desktop. Mobile and VS Code use shared MCP
Settings. Authorization URLs retain the shared external URL helper's browser,
desktop and VS Code routing; the feature does not construct callback URLs.

### Claude sign-in on Usage

Claude usage reads Claude Code's own login on the server machine, which the
Providers page cannot add. When Claude reports not configured, the Usage page
shows `usage/ClaudeCodeSignIn.tsx` in its warning instead of the "go to
Providers" text. With the opencode-claude plugin installed it mounts the
plugin's `claude-code` integration sign-in through the shared
`providers/ProviderOAuthMethods.tsx` and re-reads Claude usage once it
finishes. Without the plugin, or when the integration list cannot be read, it
shows the `claude auth login` command, which works in both cases.

### Policy-blocked MCP servers and skills

OpenCode drops an MCP server or skill an `integration.use` deny names
(`mcp:<name>`, `skill:<id>`, wildcards allowed) from its own lists, while the
MCP and Skills pages list what the config files and the disk hold.
`shared/useIntegrationPolicyBlock.ts` reads the statements from
`/api/config` (`readIntegrationPolicies`, decided like OpenCode: documents
reversed, last match wins) and the MCP page marks such a row "Blocked by
policy" and disables Connect and Test. Statements from a connected OpenCode
Console workspace are not in `/api/config`, so a server blocked only there is
not marked.

Policy reads and displayed results belong to their directory and runtime
instance. `useRuntimeInstance` subscribes to endpoint changes using the
existing runtime-instance capture, so same-path switches and batched runtime
round trips refetch policy without accepting an earlier result. Subscription
immediately reconciles the captured instance so a commit-phase switch before
the passive effect is observed. Read failure
keeps the existing unmarked UI behavior; OpenCode still enforces policy.

The Skills page reads the same statements from the skills store. One choice,
"Agents use it" (`skills/SkillUseField.tsx`), answers when agents get a skill:
Automatically, When called (the skill file's `disable-model-invocation` flag)
or Off. A skill's id is its `SKILL.md` folder name, not its display name. Off
writes an exact `skill:<id>` deny where the skill lives (project config for a
project skill, global config otherwise) and leaves the file's flag alone;
leaving Off removes the exact deny from every config file OpenCode reads for
the directory, hand-written ones included. A skill an exact deny turns off
reads "Off" in the sidebar. A wildcard deny is someone else's rule: the choice
is locked, the row reads "Blocked", and the page names the rule and its file.
An allow that decides the skill is named the same way.

### Why one choice and not a switch beside the checkbox

"Run only when called" and "off" answer the same question, when an agent may
take the skill, so two controls let a user set a combination that reads as
nonsense (off, but only when called). One three-way choice keeps them apart
in storage and together on screen.

### Why Off writes where the skill lives and not into a chosen scope

A scope picker would make every user learn how OpenCode orders global and
project policies (global wins) before turning a skill off. Writing where the
skill lives covers the common case with one control, and turning it back on
clears the skill's exact deny wherever it is, so no file keeps a stale rule.

## Skills catalog list

Skill Settings actions belong to their rendered runtime, Settings-directory and
selection visit. `skills/useSkillOperationOwner.ts` observes authoritative store
transitions synchronously, including round trips before React commits, and
retires work on unmount. Initial dispatch also requires that rendered owner.
The editor writes only after its current visit has successfully hydrated its
detail or explicit draft. A pending or failed detail read cannot lend the new
visit an old dirty model or saved baseline. Same-owner refreshes still preserve
newer text while advancing the server baseline.

Supporting-file reads and mutations additionally belong to one dialog visit.
Closing or replacing that visit prevents late content, detail refreshes,
confirmation changes and feedback from reaching the next file. Sidebar rename,
duplicate and delete retain the same ownership across their waits. A successful
delete clears selection in its owning caller before any later visit can reuse
that name.

Catalog uninstall validates its items against the current catalog before the
first deletion, then retains its runtime, directory, action and source definition
before each later deletion, even when the preceding deletion returned failure.
An equivalent catalog echo may replace item objects without retiring the batch;
a removed or rebound source retires it. Ordinary same-owner partial failures
continue through the batch and resolve retained failed items against the refreshed
source on retry. Install
and conflict retry intents belong to the current dialog and source entries;
reopening a dialog cannot inherit the previous install's completion.

Catalog selection and source-binding transitions retire a batch synchronously.
Returning to the original selection or binding cannot revive its intent. Before
each deletion, the next pending item's request-relevant binding must still match
the current source inventory. The source index is rebuilt only when that array
changes; already deleted rows do not have to remain in a later echo.

### Why skill payloads require a hydrated visit

A new runtime or selection owner can mount while the previous form remains
visible and the new detail read is pending. The form's saved baseline and
payload authority change only after a successful current-visit read, keeping
old instructions out of a new host's writes.

The catalog page lists one source, or every source's search matches, in
`skills/catalog/SkillsCatalogRows.tsx`. From 100 rows on it mounts only the
rows near the viewport, measured inside the settings page's own scroller; a
shorter list renders every row.

### Why a threshold and not a virtualized list for every source

A source can hold thousands of skills: `sickn33/agentic-awesome-skills` has
8,451, and mounting them all froze the page for about 28 seconds on a source
click and up to 47 seconds per search keystroke (#5455). Most built-in
catalogs hold fewer than 60 rows, and a fully mounted short list keeps the
browser's find-in-page and Tab order over every row.

### Why the list waits for the page's scroller

A virtualizer attached before it knows the scroller starts at offset 0 and
scrolls there, so clicking Cursor or a large source on a scrolled page jumped
to the top. The list finds the scroller first, starts from its `scrollTop`,
and holds its estimated height meanwhile, because a list of height 0 for one
render shortens the page and the browser clamps the scroll position.

### Why a row measured at 0 keeps the estimate

A page hidden while the list is mounted measures every row at 0 height. The
virtualizer would then fit the whole list into the viewport, mount all of it,
and re-render without end, so a zero measurement keeps the estimated height.

## Integrations: provider cards

`integrations/IntegrationsPage.tsx` draws one card per source-control provider
and one per tracker the connected server serves, in the registries' order
(`lib/source-control/providers/registry.ts`, `lib/trackers/registry.ts`). No
card names a provider: a provider the server adds (Gitea) appears with no code
here. Source-control cards are left out in VS Code, which uses the editor's own
Git integration; tracker cards exist where the runtime has `RuntimeAPIs.trackers`.

`integrations/SourceControlProviderCard.tsx` takes its name, mark and wording
term from the descriptor. Its body is one `openchamber/ProviderInstanceAccounts`
block per instance of that provider (the default instance stands in until one
is listed), and "Add instance" where the descriptor's settings take an address
(an `instance-url` field) and `instances.multiple` allows another or none is
set up yet. A block offers the sign-in methods the descriptor names *and* the
instance reports available (`capabilities.authenticationMethods`): device
code, personal access token, and the provider's CLI login. When both the
device code and a token are offered, a chip switch (`SettingsChipGroup`)
picks one and only its form shows; it starts on the method an existing
account came from (`oauth` is the device code, `pat` the token), else the
first one the descriptor names. The CLI login keeps its own row. The token
form shows the scopes the descriptor names, literally, under "Create token";
the info hint stays.
Where the descriptor's settings have a `username` field, the token form asks
for a username above the token and sends both (`authSetToken(…, { username })`);
an `http-password` field names the secret an HTTP password instead of a token
(`sourceControlProviderSettings.ts`). Gerrit signs in this way.
`normalizeInstanceInput` reads what the user typed the way the descriptor
says: an origin or a bare host, HTTPS only (HTTP on loopback where allowed), a
port only where allowed, reserved instances refused.

Invariants:

- A token field is a password input that starts empty, is cleared once the
  server accepts the token, and is never logged; a rejected token
  (`INVALID_TOKEN`) stays in the field with the rejection under the address.
  An instance the server says belongs on another provider's card
  (`SourceControlInstanceOtherProviderError`) keeps the token too, and the
  line under the address names that provider by its descriptor's label.
- An instance's async work is dropped when the runtime switches mid-flight
  (`captureRuntime`), so a late answer never writes into the next server's state.
- The github.com device flow (`openchamber/GitHubComAccountSection.tsx`) shows
  only for a descriptor whose `instances.legacyFlow.kind` is
  `github-com-device`; the instance list under it, titled "Other instances",
  leaves that instance out.
- A descriptor that names a settings field kind this version cannot draw shows
  an "update OpenChamber" line instead of the instance setup.
- Settings search anchors: the card is `integrations.source-control.<id>`, its
  body `.connect`; tracker cards keep `integrations.<id>` and its
  `.add-workspace`, `.mapping` and `.session-comments` anchors, the ids
  Linear's entries always had.

`integrations/TrackerSettings.tsx` is the tracker card: browser sign-in with a
poll that stops when a new or re-authorized account appears, disconnect, and the
account switch where `multipleAccounts` is set. `TrackerProjectMapping` and
`TrackerSessionComments` show where `projectMapping` and `sessionComments` are
set. A tracker that offers no browser sign-in asks for an update instead of a
dead Connect button.

### Why `{provider}` keys and not keys per provider

The sentences these cards show name the provider through `{provider}` and the
CLI through `{cli}` (`settings.sourceControl.*`, `settings.integrations.tracker.*`),
so a provider the server adds reads correct sentences with no keys of its own.
`openchamber/sourceControlProviderSettings.ts` selects only what really differs:
the description by change-request term and the instance hint by
`allowLoopbackHttp`. `integrations/trackerSettingsCopy.ts` keeps whole sentences
per tracker only where they carry the tracker's own nouns (Linear's workspace
and team), because interpolating a noun breaks case and gender in de, pl, uk
and fr; any other tracker reads the generic account and group sentences.

### Why a method switch and not stacked rows

The sign-in methods used to stack, the device code's Connect above the token
field, so a first visit read as two competing forms. The maintainer chose a
chip switch: the card opens on one Connect choice and the other method is one
click away. A chip group rather than radios because the labels are short and
`settings-ui-patterns` puts short exclusive choices in chips.

## Magic Prompts

`magic-prompts/` is not an autosave page: each prompt block has its own Save
and reset button. Storage and resolution belong to
`packages/web/server/lib/magic-prompts/DOCUMENTATION.md`.

The page opens on the Global scope. The Project scope edits the project the
Settings project selector names, matched by exact path, so a worktree
registered as its own project keeps its own id. Choosing it never moves the
chat. Saving the built-in text in Global removes the global override; in
Project the same text stays an override, because it still wins over a
different global one.

A failed read or an `invalid` scope shows the error with Retry and no editor,
never editable built-in text. Drafts and writes are kept per runtime, scope,
project and prompt. A context runs one write at a time, because every write
answers with the whole scope and overlapping answers could land out of order,
and a read older than the latest write is dropped. File paths render as their
own `dir="ltr"` element so an RTL sentence never reorders them.

The page is hidden in VS Code (`metadata.ts`).

## Plugins

Plugin mutations and reads retain the rendered runtime, config-directory and
selection visit through `plugins/usePluginOperationOwner`. Plugin Settings
keeps its active-project-first directory resolution. Old rendered actions check
their visit before their first request. Selection and authoritative record
removal/reappearance retire the old editor, including transitions batched before
React commits. A failed catalog read preserves the existing authoritative form.

The editor's model and baseline receive write authority together after their
own visit is hydrated. A new file visit waits for its actual file-content read;
pending or failed reads cannot authorize retained fields from another runtime.
The authority token travels with rendered form state, so advancing a ref cannot
authorize older rendered values. Same-visit dirty edits survive catalog echoes.
Successful saves advance only the submitted baseline; failed writes remain dirty
for retry. Retired saves return unchanged and publish no obsolete autosave error.

Page, dialog, grid and banner continuations check ownership before feedback or
cleanup. Add dialog reopening and banner target round trips retire earlier
operations. A delete may finish across its own catalog removal and null
selection clear. A later non-null selection, replacement draft or new same-ID
confirmation retires its operation. An older finalizer cannot close that newer
confirmation or end its busy state. Retired page cleanup preserves the next
runtime's selection and draft.

A registry pin operation retains its captured owner across the exact submitted
pin's authoritative same-entry/source catalog echo. That echo can update the
page's banner props before the store promise returns. Success feedback still
requires the operation's successful result. A current failure releases the
action for retry. Unexpected target changes and target round trips retire the
operation synchronously, including catalog changes batched before React commits;
the captured runtime/directory/selection owner is never replaced after an await.

### Why plugin models retain a hydration token

A handler can acquire the new runtime while its fields still belong to the old
one. A rendered visit check and a token for the successfully hydrated model
cover these separate boundaries. Store rejection alone cannot stop an awaiting
caller from clearing a newer form or displaying an obsolete result.

### Duplicate sources

`plugins/PluginsGrid.tsx` keeps every configuration entry and its editing target.
A discovered package card is hidden when its normalized target is already
represented by a declaration or another discovery record. Distinct declarations
and their options remain separate, including declarations of the same target.
Editable local files always keep their own cards and file edit/delete actions,
including files declared in config.

### Why paths determine discovery duplicates

Names can match for unrelated plugins, and OpenCode's runtime list can omit
disabled or not-yet-loaded plugins. Only exact target paths filter discovery;
runtime status never controls card membership. Web, Electron and mobile use the
server's path metadata; VS Code's file-only discovery stays visible.

Discovery records keep their original `absolutePath` for runtime matching and
their canonical `resolvedPath` for duplicate filtering. Resolving symlinks in
the runtime path would lose statuses reported through the original alias.

## Entity shapes: OpenCode 2 only

Every OpenCode entity these pages read and write speaks the v2 shape defined in
`packages/web/server/lib/opencode/DOCUMENTATION.md`, section "Entity routes (v2
shapes)". The server reads v1 files too and rewrites them in place as v2; the UI
only ever sends v2.

| Entity | What the page reads and writes |
|---|---|
| Agent | `system` (the markdown body), `description`, `model` as `provider/model#variant`, `mode`, `steps`, `hidden`, `color`, `request.body.temperature` / `request.body.top_p`, and an ordered `permissions` rule list |
| Command | `template` (the markdown body), `description`, `agent`, `model` with `#variant`, `subagent` |
| MCP server | `type` (required), `command` / `url`, `environment`, `headers`, `disabled`, `codemode`, `timeout: { startup, catalog, execution }`, snake_case `oauth` |
| Provider | `package` with the `aisdk:` prefix, `settings.baseURL`, `headers`, `body`, models keyed by id with `modelID`, `capabilities`, `variants`, `cost.cache.read/write`, `disabled` |
| Plugin | `{ package, options }`, serialized as a bare string when there are no options |

Two consequences worth knowing:

- **Edit the stored entry, never the resolved one.** `AgentInfo` and the model
  catalog are what OpenCode resolved: built-in defaults, global config and live
  session grants are already merged in. Writing that back would bake them into
  the file. `agents/AgentsPage.tsx` and `AgentPermissionsEditor.tsx` therefore
  read `GET /api/config/agents/:name/config` and `…/permissions`, and the
  commands store reads `GET /api/config/commands/:name/config` because the v2
  `CommandInfo` carries only a name and a description.
- **`request` is replaced wholesale.** A PATCH that sends `request` overwrites
  the whole block, so `AgentsPage` merges the fields it owns into the stored
  `request` instead of sending only what changed.

`disabled: true` is not a soft toggle: OpenCode 2 drops the entity entirely, so
no page exposes it as an on/off switch for agents. For MCP servers `disabled` is
the documented way to keep a server configured but inactive, and the page's
"Enable" checkbox writes it.

### Agent permissions

Settings lists hidden custom agents so their files remain editable, renameable, and deletable. Hidden built-in agents stay out of Settings, and all hidden agents stay out of the composer pickers. Duplicate and rename read the stored entry and preserve its `hidden` flag.

OpenCode 2 replaced the v1 `permission` map (`bash`/`task`/`list`/`lsp` keys with
allow/deny/ask per pattern) with an ORDERED list of `{ action, resource, effect }`
rules where the LAST match wins. The user does not think in ordered rules, so
the editor keeps the v1 mental model: one row per tool with inherit / allow /
ask / deny, an arrow showing what OpenCode will actually do for that tool right
now, and resource patterns under an expanded row. `agents/agentPermissionModel.ts`
translates this view to and from the rule list. Because order is part of the
policy, a save edits the stored list in place: changed effects replace their
rule where it stands, removed rows drop theirs, rules the view cannot show (an
`*` action with a resource pattern) pass through untouched, and only new rules
are inserted (agent wildcard first, a tool's wildcard before its patterns, a
pattern last), so decisions for tools the user did not touch never change. The
arrow is computed from OpenCode's built-in defaults
(`OPENCODE_DEFAULT_RULES`), the global `opencode.json` rules and the agent's
own wildcard, in that order. v1-only keys (`LEGACY_ACTIONS`) are neither shown
nor written back.

Below the built-in tools the editor lists one row per MCP server from the
Settings directory's config (`useMcpConfigStore`), keyed `<server>_*`, which
OpenCode matches against every tool the server exposes. Every configured server
is listed, not only the connected ones, so a rule can be set while a server is
disabled or failing; the live status from `useMcpStore` is shown beside the
name as a hint. A single MCP tool (`<server>_<tool>`) is still reachable
through the custom key input.

### The legacy-format note

Config reads report `legacy: true` when the entity's file still uses v1
spellings, and mutations answer with the `path` they wrote.
`shared/SettingsLegacyFormatNote.tsx` turns that into one quiet line at the top
of the page; the file is never moved, so the note has no action.

## The project page

`projects/ProjectSettingsPanel.tsx` is one project's page, shown by Settings →
Projects (`frame="page"`) and by the sidebar's project edit dialog
(`frame="dialog"`). The header holds the icon, colour and name: the icon opens a
popover with the colour (`shared/SettingsColorField.tsx`, the same field the
Agents page uses) and the symbol or image, and the name is edited in place. Below
it a tab strip splits the rest: General (new-chat defaults, the team file, trust,
plans folder), Actions (a card grid with an editor dialog), Worktrees (setup
commands and a link to the worktrees page) and Environment (not in VS Code).
Identity fields autosave through `useProjectIdentityAutoSave`, as before.

The Settings page also carries Close project in its header. It calls the same
`removeProject` as the sidebar's Close project, after a confirm dialog like the
other removals in Settings: a header button is easier to hit by accident than a
menu item. The edit dialog leaves it out, because the menu that opens the dialog
already holds Close project. VS Code shows no Projects page in Settings: its
projects are the workspace folders VS Code has open.

A project's setup lives in two files: the team's `.openchamber/project.json` in
the repo and the user's own config (`packages/web/server/lib/projects`). The page
shows one list per kind with every entry marked Team or Only me, and
`projects/projectSetupModel.ts` maps each edit onto the file the entry lives in:

- Team entries are edited in place, in the repo file. Nothing is copied into
  the personal file.
- A move between the files writes the destination first, then removes the
  entry from the source. A failed second write leaves the entry in both files;
  the server's merge shows it once. Every edit ends with a fresh read.
- Hiding a team action writes only the personal `hiddenSharedActionIds`.
- When the repo file exists but cannot be parsed, team writes are refused: a
  write replaces the file, so it would drop what could not be read.
- `projects/useProjectSetup.ts` reads with `fetchProjectSetup`, which throws.
  A failed read shows a retry, never an empty list that a later save would
  write back over the files.

The Settings page keeps its tab in `projects/projectSettingsTabs.ts` so a search
result can open the tab that holds its target (`prepareSettingsSearchTarget`).
The dialog keeps its own tab and starts on General every time.

Project colours are six-digit hex from the same presets as agents
(`lib/colorPresets.ts`), and an image icon takes the colour as its background
(`iconBackgroundForProjectColor`). Projects saved by older builds may carry a
theme key; `resolveProjectColor` in `lib/projectMeta.ts` still paints those,
and the colour field shows them as a selected swatch until the user picks again.

## Conversation learning in the knowledge library

The knowledge-library page exposes the same `ConversationMemorySection` as the
panel's Experiences tab. Web, Electron, hosted mobile and Capacitor use the
connected runtime's authenticated conversation-memory routes. VS Code hides the
section and the tab. Existing backend installation and model-key controls remain
on desktop.

The backend owns the enabled setting and processing status. The section does not
copy either into a UI settings store. Reads and mutations use the schema-validated
`lib/conversationMemory.ts` client. A failed authoritative read retains the last
visible entries and shows the failure. A project, session or runtime change
clears selection and aborts old requests before their results can apply.
Engine health appears under the localized SuperWagie memory engine name when
the connected runtime provides it. Adapter identity and upstream version remain
internal metadata. Candidate and blocked counts remain separate from failed processing jobs.
Entry errors remain visible beside their indexing state, with the existing
retry, source and confirmation actions. Older runtimes can omit these diagnostics.

Settings lists the project selected in Settings. History processing is available
only when the selected chat belongs to that project, including known worktrees,
and sends the chat's actual directory. Merely opening the page never enables or
processes conversations. Background capture belongs to the server runtime.

A methodology proposal requires active experiences from at least 2 source
sessions in the current results. It queues an unverified candidate for review.
Candidate activation preserves verification. Entry details show the generated
body, limitations and exact source-message navigation. Forgetting removes an
entry from the normal list only after the server acknowledges the durable forget
record. Pending or failed cleanup remains visible with a retry action, including
after reopening the page.

### Why the learning setting uses its domain route

Capture jobs, forget suppression and generated entries share one server owner.
Writing the switch through that owner's route keeps the setting and runtime
status authoritative without introducing a second persisted UI preference.

### Why degraded search retains its result state

The knowledge panel keeps available file-name matches when semantic retrieval
fails and labels that result as degraded. A failed search request preserves the
previous results with a visible stale-result message. Only a successful complete
search with no matches shows the empty result state.

## Keyboard shortcut settings

`KeyboardShortcutsSettings` derives rows and labels from the shared shortcut
schema, including desktop-only native menu rows. The recorder constrains native
menus, find and permission replies to one chord; native menu recording permits up
to five physical keys. The active dialog owns a native recording lease and registry
suspension, with explicit close and unmount cleanup. It reports fixed desktop menu
reservations as non-replaceable conflicts even if the corresponding renderer
binding was unassigned. Save rechecks the current override snapshot and conflict
owner before mutating settings. English and Simplified Chinese explain these
constraints; shortcut hints elsewhere resolve the same effective overrides.
