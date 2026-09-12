// Configured offline handoff. Keys arrive only on bounded stdin; no proof runtime.
import assert from 'node:assert/strict';
import { closeSync, existsSync, fstatSync, fsyncSync, openSync, readSync, writeFileSync } from 'node:fs';
import { PoolWalletStore } from '@mediumofexchange/reference/pool/wallet-store';
import { MAX_WALLET_BACKUP_BYTES, walletBackupDigest } from '@mediumofexchange/reference/pool/wallet-backup';
import { readCommandInput } from '../wallet/operation.mjs';
import { readLocalProfile } from './profile.mjs';
import { assertWalletPaths } from './paths.mjs';

const [mode, database, profileFile, profileDigest, file] = process.argv.slice(2);
assert.ok(['export', 'restore', 'inspect'].includes(mode) &&
  process.argv.slice(2).length === (mode === 'inspect' ? 4 : 5) &&
  [database, profileFile, profileDigest].every(v => typeof v === 'string'),
  'usage: custody.mjs export|restore|inspect database profile profileDigest [backup]');
assertWalletPaths(database, { profileFile, ...(mode === 'inspect' ? {} : { backup: file }) });
const profile = readLocalProfile(profileFile, profileDigest);

// Descriptor-bound size/read checks prevent a growing file from allocating an
// unbounded buffer. Protected paths remain a precondition for all local commands.
function readBackup(path) {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= MAX_WALLET_BACKUP_BYTES, 'invalid backup file size/type');
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      assert.ok(count > 0, 'backup file changed during read'); offset += count;
    }
    assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, null), 0, 'backup file changed during read');
    return bytes;
  } finally { closeSync(fd); }
}

let wallet, key;
try {
  if (mode === 'inspect') {
    assert.ok(existsSync(database), 'wallet database must exist');
    wallet = new PoolWalletStore(database, profile.AUTHORITY);
    console.log('MOE_WALLET_RESULT=' + JSON.stringify({ kind: 'custody', ...wallet.custody(), pid: process.pid }));
  } else {
    const input = await readCommandInput();
    assert.ok(input && typeof input === 'object' && !Array.isArray(input) &&
      Object.keys(input).sort().join(',') === (mode === 'export' ? 'key' : 'digest,key') &&
      typeof input.key === 'string' && /^[0-9a-f]{64}$/.test(input.key) &&
      (mode === 'export' || (typeof input.digest === 'string' && /^[0-9a-f]{64}$/.test(input.digest))), 'invalid recovery credentials');
    key = Buffer.from(input.key, 'hex');
    if (mode === 'export') {
      assert.ok(existsSync(database), 'wallet database must exist');
      wallet = new PoolWalletStore(database, profile.AUTHORITY);
      assert.ok(!existsSync(file) || wallet.custody().frozen, 'backup destination already exists');
      const bytes = wallet.exportBackup(key), digest = walletBackupDigest(bytes);
      if (existsSync(file)) assert.ok(readBackup(file).equals(Buffer.from(bytes)), 'backup destination differs from frozen export');
      else {
        const fd = openSync(file, 'wx', 0o600);
        try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      }
      assert.equal(walletBackupDigest(readBackup(file)), digest, 'backup readback differs');
      console.log('MOE_WALLET_RESULT=' + JSON.stringify({ kind: 'exported', digest, bytes: bytes.length, frozen: true, pid: process.pid }));
    } else {
      // Never infer success from an existing destination or retry into a new one.
      assert.ok(!existsSync(database + '-journal'), 'recovery requires a new destination');
      wallet = PoolWalletStore.restoreBackup(database, profile.AUTHORITY, readBackup(file), key, input.digest);
      assert.equal(wallet.custody().restoredFrom, input.digest);
      console.log('MOE_WALLET_RESULT=' + JSON.stringify({ kind: 'restored', ...wallet.custody(), pid: process.pid }));
    }
  }
} finally { key?.fill(0); wallet?.close(); }
