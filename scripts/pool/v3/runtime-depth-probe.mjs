// Slice 11 M11c2 (probe; retires once M11c's design-point report records its measurements): the runtime at depth on
// the synthetic node, by the method of the 2026-10-03 direction (M11c): the operator's journal, a reader's and a
// wallet's stores and their Ergo views over 10⁴–10⁵ stand-in statements under real verification load, with venue ranges.
//
// History: the operator's journal (V3OperatorJournal over its own Ergo view and publisher, as `moe operator serve` opens
// it) first admits REAL issues proved through the wallet library to a holder's seed; their proofs are kept. Every later
// statement is a stand-in spend: real-size records whose proofs are random bytes, two nullifiers and four outputs
// anchored at the empty root. Every second spend pays the holder's seed one output (a genuine capsule), and every fourth
// spends one of those outputs again by its nullifier, so the holder's wallet holds about a quarter of the spends' count
// and half of what it ever received is spent. Each verifier here (journal, reader, wallet) verifies a real record's
// own proof, and at each stand-in proof verifies the next kept real proof instead: real verification load and memory,
// not the stand-ins' verdicts. A block is mined every PER_BLOCK statements (the design point's peak); commitments
// follow `serve`'s schedule (interval 2, a silence clause, so every admission reads its own checkpoint, C2b.6.1).
//
// Measured: each admission (journal.submit, in this process), split into the first after a new block (a read at a new
// venue index, WORK.md Next 4(v)) and the rest, by depth band; this process's memory and the journal's files. At each
// mark, as child processes over the reader's and wallet's own directories and views (made by the `moe` commands): a
// fresh reader's first read of the frontier and a seed-restored wallet's first sync (time, CPU, peak and sampled
// memory, bytes through counting proxies, bytes kept); then, STEP statements later, each one's next read, and a read
// with nothing new. Last, the journal's reopening.
//
// Usage: node --expose-gc scripts/pool/v3/runtime-depth-probe.mjs [--statements 10000] [--marks 1000,10000] [--step 200]
//   (after npm run build and scripts/pool/prepare-crs.mjs; prints one JSON report; progress on stderr)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { cpus, totalmem } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { deserialize, serialize } from "node:v8";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { limbsOf } from "../../../dist/pool/field.js";
import { EMPTY_NOTE_ROOT } from "../../../dist/pool/note-tree.js";
import { openDirectory, readSecret } from "../../../dist/cli/common.js";
import { openVerifier } from "../../../dist/cli/backend.js";
import { keepAliveDue, servePollsOn } from "../../../dist/cli/operator.js";
import { keptReplay, serviceClient } from "../../../dist/cli/reader.js";
import { keptTerms } from "../../../dist/cli/terms.js";
import { openPublisher, openView, requireVenue } from "../../../dist/cli/venue.js";
import { readParameters } from "../../../dist/pool/parameter-files.js";
import { startBackend } from "../../../dist/pool/proof-verifier.js";
import { prepareExactOutput } from "../../../dist/pool/v3/capsules.js";
import { adoptedDomain } from "../../../dist/pool/v3/configuration.js";
import { EvidenceStore } from "../../../dist/pool/v3/evidence-store.js";
import { readFrontier } from "../../../dist/pool/v3/package-reader.js";
import { deliveryHash, encodeRecord } from "../../../dist/pool/v3/records.js";
import { createV3Service } from "../../../dist/pool/v3/service-http.js";
import { V3ServiceClient } from "../../../dist/pool/v3/service-client.js";
import { V3OperatorJournal, V3StoreError } from "../../../dist/pool/v3/store.js";
import { openV3Verifier } from "../../../dist/pool/v3/verifier.js";
import { V3Wallet } from "../../../dist/pool/v3/wallet-store.js";

const { values: options } = parseArgs({ options: { statements: { type: "string", default: "10000" }, marks: { type: "string" },
  step: { type: "string", default: "200" }, real: { type: "string", default: "8" }, role: { type: "string" }, dir: { type: "string" },
  backing: { type: "string" }, proofs: { type: "string" } } });
