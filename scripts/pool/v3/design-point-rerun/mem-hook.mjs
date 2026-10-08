// Disposable: peak JS heap, external, array buffers and RSS of this process, sampled every 50 ms, printed to stderr at exit.
const peak = { heapUsed: 0, external: 0, arrayBuffers: 0, rss: 0 };
setInterval(() => { const m = process.memoryUsage(); for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k], m[k]); }, 50).unref();
process.on("exit", () => process.stderr.write(`MEM ${JSON.stringify(Object.fromEntries(Object.entries(peak).map(([k, v]) => [k, Math.round(v / 1048576)])))} maxRSS ${Math.round(process.resourceUsage().maxRSS / 1024)}\n`));
