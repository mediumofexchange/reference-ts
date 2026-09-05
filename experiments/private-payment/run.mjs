import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync, readdirSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { cpus, totalmem } from 'node:os';
import { ed25519 } from '@noble/curves/ed25519.js';
import { makeBacking, encodeBacking, signBacking } from '../../dist/backing.js';
import { ProofSystem, NoteTree, field, randomField, limbs, sha, canonical, OPTIONS } from './proofs.mjs';
import { Journal } from './journal.mjs';
import { configIdentity, statementBytes, replay, submit, checkReceived } from './host.mjs';

const exec = promisify(execFile), root = dirname(fileURLToPath(import.meta.url));
const scratchCandidate = resolve(root, '../../scratch');
mkdirSync(scratchCandidate, { recursive: true });
const scratch = realpathSync(scratchCandidate);
const directory = realpathSync(mkdtempSync(join(scratch, 'private-payment-run-')));
const artifacts = join(directory, 'build'), crs = join(scratch, 'private-payment-crs');
const crsCachePresentAtStart = existsSync(crs);
const copy = value => JSON.parse(canonical(value));
const handles = [], checks = [];
function save(file, value) {
  const fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, canonical(value)); fsyncSync(fd); } finally { closeSync(fd); }
}
async function child(script, args) {
  return exec(process.execPath, [join(root, script), ...args], { cwd: root, windowsHide: true, timeout: 300_000, maxBuffer: 2_000_000 });
}
let system;
try {
  const compileStart = performance.now();
  await child('compile.mjs', [artifacts]);
  const compileMs = performance.now() - compileStart;
  system = await ProofSystem.open(artifacts, crs);
  console.log('PASS: real circuits compiled, ZK verification keys derived locally.');
  const secretIssuer = randomBytes(32), issuer = ed25519.getPublicKey(secretIssuer);
  const operator = ed25519.getPublicKey(randomBytes(32));
  const backing = thing => makeBacking({ obligor: issuer, payout: { thing, quantumExponent: 0, perUnit: 1n },
    reliance: [], evidence: { setting: 'transparent', operator } });
  const a = backing('research-A'), b = backing('research-B');
  const bundle = backing => ({ terms: Buffer.from(encodeBacking(backing)).toString('hex'),
    signature: Buffer.from(signBacking(secretIssuer, backing)).toString('hex') });
  const pool = limbs(randomBytes(32).toString('hex'));
  const config = { pool, circuits: system.pins, assets: { [a.nameHex]: bundle(a), [b.nameHex]: bundle(b) } };
  const identity = configIdentity(config), db = join(directory, 'operator.sqlite');
  function open(hook) { const journal = new Journal(db, identity, hook); handles.push(journal); return journal; }
  let journal = open();
  const issuedNotes = [];
  async function note(asset, value) {
    const secret = randomField();
    const opening = { asset: limbs(asset), value: String(value), owner: await system.owner(secret), rho: randomField() };
    const cm = await system.commitment(pool, opening);
    return { opening, secret, cm };
  }
  async function issue(asset, value, id) {
    const received = await note(asset, value); issuedNotes.push(received);
    const inputs = { pool, asset: received.opening.asset, quantity: String(value), output: received.cm,
      recipient: received.opening.owner, rho: received.opening.rho };
    const command = await system.prove('issue', inputs);
    command.issuerSignature = Buffer.from(ed25519.sign(statementBytes(config, command), secretIssuer)).toString('hex');
    save(join(directory, id + '.json'), command);
    await submit(journal, system, config, id, command);
    return { ...received, inputs, command };
  }
  const alice = await issue(a.nameHex, 100, 'issue-A');
  const otherAsset = await issue(b.nameHex, 80, 'issue-B');
  checks.push('two authorized issuances under distinct 256-bit backing IDs');
  const bob = await note(a.nameHex, 40), change = await note(a.nameHex, 60);
  const before = await replay(system, config, journal.snapshot().events);
  const input = { pool, anchor: before.tree.root(), nf: await system.nullifier(pool, alice.cm, alice.secret),
    outputs: [bob.cm, change.cm], input: alice.opening, secret: alice.secret,
    ...before.tree.path(alice.cm), payment: bob.opening, change: change.opening };
  const payment = await system.prove('spend', input);
  assert.deepEqual(payment.publicInputs, [...pool.map(field), input.anchor, input.nf, bob.cm, change.cm]);
  save(join(directory, 'saved-payment.json'), payment);

  async function rejectsWitness(label, kind, original, alter) {
    const invalid = copy(original); alter(invalid);
    await assert.rejects(system.execute(kind, invalid)); checks.push(label);
  }
  await rejectsWitness('unauthorized input owner', 'spend', input, v => { v.secret = randomField(); });
  await rejectsWitness('wrong Merkle path', 'spend', input, v => { v.siblings[0] = field(1); });
  await rejectsWitness('altered nullifier', 'spend', input, v => { v.nf = field(1); });
  await rejectsWitness('cross-asset substitution', 'spend', input, v => { v.payment.asset = otherAsset.opening.asset; });
  await rejectsWitness('inflation through changed payment', 'spend', input, v => { v.payment.value = '41'; });
  await rejectsWitness('u64 overflow', 'spend', input, v => { v.payment.value = (1n << 64n).toString(); });
  await rejectsWitness('u128 asset alias', 'spend', input, v => { v.input.asset[0] = (1n << 128n).toString(); });
  await rejectsWitness('zero payment', 'spend', input, v => { v.payment.value = '0'; });
  await rejectsWitness('altered receiver commitment', 'spend', input, v => { v.outputs[0] = field(1); });
  await rejectsWitness('issuance quantity does not open output', 'issue', alice.inputs, v => { v.quantity = '101'; });
  await rejectsWitness('issuance asset does not open output', 'issue', alice.inputs, v => { v.asset = otherAsset.opening.asset; });
  for (const [label, alter] of [
    ['public root tampering', c => { c.publicInputs[2] = field(1); }],
    ['wrong pool', c => { c.publicInputs[0] = field(1); }],
    ['extra public input', c => { c.publicInputs.push(field(0)); }],
    ['missing public input', c => { c.publicInputs.pop(); }],
    ['noncanonical field alias', c => { c.publicInputs[0] = '0x' + 'f'.repeat(64); }],
    ['trailing proof bytes', c => { c.proof = Buffer.concat([Buffer.from(c.proof, 'base64'), Buffer.alloc(32)]).toString('base64'); }],
    ['corrupted proof', c => { const bytes = Buffer.from(c.proof, 'base64'); bytes[100] ^= 1; c.proof = bytes.toString('base64'); }],
    ['wrong pinned circuit', c => { c.kind = 'issue'; }],
  ]) {
    const invalid = copy(payment); alter(invalid);
    assert.equal(await system.verify(invalid), false, label); checks.push(label);
  }
  const unauthorized = copy(alice.command); unauthorized.issuerSignature = '00'.repeat(64);
  await assert.rejects(submit(journal, system, config, 'unauthorized', unauthorized), /unauthorized/);
  assert.equal(journal.snapshot().sequence, 2n); checks.push('rejected authorization/proofs leave journal unchanged');
  console.log('PASS: witness constraints, public input binding, proof corruption and issuer authority.');

  // Membership alone does not establish that a root came from accepted history.
  const forgedTree = await NoteTree.create(system, [alice.cm, bob.cm]);
  assert.equal(before.anchors.has(forgedTree.root()), false);
  const forgedRootPayment = await system.prove('spend', {
    ...input, anchor: forgedTree.root(), ...forgedTree.path(alice.cm),
  });
  assert.equal(await system.verify(forgedRootPayment), true);
  await assert.rejects(submit(journal, system, config, 'unaccepted-root', forgedRootPayment), /unknown anchor/);
  assert.equal(journal.snapshot().sequence, 2n);
  checks.push('valid membership proof under an unaccepted root is rejected');

  // Reissuing one commitment must not create two notes with the same nullifier.
  assert.equal(await system.verify(alice.command), true);
  await assert.rejects(submit(journal, system, config, 'duplicate-issue', alice.command), /duplicate output/);
  assert.equal(journal.snapshot().sequence, 2n);
  checks.push('valid authorized issuance cannot duplicate an existing commitment');

  // Two valid histories can create identical leaves but spend different inputs.
  // Keep this fork fixture separate from the operator scenario's accepted events.
  const twin = await note(a.nameHex, 100);
  const twinIssue = await system.prove('issue', { pool, asset: twin.opening.asset, quantity: '100',
    output: twin.cm, recipient: twin.opening.owner, rho: twin.opening.rho });
  twinIssue.issuerSignature = Buffer.from(ed25519.sign(statementBytes(config, twinIssue), secretIssuer)).toString('hex');
  const forkBase = await replay(system, config, journal.snapshot().events);
  const twinResponse = await forkBase.apply(twinIssue);
  const forkEvents = [...journal.snapshot().events, { id: 'twin-issue', command: twinIssue, response: twinResponse }];
  const twinSpend = await system.prove('spend', { ...input, input: twin.opening, secret: twin.secret,
    nf: await system.nullifier(pool, twin.cm, twin.secret), anchor: forkBase.tree.root(), ...forkBase.tree.path(twin.cm) });
  const forkLeft = await replay(system, config, forkEvents), forkRight = await replay(system, config, forkEvents);
  await forkLeft.apply(payment);
  const forkRightResponse = await forkRight.apply(twinSpend);
  assert.equal(forkLeft.tree.root(), forkRight.tree.root()); assert.equal(forkLeft.count, forkRight.count);
  assert.notDeepEqual(forkLeft.spent, forkRight.spent);
  assert.notEqual(forkLeft.historyHash, forkRight.historyHash);
  const forkFile = join(directory, 'public-fork.json');
  save(forkFile, { config, events: [...forkEvents, { id: 'twin-payment', command: twinSpend, response: forkRightResponse }] });
  checks.push('valid histories with identical note roots bind different spent sets in history hashes');

  // Two independent handles finish proof work against the same note. Exactly one wins.
  const rival = open();
  const outcomes = await Promise.allSettled([
    submit(journal, system, config, 'payment', payment),
    submit(rival, system, config, 'payment-rival', payment),
  ]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const winningId = outcomes[0].status === 'fulfilled' ? 'payment' : 'payment-rival';
  const receipt = journal.lookup(winningId).response;
  journal.close(); journal = open();
  assert.deepEqual(await submit(journal, system, config, winningId, JSON.parse(readFileSync(join(directory, 'saved-payment.json'), 'utf8'))), receipt);
  const received = await checkReceived(system, config, journal.snapshot().events, bob.opening, bob.secret);
  assert.equal(received.commitment, bob.cm);
  const receiverJournal = new Journal(join(directory, 'receiver.sqlite'), identity); handles.push(receiverJournal);
  assert.equal(receiverJournal.append(0n, bob.cm, { invoice: 'invoice-1', cm: bob.cm }, { accepted: true }), true);
  assert.equal(receiverJournal.append(0n, bob.cm, { invoice: 'invoice-1', cm: bob.cm }, { accepted: true }), true);
  assert.equal(receiverJournal.snapshot().sequence, 1n);
  assert.throws(() => receiverJournal.append(1n, bob.cm, { invoice: 'invoice-2', cm: bob.cm }, { accepted: true }), /conflict/);
  checks.push('concurrent double spend rejected', 'saved proof retry after restart', 'receiver verifies opening and records one invoice acceptance');

  // A changed accepted anchor must not change the nullifier for the same input.
  const after = await replay(system, config, journal.snapshot().events);
  const respentInput = { ...input, anchor: after.tree.root(), ...after.tree.path(alice.cm) };
  const respent = await system.prove('spend', respentInput);
  assert.equal(respent.publicInputs[3], payment.publicInputs[3]);
  assert.equal(await system.verify(respent), true);
  await assert.rejects(submit(journal, system, config, 'respend-new-anchor', respent), /spent nullifier/);
  checks.push('valid proof cannot respend note under newer accepted anchor');

  // Redemption is a private transfer to the issuer; burning is a separate act.
  const redeemed = await note(a.nameHex, 40), dummy = await note(a.nameHex, 0);
  const redemptionInput = { pool, anchor: after.tree.root(), nf: await system.nullifier(pool, bob.cm, bob.secret),
    outputs: [redeemed.cm, dummy.cm], input: bob.opening, secret: bob.secret,
    ...after.tree.path(bob.cm), payment: redeemed.opening, change: dummy.opening };
  await rejectsWitness('payer cannot spend receiver-generated secret', 'spend', redemptionInput, v => { v.secret = alice.secret; });
  const redemption = await system.prove('spend', redemptionInput);
  const beforeCrash = journal.snapshot(), prepared = await replay(system, config, beforeCrash.events);
  const redemptionResponse = await prepared.apply(redemption);
  for (const phase of ['stored', 'committed']) {
    const file = join(directory, 'crash-' + phase + '.json');
    save(file, { identity, sequence: beforeCrash.sequence.toString(), id: 'redemption', command: redemption, response: redemptionResponse, phase });
    await assert.rejects(child('crash.mjs', [db, file]), error => error.code === 73);
    assert.equal(journal.snapshot().sequence, beforeCrash.sequence + (phase === 'committed' ? 1n : 0n));
  }
  journal.close(); journal = open();
  assert.deepEqual(await submit(journal, system, config, 'redemption', redemption), redemptionResponse);
  checks.push('actual writer process death before and after commit', 'redemption preserves outstanding count');
  const returned = await replay(system, config, journal.snapshot().events);
  assert.equal(returned.supply.get(a.nameHex), 100n);
  const burnedChange = await note(a.nameHex, 0);
  const burnInput = { pool, asset: limbs(a.nameHex), quantity: '40', anchor: returned.tree.root(),
    nf: await system.nullifier(pool, redeemed.cm, redeemed.secret), output: burnedChange.cm,
    input: redeemed.opening, secret: redeemed.secret, ...returned.tree.path(redeemed.cm), change: burnedChange.opening };
  await rejectsWitness('burn wrong asset', 'burn', burnInput, v => { v.asset = limbs(b.nameHex); });
  await rejectsWitness('burn exceeds input', 'burn', burnInput, v => { v.quantity = '41'; });
  await submit(journal, system, config, 'burn', await system.prove('burn', burnInput));
  const final = await replay(system, config, journal.snapshot().events);
  assert.equal(final.supply.get(a.nameHex), 60n); assert.equal(final.supply.get(b.nameHex), 80n);
  await checkReceived(system, config, journal.snapshot().events, change.opening, change.secret);
  const exportFile = join(directory, 'public-evidence.json');
  const exported = { config, events: journal.snapshot().events }; save(exportFile, exported);
  const serialized = canonical(exported);
  for (const owned of [alice, otherAsset, bob, change, redeemed, dummy, burnedChange]) {
    for (const privateValue of [owned.secret, owned.opening.rho, owned.opening.owner]) assert.ok(!serialized.includes(privateValue));
  }
  checks.push('operator evidence contains no note secrets/openings', 'supply A=60 B=80 after issuer burn');
  const verifyStart = performance.now();
  const audit = await child('audit.mjs', [exportFile, artifacts, crs, final.tree.root(), final.count.toString(), final.historyHash]);
  const separateAuditMs = performance.now() - verifyStart;
  const publicAudit = JSON.parse(audit.stdout.trim().split('\n').at(-1));
  assert.equal(publicAudit.root, final.tree.root());
  assert.equal(publicAudit.historyHash, final.historyHash);
  assert.equal(publicAudit.supply[a.nameHex], '60');
  checks.push('separate process reconstructs all roots and supply from public evidence');
  // A valid prefix passes replay but cannot satisfy a separately pinned head.
  const prefix = { config, events: exported.events.slice(0, -1) };
  assert.equal((await replay(system, config, prefix.events)).supply.get(a.nameHex), 100n);
  const prefixFile = join(directory, 'public-prefix.json'); save(prefixFile, prefix);
  await assert.rejects(child('audit.mjs', [prefixFile, artifacts, crs, final.tree.root(), final.count.toString(), final.historyHash]),
    error => /history differs from expected checkpoint/.test(error.stderr));
  checks.push('valid prefix is rejected against a separately supplied expected checkpoint');
  await assert.rejects(child('audit.mjs', [forkFile, artifacts, crs, forkLeft.tree.root(), forkLeft.count.toString(), forkLeft.historyHash]),
    error => /history differs from expected checkpoint/.test(error.stderr));
  checks.push('valid alternate spent history with the same note root and count is rejected against the history checkpoint');
  const verificationStart = performance.now();
  assert.equal(await system.verify(payment), true);
  const warmSpendVerifyMs = performance.now() - verificationStart;
  const report = { date: new Date().toISOString(), profile: identity.profile,
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
      logicalCpus: cpus().length, memoryBytes: totalmem(), backend: 'WasmWorker', threads: 1 },
    dependencies: { noir: '1.0.0-beta.26', barretenberg: '5.2.0', poseidonSourceSha256: sha(readFileSync(join(root, 'vendor/poseidon2.nr'))) },
    proofOptions: OPTIONS, pins: system.pins, compileMs, setupMs: system.setupMs,
    proofs: system.metrics, warmSpendVerifyMs, separateAuditMs, crsCachePresentAtStart,
    publicJournalBytes: Buffer.byteLength(serialized), peakRssKiB: process.resourceUsage().maxRSS,
    events: publicAudit.audited, checks, crs: Object.fromEntries(readdirSync(crs).map(name => [name, sha(readFileSync(join(crs, name)))])),
    limitations: ['Desktop measurements, not phone/browser measurements', 'Tiny synthetic anonymity set; no metadata protection',
      'Local journal and caller-pinned head are not independent witnessing', 'Public-history replay cost grows; no production checkpoint/recovery protocol',
      'Custom research circuits and host are not audited production cryptography', 'Redemption transfer models holder consent; external performance and demand protocol are not implemented'] };
  if (process.env.MOE_RESEARCH_REPORT) writeFileSync(resolve(process.env.MOE_RESEARCH_REPORT), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const handle of handles) handle.close();
  if (system) await system.close();
  const target = realpathSync(directory);
  if (dirname(target) !== scratch || !target.startsWith(scratch + sep)) throw new Error('unsafe experiment cleanup');
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
