# Built-in Skills

## Ownership

The web server installs bundled skills before OpenCode scans its skill paths.
Electron uses the same in-process installer. Hosted and Capacitor mobile clients
use the installation on their server. VS Code keeps its existing discovery and
catalog flow without a new host installer. The catalog remains opt-in.

Ordinary skills live under `OPENCODE_CONFIG_DIR/skills/<name>`. SuperPPT's full
plugin lives under `<dataDir>/skills-runtime/superppt`; its discoverable skill is
an exact link to `skills/superppt` inside that runtime. A physical same-name skill
or a link into another host remains untouched. SuperVideo's pinned engine lives
under `<cacheDir>/supervideo/engines/<engineManifestSha256>`.

SuperVideo also publishes its engine in the skill directory's shared
`.supervideo-engines/<engineManifestSha256>` store, so runtimes with different
cache roots can use an installed launcher.

## Invariants

- `installBuiltinSkills` returns `{ installed, skipped, updated, failed }`.
  Preserved edits, foreign ownership and a busy writer are skipped with a bounded
  diagnostic. I/O failures are reported per skill and never abort startup.
- A conflict in another configured host prevents installation and refresh.
  Destination directories inside the managed roots must be real directories.
- Every fresh installation has a versioned `.superwagie-managed.json` receipt.
  The receipt identifies the owning skill and installation kind, release ID,
  dependency closure, complete installed file/type/executable-bit inventory, and
  opaque generated directories. It contains no machine paths or credentials.
- A matching bundle ID skips without writes, recursive reads or a writer lock.
  Before a proposed update, the installed inventory must match the receipt.
  Bundle, receipt and recovery records are parsed with Zod at the file boundary.
  A malformed receipt, changed or missing file, extra custom file or directory,
  changed executable bit, or newer recorded component version prevents refresh.
  Windows normalizes executable bits because they do not express POSIX ownership.
- Untracked legacy adoption is limited to exact SuperWeb, SuperPPT and
  WPSComposer inventories in `legacy-identities.json`. These came from the saved
  app bundle and exact 2.7.38 packaged inventories. Partial matches, version-only
  matches and arbitrary missing TypeScript files do not authorize replacement.
- Opaque legacy SuperWeb dependencies survive only when dependency closures
  match. The closure excludes only the lockfile's 2 root version fields.
  SuperPPT's changed closure blocks adoption of unknown installed dependencies.
  A receipt with tracked dependencies verifies their bytes before replacement.
- WPSComposer's `__pycache__` directories are carried unchanged. Opaque directories
  move by rename, preserving inodes, links and data written through open handles.
  Retained cache parents enter the staged inventory even when the next bundle
  removes their scripts. Their contents are never relabeled as verified
  app-owned dependency bytes.
- A complete staged tree and receipt precede live mutation. The installer checks
  the live identity again, journals the transaction, renames live to backup,
  moves opaque directories into staging, then renames staging to live. A failed
  second rename restores the old copy. A failed restoration retains the backup
  and journal. Recovery verifies payload and receipt identities before cleanup.
- A SQLite exclusive transaction serializes each destination with zero wait.
  The operating system releases the guard after process exit. An unavailable
  SQLite runtime reports a failure and leaves other application startup intact.
- A narrow existing migration still refreshes exact shipped model readers and
  the SuperVideo runtime lock. Custom readers and locks stay untouched.

- SuperVideo validates the bundled engine manifest and every listed file before
  staging and atomically publishing its digest-named cache directory. The
  installer serializes publishers using the shared store. A managed skill
  installation or refresh publishes its receipt only after both engine stores
  are complete. Legacy migration updates only an unchanged shipped launcher
  and lock. A newer or custom lock prevents whole-tree replacement. A damaged cache is preserved under an
  `incomplete-` name before replacement; a custom skill lock remains untouched.
  An interrupted installation is retried on the next server start.
  A managed receipt of any file type, including invalid bytes, prevents the
  separate legacy reader refresh from bypassing a managed-tree refusal.
- The optional vision QA reader is refreshed independently when its installed
  bytes match the known shipped version and its credentials reader matches the
  current bundled version. A missing or edited QA reader does not
  prevent the image generator readers from updating.

## Decisions

### Why release identities avoid repeated dependency traversal

`node scripts/generate-builtin-skill-identities.mjs` stamps each source payload's
`.superwagie-bundle.json` after vendoring; `--check` detects stale metadata.
The file hashes the complete source inventory and dependency closure. Resource
preparers that alter files must stamp the final staged payload too. An equal
release ID avoids hashing dependencies on every startup. Modified local files
are checked when a different bundle is proposed. Development fixtures without
metadata derive their identity by walking their source tree.