const hex = bytes => Buffer.from(bytes).toString("hex");
const mib = bytes => +(bytes / 1048576).toFixed(1);
const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc(); } };
const pause = ms => new Promise(done => setTimeout(done, ms));
const directoryBytes = path => readdirSync(path, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
  .reduce((n, e) => n + statSync(join(e.parentPath, e.name)).size, 0);
const stats = values => {
  if (values.length === 0) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b), at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = v => +v.toFixed(1);
  return { count: sorted.length, mean: round(sorted.reduce((n, v) => n + v, 0) / sorted.length), median: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)) };
};

/** A verifier carrying the real one's identities: a record whose proof is one of the kept real proofs is verified as
 * it is; any other (a stand-in) verifies the next kept real proof in its place. */
function loadVerifier(real, proofs) {
  const genuine = new Set(proofs.map(p => hex(sha256(p.proof))));
  let next = 0, standIns = 0, genuineChecks = 0;
  return { identities: real.identities, parallel: real.parallel, close: () => real.close(),
    keep(proof) { proofs.push(proof); genuine.add(hex(sha256(proof.proof))); },
    get counts() { return { standIns, genuine: genuineChecks }; },
    async verify(kind, inputs, proof) {
      if (genuine.has(hex(sha256(proof)))) { genuineChecks++; return real.verify(kind, inputs, proof); }
      assert(proofs.length > 0, "a stand-in proof before any real one was kept");
      const p = proofs[next++ % proofs.length]; standIns++;
      const verified = await real.verify(p.kind, p.inputs, p.proof);
      assert.equal(verified, true, "a kept real proof failed");
      return true;
    } };
}

/** Resident memory sampled every `ms` while a child reads: the peak and the mean of each quarter. */
function memorySampler(ms = 1000) {
  const rows = [], timer = setInterval(() => rows.push(process.memoryUsage().rss), ms);
  return { stop() {
    clearInterval(timer);
    const q = Math.max(1, Math.floor(rows.length / 4)), quarter = i => mib(rows.slice(i * q, (i + 1) * q).reduce((n, v) => n + v, 0) / Math.max(1, rows.slice(i * q, (i + 1) * q).length));
    return { samples: rows.length, quarterMeansMb: [0, 1, 2, 3].map(quarter), peakMb: mib(Math.max(0, ...rows)) };
  } };
}

if (options.role !== undefined) {
  // A child: one read over a reader's or wallet's directory, reporting its own time, CPU and memory as one JSON line.
  const began = performance.now(), sampler = memorySampler();
  const role = options.role, directory = openDirectory(options.dir, role), venueFile = requireVenue(directory);
  const backing = Buffer.from(options.backing, "hex"), kept = keptTerms(directory, backing, venueFile);
  const view = openView(directory);
  const synced = await view.syncWitnessed(), at = synced.witnessedIndex, viewMs = performance.now() - began;
  const verifier = loadVerifier(await openVerifier(directory, 2), deserialize(readFileSync(options.proofs)));
  const client = serviceClient(directory, kept, view);
  const readBegan = performance.now();
  let out;
  if (role === "reader") {
    const evidence = new EvidenceStore(directory.file("evidence.db")), store = keptReplay(directory, at);
    try {
      const served = await client.sync(kept.backing, evidence), fetchedMs = performance.now() - readBegan;
      const read = await readFrontier(served.package, kept.signed, at, { verifier, venue: view.venue, reference: view.file.reference, evidence, store, answers: false });
      const state = read.canonical?.state;
      out = { fetchMs: Math.round(fetchedMs), position: state?.position.toString(), issued: state?.issued.toString(), sequence: read.canonical?.commitment.sequence.toString() };
    } finally { store.close(); evidence.close(); }
  } else {
    const wallet = new V3Wallet(directory.file("wallet.db"), { venue: view.venue, reference: view.file.reference, verifier });
    try {
      const served = await wallet.supply(evidence => client.sync(kept.backing, evidence)), fetchedMs = performance.now() - readBegan;
      const walletView = await wallet.sync(served.package, kept.signed);
      out = { fetchMs: Math.round(fetchedMs), sequence: walletView.checkpoint?.sequence.toString(), holdings: walletView.holdings.length,
        available: walletView.holdings.filter(h => h.status === "available").reduce((n, h) => n + h.value, 0n).toString() };
    } finally { wallet.close(); }
  }
  const readMs = performance.now() - readBegan;
  await verifier.close(); view.close();
  gc();
  const { maxRSS, userCPUTime, systemCPUTime } = process.resourceUsage();
  process.stdout.write(`${JSON.stringify({ role, judgingIndex: at.toString(), viewMs: Math.round(viewMs), readMs: Math.round(readMs), ...out,
    verified: verifier.counts, elapsedMs: Math.round(performance.now() - began), cpuMs: Math.round((userCPUTime + systemCPUTime) / 1000),
    maxRssMb: Math.round(maxRSS / 1024), memory: sampler.stop(), heapAfterMb: mib(process.memoryUsage().heapUsed) })}\n`);
  process.exit(0);
}

