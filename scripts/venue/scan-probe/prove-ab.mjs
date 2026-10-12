// A/B proving time on one host: the packed venue scan at 2048 bytes against slice 21's Blake2b circuit of
// about the same size, each proved twice (bb prove, 4 threads, key written while proving), verified.
// node prove-ab.mjs  (after gen.mjs/compile.mjs venue 2048, and slice 21's probe.mjs b2b 1536 built into scratch/scan-probe/b2b_1536)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Noir } from '@noir-lang/noir_js';
import { fingerprint } from './machine.mjs';
import { rng, p2pk, recordTx } from './txgen.mjs';
const bb = path.resolve(import.meta.dirname, '../../../node_modules/@aztec/bb.js/build/amd64-linux/bb');
const out = path.resolve(import.meta.dirname, '../../../scratch/scan-probe');
const L = 2048, dir = path.join(out, `venue2_${L}`);
const r = rng(5), rr = 77n, gamma = 99n, delta = 101n;
const locations = [0, 1, 2, 3].map(() => p2pk(r));
const bytes = new Uint8Array(L), starts = new Array(L).fill(false);
let off = 0;
while (true) { const t = recordTx(r, locations); if (off + t.length > L) break; bytes.set(t, off); starts[off] = true; off += t.length; }
const { witness } = await new Noir(JSON.parse(readFileSync(path.join(dir, 'program.json')))).execute({
  bytes: [...bytes].map(String), n: String(off), starts, r: String(rr), f: locations.map(l => String(fingerprint(l, rr))), gamma: String(gamma), delta: String(delta) });
writeFileSync(path.join(dir, 'witness.gz'), witness);
const gates = (d) => JSON.parse(execFileSync(bb, ['gates', '-b', path.join(d, 'program.json')], { encoding: 'utf8' })).functions[0].circuit_size;
const res = { cpu: readFileSync('/proc/cpuinfo', 'utf8').match(/model name\s*:\s*(.*)/)[1], filled: off };
for (const name of [`venue2_${L}`, 'b2b_1536']) {
  const d = path.join(out, name), times = [];
  for (let k = 0; k < 2; k++) {
    const t = performance.now();
    execFileSync(bb, ['prove', '-b', path.join(d, 'program.json'), '-w', path.join(d, 'witness.gz'), '-o', path.join(d, 'proof'), '--write_vk'], { stdio: ['ignore', 'ignore', 'pipe'] });
    times.push(+((performance.now() - t) / 1000).toFixed(2));
  }
  execFileSync(bb, ['verify', '-p', path.join(d, 'proof/proof'), '-k', path.join(d, 'proof/vk'), '-i', path.join(d, 'proof/public_inputs')], { stdio: 'ignore' });
  const g = gates(d);
  res[name] = { gates: g, proveS: times, usPerGate: +(Math.min(...times) * 1e6 / g).toFixed(2), verified: true };
}
console.log(JSON.stringify(res));
