# Offline feasibility only. No caller-supplied executable, corpus or network input.
param([switch]$StartupOnly, [switch]$EvidenceOnly,
    [ValidateSet('no-window', 'detached')][string]$LaunchMode = 'no-window')
$ErrorActionPreference = 'Stop'
$LaunchMode = $LaunchMode.ToLowerInvariant()
function Get-ResourceIssues($Result) {
    if ($Result.PeakCommitBytes -gt $Result.CommitLimitBytes -or
        $Result.PeakProcessCommitBytes -gt $Result.CommitLimitBytes -or
        $Result.SampledPeakPrivateCommitBytes -gt $Result.CommitLimitBytes) {
        "$($Result.Case) reported peak committed memory above its configured limit"
    }
    if ($Result.UserCpuTicks -gt $Result.UserCpuLimitTicks -or $Result.JobUserCpuTicks -gt $Result.UserCpuLimitTicks) {
        "$($Result.Case) reported user CPU above its configured threshold"
    }
    if ($Result.MaxSampledAssociatedProcesses -gt 1) {
        "$($Result.Case) observed multiple associated process IDs; process-limit evidence unresolved"
    } elseif ($Result.BeforeResumeActiveProcesses -gt 1 -or $Result.ActiveProcessesAfterExit -gt 1) {
        "$($Result.Case) recorded multiple active job accounting entries; process-limit evidence unresolved"
    }
}
if ($EvidenceOnly) {
    # A quota exit used to pass despite measured CPU overshoot. Retain the
    # earlier isolated observation without launching a worker for this regression.
    $sample = [pscustomobject]@{ Case = 'cpu'; Outcome = 'exited'; ExitCode = 3221225540;
        UserCpuTicks = 13750000; JobUserCpuTicks = 13750000; UserCpuLimitTicks = 10000000;
        PeakCommitBytes = 28872704; PeakProcessCommitBytes = 22290432;
        SampledPeakPrivateCommitBytes = 22290432; CommitLimitBytes = 268435456;
        MaxSampledAssociatedProcesses = 1; BeforeResumeActiveProcesses = 1; ActiveProcessesAfterExit = 0 }
    if (@(Get-ResourceIssues $sample).Count -ne 1) { throw 'CPU overshoot regression' }
    $sample.UserCpuTicks = $sample.JobUserCpuTicks = 10000000
    if (@(Get-ResourceIssues $sample).Count -ne 0) { throw 'Exact boundary regression' }
    $sample.JobUserCpuTicks = 10000001
    if (@(Get-ResourceIssues $sample).Count -ne 1) { throw 'Job CPU overshoot regression' }
    $sample.JobUserCpuTicks = 10000000
    $sample.PeakCommitBytes = 273514496
    if (@(Get-ResourceIssues $sample).Count -ne 1) { throw 'Job memory overshoot regression' }
    $sample.PeakCommitBytes = 268435456
    $sample.SampledPeakPrivateCommitBytes = 268435457
    if (@(Get-ResourceIssues $sample).Count -ne 1) { throw 'Independent memory overshoot regression' }
    $sample.SampledPeakPrivateCommitBytes = 268435456
    $sample.MaxSampledAssociatedProcesses = 2
    if (@(Get-ResourceIssues $sample).Count -ne 1) { throw 'Active-process overshoot regression' }
    $sample.MaxSampledAssociatedProcesses = 1
    $sample.BeforeResumeActiveProcesses = 2
    if (@(Get-ResourceIssues $sample).Count -ne 1) { throw 'Before-resume accounting regression' }
    $sample.BeforeResumeActiveProcesses = 1
    $sample.ActiveProcessesAfterExit = 2
    if (@(Get-ResourceIssues $sample).Count -ne 1) { throw 'After-exit accounting regression' }
    Write-Output 'Resource evidence regressions passed (8 cases; no worker executed).'
    exit 0
}
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Requires Windows x64 PowerShell 7' }
Add-Type -Path (Join-Path $PSScriptRoot 'ContainedProcess.cs')
$nodePath = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$workerPath = Join-Path $PSScriptRoot 'contained-worker.mjs'
$results = [System.Collections.Generic.List[object]]::new()
$unresolved = [System.Collections.Generic.List[string]]::new()
function Run-Case([string]$Name, [uint32]$CpuMs = 2000, [uint32]$WallMs = 8000) {
    $result = [ContainedProcess]::Run($nodePath, $workerPath, $Name, $CpuMs, $WallMs, 65536, $LaunchMode)
    $expectedFlags = if ($LaunchMode -eq 'detached') { 0x8000c } else { 0x8080004 }
    if ($result.LaunchMode -cne $LaunchMode -or $result.CreationFlags -ne $expectedFlags) {
        throw "Launch mode evidence mismatch: $Name"
    }
    if (-not $result.LimitsReadBackBeforeResume -or -not $result.JobEmptyAfterCleanup) {
        throw "Containment evidence unresolved: $Name"
    }
    $results.Add($result)
    foreach ($issue in @(Get-ResourceIssues $result)) { $unresolved.Add($issue) }
    return $result
}
function Require-Success($Result) {
    if ($Result.Outcome -ne 'exited' -or $Result.ExitCode -ne 0 -or -not $Result.Output) {
        throw "Evidence unresolved for $($Result.Case): $($Result.Outcome), exit $($Result.ExitCode)"
    }
    return ($Result.Output | ConvertFrom-Json)
}
$startup = Require-Success (Run-Case 'startup')
if ($StartupOnly) {
    [ordered]@{ status = $(if ($unresolved.Count) { 'unresolved-containment-evidence' } else { 'startup-diagnostics-only' });
        launchMode = $LaunchMode;
        results = $results; unresolved = @($unresolved.ToArray()) } | ConvertTo-Json -Depth 12
    if ($unresolved.Count) { exit 2 }
    exit 0
}
# Controls are independent. Do not execute hostile parser cases while any
# containment evidence is unresolved. The corpus below is the prior finite one.
$memory = Require-Success (Run-Case 'memory')
if ($memory.status -ne 'allocation-refused') { throw 'Memory control failed' }
$singleGrowth = Require-Success (Run-Case 'memory-single-growth')
if ($singleGrowth.status -ne 'allocation-refused' -or $singleGrowth.retainedWasmBytes -ne 65536) {
    throw 'Single-growth memory control failed'
}
$cpu = Run-Case 'cpu' 1000 8000
# Win32 ERROR_NOT_ENOUGH_QUOTA or native STATUS_QUOTA_EXCEEDED. Check observed
# user time as well; neither code alone establishes the reason for termination.
if ($cpu.Outcome -ne 'exited' -or $cpu.ExitCode -notin @(1816, 3221225540) -or $cpu.UserCpuTicks -lt 10000000) {
    $unresolved.Add("User-CPU termination evidence unresolved: $($cpu.Outcome), exit $($cpu.ExitCode), ticks $($cpu.UserCpuTicks)")
}
$wall = Run-Case 'wall' 2000 1000
if ($wall.Outcome -ne 'wall-limit' -or $wall.Output) { throw 'Wall control failed' }
$output = Run-Case 'output'
if ($output.Outcome -ne 'output-limit' -or $output.Output) { throw 'Output control failed' }
$descendant = Require-Success (Run-Case 'descendant')
if ($descendant.status -ne 'descendant-refused') { throw 'Process-count control failed' }
$corpus = Require-Success (Run-Case 'corpus' 10000 30000)
if ($corpus.checks -ne 14874 -or $corpus.fieldBoundaryAliasesRecovered -ne 65) { throw 'Corpus result changed' }
$files = [ordered]@{}
foreach ($file in @('ContainedProcess.cs', 'contained-worker.mjs', 'contained-check.ps1', 'decoder-cases.mjs', 'fixtures/manifest.json', 'package-lock.json')) {
    $files[$file] = (Get-FileHash (Join-Path $PSScriptRoot $file) -Algorithm SHA256).Hash.ToLowerInvariant()
}
[ordered]@{
    status = $(if ($unresolved.Count) { 'unresolved-containment-evidence' } else { 'offline-windows-controls-only' })
    launchMode = $LaunchMode
    node = $startup.node
    powershell = $PSVersionTable.PSVersion.ToString()
    os = [Environment]::OSVersion.VersionString
    budgets = @{ committedBytes = 268435456; activeProcesses = 1; outputBytes = 65536;
        defaultUserCpuMs = 2000; defaultWallMs = 8000; corpusUserCpuMs = 10000; corpusWallMs = 30000 }
    results = $results
    files = $files
    unresolved = @($unresolved.ToArray())
    limitations = @('No hostile parser depth/count/declared-size cases were executed.',
        'User-CPU termination is periodically checked by Windows without a documented maximum overshoot; kernel CPU is separate.',
        'Wall/output limits are supervisor-enforced; memory sampling is diagnostic, not an enforcement mechanism.',
        'Independent private-commit peaks are sampled and may miss the final interval before exit.',
        'Process-ID/image observations are bounded samples; failed associations also count toward lifetime TotalProcesses.',
        'Detached launch avoids inheriting a console; it does not prevent later console allocation or isolate untrusted programs.',
        'Allocation RangeError and descendant failure alone do not identify their cause.',
        'The nested corpus report describes its original runner; effective outer limits are listed here.',
        'No filesystem/network isolation, production boundary, node equivalence or authenticated range evidence.')
} | ConvertTo-Json -Depth 12
if ($unresolved.Count) { exit 2 }
