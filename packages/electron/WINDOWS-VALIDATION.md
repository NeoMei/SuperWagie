# Windows x64 validation

## Current results

Evidence snapshot: 2026-10-23, checkout `D:\MyDocuments\codexprojects\SuperWagie-Open`, branch `codex/windows-native-validation`, base `562c90211a4609a1b88ba6cfe57da1de1d55e386`. Commands below are reproduction steps, not additional passing results.

| Gate | Status and boundary |
| --- | --- |
| SDK/UI regressions | PASS, 50 tests in 5 isolated files; filesystem operations substituted in integration tests |
| Dev static workbench | PASS at UI level |
| Native workbench task checkbox | PASS: checked state saved as `[x]`; matching scheduled notification deleted, API count 0 |
| Native terminal command and Chinese cwd | PASS at API level in dev static mode |
| Creation directory with Chinese characters and spaces | PASS at API level in dev static mode |
| Guest UTF-8 file write/read | PASS at API level in dev static mode |
| UI create-task | Session creation succeeds; model-assisted task creation BLOCKED by external quota: default free BigPickle returns quota reached |
| Knowledge build | PASS: WinLibs/GNU archive, full Go service link and staging. Earlier MSVC/LLVM link FAIL preserved in `embedded-knowledge-mingw-sqlite.log`; startup still unproven |
| Packaging helper regressions | PASS, 16 tests: offline GNU patch and cache identity (10), npm staging (3), Git Bash selection (3) |
| HMR UI load | PASS: fully loaded at port 5373; controlled live-edit hot reload still needs separate evidence |
| AnyDoc parsing | PASS: four real GNU-linked tests for CSV, DOCX with image, garbage rejection, deeply nested PDF recovery (`anydoc-gnu-parser-tests.log`, exit 0); packaged ingestion still NOT_RUN |
| Candidate pre-commit gate | PASS: type-check, lint (3 existing warnings), Knip (0 findings), anti-slop (no new findings), `check-candidate-fixed.log`, exit 0 |
| Final Windows package | NOT BUILT: full pipeline reached native rebuild then node-pty/node-gyp failed; packaged launch, installer and signing acceptance NOT_RUN |

API passes do not establish equivalent UI interaction or packaged behavior. Preserve failures and retries separately. Run builds serially against a stable checkout and use a disposable profile, never an existing daily profile.

## 1. Build shell and prerequisites

Install the recorded prerequisites: Node 24.18.0, npm 12, Bun 1.4.3, VS 2026 BuildTools with C++/Windows SDK, Rust 1.97.1, Go 1.26.3, Git for Windows with Git Bash, and Python for native rebuilds. Keep Rust's MSVC default and add the GNU target below. Use WinLibs GCC 16.2.0 POSIX UCRT for knowledge compilation. Electron native rebuild and NSIS dependencies still need successful build evidence.

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

Require `win32 x64` and Git Bash adjacent to Git for Windows. LLVM-MinGW is a failed attempt, not a validated build path. The replacement archive is `winlibs-x64-gcc16.zip`, obtained via winget package `BrechtSanders.WinLibs.POSIX.UCRT`. Verify its supplied SHA-256 and select the real GCC executables for the pending retry:

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
go env GOOS GOARCH CGO_ENABLED CC CXX CGO_CFLAGS GOFLAGS
```

`GOFLAGS=-p=2` limits Go build parallelism for an approximately 12 GB machine; it does not cap total memory. With the default paths, `CGO_CFLAGS` is `-ID:/MyDocuments/codexprojects/SuperWagie-Open-Windows-Tools/sqlite-include`. Knowledge staging retains `sqlite_fts5,anydoc` and selects `TARGET=x86_64-pc-windows-gnu` automatically. Installing the target or selecting GCC alone does not prove linking. Leave MSVC available for Electron native tooling.

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
    './packages/electron/windows-file-replace.test.mjs'
)
foreach ($validationTest in $validationPackagingTests) {
    node --test $validationTest
    if ($LASTEXITCODE -ne 0) { throw "Regression failed: $validationTest" }
}
```

Recorded SDK/UI red counts in that order: 7/3, 10/1, 3/10, 4/1 pass/fail; the fifth file was added after fixes. Green counts: 10/0, 11/0, 13/0, 5/0, 11/0. These source-alias tests do not validate SDK distribution output, live UNC shares or native UI. Packaging-test results require their own run record.

## 3. Knowledge staging, parser tests and packaging

With the build environment above, stage knowledge first. `prepare-embedded-knowledge.mjs` invokes `embedded-knowledge-windows.mjs` to select GNU and idempotently apply the tracked `embedded-knowledge-windows-gnu.patch` to the pinned source. Unknown or partially patched sources are rejected; do not manually edit the cached checkout. The manifest records the target and patch SHA as `windowsPatch.target` and `windowsPatch.sha256` (hash of LF-normalized patch text).

