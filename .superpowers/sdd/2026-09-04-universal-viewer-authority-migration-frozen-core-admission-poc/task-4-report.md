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

### Independent-review fix round 1 RED/GREEN

The review round added directed regressions before implementation. Initial focused RED was `6/14` passed and `8` failed: missing/malformed `range_limit_bytes` was accepted; DOCX did not receive its `AbortSignal` or limits; cancellation during PPTX dispatch could become `ready`; tightened archive/XML/page/slide/sheet/table/image/animation limits were not all observed; output extraction expanded attacker-sized arrays/objects; the OOXML inventory only recognized relationship classes; and the resource-limit enforcement classification did not exist.

After the fixes, the focused suite is `18/18` green. It now includes:

- mutation tests lowering every declared limit, plus direct pre-parser rejection probes for adapter-enforceable archive, XML, page/slide/sheet, table, image, and animation limits;
- exact DOCX and PPTX Core-option capture proving signal and applicable tightened limits are forwarded;
- both abort shapes during PPTX dispatch: Core throws `AbortError`, or Core resolves after the signal becomes aborted; both return `cancelled` and revoke every request asset;
- hostile `Proxy` arrays and model objects that fail if extraction iterates beyond the bound or calls arbitrary object enumeration;
- an OOXML vendor-widget fixture covering unknown part, content type, namespace, relationship, drawing, embedding, macro, external link/relationship, font, theme/master, protection, and unverifiable image metadata; every emitted feature diagnostic is scoped and forces `partial`;
- missing, zero, fractional, and unsafe `range_limit_bytes` mutations, all rejected with zero parser dispatches.

### Independent-review fix round 2 RED/GREEN

The second review round added three real-package regressions before implementation. Focused RED was `18/22` passed and `4` failed: two logical `p:sldId` records reusing one physical slide became `partial` instead of a slide-limit result; the real DOCX `mc:AlternateContent` chart fallback was `partial` but its Core diagnostic disappeared; an attacker-sized Core diagnostic array was not transferred or visibly bounded; and standard package core-properties plus standard slide master/layout declarations were incorrectly forced to `partial`.

Focused GREEN is `23/23`. It proves:

- `max_slides` counts logical `p:sldId` references from `ppt/presentation.xml` before dispatch, independently of physical slide-part count; a second guard still returns `too_large` if Core produces more slides than the limit. Removing that post-parse guard was mutation-tested and reproduced the wrong `partial` result before restoration;
- DOCX `status.diagnostics` transfer is incremental and bounded. Core `location` is converted to a sanitized scope capped at 160 characters, and diagnostics accompanying Core `partial` are marked `forces_partial=true`;
- a generated DOCX containing real chart `mc:AlternateContent` exposes `VIEWER_CHART_FALLBACK_USED`, its `word/document.xml` scope, the visible fallback text, and `partial` state;
- exact standard OOXML declarations for package core properties and presentation slide master/layout relationships, namespaces, parts, and content types are accepted; content-type value comparison is ASCII case-insensitive. The allowlist remains exact, so vendor/unknown values still force `partial`.

## Implemented boundary

