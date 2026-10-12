// The simulator against the reference's framer and attribution (dist/ergo-profile.js): validity and the
// entries (every output with the shape, at a location unless generic), over mainnet, synthetic and mutated transactions.
// Needs scratch/scan-probe/mainnet200.json: node fetch.mjs 200 ../../../scratch/scan-probe/mainnet200.json 1892950
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { frameTransaction, collBytes } from '../../../dist/ergo-profile.js';
import { simulate, fingerprint } from './machine.mjs';
import { rng, p2pk, recordTx, mutate } from './txgen.mjs';
const r = rng(7), rr = 0x1234567890abcdefn;
const locations = [0, 1, 2, 3].map(() => p2pk(r));
const F = locations.map(l => fingerprint(l, rr));
const hex = (u) => Buffer.from(u).toString('hex');
function expected(bytes, generic) {
  const outs = frameTransaction(bytes);
  if (outs === undefined) return { valid: false, entries: [] };
  const entries = [];
  outs.forEach((o, i) => {
    const kind = generic ? 1 : locations.findIndex(l => hex(l) === hex(o.ergoTree)) + 1;
    const r4 = o.registers.R4 && collBytes(o.registers.R4), r5 = o.registers.R5 && collBytes(o.registers.R5);
    if (kind > 0 && r4?.length === 32 && r5 !== undefined) entries.push({ kind, output: i, hi: BigInt('0x' + hex(r4.slice(0, 16))), lo: BigInt('0x' + hex(r4.slice(16))) });
  });
  return { valid: true, entries };
}
const show = (x) => JSON.stringify(x, (k, v) => typeof v === 'bigint' ? v.toString(16) : v);
let n = 0, valid = 0, entries = 0, fail = 0;
function check(bytes, label) {
  for (const generic of [true, false]) {
    const got = simulate(bytes, { F, r: rr, generic }), want = expected(bytes, generic);
    const g = show({ valid: got.valid, entries: got.valid ? got.entries : [] }), w = show(want);
    if (g !== w) { if (fail++ < 5) console.log('MISMATCH', label, generic, hex(bytes).slice(0, 200), '\n got', g, '\n want', w); }
    if (!generic) { n++; valid += want.valid; entries += want.entries.length; }
  }
}
const main = JSON.parse(readFileSync(path.join(path.resolve(import.meta.dirname, '../../../scratch/scan-probe'), 'mainnet200.json')));
for (const b of main) for (const t of b.txs) check(Buffer.from(t, 'hex'), 'mainnet');
const mainCount = n;
const synth = [];
for (let i = 0; i < 2000; i++) { const t = recordTx(r, locations); synth.push(t); check(t, 'synthetic'); }
const pool = [...main.flatMap(b => b.txs.map(t => Buffer.from(t, 'hex'))), ...synth];
for (let i = 0; i < 40000; i++) { let t = pool[Math.floor(r() * pool.length)]; const k = 1 + Math.floor(r() * 3); for (let j = 0; j < k; j++) t = mutate(r, t); check(t, 'mutated'); }
console.log(JSON.stringify({ transactions: n, mainnet: mainCount, valid, entries, mismatches: fail }));
