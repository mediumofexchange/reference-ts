# Pure policy checks plus harmless live drive-namespace reads. This script does
# not create, attach, format, map, unmap, hash live modules, or write storage.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Requires Windows x64 / PowerShell 7' }
Add-Type -Path (Join-Path $PSScriptRoot 'NodeDatabaseIdentity.cs')

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
function New-LetterEvidence([char]$Unused='Z') {
    $items=[Collections.Generic.List[NodeDatabaseIdentity+DriveLetterEvidence]]::new()
    foreach ($code in ([int][char]'D')..([int][char]'Z')) {
        $letter=[char]$code
        if ($letter -eq $Unused) {
            $items.Add([NodeDatabaseIdentity+DriveLetterEvidence]::new($letter,$false,2,[string[]]@()))
        } else {
            $items.Add([NodeDatabaseIdentity+DriveLetterEvidence]::new($letter,$false,0,[string[]]@("\Device\Reserved$letter")))
        }
    }
    return $items.ToArray()
}

Expect-Pass 'highest free letter selected' {
    if ([NodeDatabaseIdentity]::SelectUnusedDriveLetterForTest((New-LetterEvidence 'Y')) -cne 'Y') { throw 'Wrong letter' }
}
Expect-Pass 'DOS reservation counts as occupied without logical bit' {
    $items=New-LetterEvidence 'Y'
    $items[22]=[NodeDatabaseIdentity+DriveLetterEvidence]::new('Z',$false,0,[string[]]@('\Device\ReservedZ'))
    if ([NodeDatabaseIdentity]::SelectUnusedDriveLetterForTest($items) -cne 'Y') { throw 'Reservation ignored' }
}
Expect-Reject 'logical bit without DOS target' {
    $items=New-LetterEvidence 'Z'
    $items[22]=[NodeDatabaseIdentity+DriveLetterEvidence]::new('Z',$true,2,[string[]]@())
    [NodeDatabaseIdentity]::SelectUnusedDriveLetterForTest($items)
}
Expect-Reject 'unexpected QueryDosDevice failure' {
    $items=New-LetterEvidence 'Z'
    $items[22]=[NodeDatabaseIdentity+DriveLetterEvidence]::new('Z',$false,5,[string[]]@())
    [NodeDatabaseIdentity]::SelectUnusedDriveLetterForTest($items)
}
Expect-Reject 'incomplete drive evidence' {
    [NodeDatabaseIdentity]::SelectUnusedDriveLetterForTest((New-LetterEvidence 'Z')[0..21])
}
Expect-Reject 'no ordinary letter free' {
    [NodeDatabaseIdentity]::SelectUnusedDriveLetterForTest((New-LetterEvidence ([char]0)))
}

