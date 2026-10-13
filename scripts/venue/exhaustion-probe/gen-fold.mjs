// The aggregation's circuits beside the leaves: the node (two children, keys from the fixed set or the node's own),
// the first fold (a period's tree root, its start canonical and its end at a block boundary) and the next fold (the
// same over the previous fold, chaining periods).
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD } from './compile.mjs';
import { source } from './gen-leaf.mjs';

export const fields = (dir, file) => { const b = readFileSync(path.join(dir, file)); return Array.from({ length: b.length / 32 }, (_, i) => '0x' + b.subarray(i * 32, i * 32 + 32).toString('hex')); };
export const TAG_ACC = 7;
// The state's structs and hash, as the leaves define them.
function stateLib() {
  const s = source(1, 1, 1);
  const a = s.indexOf('pub struct T {'), b = s.indexOf('unconstrained fn inverse');
  return s.slice(s.indexOf('global S:'), s.indexOf('global BSEL')).replace(/global (CT|CM|E): u32 = 1;\n/g, '') + 'global P64: Field = 18446744073709551616;\nglobal P128: Field = 340282366920938463463374607431768211456;\n' + s.slice(a, b);
}
function write(name, main) {
  const dir = path.join(BUILD, name);
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'Nargo.toml'), `[package]\nname = "${name}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
  writeFileSync(path.join(dir, 'src/main.nr'), main);
  return dir;
}
const V = 115, PR = 458;
export function node(name, kT, kM, kU) {
  return write(name, `global KEY_T: Field = ${kT};
global KEY_M: Field = ${kM};
global KEY_U: Field = ${kU};
fn main(sin: pub Field, sout: pub Field, key_node: pub Field, vk: [[Field; ${V}]; 2], proof: [[Field; ${PR}]; 2], pi: [[Field; 3]; 2], kh: [Field; 2]) {
    for i in 0..2 {
        assert((kh[i] - KEY_T) * (kh[i] - KEY_M) * (kh[i] - KEY_U) * (kh[i] - key_node) == 0);
        std::verify_proof_with_type(vk[i], proof[i], pi[i], kh[i], 6);
        assert(pi[i][2] == key_node);
    }
    assert(pi[0][0] == sin);
    assert(pi[0][1] == pi[1][0]);
    assert(pi[1][1] == sout);
}
`);
}
const foldBody = (next) => `
fn record(acc: Field, lo: Field, hi: Field, height: Field, root: Field) -> Field {
    perm3(perm3(acc, lo, hi, TAG_ACC), height, root, TAG_ACC)
}
fn id2(w: [u64; 4]) -> (Field, Field) { (w[0] as Field + w[1] as Field * P64, w[2] as Field + w[3] as Field * P64) }
fn main(
    start_lo: pub Field, start_hi: pub Field, start_height: pub Field, end_lo: pub Field, end_hi: pub Field,
    end_height: pub Field, root: pub Field, acc: pub Field, key_node: pub Field, key_fold: pub Field,
    vk: [Field; ${V}], proof: [Field; ${PR}], pi: [Field; 3], kh: Field,
    t0: T, m0: M, u0: U, t1: T, m1: M, u1: U,${next ? `
    pvk: [Field; ${V}], pproof: [Field; ${PR}], ppi: [Field; 10], pkh: Field,` : ''}
) {
    // The period's tree root, under a leaf key or the node key.
    assert((kh - KEY_T) * (kh - KEY_M) * (kh - KEY_U) * (kh - key_node) == 0);
    std::verify_proof_with_type(vk, proof, pi, kh, 6);
    assert(pi[2] == key_node);
    assert(state_hash(t0, m0, u0) == pi[0]);
    assert(state_hash(t1, m1, u1) == pi[1]);
    // Its start: no transaction or header open, empty chains and stack, both streams at the start header.
    let (slo, shi) = id2(m0.prev);
    assert(!t0.in_tx);
    assert(t0.chain == 0);
    assert(m0.chain == 0);
    assert(t0.echain == 0);
    assert(u0.chain == 0);
    assert(!m0.in_hdr);
    assert(m0.sp == 0);
    assert(m0.j == 0);
    assert(t0.height == m0.height);
    // Its end: both streams at one block boundary with one chain of (height, position, id).
    assert(t1.chain == m1.chain);
    assert(t1.echain == u1.chain);
    assert(!t1.in_tx);
    assert(!m1.in_hdr);
    assert(m1.sp == 0);
    assert(t1.height == m1.height);
    let (elo, ehi) = id2(m1.prev);
    assert(end_lo == elo);
    assert(end_hi == ehi);
    assert(end_height == m1.height);
    assert(root == u1.root);${next ? `
    // The previous fold: under the first fold's key or this one's, ending where this period starts.
    assert((pkh - KEY_FIRST) * (pkh - key_fold) == 0);
    std::verify_proof_with_type(pvk, pproof, ppi, pkh, 6);
    assert(ppi[0] == start_lo);
    assert(ppi[1] == start_hi);
    assert(ppi[2] == start_height);
    assert(ppi[3] == slo);
    assert(ppi[4] == shi);
    assert(ppi[5] == m0.height);
    assert(ppi[6] == u0.root);
    assert(ppi[8] == key_node);
    assert(ppi[9] == key_fold);
    assert(acc == record(ppi[7], elo, ehi, m1.height, u1.root));` : `
    // The first period: the map starts empty, and the start is the fold's genesis.
    assert(u0.root == EMPTY_ROOT);
    assert(start_lo == slo);
    assert(start_hi == shi);
    assert(start_height == m0.height);
    assert(acc == record(0, elo, ehi, m1.height, u1.root));
    assert(key_fold == key_fold);`}
}
`;
export function fold(name, { kT, kM, kU, kFirst, emptyRoot }) {
  const next = kFirst !== undefined;
  return write(name, `global KEY_T: Field = ${kT};
global KEY_M: Field = ${kM};
global KEY_U: Field = ${kU};
global TAG_ACC: Field = ${TAG_ACC};
${next ? `global KEY_FIRST: Field = ${kFirst};` : `global EMPTY_ROOT: Field = ${emptyRoot};`}
${stateLib()}${foldBody(next)}`);
}
