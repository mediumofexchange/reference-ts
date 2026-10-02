// The proving parameters the reference loads (pool-v3 §4), fetched and verified
// before they are cached: the leading 2^15 uncompressed BN254 G1 points (a
// prefix of the CDN's `g1.dat`) and `[x]_2`. Both equal Aztec Ignition
// transcript00's leading points (docs/POOL_DEPLOYMENT_PROBES.md#proving-parameters):
// their source, not the ceremony's trust. The runtime checks the same hashes
// again before loading (`startBackend`, `proof-verifier.ts`); each entry here is
// `BN254_PARAMETERS`' (`parameters.ts`). A `moe` directory caches the two files
// at `init` (slice 10 M10b, item 11); `scripts/pool/prepare-crs.mjs` caches them
// for the checks.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BN254_PARAMETERS } from "./parameters.js";

const hosts = ["https://crs.aztec-cdn.foundation", "https://crs.aztec-labs.com"];
// The last source: the transcript itself, where the CDN hosts are unreachable. Its points start after a 28-byte
// header (5,040,001 G1, then 2 G2); each coordinate is four big-endian u64 limbs, least significant first.
const TRANSCRIPT = "https://aztec-ignition.s3.eu-west-2.amazonaws.com/MAIN%20IGNITION/monomial/transcript00.dat";

/** One cached parameter: its leading `bytes` are the parameter, so a longer copy (such as all 2^19 points) is
 * read by its prefix. `range` asks a host for the prefix; `transcript` is its offset in the transcript. */
export interface ParameterFile {
  readonly name: string;
  readonly source: string;
  readonly bytes: number;
  readonly range: boolean;
  readonly transcript?: number;
  readonly sha256: string;
}
export const PARAMETER_FILES: readonly ParameterFile[] = Object.freeze([
  Object.freeze({ name: "bn254_g1.dat", source: "g1.dat", bytes: BN254_PARAMETERS.points * 64, range: true, transcript: 28,
    sha256: BN254_PARAMETERS.g1 }),
  Object.freeze({ name: "bn254_g2.dat", source: "g2.dat", bytes: 128, range: false, transcript: 28 + 64 * 5040001,
    sha256: BN254_PARAMETERS.g2 }),
]);

/** How parameters are fetched: the caller's `fetch` and where progress goes. */
export interface FetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
}

/** A transcript coordinate's limbs in the files' order: each 32-byte element big-endian. */
const fromTranscript = (bytes: Buffer): Buffer => Buffer.concat([...Array(bytes.length / 32).keys()].flatMap(i =>
  [3, 2, 1, 0].map(j => bytes.subarray(32 * i + 8 * j, 32 * i + 8 * j + 8))));
/** Where a parameter is fetched from, in order; the hash decides, not the host. */
const sources = (parameter: ParameterFile) => [
  ...hosts.map(host => ({ host, url: `${host}/${parameter.source}`, first: parameter.range ? 0 : undefined, convert: (bytes: Buffer) => bytes })),
  ...(parameter.transcript === undefined ? [] : [{ host: TRANSCRIPT, url: TRANSCRIPT, first: parameter.transcript, convert: fromTranscript }]),
];
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const matches = (bytes: Uint8Array, parameter: ParameterFile): boolean => bytes.length === parameter.bytes && sha(bytes) === parameter.sha256;

/** A file's leading `bytes` bytes, fewer if it is shorter; undefined if it does not exist. */
async function leading(path: string, bytes: number): Promise<Buffer | undefined> {
  let handle;
  try { handle = await open(path, "r"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const buffer = Buffer.alloc(bytes);
    let read = 0;
    for (let n; read < bytes && (n = (await handle.read(buffer, read, bytes - read, read)).bytesRead) > 0;) read += n;
    return buffer.subarray(0, read);
  } finally { await handle.close(); }
}

/** Write `bytes` at `target` through a temporary file, so a bad or interrupted write never occupies the cache. */
async function place(directory: string, target: string, bytes: Uint8Array): Promise<void> {
  await mkdir(directory, { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

/** Cache `parameter` in `directory` unless a matching copy is there: fetched from each source in turn, kept only
 * when its length and hash are the parameter's. Throws once every source failed. */
export async function ensureParameter(directory: string, parameter: ParameterFile, options: FetchOptions = {}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch, log = options.log ?? (() => {});
  const target = join(directory, parameter.name);
  const cached = await leading(target, parameter.bytes);
  if (cached !== undefined && matches(cached, parameter)) return;
  const failures: string[] = [];
  for (const { host, url, first, convert } of sources(parameter)) {
    let response: Response | undefined;
    try {
      const last = first === undefined ? undefined : first + parameter.bytes - 1;
      response = await fetchImpl(url, {
        headers: first === undefined ? {} : { Range: `bytes=${first}-${last}` },
        signal: AbortSignal.timeout(60_000), cache: "no-store",
      });
      if (response.status !== (first === undefined ? 200 : 206)) throw new Error(`HTTP ${response.status}`);
      if (first !== undefined) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
        if (!range || BigInt(range[1]!) !== BigInt(first) || BigInt(range[2]!) !== BigInt(last!) || BigInt(range[3]!) <= BigInt(last!)) {
          throw new Error("incorrect Content-Range");
        }
      }
      const length = response.headers.get("content-length");
      if (length !== null && length !== String(parameter.bytes)) throw new Error("incorrect Content-Length");
      if (!response.body) throw new Error("missing body");
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > parameter.bytes) throw new Error("oversized body");
        chunks.push(Buffer.from(chunk));
      }
      const bytes = received === parameter.bytes ? convert(Buffer.concat(chunks)) : Buffer.concat(chunks);
      if (!matches(bytes, parameter)) throw new Error(`length or SHA-256 mismatch (${received} bytes)`);
      await place(directory, target, bytes);
      log(`Verified ${parameter.name}: ${received} bytes from ${host}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${host}: ${message}`);
      log(`Rejected ${parameter.name} from ${host}: ${message}`);
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
  throw new Error(`No verified ${parameter.name}: ${failures.join("; ")}`);
}

/** Cache both parameters in `directory`, fetching what is missing. */
export async function prepareParameters(directory: string, options: FetchOptions = {}): Promise<void> {
  for (const parameter of PARAMETER_FILES) await ensureParameter(directory, parameter, options);
}

/** Cache both parameters in `directory` from a local copy in `from` (an offline install), each kept only when its
 * leading bytes are the parameter's. */
export async function copyParameters(from: string, directory: string): Promise<void> {
  for (const parameter of PARAMETER_FILES) {
    const bytes = await leading(join(from, parameter.name), parameter.bytes);
    if (bytes === undefined || !matches(bytes, parameter)) throw new Error(`No verified ${parameter.name} in ${from}`);
    await place(directory, join(directory, parameter.name), bytes);
  }
}

/**
 * The parameter bytes as `startBackend` takes them: each file's leading bytes,
 * unjudged here (the runtime checks them), with where they were read from.
 * The cache keeps the bytes, not the host that served them; either host's
 * bytes are the same, which the hash shows.
 */
export async function readParameters(directory: string) {
  const [g1, g2] = await Promise.all(PARAMETER_FILES.map(p => leading(join(directory, p.name), p.bytes)));
  if (g1 === undefined || g2 === undefined) throw new Error(`No proving parameters in ${directory}; run scripts/pool/prepare-crs.mjs`);
  const source = { directory, files: Object.fromEntries(PARAMETER_FILES.map((p, i) => [p.name, { leadingBytes: [g1, g2][i]!.length }])) };
  return { g1, g2, source };
}

