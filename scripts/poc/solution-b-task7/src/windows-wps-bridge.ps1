param(
  [Parameter(Mandatory = $true)][ValidateSet('writer', 'presentation')][string]$Component,
  [Parameter(Mandatory = $true)][string]$SourcePath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$source = [System.IO.Path]::GetFullPath($SourcePath)
$output = [System.IO.Path]::GetFullPath($OutputPath)
if (-not [System.IO.File]::Exists($source)) { throw 'WPS source is unavailable.' }
if ([System.IO.Path]::GetExtension($output) -ne '.pdf') { throw 'WPS output must be a PDF.' }

$application = $null
$document = $null
try {
  if ($Component -eq 'writer') {
    $application = New-Object -ComObject KWPS.Application
    $application.Visible = $false
    $document = $application.Documents.Open($source)
    $document.ExportAsFixedFormat($output, 17)
  }
  else {
    $application = New-Object -ComObject KWPP.Application
    $document = $application.Presentations.Open($source, $true, $false, $false)
    $document.SaveAs($output, 32)
  }
}
finally {
  if ($null -ne $document) {
    if ($Component -eq 'writer') { $document.Close($false) } else { $document.Close() }
  }
  if ($null -ne $application) { $application.Quit() }
  if ($null -ne $document) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
  if ($null -ne $application) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($application) }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}

if (-not [System.IO.File]::Exists($output)) { throw 'WPS did not publish the requested PDF.' }
