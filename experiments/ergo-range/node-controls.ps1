# Fixed trusted offline controls; not arbitrary-program or network isolation.
param([switch]$EvidenceOnly)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Requires Windows x64 / PowerShell 7' }
Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeProcess.cs')
function Assert-NodeControl($Result) {
    if (-not $Result.LimitsReadBackBeforeResume -or -not $Result.JobEmptyAfterCleanup) { throw 'Job membership/cleanup unresolved' }
    if ($Result.CpuRateFlags -ne 5 -or $Result.CpuRatePer10000 -ne 2500) { throw 'CPU rate readback mismatch' }
    if ($Result.PeakCommitBytes -gt $Result.CommitLimitBytes -or
        $Result.PeakProcessCommitBytes -gt $Result.CommitLimitBytes -or
        $Result.SampledPeakPrivateCommitBytes -gt $Result.CommitLimitBytes) { throw 'Observed memory exceeds declared budget' }
    if ($Result.MaxSampledAssociatedProcesses -gt 1 -or $Result.BeforeResumeActiveProcesses -ne 1) { throw 'Associated-process evidence unresolved' }
}
if ($EvidenceOnly) {
    $sample = [pscustomobject]@{ LimitsReadBackBeforeResume=$true; JobEmptyAfterCleanup=$true;
        CpuRateFlags=5; CpuRatePer10000=2500; PeakCommitBytes=268435456;
        PeakProcessCommitBytes=268435456; SampledPeakPrivateCommitBytes=268435456;
        CommitLimitBytes=268435456; MaxSampledAssociatedProcesses=1; BeforeResumeActiveProcesses=1 }
    Assert-NodeControl $sample
    $cases = @{
        LimitsReadBackBeforeResume=$false; JobEmptyAfterCleanup=$false; CpuRateFlags=1;
        CpuRatePer10000=2501; PeakCommitBytes=268435457; PeakProcessCommitBytes=268435457;
        SampledPeakPrivateCommitBytes=268435457; MaxSampledAssociatedProcesses=2; BeforeResumeActiveProcesses=0
    }
    foreach ($key in $cases.Keys) {
        $previous = $sample.$key; $sample.$key = $cases[$key]; $refused = $false
        try { Assert-NodeControl $sample } catch { $refused = $true }
        $sample.$key = $previous
        if (-not $refused) { throw "Accepted invalid report: $key" }
    }
    Write-Output 'Node control evidence regressions passed (10 cases; no process launched).'
    exit 0
}
$nodeExecutable = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$worker = Join-Path $PSScriptRoot 'node-control-worker.mjs'
$results = [Collections.Generic.List[object]]::new()
foreach ($case in @('startup','memory-single-growth','descendant','wall','output','cpu-rate')) {
    $wall = if ($case -eq 'cpu-rate') { 5000 } elseif ($case -eq 'wall') { 1000 } else { 8000 }
    $memory = if ($case -eq 'cpu-rate') { 1073741824UL } else { 268435456UL }
    $result = [NodeProbeProcess]::Run($nodeExecutable, @($worker,$case), $PSScriptRoot,
        $case, $memory, $wall, 65536, $null)
    Assert-NodeControl $result
    if ($case -in @('wall','cpu-rate')) {
        if ($result.Outcome -ne 'wall-limit') { throw "Unexpected outcome for $case" }
    } elseif ($case -eq 'output') {
        if ($result.Outcome -ne 'output-limit') { throw 'Output limit did not stop worker' }
    } else {
        if ($result.Outcome -ne 'exited' -or $result.ExitCode -ne 0) { throw "Failed control $case : $($result.Output)" }
        $value = $result.Output | ConvertFrom-Json
        if ($case -eq 'memory-single-growth' -and $value.status -ne 'allocation-refused') { throw 'Missing memory refusal' }
        if ($case -eq 'descendant' -and $value.status -ne 'descendant-refused') { throw 'Missing descendant refusal' }
    }
    # CPU ticks are an observation, not a proof about cycles per scheduling interval.
    # Do not infer exact CPU-time containment from a quota status or average ratio.
    $results.Add($result)
}
$hashes = [ordered]@{}
foreach ($file in @('NodeProbeProcess.cs','node-control-worker.mjs','node-controls.ps1','contained-worker.mjs')) {
    $hashes[$file] = (Get-FileHash (Join-Path $PSScriptRoot $file) -Algorithm SHA256).Hash.ToLowerInvariant()
}
[ordered]@{ status='fixed-node-resource-controls-only'; node=(& $nodeExecutable --version);
    powershell=$PSVersionTable.PSVersion.ToString(); os=[Environment]::OSVersion.VersionString;
    logicalProcessors=[Environment]::ProcessorCount; cpuRatePer10000=2500;
    results=$results.ToArray(); files=$hashes;
    limits=@('CPU rate is the Windows scheduling-cycle contract, not an exact cumulative CPU-time bound.',
        'No filesystem/network isolation or hostile node/parser execution.',
        'Node controls do not establish JVM startup or production acceptance.') } | ConvertTo-Json -Depth 12
