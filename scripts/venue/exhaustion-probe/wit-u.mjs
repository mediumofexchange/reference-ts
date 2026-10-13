// A full-size U-leaf witness from synthetic entries: node wit-u.mjs <EU> <out.gz>
import { BUILD } from './compile.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { Noir } from '@noir-lang/noir_js';
import { periodKinds, inputs } from './model.mjs';
import { synthPeriod } from './synth.mjs';
const [eu, file] = process.argv.slice(2);
const data = synthPeriod(77, { blocks: 30, maxTxs: 8 });
const p = periodKinds(data, { CT: 172, CM: 378, EU: Number(eu) });
const l = p.leaves.find(x => x.kind === 'U');
const t = performance.now();
const { witness } = await new Noir(JSON.parse(readFileSync(`${BUILD}/leaf_0_0_${eu}/program.json`))).execute(inputs(l.st0, l.leaf, l.params));
writeFileSync(file, witness);
console.log(JSON.stringify({ entries: l.leaf.uin.length, subjects: p.map.leaves.size, executeS: +((performance.now() - t) / 1000).toFixed(1) }));
