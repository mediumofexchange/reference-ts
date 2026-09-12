import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertLocalPaths } from './paths.mjs';

const root = mkdtempSync(join(process.cwd(), 'scratch', 'local-path-check-'));
const file = name => join(root, name), db = file('wallet.db'), profile = file('profile.json'), ledger = file('ledger.json'), evidence = file('evidence.bin');
assert.deepEqual(Object.keys(assertLocalPaths(db, profile, ledger, evidence)).sort(), ['database', 'evidenceFile', 'ledgerFile', 'profileFile']);
assert.throws(() => assertLocalPaths(db, db, ledger, evidence), /collides/);
assert.throws(() => assertLocalPaths(db, file('wallet.db-wal'), ledger, evidence), /collides/);
assert.throws(() => assertLocalPaths(db, file('profile.json'), file('profile.json'), evidence), /collides/);
writeFileSync(db, 'db'); writeFileSync(profile, 'profile'); writeFileSync(ledger, 'ledger'); writeFileSync(evidence, 'evidence');
for (const suffix of ['-wal', '-shm', '-journal']) { writeFileSync(db + suffix, suffix); assert.throws(() => assertLocalPaths(db, db + suffix, ledger, evidence), /collides/); }
assert.throws(() => assertLocalPaths(root, profile, ledger, evidence), /directory/);
const hard = file('hardlink'); linkSync(profile, hard); assert.throws(() => assertLocalPaths(db, profile, hard, evidence), /collides/);
try { const linkDir = file('alias'); symlinkSync(root, linkDir, 'junction'); assert.throws(() => assertLocalPaths(db, join(linkDir, 'profile.json'), profile, evidence), /collides/); } catch (error) { if (!['EPERM', 'EEXIST', 'UNKNOWN'].includes(error?.code)) throw error; }
try { const dbAlias = file('wallet-alias.db'); symlinkSync(db, dbAlias, 'file'); assert.throws(() => assertLocalPaths(dbAlias, db + '-wal', ledger, evidence), /collides/); } catch (error) { if (!['EPERM', 'EEXIST', 'UNKNOWN'].includes(error?.code)) throw error; }
const nested = file('new/deeper/profile.json'); assert.doesNotThrow(() => assertLocalPaths(file('new/wallet.db'), nested, file('new/ledger.json'), file('new/evidence.bin')));
if (process.platform === 'win32') {
  for (const unsafe of ['review-new.db.', 'review-new.db ', 'review-new.db::$DATA', 'review-new.db:stream']) {
    assert.throws(() => assertLocalPaths('review-new.db', 'review-profile.json', 'review-ledger.json', unsafe), /unsafe/);
  }
  assert.throws(() => assertLocalPaths(db, file('Profile.json'), profile.toUpperCase(), evidence), /collides/);
  assert.throws(() => assertLocalPaths(file('foo. '), ledger, evidence, file('other')), /unsafe/);
  assert.throws(() => assertLocalPaths(file('foo::$DATA'), ledger, evidence, file('other')), /unsafe/);
}
rmSync(root, { recursive: true, force: true });
console.log('local path checks passed');