### Why staging reads files individually

Electron's asar supports `readdir`, `readFile` and `lstat`, so staging uses those
operations. Packaged `vendor/node_modules` becomes installed `node_modules` only
when `vendor` has exactly that child or the supported `modules` transport child and no normal `node_modules` competes with
it. Dependency roots must be physical directories. Internal relative dependency
links stay links; their resolved targets must stay inside the dependency tree. Other source links are refused. Task-specific
resource preparers own executable/native dependency readiness.

### Why replacement has a recovery journal

Portable Node filesystem APIs provide 2 directory renames, with a brief interval
where the live path is absent. The journal allows the next startup to restore a
valid old tree or recognize the complete new tree. Edited or ambiguous recovery
candidates remain on disk with a diagnostic. A crash during staging before the
journal exists can leave a private sibling stage; the installer does not guess
ownership and delete unjournaled directories. Filesystem path checks protect
cooperating installers; they do not prevent hostile path swaps by another process.

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

SuperVideo's bundled engine supports OpenAI-compatible, MiniMax and managed-media narration. A new
project with no explicit voice uses the selected `tts` model/voice. Existing
project voice settings remain explicit: a model mismatch fails with a remedy to
update that project's voice, instead of forwarding a key into a different
legacy adapter. System voices and host receipts remain local/host choices.
MiniMax and managed narration invoke the private resolver's synthesis action rather than
duplicating the provider request or returning credentials in an audio receipt. Managed
voice settings contain a model and voice; speed is not currently supported for this binding.
The engine manifest and runtime lock are regenerated together, and its new cache
sits beside the previous immutable engine. Modified runtime locks are preserved.

Asset publication keeps existing content intact. Filesystems without hard links
use an exclusive destination write under the project lock, then sync and close
before registering the asset. A failed write leaves the partial file unregistered
for explicit recovery; reimport refuses differing bytes rather than overwriting
them. Readers verify the full content hash before returning an asset.

Pure prompt skills inherit the Agent model and need no separate credential.
The writing dependency family is pinned to stable mattpocock/skills v1.3.2.
Its per-skill snapshots retain upstream and shipped hashes, license bytes and
named local adaptations. SuperWriter's 3 callable wrappers preserve their
OpenCode invocation metadata and existing OpenAI host policy. Existing CONTEXT
glossaries and maps retain their paths. Writing helpers use the current
customer workspace, local spec output and SuperWriter's existing stage reviews.
SuperWriter v0.2.9 includes its same-release tender template helper; its snapshot
accounts for the full shipped source subset and its local copy-safety adaptation.
Template copies reject existing and dangling final destination symlinks before
resolution. Intermediate links remain valid when the resolved destination stays
inside the project. Copy failures preserve the old output and original cause;
cleanup removes a temporary file only after allocation.
The repository installer and
development verification helpers remain outside that subset.
The editable-PPTX skill includes offline reconstruction. Live analysis requires
dedicated configured-model adapters; an image-editing key cannot enable it.
The purpose catalog lists all bundled skills and these boundaries.

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

## Presentation runtime packaging

SuperPPT and image-to-editable-pptx have complete plugin roots under
`<dataDir>/skills-runtime/<name>`. Their skill links resolve to `skills/<name>`
inside those roots. The installer prefers Electron's physical
`presentation-runtime/<name>`, then the prepared web package, then source-only
development fixtures. A vendored source without its prepared runtime fails only
that skill; unrelated skills and the server keep starting. Startup runs no npm.

The build preparer verifies every vendored source fingerprint, installs the
component's locked dependencies in disposable directories, compiles JavaScript,
prunes development dependencies, runs Sharp and SuperPPT's production tsx path,
and validates native package identities. It only accepts native build workers.
A runtime manifest records platform, architecture, Linux libc, native package
versions and the full payload hash. Packaging verifies the physical inventory;
installation rejects a target that differs from the running server.

`vendor/modules` carries production dependencies through npm packaging. Within
that closure only, `__superwagie_node_modules__` becomes `node_modules` during
managed installation. Competing normal and encoded directories are refused.
The existing `vendor/node_modules` layout remains valid for SuperWeb. Source
identities exclude generated dist, dependency and Python cache trees. Prepared
identities include the complete actual shipped closure.

The old image skill migrates only when its 2 files and directory inventory match
`image-placeholder.json` exactly. Extra files, edits, receipts and foreign links
are preserved. The complete new plugin is ready before exposure changes. A link
failure restores the old placeholder; a retained exact backup is recoverable.
Launchers use the captured server executable and scope Electron's Node mode to
the child. Machine-local launcher descriptors live beside the plugin roots.

