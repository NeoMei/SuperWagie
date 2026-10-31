#!/bin/sh
set -eu
: "${SUPERWAGIE_MODEL_NODE:?Run this bundled runtime from a SuperWagie managed session}"
runtime_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec env ELECTRON_RUN_AS_NODE=1 "$SUPERWAGIE_MODEL_NODE" "$runtime_dir/dist/src/cli.js" "$@"
