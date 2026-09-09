// Cost and proof-binding probe for the F3 aggregate delivery digest selected in
// companion specification commit 02d911c. This is candidate evidence, not a
// v2 circuit/configuration/key change. It establishes only the cost and binding
// of two added public u128 limbs on spend; it does not establish capsule crypto,
// output association, retry/restoration, availability, or device performance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { gunzipSync } from 'node:zlib';
import { Noir } from '@noir-lang/noir_js';
import { Barretenberg, BackendType, UltraHonkBackend, UltraHonkVerifierBackend } from '@aztec/bb.js';
import { fixtures, field } from '../../fixtures.mjs';

const root = resolve(import.meta.dirname, '../../../..');
const scratchCandidate = join(root, 'scratch');
mkdirSync(scratchCandidate, { recursive: true });
const scratchParent = realpathSync(scratchCandidate);
const scratchPath = join(scratchParent, 'pool-delivery-binding');
mkdirSync(scratchPath, { recursive: true });
const scratch = realpathSync(scratchPath);
if (!scratch.startsWith(scratchParent + sep)) throw new Error('unsafe delivery scratch path');
const build = join(scratch, 'build');
if (!resolve(build).startsWith(scratch + sep)) throw new Error('unsafe delivery build path');
rmSync(build, { recursive: true, force: true });

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const packageVersion = name => json(join(root, 'node_modules', name, 'package.json')).version;
const manifest = json(join(root, 'src/pool/circuits/manifest.json'));
for (const dependency of ['@aztec/bb.js', '@noir-lang/noir_js', '@noir-lang/noir_wasm']) {
  assert.equal(packageVersion(dependency), manifest.toolchain[dependency], `unpinned ${dependency}`);
}

const compileStart = performance.now();
const compiled = await promisify(execFile)(process.execPath, [join(import.meta.dirname, 'compile.mjs'), scratch], {
  cwd: root, windowsHide: true, timeout: 300_000, maxBuffer: 2_000_000,
});
process.stdout.write(compiled.stdout);
const compileMs = performance.now() - compileStart;
const baseline = json(join(build, 'baseline.json'));
const candidate = json(join(build, 'candidate.json'));
const encoded = program => Buffer.from(program.bytecode, 'base64');
assert.equal(sha256(encoded(baseline)), manifest.circuits.spend.bytecode, 'fresh baseline differs from pinned spend bytecode');
const deliveryAbi = candidate.abi.parameters.find(parameter => parameter.name === 'delivery');
assert.deepEqual(deliveryAbi, { name: 'delivery', type: { kind: 'array', length: 2,
  type: { kind: 'integer', sign: 'unsigned', width: 128 } }, visibility: 'public' });

