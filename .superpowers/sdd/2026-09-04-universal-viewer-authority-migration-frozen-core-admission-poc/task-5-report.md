# Task 5 report — malicious-input and offline-independence baseline

## Decision

**Individual corpus behavior: PASS. Frozen candidate admission: unchanged `NO_GO`.**

The six immutable, locally generated fixtures produce their expected safe outcomes with zero network attempts, zero **observed** external Viewer-child processes, zero created paths, zero path disclosure, and zero source mutation. The hard-deadline probe kills the isolated worker process group, waits for the worker to be reaped, and leaves no surviving member of that group or known observed descendant. The macOS sampling limits are explicit below; this report does not claim proof for a process that both detaches and exits between snapshots before it is first observed.

This does not satisfy aggregate admission. `acceptance.json` correctly requires `forbidden_runtime_edges: 0`; the unchanged Task 3 evidence still records `forbidden_runtime_edges: 8`. Therefore the evidence JSON intentionally reports:

```json
{
  "execution_pass": true,
  "behavior": { "pass": true, "status": "passed" },
  "pass": false,
  "status": "failed",
  "decision": "NO_GO"
}
```

Rules applied: R-VP-03, R-VP-06, R-VP-10, R-VP-11; R-RI-11; R-SE-07, R-SE-12; R-QS-03, R-QS-08.

## TDD evidence

### Initial RED

Command: `node --test tests/malicious-corpus.test.mjs`

- Exit: `1`.
- Failure: `ERR_MODULE_NOT_FOUND` for `malicious-corpus.mjs`.
- Reason: the Task 5 behavior implementation did not exist.

### First implementation cycle

The first focused implementation run passed 5/7 tests. Two failures exposed real harness issues:

1. persisted JSON omitted `undefined` optional fields, so the returned and persisted evidence were not byte-semantically equivalent;
2. macOS `/bin/ps` may report `/bin/sh` as the underlying `bash` image depending on sampling time.

The runner now omits absent optional fields before serialization and normalizes the parenthesized macOS process form. Both `sh` and `bash` are prohibited, and any unexpected descendant process fails regardless of classification.

### Network-hook mutation RED/GREEN

The hook table was expanded to fetch, XHR, WebSocket, DNS, socket, asset-object URL, and their JSDOM window equivalents. A first test iteration failed because the worker echoed the requested hook instead of proving which guard fired. The guard now records the observed API at the interception point, and the test requires `observed_hook` to equal each requested hook.

### Full-suite process-name correction

The first full run was 74/75. The only failure required the literal basename `sh`, while macOS reported the same `/bin/sh` process as `bash`. The assertion was corrected to the real platform contract (`sh` or `bash`), without weakening the classifier or the zero-descendant admission rule.

### Evidence-output boundary RED/GREEN

A final mutation placed the evidence output under a copied fixture source tree. RED showed that the run could write there after computing its source-mutation metric. The runner then rejected direct outputs inside either candidate or fixture source tree, and rejected a direct acceptance overwrite before reading or spawning a fixture worker.

### Security review fix round 1 RED/GREEN

The first security review rejected the initial implementation on four concrete boundaries. Seven adversarial behaviors failed against commit `5583d9a` for the intended reasons:

1. raw `nested/../acceptance.json`, a directory symlink into the fixture tree, and an acceptance hardlink bypassed the lexical output check; the same boundary also lacked an ownership token for intentional evidence replacement;
2. `<style>` CSS, `srcset`, and SVG paint/filter/clip/mask/marker URL variants survived sanitization, including case, entity, and whitespace variations;
3. an empty or dirty spoofed candidate with copied receipt data could still be reported as commit `ffdcda3...` because the runner copied the identity from Task 3 evidence instead of verifying it;
4. the supervisor did not support a short-lived descendant or a detached survivor probe and only followed PPID rows.

GREEN adds canonical `realpath` containment, source inode comparisons, symlink/hardlink rejection, an explicit ownership sidecar, and same-directory atomic rename. All overlap decisions complete before a provenance verifier or fixture worker may spawn. The candidate is checked with the existing authoritative `source-lock.json` plus acquisition-receipt verifier before work, after work, and after evidence persistence. Source-tree hashes are recomputed after the atomic evidence rename; a successful return is impossible without that recheck.

The sanitizer now fails closed: active/style/animation containers and all URL-bearing attributes are removed, inline styles are removed, SVG resource attributes are removed, and SVG paint values must match a conservative literal allowlist. The adversarial outputs contain no remote/executable scheme, `@import`, `url(...)`, `srcset`, or SVG resource attribute while retaining safe visible text.

