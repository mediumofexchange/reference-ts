// Public-key fixture wrapper; configured holders use local/holder.mjs.
import assert from 'node:assert/strict';
import { sha256 } from '@noble/hashes/sha2.js';
import { statementBytes } from '@mediumofexchange/reference/pool/statement';
import { IdealVerifier } from '../service/fixture.mjs';
import { BACKER_SECRET, walletProfile } from './profile.mjs';
import { issueFixture } from './fixture-issue.mjs';
import { runWalletCommand, readCommandInput } from './operation.mjs';
const [mode, database, baseUrl, evidenceFile, ledgerFile, compiled = ''] = process.argv.slice(2);
assert.ok([mode, database, baseUrl, evidenceFile, ledgerFile].every(v => typeof v === 'string') && process.argv.slice(2).length <= 6,
  'usage: commands.mjs mode database baseUrl evidenceFile ledgerFile [compiled]');
const profile = { ...walletProfile(Boolean(compiled)), BACKER_SECRET };
const result = await runWalletCommand({ mode, database, baseUrl, evidenceFile, ledgerFile, compiled, profile,
  body: await readCommandInput(), verifier: new IdealVerifier(), issue: issueFixture,
  openProofs: async dir => (await import('./proofs.mjs')).openWalletProofs(dir),
  prove: (kind, inputs) => Promise.resolve(sha256(statementBytes(profile.DOMAIN, kind, inputs))) });
console.log('MOE_WALLET_RESULT=' + JSON.stringify(result));
