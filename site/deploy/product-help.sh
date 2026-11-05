#!/usr/bin/env bash
# Publish only the reviewed help catalog. Uses the website deploy variables.
# DEPLOY_HOST=host DEPLOY_USER=root DEPLOY_DIR=/var/www/superwagie bash site/deploy/product-help.sh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
deploy_host="${DEPLOY_HOST:?set DEPLOY_HOST}"
deploy_user="${DEPLOY_USER:-root}"
deploy_port="${DEPLOY_PORT:-22}"
deploy_root="${DEPLOY_DIR:-/var/www/superwagie}"
if [[ "$deploy_root" != /* ]]; then
  echo 'DEPLOY_DIR must be an absolute website directory' >&2
  exit 1
fi

staging="$(mktemp -d "${TMPDIR:-/tmp}/superwagie-help.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
node "$repo_root/scripts/product-help-content.mjs" --output "$staging"
catalog="$staging/catalog.json"
digest="$(node -e 'const fs = require("node:fs"); const crypto = require("node:crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));' "$catalog")"

quote_shell() {
  local value="$1"
  local escaped="'\\''"
  value="${value//\'/$escaped}"
  printf "'%s'" "$value"
}

remote_script="$(cat <<'REMOTE'
set -eu
directory="$1/product-help/v1"
expected="$2"
umask 022
mkdir -p "$directory"
lock="$directory/.publish-lock"
if ! mkdir "$lock"; then
  echo 'Another product help publication holds the lock' >&2
  exit 1
fi
staged=''
backup=''
cleanup() {
  if [ -n "$staged" ]; then rm -f "$staged"; fi
  if [ -n "$backup" ]; then rm -f "$backup"; fi
  rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
staged="$(mktemp "$directory/.catalog.XXXXXX")"
cat > "$staged"
actual="$(sha256sum < "$staged")"
actual="${actual%% *}"
if [ "$actual" != "$expected" ]; then
  echo 'Product help upload checksum mismatch' >&2
  exit 1
fi
chmod 644 "$staged"
if [ -f "$directory/catalog.json" ]; then
  current="$(sha256sum < "$directory/catalog.json")"
  if [ "${current%% *}" = "$expected" ]; then
    printf 'Product help already matches %s\n' "$expected"
    exit 0
  fi
  backup="$(mktemp "$directory/.previous.XXXXXX")"
  cp "$directory/catalog.json" "$backup"
  chmod 644 "$backup"
  mv -f "$backup" "$directory/catalog.previous.json"
  backup=''
fi
mv -f "$staged" "$directory/catalog.json"
staged=''
printf 'Published %s/catalog.json\nSHA-256 %s\n' "$directory" "$expected"
REMOTE
)"
remote_command="sh -c $(quote_shell "$remote_script") sh $(quote_shell "$deploy_root") $(quote_shell "$digest")"
ssh -p "$deploy_port" -- "$deploy_user@$deploy_host" "$remote_command" < "$catalog"
