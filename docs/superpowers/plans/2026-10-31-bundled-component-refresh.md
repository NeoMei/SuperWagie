# Bundled component refresh implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Update SuperWagie's stale bundled SuperPPT, SuperWeb and WPSComposer skills, repair the Langfuse range and remove the nonessential incompatible LangSmith catalog entry, and safely refresh unchanged app-managed skill copies.

**Architecture:** Keep upstream skill snapshots under the existing builtin-skills owner, preserving product model adapters and workflow contracts. First-run installation learns a bounded managed-copy refresh path using exact file identity; user-owned or edited copies remain untouched. Catalog entries continue using the existing opt-in installation flow.

**Tech stack:** Node.js filesystem modules, existing Vitest/Bun tests, existing vendored TypeScript/Python skill runtimes.

**Spec:** The user's 2026-10-31 instruction to update the skill/plugin audit findings and this plan's requirements. The audit is /tmp/superwagie-component-audit-20261031/audit.md.

## Global constraints

- Preserve all SuperWagie customizations, existing model adapters, safety boundaries and skill workflow/state contracts.
- Update SuperPPT 0.3.4 to 0.3.6, SuperWeb 1.1.0 to 1.2.0, WPSComposer 0.9.3 to 0.10.0 from verified official snapshots. Preserve applicable newer local product additions; record provenance without local machine paths.
- Do not install/enable telemetry plugins or send user conversations to external services. Keep catalog opt-in and enterprise behavior.
- Do not add root/workspace dependencies. Component-local existing dependencies may follow their requested upstream update, with their lockfiles.
- Do not modify user-edited skills or other hosts' directories. Refresh only exact known app-managed copies; failures preserve valid old data and unrelated installs.
- No git/gh commands, commits, shared pushes, publication, changelog edits, app replacement or app restart. The repository forbids git/GitHub commands without an explicit user request. Use the existing linked worktree and filesystem-based baseline/review artifacts.
- No new app version or automatic Intel update channel in this task. Public releases remain unchanged.
- Complete image-to-editable-pptx offline reconstruction packaging from verified 0.3.1. Its current upstream live routing uses unrelated OpenCodex discovery and hardcoded public endpoints; refuse live analyze/run at the actual bundled CLI boundary before credentials/discovery/network until dedicated configured-model adapters exist. Describe offline capability and live restriction explicitly; do not pass resolver keys into public-endpoint environment variables.
- Run isolated focused tests during each task. Root coordinates broad gates/builds once on the combined finished diff. Review each completed task before starting the next.

## Runtime surfaces

| Runtime | Behavior |
| --- | --- |
| Web | Server installs and safely refreshes bundled skills on startup; catalog retains existing opt-in flow. |
| Electron | Same in-process installer and packaged resources; user's running app remains untouched. |
| VS Code | Existing skill discovery/catalog path remains; no new host-side automatic bundle installer. |
| Hosted mobile | Uses its server's skill installation and existing catalog behavior. |
| Capacitor mobile | Uses its server's skill installation and existing catalog behavior. |

### Task 1: Refresh the three vendor snapshots

**Files:** `packages/web/server/builtin-skills/superppt/**`, `skills/superweb/**`, `skills/WPSComposer/**`, owning NOTICE/provenance, and focused vendor compatibility tests under `server/lib/builtin-skills/` when needed.

**Consumes:** Existing payload and saved baseline `.superpowers/sdd/2026-10-31-bundled-component-refresh/baseline.tar.gz`.
**Produces:** Verified current vendor payloads with source identities and retained product adaptations. Task 2 consumes their actual runtime file layout.

- [x] Read owning documentation and package scripts; compare old payload, canonical local installs and official target releases.
- [x] Verify that copied bytes match the chosen official revision, and explicitly retain any SuperWagie-only workflow assets, model handling or safety behavior. In particular examine SuperPPT's 13-style/61-combination additions before replacing a tree.
- [x] Copy only owned runtime/source/test files and lockfiles; omit local caches, node_modules, credentials, user outputs and machine-specific install receipts.
- [x] Exercise meaningful updated component tests and CLI/state contracts. Build/preparation must continue working from clean dependency resolution and packaged filtering.
- [x] Update source provenance/NOTICE and report exact tests and limitations. Leave source changes uncommitted.

### Task 2: Safely refresh unchanged managed installations

**Files:** `packages/web/server/lib/builtin-skills/install.js`, focused helper(s), tests and `DOCUMENTATION.md`; bounded migration identity metadata beside the owned bundle if needed. Minimal startup reporting in `packages/web/server/index.js` only when required.

**Consumes:** Task 1 runtime payload and the old exact baseline.
**Produces:** Same installer API `{ installed, skipped, updated, failed }`, with safe updates identified by `updated`.