$volume='\\?\Volume{00112233-4455-6677-8899-aabbccddeeff}\'
$native='\Device\HarddiskVolume42'
Expect-Pass 'matching mapping identity' {
    $record=[NodeDatabaseIdentity]::VerifyDriveMappingForTest('Z',$volume,$volume,
        [string[]]@($native),[string[]]@($native),$false)
    if ($record.DriveRoot -cne 'Z:\' -or $record.NativeTarget -cne $native) { throw 'Changed record' }
}
Expect-Pass 'volume GUID comparison is case insensitive' {
    [void][NodeDatabaseIdentity]::VerifyDriveMappingForTest('z',$volume,$volume.ToUpperInvariant(),
        [string[]]@($native),[string[]]@($native.ToUpperInvariant()),$false)
}
Expect-Reject 'different volume readback' {
    [NodeDatabaseIdentity]::VerifyDriveMappingForTest('Z',$volume,'\\?\Volume{11112233-4455-6677-8899-aabbccddeeff}\',
        [string[]]@($native),[string[]]@($native),$false)
}
Expect-Reject 'different native target' {
    [NodeDatabaseIdentity]::VerifyDriveMappingForTest('Z',$volume,$volume,
        [string[]]@($native),[string[]]@('\Device\HarddiskVolume41'),$false)
}
Expect-Reject 'ambiguous letter target' {
    [NodeDatabaseIdentity]::VerifyDriveMappingForTest('Z',$volume,$volume,
        [string[]]@($native,'\Device\Shadow'),[string[]]@($native),$false)
}
Expect-Reject 'reparse drive root' {
    [NodeDatabaseIdentity]::VerifyDriveMappingForTest('Z',$volume,$volume,
        [string[]]@($native),[string[]]@($native),$true)
}
Expect-Pass 'mapping absent in both views' {
    [NodeDatabaseIdentity]::VerifyDriveLetterAbsentForTest('Z',0,2,[string[]]@())
}
Expect-Reject 'logical mapping remains' {
    [NodeDatabaseIdentity]::VerifyDriveLetterAbsentForTest('Z',(1U -shl 25),2,[string[]]@())
}
Expect-Reject 'DOS reservation remains' {
    [NodeDatabaseIdentity]::VerifyDriveLetterAbsentForTest('Z',0,0,[string[]]@($native))
}

$run='C:\identity-fixture\run'
$bundle='C:\identity-fixture\bundle'
$rocks="$run\tmp\rocksdbjni.dll"
$hashA='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$hashB='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
$hashC='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
$manifest=@{ 'jre/bin/java.exe'=$hashA; 'jre/bin/server/jvm.dll'=$hashB }
function New-ModuleFixture {
    [NodeDatabaseIdentity+ModuleRecord[]]@(
        [NodeDatabaseIdentity+ModuleRecord]::new("$bundle\jre\bin\java.exe",$hashA,1024),
        [NodeDatabaseIdentity+ModuleRecord]::new("$bundle\jre\bin\server\jvm.dll",$hashB,2048),
        [NodeDatabaseIdentity+ModuleRecord]::new($rocks,$hashC,4096),
        [NodeDatabaseIdentity+ModuleRecord]::new((Join-Path ([Environment]::SystemDirectory) 'kernel32.dll'),$hashA,8192)
    )
}
function New-ModuleFixtureWith([NodeDatabaseIdentity+ModuleRecord]$Extra) {
    $items=[Collections.Generic.List[NodeDatabaseIdentity+ModuleRecord]]::new()
    foreach ($item in (New-ModuleFixture)) { $items.Add($item) }
    $items.Add($Extra)
    return $items.ToArray()
}
Expect-Pass 'pinned module policy' {
    $records=[NodeDatabaseIdentity]::VerifyModulePolicyForTest((New-ModuleFixture),$run,$bundle,$rocks,$hashC,$manifest)
    if ($records.Count -ne 4 -or $records[0].Classification -cne 'bundle-pinned' -or
        $records[2].Classification -cne 'rocksdb-pinned' -or $records[3].Classification -cne 'system-observed') {
        throw 'Wrong module classification'
    }
}
Expect-Reject 'wrong RocksDB hash' {
    $modules=New-ModuleFixture
    $modules[2]=[NodeDatabaseIdentity+ModuleRecord]::new($rocks,$hashA,4096)
    [NodeDatabaseIdentity]::VerifyModulePolicyForTest($modules,$run,$bundle,$rocks,$hashC,$manifest)
}
Expect-Reject 'missing RocksDB DLL' {
    $modules=New-ModuleFixture
    [NodeDatabaseIdentity]::VerifyModulePolicyForTest($modules[0..1],$run,$bundle,$rocks,$hashC,$manifest)
}
Expect-Reject 'duplicate RocksDB DLL' {
    $modules=New-ModuleFixtureWith ([NodeDatabaseIdentity+ModuleRecord]::new($rocks,$hashC,4096))
    [NodeDatabaseIdentity]::VerifyModulePolicyForTest($modules,$run,$bundle,$rocks,$hashC,$manifest)
}
Expect-Reject 'unexpected compression DLL in run root' {
    $modules=New-ModuleFixtureWith ([NodeDatabaseIdentity+ModuleRecord]::new("$run\tmp\snappy.dll",$hashA,1024))
    [NodeDatabaseIdentity]::VerifyModulePolicyForTest($modules,$run,$bundle,$rocks,$hashC,$manifest)
}
Expect-Reject 'unpinned bundle DLL' {
    $modules=New-ModuleFixtureWith ([NodeDatabaseIdentity+ModuleRecord]::new("$bundle\jre\bin\lz4.dll",$hashA,1024))
    [NodeDatabaseIdentity]::VerifyModulePolicyForTest($modules,$run,$bundle,$rocks,$hashC,$manifest)
}
foreach ($libraryFile in @('snappy.dll','libsnappy.dll','z.dll','libz.dll','zlib.dll','libzlib.dll',
    'bzip2.dll','libbzip2.dll','bz2.dll','libbz2.dll','lz4.dll','liblz4.dll','lz4hc.dll','liblz4hc.dll',
    'xpress.dll','libxpress.dll','zstd.dll','libzstd.dll','rocksdbjni.dll','librocksdbjni-other.dll')) {
    $forbiddenSystemPath=Join-Path ([Environment]::SystemDirectory) $libraryFile
    Expect-Reject "system native library is not implicitly trusted: $libraryFile" {
        $modules=New-ModuleFixtureWith ([NodeDatabaseIdentity+ModuleRecord]::new(
            $forbiddenSystemPath,$hashA,1024))
        [NodeDatabaseIdentity]::VerifyModulePolicyForTest($modules,$run,$bundle,$rocks,$hashC,$manifest)
    }
}
Expect-Pass 'manifest-pinned compression DLL is admitted' {
    $pinnedManifest=@{ 'jre/bin/java.exe'=$hashA; 'jre/bin/server/jvm.dll'=$hashB; 'jre/bin/zstd.dll'=$hashA }
    $modules=New-ModuleFixtureWith ([NodeDatabaseIdentity+ModuleRecord]::new(
        "$bundle\jre\bin\zstd.dll",$hashA,1024))
    [void][NodeDatabaseIdentity]::VerifyModulePolicyForTest($modules,$run,$bundle,$rocks,$hashC,$pinnedManifest)
}
Expect-Reject 'pinned module changed' {
    $modules=New-ModuleFixture
    $modules[0]=[NodeDatabaseIdentity+ModuleRecord]::new("$bundle\jre\bin\java.exe",$hashB,1024)
    [NodeDatabaseIdentity]::VerifyModulePolicyForTest($modules,$run,$bundle,$rocks,$hashC,$manifest)
}
Expect-Reject 'module hash byte budget exceeded' {
    $modules=New-ModuleFixture
    $modules[0]=[NodeDatabaseIdentity+ModuleRecord]::new("$bundle\jre\bin\java.exe",$hashA,134217729)
    [NodeDatabaseIdentity]::VerifyModulePolicyForTest($modules,$run,$bundle,$rocks,$hashC,$manifest)
}
$component='C:\WINDOWS\WinSxS\amd64_microsoft.windows.common-controls_6595b64144ccf1df_6.0.19041.6456_none_60b8a6cb71f64256\COMCTL32.dll'
$componentHash='4f3c45946d2e04915691d93b0606bdea1ebf60d89b884a42cbe226e65a03ea56'
Expect-Pass 'exact reviewed Common Controls component' {
    $modules=New-ModuleFixtureWith ([NodeDatabaseIdentity+ModuleRecord]::new($component,$componentHash,2715536L))
    $verified=[NodeDatabaseIdentity]::VerifyModulePolicyForTest($modules,$run,$bundle,$rocks,$hashC,$manifest)
    if ($verified[-1].Classification -cne 'system-component-pinned') { throw 'Missing exact component classification' }
}
foreach($length in @(0L,2715535L,2715537L)) {
    Expect-Reject 'Common Controls wrong length' {
        $modules=New-ModuleFixtureWith ([NodeDatabaseIdentity+ModuleRecord]::new($component,$componentHash,$length))
        [NodeDatabaseIdentity]::VerifyModulePolicyForTest($modules,$run,$bundle,$rocks,$hashC,$manifest)
    }
}
Expect-Reject 'Common Controls wrong hash' {
    $modules=New-ModuleFixtureWith ([NodeDatabaseIdentity+ModuleRecord]::new($component,$hashA,2715536L))
    [NodeDatabaseIdentity]::VerifyModulePolicyForTest($modules,$run,$bundle,$rocks,$hashC,$manifest)
}
Expect-Reject 'duplicate Common Controls entry' {
    $modules=New-ModuleFixtureWith ([NodeDatabaseIdentity+ModuleRecord]::new($component,$componentHash,2715536L))
    $modules+=[NodeDatabaseIdentity+ModuleRecord]::new($component,$componentHash,2715536L)
    [NodeDatabaseIdentity]::VerifyModulePolicyForTest($modules,$run,$bundle,$rocks,$hashC,$manifest)
}
foreach($wrongPath in @($component.Replace('amd64_','x86_'),$component.Replace('6.0.19041.6456','6.0.19041.9999'),
    $component.Replace('C:\','D:\'),$component.Replace('COMCTL32.dll','other.dll'),$component.Replace('WinSxS','WinSxS-copy'),
    'C:\unreviewed\COMCTL32.dll')) {
    Expect-Reject 'same bytes at an unreviewed component path' {
        $modules=New-ModuleFixtureWith ([NodeDatabaseIdentity+ModuleRecord]::new($wrongPath,$componentHash,2715536L))
        [NodeDatabaseIdentity]::VerifyModulePolicyForTest($modules,$run,$bundle,$rocks,$hashC,$manifest)
    }
}
Expect-Reject 'module count budget exceeded' {
    $modules=[Collections.Generic.List[NodeDatabaseIdentity+ModuleRecord]]::new()
    1..257 | ForEach-Object { $modules.Add([NodeDatabaseIdentity+ModuleRecord]::new(
        (Join-Path ([Environment]::SystemDirectory) ("ordinary$_.dll")),$hashA,0)) }
    [NodeDatabaseIdentity]::VerifyModulePolicyForTest($modules.ToArray(),$run,$bundle,$rocks,$hashC,$manifest)
}
Expect-Reject 'manifest traversal' {
    [NodeDatabaseIdentity]::VerifyModulePolicyForTest((New-ModuleFixture),$run,$bundle,$rocks,$hashC,
        @{ '../outside.dll'=$hashA })
}

# Harmless live namespace lookup: select one presently absent ordinary letter,
# then verify both read-only Windows views still report it absent.
$selected=[NodeDatabaseIdentity]::SelectUnusedDriveLetter()
[NodeDatabaseIdentity]::VerifyDriveLetterAbsent($selected)
"node database identity tests passed ($script:Cases cases; live unused letter $selected verified without mutation)"