```powershell
& $validationBun run --cwd packages/electron prepare:embedded-knowledge
if ($LASTEXITCODE -ne 0) { throw 'Knowledge preparation failed' }
```

After successful staging, run the real AnyDoc parser regressions from the cached source, retaining the same compiler/header environment. These tests and packaged PDF/Office parsing are separate gates; both remain pending in this snapshot.

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

`electron:build` stages SuperWeb, web assets, OpenCode, ripgrep and knowledge, then bundles main, rebuilds native modules and runs electron-builder/NSIS. The Electron workspace's plain `build` is a no-op. Missing signing configuration yields an unsigned installer.

After a successful full build, hash the fresh installer and packaged runtime files:

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
$env:OPENCHAMBER_ELECTRON_REMOTE_DEBUGGING_PORT = '9322'
$env:OPENCHAMBER_HMR_API_PORT = '4391'
$env:OPENCHAMBER_HMR_UI_PORT = '5373'
$env:OPENCHAMBER_RELAY_HOST = 'off'
$env:Path = (Split-Path $validationBun) + ';' + $env:Path
@(
    $env:HOME, $env:APPDATA, $env:LOCALAPPDATA, $env:OPENCHAMBER_DATA_DIR,
    $env:OPENCHAMBER_DESKTOP_USER_DATA_DIR, $env:OPENCODE_CONFIG_DIR,
    $env:XDG_CACHE_HOME, $env:XDG_DATA_HOME, $env:XDG_CONFIG_HOME
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

This builds web assets but remains development mode. After full packaging succeeds, recreate `$validationApp` from the hash block in a fresh isolated session:

```powershell
if (!(Test-Path -LiteralPath $validationApp)) { throw 'Packaged application missing' }
Start-Process -FilePath $validationApp -WorkingDirectory (Split-Path $validationApp) -PassThru | Select-Object Id, ProcessName
```

Check the packaged `openchamber-ui://app` origin and runtime bootstrap. Packaged apps ignore the development debugging variable. An unpacked launch does not validate NSIS installation; installation/uninstallation needs a designated test account or VM.

## 5. Remaining functional checks and evidence

Record results separately for dev static, HMR, bundled development and packaged mode. Existing API passes in the results table cover only their stated operations.

- Recheck checkbox persistence and matching notification deletion in the packaged app; both now pass in the native development workbench. Model-assisted completion remains BLOCKED by BigPickle quota; session creation alone is not completion.
- Open session artifacts from drive paths and file URLs once, in the deepest owning project. Exercise native picker, preview, save/reopen and reveal on disposable Chinese/space paths.
- Confirm filesystem grants and declared roots; reject other drives, sibling prefixes, traversal and undeclared UNC shares. Live UNC and real junction checks remain NOT_RUN.
- Preserve literal `%20` and marker-only Chinese header decoding; do not capture authorization values.
- Recheck terminal command/cwd behavior in the packaged app and inspect native-module/DLL loading.
- Verify knowledge startup, disposable PDF/Office ingestion and retrieval after compilation/linking succeeds.
- Check resize, minimize, tray, explicit Quit, owned-child cleanup, port release and state after relaunch. Stop only processes belonging to the test instance.

## 6. Toolchain-free runtime DLL gate — pending

- Copy the complete hashed `win-unpacked` tree, or install the exact hashed installer, into a clean Windows x64 VM without developer toolchains (WinLibs, LLVM, Rust, Go, Node, Bun or VS). Use the isolated profile/known-folder setup above, but do not add Bun or compiler directories to `PATH`.
- Inspect PE imports and actual loaded-module paths for the app, native modules and knowledge server. Windows system/UCRT DLLs are expected; resolve any compiler runtime dependencies such as `libstdc++-6.dll`, `libgcc_s_seh-1.dll` or `libwinpthread-1.dll` from packaged resources, never a developer installation. Record missing-DLL errors and unexpected external paths as FAIL.
- Launch the app and knowledge server, then ingest disposable PDF/Office files and retrieve their content through the application. Exercise parsing to expose delayed DLL loads; source `go test` cannot establish toolchain-free runtime behavior.
- Record executable hashes, module origins, startup/parser results and shutdown behavior. Static linking flags or import inspection alone do not establish PASS. Unpacked runtime, installer and signing acceptance remain separate gates.

Record command, UTC time, revision/dirty files, exit code, counts, hashes and observed behavior. Keep only credential-free errors and scoped screenshots. Do not dump environment, headers, runtime bootstrap, auth files, cookies, tokens, keys or pairing URLs. Use no new credentials for these local checks; model-assisted flows remain blocked without available quota. SuperVideo and self-updates remain outside this validation scope.
