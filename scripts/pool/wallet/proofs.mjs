// Wallet conformance adapter over the existing v2 compiler and verifier.
// Neither manifests nor circuits are repinned by this adapter.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Noir } from '@noir-lang/noir_js';
import { Barretenberg, BackendType, UltraHonkBackend } from '@aztec/bb.js';
import { barretenbergPool, PROOF_OPTIONS } from '@mediumofexchange/reference/pool/barretenberg';
import { pins } from './pins.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function openWalletProofs(directory) {
  assert.equal(pins.construction, 'moe/pool/v2');
  assert.equal(pins.verifierTarget, PROOF_OPTIONS.verifierTarget);
  for (const [name, version] of Object.entries(pins.toolchain)) {
    assert.equal(JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version, version);
  }
  for (const [name, hash] of Object.entries(pins.sources)) assert.equal(sha(readFileSync(join(root, 'src/pool/circuits', name))), hash);
  const programs = Object.fromEntries(['issue', 'spend', 'burn'].map(kind => {
    const program = JSON.parse(readFileSync(join(directory, kind + '.json'), 'utf8'));
    assert.equal(sha(Buffer.from(program.bytecode, 'base64')), pins.circuits[kind].bytecode);
    return [kind, program];
  }));
  const api = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1, crsPath: join(root, 'scratch/private-payment-crs') });
  try {
    const pool = await barretenbergPool(api, programs);
    for (const kind of ['issue', 'spend', 'burn']) {
      assert.equal(Buffer.from(pool.identities[kind].vk).toString('hex'), pins.circuits[kind].vk);
    }
    return { verifier: pool.verifier,
      async prove(kind, input, expected) {
        const name = { 1: 'issue', 2: 'spend', 3: 'burn' }[kind], program = programs[name];
        const { witness } = await new Noir(program).execute(input);
        const proof = await new UltraHonkBackend(program.bytecode, api).generateProof(witness, PROOF_OPTIONS);
        assert.deepEqual(proof.publicInputs.map(BigInt), expected, 'wallet witness public inputs differ from its persisted statement');
        assert.equal(await pool.verifier.verify(kind, expected, proof.proof), true);
        return proof.proof;
      },
      close: () => api.destroy(),
    };
  } catch (error) { await api.destroy(); throw error; }
}
