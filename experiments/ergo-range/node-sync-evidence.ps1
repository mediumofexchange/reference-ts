# Pure interpretation of bounded metadata observations, not independent consensus proof.
Set-StrictMode -Version Latest
function Assert-SyncNodeInfo($Info) {
    if ($Info.network -cne 'mainnet' -or $Info.appVersion -cne '6.0.5' -or
        $Info.stateType -cne 'utxo' -or $Info.isMining -isnot [bool] -or $Info.isMining -or
        $Info.stateVersion -cnotmatch '^[0-9a-f]{64}$' -or $Info.stateRoot -cnotmatch '^[0-9a-f]{66}$') { throw 'Unexpected sync node identity/state' }
    foreach ($height in @($Info.fullHeight,$Info.headersHeight)) {
        if ($null -ne $height -and ($height -isnot [long] -and $height -isnot [int] -or $height -lt 0 -or $height -gt 2147483647)) { throw 'Invalid node height' }
    }
    if ($null -ne $Info.genesisBlockId -and $Info.genesisBlockId -cne 'b0244dfc267baca974a4caee06120321562784303a8a688976ae56170e4d175b') { throw 'Wrong mainnet genesis' }
}
function Get-SyncTipEvidence($Before, $Header, $After) {
    Assert-SyncNodeInfo $Before
    Assert-SyncNodeInfo $After
    $result=[ordered]@{status='no-correlated-applied-tip';stableAppliedView=$false;headersAhead=$false;applicationLogMatch=$false}
    if ($Before.stateVersion -ceq ('0'*64) -or $null -eq $Header -or $Before.fullHeight -le 0) { return $result }
    if ($Before.genesisBlockId -cne 'b0244dfc267baca974a4caee06120321562784303a8a688976ae56170e4d175b' -or
        $Before.stateVersion -cne $Before.bestFullHeaderId -or $Header.id -cne $Before.stateVersion -or
        $Header.height -ne $Before.fullHeight -or $Header.stateRoot -cne $Before.stateRoot) { return $result }
    $result.status='historical-applied-tip-correlated'
    $result.height=$Before.fullHeight; $result.id=$Before.stateVersion; $result.stateRoot=$Before.stateRoot
    $result.headersAhead=$Before.headersHeight -gt $Before.fullHeight
    $result.stableAppliedView=$After.stateVersion -ceq $Before.stateVersion -and $After.bestFullHeaderId -ceq $Before.bestFullHeaderId -and
        $After.fullHeight -eq $Before.fullHeight -and $After.stateRoot -ceq $Before.stateRoot
    return $result
}
