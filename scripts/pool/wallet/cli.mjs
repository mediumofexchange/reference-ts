// Local acceptance CLI: optional pinned real proofs, PUBLIC obligor keys. Private
// files are trusted local v8 serialization, not a network delivery format.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { decodeCommitment } from '@mediumofexchange/reference/commitment';
import { LocalVenue } from '@mediumofexchange/reference/venue';
import { PoolServiceClient } from '@mediumofexchange/reference/pool/service-client';
import { PoolWalletStore } from '@mediumofexchange/reference/pool/wallet-store';
import { deriveWalletField } from '@mediumofexchange/reference/pool/wallet';
import { commitmentOf, nullifierOf, ownerOf } from '@mediumofexchange/reference/pool/notes';
import { NoteTree } from '@mediumofexchange/reference/pool/note-tree';
import { limbsOf } from '@mediumofexchange/reference/pool/field';
import { ScopeTree } from '@mediumofexchange/reference/pool/scope';
import { ISSUE, SPEND, BURN, segmentIdentity, statementBytes } from '@mediumofexchange/reference/pool/statement';
import { readPoolCheckpoint } from '@mediumofexchange/reference/pool/checkpoint';
import { encodeStoredReceipt } from '@mediumofexchange/reference/pool/store-codec';
import { poolReceiptCovers, poolReceiptAttestsEvidence } from '@mediumofexchange/reference/pool/receipt';
import { IdealVerifier } from '../service/fixture.mjs';
import { walletProfile, BACKER_SECRET } from './profile.mjs';

const [mode, database, baseUrl, exchange, evidenceFile, ledgerFile, compiled] = process.argv.slice(2);
const { AUTHORITY, DOMAIN, CONFIG, VENUE, TERMS, WALLET, HEADER } = walletProfile(Boolean(compiled));
const needsProofs = ['issue', 'fund', 'change', 'receive', 'missing', 'replay', 'prepare-pay', 'reprove-pay', 'prepare-burn', 'prepare-burn-change'].includes(mode);
const proofs = compiled && needsProofs ? await (await import('./proofs.mjs')).openWalletProofs(compiled) : undefined;
const wallet = new PoolWalletStore(database, AUTHORITY), client = new PoolServiceClient(baseUrl, WALLET);
const load = path => deserialize(readFileSync(path));
const save = (path, value) => writeFileSync(path, serialize(value), { mode: 0o600 });
const backing = TERMS.backing.name;
const head = [...limbsOf(DOMAIN), ...limbsOf(AUTHORITY.segment), AUTHORITY.scopeRoot];
const prove = async (kind, publicInputs, witness) => ({ kind, publicInputs,
  proof: proofs ? await proofs.prove(kind, witness, publicInputs) : sha256(statementBytes(DOMAIN, kind, publicInputs)),
  ...(kind === ISSUE ? { obligorSignature: ed25519.sign(statementBytes(DOMAIN, kind, publicInputs), BACKER_SECRET) } : {}) });
