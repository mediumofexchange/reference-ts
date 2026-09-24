// Decoder node equivalence over the own node's retained blocks: chain-cost.mjs run in contiguous chunks against the
// reader's own mainnet node (every full block it keeps, from its UTXO-snapshot height to near its tip), compared field
// by field, summarized. For each chunk the node's header chain links from its anchor, every block's section reproduces
// its header's transaction root from the node's exact JSON text, and the pinned decoder reads every transaction or
// refuses it; a refusal leaves its index without a section. equivalence-fields.mjs then compares, over the same cached
// responses, what the decoder reads with what the node's JSON states. The summary checks that the chunks are exactly
// the driver's plan, link by header id, ran one script and decoder pin against one source, and that the post-pass
// covered each chunk's exact report and responses; it adds them up. No runtime path reads this and no answer selects a
// decoder or a venue.
//
// Usage, from the repository root:
//   node experiments/ergo-range/equivalence-driver.mjs      (the chunks; resumes)
//   node experiments/ergo-range/equivalence-fields.mjs      (the field comparison; resumes)
//   node experiments/ergo-range/equivalence-summary.mjs [--dir scratch/equivalence] [--out <report>]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const here = import.meta.dirname, root = resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const dir = resolve(root, option("--dir", "scratch/equivalence")), out = option("--out");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fileHash = file => sha256(readFileSync(join(root, file)));

// The driver's plan: its constants and the exact chain-cost arguments it passes for every chunk.
const driverFile = "experiments/ergo-range/equivalence-driver.mjs", driverText = readFileSync(join(root, driverFile), "utf8");
const plan = driverText.match(/const FROM = (\d+), TO = (\d+), CHUNK = (\d+), dir = "([^"]+)";/);
const argv = driverText.match(/\["experiments\/ergo-range\/chain-cost\.mjs", ([^\]]+)\]/);
assert(plan && argv, `${driverFile} states its plan and chain-cost arguments`);
const [FROM, TO, CHUNK] = plan.slice(1, 4).map(Number);
const planned = [];
for (let from = FROM; from <= TO; from += CHUNK) planned.push({ from, count: Math.min(CHUNK, TO - from + 1) });
const source = "http://127.0.0.1:9053", cacheDir = "scratch/ergo-chain-own", depth = 10;
// The driver's argument list, literally; the command stated for each chunk is this list with its from, count and out.
assert.equal(argv[1], `"--from", String(from), "--count", String(count), "--depth", "${depth}",\n    "--sources", "${source}", "--cache", "${cacheDir}", "--delay", "0", "--out", out`,
  `${driverFile} passes exactly the arguments this summary states`);
assert(driverText.includes("out = `${dir}/chunk-${from}.json`"), `${driverFile} names each chunk report by its first height`);
assert.equal(dir, resolve(root, plan[4]), "the summary reads the driver's directory");
const commandOf = ({ from, count }) =>
  `node experiments/ergo-range/chain-cost.mjs --from ${from} --count ${count} --depth ${depth} --sources ${source} --cache ${cacheDir} --delay 0 --out ${plan[4]}/chunk-${from}.json`;
// Every source a chunk or field report binds must be the one on disk now, so an older report cannot pass for these files.
const current = (bound, what) => { for (const [file, digest] of Object.entries(bound)) assert.equal(fileHash(file), digest, `${what} bound ${file} as it is now`); };

const load = name => { const text = readFileSync(join(dir, name)); return { name, sha256: sha256(text), report: JSON.parse(text) }; };
const chunks = readdirSync(dir).filter(n => /^chunk-\d+\.json$/.test(n)).map(load).sort((a, b) => a.report.window.fromHeight - b.report.window.fromHeight);
assert.deepEqual(chunks.map(c => ({ from: c.report.window.fromHeight, count: c.report.window.count })), planned, "the chunks are exactly the driver's plan");

