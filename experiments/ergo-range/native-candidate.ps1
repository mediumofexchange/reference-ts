# Static candidate packaging/import only. Never executes Java or loads a DLL.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:NativeSource = '4b2122578e475cb88aef4dcf152cccd5dbf51060'
$script:NativeMaxBytes = 80MB
$script:NativeMaxFiles = 300

function Assert-NativeScratchPath([string]$Path) {
    $scratch = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../scratch'))
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($scratch + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Candidate path must be below repository scratch'
    }
    $current = $full
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -Force -LiteralPath $current
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Candidate path contains a link' }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
    return $full
}

function Get-NativeFileLimit([string]$Name) {
    switch -CaseSensitive ($Name) {
        'librocksdbjni-win64.dll' { return 32MB }
        'rocksdbjni-10.2.1-win64.jar' { return 32MB }
        'report.json' { return 1MB }
        'CMakeCache.txt' { return 1MB }
        'rocksdbjni.vcxproj' { return 4MB }
        'build_version.cc' { return 64KB }
        'exports.txt' { return 1MB }
        'imports.txt' { return 1MB }
        'native-build-inputs.json' { return 64KB }
    }
    if ($Name -cmatch '\Aheaders/org_rocksdb_[A-Za-z0-9_]+\.h\z') { return 256KB }
    throw 'Unexpected candidate member name'
}

function Assert-NativeIdentity($Manifest, [string]$WorkflowCommit, [string]$RunId, [string]$RunAttempt) {
    if ($Manifest -isnot [Collections.IDictionary]) { throw 'Candidate manifest must be an object' }
    foreach ($field in @('schema','repository','sourceCommit','workflowCommit','runId','runAttempt')) {
        if ($Manifest[$field] -isnot [string]) { throw 'Candidate identity must use scalar strings' }
    }
    if ($WorkflowCommit -cnotmatch '\A[0-9a-f]{40}\z' -or $RunId -cnotmatch '\A[1-9][0-9]{0,19}\z' -or
        $RunAttempt -cnotmatch '\A[1-9][0-9]{0,5}\z') { throw 'Invalid expected workflow identity' }
    if ($Manifest.schema -cne 'moe-rocksdb-candidate-v1' -or
        $Manifest.repository -cne 'mediumofexchange/reference-ts' -or
        $Manifest.sourceCommit -cne $script:NativeSource -or
        $Manifest.workflowCommit -cne $WorkflowCommit -or $Manifest.runId -cne $RunId -or
        $Manifest.runAttempt -cne $RunAttempt) { throw 'Candidate workflow/source identity mismatch' }
}

function Assert-NativeReport($Report, [string]$WorkflowCommit, [string]$RunId, [string]$RunAttempt) {
    if ($Report -isnot [Collections.IDictionary]) { throw 'Build report must be an object' }
    foreach ($field in @('status','sourceCommit','workflowCommit','runId','runAttempt')) {
        if ($Report[$field] -isnot [string]) { throw 'Build report identity must use scalar strings' }
    }
    foreach ($field in @('candidateLoaded','databaseAcceptance')) {
        if ($Report[$field] -isnot [bool] -or $Report[$field]) { throw 'Build report must explicitly deny execution' }
    }
    if ($Report.status -cne 'compiled-unadopted-native-candidate' -or $Report.workflowCommit -cne $WorkflowCommit -or
        $Report.runId -cne $RunId -or $Report.runAttempt -cne $RunAttempt -or
        $Report.sourceCommit -cne $script:NativeSource) { throw 'Build report identity/status mismatch' }
    foreach ($field in @('dll','jar')) {
        $record = $Report[$field]
        if ($record -isnot [Collections.IDictionary] -or ($record.bytes -isnot [long] -and $record.bytes -isnot [int]) -or
            $record.bytes -le 0 -or $record.bytes -gt 32MB -or $record.sha256 -isnot [string] -or
            $record.sha256 -cnotmatch '\A[0-9a-f]{64}\z') { throw 'Build report output record malformed' }
    }
}

