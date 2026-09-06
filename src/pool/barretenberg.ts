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

/**
 * Derive the keys and build the verifier over an existing backend instance.
 * `close` on the result does not destroy the instance the caller owns.
 */
export async function barretenbergPool(api: Barretenberg, circuits: CompiledCircuits): Promise<BarretenbergPool> {
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
  const verifierBackend = new UltraHonkVerifierBackend(api);
  const frozen = Object.freeze(identities) as unknown as CircuitIdentities;
  const verifier: StatementVerifier = {
    identities: frozen,
    async verify(kind, publicInputs, proof) {
      try {
        const key = keys.get(kind);
        if (key === undefined || !isStatementKind(kind) || !allFields(publicInputs, PUBLIC_INPUT_COUNT[kind]) || !isWellFormedProof(proof)) {
          return false;
        }
        const verified = await verifierBackend.verifyProof(
          { proof: copyBytes(proof), publicInputs: publicInputs.map(fieldToHex), verificationKey: key },
          PROOF_OPTIONS,
        );
        return verified === true;
      } catch {
        return false;
      }
    },
  };
  return {
    identities: frozen,
    verifier,
    async hash(inputs) {
      const { hash } = await api.poseidon2Hash({ inputs: inputs.map(fieldToBytes) });
      return bytesToField(hash);
    },
    async close() {},
  };
}

/** Start a single-threaded WASM backend, derive the keys, and own the instance. */
export async function openBarretenberg(
  circuits: CompiledCircuits,
  options: { readonly crsPath?: string; readonly threads?: number } = {},
): Promise<BarretenbergPool> {
  const api = await Barretenberg.new({
    backend: BackendType.WasmWorker,
    threads: options.threads ?? 1,
    ...(options.crsPath === undefined ? {} : { crsPath: options.crsPath }),
  });
  try {
    const pool = await barretenbergPool(api, circuits);
    return { ...pool, close: () => api.destroy() };
  } catch (cause) {
    await api.destroy();
    throw cause;
  }
}
