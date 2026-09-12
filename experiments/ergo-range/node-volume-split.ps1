# Fixed offline ordinary-user control. Default is read-only; Execute requests UAC for disk ownership only.
param([switch]$Execute,[switch]$ParentFailureControl)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Windows x64 / PowerShell 7 required' }
foreach ($file in @('node-java.ps1','node-disk-evidence.ps1','node-database-evidence.ps1','node-evidence.ps1','node-volume-evidence.ps1','node-volume-handoff.ps1')) { . (Join-Path $PSScriptRoot $file) }
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$nonce=[guid]::NewGuid().ToString('N')
$run=Join-Path $repo "scratch/node-volume-split/$nonce"
$bundle=Join-Path $repo 'scratch/ergo-stable/bundle'
$report=[ordered]@{status='unresolved-ordinary-volume-control';nonce=$nonce;run=$run;observedAtUtc=[DateTime]::UtcNow.ToString('o');executeRequested=[bool]$Execute;errors=@();files=[ordered]@{}}
$lease=$null; $owner=$null; $maySignalDone=$false
try {
    foreach ($file in @('node-volume-split.ps1','node-volume-worker.ps1','node-volume-owner.ps1','node-volume-handoff.ps1','NodeProbeProcess.cs','NodeProbeDisk.cs','NodeDatabaseIdentity.cs','NodeTrafficCounter.cs','node-java.ps1','node-volume-evidence.ps1','node-disk-evidence.ps1','node-database-evidence.ps1','node-evidence.ps1')) {
        $report.files[$file]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $file)).Hash.ToLowerInvariant()
    }
    Assert-OrdinaryAncestors $run
    Assert-OrdinaryAncestors $bundle
    if ($repo -cnotmatch '^[A-Za-z]:\\' -or (Test-Path -LiteralPath $run)) { throw 'Requires local repository and absent control directory' }
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($repo))
    if ($drive.DriveFormat -cne 'NTFS' -or $drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'Fixed NTFS host required' }
    $report.hostFreeBefore=$drive.AvailableFreeSpace
    if ($report.hostFreeBefore -lt 108011716608L) { throw 'Need 100 GiB reserve plus 65 MiB image, 512 MiB preparation and 16 MiB report allowance' }
    $report.java=Get-MaintainedNodeJava $repo
    $prior=Get-Content -Raw (Join-Path $repo 'docs/ergo-maintained-java-startup-verification.json') | ConvertFrom-Json -AsHashtable
    $configHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($prior.config))).ToLowerInvariant()
    if ($prior.status -cne 'stock-node-offline-startup-only' -or
        $configHash -cne 'c8f156ed686c159ccb6b03134b8fd5393517eb1a473d4170b97a8d08f1063dc1') { throw 'Exact reviewed offline config required' }
    $manifestPath=Join-Path $repo 'scratch/ergo-stable/bundle-manifest.json'
    if ((Get-FileHash -LiteralPath $manifestPath).Hash -ine 'df98bdbfa029ad3aaeabb3968a2b73cdaa92769d93192bc25b4c8f298102dce6') { throw 'Stable manifest mismatch' }
    $pins=(Get-Content -Raw $manifestPath | ConvertFrom-Json -AsHashtable).files
    $pending=[Collections.Generic.Queue[string]]::new(); $pending.Enqueue($bundle); $entries=0; $files=0
    while ($pending.Count) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
            $entries++
            if ($entries -gt 192 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Stable bundle redirection or budget' }
            if ($item.PSIsContainer) { $pending.Enqueue($item.FullName); continue }
            $name=[IO.Path]::GetRelativePath($bundle,$item.FullName).Replace('\','/')
            if (-not $pins.ContainsKey($name) -or (Get-FileHash -LiteralPath $item.FullName).Hash -ine $pins[$name]) { throw 'Stable bundle mismatch' }
            $files++
        }
    }
    if ($files -ne 167 -or $pins['ergo-6.0.5.jar'] -cne '2a7e2978cb09538ed6780d85ae3aa39c1ecce10e5e5a6e0dc3cd8ab087851588') { throw 'Stable JAR/count mismatch' }
    $report.jarSha256=$pins['ergo-6.0.5.jar']
    foreach ($port in @(19030,19053)) {
        if ([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port -contains $port) { throw 'Probe port occupied' }
    }
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try { $report.elevated=[Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
    finally { $identity.Dispose() }
    if (-not $Execute) { $report.status='prepared-read-only-ordinary-volume-control'; return }
    if ($report.elevated) { throw 'Run the split supervisor as an ordinary user' }

    foreach ($file in @('NodeProbeProcess.cs','NodeTrafficCounter.cs','NodeDatabaseIdentity.cs')) { Add-Type -Path (Join-Path $PSScriptRoot $file) }
    [void][IO.Directory]::CreateDirectory($run)
    $lease=[NodeProbeProcess]::CreateVolumeJob($nonce)
    $self=[Diagnostics.Process]::GetCurrentProcess()
    try { $started=$self.StartTime.ToFileTimeUtc() } finally { $self.Dispose() }
    $ownerPath=Join-Path $PSScriptRoot 'node-volume-owner.ps1'
    $ownerArgs="-NoProfile -File `"$ownerPath`" -Nonce $nonce -ParentId $PID -ParentStarted $started"
    $owner=Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList $ownerArgs -Verb RunAs -WindowStyle Hidden -PassThru
    $maySignalDone=$true
    $wait=[Diagnostics.Stopwatch]::StartNew()
    $readyPath=Join-Path $run 'ready.json'
    while (-not (Test-Path -LiteralPath $readyPath)) {
        if ($owner.HasExited) { throw 'Disk owner exited before readiness' }
        if ($wait.ElapsedMilliseconds -gt 180000) { throw 'Disk owner readiness timeout' }
        Start-Sleep -Milliseconds 250
    }
    $ready=Read-VolumeHandoff $readyPath
    if ($ready.nonce -cne $nonce -or $ready.parentId -ne $PID -or $ready.parentStarted -ne $started -or $ready.ownerId -ne $owner.Id -or
        $ready.driveLetter -cnotmatch '^[D-Z]$' -or $ready.volumeRoot -cnotmatch '^\\\\\?\\Volume\{[0-9a-fA-F-]{36}\}\\$' -or
        $ready.volume.Size -le 0 -or $ready.volume.Size -gt 67108864 -or $ready.volume.FileSystem -cne 'NTFS') { throw 'Wrong volume handoff' }
    $letter=[char]$ready.driveLetter; $driveRoot=([string]$letter)+':\'; $volumeRoot=$ready.volumeRoot
    $report.ownerReady=$ready
    function Assert-OwnedVolume {
        if ($owner.HasExited) { throw 'Disk owner exited' }
        [NodeDatabaseIdentity]::VerifyDriveMapping($letter,$volumeRoot) | Out-Null
        $localVolume=[IO.DriveInfo]::new($driveRoot)
        if ($localVolume.DriveFormat -cne 'NTFS' -or $localVolume.VolumeLabel -cne 'MOE_NODE_CONTROL' -or $localVolume.TotalSize -ne $ready.volume.Size) { throw 'Ordinary volume identity mismatch' }
        if ($drive.AvailableFreeSpace -lt 107374182400L) { throw 'Host reserve lost' }
        return [pscustomobject]@{Path=$volumeRoot;UniqueId=$ready.volume.UniqueId;FileSystem=$localVolume.DriveFormat;FileSystemLabel=$localVolume.VolumeLabel;Size=$localVolume.TotalSize;SizeRemaining=$localVolume.AvailableFreeSpace}
    }
    [void](Assert-OwnedVolume)
    $report.mappingBefore=[NodeDatabaseIdentity]::VerifyDriveMapping($letter,$volumeRoot)
    # The failure control kills this dedicated supervisor at the first Java observation.
    # The elevated owner must observe parent death, stop the job and remove its disk.
    . (Join-Path $PSScriptRoot 'node-volume-worker.ps1')
    if (-not $report.process.ChildTokenChecked -or $report.process.ChildElevated) { throw 'Ordinary child token evidence missing' }
    $report.status='ordinary-offline-node-volume-only'
} catch { $report.errors+=$_.Exception.Message }
finally {
    if ($null -ne $lease) {
        # No disk release signal until all worker work has returned and the job is empty.
        # If termination is unresolved, leave the owner holding the volume; parent
        # death remains an independent cleanup trigger. Never issue a false done.
        try {
            $lease.StopAndConfirmEmpty()
            if ($maySignalDone) { Write-VolumeHandoff (Join-Path $run 'done.json') @{nonce=$nonce;parentId=$PID;parentStarted=$started} }
            $lease.Dispose(); $lease=$null
        } catch { $report.errors+=$_.Exception.Message; $report.status='unresolved-ordinary-volume-control' }
    }
    if ($null -ne $owner) {
        $wait=[Diagnostics.Stopwatch]::StartNew()
        while (-not $owner.HasExited -and $wait.ElapsedMilliseconds -lt 30000) { Start-Sleep -Milliseconds 250 }
        if ($owner.HasExited -and (Test-Path -LiteralPath (Join-Path $run 'owner.json'))) {
            $report.owner=Read-VolumeHandoff (Join-Path $run 'owner.json')
            if ($report.owner.status -cne 'owned-volume-removed' -or -not $report.owner.jobEmpty -or -not $report.owner.mappingRemoved -or -not $report.owner.detached -or -not $report.owner.artifactRemoved) {
                $report.errors+='Disk owner cleanup unresolved'; $report.status='unresolved-ordinary-volume-control'
            }
        } else { $report.errors+='Disk owner still running or report unavailable'; $report.status='unresolved-ordinary-volume-control' }
        $owner.Dispose()
    }
    $json=$report | ConvertTo-Json -Depth 20
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 16777216) { throw 'Report exceeds 16 MiB' }
    if ($Execute -and (Test-Path -LiteralPath $run)) { [IO.File]::WriteAllText((Join-Path $run 'result.json'),$json) }
    $json
}
if ($report.status -notin @('prepared-read-only-ordinary-volume-control','ordinary-offline-node-volume-only')) { exit 2 }
