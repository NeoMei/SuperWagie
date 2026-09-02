# G3-REVIEW-001 — Office Reviewer torture fixtures

This fixture set provides project-owned, redistributable DOCX, PPTX, PDF,
terminal-failure, and oversize inputs for Gate 3 technical validation. The
manifest records immutable relative paths, expected counts/outcomes, and
SHA-256 hashes calculated from the checked-in bytes.

## Files and required evidence

| File | Expected result | Required evidence |
|---|---|---|
| `fixtures/reviewer-torture-30p.docx` | 30 rendered pages | True TOC field, linked heading numbering, 3 sections with portrait/landscape changes, per-section headers/footers, PAGE field, true footnote, table, `wp:anchor`, Chinese/Latin text, missing-font marker, tracked repagination replacement |
| `fixtures/reviewer-torture-20s.pptx` | 20 slides | Image-first slides, editable DrawingML text, native charts/tables, SVG and raster media, alpha transparency, gradients, native group, rebuild markers, poster-frame/video relationship, missing-font marker, notes |
| `fixtures/reviewer-torture-100p.pdf` | 100 pages | 80 text pages, 20 scanned-image pages, 3 page sizes, 11 outline entries, 100 URI links, 99 internal links, 4 text annotations |
| `fixtures/corrupt-tail.pdf` | `failed_terminal` | PDF signature retained, terminal xref/EOF removed, explicit corrupt-tail marker |
| `fixtures/oversize-placeholder.bin` | `unsupported` | Unknown `.bin` class and size greater than 16 MiB |

## Provenance

The binaries were authored from task-owned synthetic content with the bundled
workspace artifact runtimes. Their durable sources live in `builders/`:
`build_docx.py`, `patch_docx_ooxml.py`, `build_pptx.mjs`, and `build_pdf.py`;
`structural_audit.py` independently validates the semantic output. The pinned
runtime/module identities are in `builders/runtime-lock.json`, and the
executable, path-parameterized recipe is `builders/reproduce.sh` with usage and
determinism boundaries documented in `builders/README.md`. No builder contains
the former ephemeral task root or a user-specific absolute path.

The manifest's separate `build_sources` ledger records the role and SHA-256 of
every builder, validator, lock, recipe, and reproduction guide. These entries
are provenance evidence and do not alter the exact five fixture definitions in
`files`.

The rebuild guarantee is semantic, not byte-identical. OOXML ZIP metadata,
serialization/compression order, and container metadata can vary while all
required structures and exact counts remain valid. A reviewed regeneration is
required before replacing checked-in bytes or changing their manifest hashes.
The focused recipe's `--check-only` mode verifies the pinned runtime and builder
syntax without generating artifacts.

The DOCX/PPTX ZIP packages and the valid PDF were rendered during fixture QA.
Those bundled/LibreOffice renders are technical evidence only. They do not
replace the real-WPS visual fact source required by later Gate 3 tasks
(R-DL-05, R-DL-08, R-DL-09, R-QS-02).

## macOS machine profile

`machine-profile.macos-15-arm64.json` is the explicit, path-free input for the
current representative macOS arm64 Gate run. It binds WPS `12.1.26055`, the
project-owned WPSComposer bridge hash, the WPS executable's bundle-relative
path, and the authoritative render options. The runner never discovers or
invents this profile. If WPS, the bridge, or the target environment changes,
create and review a new profile instead of silently editing the recorded
identity or reusing stale evidence.

## Audit

Run from the repository root with the approved bundled Node on `PATH`:

```bash
node --test scripts/poc/gate-3/fixture-audit.test.mjs
node scripts/poc/gate-3/fixture-audit.mjs --fixture G3-REVIEW-001
```

Do not edit a binary in place without regenerating the manifest and preserving
the source/build/validation evidence. Consumers must bind cache keys and review
annotations to the manifest SHA-256, renderer/application version, font
environment, and rendering parameters.
