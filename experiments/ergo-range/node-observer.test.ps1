# Loopback-only controls for PID socket observations and bounded literal HTTP reads.
$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'NodeProbeProcess.cs')
$checks=0
$tcp=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,19053)
$tcp.Start()
$udp=[Net.Sockets.UdpClient]::new([Net.IPEndPoint]::new([Net.IPAddress]::Loopback,0))
try {
    $sockets=[NodeProbeProcess]::Sockets([uint32]$PID)
    if (-not ($sockets | Where-Object { $_.Protocol -eq 'tcp' -and $_.State -eq 2 -and $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -eq 19053 })) { throw 'TCP owner/address/port readback mismatch' }; $checks++
    if (-not ($sockets | Where-Object { $_.Protocol -eq 'udp' -and $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -eq $udp.Client.LocalEndPoint.Port })) { throw 'UDP owner/address/port readback mismatch' }; $checks++
    foreach ($case in @('success','redirect','encoding','utf8','bytes','timeout')) {
        $reader=[NodeProbeProcess+StartupReader]::new(); $client=$null
        try {
            $accept=$tcp.AcceptTcpClientAsync(); $task=$reader.ReadOnce('/info')
            if (-not $accept.Wait(2000)) { throw 'Test connection missing' }
            $client=$accept.GetAwaiter().GetResult(); $stream=$client.GetStream()
            # Read the tiny fixed GET request so malformed responses do not race connection setup.
            $stream.ReadTimeout=2000; $request=[byte[]]::new(4096)
            if ($stream.Read($request,0,$request.Length) -eq 0) { throw 'GET request missing' }
            $body=[Text.Encoding]::UTF8.GetBytes('{}'); $status='200 OK'; $extra=''
            switch ($case) {
                'redirect' { $status='302 Found'; $extra="Location: http://127.0.0.1:19053/utils/seed`r`n" }
                'encoding' { $extra="Content-Encoding: gzip`r`n" }
                'utf8' { $body=[byte[]]@(0xff) }
                'bytes' { $body=[byte[]]::new(1048577) }
            }
            if ($case -ne 'timeout') {
                $header=[Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $status`r`n${extra}Content-Length: $($body.Length)`r`nConnection: close`r`n`r`n")
                $stream.Write($header,0,$header.Length)
                try { $stream.Write($body,0,$body.Length) } catch [IO.IOException] { if ($case -ne 'encoding') { throw } }
                $client.Dispose(); $client=$null
            }
            $refused=$false; $reply=$null
            try { $reply=$task.GetAwaiter().GetResult() } catch { $refused=$true }
            if ($case -in @('success','redirect')) {
                $expected=if ($case -eq 'success') {200} else {302}
                if ($refused -or $reply.Status -ne $expected -or $reply.Body -ne '{}') { throw "Wrong result: $case" }
                if ($tcp.Pending()) { throw 'Reader followed redirect/retried request' }
                $duplicate=$reader.ReadOnce('/info'); $duplicateRefused=$false
                try { $duplicate.GetAwaiter().GetResult() | Out-Null } catch { $duplicateRefused=$true }
                if (-not $duplicateRefused) { throw 'Duplicate endpoint accepted' }; $checks++
            } elseif (-not $refused) { throw "Unsafe response accepted: $case" }
            $checks++
        } finally { if ($client) {$client.Dispose()}; $reader.Dispose() }
    }
    $reader=[NodeProbeProcess+StartupReader]::new()
    try {
        $bad=$reader.ReadOnce('/utils/seed'); $refused=$false
        try {$bad.GetAwaiter().GetResult() | Out-Null} catch {$refused=$true}
        if (-not $refused -or $tcp.Pending()) {throw 'Allowlist did not refuse before connection'}; $checks++
    } finally {$reader.Dispose()}
} finally { $tcp.Stop(); $udp.Dispose() }
Write-Output "Node observer controls passed ($checks cases; loopback only; no node launched)."
