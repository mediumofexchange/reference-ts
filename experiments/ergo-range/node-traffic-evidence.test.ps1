param([switch]$RecordedReport)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'node-traffic-evidence.ps1')
function New-Evidence {
    @{ Process=@{ JobEmptyAfterCleanup=$true; Outcome='observer-complete'; ExitCode=3758096385UL; LimitsReadBackBeforeResume=$true;
            CpuRateFlags=5; CpuRatePer10000=2500; PeakCommitBytes=10485760UL; PeakProcessCommitBytes=10485760UL;
            SampledPeakPrivateCommitBytes=10485760UL; MaxSampledAssociatedProcesses=1 };
        State=@{ readError=$null; stopDecisionMs=500L; emptyConfirmedMs=550L; finalSampleStartedMs=551L; finalSampleFinishedMs=570L };
        Budget=@{ AccountingValid=$true; StopReason='traffic-threshold'; FirstStopMs=495L; TotalBytes=16384UL } }
}
function Check-Evidence($Value, [bool]$ShouldPass) {
    $result=Get-NodeTrafficControlEvidence $Value.Process $Value.State $Value.Budget
    if (($result.Unresolved.Count -eq 0) -ne $ShouldPass) { throw "Unexpected evidence verdict: $($result | ConvertTo-Json -Compress)" }
    $script:cases++
}
$script:cases=0
Check-Evidence (New-Evidence) $true
$case=New-Evidence; $case.Budget.TotalBytes=2097152UL; Check-Evidence $case $true
$case=New-Evidence; $case.State.emptyConfirmedMs=2500L; $case.State.finalSampleStartedMs=2501L; $case.State.finalSampleFinishedMs=3500L
Check-Evidence $case $true # Both separately declared timing limits, exactly at their bounds.
$mutations=@(
    @('Process','Outcome','exited'), # Threshold reached only in final accounting is not a stop control.
    @('Process','Outcome','wall-limit'),
    @('Process','ExitCode',0), # Natural exit raced the observer callback despite observer-complete.
    @('State','readError','Final query failed'),
    @('State','emptyConfirmedMs',-1L),
    @('State','stopDecisionMs',-1L),
    @('State','finalSampleStartedMs',549L),
    @('State','finalSampleFinishedMs',1551L),
    @('State','finalSampleFinishedMs',550L),
    @('Budget','TotalBytes',2097153UL),
    @('Budget','TotalBytes',16383UL),
    @('Budget','AccountingValid',$false),
    @('Budget','StopReason','observation-invalid'),
    @('Budget','FirstStopMs',501L),
    @('Process','JobEmptyAfterCleanup',$false),
    @('Process','LimitsReadBackBeforeResume',$false),
    @('Process','CpuRateFlags',1),
    @('Process','CpuRatePer10000',2501),
    @('Process','PeakCommitBytes',268435457UL),
    @('Process','PeakProcessCommitBytes',268435457UL),
    @('Process','SampledPeakPrivateCommitBytes',268435457UL),
    @('Process','MaxSampledAssociatedProcesses',2)
)
foreach ($mutation in $mutations) {
    $case=New-Evidence; $case[$mutation[0]][$mutation[1]]=$mutation[2]; Check-Evidence $case $false
}
$case=New-Evidence; $case.State.emptyConfirmedMs=2501L; $case.State.finalSampleStartedMs=2502L; $case.State.finalSampleFinishedMs=2520L
Check-Evidence $case $false
Write-Output "Traffic control evidence regressions passed ($script:cases cases; no worker/network)."
if ($RecordedReport) {
    $report=Get-Content -Raw (Join-Path $PSScriptRoot '../../docs/ergo-traffic-stop-verification.json') | ConvertFrom-Json
    $budget=@{ AccountingValid=$report.accountingValid; StopReason=$report.stopReason;
        FirstStopMs=$report.firstStopMs; TotalBytes=[UInt64]$report.totalBytes }
    $evidence=Get-NodeTrafficControlEvidence $report.process $report.observations $budget
    if ($report.status -ne 'host-traffic-accounting-stop-only' -or $evidence.Unresolved.Count) {
        throw "Recorded observation does not meet the final classifier: $($evidence | ConvertTo-Json -Compress)"
    }
    Write-Output 'Recorded native observation passes the final classifier; no transfer repeated.'
}
