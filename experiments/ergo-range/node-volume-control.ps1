# Fixed OFFLINE composition only. Default validates inputs without disk/JVM writes.
# -Execute requires an elevated Windows session. No connected mode exists here.
param([switch]$Execute)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Windows x64 / PowerShell 7 required' }
. (Join-Path $PSScriptRoot 'node-java.ps1')
. (Join-Path $PSScriptRoot 'node-disk-evidence.ps1')
. (Join-Path $PSScriptRoot 'node-database-evidence.ps1')
. (Join-Path $PSScriptRoot 'node-evidence.ps1')
. (Join-Path $PSScriptRoot 'node-volume-evidence.ps1')
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$run=Join-Path $repo 'scratch/node-volume-control'
$imagePath=Join-Path $run 'control.vhd'
$bundle=Join-Path $repo 'scratch/ergo-stable/bundle'
$report=[ordered]@{status='unresolved-volume-control'; executeRequested=[bool]$Execute; observedAtUtc=[DateTime]::UtcNow.ToString('o');
    imagePath=$imagePath; virtualBytes=67108864L; maximumBackingBytes=68157440L; hostReserveBytes=107374182400L;
    wallMs=120000; commitBytes=4294967296L; heapBytes=2147483648L; cpuRatePer10000=2500;
    trafficTriggerBytes=8589934592L; finalTrafficMaximumBytes=10737418240L; diagnosticBytesMaximum=16777216L;
    mutationsStarted=$false; mappingRemoved=$false; detached=$false; artifactRemoved=$false;
    process=$null; traffic=$null; observations=$null; files=[ordered]@{}; errors=@();
    limitations=@('Trusted offline node inherits elevation needed for this disk control. Never use this launcher with public peers.',
        'Connected operation needs separate elevated disk ownership and ordinary-token Java execution; neither 20 GiB nor 30 minutes is implemented here.',
        'The fixed volume bounds its files, not all JRE/OS writes. Host paging, caches, package reads and supervisor/report allocations are outside it.',
        'Real counters include unrelated and possibly duplicated virtual-interface traffic. They are sampled accounting, not an egress firewall.',
        'Synchronous native/supervisor calls can stall. One-second accounting and two-second stop checks refuse late evidence; they are not hard independent deadlines.',
        'Termination is a whole-job stop, not a graceful close, crash-recovery result or synchronized chain.',
        'Cleanup follows supervisor cleanup attempts on all exits. Failed launch/cleanup retains the image and supplies no empty-job acceptance.') }
