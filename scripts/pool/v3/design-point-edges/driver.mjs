// Slice 13 (e), WORK.md Next 5 (probe; disposable, retires once the design point records it): the 10⁵ rerun by
// M11c2/M11c3's method, restartable. `moe operator serve` runs as its own process (its memory at depth, Next 5), the
// synthetic node as another (node.mjs, replayed from its log after a restart), and a fresh reader's and a seed-restored
// wallet's first `reader supply` / `wallet sync` at each mark, then their steady state (STEP more statements, then
// nothing new), all as `moe` processes under standin-hook.mjs (stand-in proofs verify a kept real proof in their place).
// History as M11c2: REAL real issues to a holder's seed, then stand-in spends (real-size records, two nullifiers, four
// outputs; every second pays the seed one output, every fourth spends one again), a block every PER_BLOCK statements.
// Every step's result is written to RUN/report.json before the next starts; a rerun resumes from the journal's count.
// Usage: node driver.mjs [--marks 10000,100000] [--step 200] [--stop-after <statements>]
// As run: these four files from scratch/depth (HERE) over the dist of a worktree of 154735d (WT), built with
// `npm run build` and `scripts/pool/prepare-crs.mjs`; the paths are the cloud container's.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { serialize } from "node:v8";
import { DatabaseSync } from "node:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

const WT = process.env.DPR_WT, HERE = "/home/user/reference-ts/scratch/dpr", RUN = process.env.DPR_RUN;
const dist = path => import(join(WT, "dist", path));
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
const { PARAMETER_DIRECTORY } = await import(join(WT, "scripts/pool/prepare-crs.mjs"));

const { values: options } = parseArgs({ options: { marks: { type: "string", default: "10000,100000" }, step: { type: "string", default: "200" },
  "stop-after": { type: "string" } } });
const MARKS = options.marks.split(",").map(Number), STEP = Number(options.step), STOP = options["stop-after"] === undefined ? Infinity : Number(options["stop-after"]);
const REAL = 8, PER_BLOCK = 14, SILENCE = "32", DEPTH = "2", BAND = 10_000;
const PORT = { node: 39053, nodeProxy: 39054, serve: 39055, serviceProxy: 39056 };
const NODE_URL = `http://127.0.0.1:${PORT.node}`, MOE = join(WT, "dist/cli/moe.js");
const HOOK = join(HERE, "standin-hook.mjs"), RSS_HOOK = join(WT, "scripts/pool/v3/rss-hook.mjs");
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
  return { count: sorted.length, mean: round(sorted.reduce((n, v) => n + v, 0) / sorted.length), median: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)) };
};
const host = () => ({ cores: cpus().length, model: cpus()[0]?.model, memoryGb: Math.round(totalmem() / 2 ** 30), node: process.version });
const env = { ...process.env, MOE_DEPTH_BACKEND: join(WT, "dist/cli/backend.js"), MOE_DEPTH_PROOFS: PROOFS, MOE_DEPTH_COUNTS: join(RUN, "verifier-counts.jsonl") };

mkdirSync(RUN, { recursive: true });
const stateFile = join(RUN, "state.json"), reportFile = join(RUN, "report.json");
let state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { step: "setup" };
const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf8"))
  : { shape: { real: REAL, perBlock: PER_BLOCK, serveInterval: 2, silence: Number(SILENCE), depth: Number(DEPTH), step: STEP, marks: MARKS, band: BAND },
    starts: [], bands: [], marks: [], waits: { SCHEDULE: 0, STALE: 0 } };
const save = () => { writeFileSync(stateFile, JSON.stringify(state, null, 2)); writeFileSync(reportFile, JSON.stringify(report, null, 2)); };

// Processes of an earlier, interrupted driver.
const pidsFile = join(RUN, "pids.json");
if (existsSync(pidsFile)) for (const pid of Object.values(JSON.parse(readFileSync(pidsFile, "utf8")))) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
const pids = {};
const keepPid = (name, pid) => { pids[name] = pid; writeFileSync(pidsFile, JSON.stringify(pids)); };
await pause(500);

if (state.step === "setup" || state.step === "issues") {
  // Nothing worth keeping before the stand-ins: start again from nothing.
  for (const name of readdirSync(RUN)) if (name !== "pids.json") rmSync(join(RUN, name), { recursive: true, force: true });
  state = { step: "setup" };
  report.starts = []; report.bands = []; report.marks = [];
}
report.starts.push({ at: new Date().toISOString(), step: state.step, host: host() });

