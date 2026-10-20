#!/usr/bin/env bash
# Regenerate references/excalidraw-vendored.mjs (the single-file Excalidraw ES module
# used by render.py). The bundle is committed for out-of-the-box rendering; re-run only
# to bump @excalidraw/excalidraw or change exports.
# Usage:  bash references/build-vendor.sh
set -euo pipefail
cd "$(dirname "$0")"
echo ">> installing esbuild + @excalidraw/excalidraw"
# macOS npm cache permission fix if needed: sudo chown -R "$(whoami)" ~/.npm  (or: --cache /tmp)
npm install --no-save --no-package-lock esbuild @excalidraw/excalidraw
echo ">> bundling entry.mjs -> excalidraw-vendored.mjs"
npx esbuild entry.mjs --bundle --format=esm --outfile=excalidraw-vendored.mjs --log-level=warning
echo ">> done. $(du -h excalidraw-vendored.mjs | cut -f1) written."
