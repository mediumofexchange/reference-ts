// The venue recheck's comparison (Next 12): per candidate, a phone's header bytes a day, exhaustion bytes a day, and
// the prover hours a day a succinct proof of exhaustion would take, from btc-result.json's measured Bitcoin day and
// slices 21–22's measured Ergo day. Each chain's hashing is modelled as gates per byte plus gates per transaction,
// fitted to the measured day of the same hash (SHA-256d: Bitcoin; Blake2b-256: Ergo), plus slice 22's scan per byte and
// the leaf's recursion. Estimates for every chain but Bitcoin and Ergo. Usage: node model.mjs <dir with results>
import { readFileSync } from 'node:fs';

const dir = process.argv[2];
const btc = JSON.parse(readFileSync(`${dir}/btc-result.json`, 'utf8'));
const c = JSON.parse(readFileSync(`${dir}/cands-result.json`, 'utf8'));
const perGate = btc.perGateUs / 1e6, SCAN = 181.5, ROWS = 2 ** 22, REC = btc.recursionGates;
const overhead = 1 + REC / (ROWS - REC - 25_700); // each leaf also verifies its predecessor
const hours = (gates) => +((gates * overhead * perGate) / 3600).toFixed(1);
// SHA-256d, fitted to Bitcoin's day: 4158/64 gates a stripped byte, the rest per transaction (second hash, Merkle nodes,
// rounding to blocks).
const shaByte = btc.gatesPerPackedCompression / 64;
const shaTx = (btc.opReturn.hashGates - shaByte * btc.day.bytesStripped) / btc.day.txs;
// Blake2b-256, fitted to slice 21's Ergo day: 3.81 MB unsigned, 4,832 transactions, 53,391 compressions of 32,941 gates.
const ergo = { bytes: 3.81e6, txs: 4832, gates: 53391 * 32941 };
const b2bByte = 32941 / 128, b2bTx = (ergo.gates - b2bByte * ergo.bytes) / ergo.txs;
const sha = (bytes, txs) => ({ hash: hours(shaByte * bytes + shaTx * txs), withScan: hours(shaByte * bytes + shaTx * txs + SCAN * bytes) });
const b2b = (bytes, txs, headers) => ({ hash: hours(b2bByte * bytes + b2bTx * txs + headers * 2 * 32941), withScan: hours(b2bByte * bytes + b2bTx * txs + headers * 2 * 32941 + SCAN * bytes) });
// Merged mining: Dogecoin's attack cost scaled from Litecoin's by hashrate, difficulty over block time
// (Dogecoin 22,290,371 at 60 s, Blockchair block 6,412,927; Litecoin 87,856,932 at 150 s, litecoinspace block 3,194,100).
const dogeShare = (22290371 / 60) / (87856932 / 150);
const ltcHour = Number(c.crypto51.LTC.hourCost.replace(/[$,]/g, ''));
const rows = {
  BTC: { headersPerDay: 80 * 144, exhaustion: btc.day.bytesStripped, prover: { hash: btc.opReturn.hashHours, withScan: btc.opReturn.withScanHours }, attackHour: c.crypto51.BTC.hourCost, measured: 'prover hashing measured' },
  ERG: { headersPerDay: 160_000, exhaustion: 3.96e6, prover: { hash: 9.9, withScan: 14.6 }, attackHour: c.crypto51.ERG.hourCost, measured: 'slices 20–22' },
  LTC: { headersPerDay: c.LTC.headerBytes, exhaustion: c.LTC.bytesStripped, prover: sha(c.LTC.bytesStripped, c.LTC.txs), attackHour: c.crypto51.LTC.hourCost, pools: c.LTC.pools.forMajority },
  DOGE: { headersPerDay: c.DOGE.headerBytes, exhaustion: c.DOGE.bytesTransactions, prover: sha(c.DOGE.bytesTransactions, c.DOGE.txs), attackHour: `$${Math.round(ltcHour * dogeShare).toLocaleString('en')} (merged; ${(100 * dogeShare).toFixed(0)}% of Litecoin's hashrate)` },
  CKB: { headersPerDay: c.CKB.headerBytes, exhaustion: c.CKB.bytesFull, prover: b2b(c.CKB.bytesFull, c.CKB.txs, c.CKB.blocks), attackHour: c.crypto51.CKB.hourCost, pools: c.CKB.pools.forMajority },
  ETC: { headersPerDay: c.ETC.smallestBlock * c.ETC.blocks, exhaustion: c.ETC.bytesFull, prover: 'Keccak-256 and RLP: not modelled', attackHour: c.crypto51.ETC.hourCost, pools: c.ETC.pools.forMajority },
  ALPH: { headersPerDay: c.ALPH.headerBytesUpper, exhaustion: c.ALPH.bytesFull, prover: 'not modelled (fails on headers)', attackHour: 'not listed' },
};
console.log(JSON.stringify({ model: { shaByte, shaTx: Math.round(shaTx), b2bByte, b2bTx: Math.round(b2bTx), scanPerByte: SCAN, overhead: +overhead.toFixed(3), perGateUs: btc.perGateUs }, rows }, null, 1));