- The adapter statically imports only generated `dist/viewer-base/viewer-base.mjs` and `dist/viewer-office/viewer-office.mjs` output. It does not import `.candidate/source` or any Obsidian adapter.
- The frozen base output supplies magic/container sniffing and probing. The frozen Office output supplies OOXML ZIP access, DOCX mounting, and PPTX parsing. The adapter never accepts or opens a document filesystem path.
- Input is exactly `{handle, bytes, descriptor_id, signal, limits}`. Unknown fields, including a caller path, fail before parsing.
- The JavaScript PoC performs no cryptography and accepts only `verification_state=verified_by_test_core`. Trusted test harness context binds worker audience, read operation, expected revision, and clock. Resource type, audience, operations, revision, expiry, declared byte length, handle size limit, and a positive safe-integer range-read limit are checked before any read or parser dispatch.
- The enumerable adapter surface is exactly `open`, `readAll`, bounded `readRange`, `isCancelled`, `reportDiagnostic`, `createEphemeralAssetUrl`, and `revokeEphemeralAssetUrl`. It has no `save`, `write`, `pickFile`, `share`, `fetch`, `spawn`, `openExternal`, or `path` property.
- Parser input is a copied `Uint8Array`. Tests preserve and compare the original bytes after DOCX/PPTX success, cancellation, parser failure, and resource rejection.
- The fixed sequence is handle verification, magic/container sniff, PoC descriptor selection, OOXML inventory, budget enforcement, AbortSignal-aware parse, diagnostic normalization, strict state derivation, and ephemeral asset revocation. DOCX receives the same signal plus the Core-supported input, decompression, page, image-byte, and embedded-file limits. PPTX receives the signal plus input, entry, decompression, and cooperative parse-deadline limits.
- OOXML inventory is deliberately conservative rather than a claim of complete OOXML semantics. Known standard package metadata and slide master/layout declarations are accepted exactly. Unknown parts, content types, namespaces, relationships, DrawingML URIs, embeddings, macros, external links/relationships, fonts, themes, protection, and image metadata that this PoC cannot verify emit scoped `forces_partial=true` diagnostics. Such a parsed file cannot become `ready`.
- ZIP containers containing both Word and PowerPoint roots, unrecognized containers, descriptor mismatches, and zero-slide PPTX parser results do not become successful Office parses. Ambiguous containers record zero parser dispatches.
- Cancellation after media inventory revokes every request-created ephemeral asset URL before returning `cancelled`.
- Diagnostic, text, block, slide, aggregate-text, and model traversal are bounded incrementally. Extraction no longer uses attacker-sized `map`, `flatMap`, spread expansion, or `Object.values`; it stops before retrieving work beyond the configured bound. Truncation emits visible `VIEWER_OUTPUT_TRUNCATED` and forces `partial` rather than silently dropping output.

## Resource budget

`resource-budget.mjs` freezes the Viewer design §9.4 ceilings used by this characterization for detection/input bytes, entry and total decompression, archive entries/depth/ratio, XML depth/nodes/text, image dimensions/pixels and animation frames, table rows/columns/cells, page/slide/sheet counts, first-content/parse deadlines, worker RSS, and bounded output arrays.

Per-format or per-test limits may only lower those defaults. Every attempted increase, unknown limit, zero, negative, fractional, or unsafe-integer value fails closed. Per-axis image and table bounds are conservatively capped by their joint 100 MP and 50,000-cell ceilings; the joint ceilings remain authoritative.

The enforcement classification is explicit and intentionally does not claim that constants alone create a production hard limit:

| Class | Limits | What this PoC proves |
|---|---|---|
| `adapter` | byte/count/depth/ratio/XML/page/slide/sheet/image/table/output bounds | the adapter checks observed values and/or stops its own traversal before parser dispatch or output expansion |
| `core_cooperative_supervisor_hard_limit` | `parse_deadline_ms` | PPTX receives the cooperative Core limit; a future worker supervisor must supply the hard wall-clock termination |
| `supervisor_only` | `first_content_deadline_ms`, `max_worker_rss_bytes` | constants and validation exist, but the in-process adapter does not claim to enforce elapsed time or RSS |

The generated archive API used here returns a materialized entry before the adapter can count its bytes. Therefore the PoC's entry and cumulative decompression checks are post-entry observations, not the stream/inflate-time hard enforcement required by Viewer design §9.4 and GVP-3. Likewise, page counting is a conservative OOXML preflight plus the DOCX Core limit, not full layout pagination. These are explicit future admission gaps, not `GO` evidence.

## Evidence and unchanged admission state

- Frozen source commit: `ffdcda3eea83527380996ac935605f1422e43d3b`; `git status --porcelain` inside `.candidate/source` is empty.
- Task 3 tracked baseline remains `decision: NO_GO` with `forbidden_runtime_edges: 8`.
- Production `format-admission-ledger.json` remains unchanged; all records, including `office.docx.ooxml` and `office.pptx.ooxml`, remain `RESEARCH_REQUIRED`.
- No GVP receipt, production Registry, status document, source patch, generated Chunk, or baseline evidence artifact is changed by Task 4.

