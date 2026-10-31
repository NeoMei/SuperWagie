---
name: image-to-editable-pptx
description: Rebuild an existing slide analysis package into an editable PPTX offline, or patch an existing raster slide.
---

# Image to editable PPTX

This SuperWagie bundle supports offline `build`, `build-v1` and `raster-patch`.
Live `analyze` and `run` are unavailable until dedicated configured-model
adapters exist. The CLI and pipeline refuse them before provider discovery,
configuration, credentials or network access. Do not run upstream provider
modules, install another runtime, or substitute environment keys to bypass this.

## SuperWagie runtime

The application ships compiled `dist/src/cli.js`, source modules and production
dependencies. Resolve this skill's physical plugin root, then invoke
`/absolute/plugin/root/superwagie-cli.sh <arguments>` on macOS/Linux, or
`& /absolute/plugin/root/superwagie-cli.ps1 <arguments>` in Windows PowerShell.
The launcher uses `SUPERWAGIE_MODEL_NODE` and scopes Electron's Node mode to the
child. No system Node or npm installation is needed in a managed session.
The server writes the executable/argument descriptor to
`<dataDir>/skills-runtime/image-to-editable-pptx.launcher.json` for direct process invocation.
Keep each argument separate. The image runtime executes compiled JavaScript;
its development tsx loader is not included in production dependencies.

## Resolve the runtime

Follow the physical path of this file through its skill link. The plugin root
is 2 levels above its containing directory. It contains `package.json`,
`src/cli.ts`, `dist/src/cli.js` and production `node_modules`. Dependencies ship
with the application. Missing files require reinstalling the application bundle.
Never install dependencies at application startup or modify this managed root.

Run the compiled CLI with the supported server Node runtime. In a managed
session use `SUPERWAGIE_MODEL_NODE`; if it is the Electron executable, scope
`ELECTRON_RUN_AS_NODE=1` to that child alone. The server also writes
`<dataDir>/skills-runtime/image-to-editable-pptx.launcher.json` with the executable, CLI arguments and child-only
environment. Preserve argument boundaries and paths containing spaces or Chinese.

```sh
/absolute/plugin/root/superwagie-cli.sh build --analysis /absolute/analysis --out /absolute/output --required-text-count 1
/absolute/plugin/root/superwagie-cli.sh build-v1 /absolute/source.png --analysis /absolute/analysis-v1 --out /absolute/output
/absolute/plugin/root/superwagie-cli.sh raster-patch /absolute/deck.pptx --patch /absolute/patch.json --out /absolute/patched.pptx
```

## Acceptance and delivery

Use a self-contained v2 analysis package, or a legacy v1 package with its source
image. Put outputs in durable project directories outside the installed runtime.
Keep upstream ownership, dimensions, text-count and publication checks. A failed
rebuild must preserve the previous successful output and retained failure data.
Inspect the emitted manifest, ledger, PPTX slide XML and QA previews. Native text
must be present before describing text as editable. Backings and semantic layers
are movable PNG assets only when their checks pass; uncertain content stays in
the safe background. Do not claim complete object separation from a bitmap.

Open the result in the user's PowerPoint or WPS, edit representative text and
move a representative asset, undo, save or discard explicitly, close and reopen.
Report which checks actually ran. Offline reconstruction does not provide new
OCR or image analysis. An image alone needs an accepted analysis package first.
