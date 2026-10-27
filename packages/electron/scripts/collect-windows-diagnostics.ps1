#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$OutputDirectory = '',
  [ValidateRange(5, 1440)]
  [int]$SinceMinutes = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Redact-Text {
  param([AllowNull()][string]$Text)
  if ($null -eq $Text) { return '' }

  # URLs can carry credentials in the query, fragment, or user-info.
  $redacted = [regex]::Replace($Text, 'https?://[^\s"''<>]+', '<redacted-url>', 'IgnoreCase')
  $patterns = @(
    '(?i)(Authorization\s*[:=]\s*Bearer\s+)[^\s,;"}]+'
    '(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}'
    '(?i)(["'']?(?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|client[_-]?token|client[_-]?secret|password|passwd|secret|cookie|set-cookie|private[_-]?key|pairing[_-]?(?:url|token))["'']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|''(?:''''|[^''])*''|[^\s,;}]+)'
    '(?i)oc_client_[A-Za-z0-9._-]+'
    '(?i)\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b'
    '(?i)[A-Z]:\\Users\\[^\\\s"]+'
  )
  foreach ($pattern in $patterns) {
    $redacted = [regex]::Replace($redacted, $pattern, {
      param($match)
      if ($match.Groups.Count -gt 1 -and $match.Groups[1].Success) {
        $prefix = $match.Groups[1].Value
        $value = $match.Value.Substring($prefix.Length)
        if ($value.StartsWith('"') -or $value.StartsWith("'")) {
          $quote = $value.Substring(0, 1)
          return $prefix + $quote + '<redacted>' + $quote
        }
        return $prefix + '<redacted>'
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
    [Parameter(Mandatory)][AllowEmptyCollection()]$Value
  )
  $json = ConvertTo-Json -InputObject $Value -Depth 8
  # Structured snapshots contain only the selected metadata fields. Redacting
  # serialized JSON with text regexes can break its string escaping.
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
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
  # Component prefixes can also precede arbitrary command output. Retain only
  # fixed lifecycle messages and explicitly selected scalar payload fields.
  $prefix = '^(?<prefix>(?:\[\d{4}-\d{2}-\d{2} [\d:.]+\]\s+\[\w+\]\s+)?\[(?:electron|lifecycle|OpenCode)\]\s+)'
  $message = '(?<message>app starting|Launching managed server|renderer exited unexpectedly; reloading window|renderer keeps crashing; reloading window without its saved layout|renderer keeps crashing after a safe start; no more reloads|(?:periodic|startup|manual) health check failed \(\d+/\d+\) class=[a-z-]+|(?:periodic|startup|manual) health check failure threshold reached, restarting OpenCode\.\.\.|(?:periodic|startup|manual) health check: OpenCode process exited, restarting\.\.\.)'
  if ($Line -match ($prefix + $message + '(?:\s+\{)?\s*$')) {
    return $matches['prefix'] + $matches['message']
  }
  return $null
}

function Get-SafeLogField {
  param([string]$Line)
  if ($Line -notmatch '^\s{1,4}(?<key>version|platform|arch|reason|exitCode|pid|port|packaged|isBackgroundStart)\s*:\s*(?<value>[^,]+),?\s*$') { return $null }
  $key = $matches['key']
  $value = $matches['value'].Trim().Trim([char[]]'"''')
  $valid = switch ($key) {
    'version' { $value -match '^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$' }
    'platform' { $value -in @('win32', 'darwin', 'linux') }
    'arch' { $value -in @('x64', 'arm64', 'ia32') }
    'reason' { $value -in @('crashed', 'abnormal-exit', 'oom', 'memory-eviction', 'killed', 'clean-exit', 'launch-failed', 'integrity-failure') }
    { $_ -in @('exitCode', 'pid', 'port') } { $value -match '^-?\d{1,12}$' }
    default { $value -in @('true', 'false') }
  }
  if ($valid) { return '  ' + $key + ': ' + $value }
  return $null
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
    $lines = New-Object System.Collections.Generic.List[string]
    $keepFields = $false
    foreach ($line in (Get-Content -LiteralPath $Source.FullName -Tail 4000 -Encoding UTF8 -ErrorAction Stop)) {
      $header = Get-SafeLogLine $line
      if ($null -ne $header) {
        $lines.Add($header)
        $keepFields = $line.TrimEnd().EndsWith('{')
      } elseif ($line -match '^\[' -or $line -match '^\}\s*$') {
        $keepFields = $false
      } elseif ($keepFields) {
        $field = Get-SafeLogField $line
        if ($null -ne $field) { $lines.Add($field) }
      }
    }
    if ($lines.Count -eq 0) { $lines = @('No matching lifecycle lines in the selected log tail.') }
    Write-TextFile -Path $Destination -Text ($lines -join [Environment]::NewLine)
    return $true
  } catch {
    Write-TextFile -Path $Destination -Text 'Could not read the selected application log.'
    return $false
  }
}

