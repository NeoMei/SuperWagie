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
read. The generated environment lists that host in `SSRF_WHITELIST_EXTRA`;
without it first-run setup cannot create the embedding model.

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
