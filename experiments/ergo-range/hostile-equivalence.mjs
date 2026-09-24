// Decoder node equivalence on hostile bytes, at the parse level: deterministic mutations of the hash-pinned corpus
// transactions, each read by the node's own parser (node-read/NodeRead.java over the official v6.0.6 JAR, offline) and
// by the reader's contained decoder (contained-decoder.mjs), and each pair of readings classified.
//
// The equivalence pass compares the two on valid transactions only. Here the bytes are the node's and the decoder's
// to disagree on: a case both read must give the same id, witness id, output count and, per output, ErgoTree bytes,
// register names and register constants; a case the node reads while the decoder refuses is a denial (the reader
// leaves the ranges through such a block unresolved); a case the decoder reads while the node refuses, or both read
// differently, is a disagreement. Where the node reads only a prefix of a case (as it would read one transaction of a
// block section and continue after it), the decoder must refuse the whole case and read that prefix as the node did.
// Nothing here says the node would accept a case: no state, proofs or validity are checked beyond the node's recorded
// stateless verdict, and no runtime path reads this.
//
// Usage, from the repository root, with a JDK for javac (the node's bundled runtime has no compiler) and the own
// node's bundle (nodes.mjs):
//   node experiments/ergo-range/hostile-equivalence.mjs --jdk <jdk dir> [--node-dir scratch/ergo-nodes/v6.0.6]
//     [--work scratch/hostile-equivalence] [--out docs/ergo-decoder-hostile-equivalence-verification.json]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { blake2b } from "@noble/hashes/blake2b";
import { serializeTransaction } from "@fleet-sdk/serializer";
import { Transaction } from "ergo-lib-wasm-nodejs";
import { decodeContained, DERIVED_SHA256, VENDORED_SHA256 } from "./contained-decoder.mjs";

const here = import.meta.dirname, root = resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const jdk = option("--jdk");
assert(jdk, "--jdk <dir> names a JDK whose javac compiles the node harness");
const nodeDir = resolve(root, option("--node-dir", "scratch/ergo-nodes/v6.0.6"));
const work = resolve(root, option("--work", "scratch/hostile-equivalence"));
const out = resolve(root, option("--out", "docs/ergo-decoder-hostile-equivalence-verification.json"));
mkdirSync(join(work, "classes"), { recursive: true });

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const hex = bytes => Buffer.from(bytes).toString("hex");
const files = Object.fromEntries(["experiments/ergo-range/hostile-equivalence.mjs", "experiments/ergo-range/node-read/NodeRead.java",
  "experiments/ergo-range/contained-decoder.mjs", "experiments/ergo-range/wasm-meter.mjs", "experiments/ergo-range/fixtures/manifest.json",
  "experiments/ergo-range/package.json", "experiments/ergo-range/package-lock.json", "experiments/ergo-range/vendor/ergo-lib-wasm-nodejs/ergo_lib_wasm.js",
  "experiments/ergo-range/vendor/ergo-lib-wasm-nodejs/SHA256SUMS"].map(file => [file, sha256(readFileSync(join(root, file)))]));
// The reference parse that names sigma-rust's errors is the vendored build the contained decoder derives from.
assert.equal(sha256(readFileSync(join(here, "node_modules/ergo-lib-wasm-nodejs/ergo_lib_wasm_bg.wasm"))), VENDORED_SHA256, "the installed build is the vendored one");
assert.equal(sha256(readFileSync(join(here, "node_modules/ergo-lib-wasm-nodejs/ergo_lib_wasm.js"))), files["experiments/ergo-range/vendor/ergo-lib-wasm-nodejs/ergo_lib_wasm.js"], "the installed glue is the vendored one");

