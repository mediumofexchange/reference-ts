# Fixture-only checks for the pure guards used by node-disk-control.ps1.
# This file does not attach, create, format, or write any storage.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'node-disk-evidence.ps1')

$script:Cases = 0
function Expect-Pass([string]$Name, [scriptblock]$Action) {
    $script:Cases++
    try { & $Action } catch { throw "$Name unexpectedly rejected: $($_.Exception.Message)" }
}
function Expect-Reject([string]$Name, [scriptblock]$Action) {
    $script:Cases++
    try { & $Action; throw "$Name unexpectedly passed" } catch {
        if ($_.Exception.Message -eq "$Name unexpectedly passed") { throw }
    }
}
function New-IdentityFixture {
    [pscustomobject]@{ Image=[pscustomobject]@{ Attached=$true; ImagePath='C:\control.vhd'; DevicePath='\\.\PhysicalDrive12' }
        Disk=[pscustomobject]@{ Number=12; Size=67108864UL; BusType=15; PartitionStyle='RAW'; IsBoot=$false; IsSystem=$false; IsOffline=$false; IsReadOnly=$false; Path='\\?\scsi#disk'; UniqueId='disk-12'; NumberOfPartitions=0 } }
}
function New-PartitionFixture {
    [pscustomobject]@{ Disk=[pscustomobject]@{ Number=12 }
        Partition=[pscustomobject]@{ DiskNumber=12; GptType='{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}'; IsBoot=$false; IsSystem=$false; IsReadOnly=$false; IsOffline=$false; DriveLetter=$null; Offset=1048576UL; Size=66060288UL; Guid='{11111111-2222-3333-4444-555555555555}'; PartitionNumber=1 }
        Expected=[pscustomobject]@{ Guid='{11111111-2222-3333-4444-555555555555}'; PartitionNumber=1; Offset=1048576UL; Size=66060288UL } }
}
function New-CompletionFixture {
    [pscustomobject]@{ Process=[pscustomobject]@{ LimitsReadBackBeforeResume=$true; JobEmptyAfterCleanup=$true; Outcome='exited'; ExitCode=0; CommitLimitBytes=536870912UL; PeakCommitBytes=536870912UL; PeakProcessCommitBytes=536870912UL; SampledPeakPrivateCommitBytes=536870912UL; CpuRateFlags=5; CpuRatePer10000=2500; BeforeResumeActiveProcesses=1; MaxSampledAssociatedProcesses=1; ElapsedMs=30000; CapturedOutputBytes=65536 }
        Fill=[pscustomobject]@{ Status='disk-full'; NativeError=112; BytesWritten=67108864UL; AttemptedBytes=68157440UL }
        Volume=[pscustomobject]@{ FileSystem='NTFS'; Size=67108864UL; SizeRemaining=0L }
        Detached=$true; FileBytes=67108864L; HostFreeBefore=107442339840L; HostFreeAfter=107374182400L }
}
function Invoke-Identity([scriptblock]$Mutate) { $f=New-IdentityFixture; & $Mutate $f; Assert-ProbeDiskIdentity $f.Image $f.Disk 'C:\control.vhd' '\\.\PhysicalDrive12' 'RAW' }
function Invoke-Partition([scriptblock]$Mutate) { $f=New-PartitionFixture; & $Mutate $f; Assert-ProbePartition $f.Partition $f.Disk $f.Expected }
function Invoke-Completion([scriptblock]$Mutate) { $f=New-CompletionFixture; & $Mutate $f; Assert-ProbeDiskCompletion $f.Process $f.Fill $f.Volume $f.Detached $f.FileBytes $f.HostFreeBefore $f.HostFreeAfter }

Expect-Pass 'valid disk identity' { Invoke-Identity {} }
Expect-Pass 'valid partition' { Invoke-Partition {} }
Expect-Pass 'valid completion' { Invoke-Completion {} }

@(
    @{ n='unattached image'; m={param($f) $f.Image.Attached=$false} },
    @{ n='wrong image'; m={param($f) $f.Image.ImagePath='C:\other.vhd'} },
    @{ n='wrong device'; m={param($f) $f.Image.DevicePath='\\.\PhysicalDrive13'} },
    @{ n='wrong disk number'; m={param($f) $f.Disk.Number=13} },
    @{ n='wrong size'; m={param($f) $f.Disk.Size=67108863UL} },
    @{ n='wrong bus'; m={param($f) $f.Disk.BusType=7} },
    @{ n='wrong partition style'; m={param($f) $f.Disk.PartitionStyle='GPT'} },
    @{ n='boot disk'; m={param($f) $f.Disk.IsBoot=$true} },
    @{ n='system disk'; m={param($f) $f.Disk.IsSystem=$true} },
    @{ n='read-only disk'; m={param($f) $f.Disk.IsReadOnly=$true} },
    @{ n='offline disk'; m={param($f) $f.Disk.IsOffline=$true} },
    @{ n='nonempty raw disk'; m={param($f) $f.Disk.NumberOfPartitions=1} },
    @{ n='missing disk path'; m={param($f) $f.Disk.Path=''} },
    @{ n='missing disk identity'; m={param($f) $f.Disk.UniqueId=''} },
    @{ n='malformed physical path'; m={param($f) $f.Image.DevicePath='PhysicalDrive12'} }
) | ForEach-Object { $case=$_; Expect-Reject $case.n { Invoke-Identity $case.m } }

