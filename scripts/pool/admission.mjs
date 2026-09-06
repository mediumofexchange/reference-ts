// Real proofs through the claim layer. The wallet side derives owners,
// commitments, nullifiers, note paths and scope paths with `dist/pool`'s host
// functions, proves with the pinned circuits, and a Segment admits, refuses,
// imports and replays with the Barretenberg verifier. If the host hash
// disagreed with the circuits', no wallet-built witness would prove; if
// admission read a frame differently from the specification, the obligor's
// signature would not verify; if the forest or the import were wrong, a
// note from the first segment could not be spent in the second, or the
// discarded tail could.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { makeBacking, signBacking } from '../../dist/backing.js';
import { directoryRoot, signCommitment } from '../../dist/commitment.js';
import { barretenbergPool, PROOF_OPTIONS } from '../../dist/pool/barretenberg.js';
import { fieldToHex, hexToField, limbsOf } from '../../dist/pool/field.js';
import { EMPTY_NOTE_ROOT, NoteTree, notePathProves } from '../../dist/pool/note-tree.js';
import { commitmentOf, nullifierOf, ownerOf } from '../../dist/pool/notes.js';
import { ScopeTree } from '../../dist/pool/scope.js';
import { Segment } from '../../dist/pool/segment.js';
import { poolReceiptAttestsEvidence, poolReceiptBytes, poolReceiptCovers, poolReceiptInHistory,
  signPoolReceipt, verifyPoolReceipt } from '../../dist/pool/receipt.js';
