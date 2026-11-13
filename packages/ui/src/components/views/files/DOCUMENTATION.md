# File tree loading and visibility

The docked file surface starts with the directory tree collapsed so an opened
preview gets the panel's width. The tree toggle is still there, and reopening
it persists for later files; an empty file surface keeps showing the tree
because it is the only content then.

`FilesView` and `SidebarFilesTree` keep directory snapshots in component state.
`DirectoryRequests` owns shared in-flight reads and supersession. Repeated
same-path callers await the same request; an explicit mutation refresh can
replace it. Scope changes and unmount clear the coordinator, so old completions
cannot publish or remove a newer request's slot. Callers also check runtime
identity at completion.

Directory arrays retain their references when every rendered field and ordering
matches. `fileTreeStatus.ts` builds path and ancestor indexes once per Git
snapshot. Open-file membership has its own set, so changing tabs does not
rebuild the Git index.

Directory listings follow the "Show gitignored files" setting: `SidebarFilesTree`,
`FilesView`, and the mobile `MobileFilesSurface` ask the runtime for
`respectGitignore` unless the user has chosen to show gitignored entries, so the
server's `git check-ignore` filter decides what appears inside a Git repository.
Outside a repository no entries are ignored, so the hardcoded `node_modules`
name filter remains as a fallback. Search already follows the same setting.

## Searching

