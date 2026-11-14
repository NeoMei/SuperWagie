# Guest file paths

## Ownership

These helpers adapt guest file requests and session artifact references for the host. The SDK owns path scope and wire validation; `packages/web/server/lib/guests/files.js` owns grants, declared patterns and canonical filesystem containment. The wider guest protocol is documented in `packages/sdk/DOCUMENTATION.md`.

## Invariants

- File opening selects the deepest registered project containing a forward-slash absolute path, including drive and UNC paths. Sibling prefixes, traversal, NULs and backslashes are refused. This selection does not grant server filesystem access.
- Owner comparison folds case for drive and UNC paths, matching the Windows equivalence rule in `path-utils.ts`; POSIX comparison stays case-sensitive. Comparison keys do not rewrite returned path spelling. Backend grants and canonical containment remain authoritative.
- Session artifacts preserve drive paths and file URL authorities. `file:///C:/...` becomes `C:/...`; `file://server/share/...` becomes `//server/share/...`. Relative artifacts resolve against the session directory. Artifact discovery does not read files or authorize access.
- Guest file requests pass plain header tuples into `runtimeFetch`. It encodes non-Latin-1 directory hints and adds `x-opencode-directory-encoding: uri`; the server decodes only marked values. Unmarked literal percent sequences stay unchanged.
- `PluginPane` validates the registered owner first, then opens the absolute file under the visible chat's effective directory without selecting a project or changing its session, draft, or global directory. The tab key is not a filesystem authorization grant.
- File opening compares the target's `spaceIdOfDirectory` with the actual FilesView content root: `panelContentDirectory(useDraftSpaceTarget(), effectiveDirectory)`. A ready pending space can have a host tab key and a space content root; preparing has no content root. Missing roots and cross-host/space or different-space targets fail before reads, tab creation, or overlay dismissal. Existing outside-root, backend containment, and HTML preview permissions still apply.
- `openSurface('product-help')` can open the built-in assistant before a project
  directory exists. Only that mode receives the UI-only product-help panel key;
  every project-dependent surface still reports `NO_DIRECTORY`. Repeated open
  requests keep the same panel visible rather than toggling it closed.

- Direct Workflows entry requires both server support and persisted workflow
  opt-in; a disabled feature returns the existing `UNSUPPORTED` result before
  creating a context tab.

## Decisions

### Why directory headers remain tuples until transport

Constructing `Headers` with a Chinese project directory throws before runtime encoding can run. Passing tuples lets the existing runtime transport own encoding and authentication for both direct and relay requests.

### Why file URLs are parsed before extracting their path

A file URL has an authority and an encoded path. Removing only `file://` loses UNC authority semantics and leaves a leading slash before a Windows drive. URL parsing retains those components so the artifact can reach the existing project containment check.

### Why opening a file does not select its owning project

The visible context panel follows its chat/session/draft, not the active project. Switching projects and keying the tab by the file owner can hide the result behind the unchanged chat. Opening beside that chat preserves navigation, while checking its content root prevents FilesView from routing the file to the wrong host or space. Hook-derived refs retain the visible column's live directory rather than imposing the main chat's imperative directory on every guest surface.


## Passive results and hosted phone selections

The SDK owns result-card types and parsing. `PluginPane` accepts plain cards only from the bundled workbench and creation while that frame owns the visible directory/session. It clears them when that authority changes. `GuestResultCards` draws the text and owns local desktop selection/revocation controls; an iframe receives no account key or selection credential. Selection uses the optional `RuntimeAPIs.officialSelections` capability. The web adapter reaches privileged native IPC only in the Electron local runtime; every unsupported runtime reports `mobile_selector_unsupported`. Account/project changes cancel the caller's pending operation, and runtime switches cancel the native lease. Selection-list ownership includes the runtime instance so an old response cannot restore previous titles.

`mobile-official.ts` parses the separate phone projection. The ordinary mobile and VS Code guest catalogs remain unsupported. A phone mounts no guest iframe and receives no files, filesystem, Downloads, prompt, service or background grant. Hosted mobile reads selected server snapshots through `MobileOfficialPane`; Capacitor shows explicit unsupported copy. Account changes invalidate cached lists, pending responses and previews. Runtime/project keys prevent old titles appearing after navigation.

### Why result metadata does not grant file access

A guest can name a path in a passive card because the existing host preview owns any actual file operation. Phone selection is a separate host control whose server checks native local-owner authority, registered project containment and verified account ownership. A manifest or a viewport cannot grant that authority.

## Creation approval admission

`creation-approval.ts` owns the host-side inspection, claim and prompt sequence for the bundled creation panel's `/api/creation/decision` SDK request. This is an intercepted iframe request, not a public HTTP write route. `PluginPane` remains a thin frame/grant/context boundary. The optional native `RuntimeAPIs.creationApprovals` capability returns parsed inspection and receipt unions. Inspection unavailability preserves the existing ordinary confirmation path with visible coordination-unavailable copy. A stale inspection or unreadable claim/receipt blocks coordinated dispatch.

The server persists an unknown receipt before returning admission. The host sends at most once for a newly admitted claim, verifies its original frame/project/session/runtime/account first, and never retries after claim or dispatch ambiguity. A retained claim only returns its receipt. Prompt admission changes the receipt to accepted; generation completion needs independent engine evidence. These receipts neither grant mobile writes nor prove notification removal.

The native result is rechecked after awaited controller IO, and the host checks its original owner immediately after native admission resolves. A lease canceled during durable publication receives no dispatch permission. The durable unknown claim remains readable by its original verified owner and prevents replay across controller restart.

### Why approval dispatch stays in the host

Returning a dispatch token to a guest would let a reloaded or replaced frame reuse it after its source ownership ended. The host holds the original frame lifetime and sends through the existing session prompt flow once. Native account authentication supplies verified ownership and leaves the session's existing model and payer selection unchanged.
