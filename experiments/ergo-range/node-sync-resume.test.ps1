# Focused retained-volume and worker refusals; no VHD attachment or node launch.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'node-sync-resume.ps1')
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$expected=Get-SyncResumeDescriptor $repo
$volume=@{Path=$expected.volumeRoot;UniqueId=$expected.volumeRoot;Size=$expected.volumeBytes;FileSystem='NTFS';FileSystemLabel='MOE_NODE_CONTROL'}
$cases=0
function Reject([scriptblock]$Action) {
    $failed=$false; try { & $Action } catch { $failed=$true }
    if (-not $failed) { throw 'Expected resume refusal' }; $script:cases++
}
Assert-SyncResumeVolume $volume $expected; $cases++
foreach ($change in @(@('Path','wrong'),@('UniqueId','wrong'),@('Size',1),@('FileSystem','ReFS'),@('FileSystemLabel','other'))) {
    $bad=$volume.Clone(); $bad[$change[0]]=$change[1]; Reject { Assert-SyncResumeVolume $bad $expected }
}
$root=Join-Path $repo ('scratch/resume-guards-'+[guid]::NewGuid().ToString('N'))
try {
    foreach ($directory in @($root,"$root/data","$root/secrets","$root/home","$root/tmp")) { [void][IO.Directory]::CreateDirectory($directory) }
    [IO.File]::WriteAllText("$root/ergo.conf",'fixture config')
    [IO.File]::WriteAllText("$root/logback.xml",'<configuration/>')
    [IO.File]::WriteAllText("$root/data/retained",'fixture database marker')
    $testExpected=$expected.Clone(); $testExpected.configSha256=(Get-FileHash "$root/ergo.conf").Hash.ToLowerInvariant()
    Assert-SyncResumeWorker $root $testExpected; $cases++
    Reject { Assert-SyncResumeWorker $root $expected }
    [IO.File]::WriteAllText("$root/secrets/unexpected",'not a key')
    Reject { Assert-SyncResumeWorker $root $testExpected }
    [IO.File]::Delete("$root/secrets/unexpected")
    [IO.File]::Delete("$root/data/retained")
    Reject { Assert-SyncResumeWorker $root $testExpected }
    [IO.File]::WriteAllText("$root/data/retained",'fixture database marker')
    [IO.File]::Delete("$root/logback.xml")
    [void][IO.Directory]::CreateDirectory("$root/logback.xml")
    Reject { Assert-SyncResumeWorker $root $testExpected }
    [IO.Directory]::Delete("$root/logback.xml")
    [IO.File]::WriteAllText("$root/logback.xml",'<configuration/>')
    [IO.Directory]::Delete("$root/tmp")
    Reject { Assert-SyncResumeWorker $root $testExpected }
} finally {
    $resolved=[IO.Path]::GetFullPath($root)
    if (-not $resolved.StartsWith((Join-Path $repo 'scratch/resume-guards-'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup path outside test scratch' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
"Resume guards passed ($cases cases; no image or node)."
