#!/usr/bin/env bash
# Publish both reviewed help formats. Uses the website deploy variables.
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
digest_file() {
  node -e 'const fs = require("node:fs"); const crypto = require("node:crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));' "$1"
}
v1_digest="$(digest_file "$staging/v1/catalog.json")"
v2_digest="$(digest_file "$staging/v2/catalog.json")"
COPYFILE_DISABLE=1 tar -C "$staging" -cf "$staging/catalogs.tar" v1/catalog.json v2/catalog.json

quote_shell() {
  local value="$1"
  local escaped="'\\''"
  value="${value//\'/$escaped}"
  printf "'%s'" "$value"
}

remote_script="$(cat <<'REMOTE'
set -eu
root="$1/product-help"
expected_v1="$2"
expected_v2="$3"
umask 022
mkdir -p "$root"
lock="$root/.publish-lock"
if ! mkdir "$lock"; then
  echo 'Another product help publication holds the lock' >&2
  exit 1
fi
staging=''
completed=''
recovery_backup=''
cleanup() {
  status="$?"
  if [ "$status" -ne 0 ]; then
    printf 'Product help publication incomplete; completed: %s. Retry both formats from the same author snapshot.\n' "${completed:-none}" >&2
  fi
  if [ -n "$recovery_backup" ] && [ -f "$recovery_backup" ] && ! cmp -s "$recovery_backup" "$directory/catalog.json"; then
    printf 'Product help previous catalog retained for recovery at %s\n' "$recovery_backup" >&2
  elif [ -n "$staging" ]; then
    rm -rf "$staging"
  fi
  rmdir "$lock"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
staging="$(mktemp -d "$root/.publication.XXXXXX")"
tar -xf - -C "$staging" v1/catalog.json v2/catalog.json
# Check the whole upload before either public channel changes.
for version in v1 v2; do
  if [ "$version" = v1 ]; then expected="$expected_v1"; else expected="$expected_v2"; fi
  actual="$(sha256sum < "$staging/$version/catalog.json")"
  if [ "${actual%% *}" != "$expected" ]; then
    printf 'Product help %s upload checksum mismatch\n' "$version" >&2
    exit 1
  fi
done
for version in v1 v2; do
  if [ "$version" = v1 ]; then expected="$expected_v1"; else expected="$expected_v2"; fi
  directory="$root/$version"
  staged="$staging/$version/catalog.json"
  backup=''
  mkdir -p "$directory"
  chmod 644 "$staged"
  if [ -f "$directory/catalog.json" ]; then
    current="$(sha256sum < "$directory/catalog.json")"
    if [ "${current%% *}" = "$expected" ]; then
      completed="${completed:+$completed }$version"
      printf 'Product help %s already matches %s\n' "$version" "$expected"
      continue
    fi
    backup="$staging/$version/catalog.previous.json"
    cp "$directory/catalog.json" "$backup"
    chmod 644 "$backup"
  fi
  # Register recovery before the public rename so a signal cannot delete the
  # prior current bytes between that rename and their move to previous.
  recovery_backup="$backup"
  mv -f "$staged" "$directory/catalog.json"
  completed="${completed:+$completed }$version"
  if [ -n "$backup" ] && ! mv -f "$backup" "$directory/catalog.previous.json"; then
    printf 'Published %s; could not replace its previous catalog\n' "$version" >&2
    exit 1
  fi
  recovery_backup=''
  printf 'Published %s/catalog.json\nSHA-256 %s\n' "$directory" "$expected"
done
REMOTE
)"
remote_command="sh -c $(quote_shell "$remote_script") sh $(quote_shell "$deploy_root") $(quote_shell "$v1_digest") $(quote_shell "$v2_digest")"
ssh -p "$deploy_port" -- "$deploy_user@$deploy_host" "$remote_command" < "$staging/catalogs.tar"
