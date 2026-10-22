# Knowledge library: local folders indexed by a bundled the embedded knowledge backend

Status: proposed. Date: 2026-10-22. Revised 2026-10-22: files are indexed
in place by a patched backend instead of being copied on upload.

## Glossary

- **Library** — a local directory the user has added to SuperWagie. One library
  is one folder subtree; its files are indexed into the knowledge backend. The UI calls it
  资料库.
- **Document** — one file inside a library. A document has one stable identity
  in SuperWagie and at most one live *knowledge record* in the knowledge backend.
- **Knowledge record** — the backend's per-file indexing unit (`knowledge`). It
  survives a content change (a reparse updates it in place), but it is not the
  document's identity: the ledger keys on the library-relative path.
- **Knowledge base (KB)** — the single backend container that holds every
  document from every library. Exactly one, named `SuperWagie 资料库`.
- **Passage** — a retrieved chunk of a document, with its offsets.
- **Knowledge backend** — the local indexing service SuperWagie ships
  (`embedded-knowledge-server`, loopback HTTP). It is an implementation detail
  and never appears in the product UI.
- **Reference ingest** — the backend indexes a file at the path where it lives
  instead of a copy. It reads the file for parsing and for preview; removing
  the index entry never touches the file.
- **SuperWagie build** — SuperWagie's fork of the upstream project: a pinned
  upstream tag plus the reference-ingest patch.

Not to be confused with the existing project knowledge panel
(`packages/web/server/lib/project-context`), which holds notes, todos and
plans. That is a different domain; this spec adds no behaviour there.

## Problem Statement

A user keeps their working material in ordinary folders: contracts, decks,
meeting notes, reference PDFs. SuperWagie's agent can read files only when the
user names a path or attaches a file, so the material that matters most is
invisible to it.

The user has the embedded knowledge backend installed and a local corpus already in it, but using
it means leaving SuperWagie, uploading files through another app's UI, and
copy-pasting answers back. They want the opposite: point SuperWagie at a
folder, have it kept in sync automatically, and have both the agent and the UI
search that folder by file name and by meaning without ever learning that a
separate product is involved.

## Solution

A **资料库** surface in the right context rail, opened the same way as the file
or git panel, plus a Settings page for first-run connection.

The user adds a local directory and confirms the file counts SuperWagie
previews. Indexing is in place, in the knowledge backend instance the product
ships and manages: it scans the folder, points the backend at each file where
it already lives (nothing is copied), re-parses a document when its content
changes, and shows per-document status. One search box returns file
matches and relevant passages together. Clicking a result opens the original
file at the match when the format allows.

The agent gets one tool, `openchamber_library`, that performs the same merged
search and can read a document's indexed text. It never writes.

Nothing about the knowledge backend is user-visible: not the app, not its web UI, not its
account, not its ports, models or settings. The only backend artefact the user
ever sees is one optional key field in first-run setup, named 嵌入模型密钥.

## User Stories

1. As a user, I want to add a folder as a 资料库 from the right-hand panel, so
   that I do not have to leave the conversation to index my material.
2. As a user, I want the add-folder action to open the native directory picker
   on desktop, so that I never type a path.
3. As a user, I want to see how many files a folder contains and that indexing
   will call a paid remote embedding model before I confirm, so that I am not
   surprised by cost or time.
4. As a user, I want indexing to start immediately after I confirm, so that I
   can keep working while it runs.
5. As a user, I want to see per-document status (queued, indexing, ready,
   failed, missing) and an overall progress count, so that I know whether my
   material is usable yet.
6. As a user, I want files I create or edit in a library to be indexed shortly
   after I save them, so that search stays current without a manual step.
7. As a user, I want deleting a file from disk to mark it missing rather than
   silently remove it from the index, so that a mistaken move never loses
   indexed material.
8. As a user, I want an explicit "清理已删除条目" action, so that missing
   documents can be removed from the index when I am sure.
9. As a user, I want to pause a library without removing it, so that a busy
   folder (build output, sync client) stops consuming indexing work.
10. As a user, I want to remove a library and choose whether its indexed
    documents are deleted, so that removing a folder does not corrupt the index.
11. As a user, I want one search field in the panel, so that I do not have to
    decide between "search by name" and "search by meaning".
12. As a user, I want name matches listed first and semantic passages grouped
    separately, so that I can tell why a result matched.
13. As a user, I want a search scoped to the library I am browsing, and a
    global search from the panel header, so that I can narrow or widen quickly.
