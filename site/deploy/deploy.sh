#!/usr/bin/env bash
# Build the static site and copy it to a server over SSH.
# Usage:
#   DEPLOY_HOST=1.2.3.4 DEPLOY_USER=root DEPLOY_DIR=/var/www/superwagie ./site/deploy/deploy.sh
# Optional: DEPLOY_PORT=22, RELOAD_CMD="sudo systemctl reload nginx"
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOST="${DEPLOY_HOST:?set DEPLOY_HOST}"
USER="${DEPLOY_USER:-root}"
PORT="${DEPLOY_PORT:-22}"
DIR="${DEPLOY_DIR:-/var/www/superwagie}"
RELOAD="${RELOAD_CMD:-sudo nginx -t && sudo systemctl reload nginx}"

node "$ROOT/site/build.mjs"

# Installers and Google ownership verification files are managed separately.
# Preserve both when the page build does not carry a copy.
rsync -az --delete --exclude downloads/ --exclude 'google*.html' -e "ssh -p $PORT" "$ROOT/site/dist/" "$USER@$HOST:$DIR/"

if [ -n "$RELOAD" ]; then
  ssh -p "$PORT" "$USER@$HOST" "$RELOAD"
fi

echo "Deployed to $USER@$HOST:$DIR"
