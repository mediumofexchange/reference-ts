# Internal evidence helpers for the fixed offline control; no disk mutations.
Set-StrictMode -Version Latest
function Assert-DatabaseProcess($Result, [bool]$Stopped=$false) {
    if ($null -eq $Result -or -not $Result.LimitsReadBackBeforeResume -or -not $Result.JobEmptyAfterCleanup -or
        $Result.LaunchMode -cne 'detached' -or $Result.CreationFlags -ne 525324 -or
        $Result.TotalProcesses -ne 1 -or $Result.BeforeResumeActiveProcesses -ne 1 -or
        $Result.MaxSampledAssociatedProcesses -ne 1 -or $Result.CommitLimitBytes -ne 1073741824UL -or
        $Result.PeakCommitBytes -gt 1073741824UL -or $Result.PeakProcessCommitBytes -gt 1073741824UL -or
        $Result.SampledPeakPrivateCommitBytes -gt 1073741824UL -or
        $Result.CpuRateFlags -ne 5 -or $Result.CpuRatePer10000 -ne 2500 -or
        $Result.ElapsedMs -gt 30000 -or $Result.CapturedOutputBytes -gt 65536) { throw 'Database process limits or empty-job evidence unresolved' }
    if ($Stopped) {
        if ($Result.Outcome -cne 'observer-complete' -or $Result.ExitCode -ne 3758096385UL) { throw 'Injected whole-job stop not demonstrated' }
    } elseif ($Result.Outcome -cne 'exited' -or $Result.ExitCode -ne 0) { throw 'Expected successful natural process exit' }
}
function New-DatabaseTrafficState {
    [ordered]@{ stopDecisionMs=-1L; emptyConfirmedMs=-1L; finalSampleStartedMs=-1L;
        finalSampleFinishedMs=-1L; readError=$null; samples=1; finalAttempted=$false }
}
function Update-DatabaseTraffic($Budget, $State, [scriptblock]$ReadSample) {
    try {
        $sample = & $ReadSample
        $State.samples++
        return $Budget.Observe($sample)
    } catch {
        $State.readError=$_.Exception.Message
        return $true
    }
}
# Always execute final accounting, even if launch/observer/cleanup threw. A thrown
# launcher does not provide empty-job evidence; the final sample cannot repair it.
function Invoke-DatabaseAccountedRun([scriptblock]$Launch, [scriptblock]$FinalRead, $Budget, $State, $Clock) {
    $result=$null; $failure=$null
    try {
        $result = & $Launch
        if ($null -ne $result -and $result.JobEmptyAfterCleanup) { $State.emptyConfirmedMs=$Clock.ElapsedMilliseconds }
    } catch { $failure=$_.Exception.Message }
    finally {
        $State.finalAttempted=$true
        try {
            $sample = & $FinalRead
            if ($null -eq $sample) { throw 'Final traffic sample missing' }
            $State.finalSampleStartedMs=$sample.StartedMs
            $State.finalSampleFinishedMs=$sample.FinishedMs
            $State.samples++
            [void]$Budget.Observe($sample)
        } catch { $State.readError=$_.Exception.Message }
    }
    [pscustomobject]@{ Process=$result; Failure=$failure }
}
function Assert-DatabaseTraffic($State, $Budget, [bool]$Stopped) {
    if (-not $State.finalAttempted -or $State.emptyConfirmedMs -lt 0 -or $State.readError -or
        -not $Budget.AccountingValid -or $Budget.StopReason -or $Budget.TotalBytes -gt 2097152UL -or
        $State.finalSampleStartedMs -lt $State.emptyConfirmedMs -or
        $State.finalSampleFinishedMs -lt $State.finalSampleStartedMs -or
        $State.finalSampleFinishedMs-$State.emptyConfirmedMs -gt 1000) { throw 'Actual final traffic accounting missing, late, invalid or excessive' }
    if ($Stopped -and ($State.stopDecisionMs -lt 0 -or $State.emptyConfirmedMs -lt $State.stopDecisionMs -or
        $State.emptyConfirmedMs-$State.stopDecisionMs -gt 2000)) { throw 'Stop-to-empty evidence missing or above 2 seconds' }
}
function Assert-DatabaseMappedPartition($Partition, $Disk, $Expected, [char]$Letter, [bool]$Sync20GiB=$false) {
    if ($Partition.DriveLetter -ine $Letter) { throw 'Owned partition drive letter changed' }
    # Reuse the GUID-only native guard on a projection after checking the sole
    # intentional difference. The original native control remains unchanged.
    $copy = [ordered]@{}
    foreach ($name in @('DiskNumber','PartitionNumber','Guid','Offset','Size','GptType','IsBoot','IsSystem','IsReadOnly','IsOffline')) {
        $copy[$name]=$Partition.$name
    }
    $copy.DriveLetter=[char]0
    Assert-ProbePartition ([pscustomobject]$copy) $Disk $Expected $Sync20GiB
}
function Read-DatabaseMarker([string]$Path, [string]$Expected) {
    if (-not [IO.File]::Exists($Path)) { return $false }
    $item=Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -ne $Expected.Length -or
        [IO.File]::ReadAllText($Path) -cne $Expected) { throw 'Invalid worker handshake marker' }
    return $true
}
function Assert-DatabaseResult($Result) {
    if ($Result.event -cne 'result' -or $Result.outcome -cne 'complete' -or $Result.mode -cne 'disk-full' -or
        $Result.diskFull -isnot [bool] -or -not $Result.diskFull -or $Result.capacityStatus -cne 'IOError/NoSpace' -or
        $Result.closeStatus -cnotin @('ok','IOError/NoSpace') -or
        -not $Result.baselineClosed -or -not $Result.finalClosed -or $Result.verifiedReads -lt 3 -or
        $Result.completedFlushes -lt 1 -or $Result.completedWrites -lt 0 -or $Result.completedWrites -gt 64 -or
        $Result.attemptedPayloadBytes -le 4096 -or $Result.attemptedPayloadBytes -gt 67112960L -or
        $Result.completedPayloadBytes -lt 4096 -or $Result.completedPayloadBytes -gt $Result.attemptedPayloadBytes -or
        $Result.maxPayloadBytes -ne 67112960L -or $Result.elapsedMs -gt 30000 -or $Result.errorClass -or $Result.error) {
        throw 'Database NoSpace, baseline, close or payload evidence unresolved'
    }
}
