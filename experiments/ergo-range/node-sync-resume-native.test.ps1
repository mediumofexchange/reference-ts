# Pure/header and synthetic path checks. Optional retained read is exactly 1 KiB.
# Never calls OpenVirtualDisk, attaches a disk, creates a VHD or launches Java.
param([string]$RetainedImagePath)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not ('NodeProbeDisk' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeDisk.cs') }
$scratch=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../scratch'))
$root=Join-Path $scratch ('sync-resume-native-test-'+[Guid]::NewGuid().ToString('N'))
$suffix='scratch\node-source-sync\f2dc2b779ba7441eba7528b01928476d\control.vhd'
$image=Join-Path $root $suffix
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($image))
$cases=0
function Check([bool]$Condition,[string]$Label) { if(-not $Condition){throw $Label};$script:cases++ }
function Refuses([scriptblock]$Action,[string]$Label) {
    $refused=$false;try { & $Action | Out-Null } catch { $refused=$true }
    Check $refused $Label
}
try {
    [NodeProbeDisk]::ValidateNativeLayoutForTest();$cases++
    $flags=[Reflection.BindingFlags]'NonPublic,Static'
    $parameterType=[NodeProbeDisk].GetNestedType('OpenVirtualDiskParametersV1',[Reflection.BindingFlags]::NonPublic)
    Check ($null -ne $parameterType) 'Missing open ABI'
    Check ([Runtime.InteropServices.Marshal]::SizeOf([Activator]::CreateInstance($parameterType)) -eq 8) 'Wrong version-1 prefix size'
    Check ([Runtime.InteropServices.Marshal]::OffsetOf($parameterType,'Version').ToInt32() -eq 0) 'Wrong version offset'
    Check ([Runtime.InteropServices.Marshal]::OffsetOf($parameterType,'RWDepth').ToInt32() -eq 4) 'Wrong RWDepth offset'
    Check ([NodeProbeDisk].GetField('RetainedSyncAccess',$flags).GetRawConstantValue() -eq 0x000E0000) 'Open grants CREATE or misses required access'
    Check ([NodeProbeDisk].GetField('AttachNoDriveLetter',$flags).GetRawConstantValue() -eq 2) 'Attach permits permanent lifetime'
    $nativeOpen=[NodeProbeDisk].GetMethod('OpenVirtualDisk',$flags)
    Check ($nativeOpen.GetParameters().Count -eq 6) 'Wrong OpenVirtualDisk signature'
    Check ($nativeOpen.GetParameters()[4].ParameterType -eq $parameterType.MakeByRefType()) 'Wrong open parameter ABI'
    Check ($nativeOpen.GetParameters()[5].IsOut) 'Native handle must be output'
    $dll=$nativeOpen.GetCustomAttributes([Runtime.InteropServices.DllImportAttribute],$false)[0]
    Check ($dll.Value -ceq 'virtdisk.dll' -and $dll.CharSet -eq [Runtime.InteropServices.CharSet]::Unicode -and $dll.ExactSpelling) 'Wrong native import'

    $header=[byte[]]::new(1024)
    [Text.Encoding]::ASCII.GetBytes('EFI PART').CopyTo($header,512)
    [BitConverter]::GetBytes([uint32]0x10000).CopyTo($header,520)
    [BitConverter]::GetBytes([uint32]92).CopyTo($header,524)
    [BitConverter]::GetBytes([uint64]1).CopyTo($header,536)
    ([Guid]'ad70ec67-79dc-47ab-8d93-8c831533123c').ToByteArray().CopyTo($header,568)
    [NodeProbeDisk]::ValidateRetainedSync20GiBHeader($header,21474836992L);$cases++
    foreach($offset in @(512,520,524,532,536,568,583)) {
        $bad=[byte[]]$header.Clone();$bad[$offset]=$bad[$offset] -bxor 1
        Refuses { [NodeProbeDisk]::ValidateRetainedSync20GiBHeader($bad,21474836992L) } "Changed header byte $offset accepted"
    }
    foreach($length in @(0L,21474836480L,21474836991L,21474836993L)) {
        Refuses { [NodeProbeDisk]::ValidateRetainedSync20GiBHeader($header,$length) } 'Wrong backing length accepted'
    }
    Refuses { [NodeProbeDisk]::ValidateRetainedSync20GiBHeader($null,21474836992L) } 'Null header accepted'
    foreach($length in @(0,1023,1025)) {
        Refuses { [NodeProbeDisk]::ValidateRetainedSync20GiBHeader([byte[]]::new($length),21474836992L) } 'Non-bounded header accepted'
    }
    [NodeProbeDisk]::ValidateRetainedSync20GiBNativeInfo(21474836480L,2);$cases++
    foreach($length in @(0L,67108864L,21474836479L,21474836481L)) {
        Refuses { [NodeProbeDisk]::ValidateRetainedSync20GiBNativeInfo($length,2) } 'Wrong native virtual size accepted'
    }
    foreach($subtype in @(0,1,3,4)) {
        Refuses { [NodeProbeDisk]::ValidateRetainedSync20GiBNativeInfo(21474836480L,$subtype) } 'Non-fixed subtype accepted'
    }

    [IO.File]::WriteAllBytes($image,$header)
    Check ([NodeProbeDisk]::ValidateRetainedSync20GiBPath($image) -ceq $image) 'Exact normalized ordinary path rejected'
    Refuses { [NodeProbeDisk]::ValidateRetainedSync20GiBImage($image) } 'Small fake image passed backing-size check'
    foreach($badPath in @('', $suffix, ('\\server\share\'+$suffix), ('\\?\'+$image),
        ($image+':stream'), ($image+"`n"), ($image -replace 'control.vhd$','other.vhd'),
        ($image -replace 'f2dc2b779ba7441eba7528b01928476d','00000000000000000000000000000000'),
        ($root+'\..\'+[IO.Path]::GetFileName($root)+'\'+$suffix),
        ($root+' \'+$suffix), ($root+'.\'+$suffix))) {
        Refuses { [NodeProbeDisk]::ValidateRetainedSync20GiBPath($badPath) } 'Invalid/alias path accepted'
    }
    $missing=Join-Path $root ('missing\'+$suffix)
    Refuses { [NodeProbeDisk]::ValidateRetainedSync20GiBPath($missing) } 'Missing image accepted'
    $directoryImage=Join-Path $root ('directory\'+$suffix)
    [void][IO.Directory]::CreateDirectory($directoryImage)
    Refuses { [NodeProbeDisk]::ValidateRetainedSync20GiBPath($directoryImage) } 'Directory accepted as image'
    $link=Join-Path $root 'redirect'
    [void](New-Item -ItemType Junction -Path $link -Target $root)
    try {
        Refuses { [NodeProbeDisk]::ValidateRetainedSync20GiBPath((Join-Path $link $suffix)) } 'Reparse ancestor accepted'
    } finally { Remove-Item -LiteralPath $link }
    $fileLink=Join-Path $root ('file-link\'+$suffix)
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($fileLink))
    [void](New-Item -ItemType Junction -Path $fileLink -Target $root)
    try { Refuses { [NodeProbeDisk]::ValidateRetainedSync20GiBPath($fileLink) } 'Reparse target accepted' }
    finally { Remove-Item -LiteralPath $fileLink }
    # The validation handle must exclude delete sharing until native open ends.
    $openForValidation=[NodeProbeDisk].GetMethod('OpenRetainedSyncForValidation',$flags)
    $readHandle=$openForValidation.Invoke($null,[object[]]@([string]$image))
    try { Refuses { [IO.File]::Delete($image) } 'Validation handle permits replacement/deletion' }
    finally { $readHandle.Dispose() }
    Check ((Get-Item -LiteralPath $image).Length -eq 1024) 'Tests changed the fake image'
    if($RetainedImagePath) {
        Check ([NodeProbeDisk]::ValidateRetainedSync20GiBImage($RetainedImagePath) -ieq $RetainedImagePath) 'Recorded retained image failed read-only identity'
    }
} finally {
    $resolved=[IO.Path]::GetFullPath($root)
    if(-not $resolved.StartsWith($scratch+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup outside scratch' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Output "Retained sync native guards: $cases checks passed; no native disk open or attachment."
