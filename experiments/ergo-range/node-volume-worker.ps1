# Shared fixed offline node body; called only by the ordinary split supervisor.
        $root=Join-Path $driveRoot 'run'
        if (Test-Path -LiteralPath $root) { throw 'Worker root already exists' }
        foreach ($directory in @($root,"$root/data","$root/secrets","$root/home","$root/tmp")) { [void][IO.Directory]::CreateDirectory($directory) }
        $oldPath=[regex]::Match($prior.config,'ergo.directory = "(.+)/data"').Groups[1].Value
        if (-not $oldPath) { throw 'Recorded root missing' }
        $config=$prior.config.Replace($oldPath,$root.Replace('\','/'))
        $auth=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
        $config=[regex]::Replace($config,'apiKeyHash = "[0-9a-f]{64}"',('apiKeyHash = "'+$auth+'"'))
        [IO.File]::WriteAllText("$root/ergo.conf",$config,[Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText("$root/logback.xml",'<configuration><appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender"><encoder><pattern>%level %logger - %msg%n</pattern></encoder></appender><root level="INFO"><appender-ref ref="STDOUT"/></root></configuration>',[Text.UTF8Encoding]::new($false))
        $report.config=$config; $report.configSha256=(Get-FileHash "$root/ergo.conf").Hash.ToLowerInvariant()
        $arguments=@('-Xms128m','-Xmx2g',"-Duser.home=$root/home","-Djava.io.tmpdir=$root/tmp",
            "-Dlogback.configurationFile=$root/logback.xml",'-Djava.net.preferIPv4Stack=true',
            "-XX:ErrorFile=$root/hs_err.log",'-XX:-CreateCoredumpOnCrash','-XX:-UsePerfData',
            '-jar',"$bundle/ergo-6.0.5.jar",'--mainnet','-c',"$root/ergo.conf")
        $report.arguments=$arguments
        $clock=[Diagnostics.Stopwatch]::StartNew()
        $state=New-DatabaseTrafficState
        $progress=[ordered]@{socketSamples=0;replies=[ordered]@{};pending=$null;endpoint=$null;readyAtMs=-1L;reason=$null;diagnosticPeakBytes=0L;readerDisposed=$false}
        $budget=[NodeTrafficCounter+Accumulator]::new([NodeTrafficCounter]::Read($clock),8589934592UL,1000L)
        $reader=[NodeProbeProcess+StartupReader]::new()
        $observer=[Func[uint32,long,bool]] {
            param($processId,$outputBytes)
            if ($ParentFailureControl) {
                Write-VolumeHandoff (Join-Path $run 'parent-failure.json') @{nonce=$nonce;parentId=$PID;childId=$processId;activeProcesses=$lease.ActiveProcesses;observedAtUtc=[DateTime]::UtcNow.ToString('o')}
                [Diagnostics.Process]::GetCurrentProcess().Kill()
                throw 'Parent failure injection unexpectedly returned'
            }
            $stop=Update-DatabaseTraffic $budget $state { [NodeTrafficCounter]::Read($clock) }
            try {
                if ($owner.HasExited) { throw 'Disk owner exited' }
                [NodeDatabaseIdentity]::VerifyDriveMapping($letter,$volumeRoot) | Out-Null
                if ($drive.AvailableFreeSpace -lt 107374182400L) { throw 'Host reserve lost' }
                # Only these fixed diagnostics, never the live database tree.
                $diagnostics=(Get-Item -LiteralPath "$root/ergo.conf").Length+(Get-Item -LiteralPath "$root/logback.xml").Length
                if (Test-Path -LiteralPath "$root/hs_err.log") {
                    $errorFile=Get-Item -LiteralPath "$root/hs_err.log" -Force
                    if ($errorFile.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected diagnostic' }
                    $diagnostics+=$errorFile.Length
                }
                $progress.diagnosticPeakBytes=[Math]::Max($progress.diagnosticPeakBytes,$diagnostics)
                if ($diagnostics+$outputBytes -gt 16777216) { throw 'Diagnostic/output budget exceeded' }
                $sockets=[NodeProbeProcess]::Sockets($processId); $progress.socketSamples++
                foreach ($socket in $sockets) {
                    if ($socket.Protocol -ne 'tcp' -or $socket.LocalAddress -ne '127.0.0.1' -or
                        ($socket.State -ne 2 -and $socket.RemoteAddress -notin @('127.0.0.1','0.0.0.0'))) { throw 'Unexpected offline socket' }
                }
                if (-not $stop -and $clock.ElapsedMilliseconds -ge 60000) {
                    if ($progress.pending -and $progress.pending.IsCompleted) {
                        $reply=$progress.pending.GetAwaiter().GetResult()
                        $progress.replies[$progress.endpoint]=[ordered]@{status=$reply.Status;body=$reply.Body}
                        $progress.pending=$null
                    }
                    if (-not $progress.pending -and ($sockets | Where-Object { $_.State -eq 2 -and $_.LocalPort -eq 19053 })) {
                        foreach ($endpoint in @('/info','/peers/connected','/wallet/status')) {
                            if ($progress.replies.Contains($endpoint)) { continue }
                            $progress.endpoint=$endpoint; $progress.pending=$reader.ReadOnce($endpoint); break
                        }
                    }
                    if ($progress.replies.Count -eq 3) {
                        if ($progress.readyAtMs -lt 0) { Assert-InitialNodeReplies $progress.replies; $progress.readyAtMs=$clock.ElapsedMilliseconds }
                        if ($clock.ElapsedMilliseconds-$progress.readyAtMs -ge 10000) { $progress.reason='offline-ready'; $stop=$true }
                    }
                }
            } catch { $state.readError=$_.Exception.Message; $progress.reason='observation-error'; $stop=$true }
            if ($stop -and $state.stopDecisionMs -lt 0) { $state.stopDecisionMs=$clock.ElapsedMilliseconds }
            return $stop
        }
        try {
            $accounted=Invoke-DatabaseAccountedRun {
                try { [NodeProbeProcess]::RunOnVolumeJob($lease,$report.java.path,$arguments,$root,$observer) }
                finally { $progress.readerDisposed=$true; $reader.Dispose() }
            } { [NodeTrafficCounter]::Read($clock) } $budget $state $clock
        } finally {
            if (-not $progress.readerDisposed) { $progress.readerDisposed=$true; $reader.Dispose() }
            $progress.pending=$null
        }
        $report.process=$accounted.Process; $report.launchFailure=$accounted.Failure
        $report.traffic=$budget; $report.observations=$state; $report.progress=$progress
        if ($accounted.Failure) { throw $accounted.Failure }
        Assert-VolumeNodeProcess $accounted.Process
        Assert-VolumeNodeTraffic $state $budget
        if ($progress.reason -cne 'offline-ready') { throw 'Expected completed offline observations' }
        Assert-InitialNodeReplies $progress.replies
        if (($progress.replies['/info'].body | ConvertFrom-Json).appVersion -cne '6.0.5') { throw 'Unexpected node version' }
        $report.volumeAfter=Assert-OwnedVolume | Select-Object Path,UniqueId,FileSystem,FileSystemLabel,Size,SizeRemaining
        $report.mappingAfter=[NodeDatabaseIdentity]::VerifyDriveMapping($letter,$volumeRoot)
        if (@(Get-ChildItem -LiteralPath "$root/secrets" -Force).Count) { throw 'Secrets not empty' }
        # Inventory only after empty-job and final traffic accounting.
        $pending=[Collections.Generic.Queue[string]]::new(); $pending.Enqueue($root)
        $inventory=[Collections.Generic.List[object]]::new(); $entries=0; $bytes=0L
        while ($pending.Count) {
            foreach ($item in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
                $entries++
                if ($entries -gt 4096 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Final inventory bound or redirection' }
                if ($item.PSIsContainer) { $pending.Enqueue($item.FullName); continue }
                $bytes+=$item.Length
                if ($bytes -gt 67108864L) { throw 'Volume logical file bound' }
                $inventory.Add([ordered]@{path=[IO.Path]::GetRelativePath($root,$item.FullName);bytes=$item.Length})
            }
        }
        $report.finalInventory=$inventory.ToArray(); $report.finalFileBytes=$bytes
        $report.finalDiagnosticBytes=0L
        foreach ($entry in $report.finalInventory) {
            if ($entry.path -in @('ergo.conf','logback.xml','hs_err.log')) { $report.finalDiagnosticBytes+=$entry.bytes }
        }
        Assert-NodeObservedBytes $accounted.Process.CapturedOutputBytes $progress.diagnosticPeakBytes $report.finalDiagnosticBytes
        $report.secretsEmpty=$true
