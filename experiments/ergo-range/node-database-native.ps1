# Bounded file identity/copy for the offline worker. Never loads native code.
# Caller owns destination ancestors and cleanup on its fixed disposable volume.
function Confirm-DatabaseNative([string]$Source, [long]$ExpectedBytes,
    [string]$ExpectedSha256, [string]$Destination) {
    if ($ExpectedBytes -le 0 -or $ExpectedBytes -gt 32MB -or
        $ExpectedSha256 -cnotmatch '\A[0-9a-f]{64}\z') { throw 'Invalid native file expectation' }
    $sourcePath=[IO.Path]::GetFullPath($Source)
    $cursor=$sourcePath
    while ($cursor) {
        $item=Get-Item -Force -LiteralPath $cursor -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Native source redirection' }
        $cursor=[IO.Path]::GetDirectoryName($cursor)
    }
    if ((Get-Item -LiteralPath $sourcePath).PSIsContainer) { throw 'Expected native source file' }
    # Hold the same source handle through hashing and copying. Recheck at use,
    # even when an earlier read-only preflight succeeded. Host stability remains
    # assumed; this is not isolation from a hostile concurrent administrator.
    $inputStream=[IO.File]::Open($sourcePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        if ($inputStream.Length -ne $ExpectedBytes) { throw 'Native source length mismatch' }
        $hasher=[Security.Cryptography.SHA256]::Create()
        try { $hash=[Convert]::ToHexString($hasher.ComputeHash($inputStream)).ToLowerInvariant() }
        finally { $hasher.Dispose() }
        if ($hash -cne $ExpectedSha256) { throw 'Native source hash mismatch' }
        if ($Destination) {
            $inputStream.Position=0
            $outputStream=[IO.File]::Open($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
            try {
                $buffer=[byte[]]::new(65536);$written=0L
                while (($count=$inputStream.Read($buffer,0,$buffer.Length)) -gt 0) {
                    $written+=$count
                    if ($written -gt $ExpectedBytes) { throw 'Native copy exceeded length' }
                    $outputStream.Write($buffer,0,$count)
                }
                if ($written -ne $ExpectedBytes -or $outputStream.Length -ne $ExpectedBytes) { throw 'Native copy length mismatch' }
                $outputStream.Flush();$outputStream.Position=0
                $hasher=[Security.Cryptography.SHA256]::Create()
                try { $copiedHash=[Convert]::ToHexString($hasher.ComputeHash($outputStream)).ToLowerInvariant() }
                finally { $hasher.Dispose() }
                if ($copiedHash -cne $ExpectedSha256) { throw 'Native copy hash mismatch' }
            } finally { $outputStream.Dispose() }
        }
        return [ordered]@{source=$sourcePath;bytes=$ExpectedBytes;sha256=$hash;copied=[bool]$Destination}
    } finally { $inputStream.Dispose() }
}
