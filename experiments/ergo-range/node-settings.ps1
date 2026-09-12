# Fixed offline settings readback. No node services, sockets, peers or disk image.
param([switch]$Stable, [switch]$MaintainedJava, [switch]$SyncProfile)
$ErrorActionPreference = 'Stop'
if ($MaintainedJava -and -not $Stable) { throw 'Maintained Java is selected only with the stable node' }
if ($SyncProfile -and -not $MaintainedJava) { throw 'Sync profile requires the selected maintained Java and stable node' }
Set-StrictMode -Version Latest
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Windows x64 / PowerShell 7 required' }
Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeProcess.cs')
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$packageVersion = if ($Stable) { '6.0.5' } else { '6.1.5' }
$bundle = Join-Path $repo $(if ($Stable) { 'scratch/ergo-stable/bundle' } else { 'scratch/node-startup/bundle' })
$compiler = Join-Path $repo 'scratch/sync-preparation/ecj-3.37.0.jar'
$run = Join-Path $repo $(if ($Stable) { 'scratch/ergo-stable/settings-run' } else { 'scratch/node-settings' })
$javaSelection = $null
if ($MaintainedJava) {
    . (Join-Path $PSScriptRoot 'node-java.ps1')
    $javaSelection = Get-MaintainedNodeJava $repo
    $run = Join-Path $repo 'scratch/ergo-stable/maintained-java-settings-run'
}
if ($SyncProfile) { $run = Join-Path $repo 'scratch/ergo-stable/sync-settings-run' }
$source = Join-Path $PSScriptRoot 'NodeSettingsReadback.java'
if (Test-Path -LiteralPath $run) { throw 'Readback requires an absent run directory' }
$priorPath = if ($Stable) { 'docs/ergo-stable-startup-verification.json' } else { 'docs/ergo-node-startup-verification.json' }
if ($MaintainedJava) { $priorPath = 'docs/ergo-maintained-java-startup-verification.json' }
$prior = Get-Content -Raw (Join-Path $repo $priorPath) | ConvertFrom-Json -AsHashtable
if ($Stable -and ($prior.status -cne 'stock-node-offline-startup-only' -or
    $prior.bundleManifest.files['ergo-6.0.5.jar'] -cne '2a7e2978cb09538ed6780d85ae3aa39c1ecce10e5e5a6e0dc3cd8ab087851588')) { throw 'Stable startup evidence required' }
