# Harmless real PowerShell startup checks; no disk, volume, or fill worker.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Requires Windows x64 / PowerShell 7' }
Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeProcess.cs')
$directory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../scratch'))
$results = @()
foreach ($case in @(
    @{ Name='stdout'; Command='Write-Output 12345'; Output="12345`r`n"; Exit=0 },
    @{ Name='exit'; Command='[Environment]::Exit(72)'; Output=''; Exit=72 }
)) {
    $result = [NodeProbeProcess]::RunWithInheritedConsole((Join-Path $PSHOME 'pwsh.exe'),
        @('-NoLogo','-NoProfile','-NonInteractive','-Command',$case.Command),
        $directory,('disk-startup-' + $case.Name),536870912UL,10000,65536,$null)
    if ($result.Outcome -cne 'exited' -or $result.Output -cne $case.Output -or $result.ExitCode -ne $case.Exit -or
        $result.LaunchMode -cne 'inherited-console' -or $result.CreationFlags -ne 525316 -or
        -not $result.ParentConsoleVerified -or -not $result.LimitsReadBackBeforeResume -or
        -not $result.JobEmptyAfterCleanup -or $result.TotalProcesses -ne 1 -or
        $result.BeforeResumeActiveProcesses -ne 1 -or $result.MaxSampledAssociatedProcesses -ne 1) {
        throw "Harmless PowerShell startup case failed: $($case.Name)"
    }
    $results += $result
}
[ordered]@{ status='harmless-powershell-startup-only'; observedAtUtc=[DateTime]::UtcNow.ToString('o');
    sourceSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'NodeProbeProcess.cs')).Hash.ToLowerInvariant();
    powershell=$PSVersionTable.PSVersion.ToString(); results=$results } | ConvertTo-Json -Depth 8
