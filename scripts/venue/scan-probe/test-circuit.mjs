// The compiled circuit against the simulator (itself checked against the reference framer): (vsum, acc) over
// mainnet, synthetic and mutated transactions, packed back to back into buffers of L bytes.
// node test-circuit.mjs <variant> <L> <count>, after gen.mjs and compile.mjs for that variant and L and test-sim.mjs's fetch.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Noir } from '@noir-lang/noir_js';
import { simulate, fingerprint, P } from './machine.mjs';
import { frameTransaction } from '../../../dist/ergo-profile.js';
import { rng, p2pk, recordTx, mutate } from './txgen.mjs';
const [variant, Ltext, countText] = process.argv.slice(2);
const L = Number(Ltext), count = Number(countText ?? 50), generic = variant === 'generic';
const program = JSON.parse(readFileSync(path.join(path.resolve(import.meta.dirname, '../../../scratch/scan-probe'), `${variant}2_${L}`, 'program.json')));
const noir = new Noir(program);
const r = rng(11), rr = 0x1234567890abcdefn, gamma = 0xabcdef0123456789abcdefn, delta = 0x5555aaaa5555aaaa1n;
const locations = [0, 1, 2, 3].map(() => p2pk(r));
const F = locations.map(l => fingerprint(l, rr));
const md = (x) => ((x % P) + P) % P;
const main = JSON.parse(readFileSync(path.join(path.resolve(import.meta.dirname, '../../../scratch/scan-probe'), 'mainnet200.json'))).flatMap(b => b.txs.map(t => Uint8Array.from(Buffer.from(t, 'hex'))));
const fits = (t) => t.length <= L;
const cases = [];
for (const t of main.filter(fits).slice(0, count)) cases.push(['mainnet', t]);
let s = 0; while (cases.filter(c => c[0] === 'synthetic').length < count && s++ < 100000) { const t = recordTx(r, locations); if (fits(t)) cases.push(['synthetic', t]); }
const pool = cases.map(c => c[1]);
let m = 0; while (cases.filter(c => c[0] === 'mutated').length < count && m++ < 100000) { const t = mutate(r, pool[Math.floor(r() * pool.length)]); if (fits(t)) cases.push(['mutated', t]); }
// Pack the cases back to back into buffers of L bytes and compare (vsum, acc) per buffer.
let fail = 0, valid = 0, entries = 0, buffers = 0, packed = 0;
const t0 = performance.now();
const order = cases.map((c, i) => [r(), c]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
for (let at = 0; at < order.length;) {
  const group = [];
  let used = 0;
  while (at < order.length && used + order[at][1].length <= L) { group.push(order[at]); used += order[at][1].length; at++; }
  if (group.length === 0) { at++; continue; }
  const bytes = new Uint8Array(L), starts = new Array(L).fill(false);
  let off = 0, vsum = 0n, acc = 1n, pw = 1n;
  group.forEach(([label, t], pos) => {
    bytes.set(t, off); starts[off] = true; off += t.length;
    const sim = simulate(t, { F, r: rr, generic });
    if (sim.valid !== (frameTransaction(t) !== undefined)) throw new Error('simulator disagrees with the framer');
    if (sim.valid) {
      vsum = md(vsum + pw); valid++;
      for (const e of sim.entries) { entries++; acc = md(acc * md(gamma - md(BigInt(e.kind) + delta * md(e.hi + delta * md(e.lo + delta * md(BigInt(e.output) + delta * BigInt(pos))))))); }
    }
    pw *= 3n;
  });
  const { returnValue } = await noir.execute({ bytes: [...bytes].map(String), n: String(off), starts, r: String(rr), f: F.map(String), gamma: String(gamma), delta: String(delta) });
  const [gv, gacc] = returnValue.map(BigInt);
  buffers++; packed += group.length;
  if ((gv !== vsum || gacc !== acc) && fail++ < 5) console.log('MISMATCH', group.map(g => g[0]).join(','), gv.toString(16), vsum.toString(16), gacc.toString(16), acc.toString(16));
}
console.log(JSON.stringify({ variant, L, transactions: packed, buffers, valid, entries, mismatches: fail, seconds: +((performance.now() - t0) / 1000).toFixed(1) }));
