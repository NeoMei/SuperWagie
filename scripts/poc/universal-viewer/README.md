# Universal Viewer frozen-core acquisition PoC

This directory is a disposable, developer-only GVP-0 experiment. It locks and
reproduces one reviewed `omni-viewer-core` candidate without admitting any
format or Viewer gate into production.

The committed `source-lock.json` is the only upstream source identity accepted
by the commands. Network acquisition is an explicit developer action and is
never a product startup, first-open, runtime fallback, or update path.

```bash
npm ci
npm test
node acquire-frozen-core.mjs --cache-root "$PWD/.candidate"
node provenance.mjs \
  --candidate-root "$PWD/.candidate/source" \
  --output "$PWD/audit/source-provenance.json"
```

Both commands require absolute paths. Acquisition fetches only the locked
40-character commit with tags disabled, verifies the detached checkout and
deterministic `git archive` SHA-256, and rejects dirty trees, symlinks,
submodules, remote drift, and lock drift. For an already acquired archive, use
`--offline-archive /absolute/path/to/source.tar`; its bytes must match the same
locked SHA-256.

Generated candidates, audit data, build output, and dependencies remain local
and ignored. The emitted provenance deliberately excludes filesystem paths and
records an empty patch ledger; this task does not modify production registries
or technical admission status.
