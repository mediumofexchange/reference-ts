// Exercise exactly the tarball a consumer would install, outside this checkout.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const scratch = resolve('scratch');
mkdirSync(scratch, { recursive: true });
const directory = mkdtempSync(join(scratch, 'package-check-'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run check:package');
function run(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr ?? 'package check failed');
  }
  return result.stdout;
}
try {
  const packed = JSON.parse(run([npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', directory], process.cwd()));
  if (packed[0].files.some(file => file.path.startsWith('experiments/'))) {
    throw new Error('Research code must not ship as a supported package API');
  }
  if (packed[0].files.some(file => file.path.startsWith('src/'))) {
    throw new Error('The package ships built modules, not sources');
  }
  const consumer = join(directory, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'moe-package-consumer', private: true, type: 'module' }));
  run([npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packed[0].filename)], consumer);
  writeFileSync(join(consumer, 'check.mjs'), `
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';
import * as core from '@mediumofexchange/reference';
import { encodeRootTerms, decodeRootTerms, rootTermsName, rootTermsSignatureMessage, verifyRootTermsSignature } from '@mediumofexchange/reference/pool/v3/terms';
import { V3_SERVICE_PROFILE } from '@mediumofexchange/reference/pool/v3/service-wire';
import { V3ServiceClient } from '@mediumofexchange/reference/pool/v3/service-client';
import { commitmentOf } from '@mediumofexchange/reference/pool/notes';
import { MAX_WALLET_BACKUP_BYTES } from '@mediumofexchange/reference/pool/v3/wallet-backup';
import { ErgoVenue, DEFAULT_ERGO_DEPTH } from '@mediumofexchange/reference/ergo';
import { ergoNodeSupplier } from '@mediumofexchange/reference/ergo-supplier';
import { ed25519 } from '@noble/curves/ed25519.js';
for (const specifier of ['@mediumofexchange/reference', '@noble/curves/ed25519.js', '@noble/hashes/sha2.js']) {
  assert.ok(fileURLToPath(import.meta.resolve(specifier)).startsWith(process.cwd() + sep), 'dependency escaped installed consumer: ' + specifier);
}
const secret = new Uint8Array(32).fill(1), key = ed25519.getPublicKey(secret);
const terms = encodeRootTerms({ obligor: key, operator: key, configuration: new Uint8Array(32), venue: new Uint8Array(32), interval: 1n,
  payout: { thing: 'test', quantumExponent: 0, perUnit: 1n } });
assert.deepEqual(encodeRootTerms(decodeRootTerms(terms)), terms);
assert.equal(rootTermsName(terms).length, 32);
assert.ok(verifyRootTermsSignature(terms, ed25519.sign(rootTermsSignatureMessage(terms), secret)));
assert.equal(typeof core.verifySignatureStrict, 'function');
assert.equal(core.makeBacking, undefined);
assert.equal(core.commitmentOf, commitmentOf);
assert.equal(core.proofVerifier, undefined);
assert.equal(V3_SERVICE_PROFILE, 'pool-store/v3');
assert.equal(typeof V3ServiceClient, 'function');
assert.equal(core.V3ServiceClient, undefined);
assert.equal(MAX_WALLET_BACKUP_BYTES, 64 * 1024 * 1024);
assert.equal(typeof ErgoVenue, 'function');
assert.equal(DEFAULT_ERGO_DEPTH, 10n);
assert.equal(ergoNodeSupplier('http://127.0.0.1:9053/').name, 'http://127.0.0.1:9053');
assert.equal(core.ErgoVenue, undefined);
{
  // Every reader keeps its replay state in node:sqlite (storage decision 2026-09-29).
  const { ReplayStore } = await import('@mediumofexchange/reference/pool/v3/replay-store');
  const replay = new ReplayStore();
  assert.equal(replay.namespaces(new Uint8Array(32)).length, 0);
  replay.close();
  const { V3OperatorJournal, V3StoreError } = await import('@mediumofexchange/reference/pool/v3/store');
  const { V3Wallet } = await import('@mediumofexchange/reference/pool/v3/wallet-store');
  const { createV3Service } = await import('@mediumofexchange/reference/pool/v3/service-http');
  assert.equal(typeof createV3Service, 'function');
  assert.equal(core.createV3Service, undefined);
  assert.equal(typeof V3Wallet, 'function');
  assert.equal(core.V3Wallet, undefined);
  assert.equal(typeof V3OperatorJournal, 'function');
  assert.equal(typeof V3StoreError, 'function');
  assert.equal(core.V3OperatorJournal, undefined);
}
{
  // The installed package carries the six compiled relations and checks them against its manifest, with no
  // proving backend installed (pool-v3 §11.4).
  const { adoptedPrograms } = await import('@mediumofexchange/reference/pool/v3/programs');
  const { POOL_V3_MANIFEST } = await import('@mediumofexchange/reference/pool/v3/configuration');
  const { createHash } = await import('node:crypto');
  const programs = adoptedPrograms();
  assert.deepEqual(Object.keys(programs), Object.keys(POOL_V3_MANIFEST.circuits));
  for (const [name, program] of Object.entries(programs)) {
    assert.equal(createHash('sha256').update(Buffer.from(program.bytecode, 'base64')).digest('hex'), POOL_V3_MANIFEST.circuits[name].bytecode);
  }
}
{
  // The one executable ships as the package's bin and answers a usage error without a role (slice 10 M10b).
  const { readFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const manifest = new URL(import.meta.resolve('@mediumofexchange/reference/package.json'));
  assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')).bin, { moe: 'dist/cli/moe.js' });
  const usage = spawnSync(process.execPath, [fileURLToPath(new URL('dist/cli/moe.js', manifest))], { encoding: 'utf8', windowsHide: true });
  assert.equal(usage.status, 2, usage.stderr);
  assert.match(usage.stderr, /^usage: moe <role>/);
}
console.log('Built tarball consumer: imports, canonical round trip, signature and the moe bin passed');
`);
  process.stdout.write(run([join(consumer, 'check.mjs')], consumer));
} finally {
  const target = resolve(directory);
  if (!target.startsWith(scratch + sep)) throw new Error('unsafe scratch cleanup');
  rmSync(target, { recursive: true, force: true });
}
