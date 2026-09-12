# Inspect/extract exactly one pinned distribution into fresh ignored scratch.
# Download is a separate bounded operation; this script never starts Java.
param([switch]$Stable)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$version = if ($Stable) { '6.0.5' } else { '6.1.5' }
$archiveBytes = if ($Stable) { 108916979 } else { 179682635 }
$expandedBytes = if ($Stable) { 131488960 } else { 202691057 }
$archiveHash = if ($Stable) { '28be43dd010792bc72d320952dcfde368a9a21e3926409f78757e6218583ea06' } else { '7d8c010b781841631f8968e424e30ea99f2352ac0cd40ef32c72e90c37d0af73' }
$jarHash = if ($Stable) { '2a7e2978cb09538ed6780d85ae3aa39c1ecce10e5e5a6e0dc3cd8ab087851588' } else { '4ada5520636a65d7be09b6ec3ff8044b8fdc5baf552633b8c4f6335f71b93928' }
$scratch = Join-Path $repo $(if ($Stable) { 'scratch/ergo-stable' } else { 'scratch/node-startup' })
$archivePath = Join-Path $scratch "ergo-node-v$version-windows-x64.zip"
$bundle = Join-Path $scratch 'bundle'
$clock = [Diagnostics.Stopwatch]::StartNew()
foreach ($path in @((Join-Path $repo 'scratch'), $scratch, $archivePath)) {
    if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse path refused' }
}
if (Test-Path -LiteralPath $bundle) { throw 'Bundle destination must be absent' }
if ((Get-Item -LiteralPath $archivePath).Length -ne $archiveBytes -or
    (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ine $archiveHash) { throw 'Archive pin mismatch' }
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    if ($archive.Entries.Count -ne 192) { throw 'Archive member count mismatch' }
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $total = 0L
    foreach ($entry in $archive.Entries) {
        $name = $entry.FullName
        if ($name -notmatch '^[a-zA-Z0-9._/-]+$' -or $name.StartsWith('/')) { throw 'Invalid archive path' }
        foreach ($part in $name.TrimEnd('/').Split('/')) {
            if ($part -in @('','.','..') -or $part.EndsWith('.') -or
                $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Unsafe archive path segment' }
        }
        if (-not $names.Add($name.TrimEnd('/'))) { throw 'Duplicate archive path' }
        $target = [IO.Path]::GetFullPath((Join-Path $bundle $name))
        if (-not $target.StartsWith($bundle + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive escape' }
        $total += $entry.Length
        if ($entry.Length -lt 0 -or $total -gt $expandedBytes) { throw 'Expanded archive budget exceeded' }
    }
    if ($total -ne $expandedBytes) { throw 'Expanded archive size mismatch' }
    $existing = (Get-ChildItem -LiteralPath $scratch -Recurse -File | Measure-Object Length -Sum).Sum
    if ($existing + $total + 1048576 -gt 536870912) { throw 'Scratch budget exceeded' }
    New-Item -ItemType Directory -Path $bundle | Out-Null
    $hashes = [ordered]@{}
    foreach ($entry in $archive.Entries) {
        if ($clock.Elapsed.TotalSeconds -ge 300) { throw 'Extraction wall budget exceeded' }
        $target = [IO.Path]::GetFullPath((Join-Path $bundle $entry.FullName))
        if ($entry.FullName.EndsWith('/')) { New-Item -ItemType Directory -Force -Path $target | Out-Null; continue }
        New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($target)) | Out-Null
        $inputStream = $entry.Open()
        try {
            $outputStream = [IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try {
                $buffer = [byte[]]::new(1048576); $written = 0L
                while (($count = $inputStream.Read($buffer,0,$buffer.Length)) -gt 0) {
                    $written += $count
                    if ($written -gt $entry.Length -or $clock.Elapsed.TotalSeconds -ge 300) { throw 'Entry extraction budget exceeded' }
                    $outputStream.Write($buffer,0,$count)
                }
                if ($written -ne $entry.Length) { throw 'Entry length mismatch' }
            } finally { $outputStream.Dispose() }
        } finally { $inputStream.Dispose() }
        $hashes[$entry.FullName] = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    if ($hashes["ergo-$version.jar"] -ne $jarHash) { throw 'JAR pin mismatch' }
    [ordered]@{ archiveSha256=$archiveHash;
        entries=192; expandedBytes=$total; files=$hashes } | ConvertTo-Json -Depth 4 |
        Set-Content -Encoding utf8 (Join-Path $scratch 'bundle-manifest.json')
    Write-Output "Pinned bundle extracted: $($hashes.Count) files; $total bytes; no executable started."
} finally { $archive.Dispose() }
