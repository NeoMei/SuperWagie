# Windows x64 validation

## Final source and installed-package results

Evidence snapshot: 2026-10-23. The final executable source is `39aa517cf72e1846276921e5da1ee6babf053b16`, based on `562c90211a4609a1b88ba6cfe57da1de1d55e386`, in `D:\MyDocuments\codexprojects\SuperWagie-Open` on `codex/windows-native-validation`. Later edits to this evidence document do not change the source or package identity below. Logs and receipts are retained in `D:\MyDocuments\codexprojects\SuperWagie-Open-Windows-Evidence`. Commands in the reproduction sections are instructions, not additional passing results.

| Gate | Status and evidence |
| --- | --- |
| Final source gate and review | PASS: complete `check:changed` against the base above and independent coordinator review on the final source |
| Final artifact-route regressions | PASS: 57 tests, comprising PluginPane 15, creation artifact discovery 20, creation-link caller 16 and neighboring regressions 1 + 5. The creation stat regression uses real WebFilesAPI/runtimeFetch with controlled HTTP containment. Independent review also exercised real `registerFsRoutes`: an A-scoped request for B's file returned 400 and the B-scoped request returned 200 |
| Final full build attempt | FAIL at executable resource editing: `electron-build-final-source-workspace.log` completed web build and native rebuild, then rcedit failed to commit the output executable's resources. The failed output is preserved as `failed-source-workspace-unpacked` |
| Final packaging retry | PASS: after isolating the old output, the package-only retry in `package-final-clean-output-retry.log` exited 0. All 2193 packaging input files had the same combined SHA-256 before and after the retry, recorded in `final-packaging-inputs-before.json` and `final-packaging-inputs-after.json`. This is not a successful exit of the preceding full pipeline |
| Final NSIS installation | PASS: the installer below exited 0 into `<evidence>\installed`; installed executable and app.asar hashes match the package, recorded in `final-installation.json` |
| Final signature | NotSigned. Signed distribution was not validated |
| Final installed API smoke | PASS: 5 checks in `final-installed-api-smoke.json`, covering PowerShell PTY with Chinese cwd, project handling, UTF-8 file roundtrip, absolute artifact access, and task/schedule persistence |
| Final native task checkbox | PASS: native interaction persisted `[x]` in the QA task file; `notificationRemoved` is true and matching schedule count is 0, recorded in `final-native-task-completion.json` |
| Final restart persistence | PASS: `final-restart-persistence.json` confirms the completed task remains checked after restart, its notification remains removed and schedule count remains 0 |
| Final loaded modules | PASS for the observed processes: `final-installed-modules.json` records packaged conpty loading, OpenCode temporary files under the QA directory, and no WinLibs, LLVM or VS DLL paths. Registry PATH discovery remains enabled |
| Final native cross-project artifact | PASS: an A Chat draft opened B's HTML in the chat panel, with `WINDOWS_ARTIFACT_OK` and green same-directory `RELATIVE_RESOURCE_OK` rendered. `final-native-html-draft.json` records `selectionsUnchanged`, `draftPreserved` and `artifactInChatPanel` all true. `WINDOWS_DRAFT_KEEP` remained unsent; no manual switch to B. Before/after receipts are `final-chat-draft-before.json` and `final-chat-artifact-after.json`; screenshot is `final-native-html-draft.jpg`. This covers a draft; a native existing-conversation run is NOT_RUN |
| Final real-provider reply | BLOCKED by upstream usage quota: the normal session/prompt path reached `open.bigmodel.cn` for `zhipuai-coding-plan/glm-5.3-flash`, which returned `provider.rate-limit`, status 429 and error code 1310. Assistant text remained empty. `final-provider-session-contract.json` records the result; no successful assistant reply was obtained |
| Final provider-session stop | PASS: `final-session-stopped.json` records `active: false` and `idleOutcome: interrupted`. `final-native-model-interrupted.jpg` shows the prompt, GLM 5.3 Flash and the stopped state; quota evidence comes from the API receipts, not this screenshot |
| Final owned-process cleanup | PASS: `final-owned-cleanup-complete.json` records 0 processes from the installed test path and 0 listeners on ports 49331 and 9323. The original daily OpenChamber retains 4 processes. Original credential bytes and before/after shutdown hashes are unchanged |
| Final credential residue check | PASS: `final-credential-residue-complete.json` records a scoped scan of 2751 files and 273318703 bytes, with 0 matches, 0 unreadable files and 0 skipped external links |

