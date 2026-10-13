// The leaf's verdict on every hostile case: the leaf the case names (pinned key, or a variant) executed over the
// case's bytes, then proved and its proof verified under noir-recursive. A case the leaf accepts must be one the host
// accepts, with the same proofHash. Writes results/hostile.json beside host.json's verdicts.
// node hostile.mjs [case-id substring]
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Noir } from '@noir-lang/noir_js';
import { leaf, compile, leafInput, prove, leafDigest, sha256, KINDS } from './lib.mjs';
import { cases } from './cases.mjs';
const out = path.join(import.meta.dirname, 'results/hostile.json');
const all = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
const programs = new Map();
const filter = process.argv[2];
for (const [n, c] of cases().entries()) {
  if (filter && !c.id.includes(filter)) continue;
  const key = c.leaf + (c.variant ?? '');
  if (!programs.has(key)) programs.set(key, { dir: leaf(c.leaf, c.variant ?? 'pinned'), ...(await compile(leaf(c.leaf, c.variant ?? 'pinned'))) });
  const { dir, program } = programs.get(key);
  const r = { leaf: c.leaf + (c.variant ? ` (${c.variant})` : ''), as: c.as };
  let witness, value;
  try {
    ({ witness, returnValue: value } = await new Noir(program).execute(leafInput(c.bytes, c.pi, 5n, c.extra?.() ?? {})));
    r.executes = true;
  } catch (e) { r.executes = false; r.error = String(e.message).slice(0, 160); }
  if (r.executes) {
    // The digest the leaf outputs against the one a phone computes from the committed bytes' proofHash.
    r.digestOfCommittedBytes = BigInt(value) === leafDigest(KINDS[c.leaf], c.pi, sha256(c.bytes));
    try { Object.assign(r, prove(dir, witness, 'case' + n)); } catch (e) { r.proveError = String(e.message).slice(0, 160); }
  }
  r.leafAccepts = r.executes && r.exit === 0 && r.verified === true;
  all[c.id] = r;
  writeFileSync(out, JSON.stringify(all, null, 1) + '\n');
  console.log(c.id, JSON.stringify(r));
}
