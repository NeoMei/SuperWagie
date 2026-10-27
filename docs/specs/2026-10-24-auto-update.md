# Auto-update: Windows installs, macOS prompts

Status: implemented 2026-10-24 (macOS self-install verified 2.7.4 → 2.7.5);
Windows end-to-end release test pending.

## Glossary

- **Update feed** — the two static files at
  `https://github.com/NeoMei/SuperWagie-Open/releases/latest/download/`:
  `latest.json` for the app's own version check, `latest.yml` for
  electron-updater on Windows.
- **Latest release** — the published, non-prerelease GitHub release the
  `releases/latest` URL resolves to. A draft or prerelease is never an update.
- **Auto-install** — the app downloads the installer, then the user confirms a
  restart and the platform installer replaces the app.
- **Manual install** — the app tells the user a new version exists and opens
  the DMG download; the user replaces the app themselves.
- **Skipped version** — a version the user dismissed. Background checks stay
  quiet about it until a newer version appears or the user checks manually.

## Problem

SuperWagie has no working self-update. The upstream updater is complete but
`UPDATES_ENABLED` is `false` and its production feed points at
`openchamber/openchamber`; enabling it as-is would replace this build with
upstream OpenChamber. Releases also carry no `latest.json` or `latest.yml`, so
even a configured updater would find no feed. Every release currently needs a
manual download and drag-install.

The app is ad-hoc signed and not notarised. Squirrel.Mac, the updater behind
`electron-updater` on macOS, requires a stable code signature that a new
ad-hoc build cannot satisfy, so macOS cannot auto-install reliably without an
Apple Developer ID.

## Decisions

1. **Both platforms install themselves.** Windows downloads in the background
   and asks for a restart. macOS has no Apple Developer identity, so
   Squirrel.Mac cannot replace the ad-hoc bundle; SuperWagie installs its own
   update instead (see "macOS self-install"). A release without a ZIP still
   falls back to the DMG prompt.
2. **The feed is GitHub Releases.** No extra server and no update uploads.
   Checks read static files from the latest release, so they do not use the
   GitHub API and its rate limit.
3. **Checks run after launch (30 s) and every 6 hours.** A successful Windows
   check downloads in the background; the restart prompt opens when the
   download finishes. macOS opens the prompt as soon as an update is found.
4. **Releases stay manual with a manifest script.** The existing macOS
   arm64 build and Windows x64 CI build stay as they are; a new
   `bun run release:manifests` writes `latest.yml` and `latest.json` into the
   build output, and the maintainer uploads them with `gh release upload`.
5. **A setting controls background checks.** `设置 → 关于 → 自动检查更新`,
   default on, stored per device. Turning it off stops checks and background
   downloads; the menu's manual check still works.
6. **Dismissing remembers the version.** The same version does not reopen on
   the next 6-hour check; a manually requested check clears the skip.

## Implementation notes

- `UPDATES_ENABLED` (Electron) and `DESKTOP_SELF_UPDATES_ENABLED` (UI) are
  true. `SELF_UPDATES_ENABLED` stays false so the web/server update path
  cannot offer an upstream build.
- The existing `useUpdatePolling` hook carries the schedule; the separate
  scheduler file was not kept.
- The macOS check returns `installBlocked: 'manual-install'`; the dialog's
  primary action opens the DMG URL and closes. There is no in-app download.
- The first release with this client must publish `latest.yml` and
  `latest.json`; 2.7.2 is not backfilled because that build cannot read a feed.
- `scripts/release-manifests.mjs` (`bun run release:manifests`) writes both
  files and prints the `gh release upload` command.

## Feed contract

`latest.json`:

```json
{
  "version": "2.7.3",
  "notes": "<!-- release-notes:zh-CN -->中文说明<!-- /release-notes -->\n<!-- release-notes:en -->English notes<!-- /release-notes -->",
  "publishedAt": "2026-10-24T10:00:00Z",
  "mac": {
    "url": "https://github.com/NeoMei/SuperWagie-Open/releases/download/v2.7.3/SuperWagie-2.7.3-mac-arm64.dmg",
    "sha256": "…",
    "size": 415030000
  },
  "win": {
    "url": "https://github.com/NeoMei/SuperWagie-Open/releases/download/v2.7.3/SuperWagie-2.7.3-win-x64.exe",
    "sha256": "…",
    "size": 330000000
  }
}
```

`latest.yml` is the electron-updater manifest for the Windows x64 NSIS
installer: `version`, `files[]` with the exe, base64 SHA-512 and size, plus
the top-level `path`, `sha512`, `releaseDate` and `releaseNotes`. Both feeds carry
the same bilingual Markdown. There is no arm64 Windows
manifest until a complete ARM64 build exists. Differential updates are out of
scope: the installer is downloaded whole.

## Client behaviour

- **Enabled for the packaged desktop app only.** Web, VS Code and mobile keep
  their update paths off: `SELF_UPDATES_ENABLED` stays `false` so the server
  update check cannot offer an upstream OpenChamber release, while
  `DESKTOP_SELF_UPDATES_ENABLED` and the Electron `UPDATES_ENABLED` become
  `true`. The feed changes from `openchamber/openchamber` to the SuperWagie
  repository.
- **Windows:** electron-updater uses a generic feed pointing at the latest
  release. A check compares semver; when newer, the app downloads with the
  existing progress events, then opens the update dialog in its "restart to
  update" state. The installer is unsigned and per-user; SmartScreen may warn.
