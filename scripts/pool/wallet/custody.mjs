// Local acceptance worker. Recovery key arrives on stdin, never argv or logs.
// This fixture's trusted local directory is not a supported encrypted volume.
import assert from 'node:assert/strict';
import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { PoolWalletStore } from '@mediumofexchange/reference/pool/wallet-store';
import { MAX_WALLET_BACKUP_BYTES, walletBackupDigest } from '@mediumofexchange/reference/pool/wallet-backup';
import { walletProfile } from './profile.mjs';

const [mode, database, file, real] = process.argv.slice(2);
assert.ok(['export', 'restore'].includes(mode));
const credentials = JSON.parse(readFileSync(0, 'utf8'));
assert.match(credentials.key, /^[0-9a-f]{64}$/);
const key = Buffer.from(credentials.key, 'hex'), { AUTHORITY } = walletProfile(real === 'real');
let wallet;
try {
  if (mode === 'export') {
    wallet = new PoolWalletStore(database, AUTHORITY);
    const bytes = wallet.exportBackup(key), digest = walletBackupDigest(bytes);
    assert.deepEqual(wallet.exportBackup(key), bytes, 'lost export reply retries exact bytes');
    assert.equal(wallet.custody().frozen, true);
    assert.throws(() => wallet.request('after-export', AUTHORITY.domain, 1n), { code: 'CONFLICT' });
    const fd = openSync(file, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    assert.equal(walletBackupDigest(readFileSync(file)), digest);
    console.log(JSON.stringify({ pid: process.pid, digest, bytes: bytes.length }));
  } else {
    assert.ok(statSync(file).size <= MAX_WALLET_BACKUP_BYTES);
    wallet = PoolWalletStore.restoreBackup(database, AUTHORITY, readFileSync(file), key, credentials.digest);
    assert.deepEqual(wallet.custody(), { frozen: false, restoredFrom: credentials.digest });
    wallet.close(); wallet = new PoolWalletStore(database, AUTHORITY);
    assert.equal(wallet.custody().restoredFrom, credentials.digest);
    console.log(JSON.stringify({ pid: process.pid, restoredFrom: wallet.custody().restoredFrom }));
  }
} finally { key.fill(0); wallet?.close(); }
