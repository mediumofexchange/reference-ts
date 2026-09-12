// Configured command acceptance. Parent owns service, listener and directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWalletPairing } from '@mediumofexchange/reference/pool/wallet-pairing';
import { PoolWalletStore } from '@mediumofexchange/reference/pool/wallet-store';
import { readLocalProfile } from './profile.mjs';

export async function checkConfiguredCustody(options) {
  const { root, directory, profileFile, profileDigest, holder, listen, stop, firstPrepared, firstAccepted, firstEnrollment, firstRequest } = options;
  const profile = readLocalProfile(profileFile, profileDigest);
  function inbox(database) {
    const wallet = new PoolWalletStore(database, profile.AUTHORITY, { readOnly: true });
    try { return wallet.inbox('order17'); } finally { wallet.close(); }
  }
  const savedInbox = inbox(options.receiver); assert.ok(savedInbox);
  async function custody(mode, database, backup, input, selectedProfile = profileFile, selectedDigest = profileDigest, rawInput) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, 'scripts/pool/local/custody.mjs'), mode, database, selectedProfile, selectedDigest,
        ...(mode === 'inspect' ? [] : [backup])], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', errors = ''; const timer = setTimeout(() => child.kill(), 30_000);
      child.stdout.on('data', c => { output += c; if (output.length > 1024 * 1024) child.kill(); });
      child.stderr.on('data', c => { errors += c; if (errors.length > 1024 * 1024) child.kill(); });
      child.stdin.on('error', () => {});
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        try {
          if (input?.key) assert.equal((output + errors).includes(input.key), false, 'recovery key reached output');
          if (rawInput !== undefined) assert.equal((output + errors).includes('deadbeef'), false, 'malformed recovery key reached output');
          if (code !== 0) { reject(new Error(errors || 'custody worker failed')); return; }
          const lines = output.split(/\r?\n/).filter(l => l.startsWith('MOE_WALLET_RESULT=')); assert.equal(lines.length, 1);
          resolve(JSON.parse(lines[0].slice('MOE_WALLET_RESULT='.length)));
        } catch (error) { reject(error); }
      });
      child.stdin.end(rawInput ?? (input === undefined ? '' : JSON.stringify(input)));
    });
  }
  const restored = {};
  for (const role of ['payer', 'receiver']) {
    const source = options[role], backup = join(directory, `${role}.encrypted`), destination = join(directory, `${role}-restored.db`);
    const key = randomBytes(32).toString('hex');
    const before = await custody('inspect', source);
    assert.equal(before.frozen, false);
    await assert.rejects(custody('export', source, backup, { key }, profileFile, profileDigest,
      '{"key":' + 'deadbeef'.repeat(8) + '}'), /invalid command JSON/);
    await assert.rejects(custody('export', source, profileFile, { key }), /collides/);
    await assert.rejects(custody('export', source, source + '-wal', { key }), /collides/);
    const hardlink = join(directory, `${role}-profile-link`); linkSync(profileFile, hardlink);
    await assert.rejects(custody('export', source, hardlink, { key }), /collides/);
    const occupied = join(directory, `${role}-occupied`); writeFileSync(occupied, 'keep');
    await assert.rejects(custody('export', source, occupied, { key }), /already exists/);
    assert.equal((await custody('inspect', source)).frozen, false);
    assert.equal(readFileSync(occupied, 'utf8'), 'keep');
    const exported = await custody('export', source, backup, { key });
    assert.equal(exported.frozen, true);
    const original = readFileSync(backup);
    const partial = join(directory, `${role}-partial.encrypted`); writeFileSync(partial, original.subarray(0, 32));
    await assert.rejects(custody('export', source, partial, { key }), /differs from frozen export/);
    assert.deepEqual(readFileSync(partial), original.subarray(0, 32));
    assert.equal((await custody('export', source, join(directory, `${role}-retry.encrypted`), { key })).digest, exported.digest);
    assert.equal((await custody('export', source, backup, { key })).digest, exported.digest, 'lost export reply must return exact file');
    assert.deepEqual(readFileSync(backup), original);
    await assert.rejects(custody('export', source, backup, { key: randomBytes(32).toString('hex') }), /invalid wallet backup/);
    await assert.rejects(holder('request', source, { id: 'after-export', value: '1' }), /frozen/);
    await assert.rejects(listen(source, role === 'payer' ? 'fund4' : 'order17', '1'), /frozen/);
    await assert.rejects(custody('restore', destination, backup, { key, digest: '00'.repeat(32) }), /invalid wallet backup/);
    await assert.rejects(custody('restore', destination, backup, { key: randomBytes(32).toString('hex'), digest: exported.digest }), /invalid wallet backup/);
    await assert.rejects(custody('restore', destination, backup, { key, digest: exported.digest }, profileFile, '00'.repeat(32)), /profile digest mismatch/);
    assert.equal(existsSync(destination), false, 'invalid restore created a wallet');
    writeFileSync(backup, Buffer.concat([original, Buffer.from('changed')]));
    await assert.rejects(custody('restore', destination, backup, { key, digest: exported.digest }), /invalid wallet backup/);
    writeFileSync(backup, original);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecarDestination = join(directory, `${role}${suffix}.db`); writeFileSync(sidecarDestination + suffix, 'keep');
      await assert.rejects(custody('restore', sidecarDestination, backup, { key, digest: exported.digest }), /new destination/);
      assert.equal(existsSync(sidecarDestination), false); assert.equal(readFileSync(sidecarDestination + suffix, 'utf8'), 'keep');
    }
    assert.equal((await custody('restore', destination, backup, { key, digest: exported.digest })).restoredFrom, exported.digest);
    await assert.rejects(custody('restore', destination, backup, { key, digest: exported.digest }), /EEXIST|new destination/);
    const inspected = await custody('inspect', destination);
    assert.equal(inspected.restoredFrom, exported.digest); assert.equal(inspected.frozen, false);
    assert.equal((await custody('inspect', source)).frozen, true);
    restored[role] = destination;
  }
  const { payer, receiver } = restored;
  assert.deepEqual(inbox(receiver), savedInbox, 'restore must retain the exact inbox before any retransmission');
  // Retained counter, invoice, inbox, exact prepared statement and receipt all
  // cross the encrypted handoff before either wallet consumes a new checkpoint.
  assert.equal((await holder('request', receiver, { id: 'order17', value: '7' })).request, firstRequest.request);
  assert.equal((await holder('prepare', payer, { alias: 'payment17' }, join(directory, 'absent'), '')).statement, firstPrepared.statement);
  assert.equal((await holder('submit', payer, { alias: 'payment17' }, join(directory, 'absent'), '')).receipt, firstAccepted.receipt);
  let listener;
  try {
    listener = await listen(receiver, 'order17');
    assert.equal(listener.ready.invitation, firstEnrollment.invitation, 'restore must retain private endpoint credentials/capability');
    assert.equal((await holder('deliver', payer, { alias: 'payment17' }, join(directory, 'absent'), '')).kind, 'stored');
    const oldPair = decodeWalletPairing(firstEnrollment.invitation);
    // Rotation commits even when the old listener still owns the requested port.
    await assert.rejects(listen(receiver, 'order17', oldPair.generation), /EADDRINUSE/);
    await assert.rejects(holder('deliver', payer, { alias: 'payment17' }), /wallet delivery failed/);
    await stop(listener.child); listener = undefined;
    listener = await listen(receiver, 'order17');
    const rotated = listener.ready, newPair = decodeWalletPairing(rotated.invitation);
    assert.equal(BigInt(newPair.generation), BigInt(oldPair.generation) + 1n);
    assert.notEqual(newPair.cert, oldPair.cert); assert.notEqual(newPair.token, oldPair.token);
    await assert.rejects(holder('deliver', payer, { alias: 'payment17' }), /wallet delivery failed/);
    await assert.rejects(holder('enroll', payer, { ...firstEnrollment, invitation: rotated.invitation,
      previousDigest: firstEnrollment.trustedDigest }), /pairing request or digest differs/);
    const update = { ...firstEnrollment, invitation: rotated.invitation, trustedDigest: rotated.digest, previousDigest: firstEnrollment.trustedDigest };
    assert.equal((await holder('enroll', payer, update)).digest, rotated.digest);
    assert.equal((await holder('enroll', payer, update)).digest, rotated.digest);
    assert.equal((await holder('prepare', payer, { alias: 'payment17' }, join(directory, 'absent'), '')).statement, firstPrepared.statement);
    assert.equal((await holder('deliver', payer, { alias: 'payment17' })).kind, 'stored');
    await stop(listener.child); listener = undefined;
    await assert.rejects(listen(receiver, 'order17', oldPair.generation), /credential generation changed/);
    listener = await listen(receiver, 'order17');
    assert.equal(listener.ready.invitation, rotated.invitation, 'lost rotation reply must reconcile by restart without another rotation');
    restored.receiverGeneration = BigInt(newPair.generation);
  } finally { if (listener) await stop(listener.child); }
  console.log('PASS configured encrypted handoff: both sources frozen, exact export/restore identity, occupied/hostile files refused, exact payment retry, credential rotation and authenticated re-enrollment');
  return restored;
}
