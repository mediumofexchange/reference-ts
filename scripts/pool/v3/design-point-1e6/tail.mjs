// The 10⁶ run's tail (slice 18, disposable): once driver.mjs's report is done, this copy of it starts the node and a fresh
// serve on the same run and admits --tail more stand-ins (default 3,000) with nothing else on the host, recording every
// admission's time in RUN/tail-report.json (as slice 15's 3,000 at 10⁵), so the waits during the journal's own read are
// read one by one instead of from band percentiles that also hold ordinary admissions over 300 ms. It writes neither
// state.json nor report.json. Usage: node tail.mjs [--tail 3000] [--per-block 14] (9 gives about 27 statements a checkpoint, the design point's peak 28; the run's 14 gives 42); the report is RUN/tail-report-<per-block>.json. The rest of this header is driver.mjs's.
// The 10⁶ design-point run (WORK.md Open questions; probe, disposable, retires once the design point records it): M13h's
// driver (at 51ea592, scripts/pool/v3/design-point-rerun) as slice 15 ran it (at defc7ee), made to run for days on the
// Windows PC. Changes from slice 15's:
// - Windows: every process samples its own memory and CPU (sample-hook.mjs) in place of /proc; dist, hooks and the
//   verifier's backend are imported as file URLs; serve is stopped outright (Windows has no SIGTERM handler) and no heap
//   snapshot is taken by signal. The CRS is the main checkout's retained scratch/private-payment-crs.
// - Every process of the run is raised to above-normal priority, and each band records the host's whole CPU beside
//   serve's, so other work on the PC shows instead of passing for the runtime's.
// - The holder's holdings stop growing at --holdings-cap (25,000, M13h's 25,015 at 10⁵): past it every second statement
//   spends one of its notes again as well, so 10⁶ measures depth at 10⁵'s holdings (holdings are slice 15's (az)).
// - Each band also records the admissions over 300 ms (slice 15's waits during the journal's own read).
// - serve is restarted at every mark, not only at the end, so the first admission after a restart is measured at 10⁵ too.
// History as M11c2: REAL real issues to a holder's seed, then stand-in spends (real-size records, two nullifiers, four
// outputs; every second pays the seed one output, every fourth spends one again), a block every PER_BLOCK statements.
// Every step's result is written to RUN/report.json before the next starts; a rerun resumes from the journal's count.
// Usage: node driver.mjs [--marks 100000,1000000] [--step 200] [--holdings-cap 25000] [--stop-after <statements>]
// Environment: DPR_WT (a built worktree, default ../wt/dp6), DPR_RUN (default ./run).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { constants, cpus, setPriority, totalmem, uptime } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { serialize } from "node:v8";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const WT = process.env.DPR_WT ?? join(HERE, "..", "wt", "dp6"), RUN = process.env.DPR_RUN ?? join(HERE, "run");
const url = path => pathToFileURL(path).href;
const dist = path => import(url(join(WT, "dist", path)));
const { ed25519 } = await import(url(join(WT, "node_modules/@noble/curves/ed25519.js")));
const { sha256 } = await import(url(join(WT, "node_modules/@noble/hashes/sha2.js")));
const { limbsOf } = await dist("pool/field.js");
const { EMPTY_NOTE_ROOT } = await dist("pool/note-tree.js");
const { openDirectory, readSecret } = await dist("cli/common.js");
const { openView } = await dist("cli/venue.js");
const { readParameters } = await dist("pool/parameter-files.js");
const { startBackend } = await dist("pool/proof-verifier.js");
const { prepareExactOutput } = await dist("pool/v3/capsules.js");
const { adoptedDomain } = await dist("pool/v3/configuration.js");
const { deliveryHash, encodeRecord, decodeRecord } = await dist("pool/v3/records.js");
const { V3ServiceClient } = await dist("pool/v3/service-client.js");
const { openV3Verifier } = await dist("pool/v3/verifier.js");
const { V3Wallet } = await dist("pool/v3/wallet-store.js");
const PARAMETER_DIRECTORY = join(HERE, "..", "private-payment-crs") + "\\";

const { values: options } = parseArgs({ options: { marks: { type: "string", default: "100000,1000000" }, step: { type: "string", default: "200" },
  "holdings-cap": { type: "string", default: "25000" }, "stop-after": { type: "string" }, tail: { type: "string", default: "3000" }, "per-block": { type: "string", default: "14" } } });
