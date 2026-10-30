# Knowledge library

## Ownership

The user-facing feature over the embedded knowledge backend:

- `store.js` — the two JSON files (libraries, document ledger), atomic and
  serialized.
- `scan.js` — what may be indexed, and the directory walk.
- `ingest.js` — reference registration, reparse on change, parse polling.
- `watcher.js` — event hints, debounced reconcile, periodic sweep.
- `search.js` — merged file-name and semantic results.
- `runtime.js` — settings-driven composition: supervisor, provisioning,
  libraries, reconcile/ingest loop, search, content and project-scoped managed
  Markdown references.
- `routes.js` — the HTTP surface for the panel, the settings page and the
  agent tool.

`../embedded-knowledge/` owns the backend process and every wire shape.
`../openchamber-control/library.js` is the agent-facing adapter.

## Invariants

- The document-library setting controls document APIs, watchers and ingestion.
  Internal memory demand can keep the same owned backend running while that
  setting is off. `start()` reconciles document-setting changes;
  `setMemoryDemand(false)` releases memory demand. Full server shutdown calls
  `stop()`. Memory-only startup creates no document watcher or ingest queue.
- Cleanup of an old managed memory document remains available with document
  activity disabled. It uses the managed identity and original document ledger;
  an absent old document needs no model or backend mutation.
- Private memory-index operations share the authorized KB transport and SQLite
  service. Document Wiki and graph policy never gate typed memory-node writes.
  Memory source eligibility remains the conversation owner's responsibility.
- A document's identity is `(libraryId, relPath)`. The backend knowledge id
  is an attribute that survives a content change, never the identity.
- Only documents in the `ready` state are returned by search, listed as
  openable, or quoted by the agent. A parsing document is invisible rather
  than cited-and-unopenable.
- A library-scoped search accepts passages only from that library's ready
  ledger records, even if the backend returns additional knowledge IDs.
  Filtering happens before the result limit, so an unrelated hit cannot
  displace an authorized passage. The same rule covers the panel and agent.
- The absolute path enters the backend only through the reference endpoint
  and is never part of an API response that the backend produced. The panel
  uses the ledger's own path to open the file.
- Gallery images expose a nullable `source` with `documentId`, `path` and
  `relPath`, resolved from the image's backend `knowledge_id` and a ready ledger
  document's `knowledgeId`. Both paths come from the ledger. Missing or unready
  sources stay unlinked; source filenames never identify documents.
- Gallery tiles open an image preview with the complete caption. Opening the
  original is a separate action through the runtime's existing file opener.
  Details stay inside the gallery panel with a return action. The mounted image
  grid retains its scroll position and returns focus to the originating tile;
  returning releases the detail image without reloading the thumbnails.
  Image failures retain the caption and source action; a gallery read failure
  is visible and never presented as an empty gallery.
- One knowledge base holds every library; `folder_path` is
  `<library slug>/<directories>`, which is what makes the tree.
- Removing a library deletes its ledger rows, and deletes backend records
  only when the caller asks. It never touches files on disk.
- A file that disappears from disk becomes `missing`; nothing deletes
  records implicitly, and `clean-missing` is the explicit action.
- Secrets (API key, account password) never leave the server; status answers
  carry presence, not values.
- A library root is validated before every scan. A vanished or unreadable
  root fails that library closed and never reads as mass deletion.
- Ordinary folder preview reads metadata only. It returns file counts plus
  broad token and time ranges without parsing files or calling a model. Managed
  TXT preview also freezes the bounded file bytes for exact confirmation.
- A failed start keeps its error code and backend log path in status. An
  explicit retry returns that status after a second failure so the settings
  page and library panel can show the cause.
- The stored enable switch is shown from the server status once it is read.
  A local default or stale client value cannot make a disabled backend look
  switched on.
- Managed conversation libraries and documents carry
  `managedBy: 'conversation-memory'` and a trusted `projectId`. Ordinary
  library lists, document lists and direct reads exclude them. A matching
  server-resolved project may read them. A model-provided project identifier
  never establishes that scope.
