// Decoder node equivalence over the own node's retained blocks: chain-cost.mjs run in contiguous chunks against the
// reader's own mainnet node (every full block it keeps, from its UTXO-snapshot height to near its tip), summarized. For
// each chunk the node's header chain links from its anchor, every block's section reproduces its header's transaction
// root from the node's exact JSON text, and the pinned decoder reads every transaction or refuses it; a refusal leaves
// its index without a section. The summary checks that the chunks are contiguous, ran one script and decoder pin
// against one source, and adds them up. No runtime path reads this and no answer selects a decoder or a venue.
//
// Usage, from the repository root, after the chunks (see the probes document for the chunk command):
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

const chunks = readdirSync(dir).filter(n => /^chunk-\d+\.json$/.test(n)).map(name => {
  const text = readFileSync(join(dir, name));
  return { name, sha256: sha256(text), report: JSON.parse(text) };
}).sort((a, b) => a.report.window.fromHeight - b.report.window.fromHeight);
assert(chunks.length > 0, `no chunk reports in ${dir}`);

const first = chunks[0].report, same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rows = chunks.map(({ name, sha256, report: r }, i) => {
  if (i > 0) assert.equal(r.window.fromHeight, chunks[i - 1].report.window.toHeight + 1, `${name} continues the previous chunk`);
  assert(same(r.files, first.files) && same(r.decoders.pinned, first.decoders.pinned), `${name} ran the same script and decoder pin`);
  assert(r.sources.length === 1 && r.sources[0].url === first.sources[0].url, `${name} read the same single source`);
  const h = r.headerAgreement;
  return { report: name, sha256, fromHeight: r.window.fromHeight, toHeight: r.window.toHeight, anchorId: r.window.anchorId, tipId: r.window.tipId,
    headersLinked: h.linked === h.linkedExpected && h.heights === h.expectedHeights && h.anchorAgreed,
    blocks: r.totals.blocks, rootOk: r.totals.rootOk, transactions: r.totals.transactions, outputs: r.totals.outputs, sectionBytes: r.totals.sectionBytes,
    maxTransactionBytes: r.totals.maxTransactionBytes, refusedTransactions: r.refusals.pinned.transactions, refusedBlocks: r.refusals.pinned.blocks,
    refusedByOutputTreeVersions: r.refusals.pinned.byOutputTreeVersions, copyDiffering: r.decoderEquivalence.differing,
    unresolvedIndices: r.verifier.pinned.unresolvedIndices, decodeMs: r.timing.decodeMs.pinned, cacheDigest: r.cache.digest };
});
const sum = key => rows.reduce((n, r) => n + r[key], 0);
const totals = { fromHeight: rows[0].fromHeight, toHeight: rows.at(-1).toHeight, chunks: rows.length, blocks: sum("blocks"), rootOk: sum("rootOk"),
  transactions: sum("transactions"), outputs: sum("outputs"), sectionBytes: sum("sectionBytes"), maxTransactionBytes: Math.max(...rows.map(r => r.maxTransactionBytes)),
  refusedTransactions: sum("refusedTransactions"), refusedBlocks: sum("refusedBlocks"), copyDiffering: sum("copyDiffering"),
  unresolvedIndices: sum("unresolvedIndices"), decodeMs: sum("decodeMs"), spanDays: +((chunks.at(-1).report.window.lastTimestamp - first.window.firstTimestamp) / 86400000).toFixed(1) };
const passed = rows.every(r => r.headersLinked && r.rootOk === r.blocks) && totals.refusedTransactions === 0 && totals.copyDiffering === 0 && totals.unresolvedIndices === 0;

const report = {
  status: passed ? "every-retained-transaction-read" : "refusals-or-mismatch",
  node: process.version, source: first.sources[0], decoder: first.decoders.pinned, chunkScript: first.files, totals, chunks: rows,
  files: { "experiments/ergo-range/equivalence-summary.mjs": sha256(readFileSync(join(here, "equivalence-summary.mjs"))) },
  limitations: [
    "The source is the reader's own node, whose headers it validated from genesis; each chunk's report states the public-node wording of chain-cost.mjs, whose checks are the same for one source: linkage from the anchor, section roots from the node's exact text, and the pinned decoder's reading.",
    "Equivalence here is that the pinned decoder reads, without refusal and in an exact round trip, every transaction the node accepted in these blocks, and that a verbatim second copy of the decoder reads each the same; it is not a proof that the decoder and the node agree on every possible input, and hostile inputs the chain does not contain are not exercised.",
    "The blocks are those the node keeps after its UTXO-set snapshot, about ten weeks of one venue's history; earlier script versions and blocks before the snapshot are covered only by the pinned fixtures.",
    "Timings are one desktop's, with the node and other probes running; they are not containment bounds, and the decoder's containment is not established here.",
    "No runtime path, decoder selection, profile selection or specification change follows from this measurement.",
  ],
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) writeFileSync(resolve(root, out), text);
process.stdout.write(text);
if (!passed) process.exitCode = 1;
