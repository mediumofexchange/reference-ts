// Proof verification under Barretenberg 5.2.0's UltraHonk over BN254 with the
// verifier target `noir-recursive`, which is the zero-knowledge mode (pool-v3
// §4). The backend's legacy `keccak` mode disables zero knowledge and is no
// construction here.
//
// A construction passes its circuits as data — each statement kind, the name
// of its compiled artifact and its public-input count — with its proof-size
// bound. The verifier derives one key per kind from the artifact's bytecode,
// names each circuit's identity for the caller to pin against its
// configuration, and verifies a kind against that kind's key and nothing else;
// it never accepts a verification key supplied with a statement.
// `v3/verifier.ts` binds pool-v3's table to the package's shipped relations.
//
// Every backend instance is started here from proving parameters whose hashes
// match `BN254_PARAMETERS` (`parameters.ts`, pool-v3 §4's check before loading);
// the backend's own loader, which reads an unchecked directory or downloads,
// is never used.
// This module, `v3/prover.ts` and `poseidon2.ts` (the host hash, on an
// instance of its own that loads no parameters) are the only ones that import
// `@aztec/bb.js`, an exact-pinned dependency.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Barretenberg, BackendType, findBbBinary, UltraHonkBackend, UltraHonkVerifierBackend } from "@aztec/bb.js";
import { BN254_PARAMETERS, CHECK_SET_PARAMETERS, EXHAUSTION_PARAMETERS } from "./parameters.js";
import { copyArray, copyBytes, copyUnshared, EncodingError } from "../bytes.js";
import { fieldToHex, isField } from "./field.js";
import { PACKAGED_BINARY_REFUSAL, packagedBinary } from "./packaged-binary.js";

/** The proof options every construction here is defined under. */
export const PROOF_OPTIONS = Object.freeze({ verifierTarget: "noir-recursive" as const });

/** The compiler's artifact for one circuit, as the compile scripts write it. */
export interface CompiledProgram {
  readonly noir_version: string;
  /** Base64 of the compressed ACIR bytecode; a circuit's bytecode identity hashes its decoded bytes. */
  readonly bytecode: string;
}

/** SHA-256 of a circuit's compiled bytecode and of its verification key. */
export interface CircuitIdentity {
  readonly bytecode: Uint8Array;
  readonly vk: Uint8Array;
  /** The statement kind whose proofs are verified under this key. */
  readonly kind: number;
}

/** One circuit of a construction: the statement kind it proves, its artifact's name, its public-input count. */
export interface CircuitEntry {
  readonly kind: number;
  readonly name: string;
  readonly publicInputs: number;
}

/** A construction's circuits and the largest proof it admits (a positive multiple of 32 bytes). */
export interface CircuitTable {
  readonly circuits: readonly CircuitEntry[];
  readonly maxProofBytes: number;
}

export interface ProofVerifier extends KeyedVerifier {
  /** Each circuit's identity, by artifact name, derived here from the bytecode the caller supplied. */
  readonly identities: Readonly<Record<string, CircuitIdentity>>;
}

/** A verifier over keys it holds, by kind. */
export interface KeyedVerifier {
  /** False for a kind outside the table, a wrong count of canonical fields, malformed proof bytes or a proof that fails. */
  verify(kind: number, publicInputs: readonly bigint[], proof: Uint8Array): Promise<boolean>;
  /** How many verifications run at once, each on an instance of its own, off the caller's thread. */
  readonly parallel: number;
  /** Destroys the verifier's own backend instances; later verifications refuse. */
  close(): Promise<void>;
}

/** How the verifier's own instances run: `instances` of them (default one), each a WASM worker whose memory settles
 * near 85 MB once it has verified (the M5b.6 probe); a party sizes the count against its 1 GiB budget. */
export interface VerifierOptions extends BackendOptions {
  readonly instances?: number;
}
/** The most instances one verifier starts. */
const MAX_INSTANCES = 64;

const POINT_BYTES = 64;
const G2_BYTES = 128;

/** The parameter bytes a caller obtained, from wherever it keeps or fetches them. */
export interface ProvingParameters {
  readonly g1: Uint8Array;
  readonly g2: Uint8Array;
}