- Search computes eligible ready knowledge IDs before backend topK and checks
  returned hits against the same set. A project query includes ordinary
  libraries and its own managed entries; an unscoped query excludes every
  managed entry. An empty document selection performs no backend search.
- A semantic or model-configuration failure preserves ready local title/name
  matches and returns `availability.state: 'degraded'` with a stable reason.
  A stopped backend still permits local lookup. An empty passage list with
  degraded availability does not establish that no matching content exists.
- Ordinary scans and ingestion never advance managed entries. Scans exclude
  the managed subtree even when an ancestor or symlink alias is registered as
  a user library. Managed roots cannot be added as ordinary libraries.
- Managed Markdown is atomically replaced with mode `0600` under a mode `0700`
  directory. The runtime derives every path from hashes of validated opaque
  IDs. Its managed APIs accept no caller-selected file path.
- A managed content replacement first hides its old ready revision. Failed
  writes remain pending and indexing verifies the stored content hash before
  using the local reference. A missing file can be restored from the same body
  without embedding identical indexed bytes again.
- Each managed reference registration or reparse reads the current
  knowledge-base strategy. Parse status polls reuse the existing ingestion
  without another policy read.
  Wiki and graph derivation must both be explicitly disabled. Enabled, unknown
  or unreadable policies fail with `managed_derivation_scope_unavailable`
  before registering or reparsing the reference. Retained Markdown can be
  retried after the policy is resolved. User knowledge-base settings stay intact.
- Forget persists `deleting` before backend or disk cleanup. That state is
  absent from searches and ordinary reads. Cleanup errors propagate and keep
  the row for retry. A successful result follows backend deletion, local file
  removal and ledger deletion. Sweeps cannot recreate a removed document.

## Decisions

### Why the backend dictionary is adjacent to its executable

The Go Jieba library otherwise resolves its dictionary from the source path
recorded when it was compiled. That path belongs to the build machine and
cannot exist on a user's Mac. Packaged backends carry a hash-verified
`jieba-dict` directory and receive its absolute path in `JIEBA_DICT_DIR`.
An adjacent directory missing any required dictionary fails before spawning.
Custom backends without that directory retain their own dictionary setup.

### Why gallery source links use backend knowledge IDs

Files in different libraries or directories can share a name. Joining the
image's knowledge ID to the ready ledger preserves its exact local source and
leaves a stale or external source visibly unavailable. The response includes
the ledger paths so source links also work beyond the panel's document list limit.

### Why one knowledge base and folder paths, not one per library

Cross-library search is the common case, and one backend call serves it. A
knowledge base per library would multiply model configuration and make a
global search an N-call fan-out. The cost is that scoping a search to one
library has to pass its ready documents' ids; that is a ledger lookup, and
the documented upgrade path is a tag per library if ids ever get large.

### Why file-name search runs over the ledger

The backend's `?keyword=` filter matches titles only, and only for documents
it has finished indexing, so it cannot answer "find the file whose name looks
like this" while a folder is still catching up — and it costs a round trip.
The ledger already holds every relative path and state; filtering it is
instant, works while the backend is down, and keeps one input returning both
groups.

### Why semantic failures retain local matches

A saved document title is independent of its embedding backend. Search keeps
that local result and reports the failed semantic component so exact lookup
works during a backend outage without presenting incomplete retrieval as a
successful empty answer. Model reconciliation remains retryable on each
semantic attempt and retains safe policy/restart reason codes.

### Why a change reparses instead of delete-and-register

The fork's reference records are idempotent per `(knowledge base, path)` and
`POST /knowledge/:id/reparse` re-reads the file in place. Deleting first
would open a window where a citation points at nothing and would change the
knowledge id, which is exactly what citations and the ledger key on.

### Why the ingester is the only module that knows how a file enters the index

Reference ingest is a contract with a forked backend. Keeping registration,
reparse and polling behind `ingest.js` means a different contract — a copy,
a mount, a different fork — replaces one adapter; libraries, the ledger,
search, the panel and the agent tool do not change.

