// Two tree cases from review, after node.mjs: (1) a forged tree, the genuine node circuit with its node-key input set
// to the witness-key leaf's key hash over two such leaves accepting a burn proof as a spend: its root verifies under
// the pinned node key, and only the phone's check of the root's node-key input refuses it; (2) propagation, a node
// over the genuine issue leaf and a pinned spend leaf over the proof whose KZG W is the generator (only its final
// pairing fails): the node proof fails at the pairing check. Also records the stage at which each hostile leaf proof's
// verification failed (bb's verify.log). Writes results/tree-cases.json and adds `failedAt` to results/hostile.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Noir } from '@noir-lang/noir_js';
import { BUILD, fieldsOf, leafInput, genuine, innerKey, prove } from './lib.mjs';
import { cases } from './cases.mjs';
const read = (...p) => fieldsOf(readFileSync(path.join(BUILD, ...p)));
const program = d => JSON.parse(readFileSync(path.join(BUILD, d, 'program.json'), 'utf8'));
const child = (dir, run) => ({ vk: read(dir, 'vk/vk'), kh: read(dir, 'vk/vk_hash')[0], proof: read(dir, run, 'proof/proof'), pi: read(dir, run, 'proof/public_inputs') });
const stage = (...p) => { const f = path.join(BUILD, ...p, 'verify.log'); if (!existsSync(f)) return undefined;
  const t = readFileSync(f, 'utf8'); return /verified successfully/.test(t) ? 'verified' : (t.match(/verification failed at ([a-z ]+)/)?.[1].trim() ?? 'failed'); };
const out = {}, pinnedNode = read('node', 'vk/vk_hash')[0], freeKh = read('leaf_spend_free', 'vk/vk_hash')[0];
// (1) The forged tree.
{
  const g = genuine('burn'), k = innerKey('burn');
  const { witness } = await new Noir(program('leaf_spend_free')).execute(leafInput(g.bytes, g.pi, BigInt(freeKh), { vk: k.vk, kh: k.kh }));
  const leaf = prove(path.join(BUILD, 'leaf_spend_free'), witness, 'forged');
  const c = child('leaf_spend_free', 'forged');
  const r = await new Noir(program('node')).execute({ key_node: freeKh, vk: [c.vk, c.vk], proof: [c.proof, c.proof], pi: [c.pi, c.pi], kh: [c.kh, c.kh] });
  const root = prove(path.join(BUILD, 'node'), r.witness, 'forged');
  const pi = read('node', 'forged', 'proof/public_inputs');
  out['forged tree under a made-up node key'] = { leaf, root, rootVerifiesUnderPinnedNodeKey: root.verified,
    rootNodeKeyInputIsPinned: pi[0] === pinnedNode, phoneAccepts: root.verified && pi[0] === pinnedNode };
}
// (2) Propagation of a child's deferred pairing points.
{
  const c = cases().find(c => c.id.startsWith('pairing-part-only'));
  const { witness } = await new Noir(program('leaf_spend')).execute(leafInput(c.bytes, c.pi, BigInt(pinnedNode)));
  const leaf = prove(path.join(BUILD, 'leaf_spend'), witness, 'pairing-tamper-tree');
  const bad = child('leaf_spend', 'pairing-tamper-tree'), good = child('leaf_issue', 'tree');
  const r = await new Noir(program('node')).execute({ key_node: pinnedNode, vk: [good.vk, bad.vk], proof: [good.proof, bad.proof], pi: [good.pi, bad.pi], kh: [good.kh, bad.kh] });
  const node = prove(path.join(BUILD, 'node'), r.witness, 'pairing-tamper-tree');
  out['node over a leaf of a pairing-only tamper'] = { leaf: { ...leaf, failedAt: stage('leaf_spend', 'pairing-tamper-tree') }, node: { ...node, failedAt: stage('node', 'pairing-tamper-tree') } };
}
const hostilePath = path.join(import.meta.dirname, 'results/hostile.json'), hostile = JSON.parse(readFileSync(hostilePath, 'utf8'));
for (const [n, c] of cases().entries()) if (hostile[c.id]?.exit === 0) hostile[c.id].failedAt = stage(`leaf_${c.leaf}${c.variant ? '_' + c.variant : ''}`, 'case' + n);
writeFileSync(hostilePath, JSON.stringify(hostile, null, 1) + '\n');
writeFileSync(path.join(import.meta.dirname, 'results/tree-cases.json'), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(out, null, 1));