14. As a user, I want a result to open the original file, so that I can read
    the surrounding context in its real format.
15. As a user, I want text-format results to open at the matched passage, so
    that I land where the answer is.
16. As a user, I want the tree to show libraries, folders and documents with
    counts, so that I can browse what is indexed without searching.
17. As a user, I want a failed document to show a readable reason and a retry
    action, so that I can fix it (wrong format, too large, parse error) myself.
18. As a user, I want files above the backend's size limit to be skipped and
    labelled, so that one large file does not stall a library.
19. As a user, I want the agent to search my indexed material when it needs
    facts from it, so that answers cite my own documents instead of guessing.
20. As a user, I want the agent's tool result to carry the source path, so that
    its answer contains clickable file references.
21. As a user, I want the agent to be able to read a document's indexed text
    when a passage is not enough, so that it can summarise or compare whole
    files.
22. As a user, I want the agent to be unable to modify my library, so that
    generated content never mixes into source material.
23. As a user, I want a single switch to turn the whole feature off, so that
    nothing runs or indexes when I do not need it.
24. As a user, I want SuperWagie to start and supervise the local indexing
    backend on its own, so that I never launch another app.
25. As a user, I want a clear error and a retry button when the backend cannot
    start, so that I know the difference between "broken" and "still starting".
26. As a user, I want the chat to keep working while the backend is down, so
    that a knowledge problem never blocks a conversation.
27. As a user, I want to paste one embedding-model key the first time, so that
    indexing works without me configuring a model catalogue.
28. As a user, I want that key to be the only credential I ever supply, so that
    the rest of the backend is provisioned for me.
29. As a user, I want the panel to hide itself entirely when the backend is not
    installed on this platform, so that I never see a broken surface.
30. As a user on a phone or another machine, I want the feature to be absent
    rather than non-functional, so that the UI stays honest.
31. As a user, I want an ignored-files rule set (dependencies, build output,
    hidden folders, temp files) applied by default, so that a project folder
    does not index its own `node_modules`.
32. As a user, I want a "重建索引" action for one library, so that I can recover
    from a backend reset without re-adding the folder.
33. As a user, I want indexing to read my files where they already are instead
    of copying them into another app's storage, so that adding a large library
    does not double its disk use.
34. As a user, I want cleaning up the index to never delete my files, so that no
    maintenance action in SuperWagie can destroy source material.

## Implementation Decisions

### Runtime scope

Desktop only. The server module exists in every runtime but reports
`unsupported` outside the desktop (and where the bundled backend is absent),
and the settings page, context surface and agent tool are hidden or disabled
accordingly. No hosted-relay or Capacitor path is built.

### Bundling and first run

SuperWagie ships the headless `embedded-knowledge-server` binary (one self-contained
executable, roughly 250 MB) as an Electron extra resource. CI builds it from the
public fork `https://github.com/NeoMei/embedded-knowledge`, branch
`embedded-knowledge` (currently commit `f5adb9e`: upstream `v0.8.3` plus the
reference-ingest patch, 11 files):

```
EDITION=lite CGO_ENABLED=1 go build -tags sqlite_fts5,anydoc -o embedded-knowledge-server ./cmd/server
```

`anydoc` is not optional for the product: the binary's other engines are
`simple` (text and media only) and `docreader` (an external service the desktop
app never runs), so without it no PDF or Office file can be parsed. The tag
links a Rust static archive built first with `scripts/build-anydoc-lib.sh`.

The staged resource carries the binary plus `config/` (already bound to
`127.0.0.1:17808`), `migrations/sqlite/`, `LICENSE`,
`THIRD_PARTY_NOTICES.md` (the upstream project is MIT; bundled third-party parts are
Apache-2.0) and `REFERENCE_INGEST.md`; the build script records the commit and
binary hash in a manifest. The binary resolves `config/` and `migrations/` from
its working directory, so the server spawns it with that directory as its cwd
and passes `SERVER_HOST`/`SERVER_PORT` explicitly. A developer checkout is a
local convenience only; CI and packaging never reference a local path.

### Reference ingest (backend patch)

The fork carries one patch on top of the pinned tag. It adds no schema
migration; a reference record is identifiable by its file path.

- `POST /api/v1/knowledge-bases/:kb/knowledge/ref` takes `{ path, title,
  folder_path, metadata }`, requires an absolute path to an existing regular
  file (a symlink is resolved and rejected when it points outside), and the
  same API-key capabilities the upload route requires. It records size and
  hash, stores `ref://<absolute path>` as the file path, and enqueues the same
  parse task an upload enqueues. It is idempotent per `(knowledge base, path)`.