/** The node: node.mjs as its own process, from its log. */
async function startNode() {
  const child = spawn(process.execPath, [join(HERE, "node.mjs"), WT, join(RUN, "node.log"), String(PORT.node)], { stdio: ["ignore", "pipe", "inherit"] });
  keepPid("node", child.pid);
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

const procStatus = pid => {
  try {
    const lines = readFileSync(`/proc/${pid}/status`, "utf8").split("\n"), kb = key => Number(lines.find(l => l.startsWith(key))?.split(/\s+/)[1] ?? 0);
    return { rssMb: Math.round(kb("VmRSS:") / 1024), peakMb: Math.round(kb("VmHWM:") / 1024) };
  } catch { return {}; }
};
const cpuMsOf = pid => {
  try { const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); return Math.round((Number(f[11]) + Number(f[12])) * 10); } catch { return undefined; }
};

let nodeProxy, serviceProxy;
/** One `moe` process under the stand-in hook: its output, wall time, CPU, peak and sampled memory, bytes through the proxies. */
function moe(args, { input, quiet = false } = {}) {
  return new Promise((done, failed) => {
    const rss = join(RUN, `rss-${process.hrtime.bigint()}.json`), began = performance.now();
    nodeProxy?.take(); serviceProxy?.take();
    const child = spawn(process.execPath, ["--import", HOOK, "--import", RSS_HOOK, MOE, ...args],
      { cwd: RUN, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: { ...env, MOE_DRILL_RSS: rss } });
    if (input !== undefined) child.stdin.end(input);
    const samples = [], timer = setInterval(() => { const s = procStatus(child.pid); if (s.rssMb !== undefined) samples.push(s.rssMb); }, 1000);
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", failed);
    child.on("close", status => {
      clearInterval(timer);
      const elapsedMs = Math.round(performance.now() - began);
      let usage = {};
      try { usage = JSON.parse(readFileSync(rss, "utf8")); rmSync(rss); } catch { /* died before its exit handler */ }
      const node = nodeProxy?.take() ?? {}, service = serviceProxy?.take() ?? {};
      if (status !== 0) return failed(new Error(`moe ${args.join(" ")} exited ${status}: ${stderr.slice(-4000)}`));
      const q = Math.max(1, Math.floor(samples.length / 4)), quarter = i => { const part = samples.slice(i * q, (i + 1) * q); return part.length ? Math.round(part.reduce((n, v) => n + v, 0) / part.length) : undefined; };
      const json = JSON.parse(stdout.trim().split("\n").at(-1));
      done(quiet ? json : { json, elapsedMs, cpuMs: usage.cpuMs, maxRssMb: Math.round(usage.maxRssKb / 1024), noir: usage.noir,
        quarterMeansMb: [0, 1, 2, 3].map(quarter), bytes: { nodeDown: node.down, nodeUp: node.up, serviceDown: service.down, serviceUp: service.up } });
    });
  });
}

