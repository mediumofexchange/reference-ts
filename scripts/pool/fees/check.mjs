// F4 fee-output circuit feasibility and binding probe. This is disposable
// evidence over generated candidates, not production v3 admission or finality.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus } from 'node:os';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { gunzipSync } from 'node:zlib';
import { Noir } from '@noir-lang/noir_js';
import { Barretenberg, BackendType, UltraHonkBackend, UltraHonkVerifierBackend } from '@aztec/bb.js';
import { fixtures, field, U64_MAX } from '../fixtures.mjs';
import { deliveryHash, prepareExactOutput, recoverCapsule, requireDeliveryVector } from '../delivery/crypto.mjs';

const root = resolve(import.meta.dirname, '../../..');
const scratchCandidate = join(root, 'scratch');
mkdirSync(scratchCandidate, { recursive: true });
const scratchParent = realpathSync(scratchCandidate);
const scratchPath = join(scratchParent, 'pool-fees');
mkdirSync(scratchPath, { recursive: true });
const scratch = realpathSync(scratchPath);
if (!scratch.startsWith(scratchParent + sep)) throw new Error('unsafe fee scratch path');
const build = join(scratch, 'build');
if (!resolve(build).startsWith(scratch + sep)) throw new Error('unsafe fee build path');
rmSync(build, { recursive: true, force: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const encoded = program => Buffer.from(program.bytecode, 'base64');
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
const programs = Object.fromEntries(['v2-2x2', 'f3-2x2', 'f4-2x3', 'f4-2x4'].map(name => [name, json(join(build, `${name}.json`))]));
assert.equal(sha256(encoded(programs['v2-2x2'])), manifest.circuits.spend.bytecode,
  'fresh baseline differs from pinned spend bytecode');

const sequence = start => Uint8Array.from({ length: 32 }, (_, i) => (start + i) & 0xff);
const bytesFromLimbs = limbs => Buffer.concat(limbs.map(limb => {
  const out = Buffer.alloc(16);
  let value = BigInt(limb);
  for (let i = 15; i >= 0; i -= 1) { out[i] = Number(value & 0xffn); value >>= 8n; }
  assert.equal(value, 0n);
  return out;
}));
const limbsFromBytes = value => {
  assert.equal(value.length, 32);
  return [value.subarray(0, 16), value.subarray(16)].map(part => {
    let limb = 0n;
    for (const byte of part) limb = (limb << 8n) | BigInt(byte);
    return limb.toString();
  });
};
const openingOf = prepared => ({
  backing: limbsFromBytes(prepared.opening.backing),
  value: prepared.opening.value.toString(), owner: field(prepared.opening.owner), rho: field(prepared.opening.rho),
});
const digestLimbs = (domain, prepared) => limbsFromBytes(deliveryHash(domain,
  prepared.map(output => ({ cm: output.cm, capsule: output.capsule }))));

const options = Object.freeze({ verifierTarget: 'noir-recursive' });
const crsPath = join(scratchParent, 'private-payment-crs');
const api = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1, crsPath });
const checks = [];
const rejectionEvidence = [];
const proofMetrics = [];
try {
  const acir = program => gunzipSync(encoded(program));
  const circuitSizes = Object.fromEntries(await Promise.all(Object.entries(programs).map(async ([name, program]) =>
    [name, await api.acirGetCircuitSizes(acir(program), true, true)])));
  console.log('Circuit sizes [gates, subgroup]: ' + JSON.stringify(circuitSizes));
  const fixture = await fixtures(api);
  const domainBytes = bytesFromLimbs(fixture.domain);
  const backingBytes = Object.fromEntries(['a', 'b', 'foreign'].map(name => [name, bytesFromLimbs(fixture[name])]));
  const seeds = { sender: sequence(0x01), receiver: sequence(0x41), fee: sequence(0x81), other: sequence(0xc1) };
  let requestCounter = 1;
  const prepared = (seed, backing, value) => prepareExactOutput(seed, domainBytes, sequence(requestCounter++), backing, value);
  const asNote = output => ({ opening: openingOf(output), secret: field(output.secret) });

  async function witness(first, second, outputs, { positions = [0n, 1n], separateTrees = false } = {}) {
    assert(outputs.length >= 2);
    const notes = outputs.map(output => output.opening ? output : asNote(output));
    const result = await fixture.spend(first, second, notes[0], notes[1], positions, separateTrees);
    result.output_notes = notes.map(note => structuredClone(note.opening));
    result.outputs = await Promise.all(result.output_notes.map(note => fixture.cm(note)));
    return result;
  }
  async function preparedWitness(first, second, outputs, options = {}) {
    const result = await witness(first, second, outputs.map(asNote), options);
    for (let i = 0; i < outputs.length; i += 1) {
      assert.equal(field(outputs[i].cm), result.outputs[i], `host/backend commitment disagreement at output ${i}`);
    }
    result.delivery = digestLimbs(domainBytes, outputs);
    return result;
  }
  const withZeroDelivery = value => ({ ...value, delivery: ['0', '0'] });

  const inputA80 = await fixture.note(fixture.a, 80n);
  const inputB80 = await fixture.note(fixture.b, 80n);
  const paymentOutputs = [
    prepared(seeds.receiver, backingBytes.a, 73n),
    prepared(seeds.sender, backingBytes.a, 25n),
    prepared(seeds.fee, backingBytes.a, 2n),
  ];
  const payment = await preparedWitness(fixture.first, fixture.padding, paymentOutputs);
  assert.equal(recoverCapsule(seeds.fee, domainBytes, paymentOutputs[2].cm, paymentOutputs[2].capsule)?.secret, paymentOutputs[2].secret);
  assert.equal(recoverCapsule(seeds.sender, domainBytes, paymentOutputs[2].cm, paymentOutputs[2].capsule), null);
  assert.equal(recoverCapsule(seeds.receiver, domainBytes, paymentOutputs[2].cm, paymentOutputs[2].capsule), null);
  assert.deepEqual(Object.keys(payment).filter(key => key.includes('output_secret')), []);
  const paymentVector = paymentOutputs.map(output => ({ cm: output.cm, capsule: output.capsule }));
  const paymentDigest = deliveryHash(domainBytes, paymentVector);
  assert.deepEqual(payment.delivery, digestLimbs(domainBytes, paymentOutputs));
  assert.deepEqual(requireDeliveryVector(domainBytes, paymentVector, paymentDigest), paymentDigest);
  assert.throws(() => requireDeliveryVector(domainBytes, paymentVector.slice(0, -1), paymentDigest));
  const alteredPaymentVector = structuredClone(paymentVector);
  alteredPaymentVector[2].capsule[alteredPaymentVector[2].capsule.length - 1] ^= 1;
  assert.throws(() => requireDeliveryVector(domainBytes, alteredPaymentVector, paymentDigest));
  checks.push('73 payment + 25 change + 2 ordinary fee uses receiver-prepared outputs; host commitments equal backend fixture commitments; only the fee seed recovers the fee secret');
  checks.push('host F3 association requires the exact ordered three-output commitment/capsule vector; a missing or altered fee capsule rejects');

  const f3Outputs = [prepared(seeds.receiver, backingBytes.a, 73n), prepared(seeds.sender, backingBytes.a, 27n)];
  const f3 = await preparedWitness(fixture.first, fixture.padding, f3Outputs);
  const v2 = structuredClone(f3); delete v2.delivery;

  const fourOutputs = [
    prepared(seeds.receiver, backingBytes.a, 73n), prepared(seeds.sender, backingBytes.a, 27n),
    prepared(seeds.fee, backingBytes.b, 2n), prepared(seeds.sender, backingBytes.b, 8n),
  ];
  const inputB10 = await fixture.note(fixture.b, 10n);
  const four = await preparedWitness(fixture.first, inputB10, fourOutputs);
  assert.equal(recoverCapsule(seeds.fee, domainBytes, fourOutputs[2].cm, fourOutputs[2].capsule)?.secret, fourOutputs[2].secret);
  assert.equal(recoverCapsule(seeds.sender, domainBytes, fourOutputs[2].cm, fourOutputs[2].capsule), null);
  assert.equal(recoverCapsule(seeds.receiver, domainBytes, fourOutputs[2].cm, fourOutputs[2].capsule), null);
  checks.push('selected 2x4 fee output is recoverable only by the fee receiver seed; its backing-B change is payer-seed controlled');
  const fourVector = fourOutputs.map(output => ({ cm: output.cm, capsule: output.capsule }));
  const fourDigest = deliveryHash(domainBytes, fourVector);
  assert.deepEqual(requireDeliveryVector(domainBytes, fourVector, fourDigest), fourDigest);
  assert.throws(() => requireDeliveryVector(domainBytes, fourVector.slice(0, -1), fourDigest));
  const alteredFourVector = structuredClone(fourVector);
  alteredFourVector[3].capsule[1] ^= 1;
  assert.throws(() => requireDeliveryVector(domainBytes, alteredFourVector, fourDigest));
  checks.push('host F3 association requires the exact ordered four-output commitment/capsule vector; a missing or altered fourth capsule rejects');

  const noirs = Object.fromEntries(Object.entries(programs).map(([name, program]) => [name, new Noir(program)]));
  async function executes(name, input, label) {
    await noirs[name].execute(input);
    checks.push(label);
  }
  async function rejected(input, label, noir) {
    try { await noir.execute(input); } catch (error) {
      rejectionEvidence.push({ label, name: error?.constructor?.name ?? typeof error, message: String(error?.message ?? error) });
      return;
    }
    assert.fail(`${label} unexpectedly executed`);
  }
  async function recompute(input) {
    input.outputs = await Promise.all(input.output_notes.map(note => fixture.cm(note)));
    return input;
  }
  const validByArity = {};
  const widenedByArity = {};
  for (const outputCount of [3, 4]) {
    const name = `f4-2x${outputCount}`;
    const noir = noirs[name];
    const values = outputCount === 3 ? {
      zeroFee: [73n, 27n, 0n], zeroChange: [98n, 0n, 2n], twoReal: [100n, 78n, 2n],
      inflate: [73n, 25n, 3n], shave: [73n, 24n, 2n], widened: [U64_MAX - 1n, 1n, 1n],
      shift: [[fixture.a, 73n], [fixture.a, 26n], [fixture.b, 81n]],
    } : {
      zeroFee: [73n, 27n, 0n, 0n], zeroChange: [98n, 0n, 2n, 0n], twoReal: [100n, 70n, 8n, 2n],
      inflate: [73n, 20n, 5n, 3n], shave: [73n, 20n, 4n, 2n], widened: [U64_MAX - 2n, 1n, 1n, 1n],
      shift: [[fixture.a, 73n], [fixture.a, 26n], [fixture.b, 80n], [fixture.b, 1n]],
    };
    const zeroFeeOutputs = values.zeroFee.map((value, i) => prepared(i === 0 ? seeds.receiver : seeds.sender, backingBytes.a, value));
    const zeroFee = await preparedWitness(fixture.first, fixture.padding, zeroFeeOutputs);
    const zeroChangeOutputs = values.zeroChange.map((value, i) => prepared(i === 0 ? seeds.receiver : i === 2 ? seeds.fee : seeds.sender, backingBytes.a, value));
    const zeroChange = await preparedWitness(fixture.first, fixture.padding, zeroChangeOutputs);
    const twoReal = withZeroDelivery(await witness(fixture.first, inputA80,
      await Promise.all(values.twoReal.map(value => fixture.note(fixture.a, value)))));
    const crossNotes = outputCount === 3
      ? [[fixture.a, 98n], [fixture.b, 80n], [fixture.a, 2n]]
      : [[fixture.a, 73n], [fixture.a, 27n], [fixture.b, 2n], [fixture.b, 78n]];
    const cross = withZeroDelivery(await witness(fixture.first, inputB80,
      await Promise.all(crossNotes.map(([backing, value]) => fixture.note(backing, value)))));
    const maxInput = await fixture.note(fixture.a, U64_MAX);
    const oneInput = await fixture.note(fixture.a, 1n);
    const widened = withZeroDelivery(await witness(maxInput, oneInput,
      await Promise.all(values.widened.map(value => fixture.note(fixture.a, value)))));
    validByArity[outputCount] = { zeroFee, zeroChange, twoReal, cross };
    widenedByArity[outputCount] = widened;
    await executes(name, zeroFee, `${name}: valid zero fee uses payer-seed owned, distinct zero-value padding output`);
    await executes(name, zeroChange, `${name}: valid zero-change output`);
    await executes(name, twoReal, `${name}: valid two-positive-input same-backing spend`);
    await executes(name, cross, `${name}: valid two-backing conservation`);
    await executes(name, widened, `${name}: valid outgoing sum 2^64 uses u128 accumulator`);

    for (let index = 2; index < outputCount; index += 1) {
      const foreignZero = structuredClone(zeroFee);
      foreignZero.output_notes[index] = (await fixture.note(fixture.foreign, 0n)).opening;
      await rejected(await recompute(foreignZero), `${name}: zero-valued foreign added output ${index}`, noir);
    }
    for (const [label, hostileValues] of [['inflated', values.inflate], ['shaved', values.shave]]) {
      const outputs = await Promise.all(hostileValues.map(value => fixture.note(fixture.a, value)));
      await rejected(withZeroDelivery(await witness(fixture.first, fixture.padding, outputs)), `${name}: ${label} same-backing output total`, noir);
    }
    for (let index = 2; index < outputCount; index += 1) {
      const wrongAdded = structuredClone(zeroChange);
      wrongAdded.outputs[index] = field(BigInt(wrongAdded.outputs[index]) + 1n);
      await rejected(wrongAdded, `${name}: wrong added output ${index} commitment`, noir);
    }

    for (let left = 0; left < outputCount; left += 1) {
      for (let right = left + 1; right < outputCount; right += 1) {
        const outputNotes = await Promise.all(Array.from({ length: outputCount }, () => fixture.note(fixture.a, 0n)));
        const duplicate = await fixture.note(fixture.a, 50n);
        outputNotes[left] = duplicate; outputNotes[right] = duplicate;
        await rejected(withZeroDelivery(await witness(fixture.first, fixture.padding, outputNotes)),
          `${name}: duplicate output pair ${left},${right}`, noir);
      }
    }
    for (let index = 2; index < outputCount; index += 1) {
      for (const property of ['rho', 'owner']) {
        const bad = structuredClone(zeroChange);
        bad.output_notes[index][property] = field(0n);
        await rejected(await recompute(bad), `${name}: zero ${property} in added output ${index} with recomputed commitment`, noir);
      }
    }
    const shifted = withZeroDelivery(await witness(fixture.first, inputB80,
      await Promise.all(values.shift.map(([backing, value]) => fixture.note(backing, value)))));
    await rejected(shifted, `${name}: conserved grand total shifts one unit A to B`, noir);

    const bypassProgram = structuredClone(programs[name]);
    bypassProgram.abi.parameters.find(item => item.name === 'output_notes').type.type.fields
      .find(item => item.name === 'value').type = { kind: 'field' };
    const bypassNoir = new Noir(bypassProgram);
    await bypassNoir.execute(zeroChange);
    checks.push(`${name}: Field-ABI valid control executes over unchanged ACIR`);
    for (let index = 2; index < outputCount; index += 1) {
      const overflowOutputs = await Promise.all(Array.from({ length: outputCount }, (_, outputIndex) =>
        fixture.note(fixture.a, outputIndex === index ? 1n << 64n : 0n)));
      const overflow = withZeroDelivery(await witness(maxInput, oneInput, overflowOutputs));
      await rejected(overflow, `${name}: normal ABI rejects 2^64 in added output ${index} with valid inputs`, noir);
      await rejected(overflow, `${name}: Field ABI bypass rejects 2^64 in added output ${index} in unchanged ACIR`, bypassNoir);
    }
  }

  const deliveryBypassProgram = structuredClone(programs['f4-2x4']);
  deliveryBypassProgram.abi.parameters.find(item => item.name === 'delivery').type.type = { kind: 'field' };
  const deliveryBypassNoir = new Noir(deliveryBypassProgram);
  await deliveryBypassNoir.execute(four);
  checks.push('f4-2x4: Field-ABI delivery valid control executes over unchanged ACIR');
  for (const limb of [0, 1]) {
    const overflow = structuredClone(four); overflow.delivery[limb] = field(1n << 128n);
    await rejected(overflow, `f4-2x4: Field ABI bypass rejects 2^128 delivery limb ${limb} in unchanged ACIR`, deliveryBypassNoir);
  }

  const verifier = new UltraHonkVerifierBackend(api);
  async function prove(name, input, label, mutateIndices = []) {
    const noir = noirs[name];
    const backend = new UltraHonkBackend(programs[name].bytecode, api);
    const executeStart = performance.now();
    const { witness: solved } = await noir.execute(input);
    const executeMs = performance.now() - executeStart;
    const proveStart = performance.now();
    const proof = await backend.generateProof(solved, options);
    const proveMs = performance.now() - proveStart;
    const keyStart = performance.now();
    const verificationKey = await backend.getVerificationKey(options);
    const verificationKeyMs = performance.now() - keyStart;
    const verifyStart = performance.now();
    assert.equal(await verifier.verifyProof({ ...proof, verificationKey }, options), true);
    const verifyMs = performance.now() - verifyStart;
    const expected = [...input.domain, ...input.segment, input.scope, ...input.anchors, ...input.nullifiers,
      ...input.outputs, ...(input.delivery ?? [])].map(field);
    assert.deepEqual(proof.publicInputs.map(field), expected, `${label} public-input order`);
    for (const index of mutateIndices) {
      const changed = [...proof.publicInputs]; changed[index] = field(BigInt(changed[index]) + 1n);
      assert.equal(await verifier.verifyProof({ ...proof, publicInputs: changed, verificationKey }, options), false,
        `${label} public input ${index} is not proof-bound`);
    }
    proofMetrics.push({ name, label, executeMs, proveMs, verificationKeyMs, verifyMs,
      proofBytes: proof.proof.length, publicInputCount: proof.publicInputs.length,
      verificationKeySha256: sha256(verificationKey), mutatedPublicInputsRejected: mutateIndices });
    console.log(`${label}: ${proof.proof.length} proof bytes, ${proof.publicInputs.length} public inputs, proof verified`);
  }

  await prove('f4-2x4', four, 'F4 2x4 different-backing fee/change', [9, 10, 11, 12, 13, 14]);
  await prove('v2-2x2', v2, 'pinned v2 2x2 payment/change');
  await prove('f3-2x2', f3, 'F3 2x2 payment/change with delivery digest', [9, 10, 11, 12]);
  await prove('f4-2x3', payment, 'F4 2x3 payment/change/fee', [9, 10, 11, 12, 13]);
  await prove('f4-2x4', widenedByArity[4], 'F4 2x4 widened-sum boundary');

  const identities = {};
  for (const name of Object.keys(programs)) {
    identities[name] = {
      bytecodeSha256: sha256(encoded(programs[name])),
      generatedSourceSha256: sha256(readFileSync(join(scratch, `generated-${name}.nr`))),
      compressedBytecodeBytes: encoded(programs[name]).length,
    };
  }
  const f3Metric = proofMetrics.find(metric => metric.name === 'f3-2x2');
  const f4ThreeMetric = proofMetrics.find(metric => metric.label === 'F4 2x3 payment/change/fee');
  const f4FourMetric = proofMetrics.find(metric => metric.name === 'f4-2x4');
  const report = {
    recorded: new Date().toISOString(),
    candidate: 'generic two-input spend with 2, 3, or 4 ordinary outputs and F3 delivery digest',
    sourceOnly: true, referenceCommit: '17a9f1e', companionSpecCommit: '37cbd404dab1525f10c3e6815cc643c16269e6de',
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
      noirVersion: programs['f4-2x3'].noir_version, verifierTarget: options.verifierTarget,
      toolchain: Object.fromEntries(['@aztec/bb.js', '@noir-lang/noir_js', '@noir-lang/noir_wasm'].map(name => [name, packageVersion(name)])),
      threads: 1, crsPath: 'scratch/private-payment-crs' },
    publicInputOrders: {
      'v2-2x2': ['domainHi','domainLo','segmentHi','segmentLo','scope','anchor1','anchor2','nullifier1','nullifier2','output1','output2'],
      'f3-2x2': ['domainHi','domainLo','segmentHi','segmentLo','scope','anchor1','anchor2','nullifier1','nullifier2','output1','output2','deliveryHi','deliveryLo'],
      'f4-2x3': ['domainHi','domainLo','segmentHi','segmentLo','scope','anchor1','anchor2','nullifier1','nullifier2','output1','output2','output3','deliveryHi','deliveryLo'],
      'f4-2x4': ['domainHi','domainLo','segmentHi','segmentLo','scope','anchor1','anchor2','nullifier1','nullifier2','output1','output2','output3','output4','deliveryHi','deliveryLo'],
    },
    circuitSizes, compileMs, proofMetrics,
    comparison: {
      f3TwoIndependentSpendProofBytes: 2 * f3Metric.proofBytes,
      f3TwoIndependentSpendPublicInputs: 2 * f3Metric.publicInputCount,
      f4ThreeOutputProofBytes: f4ThreeMetric.proofBytes,
      f4FourOutputProofBytes: f4FourMetric.proofBytes,
      note: 'Two F3 statements can produce four outputs but are independently admitted/finalized; this probe does not make them atomic.',
    },
    checks, rejectionEvidence,
    structuralFinding: 'Each candidate exposes every ordered output commitment and one delivery digest in one proof public-input vector. Mutating every output or digest input rejects that proof. A caller can therefore admit all outputs with that one statement or reject it; this is circuit structure only, not a production v3 admission/finality demonstration.',
    feeFinding: 'There is no fee role, privileged owner, or special debit in either candidate. Output 3/4 traverse the same backing, commitment, distinctness, and per-backing conservation loops. A zero fee is an ordinary zero-value owned output. Three outputs fit same-backing payment/change/fee; four fit payment/change on A plus fee/change on B.',
    privacyFinding: 'A same-backing fee flow lets a fee recipient who recovers its capsule learn the payment backing. When both the payment input and fee input require change, 2x3 cannot carry payment, payment change, fee, and fee change; 2x4 can keep those flows on separate backings.',
    identities: { ...identities,
      compileScriptSha256: sha256(readFileSync(join(import.meta.dirname, 'compile.mjs'))),
      checkScriptSha256: sha256(readFileSync(import.meta.filename)),
      fixturesSha256: sha256(readFileSync(join(root, 'scripts/pool/fixtures.mjs'))),
      deliveryCryptoSha256: sha256(readFileSync(join(root, 'scripts/pool/delivery/crypto.mjs'))),
      notesSha256: sha256(readFileSync(join(root, 'src/pool/circuits/notes.nr'))),
      poseidon2Sha256: sha256(readFileSync(join(root, 'src/pool/circuits/vendor/poseidon2.nr'))) },
    limitations: [
      'Generated scratch candidates do not change production v2 configuration, keys, admission, retry, publication, or finality.',
      'The host cross-check covers F3 delivery framing and fixture-backend commitments; no authenticated complete history is demonstrated.',
      'Single desktop runs are comparative measurements, not phone or deployment acceptance.',
      'The two-statement F3 comparison has no atomic batching claim.',
    ],
  };
  writeFileSync(join(scratch, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await api.destroy();
}
