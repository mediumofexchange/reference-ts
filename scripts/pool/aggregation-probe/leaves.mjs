// node leaves.mjs [names...]: each proved relation's leaf compiled (gates), executed over its genuine conformance proof
// (the leaf's digest equal to the host's), proved and verified under noir-recursive; results to results/leaves.json.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Noir } from '@noir-lang/noir_js';
import { leaf, compile, genuine, leafInput, prove, leafDigest, sha256, KINDS, host } from './lib.mjs';
const out = path.join(import.meta.dirname, 'results/leaves.json');
mkdirSync(path.dirname(out), { recursive: true });
const all = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : { host: host(), leaves: {} };
for (const name of process.argv.length > 2 ? process.argv.slice(2) : Object.keys(KINDS)) {
  const dir = leaf(name);
  const { program, gates } = await compile(dir);
  const g = genuine(name);
  const { witness, returnValue } = await new Noir(program).execute(leafInput(g.bytes, g.pi, 5n));
  const r = { kind: KINDS[name], publicInputs: g.pi.length, gates, rows: 2 ** Math.ceil(Math.log2(gates)),
    digestEqualsHost: BigInt(returnValue) === leafDigest(KINDS[name], g.pi, sha256(g.bytes)), ...prove(dir, witness, 'genuine') };
  all.leaves[name] = r;
  writeFileSync(out, JSON.stringify(all, null, 1) + '\n');
  console.log(name, JSON.stringify(r));
}
