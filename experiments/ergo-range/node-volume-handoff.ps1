# Fixed local, trusted-host handoff. No caller-selected disk or executable.
Set-StrictMode -Version Latest
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
