// The exhaustion prover pool over recorded Ergo mainnet blocks (succinct-read §4.3, slice 43): the replica's map-keeper
// (`ExhaustionServer`) hands each period to `ExhaustionPool`, which proves it leaf by leaf on the native backend from
// the pinned 2^22 points, joins it by nodes and folds it, first then next. The folds are taken by the reader's §4.3
// rules (`checkFold`) under a test set over the same built circuits on the pinned WebAssembly verifier; hostile folds
// are refused. A second pool over the same kept proofs proves the same periods again and must make no proof (resume).
// Each proof's time is recorded with the host's CPU and the least free memory seen.
//
//   node scripts/venue/exhaustion-pool.mjs --blocks <recorded.json> [--periods N] [--circuits <dir>] [--proofs <dir>]
//     [--report <file>]
//
// Run after `npm run build`, `node scripts/pool/prepare-crs.mjs`, the recorded blocks (exhaustion-fetch.mjs), the
// circuits built with keys (`NARGO=<nargo> node scripts/venue/exhaustion-build.mjs 167 380 746 --keys`) and their
// parameters (`prepareExhaustionParameters` into scratch/exhaustion-crs). The keys are a test set's: no set is adopted.
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXHAUSTION_SPECIFICATION, root, sourceHashes } from "./exhaustion-build.mjs";
import { recordedPeriod } from "./exhaustion-periods.mjs";
import { checkFold, pathRoot, subjectKey } from "../../dist/ergo-exhaustion.js";
import { circuitExhaustionSet, circuitIdentities, ExhaustionPool, nativeExhaustionBackend, proofDirectory, readExhaustionCircuits }
  from "../../dist/ergo-exhaustion-pool.js";
import { ExhaustionServer } from "../../dist/ergo-exhaustion-server.js";
import { prepareExhaustionParameters, readExhaustionParameters } from "../../dist/pool/parameter-files.js";
import { EXHAUSTION_PARAMETERS } from "../../dist/pool/parameters.js";
import { startBackend } from "../../dist/pool/proof-verifier.js";
import { readParameters } from "../pool/prepare-crs.mjs";

const argv = process.argv.slice(2);
const option = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const blocksFile = option("--blocks");
if (blocksFile === undefined) throw new Error("usage: exhaustion-pool.mjs --blocks <recorded.json> [--periods N] [--circuits <dir>] [--proofs <dir>] [--report <file>]");
const periodCount = Number(option("--periods") ?? 3);
const circuitDir = path.resolve(option("--circuits") ?? path.join(root, "scratch/exhaustion/167-380-746"));
const proofDir = path.resolve(option("--proofs") ?? path.join(root, "scratch/exhaustion-pool/proofs"));
const crs = path.join(root, "scratch/exhaustion-crs");
const started = Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let leastFree = os.freemem();
const sampler = setInterval(() => { leastFree = Math.min(leastFree, os.freemem()); }, 2000);
sampler.unref();
let failed = 0;
const report = { specification: EXHAUSTION_SPECIFICATION, sources: sourceHashes(["scripts/venue/exhaustion-pool.mjs", "src/ergo-exhaustion-pool.ts", "src/ergo-exhaustion-server.ts",
  "src/pool/parameters.ts", "src/pool/parameter-files.ts"]), cpu: os.cpus()[0]?.model ?? "unknown", cores: os.cpus().length,
  memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1), parameters: EXHAUSTION_PARAMETERS, blocks: {}, circuits: {}, periods: [], resume: {}, checks: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) }); if (!ok) { failed++; console.error(`FAIL ${name}`); } else log(`ok ${name}`); };

const recorded = recordedPeriod(blocksFile);
const blocks = recorded.blocks.map(b => ({ id: b.id, transactionsRoot: b.header.subarray(65, 97), header: b.header, section: b.transactions }));
const per = Math.ceil(blocks.length / periodCount);
const periods = Array.from({ length: periodCount }, (_, k) => blocks.slice(k * per, (k + 1) * per)).filter(p => p.length > 0);
report.blocks = { file: path.basename(blocksFile), from: Number(recorded.blocks[0].height), to: Number(recorded.blocks.at(-1).height), count: blocks.length,
  transactions: blocks.reduce((n, b) => n + b.section.length, 0), unsignedBytes: blocks.reduce((n, b) => n + b.section.reduce((m, t) => m + t.unsigned.length, 0), 0),
  periods: periods.map(p => p.length) };
log(`blocks ${report.blocks.from}–${report.blocks.to}: ${report.blocks.transactions} transactions, ${report.blocks.unsignedBytes} unsigned bytes, periods ${report.blocks.periods.join(", ")}`);

const circuits = readExhaustionCircuits(circuitDir);
report.circuits = { sizes: circuits.sizes, identities: circuitIdentities(circuits) };
await prepareExhaustionParameters(crs, { log });
const parameters = () => readExhaustionParameters(crs);

