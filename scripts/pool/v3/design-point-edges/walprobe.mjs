// Probe (slice 15 (az)), disposable: over the wallet run (node, serve, proxies as memprobe-wal.mjs), a reader's and a
// seed-restored wallet's first `reader supply` / `wallet sync`, then each again with nothing new, every command under
// mem-hook.mjs (peak heap, external, array buffers, RSS) and the stand-in verifier. Results append to RUN/walprobe.jsonl.
// Usage: DPR_WT=<worktree> DPR_RUN=<run> node walprobe.mjs <label>
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cpus } from "node:os";
const WT = process.env.DPR_WT, HERE = "/home/user/reference-ts/scratch/dpr", RUN = process.env.DPR_RUN, label = process.argv[2] ?? "run";
const { PARAMETER_DIRECTORY } = await import(join(WT, "scripts/pool/prepare-crs.mjs"));
const env = { ...process.env, MOE_DEPTH_BACKEND: join(WT, "dist/cli/backend.js"), MOE_DEPTH_PROOFS: join(RUN, "proofs.bin") };
const proxy = (port, to) => new Promise(done => { const s = createServer(c => { const u = connect(to, "127.0.0.1"); c.pipe(u); u.pipe(c); c.on("error", () => u.destroy()); u.on("error", () => c.destroy()); }); s.listen(port, "127.0.0.1", () => done(s)); });
const node = spawn(process.execPath, [join(HERE, "node.mjs"), WT, join(RUN, "node.log"), "39153"], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise(done => node.stdout.once("data", done));
const serve = spawn(process.execPath, ["--import", join(HERE, "standin-hook.mjs"), join(WT, "dist/cli/moe.js"), "operator", "serve", "--dir", join(RUN, "operator"),
  "--interval", "2", "--poll-ms", "100", "--port", "39155"], { cwd: RUN, stdio: ["ignore", "pipe", "inherit"], env });
await new Promise(done => { let s = ""; serve.stdout.on("data", c => { s += c; if (s.includes("\n")) done(); }); });
const p1 = await proxy(39154, 39153), p2 = await proxy(39156, 39155);
const service = JSON.parse(readFileSync(join(RUN, "operator", "service.json"), "utf8")), proxied = join(RUN, "service-proxied.json");
writeFileSync(proxied, JSON.stringify({ url: "http://127.0.0.1:39156/", walletToken: service.walletToken }));
const state = JSON.parse(readFileSync(join(RUN, "state.json"), "utf8"));
const extra = (process.env.DPR_NODE_FLAGS ?? "").split(" ").filter(Boolean);
const moe = (args, { input, hooked = false } = {}) => new Promise((done, failed) => {
  const began = performance.now();
  const child = spawn(process.execPath, ["--import", join(HERE, "standin-hook.mjs"), ...(hooked ? ["--import", join(HERE, "mem-hook.mjs"), ...extra] : []), join(WT, "dist/cli/moe.js"), ...args],
    { cwd: RUN, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env });
  if (input !== undefined) child.stdin.end(input);
  let out = "", err = "";
  child.stdout.on("data", c => { out += c; }); child.stderr.on("data", c => { err += c; });
  child.on("close", status => {
    if (status !== 0) return failed(new Error(`moe ${args.join(" ")} exited ${status}: ${err.slice(-2000)}`));
    const mem = err.match(/MEM (\{.*\}) maxRSS (\d+)/), json = JSON.parse(out.trim().split("\n").at(-1));
    done({ ms: Math.round(performance.now() - began), holdings: json.holdings?.length, stdoutMb: +(out.length / 1048576).toFixed(1),
      ...(mem ? { peak: JSON.parse(mem[1]), maxRssMb: Number(mem[2]) } : {}) });
  });
});
const nodeArgs = ["--node", "http://127.0.0.1:39154", "--parameters", PARAMETER_DIRECTORY];
const termsArgs = ["--terms", state.terms, "--signature", state.signature, "--synthetic"];
const reader = join(RUN, `reader-${label}`), wallet = join(RUN, `wallet-${label}`), record = entry => appendFileSync(join(RUN, "walprobe.jsonl"), `${JSON.stringify({ label, cpu: cpus()[0].model, ...entry })}\n`);
try {
  if (process.env.DPR_ONLY_WALLET) { record({ pass: "only", command: "wallet sync", ...(await moe(["wallet", "sync", "--dir", process.env.DPR_ONLY_WALLET, state.backing], { hooked: true })) }); } else {
  for (const d of [reader, wallet]) rmSync(d, { recursive: true, force: true });
  await moe(["reader", "init", "--dir", reader, "--venue", state.venueFile, ...nodeArgs]);
  await moe(["reader", "terms", "add", "--dir", reader, state.backing, ...termsArgs]);
  await moe(["reader", "service", "add", "--dir", reader, state.backing, proxied]);
  await moe(["wallet", "restore-seed", "--dir", wallet, "--venue", state.venueFile, ...nodeArgs], { input: `${state.seed}\n` });
  await moe(["wallet", "terms", "add", "--dir", wallet, state.backing, ...termsArgs]);
  await moe(["wallet", "service", "add", "--dir", wallet, state.backing, proxied]);
  for (const pass of ["first", "idle", "idle2"]) {
    record({ pass, command: "reader supply", ...(await moe(["reader", "supply", "--dir", reader, state.backing], { hooked: true })) });
    record({ pass, command: "wallet sync", ...(await moe(["wallet", "sync", "--dir", wallet, state.backing], { hooked: true })) });
  }
} } finally {
  serve.kill("SIGTERM"); await new Promise(done => serve.on("close", done)); node.kill("SIGTERM"); p1.close(); p2.close();
}