const crsPath = join(scratchParent, 'private-payment-crs');
const options = Object.freeze({ verifierTarget: 'noir-recursive' });
const api = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1, crsPath });
try {
  const acir = program => gunzipSync(encoded(program));
  const baselineCircuitSizes = await api.acirGetCircuitSizes(acir(baseline), true, true);
  const candidateCircuitSizes = await api.acirGetCircuitSizes(acir(candidate), true, true);
  const f = await fixtures(api);
  const input = structuredClone(f.padded);
  input.delivery = [(1n << 128n) - 1n, 0x123456789abcdef123456789abcdef0n].map(String);
  const noir = new Noir(candidate);
  const backend = new UltraHonkBackend(candidate.bytecode, api);
  const verifier = new UltraHonkVerifierBackend(api);
  const executeStart = performance.now();
  const { witness } = await noir.execute(input);
  const executeMs = performance.now() - executeStart;
  const proveStart = performance.now();
  const proof = await backend.generateProof(witness, options);
  const proveMs = performance.now() - proveStart;
  const keyStart = performance.now();
  const verificationKey = await backend.getVerificationKey(options);
  const verificationKeyMs = performance.now() - keyStart;
  const verifyStart = performance.now();
  assert.equal(await verifier.verifyProof({ ...proof, verificationKey }, options), true);
  const verifyMs = performance.now() - verifyStart;
  const expected = [...input.domain, ...input.segment, input.scope, ...input.anchors,
    ...input.nullifiers, ...input.outputs, ...input.delivery].map(field);
  assert.deepEqual(proof.publicInputs.map(field), expected);
  assert.equal(proof.publicInputs.length, 13);

  for (const index of [11, 12]) {
    const changed = [...proof.publicInputs];
    changed[index] = field(BigInt(changed[index]) - 1n);
    assert.equal(await verifier.verifyProof({ ...proof, publicInputs: changed, verificationKey }, options), false,
      `delivery public input ${index} is not proof-bound`);
  }

  async function rejected(run, label) {
    try { await run(); } catch (error) {
      return { label, name: error?.constructor?.name ?? typeof error, message: String(error?.message ?? error) };
    }
    assert.fail(label + ' unexpectedly executed');
  }
  const normalOverflowFailures = [];
  for (const limb of [0, 1]) {
    const overflow = structuredClone(input);
    overflow.delivery[limb] = (1n << 128n).toString();
    normalOverflowFailures.push(await rejected(() => noir.execute(overflow), `normal ABI delivery limb ${limb}`));
  }
  // Change only host ABI metadata to Field; ACIR bytecode stays byte-for-byte
  // identical. The valid control excludes a generic ABI mismatch. Rejection of
  // 2^128 then demonstrates the compiled circuit's u128 range constraints.
  const bypass = structuredClone(candidate);
  bypass.abi.parameters.find(parameter => parameter.name === 'delivery').type.type = { kind: 'field' };
  const bypassNoir = new Noir(bypass);
  await bypassNoir.execute(input);
  const acirOverflowFailures = [];
  for (const limb of [0, 1]) {
    const overflow = structuredClone(input);
    overflow.delivery[limb] = field(1n << 128n);
    acirOverflowFailures.push(await rejected(() => bypassNoir.execute(overflow), `Field ABI delivery limb ${limb}`));
  }

  const generatedSource = join(scratch, 'generated-spend.nr');
  const report = {
    candidate: 'pool-v2-spend-plus-public-delivery-u128x2', sourceOnly: true,
    companionSpecCommit: '02d911c82d895feae86607ee9e9d3cae9612361e',
    node: process.version, platform: process.platform, arch: process.arch,
    noirVersion: candidate.noir_version, verifierTarget: options.verifierTarget,
    toolchain: Object.fromEntries(['@aztec/bb.js', '@noir-lang/noir_js', '@noir-lang/noir_wasm'].map(name => [name, packageVersion(name)])),
    publicInputOrder: ['domainHi','domainLo','segmentHi','segmentLo','scope','anchor1','anchor2','nullifier1','nullifier2','output1','output2','deliveryHi','deliveryLo'],
    publicInputCount: proof.publicInputs.length, deliveryAbi,
    checks: ['fresh baseline equals pinned spend bytecode','genuine maximum-limb spend executes, proves and verifies',
      'proof public inputs match declared order','mutating either delivery public input rejects the original proof',
      'Field-ABI valid control executes over unchanged ACIR','2^128 in either Field-spelled delivery limb fails unchanged ACIR'],
    overflowFailures: { normalAbi: normalOverflowFailures, fieldAbiUnchangedAcir: acirOverflowFailures },
    metrics: { compileMs, executeMs, proveMs, verificationKeyMs, verifyMs, proofBytes: proof.proof.length,
      publicInputBytesAdded: 64, baselineCircuitSizes, candidateCircuitSizes,
      baselineCompressedBytecodeBytes: encoded(baseline).length, candidateCompressedBytecodeBytes: encoded(candidate).length },
    identities: { baselineBytecodeSha256: sha256(encoded(baseline)), candidateBytecodeSha256: sha256(encoded(candidate)),
      verificationKeySha256: sha256(verificationKey), generatedSourceSha256: sha256(readFileSync(generatedSource)),
      checkScriptSha256: sha256(readFileSync(import.meta.filename)), compileScriptSha256: sha256(readFileSync(join(import.meta.dirname, 'compile.mjs'))),
      notesSha256: sha256(readFileSync(join(root, 'src/pool/circuits/notes.nr'))),
      poseidon2Sha256: sha256(readFileSync(join(root, 'src/pool/circuits/vendor/poseidon2.nr'))) },
    limits: ['digest preimage/framing and capsule cryptography are outside this probe',
      'issue, burn, settle, output association, retry, restoration and availability are outside this probe',
      'desktop timings are one run and do not establish device budgets'],
  };
  writeFileSync(join(scratch, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await api.destroy();
}