// A stopped run ends its native instance rather than leaving it proving (its kept proofs stay for the next run).
let running;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void Promise.resolve(running?.close()).finally(() => process.exit(130)); });

/** Prove every period through a server and pool over `proofs`; the folds and each period's record. */
async function run(label) {
  const backend = running = nativeExhaustionBackend(circuits, parameters, { threads: os.cpus().length });
  const pool = new ExhaustionPool({ circuits, backend, proofs: proofDirectory(proofDir), log: line => log(`${label}: ${line}`) });
  const server = new ExhaustionServer({ start: recorded.start, foldKeyHash: pool.foldKeyHash, prove: (first, inputs, period) => pool.fold(first, inputs, period) });
  const folds = [], records = [];
  try {
    for (const period of periods) {
      folds.push(await server.extend(period));
      records.push({ blocks: period.length, endHeight: Number(folds.at(-1).inputs.endHeight), ...pool.last });
    }
  } finally { await backend.close(); }
  return { server, folds, records };
}

const proved = await run("prove");
report.periods = proved.records;
const resumed = await run("resume");
report.resume = { made: resumed.records.reduce((n, r) => n + r.made, 0), kept: resumed.records.reduce((n, r) => n + r.kept, 0),
  seconds: +resumed.records.reduce((n, r) => n + r.seconds, 0).toFixed(1) };
check("a pool over the kept proofs proves the same periods again without a proof", report.resume.made === 0 && report.resume.kept > 0, report.resume);
check("its folds are the same bytes", resumed.folds.every((f, k) => Buffer.from(f.proof).equals(Buffer.from(proved.folds[k].proof))));

// The reader's §4.3 rules under the circuits' test set, on the pinned WebAssembly verifier.
const api = await startBackend(await readParameters(path.join(root, "scratch/private-payment-crs")), { threads: 4 });
try {
  const set = circuitExhaustionSet(circuits, recorded.start, api);
  report.set = { identity: Buffer.from(set.identity).toString("hex"), test: set.test };
  const at = new Map(recorded.blocks.map(b => [b.height, b]));
  const chain = { at: h => { const b = at.get(h); return b && { id: b.id, transactionsRoot: b.header.subarray(65, 97) }; }, tipHeight: recorded.blocks.at(-1).height };
  for (const [k, fold] of proved.folds.entries()) {
    const t0 = Date.now(), taken = await checkFold(set, fold, chain, 0n);
    check(`the reader takes period ${k}'s ${fold.first ? "first" : "next"} fold to ${fold.inputs.endHeight} (${Date.now() - t0} ms)`, "inputs" in taken, taken.refused);
  }
  const last = proved.folds.at(-1), end = last.inputs.endHeight;
  // Absence: a subject's path at the last fold reproduces its root with count zero (no output with the shape names it).
  const subject = new Uint8Array(32).fill(0x5a), key = subjectKey(subject), answer = await proved.server.key(end, key, 0n);
  check("a subject's path at the last fold reproduces its map root with no entry", answer !== undefined && answer.path.count === 0n &&
    answer.entries.length === 0 && pathRoot(key, answer.path) === last.inputs.mapRoot);
  const refused = async (name, fold, expected, depth = 0n) => {
    const r = await checkFold(set, fold, chain, depth);
    check(`the reader refuses ${name}`, r.refused === expected, r.refused ?? "accepted");
  };
  const with_ = change => ({ ...last, inputs: { ...last.inputs, ...change } });
  await refused("a fold with another map root", with_({ mapRoot: last.inputs.mapRoot + 1n }), "fold-proof");
  await refused("a next fold's proof under the first fold's key", { ...last, first: true }, "fold-proof");
  await refused("the first fold's proof for the last fold's inputs", { ...last, proof: proved.folds[0].proof }, "fold-proof");
  await refused("a fold ending at another header", with_({ endId: recorded.blocks[0].id }), "fold-end");
  await refused("a fold above the depth", last, "fold-depth", 1n);
  await refused("a fold from another start", with_({ startHeight: recorded.start.height + 1n }), "fold-start");
  await refused("a fold naming another fold key hash", with_({ foldKeyHash: 7n }), "fold-key");
  await set.close();
} finally {
  await api.destroy();
}

report.leastFreeGiB = +(leastFree / 2 ** 30).toFixed(1);
report.result = failed === 0 ? "pass" : `${failed} failures`;
report.minutes = +((Date.now() - started) / 60000).toFixed(1);
if (option("--report")) writeFileSync(option("--report"), `${JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
log(failed === 0 ? "exhaustion-pool: pass" : `exhaustion-pool: ${failed} failures`);
if (failed) process.exitCode = 1;