function ConvertFrom-NativeJson([string]$Text) {
    function Check-JsonKeys([Text.Json.JsonElement]$Element) {
        if ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Object) {
            $keys = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            foreach ($property in $Element.EnumerateObject()) {
                if (-not $keys.Add($property.Name)) { throw 'Duplicate candidate JSON property' }
                Check-JsonKeys $property.Value
            }
        } elseif ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Array) {
            foreach ($value in $Element.EnumerateArray()) { Check-JsonKeys $value }
        }
    }
    $options = [Text.Json.JsonDocumentOptions]::new()
    $options.MaxDepth = 32
    $document = [Text.Json.JsonDocument]::Parse($Text,$options)
    try {
        if ($document.RootElement.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw 'Candidate JSON root must be an object' }
        Check-JsonKeys $document.RootElement
    } finally { $document.Dispose() }
    return ConvertFrom-Json -InputObject $Text -AsHashtable -Depth 32
}

function Read-NativeEntry($Entry, [switch]$Text, $OutputStream=$null) {
    $stream = $Entry.Open()
    $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
    $memory = if ($Text) { [IO.MemoryStream]::new() } else { $null }
    try {
        $buffer = [byte[]]::new(8192)
        [long]$count = 0
        while (($read = $stream.Read($buffer,0,$buffer.Length)) -ne 0) {
            $count += $read
            if ($count -gt $Entry.Length) { throw 'Candidate entry expanded beyond declared length' }
            $hash.AppendData($buffer,0,$read)
            if ($memory) { $memory.Write($buffer,0,$read) }
            if ($OutputStream) { $OutputStream.Write($buffer,0,$read) }
        }
        if ($count -ne $Entry.Length) { throw 'Candidate entry truncated' }
        return @{sha256=[Convert]::ToHexString($hash.GetHashAndReset()).ToLowerInvariant();
            text=$(if ($memory) { [Text.UTF8Encoding]::new($false,$true).GetString($memory.ToArray()) } else { $null })}
    } finally {
        $stream.Dispose(); $hash.Dispose()
        if ($memory) { $memory.Dispose() }
    }
}

function Export-NativeCandidate([string]$Root, $Report) {
    $rootPath = Assert-NativeScratchPath $Root
    $destination = Assert-NativeScratchPath (Join-Path $rootPath 'candidate')
    if (Test-Path -LiteralPath $destination) { throw 'Candidate staging directory must be absent' }
    Assert-NativeReport $Report $Report.workflowCommit $Report.runId $Report.runAttempt
    $manifest = [ordered]@{schema='moe-rocksdb-candidate-v1'; repository='mediumofexchange/reference-ts';
        sourceCommit=$Report.sourceCommit; workflowCommit=$Report.workflowCommit; runId=$Report.runId;
        runAttempt=$Report.runAttempt; files=@(); totalBytes=0L}
    Assert-NativeIdentity $manifest $Report.workflowCommit $Report.runId $Report.runAttempt
    $build = Join-Path $rootPath 'build'
    $inputs = [ordered]@{
        'librocksdbjni-win64.dll' = (Join-Path $build 'java/Release/librocksdbjni-win64.dll')
        'rocksdbjni-10.2.1-win64.jar' = (Join-Path $build 'java/rocksdbjni-10.2.1-win64.jar')
        'CMakeCache.txt' = (Join-Path $build 'CMakeCache.txt')
        'rocksdbjni.vcxproj' = (Join-Path $build 'java/rocksdbjni.vcxproj')
        'build_version.cc' = (Join-Path $build 'build_version.cc')
        'exports.txt' = (Join-Path $rootPath 'exports.txt')
        'imports.txt' = (Join-Path $rootPath 'imports.txt')
    }
    $headersPath = Assert-NativeScratchPath (Join-Path $rootPath 'source/java/include')
    $headers = @(Get-ChildItem -LiteralPath $headersPath -Force)
    if ($headers.Count -eq 0 -or $headers.Count -gt 256) { throw 'Unexpected generated header count' }
    foreach ($header in $headers) { $inputs['headers/'+$header.Name] = $header.FullName }
    New-Item -ItemType Directory -Path $destination | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $destination 'headers') | Out-Null
    # Report is finalized before staging; manifest hashes the exact retained bytes.
    $reportPath = Join-Path $destination 'report.json'
    $Report | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 -LiteralPath $reportPath
    $inputs['report.json'] = $reportPath
    $pinsPath = Join-Path $destination 'native-build-inputs.json'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'native-build-inputs.json') -Destination $pinsPath
    $inputs['native-build-inputs.json'] = $pinsPath
    [long]$headerBytes = 0
    foreach ($name in $inputs.Keys) {
        $limit = Get-NativeFileLimit $name
        $path = Assert-NativeScratchPath $inputs[$name]
        $file = Get-Item -Force -LiteralPath $path
        if ($file.PSIsContainer -or $file.Length -le 0 -or $file.Length -gt $limit) { throw 'Candidate member size/type refused' }
        $record = [ordered]@{name=$name; bytes=$file.Length; sha256=(Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant()}
        $manifest.totalBytes += $file.Length
        if ($manifest.totalBytes -gt $script:NativeMaxBytes) { throw 'Candidate expanded size exceeded' }
        if ($name.StartsWith('headers/')) {
            $headerBytes += $file.Length
            if ($headerBytes -gt 8MB) { throw 'Candidate generated headers exceed 8 MiB' }
        }
        if ($name -cnotin @('report.json','native-build-inputs.json')) { Copy-Item -LiteralPath $path -Destination (Join-Path $destination $name) }
        if ((Get-FileHash -LiteralPath (Join-Path $destination $name)).Hash.ToLowerInvariant() -cne $record.sha256) { throw 'Staged candidate copy differs' }
        $manifest.files += $record
    }
    if ($manifest.files.Count -gt $script:NativeMaxFiles) { throw 'Candidate file count exceeded' }
    foreach ($pair in @(@('librocksdbjni-win64.dll','dll'),@('rocksdbjni-10.2.1-win64.jar','jar'))) {
        $record = @($manifest.files | Where-Object name -CEQ $pair[0])[0]
        if ($record.bytes -ne $Report[$pair[1]].bytes -or $record.sha256 -cne $Report[$pair[1]].sha256) { throw 'Output changed after build inspection' }
    }
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $destination 'manifest.json')
    if ((Get-Item -LiteralPath (Join-Path $destination 'manifest.json')).Length -gt 256KB) { throw 'Candidate manifest size exceeded' }
    return $manifest
}

