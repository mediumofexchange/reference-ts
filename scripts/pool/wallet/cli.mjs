// Local acceptance CLI only: ideal proofs and PUBLIC obligor keys. Private
// files are trusted local v8 serialization, not a network delivery format.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
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
import { ISSUE, SPEND, BURN, parsePublicInputs, statementBytes } from '@mediumofexchange/reference/pool/statement';
import { readPoolCheckpoint } from '@mediumofexchange/reference/pool/checkpoint';
import { encodeStoredReceipt } from '@mediumofexchange/reference/pool/store-codec';
import { poolReceiptCovers, poolReceiptAttestsEvidence } from '@mediumofexchange/reference/pool/receipt';
import { AUTHORITY, DOMAIN, CONFIG, VENUE, TERMS, WALLET, IdealVerifier } from '../service/fixture.mjs';

const [mode, database, baseUrl, exchange, evidenceFile, ledgerFile] = process.argv.slice(2);
const wallet = new PoolWalletStore(database, AUTHORITY), client = new PoolServiceClient(baseUrl, WALLET);
const load = path => deserialize(readFileSync(path));
const save = (path, value) => writeFileSync(path, serialize(value), { mode: 0o600 });
const backing = TERMS.backing.name;
const head = [...limbsOf(DOMAIN), ...limbsOf(AUTHORITY.segment), AUTHORITY.scopeRoot];
const prove = (kind, publicInputs) => ({ kind, publicInputs, proof: sha256(statementBytes(DOMAIN, kind, publicInputs)),
  ...(kind === ISSUE ? { obligorSignature: ed25519.sign(statementBytes(DOMAIN, kind, publicInputs), new Uint8Array(32).fill(1)) } : {}) });
function evidenceArgs() {
  const bundle = load(evidenceFile), venue = new LocalVenue(VENUE);
  for (const c of JSON.parse(readFileSync(ledgerFile, 'utf8'))) venue.publish(decodeCommitment(hexToBytes(c)));
  return { configuration: CONFIG, venue, checkpoint: bundle.latest, evidence: bundle.checkpoints, verifier: new IdealVerifier() };
}
let result;
try {
  if (mode === 'request') {
    const request = wallet.request('invoice', backing, 7n);
    save(exchange, request); result = { owner: request.owner.toString(), fields: Object.keys(request).sort() };
  } else if (mode === 'issue') {
    const request = wallet.request('fund', backing, 10n);
    const opening = { backing, value: 10n, owner: request.owner,
      rho: deriveWalletField(new Uint8Array(32).fill(1), DOMAIN, 'issue-rho', [request.owner]) };
    wallet.prepare('issue', prove(ISSUE, [...head, ...limbsOf(backing), 10n, commitmentOf(DOMAIN, opening)]), opening);
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
      assert.equal(verified.kind, mode === 'missing' ? 'unavailable' : 'final');
      result = { finality: verified.kind, ...(mode === 'change' ? { change: wallet.received('change').value.toString() } : {}) };
    }
  } else if (mode === 'prepare-pay' || mode === 'prepare-burn' || mode === 'prepare-burn-change') {
    const burning = mode !== 'prepare-pay', inputId = mode === 'prepare-burn-change' ? 'change' : burning ? 'invoice' : 'fund';
    const held = wallet.received(inputId);
    assert.ok(held);
    const secret = wallet.secret(inputId), nf = nullifierOf(DOMAIN, commitmentOf(DOMAIN, held), secret);
    const args = evidenceArgs(), verified = await readPoolCheckpoint(args); assert.equal(verified.kind, 'final');
    const tree = new NoteTree();
    const trail = args.evidence.find(e => e.commitment.sequence === args.checkpoint.sequence).history.trail;
    for (const statement of trail.statements) tree.appendAll(parsePublicInputs(statement.kind, statement.publicInputs).outputs);
    assert.ok(tree.has(commitmentOf(DOMAIN, held)));
    const paddingSecret = wallet.derive('padding-secret', [nf]);
    const padding = { backing, value: 0n, owner: ownerOf(paddingSecret), rho: wallet.derive('padding-rho', [nf]) };
    const paddedNf = nullifierOf(DOMAIN, commitmentOf(DOMAIN, padding), paddingSecret);
    const anchors = [tree.root(), tree.root()], nullifiers = [nf, paddedNf];
    if (burning) {
      const change = { backing, value: 0n, owner: padding.owner, rho: wallet.derive('output-rho', [nf]) };
      wallet.prepare('burn', prove(BURN, [...head, ...limbsOf(backing), held.value, ...anchors, ...nullifiers, commitmentOf(DOMAIN, change)]));
      result = { prepared: 'burn', quantity: held.value.toString() };
    } else {
      const request = load(exchange), changeRequest = wallet.request('change', backing, held.value - request.value);
      assert.deepEqual(request.backing, backing); assert.equal(request.value, 7n);
      const output = { backing, value: request.value, owner: request.owner, rho: wallet.derive('output-rho', [nf]) };
      const change = { backing, value: changeRequest.value, owner: changeRequest.owner, rho: wallet.derive('output-rho', [nf], 1) };
      wallet.prepare('pay', prove(SPEND, [...head, ...anchors, ...nullifiers, commitmentOf(DOMAIN, output), commitmentOf(DOMAIN, change)]), output, change);
      result = { prepared: 'pay' };
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
  console.log(JSON.stringify({ ...result, pid: process.pid }));
} finally { wallet.close(); }
