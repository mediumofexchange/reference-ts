# Synthetic provider observations and in-memory ACLs; no disk/ACL/encryption edits.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/device-storage.ps1"
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows test required' }
$cases = 0
$holder = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sentinel = 'PRIVATE-DEVICE-OBSERVATION-DO-NOT-LOG'
$savedTemp = $env:TEMP
$savedTmp = $env:TMP

function Assert-Check([bool]$Value, [string]$Message) {
    if (-not $Value) { throw $Message }
    $script:cases++
}
function Make-Acl([bool]$Directory = $true, [string]$Principal = $holder) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $sid = [Security.Principal.SecurityIdentifier]::new($Principal)
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = if ($Directory) { 'ContainerInherit, ObjectInherit' } else { 'None' }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inheritance, 'None', 'Allow'))
    return $acl
}
function Reset-Observation {
    $script:state = @{
        system = @{ SystemDrive = 'C:' }
        disk = @{ DeviceID = 'C:'; DriveType = 3; FileSystem = 'NTFS' }
        volume = @{ DriveLetter = 'C:' }
        GetConversionStatus = @{ ReturnValue = 0; ConversionStatus = 1; EncryptionPercentage = 100; EncryptionFlags = 0 }
        GetProtectionStatus = @{ ReturnValue = 0; ProtectionStatus = 1 }
        GetEncryptionMethod = @{ ReturnValue = 0; EncryptionMethod = 7 }
        GetKeyProtectors = @{ ReturnValue = 0; VolumeKeyProtectorID = @('{11111111-1111-1111-1111-111111111111}', '{22222222-2222-2222-2222-222222222222}') }
        types = @(4, 3)
        secureBoot = $true
        acl = (Make-Acl)
        fileAcl = (Make-Acl $false)
        entries = @('wallet.db', 'wallet.db-wal', 'wallet.db-shm', 'wallet.db-journal', 'profile.json')
        linked = ''; nested = $false; linkedFile = $false; throwAt = ''; malformedReturn = $false
        container = $true; pathAttributes = [IO.FileAttributes]::Directory; entryName = ''
    }
    $script:methods = [Collections.Generic.List[string]]::new()
    $script:aclReads = [Collections.Generic.List[string]]::new()
    $env:TEMP = 'C:\Temp'; $env:TMP = 'C:\Temp'
}
function Get-Item {
    [CmdletBinding()]param($LiteralPath, [switch]$Force)
    if ($state.throwAt -eq 'path') { throw $sentinel }
    $attributes = $state.pathAttributes
    if ($LiteralPath -eq $state.linked) { $attributes = $attributes -bor [IO.FileAttributes]::ReparsePoint }
    [pscustomobject]@{ PSIsContainer = $state.container; Attributes = $attributes }
}
function Get-Acl {
    [CmdletBinding()]param($LiteralPath)
    $aclReads.Add($LiteralPath)
    if ($state.throwAt -eq 'acl') { throw $sentinel }
    if ($LiteralPath -eq 'C:\Wallet') { return $state.acl }
    return $state.fileAcl
}
function Get-ChildItem {
    [CmdletBinding()]param($LiteralPath, [switch]$Force)
    if (-not $Force) { throw 'hidden files omitted' }
    if ($state.throwAt -eq 'entries') { throw $sentinel }
    foreach ($entry in $state.entries) {
        [pscustomobject]@{ FullName = $(if ($state.entryName) { $state.entryName } else { "C:\Wallet\$entry" }); PSIsContainer = $state.nested;
            Attributes = $(if ($state.linkedFile) { [IO.FileAttributes]::ReparsePoint } else { [IO.FileAttributes]::Normal }) }
    }
}
function Get-CimInstance {
    [CmdletBinding()]param($ClassName, $Property, $Filter, $Namespace, $OperationTimeoutSec)
    if ($state.throwAt -eq $ClassName) { throw $sentinel }
    switch ($ClassName) {
        'Win32_OperatingSystem' { return $state.system }
        'Win32_LogicalDisk' { return $state.disk }
        'Win32_EncryptableVolume' { return $state.volume }
        default { throw 'unexpected provider' }
    }
}
function Invoke-CimMethod {
    [CmdletBinding()]param($InputObject, $MethodName, $Arguments, $OperationTimeoutSec)
    $methods.Add($MethodName)
    if ($state.throwAt -eq $MethodName) { throw $sentinel }
    if ($MethodName -eq 'GetKeyProtectorType') {
        $index = [array]::IndexOf($state.GetKeyProtectors.VolumeKeyProtectorID, $Arguments.VolumeKeyProtectorID)
        return @{ ReturnValue = $(if ($state.malformedReturn) { $null } else { 0 }); KeyProtectorType = $state.types[$index] }
    }
    if (-not $state.ContainsKey($MethodName)) { throw 'unexpected method' }
    return $state[$MethodName]
}
function Confirm-SecureBootUEFI {
    [CmdletBinding()]param()
    if ($state.throwAt -eq 'boot') { throw $sentinel }
    return $state.secureBoot
}
function Check-Report([string]$Expected = 'pass', [string]$Id = '') {
    $report = Get-DeviceStorageReport 'C:\Wallet'
    Assert-Check ($report.automaticChecks -eq $Expected) "unexpected aggregate: $($report.automaticChecks), expected $Expected ($Id)"
    Assert-Check ($report.qualified -ceq $false) 'partial observation qualified a device'
    if ($Id) { Assert-Check (@($report.checks | Where-Object { $_.id -eq $Id -and $_.status -ne 'pass' }).Count -eq 1) "missed refusal $Id" }
    $json = $report | ConvertTo-Json -Depth 5 -Compress
    Assert-Check (-not $json.Contains($sentinel) -and -not $json.Contains($holder) -and -not $json.Contains('11111111') -and -not $json.Contains('wallet.db')) 'private observation leaked'
}

