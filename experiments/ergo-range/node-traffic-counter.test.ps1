# Pure regression checks for NodeTrafficCounter.Accumulator. Read() is never invoked.
$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'NodeTrafficCounter.cs')
$checks=0

function Assert-True([bool]$condition,[string]$message) {
    if (-not $condition) { throw $message }
    $script:checks++
}

function New-Row {
    param(
        [string]$Id,
        [UInt64]$Received=0,
        [UInt64]$Sent=0,
        [UInt64]$ReceiveErrors=0,
        [UInt64]$SendErrors=0,
        [UInt64]$ReceiveDiscards=0,
        [UInt64]$SendDiscards=0,
        [int]$Type=6,
        [int]$Status=1
    )
    [NodeTrafficCounter+Row]::new($Id,$Type,$Status,$Received,$Sent,$ReceiveErrors,$SendErrors,$ReceiveDiscards,$SendDiscards)
}

function New-Sample([long]$Started,[long]$Finished,[NodeTrafficCounter+Row[]]$Rows) {
    [NodeTrafficCounter+Sample]::new($Started,$Finished,$Rows)
}

function New-Accumulator([NodeTrafficCounter+Sample]$Baseline,[UInt64]$Trigger=1000,[long]$MaxGap=1000) {
    [NodeTrafficCounter+Accumulator]::new($Baseline,$Trigger,$MaxGap)
}

function Assert-InvalidObserve {
    param(
        [NodeTrafficCounter+Sample]$Baseline,
        [NodeTrafficCounter+Sample]$Invalid,
        [string]$Reason=''
    )
    $acc=New-Accumulator $Baseline 1000 1000
    Assert-True ($acc.Observe($Invalid)) "Invalid sample did not request stop: $Reason"
    Assert-True (-not $acc.AccountingValid) "Invalid sample remained valid: $Reason"
    Assert-True ($acc.TotalBytes -eq 0) "Invalid sample changed totals: $Reason"
    $before=$acc.StopReason
    $valid=New-Sample 30 31 @((New-Row 'a' -Received 999 -Sent 999))
    Assert-True ($acc.Observe($valid) -and -not $acc.AccountingValid -and $acc.TotalBytes -eq 0 -and $acc.StopReason -eq $before) "Invalid state was not terminal: $Reason"
}

# Independent receive/send deltas, exact trigger, and valid final post-stop accounting.
$baseline=New-Sample 0 2 @((New-Row 'a' -Received 100 -Sent 200),(New-Row 'b' -Received 10 -Sent 20))
$acc=New-Accumulator $baseline 15 100
$atLimit=New-Sample 10 20 @((New-Row 'a' -Received 105 -Sent 207),(New-Row 'b' -Received 12 -Sent 21))
Assert-True ($acc.Observe($atLimit)) 'Exact combined trigger did not stop'
Assert-True ($acc.ReceivedBytes -eq 7 -and $acc.SentBytes -eq 8 -and $acc.TotalBytes -eq 15) 'Receive/send deltas were not independent'
Assert-True ($acc.StopReason -eq 'traffic-threshold' -and $acc.FirstStopMs -eq 20 -and $acc.AccountingValid) 'Threshold stop properties mismatch'
$afterLimit=New-Sample 30 35 @((New-Row 'b' -Received 12 -Sent 21),(New-Row 'a' -Received 107 -Sent 210))
Assert-True ($acc.Observe($afterLimit)) 'Post-stop sample cleared sticky stop'
Assert-True ($acc.TotalBytes -eq 20 -and $acc.FirstStopMs -eq 20 -and $acc.LastSampleMs -eq 35) 'Final post-stop bytes or time were lost'
Assert-True ($acc.MaxGapMsObserved -eq 25 -and $acc.MaxGapMs -eq 100) 'Conservative gap observation mismatch'

# Zero traffic does not stop, and a zero threshold is already stopped at baseline.
$zeroBaseline=New-Sample 5 6 @((New-Row 'a' -Received 8 -Sent 9))
$zero=New-Accumulator $zeroBaseline 1 100
Assert-True (-not $zero.Observe((New-Sample 7 8 @((New-Row 'a' -Received 8 -Sent 9))))) 'Zero traffic stopped'
Assert-True ($zero.TotalBytes -eq 0 -and $zero.AccountingValid) 'Zero traffic changed accounting'
$zeroTrigger=New-Accumulator $zeroBaseline 0 100
Assert-True ($zeroTrigger.StopReason -eq 'traffic-threshold' -and $zeroTrigger.FirstStopMs -eq 6) 'Zero threshold did not stop at baseline'

