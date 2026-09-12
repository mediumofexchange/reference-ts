# One recorded, owned database only. No caller-selected image or storage mutation.
function Get-SyncResumeDescriptor([string]$Repo) {
    return @{
        imagePath=Join-Path $Repo 'scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd'
        diskGuid='{ad70ec67-79dc-47ab-8d93-8c831533123c}'
        partition=@{PartitionNumber=2;Guid='{edfe9a0d-4157-49f1-88e8-e6bbbcb9929a}';Offset=16777216L;Size=21457010688L}
        volumeRoot='\\?\Volume{edfe9a0d-4157-49f1-88e8-e6bbbcb9929a}\'
        volumeBytes=21457006592L
        configSha256='b3e6a52bea1c027fca69863c44a97d332771ca2b8985c997b3294d764822c530'
    }
}
function Assert-SyncResumeVolume($Volume,$Expected) {
    if ($Volume.Path -ine $Expected.volumeRoot -or $Volume.UniqueId -ine $Expected.volumeRoot -or
        $Volume.Size -ne $Expected.volumeBytes -or $Volume.FileSystem -cne 'NTFS' -or
        $Volume.FileSystemLabel -cne 'MOE_NODE_CONTROL') { throw 'Retained volume identity changed' }
}
function Assert-SyncResumeWorker([string]$Root,$Expected) {
    foreach ($directory in @($Root,"$Root/data","$Root/secrets","$Root/home","$Root/tmp")) {
        $item=Get-Item -LiteralPath $directory -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Retained worker directory redirected or missing' }
    }
    foreach ($name in @('ergo.conf','logback.xml','hs_err.log')) {
        $path=Join-Path $Root $name
        if ($name -eq 'hs_err.log' -and -not (Test-Path -LiteralPath $path)) { continue }
        $item=Get-Item -LiteralPath $path -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 1048576) { throw 'Retained diagnostic redirected or oversized' }
    }
    if ((Get-FileHash -LiteralPath "$Root/ergo.conf").Hash -ine $Expected.configSha256) { throw 'Retained configuration differs from the recorded first run' }
    if (@(Get-ChildItem -LiteralPath "$Root/secrets" -Force).Count) { throw 'Retained secrets directory is not empty' }
    if (-not @(Get-ChildItem -LiteralPath "$Root/data" -Force).Count) { throw 'Retained database is empty' }
}
