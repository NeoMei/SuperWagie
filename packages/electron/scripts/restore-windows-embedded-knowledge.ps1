$ErrorActionPreference = 'Stop'
# This exact installer is the audited source for the existing Windows x64
# embedded worker; it does not include the in-progress managed worker changes.
$installer = Join-Path $env:RUNNER_TEMP 'SuperWagie-2.7.19-win-x64.exe'
$extracted = Join-Path $env:RUNNER_TEMP 'superwagie-knowledge-2.7.19'
Invoke-WebRequest 'https://github.com/NeoMei/SuperWagie-Open/releases/download/v2.7.19/SuperWagie-2.7.19-win-x64.exe' -OutFile $installer
$installerHash = '88e3e3a4417b7f0833fc7a5a07b529993e53d8298793804f28eb10f3e29bc874'
if ((Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $installerHash) {
  throw 'The pinned knowledge source installer checksum does not match'
}
& 7z x -t7z $installer "-o$extracted" 'resources/embedded-knowledge/*' -r -y
if ($LASTEXITCODE -ne 0) { throw 'Could not extract the pinned knowledge backend' }
$source = Join-Path $extracted 'resources/embedded-knowledge'
$manifest = Get-Content (Join-Path $source 'manifest.json') -Raw | ConvertFrom-Json
$binaryHash = 'bed12a528363cccbab302db63d27f5e60d780faa08623ba94b6bd4560fc4c162'
if ($manifest.commit -ne 'f5adb9eac166e7d3da7dceed7aa50049d4c4db1f' -or
    $manifest.binary -ne 'embedded-knowledge-server.exe' -or
    $manifest.binarySha256 -ne $binaryHash -or
    $manifest.windowsPatch.target -ne 'x86_64-pc-windows-gnu' -or
    $manifest.windowsPatch.sha256 -ne 'cd7d7a4a296acfe0ec5766b51682ff076e84f3938208823605f51e1e6f2ece71') {
  throw 'The pinned knowledge manifest does not match the expected backend'
}
if ((Get-FileHash (Join-Path $source $manifest.binary) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $binaryHash) {
  throw 'The pinned knowledge binary checksum does not match'
}
$destination = 'packages/electron/resources/embedded-knowledge'
if (Test-Path $destination) { throw 'Knowledge staging already exists; preserve it and review before restoring' }
Copy-Item $source $destination -Recurse