// The node: the JAR nodes.mjs pins, compiled against and run in the bundle's own runtime.
const JAR_SHA256 = "21b9023933b19b98b7eb4d50cb78bcb6c827a0fe65711a00ceaf1b83f8f3a323";
const jar = join(nodeDir, "ergo-6.0.6.jar"), java = join(nodeDir, "jre", "bin", "java");
assert.equal(sha256(readFileSync(jar)), JAR_SHA256, "the node JAR is the pinned v6.0.6 release");
const firstLineOf = result => `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n")[0].trim();
const compiled = spawnSync(join(jdk, "bin", "javac"), ["--release", "21", "-nowarn", "-cp", jar, "-d", join(work, "classes"),
  join(here, "node-read", "NodeRead.java")], { encoding: "utf8" });
assert.equal(compiled.status, 0, `javac: ${compiled.stderr}`);
const node = { jarSha256: JAR_SHA256, runtime: firstLineOf(spawnSync(java, ["-version"], { encoding: "utf8" })),
  compiler: firstLineOf(spawnSync(join(jdk, "bin", "javac"), ["-version"], { encoding: "utf8" })), heap: "-Xmx4G, as ergo-node.ps1 runs it" };

// Seeds: every corpus transaction, pinned by the manifest before parsing, serialized as decoder-cases.mjs does.
const manifest = JSON.parse(readFileSync(join(here, "fixtures/manifest.json")));
const lossless = text => JSON.parse(text, (_key, value, context) => typeof value === "number" ? BigInt(context.source) : value);
// --seeds n keeps the first n seeds, for a quick run; the report records it.
const seedLimit = Number(option("--seeds", "Infinity"));
const seeds = [];
for (const fixture of manifest.fixtures) {
  const raw = readFileSync(join(here, fixture.file));
  assert.equal(sha256(raw), fixture.sha256, `${fixture.file} is the pinned fixture`);
  for (const [position, tx] of lossless(raw.toString("utf8")).blockTransactions.transactions.entries()) {
    const normalized = { ...tx, outputs: tx.outputs.map(o => ({ ...o, creationHeight: Number(o.creationHeight), index: Number(o.index) })) };
    seeds.push({ height: fixture.height, position, id: tx.id, bytes: Buffer.from(serializeTransaction(normalized).toBytes()) });
  }
}
seeds.splice(seedLimit);

// The compared fields, from the decoder's view and from the node's JSON.
const witnessOf = proofs => hex(blake2b(Buffer.concat(proofs.map(p => Buffer.from(p, "hex"))), { dkLen: 32 }).subarray(1));
const viewFields = view => ({ id: hex(view.id), witnessId: hex(view.witnessId),
  outputs: view.outputs.map(o => ({ ergoTree: hex(o.ergoTree), registers: Object.fromEntries(Object.entries(o.registers).map(([k, v]) => [k, hex(v)])) })) });
const nodeFields = tx => ({ id: tx.id, witnessId: witnessOf(tx.inputs.map(i => i.spendingProof.proofBytes)),
  outputs: tx.outputs.map(o => ({ ergoTree: o.ergoTree, registers: { ...(o.additionalRegisters ?? {}) } })) });
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
const casesFile = join(work, "cases.txt"), nodeFile = join(work, "node.jsonl");
writeFileSync(casesFile, cases.map(c => hex(c.bytes)).join("\n") + "\n");
const t0 = performance.now();
const fd = openSync(nodeFile, "w");
const run = spawnSync(java, ["-Xmx4G", "-cp", `${jar}${process.platform === "win32" ? ";" : ":"}${join(work, "classes")}`, "NodeRead", casesFile],
  { stdio: ["ignore", fd, "pipe"], encoding: "utf8", timeout: 4 * 3600 * 1000 });
closeSync(fd);
assert.equal(run.status, 0, `the node harness ran: ${run.stderr}`);
const nodeMs = performance.now() - t0;

const counts = {};
const tally = (...path) => { let at = counts; for (const key of path.slice(0, -1)) at = at[key] ??= {}; at[path.at(-1)] = (at[path.at(-1)] ?? 0) + 1; };
const samples = {};
const SAMPLE = 20;
const sample = (outcome, c, extra) => {
  const list = samples[outcome] ??= [];
  if (list.length < SAMPLE) list.push({ seed: c.seed, kind: c.kind, at: c.at, ...(c.value === undefined ? {} : { value: c.value }),
    ...(c.to === undefined ? {} : { to: c.to, donor: c.donor }), length: c.bytes.length, ...extra });
};
// What the mutations reached: per compared field, how many cases both sides read equally with that field unlike the seed's.
const reached = {};
const seedFields = [];
// Resource refusals of the node's runtime are counted, not described.
const RESOURCE = /^java\.lang\.(OutOfMemoryError|StackOverflowError|VirtualMachineError|InternalError)$/;
// The contained decoder refuses a sigma-rust error as the import that builds its JavaScript Error. For those, the
// vendored build's own parser (decoder.mjs's reference instance; the contained run has already bounded that parse)
// names the error, reduced to a category.
const ERROR_IMPORT = "__wbg_new_a32a1ab6c6655abe";
const CATEGORIES = [
  [/LowerBoundError/, "no inputs or no outputs"],
  [/not implemented op error|No method id/, "an opcode or method sigma-rust does not implement"],
  [/InvalidExprEvalTypeError|TypeUnificationError|Sigma conjecture: expected|expected input to be|Expected \w+ (input|col_\d+ param|param)|Invalid [\w ]+ tpe|Expected args|ValDef type for an index/i,
    "an expression sigma-rust's type check refuses"],
  [/BoxValue error|TokenAmount error/, "a box value or token amount outside sigma-rust's bounds"],
  [/failed to find token id in tx digests/, "a token index past the transaction's token list"],
  [/IO error|vlq encode error/, "sigma-rust's reader runs out of bytes or of range"],
];
const categoryOf = bytes => {
  let message;
  try { Transaction.sigma_parse_bytes(bytes).free(); return "the reference parse reads it"; } catch (error) { message = String(error?.message ?? error); }
  return CATEGORIES.find(([pattern]) => pattern.test(message))?.[1] ?? `other: ${message.split("\n")[0].replace(/\d+/g, "#").slice(0, 80)}`;
};
const refusalOf = (decoded, bytes) => decoded.refused !== "import" ? decoded.refused
  : decoded.import === ERROR_IMPORT ? `sigma-rust error: ${categoryOf(bytes)}` : `import:${decoded.import}`;
// A decoder reading against the node's reading of the same bytes. The profile authenticates a block's decoded
// transactions by its header's root over their ids and witness ids, so a reading under other ids than the node's fails
// that root and leaves the block unresolved, while a reading under the node's ids with other output fields would pass it:
// "sameIdsDiffer" is the disagreement that matters to the reader.
const compare = (bytes, tx, decoded = decodeContained(bytes)) => {
  if (decoded.view === undefined) return { verdict: "decoderRefuses", refusal: refusalOf(decoded, bytes) };
  const fields = differences(viewFields(decoded.view), nodeFields(tx));
  return { fields, verdict: fields.length === 0 ? "equal" : fields.includes("id") || fields.includes("witnessId") ? "otherIds" : "sameIdsDiffer" };
};
let sameIdsDiffer = 0;
const note = (group, c, result, extra) => {
  tally(group, result.verdict);
  // Split by the node's stateless verdict: a denial matters where the node's stateless checks pass.
  if (result.verdict === "decoderRefuses") tally(`${group}Refusals`, extra.stateless ? "statelessOk" : "statelessFailed", result.refusal);
  if (result.verdict === "sameIdsDiffer") sameIdsDiffer++;
  if (result.verdict !== "equal") sample(`${group}:${result.verdict}`, c, { ...extra, ...(result.fields ? { fields: result.fields } : { decoder: result.refusal }) });
};
let versionContext, index = 0, decodeMs = 0, maxDecodeMs = 0;
const lines = createInterface({ input: createReadStream(nodeFile, "utf8"), crlfDelay: Infinity });
for await (const line of lines) {
  const answer = JSON.parse(line);
  if (versionContext === undefined) { versionContext = answer.versionContext; assert(versionContext, "the harness states its version context"); continue; }
  const c = cases[index++];
  assert(c, "no more node answers than cases");
  const t1 = performance.now();
  const decoded = decodeContained(c.bytes);
  const took = performance.now() - t1;
  decodeMs += took; maxDecodeMs = Math.max(maxDecodeMs, took);
  let outcome;
  if (answer.encodeFailed !== undefined) { outcome = "nodeEncodeFailed"; sample(outcome, c, { node: answer.encodeFailed }); }
  else if (answer.refused !== undefined) {
    const resource = RESOURCE.test(answer.refused);
    // Bytes the node refuses under this version context cannot be a transaction of a version-4 block.
    if (decoded.view !== undefined) { outcome = "decoderReadsNodeRefuses"; tally("decoderReadsNodeRefusesBy", resource ? "resource" : answer.refused); sample(outcome, c, resource ? { node: "resource" } : { node: answer.refused, message: answer.message }); }
    else outcome = "bothRefuse";
    tally("nodeRefusals", resource ? "resource" : answer.refused);
  } else {
    assert(Number.isSafeInteger(answer.read) && answer.read > 0 && answer.read <= c.bytes.length, "the node read within the case");
    tally("nodeStateless", answer.stateless === "ok" ? "ok" : "failed");
    const extra = { stateless: answer.stateless === "ok", ...(answer.rewritten ? { rewritten: true } : {}) };
    if (answer.read === c.bytes.length) {
      const result = compare(c.bytes, answer.tx, decoded);
      outcome = answer.rewritten ? "nodeReadsAndRewrites" : "nodeReads";
      note(outcome, c, result, extra);
      if (result.verdict === "equal" && !answer.rewritten) {
        if (c.kind === "seed") seedFields[c.seed] = nodeFields(answer.tx);
        else if (seedFields[c.seed] !== undefined) for (const field of differences(nodeFields(answer.tx), seedFields[c.seed])) reached[field] = (reached[field] ?? 0) + 1;
      }
    } else {
      // The node read a proper prefix, as it reads one transaction of a block section and continues after it: the
      // decoder is compared on the whole case and on that prefix.
      outcome = "nodeReadsPrefix";
      note("nodeReadsPrefix", c, compare(c.bytes, answer.tx, decoded), { read: answer.read, ...extra });
      note("prefixOnly", c, compare(c.bytes.subarray(0, answer.read), answer.tx), { read: answer.read, ...extra });
    }
    // Where the node writes what it read as other bytes, its id and fields are those bytes'; the decoder reads them too.
    if (answer.rewritten) note("rewrittenBytes", c, compare(Buffer.from(answer.rewritten, "hex"), answer.tx), extra);
  }
  tally("outcomes", outcome);
  tally("byKind", c.kind, outcome);
  if (index % 20000 === 0) console.error(`  ${index}/${cases.length}`);
}
assert.equal(index, cases.length, "one node answer per case");
seeds.forEach((_, seed) => assert(seedFields[seed], `both read seed ${seed} alike, the node without rewriting it`));

// Controls, so an empty disagreement count is not a comparison that cannot fail: each compared field changed in the
// node's reading of a seed with registers and a proof shows as a difference in that field.
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

const report = {
  status: sameIdsDiffer === 0 ? "no-same-id-disagreement-on-these-cases" : "same-id-disagreement-found",
  sameIdsDiffer,
  compares: "per case, the node's reading (the pinned v6.0.6 JAR's ErgoTransactionSerializer.parse under block version 4's version context, then its API encoder) against contained-decoder.mjs's: id, witness id, output count, and each output's ErgoTree bytes, register names and register constants; where the node reads a proper prefix, the decoder's reading of the whole case and of that prefix; where the node's serializer writes what it read as other bytes, the decoder's reading of those bytes",
  verdicts: { equal: "every compared field equal", otherIds: "the id or witness id differs, so the header's transactions root refuses the decoder's reading", sameIdsDiffer: "equal ids, other output fields: the root would not catch it", decoderRefuses: "a denial: the reader leaves the ranges through such a block unresolved" },
  node, versionContext,
  decoder: { vendoredWasmSha256: VENDORED_SHA256, derivedWasmSha256: DERIVED_SHA256 },
  seeds: { transactions: seeds.length, limited: Number.isFinite(seedLimit), bytes: seeds.reduce((sum, s) => sum + s.bytes.length, 0), ids: seeds.map(s => s.id) },
  mutations: { replacements: "each byte b as b^0x01, b^0x80, 0x00, 0xff", deletions: "each byte", insertions: "0x00 and 0x80 before each byte and at the end",
    prefixes: "each proper nonempty prefix", splices: `${SPLICES} per seed, sfc32 seeded 6d6f652d 686f7374 696c652d 65717569, runs of 0-64 bytes`,
    distinctCases: cases.length, duplicatesDropped: duplicates },
  counts, reached, controls, samples,
  timing: { nodeMs: Math.round(nodeMs), decodeMs: Math.round(decodeMs), maxDecodeMs: Math.round(maxDecodeMs) },
  host: { node: process.version, platform: process.platform },
  files,
};
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.error(`${report.status}: ${JSON.stringify(counts.outcomes)}`);
