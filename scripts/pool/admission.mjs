// Real proofs through the claim layer. The wallet side derives owners,
// commitments, nullifiers and paths with `dist/pool`'s host functions, proves
// with the pinned circuits, and the Pool admits, refuses and replays with the
// Barretenberg verifier. If the host hash disagreed with the circuits', no
// wallet-built witness would prove; if admission read a frame differently
// from the specification, the obligor's signature would not verify.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { makeBacking, signBacking } from '../../dist/backing.js';
import { barretenbergPool, PROOF_OPTIONS } from '../../dist/pool/barretenberg.js';
import { fieldToHex, hexToField, limbsOf } from '../../dist/pool/field.js';
import { NoteTree, notePathProves } from '../../dist/pool/note-tree.js';
import { commitmentOf, nullifierOf, ownerOf } from '../../dist/pool/notes.js';
import { Pool } from '../../dist/pool/pool.js';
import { poseidon2Hash } from '../../dist/pool/poseidon2.js';
import { BURN, configurationHash, ISSUE, poolIdentity, SPEND, statementBytes } from '../../dist/pool/statement.js';

const decimal = value => value.toString();
const limbs = identifier => limbsOf(identifier).map(decimal);

/** @param {{ api: any, circuits: Record<string, { program: any, noir: any, backend: any }>, pins: any, checks: string[], metrics: object[] }} args */
export async function checkAdmission({ api, circuits, pins, checks, metrics }) {
  const programs = { issue: circuits.issue.program, spend: circuits.spend.program, burn: circuits.burn.program };
  const backend = await barretenbergPool(api, programs);
  for (const kind of ['issue', 'spend', 'burn']) {
    assert.equal(bytesToHex(backend.identities[kind].bytecode), pins.circuits[kind].bytecode, `${kind} bytecode identity`);
    assert.equal(bytesToHex(backend.identities[kind].vk), pins.circuits[kind].vk, `${kind} verification-key identity`);
  }
  checks.push('the claim layer derives the pinned circuit identities');
  for (let n = 1; n <= 8; n++) {
    const inputs = Array.from({ length: n }, (_, i) => BigInt(i * 7919 + n * 104729));
    assert.equal(await backend.hash(inputs), poseidon2Hash(inputs), `host Poseidon2 over ${n} inputs`);
  }
  checks.push('host Poseidon2 agrees with the backend for one to eight inputs');

  const operatorSecret = new Uint8Array(32).fill(0x70), operator = ed25519.getPublicKey(operatorSecret);
  const backerSecret = new Uint8Array(32).fill(0x71), otherSecret = new Uint8Array(32).fill(0x72);
  const configuration = { pool: poolIdentity(operator, 0n), operator, ...backend.identities,
    helper: Buffer.from(pins.sources['vendor/poseidon2.nr'], 'hex') };
  const configHash = configurationHash(configuration);
  const backing = makeBacking({ obligor: ed25519.getPublicKey(backerSecret), payout: { thing: 'EUR', quantumExponent: -2, perUnit: 100n },
    reliance: [], evidence: { setting: 'pool', operator, construction: 'moe/pool/v1', configuration: configHash } });
  const pool = new Pool(configuration, backend.verifier);
  pool.register(backing, signBacking(backerSecret, backing));

  // The wallet: notes with derived secrets, and its own tree synced from the pool's leaves.
  let seed = 1000n;
  function note(value) {
    const secret = ++seed, rho = ++seed;
    const opening = { backing: backing.name, value, owner: ownerOf(secret), rho };
    const cm = commitmentOf(configuration.pool, opening);
    return { opening, secret, cm, nf: nullifierOf(configuration.pool, cm, secret) };
  }
  const witnessNote = n => ({ backing: limbs(n.opening.backing), value: decimal(n.opening.value), owner: fieldToHex(n.opening.owner), rho: fieldToHex(n.opening.rho) });
  function synced() {
    const tree = new NoteTree();
    for (const leaf of pool.leaves()) tree.append(leaf);
    assert.equal(tree.root(), pool.noteRoot(), 'the wallet rebuilds the pool root from its leaves');
    return tree;
  }
  const emptyPath = { siblings: Array(32).fill(fieldToHex(0n)), right: Array(32).fill(false) };
  const hexPath = path => ({ siblings: path.siblings.map(fieldToHex), right: [...path.right] });
  async function prove(kind, witness) {
    const start = performance.now();
    const { witness: compressed } = await circuits[kind].noir.execute(witness);
    const executionMs = performance.now() - start, beforeProof = performance.now();
    const proof = await circuits[kind].backend.generateProof(compressed, PROOF_OPTIONS);
    metrics.push({ label: `claim layer ${kind}`, kind, executionMs, proveMs: performance.now() - beforeProof, verifyMs: 0, proofBytes: proof.proof.length });
    return { publicInputs: proof.publicInputs.map(hexToField), proof: proof.proof };
  }
  const kindOf = { issue: ISSUE, spend: SPEND, burn: BURN };
  async function statement(kind, witness) {
    const { publicInputs, proof } = await prove(kind, witness);
    const s = { kind: kindOf[kind], publicInputs, proof };
    if (kind === 'issue') s.obligorSignature = ed25519.sign(statementBytes(configHash, ISSUE, publicInputs), backerSecret);
    return s;
  }
  async function refused(promise, code) {
    await assert.rejects(promise, error => error.name === 'PoolError' && error.code === code, code);
  }

  // Issue 100 to Alice under K's signature over the statement bytes.
  const alice = note(100n);
  const issue = await statement('issue', { pool: limbs(configuration.pool), backing: limbs(backing.name), quantity: '100',
    cm: fieldToHex(alice.cm), owner: fieldToHex(alice.opening.owner), rho: fieldToHex(alice.opening.rho) });
  assert.deepEqual(issue.publicInputs, [...limbsOf(configuration.pool), ...limbsOf(backing.name), 100n, alice.cm]);
  const wrongSigner = { ...issue, obligorSignature: ed25519.sign(statementBytes(configHash, ISSUE, issue.publicInputs), otherSecret) };
  await refused(pool.admit(wrongSigner), 'SIGNATURE');
  const issued = await pool.admit(issue);
  assert.equal(issued.sequence, 1n);
  assert.equal(pool.outstanding(backing.name), 100n);
  checks.push('a real issuance is admitted under K\'s signature and refused under another key');

  // Alice pays Bob 40 with change 60 from one real input and one padding input, against her own path.
  let tree = synced();
  const padding = note(0n), bob = note(40n), change = note(60n);
  const alicePath = tree.path(0n);
  assert.ok(notePathProves(tree.root(), alice.cm, alicePath));
  const spendWitness = anchor => ({ pool: limbs(configuration.pool), anchor: fieldToHex(anchor.root),
    nullifiers: [fieldToHex(alice.nf), fieldToHex(padding.nf)], outputs: [fieldToHex(bob.cm), fieldToHex(change.cm)],
    inputs: [witnessNote(alice), witnessNote(padding)], secrets: [fieldToHex(alice.secret), fieldToHex(padding.secret)],
    siblings: [hexPath(anchor.path).siblings, emptyPath.siblings], right: [hexPath(anchor.path).right, emptyPath.right],
    output_notes: [witnessNote(bob), witnessNote(change)] });
  const spend = await statement('spend', spendWitness({ root: tree.root(), path: alicePath }));
  const spent = await pool.admit(spend);
  assert.equal(spent.sequence, 2n);
  assert.deepEqual(pool.leaves(), [alice.cm, bob.cm, change.cm]);
  checks.push('a wallet-built spend with a padding input is admitted');

  // The same statement, proven again: different proof bytes, one statement, the prior record.
  const again = await statement('spend', spendWitness({ root: tree.root(), path: alicePath }));
  assert.notDeepEqual(again.proof, spend.proof);
  assert.deepEqual(await pool.admit(again), spent);
  assert.equal(pool.length, 2n);
  checks.push('a re-proven resubmission returns the prior record without changing state');

  // Respending under the newest anchor verifies as a proof and is refused as spent.
  tree = synced();
  const respend = await statement('spend', spendWitness({ root: tree.root(), path: tree.path(0n) }));
  assert.equal(await backend.verifier.verify(SPEND, respend.publicInputs, respend.proof), true);
  assert.equal(respend.publicInputs[3], spend.publicInputs[3]);
  await refused(pool.admit(respend), 'SPENT');
  // A membership proof under a root this pool never accepted is refused as an anchor.
  const forged = new NoteTree();
  forged.append(alice.cm); forged.append(bob.cm);
  const underForgedRoot = await statement('spend', spendWitness({ root: forged.root(), path: forged.path(0n) }));
  assert.equal(await backend.verifier.verify(SPEND, underForgedRoot.publicInputs, underForgedRoot.proof), true);
  await refused(pool.admit(underForgedRoot), 'ANCHOR');
  checks.push('valid proofs are refused for a spent nullifier and for an unaccepted root');

  // Bob burns 30 of his 40, keeping 10; the burn names the backing and lowers outstanding.
  const padding2 = note(0n), rest = note(10n);
  const bobPath = tree.path(1n);
  const burn = await statement('burn', { pool: limbs(configuration.pool), backing: limbs(backing.name), quantity: '30',
    anchor: fieldToHex(tree.root()), nullifiers: [fieldToHex(bob.nf), fieldToHex(padding2.nf)], cm_change: fieldToHex(rest.cm),
    inputs: [witnessNote(bob), witnessNote(padding2)], secrets: [fieldToHex(bob.secret), fieldToHex(padding2.secret)],
    siblings: [hexPath(bobPath).siblings, emptyPath.siblings], right: [hexPath(bobPath).right, emptyPath.right], change: witnessNote(rest) });
  const burned = await pool.admit(burn);
  assert.equal(burned.sequence, 3n);
  assert.equal(pool.outstanding(backing.name), 70n);
  assert.ok(pool.isSpent(bob.nf) && !pool.isSpent(change.nf) && !pool.isSpent(rest.nf));
  checks.push('a real burn lowers outstanding and spends its inputs');

  // A fourth statement, proven and not yet admitted: its evidence must be its
  // own. Corrupted bytes, another kind's proof, and a truncated proof of an
  // allowed length are each refused before any state is read.
  tree = synced();
  const padding3 = note(0n), rest2 = note(5n);
  const restPath = tree.path(3n);
  const burn2 = await statement('burn', { pool: limbs(configuration.pool), backing: limbs(backing.name), quantity: '5',
    anchor: fieldToHex(tree.root()), nullifiers: [fieldToHex(rest.nf), fieldToHex(padding3.nf)], cm_change: fieldToHex(rest2.cm),
    inputs: [witnessNote(rest), witnessNote(padding3)], secrets: [fieldToHex(rest.secret), fieldToHex(padding3.secret)],
    siblings: [hexPath(restPath).siblings, emptyPath.siblings], right: [hexPath(restPath).right, emptyPath.right], change: witnessNote(rest2) });
  const corrupted = new Uint8Array(burn2.proof); corrupted[100] ^= 1;
  await refused(pool.admit({ ...burn2, proof: corrupted }), 'PROOF');
  await refused(pool.admit({ ...burn2, proof: spend.proof }), 'PROOF');
  await refused(pool.admit({ ...burn2, proof: burn2.proof.subarray(0, 32) }), 'PROOF');
  assert.equal(pool.length, 3n);
  // An accepted statement answers with its record whatever proof bytes accompany it (§6).
  const corruptedBurn = new Uint8Array(burn.proof); corruptedBurn[100] ^= 1;
  assert.deepEqual(await pool.admit({ ...burn, proof: corruptedBurn }), burned);
  assert.equal((await pool.admit(burn2)).sequence, 4n);
  assert.equal(pool.outstanding(backing.name), 65n);
  checks.push('corrupted, cross-kind and truncated proofs are refused for a new statement; an accepted one answers with its record');

  // A stranger replays the served trail with its own verifier and recomputes everything.
  const replayed = await Pool.replay(pool.trail(), (await barretenbergPool(api, programs)).verifier);
  assert.deepEqual(replayed.historyHash(), pool.historyHash());
  assert.equal(replayed.noteRoot(), pool.noteRoot());
  assert.deepEqual(replayed.spentRoot(), pool.spentRoot());
  assert.equal(replayed.outstanding(backing.name), 65n);
  assert.deepEqual(replayed.directory(), pool.directory());
  const truncated = pool.trail();
  const prefix = await Pool.replay({ ...truncated, statements: truncated.statements.slice(0, 2) }, backend.verifier);
  assert.equal(prefix.outstanding(backing.name), 100n);
  assert.notDeepEqual(prefix.historyHash(), pool.historyHash());
  checks.push('a separate verifier replays the trail to the same history; a prefix proves only itself');
  await backend.close();
}
