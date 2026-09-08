// Prepare synthetic public benchmark assets. No wallet or production proving API.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Barretenberg, BackendType, UltraHonkBackend } from '@aztec/bb.js';
import { fixtures } from '../fixtures.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = join(root, 'scratch');
mkdirSync(scratch, { recursive: true });
const output = join(scratch, 'pool-browser');
mkdirSync(output, { recursive: true });
// A failed or interrupted preparation must not leave an old manifest advertising
// partially replaced assets. The server requires this completion marker.
rmSync(join(output, 'manifest.json'), { force: true });
const crsPath = join(scratch, 'private-payment-crs');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = json(join(root, 'src/pool/circuits/manifest.json'));
// Require the existing recorded cache; do not silently download new parameters.
const recorded = json(join(root, 'docs/pool-v2-verification.json')).parameterCache;
const parameters = {};
for (const name of ['bn254_g1.dat', 'bn254_g2.dat', 'grumpkin_g1_v2.flat.dat']) {
  const bytes = readFileSync(join(crsPath, name));
  assert.equal(sha(bytes), recorded[name].sha256, `unrecognized cached parameter: ${name}`);
  parameters[name] = { bytes: bytes.length, sha256: sha(bytes) };
}
for (const [name, version] of Object.entries(pins.toolchain)) {
  assert.equal(json(join(root, 'node_modules', name, 'package.json')).version, version, name);
}
for (const [name, expected] of Object.entries(pins.sources)) {
  assert.equal(sha(readFileSync(join(root, 'src/pool/circuits', name))), expected, name);
}
const compiled = realpathSync(mkdtempSync(join(scratch, 'pool-browser-compile-')));
let api;
try {
  execFileSync(process.execPath, [join(root, 'scripts/pool/compile.mjs'), compiled],
    { cwd: root, windowsHide: true, timeout: 300_000, stdio: 'inherit' });
  api = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1, crsPath });
  for (const kind of ['issue', 'spend', 'burn']) {
    const program = json(join(compiled, `${kind}.json`));
    assert.equal(sha(Buffer.from(program.bytecode, 'base64')), pins.circuits[kind].bytecode, `${kind} bytecode`);
    const backend = new UltraHonkBackend(program.bytecode, api);
    const vk = await backend.getVerificationKey({ verifierTarget: pins.verifierTarget });
    assert.equal(sha(vk), pins.circuits[kind].vk, `${kind} key`);
    if (kind === 'spend') writeFileSync(join(output, 'spend.json'), JSON.stringify(program));
  }
  const f = await fixtures(api);
  const vectors = [
    { label: 'one real input plus padding', input: f.padded },
    { label: 'two real inputs, same backing', input: f.same },
    { label: 'two backings conserve separately', input: f.cross },
  ];
  writeFileSync(join(output, 'vectors.json'), JSON.stringify(vectors));
  const assets = {};
  for (const name of ['spend.json', 'vectors.json']) {
    const bytes = readFileSync(join(output, name));
    assets[name] = { bytes: bytes.length, sha256: sha(bytes) };
  }
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ construction: pins.construction,
    pins, assets, parameters, node: process.version, synthetic: true,
    parameterProvenance: 'Matches the recorded local cache; not authenticated setup provenance.' }, null, 2) + '\n');
  console.log('Prepared pinned synthetic browser inputs in scratch/pool-browser.');
} finally {
  if (api) await api.destroy();
  const local = relative(realpathSync(scratch), compiled);
  assert(local && !local.startsWith('..') && !isAbsolute(local), 'compiler cleanup must stay in scratch');
  rmSync(compiled, { recursive: true, force: true });
}
