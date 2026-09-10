# No JVM, traffic reads, storage mutations or native library loads.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Add-Type -Path (Join-Path $PSScriptRoot 'NodeTrafficCounter.cs')
. (Join-Path $PSScriptRoot 'node-database-evidence.ps1')
$checks=0
function Check([bool]$Condition,[string]$Label) { if (-not $Condition) { throw $Label }; $script:checks++ }
function Refuses([scriptblock]$Action,[string]$Label) {
    $refused=$false; try { & $Action } catch { $refused=$true }; Check $refused $Label
}
function Sample([long]$Start=0,[long]$End=0,[ulong]$Bytes=0) {
    [NodeTrafficCounter+Sample]::new($Start,$End,@([NodeTrafficCounter+Row]::new('test',6,1,$Bytes,0,0,0,0,0)))
}
function Budget { [NodeTrafficCounter+Accumulator]::new((Sample),1048576UL,1000L) }
foreach ($failure in @('missing','late','throwing','threshold')) {
    $budget=Budget; $state=New-DatabaseTrafficState
    $stopped=Update-DatabaseTraffic $budget $state {
        switch ($failure) { 'missing' {$null}; 'late' {Sample 1001 1001}; 'throwing' {throw 'reader failed'}; 'threshold' {Sample 250 250 1048576UL} }
    }
    Check $stopped "$failure did not request stop"
    Check ($state.readError -or $budget.StopReason) "$failure lost refusal reason"
}
# Every launcher result/failure must still attempt final accounting once.
foreach ($outcome in @('exited','wall-limit','output-limit','observer-complete','launch-throws','cleanup-throws')) {
    $budget=Budget; $state=New-DatabaseTrafficState; $script:finalCalls=0
    $result=Invoke-DatabaseAccountedRun {
        if ($outcome.EndsWith('throws')) { throw $outcome }
        [pscustomobject]@{JobEmptyAfterCleanup=$true;Outcome=$outcome}
    } { $script:finalCalls++; Sample 300 301 10 } $budget $state ([pscustomobject]@{ElapsedMilliseconds=300L})
    Check ($state.finalAttempted -and $script:finalCalls -eq 1 -and $state.finalSampleFinishedMs -eq 301) "Lost final accounting: $outcome"
    if ($outcome.EndsWith('throws')) {
        Check ($result.Failure -eq $outcome -and $state.emptyConfirmedMs -eq -1) 'Failure fabricated empty job'
        Refuses { Assert-DatabaseTraffic $state $budget $false } 'Accepted missing empty-job evidence'
    } else { Assert-DatabaseTraffic $state $budget $false; Check $true 'Valid final sample' }
}
foreach ($finalCase in @('missing','throwing','late','excess')) {
    $budget=Budget; $state=New-DatabaseTrafficState
    [void](Invoke-DatabaseAccountedRun { [pscustomobject]@{JobEmptyAfterCleanup=$true} } {
        switch ($finalCase) { 'missing' {$null}; 'throwing' {throw 'final failed'}; 'late' {Sample 1301 1301}; 'excess' {Sample 300 301 2097153UL} }
    } $budget $state ([pscustomobject]@{ElapsedMilliseconds=300L}))
    Refuses { Assert-DatabaseTraffic $state $budget $false } "Accepted final $finalCase"
}
$state=New-DatabaseTrafficState; $budget=Budget
$state.finalAttempted=$true; $state.emptyConfirmedMs=2301L; $state.stopDecisionMs=300L
$state.finalSampleStartedMs=2301L; $state.finalSampleFinishedMs=2302L
Refuses { Assert-DatabaseTraffic $state $budget $true } 'Accepted slow job stop'
$valid=[ordered]@{event='result';outcome='complete';mode='disk-full';diskFull=$true;capacityStatus='IOError/NoSpace';
    closeStatus='ok';baselineClosed=$true;finalClosed=$true;verifiedReads=3;completedFlushes=1;completedWrites=0;
    attemptedPayloadBytes=1052672L;completedPayloadBytes=4096L;maxPayloadBytes=67112960L;elapsedMs=5000;errorClass=$null;error=$null}
Assert-DatabaseResult ([pscustomobject]$valid); Check $true 'Valid disk-full boundary rejected'
foreach ($change in @(@{capacityStatus='IOError/None'},@{diskFull=$false},@{closeStatus='IOError/None'},@{baselineClosed=$false},
    @{finalClosed=$false},@{verifiedReads=2},@{attemptedPayloadBytes=67112961L},@{completedPayloadBytes=1052673L},@{error='unexpected'})) {
    $bad=[ordered]@{}; foreach ($entry in $valid.GetEnumerator()) { $bad[$entry.Key]=$entry.Value }
    foreach ($entry in $change.GetEnumerator()) { $bad[$entry.Key]=$entry.Value }
    Refuses { Assert-DatabaseResult ([pscustomobject]$bad) } 'Accepted false database evidence'
}
Write-Output "Database evidence: $checks checks passed; no disk/JVM/network execution."
