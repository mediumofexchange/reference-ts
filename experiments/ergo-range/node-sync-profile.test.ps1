# Selected profile, identity and evidence guards only; no disk or worker launch.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
foreach ($file in @('node-volume-handoff.ps1','node-disk-evidence.ps1','node-database-evidence.ps1','node-volume-evidence.ps1','node-sync-evidence.ps1')) { . (Join-Path $PSScriptRoot $file) }
Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeDisk.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeProcess.cs')
$cases=0
function Reject([scriptblock]$Action) {
    $failed=$false; try { & $Action } catch { $failed=$true }
    if (-not $failed) { throw 'Expected profile/evidence refusal' }; $script:cases++
}
$offline=Get-NodeVolumeProfile; $sync=Get-NodeVolumeProfile $true
if ($offline.virtualBytes -ne 67108864 -or $offline.childWallMs -ne 120000 -or $sync.virtualBytes -ne 21474836480 -or $sync.childWallMs -ne 1800000 -or
    $sync.minimumHostFree - $sync.maximumBackingBytes -lt 107374182400) { throw 'Fixed profile bounds changed' }; $cases++
Reject { [NodeProbeDisk]::CreateSync20GiB('relative.vhd') }
Reject { [NodeProbeProcess]::Run('unused',@(),'unused','invalid-old-budget',4294967296UL,1800000,1024,$null) }
$image=@{Attached=$true;ImagePath='C:\owned.vhd';DevicePath='\\.\PhysicalDrive8'}
$disk=@{Number=8;Size=21474836480UL;CimInstanceProperties=@{BusType=@{Value=[uint16]15}};PartitionStyle='GPT';IsBoot=$false;IsSystem=$false;IsOffline=$false;IsReadOnly=$false;Path='owned';UniqueId='owned'}
Assert-ProbeDiskIdentity $image $disk 'C:\owned.vhd' '\\.\PhysicalDrive8' 'GPT' $true; $cases++
Reject { Assert-ProbeDiskIdentity $image $disk 'C:\owned.vhd' '\\.\PhysicalDrive8' 'GPT' }
$bad=$disk.Clone(); $bad.Size++; Reject { Assert-ProbeDiskIdentity $image $bad 'C:\owned.vhd' '\\.\PhysicalDrive8' 'GPT' $true }
$partition=@{DiskNumber=8;PartitionNumber=1;GptType='{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}';IsBoot=$false;IsSystem=$false;IsReadOnly=$false;IsOffline=$false;DriveLetter=[char]0;Offset=1048576UL;Size=21473787904UL;Guid='owned'}
Assert-ProbePartition $partition $disk $null $true; $cases++
$afterReserved=$partition.Clone(); $afterReserved.Offset=16777216UL; $afterReserved.Size=21458058752UL
Assert-ProbePartition $afterReserved $disk $null $true; $cases++
Reject { Assert-ProbePartition $partition $disk $null }
$bad=$partition.Clone(); $bad.Size++; Reject { Assert-ProbePartition $bad $disk $null $true }
$mapped=$partition.Clone(); $mapped.DriveLetter=[char]'Z'
Assert-DatabaseMappedPartition $mapped $disk $partition 'Z' $true; $cases++
Reject { Assert-DatabaseMappedPartition $mapped $disk $partition 'Y' $true }
$info=@{network='mainnet';appVersion='6.0.5';stateType='utxo';isMining=$false;stateVersion=('a'*64);bestFullHeaderId=('a'*64);bestHeaderId=('b'*64);
    stateRoot=('c'*66);fullHeight=100;headersHeight=200;genesisBlockId='b0244dfc267baca974a4caee06120321562784303a8a688976ae56170e4d175b'}
$header=@{id=('a'*64);height=100;stateRoot=('c'*66)}
$tip=Get-SyncTipEvidence $info $header $info
if ($tip.status -cne 'historical-applied-tip-correlated' -or -not $tip.headersAhead -or -not $tip.stableAppliedView -or $tip.applicationLogMatch) { throw 'Partial applied evidence interpretation changed' }; $cases++
$later=$info.Clone(); $later.stateVersion=('d'*64); $later.bestFullHeaderId=('d'*64); $later.fullHeight=101
if ((Get-SyncTipEvidence $info $header $later).stableAppliedView) { throw 'Changing view accepted as stable' }; $cases++
$bad=$header.Clone(); $bad.id=('e'*64)
if ((Get-SyncTipEvidence $info $bad $info).status -cne 'no-correlated-applied-tip') { throw 'Wrong header correlation accepted' }; $cases++
foreach ($mutation in @(@('isMining',$true),@('network','testnet'),@('appVersion','wrong'),@('stateRoot','bad'),@('fullHeight',1.5),@('genesisBlockId',('0'*64)))) {
    $bad=$info.Clone(); $bad[$mutation[0]]=$mutation[1]; Reject { Assert-SyncNodeInfo $bad }
}
$state=@{finalAttempted=$true;readError=$null;stopDecisionMs=1700000L;emptyConfirmedMs=1700050L;finalSampleStartedMs=1700051L;finalSampleFinishedMs=1700052L}
$budget=@{AccountingValid=$true;StopReason='traffic-threshold';TotalBytes=8589934593UL}
Assert-VolumeNodeTraffic $state $budget $true; $cases++
Reject { Assert-VolumeNodeTraffic $state $budget }
$bad=$budget.Clone(); $bad.TotalBytes=10737418241UL; Reject { Assert-VolumeNodeTraffic $state $bad $true }
$bad=$budget.Clone(); $bad.StopReason='sample-gap'; Reject { Assert-VolumeNodeTraffic $state $bad $true }
"Sync profile checks passed ($cases cases; no disk, worker or network)."