try {
    Reset-Observation
    Check-Report
    Assert-Check ($aclReads.Count -eq 6 -and $aclReads.Contains('C:\Wallet\wallet.db-wal') -and $aclReads.Contains('C:\Wallet\wallet.db-journal')) 'sidecar ACL omitted'
    Assert-Check (@($methods | Where-Object { $_ -notin @('GetConversionStatus', 'GetProtectionStatus', 'GetEncryptionMethod', 'GetKeyProtectors', 'GetKeyProtectorType') }).Count -eq 0) 'unexpected key retrieval'
    foreach ($path in @('C:\Wallet', 'C:\Wallet\')) { Assert-Check (Test-DeviceLiteralPath $path) 'valid path refused' }
    foreach ($path in @('', 'C:\', 'Wallet', '\\host\share', '\\?\C:\Wallet', 'C:\Wallet:stream', 'C:\Wallet\..\Other', 'C:\Wallet.', 'C:\Wallet ', 'C:\NUL', 'C:\Wallet\CON.txt', 'C:\*', 'C:\Wallet\\Child', 'C:\Wallet/Child', "C:\Wallet`nChild")) {
        Assert-Check (-not (Test-DeviceLiteralPath $path)) 'unsafe path accepted'
    }
    foreach ($bad in @($null, $true, '1', @(1, 2), -1, 4294967296L, 1.0)) {
        $refused = $false
        try { $null = Get-DeviceUInt $bad } catch { $refused = $true }
        Assert-Check $refused 'malformed numeric observation accepted'
    }
    Assert-Check (-not (Test-DeviceLiteralPath "C:\Wallet`n")) 'trailing newline path accepted'
    foreach ($mutation in @(
        @('GetConversionStatus', 'ConversionStatus', 2), @('GetConversionStatus', 'EncryptionPercentage', 99),
        @('GetConversionStatus', 'EncryptionFlags', 1), @('GetProtectionStatus', 'ProtectionStatus', 0),
        @('GetProtectionStatus', 'ProtectionStatus', 2), @('GetEncryptionMethod', 'EncryptionMethod', 5))) {
        Reset-Observation; $state[$mutation[0]][$mutation[1]] = $mutation[2]; Check-Report 'fail' 'bitlocker-protection'
    }
    foreach ($method in @('GetConversionStatus', 'GetProtectionStatus', 'GetEncryptionMethod', 'GetKeyProtectors')) {
        Reset-Observation; $state[$method].ReturnValue = 5; Check-Report 'unknown'
        Reset-Observation; $state[$method].ReturnValue = $null; Check-Report 'unknown'
    }
    foreach ($provider in @('Win32_OperatingSystem', 'Win32_LogicalDisk', 'Win32_EncryptableVolume', 'GetConversionStatus',
        'GetProtectionStatus', 'GetEncryptionMethod', 'GetKeyProtectors', 'GetKeyProtectorType', 'path', 'acl', 'entries', 'boot')) {
        Reset-Observation; $state.throwAt = $provider; Check-Report 'unknown'
    }
    Reset-Observation; $state.GetConversionStatus.ConversionStatus = '1'; Check-Report 'unknown' 'bitlocker-protection'
    Reset-Observation; $state.malformedReturn = $true; Check-Report 'unknown' 'pin-protector-types'
    foreach ($type in @(0, 1, 2, 5, 6, 7, 8, 9, 10)) {
        Reset-Observation; $state.types = @(4, $type); Check-Report 'fail' 'pin-protector-types'
    }
    Reset-Observation; $state.types = @(3, 3); Check-Report 'fail' 'pin-protector-types'
    Reset-Observation; $state.GetKeyProtectors.VolumeKeyProtectorID = @(); Check-Report 'fail' 'pin-protector-types'
    Reset-Observation; $state.GetKeyProtectors.VolumeKeyProtectorID = @('bad'); Check-Report 'unknown' 'pin-protector-types'
    Reset-Observation; $state.GetKeyProtectors.VolumeKeyProtectorID = @('{------------------------------------}'); Check-Report 'unknown' 'pin-protector-types'
    Reset-Observation; $state.GetKeyProtectors.VolumeKeyProtectorID = @("{11111111-1111-1111-1111-111111111111}`n"); Check-Report 'unknown' 'pin-protector-types'
    Reset-Observation; $state.GetKeyProtectors.VolumeKeyProtectorID = @($state.GetKeyProtectors.VolumeKeyProtectorID[0]) * 2; Check-Report 'unknown' 'pin-protector-types'
    Reset-Observation; $state.GetKeyProtectors.VolumeKeyProtectorID = @('x') * 9; Check-Report 'fail' 'pin-protector-types'
    Reset-Observation; $state.system.SystemDrive = 'D:'; Check-Report 'fail' 'os-volume'
    Reset-Observation; $state.disk.FileSystem = 'FAT32'; Check-Report 'fail' 'local-ntfs'
    Reset-Observation; $state.disk.DriveType = 4; Check-Report 'fail' 'local-ntfs'
    Reset-Observation; $state.disk.DeviceID = 'D:'; Check-Report 'unknown' 'local-ntfs'
    Reset-Observation; $state.volume.DriveLetter = 'D:'; Check-Report 'unknown' 'bitlocker-protection'
    foreach ($mutation in @(@('system', 'SystemDrive', 'C:'), @('disk', 'DeviceID', 'C:'),
        @('disk', 'FileSystem', 'NTFS'), @('volume', 'DriveLetter', 'C:'))) {
        Reset-Observation; $state[$mutation[0]][$mutation[1]] = @($mutation[2]); Check-Report 'unknown'
        Reset-Observation; $state[$mutation[0]][$mutation[1]] = @($mutation[2], 'BAD'); Check-Report 'unknown'
    }
    Reset-Observation; $state.container = 'false'; Check-Report 'unknown' 'directory-chain'
    Reset-Observation; $state.pathAttributes = 'Directory'; Check-Report 'unknown' 'directory-chain'
    Reset-Observation; $state.nested = 'false'; Check-Report 'unknown' 'flat-directory-acls'
    Reset-Observation; $state.entryName = 'C:\Other\wallet.db'; Check-Report 'unknown' 'flat-directory-acls'
    Reset-Observation; $state.acl = @{ AreAccessRulesProtected = $true }; Check-Report 'unknown' 'flat-directory-acls'
    Reset-Observation; $state.secureBoot = $false; Check-Report 'fail' 'secure-boot'
    Reset-Observation; $state.secureBoot = 'True'; Check-Report 'unknown' 'secure-boot'
    Reset-Observation; $env:TMP = 'D:\Temp'; Check-Report 'fail' 'temporary-storage'
    Reset-Observation; $env:TEMP = ''; Check-Report 'fail' 'temporary-storage'
    foreach ($path in @('C:\Wallet', 'C:\', 'C:\Temp')) {
        Reset-Observation; $state.linked = $path; Check-Report 'fail'
        if ($path -ne 'C:\Temp') { Assert-Check ($aclReads.Count -eq 0) 'enumerated linked directory' }
    }
    Reset-Observation; $state.entries = @(1..128 | ForEach-Object { "file-$_" }); Check-Report
    Reset-Observation; $state.entries = @(1..129 | ForEach-Object { "file-$_" }); Check-Report 'fail' 'flat-directory-acls'
    Reset-Observation; $state.nested = $true; Check-Report 'fail' 'flat-directory-acls'
    Reset-Observation; $state.linkedFile = $true; Check-Report 'fail' 'flat-directory-acls'
    Reset-Observation; $state.acl.SetAccessRuleProtection($false, $true); Check-Report 'fail' 'flat-directory-acls'
    Reset-Observation; $state.fileAcl = Make-Acl $false 'S-1-1-0'; Check-Report 'fail' 'flat-directory-acls'
    Reset-Observation; $state.acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-1-0')); Check-Report 'fail' 'flat-directory-acls'
    foreach ($kind in @('Allow', 'Deny')) {
        Reset-Observation
        $state.fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', $kind))
        Check-Report 'fail' 'flat-directory-acls'
    }
    Reset-Observation
    $state.acl = Make-Acl $true 'S-1-5-18'; Check-Report 'fail' 'flat-directory-acls'
    $blockedMethod = $false
    try { $null = Read-DeviceVolumeMethod $state.volume 'GetKeyProtectorNumericalPassword' } catch { $blockedMethod = $true }
    Assert-Check $blockedMethod 'recovery-key method admitted'

    # Real isolated CLI, invalid private path: generic report and exact refusal exit.
    $env:TEMP = $savedTemp; $env:TMP = $savedTmp
    $pwsh = (Get-Process -Id $PID).Path
    $cliOutput = & $pwsh -NoProfile -File "$PSScriptRoot/device-preflight.ps1" -Directory "C:\${sentinel}:stream" 2>&1
    Assert-Check ($LASTEXITCODE -eq 2) 'CLI refusal exit changed'
    Assert-Check (-not ($cliOutput -join "`n").Contains($sentinel)) 'CLI leaked private path'
    $cliReport = ($cliOutput -join "`n") | ConvertFrom-Json
    Assert-Check ($cliReport.qualified -ceq $false -and $cliReport.automaticChecks -eq 'fail') 'CLI refusal report changed'
} finally { $env:TEMP = $savedTemp; $env:TMP = $savedTmp }
Write-Output "Device storage checks passed ($cases assertions; synthetic providers, in-memory ACLs; no device changes)."