function Assert-OrdinaryAncestors([string]$Path) {
    $cursor=[IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item=Get-Item -LiteralPath $cursor -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Nonordinary directory ancestor' }
        }
        $cursor=[IO.Path]::GetDirectoryName($cursor)
    }
}
try {
    foreach ($file in @('node-volume-control.ps1','node-volume-evidence.ps1','node-java.ps1','node-disk-evidence.ps1',
        'node-database-evidence.ps1','node-evidence.ps1','NodeProbeDisk.cs','NodeProbeProcess.cs','NodeTrafficCounter.cs','NodeDatabaseIdentity.cs')) {
        $report.files[$file]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $file)).Hash.ToLowerInvariant()
    }
    Assert-OrdinaryAncestors $run
    Assert-OrdinaryAncestors $bundle
    if ($repo -cnotmatch '^[A-Za-z]:\\' -or (Test-Path -LiteralPath $run)) { throw 'Requires local repository and absent control directory' }
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($repo))
    if ($drive.DriveFormat -cne 'NTFS' -or $drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'Fixed NTFS host required' }
    $report.hostFreeBefore=$drive.AvailableFreeSpace
    if ($report.hostFreeBefore -lt 108011716608L) { throw 'Need 100 GiB reserve plus 65 MiB image, 512 MiB preparation and 16 MiB report allowance' }
    $report.java=Get-MaintainedNodeJava $repo
    $prior=Get-Content -Raw (Join-Path $repo 'docs/ergo-maintained-java-startup-verification.json') | ConvertFrom-Json -AsHashtable
    $configHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($prior.config))).ToLowerInvariant()
    if ($prior.status -cne 'stock-node-offline-startup-only' -or
        $configHash -cne 'c8f156ed686c159ccb6b03134b8fd5393517eb1a473d4170b97a8d08f1063dc1') { throw 'Exact reviewed offline config required' }
    $manifestPath=Join-Path $repo 'scratch/ergo-stable/bundle-manifest.json'
    if ((Get-FileHash -LiteralPath $manifestPath).Hash -ine 'df98bdbfa029ad3aaeabb3968a2b73cdaa92769d93192bc25b4c8f298102dce6') { throw 'Stable manifest mismatch' }
    $pins=(Get-Content -Raw $manifestPath | ConvertFrom-Json -AsHashtable).files
    $pending=[Collections.Generic.Queue[string]]::new(); $pending.Enqueue($bundle); $entries=0; $files=0
    while ($pending.Count) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
            $entries++
            if ($entries -gt 192 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Stable bundle redirection or budget' }
            if ($item.PSIsContainer) { $pending.Enqueue($item.FullName); continue }
            $name=[IO.Path]::GetRelativePath($bundle,$item.FullName).Replace('\','/')
            if (-not $pins.ContainsKey($name) -or (Get-FileHash -LiteralPath $item.FullName).Hash -ine $pins[$name]) { throw 'Stable bundle mismatch' }
            $files++
        }
    }
    if ($files -ne 167 -or $pins['ergo-6.0.5.jar'] -cne '2a7e2978cb09538ed6780d85ae3aa39c1ecce10e5e5a6e0dc3cd8ab087851588') { throw 'Stable JAR/count mismatch' }
    $report.jarSha256=$pins['ergo-6.0.5.jar']
    foreach ($port in @(19030,19053)) {
        if ([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port -contains $port) { throw 'Probe port occupied' }
    }
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try { $report.elevated=[Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
    finally { $identity.Dispose() }
    if (-not $Execute) { $report.status='prepared-read-only-volume-control'; return }
    if (-not $report.elevated) { throw 'Elevated Windows session required for this offline disk control' }
    foreach ($name in @('Get-DiskImage','Get-Disk','Get-Partition','Get-Volume','Initialize-Disk','New-Partition','Format-Volume','Add-PartitionAccessPath','Remove-PartitionAccessPath')) {
        if (-not (Get-Command "Storage\$name" -ErrorAction SilentlyContinue)) { throw "Missing storage command $name" }
    }
    foreach ($file in @('NodeProbeDisk.cs','NodeProbeProcess.cs','NodeTrafficCounter.cs','NodeDatabaseIdentity.cs')) { Add-Type -Path (Join-Path $PSScriptRoot $file) }
    $letter=[NodeDatabaseIdentity]::SelectUnusedDriveLetter(); $report.driveLetter=[string]$letter
    $driveRoot=([string]$letter)+':\'
    [void][IO.Directory]::CreateDirectory($run); $report.mutationsStarted=$true
    $owned=$null; $mappingAttempted=$false
    try {
        $owned=[NodeProbeDisk]::Create($imagePath); $owned.Attach(); $report.nativeDisk=$owned.Info
        function Read-OwnedVolumeDisk([string]$Style) {
            $images=@(Storage\Get-DiskImage -ImagePath $imagePath)
            if ($images.Count -ne 1) { throw 'Ambiguous owned image' }
            $disks=@($images[0] | Storage\Get-Disk)
            if ($disks.Count -ne 1) { throw 'Ambiguous owned disk' }
            Assert-ProbeDiskIdentity $images[0] $disks[0] $imagePath $owned.PhysicalPath $Style
            $report.disk=$disks[0] | Select-Object Number,Path,UniqueId,Guid,Size,PartitionStyle
            return $disks[0]
        }
        $disk=Read-OwnedVolumeDisk 'RAW'
        if (@(Storage\Get-Partition -Disk $disk).Count) { throw 'New disk already has partitions' }
        Storage\Initialize-Disk -InputObject $disk -PartitionStyle GPT -Confirm:$false
        $disk=Read-OwnedVolumeDisk 'GPT'; $diskId=$disk.UniqueId; $diskPath=$disk.Path; $diskGuid=$disk.Guid
        $created=@(Storage\New-Partition -InputObject $disk -Offset 1048576UL -UseMaximumSize -AssignDriveLetter:$false)
        if ($created.Count -ne 1) { throw 'Ambiguous created partition' }
        $expected=$created[0]; Assert-ProbePartition $expected $disk $null
        $report.partition=$expected | Select-Object DiskNumber,PartitionNumber,Guid,Offset,Size,GptType
        function Read-OwnedVolumePartition([bool]$Mapped=$false) {
            $d=Read-OwnedVolumeDisk 'GPT'
            if ($d.UniqueId -ine $diskId -or $d.Path -ine $diskPath -or $d.Guid -ine $diskGuid) { throw 'Disk identity changed' }
            $parts=@(Storage\Get-Partition -Disk $d | Where-Object { $_.PartitionNumber -eq $expected.PartitionNumber })
            if ($parts.Count -ne 1) { throw 'Owned partition missing or ambiguous' }
            if ($Mapped) { Assert-DatabaseMappedPartition $parts[0] $d $expected $letter }
            else { Assert-ProbePartition $parts[0] $d $expected }
            return $parts[0]
        }
        $partition=Read-OwnedVolumePartition
        $volumes=@(Storage\Get-Volume -Partition $partition)
        if ($volumes.Count -ne 1 -or $volumes[0].FileSystem -notin @('','RAW')) { throw 'New volume is not empty' }
        Storage\Format-Volume -Partition $partition -FileSystem NTFS -NewFileSystemLabel 'MOE_NODE_CONTROL' -AllocationUnitSize 4096 -Confirm:$false | Out-Null
        $partition=Read-OwnedVolumePartition
        $volumes=@(Storage\Get-Volume -Partition $partition)
        if ($volumes.Count -ne 1) { throw 'Ambiguous formatted volume' }
        $volume=$volumes[0]; $volumeRoot=$volume.Path; $report.volumeRoot=$volumeRoot
        if ($volume.FileSystem -cne 'NTFS' -or $volume.FileSystemLabel -cne 'MOE_NODE_CONTROL' -or
            $volume.Size -le 0 -or $volume.Size -gt 67108864L -or ($volume.DriveLetter -and [int][char]$volume.DriveLetter -ne 0)) { throw 'Unexpected volume identity/capacity' }
        $report.volumeBefore=$volume | Select-Object Path,UniqueId,FileSystem,FileSystemLabel,Size,SizeRemaining
        [NodeDatabaseIdentity]::VerifyDriveLetterAbsent($letter)
        $mappingAttempted=$true
        Storage\Add-PartitionAccessPath -InputObject $partition -AccessPath $driveRoot
        $partition=Read-OwnedVolumePartition $true
        $report.mappingBefore=[NodeDatabaseIdentity]::VerifyDriveMapping($letter,$volumeRoot)
        function Assert-OwnedVolume {
            $p=Read-OwnedVolumePartition $true; $v=@(Storage\Get-Volume -Partition $p)
            if ($v.Count -ne 1 -or $v[0].Path -ine $volumeRoot -or $v[0].UniqueId -ine $volume.UniqueId -or
                $v[0].FileSystem -cne 'NTFS' -or $v[0].FileSystemLabel -cne 'MOE_NODE_CONTROL' -or $v[0].Size -ne $volume.Size) { throw 'Owned volume changed' }
            [NodeDatabaseIdentity]::VerifyDriveMapping($letter,$volumeRoot) | Out-Null
            if ($drive.AvailableFreeSpace -lt 107374182400L) { throw 'Host reserve lost' }
            return $v[0]
        }
        [void](Assert-OwnedVolume)
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
            $stop=Update-DatabaseTraffic $budget $state { [NodeTrafficCounter]::Read($clock) }
            try {
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
                try { [NodeProbeProcess]::Run($report.java.path,$arguments,$root,'offline-volume-node',4294967296UL,120000,15728640,$observer) }
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
    } finally {
        if ($mappingAttempted) {
            try {
                # Re-read the actual mapping even if assignment succeeded then threw.
                [NodeDatabaseIdentity]::VerifyDriveMapping($letter,$volumeRoot) | Out-Null
                $partition=Read-OwnedVolumePartition $true
                Storage\Remove-PartitionAccessPath -InputObject $partition -AccessPath $driveRoot
                [NodeDatabaseIdentity]::VerifyDriveLetterAbsent($letter)
                [void](Read-OwnedVolumePartition $false)
                $report.mappingRemoved=$true
            } catch { $report.errors+=$_.Exception.Message }
        }
        if ($null -ne $owned) {
            try {
                try { $owned.Detach() } finally { $owned.Dispose() }
                $images=@(Storage\Get-DiskImage -ImagePath $imagePath)
                if ($images.Count -ne 1 -or $images[0].Attached -isnot [bool] -or $images[0].Attached) { throw 'Detach readback unresolved' }
                $report.detached=$true
                [NodeDatabaseIdentity]::VerifyDriveLetterAbsent($letter)
            } catch { $report.errors+=$_.Exception.Message }
        }
    }
    Assert-OrdinaryAncestors $run
    $image=Get-Item -LiteralPath $imagePath -Force
    $report.backingBytes=$image.Length; $report.hostFreeAfter=$drive.AvailableFreeSpace
    if ($report.errors.Count -or -not $report.mappingRemoved -or -not $report.detached -or
        ($image.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $image.Length -lt 67108864L -or $image.Length -gt 68157440L -or
        $report.hostFreeAfter -lt 107374182400L) { throw 'Cleanup/capacity/reserve unresolved; owned image retained' }
    [IO.File]::Delete($imagePath)
    if (Test-Path -LiteralPath $imagePath) { throw 'Image removal readback failed' }
    $report.artifactRemoved=$true; $report.status='offline-node-volume-composition-only'
} catch { $report.errors+=$_.Exception.Message }
finally {
    $json=$report | ConvertTo-Json -Depth 18
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 16777216) {
        $report.status='unresolved-report-budget'; $report.process=$null; $report.errors+='Report exceeds 16 MiB'
        $json=$report | ConvertTo-Json -Depth 18
    }
    $json
}
if ($report.status -notin @('prepared-read-only-volume-control','offline-node-volume-composition-only')) { exit 2 }
