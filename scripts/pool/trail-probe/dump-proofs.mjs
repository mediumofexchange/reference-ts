// How proofs/ was made: the conformance build (scripts/pool/v3/check.mjs) run with one addition after its genuine
// proofs (`proofs[kind] = await accepts(...)`): each proof and its public inputs written here, then exit. Needs
// `npm run build` and `node scripts/pool/prepare-crs.mjs`. The copy runs beside check.mjs (its imports) and is removed.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../../..'), v3 = path.join(root, 'scripts/pool/v3');
const source = readFileSync(path.join(v3, 'check.mjs'), 'utf8');
const anchor = "for (const kind of kinds) proofs[kind] = await accepts(kind, bases[kind], kind + ': exact public order and real proof', true);";
if (!source.includes(anchor)) throw new Error('check.mjs changed: the anchor line is gone');
const out = JSON.stringify(path.join(import.meta.dirname, 'proofs'));
const dump = `\n  for (const k of ['spend', 'issue', 'demand', 'settle']) { writeFileSync(join(${out}, k + '.proof'), proofs[k].proof);
    writeFileSync(join(${out}, k + '.json'), JSON.stringify({ publicInputs: proofs[k].publicInputs }) + '\\n'); }
  process.exit(0);`;
const copy = path.join(v3, '_trail-probe-dump.mjs');
writeFileSync(copy, source.replace(anchor, anchor + dump));
try { execFileSync(process.execPath, [copy], { cwd: root, stdio: 'inherit' }); } finally { rmSync(copy); }