/** Parameter bytes that are not `BN254_PARAMETERS`' layout, an instance not started from them, or a replaced backend binary. */
export class ParameterError extends Error {
  constructor(readonly code: "G1" | "G2" | "UNCHECKED" | "BACKEND", message: string) {
    super(message); this.name = "ParameterError";
  }
}

/** How a backend instance runs. */
export interface BackendOptions {
  readonly threads?: number;
}

/** How `startCheckSetBackend` starts an instance. */
export interface CheckSetBackendOptions extends BackendOptions {
  /** On the native binary the pinned bb.js bundles (`nativeRefusal`), not its WebAssembly (slice 42). */
  readonly native?: boolean;
}

// Every instance `startBackend` loaded, with what the verifier's own instances
// load: `[1]_1` and `[x]_2`. Verification given a key reads nothing else (§4).
const STARTED = new WeakMap<Barretenberg, { readonly generator: Uint8Array; readonly g2: Uint8Array; readonly points: number }>();

/** An owned copy of one input, judged by its own length and hash. */
function checked(value: unknown, code: "G1" | "G2", length: number, expected: string): Uint8Array {
  let own: Uint8Array;
  try {
    own = copyUnshared(value as Uint8Array);
  } catch (error) {
    if (error instanceof EncodingError) throw new ParameterError(code, `the BN254 ${code} parameters are not bytes`);
    throw error;
  }
  if (own.length !== length || bytesToHex(sha256(own)) !== expected) {
    throw new ParameterError(code, `the BN254 ${code} parameters are not the manifest's`);
  }
  return own;
}

/**
 * bb.js runs the WASM binary `BB_WASM_PATH` names instead of its own, and
 * that binary is what refuses any other `[x]_2` and derives the keys (§4), so
 * a backend starts only without it. Checked at every start, since the
 * environment can change between them. A browser bundle starts one only
 * cross-origin isolated, where bb.js loads the binary the package ships
 * (packaged-binary.ts, slice 39).
 */
function pinnedBackend(): void {
  if (typeof process !== "undefined" && process.env?.BB_WASM_PATH !== undefined) {
    throw new ParameterError("BACKEND", "BB_WASM_PATH would replace the pinned backend's WASM");
  }
  if (!packagedBinary()) throw new ParameterError("BACKEND", PACKAGED_BINARY_REFUSAL);
}

/** A WASM worker instance holding `count` G1 points and G2, and no Grumpkin points (UltraHonk reads none). */
async function load(points: Uint8Array, count: number, g2: Uint8Array, threads: number | undefined): Promise<Barretenberg> {
  pinnedBackend();
  const api = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: threads ?? 1, skipSrsInit: true });
  try {
    await api.srsInitSrs({ pointsBuf: copyBytes(points), numPoints: count, g2Point: copyBytes(g2) });
  } catch (error) {
    await api.destroy().catch(() => {});
    throw error;
  }
  return api;
}

/** The version the bundled `bb` reports, which the pinned bb.js's is. */
const NATIVE_VERSION = /^5\.2\.0(?:-|$)/;
/** Each bundled binary's answer to `--version`, asked once per process. */
const ran = new Map<string, string | undefined>();

/**
 * Why this host starts no native backend, or undefined where it does. bb.js
 * bundles its native `bb` for Linux and macOS on x64 and arm64 and runs the
 * file `BB_BINARY_PATH` names in its place, so a native start refuses that
 * variable as a WebAssembly one refuses `BB_WASM_PATH`. A bundled binary
 * may still not run here (it needs glibc 2.34 on Linux), so it is asked for
 * its version once, which must be the pinned package's.
 */
