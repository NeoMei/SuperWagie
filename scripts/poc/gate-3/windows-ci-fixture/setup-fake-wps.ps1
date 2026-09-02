param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$parent = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $parent | Out-Null
if (Test-Path -LiteralPath $OutputPath) {
  Remove-Item -LiteralPath $OutputPath -Force
}

$source = @'
using System;
using System.Reflection;

[assembly: AssemblyTitle("SuperWagie Controlled Fake WPS Target")]
[assembly: AssemblyDescription("Test-only target identity; never launches Office")]
[assembly: AssemblyVersion("12.1.0.17900")]
[assembly: AssemblyFileVersion("12.1.0.17900")]
[assembly: AssemblyInformationalVersion("12.1.0.17900")]

public static class ControlledFakeWpsTarget
{
    public static int Main(string[] args)
    {
        Console.Error.WriteLine("This controlled fake target must not be launched.");
        return 86;
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $OutputPath -OutputType ConsoleApplication
$observed = (Get-Item -LiteralPath $OutputPath).VersionInfo.ProductVersion
if ($observed -ne "12.1.0.17900") {
  throw "controlled fake WPS ProductVersion mismatch: $observed"
}
