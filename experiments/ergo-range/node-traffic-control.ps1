# Fixed public GET plus host accounting/whole-job stop. Never launches an Ergo node.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Requires Windows x64 / PowerShell 7' }
Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeProcess.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'NodeTrafficCounter.cs')
. (Join-Path $PSScriptRoot 'node-traffic-evidence.ps1')
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$curl = Join-Path ([Environment]::GetFolderPath('System')) 'curl.exe'
if (-not (Test-Path -LiteralPath $curl -PathType Leaf)) { throw 'System curl is unavailable' }
$url = 'https://raw.githubusercontent.com/mediumofexchange/reference-ts/4af6af4e02997ae880147ebacbd0f38f61303aa8/experiments/ergo-range/fixtures/mainnet-1000000.json'
# -q FIRST disables curlrc. Explicitly avoid proxies, redirects, retries and credentials.
$arguments = @('-q','--noproxy','*','--proto','=https','--proto-redir','=https',
    '--http1.1','--max-time','8','--connect-timeout','5','--max-filesize','65536',
    '--limit-rate','8192','--output','NUL','--fail','--no-progress-meter','--url',$url)
$script:trafficClock = [Diagnostics.Stopwatch]::StartNew()
$baseline = [NodeTrafficCounter]::Read($script:trafficClock)
$script:trafficBudget = [NodeTrafficCounter+Accumulator]::new($baseline,16384UL,1000L)
$script:trafficState = [ordered]@{ stopDecisionMs=-1L; emptyConfirmedMs=-1L;
    finalSampleStartedMs=-1L; finalSampleFinishedMs=-1L; readError=$null; samples=1 }
$observer = [Func[uint32,long,bool]] {
    param($processId,$outputBytes)
    $stop = $false
    try {
        $sample = [NodeTrafficCounter]::Read($script:trafficClock)
        $script:trafficState.samples++
        $stop = $script:trafficBudget.Observe($sample)
    } catch [Net.NetworkInformation.NetworkInformationException] {
        $script:trafficState.readError=$_.Exception.Message; $stop=$true
    } catch [InvalidOperationException] {
        $script:trafficState.readError=$_.Exception.Message; $stop=$true
    }
    if ($stop) { $script:trafficState.stopDecisionMs=$script:trafficClock.ElapsedMilliseconds }
    return $stop
}
$result = [NodeProbeProcess]::Run($curl,$arguments,$repo,'host-traffic-stop',268435456UL,10000,65536,$observer)
if ($result.JobEmptyAfterCleanup) { $script:trafficState.emptyConfirmedMs=$script:trafficClock.ElapsedMilliseconds }
# Always attempt final accounting; a failed/late sample never becomes zero traffic.
try {
    $final = [NodeTrafficCounter]::Read($script:trafficClock)
    $script:trafficState.finalSampleStartedMs=$final.StartedMs
    $script:trafficState.finalSampleFinishedMs=$final.FinishedMs
    $script:trafficState.samples++
    [void]$script:trafficBudget.Observe($final)
} catch [Net.NetworkInformation.NetworkInformationException] {
    $script:trafficState.readError=$_.Exception.Message
} catch [InvalidOperationException] {
    $script:trafficState.readError=$_.Exception.Message
}
$state=$script:trafficState; $budget=$script:trafficBudget
$acceptance=Get-NodeTrafficControlEvidence $result $state $budget
$unresolved=$acceptance.Unresolved; $stopLatency=$acceptance.StopLatencyMs
$hashes=[ordered]@{}
foreach ($file in @('NodeProbeProcess.cs','NodeTrafficCounter.cs','node-traffic-counter.test.ps1','node-traffic-control.ps1',
    'node-traffic-evidence.ps1','node-traffic-evidence.test.ps1')) {
    $hashes[$file]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $file) -Algorithm SHA256).Hash.ToLowerInvariant()
}
[ordered]@{ status=$(if ($unresolved.Count) {'unresolved-host-traffic-stop'} else {'host-traffic-accounting-stop-only'});
    observedAtUtc=[DateTime]::UtcNow.ToString('o'); os=[Environment]::OSVersion.VersionString;
    powershell=$PSVersionTable.PSVersion.ToString(); runtime=[Runtime.InteropServices.RuntimeInformation]::FrameworkDescription;
    curlFileVersion=(Get-Item -LiteralPath $curl).VersionInfo.FileVersion;
    curlSha256=(Get-FileHash -LiteralPath $curl -Algorithm SHA256).Hash.ToLowerInvariant();
    url=$url; arguments=$arguments; interfaceCount=$baseline.Rows.Count;
    baselineStartedMs=$baseline.StartedMs; baselineFinishedMs=$baseline.FinishedMs;
    triggerBytes=16384UL; finalMaximumBytes=2097152UL; maxSampleGapMs=1000;
    maxStopLatencyMs=2000; maxFinalSampleDelayMs=1000;
    receiveBytes=$budget.ReceivedBytes; sendBytes=$budget.SentBytes; totalBytes=$budget.TotalBytes;
    triggerOvershootBytes=$(if ($budget.TotalBytes -gt 16384UL) {$budget.TotalBytes-16384UL} else {0UL});
    accountingValid=$budget.AccountingValid; stopReason=$budget.StopReason;
    maxObservedSampleGapMs=$budget.MaxGapMsObserved; lastGoodSampleMs=$budget.LastSampleMs;
    firstStopMs=$budget.FirstStopMs; stopToEmptyConfirmedMs=$stopLatency; observations=$state;
    process=$result; unresolved=$unresolved; files=$hashes;
    limitations=@('Successful exposed-interface octets, not physical wire, ISP billing or complete link overhead.',
        'Includes unrelated host traffic and duplicate virtual-interface accounting; no per-curl attribution.',
        'Stable trusted host/counter continuity assumed; hidden reset/regrowth and transient interfaces can evade samples.',
        'No bound under a permanently stalled supervisor; no hard network quota or isolation.',
        'No Ergo peers, full sync, disk-control or production acceptance evidence.') } | ConvertTo-Json -Depth 12
if ($unresolved.Count) { exit 2 }
