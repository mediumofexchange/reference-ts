// End to end with small leaves: two consecutive periods proved as T- and M-leaves, joined by nodes, folded, and
// the last fold verified; then hostile folds. node e2e.mjs [seed] [blocks per period]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Noir } from '@noir-lang/noir_js';
import { compile, bb, BUILD } from './compile.mjs';
import { periodKinds, kindInputs, SubjectMap, KEY_NODE, tJson, mJson, perm3, wordsOf, stateHash } from './model.mjs';
import { synthPeriod } from './synth.mjs';
import { node, fold, fields, TAG_ACC } from './gen-fold.mjs';

const seed = Number(process.argv[2] ?? 5), per = Number(process.argv[3] ?? 3);
const LT = { CT: 8, CM: 0, E: 0 }, LM = { CT: 0, CM: 12, E: 0 }, LU = { CT: 0, CM: 0, E: 4 };
const out = path.join(BUILD, 'e2e');
mkdirSync(out, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const times = {};
const timed = (k, f) => { const t = performance.now(); const r = f(); (times[k] ??= []).push(+((performance.now() - t) / 1000).toFixed(1)); return r; };
// Keys.
async function build(dir) { const { program, ...g } = await compile(dir); return { dir, program, gates: g.circuit_size }; }
function writeVk(c, name) { const d = path.join(out, 'vk-' + name); mkdirSync(d, { recursive: true }); execFileSync(bb, ['write_vk', '-b', path.join(c.dir, 'program.json'), '-o', d, '-t', 'noir-recursive'], { stdio: 'ignore' }); return { vkDir: d, kh: fields(d, 'vk_hash')[0], vk: fields(d, 'vk') }; }
let n = 0;
async function prove(c, key, input, label) {
  const { witness } = await new Noir(c.program).execute(input);
  const d = path.join(out, `p${n++}-${label}`); mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'w.gz'), witness);
  timed(label, () => execFileSync(bb, ['prove', '-b', path.join(c.dir, 'program.json'), '-w', path.join(d, 'w.gz'), '-k', path.join(key.vkDir, 'vk'), '-o', d, '-t', 'noir-recursive'], { stdio: 'ignore' }));
  return { dir: d, vk: key.vk, kh: key.kh, proof: fields(d, 'proof'), pi: fields(d, 'public_inputs') };
}
const cT = await build(path.join(BUILD, 'leaf_8_0_0')), cM = await build(path.join(BUILD, 'leaf_0_12_0')), cU = await build(path.join(BUILD, 'leaf_0_0_4'));
const kT = writeVk(cT, 'T'), kM = writeVk(cM, 'M'), kU = writeVk(cU, 'U');
const cN = await build(node('node_s', kT.kh, kM.kh, kU.kh)); const kN = writeVk(cN, 'N');
const empty = new SubjectMap().root;
const cF1 = await build(fold('fold_first_s', { kT: kT.kh, kM: kM.kh, kU: kU.kh, emptyRoot: '0x' + empty.toString(16) })); const kF1 = writeVk(cF1, 'F1');
const cF2 = await build(fold('fold_next_s', { kT: kT.kh, kM: kM.kh, kU: kU.kh, kFirst: kF1.kh })); const kF2 = writeVk(cF2, 'F2');
log('gates', { T: cT.gates, M: cM.gates, U: cU.gates, node: cN.gates, foldFirst: cF1.gates, foldNext: cF2.gates });
KEY_NODE.value = BigInt(kN.kh);

