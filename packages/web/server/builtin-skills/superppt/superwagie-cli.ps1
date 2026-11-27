$ErrorActionPreference = 'Stop'
if (-not $env:SUPERWAGIE_MODEL_NODE) { throw 'Run this bundled runtime from a SuperWagie managed session' }
$previousMode = $env:ELECTRON_RUN_AS_NODE
$previousChatInteractions = $env:SUPERPPT_CHAT_INTERACTIONS
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $env:SUPERPPT_CHAT_INTERACTIONS = '1'
    & $env:SUPERWAGIE_MODEL_NODE (Join-Path $PSScriptRoot 'dist/src/cli.js') @args
    $runtimeExit = $LASTEXITCODE
} finally { $env:ELECTRON_RUN_AS_NODE = $previousMode; $env:SUPERPPT_CHAT_INTERACTIONS = $previousChatInteractions }
exit $runtimeExit
