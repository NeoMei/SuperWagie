#!/usr/bin/env bash
set -euo pipefail

builder_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runtime_python="${RUNTIME_PYTHON:-}"
runtime_node="${RUNTIME_NODE:-}"
runtime_node_modules="${RUNTIME_NODE_MODULES:-}"
output_dir=""
check_only=0
with_pptx_preview=0

while (($#)); do
  case "$1" in
    --runtime-python) runtime_python="$2"; shift 2 ;;
    --runtime-node) runtime_node="$2"; shift 2 ;;
    --runtime-node-modules) runtime_node_modules="$2"; shift 2 ;;
    --output-dir) output_dir="$2"; shift 2 ;;
    --check-only) check_only=1; shift ;;
    --with-pptx-preview) with_pptx_preview=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for value_name in runtime_python runtime_node runtime_node_modules; do
  if [[ -z "${!value_name}" ]]; then
    echo "missing --${value_name//_/-} (or uppercase environment equivalent)" >&2
    exit 2
  fi
done

"$runtime_python" - "$builder_dir/runtime-lock.json" <<'PY'
import importlib.metadata as metadata
import json
import platform
import sys

lock = json.load(open(sys.argv[1], encoding="utf-8"))
observed = platform.python_version()
if observed != lock["python"]["version"]:
    raise SystemExit(f"Python version mismatch: expected {lock['python']['version']}, observed {observed}")
for package, expected in lock["python"]["modules"].items():
    actual = metadata.version(package)
    if actual != expected:
        raise SystemExit(f"Python module mismatch for {package}: expected {expected}, observed {actual}")
PY

"$runtime_node" - "$builder_dir/runtime-lock.json" "$runtime_node_modules" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const [lockPath, moduleRoot] = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const observed = process.versions.node;
if (observed !== lock.node.version) throw new Error(`Node version mismatch: expected ${lock.node.version}, observed ${observed}`);
for (const [packageName, expected] of Object.entries(lock.node.modules)) {
  const actual = JSON.parse(fs.readFileSync(path.join(moduleRoot, packageName, 'package.json'), 'utf8')).version;
  if (actual !== expected) throw new Error(`Node module mismatch for ${packageName}: expected ${expected}, observed ${actual}`);
}
JS

"$runtime_python" - \
  "$builder_dir/build_docx.py" \
  "$builder_dir/patch_docx_ooxml.py" \
  "$builder_dir/build_pdf.py" \
  "$builder_dir/structural_audit.py" <<'PY'
import pathlib
import sys
for source_path in sys.argv[1:]:
    source = pathlib.Path(source_path).read_text(encoding="utf-8")
    compile(source, source_path, "exec")
PY
"$runtime_node" --check "$builder_dir/build_pptx.mjs"

if ((check_only)); then
  echo "runtime lock and builder syntax checks passed"
  exit 0
fi
if [[ -z "$output_dir" ]]; then
  echo "missing --output-dir for artifact rebuild" >&2
  exit 2
fi

mkdir -p "$output_dir"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/superwagie-g3-rebuild.XXXXXX")"
cleanup() {
  if [[ -d "$work_dir" && "$(basename "$work_dir")" == superwagie-g3-rebuild.* ]]; then
    rm -rf -- "$work_dir"
  fi
}
trap cleanup EXIT

"$runtime_python" "$builder_dir/build_docx.py" \
  --output "$work_dir/reviewer-torture-base.docx" \
  --work-dir "$work_dir/docx"
"$runtime_python" "$builder_dir/patch_docx_ooxml.py" \
  --input "$work_dir/reviewer-torture-base.docx" \
  --output "$output_dir/reviewer-torture-30p.docx"

pptx_work="$work_dir/pptx"
mkdir -p "$pptx_work"
cp "$builder_dir/build_pptx.mjs" "$pptx_work/build_pptx.mjs"
ln -s "$runtime_node_modules" "$pptx_work/node_modules"
pptx_args=(
  --output "$output_dir/reviewer-torture-20s.pptx"
  --work-dir "$pptx_work/evidence"
)
if ((!with_pptx_preview)); then pptx_args+=(--no-preview); fi
"$runtime_node" "$pptx_work/build_pptx.mjs" "${pptx_args[@]}"

"$runtime_python" "$builder_dir/build_pdf.py" \
  --output-dir "$output_dir" \
  --work-dir "$work_dir/pdf"
"$runtime_python" "$builder_dir/structural_audit.py" --fixture-dir "$output_dir"
echo "semantic rebuild passed: $output_dir"
