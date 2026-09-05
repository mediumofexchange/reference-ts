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
  const consumer = join(directory, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'moe-package-consumer', private: true, type: 'module' }));
  run([npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packed[0].filename)], consumer);
  writeFileSync(join(consumer, 'check.mjs'), `
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';
import * as core from '@mediumofexchange/reference';
import { makeBacking, encodeBacking, decodeBacking, signBacking, verifyBackingSignature } from '@mediumofexchange/reference/backing';
import { PILOT_PROFILE } from '@mediumofexchange/reference/pilot-wire';
import { ed25519 } from '@noble/curves/ed25519.js';
for (const specifier of ['@mediumofexchange/reference', '@noble/curves/ed25519.js', '@noble/hashes/sha2.js']) {
  assert.ok(fileURLToPath(import.meta.resolve(specifier)).startsWith(process.cwd() + sep), 'dependency escaped installed consumer: ' + specifier);
}
const secret = new Uint8Array(32).fill(1), key = ed25519.getPublicKey(secret);
const backing = makeBacking({ obligor: key, payout: { thing: 'test', quantumExponent: 0, perUnit: 1n }, reliance: [], evidence: { setting: 'transparent', operator: key } });
assert.equal(decodeBacking(encodeBacking(backing)).nameHex, backing.nameHex);
assert.ok(verifyBackingSignature(backing, signBacking(secret, backing)));
assert.equal(typeof core.makeBacking, 'function');
assert.equal(PILOT_PROFILE, 'transparent-pilot/v0-directory-v1');
if (Number(process.versions.node.split('.')[0]) >= 24) {
  const { PilotStore } = await import('@mediumofexchange/reference/pilot-store');
  const { createPilotServer } = await import('@mediumofexchange/reference/pilot-http');
  assert.equal(typeof PilotStore, 'function');
  assert.equal(typeof createPilotServer, 'function');
}
console.log('Built tarball consumer: imports, canonical round trip and signature passed');
`);
  process.stdout.write(run([join(consumer, 'check.mjs')], consumer));
} finally {
  const target = resolve(directory);
  if (!target.startsWith(scratch + sep)) throw new Error('unsafe scratch cleanup');
  rmSync(target, { recursive: true, force: true });
}
