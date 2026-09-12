$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'node-volume-handoff.ps1')
Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeProcess.cs')
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$nonce=[guid]::NewGuid().ToString('N')
$run=Join-Path $repo "scratch/volume-handoff-test-$nonce"
Assert-OrdinaryAncestors $run
[void][IO.Directory]::CreateDirectory($run)
$creator=$null; $reader=$null; $cases=0
function Expect-Refusal([scriptblock]$Action) {
    $failed=$false
    try { & $Action } catch { $failed=$true }
    if (-not $failed) { throw 'Expected handoff/lease refusal' }
    $script:cases++
}
try {
    $creator=[NodeProbeProcess]::CreateVolumeJob($nonce)
    $reader=[NodeProbeProcess]::OpenVolumeJob($nonce)
    if ($creator.ActiveProcesses -ne 0 -or $reader.ActiveProcesses -ne 0) { throw 'Fresh job not empty' }; $cases++
    Expect-Refusal { [NodeProbeProcess]::CreateVolumeJob($nonce) }
    Expect-Refusal { [NodeProbeProcess]::CreateVolumeJob('not-a-guid') }
    Expect-Refusal { [NodeProbeProcess]::RunOnVolumeJob($reader,'unused',@(),'unused',$null) }
    $reader.StopAndConfirmEmpty(); $cases++
    $reader.Dispose(); $reader.Dispose(); $reader=$null
    $creator.Dispose(); $creator=$null
    Expect-Refusal { [NodeProbeProcess]::OpenVolumeJob($nonce) }
    $path=Join-Path $run 'ready.json'
    Write-VolumeHandoff $path @{nonce=$nonce}
    if ((Read-VolumeHandoff $path).nonce -cne $nonce) { throw 'Handoff roundtrip failed' }; $cases++
    Expect-Refusal { Write-VolumeHandoff $path @{nonce='replacement'} }
    if ((Read-VolumeHandoff $path).nonce -cne $nonce) { throw 'Existing handoff replaced' }; $cases++
    Expect-Refusal { Write-VolumeHandoff (Join-Path $run 'large.json') @{value=('x'*65536)} }
    [IO.File]::WriteAllBytes((Join-Path $run 'invalid.json'),[byte[]]@(255,255))
    Expect-Refusal { Read-VolumeHandoff (Join-Path $run 'invalid.json') }
    [IO.File]::WriteAllText((Join-Path $run 'large.json'),('x'*65537))
    Expect-Refusal { Read-VolumeHandoff (Join-Path $run 'large.json') }
    "Volume handoff checks passed ($cases cases; no worker, disk or network)."
} finally {
    if ($reader) { $reader.Dispose() }; if ($creator) { $creator.Dispose() }
    Assert-OrdinaryAncestors $run
    # Exact owned files, no recursion or derived external deletion targets.
    foreach ($name in @('ready.json','ready.json.writing','invalid.json','large.json')) {
        $path=Join-Path $run $name
        if (Test-Path -LiteralPath $path) {
            $item=Get-Item -LiteralPath $path -Force
            if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected test artifact' }
            [IO.File]::Delete($path)
        }
    }
    [IO.Directory]::Delete($run,$false)
}
