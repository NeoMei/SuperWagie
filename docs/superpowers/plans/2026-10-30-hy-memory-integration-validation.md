# Hy integration validation

Date: 2026-10-30. Implementation is in the existing conversation-memory-release
checkout. No production memory or settings were migrated. Publication was
subsequently authorized for version 2.7.38. Both default platform builds pass
their native checks. Version 2.7.38 is published as GitHub Latest with 13
verified assets, and both official website servers are synchronized.

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
| Actual Python algorithms, Hybrid Reader and host adapters | 49 tests passed on the frozen product source |
| UI memory HTTP contract, panel and translations | 24 tests passed |
| Electron isolated suites | 63 test files passed |
| Overlay, staged resources and smoke argument/output checks | 13 tests passed |
| Native Go memory store and scoped router tests | Passed with sqlite-vec and FTS5 |
| Root type-check, lint and dead-code | Passed |
| Direct server lint and scoped anti-slop rules | Passed with no findings |
| Web production build | Passed; CSS optimization and large-chunk warnings remain |
| Electron main-process bundle | Passed |
| macOS ARM64 portable Python | Resource hashes, native imports and worker handshake passed |
| Windows x64 portable Python | Resource hashes, native imports and worker handshake passed |
| Windows native kernels and real worker protocol | 3 kernel environments and 3 S2 shutdown paths passed with exit code 0 on the frozen product source |
| Windows native Python suite and S1/S2 fixtures | 49 tests and both fixtures passed on frozen source 206ce08a93246eab565b0329071b78253959828f in run 41013168382 |
| Final Windows x64 installer and packaged-resource verification | Build, resource verification and artifact upload passed in workflow run 41013168382 |
| Published release assets | All 13 local sizes and SHA-256 digests match GitHub before and after publication |
| Public installers and update feeds | All 3 installer links return HTTP 200 with matching sizes; public feeds and evidence files match local bytes |
| Official website | 42 files, including 33 HTML files, match the built bytes over verified HTTPS; the custom error page correctly returns HTTP 404 |

The release Go binary was rebuilt through the normal preparation script from
the verified pinned source f5adb9eac166e7d3da7dceed7aa50049d4c4db1f with the
current overlay. Source licenses, Python dependencies and runtime archives
retain their pinned hashes.

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
latency. Clean-machine GUI/installer/updater acceptance, production data
migration and live OpenCode HTTP/source-event acceptance were not run. Final
Windows installer generation and packaged-resource verification passed.
Agent library actions were invoked through the real action adapter; the native
fixtures do not claim HTTP route acceptance. Worker graph operations retain
explicit 512-node and 300-read request limits and fail rather than report a
partial graph scan as complete.

## Release candidate 2.7.38

The release candidate adds the actual Hy HybridReadPipeline, including keyword/vector fusion, reverse schema evidence, evolution-chain latest selection and MMR. Separate normal/schema/behavior rank fusion retains methodology visibility within the final limit. Automatic cross-domain proposals outside the current batch become source-validated unverified candidates, or remain explicit pending/rejected diagnostics for later receipt reuse. Native S1 additionally asserts the actual Reader identity.

Release review repaired manual memory without embedding configuration, managed cleanup with document libraries disabled, more-than-256-ID retrieval partitions, and canonical card retirement when Hy supersedes a fact. Windows builds now compile the current memory overlay and verify native Hy before packaging.

Release verification includes UI 1104/1104 test files, VS Code 71/71 files,
Electron 63/63 files, and Web 569 passed files with 9 skips and 9553 passed
tests with 138 skips. These suites preceded the final Python lifecycle fixes;
the 49-test Python suite and commit checks passed after those fixes. Two old
workflow fixtures were synchronized with their actual report/persistence
completion without changing production code. The packaged macOS app started
with isolated data, returned backend health and loaded openchamber-ui://app.
The isolated HMR development launch also returned API health and loaded its
development page.

