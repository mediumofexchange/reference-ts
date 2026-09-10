# Synthetic scratch files only; no JVM, DLL load, volume allocation or network.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'node-database-native.ps1')
$scratch=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../scratch'))
$root=Join-Path $scratch ('database-native-test-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$cases=0
function Check([bool]$Condition,[string]$Label) { if(-not $Condition){throw $Label};$script:cases++ }
function Refuses([scriptblock]$Action,[string]$Label) {
    $refused=$false;try { & $Action | Out-Null } catch { $refused=$true }
    Check $refused $Label
}
try {
    $source=Join-Path $root 'source.bin';$destination=Join-Path $root 'copied.bin'
    $bytes=[byte[]]::new(65539);for($i=0;$i -lt $bytes.Length;$i++){$bytes[$i]=[byte]($i%251)}
    [IO.File]::WriteAllBytes($source,$bytes)
    $hash=(Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant()
    $result=Confirm-DatabaseNative $source $bytes.Length $hash
    Check (-not $result.copied -and $result.sha256 -ceq $hash) 'Read-only identity failed'
    Check (-not (Test-Path -LiteralPath $destination)) 'Preflight wrote destination'
    $result=Confirm-DatabaseNative $source $bytes.Length $hash $destination
    Check ($result.copied -and (Get-FileHash -LiteralPath $destination).Hash.ToLowerInvariant() -ceq $hash) 'Exact copy failed'
    Refuses { Confirm-DatabaseNative $source $bytes.Length $hash $destination } 'Existing destination overwritten'
    Check ((Get-FileHash -LiteralPath $destination).Hash.ToLowerInvariant() -ceq $hash) 'Existing destination changed'
    $absent=Join-Path $root 'absent.bin'
    foreach($length in @(0L,-1L,33554433L,65538L,65540L)) {
        Refuses { Confirm-DatabaseNative $source $length $hash $absent } 'Invalid length accepted'
    }
    foreach($badHash in @('',('a'*63),(('a'*64)+"`n"),('z'*64),('a'*64))) {
        Refuses { Confirm-DatabaseNative $source $bytes.Length $badHash $absent } 'Invalid/wrong hash accepted'
    }
    Refuses { Confirm-DatabaseNative $root $bytes.Length $hash $absent } 'Directory accepted'
    Refuses { Confirm-DatabaseNative (Join-Path $root 'missing') $bytes.Length $hash $absent } 'Missing source accepted'
    $locked=[IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
    try { Refuses { Confirm-DatabaseNative $source $bytes.Length $hash $absent } 'Conflicting source handle accepted' }
    finally { $locked.Dispose() }
    $bytes[0]=1;[IO.File]::WriteAllBytes($source,$bytes)
    Refuses { Confirm-DatabaseNative $source $bytes.Length $hash $absent } 'Changed source after preflight accepted'
    Check (-not (Test-Path -LiteralPath $absent)) 'Rejected input created output'
    # A directory junction needs no DLL execution and exercises ancestor refusal.
    $link=Join-Path $root 'redirect'
    [void](New-Item -ItemType Junction -Path $link -Target $root)
    try {
        $changedHash=(Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant()
        Refuses { Confirm-DatabaseNative (Join-Path $link 'source.bin') $bytes.Length $changedHash $absent } 'Redirected source accepted'
    } finally { Remove-Item -LiteralPath $link }
} finally {
    $resolved=[IO.Path]::GetFullPath($root)
    if(-not $resolved.StartsWith($scratch+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup outside scratch' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Output "Native file identity/copy: $cases checks passed; synthetic files only."