The combined packaging-input SHA-256 is `2d0a57160e5ca81634ad1c58d92df5a3b9327cda3fb31b6f33e70489e2935250`. The final installer is `D:\MyDocuments\codexprojects\SuperWagie-Open\packages\electron\dist\SuperWagie-2.6.1-win-x64.exe`, 322308048 bytes.

| Final artifact | SHA-256 |
| --- | --- |
| Installer | `65f67b6ef0780cce79e2fff959671a5f115e9364a2b10919d9e91e5801e0c165` |
| Application executable | `18d9ba0b24b6c293fdeb9fd76822293d0dc16b79f622df7755d4d475de715992` |
| app.asar | `a69db2e3e1deb36708c6cb8b453c5fe3846c094942ca8301c3a956be4b09731e` |

The knowledge binary was unchanged by the final source freeze. Its earlier installed-resource run with Windows-only PATH passed startup, HTTP 200 health, temporary registration/login, knowledge-base creation and text upload. Import then failed with `failed to get embedding model: model ID cannot be empty`; model count and chunk count were both 0. Semantic retrieval and OCR are NOT_RUN, and that run made no external model call. The owned knowledge process was stopped, its port rebound, and its isolated runtime state removed. Successful upload does not establish completed ingestion.

The normal provider run received HTTP 200 for `GET /api/model`, `GET /api/provider`, `POST /api/session`, `POST /api/session/{id}/prompt` and the message read. The asynchronous provider retry carried the quota error above. `final-provider-quota-receipt.json` and `final-provider-session-contract.json` record `BLOCKED_EXTERNAL_QUOTA`. The original message was "您已达到每周/每月使用上限，您的限额将在 2026-10-26 09:37:54 重置。" The upstream response did not specify a timezone; this record does not convert that reset time. A separate initial `experimental/generate` diagnostic returned HTTP 503 with an unresolved cause. That diagnostic is distinct from the confirmed quota failure on the normal session path. The normal session was interrupted and the test processes were stopped; no assistant reply is claimed.

The run is closed in `FINAL-RECEIPT.md`, with no acceptance action still in progress. No executable source changes or rebuild occurred after these final package checks. Release CI parity, Windows ARM64, signed distribution, clean Windows without developer tools, semantic retrieval and OCR are NOT_RUN. The real-provider reply is BLOCKED by usage quota. Cross-project routing in an existing conversation has source-test coverage but its native acceptance is NOT_RUN. API checks establish only the operations named above.

The intermediate `final-pre-provider-shutdown.json` also passed with owned processes 0 and listeners 0 while the daily OpenChamber retained 4 processes. The final package was subsequently relaunched for the provider check; the final cleanup receipts above cover that last run.

## Historical candidate and diagnostic results

These results explain the fixes and retain earlier failures. They do not substitute for the final package receipts above.

