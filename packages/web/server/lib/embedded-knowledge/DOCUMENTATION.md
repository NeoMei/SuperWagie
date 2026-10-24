# Embedded knowledge backend

## Ownership

This module owns the bundled indexing backend and everything that speaks to
it over HTTP:

- `client.js` — every endpoint the feature uses, auth headers, timeout,
  and the typed `EmbeddedKnowledgeError` callers branch on. It is the only
  module that knows wire shapes.
- `supervisor.js` — binary resolution, child process, health probe, restart
  ladder, adoption of an already-running instance, shutdown.
- `provision.js` — the one-time account, models, knowledge base and API key
  on a fresh database, plus the defaults applied to an already-provisioned
  one (versioned by `DEFAULTS_VERSION`).
- `local-defaults.js` — reads the machine's WeKnora Lite installation, when
  present, and turns its model and parser choices into those defaults.

`../knowledge-library/` owns the product on top of it: libraries, the ledger,
ingest policy, search merging, routes, the panel and the agent tool.

## Invariants

- The backend binds `127.0.0.1` only and is never proxied as a browsable
  surface. Its own UI stays invisible.
- The child is spawned with `SERVER_HOST` and `SERVER_PORT` in its
  environment. It must not depend on finding `config/config.yaml` from a
  working directory that packaging may change.
- `SERVER_PORT` defaults to 17808, and its `config/` is pinned to the same
  port so a manual start matches a supervised one.
- A healthy instance on the port is adopted; a listener that is not this
  backend is reported as a port conflict. The supervisor never kills a
  process it did not start.
- Restarts follow one ladder (`0, 5, 20, 60, 300` seconds) and then stop at
  `unavailable`. No data repair, no lock-file deletion.
- `SYSTEM_AES_KEY` and `JWT_SECRET` are generated once into
  `<data-dir>/embedded-knowledge/secrets.json` with mode `0600`; they are
  never written to settings.
- Credentials never reach the browser. The API key is a write-only setting;
  the account password and model key are write-only too.
- Provisioning is idempotent per step: an existing artefact is reused, so a
  crash halfway through is retried, not duplicated.

## Decisions

### Why the API key's `token` and not `api_key`

The create-key response carries a display id (`api_key`) and a credential
(`token`). Only the token authenticates `X-API-Key`; using the display id
returns 401 for every call. `createApiKey` returns the token and hides the
other field so a caller cannot pick the wrong one.

### Why the backend environment whitelists the model host

WeKnora validates model base URLs against SSRF before creating the record. On
machines whose DNS returns fake-IP addresses, `dashscope.aliyuncs.com`
resolves into a restricted range and creation fails before the payload is
read. The knowledge runtime puts exact default, imported and explicitly bound
model hosts in `SSRF_WHITELIST_EXTRA`. PaddleOCR's observed result hosts
`paddleocr-store.bj.bcebos.com` and `paddleocr-store-2.bj.bcebos.com` are listed
individually because the backend validates result downloads through the same
guard. There is no domain wildcard or disabled SSRF check.

The supervisor's `restartOwned` applies the runtime's new environment by
restarting its own child. It returns `null` for an adopted running backend and
leaves that process alone, so a caller can report that its original owner must
restart it. An unsuccessful restart retains the normal backend state and can
be retried.

### Why defaults come from a local WeKnora Lite install

The backend alone cannot read PDFs or Office files: `simple` handles text and
media, `docreader` is an external service the desktop app never runs, and
`anydoc` converts Office formats but needs OCR for scanned pages. Anyone who
already tuned a WeKnora Lite installation has working choices for those gaps —
the vision model, ASR model, PaddleOCR-VL Cloud token and parser rules.

`local-defaults.js` reads that installation's SQLite database read-only and
copies the choices into our backend during provisioning. Model credentials
there are AES-GCM encrypted under that installation's `SYSTEM_AES_KEY`; the
import decrypts them with the key from the same directory's `runtime.env` and
hands plaintext to the model-creation API, which encrypts them under ours.
Nothing is written back, and a machine without that installation keeps the
built-in DashScope defaults.

Defaults are versioned so an existing backend picks up a new set once. The
upgrade runs on start when the stored version is behind; it never asks the
user for a key it does not have.

### Why model creation is not a credential check

Upstream accepts a model record without calling the provider. A wrong model
key therefore surfaces on the first document parse, whose message names the
rejected key. Validating the key ourselves would add a second provider
client and a second place that handles the user's credential; the parse
error already reaches the document row.

### Why the supervisor adopts instead of owning the port

A previous instance can survive a desktop crash. Refusing to start while it
is healthy would strand the feature until the user found the process; a
blind spawn would fail with `EADDRINUSE` and look like a broken install.
Adoption keeps the feature working, and the port-conflict state covers the
case where something else holds the port.

## Unified model bindings

`model-bindings.js` owns applying explicitly selected embedding, rerank, image
understanding and PaddleOCR bindings to the local backend's model records. It logs into the
existing local account, updates the existing record ID and retains unrelated
parameters. A selected key is therefore actually rotated even when the versioned
first-run provisioning path has already completed. Model service resolution
runs before every indexing pass and semantic search, so enterprise policy and
new connection revisions apply without a cached credential crossing.

### Why indexed embedding replacement is refused before saving

An existing embedding's name, endpoint and dimensions define its index. Both the
local document ledger and the backend's knowledge count are checked before a
binding change and again before use. A different model, endpoint or dimension is
refused for an existing index. Rotating the key on the same model preserves its
record, knowledge base and stored dimension. This page does not perform an
implicit rebuild or pretend that queuing a reparse changes the index contract.

### Why binding preparation does not update the backend

`prepareModelBindingChange` validates only. Saved configuration and the backend
are separate persisted stores; a failed configuration write must not leave a
remote key half-rotated. `syncModelBindings` applies the authoritative saved
revision before the consumer uses it. A failed sync remains a visible failed
operation and is retried at the next invocation.

### Why PaddleOCR configuration uses the backend parser adapter

The pinned backend `f5adb9e` already owns PaddleOCR's v2 jobs protocol: multipart
submission, job polling and JSONL result download. The binding updates its
`paddleocr_vl_cloud_token`, `paddleocr_vl_cloud_base_url` and
`paddleocr_vl_cloud_model`, retaining other tenant parser settings. PDF/image
rules are routed to the available PaddleOCR engine while Office and unrelated
rules, chunking and indexes remain intact. Model configuration does not replace
this with an incompatible generic chat or legacy layout parsing request.

Model synchronization uses a private digest of the resolved endpoint, protocol,
model, parameters and credential, rather than only the page revision. A native
OpenCode key rotation therefore reaches existing backend records on the next
invocation even when the model page was not saved again. The digest and source
credential are never part of the public configuration.

KB mutations retain cumulative state: enabling a new VLM and then changing OCR
rules cannot restore a stale disabled VLM. OCR sends only its required KB
configuration fields. A missing active embedding record is an explicit repair
error; the backend's KB PUT does not support rebinding `embedding_model_id`.

Pre-save preparation rejects unsupported knowledge protocol families. A running,
provisioned backend must list the PaddleOCR parser before an OCR binding can be
activated. Registration is sufficient for this local check: `Available` can be
false until its token is configured. Unprovisioned/offline setup does not make
provider calls or invent a missing-adapter verdict; invocation still validates
the actual parser after configuration is applied.
