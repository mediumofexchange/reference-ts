// Bounded metadata reads from the dedicated loopback Ergo sync probe only.
using System;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public sealed class NodeSyncReader : IDisposable {
    public sealed class ApiReply {
        public int Status, Bytes, Requests;
        public string Body;
        public long TotalBytes;
    }

    const int MaxRequests = 128, MaxResponseBytes = 1048576;
    const long MaxTotalBytes = 8388608;
    readonly object gate = new object();
    readonly HttpClient client;
    readonly CancellationTokenSource lifetime = new CancellationTokenSource();
    bool active, disposed;
    int requests;
    long bytes;

    public int Requests { get { lock (gate) return requests; } }
    public long Bytes { get { lock (gate) return bytes; } }

    public NodeSyncReader() {
        client = new HttpClient(new HttpClientHandler {
            AllowAutoRedirect = false, UseProxy = false, UseCookies = false,
            AutomaticDecompression = System.Net.DecompressionMethods.None
        });
        client.Timeout = Timeout.InfiniteTimeSpan;
    }

    static bool Allowed(string endpoint) {
        if (endpoint == "/info" || endpoint == "/peers/connected" || endpoint == "/wallet/status") return true;
        if (endpoint == null || endpoint.Length != 79 ||
            !endpoint.StartsWith("/blocks/", StringComparison.Ordinal) ||
            !endpoint.EndsWith("/header", StringComparison.Ordinal)) return false;
        for (int i = 8; i < 72; i++) {
            char c = endpoint[i];
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        }
        return true;
    }

    public async Task<ApiReply> Read(string endpoint) {
        if (!Allowed(endpoint)) throw new ArgumentException("Endpoint not allowed", "endpoint");
        CancellationTokenSource timeout;
        lock (gate) {
            if (disposed) throw new ObjectDisposedException("NodeSyncReader");
            if (active) throw new InvalidOperationException("Concurrent API read refused");
            if (requests >= MaxRequests || bytes >= MaxTotalBytes)
                throw new InvalidOperationException("API reader budget exhausted");
            timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            active = true;
            requests++;
        }
        try {
            using (timeout) {
                timeout.CancelAfter(5000); // Includes response headers and the entire body.
                using (var request = new HttpRequestMessage(HttpMethod.Get, "http://127.0.0.1:19053" + endpoint))
                using (var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false)) {
                    if (response.Content.Headers.ContentEncoding.Count != 0)
                        throw new InvalidDataException("Encoded API response refused");
                    long remaining;
                    lock (gate) remaining = MaxTotalBytes - bytes;
                    long? length = response.Content.Headers.ContentLength;
                    if (length.HasValue && (length.Value > MaxResponseBytes || length.Value > remaining))
                        throw new InvalidDataException("API response byte budget exceeded");
                    using (var input = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false))
                    using (var output = new MemoryStream()) {
                        var buffer = new byte[4096];
                        // Content-Length is HTTP framing, so no extra EOF byte is needed at an exact limit.
                        while (!length.HasValue || output.Length < length.Value) {
                            lock (gate) remaining = MaxTotalBytes - bytes;
                            if (remaining == 0)
                                throw new InvalidDataException("API total byte budget exhausted before body completion");
                            int capacity = (int)Math.Min(buffer.Length, Math.Min(remaining, MaxResponseBytes - output.Length + 1));
                            int count = await input.ReadAsync(buffer, 0, capacity, timeout.Token).ConfigureAwait(false);
                            if (count == 0) {
                                if (length.HasValue && output.Length != length.Value)
                                    throw new InvalidDataException("Incomplete API response body");
                                break;
                            }
                            // Failed bodies still consume the cumulative observation budget.
                            lock (gate) bytes += count;
                            if (output.Length + count > MaxResponseBytes)
                                throw new InvalidDataException("API response byte budget exceeded");
                            output.Write(buffer, 0, count);
                        }
                        string body = new UTF8Encoding(false, true).GetString(output.ToArray());
                        timeout.Token.ThrowIfCancellationRequested();
                        lock (gate) return new ApiReply {
                            Status = (int)response.StatusCode, Bytes = (int)output.Length, Body = body,
                            Requests = requests, TotalBytes = bytes
                        };
                    }
                }
            }
        } finally {
            lock (gate) active = false;
        }
    }

    public void Dispose() {
        lock (gate) {
            if (disposed) return;
            disposed = true;
        }
        try { lifetime.Cancel(); }
        finally { client.Dispose(); lifetime.Dispose(); }
    }
}
