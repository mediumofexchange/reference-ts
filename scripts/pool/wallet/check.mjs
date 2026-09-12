// Two wallet processes and an HTTP service, using only public fixture keys,
// ideal proofs and an independently reconstructed known local venue ledger.
import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize, deserialize } from 'node:v8';
import { bytesToHex } from '@noble/hashes/utils.js';
import { encodeCommitment } from '@mediumofexchange/reference/commitment';
import { LocalVenue } from '@mediumofexchange/reference/venue';
import { IdealVerifier } from '../service/fixture.mjs';
import { walletProfile } from './profile.mjs';

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
assert.ok(process.argv.slice(2).every(arg => arg === '--real'), 'unknown wallet acceptance argument');
const real = process.argv.includes('--real');
const { ADMIN, CONFIG, OPERATOR_SECRET, TERMS, VENUE, WALLET } = walletProfile(real);
const run = promisify(execFile), ledger = [], requests = [];
const publicDirectory = join(directory, 'public'); mkdirSync(publicDirectory);
const ledgerFile = join(publicDirectory, 'ledger.json'), evidenceFile = join(publicDirectory, 'evidence.bin');
const compiled = real ? join(directory, 'circuits') : undefined;
const payer = join(directory, 'payer.db'), receiver = join(directory, 'receiver.db');
const requestFile = join(directory, 'request.bin'), deliveryFile = join(directory, 'delivery.bin'), fundingFile = join(directory, 'fund.bin');
const pairingFile = join(directory, 'pairing.json');
const venue = new LocalVenue(VENUE), publish = venue.publish.bind(venue);
venue.publish = c => { publish(c); ledger.push(bytesToHex(encodeCommitment(c))); writeFileSync(ledgerFile, JSON.stringify(ledger)); };
let proofs, store;
let server, drop = false, droppedReceipt;
let receiverServer;
async function startReceiver(dropOnce = false, ignoreStop = false) {
  const child = fork(join(root, 'scripts/pool/wallet/receiver-server.mjs'), [receiver, pairingFile, real ? 'real' : 'ideal', dropOnce ? 'drop-once' : '', ignoreStop ? 'ignore-stop' : ''],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  receiverServer = child;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('receiver startup timed out')); }, 15_000);
    const failed = () => { clearTimeout(timer); reject(new Error('receiver exited before readiness')); };
    child.once('error', failed); child.once('exit', failed);
    child.once('message', value => {
      clearTimeout(timer); child.off('error', failed); child.off('exit', failed);
      if (value?.ready === true) resolve(); else reject(new Error('invalid receiver readiness'));
    });
  });
}
async function stopReceiver(allowForced = false) {
  const child = receiverServer; if (!child) return false;
  if (child.exitCode !== null || child.signalCode !== null) { receiverServer = undefined; return false; }
  let forced = false;
  await new Promise((resolve, reject) => {
    let killTimer;
    const force = () => {
      if (forced) return; forced = true; child.kill();
      killTimer = setTimeout(() => reject(new Error('receiver did not exit after termination; ownership retained')), 5_000);
    };
    const timer = setTimeout(force, 5_000);
    child.once('error', force);
    child.once('exit', code => {
      clearTimeout(timer); clearTimeout(killTimer); child.off('error', force);
      receiverServer = undefined;
      if (code === 0 || forced && allowForced) resolve(); else reject(new Error('receiver shutdown failed'));
    });
    if (child.connected) child.send('stop', error => { if (error) force(); }); else force();
  });
  return forced;
}
function resultOf(stdout) {
  const prefix = 'MOE_WALLET_RESULT=', lines = stdout.split(/\r?\n/).filter(line => line.startsWith(prefix));
  assert.equal(lines.length, 1, 'worker must return one framed result');
  return JSON.parse(lines[0].slice(prefix.length));
}
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
    `http://127.0.0.1:${server.address().port}/`, exchange, evidenceFile, ledgerFile, compiled ?? '', pairingFile],
    { cwd: root, windowsHide: true, timeout: real ? 180_000 : 30_000, maxBuffer: 1024 * 1024 });
  const result = resultOf(stdout); assert.notEqual(result.pid, process.pid); return result;
}
async function checkpoint(id) {
  await store.commit(id); await store.publish(); writeFileSync(evidenceFile, serialize(await store.view()));
  if (real) console.log('PASS real wallet checkpoint: ' + id);
}
async function audit(expected, kind, amounts) {
  const { stdout } = await run(process.execPath, [join(root, 'scripts/pool/wallet/audit.mjs'), publicDirectory, compiled, expected],
    { cwd: publicDirectory, windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 });
  const result = resultOf(stdout); assert.notEqual(result.pid, process.pid); assert.equal(result.kind, kind);
  if (amounts) assert.deepEqual(result.supply[bytesToHex(TERMS.backing.name)], amounts);
  return result;
}
let acceptanceFailure;
try {
  if (real) {
    const { stdout } = await run(process.execPath, [join(root, 'scripts/pool/compile.mjs'), compiled],
      { cwd: root, windowsHide: true, timeout: 300_000, maxBuffer: 2_000_000 });
    process.stdout.write(stdout);
    proofs = await (await import('./proofs.mjs')).openWalletProofs(compiled);
  }
  store = new PoolStore(join(directory, 'operator.db'), CONFIG, OPERATOR_SECRET, venue, proofs?.verifier ?? new IdealVerifier());
  await store.activate('opening', [TERMS]); await store.publish(); await start();
  await cli('issue', payer, fundingFile); await checkpoint('fund'); await cli('fund', payer, fundingFile);
  const request = await cli('request', receiver, requestFile);
  assert.deepEqual(request.fields, ['backing', 'id', 'owner', 'value']);
  assert.deepEqual(await cli('request', receiver, requestFile).then(r => r.owner), request.owner);
  await startReceiver(true);
  const pairing = JSON.parse(readFileSync(pairingFile, 'utf8'));
  assert.equal(pairing.request.owner, request.owner);
  const originalRequestBytes = readFileSync(requestFile);
  const fundingEvidence = readFileSync(evidenceFile), withTail = deserialize(Buffer.from(fundingEvidence));
  const funded = withTail.checkpoints.find(e => e.commitment.sequence === withTail.latest.sequence);
  funded.history.trail.statements.push(funded.history.trail.statements[0]);
  writeFileSync(evidenceFile, serialize(withTail));
  await cli('prepare-pay', payer, requestFile);
  writeFileSync(evidenceFile, fundingEvidence);
  await cli('prepare-pay', payer, requestFile);
  const changedRequest = deserialize(Buffer.from(originalRequestBytes)); changedRequest.owner = changedRequest.owner === 1n ? 2n : 1n;
  writeFileSync(requestFile, serialize(changedRequest));
  await assert.rejects(cli('prepare-pay', payer, requestFile), /pairing request differs/);
  writeFileSync(requestFile, originalRequestBytes);
  drop = true; await cli('lost-pay', payer); assert.ok(droppedReceipt);
  const first = await cli('submit-pay', payer);
  assert.equal(existsSync(deliveryFile), false, 'private payer delivery must cross HTTPS, not a shared delivery file');
  assert.equal(encodeStoredReceipt(replyReceipt(decodePoolServiceReply(JSON.parse(droppedReceipt)))), first.receipt);
  const second = await cli('submit-pay', payer); assert.equal(first.receipt, second.receipt);
  if (real) assert.equal((await cli('reprove-pay', payer, requestFile)).reproved, true);
  assert.equal((await cli('inbox-status', receiver)).stored, false);
  await cli('lost-delivery', payer);
  const stored = await cli('inbox-status', receiver);
  assert.equal(stored.stored, true); assert.equal(stored.fulfilled, false);
  await stopReceiver(); await startReceiver();
  assert.equal(JSON.parse(readFileSync(pairingFile, 'utf8')).token, pairing.token);
  assert.equal((await cli('deliver-pay', payer)).ack, stored.hash);
  assert.equal((await cli('deliver-pay', payer)).ack, stored.hash);
  assert.deepEqual(readFileSync(requestFile), originalRequestBytes);
  await checkpoint('payment');
  if (real) {
    const expected = bytesToHex(encodeCommitment((await store.view()).latest));
    await audit(expected, 'final', { issued: '10', burned: '0', outstanding: '10' });
    const original = readFileSync(evidenceFile), missing = deserialize(Buffer.from(original));
    const selected = bundle => bundle.checkpoints.find(e => bytesToHex(encodeCommitment(e.commitment)) === expected);
    delete selected(missing).history;
    writeFileSync(evidenceFile, serialize(missing)); await audit(expected, 'unavailable');
    const corrupt = deserialize(Buffer.from(original)); selected(corrupt).history.trail.statements.at(-1).proof[100] ^= 1;
    writeFileSync(evidenceFile, serialize(corrupt)); await audit(expected, 'invalid');
    const reordered = deserialize(Buffer.from(original)); selected(reordered).history.trail.statements.reverse();
    writeFileSync(evidenceFile, serialize(reordered)); await audit(expected, 'invalid');
    const substituted = deserialize(Buffer.from(original)), alternateFile = join(publicDirectory, 'alternate.bin');
    const alternate = deserialize(readFileSync(alternateFile));
    assert.equal(await proofs.verifier.verify(alternate.kind, alternate.publicInputs, alternate.proof), true);
    const old = selected(substituted).history.trail.statements.at(-1);
    assert.deepEqual(alternate.publicInputs.slice(9), old.publicInputs.slice(9), 'alternate keeps both note outputs');
    assert.notEqual(alternate.publicInputs[8], old.publicInputs[8], 'alternate changes only padding spentness');
    selected(substituted).history.trail.statements[1] = alternate;
    writeFileSync(evidenceFile, serialize(substituted)); await audit(expected, 'invalid');
    rmSync(alternateFile);
    writeFileSync(evidenceFile, original);
  }
  assert.equal((await cli('change', payer)).change, '3');
  await cli('missing', receiver); await cli('receive', receiver); await cli('replay', receiver);
  await cli('prepare-burn', receiver); await cli('submit-burn', receiver); await checkpoint('burn');
  assert.equal((await cli('prepare-burn-change', payer)).quantity, '3');
  await cli('submit-burn', payer); await checkpoint('burn-change');
  assert.equal((await cli('note-spent', receiver)).note, 'spent');
  await assert.rejects(cli('prepare-burn', receiver), /held note is already spent/);
  // Inspect the actual service request schema: only canonical public statement
  // frames were sent. Receiver root/secret/opening are never service fields.
  assert.ok(requests.length >= 6);
  for (const text of requests) {
    assert.equal(text.includes(pairing.token), false, 'invoice capability reached operator');
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
  if (real) {
    await audit(bytesToHex(encodeCommitment(final.latest)), 'final', { issued: '10', burned: '10', outstanding: '0' });
    assert.deepEqual((await import('node:fs')).readdirSync(publicDirectory).sort(), ['evidence.bin', 'ledger.json']);
  }
  await stopReceiver();
  await startReceiver(false, true);
  assert.equal(await stopReceiver(true), true, 'noncooperating receiver must be terminated and its exit observed');
  console.log('PASS two-wallet v2 CLI: issue 10, request/pay 7, receiver checkpoint verification, fulfill once, burn 7; restore/verify/burn payer change 3 to outstanding 0; process restarts, lost accepted reply, exact/changed-proof retries, unavailable history and invoice replay rejection. Service traffic contains only public statement frames.');
  console.log(real ? 'PASS pinned real v2 wallet proofs and separate public-only audit: supply, missing history, corrupted proof, reordered history and different valid history with unchanged outputs/totals.' : 'Scope: ideal proof fixture only.');
  console.log('PASS private HTTPS inbox: original attested delivery, dropped acknowledgment, receiver restart, exact retry and separate fulfillment.');
  console.log('Scope: trusted plaintext local custody, public fixture TLS/obligor keys, authenticated fixture pairing and known LocalVenue; no external finality, supported custody, rollback protection or external-goods atomicity claim.');
} catch (error) { acceptanceFailure = error; }
finally {
  const failures = acceptanceFailure ? [acceptanceFailure] : [];
  for (const close of [() => stopReceiver(), async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }, () => store?.close(), () => proofs?.close(), () => {
    if (receiverServer) throw new Error('receiver still owns scratch; directory preserved');
    const target = realpathSync(directory);
    if (dirname(target) !== scratch || !target.startsWith(scratch + sep) || !target.startsWith(join(scratch, 'pool-wallet-cli-'))) throw new Error('unsafe wallet cleanup path');
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }]) { try { await close(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, 'wallet acceptance or cleanup failed');
}
