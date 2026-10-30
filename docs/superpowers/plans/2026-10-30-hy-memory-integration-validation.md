# Hy integration validation

Date: 2026-10-30. Implementation is in the existing conversation-memory-release
checkout. No production memory or settings were migrated. No commit, push,
installer publication or updater change forms part of this task.

## Implemented behavior

- Pinned Hy 2.0.8 source executes chat/coding extraction, reconciliation, fact
  revisions, linked history, S2 clustering and schema tools, review continuation
  and cross-domain behavior abstraction. Recall executes the upstream Hy
  HybridReadPipeline with BM25/semantic fusion, graph evidence, evolution latest
  selection and diversity/MMR. Standalone storage services, optional local
  cross-encoder and generated-episode features remain disabled.
- Node owns source consent, exact provenance, policy, model dispatch, durable
  work and candidate eligibility. Python receives no credentials or file access
  tool. Provider requests go through the configured host model services.
- The existing embedded Go service owns canonical memory state, sqlite-vec and
  FTS5. Manual records, source-linked cards and Hy nodes share this service with
  document knowledge under typed namespaces. AnyDoc and CodeGraph retain their
  document/code authority.
- Old completed extraction can recover indexing without another generation.
  Unknown paid outcomes stay unknown. Bounded retries, generated receipts and
  migration cursors survive restart. Source withdrawal and forget revoke
  eligibility before cleanup, including late-output and retrieval races.
- Model changes copy vectors while retaining the old complete space, then
  atomically swap bindings. Changed method proposals lose their earlier
  confirmation and vector until confirmed again.
- Document-library disablement stops document activity while memory demand can
  retain the same owned local backend. Existing feature switches remain in force.

## Verification

| Check | Result |
| --- | --- |
| Related web suites: knowledge-library, embedded-knowledge, openchamber-control, agent-tool runtime, agent-memory, conversation-memory and hy-memory | 51 files, 713 tests passed |
| Actual Python algorithms, Hybrid Reader and host adapters | 43 tests passed |
| UI memory HTTP contract, panel and translations | 24 tests passed |
| Electron isolated suites | 63 test files passed |
| Overlay, staged resources and smoke argument/output checks | 13 tests passed |
| Native Go memory store and scoped router tests | Passed with sqlite-vec and FTS5 |
| Root type-check, lint and dead-code | Passed |
| Direct server lint and scoped anti-slop rules | Passed with no findings |
| Web production build | Passed; CSS optimization and large-chunk warnings remain |
| Electron main-process bundle | Passed |
| macOS ARM64 portable Python | Resource hashes, native imports and worker handshake passed |
| Windows x64 portable Python | Resource hashes and target checks passed; native execution not run |

The Go binary was rebuilt from an isolated copy of the existing pinned backend
cache with the recorded local overlay. Its staged manifest records that local
source provenance and the absence of a new Git verification command. Source
licenses, Python dependencies and runtime archives retain their pinned hashes.

## Real backend fixtures

The reproducible commands and their explicit executable arguments are documented
in `packages/web/scripts/hy-memory-smoke.md`. Both fixtures start isolated local
databases, a real Go backend and the actual bundled Python Hy worker. Embedding
vectors and generation responses are synthetic.

The single-session fixture verifies capture, exact history links, candidate
inspection, confirmation, agent library search/read, recall, model configuration
migration, old-vector removal, sibling preservation and complete source cleanup.
It enables Wiki on the fixture KB and reads that setting back. Confirmation,
model migration and deletion keep the generation count at 2.

The two-session fixture exercises automatic real System2 schema creation,
behavior representation and continuation. An injected projection failure leaves
the generated receipt durable. Restart commits that receipt without another
generation call. A second actual review batch exhausts the continuation. The
method becomes eligible after separate confirmation. Counts are 4 capture,
2 System2 and 1 behavior-abstraction generation calls.

Both fixtures also passed with `OPENCHAMBER_HY_MEMORY_WORKER_SCRIPT` pointing
at the final staged resource script and the staged macOS ARM64 interpreter.
The staged backend cache verifier accepts the built executable and current
overlay, and both Python target resource manifests pass integrity verification.

## Evidence limits

These checks do not measure external provider extraction quality or large-bank
latency. Native Windows execution, GUI/installer/updater acceptance, production
data migration and live OpenCode HTTP/source-event acceptance were not run.
Agent library actions were invoked through the real action adapter; the native
fixtures do not claim HTTP route acceptance. Worker graph operations retain
explicit 512-node and 300-read request limits and fail rather than report a
partial graph scan as complete.

## Release candidate 2.7.38

The release candidate adds the actual Hy HybridReadPipeline, including keyword/vector fusion, reverse schema evidence, evolution-chain latest selection and MMR. Separate normal/schema/behavior rank fusion retains methodology visibility within the final limit. Automatic cross-domain proposals outside the current batch become source-validated unverified candidates, or remain explicit pending/rejected diagnostics for later receipt reuse. Native S1 additionally asserts the actual Reader identity.

Release review repaired manual memory without embedding configuration, managed cleanup with document libraries disabled, more-than-256-ID retrieval partitions, and canonical card retirement when Hy supersedes a fact. Windows builds now compile the current memory overlay and verify native Hy before packaging.
