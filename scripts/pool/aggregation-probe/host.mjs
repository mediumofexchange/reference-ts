// The host's verdict on every hostile case: the reference's v3 verifier (openV3Verifier over checked parameters),
// verifying the case's bytes and public inputs as its kind. Writes results/host.json.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { root, KINDS } from './lib.mjs';
import { cases } from './cases.mjs';
const { startBackend } = await import(path.join(root, 'dist/pool/proof-verifier.js'));
const { openV3Verifier } = await import(path.join(root, 'dist/pool/v3/verifier.js'));
const { PARAMETER_DIRECTORY, readParameters } = await import(path.join(root, 'scripts/pool/prepare-crs.mjs'));
const api = await startBackend(await readParameters(PARAMETER_DIRECTORY));
const verifier = await openV3Verifier(api);
const out = {};
for (const c of cases()) {
  let verdict;
  try { verdict = await verifier.verify(KINDS[c.as], c.pi, new Uint8Array(c.bytes)); } catch (e) { verdict = 'throws: ' + String(e.message).slice(0, 120); }
  out[c.id] = verdict;
  console.log(c.id, verdict);
}
await verifier.close(); await api.destroy();
mkdirSync(path.join(import.meta.dirname, 'results'), { recursive: true });
writeFileSync(path.join(import.meta.dirname, 'results/host.json'), JSON.stringify(out, null, 1) + '\n');
