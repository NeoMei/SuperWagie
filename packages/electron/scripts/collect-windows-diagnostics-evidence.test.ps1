#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$CollectorPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($CollectorPath)) {
  $CollectorPath = Join-Path $PSScriptRoot 'collect-windows-diagnostics.ps1'
}

# Load the real helpers without running collection against the user's profile.
$parseTokens = $null
$parseErrors = $null
$collectorAst = [System.Management.Automation.Language.Parser]::ParseFile(
  $CollectorPath, [ref]$parseTokens, [ref]$parseErrors
)
if (@($parseErrors).Count -gt 0) {
  throw ('Collector syntax error: ' + ($parseErrors.Message -join '; '))
}
foreach ($definition in $collectorAst.EndBlock.Statements) {
  if ($definition -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
    . ([scriptblock]::Create($definition.Extent.Text))
  }
}

$appProcessNames = @('SuperWagie', '犇马', 'OpenChamber', 'openchamber', 'opencode')
$appExecutableNames = @('SuperWagie.exe', '犇马.exe', 'OpenChamber.exe', 'openchamber.exe', 'opencode.exe')
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('superwagie-evidence-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
$script:passed = 0

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Assert-Contains {
  param([string]$Text, [string]$Expected)
  Assert-True -Condition $Text.Contains($Expected) -Message ('Missing expected value: ' + $Expected)
}

function Assert-Excludes {
  param([string]$Text, [string]$Forbidden)
  Assert-True -Condition (-not $Text.Contains($Forbidden)) -Message ('Fixture secret was retained: ' + $Forbidden)
}

function Invoke-EvidenceTest {
  param([string]$Name, [scriptblock]$Body)
  & $Body
  $script:passed += 1
  Write-Host ('PASS ' + $Name)
}

function New-FixtureEvent {
  param([string]$AppName = '犇马.exe', [string]$Provider = 'Application Error')
  $event = [pscustomobject]@{
    TimeCreated = [datetime]'2026-10-27T10:30:00'
    ProviderName = $Provider
    Id = 1000
    LevelDisplayName = '错误'
    # Localized formatted messages must not be needed for field extraction.
    Message = '应用程序发生错误。诊断字段位于 XML 数据中。'
    XmlText = @"
<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event">
  <System><Provider Name="$Provider"/><EventID>1000</EventID></System>
  <EventData>
    <Data Name="AppName">$AppName</Data>
    <Data Name="AppVersion">2.7.22.0</Data>
    <Data Name="ModuleName">KERNELBASE.dll</Data>
    <Data Name="ModuleVersion">10.0.26200.1</Data>
    <Data Name="ExceptionCode">c0000005</Data>
    <Data Name="FaultingOffset">0000000000012345</Data>
    <Data Name="ProcessId">0x1234</Data>
    <Data Name="AppPath">C:\Users\fixture-private-user\Apps\$AppName</Data>
    <Data Name="ModulePath">C:\Windows\System32\KERNELBASE.dll</Data>
    <Data Name="Unrelated">fixture-event-secret</Data>
  </EventData>
</Event>
"@
  }
  $event | Add-Member -MemberType ScriptMethod -Name ToXml -Value { return $this.XmlText }
  return $event
}

try {
  Invoke-EvidenceTest 'query credentials are removed rather than copied into the replacement' {
    $result = Redact-Text 'Failed https://fixture.invalid/callback?token=fixture-url-secret&code=fixture-code-secret'
    Assert-Excludes $result 'fixture-url-secret'
    Assert-Excludes $result 'fixture-code-secret'
  }

  Invoke-EvidenceTest 'quoted JSON credentials with spaces are removed' {
    $result = Redact-Text '{"password":"fixture password secret","access_token":"fixture-token-secret","client_secret":"fixture-client-secret"}'
    Assert-Excludes $result 'fixture password secret'
    Assert-Excludes $result 'fixture-token-secret'
    Assert-Excludes $result 'fixture-client-secret'
    $parsed = ConvertFrom-Json -InputObject $result
    Assert-True -Condition ($parsed.password -eq '<redacted>') -Message 'Redaction broke JSON quoting'
  }

  Invoke-EvidenceTest 'bearer and pairing credentials are removed' {
    $result = Redact-Text 'Authorization: Bearer fixture-bearer-secret-123456; oc_client_fixture-pairing-secret'
    Assert-Excludes $result 'fixture-bearer-secret-123456'
    Assert-Excludes $result 'oc_client_fixture-pairing-secret'
  }

  Invoke-EvidenceTest 'multiline startup and renderer evidence survives while private fields do not' {
    $sourcePath = Join-Path $fixtureRoot 'main.log'
    $destinationPath = Join-Path $fixtureRoot 'redacted.log'
    $fixtureLog = @'
[2026-10-27 10:20:00.100] [info] [electron] app starting {
  version: '2.7.22',
  packaged: true,
  platform: 'win32',
  arch: 'x64',
  argv: ['C:\Users\fixture-private-user\Apps\SuperWagie.exe', 'fixture-argv-secret'],
  cwd: 'C:\fixture-private-workspace',
  token: 'fixture-log-token'
}
[2026-10-27 10:21:00.200] [warn] [electron] renderer exited unexpectedly; reloading window {
  label: 'fixture-private-label',
  surface: 'main',
  reason: 'crashed',
  exitCode: -1073741819
}
[2026-10-27 10:22:00.200] [info] [electron] arbitrary prompt fixture-prompt-secret
[2026-10-27 10:23:00.200] [info] [assistant] fixture-assistant-secret
'@
    [IO.File]::WriteAllText($sourcePath, $fixtureLog, [Text.UTF8Encoding]::new($false))
    $copied = Copy-RedactedLog -Source (Get-Item -LiteralPath $sourcePath) -Destination $destinationPath
    Assert-True -Condition $copied -Message 'Synthetic log collection failed'
    $result = [IO.File]::ReadAllText($destinationPath)
    foreach ($expected in @('2.7.22', 'win32', 'x64', 'crashed', '-1073741819')) {
      Assert-Contains $result $expected
    }
    foreach ($forbidden in @('fixture-private-user', 'fixture-argv-secret', 'fixture-private-workspace', 'fixture-log-token', 'fixture-private-label', 'fixture-prompt-secret', 'fixture-assistant-secret')) {
      Assert-Excludes $result $forbidden
    }
  }

  Invoke-EvidenceTest 'unrelated multiline records cannot contribute crash-looking fields' {
    $sourcePath = Join-Path $fixtureRoot 'unrelated.log'
    $destinationPath = Join-Path $fixtureRoot 'unrelated-redacted.log'
    [IO.File]::WriteAllText($sourcePath, @'
[2026-10-27 10:20:00.100] [info] [assistant] arbitrary payload {
  version: '99.98.97',
  reason: 'crashed',
  exitCode: -1234567
}
'@, [Text.UTF8Encoding]::new($false))
    $copied = Copy-RedactedLog -Source (Get-Item -LiteralPath $sourcePath) -Destination $destinationPath
    Assert-True -Condition $copied -Message 'Synthetic unrelated log collection failed'
    $result = [IO.File]::ReadAllText($destinationPath)
    Assert-Excludes $result '99.98.97'
    Assert-Excludes $result '-1234567'
  }

  Invoke-EvidenceTest 'Chinese Application Error uses named XML fields' {
    $result = Get-SafeApplicationEvent -Event (New-FixtureEvent)
    Assert-True -Condition ($null -ne $result) -Message 'Chinese app event was dropped'
    Assert-True -Condition ($result.faultingApplication -eq '犇马.exe') -Message 'AppName was not extracted'
    Assert-True -Condition ($result.faultingModule -eq 'KERNELBASE.dll') -Message 'ModuleName was not extracted'
    Assert-True -Condition ($result.exceptionCode -eq 'c0000005') -Message 'ExceptionCode was not extracted'
    $serialized = ConvertTo-Json -InputObject $result -Depth 8
    Assert-Excludes $serialized 'fixture-private-user'
    Assert-Excludes $serialized 'fixture-event-secret'
  }

  Invoke-EvidenceTest 'an Application Error from another application is excluded' {
    $result = Get-SafeApplicationEvent -Event (New-FixtureEvent -AppName 'unrelated-editor.exe')
    Assert-True -Condition ($null -eq $result) -Message 'Unrelated app event was included'
  }

  Write-Host ('All ' + $script:passed + ' evidence tests passed on PowerShell ' + $PSVersionTable.PSVersion)
} finally {
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}