- The storage layer treats a `ref://` path as read-only: reads open the file
  where it lives; delete removes the record and its chunks but never the file.
- `POST /api/v1/knowledge/:id/reparse` already re-reads a record's file, so a
  content change needs no new endpoint and keeps the knowledge id.
- Copying or moving a reference record within the knowledge backend falls back to
  materialising a real copy; this feature never clones libraries.
- The patch stays a small, isolated diff in the knowledge-create, storage and
  router layers, so it is rebased onto a new upstream tag as a release task.

A fresh install provisions its own backend, never the user's existing
local knowledge installation:

1. Data lives under SuperWagie's own data directory (`<data-dir>/embedded-knowledge/`),
   with `SERVER_HOST=127.0.0.1`, default port `17808`, SQLite storage, local
   file storage, generated `SYSTEM_AES_KEY` and `JWT_SECRET` written `0600`.
2. On first start, SuperWagie creates a local account with generated
   credentials (never shown, never user-editable), creates the embedding and
   rerank model records from the one DashScope key the user pastes, creates the
   single KB `SuperWagie 资料库`, then creates a backend API key carrying only
   `retrieve` and `ingest`, allow-listed to that KB. IDs and the API key are
   stored in instance settings; the API key is a write-only secret.
   Registration creates its own tenant but returns no token, so provisioning
   logs in afterwards and stores the tenant id. The usable credential is the
   API-key response's `token` field, not its `api_key` display id.
3. Defaults come from the machine's existing WeKnora Lite installation when
   there is one: its model records (embedding, rerank, vision `qwen3.8-flash`,
   ASR `qwen3-asr-flash`) and its parser configuration are read once, read-only,
   from `~/.weknora-lite/data/weknora.db`. Model credentials there are AES-GCM
   encrypted with that installation's `SYSTEM_AES_KEY`; they are decrypted for
   the import and stored encrypted again by our backend. Without such an
   installation the fallback stays `text-embedding-v4` (1024 dims) and
   `qwen3-rerank` built from the one key the user pastes.
   Parser rules mirror the local setup: PDF and images go to
   PaddleOCR-VL Cloud when its token was imported (so scanned pages are read
   instead of rejected), Office formats go to the in-process anydoc engine,
   and the knowledge base gets the imported vision/image-processing and
   chunking configuration.
   The generated backend environment lists every imported model host plus the
   PaddleOCR hosts in `SSRF_WHITELIST_EXTRA`; without it the knowledge backend
   rejects model creation because the host resolves into a restricted range on
   machines using fake-IP DNS. Model creation does not validate the remote key,
   so a wrong key first shows up as a parse error on the first document, whose
   message names the rejected key.
   Evidence: a repair run on the maintainer's machine resolved 105 stale
   failures and left only OCR-less scanned PDFs failing before PaddleOCR was
   configured; `parser-engines` then reported `paddleocr_vl_cloud` available.

Provisioning is a one-time state machine
`not-installed → stopped → starting → needs-model-key → provisioning → ready | error`,
surfaced in Settings with a `重试` action. It is idempotent: each step checks
whether the artefact already exists.

### Process supervision

The backend is a child process owned by the web server, started when the
feature is enabled and the binary exists, and stopped on server shutdown
(SIGTERM, 5 s grace, then kill). Readiness is the public `GET /health`
(`{"status":"ok"}`), polled every 2 s during startup and every 15 s while
running. The supervisor spawns it with `SERVER_HOST=127.0.0.1` and
`SERVER_PORT=17808` set explicitly rather than relying on the backend finding
its config file: the fork's `config/config.yaml` also names 17808, but a packaged
working directory may not contain it, and a missing config must fail loudly
instead of silently choosing another port.

On an unhealthy probe or exit: restart with backoff 0 s, 5 s, 20 s, 60 s,
300 s; after the last attempt the state becomes `unavailable` and stays there
until the user retries or the server restarts. There is no database repair, no
lock-file deletion, no process killing beyond the child we own. If the
configured port is occupied, a healthy backend on it is adopted (covers a
previous instance left behind by a crash); anything else is reported as a port
conflict with the log path.

### Storage

- `<data-dir>/knowledge-library/libraries.json` — library records: id, absolute
  root, display name, slug used in the backend's folder path, enabled flag,
  ignore rules, created time, last scan time, last error.
