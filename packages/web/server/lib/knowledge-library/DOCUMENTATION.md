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
- Folder preview reads metadata only. It returns file counts plus broad token
  and time ranges without parsing files or calling a model.
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

### Managed document work preparation

`POST /api/knowledge-library/documents/:id/managed-work` prepares an intent for
one document. The endpoint is disabled unless `OPENCHAMBER_KNOWLEDGE_WORK_PREPARE`
is exactly `true` and the instance owner issuer and user ID are both pinned.
It requires the existing authenticated platform session, an allowed browser
origin, an explicit `confirmed: true` body, and one `Idempotency-Key` header.
The payer comes from the session and is checked against the current UniHub
account list. The document and library come from the local ledger. A fresh
managed UniHub embedding binding is required.

The file is read from its library root with symlinks and path escapes refused.
The prepared snapshot is limited to 8 MiB and stored encrypted. The work record
encrypts the actor, payer, model, document identity and keyed file digest under a
private server key. It contains no document text or bearer credential. Reusing
the same key with changed work reports a conflict. A
response has `dispatchable: false`: preparation does not authorize a model
charge, submit work to WeKnora, or expose a worker credential. Automatic scans
continue to reject managed models.

Work preparation is not a production activation. Isolated tests connect the
worker to short-lived host-signed authorizations, encrypted snapshots and
settled-result recovery. Dispatch is limited to a single short text chunk with
ASCII or CJK content, optional internal LF line breaks and an ASCII or CJK TXT
filename. The worker's chunk must exactly equal the original confirmed text;
split or transformed documents are rejected. Search has a separate actor,
payer, task, query and document binding.
These pilot callbacks are not started or exposed by the product endpoint and
are not a general document or search implementation. The production gate
remains closed.
The pilot callback server creates its worker authentication key in a private
temporary directory and removes it on normal shutdown or startup failure.
An abrupt process termination can leave that directory behind; the key is
ephemeral and no new callback server accepts it.
The local key must survive independently of a restored work-record snapshot for
work IDs to remain stable. Restoring both the key and records from an older
backup may recreate an identity already used elsewhere. The gateway and
central authority have not been verified together with the host and worker,
and concurrent authorization revocation is not serialized with use. Keep the
managed model gate closed until these boundaries and durable work identity are
resolved.

The API belongs to the shared web server used by web, Electron and hosted
mobile. Capacitor uses its connected server. The VS Code extension has no
server route and does not create these records.

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

### Managed embedding-space authorization: blocked integration contract

The current managed knowledge entry is closed unless both a trusted host-only
`verifyEmbeddingEvidence` adapter and a `dispatchKnowledgeEmbeddingPinned`
implementation are supplied. Neither is wired by the application. The test
adapters are deliberately synthetic; they are not evidence of a gateway route.
The local catalog states the proposed identity but is not a live attestation.

A production adapter must independently authenticate the gateway's current
technical catalog and exact executable route. It must verify issuer, audience,
actor, payer, validity, operation and the complete tuple: provider `aliyun`,
upstream model `text-embedding-v4`, version `v4`, dimensions `1024`, input
semantics `text`. The older `text/query-document-v1` space is different. A
collision-resistant policy digest must cover a stable unique route generation,
model/channel/adapter and the entire tuple. Removing/recreating a route must
create a different generation, even if the public alias and dimensions match.
The gateway must atomically enforce that digest when admitting the call; a
preflight check followed by unpinned dispatch is not sufficient. Every charged
result, including result recovery, must carry an authenticated receipt binding
the actual executed route generation and complete tuple to issuer, audience,
actor, payer, task, call, operation, settlement and exact response digest.
The host must verify it and recheck current scope and route before returning
bytes or a signed result. Mismatch, missing receipt, stale/revoked authority,
unknown policy or an indeterminate dispatch must remain unavailable and must
never fall back to a same-name route.

Index reuse additionally requires proof of completed indexing in the same
storage generation, not merely the encrypted work registration. The worker
needs a fresh current-user scoped, nonce-bound status request and a signed or
MACed response bound to tenant, actor, payer, KB, document, space, generation,
store identity, completed state and expiry. The indexing commit and generation
must be fenced against concurrent replacement and rollback across the database
and vector store. Until that exists, previously indexed managed libraries are
rejected on configuration/credential changes, including after restart; a fresh
credential alone cannot authorize reuse. Missing or old records require an
explicit rebuild. This is an intentional availability limitation.

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
