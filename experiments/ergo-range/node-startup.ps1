# Finite stock-node experiment. No sync, signing, arbitrary URL or private API client.
param([switch]$Stable)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Requires Windows x64 / PowerShell 7' }
Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeProcess.cs')
. (Join-Path $PSScriptRoot 'node-evidence.ps1')
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$packageVersion = if ($Stable) { '6.0.5' } else { '6.1.5' }
$manifestHash = if ($Stable) { 'df98bdbfa029ad3aaeabb3968a2b73cdaa92769d93192bc25b4c8f298102dce6' } else { '5a5d8e06d006f53b15502e4e64b8f158a8112fd8ee65b75ff84790718ac2d067' }
$archiveHash = if ($Stable) { '28be43dd010792bc72d320952dcfde368a9a21e3926409f78757e6218583ea06' } else { '7d8c010b781841631f8968e424e30ea99f2352ac0cd40ef32c72e90c37d0af73' }
$jarHash = if ($Stable) { '2a7e2978cb09538ed6780d85ae3aa39c1ecce10e5e5a6e0dc3cd8ab087851588' } else { '4ada5520636a65d7be09b6ec3ff8044b8fdc5baf552633b8c4f6335f71b93928' }
$scratch = Join-Path $repo $(if ($Stable) { 'scratch/ergo-stable' } else { 'scratch/node-startup' })
$bundle = Join-Path $scratch 'bundle'
$run = Join-Path $scratch 'run'
if (Test-Path -LiteralPath $run) { throw 'Startup requires an absent run directory' }
$manifestPath=Join-Path $scratch 'bundle-manifest.json'
if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash -ine $manifestHash) { throw 'Manifest bytes changed' }
$manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json -AsHashtable
foreach ($root in @((Join-Path $repo 'scratch'),$scratch,$bundle)) {
    if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse root refused' }
}
$bundleEntries=@(Get-ChildItem -LiteralPath $bundle -Recurse -Force)
if (@($bundleEntries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -ne 0 -or
    @($bundleEntries | Where-Object { -not $_.PSIsContainer }).Count -ne 167) { throw 'Unexpected bundle entry' }
if ($manifest.archiveSha256 -ne $archiveHash -or $manifest.files.Count -ne 167) { throw 'Bundle manifest mismatch' }
foreach ($entry in $manifest.files.GetEnumerator()) {
    $file = [IO.Path]::GetFullPath((Join-Path $bundle $entry.Key))
    if (-not $file.StartsWith($bundle + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or
        (Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.Value) { throw 'Bundle file changed' }
}
if ($manifest.files["ergo-$packageVersion.jar"] -ne $jarHash) { throw 'JAR mismatch' }
foreach ($port in @(19053,19030)) {
    if ([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port -contains $port) { throw 'Probe port already in use' }
}
foreach ($directory in @($run,"$run/data","$run/secrets","$run/tmp","$run/home")) { New-Item -ItemType Directory -Path $directory | Out-Null }
# Random hash target, not a hash of a retained/generated API-key preimage.
$authTarget = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$path = $run.Replace('\','/')
$config = @"
ergo.directory = "$path/data"
ergo.networkType = "mainnet"
ergo.node {
  stateType = "utxo"
  verifyTransactions = true
  blocksToKeep = -1
  utxo.utxoBootstrap = false
  utxo.storingUtxoSnapshots = 0
  nipopow.nipopowBootstrap = false
  checkpoint = null
  mining = false
  offlineGeneration = false
  extraIndex = false
}
ergo.wallet.secretStorage.secretDir = "$path/secrets"
ergo.wallet.testMnemonic = null
ergo.wallet.testKeysQty = null
scorex.dataDir = "$path/data"
scorex.logDir = "$path"
scorex.logging.level = "INFO"
scorex.restApi {
  bindAddress = "127.0.0.1:19053"
  apiKeyHash = "$authTarget"
  publicUrl = null
  corsAllowedOrigin = null
}
scorex.network {
  bindAddress = "127.0.0.1:19030"
  knownPeers = []
  bannedPeers = []
  peerDiscovery = false
  maxConnections = 0
  upnpEnabled = false
  declaredAddress = null
  nodeName = "moe-offline-source-probe"
}
"@
[IO.File]::WriteAllText("$run/ergo.conf",$config,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText("$run/logback.xml",'<configuration><appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender"><encoder><pattern>%level %logger - %msg%n</pattern></encoder></appender><root level="INFO"><appender-ref ref="STDOUT"/></root></configuration>',[Text.UTF8Encoding]::new($false))
$java = Join-Path $bundle 'jre/bin/java.exe'
$version = [NodeProbeProcess]::Run($java,@('-XshowSettings:properties',"-Duser.home=$run/home","-Djava.io.tmpdir=$run/tmp",'-version'),$run,'java-version',4294967296UL,15000,65536,$null)
if ($version.Outcome -ne 'exited' -or $version.ExitCode -ne 0 -or -not $version.JobEmptyAfterCleanup -or $version.Output -notmatch 'java.version = 21\.0\.1') { throw "Pinned Java startup failed: $($version.Output)" }
$arguments = @('-Xms128m','-Xmx2g',"-Duser.home=$run/home","-Djava.io.tmpdir=$run/tmp",
    "-Dlogback.configurationFile=$run/logback.xml",'-Djava.net.preferIPv4Stack=true',
    "-XX:ErrorFile=$run/hs_err.log",'-XX:-CreateCoredumpOnCrash',
    '-jar',"$bundle/ergo-$packageVersion.jar",'--mainnet','-c',"$run/ergo.conf")
$reader=[NodeProbeProcess+StartupReader]::new()
$script:nodeObservation = [ordered]@{ socketSamples=0; sockets=[Collections.Generic.List[object]]::new();
    replies=[ordered]@{}; apiBytes=0L; readyAtMs=-1L; nextProbeMs=0L; filesPeakBytes=0L;
    unresolved=[Collections.Generic.List[string]]::new() }
$script:pendingNodeRead=$null; $script:pendingNodeEndpoint=$null
$probeClock = [Diagnostics.Stopwatch]::StartNew()
$observer = [Func[uint32,long,bool]] {
    param($processId,$capturedOutputBytes)
    $state=$script:nodeObservation
    $sockets=[NodeProbeProcess]::Sockets($processId); $state.socketSamples++
    foreach ($socket in $sockets) {
        if ($socket.Protocol -eq 'udp' -or $socket.LocalAddress -ne '127.0.0.1' -or
            ($socket.State -ne 2 -and $socket.RemoteAddress -notin @('127.0.0.1','0.0.0.0'))) {
            $state.unresolved.Add('Unexpected socket observed'); return $true
        }
        if ($state.sockets.Count -lt 64 -and -not ($state.sockets | Where-Object {
            $_.Protocol -eq $socket.Protocol -and $_.LocalPort -eq $socket.LocalPort -and $_.State -eq $socket.State })) { $state.sockets.Add($socket) }
    }
    if ($probeClock.ElapsedMilliseconds -lt $state.nextProbeMs) { return $false }
    $state.nextProbeMs=$probeClock.ElapsedMilliseconds+1000
    $files=@(Get-ChildItem -LiteralPath $run -Recurse -File)
    if ($files.Count -gt 4096) { $state.unresolved.Add('File-count budget exceeded'); return $true }
    $fileBytes=($files | Measure-Object Length -Sum).Sum
    $state.filesPeakBytes=[Math]::Max($state.filesPeakBytes,$fileBytes)
    # Startup uses only a fresh genesis directory. This is observation, not a disk quota.
    if ($fileBytes+$capturedOutputBytes -gt 16777216) { $state.unresolved.Add('Combined startup file/output observation exceeds 16 MiB'); return $true }
    if (@(Get-ChildItem -LiteralPath "$run/secrets" -Force).Count -ne 0) { $state.unresolved.Add('Secret storage no longer empty'); return $true }
    # Predeclared observation schedule: first request no earlier than 60 seconds.
    # Listener presence alone is not application readiness. No request is retried.
    if ($probeClock.ElapsedMilliseconds -lt 60000 -or -not ($sockets | Where-Object { $_.State -eq 2 -and $_.LocalPort -eq 19053 })) { return $false }
    if ($script:pendingNodeRead) {
        if (-not $script:pendingNodeRead.IsCompleted) { return $false }
        try {
            $reply=$script:pendingNodeRead.GetAwaiter().GetResult()
            $state.apiBytes+=$reply.Bytes
            $state.replies[$script:pendingNodeEndpoint]=[ordered]@{status=$reply.Status; body=$reply.Body}
        } catch { $state.unresolved.Add("API observation failed: $script:pendingNodeEndpoint : $($_.Exception.Message)"); return $true }
        $script:pendingNodeRead=$null
    }
    foreach ($endpoint in @('/info','/peers/connected','/wallet/status')) {
        if ($state.replies.Contains($endpoint)) { continue }
        $script:pendingNodeEndpoint=$endpoint
        $script:pendingNodeRead=$reader.ReadOnce($endpoint)
        break
    }
    if ($state.replies.Count -eq 3) {
        if ($state.readyAtMs -lt 0) { $state.readyAtMs=$probeClock.ElapsedMilliseconds }
        return ($probeClock.ElapsedMilliseconds-$state.readyAtMs -ge 10000)
    }
    return $false
}
try { $result=[NodeProbeProcess]::Run($java,$arguments,$run,'stock-node-startup',4294967296UL,120000,16777216,$observer) }
finally { $reader.Dispose() }
$state=$script:nodeObservation
if ($result.Outcome -ne 'observer-complete' -or -not $result.JobEmptyAfterCleanup -or -not $result.LimitsReadBackBeforeResume) { $state.unresolved.Add('Startup/cleanup incomplete') }
if ($result.CpuRateFlags -ne 5 -or $result.CpuRatePer10000 -ne 2500 -or
    $result.PeakCommitBytes -gt 4294967296UL -or $result.SampledPeakPrivateCommitBytes -gt 4294967296UL -or
    $result.MaxSampledAssociatedProcesses -gt 1) { $state.unresolved.Add('Resource evidence unresolved') }
if ($state.replies.Count -eq 3) {
    try { Assert-InitialNodeReplies $state.replies } catch { $state.unresolved.Add($_.Exception.Message) }
} else { $state.unresolved.Add('API observations missing') }
if (@(Get-ChildItem -LiteralPath "$run/secrets" -Force).Count -ne 0) { $state.unresolved.Add('Secret storage not empty after cleanup') }
$finalFiles=@(Get-ChildItem -LiteralPath $run -Recurse -File)
$state.finalFileBytes=($finalFiles | Measure-Object Length -Sum).Sum
$state.observedFileAndOutputBytes=[Math]::Max($state.filesPeakBytes,$state.finalFileBytes)+$result.CapturedOutputBytes
try { Assert-NodeObservedBytes $result.CapturedOutputBytes $state.filesPeakBytes $state.finalFileBytes } catch { $state.unresolved.Add($_.Exception.Message) }
$hashes=[ordered]@{}
foreach ($file in @('NodeProbeProcess.cs','node-startup.ps1','node-prepare.ps1','node-evidence.ps1')) { $hashes[$file]=(Get-FileHash (Join-Path $PSScriptRoot $file) -Algorithm SHA256).Hash.ToLowerInvariant() }
[ordered]@{ status=$(if ($state.unresolved.Count) {'unresolved-node-startup'} else {'stock-node-offline-startup-only'});
    packageVersion=$packageVersion; archiveSha256=$manifest.archiveSha256; bundleManifest=$manifest; javaVersion=$version;
    arguments=$arguments; config=$config; configSha256=(Get-FileHash "$run/ergo.conf" -Algorithm SHA256).Hash.ToLowerInvariant();
    result=$result; observations=$state; files=$hashes;
    limits=@('Source-configured offline and sampled TCP/UDP sockets, not zero-packet proof or network sandbox.',
        'Wallet actor and wildcard CORS remain; trusted host and fixed request allowlist only.',
        'JVM properties/API/readback cover observed settings; no complete effective-config dump.',
        'File sizes are sampled observations, not disk/log quotas. No sync or chain-membership evidence.',
        'CPU-rate scheduling does not repair the earlier exact-CPU refusal.') } | ConvertTo-Json -Depth 15
if ($state.unresolved.Count) { exit 2 }
