# Read-only selection of the separately prepared, unmodified Temurin runtime.
# No PATH/JAVA_HOME changes, downloads, installation or executable launch.
function Get-MaintainedNodeJava([string]$Repo) {
    $scratch = Join-Path $Repo 'scratch/ergo-java'
    $bundle = Join-Path $scratch 'bundle'
    $manifestPath = Join-Path $scratch 'bundle-manifest.json'
    $manifestHash = 'fab21196a9f51cdc4678b5ffbe4ba3ad5ccdf945863024b16400d15a7c03ac1d'
    $cursor = [IO.Path]::GetFullPath($bundle)
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Nonordinary Java ancestor' }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    if (((Get-Item -LiteralPath $manifestPath).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash -ine $manifestHash) { throw 'Java manifest changed' }
    $manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json -AsHashtable
    $pending = [Collections.Generic.Queue[string]]::new(); $pending.Enqueue($bundle)
    $entries = 0; $files = 0; $bytes = 0L
    while ($pending.Count) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
            $entries++
            if ($entries -gt 378 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Java entry budget or redirection' }
            if ($item.PSIsContainer) { $pending.Enqueue($item.FullName); continue }
            $name = [IO.Path]::GetRelativePath($bundle,$item.FullName).Replace('\','/')
            if (-not $manifest.files.ContainsKey($name) -or
                (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash -ine $manifest.files[$name]) { throw 'Java member mismatch' }
            $files++; $bytes += $item.Length
        }
    }
    if ($files -ne 315 -or $bytes -ne 151524241L) { throw 'Java inventory mismatch' }
    [pscustomobject]@{
        path = Join-Path $bundle 'jdk-21.0.12.1+1-jre/bin/java.exe'
        version = '21.0.12.1'
        sha256 = $manifest.files['jdk-21.0.12.1+1-jre/bin/java.exe']
        manifestSha256 = $manifestHash
        manifest = $manifest
    }
}
