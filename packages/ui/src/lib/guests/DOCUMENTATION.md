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

## Decisions

### Why directory headers remain tuples until transport

Constructing `Headers` with a Chinese project directory throws before runtime encoding can run. Passing tuples lets the existing runtime transport own encoding and authentication for both direct and relay requests.

### Why file URLs are parsed before extracting their path

A file URL has an authority and an encoded path. Removing only `file://` loses UNC authority semantics and leaves a leading slash before a Windows drive. URL parsing retains those components so the artifact can reach the existing project containment check.

### Why opening a file does not select its owning project

The visible context panel follows its chat/session/draft, not the active project. Switching projects and keying the tab by the file owner can hide the result behind the unchanged chat. Opening beside that chat preserves navigation, while checking its content root prevents FilesView from routing the file to the wrong host or space. Hook-derived refs retain the visible column's live directory rather than imposing the main chat's imperative directory on every guest surface.