The process supervisor now creates a detached worker process group, takes explicit pre-spawn, event-triggered, continuous, pre-release/timeout, post-exit, and cleanup `/bin/ps -axo pid=,ppid=,pgid=,comm=` snapshots, and retains first non-zombie executable identity. Cleanup signals the worker group plus every observed escaped descendant PID/process group after either timeout or a normal result, waits for the worker exit, and verifies zero original-group and known-descendant survivors. A real 80 ms `/bin/sleep` descendant is observed and rejected; real detached Node survivors are observed, killed, and absent afterward in both timeout and normal-result probes.

The required post-patch bypass review produced one additional RED: an observed detached child left after a normal worker `ready` result was rejected but remained alive because cleanup was timeout-only. Moving known-descendant/group cleanup onto both terminal paths made that probe GREEN without weakening the rejection rule.

An offline concurrent full-suite run also showed that a 250 ms detached-survivor probe could time out before the adversarial worker had executed far enough to create its child. That test setup was corrected to 1000 ms so it must exercise a real detached descendant under suite load. The separate hung-parser test continues to enforce the 150 ms focused / 250 ms corpus startup-inclusive hard deadline; no production deadline was relaxed.

### Security review fix round 2 RED/GREEN

The second review supplied this exact bypass payload: `<template><style>@import url(https://evil.invalid/x.css)</style><img srcset="https://evil.invalid/a.png 1x" onload="alert(1)"></template>`. RED returned `removed_count: 0` because a document-wide selector does not enter an HTML template's inert `DocumentFragment`; the remote stylesheet syntax, `srcset`, and event handler all survived. A second RED nested templates three levels deep and combined sibling active elements, CSS URL syntax, event attributes, SVG paint/resource attributes, and case/entity/whitespace variants. It also returned `removed_count: 0`.

GREEN replaces that selector with recursive, snapshot-based container traversal. It starts at the `Document`, snapshots each container's element children before mutation, traverses ordinary element children, and explicitly traverses every HTML `template.content` `DocumentFragment`, including nested templates. Snapshotting prevents removal of one active sibling from skipping the next. The exact reviewer payload now reports `diagnostic: VIEWER_ACTIVE_CONTENT_REMOVED` and `removed_count: 3`; the nested case reports at least 14 removals, retains both safe text nodes, and serializes with no remote URL, active CSS syntax, URL-bearing/event attribute, or unsafe SVG resource attribute.

## Implemented behavior

- `malicious-corpus.mjs` requires absolute candidate, fixture, acceptance, and output paths plus `--offline`; the output parent must already exist.
- Output and source paths are normalized and canonicalized. Existing output inodes are compared with the candidate, fixture, and acceptance sources so hardlinks cannot bypass containment. Existing output is accepted only with the exact PoC ownership sidecar; evidence is written to a new same-directory temporary file and atomically renamed.
- The candidate must pass the existing Frozen Core acquisition verifier against the authoritative source-lock bytes and receipt. Commit, Git tree, archive hash, materialized-tree hash, pristine status, and Task 3 candidate identity are bound into the evidence from the verified receipt, not copied as an unchecked claim.
- For the network-acquired candidate, that verifier runs local Git identity/archive commands as a control-plane preflight and postflight. Those local processes do not enter a Viewer worker tree and perform no network acquisition; the zero-external-process metric is explicitly scoped to each isolated Viewer worker process group.
- Every fixture runs in a separate expected Node worker with a hard wall-clock supervisor deadline.
- On macOS, the parent uses explicit `/bin/ps -axo pid=,ppid=,pgid=,comm=` sampling. Raw PIDs, process-group IDs, command lines, executable paths, fixture paths, and arguments never enter evidence. Only normalized executable basename and SHA-256 identity are retained.
- The expected Node worker is the isolated process-group root. Every observed group member or descendant counts as an external process and fails the fixture. WPS/Office/LibreOffice/`soffice`/WpsComposer, shells, and archive tools are separately labeled forbidden.
- The worker uses the same Task 4 host adapter and frozen `viewer-base`/`viewer-office` outputs for the OOXML fixtures. The frozen candidate source is not patched.
- Offline guards synchronously reject fetch, XHR, WebSocket/EventSource, DNS, TCP/TLS/UDP, HTTP(S), and object URL attempts in both Node global and JSDOM window surfaces.
- ZIP path names and compressed/uncompressed sizes are read directly from the central directory. Traversal is rejected without extraction; the bounded 2 MiB zero fixture exceeds 100:1 and is rejected with `expanded_bytes: 0` before JSZip/parser dispatch.
- HTML/SVG are parsed with script execution and resource loading disabled, then passed through a fail-closed element/attribute policy that recursively enters HTML template `DocumentFragment`s, removes styles and all executable/remote resource-bearing forms, and retains safe visible text.
- The external OOXML relationship is detected as scoped `partial`; no request occurs. The container with both Word and PowerPoint roots returns `unsupported` with zero parser dispatches.
- Candidate and fixture trees are hashed before work, after workers, and after the final atomic evidence rename. Each result is keyed by the immutable fixture SHA-256 from `acceptance.json`.