function Get-SafeApplicationEvent {
  param([Parameter(Mandatory)]$Event)
  # XML EventData names are stable across Windows display languages.
  $xml = [xml]$Event.ToXml()
  $fields = @{}
  foreach ($node in $xml.SelectNodes('//*[local-name()="EventData"]/*[local-name()="Data"]')) {
    $fields[$node.GetAttribute('Name')] = $node.InnerText
  }
  $appName = $fields['AppName']
  if (-not $appName -and $Event.ProviderName -eq 'Windows Error Reporting') { $appName = $fields['P1'] }
  if (-not $appName) { return $null }
  $appName = [IO.Path]::GetFileName($appName)
  if ($appName -notin $appExecutableNames) { return $null }
  $module = $fields['ModuleName']
  $code = $fields['ExceptionCode']
  $offset = $fields['FaultingOffset']
  if ($Event.ProviderName -eq 'Windows Error Reporting' -and $fields['EventName'] -eq 'APPCRASH') {
    $module = $fields['P4']
    $code = $fields['P7']
    $offset = $fields['P8']
  }
  return [ordered]@{
    time = $Event.TimeCreated.ToString('o')
    provider = $Event.ProviderName
    id = $Event.Id
    level = $Event.LevelDisplayName
    faultingApplication = $appName
    faultingModule = if ($module) { [IO.Path]::GetFileName($module) } else { $null }
    exceptionCode = if ($code -match '^(?:0x)?[a-fA-F0-9]{1,16}$') { $code } else { $null }
    faultOffset = if ($offset -match '^(?:0x)?[a-fA-F0-9]{1,16}$') { $offset } else { $null }
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
$processTreeCollected = $false

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

$userProfileDirectory = [Environment]::GetFolderPath('UserProfile')
$appData = [Environment]::GetFolderPath('ApplicationData')
$dataRoot = if (-not [string]::IsNullOrWhiteSpace($env:OPENCHAMBER_DATA_DIR)) {
  $env:OPENCHAMBER_DATA_DIR
} else {
  Join-Path $userProfileDirectory '.config\openchamber'
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
  try {
    $items = @(Get-ChildItem -LiteralPath $source.path -File -Filter $source.filter -ErrorAction Stop | Sort-Object LastWriteTime -Descending)
  } catch {
    $warnings.Add("Could not list logs: $($source.name)")
    continue
  }
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
    collectorVersion = '2'
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
  $processes = @(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -in $appProcessNames } | ForEach-Object {
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
  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $processIds = @($allProcesses | Where-Object { $_.Name -in $appExecutableNames } | Select-Object -ExpandProperty ProcessId)
  do {
    $previousCount = $processIds.Count
    $processIds = @(@(
      $processIds + ($allProcesses | Where-Object { $_.ParentProcessId -in $processIds } | Select-Object -ExpandProperty ProcessId)
    ) | Sort-Object -Unique)
  } while ($processIds.Count -gt $previousCount)
  $processRows = @($allProcesses | Where-Object { $_.ProcessId -in $processIds } | Select-Object Name, ProcessId, ParentProcessId)
  Write-JsonFile -Path (Join-Path $workRoot 'process-tree.json') -Value $processRows
  Add-FileRecord -Path (Join-Path $workRoot 'process-tree.json') -Kind 'process-tree' -Collected $true
  $processTreeCollected = $true
} catch {
  $warnings.Add('Could not collect process tree')
}

try {
  if (-not $processTreeCollected) { throw 'Process ownership snapshot unavailable' }
  $pids = @($processIds)
  $connections = @()
  if ($pids.Count -gt 0) {
    $connections = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.OwningProcess -in $pids } | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess)
  }
  Write-JsonFile -Path (Join-Path $workRoot 'network.json') -Value $connections
  Add-FileRecord -Path (Join-Path $workRoot 'network.json') -Kind 'network' -Collected $true
} catch {
  $warnings.Add('Could not collect network connections')
}

try {
  $eventErrors = @()
  $candidates = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since; Id = @(1000, 1001, 1002) } -MaxEvents 2000 -ErrorAction SilentlyContinue -ErrorVariable eventErrors)
  if (@($eventErrors | Where-Object { $_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*' }).Count -gt 0) {
    throw 'Windows Application event query failed'
  }
  $events = @($candidates | ForEach-Object {
    try { Get-SafeApplicationEvent -Event $_ } catch { $warnings.Add('Could not parse one Windows Application event') }
  } | Where-Object { $null -ne $_ } | Select-Object -First 300)
  if ($candidates.Count -eq 2000) { $warnings.Add('Windows event query reached its 2000-record limit; older events may be omitted') }
  Write-JsonFile -Path (Join-Path $workRoot 'application-events.json') -Value $events
  Add-FileRecord -Path (Join-Path $workRoot 'application-events.json') -Kind 'windows-event-log' -Collected $true
} catch {
  $warnings.Add('Could not collect the Windows Application event log')
}

$readme = @"
SuperWagie Windows diagnostics

Collected: $($startedAt.ToString('o'))
Windows event window: last $SinceMinutes minutes
Application logs: newest 4000 lines per file, which can include older entries

This archive contains redacted log tails, fixed system/process/network metadata,
and matching Windows Application events. User data, settings, cookies, credentials,
tokens, pairing links and memory dumps are intentionally excluded.

If the failure happened outside this time window, run again with -SinceMinutes 1440.
"@
Write-TextFile -Path (Join-Path $workRoot 'README.txt') -Text $readme
Add-FileRecord -Path (Join-Path $workRoot 'README.txt') -Kind 'readme' -Collected $true

$manifest = [ordered]@{
  collector = 'SuperWagie Windows diagnostics'
  collectorVersion = '2'
  collectedAt = $startedAt.ToString('o')
  since = $since.ToString('o')
  files = $files.ToArray()
  warnings = $warnings.ToArray()
}
Write-JsonFile -Path (Join-Path $workRoot 'manifest.json') -Value $manifest

$zipPath = Join-Path $OutputDirectory ("SuperWagie-Windows-Diagnostics-" + $stamp + '.zip')
try {
  Compress-Archive -Path (Join-Path $workRoot '*') -DestinationPath $zipPath -CompressionLevel Optimal -Force -ErrorAction Stop
} catch {
  Write-Warning ("Archive creation failed. Collected files remain at: " + $workRoot)
  throw
}
Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'SuperWagie diagnostics archive created:' -ForegroundColor Green
Write-Host $zipPath -ForegroundColor Cyan
if ($warnings.Count -gt 0) {
  Write-Warning ("Collection completed with " + $warnings.Count + " warning(s). See manifest.json for missing evidence.")
}
Write-Host ''
Write-Host 'The archive contains redacted logs only. Do not send passwords, tokens, cookies, or pairing links.'