# Sample input arrays and returned arrays cannot alias retained state.
$source=[NodeTrafficCounter+Row[]]@((New-Row 'a' -Received 1))
$copied=New-Sample 0 1 $source
$source[0]=New-Row 'changed'
$returned=$copied.Rows
$returned[0]=New-Row 'also-changed'
$aliasAcc=New-Accumulator $copied 100 100
Assert-True (-not $aliasAcc.Observe((New-Sample 2 3 @((New-Row 'a' -Received 2))))) 'Sample rows aliased caller mutation'
Assert-True ($aliasAcc.ReceivedBytes -eq 1) 'Aliasing changed retained counter'
$rowProperties=[NodeTrafficCounter+Row].GetProperties()
Assert-True (-not ($rowProperties | Where-Object CanWrite)) 'Row exposes a writable property'

# The same exact interface set is order-independent.
$ordered=New-Sample 0 1 @((New-Row 'a' -Received 1),(New-Row 'b' -Sent 2))
$reordered=New-Accumulator $ordered 100 100
Assert-True (-not $reordered.Observe((New-Sample 2 3 @((New-Row 'b' -Sent 5),(New-Row 'a' -Received 3))))) 'Reordered exact set was refused'
Assert-True ($reordered.ReceivedBytes -eq 2 -and $reordered.SentBytes -eq 3) 'Reordered set deltas mismatch'

# Interface add/remove, identity metadata changes, duplicates, and empty IDs fail closed.
$one=New-Sample 0 1 @((New-Row 'a' -Received 10 -Sent 10))
Assert-InvalidObserve $one (New-Sample 2 3 @((New-Row 'a' -Received 11 -Sent 11),(New-Row 'b'))) 'interface added'
Assert-InvalidObserve $one (New-Sample 2 3 @()) 'interface removed'
Assert-InvalidObserve $one (New-Sample 2 3 @((New-Row 'a' -Received 11 -Sent 11 -Type 7))) 'type changed'
Assert-InvalidObserve $one (New-Sample 2 3 @((New-Row 'a' -Received 11 -Sent 11 -Status 2))) 'status changed'
$two=New-Sample 0 1 @((New-Row 'a'),(New-Row 'b'))
Assert-InvalidObserve $two (New-Sample 2 3 @((New-Row 'a'),(New-Row 'a'))) 'duplicate ID'
Assert-InvalidObserve $one (New-Sample 2 3 @((New-Row ' '))) 'empty ID'

# Either successful-octet counter decreasing is a reset.
$counterBase=New-Sample 0 1 @((New-Row 'a' -Received 10 -Sent 10))
Assert-InvalidObserve $counterBase (New-Sample 2 3 @((New-Row 'a' -Received 9 -Sent 11))) 'receive reset'
Assert-InvalidObserve $counterBase (New-Sample 2 3 @((New-Row 'a' -Received 11 -Sent 9))) 'send reset'

# Every error/discard counter must remain exactly constant; increases and resets refuse accounting.
$errorBase=New-Sample 0 1 @((New-Row 'a' -ReceiveErrors 5 -SendErrors 5 -ReceiveDiscards 5 -SendDiscards 5))
$errorCases=@(
    (New-Row 'a' -ReceiveErrors 6 -SendErrors 5 -ReceiveDiscards 5 -SendDiscards 5),
    (New-Row 'a' -ReceiveErrors 5 -SendErrors 6 -ReceiveDiscards 5 -SendDiscards 5),
    (New-Row 'a' -ReceiveErrors 5 -SendErrors 5 -ReceiveDiscards 6 -SendDiscards 5),
    (New-Row 'a' -ReceiveErrors 5 -SendErrors 5 -ReceiveDiscards 5 -SendDiscards 6),
    (New-Row 'a' -ReceiveErrors 4 -SendErrors 5 -ReceiveDiscards 5 -SendDiscards 5),
    (New-Row 'a' -ReceiveErrors 5 -SendErrors 4 -ReceiveDiscards 5 -SendDiscards 5),
    (New-Row 'a' -ReceiveErrors 5 -SendErrors 5 -ReceiveDiscards 4 -SendDiscards 5),
    (New-Row 'a' -ReceiveErrors 5 -SendErrors 5 -ReceiveDiscards 5 -SendDiscards 4)
)
for ($i=0;$i -lt $errorCases.Count;$i++) {
    Assert-InvalidObserve $errorBase (New-Sample 2 3 @($errorCases[$i])) "error/discard case $i"
}

