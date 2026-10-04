// Slice 11 M11c1 (probe; retires once its measurements are recorded): the `moe` operator, reader and wallet with real
// proofs over about 10³ statements on the synthetic node, measured against the declared budgets
// (docs/PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets), by the method of the 2026-10-03 direction (M11c).
//
// History: rounds of issues from a backer to a holder's seed and payments of one unit from the holder to a shop,
// made with real proofs through the wallet library in this process and submitted to `moe operator serve`; a block
// is mined every PER_BLOCK statements (the design point's peak, 10⁴ a day, is about 14 per two-minute block).
// Measured: each statement's admission as its submitter sees it (serve's proof check and journal turn, HTTP included);
// serve's resident memory as history grows and its restart; at each mark a fresh reader's first `reader supply` and
// a fresh wallet's `restore-seed` and first `sync` (time, CPU, peak memory, bytes moved through counting proxies in
// front of the node and the service, bytes kept); past the last mark the same reader's and wallet's sync over one
// more round (the steady state) and with nothing new.
//
// Usage: node scripts/pool/v3/design-point-probe.mjs [--statements 1000] [--round 50] [--marks 200,500,1000]
//   (after npm run build and scripts/pool/prepare-crs.mjs; prints one JSON report)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { cpus, totalmem } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { ed25519 } from "@noble/curves/ed25519.js";
import { openView } from "../../../dist/cli/venue.js";
import { readParameters } from "../../../dist/pool/parameter-files.js";
import { startBackend } from "../../../dist/pool/proof-verifier.js";
import { prepareExactOutput } from "../../../dist/pool/v3/capsules.js";
import { openV3Prover } from "../../../dist/pool/v3/prover.js";
import { V3Wallet } from "../../../dist/pool/v3/wallet-store.js";
import { adoptedDomain } from "../../../dist/pool/v3/configuration.js";
import { V3ServiceClient } from "../../../dist/pool/v3/service-client.js";
import { PARAMETER_DIRECTORY } from "../prepare-crs.mjs";
import { serveSyntheticNode } from "./synthetic-node.mjs";

const { values: options } = parseArgs({ options: { statements: { type: "string", default: "1000" }, round: { type: "string", default: "50" },
  marks: { type: "string" } } });
