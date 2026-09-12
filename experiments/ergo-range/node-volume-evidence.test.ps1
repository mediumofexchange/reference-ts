$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'node-volume-evidence.ps1')
$process=@{LimitsReadBackBeforeResume=$true;JobEmptyAfterCleanup=$true;LaunchMode='detached';CreationFlags=525324;
    Outcome='observer-complete';ExitCode=3758096385UL;TotalProcesses=1;BeforeResumeActiveProcesses=1;
    MaxSampledAssociatedProcesses=1;CommitLimitBytes=4294967296UL;PeakCommitBytes=1UL;PeakProcessCommitBytes=1UL;
    SampledPeakPrivateCommitBytes=1UL;CpuRateFlags=5;CpuRatePer10000=2500;ElapsedMs=73000L;CapturedOutputBytes=65536L}
$state=@{finalAttempted=$true;readError=$null;stopDecisionMs=73000L;emptyConfirmedMs=73100L;finalSampleStartedMs=73101L;finalSampleFinishedMs=73102L}
$budget=@{AccountingValid=$true;StopReason=$null;TotalBytes=1000UL}
$cases=0
function Expect-Refusal([scriptblock]$Check) {
    $failed=$false
    try { & $Check } catch { $failed=$true }
    if (-not $failed) { throw 'Invalid observation accepted' }
    $script:cases++
}
Assert-VolumeNodeProcess $process; Assert-VolumeNodeTraffic $state $budget; $cases+=2
foreach ($mutation in @(
    @('JobEmptyAfterCleanup',$false),@('LimitsReadBackBeforeResume',$false),@('Outcome','wall-limit'),@('ExitCode',0),
    @('TotalProcesses',2),@('MaxSampledAssociatedProcesses',2),@('CommitLimitBytes',8589934592UL),
    @('PeakCommitBytes',4294967297UL),@('PeakProcessCommitBytes',4294967297UL),@('SampledPeakPrivateCommitBytes',4294967297UL),
    @('CpuRatePer10000',2501),@('ElapsedMs',120001L),@('CapturedOutputBytes',15728641L))) {
    $bad=$process.Clone(); $bad[$mutation[0]]=$mutation[1]; Expect-Refusal { Assert-VolumeNodeProcess $bad }
}
foreach ($mutation in @(@('finalAttempted',$false),@('readError','missing'),@('stopDecisionMs',-1L),
    @('emptyConfirmedMs',75001L),@('finalSampleStartedMs',73099L),@('finalSampleFinishedMs',74101L))) {
    $bad=$state.Clone(); $bad[$mutation[0]]=$mutation[1]; Expect-Refusal { Assert-VolumeNodeTraffic $bad $budget }
}
foreach ($mutation in @(@('AccountingValid',$false),@('StopReason','sample-gap'),@('StopReason','traffic-threshold'),@('TotalBytes',10737418241UL))) {
    $bad=$budget.Clone(); $bad[$mutation[0]]=$mutation[1]; Expect-Refusal { Assert-VolumeNodeTraffic $state $bad }
}
$edge=$state.Clone(); $edge.emptyConfirmedMs=75000L; $edge.finalSampleStartedMs=75001L; $edge.finalSampleFinishedMs=76000L
Assert-VolumeNodeTraffic $edge $budget; $cases++
Write-Output "Offline volume evidence checks passed ($cases cases; no disk, node or network)."
