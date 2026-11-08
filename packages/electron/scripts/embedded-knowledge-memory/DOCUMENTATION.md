# Embedded memory store

## Ownership

This source overlay adds the private memory-index routes to the pinned embedded
knowledge backend. It owns persisted memory records, state revisions and receipts,
model-space bindings, node payloads, FTS5 rows and sqlite-vec rows. Node owns consent,
project identity, source eligibility, model policy and organizing jobs. Hy owns
organization. This package does not admit sources or promote candidates.

The overlay copies into an isolated backend build directory. It verifies the
upstream routing and dependency-injection hooks before changing files. Packaging
records the content digest as `memoryIndexOverlay` in the backend manifest.

The existing authenticated KB routes protect every operation. Reads use the
retrieve capability and the KB read grant. Writes use the ingest capability,
creator or admin checks and the KB write grant. Tenant and KB identifiers come
from the resolved grant. A payload field cannot select another tenant or KB.

Web, Electron, hosted mobile and Capacitor use their active backend through the
existing server transport. VS Code has no memory-index backend and retains the
server-owned capability's explicit unsupported behavior. PostgreSQL backends
return memory-index unavailability without preventing the rest of the backend
from starting.

## Invariants

- Every query includes tenant, KB and namespace predicates. Semantic queries
  also require a bound model space. Scope predicates apply before ranking and
  the result limit. Inactive nodes remain readable but cannot appear in search.
- State commits compare revisions and atomically persist JSON records and the
  receipt. Reusing the same key and request returns its original revision.
  Reusing the key for different content returns HTTP 409.
- A commit may include `index_operations`. Each operation uses `operation` with
  `nodes/upsert`, `nodes/delete` or `nodes/payload`, plus the corresponding node
  endpoint fields. Its namespace must match the ledger namespace or start with
  the ledger namespace followed by `:`. These operations, canonical records,
  the revision and receipt share one SQLite transaction. Vector generation
  finishes before this transaction begins. Any error rolls back the whole commit.
- Each standalone node mutation changes metadata, keyword and vector rows in
  one transaction. Node IDs remain stable within a namespace and space. A
  failed vector write cannot retain new metadata or keyword rows.
- Every writer reserves SQLite's writer lock before reading. The existing busy
  timeout waits for other backend writes. A stale snapshot cannot turn a CAS
  conflict into a misleading empty read.
- Soft or hard KB deletion removes its state, receipts, spaces, node metadata,
  FTS and vectors in the same SQLite transaction. Cleanup failure rolls back the
  KB deletion. Writers check that the KB remains active after reserving the
  writer lock. Startup also removes rows left by an already-deleted KB.
- Embedding calls use the authorized KB's configured model through the existing
  model service. An explicit different model ID is refused. Spaces bind the
  model identifier, name, normalized endpoint, provider, interface, dimensions,
  truncation, resolved catalog settings, routing overrides and processing version. A model
  configuration change observed during embedding rejects the result. Rotating credentials
  preserves a space. No credential is returned or stored in the identity.
- Embedding accepts `input_role` as `query` or `document`, defaulting to
  `document`. Query calls use the configured model's query input type, so
  asymmetric embedding models receive the proper query/document distinction.
- Node batches contain at most 256 items. A ledger commit contains at most
  16,384 mutations and 16,384 index operations, so an atomic import or withdrawal
  can exceed one node batch. Identifiers contain at most 512 ASCII characters.
  Ledger JSON values contain at most 16 MiB; node content and payloads contain
  at most 1 MiB each. HTTP bodies contain at most 64 MiB. Lists and searches return at
  most 256 rows. Vector norms must remain positive and finite at sqlite-vec's
  float32 precision. Arbitrary payload fields round-trip as JSON objects.
- Delete without IDs or filters explicitly clears the authorized namespace,
  optionally within a space. An explicit empty IDs array deletes no rows.
  Filters only narrow this scope. Payload patches shallowly merge object keys
  and retain explicit JSON nulls.
- Wiki, graph and document indexing strategies do not gate memory writes.
  All tables are additive and do not convert existing document records.

## Decisions

### Why a build overlay owns the backend changes

The backend is pinned and rebuilt as an existing product resource. A deterministic
overlay keeps the memory implementation reviewable in this repository and refuses
changed upstream hooks before applying it. The developer's cached source stays
outside tests; focused integration tests use a temporary copy.

### Why scoped cosine queries scan the eligible sqlite-vec rows

