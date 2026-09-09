# Offline feasibility only. No caller-supplied executable, corpus or network input.
param([switch]$StartupOnly)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Requires Windows x64 PowerShell 7' }
Add-Type -Path (Join-Path $PSScriptRoot 'ContainedProcess.cs')
$nodePath = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$workerPath = Join-Path $PSScriptRoot 'contained-worker.mjs'
$results = [System.Collections.Generic.List[object]]::new()
$unresolved = [System.Collections.Generic.List[string]]::new()
function Run-Case([string]$Name, [uint32]$CpuMs = 2000, [uint32]$WallMs = 8000) {
    $result = [ContainedProcess]::Run($nodePath, $workerPath, $Name, $CpuMs, $WallMs, 65536)
    if (-not $result.LimitsReadBackBeforeResume) {
        throw "Containment evidence unresolved: $Name"
    }
    $results.Add($result)
    if ($result.PeakCommitBytes -gt $result.CommitLimitBytes -or $result.PeakProcessCommitBytes -gt $result.CommitLimitBytes) {
        $unresolved.Add("$Name reported peak committed memory above its configured limit")
    }
    return $result
}
function Require-Success($Result) {
    if ($Result.Outcome -ne 'exited' -or $Result.ExitCode -ne 0 -or -not $Result.Output) {
        throw "Evidence unresolved for $($Result.Case): $($Result.Outcome), exit $($Result.ExitCode)"
    }
    return ($Result.Output | ConvertFrom-Json)
}
$startup = Require-Success (Run-Case 'startup')
if ($StartupOnly) { $results | ConvertTo-Json -Depth 12; exit 0 }
# Controls are independent. Do not execute hostile parser cases while any
# containment evidence is unresolved. The corpus below is the prior finite one.
$memory = Require-Success (Run-Case 'memory')
if ($memory.status -ne 'allocation-refused') { throw 'Memory control failed' }
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
    node = $startup.node
    powershell = $PSVersionTable.PSVersion.ToString()
    os = [Environment]::OSVersion.VersionString
    budgets = @{ committedBytes = 268435456; activeProcesses = 1; outputBytes = 65536;
        defaultUserCpuMs = 2000; defaultWallMs = 8000; corpusUserCpuMs = 10000; corpusWallMs = 30000 }
    results = $results
    files = $files
    unresolved = @($unresolved.ToArray())
    limitations = @('No hostile parser depth/count/declared-size cases were executed.',
        'User-CPU termination is periodically checked by Windows; wall/output limits are supervisor-enforced.',
        'Allocation RangeError and descendant failure alone do not identify their cause.',
        'The nested corpus report describes its original runner; effective outer limits are listed here.',
        'No filesystem/network isolation, production boundary, node equivalence or authenticated range evidence.')
} | ConvertTo-Json -Depth 12
if ($unresolved.Count) { exit 2 }
