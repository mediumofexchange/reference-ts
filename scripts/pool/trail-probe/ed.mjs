// Ed25519 (RFC 8032, cofactored) in the circuit with willemolding/noir-ed25519, against @noble/curves signatures.
// Usage: node ed.mjs <message length> [--prove]; a flipped message byte must make execution fail.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
import { Noir } from '@noir-lang/noir_js';
import { ed25519 } from '@noble/curves/ed25519.js';
const here = import.meta.dirname, root = path.resolve(here, '../../..');
const bb = path.join(root, 'node_modules/@aztec/bb.js/build/amd64-linux/bb');
const L = Number(process.argv[2]);
const project = path.join(root, 'scratch/trail-probe/build', `ed_${L}`);
mkdirSync(path.join(project, 'src'), { recursive: true });
writeFileSync(path.join(project, 'Nargo.toml'), `[package]\nname = "ed_${L}"\ntype = "bin"\nauthors = []\n[dependencies]\ned25519 = { path = "${path.join(root, 'scratch/trail-probe/deps/noir-ed25519')}" }\nbignum = { path = "${path.join(root, 'scratch/trail-probe/deps/bignum')}" }\nedwards_bignum = { path = "${path.join(root, 'scratch/trail-probe/deps/noir-edwards-bignum')}" }\n`);
writeFileSync(path.join(project, 'src/main.nr'), `use bignum::{bignum::BigNum, ED25519_Fq as Fq};
use edwards_bignum::ed25519::Ed25519;
use edwards_bignum::ScalarField;
fn main(ax: [u128; 3], ay: [u128; 3], rx: [u128; 3], ry: [u128; 3], s: Field, msg: pub [u8; ${L}]) {
    let a = Ed25519::from((Fq::from_limbs(ax), Fq::from_limbs(ay)));
    let r = Ed25519::from((Fq::from_limbs(rx), Fq::from_limbs(ry)));
    let mut m: BoundedVec<u8, ${L}> = BoundedVec::new();
    m.extend_from_array(msg);
    assert(ed25519::ed25519_verify(a, ScalarField::<64>::from(s), r, m));
}
`);
const { program } = await compile_program(createFileManager(project), undefined, () => {}, () => {});
writeFileSync(path.join(project, 'program.json'), JSON.stringify(program));
const limbs = v => [v & ((1n << 120n) - 1n), (v >> 120n) & ((1n << 120n) - 1n), v >> 240n].map(String);
const secret = randomBytes(32), msg = randomBytes(L), sig = ed25519.sign(msg, secret);
const A = ed25519.Point.fromBytes(ed25519.getPublicKey(secret)).toAffine(), R = ed25519.Point.fromBytes(sig.subarray(0, 32)).toAffine();
let s = 0n; for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(sig[32 + i]);
const input = m => ({ ax: limbs(A.x), ay: limbs(A.y), rx: limbs(R.x), ry: limbs(R.y), s: String(s), msg: [...m].map(String) });
const noir = new Noir(program), { witness } = await noir.execute(input(msg));
writeFileSync(path.join(project, 'witness.gz'), witness);
const bad = Uint8Array.from(msg); bad[0] ^= 1;
const refused = await noir.execute(input(bad)).then(() => false, () => true);
const gates = JSON.parse(execFileSync(bb, ['gates', '-b', path.join(project, 'program.json')], { encoding: 'utf8' })).functions[0].circuit_size;
const out = { L, gates, nobleValid: ed25519.verify(sig, msg, ed25519.getPublicKey(secret)), flippedRefused: refused };
if (process.argv.includes('--prove')) {
  const t = performance.now();
  execFileSync(bb, ['prove', '-b', path.join(project, 'program.json'), '-w', path.join(project, 'witness.gz'), '-o', path.join(project, 'proof'), '--write_vk'], { stdio: ['ignore', 'ignore', 'pipe'] });
  out.proveS = (performance.now() - t) / 1000;
}
console.log(JSON.stringify(out));