| Earlier gate | Result and boundary |
| --- | --- |
| SDK/UI regressions | PASS: 50 tests in 5 isolated files; filesystem operations substituted in integration tests |
| Windows owner case equivalence | PASS: openFileTarget 27 tests, following 21 pass/6 fail before the fix; drive/UNC comparison folds case, POSIX remains case-sensitive, and sibling/traversal checks remain |
| Earlier artifact-route regressions | PASS: 56 tests before the final real-WebFilesAPI stat regression; superseded by the final 57-test result |
| Dev static workbench and native checkbox | PASS at UI level; checked state persisted as `[x]`, matching notification removed and API count 0 |
| Dev static terminal, project and file APIs | PASS: native terminal command/Chinese cwd, creation directory with Chinese characters and spaces, and guest UTF-8 file write/read |
| Earlier UI create-task | Session creation succeeded; model-assisted task creation was BLOCKED by external BigPickle quota. This does not establish the final provider result |
| Knowledge build | PASS: WinLibs/GNU archive, full Go service link and staging. Earlier MSVC/LLVM link FAIL retained in `embedded-knowledge-mingw-sqlite.log` |
| Packaging helper regressions | PASS: 16 tests covering offline GNU patch/cache identity 10, npm staging 3 and Git Bash selection 3 |
| HMR UI load | PASS at port 5373; controlled live-edit hot reload remains NOT_RUN |
| AnyDoc parsing | PASS: 4 real GNU-linked tests for CSV, DOCX with image, garbage rejection and deeply nested PDF recovery in `anydoc-gnu-parser-tests.log`, exit 0 |
| Earlier pre-commit gate | PASS: type-check, lint with 3 existing warnings, Knip with 0 findings and no new anti-slop findings in `check-candidate-fixed.log`, exit 0 |
| Native rebuild | PASS: Electron 44.9.0 in `native-rebuild-spectre.log`, exit 0; original node-pty binding hash restored. Direct-GYP lookup tests passed 4 cases including partial-setup restoration |
| Parser executable with Windows-only PATH | PASS: all 4 AnyDoc tests in `anydoc-clean-path-fixed.log`; this is separate from desktop clean-VM and ingestion acceptance |
| Candidate full Windows build | PASS at `fceea6626432131863b291ac25a104d6bd30efb2`: `electron-build-release-candidate.log`, exit 0, NSIS x64, Electron 44.9.0 and OpenCode 2.0.32 |
| Candidate installation and isolation | PASS: NSIS exited 0, installed hashes matched, signature NotSigned. Checked QA runtime home/profile, SQLite session_v2 count 0 and HTTP session count 0 before smoke. The native window was selected by installed executable path; an earlier screenshot was inconclusive and did not establish a data leak |
| Candidate installed API smoke | PASS after a separate terminal retry using discovered Windows PowerShell. The first terminal attempt failed because the test hardcoded unavailable pwsh. Project/file/task checks passed |
| Candidate native task completion | PASS: checkbox persisted `[x]` and matching notification count became 0 |
| Candidate HTML artifact | Rendered after manually aligning the chat draft with its owning project. Direct workbench-card routing FAILED from a Chat draft because the tab and panel used different directory keys; this led to the final source correction |
| Candidate loaded modules | Packaged conpty loaded; no observed WinLibs, LLVM or VS runtime module paths in Electron, OpenCode or knowledge |
| Standalone knowledge startup | PASS: production binary with Windows-only PATH, isolated SQLite and HTTP 200 health; owned child stopped |

The historical candidate installer was 322306964 bytes with SHA-256 `880ea3809534f36619fd5ba5a6f898876bdf66727ed2f1d24b8bb26abf9652be`. Its executable SHA-256 was `5cc36c94d74a3287c9dd525d60452fd7da0349103965451851412a23fde51e9a`; app.asar was `f6b46c6e40a2ff02f87d8af3505c0be886a891589d695e24bb68440a593ccd45`. These identify the package before the final artifact-routing correction.

Preserve failures and retries separately. Run builds serially against stable source and use a disposable profile, never an existing daily profile.

## 1. Build shell and prerequisites

This run used Node 24.18.0, npm 12, Bun 1.4.3, VS 2026 BuildTools with C++/Windows SDK, Rust 1.97.1, Go 1.26.3, Git for Windows with Git Bash, Python for native rebuilds, and WinLibs GCC 16.2.0 POSIX UCRT for knowledge compilation. These are the tested versions, not minimum supported versions. Keep Rust's MSVC default and add the GNU target below.

Native node-pty requires the matching **C++ Spectre-mitigated libraries for x64/x86**, component `Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre`; keep `/Qspectre` and `SpectreMitigation=Spectre` enabled. Missing libraries produce MSB8040 even when ordinary C++ tools are installed.

This non-administrator validation used the official installed VS catalog at `C:\ProgramData\Microsoft\VisualStudio\Packages\_Instances\0961aaa4\catalog.json` to download `Microsoft.VC.14.50.18.0.CRT.x64.Desktop.spectre.base`, version `14.50.35721`, SHA-256 `1f4a7d1c46d7f5a7f10b7e479bad25511503ecd2c7e27d3555bb31d533587686`. Its extracted `Contents\VC\Tools\MSVC\14.50.35717\lib\spectre\x64` matches the installed compiler. Nothing was installed into VS or the registry.

For this scoped alternative, an external `msvc-spectre-x64.props` was supplied through the build process's `ForceImportAfterCppProps`. The file only redirects the required Spectre library location and prepends it to the linker search path, guarded by exact compiler version and x64 architecture:

```xml
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup Condition="'$(Platform)' == 'x64' and '$(VCToolsVersion)' == '14.50.35717'">
    <VC_LibraryPath_VC_Desktop_CurrentPlatform_spectre>$(MSBuildThisFileDirectory)msvc-spectre-x64\Contents\VC\Tools\MSVC\14.50.35717\lib\spectre\x64</VC_LibraryPath_VC_Desktop_CurrentPlatform_spectre>
    <LibraryPath>$(VC_LibraryPath_VC_Desktop_CurrentPlatform_spectre);$(LibraryPath)</LibraryPath>
  </PropertyGroup>
</Project>
```

