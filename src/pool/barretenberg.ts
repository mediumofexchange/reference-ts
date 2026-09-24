// The proof backend behind the pool (pool-v2 §12): Barretenberg 5.2.0's
// UltraHonk over BN254 with the verifier target `noir-recursive`, which is
// the zero-knowledge mode. The backend's legacy `keccak` mode disables zero
// knowledge and is not this construction.
//
// This module is the one place `@aztec/bb.js` is imported. It is an optional
// peer dependency: everything else in `pool/` is pure TypeScript over the
// canonical frames and the host Poseidon2, and a verifier that only reads a
// trail's roots needs nothing here. An operator, a wallet and a replaying
// stranger need it, to verify proofs against the configuration's keys.
//
// The keys are derived here from the compiled circuits' bytecode and pinned
// by the caller against the configuration and `circuits/manifest.json`; a
// verifier never accepts a verification key supplied with a statement (§2),
// and the StatementVerifier this returns holds exactly three keys, one per
// kind, and verifies against nothing else.
//
// Compiling the sources to the bytecode is `scripts/pool/compile.mjs`'s job,
// in a child process, since the WASM compiler's Windows path adaptation
// changes Node's path functions; the compiled artifacts are what this takes.

import { sha256 } from "@noble/hashes/sha2.js";
import { Barretenberg, BackendType, UltraHonkBackend, UltraHonkVerifierBackend } from "@aztec/bb.js";
import { copyBytes, EncodingError } from "../bytes.js";
import { bytesToField, fieldToBytes, fieldToHex } from "./field.js";
import type { StatementVerifier } from "./segment.js";
import {
  allFields,
  isStatementKind,
  isWellFormedProof,
  PUBLIC_INPUT_COUNT,
  type CircuitIdentities,
  type CircuitIdentity,
  type StatementKind,
} from "./statement.js";

export type { CircuitIdentities } from "./statement.js";

/** The proof options this construction is defined under (§9). */
export const PROOF_OPTIONS = Object.freeze({ verifierTarget: "noir-recursive" as const });

/** The compiler's artifact for one circuit, as `scripts/pool/compile.mjs` writes it. */
export interface CompiledProgram {
  readonly noir_version: string;
  /** Base64 of the compressed ACIR bytecode; `bytecode(k)` hashes its decoded bytes (§2). */
  readonly bytecode: string;
}

export interface CompiledCircuits {
  readonly issue: CompiledProgram;
  readonly spend: CompiledProgram;
  readonly burn: CompiledProgram;
}

export interface BarretenbergPool {
  /** SHA-256 of each circuit's bytecode and derived verification key, for the configuration. */
  readonly identities: CircuitIdentities;
  /** Verifies against the three derived keys and nothing else, and names their identities. */
  readonly verifier: StatementVerifier;
  /** The backend's own Poseidon2 sponge: the oracle `poseidon2.ts` is pinned to. */
  hash(inputs: readonly bigint[]): Promise<bigint>;
  close(): Promise<void>;
}

const NAMES: Readonly<Record<StatementKind, keyof CompiledCircuits>> = Object.freeze({ 1: "issue", 2: "spend", 3: "burn" });

/** How a backend instance is started: the verifier's own, and `openBarretenberg`'s. */
export interface BackendOptions {
  readonly crsPath?: string;
  readonly threads?: number;
}

const startBackend = (options: BackendOptions): Promise<Barretenberg> => Barretenberg.new({
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

/**
 * Derive the keys over an existing backend instance and build the verifier.
 * `close` on the result does not destroy the instance the caller owns.
 *
 * A proof bb.js throws on leaves its instance behind: each such throw leaks
 * in the WASM instance, and after enough of them every later verification
 * fails, valid proofs included. So the verifier verifies only on an instance
 * of its own, started with `options` at its first verification and replaced
 * after every throw, and never on the caller's. `close` destroys it.
 * Verifications run one at a time, so no call is in flight on an instance
 * being retired.
 */
export async function barretenbergPool(api: Barretenberg, circuits: CompiledCircuits, options: BackendOptions): Promise<BarretenbergPool> {
  // Each replacement starts with these options as given now, not as the caller later changes them.
  const { crsPath, threads } = options;
  const own: BackendOptions = Object.freeze({ ...(crsPath === undefined ? {} : { crsPath }), ...(threads === undefined ? {} : { threads }) });
  const keys = new Map<StatementKind, Uint8Array>();
  const identities: Record<string, CircuitIdentity> = {};
  for (const kind of [1, 2, 3] as const) {
    const program = circuits[NAMES[kind]];
    // bytecode(k) hashes the bytes the artifact's field decodes to (§2). The
    // key is derived by the backend from its own decoding of the same string,
    // so the string must have one decoding: canonical base64, or the hash
    // could name bytes other than those the key came from.
    const bytecode = Buffer.from(program.bytecode, "base64");
    if (bytecode.toString("base64") !== program.bytecode) throw new EncodingError(`${NAMES[kind]} bytecode is not canonical base64`);
    const backend = new UltraHonkBackend(program.bytecode, api);
    const vk = await backend.getVerificationKey(PROOF_OPTIONS);
    keys.set(kind, vk);
    identities[NAMES[kind]] = Object.freeze({ bytecode: sha256(bytecode), vk: sha256(vk) });
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
  const frozen = Object.freeze(identities) as unknown as CircuitIdentities;
  const verifier: StatementVerifier = {
    identities: frozen,
    async verify(kind, publicInputs, proof) {
      // A destroyed instance never settles a call, so a closed verifier refuses instead.
      if (closed) throw new Error("the proof verifier is closed");
      const key = keys.get(kind);
      if (key === undefined || !isStatementKind(kind) || !allFields(publicInputs, PUBLIC_INPUT_COUNT[kind]) || !isWellFormedProof(proof)) {
        return false;
      }
      const input = { proof: copyBytes(proof), publicInputs: publicInputs.map(fieldToHex), verificationKey: key };
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
  };
  return {
    identities: frozen,
    verifier,
    async hash(inputs) {
      const { hash } = await api.poseidon2Hash({ inputs: inputs.map(fieldToBytes) });
      return bytesToField(hash);
    },
    close: () => serially(async () => {
      closed = true;
      await retire();
    }),
  };
}

/** Start a single-threaded WASM backend, derive the keys, and own the instance. */
export async function openBarretenberg(
  circuits: CompiledCircuits,
  options: BackendOptions = {},
): Promise<BarretenbergPool> {
  const api = await startBackend(options);
  try {
    const pool = await barretenbergPool(api, circuits, options);
    return { ...pool, close: async () => { try { await pool.close(); } finally { await api.destroy(); } } };
  } catch (cause) {
    await api.destroy();
    throw cause;
  }
}
