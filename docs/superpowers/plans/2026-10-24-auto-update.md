# SuperWagie Auto-update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows updates itself from GitHub Releases; macOS checks the same feed and opens the DMG download instead of installing.

**Architecture:** Keep the upstream electron-updater flow for Windows and point its generic feed at the SuperWagie latest release. Add a small `latest.json` check in the Electron main process for macOS, returning `installBlocked: 'manual-install'`. The renderer schedules checks, downloads on Windows, and opens the existing update dialog for the restart or the DMG link. A release script writes both static manifests.

**Tech Stack:** Electron 44, electron-updater 6, React/Zustand UI, Node scripts, GitHub Releases.

**Spec:** `docs/specs/2026-10-24-auto-update.md`

## Global Constraints

- Feed owner is `NeoMei/SuperWagie-Open`; never `openchamber/openchamber`.
- Windows x64 only; macOS arm64 manual install; no Linux/ARM64/beta/delta.
- Default auto-check on; per-device opt-out in About; skipped version remembered.
- No new npm dependencies.
- Do not change the manual release process; add a manifest script.

---

### Task 1: Point the updater at the SuperWagie feed and enable it

**Files:**
- Modify: `packages/electron/updater-feed.mjs`
- Modify: `packages/electron/updater-feed.test.mjs`
- Modify: `packages/electron/branding.mjs`
- Modify: `packages/ui/src/lib/branding.ts`

**Interfaces:**
- Produces: `PRODUCTION_UPDATER_FEED = { provider: 'generic', url: 'https://github.com/NeoMei/SuperWagie-Open/releases/latest/download/' }`
- Produces: `UPDATES_ENABLED = true`, `SELF_UPDATES_ENABLED = true`

- [x] Change the production feed and test expectation.
- [x] Run `bun test packages/electron/updater-feed.test.mjs`.
- [x] Flip both flags and run `bun run type-check`.

### Task 2: macOS check from latest.json

**Files:**
- Modify: `packages/electron/updater-check.mjs`
- Test: `packages/electron/updater-check.test.mjs`
- Modify: `packages/electron/main.mjs` (imports and `desktop_check_for_updates` / `desktop_download_and_install_update`)

**Interfaces:**
- Produces: `LATEST_JSON_URL`, `checkForMacUpdate({ currentVersion, compareVersions, fetchImpl, feedUrl, releaseBaseUrl })` returning `UpdateInfo` with `installBlocked: 'manual-install'` and `downloadUrl`.
- `desktop_check_for_updates` branches on `process.platform === 'darwin'`; other platforms keep electron-updater.
- `desktop_download_and_install_update` on darwin throws a message telling the UI to download the DMG.

- [x] Add tests for newer/equal/malformed/404 feeds with a stub `fetchImpl`.
- [x] Implement and wire the IPC branch.
- [x] Run the updater tests and type-check.

### Task 3: Release manifest script

**Files:**
- Create: `scripts/release-manifests.mjs`
- Create: `scripts/release-manifests.test.mjs`
- Modify: `package.json` (script `release:manifests`)
- Modify: `site/README.md` and `docs/specs/2026-10-24-auto-update.md` if the process differs

**Interfaces:**
- `buildManifests({ version, files: { macDmg, macZip, winExe }, notes, publishedAt, repo })` returns `{ 'latest.yml': string, 'latest.json': string }`.
- CLI accepts `--version`, `--dist`, `--notes-file`, `--repo`.

- [x] Test SHA-256/SHA-512 encoding, URLs, missing Windows asset failure.
- [x] Implement the CLI and the package script.
- [x] Run the script against fixture files; inspect the output.

### Task 4: Manual macOS action and SuperWagie links in the dialog

**Files:**
- Modify: `packages/ui/src/components/ui/UpdateDialog.tsx`
- Modify: `packages/electron/updater-check.mjs` (shape only)
- Test: existing `useUpdateStore.test.ts` if the store changes; no store change planned.

**Interfaces:**
- `UpdateInfo.installBlocked === 'manual-install'` makes the primary action open `downloadUrl` in the browser and close the dialog.
- The GitHub link points at `https://github.com/NeoMei/SuperWagie-Open/releases`.

- [x] Render the manual branch; do not call `onDownload`.
- [x] Run `bun test packages/ui/src/stores/useUpdateStore.test.ts` and type-check.

### Task 5: Background scheduler, auto-download, skip, and setting

**Files:**
- Create: `packages/ui/src/hooks/useUpdateScheduler.ts`
- Modify: `packages/ui/src/components/session/SessionSidebar.tsx`
- Modify: `packages/ui/src/components/sections/openchamber/AboutSettings.tsx`
- Modify: `packages/ui/src/stores/useUpdateStore.ts` (`checkForUpdates({ manual })`, `dismiss` records skip)
- Modify: `packages/ui/src/lib/i18n/messages/en.settings.ts`, `zh-CN.settings.ts` (and other locale files only if the key type requires it)
- Test: `packages/ui/src/stores/useUpdateStore.test.ts`

**Interfaces:**
- Constants: `oc.updates.autoCheck`, `oc.updates.skippedVersion`.
- `checkForUpdates({ manual: true })` clears the skipped version.
- Scheduler: 30 s after mount, then every 6 h; only Electron desktop; skip when auto-check is `'0'`.
- Windows: auto `downloadUpdate()` when available; dialog opens on `downloaded`.
- macOS: dialog opens on `available`.
- About: a switch in the update section, default on.

- [x] Unit-test manual clearing and dismiss persistence.
- [x] Implement the hook and effects.
- [x] Add the toggle and translations.
- [x] Type-check/lint and a packaged manual check.

### Task 6: Validation and release checklist

- [ ] `bun run type-check`, `bun run lint`, focused tests, `bun run check:changed`.
- [ ] Build/package the macOS app; launch; verify `desktop_check_for_updates` returns no update or the fixture.
- [ ] Windows: needs a real machine; document the manual test (install 2.7.2, publish 2.7.3 feed, download/restart).
- [ ] Update `docs/specs/2026-10-24-auto-update.md` with any deviation.