const TAIL = Number(options.tail);
const MARKS = options.marks.split(",").map(Number), STEP = Number(options.step), CAP = Number(options["holdings-cap"]);
const STOP = options["stop-after"] === undefined ? Infinity : Number(options["stop-after"]);
// SILENCE lies far beyond the blocks any restart or wait mines (settle's 44, a wait's 20), so an interrupted driver never
// lets the backing lapse; serve's keep-alive then follows the checkpoints, which come every two blocks anyway.
const REAL = 8, PER_BLOCK = Number(options["per-block"]), SILENCE = "4096", DEPTH = "2", BAND = 10_000, SLOW_MS = 300;
const BASE = Number(process.env.DPR_PORT_BASE ?? 39053);
const PORT = { node: BASE, nodeProxy: BASE + 1, serve: BASE + 2, serviceProxy: BASE + 3 };
const NODE_URL = `http://127.0.0.1:${PORT.node}`, MOE = join(WT, "dist/cli/moe.js");
const HOOK = url(join(HERE, "standin-hook.mjs")), SAMPLE_HOOK = url(join(HERE, "sample-hook.mjs")), RSS_HOOK = url(join(WT, "scripts/pool/v3/rss-hook.mjs"));
const OP = join(RUN, "operator"), BK = join(RUN, "backer"), PROOFS = join(RUN, "proofs.bin");
const hex = bytes => Buffer.from(bytes).toString("hex");
const mib = bytes => +(bytes / 1048576).toFixed(1);
const pause = ms => new Promise(done => setTimeout(done, ms));
const log = message => process.stderr.write(`${new Date().toISOString()} ${message}\n`);
const directoryBytes = path => readdirSync(path, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
  .reduce((n, e) => n + statSync(join(e.parentPath, e.name)).size, 0);
const stats = values => {
  if (values.length === 0) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b), at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = v => +v.toFixed(1);
  return { count: sorted.length, mean: round(sorted.reduce((n, v) => n + v, 0) / sorted.length), p05: round(at(0.05)), median: round(at(0.5)),
    p95: round(at(0.95)), max: round(sorted.at(-1)) };
};
const host = () => ({ cores: cpus().length, model: cpus()[0]?.model, memoryGb: Math.round(totalmem() / 2 ** 30), node: process.version });
/** The host's CPU time so far, in milliseconds summed over its logical processors: [busy, total]. */
const hostCpu = () => cpus().reduce(([busy, total], { times: t }) => [busy + t.user + t.nice + t.sys + t.irq, total + t.user + t.nice + t.sys + t.irq + t.idle], [0, 0]);
const raise = pid => { try { setPriority(pid, constants.priority.PRIORITY_ABOVE_NORMAL); } catch (error) { log(`priority ${pid}: ${error.message}`); } };
const env = { ...process.env, MOE_DEPTH_BACKEND: url(join(WT, "dist/cli/backend.js")), MOE_DEPTH_PROOFS: PROOFS, MOE_DEPTH_COUNTS: join(RUN, "verifier-counts.jsonl"),
  NODE_OPTIONS: "--disable-warning=ExperimentalWarning" };
/** The last line of a samples file. */
const lastSample = file => {
  try {
    const fd = openSync(file, "r"), size = fstatSync(fd).size, length = Math.min(size, 4096), buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length); closeSync(fd);
    return JSON.parse(buffer.toString("utf8").trim().split("\n").at(-1));
  } catch { return {}; }
};
const samplesOf = file => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };

raise(process.pid);
mkdirSync(RUN, { recursive: true });
const stateFile = join(RUN, "state.json"), reportFile = join(RUN, `tail-report-${PER_BLOCK}.json`);
let state = JSON.parse(readFileSync(stateFile, "utf8"));
if (state.step !== "done" || JSON.parse(readFileSync(join(RUN, "report.json"), "utf8")).done !== true) throw new Error("the run's report is not done");
const report = { shape: { real: REAL, perBlock: PER_BLOCK, serveInterval: 2, silence: Number(SILENCE), depth: Number(DEPTH), tail: TAIL, band: BAND,
    holdingsCap: CAP, slowMs: SLOW_MS }, starts: [], bands: [], waits: { SCHEDULE: 0, STALE: 0 }, admissions: [] };
