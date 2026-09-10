# Pure guards for the fixed, trusted-host 64 MiB disk control. No storage writes.
Set-StrictMode -Version Latest
function Assert-ProbeDiskIdentity($Image, $Disk, [string]$ImagePath, [string]$PhysicalPath, [string]$Style) {
    if ($PhysicalPath -cnotmatch '^\\\\\.\\PhysicalDrive(0|[1-9][0-9]*)\z') { throw 'Malformed physical disk path' }
    $number = [uint32]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture)
    # Storage's type data projects BusType to a display string (for example
    # "File Backed Virtual"). Use the underlying MSFT_Disk UInt16 instead.
    $busType = $Disk.CimInstanceProperties['BusType'].Value
    if ($Image.Attached -isnot [bool] -or -not $Image.Attached -or
        $Image.ImagePath -ine $ImagePath -or $Image.DevicePath -ine $PhysicalPath -or
        $Disk.Number -ne $number -or $Disk.Size -ne 67108864UL -or
        $busType -isnot [uint16] -or $busType -ne 15 -or $Disk.PartitionStyle.ToString() -cne $Style -or
        $Disk.IsBoot -isnot [bool] -or $Disk.IsBoot -or
        $Disk.IsSystem -isnot [bool] -or $Disk.IsSystem -or
        $Disk.IsOffline -isnot [bool] -or $Disk.IsOffline -or
        $Disk.IsReadOnly -isnot [bool] -or $Disk.IsReadOnly -or
        [string]::IsNullOrWhiteSpace($Disk.Path) -or [string]::IsNullOrWhiteSpace($Disk.UniqueId)) {
        throw 'Created image / attached disk identity or state mismatch'
    }
    if ($Style -eq 'RAW' -and $Disk.NumberOfPartitions -ne 0) { throw 'New disk is not empty' }
}
function Assert-ProbePartition($Partition, $Disk, $Expected) {
    if ($Partition.DiskNumber -ne $Disk.Number -or
        $Partition.GptType -ine '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}' -or
        $Partition.IsBoot -isnot [bool] -or $Partition.IsBoot -or
        $Partition.IsSystem -isnot [bool] -or $Partition.IsSystem -or
        $Partition.IsReadOnly -isnot [bool] -or $Partition.IsReadOnly -or
        $Partition.IsOffline -isnot [bool] -or $Partition.IsOffline -or
        ($Partition.DriveLetter -and [int][char]$Partition.DriveLetter -ne 0) -or
        $Partition.Offset -lt 1048576UL -or $Partition.Offset -ge 67108864UL -or $Partition.Size -le 0 -or
        $Partition.Size -gt 67108864UL - $Partition.Offset -or
        [string]::IsNullOrWhiteSpace($Partition.Guid)) { throw 'Unexpected new data partition' }
    if ($null -ne $Expected -and ($Partition.Guid -ine $Expected.Guid -or
        $Partition.PartitionNumber -ne $Expected.PartitionNumber -or
        $Partition.Offset -ne $Expected.Offset -or $Partition.Size -ne $Expected.Size)) {
        throw 'Data partition changed before mutation'
    }
}
function Assert-ProbeDiskCompletion($Process, $Fill, $Volume, [bool]$Detached, [long]$FileBytes,
    [long]$HostFreeBefore, [long]$HostFreeAfter) {
    if (-not $Process.LimitsReadBackBeforeResume -or -not $Process.JobEmptyAfterCleanup -or
        $Process.LaunchMode -cne 'inherited-console' -or $Process.CreationFlags -ne 525316 -or
        -not $Process.ParentConsoleVerified -or $Process.TotalProcesses -ne 1 -or
        $Process.Outcome -cne 'exited' -or $Process.ExitCode -ne 0 -or
        $Process.CommitLimitBytes -ne 536870912UL -or
        $Process.PeakCommitBytes -gt 536870912UL -or
        $Process.PeakProcessCommitBytes -gt 536870912UL -or
        $Process.SampledPeakPrivateCommitBytes -gt 536870912UL -or
        $Process.CpuRateFlags -ne 5 -or $Process.CpuRatePer10000 -ne 2500 -or
        $Process.BeforeResumeActiveProcesses -ne 1 -or $Process.MaxSampledAssociatedProcesses -ne 1 -or
        $Process.ElapsedMs -gt 30000 -or $Process.CapturedOutputBytes -gt 65536) { throw 'Disk worker process evidence unresolved' }
    if ($Fill.Status -cne 'disk-full' -or $Fill.NativeError -ne 112 -or
        $Fill.BytesWritten -le 0 -or $Fill.BytesWritten -gt 67108864UL -or
        $Fill.AttemptedBytes -le $Fill.BytesWritten -or $Fill.AttemptedBytes -gt 68157440UL -or
        $Volume.FileSystem -cne 'NTFS' -or $Volume.Size -le 0 -or $Volume.Size -gt 67108864UL -or
        $Volume.SizeRemaining -lt 0 -or $Volume.SizeRemaining -ge 1048576UL -or
        -not $Detached -or $FileBytes -lt 67108864L -or $FileBytes -gt 68157440L -or
        $HostFreeBefore -lt 107442339840L -or $HostFreeAfter -lt 107374182400L) {
        throw 'Disk-full, capacity, host reserve or detach evidence unresolved'
    }
}