@(
    @{ n='partition substitution'; m={param($f) $f.Partition.Guid='{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}'} },
    @{ n='partition wrong disk'; m={param($f) $f.Partition.DiskNumber=13} },
    @{ n='partition wrong type'; m={param($f) $f.Partition.GptType='{00000000-0000-0000-0000-000000000000}'} },
    @{ n='partition boot'; m={param($f) $f.Partition.IsBoot=$true} },
    @{ n='partition system'; m={param($f) $f.Partition.IsSystem=$true} },
    @{ n='partition readonly'; m={param($f) $f.Partition.IsReadOnly=$true} },
    @{ n='partition offline'; m={param($f) $f.Partition.IsOffline=$true} },
    @{ n='partition drive letter'; m={param($f) $f.Partition.DriveLetter='D'} },
    @{ n='partition low offset'; m={param($f) $f.Partition.Offset=1048575UL} },
    @{ n='partition past disk'; m={param($f) $f.Partition.Offset=67108864UL} },
    @{ n='partition zero size'; m={param($f) $f.Partition.Size=0UL} },
    @{ n='partition oversized'; m={param($f) $f.Partition.Size=67108864UL} },
    @{ n='partition missing guid'; m={param($f) $f.Partition.Guid=''} },
    @{ n='partition number changed'; m={param($f) $f.Partition.PartitionNumber=2} },
    @{ n='partition offset changed'; m={param($f) $f.Partition.Offset=2097152UL} },
    @{ n='partition size changed'; m={param($f) $f.Partition.Size=65011712UL} }
) | ForEach-Object { $case=$_; Expect-Reject $case.n { Invoke-Partition $case.m } }

@(
    @{ n='disk-full false positive status'; m={param($f) $f.Fill.Status='completed'} },
    @{ n='disk-full false positive error'; m={param($f) $f.Fill.NativeError=0} },
    @{ n='fill oversize'; m={param($f) $f.Fill.AttemptedBytes=68157441UL} },
    @{ n='missing cleanup'; m={param($f) $f.Process.JobEmptyAfterCleanup=$false} },
    @{ n='limits not read back'; m={param($f) $f.Process.LimitsReadBackBeforeResume=$false} },
    @{ n='worker failure'; m={param($f) $f.Process.ExitCode=1} },
    @{ n='wrong commit limit'; m={param($f) $f.Process.CommitLimitBytes=536870911UL} },
    @{ n='excess memory'; m={param($f) $f.Process.PeakCommitBytes=536870913UL} },
    @{ n='excess process memory'; m={param($f) $f.Process.PeakProcessCommitBytes=536870913UL} },
    @{ n='excess sampled memory'; m={param($f) $f.Process.SampledPeakPrivateCommitBytes=536870913UL} },
    @{ n='wrong cpu flags'; m={param($f) $f.Process.CpuRateFlags=4} },
    @{ n='wrong cpu rate'; m={param($f) $f.Process.CpuRatePer10000=2499} },
    @{ n='pre-resume worker count'; m={param($f) $f.Process.BeforeResumeActiveProcesses=2} },
    @{ n='associated worker count'; m={param($f) $f.Process.MaxSampledAssociatedProcesses=2} },
    @{ n='excess timing'; m={param($f) $f.Process.ElapsedMs=30001} },
    @{ n='excess output'; m={param($f) $f.Process.CapturedOutputBytes=65537} },
    @{ n='missing detach'; m={param($f) $f.Detached=$false} },
    @{ n='undersized backing'; m={param($f) $f.FileBytes=67108863L} },
    @{ n='oversized backing'; m={param($f) $f.FileBytes=68157441L} },
    @{ n='wrong filesystem'; m={param($f) $f.Volume.FileSystem='FAT32'} },
    @{ n='oversized volume'; m={param($f) $f.Volume.Size=67108865UL} },
    @{ n='free space false positive'; m={param($f) $f.Volume.SizeRemaining=1048576L} },
    @{ n='low host reserve before'; m={param($f) $f.HostFreeBefore=107442339839L} },
    @{ n='low host reserve after'; m={param($f) $f.HostFreeAfter=107374182399L} },
    @{ n='missing completion property'; m={param($f) $f.Process.PSObject.Properties.Remove('Outcome')} }
) | ForEach-Object { $case=$_; Expect-Reject $case.n { Invoke-Completion $case.m } }

# Parse-only verification keeps control/worker syntax checked without invoking their param blocks.
foreach ($script in @('node-disk-control.ps1','node-disk-worker.ps1')) {
    $tokens=$null; $errors=$null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $script), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw "$script has parse errors: $($errors[0].Message)" }
}
# Compile and exercise native guards without invoking any storage mutation.
if ($IsWindows -and [Environment]::Is64BitProcess) {
    Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeDisk.cs')
    [NodeProbeDisk]::ValidateNativeLayoutForTest()
    $probeRoot = '\\?\Volume{00112233-4455-6677-8899-aabbccddeeff}\'
    if ([NodeProbeDisk]::ValidateVolumeGuidRoot($probeRoot) -cne $probeRoot) { throw 'Changed volume GUID root' }
    foreach ($invalidRoot in @('C:\', ($probeRoot + 'child'), $probeRoot.TrimEnd('\'), ($probeRoot + "`n"), ($probeRoot + "`r`n"), '\\server\share\')) {
        Expect-Reject 'invalid native volume root' { [NodeProbeDisk]::ValidateVolumeGuidRoot($invalidRoot) }
    }
    foreach ($invalidImage in @('relative.vhd', 'C:\test.vhd:stream', '\\server\share\test.vhd', ($probeRoot + 'test.vhd'))) {
        Expect-Reject 'invalid native image path' { [NodeProbeDisk]::ValidateImagePathForCreate($invalidImage) }
    }
}
"node-disk-evidence fixture tests passed ($script:Cases cases; native compile/ABI checks on Windows x64)"