import { poseidon2Hash } from '../../dist/pool/poseidon2.js';
import { BURN, configurationHash, ISSUE, SPEND, statementBytes } from '../../dist/pool/statement.js';

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
  const successorSecret = new Uint8Array(32).fill(0x73), successor = ed25519.getPublicKey(successorSecret);
  const backerSecret = new Uint8Array(32).fill(0x71), otherSecret = new Uint8Array(32).fill(0x72);
  const configuration = { ...backend.identities, helper: Buffer.from(pins.sources['vendor/poseidon2.nr'], 'hex') };
  const domain = configurationHash(configuration);
  const venue = sha256(Buffer.from('moe/venue/pool-check'));
  // E names the original operator P; Q's later service reads authority from the record, not from E.
  const backing = makeBacking({ obligor: ed25519.getPublicKey(backerSecret), payout: { thing: 'EUR', quantumExponent: -2, perUnit: 100n },
    reliance: [], evidence: { setting: 'pool', operator, construction: 'moe/pool/v2', configuration: domain } });
  const signature = signBacking(backerSecret, backing);
  const header1 = { domain, venue, operator, sequence: 1n, entries: [{ backing: backing.name, link: backing.name }] };
  const s1 = new Segment(configuration, header1, [], backend.verifier);
  s1.register(backing, signature);
  const auth1 = s1.authority(), scope1 = new ScopeTree(header1.entries);

  // The wallet: notes with derived secrets, trees synced from each segment's leaves, scope paths from the public header.
  let seed = 1000n;
  function note(value) {
    const secret = ++seed, rho = ++seed;
    const opening = { backing: backing.name, value, owner: ownerOf(secret), rho };
    const cm = commitmentOf(domain, opening);
    return { opening, secret, cm, nf: nullifierOf(domain, cm, secret) };
  }
  const witnessNote = n => ({ backing: limbs(n.opening.backing), value: decimal(n.opening.value), owner: fieldToHex(n.opening.owner), rho: fieldToHex(n.opening.rho) });
  function synced(segment) {
    const tree = new NoteTree();
    for (const leaf of segment.leaves()) tree.append(leaf);
    assert.equal(tree.root(), segment.noteRoot(), 'the wallet rebuilds the segment root from its leaves');
    return tree;
  }
  const emptyPath = { siblings: Array(32).fill(fieldToHex(0n)), right: Array(32).fill(false) };
  const hexPath = path => ({ siblings: path.siblings.map(fieldToHex), right: [...path.right] });
  const scopeWitness = (scope, name) => {
    const entry = scope.entry(name), path = scope.pathFor(name);
    return { link: limbs(entry.link), scope_siblings: path.siblings.map(fieldToHex), scope_right: [...path.right] };
  };
  const common = auth => ({ domain: limbs(domain), segment: limbs(auth.segment), scope: fieldToHex(auth.scopeRoot) });
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
    if (kind === 'issue') s.obligorSignature = ed25519.sign(statementBytes(domain, ISSUE, publicInputs), backerSecret);
    return s;
  }
  /** A spend witness: each input against its own anchor and path, padding against any accepted root. */
  const spendWitness = (auth, scope, inputs, outputs) => ({
    ...common(auth),
    anchors: inputs.map(i => fieldToHex(i.anchor)),
    nullifiers: inputs.map(i => fieldToHex(i.note.nf)), outputs: outputs.map(o => fieldToHex(o.cm)),
    inputs: inputs.map(i => witnessNote(i.note)), secrets: inputs.map(i => fieldToHex(i.note.secret)),
    siblings: inputs.map(i => (i.path ? hexPath(i.path) : emptyPath).siblings), right: inputs.map(i => (i.path ? hexPath(i.path) : emptyPath).right),
    links: inputs.map(() => scopeWitness(scope, backing.name).link),
    scope_siblings: inputs.map(() => scopeWitness(scope, backing.name).scope_siblings),
    scope_right: inputs.map(() => scopeWitness(scope, backing.name).scope_right),
    output_notes: outputs.map(witnessNote),
  });
  async function refused(promise, code) {
    await assert.rejects(promise, error => error.name === 'PoolError' && error.code === code, code);
  }

  // Issue 100 to Alice under K's signature over the statement bytes, which name the domain, segment and scope.
  const alice = note(100n);
  const issue = await statement('issue', { ...common(auth1), backing: limbs(backing.name), quantity: '100',
    cm: fieldToHex(alice.cm), owner: fieldToHex(alice.opening.owner), rho: fieldToHex(alice.opening.rho), ...scopeWitness(scope1, backing.name) });
  assert.deepEqual(issue.publicInputs, [...limbsOf(domain), ...limbsOf(auth1.segment), auth1.scopeRoot, ...limbsOf(backing.name), 100n, alice.cm]);
  const wrongSigner = { ...issue, obligorSignature: ed25519.sign(statementBytes(domain, ISSUE, issue.publicInputs), otherSecret) };
  await refused(s1.admit(wrongSigner), 'SIGNATURE');
  const issued = await s1.admit(issue);
  const issueReceipt = signPoolReceipt(operatorSecret, auth1, issued, 0n);
  assert.equal(issued.position, 1n);
  assert.equal(s1.outstanding(backing.name), 100n);
  checks.push('a real issuance is admitted under K\'s signature and refused under another key');

  // Alice pays Bob 40 with change 60 from one real input and one padding input, against her own path.
  let tree = synced(s1);
  const padding = note(0n), bob = note(40n), change = note(60n);
  const alicePath = tree.path(0n);
  assert.ok(notePathProves(tree.root(), alice.cm, alicePath));
  const aliceSpend = anchor => spendWitness(auth1, scope1,
    [{ note: alice, anchor: anchor.root, path: anchor.path }, { note: padding, anchor: anchor.root }], [bob, change]);
  const spend = await statement('spend', aliceSpend({ root: tree.root(), path: alicePath }));
  const spent = await s1.admit(spend);
  const spendReceipt = signPoolReceipt(operatorSecret, auth1, spent, 0n);
  assert.equal(spent.position, 2n);
  assert.deepEqual(s1.leaves(), [alice.cm, bob.cm, change.cm]);
  checks.push('a wallet-built spend with a padding input is admitted');

  // The same statement, proven again: different proof bytes, one statement, the prior record.
  const again = await statement('spend', aliceSpend({ root: tree.root(), path: alicePath }));
  assert.notDeepEqual(again.proof, spend.proof);
  assert.deepEqual(await s1.admit(again), spent);
  assert.deepEqual(signPoolReceipt(operatorSecret, auth1, await s1.admit(again), spendReceipt.after), spendReceipt);
  assert.ok(poolReceiptCovers(auth1, again, spendReceipt));
  assert.equal(poolReceiptAttestsEvidence(auth1, again, spendReceipt), false);
  assert.equal(s1.length, 2n);
  checks.push('a re-proven resubmission returns the prior record without changing state');
  checks.push('a re-proven retry keeps the original receipt and its original evidence hash');

  // Respending under the newest anchor verifies as a proof and is refused as spent.
  tree = synced(s1);
  const respend = await statement('spend', aliceSpend({ root: tree.root(), path: tree.path(0n) }));
  assert.equal(await backend.verifier.verify(SPEND, respend.publicInputs, respend.proof), true);
  assert.equal(respend.publicInputs[7], spend.publicInputs[7]);
  await refused(s1.admit(respend), 'SPENT');
  // A membership proof under a root this segment never accepted is refused as an anchor.
  const forged = new NoteTree();
  forged.append(alice.cm); forged.append(bob.cm);
  const underForgedRoot = await statement('spend', aliceSpend({ root: forged.root(), path: forged.path(0n) }));
  assert.equal(await backend.verifier.verify(SPEND, underForgedRoot.publicInputs, underForgedRoot.proof), true);
  await refused(s1.admit(underForgedRoot), 'ANCHOR');
  checks.push('valid proofs are refused for a spent nullifier and for an unaccepted root');

  // Bob burns 30 of his 40, keeping 10; the burn names the backing and lowers outstanding.
  const padding2 = note(0n), rest = note(10n);
  const bobPath = tree.path(1n);
  const burn = await statement('burn', { ...common(auth1), backing: limbs(backing.name), quantity: '30',
    anchors: [fieldToHex(tree.root()), fieldToHex(tree.root())], nullifiers: [fieldToHex(bob.nf), fieldToHex(padding2.nf)], cm_change: fieldToHex(rest.cm),
    inputs: [witnessNote(bob), witnessNote(padding2)], secrets: [fieldToHex(bob.secret), fieldToHex(padding2.secret)],
    siblings: [hexPath(bobPath).siblings, emptyPath.siblings], right: [hexPath(bobPath).right, emptyPath.right], change: witnessNote(rest),
    ...scopeWitness(scope1, backing.name) });
  const burned = await s1.admit(burn);
  const burnReceipt = signPoolReceipt(operatorSecret, auth1, burned, 0n);
  assert.equal(burned.position, 3n);
  assert.equal(s1.outstanding(backing.name), 70n);
  assert.ok(s1.isSpent(bob.nf) && !s1.isSpent(change.nf) && !s1.isSpent(rest.nf));
  checks.push('a real burn lowers outstanding and spends its inputs');

  // A fourth statement, proven and not yet admitted: its evidence must be its
  // own. Corrupted bytes, another kind's proof, and a truncated proof of an
  // allowed length are each refused before any state is read.
  tree = synced(s1);
  const padding3 = note(0n), rest2 = note(5n);
  const restPath = tree.path(3n);
  const burn2 = await statement('burn', { ...common(auth1), backing: limbs(backing.name), quantity: '5',
    anchors: [fieldToHex(tree.root()), fieldToHex(tree.root())], nullifiers: [fieldToHex(rest.nf), fieldToHex(padding3.nf)], cm_change: fieldToHex(rest2.cm),
    inputs: [witnessNote(rest), witnessNote(padding3)], secrets: [fieldToHex(rest.secret), fieldToHex(padding3.secret)],
    siblings: [hexPath(restPath).siblings, emptyPath.siblings], right: [hexPath(restPath).right, emptyPath.right], change: witnessNote(rest2),
    ...scopeWitness(scope1, backing.name) });
  const corrupted = new Uint8Array(burn2.proof); corrupted[100] ^= 1;
  await refused(s1.admit({ ...burn2, proof: corrupted }), 'PROOF');
  await refused(s1.admit({ ...burn2, proof: spend.proof }), 'PROOF');
  await refused(s1.admit({ ...burn2, proof: burn2.proof.subarray(0, 32) }), 'PROOF');
  assert.equal(s1.length, 3n);
  // An accepted statement answers with its record whatever proof bytes accompany it (§8).
  const corruptedBurn = new Uint8Array(burn.proof); corruptedBurn[100] ^= 1;
  assert.deepEqual(await s1.admit({ ...burn, proof: corruptedBurn }), burned);
  assert.ok(poolReceiptCovers(auth1, { ...burn, proof: corruptedBurn }, burnReceipt));
  assert.equal(poolReceiptAttestsEvidence(auth1, { ...burn, proof: corruptedBurn }, burnReceipt), false);
  assert.equal(poolReceiptAttestsEvidence(auth1, wrongSigner, issueReceipt), false);
  checks.push('receipts distinguish corrupted proof and issuance-signature bytes from admitted evidence');
  assert.equal((await s1.admit(burn2)).position, 4n);
  assert.equal(s1.outstanding(backing.name), 65n);
  checks.push('corrupted, cross-kind and truncated proofs are refused for a new statement; an accepted one answers with its record');

  // A stranger replays the served trail with its own verifier and recomputes everything.
  const replayed = await Segment.replay(s1.trail(), (await barretenbergPool(api, programs)).verifier);
  assert.deepEqual(replayed.historyHash(), s1.historyHash());
  assert.equal(replayed.noteRoot(), s1.noteRoot());
  assert.deepEqual(replayed.spentRoot(), s1.spentRoot());
  assert.equal(replayed.outstanding(backing.name), 65n);
  assert.deepEqual(replayed.directory(), s1.directory());
  for (const [s, receipt] of [[issue, issueReceipt], [spend, spendReceipt], [burn, burnReceipt]]) {
    assert.ok(verifyPoolReceipt(auth1, receipt));
    assert.ok(poolReceiptAttestsEvidence(auth1, s, receipt));
    assert.ok(poolReceiptInHistory(replayed, receipt));
    assert.equal(poolReceiptBytes(receipt).length, 259);
    assert.equal(verifyPoolReceipt({ ...auth1, scopeRoot: auth1.scopeRoot + 1n }, receipt), false);
  }
  checks.push('signed issuance, spend and burn receipts verify against separately replayed real-proof history');
  const reprovenTrail = s1.trail(); reprovenTrail.statements[1] = again;
  const reprovenHistory = await Segment.replay(reprovenTrail, backend.verifier);
  assert.ok(poolReceiptInHistory(reprovenHistory, spendReceipt));
  checks.push('replay with a different valid proof preserves receipt history inclusion');
  const truncated = s1.trail();
  const prefix = await Segment.replay({ ...truncated, statements: truncated.statements.slice(0, 2) }, backend.verifier);
  assert.equal(prefix.outstanding(backing.name), 100n);
  assert.notDeepEqual(prefix.historyHash(), s1.historyHash());
  assert.ok(poolReceiptInHistory(prefix, spendReceipt));
  assert.equal(poolReceiptInHistory(prefix, burnReceipt), false);
  checks.push('a receipt beyond a replayed prefix is not proven by it');
  checks.push('a separate verifier replays the trail to the same history; a prefix proves only itself');

  // P commits the segment at length 4: the checkpoint every successor's opening names (§10).
  const directory1 = s1.directory();
  const commitment1 = signCommitment(operatorSecret, 1n, directoryRoot(directory1));
  const checkpoint1 = { commitment: commitment1, directory: directory1 };
  assert.deepEqual(s1.prefix(4n).directory, directory1);
  // P's unwitnessed tail: Alice spends her change after the checkpoint. It dies with the term (C2.10.9).
  tree = synced(s1);
  const tailPadding = note(0n), tailOut = note(60n), tailZero = note(0n);
  const tail = await statement('spend', spendWitness(auth1, scope1,
    [{ note: change, anchor: tree.root(), path: tree.path(2n) }, { note: tailPadding, anchor: tree.root() }], [tailOut, tailZero]));
  assert.equal((await s1.admit(tail)).position, 5n);
  const tailRoot = s1.noteRoot();

  // Q takes over the backing under a new link (the replacement itself is the record's, off-stage here) and opens
  // a segment whose opening is P's checkpoint; the original operator in E is not compared at registration.
  const link2 = sha256(Buffer.from('the replacement that seated Q'));
  const header2 = { domain, venue, operator: successor, sequence: 1n,
    entries: [{ backing: backing.name, link: link2, opening: { operator, sequence: 1n, root: commitment1.root } }] };
  const s2 = new Segment(configuration, header2, [s1.prefix(4n)], backend.verifier);
  s2.register(backing, signature);
  const auth2 = s2.authority(), scope2 = new ScopeTree(header2.entries);
  assert.notDeepEqual(auth2.segment, auth1.segment);
  assert.notEqual(auth2.scopeRoot, auth1.scopeRoot);
  assert.equal(s2.length, 0n);
  assert.equal(s2.noteRoot(), EMPTY_NOTE_ROOT);
  assert.equal(s2.outstanding(backing.name), 65n);
  assert.ok(s2.isSpent(alice.nf) && s2.isSpent(bob.nf) && s2.isSpent(rest.nf) && !s2.isSpent(change.nf));
  assert.ok(s2.isAnchor(tree.root()) && !s2.isAnchor(tailRoot));
  checks.push('a successor segment imports the checkpointed prefix: totals, spentness and certified roots, not the tail');

  // S1's statement is not S2's: its public inputs name the other segment, before any proof is read.
  await refused(s2.admit(spend), 'SEGMENT');
  // The tail's output cannot be spent in S2: its root was never certified.
  const s1Tail = synced(s1);
  const fromTail = await statement('spend', spendWitness(auth2, scope2,
    [{ note: tailOut, anchor: s1Tail.root(), path: s1Tail.path(5n) }, { note: note(0n), anchor: s1Tail.root() }], [note(60n), note(0n)]));
  assert.equal(await backend.verifier.verify(SPEND, fromTail.publicInputs, fromTail.proof), true);
  await refused(s2.admit(fromTail), 'ANCHOR');
  // A note spent in S1's finalized prefix stays spent in S2, under a real proof for S2 against S1's root.
  const respendInS2 = await statement('spend', spendWitness(auth2, scope2,
    [{ note: alice, anchor: tree.root(), path: tree.path(0n) }, { note: note(0n), anchor: tree.root() }], [note(100n), note(0n)]));
  await refused(s2.admit(respendInS2), 'SPENT');
  checks.push('in the successor segment, the other segment\'s statements, the discarded tail\'s root and imported spentness are refused');

  // Alice re-spends her change in S2 against S1's certified root: the tail's payment is re-proven, same nullifier.
  const carol = note(60n), zero = note(0n);
  const reproven = await statement('spend', spendWitness(auth2, scope2,
    [{ note: change, anchor: tree.root(), path: tree.path(2n) }, { note: tailPadding, anchor: tree.root() }], [carol, zero]));
  assert.equal(reproven.publicInputs[7], tail.publicInputs[7]);
  const carolAccepted = await s2.admit(reproven);
  assert.equal(carolAccepted.position, 1n);
  assert.deepEqual(s2.leaves(), [carol.cm, zero.cm]);
  checks.push('a payment from the discarded tail is re-proven in the successor segment with its nullifier unchanged');

  // Two inputs from two histories in one statement: Carol's note in S2's tree and Bob's rest in S1's.
  const s2Tree = synced(s2);
  const dave = note(65n), zero2 = note(0n);
  const mixed = await statement('spend', spendWitness(auth2, scope2,
    [{ note: carol, anchor: s2Tree.root(), path: s2Tree.path(0n) }, { note: rest2, anchor: tree.root(), path: tree.path(4n) }], [dave, zero2]));
  assert.notEqual(mixed.publicInputs[5], mixed.publicInputs[6]);
  const mixedAccepted = await s2.admit(mixed);
  assert.equal(mixedAccepted.position, 2n);
  assert.equal(s2.outstanding(backing.name), 65n);
  assert.ok(s2.isSpent(carol.nf) && s2.isSpent(rest2.nf));
  const mixedReceipt = signPoolReceipt(successorSecret, auth2, mixedAccepted, 1n);
  assert.ok(verifyPoolReceipt(auth2, mixedReceipt) && poolReceiptInHistory(s2, mixedReceipt));
  assert.equal(verifyPoolReceipt(auth1, mixedReceipt), false);
  assert.equal(verifyPoolReceipt(auth2, spendReceipt), false);
  checks.push('a spend takes inputs from two histories against two anchors; its receipt is the successor\'s alone');

  // A stranger replays S2 from its trail and the evidence for its opening: P's checkpoint and S1's trail.
  const evidence = [{ checkpoint: checkpoint1, trail: s1.trail(), length: 4n }];
  const s2Replayed = await Segment.replay(s2.trail(), (await barretenbergPool(api, programs)).verifier, evidence);
  assert.deepEqual(s2Replayed.historyHash(), s2.historyHash());
  assert.deepEqual(s2Replayed.directory(), s2.directory());
  assert.deepEqual(s2Replayed.spentRoot(), s2.spentRoot());
  assert.equal(s2Replayed.outstanding(backing.name), 65n);
  assert.ok(poolReceiptInHistory(s2Replayed, mixedReceipt));
  await refused(Segment.replay(s2.trail(), backend.verifier, []), 'IMPORT');
  await refused(Segment.replay(s2.trail(), backend.verifier, [{ ...evidence[0], length: 5n }]), 'IMPORT');
  const tampered = directory1.map(entry => ({ name: entry.name, digest: sha256(entry.digest) }));
  await refused(Segment.replay(s2.trail(), backend.verifier, [{ checkpoint: { commitment: signCommitment(operatorSecret, 1n, directoryRoot(tampered)), directory: tampered }, trail: s1.trail(), length: 4n }]), 'IMPORT');
  checks.push('a stranger replays the successor segment from the checkpoint evidence; missing, longer or tampered evidence is refused');
  await backend.close();
  return {
    domain: bytesToHex(domain), backing: bytesToHex(backing.name),
    segments: [bytesToHex(auth1.segment), bytesToHex(auth2.segment)],
    note: { value: decimal(alice.opening.value), owner: fieldToHex(alice.opening.owner), rho: fieldToHex(alice.opening.rho), secret: fieldToHex(alice.secret) },
    cm: fieldToHex(alice.cm), nf: fieldToHex(alice.nf), anchorAfterIssue: fieldToHex(issued.noteRoot),
  };
}