Set `$env:ForceImportAfterCppProps` to that file only in the build shell. MSBuild property output confirmed the matching library directory and `SpectreMitigation=Spectre`; the compiler command log retained `/Qspectre`. Ordinary machines with the component installed do not need this override. The tools and props file are not packaged or committed.

Adjust the three root paths and Bun executable for your machine. Extract the verified WinLibs archive so its `mingw64\bin` is under `$validationTools\winlibs`; installation of tools alone is not validation.

```powershell
$validationRepo = 'D:\MyDocuments\codexprojects\SuperWagie-Open'
$validationTools = 'D:\MyDocuments\codexprojects\SuperWagie-Open-Windows-Tools'
$validationEvidence = 'D:\MyDocuments\codexprojects\SuperWagie-Open-Windows-Evidence'
$validationBun = Join-Path $validationTools 'node_modules\@oven\bun-windows-x64\bin\bun.exe'
$validationWinlibs = Join-Path $validationTools 'winlibs\mingw64\bin'
$env:Path = (Split-Path $validationBun) + ';' + $env:Path
Set-Location -LiteralPath $validationRepo
node --version
node -p "process.platform + ' ' + process.arch"
npm.cmd --version
& $validationBun --version
rustc --version
rustup show active-toolchain
rustup target add x86_64-pc-windows-gnu
if ($LASTEXITCODE -ne 0) { throw 'GNU Rust target installation failed' }
rustup target list --installed
go version
git --version
git branch --show-current
git rev-parse HEAD
git status --short
& 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\Launch-VsDevShell.ps1' -Arch amd64 -HostArch amd64
Get-Command cl.exe, link.exe, python.exe | Select-Object Name, Source
```

Require `win32 x64` and Git Bash adjacent to Git for Windows. The historical LLVM-MinGW attempt failed. The successful build uses `winlibs-x64-gcc16.zip`, obtained via winget package `BrechtSanders.WinLibs.POSIX.UCRT`. Verify its SHA-256 and select the GCC executables:

```powershell
$validationArchive = Join-Path $validationTools 'winlibs-x64-gcc16.zip'
if ((Get-FileHash -LiteralPath $validationArchive -Algorithm SHA256).Hash -ne 'd5dbafc4a170e762ca6143151ec918fb9e2c72736fb14cd704abebc6bdd5276a') {
    throw 'WinLibs archive hash mismatch'
}
$env:Path = $validationWinlibs + ';' + $env:Path
$env:CC = Join-Path $validationWinlibs 'x86_64-w64-mingw32-gcc.exe'
$env:CXX = Join-Path $validationWinlibs 'x86_64-w64-mingw32-g++.exe'
$env:CGO_ENABLED = '1'
$env:OPENCHAMBER_TARGET_ARCH = 'x64'
$env:OPENCHAMBER_EMBEDDED_KNOWLEDGE_COMMIT = 'f5adb9eac166e7d3da7dceed7aa50049d4c4db1f'
& $env:CC --version
& $env:CXX --version
```

### SQLite header workaround

The sqlite-vec compile needs headers from the locked `github.com/mattn/go-sqlite3@v1.14.24` module. Download that exact module if needed, then copy its headers without modifying module-cache sources.

```powershell
go mod download github.com/mattn/go-sqlite3@v1.14.24
if ($LASTEXITCODE -ne 0) { throw 'SQLite module download failed' }
$validationGoModCache = go env GOMODCACHE
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve GOMODCACHE' }
$validationSqliteSource = Join-Path $validationGoModCache.Trim() 'github.com\mattn\go-sqlite3@v1.14.24'
$validationSqliteInclude = Join-Path $validationTools 'sqlite-include'
New-Item -ItemType Directory -Path $validationSqliteInclude -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $validationSqliteSource 'sqlite3-binding.h') -Destination (Join-Path $validationSqliteInclude 'sqlite3.h') -Force -ErrorAction Stop
Copy-Item -LiteralPath (Join-Path $validationSqliteSource 'sqlite3ext.h') -Destination (Join-Path $validationSqliteInclude 'sqlite3ext.h') -Force -ErrorAction Stop
$env:CGO_CFLAGS = '-I' + $validationSqliteInclude.Replace('\', '/')
$env:GOFLAGS = '-p=2'
$env:CARGO_BUILD_JOBS = '2'
go env GOOS GOARCH CGO_ENABLED CC CXX CGO_CFLAGS GOFLAGS
```

