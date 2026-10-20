# Built-in Skills

## Purpose

SuperWagie ships a set of skills that should be available without running the
skills catalog. `install.js` copies them into the OpenCode skills directory the
first time the server starts, then leaves them alone.

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
- The copy only adds missing directories. Updates to a bundled skill reach an
  installation only after the user removes the installed copy.
- `superppt` is linked on macOS/Linux and junctioned on Windows; a machine
  without symlink permission logs the failure and keeps the rest.
