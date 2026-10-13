// Prices btc-day.mjs's day as a succinct proof of §13.2's exhaustion (venue recheck, Next 12), the way slices 21–22
// priced Ergo's: compressions from the verified blocks, gates from leaf.mjs's measured leaves, time from the measured
// 2^22-row leaf (time-prove.sh). The attribution scan is not built for Bitcoin's grammar: it is priced at slice 22's
// measured 181.5 gates a byte for Ergo's (an estimate), and the hashing alone is reported as the measured floor.
// Usage: node btc-cost.mjs <out dir> <leaf proving seconds> [more seconds...]
import { readFileSync } from 'node:fs';

const [out, ...secs] = process.argv.slice(2);
const blocks = readFileSync(`${out}/btc.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).sort((a, b) => a.height - b.height);
for (let i = 1; i < blocks.length; i++) if (blocks[i].prev !== blocks[i - 1].hash || blocks[i].height !== blocks[i - 1].height + 1) throw new Error(`link ${blocks[i].height}`);
const sum = (k) => blocks.reduce((s, b) => s + b[k], 0);
const n = blocks.length;
const span = (blocks[n - 1].time - blocks[0].time) / 3600 / 24;
const LEAF = { K: 830, gates: 4155044 }, ONE = 708062, PER_PACKED = (974174 - 708062) / 64, ROWS = 2 ** 22;
const RECURSION = ONE - PER_PACKED; // a leaf's verification of its predecessor, and the frame
const PER_WORD = 3974; // slice 27: a compression over words (digests), no byte packing
const SCAN = 181.5; // slice 22: Ergo's attribution scan per unsigned byte (estimate for Bitcoin's grammar)
const proveS = secs.map(Number).sort((a, b) => a - b)[0];
const perGateS = proveS / LEAF.gates;
const day = {
  blocks: n, spanDays: +span.toFixed(3), txs: sum('txCount'),
  bytesStripped: sum('txBytesStripped'), bytesFull: sum('txBytesFull'),
  txidCompressions: sum('txidCompressions'), merkleCompressions: sum('merkleCompressions'), headerCompressions: 3 * n,
  wtxidCompressions: sum('wtxidCompressions'), witnessMerkleCompressions: sum('witnessMerkleCompressions'),
  opReturnOver83: sum('opReturnOver83'),
};
// Packed compressions read transaction bytes; the second hash of a txid, Merkle nodes and header ids read words.
const firstHash = day.txidCompressions - day.txs;
function price(label, packed, words, scanBytes) {
  const hashGates = packed * PER_PACKED + words * PER_WORD;
  const scanGates = scanBytes * SCAN;
  const leaves = (g) => Math.ceil(g / (ROWS - RECURSION - 25_700));
  const hours = (g) => +(((g + leaves(g) * RECURSION) * perGateS) / 3600).toFixed(1);
  return { label, packed, words, hashGates, hashHours: hours(hashGates), withScanHours: hours(hashGates + scanGates), leavesWithScan: leaves(hashGates + scanGates) };
}
const opReturn = price('records in OP_RETURN (txids over stripped bytes)', firstHash, day.txs + day.merkleCompressions + day.headerCompressions, day.bytesStripped);
// Every wtxid compression is priced packed: its second hash reads words, so this slightly overstates (under 0.5%).
const witness = price('records in the witness (txids and wtxids)', firstHash + day.wtxidCompressions, day.txs + day.merkleCompressions + day.witnessMerkleCompressions + day.headerCompressions, day.bytesFull);
// The ceiling: blocks of minimal 60-byte transactions filling the 1 MB the weight limit leaves without witness. Each
// transaction is two packed compressions and its second hash; each Merkle node three.
const MIN_TX = 60, perBlock = Math.floor((1e6 - 80 - 3) / MIN_TX);
let ceilNodes = 0;
for (let k = perBlock; k > 1; k = Math.ceil(k / 2)) ceilNodes += Math.ceil(k / 2);
const ceiling = price('a day of blocks full of minimal transactions (estimate)', 144 * 2 * perBlock, 144 * (perBlock + 3 * ceilNodes + 3), 144 * 1e6);
const perDay = (x) => +(x / n * 144).toFixed(1);
console.log(JSON.stringify({
  day, gatesPerPackedCompression: PER_PACKED, recursionGates: RECURSION, leaf: LEAF, proveS: secs.map(Number), perGateUs: +(perGateS * 1e6).toFixed(2),
  opReturn: { ...opReturn, hashHoursPer144: perDay(opReturn.hashHours), withScanHoursPer144: perDay(opReturn.withScanHours) },
  ceiling: { ...ceiling, txsPerBlock: perBlock },
  // Upper bounds: a witness relation needs the wtxid tree and only the coinbase's txid path, not every txid.
  witness: { ...witness, hashHoursPer144: perDay(witness.hashHours), withScanHoursPer144: perDay(witness.withScanHours) },
  ergoDay: { hashHours: 9.9, withScanHours: '13.9–14.6', source: 'slices 21–22' },
}, null, 1));
