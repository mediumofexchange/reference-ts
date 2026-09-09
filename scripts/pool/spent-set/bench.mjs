import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { SpentSet } from '../../../dist/pool/spent-set.js';
import { RadixSpentSet } from './radix.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest();
const keys = Array.from({ length: 100000 }, (_, i) => hash(Buffer.from(`A22/benchmark/${i}`)));
const run = (Type, count, reverse = false) => {
  const set = new Type();
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    set.insert(keys[reverse ? count - 1 - i : i]);
    set.root(); // Per-statement checkpoint: never defer root work to the end.
  }
  const ms = performance.now() - start;
  return { set, ms };
};
run(SpentSet, 128); run(RadixSpentSet, 128);
const measurements = [];
for (const count of [128, 1024, 8192, 100000]) {
  const old = run(SpentSet, count), candidate = run(RadixSpentSet, count);
  const reversed = run(RadixSpentSet, count, true);
  assert.deepEqual(candidate.set.root(), reversed.set.root());
  const row = { keys: count, v2Ms: old.ms, radixMs: candidate.ms, reverseRadixMs: reversed.ms,
    speedup: old.ms / candidate.ms, radixHashes: candidate.set.hashes.toString(),
    radixHashesPerInsert: Number(candidate.set.hashes) / count,
    v2Root: Buffer.from(old.set.root()).toString('hex'),
    radixRoot: Buffer.from(candidate.set.root()).toString('hex') };
  measurements.push(row); console.log(JSON.stringify(row));
}
const sourceHash = file => hash(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).toString('hex');
const sources = Object.fromEntries(['radix.mjs', 'check.mjs', 'bench.mjs'].map(file =>
  [`scripts/pool/spent-set/${file}`, sourceHash(new URL(file, import.meta.url))]));
sources['src/pool/spent-set.ts'] = sourceHash(new URL('../../../src/pool/spent-set.ts', import.meta.url));
const report = { schema: 1, specification: '78f8a8c8e4264ee8a406ea6dab91e02836c8272c',
  sourceHashEncoding: 'SHA-256 of UTF-8 source with CRLF normalized to LF',
  node: process.version, platform: process.platform, arch: process.arch,
  cpu: cpus()[0]?.model, methodology: 'One measured run per size after 128-key warmup; deterministic SHA-256 keys; root read after every insert; same noble SHA-256 for both shapes. Timings are observations, not pass thresholds. Reverse candidate checks root order independence. Not full protocol replay, memory or mobile evidence.',
  sources, measurements };
const output = new URL('../../../scratch/pool-spent-set/', import.meta.url);
mkdirSync(output, { recursive: true });
writeFileSync(new URL('report.json', output), JSON.stringify(report, null, 2) + '\n');
