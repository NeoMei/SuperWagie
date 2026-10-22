# Pinned embedded-knowledge test fixtures

These are unmodified original source files from
[NeoMei/embedded-knowledge](https://github.com/NeoMei/embedded-knowledge/tree/f5adb9eac166e7d3da7dceed7aa50049d4c4db1f),
commit `f5adb9eac166e7d3da7dceed7aa50049d4c4db1f`:

| File | Original Git blob SHA-1 |
| --- | --- |
| `scripts/build-anydoc-lib.sh` | `d59aeeb48ab44dda37b2d9348286685192822df4` |
| `third_party/anydoc-go/anydoc.go` | `646ed6a979e623f97ffaa8e5df19425d2731b75b` |

The Windows patch tests copy these files into temporary repositories and apply
the production patch there. Tests need Git and Bash, with Git Bash on Windows.
They need no upstream checkout, network access, Go compiler, or Rust compiler.
The archive-copy test replaces Cargo with a fixture executable.

WeKnora is copyright 2026 Tencent and is MIT licensed. `LICENSE.weknora`
contains the copyright notice and MIT terms extracted from the pinned root
LICENSE, with trailing whitespace removed. AnyDoc is copyright 2026 Sideguide
Technologies Inc.; its original MIT license is preserved at
`third_party/anydoc-go/LICENSE`. The pinned distribution identifies Tencent
modifications to AnyDoc.

When updating the upstream pin, review and replace both originals together with
the patch and its full-file blob identities. Preserve original source contents;
the test loader normalizes CRLF to LF for Git and Bash.