The field above the sidebar tree searches file names, as it always did. Where
the runtime has `files.searchContents` (web and desktop; VS Code has its own
search and the mobile browser keeps name search), the search icon is a menu
that switches the field to file contents. In that mode the placeholder changes,
a `.*` toggle at the end of the field makes the query a regular expression, and
the results replace the tree as one card per matching line: the file and its
folder on top with the line number, the line below with the matches marked and
an ellipsis where the server cut its start. A click opens the file at that line
as a preview, a double-click as a pinned tab (`openContextFileAtLine` with
`preview`), and a card drags into the chat like a name result. The hook
(`useFileContentSearch`) sends the debounced query with the tree's hidden and
gitignored settings, aborts the request a new query replaces so the server ends
its ripgrep process, and never lets a late answer land. "Showing the first N
matches" follows the list when the server's limit was hit, and the row says so
when the server stopped at its deadline, when the regular expression is invalid
(with ripgrep's reason), when the server has no ripgrep, or when the search
failed; none of these is shown as an empty result. The server side is in
`packages/web/server/lib/fs/DOCUMENTATION.md`.

Desktop `FilesView` in editor-only mode neither loads nor constructs its unused
tree. In the context panel the panel's tab strip owns the open files: closing
a file from the editor (Cmd/Ctrl+W in the desktop app, which the window menu
turns into `openchamber:close-tab` through `lib/closeTabTarget.ts`, or the
unsaved-changes prompt that may come first) goes through `onCloseFile` to
`closeContextFile`, which closes that tab exactly as its close button does. Mobile retains its tree. The context panel passes actual visibility,
including the panel's open state, its active tab, and the editor toggle, to each file surface.
Hidden surfaces retain drafts, loaded content and scroll state. They stop
directory and file metadata polling; reopening checks freshness once before
normal polling resumes. Autosave is independent of visibility.

Background polling never supersedes an in-flight directory read. Explicit
refresh after file mutations does. Each directory failure remains local and
preserves its previous successful snapshot.

## Creating a file

Both file-tree dialogs use the optional `FilesAPI.createFile` capability. The
web-backed implementation creates an empty file exclusively through
`POST /api/fs/create`. A collision preserves existing bytes, leaves the dialog
and typed name open, clears submitting state and shows the existing operation
failure message. A confirmed creation refreshes its parent and closes the
dialog. The adapter rejects false or malformed success responses.

File and folder creation completion belongs to the captured dialog, directory
visit and runtime instance. A retired success starts no parent refresh and
publishes no feedback; a retired failure also publishes no feedback. Closing
and reopening the dialog gives the newer operation its own busy state and
completion. An already-issued creation can still finish against its original
runtime.

Creation participates in the content-cache owner's mutation barrier and cache
invalidation, so a recreated path cannot reuse stale bytes with coincidentally
matching metadata. Ordinary editor and diagram saves keep `writeFile` overwrite
behavior. Web, Electron and both mobile runtimes use the connected server;
VS Code leaves creation unsupported and does not mount these file views.

The content-cache owner serializes create, write, delete and rename within one
runtime instance. Each mutation captures that instance before waiting. A queued
mutation rejects before dispatch if the instance changes or its owner is
disposed, including an A-to-B-to-A visit. A runtime switch retires the old
barrier so fresh reads and mutations can proceed even when an old request is
stalled. A same-instance transport or credential refresh preserves queue order.
Already-dispatched requests retain their original outcome, while their retired
completion cannot invalidate the current runtime's cache. Disposal releases new
reads from the barrier so they reject promptly; previously queued mutations
reject when their predecessor settles.

### Why runtime switches retire the mutation barrier

The stable file adapter resolves its endpoint when invoked. Delayed mutations
therefore need the runtime owner's instance check before dispatch. A separate
queue for the replacement instance also keeps a stalled old request from
blocking current file operations. Content revisions cannot identify that owner
because ordinary same-runtime mutations advance those revisions.

### Why creation does not call save

The server must resolve a name collision at the atomic creation point. A client
existence check leaves a race, and the save endpoint deliberately replaces an
existing file. The separate capability also fails visibly against older servers.

Opening a file outside the workspace reads it directly through the active
runtime, in both editor-only and full Files modes. Chat navigation and file
loading do not request native file grants. Server-backed text reads and metadata
requests have a 30-second deadline, including response-body reads, so a stalled
request reaches the existing error handler instead of leaving loading pending.

A file that cannot be read, a missing one included, stays selected and shows
the read error; the host's tab still names that path, so the editor never falls
back to another open file. A pending line jump or focus for that path ends
there. The metadata poll treats a file deleted while open the same way: without
unsaved edits it shows the error, with unsaved edits it keeps them. It keeps
polling a failed file and loads it again once a missing file is back; a file
that exists but fails to read is never reloaded by the poll
(`openFilePollStep`). Pruning stale open paths (`removeUnselectedOpenPath`)
never removes the path on screen.

A pending line jump (`pendingFileNavigationStep`) selects its file only until
that file has been on screen. If the user then switches tabs while it loads,
the jump leaves the other tab alone and runs when its file is selected again.
A read-only text file, one outside the workspace for example, opens in the
read-only code editor, because the selection effect resets the text mode after
the effect that switches read-only files to the view mode; the jump runs there.
If no editor is on screen the jump ends, so the waiting mask never hides a
loaded file.

Sidebar root/runtime changes remount the scoped tree. Its bounded module cache
provides continuity between mounts; request cancellation for collapsed paths
stops queued batches, while already-started reads may populate the same-scope
cache. Runtime changes and unmount invalidate those active reads.

The sidebar tree is virtualized (`@tanstack/react-virtual`): the expanded
folders flatten into one list of rows (`fileTreeRows.ts`, a folder's load error
right under it), and only rows in and near view are in the document. With every
row mounted, a large repository put thousands of elements under the context
panel, and opening the panel restyled all of them and added them to the
accessibility tree inside its animation. The dragged row and the row holding
focus stay mounted wherever they scroll, so a drag still ends and focus does
not fall to the page. Selecting a file scrolls its row into view through the
virtualizer once the row exists. Only mounted rows are in the tab order. Rows
keep an explicit height (the meta line height, the icon minimum and vertical
padding), so a font change re-measures them. Search results and the root
error are plain lists. Reopening still refreshes directory contents.

## Row look

The sidebar tree, `FilesView`'s own tree and the changes tree in `DiffView`
draw rows from `FileTreeRowParts.tsx`, so the three look the same: flat rows
indented 12px per level, one faint guide per ancestor level under its
chevron, a chevron instead of a folder icon, and the git state as a coloured
letter on the right. A blue dot before the letter marks a file open in a tab;
it no longer hides the file's git state. Change the look there, not per tree.
The JSON tree viewer (`components/ui/JsonTreeViewer.tsx`) takes the same
indent and guides and copies the chevron's look; keep the copy in step.

## Refreshing after file changes

The sidebar tree and the phone browser re-list folders when the agent changed
them, with no watcher and no timer: an idle client sends nothing. OpenCode 2.x
has no file events (`filesystem.changed` covers the repository HEAD only), so
`lib/fileTreeChanges.ts` derives changes from what the event stream already
carries, fed from `sync-context` and the revert actions:

- a finished `write` or `patch` names its files, so only their parent folders
  change (`toolListingChanges` in `lib/opencode/tools.ts`; `edit` never
  creates a file and counts as no change);
- a finished `shell`, `execute`, MCP or plugin call could touch anything, so
  its session waits for the step's end: the step's snapshot `files` decide.
  An empty list costs nothing (read-only commands); a non-empty or missing
  list (snapshots off, not a Git repository, a failed step) is an unknown
  change. The snapshot skips Git-ignored files and untracked files over 2 MB;
- a finished user shell command, staging a revert and clearing one are
  unknown changes.

`useFileTreeChanges` collects changes for two seconds after the first one and
delivers them as one batch, so a surface re-lists at most once per two seconds
however fast the agent works; it holds the batch while the window is hidden.
A folder whose last listing had more than 1000 entries
(`AUTO_RELIST_MAX_ENTRIES`) is never re-listed on its own, because each
re-list resends the whole listing; the refresh button and expanding it still
read it. The sidebar drops changes while its tab is
hidden, because reopening re-lists everything anyway; the phone browser holds
them and reloads the folder on screen when the drawer shows it again, keeping
the listing if that reload fails. In the sidebar a listing on screen reloads
(forced, superseding an in-flight read); a loaded folder out of sight is only
forgotten so expanding it reads it again; a new folder re-lists its nearest
loaded ancestor. An unknown change re-lists the root and every expanded folder
on screen. Changes made outside the agent (an editor, a terminal) still need
the refresh button or reopening the tab. VS Code has no file tree, so nothing
subscribes there. Desktop `FilesView` keeps its own 8-second poll of expanded
folders.

## Artifact previews

`previews/` holds what the viewer shows instead of text: `ImageArtifact`
(natural dimensions; fit, which never upscales, or a zoom from 10% to 1600%
through −/+ steps, Ctrl/⌘ + wheel or trackpad pinch, Safari gesture events,
a two-finger touch pinch, and double-click between fit and 1:1, anchored at
the pointer; a zoomed image larger than the viewer pans by mouse drag;
`imageZoom.ts` holds the scale math; round arrows fixed to the viewer's
edges, and the arrow keys while the viewer has focus and the image is at fit,
show the previous and next image of the same folder, see below),
`MediaArtifact` (native audio/video
element, duration and dimensions once metadata loads, a stated failure when
the runtime cannot decode the codec), `FontArtifact` (a specimen under a
throwaway `FontFace` family removed when the tab closes), `TableArtifact`
(CSV/TSV through `delimitedText.ts`, capped rows stated in the meta line),
and `BinaryArtifact` (name, type, size, download; never a decode attempt).
Office documents (`.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`) use
`OfficeArtifact`, which mounts the matching `omni-viewer-core` viewer inside a
shadow root. It reads the bytes through the same scoped `/api/fs/raw` path as
the other binary previews, and loads the viewer and its parser dependencies
with dynamic imports so opening a text file does not pay for Office support.
Web and VS Code builds resolve the legacy Office readers' `buffer` imports to the pinned browser package.
The package stays inside the preview bundle; the application does not install a global `Buffer`.
The Office adapter supplies Omni's `--omni-*` variables from the resolved app
surface, control, text and status tokens. Those variables cross the shadow root,
so default, custom, system and VS Code theme changes update existing viewers
without reading or parsing again. DOCX's surrounding wrapper uses the same canvas;
document pages and PPT slide fills retain their authored colors. Omni is the sole
Office renderer. Its Word self-loader requires the installed `docx-preview` peer.

Office input has an independent 30 MiB bound. Display metadata can be stale after
a file changes, so the scoped raw reader checks Content-Length and every received chunk before
retention. The raw request carries an optional `maxBytes` for VS Code's native
adapter, which bounds disk reads before base64 allocation. Canvas reads and raw
callers omitting that option keep their existing behavior. This bounds compressed
input bytes, not total parser heap or decompressed documents. Attachment extraction
keeps its separate contract and 20 MiB limit.

Each runtime/root/path preview owns an abort controller and a fresh mount host per
revision or manual retry. Closing or replacing it aborts its read/mount, removes
its host and disposes any returned handle, including one that resolves after
cleanup. Late reads and errors cannot publish into the replacement preview. A
read failure keeps download/default-app actions and offers Retry. Network/relay
and webview abort are supported; a VS Code native disk read already in progress
remains bounded and can finish after the webview retires its request.
`FilesView.renderArtifactPreview` is the single switch both the docked and
the fullscreen viewer use. SVG, Mermaid (`.mmd`) and delimited files are text
with an artifact view: each has a per-path preview/source toggle, and opens
in preview regardless of the text-first setting because an agent-produced
artifact is opened to be looked at.

Stepping through a folder's images: `FilesView` reads the shown image's folder
with the tree's hidden and gitignored settings for every image shown, so
files added or removed meanwhile count, and keeps the last listing's arrows
on screen while it reads; an image the listing leaves out gets no arrows.
`imageNeighbors.ts` picks the images before and after it in the tree's order,
wrapping at the ends. SVG counts, since it opens in the image preview. A step
opens the neighbour the way a single click in the tree does (`openContextFile`
with `preview`): on desktop one preview tab follows the steps while the tab
the user started from stays; on the phone the Files surface shows the
neighbour in place and Back still leads to the folder being browsed. The
viewer unmounts while the next image loads, so a step remembers its target and
the viewer showing it within five seconds takes the focus back for the next
key. A folder that cannot be read shows no arrows.

Non-text artifacts the browser must own (PDF, audio, video, fonts) are loaded
through `getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', …)` with
the scoped URL token; the server streams byte ranges so playback can seek.
Images keep the object-URL/data-URL path.

`useRawAssetUrl` makes that URL once per file, revision and runtime and holds
it, so the shared token rotating never touches an open preview: a PDF stays
on its page, a player keeps playing, a font stays registered. The server
checks the token when a request starts, so a held URL keeps working for the
document it already loads. A player asks for more ranges later, and one asked
for after the token expired gets a 401; `MediaArtifact` then asks `renew` for
a URL with a fresh token and resumes at the same position, speed and play
state. One
renewal per ten seconds; a renewal that returns the same URL, or fails, shows
"cannot be played". A file changed on disk bumps the revision, which gives the
preview a new URL and loads the new bytes.

### Why the URL is held and not rebuilt with every new token

A rebuilt URL is a new document: the iframe navigates and the media element
reloads, which put PDFs back on page 1 and stopped playback each time the
token rotated, about every 45 seconds. A longer token or a per-file grant
like the HTML preview's would also keep late ranges authorized, but would
widen what a URL in the page can open. A PDF and a font load their bytes when
they open, so only media asks for ranges late, and the renewal covers it
without changing any server check. A PDF still downloading when its token
expires, a very large file over a slow link, is the case this leaves open.

An HTML file's preview is untrusted content. `useHtmlPreviewUrl` asks the
server for a grant (`POST /api/fs/preview`) and loads the page from
`/api/fs/preview/<grant>/<path>`; the frame's `sandbox` has no
`allow-same-origin`, so the page runs as an opaque origin with no session and
cannot reach the app's API, DOM or terminal. Its neighbouring images, styles
and scripts load through the grant in the path. A page outside the workspace
asks for its grant with `allowOutsideWorkspace`, and the server scopes it to
the page's folder. VS Code renders `srcDoc` in the same sandbox. The server
side (read root, CORS, CSP) is described in
`packages/web/server/lib/fs/DOCUMENTATION.md`.

The preview toolbar has the browser panel's "Annotate page" toggle
(`useHtmlPreviewAnnotation`, a thin use of `components/browser/useFrameAnnotation.ts`,
which pages in the chat share) on web and desktop; phones and VS Code do not
show it. The server puts a bridge into every previewed HTML page, and
`lib/browser/previewFrameHost.ts` turns the frame into an `AnnotationHost`, so
`runAnnotationSession` runs the same overlay and the result attaches to the
composer through `useAnnotationAttach`, with an intro naming the file preview.
Before starting, the host probes the bridge; a page that never answers (it
navigated away, or its own CSP blocks inline scripts or `eval`) ends in the
"could not annotate" toast. The prompt names the file path: the preview URL
carries the grant, which is a credential and stays out of prompts. On desktop
the screenshot is the on-screen part of the frame's area of the window
(`visibleFrameArea`, `desktop_capture_page_rect`),
taken after the overlay has torn itself down; a browser cannot photograph a
frame, so on web the annotation goes without one. A reload or another file
ends a running session.

### Why a bridge in the page and not a webview

The browser panel annotates through a `<webview>`, which the app can script
directly. Showing the preview in a webview on desktop would have reused that
as is, but left web without annotation and given the Files view two preview
engines. The bridge works the same in both, and gives the app no reach into
the page that the page's own scripts lack.

The Markdown preview uses `SimpleMarkdownRenderer allowRawHtml`, sharing
Streamdown processing with reference descriptions and comments. The policy in
`chat/markdown/streamdownPlugins.ts` enables raw parsing, a restricted rehype
sanitizer and Streamdown hardening. It permits document elements such as
`picture`/`source`, `img`, `a`, `details`, `sub`/`sup`, `kbd` and aligned blocks.
Author styles, application classes, handlers, forms and embeds are excluded.
Chat keeps raw HTML inert. Media components own safe image dimensions so an
HTML height or aspect ratio is not lost to Tailwind preflight.

A Markdown file's frontmatter shows above its body (`SimpleMarkdownRenderer
frontmatter="properties"`, also used by the plan view): a YAML mapping
becomes a key/value table, lists of scalars become chips, nested values show
as YAML; TOML (`+++`), invalid YAML and non-mapping YAML show as the block
was written. The skill editor hides it (`frontmatter="hide"`) because the
description has its own field there.

`useMarkdownLocalAssets` supplies the file path, workspace scope, file-open
callback and app color scheme before rendering. `MarkdownMediaContext`
resolves relative images and `srcset` candidates through the runtime against
the file's own directory, including files outside the workspace. React media
nodes receive the resulting object URLs; their owner revokes them when the
preview changes or unmounts. Relative links open through the supplied
`useUIStore.openContextFile` callback, shared by the context panel and mobile
files view. Fragment links find a heading within the Markdown root. A source's
`prefers-color-scheme` condition follows the app theme through its rendered
`media` prop. Content, file and runtime changes retire older asset results.

A document image is read once it comes within one height of the preview's
scroller of its visible part (`useNearMedia` with the nearest ancestor that
scrolls vertically as root; a table that scrolls sideways does not count). A `<picture>` is watched as a whole, since its sources have
no box, and a source whose `media` does not hold, the other theme's for one,
is read only once it does. The candidates of one `srcset` are all read when
their image is near.

### Why a document image waits until it is near the view

The preview read every image when it opened: a README with 100 screenshots of
2.8 MB read 280 MB and grew the browser by about 600 MB while two pictures
were on screen (#5320). The observer's root is the preview's scroller, because
a margin on the viewport is clipped by that scroller and an image would start
loading only once already visible. Read files stay until the preview closes:
releasing one far away would collapse its height and move the text being read.

### Why document assets resolve before node updates

Media and link components own their resources and cleanup. Rewriting the
rendered Markdown's `src`, `srcset` or `media` attributes would compete with
React and could publish an old document's assets after a preview switch.

An agent can ask for a file to be shown (`file.open` on the managed
`openchamber` tool). The server broadcasts `openchamber:file-open-request`;
`ContextPanel` answers it with `openContextFile`, `MobileApp` additionally
opens the files drawer. VS Code has no shared file viewer and no managed
tool, so the event never reaches it.

## Editor aids

The text editor's helpers live in `lib/codemirror/` and need no language
server; `FilesView` assembles them. What the syntax tree or git can answer
is shown, nothing that needs type information.

- **Git changes.** `gitChangeGutter` diffs the document against the file's git
  baseline after typing pauses. A click on a bar opens that change in place:
  the changed lines are tinted, the baseline lines show under them, and
  Revert puts them back as an ordinary edit, so undo, autosave and the
  external-change guard treat it like typing. Escape or the close button
  hides it; a later diff keeps it open while the change still exists.
  Read-only files show no Revert.
- **Indent guides** draw one faint line per indent step on the lines in view,
  at multiples of the width the file itself uses (the most common step
  between lines), so a 4-space file does not get guides every 2 columns.
- **Sticky scope** (desktop) pins the first line of each function or class
  whose body fills the top of the editor, up to three, innermost kept.
- **Import links.** Cmd+click (Ctrl+click elsewhere) on a relative import path
  in JS/TS opens the file it names, trying the extensions a bundler tries;
  holding the key underlines the path. Elsewhere that click still adds a
  cursor.
- **JSON errors** (`.json`, `.jsonc`, `.geojson`) underline the first place the
  file stops parsing.

### Why import links stop at relative paths

`./` and `../` paths name a file; aliases (`@/lib/x`) and packages need the
project's resolver settings, and a jump that guesses was ruled out. Go to
definition for symbols needs a language server, which was ruled out as too
heavy; OpenCode's own LSP served the agent only and is not a source for it.

### Why JSON errors accept comments and trailing commas

tsconfig, VS Code settings and `opencode.json` allow them under a `.json`
name. Flagging them would be wrong far more often than missing a trailing
comma in a strict file, so the check blanks both before parsing, keeping
offsets, and reports only the first error: the parser's recovery after it is
noise. JSON5 and JSON Lines are not checked. The JSON tree view parses every
file the same way, so a tsconfig opens as a tree.

## Canvas editors

A "canvas" is an editor with its own document model instead of the text
editor: an extension's file editor (`contributes.fileEditors`, see
`packages/sdk/DOCUMENTATION.md`). It exposes `FileCanvasHandle`
(`fileCanvas.ts`); `getContent(purpose)` returns a `FileCanvasRead`: a
snapshot, `null` for nothing yet, or a failure message. A failure fails the
save or keeps the canvas open on a source or fullscreen toggle; it never falls
back to the stale text draft.

An extension editor claims a file when an active extension's pattern matches
its name (`useGuestFileEditor`, `lib/guests/file-editors.ts`), ahead of every
built-in preview: a text editor only text files, a binary editor
(`content: "binary"`) any file, images and PDFs included. `GuestFileEditor.tsx` mounts `PluginPane
surface="file"` with a per-mount channel (`lib/guests/file-editor-channel.ts`)
holding the draft at mount; the frame gets the file on `hello` / load, answers
snapshot requests within `GUEST_REQUEST_TIMEOUT_MS`, and reports changes. VS
Code and mobile keep the extension catalog empty, so there nothing matches.

The contract is one-directional content. The frame reads the file it was
handed at mount, so `FilesView` remounts it with a `key` of path plus
`canvasRemountNonce` whenever it must adopt content it did not author (a load,
an external write, a toggle back from the source view, a discard). Its own
save adopts content without a remount so the viewport is not reset. Exactly
one instance is mounted, in the docked chain or in the fullscreen overlay;
entering or leaving fullscreen moves unsaved edits through the text draft, as
the source toggle does, and the other slot remounts from it.

`isDirty` (draft differs from file) is not proof of a user edit. The context
panel keeps one FilesView that follows the selected path, so during a file
switch the draft and the file briefly belong to different files. React to real
edits through CodeMirror transactions (`isUserEvent('input' | 'delete' | 'undo'
| 'redo' | 'move')`). Autosave refuses to write an empty draft over a non-empty
file (`shouldScheduleFileAutosave`); an explicit save still can.

Canvas edits never enter the text draft. A separate `canvasDirty` flag feeds
the shared `isDirty`, so autosave, Cmd/Ctrl+S, the unsaved-changes prompt,
`saveDraft`, and the external-change guard all see canvas edits as text edits.
Key events inside the frame never reach the host, so Cmd/Ctrl+S arrives as the
frame's `file-save` and runs the same `saveNow` as the keybind. `saveDraft`
writes the canvas snapshot when the canvas is dirty and the text draft
otherwise, in the line endings the file was loaded with. It takes one snapshot
and marks its version saved after the write; `markSaved` clears the dirty flag
at once and the frame's answer to `file-saved` sets it again when edits landed
during the write. A canvas that went away with its extension clears the flag
instead of keeping autosave writing. The frame's `edited` notices hold
autosave's timer back until the canvas has been quiet for the full delay.

Each save captures its runtime instance, selected document/root, operation and
canvas handle. File/root transitions, committed moves, runtime round trips and
unmount retire that operation. After an asynchronous snapshot, ownership and
move guards run again before dispatch. An issued write can finish against its
original file; its retired continuation cannot mark another canvas saved,
replace its baseline/stat, refresh its runtime, clear a newer save's busy state,
or continue navigation. Success receipts carry their ownership check through
autosave, toolbar/status timers, Save-and-continue and binary fullscreen.
Fresh-owner saves can proceed while a retired write remains pending.

Save callbacks retain the selection lifetime of the render that exposes them.
The loaded document separately retains its source root/path and runtime
instance. Entry checks require both owners, before a save creates an operation
or enters the file API. A new runtime render can still hold the old draft
before its file-scope reset or read completes; that draft has no save authority
on the new runtime. The autosave callback checks before rearming as well as
before saving, and selection retirement clears its scheduled timer.

The selection owner publishes a fresh render even for a batched round trip.
A same-runtime file/root round trip can retain the actual unchanged document
and edits for a fresh callback. Its earlier callback remains retired. A runtime
instance round trip invalidates the loaded document's runtime capture and
requires a fresh authoritative load. Each load carries its selection/runtime
owner, and only its exact load ID releases the pending-path hold. Effect replay
publishes a fresh owner and retires the previous load hold too.
The separate image loader publishes the same document stamp on its owned
completion. Its captured runtime, selection and load ID guard source, error
and loading state too, so desktop binary extension editors retain save support
and a retired image result cannot grant a new runtime authority.

A canvas acknowledgement uses the captured handle and the written version.
Edits reported after that snapshot keep the host dirty while the guest applies
its versioned acknowledgement. Source edits keep their current draft while the
saved baseline advances to the text actually written. A late post-save stat
belongs to the same operation and cannot replace a newer save's baseline.

A canvas never mounts over a draft it cannot take (`shouldShowFileCanvas`): a
draft over `GUEST_FILE_EDITOR_CONTENT_MAX` stays in the source view, and a
frame that cannot read the file reports `file-unsupported`, which returns the
viewer to the source view and records that mode for the path.

A binary editor has no text draft. `GuestFileEditor` reads the file's bytes at
mount (`/api/fs/raw` through `runtimeFetch`, `loadCanvasBytes`) and loads the
frame once they are here; too many bytes or a failed read fall back to the
built-in view with a toast. Its snapshot is bytes, written with
`files.uploadFile(..., { overwrite: true })`, the same atomic temp-and-rename
write uploads use, with the stat baseline cleared so the poll does not take
the write for an external change. The binary guards (`isBinaryFile`,
`contentDetectedBinary`) that refuse text saves step aside only while a binary
editor owns the file (`binaryCanvasRef`). There is no source toggle; moving to
or from fullscreen saves unsaved changes first, because bytes cannot travel
through the draft. An external change reloads the file and remounts the
editor with the new bytes, unless it has unsaved changes.

## Excalidraw drawings

`.excalidraw` and Obsidian `.excalidraw.md` files open in the Excalidraw
extension (`github.com/openchamber/openchamber-excalidraw`), offered on the
Integrations page (`components/sections/integrations/CatalogExtensionsSection.tsx`).
Without it, where the runtime loads extensions, the file shows its text under
a one-line notice whose Install button opens that card. `isExcalidrawFile`
matches both extensions, and `isMarkdownFile` excludes `.excalidraw.md` so an
Obsidian drawing never takes the markdown preview path; its source view is the
markdown document.

## Moving and renaming

Dropping a row of the sidebar tree on a folder moves the entry there
(`SidebarFilesTree`, drop rules in `components/layout/fileTreeMoveDrag.ts`).
It is the same native drag that attaches a file to the chat, so the drop
target decides what happens. A file row stands for the folder it is in and
the empty space below the tree for the root, as in VS Code. The entry's own
folder, the entry itself and a folder's own subfolders refuse the drop, and a
drop within the click slop of where the drag began stays a click (#2368).
Touch-only devices do not move: the tree scrolls under the finger. A dialog
asks first unless the user turned it off (`confirmFileTreeMove`, Settings >
General). The server refuses a name that already exists in the target and the
tree says so in a toast; nothing is replaced or renamed. VS Code has no file
tree, so nothing moves there.

A move and both rename dialogs (the sidebar tree and `FilesView`'s own tree)
go through `moveWorkspacePath`. It renames through the runtime and then
points the context panel file tabs and `useFilesViewTabsStore` (open, selected
and expanded paths) at the new path with `moveContextFilePaths`. A file tab's
id comes from its path, so the tab is rebuilt in place and stays active. The
two are kept under different folders in a draft waiting for a new space: the
tabs under the draft's folder, the tree's paths under the space it shows.

Move publication belongs to the captured runtime instance, including a return
to the same host after visiting another one. Retired responses release only
their pending move record and return `retired` before notifying editors or
rebasing tabs. The issued rename can still succeed on its original host.

Both tree dialogs and the sidebar drag caller capture their mounted directory
visit through `useFileTreeMutationOwner`. Closing or opening a dialog retires
its previous continuation. Runtime changes and unmount also retire it. Authoritative session/draft,
directory, worktree and space stores retire directory visits synchronously when
the resolved panel or content root changes, including a round trip within one
React batch. A local visit signal also clears the retired dialog and busy state.
Updates that keep both resolved roots preserve pending operations. Owned completion checks surround each refresh and guard notifications,
selection changes, editor clearing, dialog closure and busy-state release.
A later dialog can submit while the earlier issued write finishes against its
original owner. The content-cache owner retains its existing mutation queue.

### Why mutation completion owns the refresh chain

Directory request cleanup invalidates existing reads but cannot prevent an old
mutation response starting a new read against the current runtime. The caller
checks ownership before starting refresh and after it settles. The move helper
also checks its caller before committing editor and tab publication. Selected
file changes do not retire that owner, so a successful rename can adopt its own
new path and finish its dialog.

The open editor keeps unsaved edits through a move (`lib/filePathMoves.ts`).
While the rename request is in flight, `FilesView` refuses saves of paths
under the source, so autosave cannot recreate the file at its old path. When
the move commits, the editor notes it before the tabs move; once the selected
path becomes the new one, it adopts that path instead of re-reading the file,
which would replace the draft. Editors stay keyed by the path the file was
opened under, so the text editor, a canvas or a diagram is not remounted and
keeps its edits and undo history. The draft reset that normally follows a
change of the selected path is skipped for a moved file, and the open-file
poll does not report the old path as a deleted file while the move is in
flight or not yet adopted.

Canvas readiness also accepts the committed move's temporary old-loaded/new-
selected path pair, within its captured runtime and file scope. This keeps the
same frame and its pending snapshot connected until alias adoption. Ordinary
file selections keep the loaded-path readiness check.

### Why a committed move retains the canvas before alias adoption

The tab store rebases synchronously before the adoption effect can update the
loaded path. Requiring equality during that render unmounts the frame and loses
its unsaved model and undo history despite the stable document key. The
committed move record supplies authority for that single transition; its old
save remains retired and a fresh save uses the adopted path.

Alias adoption rebases the preserved document's source scope to the destination
while retaining its valid runtime capture. An unrelated runtime or selection
change cannot perform that transfer.

## Uploads

`useFileTreeUpload` owns uploads for every file browser: `FilesView`,
`SidebarFilesTree`, and the phone browser `MobileFilesSurface` (the mobile app
never shows `FilesView`'s tree; it only hosts `FilesView` as the editor). Files
arrive through desktop drag-and-drop or through the system picker, which folder
menus ("Upload Files"), the tree toolbar, and the mobile browser header open.
On mobile the header button uploads into the folder currently on screen. A single upload runs at a time, in batches of three. Existing
names are never replaced silently: they collect into a replace-confirmation
dialog, which is dropped when the workspace or runtime changes. The feature is
present only when the runtime exposes `files.uploadFile`.

## CSV and TSV previews

Table previews retain the parser's 2,000-row cap and display its truncation notice.
Only rows near the preview's own scroll viewport mount. Spacer rows preserve the
full scroll extent, and the final retained row remains reachable. Column widths
come from the retained header and rows, bounded from 4 to 64 monospace characters;
scrolling cannot resize them. Long cells keep their full text in the title.
The preview disables browser scroll anchoring while its virtualizer owns offsets.

`node --test scripts/csv-preview.browser.test.mjs` verifies the real component in
Chrome against a 2,000-row, 300-column fixture, including its final row and a
1,000-character cell. The check skips explicitly when Chrome is unavailable.

## Preview failure ownership

Built-in image, media, font, Office, binary and delimited-table components load
on demand through `LazyFilePreview`. Its boundary belongs to the runtime,
directory, file path and content revision. Retry recreates the rejected lazy
component for that file. `FileMarkdownPreview` sends Markdown and Mermaid
through the shared module importer directly, within this file-local recovery
owner. Its failure never invokes the chat wrapper's application reload policy.
Changing files retires the failed boundary. JSON,
Markdown and Mermaid boundaries use the same document identity. File read
failures retain their selected tab and offer a read retry.

Office continues to use Omni's Word, Excel and PowerPoint viewers for
DOC/DOCX, XLS/XLSX and PPT/PPTX. Its original-byte reader, 30 MiB bound,
AbortSignal ownership, viewer disposal and live theme variables remain owned by
`OfficeArtifact`, `officePreviewBytes` and `officeViewer`.

## Table columns and quotes

Table previews window columns as well as rows. The horizontal virtualizer uses
fixed widths derived from retained data and a measured monospace character.
Three columns on either side provide the horizontal buffer. Spacer columns
preserve the complete scroll extent; headers and cells share that window. Data
coordinates stay left-to-right in every UI language.

Click and drag, or click then Shift-click, selects a CSV/TSV rectangle. Touch
scroll remains native, and a touch tap selects one cell. Quote attaches the
selected values to the existing inspectable and removable file-quote draft.
The label contains the filename, format and original source range. CSV and TSV
have one table and no workbook sheet identity. Values are a JSON matrix so
spaces, empty strings, embedded newlines and literal formula text survive.
No path, surrounding cells or complete table accompanies the quote.

`delimitedText` retains logical record numbers before filtering blank records.
An unterminated or malformed quoted record, a rectangle crossing a filtered
blank record, or an invalid coordinate prevents quoting. Selections over 1,000
cells or 64 KiB of serialized values show the limit and cannot be attached.
Limits reject the complete selection; values are never shortened. Content,
file and runtime changes retire selection. The host attaches only within its
current runtime, project and session/draft using the existing comment store.
Excel selection and file writes are outside this contract.

## Markdown reading

The headings menu observes committed headings in the current preview. It jumps
to the element itself, so repeated and non-Latin titles need no synthesized ID.
An empty document has an explicit empty menu; changing the document remounts
the owner. File previews opt into passive SVG fences. The shared Markdown
renderer leaves chat fences, standalone SVG files and Mermaid unchanged.

The main ChatInput publishes its committed inline-comment draft target through
`composer/comment/mainComposerDraftTarget`. Table quotes attach through that
owner, including expanded BTW child and pending BTW keys. Inactive, pinned,
exiting or form-owned composers do not publish a main target. Runtime instance
retirement and unmount revoke the owner. A missing or mismatched target rejects
the quote and retains its selection. Filename, format and range share one
basename-safe label separated with middle dots, so composer inspection retains
all three fields.

## Read-only data previews

`DataFileArtifact` owns ZIP directory and Notebook static text previews. It uses
FilesView's authenticated, bounded raw-file read and the existing per-file lazy
error boundary. File path, runtime scope and content revision key the preview;
switching or closing aborts the read and late completions cannot publish.
Notebook files join the non-editable preview path, including save and autosave
guards. Office keeps Omni and its separate 30 MiB limit.

ZIP input is limited to 10 MiB and 2,000 central-directory entries. Directory
metadata is validated before JSZip receives the input. No archive member is
inflated or written. Unsupported archive variants retain the original download.
Notebook v4 input is limited to 5 MiB, 500 cells, 1,000 outputs and 1,000,000 text
characters. Source, stream outputs, text/plain results and stored errors render
as plain text. Rich outputs are omitted with a visible count. No cell executes,
and notebook markup cannot fetch remote resources.

SQLite and Parquet use `DataTableArtifact` and the approved SQL.js 1.15.2,
hyparquet 1.32.0 and hyparquet-compressors 1.1.3 packages. Input is limited to
20 MiB per file. Each page runs in a disposable worker; abort, file switching,
unmount, malformed responses and the 8 second deadline terminate its CPU owner.
There is no main-thread decoder fallback. The worker accepts bytes, a table name
and a bounded page number, with no arbitrary SQL or external URL. Response parsing
limits authority to the expected table, columns and bounded text rows.

SQL.js uses a lazily loaded bundled WASM asset, limited to 4 MiB. Only that
trusted app asset is fetched. The worker receives its bytes and makes no decoder
network requests. A copied input buffer protects both normal Uint8Array and
Buffer callers from transfer detachment. The original file has no write route.
The preview retains one authorized snapshot while tables and pages change.

SQLite enables query-only and disables trusted schema, then enumerates ordinary
main-database tables. Views, virtual/shadow table namespaces, hidden columns and
generated columns are excluded before a SELECT is built from quoted names.
Unavailable virtual modules can report shadow tables as ordinary, so all names
under a virtual table's prefix are conservatively excluded. WAL-dependent inputs
remain unsupported because the preview cannot certify an absent sidecar. The
picker lists at most 200 tables. Pages contain at most 100 rows and 64 physical
columns, with no full COUNT scan. Integer values preserve bigint precision.

Parquet accepts local bytes and rejects external column files. Metadata is
limited to 1 MiB, 1,000 schema nodes, depth 8 and 1,000 row groups. Every page
header is checked before decoding: 16 MiB per column/page, 64 MiB total declared
and actual uncompressed page bytes, 1,000,000 values per column/page and 4,000,000
values across page headers. The ZSTD decoder receives a fixed bounded output
buffer. Nested values remain inside the worker and become bounded cell text.
These are decode budgets, not a claim about total parser heap.

Both table formats cap each cell at 1,000 characters plus a visible shortening
marker, nested display at depth 4 and 100 visited nodes, and a page at 200,000
text characters. The UI states when cells are shortened. Failed, timed-out and
unsupported files retain the original download. CSV/TSV retain their existing
grid and source editor paths; this preview module adds no cell-writing behavior.

Web, Electron desktop, hosted mobile and Capacitor use their connected runtime's
existing authorized raw-file route. Isolated-space file requests remain scoped
to that space. VS Code does not mount this Files view and receives no new host
filesystem capability.

### Why notebook output stays plain text

HTML and rich output can execute scripts or fetch remote content. Plain text
preserves code, prose and recorded text results while making the passive-read
contract checkable. Omitted rich output remains visible as a count.

### Why each data page gets a disposable worker

SQLite schema expressions and nested or compressed Parquet can consume CPU before
a row cap is reached. Worker termination gives file switches and the deadline an
enforceable CPU boundary. It also releases decoder memory between pages without
keeping old file owners alive. The table picker and pager reuse the authorized
file bytes while each worker receives its own copy.

## Selected XLSX cells and copies

Omni remains the default Office renderer for all six formats and keeps its
30 MiB raw-input limit. A workspace XLSX on a server-backed runtime offers a
separate selected-cell panel. Opening the panel preserves the Omni mount;
closing it preserves applied draft edits. The panel reads the server's supported
snapshot, selects one exact visible sheet/cell at a time, and stages only explicit
cell changes. Saving creates a new sibling XLSX. Existing destinations and
changed sources fail visibly with the draft retained. The original has no save
path in this panel.

Selected-cell quoting sends only the selected source value and its quoted
sheet/address into the current main composer draft. It does not attach the
workbook or hidden sheets. Copy edits do not silently change a source quote.
Source/path/revision/runtime replacement retires reads and saves, so their late
completions cannot publish feedback in another file. A dispatched server save
may still finish after its view closes; an uncertain failure asks the user to
check the destination before retrying.

The server's supported-format and publication contract is in
`packages/web/server/lib/fs/DOCUMENTATION.md`. The panel does not implement
formula evaluation: dependent formulas recalculate in Excel or WPS. Chart-bearing
workbooks are refused before editing and remain available in the Omni viewer. VS Code does not expose this capability. English and Simplified Chinese
labels resolve at render time without resetting the staged draft.

The data Worker adapter keeps the literal `new Worker(new URL(..., import.meta.url),
{ type: 'module' })` form. Vite's asset transform depends on that constructor
syntax; an alias can inline raw TypeScript instead of emitting a compiled Worker.
Capability checks run before construction without replacing the recognized form.
Source-level Worker tests do not replace final built-asset browser acceptance.
