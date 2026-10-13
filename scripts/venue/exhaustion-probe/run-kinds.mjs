// node run-kinds.mjs <data.json> <CT> <EU> <CM> [first leaf] [count] [only T|M|U]: a period as T-, M- and U-leaves; executes the chosen ones.
import { BUILD } from './compile.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { Noir } from '@noir-lang/noir_js';
import { periodKinds, kindInputs, topCheck, endId } from './model.mjs';
const [file, ct, eu, cm, fromText, nText, only] = process.argv.slice(2);
const params = { CT: +ct, CM: +cm, EU: +eu };
const data = JSON.parse(readFileSync(file));
const t0 = performance.now();
const p = periodKinds(data, params);
const tl = p.leaves.filter(l => l.kind === 'T'), ml = p.leaves.filter(l => l.kind === 'M'), ul = p.leaves.filter(l => l.kind === 'U');
const summary = { blocks: data.blocks.length, leaves: p.leaves.length, tLeaves: tl.length, mLeaves: ml.length, uLeaves: ul.length, T: p.T, M: p.M,
  tFill: +(p.T / (tl.length * params.CT)).toFixed(3), mFill: +(p.M / (ml.length * params.CM)).toFixed(3),
  entries: p.leaves.reduce((s, l) => s + l.leaf.ents.length, 0), maxEntriesInLeaf: Math.max(...p.leaves.map(l => l.leaf.ents.length)),
  topCheck: topCheck(p.final), endMatches: endId(p.final) === data.blocks.at(-1).id, modelS: +((performance.now() - t0) / 1000).toFixed(1) };
console.log(JSON.stringify(summary));
const n = Number(nText ?? 0);
if (n > 0) {
  const load = (n) => new Noir(JSON.parse(readFileSync(`${BUILD}/leaf_${n}/program.json`)));
  const prog = { T: load(`${ct}_0_0`), M: load(`0_${cm}_0`), U: load(`0_0_${eu}`) };
  let ok = 0, failed = 0, done = 0;
  for (let i = Number(fromText ?? 0); i < p.leaves.length && done < n; i++) {
    const { kind, params: lp, st0, leaf } = p.leaves[i];
    if (only && kind !== only) continue;
    done++;
    const t1 = performance.now();
    try {
      const { witness } = await prog[kind].execute(kindInputs(st0, leaf, lp));
      ok++;
      if (process.env.SAVE) writeFileSync(`${process.env.SAVE}-${kind}${i}.gz`, witness);
      console.log('leaf', i, kind, 'ok', leaf.usedT || leaf.usedM || leaf.usedU, leaf.ents.length, +((performance.now() - t1) / 1000).toFixed(1));
    } catch (err) { failed++; console.log('leaf', i, kind, 'FAILED', String(err.message ?? err).slice(0, 200)); }
  }
  console.log(JSON.stringify({ executed: ok, failed }));
}