`GOFLAGS=-p=2` and `CARGO_BUILD_JOBS=2` limit build parallelism for an approximately 12 GB machine; they do not cap total memory. With the default paths, `CGO_CFLAGS` is `-ID:/MyDocuments/codexprojects/SuperWagie-Open-Windows-Tools/sqlite-include`. Knowledge staging retains `sqlite_fts5,anydoc` and selects `TARGET=x86_64-pc-windows-gnu` automatically. Installing the target or selecting GCC alone does not prove linking. Leave MSVC available for Electron native tooling.

This machine also needs the matching Spectre library override described above:

```powershell
$env:ForceImportAfterCppProps = Join-Path $validationTools 'msvc-spectre-x64.props'
if (!(Test-Path -LiteralPath $env:ForceImportAfterCppProps)) { throw 'Matching Spectre library props missing' }
```

Use that override only when the matching Visual Studio component is absent. The scripts locate npm, Bun and Git Bash, choose the GNU Rust target, apply the identity-checked knowledge patch and handle node-pty's GYP lookup. They do not install toolchains, install the Rust target, select GCC or supply SQLite headers and Visual Studio components. `CC`, `CXX`, GCC's `bin` on `PATH` and `CGO_CFLAGS` remain build-shell inputs. The recorded Spectre override is specific to this compiler version and machine.

The [release workflow](../../.github/workflows/release.yml) and [desktop smoke workflow](../../.github/workflows/release-desktop-smoke.yml) run individual packaging stages and omit `prepare:superweb` and `prepare:embedded-knowledge`. They also do not provision the GNU knowledge toolchain. The root `electron:build` entry includes those stages. This run establishes the local x64 build stages and the packaging retry recorded above; equivalent CI output is NOT_RUN. Windows ARM64 is also NOT_RUN: the knowledge helper currently selects `x86_64-pc-windows-gnu` independently of the Electron target architecture. No CI changes are part of this validation.

## 2. Install, SDK and focused tests

Run in the build shell. Frozen install runs postinstall; the explicit SDK build refreshes distribution output after source fixes.

```powershell
& $validationBun install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Frozen install failed' }
& $validationBun run --cwd packages/sdk build
if ($LASTEXITCODE -ne 0) { throw 'SDK build failed' }
$validationTests = @(
    './packages/sdk/src/contract.test.ts'
    './packages/ui/src/lib/guests/openFileTarget.test.ts'
    './packages/ui/src/lib/guests/sessionArtifacts.test.ts'
    './packages/ui/src/lib/guests/files.test.ts'
    './packages/ui/src/lib/guests/files.windows.test.js'
)
foreach ($validationTest in $validationTests) {
    & $validationBun test --tsconfig-override ./packages/ui/tsconfig.json $validationTest
    if ($LASTEXITCODE -ne 0) { throw "Regression failed: $validationTest" }
}
$validationPackagingTests = @(
    './packages/electron/scripts/prepare-superweb-resource.test.mjs'
    './scripts/lib/git-bash-executable.test.mjs'
    './scripts/lib/bun-executable.test.mjs'
    './packages/electron/scripts/windows-executable.test.mjs'
    './packages/electron/scripts/embedded-knowledge-windows.test.mjs'
    './packages/electron/scripts/node-pty-gyp-lookup.test.mjs'
    './packages/electron/windows-file-replace.test.mjs'
)
foreach ($validationTest in $validationPackagingTests) {
    node --test $validationTest
    if ($LASTEXITCODE -ne 0) { throw "Regression failed: $validationTest" }
}
```

Historical SDK/UI red counts in that order were 7/3, 10/1, 3/10 and 4/1 pass/fail; the fifth file was added after fixes. Green counts were 10/0, 11/0, 13/0, 5/0 and 11/0. These source-alias tests do not validate SDK distribution output, live UNC shares or native UI. The final artifact-route 57-test result and independent real-route containment reproduction are recorded separately above. Packaging-test results require their own run record.

## 3. Knowledge staging, parser tests and packaging

With the build environment above, stage knowledge first. `prepare-embedded-knowledge.mjs` invokes `embedded-knowledge-windows.mjs` to select GNU and idempotently apply the tracked `embedded-knowledge-windows-gnu.patch` to the pinned source. Unknown or partially patched sources are rejected; do not manually edit the cached checkout. The manifest records the target and patch SHA as `windowsPatch.target` and `windowsPatch.sha256` (hash of LF-normalized patch text).