const all = synthPeriod(seed, { blocks: 2 * per, maxTxs: 3 });
const A = { parent: all.parent, blocks: all.blocks.slice(0, per) };
const B = { parent: { height: all.blocks[per - 1].height, id: all.blocks[per - 1].id }, blocks: all.blocks.slice(per) };
const map = new SubjectMap();
async function periodProof(data) {
  const p = periodKinds(data, { CT: LT.CT, CM: LM.CM, EU: LU.E }, map);
  let level = [];
  const leaves = [];
  for (const l of p.leaves) level.push(await prove({ T: cT, M: cM, U: cU }[l.kind], { T: kT, M: kM, U: kU }[l.kind], kindInputs(l.st0, l.leaf, l.params), 'leaf' + l.kind));
  leaves.push(...level.slice(leaves.length));
  log('period', data.blocks[0].height, 'leaves', p.leaves.length, 'entries', p.leaves.reduce((s, l) => s + l.leaf.ents.length, 0), 'kinds', p.leaves.map(l => l.kind).join(''));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      const [a, b] = [level[i], level[i + 1]];
      next.push(await prove(cN, kN, { sin: a.pi[0], sout: b.pi[1], key_node: kN.kh, vk: [a.vk, b.vk], proof: [a.proof, b.proof], pi: [a.pi, b.pi], kh: [a.kh, b.kh] }, 'node'));
    }
    if (level.length % 2) next.push(level.at(-1));
    level = next;
  }
  return { root: level[0], first: p.leaves[0].st0, final: p.final, leaf0: leaves[0], leaf0st: p.leaves[0].leaf.st };
}
const id2 = (w) => [w[0] + w[1] * (1n << 64n), w[2] + w[3] * (1n << 64n)];
const record = (acc, lo, hi, h, root) => perm3(perm3(acc, lo, hi, TAG_ACC), h, root, TAG_ACC);
const S = (x) => '0x' + BigInt(x).toString(16);
const tJ = (t) => ({ ...tJson(t), echain: S(t.echain) }), uJ = (u) => ({ chain: S(u.chain), root: S(u.root) });
function foldInput(pp, prev, accPrev, start) {
  const [elo, ehi] = id2(pp.final.m.prev);
  const acc = record(accPrev, elo, ehi, pp.final.m.height, pp.final.u.root);
  const x = { start_lo: S(start[0]), start_hi: S(start[1]), start_height: S(start[2]), end_lo: S(elo), end_hi: S(ehi), end_height: S(pp.final.m.height),
    root: S(pp.final.u.root), acc: S(acc), key_node: kN.kh, key_fold: kF2.kh,
    vk: pp.root.vk, proof: pp.root.proof, pi: pp.root.pi, kh: pp.root.kh,
    t0: tJ(pp.first.t), m0: mJson(pp.first.m), u0: uJ(pp.first.u), t1: tJ(pp.final.t), m1: mJson(pp.final.m), u1: uJ(pp.final.u) };
  if (prev) Object.assign(x, { pvk: prev.vk, pproof: prev.proof, ppi: prev.pi, pkh: prev.kh });
  return { x, acc };
}
const pa = await periodProof(A);
const start = [...id2(pa.first.m.prev), pa.first.m.height];
const fa = foldInput(pa, undefined, 0n, start);
const f1 = await prove(cF1, kF1, fa.x, 'foldFirst');
const pb = await periodProof(B);
const fb = foldInput(pb, f1, fa.acc, start);
const f2 = await prove(cF2, kF2, fb.x, 'foldNext');
let verified = true;
try { execFileSync(bb, ['verify', '-p', path.join(f2.dir, 'proof'), '-k', path.join(kF2.vkDir, 'vk'), '-i', path.join(f2.dir, 'public_inputs'), '-t', 'noir-recursive'], { stdio: 'ignore' }); } catch { verified = false; }
// A phone's checks on the latest fold's public inputs: the pinned node and fold keys, the map's start (the genesis
// header id and height it pinned), and the end id's two halves and height against a header it verified itself.
const lastId = id2(wordsOf(Buffer.from(B.blocks.at(-1).id, 'hex'))), genesis = id2(wordsOf(Buffer.from(A.parent.id, 'hex')));
const phone = {
  keys: BigInt(f2.pi[8]) === BigInt(kN.kh) && BigInt(f2.pi[9]) === BigInt(kF2.kh),
  start: BigInt(f2.pi[0]) === genesis[0] && BigInt(f2.pi[1]) === genesis[1] && BigInt(f2.pi[2]) === BigInt(A.parent.height),
  end: BigInt(f2.pi[3]) === lastId[0] && BigInt(f2.pi[4]) === lastId[1] && BigInt(f2.pi[5]) === BigInt(B.blocks.at(-1).height),
};
const endOk = phone.keys && phone.start && phone.end;
log('final fold verified', verified, 'phone checks', JSON.stringify(phone), 'root is the map', BigInt(f2.pi[6]) === map.root, 'subjects', map.leaves.size);
// Hostile folds: each must be refused at execution.
const hostile = [];
async function refuse(name, c, x) { try { await new Noir(c.program).execute(x); hostile.push({ name, refused: false }); } catch { hostile.push({ name, refused: true }); } }
await refuse('a fold claiming another end height', cF1, { ...fa.x, end_height: S(BigInt(fa.x.end_height) + 1n) });
await refuse('a fold claiming another map root', cF1, { ...fa.x, root: S(BigInt(fa.x.root) + 1n) });
await refuse("a fold over the other period's tree", cF1, { ...fa.x, vk: pb.root.vk, proof: pb.root.proof, pi: pb.root.pi, kh: pb.root.kh });
await refuse('a next fold whose previous fold ends elsewhere', cF2, { ...fb.x, ppi: f1.pi.map((v, i) => (i === 5 ? S(BigInt(v) + 1n) : v)) });
await refuse('a first fold whose map does not start empty', cF1, { ...fa.x, u0: { ...fa.x.u0, root: S(1n) } });
await refuse('a fold over a lone first leaf (its streams end apart)', cF1, { ...fa.x, vk: pa.leaf0.vk, proof: pa.leaf0.proof, pi: pa.leaf0.pi, kh: pa.leaf0.kh, t1: tJ(pa.leaf0st.t), m1: mJson(pa.leaf0st.m), u1: uJ(pa.leaf0st.u), root: S(pa.leaf0st.u.root), end_lo: S(id2(pa.leaf0st.m.prev)[0]), end_hi: S(id2(pa.leaf0st.m.prev)[1]), end_height: S(pa.leaf0st.m.height), acc: S(record(0n, ...id2(pa.leaf0st.m.prev), pa.leaf0st.m.height, pa.leaf0st.u.root)) });
log('hostile', JSON.stringify(hostile));
writeFileSync(path.join(out, 'result.json'), JSON.stringify({ seed, blocksPerPeriod: per, gates: { T: cT.gates, M: cM.gates, U: cU.gates, node: cN.gates, foldFirst: cF1.gates, foldNext: cF2.gates }, proveS: times, verified, phoneChecks: phone, hostile }, null, 1));
