# Fixed offline preparation. Default performs reads only. -Execute is a separately
# authorized elevated experiment, never a node launch or arbitrary disk selector.
param([switch]$Execute)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Windows x64 / PowerShell 7 required' }
. (Join-Path $PSScriptRoot 'node-disk-evidence.ps1')
. (Join-Path $PSScriptRoot 'node-database-evidence.ps1')
. (Join-Path $PSScriptRoot 'node-database-native.ps1')
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$run=Join-Path $repo 'scratch/node-database-control'
$imagePath=Join-Path $run 'control.vhd'
$bundle=Join-Path $repo 'scratch/node-startup/bundle'
$compiler=Join-Path $repo 'scratch/sync-preparation/ecj-3.37.0.jar'
$nativeCandidate=Join-Path $repo 'scratch/retained-native-target/candidate/librocksdbjni-win64.dll'
# Run 34507404910 / attempt 1, reviewed in ergo-native-candidate-verification.json.
# This selects only the fresh compression-free offline control, not the Ergo node.
$jniHash='b0370fa9a8afe8942d0d2ccba1557b29ab08472a09da7c1bde7005eca7cdd21c'
$jniBytes=8998912L
$report=[ordered]@{ status='unresolved-database-preflight'; executeRequested=[bool]$Execute;
    observedAtUtc=[DateTime]::UtcNow.ToString('o'); imagePath=$imagePath; virtualBytes=67108864L;
    maximumBackingBytes=68157440L; hostReserveBytes=107374182400L;
    processCountMaximum=6; perProcessWallMs=30000; perProcessCommitBytes=1073741824L;
    perProcessOutputBytes=65536; perProcessTrafficTriggerBytes=1048576L; perProcessFinalTrafficMaximumBytes=2097152L;
    mutationsStarted=$false; detached=$false; mappingRemoved=$false; artifactRemoved=$false;
    driveLetter=$null; volumeRoot=$null; nativeDisk=$null; disk=$null; partition=$null; volumeBefore=$null; volumeAfter=$null;
    hostFreeBefore=$null; hostFreeAfter=$null; backingBytes=$null; compilerSha256=$null;
    jniSha256=$jniHash; jniBytes=$jniBytes; nativeCandidate=$null; files=[ordered]@{}; cases=@(); errors=@();
    limitations=@('Trusted offline fixed worker only; no Ergo services, peers, public release or full-sized allocation.',
        'Stable trusted host administration and paths assumed; drive mapping and Job Object are not a filesystem sandbox.',
        'Synchronous storage, module reads and supervisor calls have no hard deadline; late samples refuse evidence but cannot stop a permanently stalled supervisor.',
        'Loaded module snapshots are point-in-time provenance, not an exhaustive lifetime DLL or native/JRE/OS write trace.',
        'Traffic controls inject synthetic observations separately from real interface accounting; they do not measure real traffic-trigger throughput.',
        'Host supervisor caches, bundle/compiler reads, image, reports, paging and OS services are outside the worker volume.',
        'Six sequential JVMs at most; real accounting covers each JVM baseline through its final sample, not intervening disk setup/cleanup.') }
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
    foreach ($file in @('node-database-control.ps1','node-database-evidence.ps1','node-database-evidence.test.ps1',
        'node-database-native.ps1','node-database-native.test.ps1',
        'NodeDatabaseControl.java','NodeDatabaseIdentity.cs','node-database-identity.test.ps1',
        'NodeProbeDisk.cs','node-disk-evidence.ps1','NodeProbeProcess.cs','NodeTrafficCounter.cs')) {
        $report.files[$file]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $file)).Hash.ToLowerInvariant()
    }
    Assert-OrdinaryAncestors $run
    Assert-OrdinaryAncestors $bundle
    Assert-OrdinaryAncestors ([IO.Path]::GetDirectoryName($compiler))
    if ($repo -cnotmatch '^[A-Za-z]:\\' -or (Test-Path -LiteralPath $run)) { throw 'Requires a local repository and absent control directory' }
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($repo))
    if ($drive.DriveFormat -cne 'NTFS' -or $drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'Fixed NTFS host required' }
    $report.hostFreeBefore=$drive.AvailableFreeSpace
    if ($report.hostFreeBefore -lt 108011716608L) { throw 'Need 100 GiB reserve plus image, 512 MiB preparation and 16 MiB reports' }
    $pins=(Get-Content -Raw (Join-Path $repo 'docs/ergo-node-startup-verification.json') | ConvertFrom-Json -AsHashtable).bundleManifest.files
    if ($pins.Count -ne 167) { throw 'Unexpected bundle manifest' }
    # Inspect all entries, including directories, before recursive traversal follows any redirection.
    $queue=[Collections.Generic.Queue[string]]::new(); $queue.Enqueue($bundle); $count=0; $entries=0
    while ($queue.Count) {
        foreach ($item in Get-ChildItem -LiteralPath $queue.Dequeue() -Force) {
            $entries++; if ($entries -gt 256 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Bundle redirection or entry budget' }
            if ($item.PSIsContainer) { $queue.Enqueue($item.FullName); continue }
            $relative=[IO.Path]::GetRelativePath($bundle,$item.FullName).Replace('\','/')
            if (-not $pins.ContainsKey($relative) -or (Get-FileHash -LiteralPath $item.FullName).Hash -ine $pins[$relative]) { throw 'Bundle pin mismatch or extra file' }
            $count++
        }
    }
    if ($count -ne 167 -or ((Get-Item -LiteralPath $compiler).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Missing bundle files or redirected compiler' }
    $report.compilerSha256=(Get-FileHash -LiteralPath $compiler).Hash.ToLowerInvariant()
    if ($report.compilerSha256 -cne 'cde026ff966b48b5e5f148b6f041ceff3cf4f85cf75155f4ec0f40e4ee14b545') { throw 'Compiler pin mismatch' }
    $report.nativeCandidate=Confirm-DatabaseNative -Source $nativeCandidate -ExpectedBytes $jniBytes -ExpectedSha256 $jniHash
    if (-not $Execute) { $report.status='prepared-read-only-database-control'; return }
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try { $admin=[Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
    finally { $identity.Dispose() }
    if (-not $admin) { throw 'Separately authorized elevated Windows host required' }
    foreach ($name in @('Get-DiskImage','Get-Disk','Get-Partition','Get-Volume','Initialize-Disk','New-Partition','Format-Volume','Add-PartitionAccessPath','Remove-PartitionAccessPath')) {
        if (-not (Get-Command "Storage\$name" -ErrorAction SilentlyContinue)) { throw "Missing storage command $name" }
    }
    foreach ($file in @('NodeProbeDisk.cs','NodeProbeProcess.cs','NodeTrafficCounter.cs','NodeDatabaseIdentity.cs')) { Add-Type -Path (Join-Path $PSScriptRoot $file) }
    $letter=[NodeDatabaseIdentity]::SelectUnusedDriveLetter(); $report.driveLetter=[string]$letter
    $driveRoot=([string]$letter)+':\'
    $report.status='unresolved-database-control'
    [void][IO.Directory]::CreateDirectory($run); $report.mutationsStarted=$true
    $owned=$null; $mappingAttempted=$false
    try {
        $owned=[NodeProbeDisk]::Create($imagePath); $owned.Attach(); $report.nativeDisk=$owned.Info
        function Read-OwnedDatabaseDisk([string]$Style) {
            $images=@(Storage\Get-DiskImage -ImagePath $imagePath)
            if ($images.Count -ne 1) { throw 'Ambiguous owned image' }
            $disks=@($images[0] | Storage\Get-Disk)
            if ($disks.Count -ne 1) { throw 'Ambiguous owned disk' }
            Assert-ProbeDiskIdentity $images[0] $disks[0] $imagePath $owned.PhysicalPath $Style
            $report.disk=$disks[0] | Select-Object Number,Path,UniqueId,Guid,Size,PartitionStyle
            return $disks[0]
        }
        $disk=Read-OwnedDatabaseDisk 'RAW'
        if (@(Storage\Get-Partition -Disk $disk).Count) { throw 'New disk already has partitions' }
        Storage\Initialize-Disk -InputObject $disk -PartitionStyle GPT -Confirm:$false
        $disk=Read-OwnedDatabaseDisk 'GPT'; $diskId=$disk.UniqueId; $diskPath=$disk.Path; $diskGuid=$disk.Guid
        $created=@(Storage\New-Partition -InputObject $disk -Offset 1048576UL -UseMaximumSize -AssignDriveLetter:$false)
        if ($created.Count -ne 1) { throw 'Ambiguous created partition' }
        $expected=$created[0]; Assert-ProbePartition $expected $disk $null
        $report.partition=$expected | Select-Object DiskNumber,PartitionNumber,Guid,Offset,Size,GptType
        function Read-OwnedDatabasePartition([bool]$Mapped=$false) {
            $d=Read-OwnedDatabaseDisk 'GPT'
            if ($d.UniqueId -ine $diskId -or $d.Path -ine $diskPath -or $d.Guid -ine $diskGuid) { throw 'Disk identity changed' }
            $parts=@(Storage\Get-Partition -Disk $d | Where-Object { $_.PartitionNumber -eq $expected.PartitionNumber })
            if ($parts.Count -ne 1) { throw 'Owned partition missing or ambiguous' }
            if ($Mapped) { Assert-DatabaseMappedPartition $parts[0] $d $expected $letter }
            else { Assert-ProbePartition $parts[0] $d $expected }
            return $parts[0]
        }
        $partition=Read-OwnedDatabasePartition
        $volumes=@(Storage\Get-Volume -Partition $partition)
        if ($volumes.Count -ne 1 -or $volumes[0].FileSystem -notin @('','RAW')) { throw 'New volume is not empty' }
        Storage\Format-Volume -Partition $partition -FileSystem NTFS -NewFileSystemLabel 'MOE_JRE_CONTROL' -AllocationUnitSize 4096 -Confirm:$false | Out-Null
        $partition=Read-OwnedDatabasePartition
        $volumes=@(Storage\Get-Volume -Partition $partition)
        if ($volumes.Count -ne 1) { throw 'Ambiguous formatted volume' }
        $volume=$volumes[0]; $volumeRoot=$volume.Path; $report.volumeRoot=$volumeRoot
        if ($volume.FileSystem -cne 'NTFS' -or $volume.FileSystemLabel -cne 'MOE_JRE_CONTROL' -or
            $volume.Size -le 0 -or $volume.Size -gt 67108864L -or ($volume.DriveLetter -and [int][char]$volume.DriveLetter -ne 0)) { throw 'Unexpected volume identity/capacity' }
        $report.volumeBefore=$volume | Select-Object Path,UniqueId,FileSystem,FileSystemLabel,Size,SizeRemaining
        [NodeDatabaseIdentity]::VerifyDriveLetterAbsent($letter)
        $mappingAttempted=$true
        Storage\Add-PartitionAccessPath -InputObject $partition -AccessPath $driveRoot
        $partition=Read-OwnedDatabasePartition $true
        $report.mappingBefore=[NodeDatabaseIdentity]::VerifyDriveMapping($letter,$volumeRoot)
        function Assert-DatabaseVolume {
            $p=Read-OwnedDatabasePartition $true; $v=@(Storage\Get-Volume -Partition $p)
            if ($v.Count -ne 1 -or $v[0].Path -ine $volumeRoot -or $v[0].UniqueId -ine $volume.UniqueId -or
                $v[0].FileSystem -cne 'NTFS' -or $v[0].FileSystemLabel -cne 'MOE_JRE_CONTROL' -or $v[0].Size -ne $volume.Size) { throw 'Owned volume changed' }
            [NodeDatabaseIdentity]::VerifyDriveMapping($letter,$volumeRoot) | Out-Null
            if ($drive.AvailableFreeSpace -lt 107374182400L) { throw 'Host reserve lost' }
            return $v[0]
        }
        [void](Assert-DatabaseVolume)
        $root=Join-Path $driveRoot 'run'
        if (Test-Path -LiteralPath $root) { throw 'Worker root already exists' }
        foreach ($path in @($root,"$root/tmp","$root/home","$root/native","$root/classes")) { [void][IO.Directory]::CreateDirectory($path) }
        # The pinned explicit-directory overload applies getJniLibraryFileName
        # to "rocksdbjni", yielding a second "jni". Preserve the exact candidate
        # bytes/hash while using the basename this loader requests.
        $jni=Join-Path $root 'native/librocksdbjnijni-win64.dll'
        $jar=Join-Path $bundle 'ergo-6.1.5.jar'
        $report.nativeCandidate=Confirm-DatabaseNative -Source $nativeCandidate -ExpectedBytes $jniBytes -ExpectedSha256 $jniHash -Destination $jni
        $java=Join-Path $bundle 'jre/bin/java.exe'
        $jvm=@('-Xms32m','-Xmx256m',"-Djava.io.tmpdir=$root/tmp","-Duser.home=$root/home", "-Djava.library.path=$root/native",
            '-XX:-UsePerfData','-XX:-CreateCoredumpOnCrash',"-XX:ErrorFile=$root/hs_err.log")
        foreach ($mode in @('compile','threshold','missing','late','failing','disk-full')) {
            [void](Assert-DatabaseVolume)
            $caseRoot=Join-Path $root $mode
            if ($mode -ne 'compile') { [void][IO.Directory]::CreateDirectory($caseRoot) }
            $argsForJava=if ($mode -eq 'compile') {
                $jvm+@('-jar',$compiler,'-proc:none','-encoding','UTF-8','-source','8','-target','8','-cp',$jar,'-d',"$root/classes",(Join-Path $PSScriptRoot 'NodeDatabaseControl.java'))
            } else { $jvm+@('-cp',("$root/classes;"+$jar),'NodeDatabaseControl',$root,$jniHash,$mode) }
            $clock=[Diagnostics.Stopwatch]::StartNew()
            $baseline=[NodeTrafficCounter]::Read($clock)
            $budget=[NodeTrafficCounter+Accumulator]::new($baseline,1048576UL,1000L)
            $state=New-DatabaseTrafficState
            $progress=[ordered]@{ modules=@(); nativeVerified=$false; databaseActive=$false; injected=$false; injectedReason=$null; injectedReadError=$null }
            $observer=[Func[uint32,long,bool]] {
                param($processId,$outputBytes)
                $stop=Update-DatabaseTraffic $budget $state { [NodeTrafficCounter]::Read($clock) }
                try {
                    [NodeDatabaseIdentity]::VerifyDriveMapping($letter,$volumeRoot) | Out-Null
                    if (-not $stop -and $mode -ne 'compile') {
                        if (-not $progress.nativeVerified -and (Read-DatabaseMarker "$caseRoot/jni-ready" "READY`n")) {
                            $progress.modules=@([NodeDatabaseIdentity]::CaptureAndVerifyModules([int]$processId,$root,$bundle,$jni,$jniHash,$pins))
                            # A slow module snapshot invalidates the same real accounting window.
                            $stop=Update-DatabaseTraffic $budget $state { [NodeTrafficCounter]::Read($clock) }
                            if (-not $stop) {
                                [NodeDatabaseIdentity]::VerifyDriveMapping($letter,$volumeRoot) | Out-Null
                                $proceed=[IO.File]::Open("$caseRoot/jni-proceed",[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
                                try { $bytes=[Text.Encoding]::ASCII.GetBytes("PROCEED`n"); $proceed.Write($bytes,0,$bytes.Length) } finally { $proceed.Dispose() }
                                $progress.nativeVerified=$true
                            }
                        }
                        if ($progress.nativeVerified -and (Read-DatabaseMarker "$caseRoot/db-active" "ACTIVE`n")) {
                            $progress.databaseActive=$true
                            if ($mode -ne 'disk-full' -and -not $progress.injected) {
                                $row=[NodeTrafficCounter+Row]::new('injected',6,1,0,0,0,0,0,0)
                                $synthetic=[NodeTrafficCounter+Accumulator]::new([NodeTrafficCounter+Sample]::new(0,0,@($row)),1UL,1000L)
                                $syntheticState=New-DatabaseTrafficState
                                $stop=Update-DatabaseTraffic $synthetic $syntheticState {
                                    switch ($mode) {
                                        'threshold' { [NodeTrafficCounter+Sample]::new(250,250,@([NodeTrafficCounter+Row]::new('injected',6,1,1,0,0,0,0,0))) }
                                        'missing' { $null }
                                        'late' { [NodeTrafficCounter+Sample]::new(1001,1001,@($row)) }
                                        'failing' { throw 'Injected reader failure' }
                                    }
                                }
                                $progress.injected=$true; $progress.injectedReason=$synthetic.StopReason; $progress.injectedReadError=$syntheticState.readError
                                if (-not $stop) { throw 'Synthetic refusal did not request stop' }
                            }
                        }
                    }
                } catch { $state.readError=$_.Exception.Message; $stop=$true }
                if ($stop -and $state.stopDecisionMs -lt 0) { $state.stopDecisionMs=$clock.ElapsedMilliseconds }
                return $stop
            }
            $accounted=Invoke-DatabaseAccountedRun {
                [NodeProbeProcess]::Run($java,$argsForJava,$root,$mode,1073741824UL,30000,65536,$observer)
            } { [NodeTrafficCounter]::Read($clock) } $budget $state $clock
            $record=[ordered]@{ mode=$mode; arguments=$argsForJava; process=$accounted.Process; launchFailure=$accounted.Failure;
                traffic=$budget; observations=$state; progress=$progress }
            $report.cases+=,$record
            if ($accounted.Failure) { throw $accounted.Failure }
            $stopped=$mode -notin @('compile','disk-full')
            Assert-DatabaseProcess $accounted.Process $stopped
            Assert-DatabaseTraffic $state $budget $stopped
            if ($mode -eq 'compile') {
                $classFiles=@(Get-ChildItem -LiteralPath "$root/classes" -File)
                if ($classFiles.Count -lt 1 -or $classFiles.Count -gt 8 -or ($classFiles | Measure-Object Length -Sum).Sum -gt 65536) { throw 'Compiled class budget' }
                $record.classes=@($classFiles | ForEach-Object { [ordered]@{name=$_.Name; bytes=$_.Length; sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()} })
            } else {
                # Natural disk-full exit can race a 250 ms observer sample. Its
                # marker is still readable on the verified volume after job empty.
                if ($mode -eq 'disk-full') {
                    [NodeDatabaseIdentity]::VerifyDriveMapping($letter,$volumeRoot) | Out-Null
                    $progress.databaseActive=Read-DatabaseMarker "$caseRoot/db-active" "ACTIVE`n"
                }
                if (-not $progress.nativeVerified -or -not $progress.databaseActive) { throw 'Missing native/database handshake' }
                if ($stopped) {
                    $expectedReason=@{threshold='traffic-threshold';missing='invalid-sample';late='sample-gap';failing=$null}[$mode]
                    if (-not $progress.injected -or $progress.injectedReason -cne $expectedReason -or
                        ($mode -eq 'failing' -and $progress.injectedReadError -cne 'Injected reader failure')) { throw 'Unexpected injected refusal' }
                }
                # Worker JSON outcome and final volume checks below are independent of stop classification.
            }
        }
        $report.volumeAfter=Assert-DatabaseVolume | Select-Object Path,UniqueId,FileSystem,FileSystemLabel,Size,SizeRemaining
        $report.mappingAfter=[NodeDatabaseIdentity]::VerifyDriveMapping($letter,$volumeRoot)
        $last=$report.cases[-1].process.Output.Trim().Split("`n")[-1] | ConvertFrom-Json
        $report.databaseResult=$last
        # The fixed worker must positively report disk exhaustion, not a generic IO error.
        Assert-DatabaseResult $last
        # All workers are empty before this finite inventory. Never walk database
        # trees inside the sample-critical observer. Residue from killed cases is
        # included in the same volume ceiling and discarded with the owned image.
        $pending=[Collections.Generic.Queue[string]]::new(); $pending.Enqueue($root)
        $inventory=[Collections.Generic.List[object]]::new(); $entryCount=0; $fileBytes=0L
        $inventoryClock=[Diagnostics.Stopwatch]::StartNew()
        while ($pending.Count) {
            foreach ($item in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
                $entryCount++
                if ($entryCount -gt 1024 -or $inventoryClock.ElapsedMilliseconds -gt 5000 -or
                    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Final inventory bound or redirection' }
                if ($item.PSIsContainer) { $pending.Enqueue($item.FullName); continue }
                $fileBytes+=$item.Length
                if ($fileBytes -gt 67108864L) { throw 'Final logical file-byte budget' }
                $inventory.Add([ordered]@{path=[IO.Path]::GetRelativePath($root,$item.FullName);bytes=$item.Length})
            }
        }
        $report.finalInventory=$inventory.ToArray(); $report.finalFileBytes=$fileBytes
        $report.inventoryElapsedMs=$inventoryClock.ElapsedMilliseconds
    } finally {
        if ($mappingAttempted) {
            try {
                # Re-read the actual mapping even if assignment succeeded then threw.
                [NodeDatabaseIdentity]::VerifyDriveMapping($letter,$volumeRoot) | Out-Null
                $partition=Read-OwnedDatabasePartition $true
                Storage\Remove-PartitionAccessPath -InputObject $partition -AccessPath $driveRoot
                [NodeDatabaseIdentity]::VerifyDriveLetterAbsent($letter)
                [void](Read-OwnedDatabasePartition $false)
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
    # Delete only the fixed newly-created detached image, never a recursive path.
    [IO.File]::Delete($imagePath)
    if (Test-Path -LiteralPath $imagePath) { throw 'Image removal readback failed' }
    $report.artifactRemoved=$true; $report.status='offline-database-composition-only'
} catch { $report.errors+=$_.Exception.Message }
finally { $report | ConvertTo-Json -Depth 16 }
if ($report.status -notin @('prepared-read-only-database-control','offline-database-composition-only')) { exit 2 }
