// The node over full-size leaves of the three kinds, keyed by one proof dir of each kind (time-prove.sh's output),
// and its witness over two adjacent children: node node-build.mjs <T dir> <M dir> <U dir> <left dir> <right dir>
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Noir } from '@noir-lang/noir_js';
import { node, fields } from './gen-fold.mjs';
import { compile } from './compile.mjs';
const [tDir, mDir, uDir, l, r] = process.argv.slice(2);
const kh = (d) => fields(path.join(d, 'vk'), 'vk_hash')[0];
const dir = node('node_v2', kh(tDir), kh(mDir), kh(uDir));
const { program, ...g } = await compile(dir);
const kids = [l, r].map(d => ({ vk: fields(path.join(d, 'vk'), 'vk'), proof: fields(path.join(d, 'proof'), 'proof'), pi: fields(path.join(d, 'proof'), 'public_inputs'), kh: kh(d) }));
const input = { sin: kids[0].pi[0], sout: kids[1].pi[1], key_node: kids[0].pi[2], vk: kids.map(k => k.vk), proof: kids.map(k => k.proof), pi: kids.map(k => k.pi), kh: kids.map(k => k.kh) };
const { witness } = await new Noir(program).execute(input);
writeFileSync(path.join(dir, 'witness.gz'), witness);
console.log(JSON.stringify({ gates: g.circuit_size, keys: kids.map(k => k.kh) }));