```powershell
& $validationBun run --cwd packages/electron prepare:embedded-knowledge
if ($LASTEXITCODE -ne 0) { throw 'Knowledge preparation failed' }
```

After successful staging, run the real AnyDoc parser regressions from the cached source, retaining the same compiler/header environment. These four tests passed on the GNU build; packaged PDF/Office ingestion remains a separate, unproven gate.

```powershell
Push-Location -LiteralPath (Join-Path $validationRepo 'packages\electron\.cache\embedded-knowledge\src')
try {
    go test -tags anydoc -count=1 ./internal/infrastructure/docparser/anydoc -run 'TestConvertCSV|TestConvertDocxWithEmbeddedImage|TestConvertRejectsGarbage|TestDeeplyNestedPDFFailsWithoutKillingTheProcess'
    if ($LASTEXITCODE -ne 0) { throw 'AnyDoc parser regression failed' }
} finally {
    Pop-Location
}
```

Then run the changed-scope gate and full packaging from the repository root:

```powershell
& $validationBun run check:changed -- --base 562c90211a4609a1b88ba6cfe57da1de1d55e386
if ($LASTEXITCODE -ne 0) { throw 'check:changed failed' }
$validationBuildStarted = Get-Date
& $validationBun run electron:build
if ($LASTEXITCODE -ne 0) { throw 'electron:build failed' }
& $validationBun run --cwd packages/electron verify:opencode-cli:packaged
if ($LASTEXITCODE -ne 0) { throw 'Packaged OpenCode verification failed' }
```

Knowledge staging may reuse a matching manifest, including its Windows target and patch hash. To request fresh staging, run `node ./packages/electron/scripts/prepare-embedded-knowledge.mjs --force` with no other build active. Cache reuse is not evidence of fresh compilation. Retain failed build logs separately from successful retries.

`electron:build` stages SuperWeb, web assets, OpenCode, ripgrep and knowledge, then bundles main, rebuilds native modules and runs electron-builder/NSIS. The Electron workspace's plain `build` is a no-op. Without `CSC_LINK` or `WINDOWS_CSC_LINK`, `package.mjs` disables signing identity discovery and builds unsigned. Neither Windows CI job supplies Windows signing configuration in the checked source. Verify the actual installer with Authenticode; successful packaging does not establish signed distribution.

The final run reached rcedit after web/native completion and failed while committing executable resources. Its output was preserved, the old output was isolated, and only packaging was retried with unchanged inputs. For this failure, a packaging-only reproduction from `packages/electron` is `node ./scripts/package.mjs --win --x64 --publish=never`, followed by packaged verification. Retain the original failure log and compare all packaging inputs before and after; do not attribute the retry's exit 0 to the preceding `electron:build` command. A changed input set requires new build evidence.

After successful packaging, hash the fresh installer and packaged runtime files:

```powershell
$validationPackage = Get-Content './packages/electron/package.json' -Raw | ConvertFrom-Json
$validationDist = Join-Path $validationRepo 'packages\electron\dist'
$validationInstaller = Join-Path $validationDist "SuperWagie-$($validationPackage.version)-win-x64.exe"
$validationUnpacked = Join-Path $validationDist 'win-unpacked'
$validationApp = Join-Path $validationUnpacked "$($validationPackage.build.productName).exe"
if ((Get-Item -LiteralPath $validationInstaller -ErrorAction Stop).LastWriteTime -lt $validationBuildStarted) { throw 'Stale installer' }
$validationArtifacts = @($validationInstaller, $validationApp) + @(
    'resources\app.asar'
    'resources\opencode-cli\opencode.exe'
    'resources\ripgrep\rg.exe'
    'resources\embedded-knowledge\embedded-knowledge-server.exe'
) | ForEach-Object { if ([IO.Path]::IsPathRooted($_)) { $_ } else { Join-Path $validationUnpacked $_ } }
foreach ($validationArtifact in $validationArtifacts) {
    $validationItem = Get-Item -LiteralPath $validationArtifact -ErrorAction Stop
    [pscustomobject]@{ Path = $validationItem.FullName; Bytes = $validationItem.Length; ModifiedUtc = $validationItem.LastWriteTimeUtc; SHA256 = (Get-FileHash -LiteralPath $validationArtifact -Algorithm SHA256).Hash }
}
Get-AuthenticodeSignature -LiteralPath $validationInstaller | Select-Object Path, Status
$validationKnowledgeRoot = Join-Path $validationUnpacked 'resources\embedded-knowledge'
$validationManifest = Get-Content (Join-Path $validationKnowledgeRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($validationManifest.commit -ne 'f5adb9eac166e7d3da7dceed7aa50049d4c4db1f') { throw 'Knowledge pin mismatch' }
$validationPatchJson = node --input-type=module -e "import { windowsPatchIdentity } from './packages/electron/scripts/embedded-knowledge-windows.mjs'; console.log(JSON.stringify(windowsPatchIdentity('win32')))"
if ($LASTEXITCODE -ne 0) { throw 'Cannot read tracked patch identity' }
$validationPatch = $validationPatchJson | ConvertFrom-Json
if ($validationManifest.windowsPatch.target -ne $validationPatch.target -or $validationManifest.windowsPatch.sha256 -ne $validationPatch.sha256) { throw 'Knowledge patch identity mismatch' }
if ((Get-FileHash -LiteralPath (Join-Path $validationKnowledgeRoot $validationManifest.binary) -Algorithm SHA256).Hash -ne $validationManifest.binarySha256) { throw 'Knowledge hash mismatch' }
```

