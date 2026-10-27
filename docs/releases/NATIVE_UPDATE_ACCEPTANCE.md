# Native update acceptance

The [release checklist](RELEASE_CHECKLIST.md) is suspended. This macOS arm64 and
Windows x64 runbook is retained as optional reference, not an additional release
gate. Re-enable mandatory use only on explicit maintainer instruction.
If used voluntarily, store observed results in
[the acceptance record](RELEASE_ACCEPTANCE_TEMPLATE.md) under U01 through U06.
The procedure below does not establish that any native check has passed.

## Prepare the isolated installation

1. Reserve native target hardware or an appropriate native-architecture VM on each OS version selected by the checklist cadence. Record OS build, architecture and ordinary-user permissions.
2. Use a disposable OS installation or VM snapshot and a dedicated OS account. The test may replace `/Applications/SuperWagie.app` or an NSIS installation remembered by Windows.
3. Record the existing install location, executable, version and digest before installation. Keep a restorable copy of the previous app and representative profile outside the install and staging directories.
4. Copy only acceptance fixtures into the account. Record project files, history, drafts, settings and account state to compare after restart. Use a dedicated service account with an approved bounded task.
5. Record actual Electron userData, `~/.config/openchamber` or its Windows equivalent, managed runtime/data directories, keychain or credential-store scope, install path and logs before and after each relaunch.
6. Environment overrides alone do not isolate the account. `OPENCHAMBER_DESKTOP_USER_DATA_DIR` covers Electron userData; `OPENCHAMBER_DATA_DIR` covers application data. Other runtimes and credentials need their own verified scope.
7. Windows NSIS may relaunch through Explorer with its existing environment and remembered install location. macOS relaunch through LaunchServices also needs a fresh path/profile check. Keep all resulting defaults inside the disposable account and machine.
8. Keep normal OS security controls enabled. Prepare native trust evidence required by B05 independently of update transport testing.

Preparation is complete when a restore has succeeded, the previous app starts, fixture contents are recorded and every writable profile/install path belongs to the test environment.

## Freeze the bytes and identify the starting client

- N is the installed starting client. N+1 is the exact final candidate payload, with a greater version. Record both versions, source identity, architecture, filenames, sizes, SHA-256 and signing identity.
- Retain untouched candidate DMG, ZIP, NSIS EXE and original manifests. Local feeds reference copies of these same payload bytes. Never rebuild or relabel N+1 to make a test pass.
- Inspect final installed resources and the executable selected at runtime. Record bundled OpenCode and other changed component identities using T06 and T07.
- Windows local-feed N must carry `OPENCHAMBER_UPDATER_E2E_BUILD=1` during `bundle:main`. Record its source differences from the released starting client. This instrumented run has a separate result from public replay.
- The N+1 Windows installer needs no test marker. Keep production candidates free of that marker. Prepare instrumented N from the recorded source with current native packaging scripts; the inherited [fixture preparation](../../packages/electron/scripts/updater-e2e-fixture.md) supplies compile-time-gate background, while its AppImage commands apply to Linux only.
- macOS custom JSON checking currently uses runtime gates only. Verify the actual N contains that implementation before relying on it; an older implementation may require a separate documented setup.
- A missing native host, suitable starting client, trust result or safe isolation leaves the affected acceptance blocked. A Linux AppImage run covers its own platform and shared logic only.

### Legacy Windows migration