## Final verification

| Command | Exit | Result |
|---|---:|---|
| `cd scripts/poc/universal-viewer && npm test` | 0 | `68/68` passed, `0` failed |
| `node --test tests/host-adapter.test.mjs tests/resource-budget.test.mjs` | 0 | `23/23` passed, `0` failed |
| `node scripts/check-spec-refs.mjs` | 0 | rule anchors and matrix references passed |
| `git diff --check` | 0 | no whitespace errors |

Task 4 is complete as disposable characterization evidence. Candidate remediation or re-admission requires a separately reviewed change that removes the static forbidden Core reachability and reruns the applicable gates.

## Final whole-branch review fix — OOXML and concurrent diagnostics

OOXML admission now compares complete relationship and DrawingML URIs against exact supported sets. A bounded start-tag tokenizer accepts either XML attribute quote, decodes predefined/numeric entities, and keeps URI matching case-sensitive while MIME matching stays case-insensitive. Trusted-host invented paths, unknown namespaces/content types/full relationship URIs/drawing URIs, entity-encoded inventions, and URI case variants all force `partial`; standard fixtures remain `ready`. Core logging is request-scoped through a per-open collector closure, eliminating the shared mutable `activeDiagnostics`. A deliberately overlapped pair of delayed opens proves diagnostics never cross and neither request becomes falsely ready.

The focused final review set passed `49/49`; at that review point the host-adapter file contributed `24` tests. Candidate admission remained `NO_GO / 8`, with no format promotion.

## Final re-review fix — fail-closed OOXML structure

The remaining false-ready path is closed. Exact RED on the previous code was host `25` pass / `8` fail: empty/missing/wrong-case/duplicate `ContentType`, an unquoted attribute before it, missing `Default.Extension`, missing `Override.PartName`, and an undeclared `p` QName all returned `ready`. A second namespace RED was `32` pass / `2` fail for a missing relationship default namespace and an explicit standard `xml` binding control.

The bounded tokenizer now records malformed, duplicate, unquoted, unterminated, mismatched and unsupported XML syntax as scoped `VIEWER_OOXML_XML_MALFORMED`; validates exact required `[Content_Types].xml` declaration attributes; tracks namespace scope through element nesting; recognizes the implicit/explicit standard `xml` namespace; excludes `xmlns` declarations from ordinary QName checks; and requires every element/attribute prefix plus OOXML default element namespaces to resolve in scope. `mc:Ignorable` values are not mistaken for QName usage. All diagnostics force `partial`, while the standard DOCX/PPTX fixtures and explicit `xml`/`xmlns`/`mc:Ignorable` control remain `ready`.

That re-review GREEN was host adapter `35/35`, GVP-0 `23/23`, and Universal Viewer offline serial `131/131` in 62.024 seconds. Prior single/double-quote, entity, URI-case and exact trusted-host probes remain in the same passing file.

## Final tokenizer closure — QName, document root, entities, and MCE lists

Exact RED was `0/5`: `<p:/>`, a concatenated second XML root, unknown text entity `&bogus;`, and an undeclared token in `mc:Ignorable` each returned `ready`; the four failing subtests also failed their parent aggregate. The bounded tokenizer now enforces strict non-empty QName grammar, exactly one document element, only XML declaration/comments/whitespace outside that root, predefined or valid numeric XML entities in text and attributes, and in-scope namespace resolution for tokens in `mc:Ignorable`, `ProcessContent`, `PreserveElements`, and `PreserveAttributes`. Malformed XML coalesces to one scoped `forces_partial` diagnostic and cannot become ready.

Final GREEN: focused regression `5/5`, host adapter `40/40`, GVP-0 `23/23`, and Universal Viewer offline serial `136/136` in 64.615 seconds. Standard fixtures and the prior single/double-quote, entity, URI-case and exact trusted-host controls remain ready/passing.
