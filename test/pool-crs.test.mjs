import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureParameter, PARAMETER_FILES, readParameters } from '../scripts/pool/prepare-crs.mjs';
import { BN254_PARAMETERS } from '../src/pool/parameters.js';

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

  it('falls back to the transcript at its offset, reordering each coordinate\'s limbs before the hash', async () => {
    const element = Buffer.from([...Array(32).keys()]), limbs = Buffer.concat([3, 2, 1, 0].map(j => element.subarray(8 * j, 8 * j + 8)));
    const point = { ...parameter, bytes: 32, transcript: 28, sha256: createHash('sha256').update(element).digest('hex') };
    const directory = await mkdtemp(join(tmpdir(), 'moe-crs-test-'));
    const transcript = (body, range = 'bytes 28-59/1000') => async (url, init) => {
      if (!url.includes('transcript00')) return response(Buffer.alloc(0));
      expect(init.headers.Range).toBe('bytes=28-59');
      return response(body, 206, { 'content-range': range });
    };
    try {
      for (const [body, range] of [[element, undefined], [limbs, 'bytes 0-31/1000'], [limbs, 'bytes 28-59/59']]) {
        await expect(ensureParameter(directory, point, options(transcript(body, range)))).rejects.toThrow('No verified');
        expect(await readdir(directory)).toEqual([]);
      }
      await ensureParameter(directory, point, options(transcript(limbs)));
      expect(await readFile(join(directory, point.name))).toEqual(element);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('accepts a longer cached copy by its leading bytes, and reads only those', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moe-crs-test-'));
    try {
      await writeFile(join(directory, parameter.name), Buffer.concat([good, Buffer.from([9, 9])]));
      await ensureParameter(directory, parameter, options(() => { throw new Error('a matching prefix should not fetch'); }));
      await writeFile(join(directory, parameter.name), Buffer.concat([Buffer.from([4, 3, 2, 1]), good]));
      await ensureParameter(directory, parameter, options(async () => response()));
      expect(await readFile(join(directory, parameter.name))).toEqual(good);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('pins the files the runtime checks, and hands their leading bytes over unjudged', async () => {
    expect(PARAMETER_FILES.map(p => [p.name, p.bytes, p.sha256])).toEqual([
      ['bn254_g1.dat', BN254_PARAMETERS.points * 64, BN254_PARAMETERS.g1], ['bn254_g2.dat', 128, BN254_PARAMETERS.g2]]);
    const directory = await mkdtemp(join(tmpdir(), 'moe-crs-test-'));
    try {
      await expect(readParameters(directory)).rejects.toThrow('No proving parameters');
      await writeFile(join(directory, 'bn254_g1.dat'), good);
      await writeFile(join(directory, 'bn254_g2.dat'), Buffer.alloc(200, 7));
      const { g1, g2 } = await readParameters(directory);
      expect(g1).toEqual(good);
      expect(g2).toEqual(Buffer.alloc(128, 7));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
