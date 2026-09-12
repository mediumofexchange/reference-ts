# Elevated owner for one fresh, fixed 64 MiB offline VHD. Never starts Java.
param([Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{32}$')][string]$Nonce,
    [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$ParentId,
    [Parameter(Mandatory)][long]$ParentStarted,[switch]$Sync30Minutes)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
foreach ($file in @('node-volume-handoff.ps1','node-disk-evidence.ps1','node-database-evidence.ps1')) { . (Join-Path $PSScriptRoot $file) }
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$profile=Get-NodeVolumeProfile ([bool]$Sync30Minutes)
$run=Join-Path $repo "scratch/$($profile.scratchName)/$Nonce"
$imagePath=Join-Path $run 'control.vhd'
$report=[ordered]@{status='unresolved-owned-volume';nonce=$Nonce;profile=$profile.name;imagePath=$imagePath;parentId=$ParentId;parentStarted=$ParentStarted;ownerId=$PID;errors=@();jobEmpty=$false;mappingRemoved=$false;detached=$false;artifactRemoved=$false;reason=$null}
$owned=$null; $lease=$null; $parentProcess=$null; $mappingAttempted=$false; $readyPublished=$false
try {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try { if (-not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Disk owner requires elevation' } }
    finally { $identity.Dispose() }
    Assert-OrdinaryAncestors $run
    if (-not (Test-Path -LiteralPath $run) -or (Test-Path -LiteralPath $imagePath) -or (Test-Path -LiteralPath (Join-Path $run 'ready.json')) -or (Test-Path -LiteralPath (Join-Path $run 'owner.json'))) { throw 'Fresh parent directory required' }
    $parentProcess=[Diagnostics.Process]::GetProcessById($ParentId)
    [void]$parentProcess.Handle # Retain the exact process object, not repeated PID lookup.
    if ($parentProcess.StartTime.ToFileTimeUtc() -ne $ParentStarted -or $parentProcess.HasExited) { throw 'Parent identity mismatch' }
    foreach ($file in @('NodeProbeDisk.cs','NodeProbeProcess.cs','NodeDatabaseIdentity.cs')) { Add-Type -Path (Join-Path $PSScriptRoot $file) }
    $lease=[NodeProbeProcess]::OpenVolumeJob($Nonce)
    if ($lease.ActiveProcesses -ne 0) { throw 'Job must be empty before volume preparation' }
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($repo))
    if ($drive.DriveFormat -cne 'NTFS' -or $drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.AvailableFreeSpace -lt $profile.minimumHostFree) { throw 'Fixed NTFS and host reserve required for selected profile' }
    $report.hostFreeBefore=$drive.AvailableFreeSpace
    $letter=[NodeDatabaseIdentity]::SelectUnusedDriveLetter(); $report.driveLetter=[string]$letter
    $driveRoot=([string]$letter)+':\'
    $clock=[Diagnostics.Stopwatch]::StartNew()
    try {
        $owned=if ($Sync30Minutes) { [NodeProbeDisk]::CreateSync20GiB($imagePath) } else { [NodeProbeDisk]::Create($imagePath) }
        $owned.Attach(); $report.nativeDisk=$owned.Info
        function Read-OwnedVolumeDisk([string]$Style) {
            $images=@(Storage\Get-DiskImage -ImagePath $imagePath)
            if ($images.Count -ne 1) { throw 'Ambiguous owned image' }
            $disks=@($images[0] | Storage\Get-Disk)
            if ($disks.Count -ne 1) { throw 'Ambiguous owned disk' }
            Assert-ProbeDiskIdentity $images[0] $disks[0] $imagePath $owned.PhysicalPath $Style ([bool]$Sync30Minutes)
            $report.disk=$disks[0] | Select-Object Number,Path,UniqueId,Guid,Size,PartitionStyle
            return $disks[0]
        }
        $disk=Read-OwnedVolumeDisk 'RAW'
        if (@(Storage\Get-Partition -Disk $disk).Count) { throw 'New disk already has partitions' }
        Storage\Initialize-Disk -InputObject $disk -PartitionStyle GPT -Confirm:$false
        $disk=Read-OwnedVolumeDisk 'GPT'; $diskId=$disk.UniqueId; $diskPath=$disk.Path; $diskGuid=$disk.Guid
        $report.initializedPartitions=@(Storage\Get-Partition -Disk $disk | Select-Object DiskNumber,PartitionNumber,Guid,GptType,Offset,Size)
        if ($Sync30Minutes) {
            # Windows initializes a reserved partition on the larger GPT image.
            # Let Storage choose free space, then bind the returned data partition
            # using the same GUID/type/offset/size checks before any formatting.
            $created=@(Storage\New-Partition -InputObject $disk -UseMaximumSize -AssignDriveLetter:$false)
        } else { $created=@(Storage\New-Partition -InputObject $disk -Offset 1048576UL -UseMaximumSize -AssignDriveLetter:$false) }
        if ($created.Count -ne 1) { throw 'Ambiguous created partition' }
        $expected=$created[0]; Assert-ProbePartition $expected $disk $null ([bool]$Sync30Minutes)
        $report.partition=$expected | Select-Object DiskNumber,PartitionNumber,Guid,Offset,Size,GptType
        function Read-OwnedVolumePartition([bool]$Mapped=$false) {
            $d=Read-OwnedVolumeDisk 'GPT'
            if ($d.UniqueId -ine $diskId -or $d.Path -ine $diskPath -or $d.Guid -ine $diskGuid) { throw 'Disk identity changed' }
            $parts=@(Storage\Get-Partition -Disk $d | Where-Object { $_.PartitionNumber -eq $expected.PartitionNumber })
            if ($parts.Count -ne 1) { throw 'Owned partition missing or ambiguous' }
            if ($Mapped) { Assert-DatabaseMappedPartition $parts[0] $d $expected $letter ([bool]$Sync30Minutes) }
            else { Assert-ProbePartition $parts[0] $d $expected ([bool]$Sync30Minutes) }
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
            $volume.Size -le 0 -or $volume.Size -gt $profile.virtualBytes -or ($volume.DriveLetter -and [int][char]$volume.DriveLetter -ne 0)) { throw 'Unexpected volume identity/capacity' }
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

        if ($parentProcess.HasExited) { throw 'Parent exited during volume preparation' }
        Write-VolumeHandoff (Join-Path $run 'ready.json') @{nonce=$Nonce;profile=$profile.name;parentId=$ParentId;parentStarted=$ParentStarted;ownerId=$PID;
            driveLetter=[string]$letter;volumeRoot=$volumeRoot;volume=$report.volumeBefore;disk=$report.disk;partition=$report.partition;nativeDisk=$report.nativeDisk}
        $readyPublished=$true
        while ($true) {
            if ($parentProcess.HasExited) { $report.reason='parent-exited'; break }
            $donePath=Join-Path $run 'done.json'
            if (Test-Path -LiteralPath $donePath) {
                $done=Read-VolumeHandoff $donePath
                if ($done.nonce -cne $Nonce -or $done.parentId -ne $ParentId -or $done.parentStarted -ne $ParentStarted) { throw 'Wrong completion handoff' }
                $report.reason='parent-done'; break
            }
            if ($clock.ElapsedMilliseconds -gt $profile.ownerWallMs) {
                # Stop existing work, but retain the volume until parent done/death
                # closes future admission. A suspended parent could otherwise
                # resume and create Java against a volume already detached.
                $report.reason='owner-timeout-awaiting-parent'
                $lease.StopAndConfirmEmpty()
            }
            Start-Sleep -Milliseconds 250
        }
    } finally {
        if ($null -ne $lease) {
            # If ready was published, even a handoff read error must not detach
            # under an active parent that might still launch. Stop the job while
            # waiting for its bound parent to finish or exit.
            while ($true) {
                try {
                    $lease.StopAndConfirmEmpty()
                    $finished= -not $readyPublished -or $parentProcess.HasExited
                    if (-not $finished -and (Test-Path -LiteralPath (Join-Path $run 'done.json'))) {
                        $done=Read-VolumeHandoff (Join-Path $run 'done.json')
                        $finished=$done.nonce -ceq $Nonce -and $done.parentId -eq $ParentId -and $done.parentStarted -eq $ParentStarted
                    }
                    if ($finished) {
                        # Admission must be closed BEFORE the final empty readback.
                        # A parent could have launched and exited since the earlier stop.
                        $lease.StopAndConfirmEmpty()
                        $report.jobEmpty=$true; break
                    }
                } catch {
                    if ($report.errors.Count -lt 16) { $report.errors+=$_.Exception.Message }
                }
                Start-Sleep -Milliseconds 250
            }
        }
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
    if (-not $report.jobEmpty -or -not $report.mappingRemoved -or -not $report.detached -or
        ($image.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $image.Length -lt $profile.virtualBytes -or $image.Length -gt $profile.maximumBackingBytes -or $report.hostFreeAfter -lt 107374182400L) { throw 'Cleanup/capacity/reserve unresolved; image retained' }
    if ($Sync30Minutes) { $report.status='owned-volume-retained-detached' }
    else {
        [IO.File]::Delete($imagePath)
        if (Test-Path -LiteralPath $imagePath) { throw 'Image removal failed' }
        $report.artifactRemoved=$true; $report.status='owned-volume-removed'
    }
} catch { if ($report.errors.Count -lt 16) { $report.errors+=$_.Exception.Message } }
finally {
    if ($null -ne $lease) { $lease.Dispose() }
    if ($null -ne $parentProcess) { $parentProcess.Dispose() }
    Write-VolumeHandoff (Join-Path $run 'owner.json') $report
}
if ($report.status -notin @('owned-volume-removed','owned-volume-retained-detached')) { exit 2 }