const save = () => { writeFileSync(reportFile, JSON.stringify(report, null, 2)); };

// Sleep or hibernation (the laptop's lid): every process is frozen and the wall clock jumps past a 1 s heartbeat. Each
// one is listed in report.suspensions; an admission spanning one is left out of its band's figures (counted as
// interrupted), and each band and read records the time it spent suspended.
let suspendedMs = 0, lastBeat = Date.now();
setInterval(() => {
  const now = Date.now(), gap = now - lastBeat - 1000;
  if (gap > 10_000) {
    suspendedMs += gap;
    (report.suspensions ??= []).push({ at: new Date(now).toISOString(), gapS: Math.round(gap / 1000) });
    log(`suspended about ${Math.round(gap / 1000)} s`); save();
  }
  lastBeat = now;
}, 1000).unref();
/** Whether a suspension fell since `before` (suspendedMs then), or the heartbeat has not yet run since one ended. */
const suspendedSince = before => suspendedMs !== before || Date.now() - lastBeat > 10_000;

// Processes of an earlier, interrupted driver: only if recorded since the host last started (a reboot frees the ids for
// other processes) and still a node.exe.
const pidsFile = join(RUN, "pids.json");
if (existsSync(pidsFile) && statSync(pidsFile).mtimeMs > Date.now() - uptime() * 1000) {
  for (const pid of Object.values(JSON.parse(readFileSync(pidsFile, "utf8")))) {
    const image = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }).stdout ?? "";
    if (/^"node\.exe"/i.test(image.trim())) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
}
const pids = {};
const keepPid = (name, pid) => { pids[name] = pid; writeFileSync(pidsFile, JSON.stringify(pids)); };
await pause(1000);

if (state.step === "setup" || state.step === "issues") {
  // Nothing worth keeping before the stand-ins: start again from nothing.
  for (const name of readdirSync(RUN)) if (name !== "pids.json") rmSync(join(RUN, name), { recursive: true, force: true });
  state = { step: "setup" };
  report.starts = []; report.bands = []; report.marks = [];
}
report.starts.push({ at: new Date().toISOString(), step: state.step, host: host() });

