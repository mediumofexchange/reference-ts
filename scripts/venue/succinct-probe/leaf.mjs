// A chained leaf: Blake2b-256 over C*128 bytes (C compressions) and one type-6 recursive verification of a
// noir-recursive proof, in one circuit; with --witness the digest is checked against @noble/hashes.
// Usage: node leaf.mjs <C> <inner build dir made by probe.mjs --recursive> [--witness]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
import { Noir } from '@noir-lang/noir_js';
import { blake2b } from '@noble/hashes/blake2b.js';
const root = path.resolve(import.meta.dirname, '../../..');
const bb = path.join(root, 'node_modules/@aztec/bb.js/build/amd64-linux/bb');
const [cText, inner] = process.argv.slice(2);
const C = Number(cText), L = C * 128;
const fields = (file) => { const b = readFileSync(path.join(inner, 'rec', file)); return Array.from({ length: b.length / 32 }, (_, i) => '0x' + b.subarray(i * 32, i * 32 + 32).toString('hex')); };
const vk = fields('vk'), keyHash = fields('vk_hash')[0], proof = fields('proof'), pi = fields('public_inputs');
const project = path.join(root, 'scratch/succinct-probe', `leaf_${C}`);
mkdirSync(path.join(project, 'src'), { recursive: true });
writeFileSync(path.join(project, 'Nargo.toml'), `[package]\nname = "leaf_${C}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
copyFileSync(path.join(root, 'scripts/venue/succinct-probe/blake2b.nr'), path.join(project, 'src/blake2b.nr'));
writeFileSync(path.join(project, 'src/main.nr'), `mod blake2b;
fn main(msg: [u8; ${L}], expected: pub [u8; 32], vk: [Field; ${vk.length}], proof: [Field; ${proof.length}], pi: pub [Field; ${pi.length}], key_hash: Field) {
    assert(blake2b::blake2b256(msg) == expected);
    std::verify_proof_with_type(vk, proof, pi, key_hash, 6);
}
`);
const { program } = await compile_program(createFileManager(project), undefined, () => {}, () => {});
writeFileSync(path.join(project, 'program.json'), JSON.stringify(program));
if (process.argv.includes('--witness')) {
  const msg = randomBytes(L);
  const { witness } = await new Noir(program).execute({ msg: [...msg].map(String), expected: [...blake2b(msg, { dkLen: 32 })].map(String), vk, proof, pi, key_hash: keyHash });
  writeFileSync(path.join(project, 'witness.gz'), witness);
}
const gates = JSON.parse(execFileSync(bb, ['gates', '-b', path.join(project, 'program.json')], { encoding: 'utf8' }));
console.log(JSON.stringify({ C, inner, gates: gates.functions[0], project }));
