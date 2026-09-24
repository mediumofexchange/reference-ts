// Framer node equivalence on hostile bytes, at the parse level: deterministic mutations of the hash-pinned corpus
// transactions' unsigned bytes, each read by the node's own parser (node-read/NodeRead.java over the official v6.0.6
// JAR, offline), and every reading the node gives read again by the profile's framer (model/pool-v3-ergo-profile.ts).
//
// The reader takes a transaction's unsigned bytes and frames them itself; the header's root binds those bytes, so
// every reader frames a committed transaction alike. What matters is that the framer never reads a transaction the
// node reads with other outputs: for every transaction the node reads (a whole case, a prefix it would read as one
// transaction of a section, or the node's own rewrite of a case), the node's unsigned bytes must hash to its id and,
// where the framer reads them, give the node's output count, ErgoTree bytes and register constants. A transaction the
// framer does not read carries no record and withholds nothing. Bytes the node refuses cannot be a transaction of a
// block the node accepts under this version context, so a framer reading of them is counted, not compared. The seeds
// are the unsigned bytes supply.mjs copies from the corpus, so the mutations land in the framer's own input.
// Nothing here says the node would accept a case: no state, proofs or validity are checked beyond the node's recorded
// stateless verdict, and no runtime path reads this.
//
// Usage, from the repository root, with a JDK for javac (the node's bundled runtime has no compiler) and the own
// node's bundle (nodes.mjs):
//   node experiments/ergo-range/hostile-equivalence.mjs --jdk <jdk dir> [--node-dir scratch/ergo-nodes/v6.0.6]
//     [--work scratch/hostile-framer] [--out docs/ergo-framer-hostile-equivalence-verification.json] [--seeds n]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { blake2b } from "@noble/hashes/blake2b";
import { parseNodeJson, supplyTransaction } from "./supply.mjs";

const here = import.meta.dirname, root = resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const jdk = option("--jdk");
assert(jdk, "--jdk <dir> names a JDK whose javac compiles the node harness");
const nodeDir = resolve(root, option("--node-dir", "scratch/ergo-nodes/v6.0.6"));
const work = resolve(root, option("--work", "scratch/hostile-framer"));
const out = resolve(root, option("--out", "docs/ergo-framer-hostile-equivalence-verification.json"));
mkdirSync(join(work, "classes"), { recursive: true });

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const hex = bytes => Buffer.from(bytes).toString("hex");
const files = Object.fromEntries(["experiments/ergo-range/hostile-equivalence.mjs", "experiments/ergo-range/node-read/NodeRead.java",
  "experiments/ergo-range/supply.mjs", "tsconfig.json", "experiments/ergo-range/fixtures/manifest.json",
  "experiments/ergo-range/package.json", "experiments/ergo-range/package-lock.json"].map(file => [file, sha256(readFileSync(join(root, file)))]));

