// Synthetic periods through the model and the circuits (three leaf kinds): node test-synth.mjs <CT> <CM> <EU> <periods> [execute: 0|1]
import { BUILD } from './compile.mjs';
import { readFileSync } from 'node:fs';
import { Noir } from '@noir-lang/noir_js';
import { periodKinds, inputs, topCheck, endId } from './model.mjs';
import { synthPeriod, expectedEntries } from './synth.mjs';
const [ct, cm, eu, nText, exText] = process.argv.slice(2);
const params = { CT: +ct, CM: +cm, EU: +eu };
const load = (n) => new Noir(JSON.parse(readFileSync(`${BUILD}/leaf_${n}/program.json`)));
const prog = exText === '1' ? { T: load(`${ct}_0_0`), M: load(`0_${cm}_0`), U: load(`0_0_${eu}`) } : undefined;
const hex16 = (x) => x.toString(16).padStart(32, '0');
const count = { periods: 0, leaves: 0, T: 0, M: 0, U: 0, executed: 0, failures: 0, entries: 0, wanted: 0, missing: 0, extra: 0 };
for (let seed = 1; seed <= Number(nText); seed++) {
  const data = synthPeriod(seed, { blocks: 4 + (seed % 5), maxTxs: 1 + (seed % 7) });
  const p = periodKinds(data, params);
  count.periods++;
  if (!topCheck(p.final) || endId(p.final) !== data.blocks.at(-1).id) { count.failures++; console.log('top check failed', seed); }
  const got = new Set();
  for (const { leaf } of p.leaves) for (const x of leaf.ents) {
    const out = x.pack % (1n << 32n), j = (x.pack >> 32n) % (1n << 32n), h = x.pack >> 64n;
    got.add(`${h}:${j}:${out}:${hex16(x.hi)}${hex16(x.lo)}`);
  }
  count.entries += got.size;
  const want = expectedEntries(data);
  count.wanted += want.length;
  for (const w of want) if (!got.has(w)) { count.missing++; if (count.missing < 4) console.log('missing', seed, w); }
  count.extra += got.size - want.filter(w => got.has(w)).length;
  for (const { kind, params: lp, st0, leaf } of p.leaves) {
    count.leaves++; count[kind]++;
    if (!prog) continue;
    try { await prog[kind].execute(inputs(st0, leaf, lp)); count.executed++; }
    catch (err) { count.failures++; console.log('leaf FAILED', seed, kind, String(err.message ?? err).slice(0, 200)); }
  }
}
console.log(JSON.stringify(count));
