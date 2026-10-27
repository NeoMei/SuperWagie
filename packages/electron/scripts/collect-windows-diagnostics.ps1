#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$OutputDirectory = '',
  [ValidateRange(5, 1440)]
  [int]$SinceMinutes = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

function Redact-Text {
  param([AllowNull()][string]$Text)
  if ($null -eq $Text) { return '' }

  $redacted = $Text
  $patterns = @(
    '(?i)(Authorization\s*[:=]\s*Bearer\s+)[^\s,;"}]+'
    '(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}'
    '(?i)((?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|client[_-]?token|client[_-]?secret|password|passwd|secret|cookie|set-cookie|private[_-]?key|pairing[_-]?(?:url|token))\s*[:=]\s*)[^\s,;"}]+'
    '(?i)oc_client_[A-Za-z0-9._-]+'
    '(?i)(https?://[^\s"<>]*(?:token|secret|password|key|code)=[^&\s"<>]+)'
    '(?i)\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b'
    '(?i)[A-Z]:\\Users\\[^\\\s"]+'
  )
  foreach ($pattern in $patterns) {
    $redacted = [regex]::Replace($redacted, $pattern, {
      param($match)
      if ($match.Groups.Count -gt 1 -and $match.Groups[1].Success) {
        return $match.Groups[1].Value + '<redacted>'
      }
      return '<redacted>'
    })
  }
  return $redacted
}

function Ensure-Directory {
  param([Parameter(Mandatory)][string]$Path)
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Write-JsonFile {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)]$Value
  )
  $json = $Value | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($Path, (Redact-Text $json), [System.Text.UTF8Encoding]::new($false))
}

function Write-TextFile {
  param(
    [Parameter(Mandatory)][string]$Path,
    [AllowNull()][string]$Text
  )
  [System.IO.File]::WriteAllText($Path, (Redact-Text $Text), [System.Text.UTF8Encoding]::new($false))
}

function Get-SafeStartTime {
  param([Parameter(Mandatory)]$Process)
  try { return $Process.StartTime.ToString('o') } catch { return $null }
}

function Get-SafeLogLine {
  param([AllowNull()][string]$Line)
  if ([string]::IsNullOrWhiteSpace($Line)) { return $null }
  # Keep only the fixed application components that can explain a startup,
  # renderer, OpenCode or port-lifecycle failure. This excludes prompts,
  # model output and arbitrary command output before redaction runs.
  if ($Line -notmatch '(?i)\[(electron|lifecycle|OpenCode|startup|renderer|ipc|proxy|desktop)\]') {
    return $null
  }
  return Redact-Text $Line
}

# The packaged display name is currently Chinese (`犇马`), while release
# artifacts use the ASCII SuperWagie name. Keep both forms so the process and
# event snapshots work with installed builds and older OpenChamber installs.
$appProcessNames = @('SuperWagie', '犇马', 'OpenChamber', 'openchamber', 'opencode')
$appExecutableNames = @('SuperWagie.exe', '犇马.exe', 'OpenChamber.exe', 'openchamber.exe', 'opencode.exe')

function Copy-RedactedLog {
  param(
    [Parameter(Mandatory)][System.IO.FileInfo]$Source,
    [Parameter(Mandatory)][string]$Destination
  )
  try {
    # Keep the newest bounded tail. It contains the crash/restart window while
    # avoiding an unbounded copy of a long-running user's logs.
    $lines = @(Get-Content -LiteralPath $Source.FullName -Tail 4000 -ErrorAction Stop |
      ForEach-Object { Get-SafeLogLine $_ } |
      Where-Object { $null -ne $_ })
    if ($lines.Count -eq 0) { $lines = @('No matching lifecycle lines in the selected log tail.') }
    Write-TextFile -Path $Destination -Text ($lines -join [Environment]::NewLine)
    return $true
  } catch {
    Write-TextFile -Path $Destination -Text ("Could not read log: " + $_.Exception.Message)
    return $false
  }
}

$startedAt = Get-Date
$since = $startedAt.AddMinutes(-$SinceMinutes)
$stamp = $startedAt.ToString('yyyyMMdd-HHmmss')
$defaultOutput = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($defaultOutput) -or -not (Test-Path -LiteralPath $defaultOutput)) {
  $defaultOutput = (Get-Location).Path
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = $defaultOutput
}
Ensure-Directory -Path $OutputDirectory

$workRoot = Join-Path ([IO.Path]::GetTempPath()) ("SuperWagie-diagnostics-" + [guid]::NewGuid().ToString('N'))
Ensure-Directory -Path $workRoot
$logOutput = Join-Path $workRoot 'logs'
Ensure-Directory -Path $logOutput