// The node: the JAR nodes.mjs pins, compiled against and run in the bundle's own runtime.
const JAR_SHA256 = "21b9023933b19b98b7eb4d50cb78bcb6c827a0fe65711a00ceaf1b83f8f3a323";
const jar = join(nodeDir, "ergo-6.0.6.jar"), java = join(nodeDir, "jre", "bin", "java");
assert.equal(sha256(readFileSync(jar)), JAR_SHA256, "the node JAR is the pinned v6.0.6 release");
const firstLineOf = result => `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n")[0].trim();
const compiled = spawnSync(join(jdk, "bin", "javac"), ["--release", "21", "-nowarn", "-cp", jar, "-d", join(work, "classes"),
  join(here, "node-read", "NodeRead.java")], { encoding: "utf8" });
assert.equal(compiled.status, 0, `javac: ${compiled.stderr}`);
const node = { jarSha256: JAR_SHA256, runtimeReleaseSha256: sha256(readFileSync(join(nodeDir, "jre", "release"))), runtime: firstLineOf(spawnSync(java, ["-version"], { encoding: "utf8" })),
  compiler: firstLineOf(spawnSync(join(jdk, "bin", "javac"), ["-version"], { encoding: "utf8" })), heap: "-Xmx4G, as ergo-node.ps1 runs it" };

// The profile's framer, compiled from source into a disposable build as profile-check.mjs does; every repository source
// the compilation reads is bound.
const build = realpathSync(mkdtempSync(join(realpathSync(join(root, "scratch")), "hostile-framer-")));
let profile;
try {
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  assert(!config.error, "TypeScript configuration unreadable");
  const program = ts.createProgram([join(root, "model/pool-v3-ergo-profile.ts")], {
    ...ts.parseJsonConfigFileContent(config.config, ts.sys, root).options, noEmit: false, rootDir: root, outDir: build, declaration: false, sourceMap: false });
  assert.equal(ts.getPreEmitDiagnostics(program).length, 0, "model compiles");
  assert.equal(program.emit().emitSkipped, false);
  for (const source of program.getSourceFiles()) {
    const path = resolve(source.fileName);
    if (path.startsWith(root + sep) && !path.includes(`${sep}node_modules${sep}`)) files[path.slice(root.length + 1).replace(/\\/g, "/")] = sha256(readFileSync(path));
  }
  profile = await import(new URL("model/pool-v3-ergo-profile.js", pathToFileURL(build + sep).href));
} finally { rmSync(build, { recursive: true, force: true }); }

// Seeds: every corpus transaction, pinned by the manifest before parsing, as the unsigned bytes supply.mjs copies from it.
const manifest = JSON.parse(readFileSync(join(here, "fixtures/manifest.json")));
// --seeds n keeps the first n seeds, for a quick run; the report records it.
const seedLimit = Number(option("--seeds", "Infinity"));
const seeds = [];
for (const fixture of manifest.fixtures) {
  const raw = readFileSync(join(here, fixture.file));
  assert.equal(sha256(raw), fixture.sha256, `${fixture.file} is the pinned fixture`);
  for (const [position, statement] of parseNodeJson(raw.toString("utf8")).get("blockTransactions").get("transactions").entries()) {
    const supplied = supplyTransaction(statement);
    assert(supplied !== undefined, `${fixture.file} transaction ${position} is supplied`);
    seeds.push({ height: fixture.height, position, id: statement.get("id"), bytes: Buffer.from(supplied.unsigned) });
  }
}
seeds.splice(seedLimit);

// The compared fields as the node states them (NodeRead.java: its id and witness id, each output's parsed ErgoTree
// bytes and register constants) and as the framer reads the node's unsigned bytes.
const nodeFields = tx => ({ id: tx.id, witnessId: tx.witnessId, outputs: tx.outputs.map(o => ({ ergoTree: o.ergoTree, registers: { ...o.registers } })) });
const framedFields = (tx, outputs) => ({ id: tx.id, witnessId: tx.witnessId,
  outputs: outputs.map(o => ({ ergoTree: hex(o.ergoTree), registers: Object.fromEntries(Object.entries(o.registers).map(([k, v]) => [k, hex(v)])) })) });
function differences(a, b) {
  const found = [];
  if (a.id !== b.id) found.push("id");
  if (a.witnessId !== b.witnessId) found.push("witnessId");
  if (a.outputs.length !== b.outputs.length) return [...found, "outputCount"];
  a.outputs.forEach((o, i) => {
    const p = b.outputs[i];
    if (o.ergoTree !== p.ergoTree) found.push("ergoTree");
    const names = Object.keys(o.registers).sort(), other = Object.keys(p.registers).sort();
    if (names.join() !== other.join()) found.push("registerNames");
    else if (names.some(name => o.registers[name] !== p.registers[name])) found.push("register");
  });
  return [...new Set(found)];
}

// Mutations, deterministic: every position's byte replaced by four values, deleted, and preceded by 0x00 and by 0x80
// (and both appended); every proper nonempty prefix; and 256 seeded splices per seed replacing a run of up to 64
// bytes with a run of up to 64 bytes from another seed.
const REPLACEMENTS = [b => b ^ 0x01, b => b ^ 0x80, () => 0x00, () => 0xff];
const SPLICES = 256;
function sfc32(a, b, c, d) {
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b | 0) + d | 0;
    d = d + 1 | 0; a = b ^ b >>> 9; b = c + (c << 3) | 0; c = c << 21 | c >>> 11; c = c + t | 0;
    return (t >>> 0) / 4294967296;
  };
}
const random = sfc32(0x6d6f652d, 0x686f7374, 0x696c652d, 0x65717569);
const below = n => Math.floor(random() * n);
const cases = [];
const seen = new Map();
let duplicates = 0;
const add = (seed, kind, bytes, detail) => {
  const key = sha256(bytes);
  if (seen.has(key) || bytes.length === 0) { duplicates++; return; }
  seen.set(key, cases.length);
  cases.push({ seed, kind, bytes, ...detail });
};
seeds.forEach(({ bytes }, seed) => {
  add(seed, "seed", bytes, {});
  for (let at = 0; at < bytes.length; at++) {
    for (const replace of REPLACEMENTS) {
      const changed = Buffer.from(bytes);
      changed[at] = replace(bytes[at]);
      if (changed[at] !== bytes[at]) add(seed, "replace", changed, { at, value: changed[at] });
    }
    add(seed, "delete", Buffer.concat([bytes.subarray(0, at), bytes.subarray(at + 1)]), { at });
    add(seed, "prefix", bytes.subarray(0, at), { at });
  }
  for (let at = 0; at <= bytes.length; at++) {
    for (const value of [0x00, 0x80]) add(seed, "insert", Buffer.concat([bytes.subarray(0, at), Buffer.from([value]), bytes.subarray(at)]), { at, value });
  }
  for (let i = 0; i < SPLICES; i++) {
    const from = below(bytes.length), to = Math.min(bytes.length, from + below(65));
    const donorSeed = below(seeds.length), donor = seeds[donorSeed].bytes, start = below(donor.length), run = donor.subarray(start, start + below(65));
    add(seed, "splice", Buffer.concat([bytes.subarray(0, from), run, bytes.subarray(to)]), { at: from, to, donor: { seed: donorSeed, start, length: run.length } });
  }
});
console.error(`${seeds.length} seeds, ${cases.length} distinct cases (${duplicates} duplicates or empty dropped)`);

// The node reads every case in one run of its runtime; its answers stream back in case order.
const readByNode = (inputs, name) => {
  const inputFile = join(work, `${name}.txt`), outputFile = join(work, `${name}-node.jsonl`);
  writeFileSync(inputFile, inputs.join("\n") + "\n");
  const fd = openSync(outputFile, "w");
  const run = spawnSync(java, ["-Xmx4G", "-cp", `${jar}${process.platform === "win32" ? ";" : ":"}${join(work, "classes")}`, "NodeRead", inputFile],
    { stdio: ["ignore", fd, "pipe"], encoding: "utf8", timeout: 4 * 3600 * 1000 });
  closeSync(fd);
  assert.equal(run.status, 0, `the node harness ran: ${run.stderr}`);
  return outputFile;
};
const t0 = performance.now();
const nodeFile = readByNode(cases.map(c => hex(c.bytes)), "cases");
const nodeMs = performance.now() - t0;

const counts = {};
const tally = (...path) => { let at = counts; for (const key of path.slice(0, -1)) at = at[key] ??= {}; at[path.at(-1)] = (at[path.at(-1)] ?? 0) + 1; };
const samples = {};
const SAMPLE = 20;
// The node's resource refusals are counted, never sampled: a sample is a reproducer.
const RESOURCE = /^java\.lang\.(OutOfMemoryError|StackOverflowError|VirtualMachineError|InternalError)$/;
const sample = (outcome, c, extra) => {
  const list = samples[outcome] ??= [];
  if (list.length < SAMPLE) list.push({ seed: c.seed, kind: c.kind, at: c.at, ...(c.value === undefined ? {} : { value: c.value }),
    ...(c.to === undefined ? {} : { to: c.to, donor: c.donor }), length: c.bytes.length, ...extra });
};
// The reader's own path for every transaction the node reads: the node's unsigned bytes must hash to its id, and where
// the framer reads them, every output must be the node's. A framed reading with other outputs is the disagreement
// that would matter; an unframed one gives no record and withholds nothing. Returns "equal", "unframed" or "differs".
let framerDiffers = 0, frameMs = 0;
const frameNode = (c, tx, extra, wholeCase) => {
  const unsigned = Buffer.from(tx.unsigned, "hex");
  tally("framer", hex(blake2b(unsigned, { dkLen: 32 })) === tx.id ? "idFromUnsigned" : "idNotFromUnsigned");
  if (wholeCase) tally("framer", unsigned.equals(c.bytes) ? "caseIsNodeWriting" : "caseRewritten");
  const t1 = performance.now();
  const outputs = profile.frameTransaction(unsigned);
  frameMs += performance.now() - t1;
  if (outputs === undefined) { tally("framer", "unframed"); return "unframed"; }
  const fields = differences(framedFields(tx, outputs), nodeFields(tx));
  tally("framer", fields.length === 0 ? "framedEqual" : "framedDiffers");
  if (fields.length > 0) { framerDiffers++; sample("framer:differs", c, { ...extra, fields }); }
  return fields.length === 0 ? "equal" : "differs";
};
// What the mutations reached: per compared field, how many cases the node read whole and unchanged, and the framer
// read equal to it, with that field unlike the seed's.
const reached = {};
const seedFields = [];
// The node's rewrites, each read by the node again below: its writing must be what it reads back.
const rewrites = new Map();
let uncompared = 0;
let versionContext, index = 0;
const lines = createInterface({ input: createReadStream(nodeFile, "utf8"), crlfDelay: Infinity });
for await (const line of lines) {
  const answer = JSON.parse(line);
  if (versionContext === undefined) { versionContext = answer.versionContext; assert(versionContext, "the harness states its version context"); continue; }
  const c = cases[index++];
  assert(c, "no more node answers than cases");
  let outcome;
  // A case the node read but could not state was never compared: the run is then inconclusive.
  if (answer.encodeFailed !== undefined) { outcome = "nodeEncodeFailed"; uncompared++; sample(outcome, c, { node: answer.encodeFailed }); }
  else if (answer.refused !== undefined) {
    const resource = RESOURCE.test(answer.refused);
    // Where the node runs out of its runtime's resources on a case the framer reads, a node with more might read it:
    // that case goes uncompared.
    if (profile.frameTransaction(c.bytes) !== undefined) {
      outcome = "framerReadsNodeRefuses";
      if (resource) uncompared++;
      else sample(outcome, c, { node: answer.refused });
    } else outcome = "bothRefuse";
    tally("nodeRefusals", resource ? "resource" : answer.refused);
  } else {
    assert(Number.isSafeInteger(answer.read) && answer.read > 0 && answer.read <= c.bytes.length, "the node read within the case");
    tally("nodeStateless", answer.stateless === "ok" ? "ok" : "failed");
    const whole = answer.read === c.bytes.length;
    const extra = { stateless: answer.stateless === "ok", ...(answer.rewritten ? { rewritten: true } : {}), ...(whole ? {} : { read: answer.read }) };
    const framed = frameNode(c, answer.tx, extra, whole);
    // A proper prefix is what the node reads as one transaction of a block section before it continues after it.
    outcome = !whole ? "nodeReadsPrefix" : answer.rewritten ? "nodeReadsAndRewrites" : "nodeReads";
    if (c.kind === "seed") assert(whole && answer.tx.id === seeds[c.seed].id && !answer.rewritten && framed !== "differs", `the node reads seed ${c.seed} under its chain id, unchanged, and the framer reads it alike or not at all`);
    if (whole && !answer.rewritten) {
      if (c.kind === "seed") seedFields[c.seed] = nodeFields(answer.tx);
      else if (framed === "equal" && seedFields[c.seed] !== undefined) for (const field of differences(nodeFields(answer.tx), seedFields[c.seed])) reached[field] = (reached[field] ?? 0) + 1;
    }
    // Where the node writes what it read as other bytes, the header commits to the rewrite; it is read by the node again below.
    if (answer.rewritten && !rewrites.has(answer.rewritten)) rewrites.set(answer.rewritten, { c, extra, fields: nodeFields(answer.tx) });
  }
  tally("outcomes", outcome);
  tally("byKind", c.kind, outcome);
  if (index % 20000 === 0) console.error(`  ${index}/${cases.length}`);
}
assert.equal(index, cases.length, "one node answer per case");
seeds.forEach((_, seed) => assert(seedFields[seed], `the node and the framer read seed ${seed} alike`));

// Controls, so an empty disagreement count is not a comparison that cannot fail: each compared field changed in the
// node's reading of a seed with registers shows as a difference in that field.
const flip = text => text.slice(0, -1) + (parseInt(text.at(-1), 16) ^ 1).toString(16);
const controlSeed = seedFields.findIndex(f => f.outputs.some(o => Object.keys(o.registers).length > 0));
assert(controlSeed >= 0, `a seed with registers serves as the control: ${JSON.stringify(counts.outcomes)}`);
const control = seedFields[controlSeed];
const firstWithRegisters = f => f.outputs.find(o => Object.keys(o.registers).length > 0).registers;
const CONTROLS = {
  id: f => { f.id = flip(f.id); },
  witnessId: f => { f.witnessId = flip(f.witnessId); },
  outputCount: f => { f.outputs.pop(); },
  ergoTree: f => { f.outputs[0].ergoTree = flip(f.outputs[0].ergoTree); },
  register: f => { const r = firstWithRegisters(f), name = Object.keys(r)[0]; r[name] = flip(r[name]); },
  registerNames: f => { const r = firstWithRegisters(f); delete r[Object.keys(r)[0]]; },
};
const controls = { seed: controlSeed, detected: Object.fromEntries(Object.entries(CONTROLS).map(([field, mutate]) => {
  const copy = structuredClone(control);
  mutate(copy);
  return [field, differences(control, copy).includes(field)];
})) };
assert(Object.values(controls.detected).every(Boolean), `every control shows as a difference: ${JSON.stringify(controls)}`);

// The node reads each distinct rewrite of its own again: stable if it reads it whole and unchanged with the fields it
// stated for the case. The bytes a supplier of the node's writing serves are the rewrite, so the framer reads the
// rewrite against the node's reading of it. An unstable rewrite goes uncompared.
const rewriteInputs = [...rewrites.keys()];
const rereads = { rewrites: rewriteInputs.length, stable: 0, unstable: {} };
if (rewriteInputs.length > 0) {
  const answers = readFileSync(readByNode(rewriteInputs, "rewrites"), "utf8").trim().split("\n").slice(1).map(line => JSON.parse(line));
  assert.equal(answers.length, rewriteInputs.length, "one node answer per rewrite");
  answers.forEach((answer, i) => {
    const { c, extra, fields } = rewrites.get(rewriteInputs[i]);
    const reason = answer.refused !== undefined ? (RESOURCE.test(answer.refused) ? "resource" : "refused") : answer.encodeFailed !== undefined ? "encodeFailed"
      : answer.rewritten ? "rewritesAgain" : answer.read * 2 !== rewriteInputs[i].length ? "readsPrefix"
      : differences(nodeFields(answer.tx), fields).length > 0 ? "otherFields" : undefined;
    if (reason === undefined) { rereads.stable++; frameNode(c, answer.tx, extra, false); }
    else { rereads.unstable[reason] = (rereads.unstable[reason] ?? 0) + 1; uncompared++; sample("rewriteUnstable", c, { ...extra, node: reason }); }
  });
}

assert.equal(counts.framer?.idNotFromUnsigned, undefined, "every node reading's unsigned bytes hash to its id");
const report = {
  status: framerDiffers > 0 ? "framer-disagreement-found" : uncompared > 0 ? "inconclusive" : "no-framer-disagreement-on-these-cases",
  framerDiffers, uncompared, seedsAre: "unsigned bytes, copied from the corpus by supply.mjs",
  limits: [
    "parse level: no state, proofs or full validity; the stateless verdict uses the node's initial validation settings, not mainnet's voted ones",
    "one version context, a version-4 block's (activated 3, tree 3): blocks of earlier versions are read by the node under other contexts; the profile reads sections of block versions 1-4 only",
    `mutations of the ${seeds.length} corpus transactions only: single-byte replacements, deletions and insertions, prefixes and seeded splices`,
    `fields no mutation reached with the node and the framer reading alike: ${["id", "witnessId", "outputCount", "ergoTree", "registerNames", "register"].filter(f => !(f in reached)).join(", ") || "none"}`,
    "the node's resource refusals depend on its runtime's heap and stack; the harness runs its main thread with -Xmx4G",
    "for a transaction the node rewrites, the header commits to the rewrite's ids; which bytes peers and node APIs serve for it, and whether the node's section serializer (writing under version context 4, 4) gives the rewrite read here (3, 3), are not measured",
  ],
  compares: "for every transaction the node reads (whole cases, prefixes and stable rewrites; the pinned v6.0.6 JAR's BlockTransactionsSerializer.parse of a one-transaction version-4 section), the node's own unsigned bytes (messageToSign) hashed against its id and read by the profile's framer (model/pool-v3-ergo-profile.ts frameTransaction); a framed reading is compared with the node's output count, ErgoTree bytes, register names and constants (counts.framer)",
  verdicts: { framedEqual: "the framer reads the node's unsigned bytes as the node does", framedDiffers: "the framer reads the node's unsigned bytes with other outputs: a reader would attribute what the node does not hold",
    unframed: "outside the framer's grammar: the transaction carries no record and its block keeps its section",
    framerReadsNodeRefuses: "bytes the node refuses under this version context, which no section it accepts holds; counted, not compared" },
  rereads,
  node, versionContext,
  seeds: { transactions: seeds.length, limited: Number.isFinite(seedLimit), bytes: seeds.reduce((sum, s) => sum + s.bytes.length, 0), ids: seeds.map(s => s.id) },
  mutations: { replacements: "each byte b as b^0x01, b^0x80, 0x00, 0xff", deletions: "each byte", insertions: "0x00 and 0x80 before each byte and at the end",
    prefixes: "each proper nonempty prefix", splices: `${SPLICES} per seed, sfc32 seeded 6d6f652d 686f7374 696c652d 65717569, runs of 0-64 bytes`,
    distinctCases: cases.length, duplicatesDropped: duplicates },
  counts, reached, controls, samples,
  timing: { nodeMs: Math.round(nodeMs), frameMs: Math.round(frameMs) },
  host: { node: process.version, platform: process.platform },
  files,
};
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.error(`${report.status}: ${JSON.stringify(counts.outcomes)}`);
