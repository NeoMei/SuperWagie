param(
  [Parameter(Mandatory = $true)][string]$Text,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synthesizer = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $voice = $synthesizer.GetInstalledVoices() |
    Where-Object { $_.Enabled } |
    Sort-Object { if ($_.VoiceInfo.Culture.Name -eq 'zh-CN') { 0 } else { 1 } }, { $_.VoiceInfo.Name } |
    Select-Object -First 1
  if ($null -eq $voice) { throw 'No enabled Windows speech voice is installed.' }
  $synthesizer.SelectVoice($voice.VoiceInfo.Name)
  $synthesizer.Rate = 0
  $synthesizer.SetOutputToWaveFile($OutputPath)
  $synthesizer.Speak($Text)
  [Console]::Out.WriteLine($voice.VoiceInfo.Name)
}
finally {
  $synthesizer.Dispose()
}
