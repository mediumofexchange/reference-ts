// Disposable: node, serve and the two proxies of driver.mjs, then the given `moe` command under mem-hook.mjs (peak JS
// heap, external and array buffers, sampled every 50 ms) and an optional heap snapshot at its peak heap.
// Usage: node memprobe.mjs <moe args...>
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const WT = "/home/user/reference-ts/scratch/wt/depth", HERE = "/home/user/reference-ts/scratch/depth", RUN = join(HERE, "run");
const env = { ...process.env, MOE_DEPTH_BACKEND: join(WT, "dist/cli/backend.js"), MOE_DEPTH_PROOFS: join(RUN, "proofs.bin") };
const proxy = (port, to) => new Promise(done => { const s = createServer(c => { const u = connect(to, "127.0.0.1"); c.pipe(u); u.pipe(c); c.on("error", () => u.destroy()); u.on("error", () => c.destroy()); }); s.listen(port, "127.0.0.1", () => done(s)); });
const node = spawn(process.execPath, [join(HERE, "node.mjs"), WT, join(RUN, "node.log"), "39053"], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise(done => node.stdout.once("data", done));
const serve = spawn(process.execPath, ["--import", join(HERE, "standin-hook.mjs"), join(WT, "dist/cli/moe.js"), "operator", "serve", "--dir", join(RUN, "operator"),
  "--interval", "2", "--poll-ms", "100", "--port", "39055"], { cwd: RUN, stdio: ["ignore", "pipe", "inherit"], env });
await new Promise(done => { let s = ""; serve.stdout.on("data", c => { s += c; if (s.includes("\n")) done(); }); });
const p1 = await proxy(39054, 39053), p2 = await proxy(39056, 39055);
const began = performance.now();
const child = spawn(process.execPath, ["--import", join(HERE, "standin-hook.mjs"), "--import", join(HERE, "mem-hook.mjs"), join(WT, "dist/cli/moe.js"), ...process.argv.slice(2)],
  { cwd: RUN, stdio: ["ignore", "pipe", "inherit"], env });
let out = ""; child.stdout.on("data", c => { out += c; });
await new Promise(done => child.on("close", done));
console.log(JSON.stringify({ ms: Math.round(performance.now() - began), holdings: (() => { try { return JSON.parse(out.trim().split("\n").at(-1)).holdings?.length; } catch { return undefined; } })() }));
serve.kill("SIGTERM"); await new Promise(done => serve.on("close", done)); node.kill("SIGTERM"); p1.close(); p2.close();
