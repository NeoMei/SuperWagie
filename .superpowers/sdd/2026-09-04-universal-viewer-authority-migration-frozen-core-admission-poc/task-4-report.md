# Task 4 Report: Narrow Read-Only SuperWagie Host Adapter

## Status and ruling

**Task 4 characterization: PASS. Frozen candidate admission: unchanged `NO_GO`.**

The SuperWagie-owned PoC adapter exposes a handle-only, read-only host surface and returns bounded data. This characterizes the host seam only. It does not erase the Task 3 module-graph result: the generated Office candidate still contains a `mountPptViewer` closure that statically reaches eight forbidden PDF write/save/file-pick references. It does not promote the frozen candidate, change a GVP receipt, modify the Format Admission Ledger, or authorize production Viewer implementation.

Rules applied: R-VP-02, R-VP-03, R-VP-05, R-VP-06, R-VP-10, R-VP-11; R-RI-10, R-RI-11; R-SE-09, R-SE-11, R-SE-12; R-QS-03, R-QS-05, R-QS-08.

## TDD evidence

### Initial RED

Command: `cd scripts/poc/universal-viewer && npm test`

- Exit: `1`.
- Existing tests: `45` passed.
- New suites: `2` failed with `ERR_MODULE_NOT_FOUND` for `host-adapter.mjs` and `resource-budget.mjs`.
- This was the intended failure: neither Task 4 implementation module existed.

### Initial focused GREEN

Command: `node --test tests/host-adapter.test.mjs tests/resource-budget.test.mjs`

- Exit: `0`.
- Result: `10/10` passed after the minimal adapter and resource budget were implemented.

### Self-review mutation RED/GREEN

Mutation: add `write_staging` to a handle that also contains `read`.

- RED: `node --test tests/host-adapter.test.mjs` exited `1`; `6/7` passed and the write-capable handle was incorrectly accepted.
- GREEN: handle verification now rejects every operation outside `read`, `range_read`, and `inspect`; the final focused suite passes `10/10`.

The mutation proves that “contains read” is not mistaken for “read-only.”

## Implemented boundary

- The adapter statically imports only generated `dist/viewer-base/viewer-base.mjs` and `dist/viewer-office/viewer-office.mjs` output. It does not import `.candidate/source` or any Obsidian adapter.
- The frozen base output supplies magic/container sniffing and probing. The frozen Office output supplies OOXML ZIP access, DOCX mounting, and PPTX parsing. The adapter never accepts or opens a document filesystem path.
- Input is exactly `{handle, bytes, descriptor_id, signal, limits}`. Unknown fields, including a caller path, fail before parsing.
- The JavaScript PoC performs no cryptography and accepts only `verification_state=verified_by_test_core`. Trusted test harness context binds worker audience, read operation, expected revision, and clock. Resource type, audience, operations, revision, expiry, declared byte length, and handle size limit are checked before parser dispatch.
- The enumerable adapter surface is exactly `open`, `readAll`, bounded `readRange`, `isCancelled`, `reportDiagnostic`, `createEphemeralAssetUrl`, and `revokeEphemeralAssetUrl`. It has no `save`, `write`, `pickFile`, `share`, `fetch`, `spawn`, `openExternal`, or `path` property.
- Parser input is a copied `Uint8Array`. Tests preserve and compare the original bytes after DOCX/PPTX success, cancellation, parser failure, and resource rejection.
- The fixed sequence is handle verification, magic/container sniff, PoC descriptor selection, OOXML inventory, budget enforcement, AbortSignal-aware parse, diagnostic normalization, strict state derivation, and ephemeral asset revocation.
- An unknown OOXML relationship emits scoped `VIEWER_OOXML_RELATIONSHIP_UNKNOWN` with `forces_partial=true`; a parsed file with that diagnostic returns `partial`, not `ready`.
- ZIP containers containing both Word and PowerPoint roots, unrecognized containers, descriptor mismatches, and zero-slide PPTX parser results do not become successful Office parses. Ambiguous containers record zero parser dispatches.
- Cancellation after media inventory revokes every request-created ephemeral asset URL before returning `cancelled`.
- Diagnostic, text, block, slide, and aggregate text arrays are bounded. Truncation emits visible `VIEWER_OUTPUT_TRUNCATED` and forces `partial` rather than silently dropping output.

## Resource budget

`resource-budget.mjs` freezes the Viewer design §9.4 ceilings for detection/input bytes, entry and total decompression, archive entries/depth/ratio, XML depth/nodes/text, image dimensions/pixels and animation frames, table rows/columns/cells, page/slide/sheet counts, first-content/absolute parse deadlines, worker RSS, and bounded output arrays.

Per-format or per-test limits may only lower those defaults. Every attempted increase, unknown limit, zero, negative, fractional, or unsafe-integer value fails closed. Per-axis image and table bounds are conservatively capped by their joint 100 MP and 50,000-cell ceilings; the joint ceilings remain authoritative.

## Evidence and unchanged admission state

- Frozen source commit: `ffdcda3eea83527380996ac935605f1422e43d3b`; `git status --porcelain` inside `.candidate/source` is empty.
- Task 3 tracked baseline remains `decision: NO_GO` with `forbidden_runtime_edges: 8`.
- Production `format-admission-ledger.json` remains unchanged; all records, including `office.docx.ooxml` and `office.pptx.ooxml`, remain `RESEARCH_REQUIRED`.
- No GVP receipt, production Registry, status document, source patch, generated Chunk, or baseline evidence artifact is changed by Task 4.

## Final verification

| Command | Exit | Result |
|---|---:|---|
| `cd scripts/poc/universal-viewer && npm test` | 0 | `55/55` passed, `0` failed |
| `node --test tests/host-adapter.test.mjs tests/resource-budget.test.mjs` | 0 | `10/10` passed, `0` failed |
| `node scripts/check-spec-refs.mjs` | 0 | rule anchors and matrix references passed |
| `git diff --check` | 0 | no whitespace errors |

Task 4 is complete as disposable characterization evidence. Candidate remediation or re-admission requires a separately reviewed change that removes the static forbidden Core reachability and reruns the applicable gates.
