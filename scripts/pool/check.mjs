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
import { fixtures, field, FIELD, U64_MAX } from './fixtures.mjs';
import { asFields, bypass, inputRanges, refusal, withoutInputRanges } from './constraints.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = join(root, 'src/pool/circuits'), scratchPath = join(root, 'scratch');
mkdirSync(scratchPath, { recursive: true });
const scratch = realpathSync(scratchPath), directory = realpathSync(mkdtempSync(join(scratch, 'pool-v2-')));
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
  const pins = { construction: 'moe/pool/v2', toolchain: expectedVersions, verifierTarget: options.verifierTarget,
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
    // Hostile witnesses run on the same bytecode through a field-typed ABI, so
    // the constraints refuse them rather than noir_js's encoder.
    const widened = bypass(program);
    circuits[kind] = { program, backend, vk, noir: new Noir(program), widened, hostile: new Noir(widened),
      unranged: new Noir(withoutInputRanges(program)) };
    pins.circuits[kind] = { bytecode: sha(Buffer.from(program.bytecode, 'base64')), vk: sha(vk) };
  }
  if (!writePins) assert.deepEqual(pins, json(join(source, 'manifest.json')), 'circuit identities changed; review before repinning');
  console.log('PASS: compiler, helper and ZK verification-key identities.');
  // pool-v2 §1, §7: limbs below 2^128 and values below 2^64 are the circuit's
  // own constraints, as are direction bits, not the ABI encoder's.
  for (const kind of ['issue', 'spend', 'burn']) {
    const count = inputRanges(circuits[kind].program);
    checks.push(`${kind}: all ${count} integer and boolean inputs are range-checked in ACIR`);
  }
  const f = await fixtures(api), verifier = new UltraHonkVerifierBackend(api);
  const publicInputsOf = (kind, input) => kind === 'issue'
    ? [...input.domain, ...input.segment, input.scope, ...input.backing, input.quantity, input.cm]
    : kind === 'spend' ? [...input.domain, ...input.segment, input.scope, ...input.anchors, ...input.nullifiers, ...input.outputs]
      : [...input.domain, ...input.segment, input.scope, ...input.backing, input.quantity, ...input.anchors, ...input.nullifiers, input.cm_change];
  async function accepts(label, kind, input, prove = false) {
    const start = performance.now();
    const { witness } = await circuits[kind].noir.execute(input);
    if (prove) {
      const executionMs = performance.now() - start, beforeProof = performance.now();
      const proof = await circuits[kind].backend.generateProof(witness, options);
      const proveMs = performance.now() - beforeProof, beforeVerify = performance.now();
      assert(proof.proof.length > 0 && proof.proof.length <= 131072 && proof.proof.length % 32 === 0);
      assert.equal(await verifier.verifyProof({ ...proof, verificationKey: circuits[kind].vk }, options), true, label);
      assert.deepEqual(proof.publicInputs.map(field), publicInputsOf(kind, input).map(field), 'public-input order/count: ' + kind);
      assert.equal(proof.publicInputs.length, { issue: 9, spend: 11, burn: 13 }[kind]);
      metrics.push({ label, kind, executionMs, proveMs, verifyMs: performance.now() - beforeVerify, proofBytes: proof.proof.length });
      checks.push(label);
      return proof;
    }
    checks.push(label);
  }
  // Each hostile witness names the constraint it must fail: `range <input>` for an
  // input's range check, otherwise the source assertion's text (a prefix of it).
  const refused = [];
  async function rejects(label, kind, base, mutate, expected) {
    const input = structuredClone(base);
    await mutate(input);
    const actual = await circuits[kind].hostile.execute(asFields(input))
      .then(() => 'solved', error => refusal(circuits[kind].widened, error));
    refused.push({ label, expected, actual });
    checks.push(label);
    return input;
  }
  // A witness outside the declared types that satisfies every other constraint:
  // refused only by the input range check, and solved once those checks are removed.
  async function beyondTypes(label, kind, base, mutate, expected) {
    assert(expected.startsWith('range '));
    const input = await rejects(label, kind, base, mutate, expected);
    await circuits[kind].unranged.execute(asFields(input));
    checks.push(`${label}: solves without the input range checks`);
  }
  const R = {
    owner: 'notes.nr assert(note.owner == owner(secret))', secret: 'notes.nr assert(secret != 0)',
    ownerZero: 'notes.nr assert(note.owner != 0)', rho: 'notes.nr assert(note.rho != 0)',
    nullifier: 'notes.nr assert(nf == nullifier(domain, cm, secret))',
    anchor: 'notes.nr assert((note.value == 0) | (node == anchor))', scope: 'notes.nr assert(node == root)',
  };
  const proofs = {};
  proofs.issue = await accepts('authorized-relation issuance in scope', 'issue', f.issue, true);
  proofs.spend = await accepts('one real input plus padding', 'spend', f.padded, true);
  await accepts('two real inputs, same backing', 'spend', f.same, true);
  await accepts('two backings conserve separately', 'spend', f.cross, true);
  proofs.twoAnchors = await accepts('two inputs against two different anchors', 'spend', f.twoAnchors, true);
  assert.notEqual(proofs.twoAnchors.publicInputs[5], proofs.twoAnchors.publicInputs[6]);
  proofs.burn = await accepts('partial burn with padding', 'burn', f.burn, true);

  const refreshIssue = async v => { v.cm = await f.cm({ backing: v.backing, value: v.quantity, owner: v.owner, rho: v.rho }, v.domain); };
  const issueCommitment = 'main.nr assert(cm == notes::commitment(';
  for (const [label, mutate, expected] of [
    ['issue zero quantity', async v => { v.quantity = '0'; await refreshIssue(v); }, 'main.nr assert(quantity > 0)'],
    ['issue quantity overflow', v => { v.quantity = (1n << 64n).toString(); }, 'range quantity'],
    ['issue wrong commitment', v => { v.cm = field(1); }, issueCommitment],
    ['issue zero commitment', v => { v.cm = field(0); }, issueCommitment],
    ['issue zero owner', async v => { v.owner = field(0); await refreshIssue(v); }, R.ownerZero],
    ['issue zero rho', async v => { v.rho = field(0); await refreshIssue(v); }, R.rho],
    ['issue changed backing', v => { v.backing = f.b; }, issueCommitment],
    ['issue domain limb overflow', v => { v.domain[0] = (1n << 128n).toString(); }, 'range domain[0]'],
    ['issue segment limb overflow', v => { v.segment[1] = (1n << 128n).toString(); }, 'range segment[1]'],
    ['issue backing limb overflow', v => { v.backing[1] = (1n << 128n).toString(); }, 'range backing[1]'],
    ['issue link limb overflow', v => { v.link[0] = (1n << 128n).toString(); }, 'range link[0]'],
    ['issue backing outside the scope', async v => { v.backing = f.foreign; await refreshIssue(v); }, R.scope],
    ['issue wrong scope root', v => { v.scope = field(1); }, R.scope],
    ['issue wrong link', v => { v.link = f.linkB; }, R.scope],
    ['issue wrong scope sibling', v => { v.scope_siblings[0] = field(1); }, R.scope],
    ['issue wrong scope direction', v => { v.scope_right[0] = !v.scope_right[0]; }, R.scope],
    ['issue scope path of the other entry', v => { const p = f.scope.path(1n); v.scope_siblings = p.siblings; v.scope_right = p.right; }, R.scope],
  ]) await rejects(label, 'issue', f.issue, mutate, expected);

  const S = {
    padding: 'main.nr assert((inputs[i].value > 0) | (inputs[i].backing == inputs[1 - i].backing))',
    outputBacking: 'main.nr assert((output_notes[i].backing == inputs[0].backing) | (output_notes[i].backing == inputs[1].backing))',
    output: 'main.nr assert(outputs[i] == notes::commitment(domain, output_notes[i]))',
    nullifiers: 'main.nr assert(nullifiers[0] != nullifiers[1])', outputs: 'main.nr assert(outputs[0] != outputs[1])',
    positive: 'main.nr assert(inputs[0].value as u128 + inputs[1].value as u128 > 0)', conserve: 'main.nr assert(incoming == outgoing)',
  };
  for (const i of [0, 1]) {
    for (const [label, mutate, expected] of [
      ['unauthorized input', v => { v.secrets[i] = field(999); }, R.owner],
      ['zero secret', async v => {
        v.secrets[i] = field(0); v.inputs[i].owner = await f.hash([1001, 0]); await f.refresh(v);
        if (i === 0) {
          const t = await f.tree([[0n, await f.cm(v.inputs[0])]]), path = t.path(0n);
          v.anchors = [t.root, t.root]; v.siblings[0] = path.siblings; v.right[0] = path.right;
        }
      }, R.secret],
      ['zero input rho', async v => { v.inputs[i].rho = field(0); await f.refresh(v); }, R.rho],
      ['input value overflow', v => { v.inputs[i].value = (1n << 64n).toString(); }, `range inputs[${i}].value`],
      ['input limb overflow', v => { v.inputs[i].backing[0] = (1n << 128n).toString(); }, `range inputs[${i}].backing[0]`],
      ['wrong nullifier', v => { v.nullifiers[i] = field(1); }, R.nullifier],
      ['zero nullifier', v => { v.nullifiers[i] = field(0); }, R.nullifier],
      ['wrong output', v => { v.outputs[i] = field(1); }, S.output],
      ['zero output', v => { v.outputs[i] = field(0); }, S.output],
      ['zero output owner', async v => { v.output_notes[i].owner = field(0); await f.refresh(v); }, R.ownerZero],
      ['zero output rho', async v => { v.output_notes[i].rho = field(0); await f.refresh(v); }, R.rho],
      ['output value overflow', v => { v.output_notes[i].value = (1n << 64n).toString(); }, `range output_notes[${i}].value`],
      ['foreign output backing', async v => { v.output_notes[i].backing = f.foreign; await f.refresh(v); }, S.outputBacking],
      ['input wrong link', v => { v.links[i] = f.linkB; }, R.scope],
      ['input wrong scope sibling', v => { v.scope_siblings[i][15] = field(1); }, R.scope],
      ['input wrong scope direction', v => { v.scope_right[i][0] = !v.scope_right[i][0]; }, R.scope],
      ['input link limb overflow', v => { v.links[i][1] = (1n << 128n).toString(); }, `range links[${i}][1]`],
    ]) await rejects(`${label} slot ${i}`, 'spend', f.padded, mutate, expected);
  }
  for (const [label, mutate, expected] of [
    ['wrong low sibling', v => { v.siblings[0][0] = field(1); }, R.anchor],
    ['wrong high sibling', v => { v.siblings[0][31] = field(1); }, R.anchor],
    ['wrong path direction', v => { v.right[0][0] = !v.right[0][0]; }, R.anchor],
    ['wrong anchor', v => { v.anchors[0] = field(1); }, R.anchor],
    ['real input against the other slot\'s anchor only', async v => {
      // Move the real input's membership to a fresh tree but leave slot 0's anchor as the old root.
      const t = await f.tree([[5n, await f.cm(v.inputs[0])]]), path = t.path(5n);
      v.siblings[0] = path.siblings; v.right[0] = path.right; v.anchors[1] = t.root;
    }, R.anchor],
    ['wrong scope root', v => { v.scope = field(1); }, R.scope],
    // The other scoped backing, with its own valid link and scope path: only the padding rule refuses it.
    ['padding from another scoped backing', async v => {
      const p = f.scope.path(1n);
      v.inputs[1].backing = [...f.b]; v.links[1] = [...f.linkB]; v.scope_siblings[1] = p.siblings; v.scope_right[1] = p.right;
      await f.refresh(v);
    }, S.padding],
    ['both inputs outside the scope with recomputed hashes', async v => {
      v.inputs.forEach(n => { n.backing = [...f.foreign]; }); v.output_notes.forEach(n => { n.backing = [...f.foreign]; }); await f.refresh(v);
      const t = await f.tree([[0n, await f.cm(v.inputs[0])]]), path = t.path(0n);
      v.anchors = [t.root, t.root]; v.siblings[0] = path.siblings; v.right[0] = path.right;
    }, R.scope],
    ['inflation with correct output hashes', async v => { v.output_notes[0].value = '41'; await f.refresh(v); }, S.conserve],
    ['both padding', async v => { v.inputs[0].value = '0'; v.output_notes.forEach(n => { n.value = '0'; }); await f.refresh(v); }, S.positive],
    ['duplicate nullifiers with conserved value', async v => {
      v.inputs[1] = v.inputs[0]; v.secrets[1] = v.secrets[0]; v.siblings[1] = v.siblings[0]; v.right[1] = v.right[0];
      v.output_notes.forEach(n => { n.value = '100'; }); await f.refresh(v);
    }, S.nullifiers],
    ['duplicate outputs', async v => { v.output_notes[0].value = '50'; v.output_notes[1] = v.output_notes[0]; await f.refresh(v); }, S.outputs],
    ['changed domain with recomputed nullifiers and outputs', async v => { v.domain[0] = '18'; await f.refresh(v); }, R.anchor],
  ]) await rejects(label, 'spend', f.padded, mutate, expected);
  await rejects('cross-backing inflation with unchanged global total', 'spend', f.cross, async v => {
    v.output_notes[0].value = '81'; v.output_notes[1].value = '99'; await f.refresh(v);
  }, S.conserve);
  await rejects('second input under the first anchor when the trees differ', 'spend', f.twoAnchors, v => { v.anchors[1] = v.anchors[0]; }, R.anchor);

  const arbitraryPadding = structuredClone(f.padded);
  arbitraryPadding.siblings[1].fill(field(123)); arbitraryPadding.right[1].fill(true); arbitraryPadding.anchors[1] = field(77);
  await accepts('padding needs no membership and any anchor', 'spend', arbitraryPadding);
  const reversed = structuredClone(f.cross);
  for (const name of ['inputs', 'secrets', 'siblings', 'right', 'links', 'scope_siblings', 'scope_right', 'nullifiers', 'outputs', 'output_notes']) reversed[name].reverse();
  await accepts('both input and output orders', 'spend', reversed);
  const zeroFirst = await f.spend(f.first, f.padding, await f.note(f.a, 0n), await f.note(f.a, 100n));
  await accepts('first output may be zero', 'spend', zeroFirst);
  zeroFirst.outputs.reverse(); zeroFirst.output_notes.reverse();
  await accepts('second output may be zero', 'spend', zeroFirst);
  const highPath = await f.spend(f.first, f.padding, await f.note(f.a, 40n), await f.note(f.a, 60n), [(1n << 32n) - 1n, 0n]);
  await accepts('all right-child bits including bit 31', 'spend', highPath, true);
  await rejects('wrong high direction bit', 'spend', highPath, v => { v.right[0][31] = false; }, R.anchor);
  const maxima = await f.spend(await f.note(f.a, U64_MAX), await f.note(f.a, U64_MAX),
    await f.note(f.a, U64_MAX), await f.note(f.a, U64_MAX));
  await accepts('two maximum u64 inputs conserve in u128', 'spend', maxima, true);
  await rejects('u64-wrapped conservation refused', 'spend', maxima, async v => {
    v.output_notes[0].value = (U64_MAX - 1n).toString(); v.output_notes[1].value = '0'; await f.refresh(v);
  }, S.conserve);
  const latest = await f.tree([[0n, await f.cm(f.first.opening)], [1n, await f.cm((await f.note(f.b, 1n)).opening)]]);
  const later = structuredClone(f.padded), path = latest.path(0n);
  later.anchors = [latest.root, latest.root]; later.siblings[0] = path.siblings; later.right[0] = path.right;
  const laterProof = await accepts('new anchor preserves both nullifiers', 'spend', later, true);
  assert.deepEqual(laterProof.publicInputs.slice(7, 9), proofs.spend.publicInputs.slice(7, 9));
  const otherSegment = structuredClone(f.padded); otherSegment.segment = ['20', '24'];
  const otherSegmentProof = await accepts('another segment keeps the nullifiers and outputs', 'spend', otherSegment, true);
  assert.deepEqual(otherSegmentProof.publicInputs.slice(7), proofs.spend.publicInputs.slice(7));
  assert.notDeepEqual(otherSegmentProof.publicInputs.slice(2, 4), proofs.spend.publicInputs.slice(2, 4));

  const B = {
    inputBacking: 'main.nr assert(inputs[i].backing == backing)', changeBacking: 'main.nr assert(change.backing == backing)',
    conserve: 'main.nr assert(inputs[0].value as u128 + inputs[1].value as u128 == quantity as u128 + change.value as u128)',
  };
  for (const [label, mutate, expected] of [
    ['zero burn with conserved value', async v => { v.quantity = '0'; v.change.value = '100'; await f.refresh(v); }, 'main.nr assert(quantity > 0)'],
    ['excessive burn', v => { v.quantity = '101'; }, B.conserve],
    ['burn quantity overflow', v => { v.quantity = (1n << 64n).toString(); }, 'range quantity'],
    // The other scoped backing under its own valid link and path: the notes name the first.
    ['burn wrong public backing', v => {
      const p = f.scope.path(1n); v.backing = [...f.b]; v.link = [...f.linkB]; v.scope_siblings = p.siblings; v.scope_right = p.right;
    }, B.inputBacking],
    ['burn backing outside the scope', async v => {
      v.backing = [...f.foreign]; v.inputs.forEach(n => { n.backing = [...f.foreign]; }); v.change.backing = [...f.foreign]; await f.refresh(v);
      const t = await f.tree([[0n, await f.cm(v.inputs[0])]]), path = t.path(0n);
      v.anchors = [t.root, t.root]; v.siblings[0] = path.siblings; v.right[0] = path.right;
    }, R.scope],
    ['burn wrong link', v => { v.link = f.linkB; }, R.scope],
    ['burn wrong scope root', v => { v.scope = field(1); }, R.scope],
    ['burn foreign change', async v => { v.change.backing = f.b; await f.refresh(v); }, B.changeBacking],
    ['burn foreign padding', async v => { v.inputs[1].backing = f.b; await f.refresh(v); }, B.inputBacking],
    ['burn zero change rho', async v => { v.change.rho = field(0); await f.refresh(v); }, R.rho],
    ['burn zero change owner', async v => { v.change.owner = field(0); await f.refresh(v); }, R.ownerZero],
    ['burn duplicate nullifiers with conserved value', async v => {
      v.inputs[1] = v.inputs[0]; v.secrets[1] = v.secrets[0]; v.siblings[1] = v.siblings[0]; v.right[1] = v.right[0];
      v.quantity = '100'; v.change.value = '100'; await f.refresh(v);
    }, 'main.nr assert(nullifiers[0] != nullifiers[1])'],
    ['burn bad membership', v => { v.siblings[0][31] = field(1); }, R.anchor],
    ['burn wrong first anchor', v => { v.anchors[0] = field(1); }, R.anchor],
  ]) await rejects(label, 'burn', f.burn, mutate, expected);
  const fullBurn = structuredClone(f.burn);
  fullBurn.quantity = '100'; fullBurn.change.value = '0'; await f.refresh(fullBurn);
  await accepts('full burn with zero change', 'burn', fullBurn, true);
  const twoBurn = { ...structuredClone(f.burn), ...Object.fromEntries(['inputs', 'secrets', 'siblings', 'right', 'nullifiers', 'anchors'].map(k => [k, maxima[k]])) };
  twoBurn.quantity = U64_MAX.toString(); twoBurn.change.value = U64_MAX.toString(); await f.refresh(twoBurn);
  await accepts('burn widens quantity plus change', 'burn', twoBurn, true);

  // Witnesses outside the declared types that satisfy every other constraint: what a
  // prover that skips noir_js's encoder can build. Only the input range checks refuse them.
  for (const [kind, base] of [['issue', f.issue], ['spend', f.padded], ['burn', f.burn]]) {
    await circuits[kind].hostile.execute(asFields(base));
    await circuits[kind].unranged.execute(asFields(base));
    checks.push(`${kind}: the field-typed ABI and the range-stripped control solve the valid witness`);
  }
  const mod = x => ((x % FIELD) + FIELD) % FIELD;
  const inverse = x => { let r = 1n, b = mod(x); for (let e = FIELD - 2n; e > 0n; e >>= 1n, b = b * b % FIELD) if (e & 1n) r = r * b % FIELD; return r; };
  const H = async values => BigInt(await f.hash(values.map(value => mod(BigInt(value)))));
  // The root's two children on a valid path of `depth` levels under node tag `tag`.
  async function children(tag, depth, leaf, siblings, right) {
    let node = leaf;
    for (let l = 0; l < depth - 1; l++) {
      const s = BigInt(siblings[l]); node = right[l] ? await H([tag, l, s, node]) : await H([tag, l, node, s]);
    }
    const top = BigInt(siblings[depth - 1]);
    return right[depth - 1] ? [top, node] : [node, top];
  }
  // A direction d selects left = node + d·(sibling − node) and right = sibling − d·(sibling − node);
  // with sibling = A + B − node and d = (A − node)/(sibling − node) any node lands under children (A, B).
  const forge = (node, [A, B]) => {
    const sibling = mod(A + B - node);
    return { sibling: field(sibling), direction: field(mod((A - node) * inverse(sibling - node))) };
  };
  await beyondTypes('spend: an output of p - 900 wraps conservation and mints 900', 'spend', f.padded, async v => {
    v.output_notes[0].value = (FIELD - 900n).toString(); v.output_notes[1].value = '1000'; await f.refresh(v);
  }, 'range output_notes[0].value');
  await beyondTypes('spend: an input of 2^64 in the tree pays two outputs of 2^63', 'spend', f.padded, async v => {
    v.inputs[0].value = (1n << 64n).toString();
    const t = await f.tree([[0n, await f.cm(v.inputs[0])]]), path = t.path(0n);
    v.anchors = [t.root, t.root]; v.siblings[0] = path.siblings; v.right[0] = path.right;
    v.output_notes.forEach(n => { n.value = (1n << 63n).toString(); }); await f.refresh(v);
  }, 'range inputs[0].value');
  await beyondTypes('spend: a non-boolean direction puts an unminted note under a real anchor', 'spend', f.padded, async v => {
    const real = v.inputs[0], top = await children(1004, 32, BigInt(await f.cm(real)), v.siblings[0], v.right[0]);
    assert.equal(await H([1004, 31, ...top]), BigInt(v.anchors[0]));
    const fake = { backing: [...real.backing], value: '1000000', owner: await f.hash([1001, 777]), rho: field(778) };
    let node = BigInt(await f.cm(fake));
    for (let l = 0; l < 31; l++) node = await H([1004, l, node, 0]);
    const { sibling, direction } = forge(node, top);
    v.inputs[0] = fake; v.secrets[0] = field(777);
    v.siblings[0] = Array(32).fill(field(0)); v.siblings[0][31] = sibling;
    v.right[0] = Array(32).fill(false); v.right[0][31] = direction;
    v.output_notes[0].value = '400000'; v.output_notes[1].value = '600000'; await f.refresh(v);
  }, 'range right[0][31]');
  await beyondTypes('issue: a non-boolean scope direction puts a foreign backing in the scope', 'issue', f.issue, async v => {
    const top = await children(1006, 16, await H([1005, ...f.a, ...f.linkA]), v.scope_siblings, v.scope_right);
    assert.equal(await H([1006, 15, ...top]), BigInt(v.scope));
    let node = await H([1005, ...f.foreign, ...v.link]);
    for (let l = 0; l < 15; l++) node = await H([1006, l, node, 0]);
    const { sibling, direction } = forge(node, top);
    v.backing = [...f.foreign]; await refreshIssue(v);
    v.scope_siblings = Array(16).fill(field(0)); v.scope_siblings[15] = sibling;
    v.scope_right = Array(16).fill(false); v.scope_right[15] = direction;
  }, 'range scope_right[15]');
  await beyondTypes('issue: a quantity of 2^64 + 5 under its own commitment', 'issue', f.issue, async v => {
    v.quantity = ((1n << 64n) + 5n).toString(); await refreshIssue(v);
  }, 'range quantity');
  await beyondTypes('issue: a backing limb of 2^128 + 31 under a scope that holds it', 'issue', f.issue, async v => {
    v.backing = [((1n << 128n) + 31n).toString(), v.backing[1]]; await refreshIssue(v);
    let node = await H([1005, ...v.backing, ...v.link]), zero = 0n;
    v.scope_siblings = []; v.scope_right = Array(16).fill(false);
    for (let l = 0; l < 16; l++) {
      v.scope_siblings.push(field(zero)); node = await H([1006, l, node, zero]); zero = await H([1006, l, zero, zero]);
    }
    v.scope = field(node);
  }, 'range backing[0]');
  await beyondTypes('burn: a change of p - 50 wraps 100 = 150 + change', 'burn', f.burn, async v => {
    v.quantity = '150'; v.change.value = (FIELD - 50n).toString(); await f.refresh(v);
  }, 'range change.value');
  const named = ({ expected, actual }) => expected.startsWith('range ') ? actual === expected : actual.startsWith(expected);
  assert.deepEqual(refused.filter(r => !named(r)), [], 'each hostile witness fails the constraint it names');
  assert.equal(new Set(refused.map(r => r.label)).size, refused.length, 'hostile witness labels are distinct');

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
  // The claim layer's verifier over proofs bb.js throws on: an element past its modulus, a coordinate limb out of range,
  // a commitment off the curve and pairing points at infinity. Each verifies as false, and a run of them longer than the
  // one after which a reused instance fails every verification leaves a valid proof verifying.
  {
    const { barretenbergPool } = await import('../../dist/pool/barretenberg.js');
    const programs = { issue: circuits.issue.program, spend: circuits.spend.program, burn: circuits.burn.program };
    const valid = proofs.issue, inputs = valid.publicInputs.map(BigInt), vk = circuits.issue.vk;
    const word = (i, value) => { const p = new Uint8Array(valid.proof); p.set(Buffer.from(value.toString(16).padStart(64, '0'), 'hex'), i * 32); return p; };
    const malformed = [
      ['an element past its modulus', word(0, (1n << 256n) - 1n), 'Non-canonical proof element: value >= field modulus'],
      ['a low coordinate limb out of range', word(8, FIELD - 1n), 'Assertion failed: (uint256_t(fr_vec[0]) < (uint256_t(1) << (NUM_LIMB_BITS * 2)))'],
      ['a high coordinate limb out of range', word(9, FIELD - 1n), 'Assertion failed: (uint256_t(fr_vec[1]) < (uint256_t(1) << (TOTAL_BITS - NUM_LIMB_BITS * 2)))'],
      ['a commitment off the curve', word(8, 1n), 'Deserialized point is not on the curve'],
      ['pairing points at infinity', new Uint8Array(valid.proof.length), 'Cannot aggregate: incoming pairing points are at infinity'],
    ];
    const raw = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1, crsPath });
    try {
      const reused = new UltraHonkVerifierBackend(raw);
      const rawVerify = proof => reused.verifyProof({ proof, publicInputs: valid.publicInputs, verificationKey: vk }, options);
      for (const [, bytes, message] of malformed) await assert.rejects(rawVerify(bytes), error => error.message.startsWith(message));
      const offCurve = malformed[3][1];
      for (let i = 0; i < 96; i++) await rawVerify(offCurve).catch(() => {});
      await assert.rejects(rawVerify(valid.proof), /memory access out of bounds/, 'the control: a reused instance fails after the run');
    } finally { await raw.destroy(); }
    const pool = await barretenbergPool(api, programs, { crsPath });
    assert.equal(await pool.verifier.verify(1, inputs, valid.proof), true);
    for (const [label, bytes] of malformed) {
      assert.equal(await pool.verifier.verify(1, inputs, bytes), false, label);
      checks.push(`the verifier answers false for ${label}`);
    }
    for (let i = 0; i < 96; i++) assert.equal(await pool.verifier.verify(1, inputs, malformed[3][1]), false);
    assert.equal(await pool.verifier.verify(1, inputs, valid.proof), true);
    checks.push('the verifier never reuses an instance that threw: a valid proof verifies after 96 malformed ones');
    await pool.close();
    await assert.rejects(pool.verifier.verify(1, inputs, valid.proof), /the proof verifier is closed/);
    checks.push('a closed verifier refuses instead of calling a destroyed instance');
  }
  // The claim layer over these circuits, with real proofs, through dist/pool.
  const { checkAdmission } = await import("./admission.mjs");
  const claimLayer = await checkAdmission({ api, crsPath, circuits, pins, checks, metrics });
  console.log("PASS: real-proof admission, refusal, import and replay through the claim layer.");
  // Snapshot of cache files, not a claim about consumed prefixes or provenance.
  const parameterCache = {};
  for (const name of readdirSync(crsPath).filter(name => name.endsWith('.dat')).sort()) {
    const bytes = readFileSync(join(crsPath, name)); parameterCache[name] = { bytes: bytes.length, sha256: sha(bytes) };
  }
  // The repository sources the verdict executes: this check's import graph (dist
  // modules with the src they were built from), the compile step, the circuits and
  // their manifest; packages are bound by the lockfile.
  const { sourceClosure, sourceHashes } = await import('./v3/provenance.mjs');
  const sources = sourceClosure(['scripts/pool/check.mjs', 'scripts/pool/compile.mjs', 'scripts/pool/prepare-crs.mjs',
    ...['notes', 'issue', 'spend', 'burn'].map(name => `src/pool/circuits/${name}.nr`), 'src/pool/circuits/vendor/poseidon2.nr',
    'src/pool/circuits/manifest.json', 'package-lock.json']);
  const report = { construction: pins.construction, node: process.version, platform: process.platform, arch: process.arch,
    compileMs, pins, parameterCache, checks, metrics, claimLayer,
    refusals: Object.fromEntries(refused.map(({ label, actual }) => [label, actual])), sourceSha256Lf: sourceHashes(sources) };
  // Pinning is explicit and happens only after every test succeeds.
  if (writePins) writeFileSync(join(source, 'manifest.json'), JSON.stringify(pins, null, 2) + '\n');
  writeFileSync(join(scratch, 'pool-v2-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`PASS: ${checks.length} circuit/proof checks; ${metrics.length} real ZK proofs. Report: scratch/pool-v2-results.json`);
} finally {
  if (api) await api.destroy();
  const target = realpathSync(directory);
  if (!target.startsWith(scratch + sep)) throw new Error('unsafe scratch cleanup');
  rmSync(target, { recursive: true, force: true });
}