Node scope includes dynamic JSON payload fields. A SQL join applies the complete
scope before cosine ordering and LIMIT, so another project's closer vectors
cannot displace eligible results. The tradeoff is a distance calculation for each
eligible row. No query latency claim has been measured for large namespaces.

### Why lexical search can omit a model space

An unavailable embedding model must leave keyword lookup usable. The optional
`query` field on `/nodes/search` selects FTS5 and may omit `space_id`; semantic
search supplies `vector` and a bound space. These modes cannot be combined.
Every returned node includes its space ID. Callers deduplicate logical node IDs
when old and new spaces coexist during projection. Latin tokens and Han bigrams
use the same tokenization for writes and queries.

### Why state and indexes have both standalone and combined operations

Standalone index endpoints support bounded Hy adapters and readback. The
`index_operations` extension lets final source-authorized commits publish
canonical state and node indexes together. Nested Gorm savepoints reuse the outer
SQLite connection, so an index error rolls the entire commit back.

### Why capability detection remains KB scoped

Both GET and POST `/memory-index/capabilities` require the existing KB read grant.
A successful response confirms FTS5 initialization and identifies the available
contract; it does not grant access to another KB or namespace.
The optional `embedding_configuration_id` hashes the configured model settings
without a model call, credential or endpoint disclosure. Projection owners use
it to detect a changed model before deciding whether an existing vector is current.

### Why KB deletion uses SQLite triggers

KB deletion already changes the authoritative KB row in a SQLite transaction.
Triggers purge the memory rows and both indexes in that transaction, including
direct or hard deletion paths. A writer rechecks the KB under its reserved lock
so an earlier authorization grant cannot recreate memory after deletion.

## Focused validation

After applying the overlay to a temporary backend source copy:

```sh
go test -tags sqlite_fts5 ./internal/memoryindex
go test -tags sqlite_fts5 ./internal/router -run TestMemoryIndexRouteAuthorizationAndWikiIndependence
```

The repository also runs the overlay application fixture:

```sh
node --test packages/electron/scripts/embedded-knowledge-memory/apply.test.mjs
```

These tests exercise actual SQLite, sqlite-vec and FTS5. They do not prove packaged
Windows behavior or a real external provider call. Native packaging validation
belongs to the coordinator's final combined build.

## Offline embedding transport operator

The overlay also supplies `cmd/sw-embedding-transport`. Build it in the isolated
upstream source copy with `go build -tags sqlite_fts5 ./cmd/sw-embedding-transport`.
The normal application never launches this command. It adds no route, listener,
renderer capability or automatic migration. Web, mobile and VS Code retain their
existing behavior. The existing indexed-model guard stays active.

The command takes no arguments. One private stdin JSON request selects `snapshot`,
`preview`, `apply` or `verify`. Standard output contains one JSON response; errors
contain only `transport_migration_rejected` and exit nonzero. Keep snapshot output
in a private inherited pipe or a protected rehearsal artifact. It includes raw
memory content, payloads and base64 float32 vector bytes. Public preview contains
only native identities, counts, keyed credential fingerprints and state hashes.
Do not log requests, snapshots, SQL errors or target parameters.

`TransportRequest`, `TransportPreview` and `TransportSnapshot` in
`go/transport_migration.go` define the JSON contract. Requests identify an existing
absolute database path, runtime config directory, tenant, KB, creator and model.
`SYSTEM_AES_KEY` must contain exactly 32 bytes. Snapshot may omit target parameters
so the host can derive them with its owning model-parameter builder. Snapshot
redacts API key and app secret. Arbitrary custom headers and non-routing extra
settings are refused because they may contain unclassified credentials.

The operator supports the existing remote `text-embedding-v4` model at 1024
dimensions. It changes only `base_url`, `provider` and `api_key`, requiring an
HTTPS endpoint and provider `openai`. Every other parameter remains equal, and
unknown fields in the original stored JSON survive. Parameters are written as
a BLOB, matching the native serializer and its byte-only scanner. The raw CAS
compares bytes for both legacy TEXT and native BLOB rows; the frozen model digest
also records the original SQLite storage class. The model ID, name, source,
KB and tenant remain fixed. Builtin or managed models, a different creator,
inactive owner or another KB/document consumer of the model are refused.

