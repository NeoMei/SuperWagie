# Task 5 report — malicious-input and offline-independence baseline

## Decision

**Individual corpus behavior: PASS. Frozen candidate admission: unchanged `NO_GO`.**

The six immutable, locally generated fixtures produce their expected safe outcomes with zero network attempts, zero external Viewer-child processes, zero created paths, zero path disclosure, and zero source mutation. The hard-deadline probe kills its hung parser child and leaves no live child.

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

A final mutation placed the evidence output under a copied fixture source tree. RED showed that the run could write there after computing its source-mutation metric. The runner now rejects outputs inside either candidate or fixture source tree, and rejects overwriting the acceptance manifest, before reading or spawning any fixture worker. The focused mutation test then passed and confirmed the copied fixture directory stayed unchanged.

## Implemented behavior

- `malicious-corpus.mjs` requires absolute candidate, fixture, acceptance, and output paths plus `--offline`.
- Every fixture runs in a separate expected Node worker with a hard wall-clock supervisor deadline.
- On macOS, the parent uses explicit `/bin/ps -axo pid=,ppid=,comm=` sampling. Raw PIDs, command lines, executable paths, fixture paths, and arguments never enter evidence. Only normalized executable basename and SHA-256 identity are retained.
- The expected Node worker is the process-tree root. Every descendant counts as an external process and fails the fixture. WPS/Office/LibreOffice/`soffice`/WpsComposer, shells, and archive tools are separately labeled forbidden.
- The worker uses the same Task 4 host adapter and frozen `viewer-base`/`viewer-office` outputs for the OOXML fixtures. The frozen candidate source is not patched.
- Offline guards synchronously reject fetch, XHR, WebSocket/EventSource, DNS, TCP/TLS/UDP, HTTP(S), and object URL attempts in both Node global and JSDOM window surfaces.
- ZIP path names and compressed/uncompressed sizes are read directly from the central directory. Traversal is rejected without extraction; the bounded 2 MiB zero fixture exceeds 100:1 and is rejected with `expanded_bytes: 0` before JSZip/parser dispatch.
- HTML/SVG are parsed with script execution and resource loading disabled, then stripped of active elements, event/srcdoc attributes, executable/remote URLs, and URL-bearing style content. Safe visible text is retained.
- The external OOXML relationship is detected as scoped `partial`; no request occurs. The container with both Word and PowerPoint roots returns `unsupported` with zero parser dispatches.
- Candidate and fixture trees are hashed before and after the run. Each result is keyed by the immutable fixture SHA-256 from `acceptance.json`.

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

All six individual fixture results pass. The deadline probe records `timed_out: true`, `killed: true`, and `child_alive_after_kill: false`.

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
| `node --test tests/malicious-corpus.test.mjs` | 0 | 8/8 passed |
| `npm test` | 0 | 76/76 passed |
| `node malicious-corpus.mjs ... --offline ...` | 0 | execution/behavior pass; aggregate `NO_GO / 8` |
| aggregate `if (!r.pass) process.exit(1)` assertion | 1 | expected proof that admission is non-passing |
| `node scripts/check-spec-refs.mjs` | 0 | rule/spec references pass |
| `git diff --check` | 0 | no whitespace errors |

This is macOS behavior and process-tree evidence only. Windows PowerShell CIM collection remains a later platform handoff. Task 5 does not issue a GVP-3 receipt, change the Format Admission Ledger, or authorize production Viewer work.
