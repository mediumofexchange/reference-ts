// The proving parameters the reference loads (pool-v3 §4), fetched and verified
// before they are cached: the leading 2^15 uncompressed BN254 G1 points (a
// prefix of the CDN's `g1.dat`) and `[x]_2`. Both equal Aztec Ignition
// transcript00's leading points (docs/POOL_DEPLOYMENT_PROBES.md#proving-parameters):
// their source, not the ceremony's trust. The runtime checks the same hashes
// again before loading (`startBackend`, src/pool/proof-verifier.ts); a test
// holds these entries equal to its `BN254_PARAMETERS`.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hosts = ['https://crs.aztec-cdn.foundation', 'https://crs.aztec-labs.com'];
/** Each file's leading `bytes` are the parameter; a longer copy (such as all 2^19 points) is read by its prefix. */
export const PARAMETER_FILES = Object.freeze([
  Object.freeze({ name: 'bn254_g1.dat', source: 'g1.dat', bytes: 2097152, range: true,
    sha256: '50d2f4e9567be2b8e382cedfd078b96a3428a94597b7e88c4116e105d578ce77' }),
  Object.freeze({ name: 'bn254_g2.dat', source: 'g2.dat', bytes: 128, range: false,
    sha256: '01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f' }),
]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const matches = (bytes, parameter) => bytes.length === parameter.bytes && sha(bytes) === parameter.sha256;

/** A file's leading `bytes` bytes, fewer if it is shorter; undefined if it does not exist. */
async function leading(path, bytes) {
  let handle;
  try { handle = await open(path, 'r'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  try {
    const buffer = Buffer.alloc(bytes);
    let read = 0;
    for (let n; read < bytes && (n = (await handle.read(buffer, read, bytes - read, read)).bytesRead) > 0;) read += n;
    return buffer.subarray(0, read);
  } finally { await handle.close(); }
}

export async function ensureParameter(directory, parameter, { fetchImpl = fetch, log = console.log } = {}) {
  const target = join(directory, parameter.name);
  const cached = await leading(target, parameter.bytes);
  if (cached !== undefined && matches(cached, parameter)) return;
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
  for (const parameter of PARAMETER_FILES) await ensureParameter(directory, parameter);
}

/**
 * The parameter bytes as `startBackend` takes them: each file's leading bytes,
 * unjudged here (the runtime checks them), with where they were read from.
 * The cache keeps the bytes, not the host that served them; either host's
 * bytes are the same, which the hash shows.
 */
export async function readParameters(directory) {
  const [g1, g2] = await Promise.all(PARAMETER_FILES.map(p => leading(join(directory, p.name), p.bytes)));
  if (g1 === undefined || g2 === undefined) throw new Error(`No proving parameters in ${directory}; run scripts/pool/prepare-crs.mjs`);
  const source = { directory, files: Object.fromEntries(PARAMETER_FILES.map((p, i) => [p.name, { leadingBytes: [g1, g2][i].length }])) };
  return { g1, g2, source };
}

/** The reference's parameter directory. */
export const PARAMETER_DIRECTORY = fileURLToPath(new URL('../../scratch/private-payment-crs/', import.meta.url));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareCrs(PARAMETER_DIRECTORY);
}
