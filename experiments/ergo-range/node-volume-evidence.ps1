# Pure acceptance guards for the fixed offline node-on-volume composition.
Set-StrictMode -Version Latest
function Assert-VolumeNodeProcess($Process, [bool]$Sync30Minutes=$false) {
    $wall=if ($Sync30Minutes) { 1800000L } else { 120000L }
    if ($null -eq $Process -or -not $Process.LimitsReadBackBeforeResume -or -not $Process.JobEmptyAfterCleanup -or
        $Process.LaunchMode -cne 'detached' -or $Process.CreationFlags -ne 525324 -or
        $Process.Outcome -cne 'observer-complete' -or $Process.ExitCode -ne 3758096385UL -or
        $Process.TotalProcesses -ne 1 -or $Process.BeforeResumeActiveProcesses -ne 1 -or
        $Process.MaxSampledAssociatedProcesses -ne 1 -or $Process.CommitLimitBytes -ne 4294967296UL -or
        $Process.PeakCommitBytes -gt 4294967296UL -or $Process.PeakProcessCommitBytes -gt 4294967296UL -or
        $Process.SampledPeakPrivateCommitBytes -gt 4294967296UL -or
        $Process.CpuRateFlags -ne 5 -or $Process.CpuRatePer10000 -ne 2500 -or
        $Process.ElapsedMs -le 0 -or $Process.ElapsedMs -gt $wall -or
        $Process.CapturedOutputBytes -lt 0 -or $Process.CapturedOutputBytes -gt 15728640) {
        throw 'Offline volume node process/stop evidence unresolved'
    }
}
function Assert-VolumeNodeTraffic($State, $Budget, [bool]$Sync30Minutes=$false) {
    $allowedStop= -not $Budget.StopReason -or ($Sync30Minutes -and $Budget.StopReason -ceq 'traffic-threshold')
    if (-not $State.finalAttempted -or $State.readError -or -not $Budget.AccountingValid -or -not $allowedStop -or
        $Budget.TotalBytes -gt 10737418240UL -or $State.stopDecisionMs -lt 0 -or
        $State.emptyConfirmedMs -lt $State.stopDecisionMs -or $State.emptyConfirmedMs-$State.stopDecisionMs -gt 2000 -or
        $State.finalSampleStartedMs -lt $State.emptyConfirmedMs -or
        $State.finalSampleFinishedMs -lt $State.finalSampleStartedMs -or
        $State.finalSampleFinishedMs-$State.emptyConfirmedMs -gt 1000) {
        throw 'Offline volume node traffic/final accounting unresolved'
    }
}
