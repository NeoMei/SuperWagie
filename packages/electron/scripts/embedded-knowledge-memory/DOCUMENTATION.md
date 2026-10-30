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