`preview` returns both identities from the native `modelSpace` implementation.
The configuration ID is its second result at dimension 0. The vector space is
its first result at dimension 1024. The command pins the exact bytes consumed by
`ReadDeploymentOverlay`, including a configured `MODELS_CONFIG` override, and
loads those bytes directly. A DB catalog override is accepted only as the
initial singleton with version 0 and `{ "providers": {} }`; all its stored bytes
enter the state hashes. The coordinator pins the executable and built-in catalog
through its build receipt.

Read-only modes require an absent or empty WAL and use immutable SQLite reads.
A nonempty WAL is refused. Stop the owned processes and checkpoint before
preview/verify, or use a consistent SQLite backup. `mode=ro` alone can create
WAL/SHM sidecars. The immutable mode keeps database and directory bytes unchanged.
Apply opens an existing database in read/write mode and reserves the writer
before reading. It never calls `NewStore`, migrates schema or starts a container.
The host owns process detection, checkpointing and restoration. Native apply
requires the host's stopped-process evidence hash, restored-backup hash bound to
the exact preview digest, and accepted compatibility receipt hash.

The host evaluates source eligibility against one private raw snapshot and
supplies at most 256 exact selected node keys and raw marker mutations. Native
apply recomputes the complete ledger, old-space node set, model/KB/space state,
old Hy vectors/FTS and logical knowledge fingerprints under the writer lock.
This binds the host's eligibility decision to the same records and vectors used
for the write. A selection cannot supply replacement content or vector bytes.
The backend fetches those bytes from its own snapshot.

Only existing raw `entry/hy:*` engine rows for `model-space/current` and ready
`manual-index` markers can change. Only their nested `configurationId` and
`spaceId` fields may change. Existing optional dimensions remain absent when
absent; source hashes, unknown fields and all other values remain intact. Node
namespaces derive from the exact selected marker's project hash, with separate
core, cards and manual suffixes. Global manual markers do not require or create
a model-space binding. Any model-space migration journal is refused.

One transaction updates the encrypted model parameters, binds the target space,
copies vectors with the transaction-bound Store, publishes markers with ledger
revision CAS and writes the receipt. All old nodes and spaces remain, including
inactive nodes. Verification checks copied vector bytes, content, payloads,
activity, keyword rows and target binding. The complete knowledge fingerprint
streams the five metadata tables and actual vec0 rows, without accumulating the
corpus in memory or writing vector shadow tables. The coordinator separately
verifies the complete restored backup and physical knowledge-table fingerprints.

The receipt uses the existing `hy_memory_receipts` table and contains an
AES-keyed request HMAC, post-state digest and revision. An exact replay returns
`already-applied`; read-only `verify` returns `verified`. A changed request with
the same key or any post-state drift is rejected. No portable equivalence
certificate is created. The compatibility receipt records the operator's
explicit decision based on the accepted limited evidence.

### Why maintenance uses a separate command

Normal initialization creates tables and purges orphan memory rows. An offline
command can open a frozen database without initialization or provider calls,
while reusing the actual model identity, encrypted serializer and vector Store.
The host still owns source eligibility, backup/stop evidence, cross-store config
publication and recovery. This command commits only the SQLite part.

The reviewed account transport also persists the exact row override
`spec: { compat: { max_batch_size: 10 } }`. Only a nil prior spec or the same
post-migration spec is admitted by this operator. Any other override fails.
The raw encrypted parameter patch includes `spec`, and real Gorm reopen tests
verify its persistence. The pinned native protocol splitter is exercised with
11, 32 and 100 synthetic inputs against a local recording HTTP server. Partial
HTTP failure cannot publish a new memory space or advance the ledger.


### Why offline receipts bind the whole database

Paired full-file rollback can erase writes outside the migrated KB. The operator
therefore includes `fullDatabaseDigest` in preview and in the transaction-bound
post receipt, covering sqlite_schema, persisted header settings and all ordinary
and shadow table rows. Virtual tables are omitted because their raw shadow
storage is already included. Row IDs, SQLite storage types and raw text/blob
values remain distinct; DATETIME strings are not normalized by the driver.
Only the exact current operation's receipt row is excluded. Its insertion is
followed by another global digest check before commit. A subsequent unrelated
conversation, model, FTS or schema write invalidates verify and replay.

The command's apply/verify modes require a current parent-PID/token claim at
`<data-dir>/model-configuration.json.lock`. They retain a shared kernel lease
through database close. The lock-acquire/lock-release commands atomically manage
claims under an exclusive lease without opening SQLite. An orphaned native
transaction keeps recovery excluded after its parent exits. The command never
starts an application server. Other platforms return unsupported until their
kernel lease behavior has equivalent validation.
