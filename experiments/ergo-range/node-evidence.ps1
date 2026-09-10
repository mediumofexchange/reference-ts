# Observation predicates only. Never starts a process or reads the network.
function Assert-InitialNodeReplies($Replies) {
    if ($Replies.Count -ne 3 -or $Replies['/info'].status -ne 200 -or
        $Replies['/peers/connected'].status -ne 200 -or $Replies['/wallet/status'].status -ne 403) { throw 'Unexpected API statuses' }
    $info=ConvertFrom-Json -InputObject $Replies['/info'].body -AsHashtable
    $expected=@{ network='mainnet'; stateType='utxo'; isMining=$false; isExplorer=$false;
        peersCount=0; unconfirmedCount=0;
        stateVersion=('0' * 64);
        stateRoot='a5df145d41ab15a01e0cd3ffbab046f0d029e5412293072ad0f5827428589b9302' }
    foreach ($key in $expected.Keys) {
        if (-not $info.Contains($key) -or $info[$key] -cne $expected[$key]) { throw "Unexpected initial field: $key" }
        if (($expected[$key] -is [bool] -and $info[$key] -isnot [bool]) -or
            ($expected[$key] -is [string] -and $info[$key] -isnot [string]) -or
            ($expected[$key] -is [int] -and $info[$key] -isnot [int] -and $info[$key] -isnot [long])) { throw "Wrong initial field type: $key" }
    }
    # Absent headers are explicitly null, not height zero or missing fields.
    foreach ($key in @('headersHeight','fullHeight','bestHeaderId','bestFullHeaderId','genesisBlockId','headersScore','fullBlocksScore')) {
        if (-not $info.Contains($key) -or $null -ne $info[$key]) { throw "Expected absent header field: $key" }
    }
    # -NoEnumerate preserves [] as an array; @($null) would wrongly count one peer.
    $peers=ConvertFrom-Json -InputObject $Replies['/peers/connected'].body -NoEnumerate
    if ($peers -isnot [array] -or $peers.Count -ne 0) { throw 'Expected empty peer array' }
}
function Assert-NodeObservedBytes([long]$OutputBytes,[long]$PeakFileBytes,[long]$FinalFileBytes) {
    if ($OutputBytes -lt 0 -or $PeakFileBytes -lt 0 -or $FinalFileBytes -lt 0 -or
        $OutputBytes -gt 16777216 -or [Math]::Max($PeakFileBytes,$FinalFileBytes) -gt 16777216-$OutputBytes) { throw 'Combined observed byte envelope exceeded' }
}
