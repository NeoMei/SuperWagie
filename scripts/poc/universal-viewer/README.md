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
