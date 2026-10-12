// Slice 22's cost model: slice 21's chained prover of §13.2 exhaustion over a day of Ergo mainnet, with the
// attribution scan added to each leaf's work. Proving time follows the gates a circuit fills (slice 21).
// Usage: node cost.mjs <day.json from fetch.mjs> > results.json
import { readFileSync } from 'node:fs';
const cpu = 'Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 15 GB (cloud container)';
// Slice 21's measurements (scripts/venue/succinct-probe/results.json at 4d84026).
const slice21 = {
  gatesPerCompression: 32941, leaf: { compressions: 103, gates: 4097581, rows: 2 ** 22, seconds: 68.9 },
  day: { blocks: 721.2, unsignedBytes: 3813300, compressions: 53391 }, megabyteHours: 1.46, releaseFeeErgPerByte: 0.0011 / 15500,
};
// This slice's measurements (compile.mjs over gen.mjs's packed scan, bb gates; prove-ab.mjs; test-*.mjs).
const measured = JSON.parse(readFileSync(new URL('./measured.json', import.meta.url)));
const slope = (g) => (g[2048] - g[1024]) / 1024;
const scan = { generic: slope(measured.gates.generic), venue: slope(measured.gates.venue) };
const tables = Math.round(measured.gates.generic[1024] - 1024 * scan.generic); // constant tables and frame, once per leaf
// The day fetched here: compressions as slice 21's sections.mjs counts them.
const blocks = JSON.parse(readFileSync(process.argv[2]));
let ids = 0, merkle = 0, bytes = 0, txs = 0;
for (const b of blocks) {
  const lens = b.txs.map(h => h.length / 2);
  txs += lens.length; bytes += lens.reduce((s, x) => s + x, 0);
  ids += lens.reduce((s, x) => s + Math.max(1, Math.ceil(x / 128)), 0);
  let w = 2 * lens.length, internal = 0;
  do { w = Math.ceil(w / 2); internal += w; } while (w > 1);
  merkle += 2 * lens.length + internal;
}
const day = { heights: [blocks[0].height, blocks.at(-1).height], blocks: blocks.length, transactions: txs, unsignedBytes: bytes, compressions: ids + merkle + 2 * blocks.length };
const secondsPerGate = slice21.leaf.seconds / slice21.leaf.gates;
const overhead = slice21.leaf.gates - slice21.leaf.compressions * slice21.gatesPerCompression; // recursion and frame
const work = slice21.leaf.rows - overhead - tables; // gates a leaf holds for hashing and scanning
const hours = (gates) => { const leaves = Math.ceil(gates / work); return { leaves, hours: +(leaves * (gates / leaves + overhead + tables) * secondsPerGate / 3600).toFixed(1) }; };
const dayCost = (d, perByte) => {
  const hashing = d.compressions * slice21.gatesPerCompression, scanning = d.unsignedBytes * perByte;
  const total = hours(hashing + scanning);
  return { hashingAlone: hours(hashing).hours, ...total, keepsUpTimes: +(24 / total.hours).toFixed(2) };
};
const perMegabyte = (perByte) => +(((1e6 / 128) * slice21.gatesPerCompression + 1e6 * perByte) / work * (work + overhead + tables) * secondsPerGate / 3600).toFixed(2);
const result = { cpu, slice21, measured, derived: {
  gatesPerUnsignedByte: { generic: +scan.generic.toFixed(1), venue: +scan.venue.toFixed(1), budget: 660 },
  tablesGatesPerLeaf: tables,
  microsecondsPerGate: +(secondsPerGate * 1e6).toFixed(2),
  day,
  perDay: {
    slice21Day: { generic: dayCost(slice21.day, scan.generic), venue: dayCost(slice21.day, scan.venue) },
    thisDay: { generic: dayCost(day, scan.generic), venue: dayCost(day, scan.venue) },
  },
  spam: Object.fromEntries(['generic', 'venue'].map(v => {
    const h = perMegabyte(scan[v]), spare = 24 - dayCost(slice21.day, scan[v]).hours;
    return [v, { proverHoursPerExtraMegabyte: h, extraMegabytesToExceedADay: +(spare / h).toFixed(1), ergPerDayAtReleaseFee: +(spare / h * 1e6 * slice21.releaseFeeErgPerByte).toFixed(2) }];
  })),
} };
console.log(JSON.stringify(result, null, 1));
