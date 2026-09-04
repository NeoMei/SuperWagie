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
DOCX/PPTX rendering. CycloneDX output comes only from the admitted Node 24.18.0
and npm 11.16.0 runtime trees. The macOS arm64 and Windows x64 distributions
have separate pinned content hashes; candidate commands use the absolute npm
CLI through the pinned Node executable, and provenance binds Node, the complete
npm tree, Clang, and the compiled Seatbelt fingerprint helper.

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
current tracked baseline is the regenerated
zero-patch result: `GO`, zero forbidden runtime edges, zero reachable
moderate-or-higher vulnerabilities, and a `GO` chunk audit. The generated PoC
chunks remain unsigned and explicitly non-production-loadable.

Before any long-running probe, the gate exclusively reserves every evidence,
manifest, and result file with non-following file descriptors and records the
directory/file inode identities. All later writes use only those descriptors;
if a checked output root is renamed or replaced by a symlink, the candidate is
not touched and the run exits 2. The public runner applies the same capability
boundary to its command, decision, stdout/stderr, and initial manifest files;
successful finalization happens before the Core's last source/input recheck,
and a changed public root is never reopened, tailed, cleaned, or written.
Every emitted text artifact is scanned for secret-bearing keys and
credential/token patterns. Generated security-critical JSON has recursive
`additionalProperties: false` schemas, and secret-key matching normalizes
camelCase, snake_case, kebab-case, Unicode, and letter case. Subprocess failures
redact ordinary-valued key assignments as well as recognizable tokens and
absolute paths before they can enter logs or the CLI response.