Verify actual executable names and x64 PE architecture if packaging changes the layout. Hashes do not prove signing, installation, runtime behavior or publication.

## 4. Isolated native launch

Use a fresh PowerShell session and a new QA directory per mode. Define the path variables from section 1 in that session; the setup below is self-contained and needs no existing launch script or profile.

```powershell
Get-ChildItem Env: | Where-Object {
    $_.Name -match '^(OPENCHAMBER_|OPENCODE_)' -or $_.Name -in @('NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE')
} | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
$validationQa = Join-Path $validationEvidence ('qa-windows-x64-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$env:HOME = Join-Path $validationQa 'home'
$env:USERPROFILE = $env:HOME
$env:APPDATA = Join-Path $env:HOME 'AppData\Roaming'
$env:LOCALAPPDATA = Join-Path $env:HOME 'AppData\Local'
$env:OPENCHAMBER_DATA_DIR = Join-Path $env:HOME '.config\openchamber'
$env:OPENCHAMBER_DESKTOP_USER_DATA_DIR = Join-Path $validationQa 'profile'
$env:OPENCODE_CONFIG_DIR = Join-Path $validationQa 'opencode-config'
$env:OPENCODE_DB = Join-Path $validationQa 'opencode.db'
$env:XDG_CACHE_HOME = Join-Path $validationQa 'cache'
$env:XDG_DATA_HOME = Join-Path $validationQa 'localappdata'
$env:XDG_CONFIG_HOME = Join-Path $validationQa 'config'
$env:XDG_STATE_HOME = Join-Path $validationQa 'state'
$env:OPENCHAMBER_ELECTRON_REMOTE_DEBUGGING_PORT = '9322'
$env:OPENCHAMBER_HMR_API_PORT = '4391'
$env:OPENCHAMBER_HMR_UI_PORT = '5373'
$env:OPENCHAMBER_RELAY_HOST = 'off'
$env:Path = (Split-Path $validationBun) + ';' + $env:Path
@(
    $env:HOME, $env:APPDATA, $env:LOCALAPPDATA, $env:OPENCHAMBER_DATA_DIR,
    $env:OPENCHAMBER_DESKTOP_USER_DATA_DIR, $env:OPENCODE_CONFIG_DIR,
    $env:XDG_CACHE_HOME, $env:XDG_DATA_HOME, $env:XDG_CONFIG_HOME, $env:XDG_STATE_HOME
) | ForEach-Object { New-Item -ItemType Directory -Path $_ -Force | Out-Null }
Set-Location -LiteralPath $validationRepo
```

`OPENCHAMBER_DATA_DIR` must be the isolated home's `.config\openchamber` directory so the workbench literal `~/.config/openchamber/tasks.md` matches the server `taskFile`. `qa\data` breaks that agreement. Keep `OPENCODE_CONFIG_DIR` separate. Use `$env:HOME` here; PowerShell's automatic `$HOME` may still refer to the normal user.

Physically create both `home\AppData\Roaming` and `home\AppData\Local` before Electron starts; its known-folder lookup requires them. Read back effective profile, task-file and document paths and confirm containment under the QA root. Use free ports and a clean local-launch environment without inherited remote/skip-server overrides.

For HMR, leave `OPENCHAMBER_ELECTRON_USE_BUNDLED_UI` unset:

```powershell
& $validationBun run electron:dev
```

