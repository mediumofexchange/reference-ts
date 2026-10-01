// Separate receiver/admin process. Operation results and packages arrive over
// HTTP; the judging venue and signed terms are held independently of replies.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { encodeReceipt } from '../../../dist/pool/v3/commitments.js';
import { EvidenceStore } from '../../../dist/pool/v3/evidence-store.js';
import { decodeEvidencePackage, encodeEvidencePackage } from '../../../dist/pool/v3/package.js';
import { readPackage } from '../../../dist/pool/v3/package-reader.js';
import { decodeRecord, encodeRecord } from '../../../dist/pool/v3/records.js';
import { V3ServiceClient } from '../../../dist/pool/v3/service-client.js';
import { V3Wallet } from '../../../dist/pool/v3/wallet-store.js';
import { FixtureVenue } from '../../../dist/record-venue.js';
import { encodeCommitment } from '../../../dist/venue-records.js';
import { ADMIN, WALLET, backing, configuration, domain, load, operator, reference, save, terms, verifier } from './service-fixture.mjs';

const [mode, directory, baseUrl] = process.argv.slice(2);
const walletPath = join(directory, 'receiver.sqlite'), evidencePath = join(directory, 'receiver-evidence.sqlite');
if (mode === 'prepare') {
  const venue = FixtureVenue.reference(reference.label, reference.lag);
  const wallet = new V3Wallet(walletPath, { venue, reference, verifier });
  try { save(join(directory, 'request.v8'), wallet.request('invoice', backing, 7n)); } finally { wallet.close(); }
  console.log(JSON.stringify({ pid: process.pid }));
  process.exit(0);
}
const client = new V3ServiceClient(baseUrl, WALLET, { domain, operator, reference }, ADMIN);
// The receiver wallet's verifier declares its circuits, so its reads keep their state beside its database
// across its processes, and counts what it is asked to verify.
let verified = 0;
const counting = { identities: configuration.circuits, verify: (...args) => { verified++; return verifier.verify(...args); } };
const openWallet = () => new V3Wallet(walletPath, { venue: FixtureVenue.from(load(join(directory, 'venue.v8'))), reference, verifier: counting });
const fixture = load(join(directory, 'public.v8'));
assert.deepEqual(fixture.signed.terms, terms, 'terms are pinned separately from the service response');
const encoded = commitment => bytesToHex(encodeCommitment(commitment));
// The receiver's own evidence file, kept across its processes: a sync asks the service only for what came
// after the sequence the file was kept through, and a read over it needs only the read's own package.
async function synced(expected, position) {
  const evidence = new EvidenceStore(evidencePath);
  try {
    assert.equal(evidence.suppliedThrough(Buffer.concat([domain, FixtureVenue.reference(reference.label, reference.lag).id, operator])), expected.before);
    const served = await client.sync(backing, evidence);
    assert.equal(served.selection.sequence, expected.sequence);
    assert.deepEqual(decodeEvidencePackage(served.package).map(item => item.kind), [1, 2]);
    const venue = FixtureVenue.from(load(join(directory, 'venue.v8')));
    const read = await readPackage(served.package, { ...served.selection, judgingIndex: venue.witnessedIndex(), mode: 'current-fixture' },
      { verifier, venue, reference, evidence });
    assert.equal(read.state.position, position);
  } finally { evidence.close(); }
}
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
  await synced({ before: 0n, sequence: 2n }, 2n);
  await client.submit(fixture.tail);
  const tail = await client.commit('tail'); assert.equal(tail.sequence, 3n);
  assert.deepEqual(await client.package(backing), complete, 'committed unpublished records/checkpoint are excluded');
  // A wallet that holds nothing else refuses a package with its trails withheld or a snapshot altered. Each
  // attempt starts from an empty evidence file: a wallet keeps what it is given, so later packages add to it.
  const items = decodeEvidencePackage(complete.package);
  const withheld = encodeEvidencePackage(items.filter(item => item.kind !== 6));
  const tampered = encodeEvidencePackage(items.map(item => {
    if (item.kind !== 4) return item;
    const payload = item.payload.slice(); payload[payload.length - 1] ^= 1; return { kind: item.kind, payload };
  }).sort((a, b) => a.kind - b.kind || Buffer.compare(sha256(a.payload), sha256(b.payload))));
  for (const hostile of [withheld, tampered]) {
    const wallet = openWallet();
    try {
      await assert.rejects(wallet.fulfill('invoice', hostile, fixture.signed), { status: 'unresolved-evidence' });
      assert.equal(wallet.fulfillment('invoice'), undefined, 'refused evidence cannot credit the invoice');
    } finally { wallet.close(); }
    rmSync(`${walletPath}.evidence`);
  }
  // The wallet syncs its own evidence file from the service, then reads with the read's own package alone.
  const wallet = openWallet();
  try {
    verified = 0;
    const served = await wallet.supply(evidence => client.sync(backing, evidence));
    assert.deepEqual(decodeEvidencePackage(served.package).map(item => item.kind), [1, 2]);
    const fulfilled = await wallet.fulfill('invoice', served.package, fixture.signed);
    assert.deepEqual(fulfilled.request, load(join(directory, 'request.v8')));
    assert.deepEqual(fulfilled.checkpoint, checkpoint);
    assert.equal(verified, 2, 'a first read verifies both records');
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
  await synced({ before: mode === 'resumed' ? 2n : 3n, sequence: 3n }, 3n);
  // A later process of the wallet fetches and verifies only what its files do not hold: the tail record
  // once, then nothing.
  const wallet = openWallet();
  try {
    assert.deepEqual(wallet.fulfillment('invoice'), load(join(directory, 'fulfilled.v8')));
    const served = await wallet.supply(evidence => client.sync(backing, evidence));
    const view = await wallet.sync(served.package, fixture.signed);
    assert.equal(encoded(view.checkpoint), encoded(tail));
    assert.deepEqual(view.holdings.map(h => [h.value, h.status]), [[7n, 'available']]);
    assert.equal(verified, mode === 'resumed' ? 1 : 0);
  } finally { wallet.close(); }
  result = { receipt: first, commit: encoded(commit), tail: encoded(tail) };
} else throw new Error('invalid acceptance client mode');
console.log(JSON.stringify({ ...result, pid: process.pid }));
