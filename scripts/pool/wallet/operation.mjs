// Shared local holder operations. Proofs and fixture issuance are explicit caller dependencies.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deserialize } from 'node:v8';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { decodeCommitment, encodeCommitment } from '@mediumofexchange/reference/commitment';
import { LocalVenue } from '@mediumofexchange/reference/venue';
import { PoolServiceClient } from '@mediumofexchange/reference/pool/service-client';
import { PoolWalletError, PoolWalletStore } from '@mediumofexchange/reference/pool/wallet-store';
import { prepareWalletPayment, walletChangeRequestId, walletPayment } from '@mediumofexchange/reference/pool/wallet-payment';
import { encodeStatement, ISSUE, SPEND } from '@mediumofexchange/reference/pool/statement';
import { encodeStoredReceipt } from '@mediumofexchange/reference/pool/store-codec';
import { walletRequestText } from '@mediumofexchange/reference/pool/wallet-pairing';

const MAX_INPUT_BYTES = 64 * 1024;
export async function runWalletCommand({ mode, database, baseUrl, evidenceFile, ledgerFile, compiled = '', profile, body, openProofs, verifier, prove, issue, requireRealProofs = false }) {
const { AUTHORITY, CONFIG, DOMAIN, TERMS, VENUE, WALLET } = profile;
const backing = TERMS.backing.name;
let proofs, wallet, client;
async function ensureProofs() {
  assert.ok(!requireRealProofs || compiled, 'compiled pinned real proofs are required');
  if (compiled && proofs === undefined) proofs = await openProofs(compiled);
  return proofs;
}

function requireObject(value) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'command input must be a JSON object');
  return value;
}
function fields(value, required, optional = []) {
  const object = requireObject(value), actual = Object.keys(object).sort(), allowed = [...required, ...optional];
  assert.ok(required.every(key => Object.hasOwn(object, key)) && actual.every(key => allowed.includes(key)), 'invalid command input fields');
  return object;
}
function string(value, name, pattern, message = `invalid ${name}`) {
  assert.ok(typeof value === 'string' && pattern.test(value), message); return value;
}
function id(value, name = 'id') { return string(value, name, /^[A-Za-z0-9_-]{1,80}$/); }
function quantity(value) {
  const text = string(value, 'value', /^[1-9][0-9]{0,19}$/), amount = BigInt(text);
  assert.ok(amount < 1n << 64n, 'value exceeds u64'); return amount;
}
function requestText(request) { return JSON.stringify(walletRequestText(request)); }
function requestFrom(text) {
  string(text, 'expectedRequest', /^[\s\S]{1,1024}$/);
  const raw = requireObject(JSON.parse(text));
  assert.deepEqual(Object.keys(raw), ['id', 'backing', 'value', 'owner'], 'invalid public request fields');
  const request = { id: id(raw.id), backing: hexToBytes(string(raw.backing, 'backing', /^[0-9a-f]{64}$/)),
    value: quantity(raw.value), owner: BigInt(string(raw.owner, 'owner', /^[1-9][0-9]{0,76}$/)) };
  assert.equal(requestText(request), text, 'public request must be canonical');
  return request;
}
function preflight(value) {
  let data;
  if (mode === 'request' || mode === 'issue' && issue) {
    data = fields(value, ['id', 'value']); id(data.id); quantity(data.value);
    assert.ok(!data.id.startsWith('change_'), 'change request namespace is reserved');
  } else if (mode === 'enroll') {
    data = fields(value, ['alias', 'invitation', 'trustedDigest', 'expectedRequest'], ['previousDigest']);
    id(data.alias, 'alias'); string(data.invitation, 'invitation', /^[\s\S]{1,16384}$/);
    string(data.trustedDigest, 'trustedDigest', /^[0-9a-f]{64}$/); requestFrom(data.expectedRequest);
    if (data.previousDigest !== undefined) string(data.previousDigest, 'previousDigest', /^[0-9a-f]{64}$/);
  } else if (mode === 'submit' || mode === 'deliver') {
    data = fields(value, ['alias']); id(data.alias, 'alias');
  } else if (mode === 'prepare' || mode === 'change') {
    data = fields(value, ['alias'], ['checkpoint']); id(data.alias, 'alias');
  } else if (mode === 'receive' || mode === 'record-issued') {
    data = fields(value, ['id'], ['checkpoint']); id(data.id);
  } else if (mode === 'status') data = fields(value, [], ['checkpoint']);
  else assert.fail('unknown wallet command');
  if (data.checkpoint !== undefined) string(data.checkpoint, 'checkpoint', /^[0-9a-f]+$/);
}
function evidenceArgs(checkpointText) {
  assert.ok(!compiled || proofs, 'real checkpoint reads require the pinned verifier');
  const bundle = deserialize(readFileSync(evidenceFile));
  const venue = new LocalVenue(VENUE), ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
  assert.ok(Array.isArray(ledger) && ledger.length <= 100_000, 'invalid local venue ledger');
  for (const item of ledger) venue.publish(decodeCommitment(hexToBytes(string(item, 'ledger commitment', /^[0-9a-f]+$/))));
  const checkpoint = checkpointText === undefined ? bundle.latest : decodeCommitment(hexToBytes(string(checkpointText, 'checkpoint', /^[0-9a-f]+$/)));
  return { configuration: CONFIG, venue, checkpoint, evidence: bundle.checkpoints,
    verifier: proofs?.verifier ?? verifier };
}
function checkpointText(commitment) { return bytesToHex(encodeCommitment(commitment)); }
function publicFailure(result) {
  return result.kind === 'invalid' ? { kind: 'invalid', reason: result.reason } : { kind: 'unavailable', evidence: result.evidence,
    commitment: { operator: bytesToHex(result.commitment.operator), sequence: result.commitment.sequence.toString(), root: bytesToHex(result.commitment.root) } };
}
function sameOpening(a, b) {
  return bytesToHex(a.backing) === bytesToHex(b.backing) && a.value === b.value && a.owner === b.owner && a.rho === b.rho;
}
function reconcile(idValue, delivery) {
  const saved = wallet.fulfillment(idValue);
  if (saved === undefined) return undefined;
  assert.ok(sameOpening(saved.opening, delivery.opening) &&
    encodeStoredReceipt(saved.receipt) === encodeStoredReceipt(delivery.receipt), 'saved fulfillment differs from delivery');
  return { kind: 'final', record: 'historical-fulfillment', id: idValue,
    checkpoint: checkpointText(saved.checkpoint), reconciled: true };
}
async function fulfill(idValue, delivery, checkpoint) {
  const old = reconcile(idValue, delivery); if (old) return old;
  await ensureProofs();
  const args = evidenceArgs(checkpoint), checked = await wallet.checkNote(idValue, delivery.opening, args);
  if (checked.kind === 'unavailable' || checked.kind === 'invalid') return checked;
  if (checked.kind === 'spent') return { kind: 'invalid', reason: 'note is spent at the selected checkpoint' };
  const result = await wallet.fulfill(idValue, delivery, args);
  if (result.kind !== 'final') return result;
  const saved = wallet.fulfillment(idValue); assert.ok(saved);
  return { kind: 'final', record: 'historical-fulfillment', id: idValue,
    checkpoint: checkpointText(saved.checkpoint), reconciled: false };
}
function publicPending(pending) {
  return { kind: 'prepared', statement: bytesToHex(sha256(encodeStatement(DOMAIN, pending.statement))),
    hasChange: pending.change !== undefined && pending.change.value > 0n };
}

