// The node over the six pinned leaf keys and its own key: two levels of a tree over four genuine leaves (issue, spend,
// burn, demand), each node's digest against the host's, the root verified natively with its node key checked as a
// phone checks it, and hostile children. Needs leaves.mjs's and hostile.mjs's proofs. Writes results/node.json.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Noir } from '@noir-lang/noir_js';
import { BUILD, KINDS, node, compile, prove, fieldsOf, nodeDigest, host, slug } from './lib.mjs';
const read = (...p) => fieldsOf(readFileSync(path.join(BUILD, ...p)));
const leafKeys = Object.keys(KINDS).map(k => read(`leaf_${k}`, 'vk/vk_hash')[0]);
const child = (dir, run) => ({ vk: read(dir, 'vk/vk'), kh: read(dir, 'vk/vk_hash')[0], proof: read(dir, slug(run), 'proof/proof'), pi: read(dir, slug(run), 'proof/public_inputs') });
const dir = node(leafKeys);
const { program, gates } = await compile(dir);
// The node's own key, written once by the first prove; a phone pins it.
const out = { host: host(), gates, rows: 2 ** Math.ceil(Math.log2(gates)), cases: {} };
const input = (kn, a, b, over = {}) => ({ key_node: kn, vk: [a.vk, b.vk], proof: [a.proof, b.proof], pi: [a.pi, b.pi], kh: [a.kh, b.kh], ...over });
async function run(id, kn, a, b, over) {
  const r = {};
  let witness, value;
  try { ({ witness, returnValue: value } = await new Noir(program).execute(input(kn, a, b, over))); r.executes = true; }
  catch (e) { r.executes = false; r.error = String(e.message).slice(0, 160); }
  if (r.executes) { r.digest = value; Object.assign(r, prove(dir, witness, id)); }
  r.accepts = r.executes && r.exit === 0 && r.verified === true;
  out.cases[id] = r;
  console.log(id, JSON.stringify(r));
  return r;
}
// Level 1 needs the node key before any node proof exists: prove once with a placeholder to write the key (the key
// depends only on the circuit), then use its hash.
const L = k => child(`leaf_${k}`, 'genuine');
const leaves = ['issue', 'spend', 'burn', 'demand'].map(L);
await run('key', '0x05', leaves[0], leaves[1]);
const keyNode = read('node', 'vk/vk_hash')[0];
out.keyNode = keyNode;
// The leaves' key_node input was 5 in leaves.mjs; leaves for a tree are proved with the real node key.
const { leaf, leafInput, genuine } = await import('./lib.mjs');
for (const [i, k] of ['issue', 'spend', 'burn', 'demand'].entries()) {
  const ld = leaf(k), { program: lp } = await compile(ld), g = genuine(k);
  const { witness } = await new Noir(lp).execute(leafInput(g.bytes, g.pi, BigInt(keyNode)));
  out.cases[`leaf ${k} under the node key`] = prove(ld, witness, 'tree');
  leaves[i] = child(`leaf_${k}`, 'tree');
}
const a = await run('level 1: issue + spend', keyNode, leaves[0], leaves[1]);
const b = await run('level 1: burn + demand', keyNode, leaves[2], leaves[3]);
out.level1DigestsEqualHost = BigInt(a.digest) === nodeDigest(BigInt(leaves[0].pi[1]), BigInt(leaves[1].pi[1])) &&
  BigInt(b.digest) === nodeDigest(BigInt(leaves[2].pi[1]), BigInt(leaves[3].pi[1]));
const A = child('node', 'level 1: issue + spend'), B = child('node', 'level 1: burn + demand');
const top = await run('level 2: root', keyNode, A, B);
out.rootDigestEqualsHost = BigInt(top.digest) === nodeDigest(BigInt(a.digest), BigInt(b.digest));
const rootPi = read('node', slug('level 2: root'), 'proof/public_inputs');
out.phoneChecks = { rootKeyIsPinned: rootPi[0] === keyNode, rootDigest: rootPi[1] };
// Hostile children.
// The free leaf (its key a witness) over a burn proof under the burn key, as hostile.mjs's arbitrary-key case, proved
// with the real node key so that only its key is foreign.
{
  const fd = leaf('spend', 'free'), { program: fp } = await compile(fd), g = genuine('burn'), { innerKey } = await import('./lib.mjs');
  const { witness } = await new Noir(fp).execute(leafInput(g.bytes, g.pi, BigInt(keyNode), { vk: innerKey('burn').vk, kh: innerKey('burn').kh }));
  out.cases['free leaf under the node key'] = prove(fd, witness, 'tree');
}
const free = child('leaf_spend_free', 'tree');
await run('child under a key outside the set (leaf taking its key as a witness)', keyNode, free, leaves[1]);
await run('child key hash of the pinned spend leaf over the free leaf key and proof', keyNode, { ...free, kh: leaves[1].kh }, leaves[1]);
await run('child under the pinned key, its node key input another value (leaves.mjs proof, key_node 5)', keyNode, L('spend'), leaves[1]);
await run('node key input not the node key, children under it (level-1 node proofs)', '0x05', A, B);
await run('child digest substituted', keyNode, { ...leaves[0], pi: [leaves[0].pi[0], leaves[1].pi[1]] }, leaves[1]);
await run('child proof of one leaf with the other leaf public inputs', keyNode, { ...leaves[0], pi: leaves[1].pi }, leaves[1]);
mkdirSync(path.join(import.meta.dirname, 'results'), { recursive: true });
writeFileSync(path.join(import.meta.dirname, 'results/node.json'), JSON.stringify(out, null, 1) + '\n');