- `<data-dir>/knowledge-library/documents.json` — the ledger: one record per
  document, keyed by `(libraryId, relPath)`.
- Writes are atomic (temp file + rename) and serialized, following
  `project-context`.

Document record shape:

```ts
{
  id: string;              // stable SuperWagie identity
  libraryId: string;
  relPath: string;         // posix, relative to the library root
  absPath: string;         // sent only as the backend's ref path
  size: number;
  mtimeMs: number;
  sha256: string;          // of the content at the last successful index
  knowledgeId: string | null; // kept across a reparse
  state: 'pending' | 'queued' | 'parsing' | 'ready'
       | 'failed' | 'skipped' | 'missing';
  parseStatus?: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  lastError?: { code: string; message?: string };
  chunkCount?: number;
  updatedAt: number;
}
```

Document identity is `relPath`, not the backend knowledge id: a content change
reparses the record in place while the document keeps its identity, so
citations and the ledger survive re-indexing.

### Library preparation and watch

Scan rules are conservative and match the existing sync helper:

- Whitelist: PDF, Office/ODF, RTF, EPUB, Markdown, plain text, CSV.
- Skip hidden entries, symlinks (never followed), `.git`, `node_modules`,
  dependency and build directories, temp files (`~$`), and files over the
  backend's 50 MB limit (recorded as `skipped`, with reason).
- The library root must be absolute, exist, be a directory, and be readable;
  otherwise adding it fails with a specific message.

Change detection is event-driven with a correctness sweep:

- `fs.watch(root, { recursive: true })` where supported (macOS, Windows).
  Events only set dirty paths; a coalesced pass runs 2 s after the last event
  and at most once every 30 s.
- A full reconcile walks the tree every 10 minutes and on panel open, so a
  dropped event or an unsupported platform degrades to polling rather than to
  silent staleness.
- A changed file is registered only after its size and mtime are unchanged
  across two reads 1.5 s apart, and its hash is recomputed immediately before
  the call, so a touch that leaves the content identical triggers no reparse.

### Ingest

A document is registered by absolute path; no bytes cross the loopback socket
and no copy is written.

- New document: `POST /api/v1/knowledge-bases/:kb/knowledge/ref` with `{ path,
  title, folder_path, metadata }`. `title` is the file's base name and
  `folder_path` is the library slug plus the file's directories; that pair is
  what makes one KB hold many libraries as a folder tree.
- `metadata` carries only `sw_document_id`, `sw_library_id`, `sw_rel_path`,
  `sw_sha256`. The absolute path reaches the backend as the record's file path,
  because that is what it reads; it is never returned in search results or
  rendered in the UI.
- State is persisted as `queued`, then `parsing` with `knowledgeId` once the
  ref call returns, then polled via `GET /knowledge/:id` every 2 s (first 2
  minutes), then every 10 s up to 15 minutes. `parse_status=completed` with no
  pending subtasks means `ready`; `failed` shows the backend's message.
- A retry is a fresh index, not a reparse: the knowledge record is deleted and
  the file registered again, because a parse can fail on the backend's parser
  configuration and reparse keeps the task's original engine choice.
- A content change (same path, different hash) calls `POST
  /knowledge/:id/reparse` on the existing record. The knowledge id survives, so
  citations stay valid and nothing is deleted first. If the reparse fails the
  document is `failed` with a retry; the file is untouched. A record the backend
  no longer has (deleted elsewhere, or a rebuilt knowledge base) is registered
  again rather than staying failed.
- Two registrations run at a time per library, serialized across libraries to a
  small global pool (2), staying under the backend's own concurrency of 3.

### Search

One server endpoint and one panel input. The local ledger answers the
file-name side; the backend answers the passage side; the results merge in the
route layer:

- File-name side: the local ledger. It already holds every document's relative
  path, title and state, so a substring match is instant, scoped correctly and
  still works while the backend is down. The backend's `?keyword=` filter
  matches titles only, and only for documents it has fully indexed.
- Passage side: `POST /knowledge-bases/:kb/hybrid-search` with
  `{query_text, match_count, rerank: {enabled: true}}`. When a library is in
  scope, the request carries `knowledge_ids` resolved from the ledger for that
  library; the global case omits them.

Merged response:

```ts
{
  query: string;
  documents: Array<{ documentId, title, path, relPath, libraryId,
                     fileType, size, parseStatus, matched: 'name' }>;
  passages: Array<{ documentId, title, path, relPath, libraryId,
                    content, score, chunkIndex, startAt, endAt }>;
}
```

