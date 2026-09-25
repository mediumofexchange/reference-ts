// Proof verification under Barretenberg 5.2.0's UltraHonk over BN254 with the
// verifier target `noir-recursive`, which is the zero-knowledge mode (pool-v2
// §12, pool-v3 §4). The backend's legacy `keccak` mode disables zero knowledge
// and is no construction here.
//
// Construction-neutral: a construction passes its circuits as data — each
// statement kind, the name of its compiled artifact and its public-input count
// — with its proof-size bound. The verifier derives one key per kind from the
// artifact's bytecode, names each circuit's identity for the caller to pin
// against its configuration, and verifies a kind against that kind's key and
// nothing else; it never accepts a verification key supplied with a statement.
// `barretenberg.ts` binds pool-v2's table.
//
// This module and `barretenberg.ts` are the only ones that import
// `@aztec/bb.js`, an optional peer dependency.

import { sha256 } from "@noble/hashes/sha2.js";
import { Barretenberg, BackendType, UltraHonkBackend, UltraHonkVerifierBackend } from "@aztec/bb.js";
import { copyBytes, EncodingError } from "../bytes.js";
import { fieldToHex, isField } from "./field.js";

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

export interface ProofVerifier {
  /** Each circuit's identity, by artifact name, derived here from the bytecode the caller supplied. */
  readonly identities: Readonly<Record<string, CircuitIdentity>>;
  /** False for a kind outside the table, a wrong count of canonical fields, malformed proof bytes or a proof that fails. */
  verify(kind: number, publicInputs: readonly bigint[], proof: Uint8Array): Promise<boolean>;
  /** Destroys the verifier's own backend instance; later verifications refuse. */
  close(): Promise<void>;
}

/** How a backend instance is started: the verifier's own, and a caller's. */
export interface BackendOptions {
  readonly crsPath?: string;
  readonly threads?: number;
}

export const startBackend = (options: BackendOptions): Promise<Barretenberg> => Barretenberg.new({
  backend: BackendType.WasmWorker,
  threads: options.threads ?? 1,
  ...(options.crsPath === undefined ? {} : { crsPath: options.crsPath }),
});

// What bb.js 5.2.0 throws while reading a well-sized proof whose bytes are not
// a proof: an element at or above its field's modulus, a commitment coordinate
// limb out of range, a commitment off the curve, or pairing points at
// infinity. Each is a property of the supplied bytes, so the statement is
// invalid and verifies as false. Any other failure is the backend's, not the
// data's, and stays visible. The list is the pinned version's; a pin move
// re-establishes it (scripts/pool/check.mjs pins each message).
const MALFORMED_PROOF = Object.freeze([
  "Non-canonical proof element: value >= field modulus",
  "Assertion failed: (uint256_t(fr_vec[0]) < (uint256_t(1) << (NUM_LIMB_BITS * 2)))",
  "Assertion failed: (uint256_t(fr_vec[1]) < (uint256_t(1) << (TOTAL_BITS - NUM_LIMB_BITS * 2)))",
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
 * Whether `values` is an array of exactly `count` canonical field elements.
 * By index rather than `every`, which skips a sparse array's holes.
 */
function allFields(values: unknown, count: number): values is readonly bigint[] {
  if (!Array.isArray(values) || values.length !== count) return false;
  for (let i = 0; i < count; i++) if (!isField(values[i])) return false;
  return true;
}

/**
 * Derive one key per circuit of `table` over the caller's backend instance
 * and build the verifier. `close` on the result does not destroy the instance
 * the caller owns.
 *
 * A proof bb.js throws on leaves its instance behind: each such throw leaks
 * in the WASM instance, and after enough of them every later verification
 * fails, valid proofs included. So the verifier verifies only on an instance
 * of its own, started with `options` at its first verification and replaced
 * after every throw, and never on the caller's. Verifications run one at a
 * time, so no call is in flight on an instance being retired.
 */
export async function proofVerifier(
  api: Barretenberg,
  table: CircuitTable,
  programs: Readonly<Record<string, CompiledProgram>>,
  options: BackendOptions,
): Promise<ProofVerifier> {
  const owned = ownTable(table);
  // Each replacement starts with these options as given now, not as the caller later changes them.
  const { crsPath, threads } = options;
  const own: BackendOptions = Object.freeze({ ...(crsPath === undefined ? {} : { crsPath }), ...(threads === undefined ? {} : { threads }) });
  const keys = new Map<number, { readonly vk: Uint8Array; readonly publicInputs: number }>();
  const identities: Record<string, CircuitIdentity> = {};
  for (const { kind, name, publicInputs } of owned.circuits) {
    // A circuit's bytecode identity hashes the bytes the artifact's field
    // decodes to. The key is derived by the backend from its own decoding of
    // the same string, read once here, so the string must have one decoding:
    // canonical base64, or the hash could name bytes other than those the key
    // came from.
    const text: unknown = programs[name]?.bytecode;
    if (typeof text !== "string") throw new EncodingError(`${name} bytecode is not canonical base64`);
    const bytecode = Buffer.from(text, "base64");
    if (bytecode.toString("base64") !== text) throw new EncodingError(`${name} bytecode is not canonical base64`);
    const backend = new UltraHonkBackend(text, api);
    const vk = await backend.getVerificationKey(PROOF_OPTIONS);
    keys.set(kind, Object.freeze({ vk, publicInputs }));
    identities[name] = Object.freeze({ bytecode: sha256(bytecode), vk: sha256(vk) });
  }
  // The verifier's own instance; undefined before its first verification and after each throw.
  let current: { readonly api: Barretenberg; readonly backend: UltraHonkVerifierBackend } | undefined;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const retire = async (): Promise<void> => {
    const retired = current;
    current = undefined;
    // The instance is abandoned either way; a failed destroy does not change
    // what the proof was.
    if (retired !== undefined) await retired.api.destroy().catch(() => {});
  };
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };
  const wellFormed = (proof: unknown): proof is Uint8Array =>
    proof instanceof Uint8Array && proof.length > 0 && proof.length <= owned.maxProofBytes && proof.length % 32 === 0;
  return {
    identities: Object.freeze(identities),
    async verify(kind, publicInputs, proof) {
      // A destroyed instance never settles a call, so a closed verifier refuses instead.
      if (closed) throw new Error("the proof verifier is closed");
      const key = keys.get(kind);
      if (key === undefined || !allFields(publicInputs, key.publicInputs) || !wellFormed(proof)) return false;
      const input = { proof: copyBytes(proof), publicInputs: publicInputs.map(fieldToHex), verificationKey: key.vk };
      return serially(async () => {
        if (closed) throw new Error("the proof verifier is closed");
        if (current === undefined) {
          const fresh = await startBackend(own);
          current = { api: fresh, backend: new UltraHonkVerifierBackend(fresh) };
        }
        try {
          return (await current.backend.verifyProof(input, PROOF_OPTIONS)) === true;
        } catch (cause) {
          await retire();
          if (isMalformedProofFailure(cause)) return false;
          throw cause;
        }
      });
    },
    close: () => serially(async () => {
      closed = true;
      await retire();
    }),
  };
}