export function nativeRefusal(): string | undefined {
  if (typeof MOE_BROWSER_CODE === "string" || typeof process === "undefined") return "a browser host runs no native backend";
  if (process.env.BB_BINARY_PATH !== undefined) return "BB_BINARY_PATH would replace the pinned backend's native binary";
  const bbPath = findBbBinary();
  if (bbPath === null) return `the pinned bb.js bundles no native backend for ${process.platform}-${process.arch}`;
  if (!ran.has(bbPath)) {
    const { spawnSync } = process.getBuiltinModule("node:child_process");
    const answer = spawnSync(bbPath, ["--version"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    const version = answer.status === 0 ? answer.stdout.trim() : "";
    ran.set(bbPath, NATIVE_VERSION.test(version) ? undefined
      : `the bundled native backend does not run here (${version || answer.error?.message || answer.stderr.trim().split("\n")[0] || `exit ${answer.status ?? answer.signal}`})`);
  }
  return ran.get(bbPath);
}

/**
 * A native instance proving from the checked `points` (slice 42). The native
 * `bb` proves from points it reads from the directory `CRS_PATH` names (by
 * default `~/.bb-crs`), fetching them over plain HTTP where that holds too
 * few, and `srsInitSrs` does not change them. So each instance gets a private
 * directory holding exactly the checked bytes, as many as every check-set
 * circuit reads, and nothing is fetched; it is removed when the instance is
 * destroyed. bb.js passes this process's environment to `bb` while it starts
 * it, synchronously inside `Barretenberg.new`, so `CRS_PATH` is set only
 * for that call, and so is `TMPDIR`, where bb.js puts the instance's socket:
 * in the same directory rather than at a name another local user could take.
 */
async function loadNative(points: Uint8Array, threads: number | undefined): Promise<Barretenberg> {
  // `start` refused a host without one, and nothing has run since.
  const bbPath = findBbBinary()!;
  const { existsSync, mkdtempSync, rmSync, writeFileSync } = process.getBuiltinModule("node:fs");
  const { join } = process.getBuiltinModule("node:path"), { tmpdir } = process.getBuiltinModule("node:os");
  const directory = mkdtempSync(join(tmpdir(), "moe-bb-points-"));
  const remove = (): void => { rmSync(directory, { recursive: true, force: true }); };
  let api: Barretenberg;
  try {
    writeFileSync(join(directory, "bn254_g1.dat"), points, { mode: 0o600 });
    const before = { CRS_PATH: process.env.CRS_PATH, TMPDIR: process.env.TMPDIR };
    process.env.CRS_PATH = process.env.TMPDIR = directory;
    let starting: Promise<Barretenberg>;
    try {
      starting = Barretenberg.new({ backend: BackendType.NativeUnixSocket, bbPath, threads: threads ?? 1, skipSrsInit: true });
    } finally {
      for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    api = await starting;
  } catch (error) {
    remove();
    throw error;
  }
  // bb.js's destroy only signals bb, which removes its socket from the directory as it exits: a removal racing that
  // leaves the directory behind, so it is retried until bb has gone (a few seconds at most).
  const destroy = api.destroy.bind(api);
  api.destroy = async () => {
    try { await destroy(); } finally {
      for (let tries = 0; tries < 100; tries++) {
        remove();
        if (!existsSync(directory)) break;
        await new Promise(done => setTimeout(done, 50));
      }
    }
  };
  return api;
}

/**
 * Start a backend instance from `parameters` once their copies match
 * `BN254_PARAMETERS`; anything else is refused before a backend starts. The
 * caller owns the instance. Reloading other points into it through the
 * backend's own API is outside what this check can stop.
 */
export async function startBackend(parameters: ProvingParameters, options: BackendOptions = {}): Promise<Barretenberg> {
  return start(parameters, BN254_PARAMETERS, false, options?.threads);
}

/**
 * Start an instance from the leading `CHECK_SET_PARAMETERS.points` points
 * instead, for a party that proves the trail check set's circuits or derives
 * their keys (succinct-read §6); `[x]_2` is the same. Refused as
 * `startBackend` refuses. With `native` the instance is the bundled native
 * binary (`loadNative`), for proving: every check-set circuit fills the
 * points it holds, so it reads no others. Verifiers built over it verify on
 * WebAssembly instances of their own, as over any instance.
 */
export async function startCheckSetBackend(parameters: ProvingParameters, options: CheckSetBackendOptions = {}): Promise<Barretenberg> {
  return start(parameters, CHECK_SET_PARAMETERS, options?.native === true, options?.threads);
}

/**
 * Start a native instance from the leading `EXHAUSTION_PARAMETERS.points` points instead, for a prover of the venue
 * exhaustion's periods or a party deriving their keys (succinct-read §§4.3, 6); refused as `startBackend` refuses.
 * Their leaves fill 2^22 rows, beyond what WebAssembly's memory holds, so the instance is always the bundled native
 * binary.
 */
export async function startExhaustionBackend(parameters: ProvingParameters, options: BackendOptions = {}): Promise<Barretenberg> {
  return start(parameters, EXHAUSTION_PARAMETERS, true, options?.threads);
}

async function start(parameters: ProvingParameters, size: { readonly points: number; readonly g1: string }, native: boolean,
  threads: number | undefined): Promise<Barretenberg> {
  pinnedBackend();
  const refusal = native ? nativeRefusal() : undefined;
  if (refusal !== undefined) throw new ParameterError("BACKEND", refusal);
  if (parameters === null || typeof parameters !== "object") throw new ParameterError("G2", "the BN254 G2 parameters are not bytes");
  const g2 = checked(parameters.g2, "G2", G2_BYTES, BN254_PARAMETERS.g2);
  const g1 = checked(parameters.g1, "G1", size.points * POINT_BYTES, size.g1);
  const api = native ? await loadNative(g1, threads) : await load(g1, size.points, g2, threads);
  STARTED.set(api, Object.freeze({ generator: copyBytes(g1.subarray(0, POINT_BYTES)), g2, points: size.points }));
  return api;
}

// What bb.js 5.2.0 throws while reading a well-sized proof whose bytes are not
// a proof: an element at or above its field's modulus, a commitment coordinate
// limb out of range, a coordinate whose two limbs together reach the base
// field's modulus, a commitment off the curve, or pairing points at infinity. Each is a property of the supplied bytes, so the statement is
// invalid and verifies as false. Any other failure is the backend's, not the
// data's, and stays visible. The list is the pinned version's; a pin move
// re-establishes it (scripts/pool/v3/check.mjs pins each message).
const MALFORMED_PROOF = Object.freeze([
  "Non-canonical proof element: value >= field modulus",
  "Assertion failed: (uint256_t(fr_vec[0]) < (uint256_t(1) << (NUM_LIMB_BITS * 2)))",
  "Assertion failed: (uint256_t(fr_vec[1]) < (uint256_t(1) << (TOTAL_BITS - NUM_LIMB_BITS * 2)))",
  "Assertion failed: (value < fq::modulus)",
  "Deserialized point is not on the curve",
  "Cannot aggregate: incoming pairing points are at infinity",
]);

/** Whether a failure of the pinned backend's verification is one of its malformed-proof failures. */
export function isMalformedProofFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  return typeof message === "string" && MALFORMED_PROOF.some(known => message.startsWith(known));
}

/** The table read once and owned; a malformed table is the caller's error. */
function ownTable(table: CircuitTable): CircuitTable {
  const invalid = (): never => { throw new EncodingError("invalid circuit table"); };
  if (table === null || typeof table !== "object" || !Array.isArray(table.circuits) || table.circuits.length === 0) invalid();
  const { maxProofBytes } = table;
  if (!Number.isSafeInteger(maxProofBytes) || maxProofBytes <= 0 || maxProofBytes % 32 !== 0) invalid();
  const circuits: CircuitEntry[] = [];
  for (const entry of table.circuits) {
    if (entry === null || typeof entry !== "object") invalid();
    const { kind, name, publicInputs } = entry;
    if (!Number.isSafeInteger(kind) || kind < 0 || typeof name !== "string" || name.length === 0 ||
        !Number.isSafeInteger(publicInputs) || publicInputs < 0 ||
        circuits.some(other => other.kind === kind || other.name === name)) invalid();
    circuits.push(Object.freeze({ kind, name, publicInputs }));
  }
  return Object.freeze({ circuits: Object.freeze(circuits), maxProofBytes });
}

/**
 * An owned copy of exactly `count` canonical field elements, each read once
 * by index (a sparse array's holes are no field), or undefined for anything
 * else: the inputs judged are the inputs verified.
 */
function ownFields(values: unknown, count: number): readonly bigint[] | undefined {
  let own: unknown[];
  try { own = copyArray(values as unknown[], value => value, count); } catch (error) {
    if (error instanceof EncodingError) return undefined;
    throw error;
  }
  return own.length === count && own.every(isField) ? own as bigint[] : undefined;
}

/**
 * Derive one key per circuit of `table` over the caller's backend instance,
 * which `startBackend` must have started, and build the verifier. `close` on
 * the result does not destroy the instance the caller owns, and the verifier
 * never uses that instance again: a verify-only party may destroy it once the
 * verifier is built, freeing the memory key derivation took.
 *
 * A proof bb.js throws on leaves its instance behind: each such throw leaks
 * in the WASM instance, and after enough of them every later verification
 * fails, valid proofs included. So the verifier verifies only on instances
 * of its own, each holding `[1]_1` and `[x]_2` from the caller's checked
 * parameters, started at its first verification and replaced after every
 * throw, and never on the caller's. Each instance runs its verifications one
 * at a time, so no call is in flight on an instance being retired; a
 * verification goes to the instance with the fewest waiting.
 */
export async function proofVerifier(
  api: Barretenberg,
  table: CircuitTable,
  programs: Readonly<Record<string, CompiledProgram>>,
  options: VerifierOptions = {},
): Promise<ProofVerifier> {
  const owned = ownTable(table);
  // Each replacement instance runs as the options are given now, not as the caller later changes them.
  const { threads } = options, instances = instanceCount(options);
  const texts = owned.circuits.map(({ name }) => {
    // A circuit's bytecode identity hashes the bytes the artifact's field
    // decodes to. The key is derived by the backend from its own decoding of
    // the same string, read once here, so the string must have one decoding:
    // canonical base64, or the hash could name bytes other than those the key
    // came from.
    const text: unknown = programs[name]?.bytecode;
    if (typeof text !== "string") throw new EncodingError(`${name} bytecode is not canonical base64`);
    const bytecode = Buffer.from(text, "base64");
    if (bytecode.toString("base64") !== text) throw new EncodingError(`${name} bytecode is not canonical base64`);
    return { text, bytecode };
  });
  const loaded = startedFrom(api);
  const keys = new Map<number, { readonly vk: Uint8Array; readonly publicInputs: number }>();
  const identities: Record<string, CircuitIdentity> = {};
  for (const [i, { kind, name, publicInputs }] of owned.circuits.entries()) {
    const { text, bytecode } = texts[i]!;
    const vk = await new UltraHonkBackend(text, api).getVerificationKey(PROOF_OPTIONS);
    keys.set(kind, Object.freeze({ vk, publicInputs }));
    identities[name] = Object.freeze({ bytecode: sha256(bytecode), vk: sha256(vk), kind });
  }
  return Object.freeze({ ...lanesOver(loaded, keys, owned.maxProofBytes, threads, instances), identities: Object.freeze(identities) });
}

/** A key a verifier holds: the backend's key bytes for one kind and its public-input count. */
export interface PinnedKey {
  readonly kind: number;
  readonly vk: Uint8Array;
  readonly publicInputs: number;
}

/**
 * A verifier over keys the caller pins rather than derives, such as a check set's (succinct-read §2 rule 2): it
 * reads `[1]_1` and `[x]_2` from the caller's started instance and nothing else, so it needs no more points than any
 * verification, and it verifies on instances of its own exactly as `proofVerifier` does.
 */
export function keyedVerifier(api: Barretenberg, pinned: readonly PinnedKey[], maxProofBytes: number, options: VerifierOptions = {}): KeyedVerifier {
  const loaded = startedFrom(api), { threads } = options, instances = instanceCount(options);
  if (!Number.isSafeInteger(maxProofBytes) || maxProofBytes <= 0 || maxProofBytes % 32 !== 0) throw new EncodingError("invalid proof bound");
  const keys = new Map<number, { readonly vk: Uint8Array; readonly publicInputs: number }>();
  for (const key of pinned) {
    const { kind, vk, publicInputs } = key ?? {};
    if (!Number.isSafeInteger(kind) || kind < 0 || keys.has(kind) || !(vk instanceof Uint8Array) || vk.length === 0 ||
        !Number.isSafeInteger(publicInputs) || publicInputs < 0) throw new EncodingError("invalid pinned key");
    keys.set(kind, Object.freeze({ vk: copyBytes(vk), publicInputs }));
  }
  if (keys.size === 0) throw new EncodingError("invalid pinned key");
  return Object.freeze(lanesOver(loaded, keys, maxProofBytes, threads, instances));
}

/** How many G1 points a started instance holds, or undefined for one `startBackend` or `startCheckSetBackend` did not start. */
export function startedPoints(api: Barretenberg): number | undefined {
  return STARTED.get(api)?.points;
}

function startedFrom(api: Barretenberg): { readonly generator: Uint8Array; readonly g2: Uint8Array } {
  const loaded = STARTED.get(api);
  if (loaded === undefined) throw new ParameterError("UNCHECKED", "the backend instance was not started from checked parameters");
  return loaded;
}

function instanceCount(options: VerifierOptions): number {
  const { instances = 1 } = options;
  if (!Number.isSafeInteger(instances) || instances < 1 || instances > MAX_INSTANCES) {
    throw new RangeError(`a verifier runs 1 to ${MAX_INSTANCES} instances`);
  }
  return instances;
}

/** The verification lanes over `keys`, each on an instance of its own holding the loaded `[1]_1` and `[x]_2`. */
function lanesOver(loaded: { readonly generator: Uint8Array; readonly g2: Uint8Array },
  keys: ReadonlyMap<number, { readonly vk: Uint8Array; readonly publicInputs: number }>, maxProofBytes: number,
  threads: number | undefined, instances: number): KeyedVerifier {
  // Each lane's own instance, undefined before its first verification and after each throw, its queue, how many
  // wait on it, and whether its close has run.
  interface Lane {
    current: { readonly api: Barretenberg; readonly backend: UltraHonkVerifierBackend } | undefined;
    queue: Promise<unknown>; waiting: number; closed: boolean;
  }
  const lanes: Lane[] = Array.from({ length: instances }, () => ({ current: undefined, queue: Promise.resolve(), waiting: 0, closed: false }));
  let closed = false;
  const retire = async (lane: Lane): Promise<void> => {
    const retired = lane.current;
    lane.current = undefined;
    // The instance is abandoned either way; a failed destroy does not change
    // what the proof was.
    if (retired !== undefined) await retired.api.destroy().catch(() => {});
  };
  const serially = <T>(lane: Lane, task: () => Promise<T>): Promise<T> => {
    lane.waiting++;
    const run = lane.queue.then(task, task).finally(() => { lane.waiting--; });
    lane.queue = run.catch(() => {});
    return run;
  };
  /** The proof's own unshared copy where its length is a positive multiple of 32 within the table's bound, judged on the copy. */
  const ownProof = (proof: unknown): Uint8Array | undefined => {
    let own: Uint8Array;
    try { own = copyUnshared(proof as Uint8Array); } catch (error) {
      if (error instanceof EncodingError) return undefined;
      throw error;
    }
    return own.length > 0 && own.length <= maxProofBytes && own.length % 32 === 0 ? own : undefined;
  };
  return {
    async verify(kind, publicInputs, proof) {
      // A destroyed instance never settles a call, so a closed verifier refuses instead.
      if (closed) throw new Error("the proof verifier is closed");
      const key = keys.get(kind);
      const fields = key === undefined ? undefined : ownFields(publicInputs, key.publicInputs), bytes = ownProof(proof);
      if (key === undefined || fields === undefined || bytes === undefined) return false;
      const input = { proof: bytes, publicInputs: fields.map(fieldToHex), verificationKey: key.vk };
      const lane = lanes.reduce((best, next) => next.waiting < best.waiting ? next : best);
      return serially(lane, async () => {
        if (lane.closed) throw new Error("the proof verifier is closed");
        if (lane.current === undefined) {
          const fresh = await load(loaded.generator, 1, loaded.g2, threads);
          lane.current = { api: fresh, backend: new UltraHonkVerifierBackend(fresh) };
        }
        try {
          return (await lane.current.backend.verifyProof(input, PROOF_OPTIONS)) === true;
        } catch (cause) {
          await retire(lane);
          if (isMalformedProofFailure(cause)) return false;
          throw cause;
        }
      });
    },
    parallel: instances,
    // Verifications asked for before `close` finish; later ones refuse.
    async close() {
      closed = true;
      await Promise.all(lanes.map(lane => serially(lane, async () => {
        lane.closed = true;
        await retire(lane);
      })));
    },
  };
}
