// The aggregation probe's shared pieces (Next 12 step 2): the inner keys of pool-v3's six proved relations, the leaf
// and node circuits, compiling and proving with the pinned Barretenberg, and the host's digests a phone recomputes.
//
// A leaf of kind k verifies one statement proof under kind k's key, which is a constant of the leaf's circuit, computes
// §7's proofHash (SHA-256 over the proof's 458 big-endian fields) and outputs
//   digest = chain(k; public inputs..., proofHash high 128 bits, low 128 bits), two values a Poseidon2 permutation,
// with the node key as a free public input that any parent checks against its own. A node verifies two children, each
// under one of the six leaf keys (constants) or the node key (its own public input), and outputs
//   digest = P([left, right, 0, TAG_NODE])[0].
// A phone recomputes every digest from proof-free bytes and one proofHash a statement, and verifies one root proof
// under the pinned node key.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';

export const root = path.resolve(import.meta.dirname, '../../..');
export const BUILD = path.join(root, 'scratch/aggregation-probe');
export const bb = path.join(root, 'node_modules/@aztec/bb.js/build/amd64-linux/bb');
export const KINDS = { issue: 1, spend: 2, burn: 3, demand: 4, settle: 6, request: 7 };
export const TAG_LEAF = 0x6c656166n, TAG_NODE = 0x6e6f6465n;
export const fieldsOf = b => Array.from({ length: b.length / 32 }, (_, i) => '0x' + Buffer.from(b.subarray(i * 32, i * 32 + 32)).toString('hex'));
export const hex = x => '0x' + BigInt(x).toString(16).padStart(64, '0');
const { POOL_V3_MANIFEST } = await import(path.join(root, 'dist/pool/v3/configuration.js'));

