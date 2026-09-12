# Fixed loopback fake HTTP server only; no Ergo, peers, or disk launch.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Add-Type -Path (Join-Path $PSScriptRoot 'NodeSyncReader.cs')
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
public sealed class SyncReaderTestServer : IDisposable {
    readonly TcpListener listener = new TcpListener(IPAddress.Loopback, 19053);
    readonly CancellationTokenSource stop = new CancellationTokenSource();
    readonly Task running;
    public byte[] Body = Encoding.UTF8.GetBytes("{}");
    public string Status = "200 OK", Extra = "", LastRequest;
    public int DelayMs, Accepted;
    public bool Chunked;
    public SyncReaderTestServer() {
        listener.ExclusiveAddressUse = true;
        listener.Start(); // Refuse an occupied probe port; never use another listener.
        running = Task.Run(async () => {
            try {
                while (!stop.IsCancellationRequested) {
                    using (var peer = await listener.AcceptTcpClientAsync(stop.Token))
                    using (var stream = peer.GetStream()) {
                        Interlocked.Increment(ref Accepted);
                        var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                        LastRequest = await reader.ReadLineAsync(stop.Token);
                        while (!String.IsNullOrEmpty(await reader.ReadLineAsync(stop.Token))) { }
                        var data = Body;
                        string framing = Chunked ? "Transfer-Encoding: chunked\r\n" : "Content-Length: " + data.Length + "\r\n";
                        byte[] header = Encoding.ASCII.GetBytes("HTTP/1.1 " + Status + "\r\n" + framing + Extra + "Connection: close\r\n\r\n");
                        try {
                            await stream.WriteAsync(header, stop.Token);
                            await stream.FlushAsync(stop.Token);
                            await Task.Delay(DelayMs, stop.Token);
                            if (Chunked) await stream.WriteAsync(Encoding.ASCII.GetBytes(data.Length.ToString("x") + "\r\n"), stop.Token);
                            await stream.WriteAsync(data, stop.Token);
                            if (Chunked) await stream.WriteAsync(Encoding.ASCII.GetBytes("\r\n0\r\n\r\n"), stop.Token);
                        } catch (IOException) { } // Expected when the reader refuses a body.
                    }
                }
            } catch (OperationCanceledException) { }
        });
    }
    public void Dispose() {
        stop.Cancel(); listener.Stop();
        try { running.GetAwaiter().GetResult(); } finally { stop.Dispose(); }
    }
}
'@
$cases=0
function Assert-True([bool]$condition,[string]$message) {
    if (-not $condition) { throw $message }
    $script:cases++
}
function Expect-Refusal([scriptblock]$action,[string]$message) {
    $failed=$false
    try { & $action | Out-Null } catch { $failed=$true }
    Assert-True $failed $message
}
function Read-Reply([NodeSyncReader]$reader,[string]$path='/info') {
    $reader.Read($path).GetAwaiter().GetResult()
}
$reader=[NodeSyncReader]::new()
$server=$null
try {
    $id='a'*64
    foreach ($path in @('', '/INFO', '/info?x=1', '/wallet/addresses', '/blocks/at/1',
        '/blocks/chainSlice', "http://127.0.0.1:19053/info", '//example.com/info',
        ('/blocks/'+('A'*64)+'/header'), ('/blocks/'+('a'*63)+'/header'),
        ('/blocks/'+('a'*63)+'g/header'), ('/blocks/'+$id+'/header/'),
        ('/blocks/'+$id+'/header?x=1'), ('/blocks/'+$id+'/transactions'))) {
        Expect-Refusal { Read-Reply $reader $path } "Invalid endpoint accepted: $path"
    }
    Assert-True ($reader.Requests -eq 0 -and $reader.Bytes -eq 0) 'Invalid paths consumed admission budget'
    $server=[SyncReaderTestServer]::new()
    foreach ($path in @('/info','/peers/connected','/wallet/status',('/blocks/'+$id+'/header'),'/info')) {
        $reply=Read-Reply $reader $path
        Assert-True ($reply.Status -eq 200 -and $reply.Body -ceq '{}' -and $reply.Bytes -eq 2) 'Metadata reply mismatch'
        Assert-True ($server.LastRequest -ceq "GET $path HTTP/1.1") 'Request escaped the fixed GET endpoint'
    }
    Assert-True ($reply.Requests -eq 5 -and $reply.TotalBytes -eq 10 -and $reader.Requests -eq 5 -and $reader.Bytes -eq 10) 'Cumulative reply counters mismatch'
    $server.Status='302 Found'; $server.Extra="Location: http://127.0.0.1:1/disallowed`r`n"
    $reply=Read-Reply $reader
    Assert-True ($reply.Status -eq 302 -and $reader.Requests -eq 6) 'Redirect was followed or hidden'
    $server.Status='200 OK'; $server.Extra="Content-Encoding: gzip`r`n"
    Expect-Refusal { Read-Reply $reader } 'Encoded response accepted'
    Assert-True ($reader.Bytes -eq 12 -and $reader.Requests -eq 7) 'Encoded refusal accounting mismatch'
    $server.Extra=''; $server.Body=[byte[]]@(255)
    Expect-Refusal { Read-Reply $reader } 'Malformed UTF-8 accepted'
    Assert-True ($reader.Bytes -eq 13 -and $reader.Requests -eq 8) 'Failed body bytes were not counted'
    $server.Body=[byte[]]::new(1048577)
    Expect-Refusal { Read-Reply $reader } 'Oversized declared body accepted'
    Assert-True ($reader.Bytes -eq 13) 'Oversized declared body was read'
    $server.Chunked=$true
    Expect-Refusal { Read-Reply $reader } 'Oversized chunked body accepted'
    Assert-True ($reader.Bytes -eq (13+1048577)) 'Observed oversized body bytes were lost'
    $server.Chunked=$false; $server.Body=[Text.Encoding]::UTF8.GetBytes('{}')
    $reader.Dispose(); $reader.Dispose()
    Expect-Refusal { Read-Reply $reader } 'Disposed reader admitted a request'

    $reader=[NodeSyncReader]::new()
    for ($i=0; $i -lt 128; $i++) { $reply=Read-Reply $reader }
    Assert-True ($reply.Requests -eq 128 -and $reply.TotalBytes -eq 256) 'Repeated reads did not reach exact request limit'
    $accepted=$server.Accepted
    Expect-Refusal { Read-Reply $reader } 'Request 129 accepted'
    Assert-True ($reader.Requests -eq 128 -and $server.Accepted -eq $accepted) 'Request-limit refusal reached HTTP'
    $reader.Dispose(); $reader=[NodeSyncReader]::new()
    $server.Body=[Text.Encoding]::UTF8.GetBytes(('x'*1048576))
    for ($i=0; $i -lt 8; $i++) { $reply=Read-Reply $reader }
    Assert-True ($reply.Bytes -eq 1048576 -and $reply.TotalBytes -eq 8388608) 'Exact body/aggregate byte boundary failed'
    Expect-Refusal { Read-Reply $reader } 'Read after aggregate limit accepted'
    Assert-True ($reader.Requests -eq 8 -and $reader.Bytes -eq 8388608) 'Aggregate-limit refusal changed counters'
    $reader.Dispose(); $reader=[NodeSyncReader]::new()
    $server.Chunked=$true
    for ($i=0; $i -lt 7; $i++) { $reply=Read-Reply $reader }
    Expect-Refusal { Read-Reply $reader } 'Unknown-length completion at exhausted aggregate budget was assumed'
    Assert-True ($reader.Requests -eq 8 -and $reader.Bytes -eq 8388608) 'Unknown-length body exceeded aggregate observation limit'
    $reader.Dispose(); $reader=[NodeSyncReader]::new()
    $server.Chunked=$false
    $server.Body=[Text.Encoding]::UTF8.GetBytes('{}'); $server.DelayMs=250
    $pending=$reader.Read('/info')
    Expect-Refusal { Read-Reply $reader } 'Concurrent request accepted'
    $reply=$pending.GetAwaiter().GetResult()
    Assert-True ($reply.Requests -eq 1) 'Concurrent refusal consumed request budget'
    $pending=$reader.Read('/info')
    $reader.Dispose(); $reader.Dispose()
    Expect-Refusal { $pending.GetAwaiter().GetResult() } 'Disposal did not cancel an active request'
    $reader=[NodeSyncReader]::new()
    $server.DelayMs=6000
    $watch=[Diagnostics.Stopwatch]::StartNew()
    Expect-Refusal { Read-Reply $reader } 'Slow body exceeded request deadline'
    Assert-True ($watch.ElapsedMilliseconds -ge 4500 -and $watch.ElapsedMilliseconds -lt 6000) 'Deadline did not cover the response body'
    $reader.Dispose(); $reader.Dispose()
    "Node sync reader checks passed ($cases cases; fixed loopback fake server only)."
} finally {
    $reader.Dispose()
    if ($server) { $server.Dispose() }
}