### Why both a watcher and a sweep

`fs.watch` drops events (editor atomic saves, platform quirks) and is not
recursive everywhere. Events are treated as hints that mark a root dirty; a
10-minute sweep runs regardless, so the failure mode of a dropped event is a
delayed update, never a silently stale index.

### Why a freshly written file waits

A file registered while it is still being written is parsed from a partial
body and appears indexed while being wrong. A document whose mtime is under
1.5 seconds old stays `pending`; a later pass promotes it. The hash is
recomputed immediately before the backend call, so a touch that leaves the
content identical costs no reparse.

### Why managed documents use an explicit ingest pass

Conversation memory owns a durable indexing job, so a watcher is insufficient
to establish completion. Its upsert and ensure operations each run one existing
reference ingest or parse-poll pass. Only the backend's completed state with no
pending subtasks returns `ready`. This also keeps automatic folder sweeps from
recreating forgotten entries or spending model calls on retained memories.

### Why managed Markdown shares the knowledge base

The existing reference ingester preserves backend IDs through content changes
and uses the existing model configuration. Search isolation uses ledger-owned
knowledge IDs before retrieval and after it. The backend's wiki and gallery
APIs remain knowledge-base-wide contracts; they do not provide a project-scoped
memory retrieval API. The backend has no per-document Wiki exclusion, so managed
indexing requires a current policy with Wiki and graph derivation disabled.
Changing an existing knowledge base's strategy would silently alter user
libraries; this module reports an explicit failure instead.

### Why the workspace panel and the agent share one runtime

Both answer from the same ledger and the same backend. Two owners would drift
on readiness, scoping and error mapping, and the agent would cite documents
the panel does not show.

### Why a failed retry returns status instead of an HTTP error

The reconnect route reports the final backend state, including the error code
that stopped it. A generic 500 would hide the model or path failure that the
person needs to fix before retrying again.

### Why the add-folder estimate is a range

The preview cannot know the extracted text of PDFs, Office files or scanned
pages without parsing them. Token bounds therefore use file format and size,
while time also assumes two concurrent documents. Image-heavy PDFs and
presentations can add OCR or vision calls outside the embedding estimate. The
confirmation shows the range, identifies image-heavy files and points to the
provider bill as the final source of cost. Showing a supposedly exact number
would understate the common expensive cases.

## Unified model configuration

### Managed TXT indexing and search

The normal preview, confirmation, import, rescan, status and search routes use
`managed-work.js` when the embedding binding is managed UniHub. The feature
requires `OPENCHAMBER_KNOWLEDGE_WORK_PREPARE=true` and a pinned instance owner
issuer/user. `platform-account` owns the bearer session, current route reads,
pinned paid dispatch and same-response producer receipts. No bearer, provider
key or account-selected identity enters the worker, browser or agent tool.

This lane accepts one ASCII/CJK TXT file up to 300 bytes with one chunk.
Preview freezes its bytes and displays the existing token/cost/time estimates.
Only explicit confirmation can obtain the initial paid route preflight. Startup,
typing, preview, status, retry and reconnect never issue a paid grant. Confirmed
rescan can index changed bytes after the prior revision committed. Automatic
scans do not index managed files. Search submits on Enter and uses one query
embedding and one rerank for the selected document.

The durable namespace contains version, verified issuer, commerce service,
configured instance, verified actor, payer, server project and explicit host
space. A browser directory is only a lookup hint against known server projects
and worktrees. An auth-session fence is transient and checked around async work;
a new valid login can use the durable namespace after current authorization.
Isolated container spaces return `knowledge_work_space_unsupported`; the host
never reads their paths as host files. Web and Electron share this server,
hosted mobile and Capacitor use their connected server, and VS Code has no local
knowledge backend. Windows native behavior requires separate runtime acceptance.