[The Windows migration contract](../../packages/electron/README.md#windows-update-channel-migration) distinguishes legacy clients from channel-capable clients.
Current x64 clients request `latest-x64.yml`. Legacy clients request architecture-blind `latest.yml`, fixed at the real 2.6.1 x64 installer.
That legacy feed deliberately offers no newer installer to the documented 2.7.x clients. Windows ARM64 remains unsupported.

For the first dedicated-channel release, test a copy of the actual legacy installation, then manually install the exact candidate x64 NSIS EXE once and verify profile preservation.
Record this as manual migration. Retain that unmodified channel-capable release as a starting client for later public self-update acceptance.
An instrumented x64 N can test candidate NSIS replacement separately. It cannot establish automatic migration of legacy clients.
The source migration does not change existing installed clients or published assets until its release is actually published.

## Construct a private loopback feed

Keep the candidate outside public Latest until promotion. Use a fresh feed directory per case, bound only to numeric loopback such as `127.0.0.1`.
Retain the original feed and a diff of local URL changes. Verify local payload digests against the frozen candidate before launch.

| Target | Feed actually read | Required local content |
| --- | --- | --- |
| macOS arm64 | `latest.json` at the complete override URL | Candidate version/notes, `mac.url` for DMG, `mac.zip.url`, ZIP SHA-256 and positive byte size |
| Windows x64 | `latest-x64.yml` under the override base URL | Candidate EXE URL/path, version, size, base64 SHA-512 and Chinese/English release notes |
| Legacy Windows migration case | Fixed `latest.yml` | Exact repository `windows-legacy-latest.yml`; preserve its absolute versioned URL and digest |

For macOS, copy the original JSON and change only DMG/ZIP URLs to absolute loopback URLs. Keep the ZIP at its accepted size and digest.
The existing fixture has no macOS staging or launch command. Manually prepare the JSON and files, then serve the directory with its existing `serve` command.
The ZIP must unpack to exactly 1 root `.app`; staging verifies bundle ID and version. Test an advertised DMG-only fallback as a separate case.

For Windows, the existing fixture supports `stage --platform win32 --arch x64` and `serve`. Run from the repository root with real absolute paths and a real candidate version substituted:

```sh
node packages/electron/scripts/updater-e2e-fixture.mjs stage --platform win32 --arch x64 --next /absolute/candidate/SuperWagie-VERSION-win-x64.exe --version VERSION --dir /absolute/test/feed
node packages/electron/scripts/verify-update-manifest.mjs /absolute/test/feed/latest-x64.yml VERSION /absolute/candidate/SuperWagie-VERSION-win-x64.exe
node packages/electron/scripts/updater-e2e-fixture.mjs serve --dir /absolute/test/feed --port 49152
```

The staged YAML omits release notes. Copy the candidate's exact bilingual `releaseNotes` into the local YAML before serving, or use the original candidate YAML with locally resolvable payload paths.
Record that feed-only difference; otherwise the client may fetch notes from the public versioned JSON feed.
The documented `run` procedure targets Linux AppImages. Native account/session launch and installer acceptance need their own verified steps. Windows ARM64 staging is refused.
Use a separate directory for legacy-feed checks. The normal x64 fixture intentionally omits `latest.yml` so its presence cannot conceal a wrong channel.

## Confirm the feed before downloading

| Target | Gates for the running N | Required evidence |
| --- | --- | --- |
| macOS custom JSON/ZIP | `OPENCHAMBER_E2E=1`; `OPENCHAMBER_UPDATER_E2E_URL=http://127.0.0.1:49152/latest.json` | `macOS update check` records `feed: 'loopback'`, candidate version and `package: 'zip'`; independently read/hash that JSON |
| Windows electron-updater | Embedded `OPENCHAMBER_UPDATER_E2E_BUILD=1`; runtime `OPENCHAMBER_E2E=1`; `OPENCHAMBER_UPDATER_E2E_URL=http://127.0.0.1:49152/` | `updater feed configured` records the exact loopback `target` and `channel: 'latest-x64'`; candidate version resolves from that feed |

Launch the installed N executable directly within the dedicated interactive account with the applicable environment. Keep `OPENCHAMBER_E2E_AUTO_INSTALL` unset so download and install remain separately observable.
The macOS custom check does not consult the compile-time marker used by Windows. Its URL points to the JSON file; the Windows URL points to a feed directory.
The shared URL parser accepts credential-free HTTP/HTTPS numeric loopback, with no query or fragment. `localhost` is rejected.

Production also logs `provider: 'generic'`. The provider name alone proves no feed isolation. On macOS the generic updater startup log does not prove which JSON the custom check read.
The global [updater-testing reference](../../.agents/skills/openchamber-change-discipline/references/updater-testing.md) describes shared shutdown evidence and older fixture assumptions; use the current platform branches and source links here for feed selection.
Stop if the selected target, JSON source, channel, payload identity or profile differs. Fix the setup before requesting a download.
The fixture server does not log requests. Add independently recorded request observation when exact request-path evidence is needed; retain the observation method and its limitations.

## Run installation and verify the restarted runtime

1. On N, use the product's update check and download controls. Record candidate version, notes and progress. Capture staging evidence before requesting restart.
2. macOS records `macOS update staged` with version, path and bytes. Windows records `update-downloaded` for a fresh download; a cached payload may complete without that event, so also verify the actual cached file and completion result.
3. Apply through the product restart action. Capture shutdown and handoff logs. Windows must reach NSIS; macOS must record `macOS update swap started` and the detached script's result in `mac-update-install.log`.
4. Verify the relaunched process executable path, architecture, installed app version and final resource hashes against N+1. Compare installed payload contents with the accepted bundle or installer extraction; an installed EXE digest need not equal its NSIS installer digest.
5. Verify the live bundled OpenCode executable path/version and resource identity before and after Restart OpenCode. Confirm the runtime reports bundled ownership and offers no separate upstream update.
6. Recheck actual userData/data/credential paths. Reopen fixtures and compare files, history, drafts, settings and account boundaries. Confirm valid login and perform the bounded acceptance conversation required by the checklist.
7. Preserve owned-process shutdown evidence and check for orphaned processes. Record unrelated external services separately.

Completion requires the new executable and expected resources running with preserved fixture data. A version label or completed download alone leaves installation unproven.

## Exercise failures on restorable copies

Reset the OS/profile snapshot between cases. Change only copied fixture feeds, transport or test-owned permissions. Never modify accepted payloads or public feeds for failure injection.

| Case | Safe setup and observable result |
| --- | --- |
| Interrupted download | Terminate only the test feed process or cut its loopback transport during transfer. Confirm a genuinely interrupted response; graceful server closure may finish active transfers. Record the error, unchanged installed version/profile, retained partial data and successful retry. |
| Invalid digest/size | Alter only a copied feed's expected digest or size. Confirm rejection before installation and verify the previous installation/profile still works. Preserve the original candidate feed. |
| macOS bundle validation | Use a separate invalid fixture with a mismatched bundle ID/version. Confirm staging rejects it. This result applies only to fixture validation. |
| Copy or installation failure | Use a disposable install path/snapshot with controlled test-owned permissions or an installer failure. Observe the actual failed operation and restored or recoverable app/profile; record the recovery performed. |
| Windows close during shutdown | Request install, then send a normal window close during backend shutdown. Require `last window closed while an update install is pending` or `window-all-closed while an update install is pending` before installer handoff. A forced process kill or a later close cannot pass this case. |
| macOS close/quit during swap preparation | Exercise the platform's real close and quit actions, record their timing and observe swap/relaunch/profile preservation. macOS has different last-window behavior; Windows quit-arbitration evidence cannot be inferred. |

The current fixture serves files; it supplies no deterministic native failure injector or shutdown timing controller. Manual timing must prove the close reached the application's own handling. Record a missed window as not exercised and repeat safely.
macOS swap recovery restores `.previous` when copying fails. Successful copy deletes that backup before relaunch, so it provides no health-based rollback of an already installed bad version.
Current macOS staging checks checksum, size, ID and version; it does not verify a trusted signing identity. The swap removes quarantine. Current packaging also sets `notarize: false` and Windows `verifyUpdateCodeSignature: false`.
Record these trust gaps against B05. A local update pass cannot pass the required trust gate.

## Containment and recovery

Choose action from observed client state and preserve evidence before cleanup. A feed change cannot remotely revoke cached metadata, downloaded installers or a running swap/NSIS process.

| Client state | Containment and recovery |
| --- | --- |
| Undiscovered | Stop promotion and repair the feed/download entry. Verify fresh checks against the corrected source. Preserve immutable artifacts and the exposure interval. |
| Discovered, download not started | Correct the feed and instruct affected test/client operators to stop the pending action and recheck. Verify stale metadata clears; do not assume the old offer disappeared. |
| Downloading | Stop further distribution where possible. Record partial/cached bytes and stop the test client normally. Clean only verified test-owned partial files after all updater processes stop, then recheck. |
| Staged or installer handed off | Stop new install requests and close affected test clients only when the platform permits it. An active swap/NSIS handoff may continue. Preserve the staged identity and use the tested local recovery procedure. |
| Installed | Use a compatible higher-version recovery build or the rehearsed app/profile restore. Preserve post-upgrade user data first. Recheck runtime, files, login and conversation. Retargeting the feed to an older version does not repair this client. |

## Public replay and evidence cleanup

After separately authorized promotion, read back complete public manifests/payloads and match accepted hashes. Clear all test overrides and use an unmodified, channel-capable released N in the isolated account for public-feed replay.
Capture the actual production target/channel or macOS `feed: 'github'`, complete native update and repeat installed runtime/profile checks. Legacy Windows still requires its one-time manual migration.
When no unmodified dedicated-channel Windows baseline exists yet, apply [the checklist's supported-platform bootstrap rule](RELEASE_CHECKLIST.md#supported-platform-matrix). A maintainer-approved migration-only scope can complete its public manual replay; record automatic public update as an unaccepted capability and assign its next higher-candidate test. A scope that advertises automatic public update remains blocked until a released baseline can exercise it. Migration and instrumented NSIS results never substitute for that result.

Attach versions, candidate/feed digests, local feed diffs, OS/account/install/profile identities, trust results, timestamped logs, runtime/resource paths and fixture comparisons to U01 through U06. Record every unexecuted case and missing tool/device explicitly.
Stop test apps, detached swap/installer processes and fixture services. Confirm their ports are closed, archive redacted logs, then remove only test-owned staging/cache/profile files. Retain the restore snapshot and accepted artifact copies under the release record's retention rule.

Implementation references: [main lifecycle and platform branches](../../packages/electron/main.mjs), [feed gates](../../packages/electron/updater-feed.mjs), [macOS verification/swap](../../packages/electron/macos-self-update.mjs), [candidate manifests](../../scripts/release-manifests.mjs), [fixed Windows legacy feed](../../packages/electron/scripts/windows-legacy-latest.yml).
