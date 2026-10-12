// Recursive verification of real pool-v3 proofs (type 6, noir-recursive ZK UltraHonk) inside a Noir circuit.
// Usage: node rec.mjs <kind> <count> [--prove] [--tamper]
//   The inner key is derived by bb from the shipped program (src/pool/v3/programs.json) and must have the adopted
//   manifest's vk identity; proofs/<kind>.proof are genuine proofs from the conformance build (dump-proofs.mjs).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
import { Noir } from '@noir-lang/noir_js';
import { POOL_V3_MANIFEST } from '../../../dist/pool/v3/configuration.js';
const here = import.meta.dirname, root = path.resolve(here, '../../..');
const bb = path.join(root, 'node_modules/@aztec/bb.js/build/amd64-linux/bb');
const [kind, countText] = process.argv.slice(2), count = Number(countText);
const fieldsOf = b => Array.from({ length: b.length / 32 }, (_, i) => '0x' + Buffer.from(b.subarray(i * 32, i * 32 + 32)).toString('hex'));
const meta = JSON.parse(readFileSync(path.join(here, 'proofs', kind + '.json'), 'utf8'));
const inner = path.join(root, 'scratch/trail-probe/build', 'inner_' + kind);
if (!existsSync(path.join(inner, 'vk_hash'))) {
  mkdirSync(inner, { recursive: true });
  const shipped = JSON.parse(readFileSync(path.join(root, 'src/pool/v3/programs.json'), 'utf8'))[kind];
  writeFileSync(path.join(inner, 'program.json'), JSON.stringify(shipped));
  execFileSync(bb, ['write_vk', '-b', path.join(inner, 'program.json'), '-o', inner, '-t', 'noir-recursive'], { stdio: ['ignore', 'ignore', 'inherit'] });
}
const vkCli = readFileSync(path.join(inner, 'vk'));
const vkSameAsRuntime = createHash('sha256').update(vkCli).digest('hex') === POOL_V3_MANIFEST.circuits[kind].vk;
const vk = fieldsOf(vkCli), keyHash = fieldsOf(readFileSync(path.join(inner, 'vk_hash')))[0];
const proof = fieldsOf(readFileSync(path.join(here, 'proofs', kind + '.proof')));
if (process.argv.includes('--tamper')) proof[100] = '0x' + (BigInt(proof[100]) + 1n).toString(16).padStart(64, '0');
const pi = meta.publicInputs.map(x => '0x' + BigInt(x).toString(16).padStart(64, '0'));
const name = `rec_${kind}_${count}${process.argv.includes('--tamper') ? '_t' : ''}`, project = path.join(root, 'scratch/trail-probe/build', name);
mkdirSync(path.join(project, 'src'), { recursive: true });
writeFileSync(path.join(project, 'Nargo.toml'), `[package]\nname = "${name}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
writeFileSync(path.join(project, 'src/main.nr'), `fn main(vk: [Field; ${vk.length}], proof: [[Field; ${proof.length}]; ${count}], pi: pub [[Field; ${pi.length}]; ${count}], key_hash: Field) {
    for i in 0..${count} { std::verify_proof_with_type(vk, proof[i], pi[i], key_hash, 6); }
}
`);
const { program } = await compile_program(createFileManager(project), undefined, () => {}, () => {});
writeFileSync(path.join(project, 'program.json'), JSON.stringify(program));
const { witness } = await new Noir(program).execute({ vk, proof: Array(count).fill(proof), pi: Array(count).fill(pi), key_hash: keyHash });
writeFileSync(path.join(project, 'witness.gz'), witness);
const gates = JSON.parse(execFileSync(bb, ['gates', '-b', path.join(project, 'program.json')], { encoding: 'utf8' })).functions[0];
const out = { kind, count, vkFields: vk.length, vkSameAsRuntime, proofFields: proof.length, publicInputs: pi.length, gates: gates.circuit_size };
if (process.argv.includes('--prove')) {
  const t = performance.now();
  try {
    execFileSync(bb, ['prove', '-b', path.join(project, 'program.json'), '-w', path.join(project, 'witness.gz'), '-o', path.join(project, 'proof'), '--write_vk'], { stdio: ['ignore', 'ignore', 'pipe'] });
    out.proveS = (performance.now() - t) / 1000;
    execFileSync(bb, ['verify', '-p', path.join(project, 'proof/proof'), '-k', path.join(project, 'proof/vk'), '-i', path.join(project, 'proof/public_inputs')], { stdio: 'ignore' });
    out.verified = true;
  } catch (e) { out.verified = false; out.error = String(e.message).slice(0, 300); }
}
console.log(JSON.stringify(out));