The owned worker uses a separate loopback callback listener, persistent private
keys, SQLite and a minimal environment. Existing listeners are never adopted.
Windows holds and validates every ancestor through relative native handles.
Structural ancestors may permit read, traverse and creating other children;
untrusted modification, deletion, child deletion and ACL changes are refused.
The target directory and key file require the current user's owner SID and a
private current-user/SYSTEM/Administrators ACL. New directories and files receive
that protected descriptor at exclusive creation. Existing objects are inspected
without changing their owner, permissions or contents. Only an exclusively
created target directory is reported as owned for temporary cleanup.

One hidden system PowerShell helper holds the same empty file handle across
owner/ACL validation, readiness and writing. The Node handle adapter sends
exactly 32 key bytes through the helper's stdin only after readiness. The helper
rechecks that file and its held ancestors before writing, then flushes the same
handle before acknowledging success. Static code and path metadata use the
same private pipe; arguments, environment and output contain no key bytes.
The child environment contains only SystemRoot, WINDIR and canonical TMP/TEMP.
Before Add-Type can compile, the helper validates that existing user temporary
directory and every ancestor, refuses reparse objects or unsafe grants, and
checks writability with an exclusive empty DeleteOnClose probe. It neither
creates nor repairs existing compiler directories; compilation cannot fall back
to the Windows directory. The Utility module is imported from its absolute
system manifest before parsing JSON, without searching user-installed modules.
Raw path syntax still rejects traversal and Win32 device aliases. Framework
GetFullPath may expand an ordinary 8.3 user-profile name; the resulting actual
ancestor objects receive the same validation and held-handle checks.
Reparse objects, unsafe existing keys and unknown results are refused. A failed
creation can leave an empty private file, which requires recovery rather than
automatic key rotation. Unix keeps its existing private modes, exclusive
creation and no-follow opens.
The host fsyncs a storage anchor and a chained PENDING record before ingest.
Actual signed discovery verifies storage, revision, original producer receipt,
vector digest and completion before fsyncing COMMITTED and exposing ready.
Every reuse obtains current index_read and fresh signed storage/discovery/use;
expired ingest grants do not prevent this zero-spend recovery. The ready file
is a materialized view, not authority. Missing/corrupt keys, anchors, journal
and rollback mismatches fail closed. Restoring all private host state and worker
storage together remains outside rollback detection; there is no external
monotonic anchor.

### Why Windows key creation supplies an explicit owner

An elevated Windows process can create Administrators-owned files even inside
private AppData. POSIX mkdir/write modes do not establish Windows ACLs. The host
supplies the owner and protected ACL at exclusive creation, then validates and
writes through one held native file handle so the worker can retain its strict
current-user owner check. Path-based reopening could write a different object
from the one already checked. Existing unsafe secrets stay refused because a
permission repair cannot establish that their previous contents remained private.

Stable document IDs include namespace and canonical source path. Journal
high-water rejects older revisions; unresolved indexing cannot be deleted or
re-created under another ID. A lost response recovers the existing task/call.
Unknown search outcomes similarly retain existing work and call IDs. Search
results require the worker's exact raw-byte MAC envelope, current boot, nonce,
full binding and bounded expiry before disclosure. Duplicate JSON keys reject.
Managed content/file reads return rechecked host bytes after completion
verification. Wiki and gallery are unsupported in this bounded lane.

Normal agent search additionally requires a current UI prompt bound privately
to the actual OpenCode session directory, then one exact native v2 running tool
record matching session, call ID, tool name and input. Native nested
`parameters` use the same precedence as the generated plugin. The adapter
rechecks that record after asynchronous citation projection, before disclosure. Caller-supplied project,
directory and identity never establish authority. A restart clears prompt
bindings; a new explicit UI prompt is required. Existing ordinary agent reads
continue through their current runtime.

### Why completion has a private journal

An encrypted work registration proves preparation, which can precede a crash
or an unknown paid result. The PENDING/COMMITTED chain, storage anchor and
high-water preserve the exact revision that actual worker completion can
recover without repeating paid work. Read-only discovery cannot invent a new
work ID or lower a revision.

