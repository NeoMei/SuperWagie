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
- In the native lane a healthy instance on the port is adopted; a listener that is not this
  backend is reported as a port conflict. The supervisor never kills a
  process it did not start.
- Restarts follow one ladder (`0, 5, 20, 60, 300` seconds) and then stop at
  `unavailable`. No data repair, no lock-file deletion.
- A failed spawn, unexpected exit or startup timeout exposes a stable error
  code while the supervisor state remains `unavailable`. A successful start or
  adoption clears that error.
- `SYSTEM_AES_KEY` and `JWT_SECRET` are generated once into
  `<data-dir>/embedded-knowledge/secrets.json` with mode `0600`; they are
  never written to settings.
- Credentials never reach the browser. The API key is a write-only setting;
  the account password and model key are write-only too.
- Provisioning is idempotent per step: an existing artefact is reused, so a
  crash halfway through is retried, not duplicated.

- Signed managed search can wait up to 120 seconds for its two bounded model
  stages. Ordinary metadata keeps the default fifteen-second deadline. A timed
  out response body produces the same typed timeout as a connection timeout;
  the client never retries either request. Signed scopes, proof expiry, MAC and
  current authority checks remain independent of this transport budget.

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
`paddleocr-store.bj.bcebos.com`, `paddleocr-store-2.bj.bcebos.com` and
`paddleocr-store-3.bj.bcebos.com` are listed individually because the backend
validates result downloads through the same guard. PaddleOCR's temporary BOS
`resultUrl` does not define a closed hostname set. Further result hosts require
verification and an explicit exact-host addition. There is no domain wildcard,
CIDR exception or disabled SSRF check.

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

### Why model updates split metadata and credentials

The pinned backend preserves stored `api_key` and `app_secret` during model
metadata PUT. `updateModel` removes both fields from that body and sends nonempty
values to the flat `/models/:id/credentials` PUT. Missing, null and empty values
keep existing credentials. The input model is unchanged and the method returns
the metadata response only after both writes succeed.

A credential failure leaves successfully written metadata in place and rejects
with the normal typed client error. Binding synchronization records its applied
identity only after this method succeeds, so the same saved binding retries on
the next invocation. These local backend writes perform no provider probe.

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

### Why compatible rerank uses the generic engine provider

An `openai-compatible` rerank binding uses the pinned engine's `generic`
provider, which declares rerank support and sends the standard Cohere-style
request to `/rerank`. Its configured API base remains unchanged, including
`/v1`. The engine reads top-level `results` with `index` and
`relevance_score` or `score`. Aliyun and managed rerank retain their native
provider mapping. This uses the engine's existing adapter and does not rely on
the OpenAI catalog's permissive resolution fallback.

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

### Why managed workers require process ownership

Managed indexing relies on a pinned callback key and durable storage identity.
A healthy listener cannot prove it was launched with those values, so managed
startup reports `managed_worker_unowned` instead of adopting it. The managed
child receives only its explicitly constructed environment, no provider keys,
proxy variables or imported local defaults. Private config and migrations are
staged under its data directory. The managed client sends signed JSON bytes
unchanged, disables redirects and bounds raw JSON replies for host MAC checks.
The native lane retains existing adoption and environment behavior.

Managed startup captures the spawned child instance and checks its liveness
before and after health IO. Exit or spawn error clears ownership immediately;
a healthy competing listener cannot become the owned worker. Runtime client
IO rechecks ownership before and after each request, and managed recovery checks
it again before returning. Foreign listeners remain untouched.

### Why account-key OCR uses a local jobs adapter

The account-key OCR connection uses the gateway's standard `/v1/ocr` API. The
bundled parser expects PaddleOCR jobs and a JSONL result download. The local
adapter translates those contracts using the selected account connection. It
binds only `127.0.0.1` and rejects foreign Host or browser Origin headers. The
parser receives a 10-minute opaque bearer; the account key stays in its owning
secret store and is resolved before every upstream request.

Every submission, poll and result read verifies the current logged-in owner,
connection, model, credential, parameters, revision and enterprise policy. An
account switch, key change or expired session invalidates existing capabilities.
Enterprise mode refuses this external OCR path. The backend runtime owns the
adapter's listener and closes its requests and capabilities on shutdown.

The parser downloads JSONL without an Authorization header. Its result URL
therefore contains a separate random capability valid for at most 60 seconds,
limited by the parent scope. A later authorized poll rotates an expired result
capability. Every result download still checks current owner and key and reads
only the gateway's authenticated text document projection. Provider resources,
images, native JSON, supplier URLs and account keys are excluded. Recognized
text, tables, formulas and available layout coordinates remain usable; image
content and hyperlinks are omitted from this text-only path.

