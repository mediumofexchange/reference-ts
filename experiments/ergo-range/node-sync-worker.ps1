# Invoked only by the ordinary supervisor after the reviewed sync profile handoff.
if (-not $Sync30Minutes -or $profile.name -cne 'sync-30-minutes') { throw 'Fixed sync profile required' }
$root=Join-Path $driveRoot 'run'
if (Test-Path -LiteralPath $root) { throw 'Worker root already exists' }
foreach ($directory in @($root,"$root/data","$root/secrets","$root/home","$root/tmp")) { [void][IO.Directory]::CreateDirectory($directory) }
$oldPath=[regex]::Match($prior.config,'ergo.directory = "(.+)/data"').Groups[1].Value
if (-not $oldPath) { throw 'Recorded root missing' }
$config=$prior.config.Replace($oldPath,$root.Replace('\','/'))+"`n"+$overlay
# The node resets Logback's root from this setting after loading the XML.
$config+="`nscorex.logging.level = WARN`n"
$auth=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$config=[regex]::Replace($config,'apiKeyHash = "[0-9a-f]{64}"',('apiKeyHash = "'+$auth+'"'))
[IO.File]::WriteAllText("$root/ergo.conf",$config,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText("$root/logback.xml",'<configuration><appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender"><encoder><pattern>%level %logger - %msg%n</pattern></encoder></appender><logger name="org.ergoplatform.nodeView.state.UtxoState" level="INFO"/><root level="WARN"><appender-ref ref="STDOUT"/></root></configuration>',[Text.UTF8Encoding]::new($false))
$report.config=$config; $report.configSha256=(Get-FileHash "$root/ergo.conf").Hash.ToLowerInvariant()
$arguments=@('-Xms128m','-Xmx2g',"-Duser.home=$root/home","-Djava.io.tmpdir=$root/tmp", "-Dlogback.configurationFile=$root/logback.xml",
    '-Djava.net.preferIPv4Stack=true',"-XX:ErrorFile=$root/hs_err.log",'-XX:-CreateCoredumpOnCrash','-XX:-UsePerfData',
    '-jar',"$bundle/ergo-6.0.5.jar",'--mainnet','-c',"$root/ergo.conf")
$report.arguments=$arguments
$clock=[Diagnostics.Stopwatch]::StartNew(); $state=New-DatabaseTrafficState
$progress=[ordered]@{socketSamples=0;pending=$null;endpoint=$null;reason=$null;diagnosticPeakBytes=0L;readerDisposed=$false;
    nextPollMs=60000L;snapshot=$null;history=[Collections.Generic.List[object]]::new();wallet=$null;peers=$null;maxPeers=0;maxHeaders=0;maxFull=0;phase=$null}
$budget=[NodeTrafficCounter+Accumulator]::new([NodeTrafficCounter]::Read($clock),8589934592UL,1000L)
$reader=[NodeSyncReader]::new(); $volumeDrive=[IO.DriveInfo]::new($driveRoot)
$allowedPeers=@('213.239.193.208','159.65.11.55','165.227.26.175','159.89.116.15')
$observer=[Func[uint32,long,bool]] {
    param($processId,$outputBytes)
    $stop=Update-DatabaseTraffic $budget $state { [NodeTrafficCounter]::Read($clock) }
    if ($stop) { $progress.reason='traffic-or-accounting-stop' }
    try {
        if ($owner.HasExited) { throw 'Disk owner exited' }
        [NodeDatabaseIdentity]::VerifyDriveMapping($letter,$volumeRoot) | Out-Null
        if ($drive.AvailableFreeSpace -lt 107374182400L) { throw 'Host reserve lost' }
        if ($volumeDrive.AvailableFreeSpace -lt 67108864L) { $progress.reason='volume-reserve'; $stop=$true }
        $diagnostics=(Get-Item -LiteralPath "$root/ergo.conf").Length+(Get-Item -LiteralPath "$root/logback.xml").Length
        if (Test-Path -LiteralPath "$root/hs_err.log") {
            $errorFile=Get-Item -LiteralPath "$root/hs_err.log" -Force
            if ($errorFile.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected diagnostic' }
            $diagnostics+=$errorFile.Length
        }
        $progress.diagnosticPeakBytes=[Math]::Max($progress.diagnosticPeakBytes,$diagnostics)
        if ($diagnostics+$outputBytes -gt 16777216L) { throw 'Diagnostic/output budget exceeded' }
        if ($outputBytes -ge 12582912L) { $progress.reason='captured-output-budget'; $stop=$true }
        $sockets=[NodeProbeProcess]::Sockets($processId); $progress.socketSamples++
        foreach ($socket in $sockets) {
            if ($socket.Protocol -cne 'tcp') { throw 'Unexpected non-TCP node socket' }
            if ($socket.State -eq 2) {
                if ($socket.LocalAddress -cne '127.0.0.1' -or $socket.LocalPort -notin @(19030,19053)) { throw 'Unexpected public/listening node socket' }
            } elseif ($socket.State -eq 100 -and $socket.RemoteAddress -ceq '0.0.0.0' -and $socket.RemotePort -eq 0) { } # Bound, not yet connected.
            elseif ($socket.RemoteAddress -in @('127.0.0.1','0.0.0.0') -and $socket.LocalAddress -ceq '127.0.0.1') { }
            elseif ($socket.RemoteAddress -notin $allowedPeers -or $socket.RemotePort -ne 9030) { throw 'Unexpected outbound peer endpoint' }
        }
        if (-not $stop -and $progress.pending -and $progress.pending.IsCompleted) {
            $reply=$progress.pending.GetAwaiter().GetResult(); $progress.pending=$null
            if ($progress.phase -eq 'wallet') {
                if ($reply.Status -ne 403) { throw 'Wallet must refuse unauthenticated access' }
                $progress.wallet=@{status=$reply.Status;body=$reply.Body}; $progress.phase=$null
            } elseif ($progress.phase -eq 'peers') {
                if ($reply.Status -ne 200) { throw 'Peer read failed' }
                $peers=ConvertFrom-Json -InputObject $reply.Body -AsHashtable -NoEnumerate
                if ($peers -isnot [array] -or $peers.Count -gt 4) { throw 'Peer count outside selected profile' }
                $progress.peers=$peers; $progress.maxPeers=[Math]::Max($progress.maxPeers,$peers.Count)
                $progress.phase=if ($null -eq $progress.wallet) { 'wallet' } else { $null }
            } elseif ($progress.phase -eq 'tip-header') {
                if ($reply.Status -eq 200) { $progress.snapshot.tipHeader=$reply.Body | ConvertFrom-Json -AsHashtable }
                elseif ($reply.Status -ne 404) { throw 'Applied header read failed' }
                $progress.phase='info-after'
            } else {
                if ($reply.Status -ne 200) { throw 'Node info read failed' }
                $info=$reply.Body | ConvertFrom-Json -AsHashtable; Assert-SyncNodeInfo $info
                $progress.maxHeaders=[Math]::Max($progress.maxHeaders,[long]$info.headersHeight)
                $progress.maxFull=[Math]::Max($progress.maxFull,[long]$info.fullHeight)
                if ($progress.phase -eq 'info-before') {
                    $progress.snapshot=[ordered]@{elapsedMs=$clock.ElapsedMilliseconds;infoBefore=$info;tipHeader=$null;infoAfter=$null;tipEvidence=$null}
                    $progress.phase=if ($info.stateVersion -cne ('0'*64) -and $info.fullHeight -gt 0) { 'tip-header' } else { 'info-after' }
                } else {
                    $progress.snapshot.infoAfter=$info
                    $progress.snapshot.tipEvidence=Get-SyncTipEvidence $progress.snapshot.infoBefore $progress.snapshot.tipHeader $info
                    if ($progress.history.Count -ge 32) { throw 'Progress sample budget exceeded' }
                    $progress.history.Add($progress.snapshot); $progress.snapshot=$null; $progress.phase='peers'
                    $live=@{elapsedMs=$clock.ElapsedMilliseconds;headers=$info.headersHeight;full=$info.fullHeight;stateVersion=$info.stateVersion;
                        trafficBytes=$budget.TotalBytes;maxPeers=$progress.maxPeers;volumeFree=$volumeDrive.AvailableFreeSpace}
                    $livePath=Join-Path $run 'progress.json'
                    if ((Test-Path -LiteralPath $livePath) -and ((Get-Item -LiteralPath $livePath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Redirected progress file' }
                    [IO.File]::WriteAllText($livePath,($live | ConvertTo-Json))
                }
            }
        }
        if (-not $stop -and -not $progress.pending) {
            if (-not $progress.phase -and $clock.ElapsedMilliseconds -ge $progress.nextPollMs) {
                $progress.nextPollMs=$clock.ElapsedMilliseconds+60000L; $progress.phase='info-before'
            }
            if ($progress.phase) {
                $endpoint=switch ($progress.phase) {
                    'tip-header' { '/blocks/'+$progress.snapshot.infoBefore.stateVersion+'/header' }
                    'peers' { '/peers/connected' }
                    'wallet' { '/wallet/status' }
                    default { '/info' }
                }
                $progress.endpoint=$endpoint; $progress.pending=$reader.Read($endpoint)
            }
        }
        if ($clock.ElapsedMilliseconds -ge 300000L -and $progress.maxPeers -eq 0 -and $progress.maxHeaders -eq 0) { $progress.reason='no-peer-progress'; $stop=$true }
        if ($clock.ElapsedMilliseconds -ge 1790000L) { $progress.reason='time-budget'; $stop=$true }
    } catch { $state.readError=$_.Exception.Message; $progress.reason='observation-error'; $stop=$true }
    if ($stop -and $state.stopDecisionMs -lt 0) { $state.stopDecisionMs=$clock.ElapsedMilliseconds }
    return $stop
}
try {
    $accounted=Invoke-DatabaseAccountedRun {
        try { [NodeProbeProcess]::RunSync30Minutes($lease,$report.java.path,$arguments,$root,$observer) }
        finally { $progress.readerDisposed=$true; $reader.Dispose() }
    } { [NodeTrafficCounter]::Read($clock) } $budget $state $clock
} finally {
    if (-not $progress.readerDisposed) { $progress.readerDisposed=$true; $reader.Dispose() }
    $progress.pending=$null
}
$report.process=$accounted.Process; $report.launchFailure=$accounted.Failure
$report.traffic=$budget; $report.observations=$state; $report.progress=$progress
$report.api=@{requests=$reader.Requests;bytes=$reader.Bytes}
$report.fixtures=@()
if ($null -ne $accounted.Process) {
    $output=$accounted.Process.Output
    foreach ($sample in $progress.history) {
        if ($sample.tipEvidence.status -ceq 'historical-applied-tip-correlated') {
            $pattern='Valid modifier with header '+$sample.tipEvidence.id+' and emission box [^\r\n]* applied to UtxoState at height '+$sample.tipEvidence.height+'(?:\D|$)'
            $sample.tipEvidence.applicationLogMatch=[regex]::IsMatch($output,$pattern)
        }
    }
    $report.outputTextSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($output))).ToLowerInvariant()
    $report.outputTextCharacters=$output.Length
    # Preserve bounded diagnostics and the digest of all captured text; avoid a
    # 15 MiB console capture plus JSON escaping exceeding the 16 MiB report budget.
    $accounted.Process.Output=$output.Substring(0,[Math]::Min(32768,$output.Length))
    if ($output.Length -gt 32768) { $report.outputTail=$output.Substring([Math]::Max(32768,$output.Length-262144)) }
}
$manifest=Get-Content -Raw (Join-Path $PSScriptRoot 'fixtures/manifest.json') | ConvertFrom-Json -AsHashtable
$report.appliedTipObserved=@($progress.history | Where-Object { $_.tipEvidence.applicationLogMatch }).Count -gt 0
foreach ($fixture in $manifest.fixtures) {
    $height=[long]$fixture.height
    $report.fixtures+=@{height=$height;id=$fixture.headerId;status=if ($progress.maxFull -lt $height) { 'not-reached' } else { 'ancestry-not-checked' }}
}
if ($accounted.Failure) { throw $accounted.Failure }
Assert-VolumeNodeProcess $accounted.Process $true
Assert-VolumeNodeTraffic $state $budget $true
if (-not $progress.reason -or $null -eq $progress.wallet -or $progress.wallet.status -ne 403) { throw 'Incomplete sync observations' }
$report.volumeAfter=Assert-OwnedVolume
if (@(Get-ChildItem -LiteralPath "$root/secrets" -Force).Count) { throw 'Secrets not empty' }
$report.secretsEmpty=$true
$report.finalDiagnosticBytes=(Get-Item -LiteralPath "$root/ergo.conf").Length+(Get-Item -LiteralPath "$root/logback.xml").Length
if (Test-Path -LiteralPath "$root/hs_err.log") { $report.finalDiagnosticBytes+=(Get-Item -LiteralPath "$root/hs_err.log").Length }
Assert-NodeObservedBytes $accounted.Process.CapturedOutputBytes $progress.diagnosticPeakBytes $report.finalDiagnosticBytes