const note = n => ({ backing: limbsOf(n.backing).map(String), value: String(n.value), owner: String(n.owner), rho: String(n.rho) });
const common = { domain: limbsOf(DOMAIN).map(String), segment: limbsOf(AUTHORITY.segment).map(String), scope: String(AUTHORITY.scopeRoot) };
const scope = new ScopeTree(HEADER.entries), scopePath = scope.pathFor(backing);
const scoped = { link: limbsOf(scope.entry(backing).link).map(String), scope_siblings: scopePath.siblings.map(String), scope_right: [...scopePath.right] };
const existing = id => { try { return wallet.pending(id); } catch (error) { if (error.code !== 'UNKNOWN') throw error; return undefined; } };
async function prepare(id, kind, publicInputs, witness, opening, change) {
  const old = existing(id);
  // Avoid new proof randomness on exact retry, but still compare the entire
  // reconstructed intent with durable bytes/openings through wallet.prepare.
  wallet.prepare(id, old ? { ...old.statement, kind, publicInputs } : await prove(kind, publicInputs, witness), opening, change);
}
function evidenceArgs() {
  assert.ok(!compiled || proofs, 'real checkpoint reads require the pinned verifier');
  const bundle = load(evidenceFile), venue = new LocalVenue(VENUE);
  for (const c of JSON.parse(readFileSync(ledgerFile, 'utf8'))) venue.publish(decodeCommitment(hexToBytes(c)));
  return { configuration: CONFIG, venue, checkpoint: bundle.latest, evidence: bundle.checkpoints, verifier: proofs?.verifier ?? new IdealVerifier() };
}
let result;
try {
  if (mode === 'request') {
    const request = wallet.request('invoice', backing, 7n);
    save(exchange, request); result = { owner: request.owner.toString(), fields: Object.keys(request).sort() };
  } else if (mode === 'issue') {
    const request = wallet.request('fund', backing, 10n);
    const opening = { backing, value: 10n, owner: request.owner,
      rho: deriveWalletField(BACKER_SECRET, DOMAIN, 'issue-rho', [request.owner]) };
    await prepare('issue', ISSUE, [...head, ...limbsOf(backing), 10n, commitmentOf(DOMAIN, opening)],
      { ...common, ...scoped, backing: limbsOf(backing).map(String), quantity: '10', cm: String(commitmentOf(DOMAIN, opening)), owner: String(opening.owner), rho: String(opening.rho) }, opening);
    await wallet.submit('issue', client); const pending = wallet.pending('issue');
    save(exchange, pending); result = { receipt: encodeStoredReceipt(pending.receipt) };
  } else if (mode === 'fund' || mode === 'change' || mode === 'receive' || mode === 'missing' || mode === 'replay') {
    const pending = mode === 'change' ? wallet.pending('pay') : undefined;
    const delivery = pending ? { statement: pending.statement, opening: pending.change, receipt: pending.receipt } : load(exchange), args = evidenceArgs();
    if (mode === 'missing') args.evidence = [];
    if (mode === 'replay') {
      await assert.rejects(wallet.fulfill('invoice', delivery, args), { code: 'CONFLICT' }); result = { replayRejected: true };
    } else {
      const verified = await wallet.fulfill(mode === 'fund' ? 'fund' : mode === 'change' ? 'change' : 'invoice', delivery, args);
      assert.equal(verified.kind, mode === 'missing' ? 'unavailable' : 'final', verified.kind === 'invalid' ? verified.reason : undefined);
      result = { finality: verified.kind, ...(mode === 'change' ? { change: wallet.received('change').value.toString() } : {}) };
    }
  } else if (mode === 'prepare-pay' || mode === 'reprove-pay' || mode === 'prepare-burn' || mode === 'prepare-burn-change') {
    const burning = mode.startsWith('prepare-burn'), inputId = mode === 'prepare-burn-change' ? 'change' : burning ? 'invoice' : 'fund';
    const held = wallet.received(inputId);
    assert.ok(held);
    const secret = wallet.secret(inputId), nf = nullifierOf(DOMAIN, commitmentOf(DOMAIN, held), secret);
    const args = evidenceArgs(), verified = await readPoolCheckpoint(args); assert.equal(verified.kind, 'final');
    assert.deepEqual(segmentIdentity(verified.prefix.header), AUTHORITY.segment, 'wallet fixture needs its pinned segment');
    assert.equal(verified.prefix.length, BigInt(verified.prefix.events.length), 'wallet fixture has no imported events');
    const tree = new NoteTree();
    // The reader may legitimately ignore an unverified served tail beyond the
    // checkpoint. Only replayed events can supply a wallet membership path.
    for (const event of verified.prefix.events) tree.appendAll(event.outputs);
    assert.ok(tree.has(commitmentOf(DOMAIN, held)));
    assert.equal(verified.prefix.events.some(event => event.nullifiers.includes(nf)), false, 'held note is already spent at the verified checkpoint');
    const paddingSecret = wallet.derive('padding-secret', [nf]);
    const padding = { backing, value: 0n, owner: ownerOf(paddingSecret), rho: wallet.derive('padding-rho', [nf]) };
    const paddedNf = nullifierOf(DOMAIN, commitmentOf(DOMAIN, padding), paddingSecret);
    const anchors = [tree.root(), tree.root()], nullifiers = [nf, paddedNf];
    const path = tree.path(BigInt(tree.leaves().indexOf(commitmentOf(DOMAIN, held))));
    const inputs = { ...common, anchors: anchors.map(String), nullifiers: nullifiers.map(String),
      inputs: [note(held), note(padding)], secrets: [secret, paddingSecret].map(String),
      siblings: [path.siblings.map(String), Array(32).fill('0')], right: [[...path.right], Array(32).fill(false)] };
    if (burning) {
      const change = { backing, value: 0n, owner: padding.owner, rho: wallet.derive('output-rho', [nf]) };
      await prepare('burn', BURN, [...head, ...limbsOf(backing), held.value, ...anchors, ...nullifiers, commitmentOf(DOMAIN, change)],
        { ...inputs, ...scoped, backing: limbsOf(backing).map(String), quantity: String(held.value), cm_change: String(commitmentOf(DOMAIN, change)), change: note(change) });
      result = { prepared: 'burn', quantity: held.value.toString() };
    } else {
      const request = load(exchange), changeRequest = wallet.request('change', backing, held.value - request.value);
      assert.deepEqual(request.backing, backing); assert.equal(request.value, 7n);
      const output = { backing, value: request.value, owner: request.owner, rho: wallet.derive('output-rho', [nf]) };
      const change = { backing, value: changeRequest.value, owner: changeRequest.owner, rho: wallet.derive('output-rho', [nf], 1) };
      const publicInputs = [...head, ...anchors, ...nullifiers, commitmentOf(DOMAIN, output), commitmentOf(DOMAIN, change)];
      const witness = { ...inputs, outputs: [commitmentOf(DOMAIN, output), commitmentOf(DOMAIN, change)].map(String),
        links: [scoped.link, scoped.link], scope_siblings: [scoped.scope_siblings, scoped.scope_siblings], scope_right: [scoped.scope_right, scoped.scope_right], output_notes: [note(output), note(change)] };
      if (mode === 'reprove-pay') {
        assert.ok(proofs, 'reproof requires the real backend');
        const pending = wallet.pending('pay'), alternate = await prove(SPEND, publicInputs, witness);
        assert.deepEqual(alternate.publicInputs, pending.statement.publicInputs);
        assert.notDeepEqual(alternate.proof, pending.statement.proof);
        const receipt = await client.submit({ domain: DOMAIN, statement: alternate });
        assert.equal(encodeStoredReceipt(receipt), encodeStoredReceipt(pending.receipt));
        assert.equal(poolReceiptAttestsEvidence(AUTHORITY, alternate, receipt), false);
        // Different valid padding changes the statement/spent history while
        // preserving note outputs and supply. This is an adversarial record,
        // never a pending wallet request or an authorized retry policy.
        const otherSecret = wallet.derive('padding-secret', [nf], 1);
        const otherPadding = { ...padding, owner: ownerOf(otherSecret), rho: wallet.derive('padding-rho', [nf], 1) };
        const otherNullifier = nullifierOf(DOMAIN, commitmentOf(DOMAIN, otherPadding), otherSecret);
        const alternateInputs = [...publicInputs]; alternateInputs[8] = otherNullifier;
        const alternateWitness = { ...witness, inputs: [note(held), note(otherPadding)],
          secrets: [secret, otherSecret].map(String), nullifiers: [nf, otherNullifier].map(String) };
        save(join(dirname(evidenceFile), 'alternate.bin'), await prove(SPEND, alternateInputs, alternateWitness));
        result = { reproved: true, proofBytes: alternate.proof.length };
      } else {
        await prepare('pay', SPEND, publicInputs, witness, output, change);
        result = { prepared: 'pay' };
      }
    }
  } else if (mode === 'submit-pay' || mode === 'submit-burn' || mode === 'lost-pay') {
    const name = mode === 'submit-burn' ? 'burn' : 'pay';
    if (mode === 'lost-pay') {
      await assert.rejects(wallet.submit(name, client), TypeError);
      assert.equal(wallet.pending(name).receipt, undefined); result = { pendingAfterLostReply: true };
    } else {
      const receipt = await wallet.submit(name, client), pending = wallet.pending(name);
      if (name === 'pay') save(exchange, { statement: pending.statement, opening: pending.opening, receipt: pending.receipt });
      const changed = { ...pending.statement, proof: new Uint8Array(32).fill(9) };
      const retry = await client.submit({ domain: DOMAIN, statement: changed });
      assert.equal(encodeStoredReceipt(receipt), encodeStoredReceipt(retry));
      assert.equal(poolReceiptCovers(AUTHORITY, changed, retry), true);
      assert.equal(poolReceiptAttestsEvidence(AUTHORITY, changed, retry), false);
      result = { receipt: encodeStoredReceipt(receipt), changedProofRetry: true };
    }
  } else throw new Error('unknown fixture wallet command');
  console.log('MOE_WALLET_RESULT=' + JSON.stringify({ ...result, pid: process.pid }));
} finally { wallet.close(); if (proofs) await proofs.close(); }