Rules: a document already returned as a name match is not repeated in the
passage list unless it contributed a passage; passages are capped at 8 and
trimmed to 1,200 characters each; documents capped at 20. No result is
returned for documents whose state is not `ready`.

Scoping by library is O(ids) in the request body. That is acceptable up to a
few thousand documents per library; beyond that, a per-library KB or a tag per
library is the documented upgrade path.

### Content retrieval

A document's indexed text is read as its chunk list
(`GET /api/v1/chunks/:knowledgeId`, concatenated by `seq`), because it is the
only representation guaranteed to exist for every parsed format. The original
file is served through SuperWagie's existing file preview when the path is
still readable, else through `GET /api/v1/knowledge/:id/preview` (streamed with
the backend's content type). Links use the existing markdown file-reference
rendering, so references are clickable without a new citation protocol.

### Agent tool

One tool, `openchamber_library`, injected through the existing managed
agent-tool plugin and dispatched by the control service, with two actions:

- `library.search` — `{ query, library?, limit? }` → the merged shape above,
  rendered compactly for the model. Results always include `path`, so the agent
  cites files the chat can open.
- `library.read` — `{ documentId | path, maxChars? }` → indexed text, truncated
  with an explicit marker.

No write action. The tool is registered only while the feature is enabled and
the backend is `ready`; a call while the backend is down returns a plain error
the agent reports as "资料库暂不可用". A setting
`agentLibraryToolEnabled` (default true) switches it off.

### UI

- Context surface `library` (right rail, `regular` width, own icon and label),
  rendered like the file panel. Contents: header with global search and add
  button; tree of libraries → folders → documents with status dots and counts;
  search results in two groups (文件 / 相关段落); document rows open the file
  preview, text matches land on the passage.
- Library row actions: pause/resume, rescan, remove (with a delete-remote
  confirmation), clean missing entries.
- Empty state: one sentence and an add-folder button.
- Settings page `library`: enable switch, backend status with retry and log
  path, embedding-key field only while unprovisioned, rebuild index. Ignore
  rules are fixed rather than editable, and removing indexed data belongs to a
  library's own remove action instead of a global delete.
- Agent tool toggle lives with the other OpenChamber tools in Settings →
  General (`agentLibraryToolEnabled`).
- Adding a folder asks first with the preview the server computes: how many
  files can be indexed, how many are skipped, and that indexing calls a remote
  model.
- The surface is unavailable when the platform is not desktop, the binary is
  absent, or the feature is disabled.

### Settings keys (instance scope)

`knowledgeLibraryEnabled`, `embeddedKnowledgeBinaryPath` (nullable, internal override),
`embeddedKnowledgePort`, `embeddedKnowledgeApiKey` (secret), `embeddedKnowledgeBaseId`,
`embedded-knowledgeLocalUserId`/`embedded-knowledgeLocalUserPassword` (secret), `hasWeknoraApiKey`
(computed), `agentLibraryToolEnabled`. Keys are added to the generated registry
snapshots; nothing else is user-editable.

### API surface

All routes require the existing `/api` auth and are registered with the other
feature routes. Events go through the existing SSE channel as
`openchamber:knowledge-library-changed`.

- `GET /api/knowledge-library/status`
- `GET /api/knowledge-library/libraries`
- `POST /api/knowledge-library/libraries` `{ path }`
- `PATCH /api/knowledge-library/libraries/:id` `{ enabled?, ignoreRules? }`
- `DELETE /api/knowledge-library/libraries/:id?deleteRemote=true|false`
- `POST /api/knowledge-library/libraries/:id/rescan`
- `GET /api/knowledge-library/documents?libraryId&folder&state&limit&offset`
- `POST /api/knowledge-library/documents/:id/retry`
- `POST /api/knowledge-library/clean-missing`
- `POST /api/knowledge-library/search` `{ query, libraryId?, limit? }`
- `GET /api/knowledge-library/documents/:id/content`
- `GET /api/knowledge-library/documents/:id/file`
- `POST /api/knowledge-library/provision` `{ modelApiKey }`
- `POST /api/knowledge-library/reconnect`
- `POST /api/knowledge-library/rebuild`

### Security and failure behaviour

- The backend API key, account password and model key never leave the server;
  responses expose presence only.
- The backend binds loopback only; its own web UI is never linked or proxied as
  a browsable surface.
- The ref endpoint is the only place an absolute path enters the backend. It
  accepts an existing regular file, rejects symlinks, and requires the ingest
  capability. A configurable root allow-list is deliberately absent: loopback
  binding, the API key, and the library-root validation in the scan are the
  guard.
- Library roots are validated and re-validated before every scan; a vanished or
  unreadable root fails that library closed (no mass deletion inferred).
- Backend down: panel shows a banner with retry/log path, agent tool returns a
  clear error, chat and every other feature keep working.
- Backend missing: feature reports `not-installed`, surfaces hide.
- Parse failure, oversized file, permission error: per-document `failed` or
  `skipped` with a stable code plus a retry action; one bad file never blocks
  the library. Scanned PDFs that need OCR still fail until an OCR engine is
  configured: anydoc converts text, it does not read pixels.

## Testing Decisions

Good tests assert externally visible behaviour: the HTTP contract, the ledger
transition after a filesystem change, and the merged search output. They do
not assert private helpers, timers, or the knowledge backend request internals beyond the
documented contract.

The backend patch is tested inside the fork: unit tests for ref path validation
and read-only storage semantics, plus one HTTP test that registers a temporary
file, asserts a record with a `ref://` file path exists and a parse task was
enqueued, then deletes the record and asserts the file still exists.

Seams, highest first (three):

1. **Web server route seam** (`knowledge-library/routes`) with an injected fake
   runtime — covers request validation, status codes, secret redaction, and
   event emission. Prior art: `project-context/routes.http.test.js`.
2. **Runtime seam** (`knowledge-library/runtime`) with an injected fake
   the knowledge backend client and a temporary directory, timers driven manually — covers
   discovery, stability gating, change-reparses-knowledge, delete-marks-missing,
   parse-failure handling, no-byte-transfer on ingest, and merged search
   ordering/scoping. Prior art: `message-search` runtime tests with temp dirs.
3. **Client seam** (`embedded-knowledge/client`) against a small `node:http` fake server —
   covers auth headers, timeout/abort, error mapping, and the shapes of the
   endpoints used.

UI is verified manually in the desktop app (add folder, index, search, open a
passage, kill the backend process, confirm recovery), because the panel is a
thin renderer over the route seam and the repo has no UI test harness.

## Out of Scope

- Tracking upstream beyond the pinned tag. The fork carries one patch;
  rebasing it onto a new tag is a release chore, not part of this feature.
- A configurable root allow-list for the ref endpoint (see Security).
- Running the standard (MySQL/PostgreSQL) edition; the patch targets Lite.
- Migrating the user's pre-existing local knowledge installation, its 605-document KB, or
  the existing external sync helper.
- Multiple knowledge bases, per-project isolation, shared spaces, teams.
- the backend's chat, wiki, FAQ, agents, web search, OCR/VLM pipeline, or its UI.
- Web, hosted, VS Code and Capacitor mobile surfaces.
- Graph RAG, image/video/audio ingestion, and re-ranking model choice.
- Cross-device sync of libraries or credentials.

## Further Notes

- Confirmed against upstream v0.8.3 source and a fresh instance on a temporary
  data directory: registration creates a tenant and returns no token; model
  creation accepts the preset payloads without validating the remote key and
  needs the host in `SSRF_WHITELIST_EXTRA`; the API-key response's `token` is
  the credential (`X-API-Key`, `X-Tenant-ID` optional); upload derives
  `folder_path` from a slashed `fileName`; `?folder_path=` filters a KB;
  `?keyword=` matches titles only; hybrid search returns chunk content with
  `knowledge_id`, `knowledge_filename`, `start_at`/`end_at`; readiness is
  `GET /health` on the root.
- Still to confirm during implementation, not product decisions: the CI flags
  for the bundled binary, and whether the knowledge backend ever reconciles a knowledge
  record whose parse failed while the embedding provider rejected the key.
- Disk cost is now the index only: chunks and vectors, not a second copy of the
  corpus. The panel shows the indexed document count rather than a byte total.
- The fork is the price of "no second copy". Upstream upgrades mean rebasing a
  small diff across the knowledge-create, storage and router layers. If that
  ever costs more than the saving, switching back to multipart upload is
  confined to the ingest adapter and the embedded knowledge client: libraries, ledger,
  search, UI and the agent tool do not know how a document reaches the backend.
- The patch targets Lite (SQLite), where the file path column has no practical
  length limit. The standard edition's MySQL column would need widening, which
  this feature does not ship.
- Embedding calls are remote and metered. The add-library confirmation shows
  the file count and says indexing uses a remote model; it does not estimate
  money, because token counts are unknown before parsing.