const first = chunks[0].report, same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let fieldScript;
const rows = [];
for (const [i, { name, sha256, report: r }] of chunks.entries()) {
  assert.equal(name, `chunk-${r.window.fromHeight}.json`, `${name} is named by its first height`);
  assert(same(r.files, first.files) && same(r.decoders.pinned, first.decoders.pinned), `${name} ran the same script and decoder pin`);
  current(r.files, name);
  assert(r.sources.length === 1 && r.sources[0].url === source, `${name} read the one source the driver names`);
  assert(r.window.depth === depth && r.cache.delayMs === 0 && r.cache.directory.replace(/\\/g, "/").endsWith(`/${cacheDir}`), `${name} ran with the driver's arguments`);
  const { report: f, sha256: fieldsSha256 } = load(name.replace(/^chunk-/, "fields-"));
  assert(f.chunk.report === name && f.chunk.sha256 === sha256 && f.chunk.cacheDigest === r.cache.digest, `the field comparison read ${name} and its responses`);
  assert(f.window.anchorId === r.window.anchorId && f.window.tipId === r.window.tipId && f.decoder.wasmSha256 === r.decoders.pinned.wasmSha256, `the field comparison of ${name} covers its window and decoder`);
  fieldScript ??= f.files;
  assert(same(f.files, fieldScript), `the field comparison of ${name} ran the same script`);
  current(f.files, `the field comparison of ${name}`);
  assert.equal(f.counts.blocks, r.window.count, `the field comparison of ${name} read every block`);
  const controls = ["id", "witnessId", "outputCount", "ergoTree", "register", "registerNames"];
  assert(controls.every(field => f.controls?.detected[field] === true), `the field comparison of ${name} detected every control mutation`);
  // Chunks join by header id: each anchor is the block the previous chunk's last index names.
  if (i > 0) assert.equal(r.window.anchorId, rows[i - 1].lastId, `${name} continues the previous chunk by header id`);
  const h = r.headerAgreement;
  rows.push({ report: name, sha256, command: commandOf({ from: r.window.fromHeight, count: r.window.count }), fields: name.replace(/^chunk-/, "fields-"), fieldsSha256,
    fromHeight: r.window.fromHeight, toHeight: r.window.toHeight, anchorId: r.window.anchorId, lastId: f.window.lastId, tipId: r.window.tipId,
    headersLinked: h.linked === h.linkedExpected && h.heights === h.expectedHeights && h.anchorAgreed && f.window.headersLinkedById === h.heights,
    blocks: r.totals.blocks, rootOk: r.totals.rootOk, transactions: r.totals.transactions, outputs: r.totals.outputs, registers: f.counts.registers, sectionBytes: r.totals.sectionBytes,
    maxTransactionBytes: r.totals.maxTransactionBytes, refusedTransactions: r.refusals.pinned.transactions, refusedBlocks: r.refusals.pinned.blocks,
    refusedByOutputTreeVersions: r.refusals.pinned.byOutputTreeVersions, copyDiffering: r.decoderEquivalence.differing,
    fieldsCompared: f.counts.transactions, fieldsDiffering: f.counts.differingTransactions, fieldsDifferingByField: f.byField, fieldsSample: f.sample.slice(0, 5),
    unresolvedIndices: r.verifier.pinned.unresolvedIndices, decodeMs: r.timing.decodeMs.pinned, cacheDigest: r.cache.digest });
}
const sum = key => rows.reduce((n, r) => n + r[key], 0);
const totals = { fromHeight: rows[0].fromHeight, toHeight: rows.at(-1).toHeight, chunks: rows.length, blocks: sum("blocks"), rootOk: sum("rootOk"),
  transactions: sum("transactions"), outputs: sum("outputs"), registers: sum("registers"), sectionBytes: sum("sectionBytes"), maxTransactionBytes: Math.max(...rows.map(r => r.maxTransactionBytes)),
  refusedTransactions: sum("refusedTransactions"), refusedBlocks: sum("refusedBlocks"), copyDiffering: sum("copyDiffering"),
  fieldsCompared: sum("fieldsCompared"), fieldsDiffering: sum("fieldsDiffering"),
  unresolvedIndices: sum("unresolvedIndices"), decodeMs: sum("decodeMs"), spanDays: +((chunks.at(-1).report.window.lastTimestamp - first.window.firstTimestamp) / 86400000).toFixed(1) };
const passed = rows.every(r => r.headersLinked && r.rootOk === r.blocks && r.fieldsCompared === r.transactions) && totals.refusedTransactions === 0 && totals.copyDiffering === 0 &&
  totals.fieldsDiffering === 0 && totals.unresolvedIndices === 0;

const report = {
  status: passed ? "every-retained-transaction-read-with-the-nodes-compared-fields" : "refusals-or-mismatch",
  node: process.version, source: first.sources[0], decoder: first.decoders.pinned, chunkScript: first.files, fieldScript,
  driver: { file: driverFile, from: FROM, to: TO, chunk: CHUNK }, totals, chunks: rows,
  files: { [driverFile]: fileHash(driverFile), "experiments/ergo-range/equivalence-summary.mjs": fileHash("experiments/ergo-range/equivalence-summary.mjs") },
  limitations: [
    "The source is the reader's own node, whose headers it validated from genesis; each chunk's report states the public-node wording of chain-cost.mjs, whose checks are the same for one source: linkage from the anchor, section roots from the node's exact text, and the pinned decoder's reading.",
    "Equivalence here is that the pinned decoder reads, without refusal and in an exact round trip, every transaction the node accepted in these blocks, and that the id, witness id, output count and every output's ErgoTree bytes and register constants it reads equal the node's JSON fields; inputs, data inputs, values, tokens and creation heights are not compared, because the verifier does not read them. It is not a proof that the decoder and the node agree on every possible input, and hostile inputs the chain does not contain are not exercised.",
    "The field comparison rebuilds each transaction's bytes from the node's text with the pinned serializer, as the chunk did, and checks by the chunk's cache digest that it read the same responses; it does not recompute the transaction roots, which the chunk checked for those bytes. The comparison is independent of the serializer only because that root, over ids equal to the node's and the node's proof bytes, authenticates the bytes the decoder reads. The chunks bind the decoder's WASM but not its JavaScript glue; the field comparison binds both and checks them against the vendored checksums.",
    "The blocks are those the node keeps after its UTXO-set snapshot, about ten weeks of one venue's history; earlier script versions and blocks before the snapshot are covered only by the pinned fixtures.",
    "Timings are one desktop's, with the node and other probes running; they are not containment bounds, and the decoder's containment is not established here.",
    "No runtime path, decoder selection, profile selection or specification change follows from this measurement.",
  ],
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) writeFileSync(resolve(root, out), text);
process.stdout.write(text);
if (!passed) process.exitCode = 1;
