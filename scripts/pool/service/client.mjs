// Separate wallet/admin process. All operation results arrive through HTTP.
import assert from 'node:assert/strict';
import { bytesToHex } from '@noble/hashes/utils.js';
import { encodeCommitment, verifyCommitment } from '@mediumofexchange/reference/commitment';
import { PoolServiceClient } from '@mediumofexchange/reference/pool/service-client';
import { POOL_SERVICE_PROFILE } from '@mediumofexchange/reference/pool/service-wire';
import { poolReceiptAttestsEvidence, poolReceiptCovers, verifyPoolReceipt } from '@mediumofexchange/reference/pool/receipt';
import { encodeStoredReceipt } from '@mediumofexchange/reference/pool/store-codec';
import { ADMIN, AUTHORITY, DOMAIN, issue, OPERATOR, WALLET } from './fixture.mjs';

const [mode, baseUrl] = process.argv.slice(2);
const client = new PoolServiceClient(baseUrl, WALLET, ADMIN);
const encoded = commitment => {
  assert.equal(verifyCommitment(commitment), true);
  assert.deepEqual(commitment.operator, OPERATOR);
  return bytesToHex(encodeCommitment(commitment));
};
async function raw(body, token = WALLET) {
  const response = await fetch(new URL('/commands', baseUrl), { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
}
const command = fields => ({ version: 1, profile: POOL_SERVICE_PROFILE, ...fields });
async function receipt() {
  const statement = issue(), changed = { ...statement, proof: new Uint8Array(32).fill(9) };
  const first = await client.submit({ domain: DOMAIN, statement });
  assert.equal(verifyPoolReceipt(AUTHORITY, first), true);
  assert.equal(poolReceiptCovers(AUTHORITY, statement, first), true);
  assert.equal(poolReceiptAttestsEvidence(AUTHORITY, statement, first), true);
  assert.equal(verifyPoolReceipt({ ...AUTHORITY, segment: new Uint8Array(32) }, first), false);
  assert.equal(verifyPoolReceipt({ ...AUTHORITY, operator: new Uint8Array(32) }, first), false);
  const retry = await client.submit({ domain: DOMAIN, statement: changed });
  assert.equal(encodeStoredReceipt(retry), encodeStoredReceipt(first));
  assert.equal(poolReceiptCovers(AUTHORITY, changed, retry), true);
  assert.equal(poolReceiptAttestsEvidence(AUTHORITY, changed, retry), false);
  assert.equal(first.position, 1n);
  return encodeStoredReceipt(first);
}
let result;
if (mode === 'initial') {
  const firstReceipt = await receipt();
  const before = await client.view();
  assert.equal(before.highestSignedSequence, '1');
  assert.equal(before.evidence, 'omitted');
  assert.deepEqual(Object.keys(before).sort(), ['evidence', 'highestSignedSequence', 'latest', 'profile', 'version']);
  assert.deepEqual(await raw(command({ kind: 'commit', id: 'forbidden' })), { status: 403, body: { code: 'ADMIN_REQUIRED' } });
  assert.equal((await raw(command({ kind: 'publish' }))).status, 403);
  assert.equal((await raw(command({ kind: 'publish' }), '33'.repeat(32))).status, 401);
  assert.equal((await raw('{')).status, 400);
  assert.equal((await raw(command({ kind: 'commit', id: 'extra', extra: true }), ADMIN)).status, 400);
  await assert.rejects(client.submit({ domain: new Uint8Array(32), statement: issue() }), { status: 400, code: 'INVALID' });
  await assert.rejects(client.commit('opening'), { status: 409, code: 'CONFLICT' });
  assert.deepEqual(await client.view(), before);
  // The harness destroys the response only after the commit has completed.
  await assert.rejects(client.commit('checkpoint'), TypeError);
  const checkpoint = await client.commit('checkpoint');
  assert.equal(checkpoint.sequence, 2n);
  const commit = encoded(checkpoint);
  assert.equal(encoded(await client.commit('checkpoint')), commit);
  assert.equal(encoded(await client.publish()), commit);
  result = { receipt: firstReceipt, commit, nextSequence: '2', rejectedCases: 7 };
} else if (mode === 'fenced') {
  await assert.rejects(client.commit('old-process'), { code: 'FENCED' });
  await assert.rejects(client.submit({ domain: DOMAIN, statement: issue(102n) }), { code: 'FENCED' });
  await assert.rejects(client.publish(), { code: 'FENCED' });
  result = { fenced: true };
} else if (mode === 'resumed') {
  const firstReceipt = await receipt();
  const commit = encoded(await client.commit('checkpoint'));
  assert.equal((await client.view()).highestSignedSequence, '2');
  const next = await client.commit('next');
  assert.equal(next.sequence, 3n);
  const nextBytes = encoded(next);
  assert.equal(encoded(await client.publish()), nextBytes);
  result = { receipt: firstReceipt, commit, next: nextBytes, nextSequence: '3' };
} else if (mode === 'restarted') {
  const firstReceipt = await receipt();
  const commit = encoded(await client.commit('checkpoint'));
  const next = encoded(await client.commit('next'));
  assert.equal((await client.view()).highestSignedSequence, '3');
  assert.equal(encoded(await client.publish()), next);
  result = { receipt: firstReceipt, commit, next, nextSequence: '3' };
} else throw new Error('invalid acceptance client mode');
console.log(JSON.stringify({ ...result, pid: process.pid }));
