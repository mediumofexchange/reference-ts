// Hostile children for the node (node-build.mjs's build): each must fail to execute, or prove a proof that does not verify.
// node node-hostile.mjs <T proof dir> <M proof dir> <node vk dir>
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Noir } from '@noir-lang/noir_js';
import { fields } from './gen-fold.mjs';
import { bb, BUILD } from './compile.mjs';
const [tDir, mDir, vkDir] = process.argv.slice(2);
const dir = path.join(BUILD, 'node_v2');
const program = JSON.parse(readFileSync(path.join(dir, 'program.json')));
const kid = (d) => ({ vk: fields(path.join(d, 'vk'), 'vk'), proof: fields(path.join(d, 'proof'), 'proof'), pi: fields(path.join(d, 'proof'), 'public_inputs'), kh: fields(path.join(d, 'vk'), 'vk_hash')[0] });
const [a, b] = [kid(tDir), kid(mDir)];
const base = () => ({ sin: a.pi[0], sout: b.pi[1], key_node: a.pi[2], vk: [a.vk, b.vk], proof: [a.proof, b.proof], pi: [a.pi, b.pi], kh: [a.kh, b.kh] });
const bump = (x) => '0x' + (BigInt(x) + 1n).toString(16).padStart(64, '0');
const cases = {
  'a child proof altered in one field': (x) => { x.proof[1][200] = bump(x.proof[1][200]); },
  "the T-leaf's key used for the M-leaf's proof": (x) => { x.vk[1] = a.vk; x.kh[1] = a.kh; },
  "the M-leaf's key claimed under the T-leaf's hash": (x) => { x.kh[1] = a.kh; },
  'a key outside the set': (x) => { x.kh[1] = '0x1234'; },
  "a child's public input altered (its start state)": (x) => { x.pi[1][0] = bump(x.pi[1][0]); x.pi[0][1] = x.pi[1][0]; },
  'children that do not join': (x) => { x.pi[0][1] = bump(x.pi[0][1]); },
};
const out = [];
for (const [name, edit] of Object.entries(cases)) {
  const x = base(); edit(x);
  let outcome;
  try {
    const { witness } = await new Noir(program).execute(x);
    const w = path.join(BUILD, 'node-hostile'); mkdirSync(w, { recursive: true });
    writeFileSync(path.join(w, 'w.gz'), witness);
    try { execFileSync(bb, ['prove', '-b', path.join(dir, 'program.json'), '-w', path.join(w, 'w.gz'), '-k', path.join(vkDir, 'vk'), '-o', w, '-t', 'noir-recursive'], { stdio: 'ignore' }); } catch { outcome = 'proving fails'; }
    if (!outcome) { try { execFileSync(bb, ['verify', '-p', path.join(w, 'proof'), '-k', path.join(vkDir, 'vk'), '-i', path.join(w, 'public_inputs'), '-t', 'noir-recursive'], { stdio: 'ignore' }); outcome = 'VERIFIES'; } catch { outcome = 'proves, does not verify'; } }
  } catch { outcome = 'refused at execution'; }
  out.push({ name, outcome }); console.log(name, '->', outcome);
}
writeFileSync(path.join(import.meta.dirname, 'node-hostile.json'), JSON.stringify(out, null, 1));
