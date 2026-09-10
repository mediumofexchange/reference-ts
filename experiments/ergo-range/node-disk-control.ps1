# Fixed offline control. Default is read-only preflight; -Execute needs an elevated host.
param([switch]$Execute)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Requires Windows x64 / PowerShell 7' }
. (Join-Path $PSScriptRoot 'node-disk-evidence.ps1')
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$run = Join-Path $repo 'scratch/node-disk-control'
$imagePath = Join-Path $run 'control.vhd'
$hashes = [ordered]@{}
foreach ($file in @('NodeProbeDisk.cs','NodeProbeProcess.cs','node-disk-control.ps1',
    'node-disk-worker.ps1','node-disk-evidence.ps1','node-disk-evidence.test.ps1')) {
    $hashes[$file] = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $file) -Algorithm SHA256).Hash.ToLowerInvariant()
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try { $administrator = [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
finally { $identity.Dispose() }
$report = [ordered]@{ status='unresolved-disk-preflight'; observedAtUtc=[DateTime]::UtcNow.ToString('o');
    os=[Environment]::OSVersion.VersionString; powershell=$PSVersionTable.PSVersion.ToString();
    executeRequested=[bool]$Execute; administrator=$administrator; imagePath=$imagePath;
    virtualBytes=67108864L; maximumBackingFileBytes=68157440L; hostReserveBytes=107374182400L;
    workerMaximumAttemptedBytes=68157440L; workerWallMs=30000; workerMemoryBytes=536870912L;
    workerOutputBytes=65536; mutationsStarted=$false; detached=$false; artifactRemoved=$false;
    hostFreeBefore=$null; hostFreeAfter=$null; backingFileBytes=$null; nativeDisk=$null; disk=$null; partition=$null;
    volumeBefore=$null; volumeAfter=$null; process=$null; fill=$null; errors=@(); files=$hashes;
    limitations=@('Fixed trusted offline control only; no Ergo node, peers, full-sized allocation or production gate.',
        'Stable trusted host and no concurrent storage/admin/path changes assumed; not a filesystem sandbox.',
        'Worker has a Job Object deadline; synchronous Windows storage setup/detach calls have no hard deadline.',
        'The host reserve is checked before/after; unrelated host writers are not contained.',
        'No existing image is reused; a failed attempt retains its exact artifact for inspection.') }
try {
    # Check existing ancestors; reject path redirection before any directory or disk creation.
    $cursor = $run
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Run ancestor is not an ordinary directory' }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    if ($repo -cnotmatch '^[A-Za-z]:\\' -or (Test-Path -LiteralPath $run)) { throw 'Requires local repository and absent control directory' }
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($repo))
    if ($drive.DriveFormat -cne 'NTFS' -or $drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'Requires fixed NTFS host volume' }
    $report.hostFreeBefore = $drive.AvailableFreeSpace
    if ($report.hostFreeBefore -lt 107442339840L) { throw 'Insufficient host reserve for fixed control' }
    # Conservative gate: administrator membership does not itself prove SeManageVolumePrivilege.
    # No token privilege is enabled or changed; AttachVirtualDisk must succeed separately.
    if (-not $administrator) { throw 'Elevated Windows host required; no disk or worker was created' }
    foreach ($command in @('Get-DiskImage','Get-Disk','Get-Partition','Get-Volume','Initialize-Disk','New-Partition','Format-Volume')) {
        if (-not (Get-Command "Storage\$command" -ErrorAction SilentlyContinue)) { throw "Missing Storage command: $command" }
    }
    if (-not $Execute) { $report.status='ready-for-explicit-disk-control'; return }
    $report.status = 'unresolved-disk-control'
    Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeDisk.cs')
    Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeProcess.cs')
    [void][IO.Directory]::CreateDirectory($run)
    $report.mutationsStarted = $true
    $ownedDisk = $null
    try {
        $ownedDisk = [NodeProbeDisk]::Create($imagePath)
        $ownedDisk.Attach()
        $report.nativeDisk = $ownedDisk.Info
        function Read-OwnedDisk([string]$Style) {
            $images = @(Storage\Get-DiskImage -ImagePath $imagePath)
            if ($images.Count -ne 1) { throw 'Expected exactly the created image' }
            $disks = @($images[0] | Storage\Get-Disk)
            if ($disks.Count -ne 1) { throw 'Expected exactly the created disk' }
            Assert-ProbeDiskIdentity $images[0] $disks[0] $imagePath $ownedDisk.PhysicalPath $Style
            return $disks[0]
        }
        $disk = Read-OwnedDisk 'RAW'
        if (@(Storage\Get-Partition -Disk $disk).Count -ne 0) { throw 'New RAW disk already has partitions' }
        # Each mutator receives the object derived from this owned image, never an input disk number.
        Storage\Initialize-Disk -InputObject $disk -PartitionStyle GPT -Confirm:$false
        $disk = Read-OwnedDisk 'GPT'
        $diskId = $disk.UniqueId; $diskPath = $disk.Path; $diskGuid = $disk.Guid
        $partitions = @(Storage\New-Partition -InputObject $disk -UseMaximumSize -AssignDriveLetter:$false)
        if ($partitions.Count -ne 1) { throw 'Expected one created data partition' }
        $expectedPartition = $partitions[0]
        Assert-ProbePartition $expectedPartition $disk $null
        function Read-OwnedPartition {
            $currentDisk = Read-OwnedDisk 'GPT'
            if ($currentDisk.UniqueId -ine $diskId -or $currentDisk.Path -ine $diskPath -or $currentDisk.Guid -ine $diskGuid) {
                throw 'Disk changed after initialization'
            }
            $current = @(Storage\Get-Partition -Disk $currentDisk | Where-Object { $_.PartitionNumber -eq $expectedPartition.PartitionNumber })
            if ($current.Count -ne 1) { throw 'Expected one current data partition' }
            Assert-ProbePartition $current[0] $currentDisk $expectedPartition
            return $current[0]
        }
        $partition = Read-OwnedPartition
        $volumes = @(Storage\Get-Volume -Partition $partition)
        if ($volumes.Count -ne 1 -or $volumes[0].FileSystem -notin @('', 'RAW')) { throw 'New partition already has a filesystem or ambiguous volume' }
        Storage\Format-Volume -Partition $partition -FileSystem NTFS -NewFileSystemLabel 'MOE_DISK_CONTROL' -AllocationUnitSize 4096 -Confirm:$false | Out-Null
        $partition = Read-OwnedPartition
        $volumes = @(Storage\Get-Volume -Partition $partition)
        if ($volumes.Count -ne 1) { throw 'Expected one formatted volume' }
        $volume = $volumes[0]
        $volumeRoot = $volume.Path
        if ($volumeRoot -cnotmatch '^\\\\\?\\Volume\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}\\\z' -or
            $volume.FileSystem -cne 'NTFS' -or $volume.FileSystemLabel -cne 'MOE_DISK_CONTROL' -or
            $volume.Size -le 0 -or $volume.Size -gt 67108864UL -or
            ($volume.DriveLetter -and [int][char]$volume.DriveLetter -ne 0)) { throw 'Unexpected formatted volume identity/capacity' }
        $report.disk = $disk | Select-Object Number,Path,UniqueId,Guid,Size,BusType,PartitionStyle
        $report.partition = $partition | Select-Object DiskNumber,PartitionNumber,Guid,Offset,Size,GptType
        $report.volumeBefore = $volume | Select-Object Path,UniqueId,FileSystem,FileSystemLabel,Size,SizeRemaining
        $worker = Join-Path $PSScriptRoot 'node-disk-worker.ps1'
        $powershell = Join-Path $PSHOME 'pwsh.exe'
        $report.process = [NodeProbeProcess]::Run($powershell,
            @('-NoLogo','-NoProfile','-NonInteractive','-File',$worker,'-Volume',$volumeRoot.TrimEnd('\')),
            $run,'fixed-disk-full',536870912UL,30000,65536,$null)
        $report.fill = ConvertFrom-Json -InputObject $report.process.Output
        $partition = Read-OwnedPartition
        $after = @(Storage\Get-Volume -Partition $partition)
        if ($after.Count -ne 1 -or $after[0].Path -ine $volumeRoot -or $after[0].UniqueId -ine $volume.UniqueId) {
            throw 'Volume changed during worker'
        }
        $report.volumeAfter = $after[0] | Select-Object Path,UniqueId,FileSystem,FileSystemLabel,Size,SizeRemaining
    } finally {
        if ($null -ne $ownedDisk) {
            try { $ownedDisk.Detach() } finally { $ownedDisk.Dispose() }
            $images = @(Storage\Get-DiskImage -ImagePath $imagePath)
            if ($images.Count -ne 1 -or $images[0].Attached -isnot [bool] -or $images[0].Attached) { throw 'Disk detach readback unresolved; artifact retained' }
            $report.detached = $true
        }
    }
    $report.backingFileBytes = (Get-Item -LiteralPath $imagePath).Length
    $report.hostFreeAfter = $drive.AvailableFreeSpace
    Assert-ProbeDiskCompletion $report.process $report.fill $report.volumeAfter $report.detached `
        $report.backingFileBytes $report.hostFreeBefore $report.hostFreeAfter
    # No automatic file deletion: preserve the one bounded image and its evidence.
    $report.status = 'fixed-native-disk-full-only'
} catch { $report.errors += $_.Exception.Message }
finally { $report | ConvertTo-Json -Depth 12 }
if ($report.status -ne 'fixed-native-disk-full-only' -and $report.status -ne 'ready-for-explicit-disk-control') { exit 2 }
