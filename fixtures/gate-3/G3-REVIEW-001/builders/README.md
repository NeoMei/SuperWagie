# Gate 3 fixture builders

These project-owned sources rebuild the five synthetic Office Reviewer fixtures
without using user documents, Codex Desktop resources, WPSComposer private
staging, or an ephemeral task directory.

## Runtime contract

Use Codex Desktop's workspace dependency loader and pass its returned Python,
Node, and Node-module paths to `reproduce.sh`. The exact tested runtime and
module versions are pinned in `runtime-lock.json`; the recipe refuses a version
mismatch. Runtime installation locations are intentionally not embedded in any
builder.

## Reproduction

From the repository root:

```bash
fixtures/gate-3/G3-REVIEW-001/builders/reproduce.sh \
  --runtime-python "$RUNTIME_PYTHON" \
  --runtime-node "$RUNTIME_NODE" \
  --runtime-node-modules "$RUNTIME_NODE_MODULES" \
  --output-dir "$OUTPUT_DIR"
```

The recipe builds into the caller-selected output directory, keeps all scratch
files under a separate temporary work directory, disables PPTX preview rendering
for the structural rebuild, and finishes by running `structural_audit.py`.
Use `--check-only` to validate the pinned runtimes and builder syntax/imports
without creating artifacts. Use `--with-pptx-preview` only when a fresh visual
suite is explicitly required.

The four authoring/patch sources are `build_docx.py`, `patch_docx_ooxml.py`,
`build_pptx.mjs`, and `build_pdf.py`; `structural_audit.py` is the independent
semantic validator. Every input, output, work, and fixture path is supplied by
arguments or derived from the project-owned builder directory.

## Determinism boundary

A rebuild is required to be semantically equivalent and to pass all exact
counts and feature checks. Byte-identical output is not guaranteed: Office ZIP
entry metadata, serialization order, compression, and runtime/container metadata
can legitimately change bytes while preserving the audited structures. The
checked-in five fixture hashes remain the immutable acceptance identities until
an explicitly reviewed regeneration updates the manifest.

The recipe does not run artifact-operation markers. Those markers were already
run for the original Task 2 authoring operation and must not be repeated by a
reproducibility check.