const STATEMENTS = Number(options.statements), ROUND = Number(options.round);
const MARKS = (options.marks ?? [STATEMENTS / 5, STATEMENTS / 2, STATEMENTS].join(",")).split(",").map(Number);
assert(ROUND > 0 && STATEMENTS % (2 * ROUND) === 0 && MARKS.every(m => m % (2 * ROUND) === 0 && m <= STATEMENTS), "marks and statements are whole rounds");
const PER_BLOCK = 14, SILENCE = "32", DEPTH = "2";
const root = resolve(import.meta.dirname, "../../.."), MOE = join(root, "dist", "cli", "moe.js"), RSS_HOOK = new URL("./rss-hook.mjs", import.meta.url).href;
mkdirSync(join(root, "scratch"), { recursive: true });
const scratch = realpathSync(mkdtempSync(join(realpathSync(join(root, "scratch")), "design-point-")));
const hex = bytes => Buffer.from(bytes).toString("hex");
const pause = ms => new Promise(done => setTimeout(done, ms));
const stats = values => {
  const sorted = values.map(Math.round).sort((a, b) => a - b), at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { count: sorted.length, mean: Math.round(sorted.reduce((n, v) => n + v, 0) / sorted.length), median: at(0.5), p95: at(0.95), max: sorted.at(-1) };
};
const directoryBytes = path => readdirSync(path, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
  .reduce((n, e) => n + statSync(join(e.parentPath, e.name)).size, 0);

/** A loopback TCP proxy to `target` counting the bytes each way: what a measured command moves over its transport. */
async function countingProxy(target) {
  const { hostname, port } = new URL(target), counted = { up: 0, down: 0 };
  const server = createServer(client => {
    const upstream = connect(Number(port), hostname);
    client.on("data", chunk => { counted.up += chunk.length; });
    upstream.on("data", chunk => { counted.down += chunk.length; });
    client.pipe(upstream); upstream.pipe(client);
    client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}`, take() { const out = { ...counted }; counted.up = counted.down = 0; return out; },
    close: () => new Promise(done => server.close(done)) };
}

const node = await serveSyntheticNode(), nodeProxy = await countingProxy(node.url);
const call = async (path, body) => {
  const response = await fetch(`${node.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
};
const mine = count => call("/synthetic/mine", { count });

/** One `moe` process: its output, wall time, CPU and peak memory (rss-hook), and the bytes it moved through the proxies. */
function moe(args, { input } = {}) {
  return new Promise((done, failed) => {
    const rss = join(scratch, `rss-${process.hrtime.bigint()}.json`), began = performance.now();
    nodeProxy.take(); serviceProxy?.take();
    const child = spawn(process.execPath, ["--import", RSS_HOOK, MOE, ...args],
      { cwd: scratch, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: { ...process.env, MOE_DRILL_RSS: rss } });
    if (input !== undefined) child.stdin.end(input);
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", failed);
    child.on("close", status => {
      const elapsedMs = Math.round(performance.now() - began);
      let usage = {};
      try { usage = JSON.parse(readFileSync(rss, "utf8")); rmSync(rss); } catch { /* died before its exit handler */ }
      const node = nodeProxy.take(), service = serviceProxy?.take() ?? { up: 0, down: 0 };
      if (status !== 0) return failed(new Error(`moe ${args.join(" ")} exited ${status}: ${stderr}`));
      done({ json: JSON.parse(stdout.trim().split("\n").at(-1)), elapsedMs, cpuMs: usage.cpuMs, maxRssMb: Math.round(usage.maxRssKb / 1024),
        bytes: { nodeDown: node.down, nodeUp: node.up, serviceDown: service.down, serviceUp: service.up } });
    });
  });
}
const wallet = (verb, directory, ...rest) => ["wallet", ...verb.split(" "), "--dir", directory, ...rest];

/** `moe operator serve` in the background; its resident memory is sampled from /proc while it runs (Linux). */
function serve(directory) {
  const child = spawn(process.execPath, [MOE, "operator", "serve", "--dir", directory, "--interval", "2", "--poll-ms", "100"],
    { cwd: scratch, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(done => child.on("close", status => done(status)));
  const began = performance.now();
  const listening = new Promise((done, failed) => {
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("\n")) done({ ...JSON.parse(stdout.split("\n")[0]), startMs: Math.round(performance.now() - began) }); });
    exited.then(status => failed(new Error(`serve exited ${status}: ${stderr}`)));
  });
  const rssMb = () => {
    const line = readFileSync(`/proc/${child.pid}/status`, "utf8").split("\n").find(l => l.startsWith("VmRSS:")) ?? "";
    const peak = readFileSync(`/proc/${child.pid}/status`, "utf8").split("\n").find(l => l.startsWith("VmHWM:")) ?? "";
    return { rssMb: Math.round(Number(line.split(/\s+/)[1]) / 1024), peakMb: Math.round(Number(peak.split(/\s+/)[1]) / 1024) };
  };
  return { listening, log: () => stderr, rssMb, async stop() { child.kill("SIGTERM"); assert.equal(await exited, 0, stderr); } };
}

let serviceProxy, completed = false;
const report = { host: { cores: cpus().length, model: cpus()[0]?.model, memoryGb: Math.round(totalmem() / 2 ** 30), node: process.version, platform: process.platform },
  shape: { statements: STATEMENTS, round: ROUND, perBlock: PER_BLOCK, serveInterval: 2, silence: Number(SILENCE), depth: Number(DEPTH) },
  rounds: [], marks: [], steady: undefined, waits: undefined, restart: undefined };
try {
  const common = ["--parameters", PARAMETER_DIRECTORY], measured = ["--node", nodeProxy.url, ...common], direct = ["--node", node.url, ...common];
  const OP = join(scratch, "operator"), BK = join(scratch, "backer"), HD = join(scratch, "holder"), SH = join(scratch, "shop");
  await mine(Number(DEPTH) + 2);
  const operator = (await moe(["operator", "init", "--dir", OP, ...direct, "--budget", "1000000000000"])).json;
  await call("/synthetic/fund", { tree: operator.fundingTree, value: "10000000000000" });
  const venue = (await moe(["operator", "venue", "create", "--dir", OP, "--synthetic", "--depth", DEPTH])).json.venue;
  await mine(Number(DEPTH) + 1);
  const venueFile = join(OP, "venue.json");
  await moe(wallet("init", BK, "--backer", "--venue", venueFile, ...direct));
  const created = (await moe(wallet("terms create", BK, "--operator", operator.operator, "--thing", "probe units", "--per-unit", "1", "--interval", "80",
    "--silence", SILENCE, "--challenge", "5"))).json;
  const backing = created.backing, termsArgs = ["--terms", created.terms, "--signature", created.signature, "--synthetic"];
  await moe(["operator", "open", "--dir", OP, "--id", "genesis", backing, ...termsArgs]);
  for (const directory of [HD, SH]) { await moe(wallet("init", directory, "--venue", venueFile, ...direct)); await moe(wallet("terms add", directory, backing, ...termsArgs)); }
  await mine(Number(DEPTH) + 2);

  let serving = serve(OP);
  await serving.listening;
  const service = JSON.parse(readFileSync(join(OP, "service.json"), "utf8"));
  serviceProxy = await countingProxy(service.url);
  const proxiedService = join(scratch, "service-proxied.json");
  writeFileSync(proxiedService, JSON.stringify({ url: serviceProxy.url, walletToken: service.walletToken }));
  const { seed } = (await moe(wallet("seed", HD, "--show"))).json;

  // The library side: the backer's, holder's and shop's wallets in this process, on one prover.
  const api = await startBackend(await readParameters(PARAMETER_DIRECTORY)), prover = await openV3Prover(api), prove = task => prover.prove(task);
  const signed = { terms: readFileSync(created.terms), signature: readFileSync(created.signature) }, backingBytes = Buffer.from(backing, "hex");
  const open = path => {
    const directory = { path, config: JSON.parse(readFileSync(join(path, "config.json"), "utf8")), file: name => join(path, name) }, view = openView(directory);
    const held = new V3Wallet(join(path, "wallet.db"), { venue: view.venue, reference: view.file.reference, verifier: prover.verifier });
    const client = new V3ServiceClient(service.url, service.walletToken, { operator: Buffer.from(operator.operator, "hex"), reference: view.file.reference });
    return { view, held, client, async evidence() { await view.sync(); return (await held.supply(store => client.sync(backingBytes, store))).package; },
      close() { held.close(); view.close(); } };
  };
  let backer = open(BK), holder = open(HD), shop = open(SH);
  const backerKey = readFileSync(join(BK, "backer.key")), domain = adoptedDomain();
  let made = 0, issued = 0;
  const waits = { SCHEDULE: 0, STALE: 0 };
  /** The successful submission's time. A refusal while the service is closed (SCHEDULE: the reopening lag; STALE: a
   * signed checkpoint not yet witnessed past the lag) is the venue wait the budget excludes: counted, a block mined,
   * submitted again. On a real chain blocks come on their own; here they come with the probe's statements. */
  const admitted = async (party, name) => {
    for (let attempt = 0; ; attempt++) {
      const began = performance.now();
      try { await party.held.submit(name, party.client); return performance.now() - began; } catch (error) {
        if (attempt >= 20 || !(error?.code in waits)) throw error;
        waits[error.code]++; await mine(1); await pause(300);
      }
    }
  };
  const afterStatement = async () => { made++; if (made % PER_BLOCK === 0) await mine(1); };
  /** Mine until serve has committed and published everything admitted and the publication is past the depth. */
  const settle = async () => {
    const committed = () => [...serving.log().matchAll(/"event":"committed".*?"admitted":"?(\d+)/g)].length;
    const before = committed();
    for (let i = 0; i < 40 && committed() === before; i++) { await mine(1); await pause(250); }
    await mine(Number(DEPTH) + 2); await pause(800);
  };

  /** One round: ROUND issues of two units to the holder's seed, then ROUND payments of one unit from the holder to the shop, each
   * spending one note and leaving the holder a change note, so the holder's wallet holds one note more per payment. */
  async function round(number) {
    const issues = [], payments = [], proving = { issue: [], payment: [] };
    let evidence = await backer.evidence();
    for (let i = 0; i < ROUND; i++, issued++) {
      const id = new Uint8Array(32); id[0] = 0xd0; new DataView(id.buffer).setUint32(28, issued);
      const out = prepareExactOutput(Buffer.from(seed, "hex"), domain, id, backingBytes, 2n), began = performance.now();
      await backer.held.issue(`issue-${issued}`, { domain, opening: out.opening, cm: out.cm, capsule: out.capsule }, 2n, evidence, signed, prove,
        message => ed25519.sign(message, backerKey));
      proving.issue.push(performance.now() - began);
      issues.push(await admitted(backer, `issue-${issued}`)); await afterStatement();
    }
    await settle();
    evidence = await holder.evidence();
    for (let i = 0; i < ROUND; i++) {
      const name = `pay-${number}-${i}`, request = shop.held.request(name, backingBytes, 1n), began = performance.now();
      await holder.held.prepare(name, { request, value: 1n }, evidence, signed, prove);
      proving.payment.push(performance.now() - began);
      payments.push(await admitted(holder, name)); await afterStatement();
    }
    await settle();
    return { statements: made, admissionMs: { issue: stats(issues), payment: stats(payments) },
      proveMs: { issue: stats(proving.issue), payment: stats(proving.payment) }, serve: serving.rssMb() };
  }

  const reader = n => join(scratch, `reader-${n}`), restored = n => join(scratch, `wallet-${n}`);
  /** A fresh reader's first read and a fresh wallet's seed restore and first sync, through the proxies. */
  async function firstSync(n) {
    const RD = reader(n), WL = restored(n);
    await moe(["reader", "init", "--dir", RD, "--venue", venueFile, ...measured]);
    await moe(["reader", "terms", "add", "--dir", RD, backing, ...termsArgs]);
    await moe(["reader", "service", "add", "--dir", RD, backing, proxiedService]);
    const read = await moe(["reader", "supply", "--dir", RD, backing]);
    assert.equal(read.json.issued, String(2 * issued), "two units an issue");
    const restore = await moe(["wallet", "restore-seed", "--dir", WL, "--venue", venueFile, ...measured], { input: `${seed}\n` });
    await moe(wallet("terms add", WL, backing, ...termsArgs));
    await moe(wallet("service add", WL, backing, proxiedService));
    const synced = await moe(wallet("sync", WL, backing));
    const strip = ({ json: _json, ...rest }) => rest;
    return { statements: made, checkpoint: read.json.checkpoint.sequence, reader: { ...strip(read), keptBytes: directoryBytes(RD) },
      wallet: { restore: strip(restore), sync: { ...strip(synced), holdings: synced.json.holdings.length }, keptBytes: directoryBytes(WL) } };
  }

  for (let number = 0; made < STATEMENTS; number++) {
    report.rounds.push(await round(number));
    process.stderr.write(`${JSON.stringify(report.rounds.at(-1))}\n`);
    if (MARKS.includes(made)) { report.marks.push(await firstSync(made)); process.stderr.write(`${JSON.stringify(report.marks.at(-1))}\n`); }
  }

  // The steady state: the last mark's reader and wallet read one more round, then again with nothing new.
  const last = MARKS.at(-1), RD = reader(last), WL = restored(last);
  report.rounds.push(await round(report.rounds.length));
  const strip = ({ json: _json, ...rest }) => rest;
  const stepRead = await moe(["reader", "supply", "--dir", RD, backing]), stepSync = await moe(wallet("sync", WL, backing));
  const idleRead = await moe(["reader", "supply", "--dir", RD, backing]), idleSync = await moe(wallet("sync", WL, backing));
  report.steady = { statements: 2 * ROUND, reader: { step: strip(stepRead), idle: strip(idleRead), keptBytes: directoryBytes(RD) },
    wallet: { step: strip(stepSync), idle: strip(idleSync), keptBytes: directoryBytes(WL) } };

  // The operator's restart over the whole history: serve starts again from its journal.
  backer.close(); holder.close(); shop.close();
  const before = serving.rssMb();
  await serving.stop();
  serving = serve(OP);
  const listening = await serving.listening;
  report.waits = waits;
  report.restart = { statements: made, startMs: listening.startMs, servedBefore: before, after: serving.rssMb(), journalBytes: directoryBytes(OP) };
  await serving.stop();
  backerKey.fill(0); await prover.close(); await api.destroy();
  console.log(JSON.stringify(report, null, 2));
  completed = true;
} finally {
  await nodeProxy.close(); await serviceProxy?.close(); await node.close();
  if (completed) { assert(scratch.startsWith(realpathSync(join(root, "scratch")) + sep)); rmSync(scratch, { recursive: true, force: true }); }
  else process.stderr.write(`design-point probe scratch retained after failure: ${scratch}\n`);
}