/** The node: node.mjs as its own process, from its log. */
async function startNode() {
  const child = spawn(process.execPath, ["--import", SAMPLE_HOOK, join(HERE, "node.mjs"), WT, join(RUN, "node.log"), String(PORT.node)],
    { stdio: ["ignore", "pipe", "inherit"], env: { ...env, MOE_DEPTH_SAMPLES: join(RUN, "node-samples.jsonl"), MOE_DEPTH_SAMPLE_MS: "60000" } });
  keepPid("node", child.pid); raise(child.pid);
  const began = performance.now();
  const line = await new Promise((done, failed) => { let out = ""; child.stdout.on("data", c => { out += c; if (out.includes("\n")) done(JSON.parse(out.split("\n")[0])); });
    child.on("close", status => failed(new Error(`node exited ${status}`))); });
  log(`node ${JSON.stringify(line)} in ${Math.round(performance.now() - began)} ms`);
  return { ...line, startMs: Math.round(performance.now() - began), child };
}
const call = async (path, body) => {
  const response = await fetch(`${NODE_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
};
const mine = count => call("/synthetic/mine", { count });

/** A loopback TCP proxy on `port` to `target`, counting the bytes each way. */
async function countingProxy(port, target) {
  const { hostname, port: to } = new URL(target), counted = { up: 0, down: 0 }, open = new Set();
  const server = createServer(client => {
    const upstream = connect(Number(to), hostname);
    for (const socket of [client, upstream]) { open.add(socket); socket.on("close", () => open.delete(socket)); }
    client.on("data", chunk => { counted.up += chunk.length; }); upstream.on("data", chunk => { counted.down += chunk.length; });
    client.pipe(upstream); upstream.pipe(client);
    client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
  });
  await new Promise(done => server.listen(port, "127.0.0.1", done));
  return { take() { const out = { ...counted }; counted.up = counted.down = 0; return out; },
    close: () => new Promise(done => { for (const socket of open) socket.destroy(); server.close(done); }) };
}

let nodeProxy, serviceProxy;
/** One `moe` process under the stand-in hook: its output, wall time, CPU, peak and sampled memory, bytes through the proxies. */
function moe(args, { input, quiet = false } = {}) {
  return new Promise((done, failed) => {
    const tag = process.hrtime.bigint(), rss = join(RUN, `rss-${tag}.json`), samples = join(RUN, `samples-${tag}.jsonl`), began = performance.now();
    const cpuBefore = hostCpu(), suspendedBefore = suspendedMs;
    nodeProxy?.take(); serviceProxy?.take();
    const child = spawn(process.execPath, ["--import", HOOK, "--import", RSS_HOOK, "--import", SAMPLE_HOOK, MOE, ...args],
      { cwd: RUN, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: { ...env, MOE_DRILL_RSS: rss, MOE_DEPTH_SAMPLES: samples } });
    raise(child.pid);
    if (input !== undefined) child.stdin.end(input);
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", failed);
    child.on("close", status => {
      const elapsedMs = Math.round(performance.now() - began), cpuAfter = hostCpu();
      let usage = {};
      try { usage = JSON.parse(readFileSync(rss, "utf8")); rmSync(rss); } catch { /* died before its exit handler */ }
      const sampled = samplesOf(samples).map(s => s.rssMb); rmSync(samples, { force: true });
      const node = nodeProxy?.take() ?? {}, service = serviceProxy?.take() ?? {};
      if (status !== 0) return failed(new Error(`moe ${args.join(" ")} exited ${status}: ${stderr.slice(-4000)}`));
      const q = Math.max(1, Math.floor(sampled.length / 4)), quarter = i => { const part = sampled.slice(i * q, (i + 1) * q); return part.length ? Math.round(part.reduce((n, v) => n + v, 0) / part.length) : undefined; };
      const json = JSON.parse(stdout.trim().split("\n").at(-1));
      done(quiet ? json : { json, elapsedMs, cpuMs: usage.cpuMs, maxRssMb: Math.round(usage.maxRssKb / 1024), noir: usage.noir,
        suspendedMs: suspendedMs - suspendedBefore, quarterMeansMb: [0, 1, 2, 3].map(quarter), hostBusy: +((cpuAfter[0] - cpuBefore[0]) / (cpuAfter[1] - cpuBefore[1])).toFixed(3),
        bytes: { nodeDown: node.down, nodeUp: node.up, serviceDown: service.down, serviceUp: service.up } });
    });
  });
}

/** `moe operator serve` as its own process on the fixed port; stderr appended to serve.log. */
let serving;
async function startServe() {
  const logFile = join(RUN, "serve.log"), samples = join(RUN, "serve-samples.jsonl");
  const child = spawn(process.execPath, ["--expose-gc", "--import", HOOK, "--import", SAMPLE_HOOK, MOE, "operator", "serve", "--dir", OP,
    "--interval", "2", "--poll-ms", "100", "--port", String(PORT.serve)], { cwd: RUN, stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, MOE_DEPTH_SAMPLES: samples, MOE_DEPTH_SAMPLE_MS: "10000", MOE_DEPTH_GC: "1" } });
  keepPid("serve", child.pid); raise(child.pid);
  let stderrText = "", committed = 0;
  child.stderr.on("data", chunk => {
    const text = String(chunk);
    writeFileSync(logFile, text, { flag: "a" });
    committed += (text.match(/"event":"committed"/g) ?? []).length;
    stderrText = (stderrText + text).slice(-200_000);
  });
  const exited = new Promise(done => child.on("close", status => done(status)));
  const began = performance.now();
  const listening = await new Promise((done, failed) => { let out = "";
    child.stdout.on("data", chunk => { out += chunk; if (out.includes("\n")) done(JSON.parse(out.split("\n")[0])); });
    exited.then(status => failed(new Error(`serve exited ${status}: ${stderrText.slice(-4000)}`))); });
  const startMs = Math.round(performance.now() - began);
  exited.then(status => { if (!serving?.stopping) log(`serve exited unexpectedly ${status}: ${stderrText.slice(-2000)}`); });
  serving = { child, listening, startMs, stopping: false, committed: () => committed,
    status: () => { const s = lastSample(samples); return { rssMb: s.rssMb, peakMb: s.peakMb, heapMb: s.heapMb, cpuMs: s.cpuMs, sampledAt: s.at }; },
    // Windows ends the process outright: the journal's crash safety, not a drain, carries the restart.
    async stop() { this.stopping = true; child.kill("SIGTERM"); return exited; } };
  return serving;
}

/** Mine until serve has committed and published everything admitted and the publication lies past the depth. */
async function settle() {
  const before = serving.committed();
  for (let i = 0; i < 40 && serving.committed() === before; i++) { await mine(1); await pause(250); }
  for (let i = 0; i < Number(DEPTH) + 2; i++) { await mine(1); await pause(400); }
  await pause(800);
}

let node;
const shutdown = async () => {
  if (serving !== undefined && !serving.stopping) { try { await serving.stop(); } catch (error) { log(`serve stop: ${error.message}`); } }
  await nodeProxy?.close(); await serviceProxy?.close();
  node?.child.kill("SIGTERM");
};

try {
  if (state.step === "setup") {
    node = await startNode();
    const direct = ["--node", NODE_URL, "--parameters", PARAMETER_DIRECTORY];
    await mine(Number(DEPTH) + 2);
    const operatorInit = await moe(["operator", "init", "--dir", OP, ...direct, "--budget", "100000000000000"], { quiet: true });
    await call("/synthetic/fund", { tree: operatorInit.fundingTree, value: "100000000000000" });
    await moe(["operator", "venue", "create", "--dir", OP, "--synthetic", "--depth", DEPTH], { quiet: true });
    await mine(Number(DEPTH) + 1);
    const venueFile = join(OP, "venue.json");
    await moe(["wallet", "init", "--dir", BK, "--backer", "--venue", venueFile, ...direct], { quiet: true });
    const created = await moe(["wallet", "terms", "create", "--dir", BK, "--operator", operatorInit.operator, "--thing", "probe units", "--per-unit", "1",
      "--interval", "80", "--silence", SILENCE, "--challenge", "5"], { quiet: true });
    await moe(["operator", "open", "--dir", OP, "--id", "genesis", created.backing, "--terms", created.terms, "--signature", created.signature, "--synthetic"], { quiet: true });
    await mine(Number(DEPTH) + 2);
    state = { step: "issues", operator: operatorInit.operator, backing: created.backing, terms: created.terms, signature: created.signature,
      venueFile, seed: hex(randomBytes(32)) };
    save();
  } else node = await startNode();
  nodeProxy = await countingProxy(PORT.nodeProxy, NODE_URL);
  serviceProxy = await countingProxy(PORT.serviceProxy, `http://127.0.0.1:${PORT.serve}`);
  const backing = Buffer.from(state.backing, "hex"), seed = Buffer.from(state.seed, "hex"), domain = adoptedDomain();
  const signed = { terms: readFileSync(state.terms), signature: readFileSync(state.signature) };
  const termsArgs = ["--terms", state.terms, "--signature", state.signature, "--synthetic"];
  const proxiedService = join(RUN, "service-proxied.json");

  // Resuming: the journal's own count of admitted statements, read before serve opens it.
  let made = 0;
  if (state.step !== "issues") {
    const db = new DatabaseSync(join(OP, "journal.db"), { readOnly: true });
    made = Number(db.prepare("SELECT COUNT(*) AS n FROM journal_receipt").get().n); db.close();
    log(`resuming at ${made} statements, step ${state.step}`);
  }
  await startServe();
  report.starts.at(-1).serve = { startMs: serving.startMs, statements: made, node: { replayed: node.replayed, startMs: node.startMs } };
  const service = JSON.parse(readFileSync(join(OP, "service.json"), "utf8"));
  writeFileSync(proxiedService, JSON.stringify({ url: `http://127.0.0.1:${PORT.serviceProxy}/`, walletToken: service.walletToken }));
  const bk = openDirectory(BK, "wallet"), reference = (() => { const v = openView(bk); try { return v.file.reference; } finally { v.close(); } })();
  const client = new V3ServiceClient(service.url, service.walletToken, { operator: Buffer.from(state.operator, "hex"), reference });

  if (state.step === "issues") {
    // The real issues, proved through the backer's wallet here and admitted through serve (verified as they are).
    const api = await startBackend(await readParameters(PARAMETER_DIRECTORY));
    const { openV3Prover } = await dist("pool/v3/prover.js");
    const prover = await openV3Prover(api, { instances: 2 }), verifier = await openV3Verifier(api, { instances: 2 }), proofs = [];
    const backerView = openView(bk), backerKey = readSecret(join(BK, "backer.key"), "backer.key");
    const backer = new V3Wallet(bk.file("wallet.db"), { venue: backerView.venue, reference: backerView.file.reference, verifier });
    const issueClient = new V3ServiceClient(service.url, service.walletToken, { operator: Buffer.from(state.operator, "hex"), reference: backerView.file.reference });
    await backerView.sync();
    const evidence = (await backer.supply(store => issueClient.sync(backing, store))).package;
    const prove = async task => { const record = await prover.prove(task); proofs.push({ kind: record.kind, inputs: record.publicInputs, proof: record.proof }); return record; };
    let prefix;
    for (let i = 0; i < REAL; i++) {
      const out = prepareExactOutput(seed, domain, sha256(Buffer.from(`real-${i}`)), backing, 2n);
      const act = await backer.issue(`issue-${i}`, { domain, opening: out.opening, cm: out.cm, capsule: out.capsule }, 2n, evidence, signed, prove,
        message => ed25519.sign(message, backerKey));
      for (let attempt = 0; ; attempt++) {
        try { await backer.submit(`issue-${i}`, issueClient); break; } catch (error) {
          if (attempt >= 20 || !(error?.code in report.waits)) throw error;
          report.waits[error.code]++; await mine(1); await pause(300);
        }
      }
      made++;
      prefix ??= decodeRecord(act.record).publicInputs.slice(0, 5).map(String);
      log(`real issue ${i} admitted`);
    }
    backer.close(); backerView.close(); backerKey.fill(0);
    await prover.close(); await verifier.close(); await api.destroy();
    writeFileSync(PROOFS, serialize(proofs));
    report.shape.proofBytes = proofs[0].proof.length;
    await settle();
    state.prefix = prefix; state.proofBytes = proofs[0].proof.length; state.step = "generate"; state.mark = 0; save();
  }

  // Stand-in spends, deterministic in their index where it matters (the seed's outputs and which are spent again).
  const prefix = state.prefix.map(BigInt), proofBytes = state.proofBytes;
  const MODULUS = 21888242871839275222246405745257275088548364400416903490308238158651n;
  const fieldOf = () => { for (;;) { const v = BigInt(`0x${randomBytes(32).toString("hex")}`) % MODULUS; if (v !== 0n) return v; } };
  const capsuleOf = () => { const c = randomBytes(89); c[0] = 1; return c; };
  const outputOf = i => prepareExactOutput(seed, domain, sha256(Buffer.from(`out-${i}`)), backing, 1n);
  const owned = []; let ownedOutputs = 0, ownedSpent = 0, head = 0;
  const account = i => { // the queue's change at statement i; returns the spent output's index, if any
    let spent;
    if ((i % 4 === 0 && owned.length - head > 16) || (i % 2 === 0 && owned.length - head > CAP)) { spent = owned[head++]; ownedSpent++; }
    if (i % 2 === 0) { owned.push(i); ownedOutputs++; }
    if (head > 65_536) { owned.splice(0, head); head = 0; }
    return spent;
  };
  for (let i = REAL; i < made; i++) account(i);
  const standIn = i => {
    const spent = account(i), nfs = [spent === undefined ? fieldOf() : outputOf(spent).nf, fieldOf()], outs = [], caps = [];
    for (let k = 0; k < 4; k++) {
      if (k === 0 && i % 2 === 0) { const out = outputOf(i); outs.push(out.cm); caps.push(out.capsule); } else { outs.push(fieldOf()); caps.push(capsuleOf()); }
    }
    return encodeRecord({ domain, kind: 2, publicInputs: [...prefix, EMPTY_NOTE_ROOT, EMPTY_NOTE_ROOT, ...nfs, ...outs, ...limbsOf(deliveryHash(domain, outs, caps))],
      proof: randomBytes(proofBytes), authorization: new Uint8Array(), capsules: caps });
  };
  const newBand = (from, cpuBefore) => ({ first: [], rest: [], slow: [], interrupted: 0, from, began: performance.now(), cpuBefore, hostBefore: hostCpu(),
    suspendedBefore: suspendedMs });
  let band = newBand(made, serving.status().cpuMs), newBlock = false;
  const admit = async bytes => {
    for (let attempt = 0; ; attempt++) {
      const began = performance.now();
      try { await client.submit(bytes); return performance.now() - began; } catch (error) {
        // A restarted serve's first read can hold its turn past the client's 10 s idle bound (Next 4 (bb)): wait, mine
        // nothing, and resubmit the same bytes (an exact retry returns the admitted result).
        if (error?.name === "AbortError" && attempt < 720) {
          report.waits.ABORT = (report.waits.ABORT ?? 0) + 1; band.interrupted++; newBlock = true;
          log(`admission ${made} aborted by the client's idle bound; waiting (attempt ${attempt})`); await pause(5_000); continue;
        }
        if (attempt >= 20 || !(error?.code in report.waits)) throw error;
        report.waits[error.code]++; await mine(1); newBlock = true; await pause(300);
      }
    }
  };
  const closeBand = () => {
    const s = serving.status(), hostAfter = hostCpu(), n = made - band.from;
    report.bands.push({ from: band.from, through: made, firstInBlockMs: stats(band.first), otherMs: stats(band.rest), slowMs: stats(band.slow), serve: s,
      serveCpuMsPerStatement: n > 0 && s.cpuMs !== undefined && band.cpuBefore !== undefined ? Math.round((s.cpuMs - band.cpuBefore) / n) : undefined,
      hostBusy: +((hostAfter[0] - band.hostBefore[0]) / (hostAfter[1] - band.hostBefore[1])).toFixed(3),
      node: lastSample(join(RUN, "node-samples.jsonl")), journalMb: mib(directoryBytes(OP)), elapsedS: Math.round((performance.now() - band.began) / 1000), interrupted: band.interrupted,
      suspendedS: Math.round((suspendedMs - band.suspendedBefore) / 1000), at: new Date().toISOString() });
    log(JSON.stringify(report.bands.at(-1))); save();
    band = newBand(made, s.cpuMs);
  };
  const generate = async until => {
    while (made < until) {
      if (made >= STOP) throw Object.assign(new Error(`stopped at ${made}`), { stop: true });
      const bytes = standIn(made), first = newBlock;
      newBlock = false;
      const before = suspendedMs, ms = await admit(bytes);
      if (suspendedSince(before)) band.interrupted++;
      else { (first ? band.first : band.rest).push(ms); if (ms > SLOW_MS) band.slow.push(ms); }
      // [index, ms, first after a block, serve's commitments so far, suspended]
      report.admissions.push([made, +ms.toFixed(1), first ? 1 : 0, serving.committed(), suspendedSince(before) ? 1 : 0]);
      if (process.env.DPR_TEST_STALL_AT !== undefined && made === Number(process.env.DPR_TEST_STALL_AT)) { const until = Date.now() + 15_000; while (Date.now() < until); }
      made++;
      if (made % PER_BLOCK === 0) { await mine(1); newBlock = true; }
      if (made % BAND === 0) closeBand();
    }
    if (band.first.length + band.rest.length > 0) closeBand();
  };
  const reader = n => join(RUN, `reader-${n}`), wallet = n => join(RUN, `wallet-${n}`);
  const strip = ({ json, ...rest }) => rest;
  const supply = async n => { const r = await moe(["reader", "supply", "--dir", reader(n), state.backing]);
    return { ...strip(r), position: r.json.position, issued: r.json.issued, checkpoint: r.json.checkpoint?.sequence, sync: r.json.sync, keptBytes: directoryBytes(reader(n)) }; };
  const sync = async n => { const r = await moe(["wallet", "sync", "--dir", wallet(n), state.backing]);
    return { ...strip(r), holdings: r.json.holdings?.length, checkpoint: r.json.checkpoint?.sequence, keptBytes: directoryBytes(wallet(n)) }; };

  void reader; void wallet; void supply; void sync; void termsArgs; void ownedSpent; void ownedOutputs;
  report.from = made; save();
  await generate(made + TAIL);
  await settle();
  report.done = true; report.through = made; save();
  log(`tail done at ${made}`);
} catch (error) {
  if (error?.stop) { log(error.message); save(); }
  else { log(`driver failed: ${error?.stack ?? error}${error?.cause === undefined ? "" : ` cause: ${error.cause?.stack ?? error.cause} ${error.cause?.code ?? ""}`}`); report.errors = [...(report.errors ?? []), { at: new Date().toISOString(), error: String(error?.stack ?? error) }]; save(); process.exitCode = 1; }
} finally {
  await shutdown();
  rmSync(pidsFile, { force: true });
}
