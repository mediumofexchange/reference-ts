# Fixed local, trusted-host handoff. No caller-selected disk or executable.
Set-StrictMode -Version Latest
function Get-NodeVolumeProfile([bool]$Sync30Minutes=$false) {
    if ($Sync30Minutes) {
        return @{name='sync-30-minutes';scratchName='node-source-sync';virtualBytes=21474836480L;
            maximumBackingBytes=21475885056L;minimumHostFree=129922760704L;ownerWallMs=2160000L;childWallMs=1800000L}
    }
    return @{name='offline-64-mib';scratchName='node-volume-split';virtualBytes=67108864L;
        maximumBackingBytes=68157440L;minimumHostFree=108011716608L;ownerWallMs=240000L;childWallMs=120000L}
}
function Assert-OrdinaryAncestors([string]$Path) {
    $cursor=[IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item=Get-Item -LiteralPath $cursor -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Nonordinary directory ancestor' }
        }
        $cursor=[IO.Path]::GetDirectoryName($cursor)
    }
}
function Write-VolumeHandoff([string]$Path, $Value) {
    Assert-OrdinaryAncestors ([IO.Path]::GetDirectoryName($Path))
    $json=$Value | ConvertTo-Json -Depth 18
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($json)
    if ($bytes.Length -gt 65536) { throw 'Handoff exceeds 64 KiB' }
    $temporary=$Path+'.writing'
    $file=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $file.Write($bytes); $file.Flush($true) } finally { $file.Dispose() }
    [IO.File]::Move($temporary,$Path,$false)
}
function Read-VolumeHandoff([string]$Path) {
    Assert-OrdinaryAncestors ([IO.Path]::GetDirectoryName($Path))
    $item=Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 65536) { throw 'Invalid handoff file' }
    $file=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        if ($file.Length -gt 65536) { throw 'Handoff exceeds 64 KiB' }
        $bytes=[byte[]]::new([int]$file.Length); $file.ReadExactly($bytes)
        return [Text.UTF8Encoding]::new($false,$true).GetString($bytes) | ConvertFrom-Json -AsHashtable
    } finally { $file.Dispose() }
}