# Malformed timestamps and conservative start-to-finish sample gaps fail closed.
Assert-InvalidObserve $one (New-Sample -1 3 @((New-Row 'a' -Received 11 -Sent 11))) 'negative timestamp'
Assert-InvalidObserve $one (New-Sample 3 2 @((New-Row 'a' -Received 11 -Sent 11))) 'reversed timestamp'
$overlapBase=New-Sample 0 10 @((New-Row 'a'))
Assert-InvalidObserve $overlapBase (New-Sample 9 11 @((New-Row 'a'))) 'overlapping sample'
$gapAcc=New-Accumulator $overlapBase 100 20
Assert-True ($gapAcc.Observe((New-Sample 20 21 @((New-Row 'a'))))) 'Conservative gap did not stop'
Assert-True (-not $gapAcc.AccountingValid -and $gapAcc.StopReason -eq 'sample-gap' -and $gapAcc.MaxGapMsObserved -eq 21) 'Gap failure properties mismatch'

# Checked per-direction and combined totals overflow atomically.
$overflowRows=New-Sample 0 1 @((New-Row 'a'),(New-Row 'b'))
$overflowAcc=New-Accumulator $overflowRows ([UInt64]::MaxValue) 100
Assert-True ($overflowAcc.Observe((New-Sample 2 3 @((New-Row 'a' -Received ([UInt64]::MaxValue)),(New-Row 'b' -Received 1))))) 'Per-direction overflow did not stop'
Assert-True (-not $overflowAcc.AccountingValid -and $overflowAcc.TotalBytes -eq 0) 'Per-direction overflow partially committed'
$combinedBase=New-Sample 0 1 @((New-Row 'a'))
$combined=New-Accumulator $combinedBase ([UInt64]::MaxValue) 100
$maximumSample=New-Sample 2 3 @((New-Row 'a' -Received ([UInt64]::MaxValue)))
Assert-True ($combined.Observe($maximumSample)) 'Maximum exact receive total did not stop'
Assert-True ($combined.AccountingValid -and $combined.TotalBytes -eq [UInt64]::MaxValue) 'Maximum exact receive total mismatch'
$combinedOverflowSample=New-Sample 4 5 @((New-Row 'a' -Received ([UInt64]::MaxValue) -Sent 1))
Assert-True ($combined.Observe($combinedOverflowSample)) 'Combined overflow did not stay stopped'
Assert-True (-not $combined.AccountingValid -and $combined.ReceivedBytes -eq [UInt64]::MaxValue -and $combined.SentBytes -eq 0) 'Combined overflow changed last good totals'
Assert-True ($combined.StopReason -eq 'traffic-threshold' -and $combined.FirstStopMs -eq 3) 'Overflow cleared the earlier sticky trigger'

# Invalid constructor baselines refuse immediately.
foreach ($badBaseline in @(
    (New-Sample -1 0 @((New-Row 'a'))),
    (New-Sample 2 1 @((New-Row 'a'))),
    (New-Sample 0 1 @()),
    (New-Sample 0 1 @((New-Row 'a'),(New-Row 'a')))
)) {
    $threw=$false
    try { New-Accumulator $badBaseline 100 100 | Out-Null } catch [ArgumentException] { $threw=$true }
    Assert-True $threw 'Malformed baseline did not throw ArgumentException'
}
$many=[NodeTrafficCounter+Row[]]::new(257)
for ($i=0;$i -lt $many.Length;$i++) { $many[$i]=New-Row "id-$i" }
$threw=$false
try { New-Accumulator (New-Sample 0 1 $many) 100 100 | Out-Null } catch [ArgumentException] { $threw=$true }
Assert-True $threw 'Oversized baseline was accepted'
$threw=$false
try { New-Accumulator (New-Sample 0 101 @((New-Row 'a'))) 100 100 | Out-Null } catch [ArgumentException] { $threw=$true }
Assert-True $threw 'Oversized baseline duration was accepted'

Write-Output "Node traffic accumulator passed ($checks checks; pure inputs; no network enumeration)."