### Why image reconstruction is offline only

The official 0.3.1 live runtime discovers an unrelated OpenCodex instance and
uses provider-specific public endpoints. The bundled CLI refuses `analyze` and
`run` before configuration or discovery, and the exported pipeline functions
refuse before reading options. `build`, `build-v1` and `raster-patch` remain
local. Dedicated configured-model adapters are required before enabling live
analysis. This restriction is unconditional in enterprise and personal modes.

### Why presentation resources are physical and native

SuperPPT source imports and editable-runtime fingerprints require TypeScript
source alongside compiled JavaScript. Electron's global archive exclusion stays
unchanged; a physical extraResource preserves that contract and the native
production closure. Web npm artifacts contain the build worker's native target.
They are not universal artifacts. Build on the deployment platform before
packing, or provide a separately prepared matching package. A foreign artifact
leaves presentation skills unavailable and does not trigger a startup install.

## SuperVideo Office input

SuperVideo 0.1.2 renders modern PPTX/DOCX pages locally with bundled browser
converters. Optional MarkItDown supplies semantic text; Python with lxml remains
the fallback when its availability probe fails. A successfully probed converter
whose conversion fails retains failure evidence and does not switch parsers.
The runtime manifest's diagnostic invocation calls the shipped `doctor` API with
`loadRuntimeConfig`. Missing lxml at the Python entry returns a structured
`DEPENDENCY_MISSING` result, so ingestion reports `needs_input` with repair
guidance. Unrelated import errors, malformed input, process crashes, timeouts and
resource limits keep their failure classifications. Python with lxml remains an
external prerequisite; startup does not install it.
The shared UI protocol stays at version 1. Web, desktop and mobile clients use
their server's engine; VS Code retains its existing external skill discovery.
Office viewing remains owned by Omni Viewer.

Package validation precedes either semantic parser. An owned worker checks ZIP
names, actual inflation, OOXML roots/content types, slide relationships and
finite page work. Parsing and rendering have hard deadlines; the parent tracks
and terminates the owned browser process and removes its temporary profile.
Browser contexts block service workers and external content requests in both
personal and enterprise modes. No provider, listener or public resource fetch
is added by Office input.

Renderer rejection may produce bounded pages labeled reconstructed text. The
original bounded diagnostic and appearance classification persist in extraction
evidence and source warnings, including cached imports and PPT planning receipts. Timeouts, limits, empty
output and screenshot failures retain a private failure workspace and publish
no Source. Registered originals remain unchanged.

### Why Office work runs in an owned process

Synchronous ZIP inflation and unresponsive browser JavaScript cannot be bounded
by an in-process Promise timeout. The owned worker lets the parent enforce a
deadline and terminate its browser even when normal close cannot finish.

### Why the PPTX table vendor patch is retained

The upstream converter throws on valid presentations with an empty table-style
list and later dereferences the missing selected style. The declared small patch
normalizes absent, single and multiple styles and retains direct table formatting.
Its original hash, shipped hash, patch and licenses ship with the engine. Built-in
theme fidelity still needs visual review.

## Excalidraw preview

The ordinary managed skill contains the pinned renderer and all font subsets.
Electron packages the complete source payload, then the existing installer copies
it from ASAR into the physical skill directory. Edited copies and custom files
retain the ordinary managed-tree preservation rules.

`excalidraw-runtime.js` supplies 4 child-only bindings for captured Node, its
mode, owned Playwright and Python. Lifecycle removes inherited values for only
these keys before current-host injection. Missing desktop resources produce an
unavailable binding; a partial or failed binding cannot select standalone code.
Source hosts without a complete owned binding retain the explicit standalone
Python Playwright route. Hosted/mobile clients execute on their server. VS Code
and external OpenCode gain no injection; remote-client desktop gains no local
runtime requirement.

Managed preview reuses physical SuperWeb Playwright and packaged Hy Python
read-only, with an existing Chrome/Edge. Preflight must render the local
multilingual fixture and prove custom glyph use. Preview enforces input,
geometry, element and pixel limits, verifies the renderer/font inventory, blocks
external requests/service workers/WebSockets, and publishes a verified PNG by
atomic replacement. Failure preserves previous output. Browser deadlines and
owned cleanup apply before success. These cooperating-process checks do not
claim protection against hostile concurrent filesystem replacement.

### Why preview uses an existing host browser

The skill already requires a prepared browser. Reusing application-owned
executables and driver dependencies preserves that prerequisite without a new
resource, installer or service. A missing or unsupported browser fails preview
with a remedy; it does not establish visual acceptance. Standalone Python
Playwright remains available with its locked dependencies and prepared browser.
