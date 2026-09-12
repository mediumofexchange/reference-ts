# Read-only observations. Never open wallet contents or serialize native objects.
Set-StrictMode -Version Latest

function Test-DeviceLiteralPath {
    param([string]$Path)
    if ($Path -notmatch '\A[A-Za-z]:\\[^:<>"|?*/\x00-\x1f]+\z') { return $false }
    $parts = $Path.Substring(3).TrimEnd('\').Split('\')
    foreach ($part in $parts) {
        if ([string]::IsNullOrWhiteSpace($part) -or $part -match '[. ]$' -or
            $part -match '^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)') { return $false }
    }
    return $true
}

function Test-DevicePathChain {
    param([string]$Path)
    $cursor = $Path
    for ($depth = 0; $depth -lt 128; $depth++) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if ($item.PSIsContainer -isnot [bool] -or $item.Attributes -isnot [IO.FileAttributes]) { throw 'invalid path observation' }
        if (-not $item.PSIsContainer -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
        $parent = [IO.Path]::GetDirectoryName($cursor.TrimEnd('\'))
        if ([string]::IsNullOrEmpty($parent)) { return $true }
        if ($parent -match '^[A-Za-z]:$') { $parent += '\' }
        $cursor = $parent
    }
    return $false
}

function Test-DeviceAcl {
    param($Acl, [string]$HolderSid, [bool]$Directory)
    if ($Acl -isnot [Security.AccessControl.FileSystemSecurity]) { throw 'invalid ACL observation' }
    $allowed = @($HolderSid, 'S-1-5-18', 'S-1-5-32-544')
    if ($Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { return $false }
    if ($Directory -and -not $Acl.AreAccessRulesProtected) { return $false }
    $rules = @($Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -eq 0) { return $false }
    $holderAccess = $false
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Value
        if ($sid -notin $allowed -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { return $false }
        if ($sid -eq $HolderSid -and
            ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl -and
            $rule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None) {
            $both = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
            if (-not $Directory -or ($rule.InheritanceFlags -band $both) -eq $both) { $holderAccess = $true }
        }
    }
    return $holderAccess
}

function Get-DeviceUInt {
    param($Value)
    if ($null -eq $Value -or $Value.GetType() -notin @([byte], [uint16], [uint32], [uint64], [int16], [int32], [int64]) -or
        $Value -lt 0 -or $Value -gt [uint32]::MaxValue) { throw 'invalid numeric observation' }
    return [uint32]$Value
}

function Read-DeviceVolumeMethod {
    param($Volume, [string]$Method, [hashtable]$Arguments = @{})
    if ($Method -notin @('GetConversionStatus', 'GetProtectionStatus', 'GetEncryptionMethod', 'GetKeyProtectors', 'GetKeyProtectorType')) {
        throw 'unsupported observation'
    }
    $result = Invoke-CimMethod -InputObject $Volume -MethodName $Method -Arguments $Arguments -OperationTimeoutSec 5 -ErrorAction Stop
    if ((Get-DeviceUInt $result.ReturnValue) -ne 0) { throw 'unavailable observation' }
    return $result
}

function New-DeviceStorageReport {
    param([object[]]$Checks)
    $overall = 'pass'
    if (@($Checks | Where-Object { $_.status -eq 'unknown' }).Count -gt 0) { $overall = 'unknown' }
    if (@($Checks | Where-Object { $_.status -eq 'fail' }).Count -gt 0) { $overall = 'fail' }
    [pscustomobject][ordered]@{
        schema = 'moe/wallet-device-preflight/1'
        automaticChecks = $overall
        qualified = $false
        checks = @($Checks)
        outstanding = @('ancestor-access-and-hardlinks', 'physical-storage-and-standard-account',
            'pin-startup-and-network-unlock', 'paging-dumps-and-backup-exclusions',
            'trusted-software-and-secret-entry', 'recovery-material-and-single-active-copy',
            'target-power-loss-and-handoff-drills')
    }
}

function Get-DeviceStorageReport {
    param([string]$Directory)
    $checks = [Collections.Generic.List[object]]::new()
    # Scriptblocks return only bool; errors become a fixed unknown observation.
    function Observe([string]$Id, [scriptblock]$Read) {
        $status = 'unknown'
        try {
            $value = & $Read
            if ($value -is [bool]) { $status = if ($value) { 'pass' } else { 'fail' } }
        } catch { $status = 'unknown' }
        $checks.Add([pscustomobject]@{ id = $Id; status = $status })
    }
    Observe 'windows' { [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT }
    Observe 'literal-directory' { Test-DeviceLiteralPath $Directory }
    if ($checks[0].status -ne 'pass' -or $checks[1].status -ne 'pass') {
        return New-DeviceStorageReport $checks.ToArray()
    }
    $Directory = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
    $drive = [IO.Path]::GetPathRoot($Directory).TrimEnd('\')
    Observe 'directory-chain' { Test-DevicePathChain $Directory }
    $osDrive = $null
    try {
        $systems = @(Get-CimInstance -ClassName Win32_OperatingSystem -Property SystemDrive -OperationTimeoutSec 5 -ErrorAction Stop)
        if ($systems.Count -eq 1 -and $systems[0].SystemDrive -is [string] -and $systems[0].SystemDrive -match '\A[A-Za-z]:\z') { $osDrive = $systems[0].SystemDrive }
    } catch { }
    Observe 'os-volume' { if ($null -eq $osDrive) { throw 'unavailable' }; $drive -eq $osDrive }
    Observe 'local-ntfs' {
        $volumes = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$drive'" -OperationTimeoutSec 5 -ErrorAction Stop)
        if ($volumes.Count -ne 1 -or $volumes[0].DeviceID -isnot [string] -or $volumes[0].DeviceID -ne $drive -or
            $volumes[0].FileSystem -isnot [string]) { throw 'unavailable' }
        (Get-DeviceUInt $volumes[0].DriveType) -eq 3 -and $volumes[0].FileSystem -ceq 'NTFS'
    }
    $volume = $null
    try {
        $found = @(Get-CimInstance -Namespace 'root/CIMV2/Security/MicrosoftVolumeEncryption' -ClassName Win32_EncryptableVolume -Filter "DriveLetter='$drive'" -OperationTimeoutSec 5 -ErrorAction Stop)
        if ($found.Count -eq 1 -and $found[0].DriveLetter -is [string] -and $found[0].DriveLetter -eq $drive) { $volume = $found[0] }
    } catch { }
    Observe 'bitlocker-protection' {
        if ($null -eq $volume) { throw 'unavailable' }
        $conversion = Read-DeviceVolumeMethod $volume 'GetConversionStatus' @{ PrecisionFactor = [uint32]0 }
        $protection = Read-DeviceVolumeMethod $volume 'GetProtectionStatus'
        $method = Read-DeviceVolumeMethod $volume 'GetEncryptionMethod'
        (Get-DeviceUInt $conversion.ConversionStatus) -eq 1 -and
            (Get-DeviceUInt $conversion.EncryptionPercentage) -eq 100 -and
            (Get-DeviceUInt $conversion.EncryptionFlags) -eq 0 -and
            (Get-DeviceUInt $protection.ProtectionStatus) -eq 1 -and
            (Get-DeviceUInt $method.EncryptionMethod) -in @(6, 7)
    }
    Observe 'pin-protector-types' {
        if ($null -eq $volume) { throw 'unavailable' }
        # Get-BitLockerVolume can retrieve recovery passwords. Query only IDs/types
        # through the provider, with no key retrieval method and no IDs in output.
        $protectors = Read-DeviceVolumeMethod $volume 'GetKeyProtectors' @{ KeyProtectorType = [uint32]0 }
        $ids = @($protectors.VolumeKeyProtectorID)
        if ($ids.Count -eq 0 -or $ids.Count -gt 8) { return $false }
        $pin = $false
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($id in $ids) {
            if ($id -isnot [string] -or $id -notmatch '\A\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}\z' -or
                -not $seen.Add($id)) { throw 'invalid identifier observation' }
            $type = Get-DeviceUInt (Read-DeviceVolumeMethod $volume 'GetKeyProtectorType' @{ VolumeKeyProtectorID = $id }).KeyProtectorType
            if ($type -notin @(3, 4)) { return $false }
            if ($type -eq 4) { $pin = $true }
        }
        return $pin
    }
    Observe 'secure-boot' { Confirm-SecureBootUEFI -ErrorAction Stop }
    # Do not enumerate a failed/unknown directory chain, including linked trees.
    Observe 'flat-directory-acls' {
        if ($checks[2].status -ne 'pass') { throw 'unavailable' }
        $holder = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $acl = Get-Acl -LiteralPath $Directory -ErrorAction Stop
        if (-not (Test-DeviceAcl $acl $holder $true)) { return $false }
        $entries = @(Get-ChildItem -LiteralPath $Directory -Force -ErrorAction Stop | Select-Object -First 129)
        if ($entries.Count -gt 128) { return $false }
        foreach ($entry in $entries) {
            if ($entry.PSIsContainer -isnot [bool] -or $entry.Attributes -isnot [IO.FileAttributes] -or
                $entry.FullName -isnot [string] -or -not (Test-DeviceLiteralPath $entry.FullName) -or
                [IO.Path]::GetDirectoryName($entry.FullName) -ne $Directory) { throw 'invalid file observation' }
            if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
            if (-not (Test-DeviceAcl (Get-Acl -LiteralPath $entry.FullName -ErrorAction Stop) $holder $false)) { return $false }
        }
        return $true
    }
    Observe 'temporary-storage' {
        if ($null -eq $osDrive) { throw 'unavailable' }
        foreach ($name in @('TEMP', 'TMP')) {
            $path = [Environment]::GetEnvironmentVariable($name)
            if (-not (Test-DeviceLiteralPath $path)) { return $false }
            if ([IO.Path]::GetPathRoot($path).TrimEnd('\') -ne $osDrive -or
                -not (Test-DevicePathChain $path)) { return $false }
        }
        return $true
    }
    return New-DeviceStorageReport $checks.ToArray()
}
