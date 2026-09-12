// Local configured operator. The ledger is a caller-provided complete local
// record, not a source of external witness authentication.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serialize } from 'node:v8';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { decodeCommitment, encodeCommitment } from '@mediumofexchange/reference/commitment';
import { LocalVenue } from '@mediumofexchange/reference/venue';
import { PoolStore } from '@mediumofexchange/reference/pool/store';
import { createPoolService } from '@mediumofexchange/reference/pool/service-http';
import { readLocalProfile } from './profile.mjs';
import { readCommandInput } from '../wallet/operation.mjs';
import { assertLocalPaths } from './paths.mjs';
import { replaceLocalFile } from './files.mjs';

const [database, profileFile, digest, ledgerFile, evidenceFile, compiled, port = '0'] = process.argv.slice(2);
assert.ok([database, profileFile, digest, ledgerFile, evidenceFile, compiled].every(v => typeof v === 'string' && v.length > 0) &&
  process.argv.slice(2).length <= 7 && /^(0|[1-9][0-9]{0,4})$/.test(port) && Number(port) <= 65535, 'invalid operator arguments');
assertLocalPaths(database, profileFile, ledgerFile, evidenceFile);
const profile = readLocalProfile(profileFile, digest);
const credentials = await readCommandInput();
assert.ok(credentials && typeof credentials === 'object' && !Array.isArray(credentials) &&
  Object.keys(credentials).sort().join(',') === 'adminToken,operatorSecret,walletToken' &&
  Object.values(credentials).every(v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) &&
  credentials.walletToken !== credentials.adminToken, 'invalid operator credentials');
const secret = hexToBytes(credentials.operatorSecret);
assert.equal(bytesToHex(ed25519.getPublicKey(secret)), bytesToHex(profile.HEADER.operator), 'operator key differs from profile');
const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
assert.ok(Array.isArray(ledger) && ledger.length <= 100_000, 'invalid local venue ledger');
const venue = new LocalVenue(profile.VENUE);
for (const frame of ledger) {
  assert.ok(typeof frame === 'string' && /^(?:[0-9a-f]{2})+$/.test(frame), 'invalid local commitment');
  venue.publish(decodeCommitment(hexToBytes(frame)));
}
const publish = venue.publish.bind(venue);
venue.publish = commitment => {
  const frame = bytesToHex(encodeCommitment(commitment));
  // Persist before acknowledging publication; exact outbox retry can reconstruct
  // a ledger write after a lost reply. File faults remain explicit failures.
  if (!ledger.includes(frame)) {
    assert.ok(ledger.length < 100_000, 'local ledger capacity reached; publication remains pending');
    replaceLocalFile(ledgerFile, JSON.stringify([...ledger, frame]));
    ledger.push(frame);
  }
  publish(commitment);
};
let proofs, store, server;
async function close() {
  if (server) {
    const active = server; server = undefined;
    await new Promise(resolveClose => active.close(resolveClose));
  }
  try { store?.close(); } finally { await proofs?.close(); secret.fill(0); }
}
try {
  proofs = await (await import('../wallet/proofs.mjs')).openWalletProofs(compiled);
  store = new PoolStore(database, profile.CONFIG, secret, venue, proofs.verifier, undefined, profile.HEADER);
  if ((await store.view()).latest === undefined) {
    assert.equal(venue.latestFor(profile.HEADER.operator), undefined, 'existing operator history requires its original journal');
    await store.activate('opening', [profile.TERMS]);
  }
  const publishStore = store.publish.bind(store);
  store.publish = async () => {
    const result = await publishStore();
    replaceLocalFile(evidenceFile, serialize(await store.view()));
    return result;
  };
  await store.publish();
  server = createPoolService(store, credentials);
  await new Promise((resolveListen, reject) => server.listen(Number(port), '127.0.0.1', resolveListen).once('error', reject));
  console.log('MOE_LOCAL_READY=' + JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}/`, pid: process.pid }));
  await new Promise(resolveStop => {
    process.once('SIGINT', resolveStop); process.once('SIGTERM', resolveStop);
    process.once('disconnect', resolveStop);
    process.on('message', message => { if (message === 'stop') resolveStop(); });
  });
} finally { try { await close(); } finally { if (process.connected) process.disconnect(); } }
