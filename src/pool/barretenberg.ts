// The proof backend behind pool-v2 (§12): its three circuits bound to the
// construction-neutral verifier (`proof-verifier.ts`), which verifies under
// Barretenberg 5.2.0's UltraHonk over BN254 with the verifier target
// `noir-recursive`, the zero-knowledge mode.
//
// `@aztec/bb.js` is an optional peer dependency: everything else in `pool/` is
// pure TypeScript over the canonical frames and the host Poseidon2, and a
// verifier that only reads a trail's roots needs nothing here. An operator, a
// wallet and a replaying stranger need it, to verify proofs against the
// configuration's keys.
//
// The keys are derived from the compiled circuits' bytecode and pinned by the
// caller against the configuration and `circuits/manifest.json`; a verifier
// never accepts a verification key supplied with a statement (§2), and the
// StatementVerifier this returns holds exactly three keys, one per kind, and
// verifies against nothing else.
//
// Compiling the sources to the bytecode is `scripts/pool/compile.mjs`'s job,
// in a child process, since the WASM compiler's Windows path adaptation
// changes Node's path functions; the compiled artifacts are what this takes.

import type { Barretenberg } from "@aztec/bb.js";
import { bytesToField, fieldToBytes } from "./field.js";
import { proofVerifier, startBackend, type BackendOptions, type CircuitTable, type CompiledProgram } from "./proof-verifier.js";
import type { StatementVerifier } from "./segment.js";
import { BURN, ISSUE, MAX_PROOF_BYTES, PUBLIC_INPUT_COUNT, SPEND, type CircuitIdentities } from "./statement.js";

export type { CircuitIdentities } from "./statement.js";
export { isMalformedProofFailure, PROOF_OPTIONS, type BackendOptions, type CompiledProgram } from "./proof-verifier.js";

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

/** pool-v2's circuits: kinds 1–3 with nine, eleven and thirteen public fields (§7, §13), proofs to §12's bound. */
const POOL_V2_CIRCUITS: CircuitTable = Object.freeze({
  circuits: Object.freeze([
    Object.freeze({ kind: ISSUE, name: "issue", publicInputs: PUBLIC_INPUT_COUNT[ISSUE] }),
    Object.freeze({ kind: SPEND, name: "spend", publicInputs: PUBLIC_INPUT_COUNT[SPEND] }),
    Object.freeze({ kind: BURN, name: "burn", publicInputs: PUBLIC_INPUT_COUNT[BURN] }),
  ]),
  maxProofBytes: MAX_PROOF_BYTES,
});

/**
 * Derive the keys over an existing backend instance and build the verifier,
 * which verifies only on an instance of its own (`proofVerifier`). `close` on
 * the result does not destroy the instance the caller owns.
 */
export async function barretenbergPool(api: Barretenberg, circuits: CompiledCircuits, options: BackendOptions): Promise<BarretenbergPool> {
  const own = await proofVerifier(api, POOL_V2_CIRCUITS, circuits as unknown as Readonly<Record<string, CompiledProgram>>, options);
  const identities = own.identities as unknown as CircuitIdentities;
  return {
    identities,
    verifier: { identities, verify: (kind, publicInputs, proof) => own.verify(kind, publicInputs, proof) },
    async hash(inputs) {
      const { hash } = await api.poseidon2Hash({ inputs: inputs.map(fieldToBytes) });
      return bytesToField(hash);
    },
    close: () => own.close(),
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
