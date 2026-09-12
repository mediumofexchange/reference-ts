// Caller-configured local holder. No issuance or ideal-proof fallback.
import assert from 'node:assert/strict';
import { readLocalProfile } from './profile.mjs';
import { readCommandInput, runWalletCommand } from '../wallet/operation.mjs';

const [mode, database, profileFile, trustedDigest, baseUrl, evidenceFile, ledgerFile, compiled = ''] = process.argv.slice(2);
assert.ok([mode, database, profileFile, trustedDigest, baseUrl, evidenceFile, ledgerFile].every(v => typeof v === 'string') &&
  process.argv.slice(2).length <= 8, 'usage: holder.mjs mode database profileFile trustedDigest baseUrl evidenceFile ledgerFile [compiled]');
assert.ok(['request', 'enroll', 'status', 'prepare', 'submit', 'deliver', 'receive', 'change'].includes(mode), 'unknown holder command');
const profile = readLocalProfile(profileFile, trustedDigest);
const input = await readCommandInput();
assert.ok(input && typeof input === 'object' && !Array.isArray(input) &&
  Object.keys(input).sort().join(',') === 'command,walletToken' &&
  typeof input.walletToken === 'string' && /^[0-9a-f]{64}$/.test(input.walletToken), 'invalid holder input');
const result = await runWalletCommand({ mode, database, baseUrl, evidenceFile, ledgerFile, compiled,
  profile: { ...profile, WALLET: input.walletToken }, body: input.command,
  openProofs: async directory => (await import('../wallet/proofs.mjs')).openWalletProofs(directory),
  requireRealProofs: true });
console.log('MOE_WALLET_RESULT=' + JSON.stringify(result));
