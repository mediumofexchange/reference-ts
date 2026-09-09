// Reproducible test parameters for bb.js 5.2.0's default 2^19 BN254 points.
// Identities match docs/pool-v2-verification.json and fresh downloads from both
// upstream hosts. This does not attest to ceremony trust or pin a v3 config.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hosts = ['https://crs.aztec-cdn.foundation', 'https://crs.aztec-labs.com'];
const parameters = [
  { name: 'bn254_g1_compressed.dat', source: 'g1_compressed.dat', bytes: 16777216, range: true,
    sha256: '1d03ebeb73e1a6d426e44a2ccc88b04125ca185ab9d1679817380502a723fa80' },
  { name: 'bn254_g2.dat', source: 'g2.dat', bytes: 128, range: false,
    sha256: '01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f' },
  { name: 'grumpkin_g1_v2.flat.dat', source: 'grumpkin_g1_v2.dat', bytes: 4194304, range: true,
    sha256: '64236c9455e75aeea77a94587ea607eed2e978d2609a421d66bf10bb9698b8fd' },
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const matches = (bytes, parameter) => bytes.length === parameter.bytes && sha(bytes) === parameter.sha256;

export async function ensureParameter(directory, parameter, { fetchImpl = fetch, log = console.log } = {}) {
  const target = join(directory, parameter.name);
  try {
    if (matches(await readFile(target), parameter)) return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const failures = [];
  for (const host of hosts) {
    let response;
    try {
      response = await fetchImpl(`${host}/${parameter.source}`, {
        headers: parameter.range ? { Range: `bytes=0-${parameter.bytes - 1}` } : {},
        signal: AbortSignal.timeout(60_000), cache: 'no-store',
      });
      if (response.status !== (parameter.range ? 206 : 200)) throw new Error(`HTTP ${response.status}`);
      if (parameter.range) {
        const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
        if (!range || BigInt(range[1]) !== BigInt(parameter.bytes - 1) || BigInt(range[2]) < BigInt(parameter.bytes)) {
          throw new Error('incorrect Content-Range');
        }
      }
      const length = response.headers.get('content-length');
      if (length !== null && length !== String(parameter.bytes)) throw new Error('incorrect Content-Length');
      if (!response.body) throw new Error('missing body');
      const chunks = [];
      let received = 0;
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > parameter.bytes) throw new Error('oversized body');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (!matches(bytes, parameter)) throw new Error(`length or SHA-256 mismatch (${received} bytes)`);
      // A bad response never occupies the reusable cache, even after interruption.
      await mkdir(directory, { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { flag: 'wx' });
        await rename(temporary, target);
      } finally { await rm(temporary, { force: true }); }
      log(`Verified ${parameter.name}: ${received} bytes from ${host}`);
      return;
    } catch (error) {
      failures.push(`${host}: ${error.message}`);
      log(`Rejected ${parameter.name} from ${host}: ${error.message}`);
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
  throw new Error(`No verified ${parameter.name}: ${failures.join('; ')}`);
}

export async function prepareCrs(directory) {
  // bb.js prefers uncompressed G1 when present; verify that path as well.
  try {
    const bytes = await readFile(join(directory, 'bn254_g1.dat'));
    if (bytes.length !== 33554432 || sha(bytes) !== 'ea7b37bb4e1840b5632675fb2d79873ac0a1598374d3087344ba0e980736b8ac') {
      throw new Error('Uncompressed G1 cache differs from the recorded test parameters');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const parameter of parameters) await ensureParameter(directory, parameter);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareCrs(fileURLToPath(new URL('../../scratch/private-payment-crs/', import.meta.url)));
}