- [x] Capture the old genuine app-shipped file identities before adopting a legacy copy. No version-only or SKILL.md-only overwrite decisions.
- [x] Record exact managed content identity for future first-run installs. Refresh only when the complete relevant installed payload still matches the managed identity or an exact known legacy baseline. Preserve custom files, modified files, foreign paths, symlinks and newer versions; do not follow destination symlinks outside managed roots.
- [x] Stage a complete replacement before mutation, use same-filesystem rename with rollback, and make restart/retry safe. Avoid hashing large dependencies or rewriting unchanged content on every start where an authoritative unchanged check can avoid it.
- [x] Cover unchanged legacy upgrade, tracked upgrade/idempotence, user-edited or extra-file preservation, foreign host paths, intermediate symlink refusal, failure/rollback and SuperPPT linked runtime behavior. Cover SuperWeb's packaged extra-resource/vendor-node_modules layout.
- [x] Keep first-run conflict behavior and the existing narrow model-reader migration. Update the owner documentation and report tests.

### Task 3: Repair optional plugin version specifications

**Files:** `packages/ui/src/lib/integrations-catalog/registry.ts`, `registry.test.ts`, `DOCUMENTATION.md`.

**Consumes:** Existing plugin installation/confirmation path; npm public metadata.
**Produces:** Langfuse range `^0.7.0`, removal of the LangSmith catalog entry and its unused localized/icon metadata, with the existing Claude/Search specs untouched. The user confirmed removing LangSmith if nonessential; source inspection proves no core dependency. Existing user-installed plugins/configurations are not removed by catalog maintenance.

- [x] Confirm exact official npm release ranges and OpenCode plugin export compatibility without enabling telemetry or invoking real-user provider calls.
- [x] Replace Langfuse's nonexistent `^1` with `^0.7.0`. Remove the nonessential LangSmith catalog entry and unused localization/brand mapping; keep shared LangChain assets still needed elsewhere. Adjust version policy/tests for meaningful major>=1 or minor-pinned 0.x ranges. Add a meaningful regression test that the incompatible entry is absent and the supported plugin specs remain exact.
- [x] Keep explicit install confirmation and enterprise policy unchanged. Check the package-name parser and existing callers for minor-range compatibility.
- [x] Run catalog, locale and relevant plugin contract tests; document the pre-1.0 version policy and observed compatibility boundaries.

### Task 4: Package executable presentation runtimes

**Files:** Existing Electron resource preparer(s), package resource filters/contracts, owned image-to-editable-pptx vendor root, builtin installer plugin-root mapping if required, owning docs/tests.

**Consumes:** Updated SuperPPT runtime source from Task 1, refreshed installer from Task 2, verified official image-to-editable-pptx release.
**Produces:** Physical executable runtime roots with compiled JavaScript and target-native dependencies. SuperPPT resolves its runtime; image-to-editable-pptx offers verified offline reconstruction with explicit core-enforced live-provider unavailability.

- [x] Stage SuperPPT compiled JavaScript and production dependencies outside the global TypeScript archive filter, retaining plugin-relative root resolution. Generalize the existing component-resource preparation only where it genuinely avoids duplicate work.
- [x] Bundle image-to-editable-pptx 0.3.1 offline runtime, license and provenance, replacing the instruction-only placeholder with a managed plugin-root link. Preserve official source fingerprints and compiled entrypoints. Enforce offline build/build-v1/raster-patch at the actual bundled CLI before provider discovery, credentials or requests; unsupported live commands return a clear remedy. No UI claim that online analysis is ready.
- [x] Preserve target architecture constraints and existing SuperWeb preparation. Avoid copying host-architecture sharp packages into a different target package.
- [x] Verify staged CLI execution and a representative offline state/reconstruction artifact through installed skill paths and packaging-contract checks. Update owning documentation and tests; report native Windows/macOS12 validation limits.

### Task 5: Final validation and concrete local update

**Files:** Finished combined diff; isolated temporary installation/profile and receipts. No public release changes.

- [x] Independently review each prior task and the complete diff using a filesystem-generated review package. Address findings in a scoped fix pass.
- [x] Run the required type/lint/dead-code/anti-slop checks with an appropriate explicit baseline, plus component builds, customization tests and real isolated installer/CLI checks. Do not claim Windows or macOS 12 hardware acceptance from this Mac.
- [x] Back up eligible local OpenCode-managed skill copies and use the validated installer to update only exact unchanged owned copies. Leave other-host or user-edited copies intact and report exact resulting paths/versions. Do not replace or restart the running application.
- [x] Report updated sources, local migration outcome, validation and any remaining separately supplied runtime requirement. No GitHub release is implied by this update.
