# AnyDoc source archive

`anydoc-0.2.4.crate` is the unmodified official crates.io source archive, obtained
from <https://static.crates.io/crates/anydoc/anydoc-0.2.4.crate>. Its 252399 bytes
have SHA-256:

```
cf0d78e4cfe3654eb3ea04422ec5a94352000ee56e97902125e68e51f7527062
```

This is the `cksum` of version `0.2.4` in the official crates.io sparse index at
<https://index.crates.io/an/yd/anydoc>, independently checked against a second
download on 2026-10-30. The package's original MIT license is included inside the
archive as `anydoc-0.2.4/LICENSE` and is retained in the prepared source tree.

The Electron build owner verifies the fixed checksum before decompressing, then
accepts only the reviewed 83 regular tar entries with safe paths and mode 0644.
It creates the path crate by changing exactly one import in `src/lib.rs` to a
public re-export and adding the upstream version marker. All file contents,
links, names and POSIX permissions are verified before and after Cargo and Go.
Directories use mode 0755; Windows does not expose equivalent POSIX permissions.
Unknown or partial patched trees are preserved and rejected.

`embedded-knowledge-policy.cjs` pins the source checksum and deterministic patched
tree checksum together. Preparation, source-tree verification and final packaging
share that exact three-field receipt contract, so invoking electron-builder
directly cannot accept an old source-built payload with no receipt. The sole
legacy exception is the existing audited Windows x64 prebuilt, selected by its
actual binary SHA-256, fixed full source label and GNU patch; its receipt must be
absent. An arbitrary manifest flag, source override or declared hash cannot
select that exception. This is receipt consistency, not binary provenance proof.

The archive is vendored so preparing the patched path crate cannot invoke the
pinned upstream script's unverified mirror, registry cache or extraction branch.
Cargo still resolves other locked dependencies normally. This checksum guard
does not independently attest the toolchain, transitive dependency caches,
external compiler environment or resulting worker executable. For a version
upgrade, review the official checksum, archive contents, dependency pin, unique
patch and actual pinned Bash control flow together before changing this policy.