The HMR UI has fully loaded at port 5373. A controlled live edit without restarting Electron remains a separate check. For bundled development, use another isolated session:

```powershell
$env:OPENCHAMBER_ELECTRON_USE_BUNDLED_UI = '1'
& $validationBun run electron:dev
```

This builds web assets but remains development mode. After packaging, recreate `$validationApp` from the hash block in a fresh isolated session:

```powershell
if (!(Test-Path -LiteralPath $validationApp)) { throw 'Packaged application missing' }
Start-Process -FilePath $validationApp -WorkingDirectory (Split-Path $validationApp) -PassThru | Select-Object Id, ProcessName
```

Check the packaged `openchamber-ui://app` origin and runtime bootstrap. Match the native window and browser target to the exact installed executable and PID before acceptance; a window title alone can select the daily OpenChamber. Packaged apps ignore the development debugging variable; pass `--remote-debugging-port=<free-loopback-port>` when needed. A client bearer may be absent for the local desktop instance. Read only the applicable runtime headers in memory and never serialize credentials. An unpacked launch does not validate NSIS installation. The final NSIS was installed into the designated evidence directory, with the existing OpenChamber installation left in place; uninstall and clean-VM coverage remain separate.

## 5. Functional coverage and unvalidated cases

Record results separately for dev static, HMR, bundled development and packaged mode. Existing API passes in the results table cover only their stated operations.

- Final installed checkbox persistence, matching notification deletion and their survival across restart pass. Model-assisted task creation is NOT_RUN; the real-provider reply was blocked by quota.
- Final A-draft to B-artifact HTML/relative-resource rendering and draft preservation pass. Native cross-project opening from an existing conversation remains NOT_RUN. Exercise native picker, preview, save/reopen and reveal on disposable Chinese/space paths as separate checks.
- Confirm filesystem grants and declared roots; reject other drives, sibling prefixes, traversal and undeclared UNC shares. Live UNC and real junction checks remain NOT_RUN.
- Preserve literal `%20` and marker-only Chinese header decoding; do not capture authorization values.
- Final installed PowerShell PTY/Chinese cwd and observed packaged native-module loading pass. A clean-VM run remains separate.
- Knowledge startup and upload pass for the unchanged installed resource. Ingestion failed because no embedding model was configured; PDF/Office ingestion, semantic retrieval and OCR remain unvalidated.
- Final provider reply is BLOCKED by usage quota. Session interruption, final owned-process cleanup, port release and credential-residue checks pass. Resize, minimize, tray and uninstall have no separate acceptance receipt in this record.

## 6. Runtime DLL evidence and remaining clean-VM gate

The Windows shell loader intentionally combines machine and user registry PATH values with the inherited PATH. Clearing the launch shell's PATH does not establish a toolchain-free desktop process. Final loaded-module inspection found packaged conpty and no WinLibs, LLVM or VS DLL paths in the observed processes. The independently compiled parser test executable passed all four cases with a Windows-only PATH, and the unchanged production knowledge binary started with that same PATH restriction. A clean Windows VM without developer tools has not been tested.

- Copy the complete hashed `win-unpacked` tree, or install the exact hashed installer, into a clean Windows x64 VM without developer toolchains (WinLibs, LLVM, Rust, Go, Node, Bun or VS). Use the isolated profile/known-folder setup above, but do not add Bun or compiler directories to `PATH`.
- Inspect PE imports and actual loaded-module paths for the app, native modules and knowledge server. Windows system/UCRT DLLs are expected; resolve any compiler runtime dependencies such as `libstdc++-6.dll`, `libgcc_s_seh-1.dll` or `libwinpthread-1.dll` from packaged resources, never a developer installation. Record missing-DLL errors and unexpected external paths as FAIL.
- Launch the app and knowledge server, then ingest disposable PDF/Office files and retrieve their content through the application. Exercise parsing to expose delayed DLL loads; source `go test` cannot establish toolchain-free runtime behavior.
- Record executable hashes, module origins, startup/parser results and shutdown behavior. Static linking flags or import inspection alone do not establish PASS. Unpacked runtime, installer and signing acceptance remain separate gates.

Record command, UTC time, revision/dirty files, exit code, counts, hashes and observed behavior. Keep only credential-free errors and scoped screenshots. Do not dump environment, headers, runtime bootstrap, auth files, cookies, tokens, keys or pairing URLs. For the provider run, record the response and removal of temporary credentials separately from local API smoke. SuperVideo and self-updates remain outside this validation scope.
