// A chained Bitcoin leaf for the venue recheck (Next 12): K SHA-256 compressions over bytes packed into words (a
// transaction's padded blocks, as a txid's first hash reads them) and one type-6 recursive verification of a
// noir-recursive proof, in one circuit. The witness's final state must equal node:crypto's SHA-256 of a random
// message whose padding fills exactly K blocks. Usage: node leaf.mjs inner | node leaf.mjs <K> [--witness]
// `inner` proves a small circuit with -t noir-recursive under scratch/recheck-probe/inner/rec (the leaf's predecessor).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
import { Noir } from '@noir-lang/noir_js';

const root = path.resolve(import.meta.dirname, '../../..');
const bb = path.join(root, 'node_modules/@aztec/bb.js/build/amd64-linux/bb');
const build = path.join(root, 'scratch/recheck-probe');
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

async function compile(name, source) {
  const project = path.join(build, name);
  mkdirSync(path.join(project, 'src'), { recursive: true });
  writeFileSync(path.join(project, 'Nargo.toml'), `[package]\nname = "${name}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
  writeFileSync(path.join(project, 'src/main.nr'), source);
  const { program } = await compile_program(createFileManager(project), undefined, () => {}, () => {});
  writeFileSync(path.join(project, 'program.json'), JSON.stringify(program));
  return { project, program };
}

// SHA-256 padding of a message whose padded length is exactly K blocks: 64K − 9 bytes, 0x80, the bit length.
function padded(K) {
  const msg = randomBytes(64 * K - 9);
  const len = Buffer.alloc(8);
  len.writeBigUInt64BE(BigInt(msg.length) * 8n);
  return { msg, blocks: Buffer.concat([msg, Buffer.from([0x80]), len]) };
}

const words = (digest) => Array.from({ length: 8 }, (_, i) => String(digest.readUInt32BE(4 * i)));
const arg = process.argv[2];
if (arg === 'inner') {
  const { project, program } = await compile('inner', `fn main(bytes: [u8; 64], iv: [u32; 8], expected: pub [u32; 8]) {
    let mut w = [0 as u32; 16];
    for j in 0..16 { w[j] = ((bytes[4*j] as u32) << 24) + ((bytes[4*j+1] as u32) << 16) + ((bytes[4*j+2] as u32) << 8) + (bytes[4*j+3] as u32); }
    assert(std::hash::sha256_compression(w, iv) == expected);
}
`);
  const { msg, blocks } = padded(1);
  const { witness } = await new Noir(program).execute({ bytes: [...blocks].map(String), iv: IV.map(String), expected: words(createHash('sha256').update(msg).digest()) });
  writeFileSync(path.join(project, 'witness.gz'), witness);
  execFileSync(bb, ['prove', '-b', path.join(project, 'program.json'), '-w', path.join(project, 'witness.gz'), '-o', path.join(project, 'rec'), '--write_vk', '-t', 'noir-recursive'], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(JSON.stringify({ inner: path.join(project, 'rec') }));
} else {
  const K = Number(arg);
  const rec = path.join(build, 'inner/rec');
  const fields = (file) => { const b = readFileSync(path.join(rec, file)); return Array.from({ length: b.length / 32 }, (_, i) => '0x' + b.subarray(i * 32, i * 32 + 32).toString('hex')); };
  const vk = fields('vk'), keyHash = fields('vk_hash')[0], proof = fields('proof'), pi = fields('public_inputs');
  const { project, program } = await compile(`leaf_${K}`, `fn main(bytes: [u8; ${64 * K}], iv: [u32; 8], expected: pub [u32; 8], vk: [Field; ${vk.length}], proof: [Field; ${proof.length}], pi: pub [Field; ${pi.length}], key_hash: Field) {
    let mut s = iv;
    for i in 0..${K} {
        let mut w = [0 as u32; 16];
        for j in 0..16 { w[j] = ((bytes[i*64+4*j] as u32) << 24) + ((bytes[i*64+4*j+1] as u32) << 16) + ((bytes[i*64+4*j+2] as u32) << 8) + (bytes[i*64+4*j+3] as u32); }
        s = std::hash::sha256_compression(w, s);
    }
    assert(s == expected);
    std::verify_proof_with_type(vk, proof, pi, key_hash, 6);
}
`);
  if (process.argv.includes('--witness')) {
    const { msg, blocks } = padded(K);
    const { witness } = await new Noir(program).execute({ bytes: [...blocks].map(String), iv: IV.map(String), expected: words(createHash('sha256').update(msg).digest()), vk, proof, pi, key_hash: keyHash });
    writeFileSync(path.join(project, 'witness.gz'), witness);
  }
  const gates = JSON.parse(execFileSync(bb, ['gates', '-b', path.join(project, 'program.json')], { encoding: 'utf8' }));
  console.log(JSON.stringify({ K, gates: gates.functions[0], project }));
}