function Import-NativeCandidate([string]$Archive, [string]$ArchiveSha256, [string]$WorkflowCommit,
    [string]$RunId, [string]$RunAttempt, [string]$Destination) {
    $archivePath = Assert-NativeScratchPath $Archive
    $destinationPath = Assert-NativeScratchPath $Destination
    if (Test-Path -LiteralPath $destinationPath) { throw 'Candidate destination must be absent' }
    if ($ArchiveSha256 -cnotmatch '\A[0-9a-f]{64}\z') { throw 'Expected archive SHA-256 required' }
    $temporaryPath = $null
    $file = [IO.File]::Open($archivePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($file.Length -le 0 -or $file.Length -gt 81MB) { throw 'Candidate archive size exceeded' }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $digest = [Convert]::ToHexString($sha.ComputeHash($file)).ToLowerInvariant() } finally { $sha.Dispose() }
        if ($digest -cne $ArchiveSha256) { throw 'Candidate archive hash mismatch' }
        $file.Position = 0
        $zip = [IO.Compression.ZipArchive]::new($file, [IO.Compression.ZipArchiveMode]::Read, $true)
        try {
            if ($zip.Entries.Count -lt 11 -or $zip.Entries.Count -gt $script:NativeMaxFiles + 1) { throw 'Candidate archive entry count refused' }
            $entries = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
            [long]$total = 0
            [long]$headerBytes = 0
            foreach ($entry in $zip.Entries) {
                if (-not $entries.TryAdd($entry.FullName,$entry)) { throw 'Duplicate candidate archive name' }
                $limit = if ($entry.FullName -ceq 'manifest.json') { 256KB } else { Get-NativeFileLimit $entry.FullName }
                if ($entry.Length -le 0 -or $entry.Length -gt $limit) { throw 'Candidate entry size refused' }
                $total += $entry.Length
                if ($total -gt $script:NativeMaxBytes + 256KB) { throw 'Candidate archive expanded size exceeded' }
                if ($entry.FullName.StartsWith('headers/')) {
                    $headerBytes += $entry.Length
                    if ($headerBytes -gt 8MB) { throw 'Candidate generated headers exceed 8 MiB' }
                }
                # Unix symlinks and other special files are never candidate members.
                $kind = ($entry.ExternalAttributes -shr 16) -band 0xF000
                if ($kind -notin @(0,0x8000)) { throw 'Candidate archive special file refused' }
            }
            if (-not $entries.ContainsKey('manifest.json')) { throw 'Missing candidate manifest' }
            $manifestText = (Read-NativeEntry $entries['manifest.json'] -Text).text
            $manifest = ConvertFrom-NativeJson $manifestText
            Assert-NativeIdentity $manifest $WorkflowCommit $RunId $RunAttempt
            if ($manifest.files -isnot [array] -or $manifest.files.Count -ne $entries.Count - 1) { throw 'Manifest member count mismatch' }
            if (($manifest.totalBytes -isnot [long] -and $manifest.totalBytes -isnot [int]) -or
                $manifest.totalBytes -le 0 -or $manifest.totalBytes -gt $script:NativeMaxBytes) { throw 'Manifest total must be a bounded integer' }
            $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            [long]$declared = 0
            foreach ($record in $manifest.files) {
                if ($record -isnot [Collections.IDictionary] -or $record.name -isnot [string] -or $record.sha256 -isnot [string]) { throw 'Manifest file record must use scalar strings' }
                [void](Get-NativeFileLimit $record.name)
                if (-not $seen.Add($record.name) -or -not $entries.ContainsKey($record.name)) { throw 'Manifest member mismatch' }
                $entry = $entries[$record.name]
                if ($record.name -cne $entry.FullName -or $record.bytes -isnot [long] -and $record.bytes -isnot [int] -or
                    $record.bytes -ne $entry.Length -or $record.sha256 -cnotmatch '\A[0-9a-f]{64}\z') { throw 'Manifest member length/name/hash refused' }
                $digest = (Read-NativeEntry $entry).sha256
                if ($digest -cne $record.sha256) { throw 'Candidate member hash mismatch' }
                $declared += $record.bytes
            }
            if ($declared -gt $script:NativeMaxBytes -or $manifest.totalBytes -ne $declared) { throw 'Manifest total mismatch' }
            foreach ($required in @('librocksdbjni-win64.dll','rocksdbjni-10.2.1-win64.jar','report.json',
                'CMakeCache.txt','rocksdbjni.vcxproj','build_version.cc','exports.txt','imports.txt','native-build-inputs.json')) {
                if (-not $seen.Contains($required)) { throw 'Missing required candidate member' }
            }
            $headerCount = @($manifest.files | Where-Object { $_.name.StartsWith('headers/') }).Count
            if ($headerCount -eq 0 -or $headerCount -gt 256) { throw 'Unexpected generated header count' }
            $pinsHash = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'native-build-inputs.json')).Hash.ToLowerInvariant()
            if ((Read-NativeEntry $entries['native-build-inputs.json']).sha256 -cne $pinsHash) { throw 'Retained build inputs differ from reviewed pins' }
            $report = ConvertFrom-NativeJson (Read-NativeEntry $entries['report.json'] -Text).text
            Assert-NativeReport $report $WorkflowCommit $RunId $RunAttempt
            foreach ($pair in @(@('librocksdbjni-win64.dll','dll'),@('rocksdbjni-10.2.1-win64.jar','jar'))) {
                $record = @($manifest.files | Where-Object name -CEQ $pair[0])[0]
                if ($record.bytes -ne $report[$pair[1]].bytes -or $record.sha256 -cne $report[$pair[1]].sha256) { throw 'Build report output mismatch' }
            }
            # Every byte and name is verified before creating an extraction directory.
            $temporaryPath = Assert-NativeScratchPath ($destinationPath+'.partial-'+[guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $temporaryPath | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $temporaryPath 'headers') | Out-Null
            foreach ($entry in $zip.Entries) {
                $outputStream = [IO.File]::Open((Join-Path $temporaryPath $entry.FullName), [IO.FileMode]::CreateNew)
                try {
                    [void](Read-NativeEntry $entry -OutputStream $outputStream)
                } finally { $outputStream.Dispose() }
            }
            [void](Assert-NativeScratchPath $destinationPath)
            [IO.Directory]::Move($temporaryPath,$destinationPath)
            $temporaryPath = $null
            return $manifest
        } finally { $zip.Dispose() }
    } finally {
        $file.Dispose()
        if ($temporaryPath -and (Test-Path -LiteralPath $temporaryPath)) {
            # Only the random directory created by this call is eligible for cleanup.
            [void](Assert-NativeScratchPath $temporaryPath)
            $created = @(Get-ChildItem -Force -LiteralPath $temporaryPath -Recurse)
            if (@($created | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -ne 0) { throw 'Partial candidate cleanup refused a link' }
            Remove-Item -LiteralPath $temporaryPath -Recurse -Force
        }
    }
}