- **macOS:** the main process fetches `latest.json` directly (no GitHub API)
  and compares semver. When the feed carries `mac.zip`, the dialog's download
  runs the self-install path: fetch the ZIP with progress, verify SHA-256 and
  size, unpack with `ditto`, check the bundle identifier and version, then
  stage it. "Restart" writes a detached swap script that waits for this
  process to exit, moves the old bundle aside, copies the staged one into
  place, clears quarantine, deletes the backup and reopens the app; a failed
  copy restores the backup and reopens the old app. `macos-self-update.mjs`
  holds the file work and the script. A feed without `mac.zip` returns
  `installBlocked: 'manual-install'` and the primary action opens the DMG.
- **All platforms:** a failed background check is silent (logged only); a
  failed manual check shows the error. A current version equal to or newer
  than the feed is "no update". Prereleases and drafts are ignored.
- **Scheduler and skip state live in the renderer** (desktop UI), extending
  the existing `useUpdatePolling` hook: first check 30 s after launch, then
  every 6 hours. Persisted keys:
  `oc.updates.autoCheck` (`'0'` turns it off, anything else is on) and
  `oc.updates.skippedVersion`.
- **Dialog:** there is no external GitHub footer link. The manual
  macOS button says "下载安装包" and opens the DMG; Windows keeps
  "下载更新" / "重启并安装".
- **Settings:** `AboutSettings` gains the auto-check switch. It is device-local
  and does not touch the server settings file.

## Release process

Before building, compare the final source with the latest SuperWagie main
branch and run `bun run test:customizations`. This checks the workbench without
a duplicate help entry, the retained right-rail help, the two supported UI
languages, localized update notes and the release feeds. The packaging workflows
run the same command. Review changes to these tests against the owning module
decisions whenever a merge or saved snapshot replaces them.

The `--notes-file` argument is required. Its Markdown must contain nonempty
`<!-- release-notes:zh-CN --> ... <!-- /release-notes -->` and
`<!-- release-notes:en --> ... <!-- /release-notes -->` blocks. The generator
rejects missing or incomplete language blocks before writing either feed.

1. Build macOS arm64 locally and use the validated Windows x64 build. The
   Windows exe must be the complete build with embedded knowledge and
   SuperWeb; the `-INCOMPLETE-CI` artifact is not a release artifact.
2. Publish the release with the DMG, ZIP, Windows exe and SHA-256 files.
3. Run:

   ```bash
   bun run release:manifests --version 2.7.3 --notes-file /tmp/release-notes.md
   gh release upload v2.7.3 packages/electron/dist/latest.yml packages/electron/dist/latest.json --clobber
   ```

   The script finds `SuperWagie-<version>-mac-arm64.{dmg,zip}` and
   `SuperWagie-<version>-win-x64.exe` in `packages/electron/dist`, computes
   SHA-256 (feed) and base64 SHA-512 (Windows manifest) and writes both files
   next to the installers.
4. Confirm the release is published and marked latest. A missing manifest, a
   missing Windows asset or a draft release means Windows clients see "no
   update" and macOS clients see nothing.

There is no 2.7.2 backfill: that build has self-updates disabled, so it could
not read a feed. The first release that contains this client code is also the
first one to publish both manifests; users install that one manually, and from
then on Windows updates itself and macOS prompts.

## macOS self-install

- The bundle is replaced only after the app exits; the running process never
  overwrites its own files.
- The old bundle is kept at `<app>.previous` until the copy succeeds, so a
  failed update leaves a working app.
- `/Applications` is writable for the usual admin user. A non-admin account
  cannot swap the bundle; the script logs the failure, restores the app and
  reopens it, and the user can install the DMG by hand.
- The ZIP must contain exactly one `.app` at its root, with the same bundle
  identifier and the version the feed promised.
- The release flow needs the ZIP: `latest.json` now carries `mac.zip`
  (`url`, `sha256`, `size`) beside the DMG.

## Out of scope

- Developer ID signing and notarisation.
- Windows ARM64, Linux, beta/insider channels and delta downloads.
- Auto-update in web, VS Code or mobile builds.
- A rollback channel; a bad release is fixed by publishing a newer one.
- Changing the release workflow into a fully automated tag-to-release run.

## Risks

- **GitHub reachability in China.** The check and the installer both come from
  GitHub; a blocked network means no update prompt and a manual download.
- **Unsigned Windows installer.** SmartScreen may warn; the installer is
  per-user, so no administrator prompt is expected.
- **Manifest drift.** A release without `latest.yml`/`latest.json` silently
  disables updates; the release checklist and the script exist to prevent it.
- **Old clients.** Builds before this change have updates disabled and never
  see a prompt; they need one manual install of the first enabled release.
- **macOS prompt flow.** The user downloads and drags the app; there is no
  in-app progress beyond "opening the download".

## Validation

- Unit: feed resolution points at SuperWagie, never upstream; semver
  comparison; `latest.json` parsing; manifest generation (SHA-256, base64
  SHA-512, sizes, filenames, missing-asset failure).
- macOS: check against a fixture feed through the existing E2E loopback URL;
  verify the dialog opens the DMG URL and never calls the installer.
- Windows: build, install 2.7.2, publish a 2.7.3 feed, confirm check,
  background download, restart prompt and replacing the app; run on a real
  Windows x64 machine or VM before release.
- Static: type-check, lint, the Electron packaging build, and a packaged
  launch on this machine.
