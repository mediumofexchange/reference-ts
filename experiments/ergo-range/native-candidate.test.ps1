# Synthetic text-only ZIPs: no build, download, DLL load, Java or database use.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-candidate.ps1')
$root = Assert-NativeScratchPath (Join-Path $PSScriptRoot ('../../scratch/native-candidate-tests-'+[guid]::NewGuid().ToString('N')))
$commit = 'a' * 40
$run = '12345'
$script:cases = 0
function Check([string]$Name, [scriptblock]$Action) {
    & $Action
    $script:cases++
    Write-Output "PASS $Name"
}
function Reject([string]$Name, [scriptblock]$Action, [string]$Reason) {
    $caught = $null
    try { & $Action } catch { $caught = $_.Exception.Message }
    if (-not $caught -or $caught -notlike "*$Reason*") { throw "$Name expected '$Reason', received '$caught'" }
    if (Test-Path -LiteralPath (Join-Path $root 'received')) { throw 'Refused archive wrote destination' }
    $script:cases++
    Write-Output "PASS $Name"
}
function Record([string]$Path) {
    return @{bytes=(Get-Item -LiteralPath $Path).Length; sha256=(Get-FileHash -LiteralPath $Path).Hash.ToLowerInvariant()}
}
function Archive([string]$Name, [scriptblock]$Mutate={}) {
    $members = [Collections.Generic.List[object]]::new()
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root 'candidate') -File -Recurse) {
        $path = [IO.Path]::GetRelativePath((Join-Path $root 'candidate'),$file.FullName).Replace('\','/')
        $members.Add(@{name=$path; bytes=[IO.File]::ReadAllBytes($file.FullName); attributes=0})
    }
    & $Mutate $members
    $archive = Join-Path $root ($Name+'.zip')
    $zip = [IO.Compression.ZipFile]::Open($archive,[IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($member in $members) {
            $entry = $zip.CreateEntry($member.name)
            $entry.ExternalAttributes = $member.attributes
            $stream = $entry.Open()
            try { $stream.Write($member.bytes,0,$member.bytes.Length) } finally { $stream.Dispose() }
        }
    } finally { $zip.Dispose() }
    return $archive
}
function Receive([string]$Path, [string]$Hash=(Record $Path).sha256, [string]$ExpectedCommit=$commit, [string]$ExpectedRun=$run) {
    return Import-NativeCandidate -Archive $Path -ArchiveSha256 $Hash -WorkflowCommit $ExpectedCommit -RunId $ExpectedRun -RunAttempt '1' -Destination (Join-Path $root 'received')
}
function Mutate-Manifest($Members, [scriptblock]$Change) {
    $manifestEntry = @($Members | Where-Object name -CEQ 'manifest.json')[0]
    $manifest = [Text.Encoding]::UTF8.GetString($manifestEntry.bytes) | ConvertFrom-Json -AsHashtable
    & $Change $manifest
    $manifestEntry.bytes = [Text.Encoding]::UTF8.GetBytes(($manifest | ConvertTo-Json -Depth 8))
}
try {
    foreach ($dir in @('build/java/Release','source/java/include')) { New-Item -ItemType Directory -Path (Join-Path $root $dir) -Force | Out-Null }
    $paths = @('build/java/Release/librocksdbjni-win64.dll','build/java/rocksdbjni-10.2.1-win64.jar',
        'build/CMakeCache.txt','build/java/rocksdbjni.vcxproj','build/build_version.cc','exports.txt','imports.txt',
        'source/java/include/org_rocksdb_Fixture.h')
    foreach ($path in $paths) { [IO.File]::WriteAllText((Join-Path $root $path),'synthetic candidate data') }
    # Both projects exist after configure. Only rocksdbjni is packaged by
    # upstream rocksdbjava; the sibling must never stand in for its evidence.
    [IO.File]::WriteAllText((Join-Path $root 'build/java/rocksdbjni-shared.vcxproj'),'unbuilt sibling target')
    $report = @{status='compiled-unadopted-native-candidate'; candidateLoaded=$false; databaseAcceptance=$false;
        sourceCommit=$script:NativeSource; workflowCommit=$commit; runId=$run; runAttempt='1';
        dll=(Record (Join-Path $root $paths[0])); jar=(Record (Join-Path $root $paths[1]))}
    Check 'stage exact bounded members' {
        $manifest = Export-NativeCandidate $root $report
        if ($manifest.files.Count -ne 10) { throw 'Unexpected staged member count' }
        if (@($manifest.files | Where-Object name -CEQ 'rocksdbjni.vcxproj').Count -ne 1 -or
            @($manifest.files | Where-Object name -CEQ 'rocksdbjni-shared.vcxproj').Count -ne 0) {
            throw 'Stager must retain the packaged DLL target project'
        }
    }
    $good = Archive 'good'
    Check 'verified import preserves every byte' {
        $result = Receive $good
        foreach ($record in $result.files) {
            if ((Record (Join-Path $root ('received/'+$record.name))).sha256 -cne $record.sha256) { throw 'Extracted byte mismatch' }
        }
    }
    Check 'existing destination refused without overwrite' {
        try { Receive $good; throw 'Unexpected success' } catch {
            if ($_.Exception.Message -notlike '*destination must be absent*') { throw }
        }
    }
    $received = Assert-NativeScratchPath (Join-Path $root 'received')
    Remove-Item -LiteralPath $received -Recurse -Force
    Reject 'archive digest mismatch' { Receive $good ('0'*64) } 'archive hash mismatch'
    Reject 'wrong workflow commit' { Receive $good (Record $good).sha256 ('b'*40) } 'identity mismatch'
    Reject 'wrong run' { Receive $good (Record $good).sha256 $commit '999' } 'identity mismatch'
    Reject 'destination outside scratch' {
        Import-NativeCandidate $good (Record $good).sha256 $commit $run '1' (Join-Path $PSScriptRoot '../../outside')
    } 'below repository scratch'
    $bad = Archive 'traversal' { param($m) $m.Add(@{name='../escape';bytes=[byte[]]@(1);attributes=0}) }
    Reject 'parent traversal' { Receive $bad } 'Unexpected candidate member name'
    $bad = Archive 'sibling-project' { param($m) ($m | Where-Object name -CEQ 'rocksdbjni.vcxproj').name='rocksdbjni-shared.vcxproj' }
    Reject 'sibling project cannot replace packaged target' { Receive $bad } 'Unexpected candidate member name'
    $bad = Archive 'case-duplicate' { param($m) $m.Add(@{name='EXPORTS.TXT';bytes=[byte[]]@(1);attributes=0}) }
    Reject 'case-colliding name' { Receive $bad } 'Duplicate candidate archive name'
    $bad = Archive 'special' { param($m) $m[0].attributes = (0xA000 -shl 16) }
    Reject 'symlink member' { Receive $bad } 'special file refused'
    $bad = Archive 'hash' { param($m) ($m | Where-Object name -CEQ 'exports.txt').bytes=[byte[]]@(1,2,3) }
    Reject 'member length mismatch' { Receive $bad } 'length/name/hash refused'
    $bad = Archive 'same-length-tamper' { param($m) ($m | Where-Object name -CEQ 'exports.txt').bytes[0]=0 }
    Reject 'member digest mismatch' { Receive $bad } 'member hash mismatch'
    $bad = Archive 'missing' { param($m) Mutate-Manifest $m { param($m) $m.files=$m.files[1..($m.files.Count-1)] } }
    Reject 'manifest omission' { Receive $bad } 'member count mismatch'
    $bad = Archive 'duplicate-manifest' { param($m) Mutate-Manifest $m { param($m) $m.files[1]=$m.files[0] } }
    Reject 'duplicate manifest record' { Receive $bad } 'Manifest member mismatch'
    $bad = Archive 'wrong-source' { param($m) Mutate-Manifest $m { param($m) $m.sourceCommit='c'*40 } }
    Reject 'wrong source commit' { Receive $bad } 'identity mismatch'
    $bad = Archive 'wrong-total' { param($m) Mutate-Manifest $m { param($m) $m.totalBytes++ } }
    Reject 'wrong expanded total' { Receive $bad } 'Manifest total mismatch'
    $bad = Archive 'fractional-length' { param($m) Mutate-Manifest $m { param($m) $m.files[0].bytes=1.5 } }
    Reject 'fractional length' { Receive $bad } 'length/name/hash refused'
    $bad = Archive 'oversized-header' { param($m) ($m | Where-Object name -CEQ 'headers/org_rocksdb_Fixture.h').bytes=[byte[]]::new(256KB+1) }
    Reject 'oversized expanded header' { Receive $bad } 'entry size refused'
    $bad = Archive 'oversized-manifest' { param($m) ($m | Where-Object name -CEQ 'manifest.json').bytes=[byte[]]::new(256KB+1) }
    Reject 'oversized manifest' { Receive $bad } 'entry size refused'
    $bad = Archive 'missing-required' {
        param($m)
        $entry = @($m | Where-Object name -CEQ 'exports.txt')[0]
        $entry.name='headers/org_rocksdb_Extra.h'
        Mutate-Manifest $m { param($manifest) ($manifest.files | Where-Object name -CEQ 'exports.txt').name='headers/org_rocksdb_Extra.h' }
    }
    Reject 'otherwise valid missing required export report' { Receive $bad } 'Missing required candidate member'
    $bad = Archive 'wrong-report' {
        param($m)
        $entry=@($m | Where-Object name -CEQ 'report.json')[0]
        $report=[Text.Encoding]::UTF8.GetString($entry.bytes) | ConvertFrom-Json -AsHashtable
        $report.runId='99999'
        $entry.bytes=[Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json -Depth 8))
        $sha=[Security.Cryptography.SHA256]::Create()
        try { $entryHash=[Convert]::ToHexString($sha.ComputeHash($entry.bytes)).ToLowerInvariant() } finally { $sha.Dispose() }
        Mutate-Manifest $m { param($manifest) $r=($manifest.files | Where-Object name -CEQ 'report.json'); $r.bytes=$entry.bytes.Length; $r.sha256=$entryHash; $manifest.totalBytes=[long]($manifest.files | Measure-Object bytes -Sum).Sum }
    }
    Reject 'rehash does not hide report identity mismatch' { Receive $bad } 'Build report identity/status mismatch'
    $bad = Archive 'lying-expanded-length' {
        param($m)
        Mutate-Manifest $m {
            param($manifest)
            $record=($manifest.files | Where-Object name -CEQ 'headers/org_rocksdb_Fixture.h')
            $manifest.totalBytes -= $record.bytes - 1
            $record.bytes=1
        }
    }
    $zipBytes=[IO.File]::ReadAllBytes($bad)
    $patched=$false
    for ($i=0; $i -lt $zipBytes.Length-46; $i++) {
        if ([BitConverter]::ToUInt32($zipBytes,$i) -ne 0x02014b50) { continue }
        $nameLength=[BitConverter]::ToUInt16($zipBytes,$i+28)
        if ([Text.Encoding]::UTF8.GetString($zipBytes,$i+46,$nameLength) -ceq 'headers/org_rocksdb_Fixture.h') {
            [BitConverter]::GetBytes([uint32]1).CopyTo($zipBytes,$i+24)
            $patched=$true
            break
        }
    }
    if (-not $patched) { throw 'Missing test central directory member' }
    [IO.File]::WriteAllBytes($bad,$zipBytes)
    # This .NET runtime limits output to the central length; the original full
    # member hash then fails. Other runtimes may reject inside Read-NativeEntry.
    Reject 'lying expanded length cannot retain the original member' { Receive $bad } 'Candidate member hash mismatch'
    $bad = Archive 'newline-header' {
        param($m)
        ($m | Where-Object name -CEQ 'headers/org_rocksdb_Fixture.h').name += "`n"
        Mutate-Manifest $m { param($manifest) ($manifest.files | Where-Object name -CEQ 'headers/org_rocksdb_Fixture.h').name += "`n" }
    }
    Reject 'final newline in header name' { Receive $bad } 'Unexpected candidate member name'
    foreach ($field in @('schema','repository','sourceCommit','workflowCommit','runId','runAttempt')) {
        foreach ($values in @(@{label='empty'; value=@()},@{label='multiple';value=@('bad','bad')})) {
            $bad = Archive ('array-'+$field+'-'+$values.label) {
                param($m) Mutate-Manifest $m { param($manifest) $manifest[$field]=$values.value }
            }
            Reject ('manifest scalar '+$field+' '+$values.label) { Receive $bad } 'identity must use scalar strings'
        }
    }
    $bad = Archive 'array-total' { param($m) Mutate-Manifest $m { param($manifest) $manifest.totalBytes=@() } }
    Reject 'array total' { Receive $bad } 'total must be a bounded integer'
    foreach ($field in @('status','workflowCommit','runId','runAttempt','sourceCommit','candidateLoaded','databaseAcceptance','dll','jar')) {
        $bad = Archive ('report-array-'+$field) {
            param($m)
            $entry=@($m | Where-Object name -CEQ 'report.json')[0]
            $report=[Text.Encoding]::UTF8.GetString($entry.bytes) | ConvertFrom-Json -AsHashtable
            $report[$field]=@()
            $entry.bytes=[Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json -Depth 8))
            $sha=[Security.Cryptography.SHA256]::Create()
            try { $entryHash=[Convert]::ToHexString($sha.ComputeHash($entry.bytes)).ToLowerInvariant() } finally { $sha.Dispose() }
            Mutate-Manifest $m { param($manifest) $r=($manifest.files | Where-Object name -CEQ 'report.json'); $r.bytes=$entry.bytes.Length; $r.sha256=$entryHash; $manifest.totalBytes=[long]($manifest.files | Measure-Object bytes -Sum).Sum }
        }
        $reason = if ($field -in @('candidateLoaded','databaseAcceptance')) { 'must explicitly deny execution' } elseif ($field -in @('dll','jar')) { 'output record malformed' } else { 'identity must use scalar strings' }
        Reject ('report scalar '+$field) { Receive $bad } $reason
    }
    $bad = Archive 'duplicate-json-property' {
        param($m)
        $entry=@($m | Where-Object name -CEQ 'manifest.json')[0]
        $text=[Text.Encoding]::UTF8.GetString($entry.bytes).Replace('"schema":', '"schema":"invalid","schema":')
        $entry.bytes=[Text.Encoding]::UTF8.GetBytes($text)
    }
    Reject 'duplicate JSON property' { Receive $bad } 'Duplicate candidate JSON property'
    Write-Output "Native candidate static tests passed: $script:cases cases"
} finally {
    if (Test-Path -LiteralPath $root) {
        $verified = Assert-NativeScratchPath $root
        Remove-Item -LiteralPath $verified -Recurse -Force
    }
}