Startup checks used isolated profiles with OPENCHAMBER_ELECTRON_AUTO_START_HMR=1
for development and openchamber-ui://app for the packaged app. The final macOS
package contains 12 matching host modules, 6 matching Python modules, all 120
pinned vendor files and a verified 5307-file runtime. Both platform packages
share Hy source digest d27a9cd48cb965e0e6eb55fbfa0b9d7ebe602e0ee801615884488e59ad5f5075.

The first native Windows run found that the root data/ ignore rule excluded
9 pinned Hy data-adapter files from Git. The source tracking rule now retains
all 120 manifest files. A regression test verifies tracked membership and
byte hashes, while vendor attributes prevent Windows newline conversion.
The macOS package already contained all 120 matching files. The next native Windows run passed runtime imports and exposed an ANSI
stdout encoding failure during the first Chinese capture. The worker now uses
strict UTF-8 input/output, with a forced-cp1252 Chinese and emoji regression.
Coding fact replacements now also retain Reader-native version fields, and
read-only adapters hydrate earlier version records within the source-authorized
pool. The real replacement regression uses old wording to recall the current
fact and rejects a revoked old-source anchor.

The Windows capture diagnostic showed 2 generation calls, a completed job,
empty cards and no worker/host error. Hy had caught local record serialization
exceptions. Source memory epochs now use aware UTC in chat/coding and numeric
replay, including epoch 0. The adapter records a stable serialization failure
in the request failure set, so upstream catches cannot commit success-empty.
Tests preserve the original 100 ms source epoch and discard all staged writes
after a simulated serialization failure. The Windows workflow runs the full
Python suite and both native fixtures before building the frontend.

Windows S2 then exposed a native-library import deadlock while the background
thread read piped stdin. A bounded stack probe located the main thread inside
NumPy's native import. The worker now loads NumPy and the required sklearn
clustering/pairwise modules before starting that reader. Hy's algorithms and
thread settings remain unchanged. A separate close/EOF control reproduced a
Python buffered-stdin shutdown failure; waiting up to 1 second for the reader
fixes that race. The delayed-EOF protocol regression failed before the fix and
passes afterward.

The frozen product source is 206ce08a93246eab565b0329071b78253959828f. Its local
Python suite passes all 49 tests, and both native macOS fixtures pass with the
staged worker and interpreter. [Windows probe run 41013154926](https://github.com/NeoMei/SuperWagie-Open/actions/runs/41013154926)
passes all 3 kernel environments and the normal-close, EOF-only and joined-reader
S2 paths with exit code 0. The normal-close and EOF-only paths emit no stderr.

[Windows build run 41012141661](https://github.com/NeoMei/SuperWagie-Open/actions/runs/41012141661)
passed the 48-test Python suite and both full native fixtures on the preceding
603499b7d5bef87e7821326624a58c57c3357d8c source. It was canceled during the
frontend build to include the reader shutdown fix before installer packaging.
The frozen-source Windows build passes all 49 Python tests and both native
S1/S2 fixtures in [run 41013168382](https://github.com/NeoMei/SuperWagie-Open/actions/runs/41013168382).
The same run passes Windows installer generation, packaged-resource verification
and artifact upload.

[Release 2.7.38](https://github.com/NeoMei/SuperWagie-Open/releases/tag/v2.7.38)
was published at 2026-10-30T07:39:50Z and is GitHub Latest. The tag resolves to
the frozen product source. The default installers are macOS ARM64 and Windows
x64; optional architecture releases are unchanged. The macOS ARM64 and Windows
x64 update feeds contain 2.7.38, while the retired architecture-blind Windows feed
retains its earlier version. Public update feeds, checksums and build/resource
receipts match the uploaded bytes. Both website servers retain pre-deployment
archives and preserve existing downloads and ownership verification files.
The Chinese and English download pages show the released version and actual
installer sizes. All 42 built website files match public HTTPS readback.
