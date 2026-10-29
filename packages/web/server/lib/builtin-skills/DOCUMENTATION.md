# Built-in Skills

## Purpose

SuperWagie ships a set of skills that should be available without running the
skills catalog. `install.js` copies them into the OpenCode skills directory the
first time the server starts. User-edited content remains untouched.

The bundled payload lives in `packages/web/server/builtin-skills/`:

- `skills/<name>/` — ordinary skills copied to `OPENCODE_CONFIG_DIR/skills/<name>`.
- `superppt/` — the SuperPPT plugin root. SuperPPT resolves its plugin root as
  two levels above its own folder, so the skill is linked from a runtime root
  (`<dataDir>/skills-runtime/superppt`) instead of copied into the skills dir.
- `supervideo-engine/` — SuperVideo's pinned engine, copied to
  `<cacheDir>/supervideo/engines/<engineManifestSha256>`.

## Rules

- A skill name that already exists in any configured host skill directory is
  never copied over. That covers a previous install, a hand copy, and a skill
  from another host such as `~/.claude/skills`.
- A failure is logged and skipped; it never keeps the server from starting.
- The general copy only adds missing directories. A narrow migration refreshes
  the exact, byte-identical model readers and SuperVideo runtime lock shipped
  before unified configuration. A custom reader or lock prevents that group
  from being refreshed and reports a reinstall remedy. Skill instructions and
  unrelated files remain untouched.
- `superppt` is linked on macOS/Linux and junctioned on Windows; a machine
  without symlink permission logs the failure and keeps the rest.

## Shared model consumption

Managed OpenCode processes receive `SUPERWAGIE_MODEL_RESOLVER`,
`SUPERWAGIE_MODEL_NODE` and `OPENCHAMBER_DATA_DIR` from the server. The resolver
is invoked privately at generation time; its stdout contains a write-only
credential and is never printed, logged or copied into a receipt. Resolver
failure cannot silently use an unrelated environment key. Outside a managed
SuperWagie process, legacy environment/secret-file behavior remains when no
unified configuration exists; an existing unified file without its runtime
reports that the skill must run from SuperWagie. External OpenCode processes
that the app does not launch do not inherit this runtime bridge.

The image adapter reads `image-generation`, chooses OpenAI-compatible, Alibaba
Qwen Images, Gemini or Volcengine Seedream, and uses the binding's endpoint,
model and key together. Host image tools retain their existing priority.
Managed masked image editing and asynchronous video submission use private
media broker actions and never expose a supplier key; a returned video task
still needs a consumer that polls and imports its final artifact.

SuperVideo's bundled engine adds OpenAI-compatible and MiniMax narration adapters. A new
project with no explicit voice uses the selected `tts` model/voice. Existing
project voice settings remain explicit: a model mismatch fails with a remedy to
update that project's voice, instead of forwarding a key into a different
legacy adapter. System voices and host receipts remain local/host choices.
MiniMax narration invokes the private resolver's synthesis action rather than
duplicating the provider request or returning its key in an audio receipt.
The engine manifest and runtime lock are regenerated together, and its new cache
sits beside the previous immutable engine. Modified runtime locks are preserved.

Pure prompt skills inherit the Agent model and need no separate credential.
The editable-PPTX skill still needs its separately supplied runtime; an image
editing key alone does not install it, and safe-background fallback remains
available. The purpose catalog lists all bundled skills and these boundaries.

Refresh and installation refuse symlinks in every destination component inside
the managed skill/data/cache roots. Checking only the last reader file is not
enough: a linked `scripts` or engine-cache parent would otherwise overwrite a
different host's files. Reader replacements use unique temporary files and
retain the existing byte-identity check before mutation.

Image API transport refuses redirects before following any Location header.
OpenAI Authorization, Gemini x-goog-api-key and Volcengine Authorization therefore
remain on the selected endpoint. Redirect failures use a fixed message and do
not read an upstream error body or target URL into diagnostics. The same bounded
public-image download path also refuses redirects.
