// Succinct-exhaustion probe: gates and native UltraHonk prove time for a hash over L bytes.
// Usage: node probe.mjs <variant> <L> [--prove] [--recursive] [--tag=<t>]
//   variant: b2b (this directory's Noir Blake2b-256) | b2s (Noir's Blake2s black box, Barretenberg's own gadget).
//   The witness asserts the circuit's digest equals @noble/hashes' over a random message. --prove proves and
//   verifies (vk computed while proving; time-prove.sh times proving alone); --recursive writes a noir-recursive
//   proof under rec/ for recurse.mjs. Builds go to scratch/succinct-probe/<variant>_<L>[_<tag>].
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
import { Noir } from '@noir-lang/noir_js';
import { blake2b } from '@noble/hashes/blake2b.js';
import { blake2s } from '@noble/hashes/blake2s.js';

const here = import.meta.dirname;
const bb = path.resolve(here, '../../../node_modules/@aztec/bb.js/build/amd64-linux/bb');
const [variant, lText] = process.argv.slice(2);
const L = Number(lText), prove = process.argv.includes('--prove');
const tag = process.argv.find(a => a.startsWith('--tag='))?.slice(6);
const name = `${variant}_${L}${tag ? `_${tag}` : ''}`;
const project = path.join(here, '../../../scratch/succinct-probe', name);
mkdirSync(path.join(project, 'src'), { recursive: true });
writeFileSync(path.join(project, 'Nargo.toml'), `[package]\nname = "${name}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
copyFileSync(path.join(here, 'blake2b.nr'), path.join(project, 'src/blake2b.nr'));
const call = variant === 'b2b' ? 'blake2b::blake2b256(msg)' : 'std::hash::blake2s(msg)';
writeFileSync(path.join(project, 'src/main.nr'), `mod blake2b;\nfn main(msg: [u8; ${L}], expected: pub [u8; 32]) {\n    assert(${call} == expected);\n}\n`);
const t0 = performance.now();
const { program } = await compile_program(createFileManager(project), undefined, () => {}, () => {});
const compileS = (performance.now() - t0) / 1000;
writeFileSync(path.join(project, 'program.json'), JSON.stringify(program));
const msg = randomBytes(L);
const digest = variant === 'b2b' ? blake2b(msg, { dkLen: 32 }) : blake2s(msg);
const t1 = performance.now();
const { witness } = await new Noir(program).execute({ msg: [...msg].map(String), expected: [...digest].map(String) });
const witnessS = (performance.now() - t1) / 1000;
writeFileSync(path.join(project, 'witness.gz'), witness);
const gates = JSON.parse(execFileSync(bb, ['gates', '-b', path.join(project, 'program.json')], { encoding: 'utf8' }));
const out = { variant, L, blocks: Math.ceil(L / (variant === 'b2b' ? 128 : 64)), compileS, witnessS, gates: gates.functions[0] };
if (prove) {
  const t2 = performance.now();
  execFileSync(bb, ['prove', '-b', path.join(project, 'program.json'), '-w', path.join(project, 'witness.gz'), '-o', path.join(project, 'proof'), '--write_vk'], { stdio: ['ignore', 'ignore', 'pipe'] });
  out.proveS = (performance.now() - t2) / 1000;
  execFileSync(bb, ['verify', '-p', path.join(project, 'proof/proof'), '-k', path.join(project, 'proof/vk'), '-i', path.join(project, 'proof/public_inputs')], { stdio: 'ignore' });
  out.verified = true;
}
if (process.argv.includes('--recursive')) {
  execFileSync(bb, ['prove', '-b', path.join(project, 'program.json'), '-w', path.join(project, 'witness.gz'), '-o', path.join(project, 'rec'), '--write_vk', '-t', 'noir-recursive'], { stdio: ['ignore', 'ignore', 'pipe'] });
}
console.log(JSON.stringify(out));