foreach ($entry in $prior.bundleManifest.files.GetEnumerator()) {
    $file = Join-Path $bundle $entry.Key
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $entry.Value) { throw 'Pinned bundle mismatch' }
}
if ((Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash -ine 'cde026ff966b48b5e5f148b6f041ceff3cf4f85cf75155f4ec0f40e4ee14b545') { throw 'Compiler pin mismatch' }
foreach ($directory in @($run,"$run/data","$run/secrets","$run/tmp","$run/home","$run/classes")) {
    New-Item -ItemType Directory -Path $directory | Out-Null
}
$path = $run.Replace('\','/')
$oldPath = [regex]::Match($prior.config, 'ergo.directory = "(.+)/data"').Groups[1].Value
if (-not $oldPath) { throw 'Recorded startup config path missing' }
$config = $prior.config.Replace($oldPath,$path)
if ($SyncProfile) { $config += "`n" + (Get-Content -Raw (Join-Path $PSScriptRoot 'node-sync-network.conf')) }
$config = [regex]::Replace($config,'apiKeyHash = "[0-9a-f]{64}"',
    ('apiKeyHash = "' + [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant() + '"'))
[IO.File]::WriteAllText("$run/ergo.conf",$config,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText("$run/logback.xml",'<configuration><appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender"><encoder><pattern>%level %logger - %msg%n</pattern></encoder></appender><root level="INFO"><appender-ref ref="STDOUT"/></root></configuration>',[Text.UTF8Encoding]::new($false))
$java = Join-Path $bundle 'jre/bin/java.exe'
$expectedJava = '21.0.1'
if ($MaintainedJava) { $java = $javaSelection.path; $expectedJava = $javaSelection.version }
$jar = Join-Path $bundle "ergo-$packageVersion.jar"
$jvm = @('-Xms32m','-Xmx512m',"-Duser.home=$run/home","-Djava.io.tmpdir=$run/tmp",
    "-Dlogback.configurationFile=$run/logback.xml",'-Djava.net.preferIPv4Stack=true',
    "-XX:ErrorFile=$run/hs_err.log",'-XX:-CreateCoredumpOnCrash','-XX:-UsePerfData')
function Assert-ReadbackProcess($Result) {
    if ($Result.Outcome -ne 'exited' -or $Result.ExitCode -ne 0 -or -not $Result.JobEmptyAfterCleanup -or
        -not $Result.LimitsReadBackBeforeResume -or $Result.TotalProcesses -ne 1 -or
        $Result.CpuRateFlags -ne 5 -or $Result.CpuRatePer10000 -ne 2500 -or
        $Result.PeakCommitBytes -gt 1073741824UL) { throw "Settings process refused: $($Result.Output)" }
}
$compileArgs = $jvm + @('-jar',$compiler,'-proc:none','-encoding','UTF-8','-source','8','-target','8',
    '-classpath',$jar,'-d',"$run/classes",$source)
$compile = [NodeProbeProcess]::Run($java,$compileArgs,$run,'compile-settings-reader',1073741824UL,30000,65536,$null)
Assert-ReadbackProcess $compile
$cases = [ordered]@{}
$caseNames = @('baseline','pruning-override','checkpoint-fallback')
if ($SyncProfile) { $caseNames += 'peer-override' }
foreach ($case in $caseNames) {
    $configPath = "$run/ergo.conf"
    $options = @()
    if ($case -eq 'pruning-override') { $options = @('-Dergo.node.blocksToKeep=10') }
    if ($case -eq 'peer-override') { $options = @('-Dscorex.network.maxConnections=5') }
    if ($case -eq 'checkpoint-fallback') {
        $configPath = "$run/checkpoint-fallback.conf"
        [IO.File]::WriteAllText($configPath,$config.Replace('checkpoint = null',''),[Text.UTF8Encoding]::new($false))
    }
    $arguments = $jvm + $options + @('-cp',"$run/classes;$jar",'NodeSettingsReadback',$configPath)
    $result = [NodeProbeProcess]::Run($java,$arguments,$run,$case,1073741824UL,30000,65536,$null)
    Assert-ReadbackProcess $result
    $lines = @($result.Output -split '\r?\n' | Where-Object { $_.StartsWith('MOE_SETTINGS_JSON=') })
    if ($lines.Count -ne 1) { throw 'Exactly one settings observation required' }
    $settings = $lines[0].Substring(18) | ConvertFrom-Json -AsHashtable
    if ($settings.properties['java.version'] -cne $expectedJava) { throw 'Settings Java runtime mismatch' }
    $typed = $settings.typed
    $acceptable = $typed.mainnet -and $settings.resolved['ergo.node.stateType'] -ceq 'utxo' -and
        $typed.verifyTransactions -and $typed.blocksToKeep -eq -1 -and $typed.checkpointAbsent -and
        -not $typed.utxoBootstrap -and $typed.storingUtxoSnapshots -eq 0 -and -not $typed.nipopowBootstrap -and
        -not $typed.isFullBlocksPruned -and -not $typed.areSnapshotsStored -and -not $typed.mining -and
        -not $typed.offlineGeneration -and -not $typed.extraIndex -and $typed.testMnemonicAbsent -and $typed.testKeysQtyAbsent
    if ($SyncProfile) {
        $network = $settings.network
        $acceptable = $acceptable -and $network.maxConnections -eq 4 -and
            -not $network.peerDiscovery -and -not $network.allowLocal -and -not $network.upnpEnabled -and
            $network.declaredAddressAbsent -and $network.bindAddress -ceq '127.0.0.1' -and $network.bindPort -eq 19030 -and
            ($network.knownPeers -join ',') -ceq '213.239.193.208:9030,159.65.11.55:9030,165.227.26.175:9030,159.89.116.15:9030' -and
            $network.connectionTimeoutMs -eq 1000 -and $network.handshakeTimeoutMs -eq 30000 -and
            $network.deliveryTimeoutMs -eq 10000 -and $network.inactiveConnectionDeadlineMs -eq 120000 -and
            $network.maxDeliveryChecks -eq 100 -and $network.maxPeerSpecObjects -eq 64 -and $network.desiredInvObjects -eq 400
        if ($case -eq 'peer-override' -and $network.maxConnections -ne 5) { throw 'JVM peer override control failed' }
    }
    if (($case -eq 'baseline') -ne $acceptable) { throw "Unexpected acceptance for $case" }
    if ($case -eq 'pruning-override' -and ($typed.blocksToKeep -ne 10 -or -not $typed.isFullBlocksPruned)) { throw 'JVM override control failed' }
    if ($case -eq 'checkpoint-fallback' -and $typed.checkpointAbsent) { throw 'Mainnet checkpoint fallback control failed' }
    $cases[$case] = [ordered]@{ acceptedProfile=$acceptable; arguments=$arguments; process=$result; settings=$settings }
}
if (@(Get-ChildItem -LiteralPath "$run/secrets" -Force).Count -ne 0 -or
    @(Get-ChildItem -LiteralPath "$run/data" -Force).Count -ne 0) { throw 'Settings-only readback created node state or secrets' }
$files = @(Get-ChildItem -LiteralPath $run -Recurse -File)
$bytes = ($files | Measure-Object Length -Sum).Sum
if ($bytes -gt 1048576) { throw 'Settings run exceeds 1 MiB final files' }
$hashes = [ordered]@{}
foreach ($file in @('NodeSettingsReadback.java','node-settings.ps1','NodeProbeProcess.cs')) {
    $hashes[$file] = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $file) -Algorithm SHA256).Hash.ToLowerInvariant()
}
if ($MaintainedJava) { $hashes['node-java.ps1']=(Get-FileHash (Join-Path $PSScriptRoot 'node-java.ps1')).Hash.ToLowerInvariant() }
if ($SyncProfile) { $hashes['node-sync-network.conf']=(Get-FileHash (Join-Path $PSScriptRoot 'node-sync-network.conf')).Hash.ToLowerInvariant() }
[ordered]@{ status='offline-settings-readback-only'; observedAtUtc=[DateTime]::UtcNow.ToString('o');
    packageVersion=$packageVersion; jarSha256=$prior.bundleManifest.files["ergo-$packageVersion.jar"]; compilerSha256=(Get-FileHash $compiler -Algorithm SHA256).Hash.ToLowerInvariant();
    javaSha256=(Get-FileHash -LiteralPath $java).Hash.ToLowerInvariant(); maintainedJava=$javaSelection; config=$config;
    syncProfile=[bool]$SyncProfile;
    configSha256=(Get-FileHash "$run/ergo.conf" -Algorithm SHA256).Hash.ToLowerInvariant();
    compile=$compile; compileArguments=$compileArgs; cases=$cases; files=$hashes; finalRunBytes=$bytes;
    finalFiles=@($files | ForEach-Object { [ordered]@{ path=[IO.Path]::GetRelativePath($run,$_.FullName); bytes=$_.Length } });
    limitations=@('Calls the pinned configuration loader and typed settings constructor only; never starts node actors or APIs.',
        'Settings intent is not proof of executed transaction validation, retained history, no packets or complete filesystem containment.',
        'At most four sequential settings processes and one compiler, each 30 s / 1 GiB commit / 25% CPU / one process / 64 KiB output.',
        'Final 1 MiB run-file check is an observation, not a filesystem quota. No full-size disk allocation or peers.') } | ConvertTo-Json -Depth 18
