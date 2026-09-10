# Internal fixed-control classifier; not an authenticator of supplied JSON reports.
function Get-NodeTrafficControlEvidence($Result, $State, $Budget) {
    $unresolved=[Collections.Generic.List[string]]::new()
    if (-not $Result.JobEmptyAfterCleanup -or $State.emptyConfirmedMs -lt 0) { $unresolved.Add('Whole-job emptiness was not confirmed') }
    if ($State.readError -or -not $Budget.AccountingValid) { $unresolved.Add('Host traffic accounting is incomplete or discontinuous') }
    # The observer runs before the supervisor checks natural process exit.
    # Only the fixed supervisor termination code proves this worker was stopped.
    if ($Result.Outcome -ne 'observer-complete' -or $Result.ExitCode -ne 3758096385UL -or
        $Budget.StopReason -ne 'traffic-threshold' -or
        $State.stopDecisionMs -lt 0 -or $Budget.TotalBytes -lt 16384UL -or
        $Budget.FirstStopMs -lt 0 -or $Budget.FirstStopMs -gt $State.stopDecisionMs) {
        $unresolved.Add('A traffic-triggered whole-job stop was not demonstrated')
    }
    $stopLatency = if ($State.stopDecisionMs -ge 0 -and $State.emptyConfirmedMs -ge $State.stopDecisionMs) {
        $State.emptyConfirmedMs-$State.stopDecisionMs
    } else { -1L }
    if ($stopLatency -lt 0 -or $stopLatency -gt 2000) { $unresolved.Add('Stop-decision-to-empty-confirmation exceeds 2 s or is missing') }
    if ($State.finalSampleStartedMs -lt $State.emptyConfirmedMs -or
        $State.finalSampleFinishedMs -lt $State.finalSampleStartedMs -or
        $State.finalSampleFinishedMs-$State.emptyConfirmedMs -gt 1000) { $unresolved.Add('Final traffic sample is missing or late') }
    if ($Budget.TotalBytes -gt 2097152UL) { $unresolved.Add('Final observed host traffic exceeds 2 MiB') }
    if (-not $Result.LimitsReadBackBeforeResume -or $Result.CpuRateFlags -ne 5 -or $Result.CpuRatePer10000 -ne 2500 -or
        $Result.PeakCommitBytes -gt 268435456UL -or $Result.PeakProcessCommitBytes -gt 268435456UL -or
        $Result.SampledPeakPrivateCommitBytes -gt 268435456UL -or $Result.MaxSampledAssociatedProcesses -gt 1) {
        $unresolved.Add('Process resource readback is unresolved')
    }
    [pscustomobject]@{ Unresolved=$unresolved.ToArray(); StopLatencyMs=$stopLatency }
}