The runtime accepts an injected `resolveModelBinding` and exposes
`prepareModelBindingChange` for the model-service pre-save validation hook.
Existing model records are synchronized before ingest and semantic search.
Unbound purposes retain imported or legacy defaults. An explicit embedding
binding can provision a fresh backend without borrowing its key for an unrelated
DashScope rerank model. The document ledger, backend IDs and indexing dimensions
are never reset by saving a model binding. Embedding replacement on an indexed
library requires a separate explicit rebuild workflow and is refused here.

The backend's SSRF exceptions contain the existing default and imported model
hosts, the exact PaddleOCR result hosts, and the literal hostname of each
resolved embedding, rerank, vision and OCR binding. Resolution applies the
model service's current credential and enterprise policy before a host enters
the environment. Unbound saved connections add no exception. Hostnames cannot
introduce comma-separated rules, wildcards or CIDR ranges; IPv6 brackets are
removed to match the backend's URL hostname parsing.

The observed PaddleOCR result hosts are `paddleocr-store.bj.bcebos.com`,
`paddleocr-store-2.bj.bcebos.com` and `paddleocr-store-3.bj.bcebos.com`.
PaddleOCR's temporary BOS `resultUrl` does not define a closed hostname set.
Further result hosts require verification and an explicit exact-host addition.

Before a consumer uses a newly bound host, an owned backend restarts with the
expanded environment. Model reconciliation and the complete ingest/search
request share a queue so the restart cannot interrupt another ingest or search
request. First-run activation refreshes these hosts before creating models and
uses the same queue without synchronizing records that do not exist yet.
A changed key on the same host does not restart the process. Unbinding keeps
backend model records, so its host exception also remains for that process's
lifetime. A cold start rebuilds the exceptions from defaults and current
bindings. An adopted backend is never killed to apply another owner's
environment; a new host reports
`model_configuration_knowledge_restart_required` until its owner restarts it.
On initial adoption the actual synchronization decides whether existing host
exceptions are sufficient. A backend rejection keeps its original error code;
the runtime cannot infer the adopted process's environment from its own request.
Failed refreshes remain retryable and do not record the new environment as
applied. Asynchronous synchronization failures after provisioning are included
in its returned error result.

`GET /api/knowledge-library/status?models=1` opts into a read-only projection of
actual backend model records and parser configuration. Ordinary status polling
does not perform these extra reads. The projection contains purpose, model ID,
name, sanitized base URL, dimensions and key presence only. URL user information,
query parameters and fragments are stripped. Backend/account failure is
`status: 'unavailable'`; a parser-only failure leaves other complete model
metadata available and lists OCR in `unavailablePurposes`. This lets the unified
page show working legacy configuration without inventing a saved binding.

### Managed embedding-space authorization

The current account adapter verifies the gateway's index_read route and exact
executed producer receipt. The host checks the public model and complete space
`aliyun/text-embedding-v4/v4/1024/text`, policy digest, route generation,
instance, actor, payer, task, call, operation and exact response digest. Pinned
dispatch is mandatory. Search also rechecks its current rerank pin before every
callback and final disclosure. The local model catalog is shape validation;
it cannot attest the live route. Offline synthetic tests establish host wiring,
not deployed gateway, provider, installed application or billing acceptance.

## Managed document contract

The conversation-memory runtime calls these server methods with a trusted
project ID. IDs contain 1 to 200 ASCII letters, digits, `.`, `_`, `:` or `-`,
start with a letter or digit and cannot select a path.

- `upsertManagedDocument({ projectId, id, title, markdown })` persists the
  canonical Markdown and performs one indexing pass. Identical bodies reuse
  the document path, ledger ID and backend knowledge ID. Changed bodies reparse
  the existing reference. Failed parses explicitly retry using that same ID.
- `ensureManagedDocumentIndexed({ projectId, id })` advances or polls the
  stored reference once, without generating or replacing its body. It returns
  `null` for an absent or deleting entry. Callers retain pending/parsing jobs
  and invoke it again; elapsed time alone never establishes readiness.
