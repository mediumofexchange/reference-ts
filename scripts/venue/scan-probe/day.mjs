// A day of Ergo mainnet through the simulator (checked against the framer): bytes, transactions inside
// the grammar, and the outputs with §6's shape whatever their tree (the generic map's entries).
// node day.mjs <file.json> <gates a byte, generic> <gates a byte, venue>
import { readFileSync } from 'node:fs';
import { frameTransaction } from '../../../dist/ergo-profile.js';
import { simulate } from './machine.mjs';
const [file, g, v] = process.argv.slice(2);
const blocks = JSON.parse(readFileSync(file));
let txs = 0, bytes = 0, valid = 0, validBytes = 0, entries = 0, max = 0, mismatches = 0;
const trees = new Map();
for (const b of blocks) for (const hex of b.txs) {
  const t = Buffer.from(hex, 'hex');
  const sim = simulate(t, { generic: true });
  const framed = frameTransaction(t);
  if (sim.valid !== (framed !== undefined)) mismatches++;
  txs++; bytes += t.length; max = Math.max(max, t.length);
  if (sim.valid) {
    valid++; validBytes += t.length; entries += sim.entries.length;
    for (const e of sim.entries) { const k = Buffer.from(framed[e.output].ergoTree).toString('hex').slice(0, 16); trees.set(k, (trees.get(k) ?? 0) + 1); }
  }
}
const usPerGate = 16.8; // slice 21's 2^22 leaf on the same host type
const hours = (gpb) => +(bytes * gpb * usPerGate / 3.6e9).toFixed(2);
console.log(JSON.stringify({
  heights: [blocks[0].height, blocks.at(-1).height], blocks: blocks.length, txs, unsignedBytes: bytes, largestTx: max, insideGrammar: valid, insideGrammarBytes: validBytes,
  shapedOutputs: entries, shapedTreesTop: [...trees].sort((a, b) => b[1] - a[1]).slice(0, 5), simulatorFramerMismatches: mismatches,
  scanHours: { generic: hours(Number(g)), venue: hours(Number(v)) },
}));
