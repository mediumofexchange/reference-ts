// Separate receiver/admin process. Operation results and packages arrive over
// HTTP; the judging venue and signed terms are held independently of replies.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { encodeReceipt } from '../../../dist/pool/v3/commitments.js';
import { decodeEvidencePackage, encodeEvidencePackage } from '../../../dist/pool/v3/package.js';
import { decodeRecord, encodeRecord } from '../../../dist/pool/v3/records.js';
import { V3ServiceClient } from '../../../dist/pool/v3/service-client.js';
import { V3Wallet } from '../../../dist/pool/v3/wallet-store.js';
import { FixtureVenue } from '../../../dist/record-venue.js';
import { encodeCommitment } from '../../../dist/venue-records.js';
import { ADMIN, WALLET, backing, configuration, domain, load, operator, reference, save, terms, verifier } from './service-fixture.mjs';

const [mode, directory, baseUrl] = process.argv.slice(2);
const walletPath = join(directory, 'receiver.sqlite');
if (mode === 'prepare') {
  const venue = FixtureVenue.reference(reference.label, reference.lag);
  const wallet = new V3Wallet(walletPath, { configuration, venue, reference, verifier });
  try { save(join(directory, 'request.v8'), wallet.request('invoice', backing, 7n)); } finally { wallet.close(); }
  console.log(JSON.stringify({ pid: process.pid }));
  process.exit(0);
}
const client = new V3ServiceClient(baseUrl, WALLET, { domain, operator, reference }, ADMIN);
const fixture = load(join(directory, 'public.v8'));
assert.deepEqual(fixture.signed.terms, terms, 'terms are pinned separately from the service response');
const encoded = commitment => bytesToHex(encodeCommitment(commitment));
async function receipt() {
  const first = await client.submit(fixture.issue);
  const original = decodeRecord(fixture.issue), proof = original.proof.slice(); proof[proof.length - 1] ^= 1;
  const retry = await client.submit(encodeRecord({ ...original, proof }));
  assert.deepEqual(encodeReceipt(retry), encodeReceipt(first), 'changed-proof retry returns original acceptance');
  assert.equal(first.position, 1n);
  return bytesToHex(encodeReceipt(first));
}
let result;
if (mode === 'initial') {
  const first = await receipt(); await client.submit(fixture.payment);
  const opening = await client.package(backing); assert.equal(opening.selection.sequence, 1n);
  await assert.rejects(client.commit('payment'), TypeError);
  const checkpoint = await client.commit('payment'); assert.equal(checkpoint.sequence, 2n);
  assert.equal(encoded(await client.commit('payment')), encoded(checkpoint));
  assert.equal(encoded(await client.publish()), encoded(checkpoint));
  const complete = await client.package(backing); assert.equal(complete.selection.sequence, 2n);
  await client.submit(fixture.tail);
  const tail = await client.commit('tail'); assert.equal(tail.sequence, 3n);
  assert.deepEqual(await client.package(backing), complete, 'committed unpublished records/checkpoint are excluded');
  const venue = FixtureVenue.from(load(join(directory, 'venue.v8')));
  const wallet = new V3Wallet(walletPath, { configuration, venue, reference, verifier });
  try {
    const items = decodeEvidencePackage(complete.package);
    const withheld = encodeEvidencePackage(items.filter(item => item.kind !== 6));
    await assert.rejects(wallet.fulfill('invoice', withheld, fixture.signed), { status: 'unresolved-evidence' });
    const tampered = items.map(item => {
      if (item.kind !== 4) return item;
      const payload = item.payload.slice(); payload[payload.length - 1] ^= 1; return { kind: item.kind, payload };
    }).sort((a, b) => a.kind - b.kind || Buffer.compare(sha256(a.payload), sha256(b.payload)));
    await assert.rejects(wallet.fulfill('invoice', encodeEvidencePackage(tampered), fixture.signed),
      { status: 'unresolved-evidence' });
    assert.equal(wallet.fulfillment('invoice'), undefined, 'refused evidence cannot credit the invoice');
    const fulfilled = await wallet.fulfill('invoice', complete.package, fixture.signed);
    assert.deepEqual(fulfilled.request, load(join(directory, 'request.v8')));
    assert.deepEqual(fulfilled.checkpoint, checkpoint);
    save(join(directory, 'fulfilled.v8'), fulfilled);
  } finally { wallet.close(); }
  save(join(directory, 'published.v8'), complete);
  result = { receipt: first, commit: encoded(checkpoint), tail: encoded(tail) };
} else if (mode === 'fenced') {
  await assert.rejects(client.submit(fixture.issue), { code: 'FENCED' });
  await assert.rejects(client.commit('old-process'), { code: 'FENCED' });
  await assert.rejects(client.publish(), { code: 'FENCED' });
  await assert.rejects(client.package(backing), { code: 'FENCED' });
  result = { fenced: true };
} else if (mode === 'resumed' || mode === 'restarted') {
  const first = await receipt(), commit = await client.commit('payment'), tail = await client.commit('tail');
  assert.equal(tail.sequence, 3n);
  if (mode === 'resumed') assert.deepEqual(await client.package(backing), load(join(directory, 'published.v8')));
  assert.equal(encoded(await client.publish()), encoded(tail));
  assert.equal((await client.package(backing)).selection.sequence, 3n);
  const venue = FixtureVenue.from(load(join(directory, 'venue.v8')));
  const wallet = new V3Wallet(walletPath, { configuration, venue, reference, verifier });
  try { assert.deepEqual(wallet.fulfillment('invoice'), load(join(directory, 'fulfilled.v8'))); } finally { wallet.close(); }
  result = { receipt: first, commit: encoded(commit), tail: encoded(tail) };
} else throw new Error('invalid acceptance client mode');
console.log(JSON.stringify({ ...result, pid: process.pid }));
