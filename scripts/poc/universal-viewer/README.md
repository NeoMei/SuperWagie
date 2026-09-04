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
npm run sbom > audit/source-sbom.cdx.json
node acquire-frozen-core.mjs --cache-root "$PWD/.candidate"
node provenance.mjs \
  --candidate-root "$PWD/.candidate/source" \
  --output "$PWD/audit/source-provenance.json"
node build-candidate.mjs \
  --candidate-root "$PWD/.candidate/source" \
  --output-root "$PWD/dist"
```

Both commands require absolute paths. Acquisition fetches only the locked
40-character commit with tags disabled, verifies the detached checkout and
deterministic `git archive` SHA-256, and rejects dirty trees, symlinks,
submodules, remote drift, and lock drift. For an already acquired archive, use
`--offline-archive /absolute/path/to/source.tar`; its bytes must match the same
locked SHA-256.

The executable Office closure uses exact, locked runtime dependencies for
DOCX/PPTX rendering. CycloneDX output comes only from the admitted built-in npm
11.16.0 `sbom` command; provenance records the exact Node/npm identities and
refuses another npm version or a command surface without the required
lock-only, omit, and CycloneDX options.

Generated candidates, local audit data, build output, and dependencies remain
ignored. A deterministic, sanitized baseline evidence bundle is tracked under
`baseline-evidence/`. The emitted provenance excludes filesystem paths and
binds the exact zero-patch ledger bytes; this task does not modify production
registries or technical admission status. The build command intentionally
exits non-zero when the frozen executable closure violates admission policy;
inspect its structured JSON decision instead of treating that as a build hang.

The public `gvp-0` route additionally performs bounded, current-registry
production audits for both locks and regenerates the CycloneDX SBOM. Offline,
timed-out, malformed, or stale supply-chain capture is an environment failure
(exit 2), not acceptance evidence. A complete result is accepted only when its
56 relative-path artifact bindings match the exact `GVP-0-CORE-001` contract;
an internally consistent smaller or rewritten bundle is not sufficient. The
current frozen candidate still has eight forbidden runtime edges, so a
deterministic complete fixture yields a schema-valid `NO_GO` receipt and exit 1.

Before any long-running probe, the gate exclusively reserves every evidence,
manifest, and result file with non-following file descriptors and records the
directory/file inode identities. All later writes use only those descriptors;
if a checked output root is renamed or replaced by a symlink, the candidate is
not touched and the run exits 2. Every emitted text artifact is scanned for
secret-bearing keys and credential/token patterns, while generated JSON uses
an exact allowed-field contract. Subprocess failures are redacted before they
can enter logs or the CLI response.
