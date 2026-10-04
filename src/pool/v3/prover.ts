// The runtime prover for pool-v3 (§3, §4): a holder or backer proves locally,
// as the release contract requires. Witnesses are generated with
// `@noir-lang/noir_js` and proofs made with `@aztec/bb.js` under UltraHonk's
// zero-knowledge target, both exact-pinned dependencies.
//
// The prover executes the package's six shipped relations (`programs.ts`),
// whose bytecode identities the loader checks and whose keys the verifier
// derives and checks against the adopted configuration (pool-v3 §11.4). It
// proves a task built by `witness.ts`, requires the proof's public inputs to
// equal the task's exactly, and checks the proof with the verifier over the
// same keys, routed by kind (§4), before returning the record. Nothing here
// admits, signs a receipt or chooses a venue; issue and recovery signing
// helpers live in witness.ts.
import type { Barretenberg } from "@aztec/bb.js";
import { UltraHonkBackend } from "@aztec/bb.js";
import { Noir, type CompiledCircuit, type InputMap } from "@noir-lang/noir_js";
import { compareBytes, copyBytes, EncodingError } from "../../bytes.js";
import { identifierOf } from "../field.js";
import { PROOF_OPTIONS, type VerifierOptions, type ProofVerifier } from "../proof-verifier.js";
import { adoptedDomain, RELATION_KINDS, RELATIONS } from "./configuration.js";
import type { Record } from "./records.js";
import { adoptedPrograms } from "./programs.js";
import { openV3Verifier } from "./verifier.js";
import type { ProofTask } from "./witness.js";

/** A proof that does not carry the task's inputs, or does not verify. */
export class ProverError extends Error {
  constructor(readonly code: "PUBLIC_INPUTS" | "UNVERIFIED", message: string) {
    super(message); this.name = "ProverError";
  }
}

export interface V3Prover {
  /** The verifier over the same six keys, routing each kind to its own. */
  readonly verifier: ProofVerifier;
  /** Prove `task`; issue and settlement authorization is added by witness.ts's signing helpers. */
  prove(task: ProofTask): Promise<Record>;
  /** Releases the verifier's own backend instance; the caller's instance stays open. */
  close(): Promise<void>;
}

/**
 * Build the prover over the caller's backend instance, which `startBackend`
 * must have started from checked parameters: load the shipped relations,
 * derive the six keys, and refuse (`ProgramError`) unless every identity is
 * the adopted configuration's. Proving runs on the caller's instance;
 * verification on the verifier's own.
 */
export async function openV3Prover(api: Barretenberg, options: VerifierOptions = {}): Promise<V3Prover> {
  const programs = adoptedPrograms(), domain = adoptedDomain(), verifier = await openV3Verifier(api, options);
  const circuits = new Map<number, { readonly noir: Noir; readonly backend: UltraHonkBackend }>();
  for (const name of RELATIONS) {
    // Witness generation reads the ABI and bytecode; the debug fields only enrich an execution failure's message.
    const program = programs[name] as unknown as CompiledCircuit;
    circuits.set(RELATION_KINDS[name], { noir: new Noir(program), backend: new UltraHonkBackend(program.bytecode, api) });
  }
  return {
    verifier,
    async prove(task) {
      const kind = task?.kind, circuit = circuits.get(kind);
      if (circuit === undefined) throw new EncodingError("the prover proves kinds 1–4, 6 and 7");
      const expected = [...task.publicInputs], capsules = task.capsules.map(copyBytes);
      // A record names its configuration in its first two inputs (§4): the prover proves under the adopted one only.
      if (expected.length < 2 || compareBytes(identifierOf(expected[0]!, expected[1]!), domain) !== 0) {
        throw new EncodingError("the task names another configuration");
      }
      const { witness } = await circuit.noir.execute(task.witness as InputMap);
      const proof = await circuit.backend.generateProof(witness, PROOF_OPTIONS);
      const carried = proof.publicInputs.map(BigInt);
      if (carried.length !== expected.length || carried.some((value, i) => value !== expected[i])) {
        throw new ProverError("PUBLIC_INPUTS", "the proof's public inputs are not the task's");
      }
      if (await verifier.verify(kind, expected, proof.proof) !== true) throw new ProverError("UNVERIFIED", "the proof does not verify");
      return Object.freeze({ domain: identifierOf(expected[0]!, expected[1]!), kind, publicInputs: Object.freeze(expected),
        proof: copyBytes(proof.proof), authorization: new Uint8Array(), capsules: Object.freeze(capsules) });
    },
    close: () => verifier.close(),
  };
}
