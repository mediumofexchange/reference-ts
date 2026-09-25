// The runtime prover for pool-v3 (§3, §4): a holder or backer proves locally,
// as the release contract requires. Witnesses are generated with
// `@noir-lang/noir_js` and proofs made with `@aztec/bb.js` under UltraHonk's
// zero-knowledge target, both optional peer dependencies like the verifier.
//
// The caller supplies the six compiled artifacts and the candidate
// configuration from its own manifest check (pool-v3 §11.1); the prover
// derives each circuit's bytecode and key identity itself and refuses unless
// all six equal the configuration's. It proves a task built by `witness.ts`,
// requires the proof's public inputs to equal the task's exactly, and checks
// the proof with the verifier over the same keys, routed by kind (§4), before
// returning the record. Nothing here admits, signs a receipt or chooses a
// venue; the issuer's authorization is `authorizeIssue` (witness.ts).
import type { Barretenberg } from "@aztec/bb.js";
import { UltraHonkBackend } from "@aztec/bb.js";
import { Noir, type CompiledCircuit, type InputMap } from "@noir-lang/noir_js";
import { compareBytes, copyBytes, EncodingError } from "../../bytes.js";
import { identifierOf } from "../field.js";
import { PROOF_OPTIONS, proofVerifier, type BackendOptions, type CircuitTable, type ProofVerifier } from "../proof-verifier.js";
import { RELATIONS, type CandidateConfiguration, type Relation } from "./configuration.js";
import type { Record } from "./records.js";
import type { ProofTask } from "./witness.js";

/** pool-v3's six relations: kind, artifact and public-input count (§3), proofs to §5's bound. */
export const POOL_V3_CIRCUITS: CircuitTable = Object.freeze({
  circuits: Object.freeze(([[1, "issue", 11], [2, "spend", 15], [3, "burn", 15], [4, "demand", 16], [6, "settle", 17], [7, "request", 7]] as const)
    .map(([kind, name, publicInputs]) => Object.freeze({ kind, name, publicInputs }))),
  maxProofBytes: 131072,
});
const NAMES = new Map<number, Relation>(POOL_V3_CIRCUITS.circuits.map(c => [c.kind, c.name as Relation]));

/** The compiler's artifact for one circuit with the ABI noir_js executes it by. */
export type NoirProgram = CompiledCircuit & { readonly noir_version: string };

/** A prover whose artifacts or keys differ from the configuration, or whose proof does not carry the task's inputs. */
export class ProverError extends Error {
  constructor(readonly code: "IDENTITY" | "PUBLIC_INPUTS" | "UNVERIFIED", message: string) {
    super(message); this.name = "ProverError";
  }
}

export interface V3Prover {
  /** The verifier over the same six keys, routing each kind to its own. */
  readonly verifier: ProofVerifier;
  /** Prove `task`; the record carries no authorization (an issue's is `authorizeIssue`). */
  prove(task: ProofTask): Promise<Record>;
  /** Releases the verifier's own backend instance; the caller's instance stays open. */
  close(): Promise<void>;
}

/**
 * Build the prover over the caller's backend instance: derive the six keys,
 * refuse unless every identity is the configuration's, and keep the programs.
 * Proving runs on the caller's instance; verification on the verifier's own.
 */
export async function openV3Prover(api: Barretenberg, programs: Readonly<{ [name in Relation]: NoirProgram }>,
  configuration: CandidateConfiguration, options: BackendOptions = {}): Promise<V3Prover> {
  const own = new Map<Relation, NoirProgram>();
  for (const name of RELATIONS) {
    const program = programs[name];
    if (program === null || typeof program !== "object") throw new ProverError("IDENTITY", `${name} artifact is missing`);
    own.set(name, Object.freeze({ ...program }));
  }
  const verifier = await proofVerifier(api, POOL_V3_CIRCUITS, Object.fromEntries(own), options);
  try {
    for (const name of RELATIONS) {
      const derived = verifier.identities[name], expected = configuration.circuits[name];
      if (derived === undefined || compareBytes(derived.bytecode, expected.bytecode) !== 0 || compareBytes(derived.vk, expected.vk) !== 0) {
        throw new ProverError("IDENTITY", `${name} artifact or key is not the configuration's`);
      }
    }
  } catch (error) {
    await verifier.close();
    throw error;
  }
  const circuits = new Map<number, { readonly noir: Noir; readonly backend: UltraHonkBackend }>();
  for (const [kind, name] of NAMES) {
    const program = own.get(name)!;
    circuits.set(kind, { noir: new Noir(program), backend: new UltraHonkBackend(program.bytecode, api) });
  }
  return {
    verifier,
    async prove(task) {
      const kind = task?.kind, circuit = circuits.get(kind);
      if (circuit === undefined || kind > 3) throw new EncodingError("the prover proves kinds 1–3");
      const expected = [...task.publicInputs], capsules = task.capsules.map(copyBytes);
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