/** Kind's inner key from the shipped program, as bb derives it under noir-recursive; its SHA-256 must be the manifest's. */
export function innerKey(name) {
  const dir = path.join(BUILD, 'inner', name);
  if (!existsSync(path.join(dir, 'vk_hash'))) {
    mkdirSync(dir, { recursive: true });
    const shipped = JSON.parse(readFileSync(path.join(root, 'src/pool/v3/programs.json'), 'utf8'))[name];
    writeFileSync(path.join(dir, 'program.json'), JSON.stringify(shipped));
    execFileSync(bb, ['write_vk', '-b', path.join(dir, 'program.json'), '-o', dir, '-t', 'noir-recursive'], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  const vk = readFileSync(path.join(dir, 'vk'));
  if (createHash('sha256').update(vk).digest('hex') !== POOL_V3_MANIFEST.circuits[name].vk) throw new Error(`${name}: key is not the manifest's`);
  return { vk: fieldsOf(vk), kh: fieldsOf(readFileSync(path.join(dir, 'vk_hash')))[0] };
}
/** A genuine conformance proof of a relation and its public inputs (dump-proofs.mjs). */
export function genuine(name) {
  const bytes = readFileSync(path.join(import.meta.dirname, 'proofs', name + '.proof'));
  const pi = JSON.parse(readFileSync(path.join(import.meta.dirname, 'proofs', name + '.json'), 'utf8')).publicInputs.map(BigInt);
  return { bytes, pi };
}

function project(name, main) {
  const dir = path.join(BUILD, name);
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'Nargo.toml'), `[package]\nname = "${name}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
  writeFileSync(path.join(dir, 'src/main.nr'), main);
  return dir;
}
const SHA = (n) => {
  const blocks = Math.floor(n * 32 / 64) + 1;
  return `fn proof_hash(proof: [Field; ${n}]) -> [u32; 8] {
    let mut bytes = [0 as u8; ${blocks * 64}];
    for i in 0..${n} { let b: [u8; 32] = proof[i].to_be_bytes(); for j in 0..32 { bytes[32 * i + j] = b[j]; } }
    bytes[${n * 32}] = 0x80;
    let bits: u64 = ${n * 32 * 8};
    for j in 0..8 { bytes[${blocks * 64 - 1} - j] = ((bits >> (8 * j as u64)) & 0xff) as u8; }
    let mut s: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    for i in 0..${blocks} {
        let mut w = [0 as u32; 16];
        for j in 0..16 { w[j] = ((bytes[64*i+4*j] as u32) << 24) + ((bytes[64*i+4*j+1] as u32) << 16) + ((bytes[64*i+4*j+2] as u32) << 8) + (bytes[64*i+4*j+3] as u32); }
        s = std::hash::sha256_compression(w, s);
    }
    s
}`;
};
/**
 * The leaf of relation `name`. Variants for the hostile key cases: `free` takes the key and its hash as witnesses
 * (any key, as the measured recursion did), `kh` pins the key but takes its hash as a witness.
 */
export function leaf(name, variant = 'pinned', tag = '') {
  const { vk, kh } = innerKey(name), P = genuine(name).pi.length, F = P + 2;
  const pinnedKey = variant === 'pinned' || variant === 'kh';
  return project(`leaf_${name}${variant === 'pinned' ? '' : '_' + variant}${tag}`, `${pinnedKey ? `global VK: [Field; ${vk.length}] = [${vk.join(', ')}];\n` : ''}${variant === 'pinned' ? `global KH: Field = ${kh};\n` : ''}global KIND: Field = ${KINDS[name]};
global TAG_LEAF: Field = ${TAG_LEAF};
global P128: Field = 340282366920938463463374607431768211456;
${SHA(458)}
fn main(proof: [Field; 458], pi: [Field; ${P}], key_node: pub Field${pinnedKey ? '' : `, vk: [Field; ${vk.length}]`}${variant === 'pinned' ? '' : ', kh: Field'}) -> pub Field {
    std::verify_proof_with_type(${pinnedKey ? 'VK' : 'vk'}, proof, pi, ${variant === 'pinned' ? 'KH' : 'kh'}, 6);
    let s = proof_hash(proof);
    let mut f = [0; ${F + (F % 2)}];
    for i in 0..${P} { f[i] = pi[i]; }
    f[${P}] = s[0] as Field * 79228162514264337593543950336 + s[1] as Field * 18446744073709551616 + s[2] as Field * 4294967296 + s[3] as Field;
    f[${P + 1}] = s[4] as Field * 79228162514264337593543950336 + s[5] as Field * 18446744073709551616 + s[6] as Field * 4294967296 + s[7] as Field;
    let mut x = KIND;
    for i in 0..${(F + (F % 2)) / 2} { x = std::hash::poseidon2_permutation([x, f[2 * i], f[2 * i + 1], TAG_LEAF])[0]; }
    assert(key_node == key_node);
    x
}
`);
}
/** The node over two children, each under one of `leafKeys` (constants) or the node key, its own public input. */
export function node(leafKeys, name = 'node') {
  return project(name, `${leafKeys.map((k, i) => `global KEY_${i}: Field = ${k};`).join('\n')}
global TAG_NODE: Field = ${TAG_NODE};
fn main(key_node: pub Field, vk: [[Field; 115]; 2], proof: [[Field; 458]; 2], pi: [[Field; 2]; 2], kh: [Field; 2]) -> pub Field {
    for i in 0..2 {
        assert(${leafKeys.map((_, j) => `(kh[i] - KEY_${j})`).join(' * ')} * (kh[i] - key_node) == 0);
        std::verify_proof_with_type(vk[i], proof[i], pi[i], kh[i], 6);
        assert(pi[i][0] == key_node);
    }
    std::hash::poseidon2_permutation([pi[0][1], pi[1][1], 0, TAG_NODE])[0]
}
`);
}
export async function compile(dir) {
  const { program } = await compile_program(createFileManager(dir), undefined, () => {}, () => {});
  writeFileSync(path.join(dir, 'program.json'), JSON.stringify(program));
  const g = JSON.parse(execFileSync(bb, ['gates', '-b', path.join(dir, 'program.json')], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  return { program, gates: g.functions[0].circuit_size };
}
/** Witness inputs of a leaf over proof bytes and public inputs. */
export function leafInput(bytes, pi, keyNode, extra = {}) {
  return { proof: fieldsOf(bytes), pi: pi.map(hex), key_node: hex(keyNode), ...extra };
}

// Host side: the digests a phone recomputes.
const { poseidon2Permutation } = await import(path.join(root, 'dist/pool/poseidon2.js'));
export function leafDigest(kind, pi, proofHash) {
  const h = BigInt('0x' + Buffer.from(proofHash).toString('hex'));
  const f = [...pi, h >> 128n, h & ((1n << 128n) - 1n)];
  if (f.length % 2) f.push(0n);
  let x = BigInt(kind);
  for (let i = 0; i < f.length; i += 2) x = poseidon2Permutation([x, f[i], f[i + 1], TAG_LEAF])[0];
  return x;
}
export const nodeDigest = (l, r) => poseidon2Permutation([l, r, 0n, TAG_NODE])[0];
export const sha256 = b => createHash('sha256').update(b).digest();

/** write_vk then a timed prove (peak RSS) then verify, with bb's CLI under noir-recursive. */
export const slug = s => s.replace(/[^A-Za-z0-9]+/g, '-');
export function prove(dir, witness, out) {
  const o = path.join(dir, slug(out));
  mkdirSync(o, { recursive: true });
  writeFileSync(path.join(o, 'witness.gz'), witness);
  const r = execFileSync('bash', [path.join(import.meta.dirname, 'time-prove.sh'), path.join(dir, 'program.json'), path.join(o, 'witness.gz'), o], { encoding: 'utf8' });
  return JSON.parse(r.trim().split('\n').pop());
}
export const host = () => execFileSync('sh', ['-c', "grep -m1 'model name' /proc/cpuinfo | cut -d: -f2"], { encoding: 'utf8' }).trim() + `, ${execFileSync('nproc', { encoding: 'utf8' }).trim()} vCPU`;
