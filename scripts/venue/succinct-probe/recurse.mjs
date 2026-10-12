// One recursive UltraHonk verification in a Noir circuit: gates and prove time of an aggregation step.
// Usage: node recurse.mjs <proof type> <inner build dir>...  (each made by probe.mjs --recursive, one circuit)
// Proof type 6 is the one Barretenberg 5.2.0 accepts for a noir-recursive (ZK) UltraHonk proof in an Ultra circuit;
// TAMPER=1 alters one field of the first proof, whose outer proof must then fail verification.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
import { Noir } from '@noir-lang/noir_js';

const here = import.meta.dirname;
const bb = path.resolve(here, '../../../node_modules/@aztec/bb.js/build/amd64-linux/bb');
const [type, ...inners] = process.argv.slice(2);
const count = inners.length, inner = inners[0];
const fields = (file, dir = inner) => { const b = readFileSync(path.join(dir, 'rec', file)); return Array.from({ length: b.length / 32 }, (_, i) => '0x' + b.subarray(i * 32, i * 32 + 32).toString('hex')); };
const vk = fields('vk'), keyHash = fields('vk_hash')[0];
const proof = inners.map(d => fields('proof', d)), pi = inners.map(d => fields('public_inputs', d));
if (process.env.TAMPER) proof[0][100] = '0x' + (BigInt(proof[0][100]) + 1n).toString(16).padStart(64, '0');
const name = `rec_${type}_${count}${process.env.TAMPER ? '_tampered' : ''}`, project = path.join(here, '../../../scratch/succinct-probe', name);
mkdirSync(path.join(project, 'src'), { recursive: true });
writeFileSync(path.join(project, 'Nargo.toml'), `[package]\nname = "${name}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
writeFileSync(path.join(project, 'src/main.nr'), `fn main(vk: [Field; ${vk.length}], proof: [[Field; ${proof[0].length}]; ${count}], pi: pub [[Field; ${pi[0].length}]; ${count}], key_hash: Field) {
    for i in 0..${count} {
        std::verify_proof_with_type(vk, proof[i], pi[i], key_hash, ${type});
    }
}
`);
const { program } = await compile_program(createFileManager(project), undefined, () => {}, () => {});
writeFileSync(path.join(project, 'program.json'), JSON.stringify(program));
const { witness } = await new Noir(program).execute({ vk, proof, pi, key_hash: keyHash });
writeFileSync(path.join(project, 'witness.gz'), witness);
const gates = JSON.parse(execFileSync(bb, ['gates', '-b', path.join(project, 'program.json')], { encoding: 'utf8' }));
console.log(JSON.stringify({ type, count, gates: gates.functions[0], project }));
