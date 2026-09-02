# G3-REVIEW-001 validation checklist

## Provenance and confinement

- [ ] Every manifest path is relative and remains inside this fixture root.
- [ ] No path or package part references `Codex.app` or a user document.
- [ ] All five SHA-256 values are lowercase, 64 characters, and match current bytes.
- [ ] The fixture identity, redistributable flag, and provenance text match the audit contract.

## DOCX

- [ ] ZIP signature, central directory, uncompressed sizes, and CRCs pass.
- [ ] Rendered count is exactly 30 pages.
- [ ] True TOC, linked numbering, three sections, portrait/landscape changes, headers/footers, PAGE field, footnote, table, `wp:anchor`, mixed script, missing-font marker, and tracked repagination edit are present.
- [ ] Every rendered page is inspected for clipping, overlap, broken tables, missing glyphs, and misplaced headers/footers.

## PPTX

- [ ] ZIP signature, central directory, uncompressed sizes, and CRCs pass.
- [ ] The package contains exactly 20 slide parts.
- [ ] Image-first, editable text, chart, table, SVG, raster, alpha, gradient, group, rebuild, poster/video, missing-font, and notes evidence is present.
- [ ] Every slide is rendered and inspected; renderer-specific differences are recorded rather than normalized away.

## PDF and negative fixtures

- [ ] The valid PDF has exactly 100 pages, 80 text pages, 20 scanned-image pages, and three page sizes.
- [ ] Eleven outline entries, 100 URI links, 99 internal links, and four text annotations are present.
- [ ] `corrupt-tail.pdf` retains `%PDF-` but strict parsing fails terminally due to the removed tail.
- [ ] `oversize-placeholder.bin` exceeds 16 MiB and is classified as unsupported.
- [ ] Representative pages plus all-page montages are visually inspected; no claim is made for real-WPS rendering in this task.

## Result

- [ ] `node --test scripts/poc/gate-3/fixture-audit.test.mjs` passes.
- [ ] `node scripts/poc/gate-3/fixture-audit.mjs --fixture G3-REVIEW-001` returns `ok: true` with zero violation arrays.
- [ ] A completed result follows `checklist-result.example.json` and records renderer/font/parameter provenance.