const { serveSyntheticNode } = await import("./synthetic-node.mjs");
const { PARAMETER_DIRECTORY } = await import("../prepare-crs.mjs");
const STATEMENTS = Number(options.statements), STEP = Number(options.step), REAL = Number(options.real);
const MARKS = (options.marks ?? [STATEMENTS / 10, STATEMENTS].join(",")).split(",").map(Number);
assert(MARKS.every(m => Number.isSafeInteger(m) && m > REAL && m <= STATEMENTS) && STEP > 0 && REAL > 0, "marks lie past the real issues, within the statements");
const PER_BLOCK = 14, INTERVAL = 2n, SILENCE = "32", DEPTH = "2", BANDS = 10;
const root = resolve(import.meta.dirname, "../../.."), MOE = join(root, "dist", "cli", "moe.js"), RSS_HOOK = new URL("./rss-hook.mjs", import.meta.url).href;
const SELF = new URL(import.meta.url).pathname;
mkdirSync(join(root, "scratch"), { recursive: true });
const scratch = realpathSync(mkdtempSync(join(realpathSync(join(root, "scratch")), "runtime-depth-")));
process.stderr.write(`runtime-depth probe in ${scratch}\n`);

/** A loopback TCP proxy to `target` counting the bytes each way. */
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

/** One `moe` command (directory set-up only; nothing measured). */
function moe(args, { input } = {}) {
  return new Promise((done, failed) => {
    const child = spawn(process.execPath, [MOE, ...args], { cwd: scratch, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (input !== undefined) child.stdin.end(input);
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", failed);
    child.on("close", status => status === 0 ? done(JSON.parse(stdout.trim().split("\n").at(-1))) : failed(new Error(`moe ${args.join(" ")} exited ${status}: ${stderr}`)));
  });
}
let serviceProxy;
/** One measured read in a child process, through the counting proxies. */
function child(role, directory, extra = []) {
  return new Promise((done, failed) => {
    nodeProxy.take(); serviceProxy.take();
    const rss = join(scratch, `rss-${process.hrtime.bigint()}.json`);
    const spawned = spawn(process.execPath, ["--expose-gc", "--import", RSS_HOOK, SELF, "--role", role, "--dir", directory, "--backing", backingHex,
      "--proofs", proofsFile, ...extra], { cwd: scratch, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MOE_DRILL_RSS: rss } });
    let stdout = "", stderr = "";
    spawned.stdout.on("data", chunk => { stdout += chunk; }); spawned.stderr.on("data", chunk => { stderr += chunk; });
    spawned.on("error", failed);
    spawned.on("close", status => {
      const bytes = { node: nodeProxy.take(), service: serviceProxy.take() };
      let usage = {};
      try { usage = JSON.parse(readFileSync(rss, "utf8")); rmSync(rss); } catch { /* died before its exit handler */ }
      if (status !== 0) return failed(new Error(`${role} child exited ${status}: ${stderr}`));
      done({ ...JSON.parse(stdout.trim().split("\n").at(-1)), withWorkersMaxRssMb: Math.round(usage.maxRssKb / 1024), noir: usage.noir,
        bytes: { nodeDown: bytes.node.down, nodeUp: bytes.node.up, serviceDown: bytes.service.down, serviceUp: bytes.service.up }, keptBytes: directoryBytes(directory) });
    });
  });
}

let backingHex, proofsFile, completed = false;
const report = { host: { cores: cpus().length, model: cpus()[0]?.model, memoryGb: Math.round(totalmem() / 2 ** 30), node: process.version, platform: process.platform },
  shape: { statements: STATEMENTS, real: REAL, perBlock: PER_BLOCK, serveInterval: Number(INTERVAL), silence: Number(SILENCE), depth: Number(DEPTH), step: STEP, marks: MARKS },
  bands: [], marks: [], waits: { SCHEDULE: 0, STALE: 0 }, refusedPolls: 0 };
const save = () => writeFileSync(join(scratch, "report.json"), JSON.stringify(report, null, 2));
try {
  const direct = ["--node", node.url, "--parameters", PARAMETER_DIRECTORY], measured = ["--node", nodeProxy.url, "--parameters", PARAMETER_DIRECTORY];
  const OP = join(scratch, "operator"), BK = join(scratch, "backer");
  await mine(Number(DEPTH) + 2);
  const operatorInit = await moe(["operator", "init", "--dir", OP, ...direct, "--budget", "100000000000000"]);
  await call("/synthetic/fund", { tree: operatorInit.fundingTree, value: "100000000000000" });
  await moe(["operator", "venue", "create", "--dir", OP, "--synthetic", "--depth", DEPTH]);
  await mine(Number(DEPTH) + 1);
  const venueFile = join(OP, "venue.json");
  await moe(["wallet", "init", "--dir", BK, "--backer", "--venue", venueFile, ...direct]);
  const created = await moe(["wallet", "terms", "create", "--dir", BK, "--operator", operatorInit.operator, "--thing", "probe units", "--per-unit", "1",
    "--interval", "80", "--silence", SILENCE, "--challenge", "5"]);
  backingHex = created.backing;
  const termsArgs = ["--terms", created.terms, "--signature", created.signature, "--synthetic"];
  await moe(["operator", "open", "--dir", OP, "--id", "genesis", backingHex, ...termsArgs]);
  await mine(Number(DEPTH) + 2);

  // The operator's journal over its own view and publisher, as `moe operator serve` opens it, with the load verifier.
  const op = openDirectory(OP, "operator"), view = openView(op);
  await view.syncWitnessed();
  const api = await startBackend(await readParameters(PARAMETER_DIRECTORY));
  // The prover loads @noir-lang: imported here, so a child (verify-only, as the commands are) loads none.
  const { openV3Prover } = await import("../../../dist/pool/v3/prover.js");
  const prover = await openV3Prover(api, { instances: 2 }), proofs = [];
  let verifier = loadVerifier(await openV3Verifier(api, { instances: 2 }), proofs);
  const operatorSecret = readSecret(op.file("operator.key"), "operator.key");
  const openJournal = () => new V3OperatorJournal(op.file("journal.db"), { secret: operatorSecret, venue: view.venue, reference: view.file.reference, verifier });
  let journal = openJournal();
  const publisher = openPublisher(op, journal.publisherPersistence());
  view.venue.attachPublisher(publisher.publisher);
  // The service reaches whichever journal is open (it is reopened last).
  const current = new Proxy({}, { get(_target, property) { const value = Reflect.get(journal, property, journal); return typeof value === "function" ? value.bind(journal) : value; } });
  const walletToken = "11".repeat(32), server = createV3Service(current, { walletToken, adminToken: "22".repeat(32) });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const serviceUrl = `http://127.0.0.1:${server.address().port}/`;
  serviceProxy = await countingProxy(serviceUrl);
  const serviceFile = join(scratch, "service.json");
  writeFileSync(serviceFile, JSON.stringify({ url: `${serviceProxy.url}/`, walletToken }));
  const lag = view.venue.lag(), backing = Buffer.from(backingHex, "hex"), domain = adoptedDomain();
  const signed = { terms: readFileSync(created.terms), signature: readFileSync(created.signature) };

  /** `serve`'s poll, after each mined block: publish the latest signed commitment until the venue holds it; commit and
   * publish when statements were admitted INTERVAL indices since it, or for keep-alive. */
  let commits = 0;
  const tick = async () => {
    await view.sync();
    try {
      const s = await journal.status(), current = s.signed;
      if (current === undefined) return;
      if (!current.held) { await journal.publish(); return; }
      const admitted = current.admitted > 0n && s.now >= current.at + INTERVAL;
      if (!admitted && !keepAliveDue(s.now, s.heldIndex, BigInt(SILENCE), lag)) return;
      await journal.commit(`serve:${s.now}`); commits++;
      await journal.publish();
    } catch (error) { if (!servePollsOn(error)) throw error; report.refusedPolls++; }
  };
  const block = async () => { await mine(1); await tick(); };
  /** Mine until everything admitted is committed, published and held past the depth. */
  const settle = async () => {
    for (let i = 0; i < 60; i++) {
      const s = await journal.status();
      if (s.signed?.held && s.signed.admitted === 0n) break;
      await block();
    }
    for (let i = 0; i < Number(DEPTH) + 2; i++) await block();
    const s = await journal.status();
    assert(s.signed?.held && s.signed.admitted === 0n, "the journal settled");
  };

  // The real issues: proved through the backer's wallet in this process, admitted through the service.
  const seed = randomBytes(32), backerKey = readSecret(join(BK, "backer.key"), "backer.key");
  const bk = openDirectory(BK, "wallet"), backerView = openView(bk);
  const backer = new V3Wallet(bk.file("wallet.db"), { venue: backerView.venue, reference: backerView.file.reference, verifier });
  const client = new V3ServiceClient(serviceUrl, walletToken, { operator: journal.operatorKey, reference: backerView.file.reference });
  await backerView.sync();
  const evidence = (await backer.supply(store => client.sync(backing, store))).package;
  const prove = async task => { const record = await prover.prove(task); verifier.keep({ kind: record.kind, inputs: record.publicInputs, proof: record.proof }); return record; };
  let made = 0, prefix;
  for (let i = 0; i < REAL; i++) {
    const out = prepareExactOutput(seed, domain, sha256(Buffer.from(`real-${i}`)), backing, 2n);
    const act = await backer.issue(`issue-${i}`, { domain, opening: out.opening, cm: out.cm, capsule: out.capsule }, 2n, evidence, signed, prove,
      message => ed25519.sign(message, backerKey));
    // The journal opened here is a reopening: it admits once the venue passes its reopening index plus the lag.
    for (let attempt = 0; ; attempt++) {
      try { await backer.submit(`issue-${i}`, client); break; } catch (error) {
        if (attempt >= 20 || !(error?.code in report.waits)) throw error;
        report.waits[error.code]++; await block();
      }
    }
    made++;
    prefix ??= (await import("../../../dist/pool/v3/records.js")).decodeRecord(act.record).publicInputs.slice(0, 5);
  }
  backer.close(); backerView.close(); backerKey.fill(0);
  await prover.close();
  proofsFile = join(scratch, "proofs.bin");
  writeFileSync(proofsFile, serialize(proofs));
  const proofBytes = proofs[0].proof.length;
  report.shape.proofBytes = proofBytes;
  await settle();

  // Stand-in spends.
  const MODULUS = 21888242871839275222246405745257275088548364400416903490308238158651n;
  const fieldOf = () => { for (;;) { const v = BigInt(`0x${randomBytes(32).toString("hex")}`) % MODULUS; if (v !== 0n) return v; } };
  const capsuleOf = () => { const c = randomBytes(89); c[0] = 1; return c; };
  const owned = [];
  let ownedOutputs = 0, ownedSpent = 0;
  const standIn = i => {
    const nfs = [fieldOf(), fieldOf()], outs = [], caps = [];
    if (i % 4 === 0 && owned.length > 16) { nfs[0] = owned.shift(); ownedSpent++; }
    for (let k = 0; k < 4; k++) {
      if (k === 0 && i % 2 === 0) {
        const out = prepareExactOutput(seed, domain, sha256(Buffer.from(`out-${i}`)), backing, 1n);
        outs.push(out.cm); caps.push(out.capsule); owned.push(out.nf); ownedOutputs++;
      } else { outs.push(fieldOf()); caps.push(capsuleOf()); }
    }
    return encodeRecord({ domain, kind: 2, publicInputs: [...prefix, EMPTY_NOTE_ROOT, EMPTY_NOTE_ROOT, ...nfs, ...outs, ...limbsOf(deliveryHash(domain, outs, caps))],
      proof: randomBytes(proofBytes), authorization: new Uint8Array(), capsules: caps });
  };
  let band = { first: [], rest: [] }, newBlock = false;
  const bandSize = Math.max(PER_BLOCK, Math.floor(STATEMENTS / BANDS)), generateBegan = performance.now();
  const admit = async bytes => {
    for (let attempt = 0; ; attempt++) {
      const began = performance.now();
      try { await journal.submit(bytes); return performance.now() - began; } catch (error) {
        if (attempt >= 20 || !(error instanceof V3StoreError) || !(error.code in report.waits)) throw error;
        report.waits[error.code]++; await block(); newBlock = true;
      }
    }
  };
  const afterStatement = async () => {
    made++;
    if (made % PER_BLOCK === 0) { await block(); newBlock = true; }
    if (made % bandSize === 0 || made === STATEMENTS) {
      gc();
      const m = process.memoryUsage();
      report.bands.push({ through: made, firstInBlockMs: stats(band.first), otherMs: stats(band.rest), commits, heapMb: mib(m.heapUsed), rssMb: mib(m.rss),
        journalMb: mib(directoryBytes(OP)), elapsedS: Math.round((performance.now() - generateBegan) / 1000) });
      process.stderr.write(`${JSON.stringify(report.bands.at(-1))}\n`); save();
      band = { first: [], rest: [] };
    }
  };
  const generate = async until => {
    while (made < until) {
      const bytes = standIn(made), first = newBlock;
      newBlock = false;
      const ms = await admit(bytes);
      (first ? band.first : band.rest).push(ms);
      await afterStatement();
    }
  };
  const reader = n => join(scratch, `reader-${n}`), wallet = n => join(scratch, `wallet-${n}`);
  for (const mark of MARKS) {
    await generate(mark);
    await settle();
    const RD = reader(mark), WL = wallet(mark);
    await moe(["reader", "init", "--dir", RD, "--venue", venueFile, ...measured]);
    await moe(["reader", "terms", "add", "--dir", RD, backingHex, ...termsArgs]);
    await moe(["reader", "service", "add", "--dir", RD, backingHex, serviceFile]);
    await moe(["wallet", "restore-seed", "--dir", WL, "--venue", venueFile, ...measured], { input: `${hex(seed)}\n` });
    await moe(["wallet", "terms", "add", "--dir", WL, backingHex, ...termsArgs]);
    await moe(["wallet", "service", "add", "--dir", WL, backingHex, serviceFile]);
    const entry = { statements: made, ownedOutputs, ownedSpent, readerFirst: await child("reader", RD) };
    process.stderr.write(`${JSON.stringify(entry)}\n`);
    entry.walletFirst = await child("wallet", WL);
    process.stderr.write(`${JSON.stringify(entry.walletFirst)}\n`);
    assert.equal(entry.readerFirst.position, String(made), "the reader read every statement");
    assert.equal(entry.readerFirst.issued, String(2 * REAL));
    report.marks.push(entry); save();
    // STEP statements later: each one's next read, then a read with nothing new.
    await generate(made + STEP);
    await settle();
    entry.step = { statements: STEP, reader: await child("reader", RD), wallet: await child("wallet", WL) };
    entry.idle = { reader: await child("reader", RD), wallet: await child("wallet", WL) };
    process.stderr.write(`${JSON.stringify({ step: entry.step, idle: entry.idle })}\n`); save();
    assert.equal(entry.step.reader.position, String(made));
  }
  // The journal's reopening over the whole history: it verifies nothing (no proof check) and signs again only once the
  // venue passes its reopening index plus the lag; then the first admission's time.
  const checksBefore = verifier.counts.standIns + verifier.counts.genuine;
  journal.close();
  const reopenBegan = performance.now();
  journal = openJournal();
  const reopenMs = performance.now() - reopenBegan;
  const reopenChecks = verifier.counts.standIns + verifier.counts.genuine - checksBefore;
  const firstAfter = await admit(standIn(made)); made++;
  report.reopen = { statements: made, reopenMs: Math.round(reopenMs), proofChecks: reopenChecks, firstAdmissionMs: Math.round(firstAfter),
    journalMb: mib(directoryBytes(OP)) };
  report.verifier = verifier.counts;
  journal.close(); publisher.budget.close(); view.close();
  await verifier.close(); await api.destroy();
  server.closeAllConnections(); await new Promise(done => server.close(done));
  operatorSecret.fill(0);
  console.log(JSON.stringify(report, null, 2));
  completed = true;
} finally {
  save();
  await nodeProxy.close(); await serviceProxy?.close(); await node.close();
  if (completed) { assert(scratch.startsWith(realpathSync(join(root, "scratch")) + sep)); rmSync(scratch, { recursive: true, force: true }); }
  else process.stderr.write(`runtime-depth probe scratch retained after failure: ${scratch}\n`);
}
