import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureParameter, prepareCrs } from '../scripts/pool/prepare-crs.mjs';

const good = Buffer.from([1, 2, 3, 4]);
const parameter = { name: 'test.dat', source: 'test.dat', bytes: 4, range: true,
  sha256: createHash('sha256').update(good).digest('hex') };
const response = (body = good, status = 206, headers = { 'content-range': 'bytes 0-3/100' }) => new Response(body, { status, headers });
const options = fetchImpl => ({ fetchImpl, log: () => {} });

describe('verified proving parameter download', () => {
  for (const [name, bad] of [
    ['empty successful body (Linux CI regression)', () => response(Buffer.alloc(0))],
    ['truncated body', () => response(good.subarray(0, 2))],
    ['same-length corrupt body', () => response(Buffer.from([4, 3, 2, 1]))],
    ['ignored Range', () => response(good, 200)],
    ['wrong range', () => response(good, 206, { 'content-range': 'bytes 4-7/100' })],
    ['wrong length header', () => response(good, 206, { 'content-range': 'bytes 0-3/100', 'content-length': '0' })],
    ['oversized body', () => response(Buffer.alloc(5))],
    ['network failure', () => { throw new Error('network failure'); }],
  ]) it(`rejects ${name} before caching and uses fallback`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moe-crs-test-'));
    const calls = [];
    try {
      await ensureParameter(directory, parameter, options(async (url, init) => {
        calls.push(url);
        expect(init.headers.Range).toBe('bytes=0-3');
        expect(await readdir(directory)).toEqual([]);
        return calls.length === 1 ? bad() : response();
      }));
      expect(calls).toEqual(['https://crs.aztec-cdn.foundation/test.dat', 'https://crs.aztec-labs.com/test.dat']);
      expect(await readFile(join(directory, parameter.name))).toEqual(good);
      expect(await readdir(directory)).toEqual([parameter.name]);
      await ensureParameter(directory, parameter, options(() => { throw new Error('valid cache should not fetch'); }));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('fails closed if both sources are invalid and repairs a stale empty cache only with verified bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moe-crs-test-'));
    const target = join(directory, parameter.name);
    try {
      await writeFile(target, Buffer.alloc(0));
      await expect(ensureParameter(directory, parameter, options(async () => response(Buffer.alloc(0))))).rejects.toThrow('No verified');
      expect(await readFile(target)).toHaveLength(0);
      expect(await readdir(directory)).toEqual([parameter.name]);
      await ensureParameter(directory, parameter, options(async () => response()));
      expect(await readFile(target)).toEqual(good);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects an unverified uncompressed cache that bb.js would prefer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moe-crs-test-'));
    try {
      await writeFile(join(directory, 'bn254_g1.dat'), good);
      await expect(prepareCrs(directory)).rejects.toThrow('Uncompressed G1 cache differs');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