Request bodies are limited to 32 MiB, projected results to 16 MiB and 1000 pages.
There are at most 16 active scopes and 64 submissions per scope. Identical
content and options use the same deterministic upstream idempotency key across
scope renewal or process restart. The gateway's persisted OCR replay fence
prevents a repeated HTTP submission from executing the supplier again. An
uncertain local submission is retained until its scope expires and never retried
automatically. A repeated request after reopening uses that same upstream request identity
and receives a duplicate conflict if the gateway already admitted it. Recovery
then requires the existing call receipt; no second paid call is created. The adapter performs no
provider probes during setup or binding synchronization.

### Why transport repair is an offline operator

`scripts/embedding-transport.mjs` is an explicit JSON-stdin maintenance command.
The owning coordinator offers preview, prepare, resume and paired rollback for
the existing account's text-embedding-v4 1024-dimensional index. It has no HTTP
route, UI control, startup hook or provider client. Web, desktop and mobile
consumers retain ordinary binding guards; VS Code has no operator entry.
Enterprise provider-entry policy is checked before native writes and immediately
before configuration publication, including policy changes during maintenance.

Preview creates no files. Every native invocation requires a checkpointed
SQLite file, no open handles according to `lsof`, and captured owned PIDs that
are no longer alive, or an explicit isolated-copy source path and SHA-256.
The operator refuses a nonempty WAL or rollback journal. It never checkpoints,
kills processes, starts the backend or repairs a partial live database itself.
The pinned executable receives JSON on private stdin and AES material in a
restricted child environment. Output is bounded, captured and decoded once
from concatenated buffers; errors never include child output. Its deadline is
480 seconds because full knowledge and whole-database fingerprints can take tens
of seconds per pass.

Persisted account ownership is read through `createAccountKeyStore.read` and
`createModelBootstrapStore.getSecret`. Explicit issuer, service, actor, account,
connection, reference, endpoint, expiry, key SHA-256 and last four characters
must agree. Bootstrap discovery cleanup and credential issuance never run.
Raw configuration, activation, bootstrap secret/master key, native AES/JWT,
account sessions, settings, preferences and retained knowledge/memory JSON files
are frozen with modes and existence. These private files and the stopped database
are backed up byte-for-byte. Preparation restores separate copies and compares
raw hashes plus stable native preview fields across paths before admitting the
backup receipt. Database path identity and full preview digest are path-specific.

The normal model runtime stages `saveBinding` on a private copy with a throwing
network dependency and exact target preparation assertion. The coordinator reads
the resulting file bytes, retains `untested`, and publishes only after native
receipt verification, original raw-file CAS and the owning configuration lock.
Activation test history is unchanged. A current authenticated Test & apply in
the installed app supplies the final session and applied-consumer proof.

The durable journal records prepared, database_committed,
configuration_committed and verified. A prepared phase compares the physical database hash with its original backup
before applying. A changed physical file is admitted only through verify of the
existing transaction receipt. The receipt binds both the expected whole-database
baseline and the committed whole-database state. Schema, persisted header
settings and every ordinary or shadow table are covered, including other
consumers and models. Only this operation's receipt row is excluded. Unrelated
writes after a commit interrupted before journal persistence refuse recovery. Configuration rename is idempotent against the original or
exact staged bytes. Every other drift fails closed. Paired rollback requires
unchanged file hashes and the exact whole-database post-state, then restores only the
owned database and changed configuration. Its rolling_back phase resumes a
partial restore. New application writes forbid automatic full-file rollback.
Do not restart ordinary consumers while a journal is between prepared and
verified, or while rollback is incomplete.

### Why account text-embedding-v4 retains a ten-item request ceiling

The OpenAI adapter's generic catalog default permits 2048 texts, while this
native account route forwards to Aliyun's ten-item v4 endpoint. The owning
parameter builder pins `spec.compat.max_batch_size` to 10 only for llmrouter,
OpenAI-compatible text-embedding-v4. An existing stricter positive integer bound
and unrelated spec fields remain intact. Native protocol batching preserves
text order, dimensions and input-role semantics. The scoped operator admits
only the reviewed empty-spec to exact ten-item spec change, or its exact replay.
This changes target space identity and requires a fresh native preview.

### Why maintenance claims use kernel leases

An initialized PID/token claim is atomically linked into the existing `.lock`
path. Creation, stale-claim recovery and release use an exclusive kernel lease
on a permanent `.lease` inode. There is no recovery sentinel whose own crash can
block later recovery. A live empty lock from the normal configuration writer is
retained; an empty stale lock requires `lsof` to prove no process holds it.

Each native apply or verify holds a shared lease before opening SQLite and until
after closing it. Killing the Node parent therefore cannot admit a rollback
while its native child can still commit. The child checks the current claim and
live parent before opening the database. Process tokens are ephemeral and do
not change the durable request HMAC. The expected configuration-lock path stays
bound to the database's data directory. macOS and Linux implement the lease;
other operator platforms fail closed. Ordinary application locking is unchanged.

Rollback reads the original owned credential with expiry ignored because it
performs only local HMAC/decryption checks. Issuer/account, reference, key
fingerprint, destination and raw owner-file checks remain mandatory. Preview,
apply and configuration publication still require an unexpired credential.
