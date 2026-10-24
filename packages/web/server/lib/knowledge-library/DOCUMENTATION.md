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
  libraries, reconcile/ingest loop, search, content.
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
- The absolute path enters the backend only through the reference endpoint
  and is never part of an API response that the backend produced. The panel
  uses the ledger's own path to open the file.
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

## Decisions

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

### Why the workspace panel and the agent share one runtime

Both answer from the same ledger and the same backend. Two owners would drift
on readiness, scoping and error mapping, and the agent would cite documents
the panel does not show.

## Unified model configuration

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
