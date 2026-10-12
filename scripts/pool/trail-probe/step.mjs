// A trail step's measured parts in one circuit, over a real pool-v3 spend proof from the conformance build:
//   rec    the spend proof verified recursively (type 6), its public inputs the statement's;
//   phash  §7's proofHash: SHA-256 over the proof's bytes, which are its 458 fields big-endian, equal to node's digest;
//   acc    a second recursive verification, standing in for the previous step's proof;
//   spent  S SHA-256 compressions (pool-spent's radix paths; contents are stand-ins);
//   tree   P Poseidon2 permutations (note-tree appends and anchor paths; stand-ins).
// Usage: node step.mjs <parts comma-separated> [S] [P] [--prove]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
import { Noir } from '@noir-lang/noir_js';
const here = import.meta.dirname, root = path.resolve(here, '../../..');
const bb = path.join(root, 'node_modules/@aztec/bb.js/build/amd64-linux/bb');
const parts = new Set(process.argv[2].split(',')), S = Number(process.argv[3] ?? 0), P = Number(process.argv[4] ?? 0);
const fieldsOf = b => Array.from({ length: b.length / 32 }, (_, i) => '0x' + Buffer.from(b.subarray(i * 32, i * 32 + 32)).toString('hex'));
const meta = JSON.parse(readFileSync(path.join(here, 'proofs/spend.json'), 'utf8'));
const inner = path.join(root, 'scratch/trail-probe/build/inner_spend');
const proofBytes = readFileSync(path.join(here, 'proofs/spend.proof'));
const vk = fieldsOf(readFileSync(path.join(inner, 'vk'))), keyHash = fieldsOf(readFileSync(path.join(inner, 'vk_hash')))[0];
const proof = fieldsOf(proofBytes), pi = meta.publicInputs.map(x => '0x' + BigInt(x).toString(16).padStart(64, '0'));
// SHA-256 padding of the 14,656 proof bytes: 229 full blocks, then one block 0x80 .. length (14,656*8 bits).
const blocks = Math.floor(proofBytes.length / 64) + 1;
const digest = createHash('sha256').update(proofBytes).digest();
const name = `step_${[...parts].sort().join('-')}_${S}_${P}`, project = path.join(root, 'scratch/trail-probe/build', name);
mkdirSync(path.join(project, 'src'), { recursive: true });
writeFileSync(path.join(project, 'Nargo.toml'), `[package]\nname = "${name}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
const body = [];
if (parts.has('rec')) body.push(`std::verify_proof_with_type(vk, proof, pi, key_hash, 6);`);
if (parts.has('acc')) body.push(`std::verify_proof_with_type(vk, proof2, pi, key_hash, 6);`);
if (parts.has('phash')) body.push(`
    let mut bytes = [0 as u8; ${blocks * 64}];
    for i in 0..${proof.length} { let b: [u8; 32] = proof[i].to_be_bytes(); for j in 0..32 { bytes[32 * i + j] = b[j]; } }
    bytes[${proofBytes.length}] = 0x80;
    let bits: u64 = ${proofBytes.length * 8};
    for j in 0..8 { bytes[${blocks * 64 - 1} - j] = ((bits >> (8 * j as u64)) & 0xff) as u8; }
    let mut s: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    for i in 0..${blocks} {
        let mut w = [0 as u32; 16];
        for j in 0..16 { w[j] = ((bytes[64*i+4*j] as u32) << 24) + ((bytes[64*i+4*j+1] as u32) << 16) + ((bytes[64*i+4*j+2] as u32) << 8) + (bytes[64*i+4*j+3] as u32); }
        s = std::hash::sha256_compression(w, s);
    }
    assert(s == proof_hash);`);
if (S) body.push(`let mut t = iv; for i in 0..${S} { t = std::hash::sha256_compression(sblocks[i], t); } assert(t != [0; 8]);`);
if (P) body.push(`let mut q = seed; for _ in 0..${P} { q = std::hash::poseidon2_permutation(q); } assert(q[0] != 0);`);
writeFileSync(path.join(project, 'src/main.nr'), `fn main(vk: [Field; ${vk.length}], proof: [Field; ${proof.length}], proof2: [Field; ${proof.length}], pi: pub [Field; ${pi.length}], key_hash: Field,
    proof_hash: pub [u32; 8], sblocks: [[u32; 16]; ${Math.max(S, 1)}], iv: [u32; 8], seed: [Field; 4]) {
    ${body.join('\n    ')}
}
`);
const { program } = await compile_program(createFileManager(project), undefined, () => {}, () => {});
writeFileSync(path.join(project, 'program.json'), JSON.stringify(program));
const words = b => Array.from({ length: b.length / 4 }, (_, i) => String(b.readUInt32BE(4 * i)));
const input = { vk, proof, proof2: proof, pi, key_hash: keyHash, proof_hash: words(digest),
  sblocks: Array.from({ length: Math.max(S, 1) }, () => words(randomBytes(64))), iv: words(randomBytes(32)), seed: ['1', '2', '3', '4'] };
const { witness } = await new Noir(program).execute(input);
writeFileSync(path.join(project, 'witness.gz'), witness);
const out = { parts: [...parts], S, P, gates: JSON.parse(execFileSync(bb, ['gates', '-b', path.join(project, 'program.json')], { encoding: 'utf8' })).functions[0].circuit_size };
if (parts.has('phash')) {
  const wrong = { ...input, proof_hash: words(createHash('sha256').update(Buffer.concat([proofBytes, Buffer.from([0])])).digest()) };
  out.wrongDigestRefused = await new Noir(program).execute(wrong).then(() => false, () => true);
}
if (process.argv.includes('--prove')) {
  for (let run = 0; run < 2; run++) {
    const t = performance.now();
    execFileSync(bb, ['prove', '-b', path.join(project, 'program.json'), '-w', path.join(project, 'witness.gz'), '-o', path.join(project, 'proof'), '--write_vk'], { stdio: ['ignore', 'ignore', 'pipe'] });
    (out.proveS ??= []).push((performance.now() - t) / 1000);
  }
  execFileSync(bb, ['verify', '-p', path.join(project, 'proof/proof'), '-k', path.join(project, 'proof/vk'), '-i', path.join(project, 'proof/public_inputs')], { stdio: 'ignore' });
  out.verified = true;
}
console.log(JSON.stringify(out));
