// Compile the normative sources, exercise real constraints/proofs, and check pins.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Noir } from '@noir-lang/noir_js';
import { Barretenberg, BackendType, UltraHonkBackend, UltraHonkVerifierBackend } from '@aztec/bb.js';
import { fixtures, field, U64_MAX } from './fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = join(root, 'src/pool/circuits'), scratchPath = join(root, 'scratch');
mkdirSync(scratchPath, { recursive: true });
const scratch = realpathSync(scratchPath), directory = realpathSync(mkdtempSync(join(scratch, 'pool-v1-')));
// Share the existing parameter cache with the experiment; record its bytes below.
const crsPath = join(scratch, 'private-payment-crs');
const options = Object.freeze({ verifierTarget: 'noir-recursive' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const checks = [], metrics = [];
const expectedVersions = { '@aztec/bb.js': '5.2.0', '@noir-lang/noir_js': '1.0.0-beta.26', '@noir-lang/noir_wasm': '1.0.0-beta.26' };
const writePins = process.argv.slice(2).includes('--write-pins');
assert(process.argv.slice(2).every(arg => arg === '--write-pins'), 'unknown argument');
let api;
try {
  for (const [name, version] of Object.entries(expectedVersions)) {
    assert.equal(json(join(root, 'node_modules', name, 'package.json')).version, version, name);
  }
  const compileStart = performance.now();
  const compiled = await promisify(execFile)(process.execPath, [join(root, 'scripts/pool/compile.mjs'), directory],
    { cwd: root, windowsHide: true, timeout: 300_000, maxBuffer: 2_000_000 });
  process.stdout.write(compiled.stdout);
  const compileMs = performance.now() - compileStart;
  const pins = { construction: 'moe/pool/v1', toolchain: expectedVersions, verifierTarget: options.verifierTarget,
    sources: {}, circuits: {} };
  for (const name of ['notes.nr', 'issue.nr', 'spend.nr', 'burn.nr', 'vendor/poseidon2.nr']) {
    pins.sources[name] = sha(readFileSync(join(source, name)));
  }
  assert.equal(pins.sources['vendor/poseidon2.nr'], '44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8');
  api = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1, crsPath });
  const circuits = {};
  for (const kind of ['issue', 'spend', 'burn']) {
    const program = json(join(directory, kind + '.json'));
    assert(program.noir_version.startsWith('1.0.0-beta.26+'));
    const backend = new UltraHonkBackend(program.bytecode, api), vk = await backend.getVerificationKey(options);
    circuits[kind] = { program, backend, vk, noir: new Noir(program) };
    pins.circuits[kind] = { bytecode: sha(Buffer.from(program.bytecode, 'base64')), vk: sha(vk) };
  }
  if (!writePins) assert.deepEqual(pins, json(join(source, 'manifest.json')), 'circuit identities changed; review before repinning');
  console.log('PASS: compiler, helper and ZK verification-key identities.');
  const f = await fixtures(api), verifier = new UltraHonkVerifierBackend(api);
  async function accepts(label, kind, input, prove = false) {
    const start = performance.now();
    const { witness } = await circuits[kind].noir.execute(input);
    if (prove) {
      const executionMs = performance.now() - start, beforeProof = performance.now();
      const proof = await circuits[kind].backend.generateProof(witness, options);
      const proveMs = performance.now() - beforeProof, beforeVerify = performance.now();
      assert(proof.proof.length > 0 && proof.proof.length <= 131072 && proof.proof.length % 32 === 0);
      assert.equal(await verifier.verifyProof({ ...proof, verificationKey: circuits[kind].vk }, options), true, label);
      const expected = kind === 'issue' ? [...input.pool, ...input.backing, input.quantity, input.cm]
        : kind === 'spend' ? [...input.pool, input.anchor, ...input.nullifiers, ...input.outputs]
          : [...input.pool, ...input.backing, input.quantity, input.anchor, ...input.nullifiers, input.cm_change];
      assert.deepEqual(proof.publicInputs.map(field), expected.map(field), 'public-input order/count: ' + kind);
      metrics.push({ label, kind, executionMs, proveMs, verifyMs: performance.now() - beforeVerify, proofBytes: proof.proof.length });
      checks.push(label);
      return proof;
    }
    checks.push(label);
  }
  async function rejects(label, kind, base, mutate) {
    const input = structuredClone(base);
    await mutate(input);
    await assert.rejects(circuits[kind].noir.execute(input), undefined, label);
    checks.push(label);
  }
  const proofs = {};
  proofs.issue = await accepts('authorized-relation issuance', 'issue', f.issue, true);
  proofs.spend = await accepts('one real input plus padding', 'spend', f.padded, true);
  await accepts('two real inputs, same backing', 'spend', f.same, true);
  await accepts('two backings conserve separately', 'spend', f.cross, true);
  proofs.burn = await accepts('partial burn with padding', 'burn', f.burn, true);

  const refreshIssue = async v => { v.cm = await f.cm({ backing: v.backing, value: v.quantity, owner: v.owner, rho: v.rho }, v.pool); };
  for (const [label, mutate] of [
    ['issue zero quantity', async v => { v.quantity = '0'; await refreshIssue(v); }],
    ['issue quantity overflow', v => { v.quantity = (1n << 64n).toString(); }],
    ['issue wrong commitment', v => { v.cm = field(1); }],
    ['issue zero commitment', v => { v.cm = field(0); }],
    ['issue zero owner', async v => { v.owner = field(0); await refreshIssue(v); }],
    ['issue zero rho', async v => { v.rho = field(0); await refreshIssue(v); }],
    ['issue changed backing', v => { v.backing = f.b; }],
    ['issue pool limb overflow', v => { v.pool[0] = (1n << 128n).toString(); }],
    ['issue backing limb overflow', v => { v.backing[1] = (1n << 128n).toString(); }],
  ]) await rejects(label, 'issue', f.issue, mutate);

  for (const i of [0, 1]) {
    for (const [label, mutate] of [
      ['unauthorized input', v => { v.secrets[i] = field(999); }],
      ['zero secret', async v => {
        v.secrets[i] = field(0); v.inputs[i].owner = await f.hash([1001, 0]); await f.refresh(v);
        if (i === 0) {
          const t = await f.tree([[0n, await f.cm(v.inputs[0])]]), path = t.path(0n);
          v.anchor = t.root; v.siblings[0] = path.siblings; v.right[0] = path.right;
        }
      }],
      ['zero input rho', async v => { v.inputs[i].rho = field(0); await f.refresh(v); }],
      ['input value overflow', v => { v.inputs[i].value = (1n << 64n).toString(); }],
      ['input limb overflow', v => { v.inputs[i].backing[0] = (1n << 128n).toString(); }],
      ['wrong nullifier', v => { v.nullifiers[i] = field(1); }],
      ['zero nullifier', v => { v.nullifiers[i] = field(0); }],
      ['wrong output', v => { v.outputs[i] = field(1); }],
      ['zero output', v => { v.outputs[i] = field(0); }],
      ['zero output owner', async v => { v.output_notes[i].owner = field(0); await f.refresh(v); }],
      ['zero output rho', async v => { v.output_notes[i].rho = field(0); await f.refresh(v); }],
      ['output value overflow', v => { v.output_notes[i].value = (1n << 64n).toString(); }],
      ['foreign output backing', async v => { v.output_notes[i].backing = f.foreign; await f.refresh(v); }],
    ]) await rejects(`${label} slot ${i}`, 'spend', f.padded, mutate);
  }
  for (const [label, mutate] of [
    ['wrong low sibling', v => { v.siblings[0][0] = field(1); }],
    ['wrong high sibling', v => { v.siblings[0][31] = field(1); }],
    ['wrong path direction', v => { v.right[0][0] = !v.right[0][0]; }],
    ['wrong anchor', v => { v.anchor = field(1); }],
    ['padding from foreign backing', async v => { v.inputs[1].backing = f.b; await f.refresh(v); }],
    ['inflation with correct output hashes', async v => { v.output_notes[0].value = '41'; await f.refresh(v); }],
    ['both padding', async v => { v.inputs[0].value = '0'; v.output_notes.forEach(n => { n.value = '0'; }); await f.refresh(v); }],
    ['duplicate nullifiers with conserved value', async v => {
      v.inputs[1] = v.inputs[0]; v.secrets[1] = v.secrets[0]; v.siblings[1] = v.siblings[0]; v.right[1] = v.right[0];
      v.output_notes.forEach(n => { n.value = '100'; }); await f.refresh(v);
    }],
    ['duplicate outputs', async v => { v.output_notes[0].value = '50'; v.output_notes[1] = v.output_notes[0]; await f.refresh(v); }],
    ['changed pool with recomputed nullifiers and outputs', async v => { v.pool[0] = '18'; await f.refresh(v); }],
  ]) await rejects(label, 'spend', f.padded, mutate);
  await rejects('cross-backing inflation with unchanged global total', 'spend', f.cross, async v => {
    v.output_notes[0].value = '81'; v.output_notes[1].value = '99'; await f.refresh(v);
  });

  const arbitraryPadding = structuredClone(f.padded);
  arbitraryPadding.siblings[1].fill(field(123)); arbitraryPadding.right[1].fill(true);
  await accepts('padding needs no membership', 'spend', arbitraryPadding);
  const reversed = structuredClone(f.cross);
  for (const name of ['inputs', 'secrets', 'siblings', 'right', 'nullifiers', 'outputs', 'output_notes']) reversed[name].reverse();
  await accepts('both input and output orders', 'spend', reversed);
  const zeroFirst = await f.spend(f.first, f.padding, await f.note(f.a, 0n), await f.note(f.a, 100n));
  await accepts('first output may be zero', 'spend', zeroFirst);
  zeroFirst.outputs.reverse(); zeroFirst.output_notes.reverse();
  await accepts('second output may be zero', 'spend', zeroFirst);
  const highPath = await f.spend(f.first, f.padding, await f.note(f.a, 40n), await f.note(f.a, 60n), [(1n << 32n) - 1n, 0n]);
  await accepts('all right-child bits including bit 31', 'spend', highPath, true);
  await rejects('wrong high direction bit', 'spend', highPath, v => { v.right[0][31] = false; });
  const maxima = await f.spend(await f.note(f.a, U64_MAX), await f.note(f.a, U64_MAX),
    await f.note(f.a, U64_MAX), await f.note(f.a, U64_MAX));
  await accepts('two maximum u64 inputs conserve in u128', 'spend', maxima, true);
  await rejects('u64-wrapped conservation refused', 'spend', maxima, async v => {
    v.output_notes[0].value = (U64_MAX - 1n).toString(); v.output_notes[1].value = '0'; await f.refresh(v);
  });
  const latest = await f.tree([[0n, await f.cm(f.first.opening)], [1n, await f.cm((await f.note(f.b, 1n)).opening)]]);
  const later = structuredClone(f.padded), path = latest.path(0n);
  later.anchor = latest.root; later.siblings[0] = path.siblings; later.right[0] = path.right;
  const laterProof = await accepts('new anchor preserves both nullifiers', 'spend', later, true);
  assert.deepEqual(laterProof.publicInputs.slice(3, 5), proofs.spend.publicInputs.slice(3, 5));

  for (const [label, mutate] of [
    ['zero burn with conserved value', async v => { v.quantity = '0'; v.change.value = '100'; await f.refresh(v); }],
    ['excessive burn', v => { v.quantity = '101'; }],
    ['burn quantity overflow', v => { v.quantity = (1n << 64n).toString(); }],
    ['burn wrong public backing', v => { v.backing = f.b; }],
    ['burn foreign change', async v => { v.change.backing = f.b; await f.refresh(v); }],
    ['burn foreign padding', async v => { v.inputs[1].backing = f.b; await f.refresh(v); }],
    ['burn zero change rho', async v => { v.change.rho = field(0); await f.refresh(v); }],
    ['burn zero change owner', async v => { v.change.owner = field(0); await f.refresh(v); }],
    ['burn duplicate nullifiers with conserved value', async v => {
      v.inputs[1] = v.inputs[0]; v.secrets[1] = v.secrets[0]; v.siblings[1] = v.siblings[0]; v.right[1] = v.right[0];
      v.quantity = '100'; v.change.value = '100'; await f.refresh(v);
    }],
    ['burn bad membership', v => { v.siblings[0][31] = field(1); }],
  ]) await rejects(label, 'burn', f.burn, mutate);
  const fullBurn = structuredClone(f.burn);
  fullBurn.quantity = '100'; fullBurn.change.value = '0'; await f.refresh(fullBurn);
  await accepts('full burn with zero change', 'burn', fullBurn, true);
  const twoBurn = { ...structuredClone(f.burn), ...Object.fromEntries(['inputs', 'secrets', 'siblings', 'right', 'nullifiers', 'anchor'].map(k => [k, maxima[k]])) };
  twoBurn.quantity = U64_MAX.toString(); twoBurn.change.value = U64_MAX.toString(); await f.refresh(twoBurn);
  await accepts('burn widens quantity plus change', 'burn', twoBurn, true);

  for (const kind of ['issue', 'spend', 'burn']) {
    const proof = proofs[kind];
    for (let i = 0; i < proof.publicInputs.length; i++) {
      const publicInputs = [...proof.publicInputs]; publicInputs[i] = field(BigInt(publicInputs[i]) + 1n);
      assert.equal(await verifier.verifyProof({ ...proof, publicInputs, verificationKey: circuits[kind].vk }, options), false,
        `${kind} binds public input ${i}`);
      checks.push(`${kind} binds public input ${i}`);
    }
    const corrupt = new Uint8Array(proof.proof); corrupt[100] ^= 1;
    assert.equal(await verifier.verifyProof({ ...proof, proof: corrupt, verificationKey: circuits[kind].vk }, options), false);
    checks.push(`${kind} rejects corrupted proof`);
  }
  // Snapshot of cache files, not a claim about consumed prefixes or provenance.
  const parameterCache = {};
  for (const name of readdirSync(crsPath).filter(name => name.endsWith('.dat')).sort()) {
    const bytes = readFileSync(join(crsPath, name)); parameterCache[name] = { bytes: bytes.length, sha256: sha(bytes) };
  }
  const report = { construction: pins.construction, node: process.version, platform: process.platform, arch: process.arch,
    compileMs, pins, parameterCache, checks, metrics };
  // Pinning is explicit and happens only after every test succeeds.
  if (writePins) writeFileSync(join(source, 'manifest.json'), JSON.stringify(pins, null, 2) + '\n');
  writeFileSync(join(scratch, 'pool-v1-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`PASS: ${checks.length} circuit/proof checks; ${metrics.length} real ZK proofs. Report: scratch/pool-v1-results.json`);
} finally {
  if (api) await api.destroy();
  const target = realpathSync(directory);
  if (!target.startsWith(scratch + sep)) throw new Error('unsafe scratch cleanup');
  rmSync(target, { recursive: true, force: true });
}
