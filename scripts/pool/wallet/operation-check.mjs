// Caller-selected local wallet operation exercised through fresh command
// processes. The enclosing wallet check owns the operator and scratch cleanup.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { PoolWalletStore } from '@mediumofexchange/reference/pool/wallet-store';
import { createWalletDeliveryServer } from '@mediumofexchange/reference/pool/wallet-delivery-http';
import { walletPairingDigest } from '@mediumofexchange/reference/pool/wallet-pairing';
import { walletProfile } from './profile.mjs';
import { generateWalletTls } from './tls.mjs';

const MAX_CHILD_OUTPUT = 1024 * 1024;

/** Run the ordinary local operation flow against the parent check's service.
 * Each wallet action gets a new process; only the receiver listener and its
 * independently authenticated invitation remain parent-owned. */
export async function checkWalletOperation(options) {
  const { root, directory, baseUrl, evidenceFile, ledgerFile, checkpoint } = options;
  const compiled = options.compiled ?? '';
  assert.ok([root, directory, baseUrl, evidenceFile, ledgerFile, compiled].every(value => typeof value === 'string') &&
    typeof checkpoint === 'function', 'invalid wallet operation check options');
  const commands = join(root, 'scripts/pool/wallet/commands.mjs');
  const payer = join(directory, 'operation-payer.db'), receiver = join(directory, 'operation-receiver.db');
  for (const database of [payer, receiver]) assert.equal(resolve(database).startsWith(resolve(directory) + sep), true, 'wallet database escaped operation directory');
  let receiverWallet, server, receiverPort = 0;
  const children = new Set(), closedChildren = new WeakSet();

  function waitForClose(child, timeout) {
    if (closedChildren.has(child)) return Promise.resolve(true);
    return new Promise(resolveWait => {
      const closed = () => { clearTimeout(timer); resolveWait(true); };
      const timer = setTimeout(() => { child.off('close', closed); resolveWait(false); }, timeout);
      child.once('close', closed);
    });
  }

  async function command(mode, database, body, publicEvidence = evidenceFile) {
    const args = [commands, mode, database, baseUrl, publicEvidence, ledgerFile, compiled];
    return new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child);
      const stdout = [], stderr = []; let stdoutBytes = 0, stderrBytes = 0, stopReason, stdinError, killTimer;
      const stop = reason => {
        if (stopReason) return;
        stopReason = reason;
        child.kill();
        killTimer = setTimeout(() => reject(new Error('wallet command still owns scratch after termination; preserve the operation directory')), 5_000);
      };
      const timer = setTimeout(() => stop('wallet command timed out'), compiled ? 180_000 : 30_000);
      const collect = (chunks, name) => part => {
        const chunk = Buffer.from(part);
        if (name === 'stdout') stdoutBytes += chunk.length; else stderrBytes += chunk.length;
        if (stdoutBytes > MAX_CHILD_OUTPUT || stderrBytes > MAX_CHILD_OUTPUT) { stop('wallet command output exceeded limit'); return; }
        chunks.push(chunk);
      };
      child.stdout.on('data', collect(stdout, 'stdout')); child.stderr.on('data', collect(stderr, 'stderr'));
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') stdinError = error; });
      child.once('error', error => {
        if (child.pid === undefined) { clearTimeout(timer); clearTimeout(killTimer); children.delete(child); reject(error); }
        else stdinError ??= error;
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer); clearTimeout(killTimer); closedChildren.add(child); children.delete(child);
        const output = Buffer.concat(stdout).toString('utf8'), errorOutput = Buffer.concat(stderr).toString('utf8');
        if (stopReason || stdinError || code !== 0) { reject(stdinError ?? new Error(errorOutput || output || stopReason || `wallet command stopped (${signal ?? code})`)); return; }
        try {
          const prefix = 'MOE_WALLET_RESULT=', lines = output.split(/\r?\n/).filter(line => line.startsWith(prefix));
          assert.equal(lines.length, 1, 'wallet command must return one framed result');
          const result = JSON.parse(lines[0].slice(prefix.length));
          assert.ok(Number.isSafeInteger(result.pid) && result.pid !== process.pid, 'wallet command did not use a separate process');
          resolveResult(result);
        } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(body));
    });
  }
  async function stopReceiver() {
    const active = server; server = undefined;
    if (active) { active.closeAllConnections(); await new Promise(resolveClose => active.close(resolveClose)); }
    receiverWallet?.close(); receiverWallet = undefined;
  }
  async function startReceiver(requestId) {
    receiverWallet = new PoolWalletStore(receiver, walletProfile(Boolean(compiled)).AUTHORITY);
    let credentials = receiverWallet.deliveryCredentials();
    if (credentials === undefined) {
      const generated = await generateWalletTls();
      receiverWallet.installDeliveryCredentials(generated, 0n);
      credentials = receiverWallet.deliveryCredentials();
    }
    assert.ok(credentials);
    server = createWalletDeliveryServer(receiverWallet, credentials);
    await new Promise((resolveListen, reject) => server.listen(receiverPort, '127.0.0.1', resolveListen).once('error', reject));
    receiverPort = server.address().port;
    const invitation = receiverWallet.deliveryInvitation(requestId, `https://localhost:${receiverPort}/delivery/${requestId}`);
    return { invitation, digest: walletPairingDigest(invitation) };
  }

  try {
    assert.equal((await command('issue', payer, { id: 'fund4', value: '4' })).kind, 'accepted');
    assert.equal((await command('issue', payer, { id: 'fund6', value: '6' })).kind, 'accepted');
    await checkpoint('operation-funding');
    assert.equal((await command('record-issued', payer, { id: 'fund4' })).kind, 'final');
    assert.equal((await command('record-issued', payer, { id: 'fund6' })).kind, 'final');

    const funded = await command('status', payer, {});
    assert.equal(funded.kind, 'final'); assert.deepEqual(funded.notes.map(note => [note.id, note.value, note.state]),
      [['fund4', '4', 'unspent'], ['fund6', '6', 'unspent']]);
    const bundle = deserialize(readFileSync(evidenceFile));
    const missingEvidence = join(directory, 'operation-missing-evidence.bin');
    writeFileSync(missingEvidence, serialize({ ...bundle, checkpoints: [] }), { mode: 0o600 });
    assert.equal((await command('status', payer, {}, missingEvidence)).kind, 'unavailable');

    const firstRequest = await command('request', receiver, { id: 'order17', value: '7' });
    assert.equal(firstRequest.kind, 'request');
    const firstEndpoint = await startReceiver('order17');
    const firstEnrollment = { alias: 'payment17', invitation: firstEndpoint.invitation,
      trustedDigest: firstEndpoint.digest, expectedRequest: firstRequest.request };
    await assert.rejects(command('enroll', payer, { ...firstEnrollment, trustedDigest: '00'.repeat(32) }),
      /pairing request or digest differs/);
    assert.equal((await command('enroll', payer, firstEnrollment)).digest, firstEndpoint.digest);

    const firstPrepared = await command('prepare', payer, { alias: 'payment17' });
    assert.equal(firstPrepared.kind, 'prepared'); assert.equal(firstPrepared.hasChange, true);
    const reserved = await command('status', payer, {});
    assert.equal(reserved.kind, 'final');
    assert.equal(reserved.notes.filter(note => note.reservation === 'payment17' && note.state === 'unspent').length, 2,
      'the two selected notes must remain visibly reserved before the payment checkpoint');
    assert.equal((await command('prepare', payer, { alias: 'payment17' })).statement, firstPrepared.statement,
      'prepare retry must retain the exact saved statement');
    const firstAccepted = await command('submit', payer, { alias: 'payment17' });
    assert.equal(firstAccepted.kind, 'accepted');
    assert.equal((await command('submit', payer, { alias: 'payment17' })).receipt, firstAccepted.receipt,
      'submit retry must retain the exact receipt');
    assert.equal((await command('deliver', payer, { alias: 'payment17' })).kind, 'stored');
    assert.ok(receiverWallet.inbox('order17')); assert.equal(receiverWallet.fulfillment('order17'), undefined,
      'inbox acceptance must remain distinct from checkpoint finality');
    await stopReceiver();

    await checkpoint('operation-payment-7');
    const receivedFirst = await command('receive', receiver, { id: 'order17' });
    assert.equal(receivedFirst.kind, 'final'); assert.equal(receivedFirst.reconciled, false);
    assert.equal((await command('receive', receiver, { id: 'order17' })).reconciled, true,
      'lost fulfillment reply must reconcile the exact saved delivery');
    const change = await command('change', payer, { alias: 'payment17' });
    assert.equal(change.kind, 'final'); assert.equal(change.change, '3'); assert.equal(change.reconciled, false);
    assert.equal((await command('change', payer, { alias: 'payment17' })).reconciled, true,
      'change retry must reconcile its independent fulfillment');

    const secondRequest = await command('request', receiver, { id: 'order3', value: '3' });
    assert.equal(secondRequest.kind, 'request');
    const secondEndpoint = await startReceiver('order3');
    assert.equal(receiverWallet.deliveryCredentials().generation, 1n, 'receiver restart must retain its endpoint key generation');
    assert.equal((await command('enroll', payer, { alias: 'payment3', invitation: secondEndpoint.invitation,
      trustedDigest: secondEndpoint.digest, expectedRequest: secondRequest.request })).kind, 'enrolled');
    const secondPrepared = await command('prepare', payer, { alias: 'payment3' });
    assert.equal(secondPrepared.kind, 'prepared'); assert.equal(secondPrepared.hasChange, false);
    const secondReserved = await command('status', payer, {});
    assert.equal(secondReserved.notes.filter(note => note.reservation === 'payment3' && note.value === '3' && note.state === 'unspent').length, 1,
      'the independently verified change must fund the exact second payment');
    assert.equal((await command('submit', payer, { alias: 'payment3' })).kind, 'accepted');
    assert.equal((await command('deliver', payer, { alias: 'payment3' })).kind, 'stored');
    assert.equal(receiverWallet.fulfillment('order3'), undefined);
    await stopReceiver();

    await checkpoint('operation-payment-3');
    assert.equal((await command('receive', receiver, { id: 'order3' })).kind, 'final');
    const noChange = await command('change', payer, { alias: 'payment3' });
    assert.deepEqual({ kind: noChange.kind, change: noChange.change }, { kind: 'none', change: '0' });
    const final = await command('status', payer, {});
    assert.equal(final.kind, 'final'); assert.equal(final.notes.length, 3);
    assert.ok(final.notes.every(note => note.state === 'spent'));
    return { funding: ['4', '6'], firstPayment: '7', firstInputs: 2, firstChange: '3',
      secondPayment: '3', secondInputs: 1, secondChange: '0', finalSpentNotes: 3, receiverRestarts: 1 };
  } finally {
    const failures = [];
    try { await stopReceiver(); } catch (error) { failures.push(error); }
    for (const child of children) {
      child.kill();
      if (!await waitForClose(child, 5_000)) failures.push(new Error('wallet operation child still owns scratch; preserve the operation directory'));
    }
    if (failures.length) throw Object.assign(new AggregateError(failures, 'wallet operation resource cleanup failed'), { preserveWalletDirectory: true });
  }
}