- Both indexing operations return `{ documentId, knowledgeId?, state, error? }`.
  `state` is `pending`, `parsing`, `ready` or `failed`; `error` contains a code
  and may contain the backend parse message. An unavailable backend leaves
  persisted pending work and returns `backend_unavailable`.
- `readManagedDocument({ projectId, id })` returns that state with `title` and
  `markdown`, or `null` for an absent or deleting entry. Source-write or read
  failures propagate. Only ready entries may supply indexed quotations.
- `searchManagedDocuments({ projectId, query, limit = 5, documentIds? })`
  returns the usual `{ query, documents, passages }` for that project's managed
  entries only. `documentIds` contains stable ledger IDs, further intersected
  with the project scope.
- `removeManagedDocument({ projectId, id })` returns
  `{ removed: true, documentId }` only after actual cleanup, or
  `{ removed: false }` when absent. A deleting entry rejects upsert with
  `cleanup_pending`; its cleanup can be retried with the same identity.

The ordinary `search`, `findDocument`, `readContent`, `getFile`,
`listDocuments` and `readLibraries` methods accept an optional trusted
`projectId`. Search additionally accepts `documentIds`, `managedDocumentIds`
and `managedOnly`. A supplied `managedDocumentIds` is an active-entry allowlist
that limits managed results while retaining ordinary user libraries. An empty
allowlist excludes every managed entry. The conversation runtime supplies it
to agent searches after applying source reset, disabled and forget records.
Existing unscoped callers continue to see user libraries. Direct managed
indexed-content reads refuse pending, parsing, failed and deleting revisions.

Managed indexing and managed-only search fail closed with `enterprise_mode`.
The backend can retain legacy external model records, so a missing explicit
binding cannot prove that generated conversation content stays on this machine.
Ordinary searches omit managed entries in enterprise mode even when a project
is supplied. Deletion remains available. Web, Electron, hosted mobile and
Capacitor use this server enforcement; VS Code has no knowledge backend here.
Turning capture off does not delete retained Markdown or its index records.

### Why completion recovery shares the runtime consumer queue

One admission owns one journal and its serialization tail, including reads,
anchor creation, PENDING and COMMITTED. Polling, source reads and file disclosure
share the runtime mutation queue, so recovery cannot replace a completed delete
or a newer document revision with an older ledger snapshot. Journal corruption
and rollback still fail closed; concurrent recovery never creates a paid retry.

### Why a managed store cannot fall back to native models

The persisted managed profile, managed ledger ownership and durable storage
anchor survive model-selection changes. Ordinary backend startup, model sync,
search, provisioning, rebuild and retry refuse that store before backend IO.
Clearing or replacing an embedding binding is refused for an existing managed
store. Native profiles retain their library and conversation-memory behavior.
Managed worker IO and final source disclosure require the supervisor's current
owned child to remain alive. Health alone cannot establish that ownership.

### Why rerank callbacks use raw chunk bytes

Rerank callback documents must equal the verified raw chunk bytes sent by the
worker. The filename prefix used for ingest embedding is not part of that chunk.

### TXT edge whitespace and exact source provenance

The managed pilot accepts nonempty ASCII/CJK TXT with leading or trailing
spaces or LF within the original 300-byte file limit. Pure whitespace, `#`,
CR/tab, invalid UTF-8 and characters outside the existing pilot charset are
still refused; query edge whitespace remains invalid. Confirmation, snapshot
SHA, current-file checks and the completion's raw chunk SHA bind the original
bytes, including the final LF. No source file is rewritten or trimmed.

The worker's existing `Chunk.EmbeddingContent()` trims only the text sent to
the embedding model. Host dispatch and completion index-text verification use
that same title + LF + trimmed chunk input. Stored chunk content and rerank
documents remain the exact raw chunk bytes, including edge whitespace. The
producer input SHA, actual vec0 bytes, actor/payer/session, route/receipt and
UNKNOWN/no-resend checks keep their existing meaning.