$files = New-Object System.Collections.Generic.List[object]
$warnings = New-Object System.Collections.Generic.List[string]
$processIds = @()

function Add-FileRecord {
  param([string]$Path, [string]$Kind, [bool]$Collected)
  $relativePath = $Path
  if ($Path.StartsWith($workRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    $relativePath = $Path.Substring($workRoot.Length).TrimStart([char[]]'\/')
  }
  $record = [ordered]@{ path = $relativePath; kind = $Kind; collected = $Collected }
  if ($Collected -and (Test-Path -LiteralPath $Path)) {
    $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    if ($item) {
      $record.bytes = $item.Length
      try { $record.sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash } catch { }
    }
  }
  $files.Add([pscustomobject]$record)
}

$home = [Environment]::GetFolderPath('UserProfile')
$appData = [Environment]::GetFolderPath('ApplicationData')
$dataRoot = if (-not [string]::IsNullOrWhiteSpace($env:OPENCHAMBER_DATA_DIR)) {
  $env:OPENCHAMBER_DATA_DIR
} else {
  Join-Path $home '.config\openchamber'
}

$logSources = @(
  [pscustomobject]@{ name = 'superwagie'; path = (Join-Path $appData 'SuperWagie\logs'); filter = 'main*.log' }
  [pscustomobject]@{ name = 'benma'; path = (Join-Path $appData '犇马\logs'); filter = 'main*.log' }
  [pscustomobject]@{ name = 'openchamber-legacy'; path = (Join-Path $appData 'OpenChamber\logs'); filter = 'main*.log' }
  [pscustomobject]@{ name = 'openchamber-server'; path = (Join-Path $dataRoot 'logs'); filter = 'openchamber-*.log' }
  [pscustomobject]@{ name = 'update'; path = $dataRoot; filter = 'update-install.log' }
)

foreach ($source in $logSources) {
  if (-not (Test-Path -LiteralPath $source.path)) {
    $warnings.Add("Log directory not found: $($source.name)")
    continue
  }
  $items = @(Get-ChildItem -LiteralPath $source.path -File -Filter $source.filter -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
  foreach ($item in $items) {
    $safeName = ($source.name + '-' + $item.Name) -replace '[^A-Za-z0-9._-]', '_'
    $destination = Join-Path $logOutput $safeName
    $collected = Copy-RedactedLog -Source $item -Destination $destination
    Add-FileRecord -Path $destination -Kind ("log:" + $source.name) -Collected $collected
  }
}

try {
  $os = Get-CimInstance Win32_OperatingSystem
  $computer = Get-CimInstance Win32_ComputerSystem
  $metadata = [ordered]@{
    collectedAt = $startedAt.ToString('o')
    logsSince = $since.ToString('o')
    collector = 'SuperWagie Windows diagnostics'
    collectorVersion = '1'
    powershell = $PSVersionTable.PSVersion.ToString()
    os = [ordered]@{
      caption = $os.Caption
      version = $os.Version
      build = $os.BuildNumber
      architecture = $os.OSArchitecture
      lastBoot = $os.LastBootUpTime
    }
    computer = [ordered]@{
      manufacturer = $computer.Manufacturer
      model = $computer.Model
      systemType = $computer.SystemType
    }
    appData = '%APPDATA%'
    openchamberData = if ($env:OPENCHAMBER_DATA_DIR) { '%OPENCHAMBER_DATA_DIR%' } else { '%USERPROFILE%\\.config\\openchamber' }
  }
  Write-JsonFile -Path (Join-Path $workRoot 'system.json') -Value $metadata
  Add-FileRecord -Path (Join-Path $workRoot 'system.json') -Kind 'system' -Collected $true
} catch {
  $warnings.Add('Could not collect Windows system metadata')
}

try {
  $processes = @(Get-Process -Name $appProcessNames -ErrorAction SilentlyContinue | ForEach-Object {
    $version = $null
    $path = $null
    try {
      $path = $_.Path
      if ($path) { $version = (Get-Item -LiteralPath $path).VersionInfo.FileVersion }
    } catch { }
    [ordered]@{
      name = $_.ProcessName
      pid = $_.Id
      startTime = Get-SafeStartTime $_
      executable = if ($path) { Split-Path -Leaf $path } else { $null }
      fileVersion = $version
      workingSetBytes = $_.WorkingSet64
    }
  })
  Write-JsonFile -Path (Join-Path $workRoot 'processes.json') -Value $processes
  Add-FileRecord -Path (Join-Path $workRoot 'processes.json') -Kind 'processes' -Collected $true
} catch {
  $warnings.Add('Could not collect process metadata')
}

try {
  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $processIds = @($allProcesses | Where-Object { $_.Name -in $appExecutableNames } | Select-Object -ExpandProperty ProcessId)
  do {
    $previousCount = $processIds.Count
    $processIds = @(
      $processIds + ($allProcesses | Where-Object { $_.ParentProcessId -in $processIds } | Select-Object -ExpandProperty ProcessId)
    ) | Sort-Object -Unique
  } while ($processIds.Count -gt $previousCount)
  $processRows = @($allProcesses | Where-Object { $_.ProcessId -in $processIds } | Select-Object Name, ProcessId, ParentProcessId)
  Write-JsonFile -Path (Join-Path $workRoot 'process-tree.json') -Value $processRows
  Add-FileRecord -Path (Join-Path $workRoot 'process-tree.json') -Kind 'process-tree' -Collected $true
} catch {
  $warnings.Add('Could not collect process tree')
}

try {
  $pids = @($processIds)
  $connections = @()
  if ($pids.Count -gt 0) {
    $connections = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $pids } | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess)
  }
  Write-JsonFile -Path (Join-Path $workRoot 'network.json') -Value $connections
  Add-FileRecord -Path (Join-Path $workRoot 'network.json') -Kind 'network' -Collected $true
} catch {
  $warnings.Add('Could not collect network connections')
}