let result;
preflight(body);
try {
  wallet = new PoolWalletStore(database, AUTHORITY);
  client = new PoolServiceClient(baseUrl, WALLET);
  if (mode === 'request') {
    const data = fields(body, ['id', 'value']);
    result = { kind: 'request', request: requestText(wallet.request(id(data.id), backing, quantity(data.value))) };
  } else if (mode === 'enroll') {
    const data = fields(body, ['alias', 'invitation', 'trustedDigest', 'expectedRequest'], ['previousDigest']);
    const previous = data.previousDigest === undefined ? undefined : string(data.previousDigest, 'previousDigest', /^[0-9a-f]{64}$/);
    result = { kind: 'enrolled', alias: id(data.alias, 'alias'), digest: wallet.acceptPairing(data.alias,
      string(data.invitation, 'invitation', /^[\s\S]{1,16384}$/), string(data.trustedDigest, 'trustedDigest', /^[0-9a-f]{64}$/),
      requestFrom(data.expectedRequest), previous) };
  } else if (mode === 'status') {
    const data = fields(body, [], ['checkpoint']);
    await ensureProofs();
    const inspected = await wallet.inspectNotes(evidenceArgs(data.checkpoint));
    result = inspected.kind !== 'final' ? publicFailure(inspected) : { kind: 'final', checkpoint: checkpointText(inspected.checkpoint), notes: inspected.notes.map(note => ({
      id: note.id, backing: bytesToHex(note.opening.backing), value: note.opening.value.toString(), state: note.state,
      ...(note.reservation === undefined ? {} : { reservation: note.reservation }),
    })) };
  } else if (mode === 'prepare') {
    const data = fields(body, ['alias'], ['checkpoint']), alias = id(data.alias, 'alias');
    // Existing exact commands remain retryable without checkpoint files or a
    // proof backend. Only UNKNOWN means there is no saved pending command.
    wallet.pairing(alias);
    let saved;
    try { saved = walletPayment(wallet, alias); }
    catch (error) { if (!(error instanceof PoolWalletError) || error.code !== 'UNKNOWN') throw error; }
    if (saved) result = { ...publicPending(saved), alias };
    else {
      await ensureProofs();
      const prepared = await prepareWalletPayment(wallet, alias, evidenceArgs(data.checkpoint),
        (publicInputs, witness) => proofs ? proofs.prove(SPEND, witness, publicInputs) :
          prove(SPEND, publicInputs));
      result = prepared.kind !== 'prepared' ? publicFailure(prepared) : { ...publicPending(prepared.pending), alias };
    }
  } else if (mode === 'submit') {
    const data = fields(body, ['alias']), alias = id(data.alias, 'alias');
    walletPayment(wallet, alias);
    const receipt = await wallet.submit(alias, client);
    result = { kind: 'accepted', alias, receipt: encodeStoredReceipt(receipt) };
  } else if (mode === 'deliver') {
    const data = fields(body, ['alias']), alias = id(data.alias, 'alias'), pending = walletPayment(wallet, alias);
    assert.ok(pending.opening && pending.receipt, 'payment has not been accepted');
    result = { kind: 'stored', alias, acknowledgement: await wallet.pairedDeliveryClient(alias).deliver(DOMAIN,
      { statement: pending.statement, opening: pending.opening, receipt: pending.receipt }) };
  } else if (mode === 'receive') {
    const data = fields(body, ['id'], ['checkpoint']), requestId = id(data.id);
    const delivery = wallet.inbox(requestId); assert.ok(delivery, 'receiver inbox is empty');
    const fulfilled = await fulfill(requestId, delivery, data.checkpoint);
    result = fulfilled.kind === 'final' ? fulfilled : publicFailure(fulfilled);
  } else if (mode === 'change') {
    const data = fields(body, ['alias'], ['checkpoint']), alias = id(data.alias, 'alias'), pending = walletPayment(wallet, alias);
    assert.ok(pending.receipt, 'payment has not been accepted');
    if (pending.change === undefined || pending.change.value === 0n) result = { kind: 'none', alias, change: '0' };
    else {
      const changeId = walletChangeRequestId(alias, pending.change.value);
      const fulfilled = await fulfill(changeId, { statement: pending.statement, opening: pending.change, receipt: pending.receipt }, data.checkpoint);
      result = fulfilled.kind !== 'final' ? publicFailure(fulfilled) : { ...fulfilled, alias, change: pending.change.value.toString() };
    }
  } else if (mode === 'issue') {
    assert.ok(issue, 'unknown wallet command');
    result = await issue({ body, fields, id, quantity, wallet, backing, profile, ensureProofs, client });
  } else if (mode === 'record-issued') {
    const data = fields(body, ['id'], ['checkpoint']), requestId = id(data.id), pending = wallet.pending(requestId);
    assert.equal(pending.statement.kind, ISSUE, 'pending command is not issuance');
    assert.ok(pending.opening && pending.receipt, 'issuance has not been accepted');
    const fulfilled = await fulfill(requestId, { statement: pending.statement, opening: pending.opening, receipt: pending.receipt }, data.checkpoint);
    result = fulfilled.kind === 'final' ? fulfilled : publicFailure(fulfilled);
  } else assert.fail('unknown wallet command');
  return { ...result, pid: process.pid };
} finally {
  try { wallet?.close(); } finally { if (proofs) await proofs.close(); }
}
}

export async function readCommandInput() {
  const chunks = []; let size = 0;
  for await (const part of process.stdin) {
    const chunk = Buffer.from(part); size += chunk.length;
    assert.ok(size <= MAX_INPUT_BYTES, 'command input exceeds limit'); chunks.push(chunk);
  }
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size));
  assert.ok(text.length > 0, 'command input is required'); return JSON.parse(text);
}
