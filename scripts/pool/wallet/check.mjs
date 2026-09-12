// Two wallet processes and an HTTP service, using only public fixture keys,
// ideal proofs and an independently reconstructed known local venue ledger.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize, deserialize } from 'node:v8';
import { bytesToHex } from '@noble/hashes/utils.js';
import { encodeCommitment } from '@mediumofexchange/reference/commitment';
import { LocalVenue } from '@mediumofexchange/reference/venue';
import { ADMIN, CONFIG, IdealVerifier, OPERATOR_SECRET, TERMS, VENUE, WALLET } from '../service/fixture.mjs';

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.log('SKIP pool wallet acceptance: local SQLite custody requires Node 24.'); process.exit(0);
}
const { PoolStore } = await import('@mediumofexchange/reference/pool/store');
const { createPoolService } = await import('@mediumofexchange/reference/pool/service-http');
const { decodePoolServiceReply, replyReceipt } = await import('@mediumofexchange/reference/pool/service-wire');
const { encodeStoredReceipt } = await import('@mediumofexchange/reference/pool/store-codec');
const { fieldToBytes } = await import('@mediumofexchange/reference/pool/field');
const { DatabaseSync } = await import('node:sqlite');
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const scratchPath = join(root, 'scratch'); mkdirSync(scratchPath, { recursive: true });
const scratch = realpathSync(scratchPath); assert.equal(scratch, scratchPath);
const directory = realpathSync(mkdtempSync(join(scratch, 'pool-wallet-cli-')));
const run = promisify(execFile), ledger = [], requests = [];
const ledgerFile = join(directory, 'ledger.json'), evidenceFile = join(directory, 'evidence.bin');
const payer = join(directory, 'payer.db'), receiver = join(directory, 'receiver.db');
const requestFile = join(directory, 'request.bin'), deliveryFile = join(directory, 'delivery.bin'), fundingFile = join(directory, 'fund.bin');
const venue = new LocalVenue(VENUE), publish = venue.publish.bind(venue);
venue.publish = c => { publish(c); ledger.push(bytesToHex(encodeCommitment(c))); writeFileSync(ledgerFile, JSON.stringify(ledger)); };
const store = new PoolStore(join(directory, 'operator.db'), CONFIG, OPERATOR_SECRET, venue, new IdealVerifier());
let server, drop = false, droppedReceipt;
async function start() {
  server = createPoolService(store, { walletToken: WALLET, adminToken: ADMIN });
  server.prependListener('request', (request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => requests.push(body));
    const end = response.end;
    response.end = function(chunk, ...args) {
      if (drop && typeof chunk === 'string' && response.statusCode === 200 && JSON.parse(chunk).kind === 'accepted') {
        drop = false; droppedReceipt = chunk; response.destroy(); return this;
      }
      return end.call(this, chunk, ...args);
    };
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
}
async function cli(mode, database, exchange = deliveryFile) {
  const { stdout } = await run(process.execPath, [join(root, 'scripts/pool/wallet/cli.mjs'), mode, database,
    `http://127.0.0.1:${server.address().port}/`, exchange, evidenceFile, ledgerFile],
    { cwd: root, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout); assert.notEqual(result.pid, process.pid); return result;
}
async function checkpoint(id) { await store.commit(id); await store.publish(); writeFileSync(evidenceFile, serialize(await store.view())); }
try {
  await store.activate('opening', [TERMS]); await store.publish(); await start();
  await cli('issue', payer, fundingFile); await checkpoint('fund'); await cli('fund', payer, fundingFile);
  const request = await cli('request', receiver, requestFile);
  assert.deepEqual(request.fields, ['backing', 'id', 'owner', 'value']);
  assert.deepEqual(await cli('request', receiver, requestFile).then(r => r.owner), request.owner);
  const originalRequestBytes = readFileSync(requestFile);
  await cli('prepare-pay', payer, requestFile);
  drop = true; await cli('lost-pay', payer); assert.ok(droppedReceipt);
  const first = await cli('submit-pay', payer);
  assert.deepEqual(Object.keys(deserialize(readFileSync(deliveryFile))).sort(), ['opening', 'receipt', 'statement']);
  assert.equal(encodeStoredReceipt(replyReceipt(decodePoolServiceReply(JSON.parse(droppedReceipt)))), first.receipt);
  const second = await cli('submit-pay', payer); assert.equal(first.receipt, second.receipt);
  assert.deepEqual(readFileSync(requestFile), originalRequestBytes);
  await checkpoint('payment');
  assert.equal((await cli('change', payer)).change, '3');
  await cli('missing', receiver); await cli('receive', receiver); await cli('replay', receiver);
  await cli('prepare-burn', receiver); await cli('submit-burn', receiver); await checkpoint('burn');
  assert.equal((await cli('prepare-burn-change', payer)).quantity, '3');
  await cli('submit-burn', payer); await checkpoint('burn-change');
  // Inspect the actual service request schema: only canonical public statement
  // frames were sent. Receiver root/secret/opening are never service fields.
  assert.ok(requests.length >= 6);
  for (const text of requests) {
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body).sort(), ['kind', 'profile', 'statement', 'version']);
    assert.equal(body.kind, 'submit');
  }
  const receiverDb = new DatabaseSync(receiver, { readOnly: true });
  try {
    const rootSecret = receiverDb.prepare('SELECT root FROM wallet_meta WHERE singleton=1').get().root;
    const secrets = receiverDb.prepare('SELECT secret FROM wallet_requests').all().map(row => bytesToHex(fieldToBytes(BigInt(row.secret))));
    for (const secret of [rootSecret, ...secrets]) assert.equal(requests.some(body => body.includes(secret)), false, 'receiver custody bytes reached service traffic');
  } finally { receiverDb.close(); }
  const final = await store.view();
  const latest = final.checkpoints.find(e => e.commitment.sequence === final.latest.sequence);
  assert.equal(latest.snapshots[0].issued, 10n); assert.equal(latest.snapshots[0].burned, 10n);
  console.log('PASS two-wallet v2 CLI: issue 10, request/pay 7, receiver checkpoint verification, fulfill once, burn 7; restore/verify/burn payer change 3 to outstanding 0; process restarts, lost accepted reply, exact/changed-proof retries, unavailable history and invoice replay rejection. Service traffic contains only public statement frames.');
  console.log('Scope: trusted plaintext local custody, public fixture obligor keys, ideal proofs, bulk local fixture history and known LocalVenue; no external finality, private transport, rollback protection, production proof or external-goods atomicity claim.');
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  store.close();
  const target = realpathSync(directory);
  if (dirname(target) !== scratch || !target.startsWith(scratch + sep) || !target.startsWith(join(scratch, 'pool-wallet-cli-'))) throw new Error('unsafe wallet cleanup path');
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