try {
  $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since } -ErrorAction SilentlyContinue | Where-Object {
    $_.ProviderName -match '(?i)application error|windows error reporting|\.net runtime|superwagie|openchamber|犇马|electron|opencode' -or
    $_.Message -match '(?i)superwagie|openchamber|犇马|opencode|electron'
  } | Select-Object -First 300 | ForEach-Object {
    [ordered]@{
      time = $_.TimeCreated
      provider = $_.ProviderName
      id = $_.Id
      level = $_.LevelDisplayName
      faultingApplication = if ($_.Message -match '(?im)Faulting application name:\s*([^\r\n]+)') { $matches[1].Trim() } else { $null }
      faultingModule = if ($_.Message -match '(?im)Faulting module name:\s*([^\r\n]+)') { $matches[1].Trim() } else { $null }
      exceptionCode = if ($_.Message -match '(?im)Exception code:\s*([^\r\n]+)') { $matches[1].Trim() } else { $null }
      faultOffset = if ($_.Message -match '(?im)Fault offset:\s*([^\r\n]+)') { $matches[1].Trim() } else { $null }
      reportedApplication = if ($_.Message -match '(?im)Faulting application path:\s*([^\r\n]+)') { Split-Path -Leaf $matches[1].Trim() } else { $null }
    }
  })
  Write-JsonFile -Path (Join-Path $workRoot 'application-events.json') -Value $events
  Add-FileRecord -Path (Join-Path $workRoot 'application-events.json') -Kind 'windows-event-log' -Collected $true
} catch {
  $warnings.Add('Could not collect the Windows Application event log')
}

$readme = @"
SuperWagie Windows diagnostics

Collected: $($startedAt.ToString('o'))
Event/log window: last $SinceMinutes minutes

This archive contains redacted log tails, fixed system/process/network metadata,
and matching Windows Application events. User data, settings, cookies, credentials,
tokens, pairing links and memory dumps are intentionally excluded.

If the failure happened outside this time window, run again with -SinceMinutes 1440.
"@
Write-TextFile -Path (Join-Path $workRoot 'README.txt') -Text $readme
Add-FileRecord -Path (Join-Path $workRoot 'README.txt') -Kind 'readme' -Collected $true

$manifest = [ordered]@{
  collector = 'SuperWagie Windows diagnostics'
  collectedAt = $startedAt.ToString('o')
  since = $since.ToString('o')
  files = @($files)
  warnings = @($warnings)
}
Write-JsonFile -Path (Join-Path $workRoot 'manifest.json') -Value $manifest

$zipPath = Join-Path $OutputDirectory ("SuperWagie-Windows-Diagnostics-" + $stamp + '.zip')
try {
  Compress-Archive -Path (Join-Path $workRoot '*') -DestinationPath $zipPath -CompressionLevel Optimal -Force
} finally {
  Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'SuperWagie diagnostics archive created:' -ForegroundColor Green
Write-Host $zipPath -ForegroundColor Cyan
Write-Host ''
Write-Host 'The archive contains redacted logs only. Do not send passwords, tokens, cookies, or pairing links.'