/** `moe operator serve` as its own process on the fixed port; stderr appended to serve.log. */
let serving;
async function startServe() {
  const logFile = join(RUN, "serve.log");
  const child = spawn(process.execPath, ["--expose-gc", "--heapsnapshot-signal=SIGUSR2", "--import", HOOK, MOE, "operator", "serve", "--dir", OP,
    "--interval", "2", "--poll-ms", "100", "--port", String(PORT.serve)], { cwd: RUN, stdio: ["ignore", "pipe", "pipe"], env: { ...env, MOE_DEPTH_MEM: join(RUN, "serve-mem.jsonl") } });
  keepPid("serve", child.pid);
  let stderrText = "";
  child.stderr.on("data", chunk => { appendFileSync(logFile, chunk); stderrText = (stderrText + chunk).slice(-200_000); });
  const exited = new Promise(done => child.on("close", status => done(status)));
  const began = performance.now();
  const listening = await new Promise((done, failed) => { let out = "";
    child.stdout.on("data", chunk => { out += chunk; if (out.includes("\n")) done(JSON.parse(out.split("\n")[0])); });
    exited.then(status => failed(new Error(`serve exited ${status}: ${stderrText.slice(-4000)}`))); });
  const startMs = Math.round(performance.now() - began);
  exited.then(status => { if (!serving?.stopping) log(`serve exited unexpectedly ${status}: ${stderrText.slice(-2000)}`); });
  serving = { child, listening, startMs, stopping: false, committed: () => (stderrText.match(/"event":"committed"/g) ?? []).length,
    status: () => ({ ...procStatus(child.pid), cpuMs: cpuMsOf(child.pid) }),
    async stop() { this.stopping = true; child.kill("SIGTERM"); const status = await exited; assert.equal(status, 0, stderrText.slice(-4000)); } };
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
  const owned = []; let ownedOutputs = 0, ownedSpent = 0;
  const account = i => { // the queue's change at statement i; returns the spent output's index, if any
    let spent;
    if (i % 4 === 0 && owned.length > 16) { spent = owned.shift(); ownedSpent++; }
    if (i % 2 === 0) { owned.push(i); ownedOutputs++; }
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
  let band = { first: [], rest: [], from: made, began: performance.now(), cpuBefore: serving.status().cpuMs }, newBlock = false;
  const admit = async bytes => {
    for (let attempt = 0; ; attempt++) {
      const began = performance.now();
      try { await client.submit(bytes); return performance.now() - began; } catch (error) {
        if (attempt >= 20 || !(error?.code in report.waits)) throw error;
        report.waits[error.code]++; await mine(1); newBlock = true; await pause(300);
      }
    }
  };
  const closeBand = () => {
    const s = serving.status();
    report.bands.push({ from: band.from, through: made, firstInBlockMs: stats(band.first), otherMs: stats(band.rest), serve: s,
      serveCpuMs: s.cpuMs - band.cpuBefore, journalMb: mib(directoryBytes(OP)), elapsedS: Math.round((performance.now() - band.began) / 1000), host: cpus()[0]?.model });
    log(JSON.stringify(report.bands.at(-1))); save();
    band = { first: [], rest: [], from: made, began: performance.now(), cpuBefore: s.cpuMs };
  };
  const generate = async until => {
    while (made < until) {
      if (made >= STOP) throw Object.assign(new Error(`stopped at ${made}`), { stop: true });
      const bytes = standIn(made), first = newBlock;
      newBlock = false;
      const ms = await admit(bytes);
      (first ? band.first : band.rest).push(ms);
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

  for (const mark of MARKS) {
    let entry = report.marks.find(m => m.mark === mark);
    if (entry?.done) continue;
    if (entry === undefined) { entry = { mark }; report.marks.push(entry); }
    if (made < mark) { await generate(mark); }
    if (entry.readerFirst === undefined || entry.walletFirst === undefined) {
      if (entry.statements === undefined) {
        await settle();
        entry.statements = made; entry.ownedOutputs = ownedOutputs; entry.ownedSpent = ownedSpent; entry.serveAtMark = serving.status();
        serving.child.kill("SIGUSR2"); await pause(30_000); // a heap snapshot of serve at the mark
        save();
      }
      if (entry.readerFirst === undefined) {
        rmSync(reader(mark), { recursive: true, force: true });
        await moe(["reader", "init", "--dir", reader(mark), "--venue", state.venueFile, "--node", `http://127.0.0.1:${PORT.nodeProxy}`, "--parameters", PARAMETER_DIRECTORY], { quiet: true });
        await moe(["reader", "terms", "add", "--dir", reader(mark), state.backing, ...termsArgs], { quiet: true });
        await moe(["reader", "service", "add", "--dir", reader(mark), state.backing, proxiedService], { quiet: true });
        entry.readerFirst = { ...(await supply(mark)), host: cpus()[0]?.model }; log(JSON.stringify(entry.readerFirst)); save();
      }
      if (entry.walletFirst === undefined) {
        rmSync(wallet(mark), { recursive: true, force: true });
        await moe(["wallet", "restore-seed", "--dir", wallet(mark), "--venue", state.venueFile, "--node", `http://127.0.0.1:${PORT.nodeProxy}`, "--parameters", PARAMETER_DIRECTORY],
          { input: `${state.seed}\n`, quiet: true });
        await moe(["wallet", "terms", "add", "--dir", wallet(mark), state.backing, ...termsArgs], { quiet: true });
        await moe(["wallet", "service", "add", "--dir", wallet(mark), state.backing, proxiedService], { quiet: true });
        entry.walletFirst = { ...(await sync(mark)), host: cpus()[0]?.model }; log(JSON.stringify(entry.walletFirst)); save();
      }
    }
    if (entry.step === undefined) {
      if (made < entry.statements + STEP) await generate(entry.statements + STEP);
      await settle();
      entry.step = { statements: made, reader: await supply(mark), wallet: await sync(mark), host: cpus()[0]?.model };
      entry.idle = { reader: await supply(mark), wallet: await sync(mark) };
      log(JSON.stringify({ step: entry.step, idle: entry.idle }));
    }
    entry.done = true; save();
  }
  if (report.restart === undefined) {
    // serve's restart over the whole history, and the first admission after it.
    const before = serving.status();
    await serving.stop();
    await startServe();
    const firstMs = await admit(standIn(made)); made++;
    report.restart = { statements: made, before, startMs: serving.startMs, firstAdmissionMs: Math.round(firstMs), after: serving.status(),
      journalMb: mib(directoryBytes(OP)), operatorDirMb: mib(directoryBytes(OP)), host: cpus()[0]?.model };
    log(JSON.stringify(report.restart));
  }
  report.done = true; state.step = "done"; save();
  log("done");
} catch (error) {
  if (error?.stop) { log(error.message); save(); }
  else { log(`driver failed: ${error?.stack ?? error}`); report.errors = [...(report.errors ?? []), { at: new Date().toISOString(), error: String(error?.stack ?? error) }]; save(); process.exitCode = 1; }
} finally {
  await shutdown();
  rmSync(pidsFile, { force: true });
}