## Deterministic fixtures

The authoring-only JSZip generator fixed lexical entry order, the ZIP timestamp, platform, and compression settings, then was deleted. No malware or proprietary input was downloaded. Exact recipes, hashes, diagnoses, and harmless-payload rationale are recorded in `fixtures/gvp-0/GVP-0-CORE-001/README.md`.

## Baseline result

The final macOS run records:

| Metric | Required | Observed |
|---|---:|---:|
| external processes | 0 | 0 |
| network requests | 0 | 0 |
| filesystem paths exposed | 0 | 0 |
| source mutations | 0 | 0 |
| moderate-or-higher reachable vulnerabilities | 0 | 0 |
| forbidden runtime edges | 0 | **8** |
| unexpected fixture outcomes | 0 | 0 |
| base + Office compressed bytes | <= 20,971,520 | 200,588 |
| all chunks compressed bytes | <= 52,428,800 | 200,588 |

All six individual fixture results pass. The deadline probe records `timed_out: true`, `killed: true`, `child_alive_after_kill: false`, zero original-process-group survivors, and zero known-descendant survivors.

Process evidence is scoped to the isolated group and descendants actually observed by macOS `/bin/ps`. Snapshotting cannot prove the absence of a process that spawns, detaches, and exits entirely between snapshots, nor can group cleanup name a descendant that detached before its first observation. These limits are emitted in every process-tree record. The synchronized adversarial probes establish that the harness detects an 80 ms child and an observed detached survivor; they do not erase the platform limitation.

## CLI semantics

The corpus CLI exits zero when evidence collection completed and behavior passed, even though aggregate admission remains non-passing. Its summary is:

```json
{"execution_pass":true,"behavior_pass":true,"aggregate_pass":false,"decision":"NO_GO","forbidden_runtime_edges":8}
```

The plan's aggregate assertion:

```bash
node -e "const r=require('./audit/malicious-corpus.json'); if(!r.pass) process.exit(1)"
```

exits `1` as required by the corrected Task 5 ruling. A zero exit here would falsely claim that the frozen candidate met the `forbidden_runtime_edges: 0` threshold.

## Unchanged authority and source state

- Frozen candidate commit: `ffdcda3eea83527380996ac935605f1422e43d3b`.
- Task 3 admission evidence remains `decision: NO_GO`, `forbidden_runtime_edges: 8`.
- `patch-ledger.json` remains unchanged at SHA-256 `7c13a791a8cf1c58263d5c4c3b84ba8a899c1042177c7b311c98bb5b99bc265f` with zero patches.
- Production `format-admission-ledger.json` remains unchanged at SHA-256 `45dbac3e7160828f1221f318f7230bc703e7743d71b54b3227665160037d8c38`; formats remain `RESEARCH_REQUIRED`.
- `.candidate/source` has no Git status changes.

## Verification

| Command | Exit | Result |
|---|---:|---|
| `node --test tests/malicious-corpus.test.mjs` | 0 | 20/20 passed |
| earlier online `npm test` | 1 | 85/86; unrelated candidate audit transport returned registry 503, then network timeout |
| `npm_config_offline=true npm test` | 0 | 88/88 passed using the complete npm audit cache |
| `node malicious-corpus.mjs ... --offline ...` | 0 | execution/behavior pass; aggregate `NO_GO / 8` |
| aggregate `if (!r.pass) process.exit(1)` assertion | 1 | expected proof that admission is non-passing |
| `node scripts/check-spec-refs.mjs` | 0 | rule/spec references pass |
| `git diff --check` | 0 | no whitespace errors |

The earlier default full-suite command was attempted twice after fix round 1. In both runs all then-current 18 Task 5 tests passed; the only failure was the existing Office closure test because the candidate `npm audit` endpoint first returned `503 Service Unavailable` and then timed out without metadata. A direct retry of `npm audit --omit=dev --json` succeeded with complete metadata and zero vulnerabilities. The same complete audit response remains available from npm's offline cache, and `npm_config_offline=true npm test` executed the fix-round-2 final tree's full build, both dependency-audit parsers, Office closure, and all 88 tests successfully. No production or test code was weakened to accept missing audit metadata, and the external registry gate was not retried for this sanitizer-only fix.

This is macOS behavior and process-tree evidence only. Windows PowerShell CIM collection remains a later platform handoff. Task 5 does not issue a GVP-3 receipt, change the Format Admission Ledger, or authorize production Viewer work.

## Final whole-branch Windows boundary addendum

The handoff no longer presents the current POSIX-only malicious runner as runnable Windows GVP-0 evidence. A Windows CIM descendant collector plus Job Object ownership, group termination, survivor verification, automated tests, and real-machine evidence are a prerequisite blocker before the exact public command may count. The manual CIM query is explicitly diagnostic only. Windows remains missing; no fake Windows support, receipt, GVP state, format promotion, or production authority was added.
