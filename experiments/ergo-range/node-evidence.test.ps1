$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'node-evidence.ps1')
# This observed response exposed both the null-height and empty-array classifier bugs.
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$report=Get-Content -Raw (Join-Path $repo 'docs/ergo-node-startup-verification.json') | ConvertFrom-Json -AsHashtable
$replies=$report.observations.replies
Assert-InitialNodeReplies $replies
$checks=1
foreach ($case in @('missing-height','zero-height','wrong-root','wrong-network','mining','mining-string','count-string','peer-null','peer-object','peer-present','wallet-auth')) {
    $copy=$replies | ConvertTo-Json -Depth 8 | ConvertFrom-Json -AsHashtable
    $info=$copy['/info'].body | ConvertFrom-Json -AsHashtable
    switch ($case) {
        'missing-height' {$info.Remove('headersHeight')}
        'zero-height' {$info.headersHeight=0}
        'wrong-root' {$info.stateRoot='00'}
        'wrong-network' {$info.network='testnet'}
        'mining' {$info.isMining=$true}
        'mining-string' {$info.isMining='False'}
        'count-string' {$info.peersCount='0'}
        'peer-null' {$copy['/peers/connected'].body='null'}
        'peer-object' {$copy['/peers/connected'].body='{}'}
        'peer-present' {$copy['/peers/connected'].body='[{}]'}
        'wallet-auth' {$copy['/wallet/status'].status=200}
    }
    $copy['/info'].body=$info | ConvertTo-Json -Depth 8
    $refused=$false
    try {Assert-InitialNodeReplies $copy} catch {$refused=$true}
    if (-not $refused) {throw "Bad evidence accepted: $case"}; $checks++
}
Assert-NodeObservedBytes 5 16777211 16777211; $checks++
foreach ($bytes in @(@(5,16777212,0),@(5,0,16777212),@(-1,0,0))) {
    $refused=$false
    try {Assert-NodeObservedBytes $bytes[0] $bytes[1] $bytes[2]} catch {$refused=$true}
    if (-not $refused) {throw 'Combined byte-envelope failure accepted'}; $checks++
}
Write-Output "Node startup evidence regressions passed ($checks cases; no process launched)."

# Stable node observations must satisfy the same predicates as the prerelease.
$stable=Get-Content -Raw (Join-Path $repo 'docs/ergo-stable-startup-verification.json') | ConvertFrom-Json -AsHashtable
Assert-InitialNodeReplies $stable.observations.replies
Assert-NodeObservedBytes $stable.result.CapturedOutputBytes $stable.observations.filesPeakBytes $stable.observations.finalFileBytes
Write-Output 'Stable startup reply and combined-byte observations passed (2 cases; no process launched).'
