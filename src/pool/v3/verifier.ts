// The verifier over the package's shipped relations (`programs.ts`, pool-v3
// §11.4): every key it derives must be the adopted configuration's (§11.1).
// Nothing here imports `@noir-lang/noir_js`: a verify-only party needs only
// `@aztec/bb.js`, through `../proof-verifier.ts`. The prover (`prover.ts`)
// executes the same shipped relations.
import type { Barretenberg } from "@aztec/bb.js";
import { compareBytes } from "../../bytes.js";
import { proofVerifier, type ProofVerifier, type VerifierOptions } from "../proof-verifier.js";
import { adoptedConfiguration, RELATIONS } from "./configuration.js";
import { adoptedPrograms, POOL_V3_CIRCUITS, ProgramError } from "./programs.js";

/**
 * The verifier over the shipped relations, on the caller's backend instance, which `startBackend` must have
 * started from checked parameters. It derives the six keys there, refuses (`ProgramError`) unless every key
 * identity is the configuration's, and verifies on instances of its own, so a verify-only party may destroy the
 * caller's instance once this returns (`proofVerifier`).
 */
export async function openV3Verifier(api: Barretenberg, options: VerifierOptions = {}): Promise<ProofVerifier> {
  const verifier = await proofVerifier(api, POOL_V3_CIRCUITS, adoptedPrograms(), options), configuration = adoptedConfiguration();
  for (const name of RELATIONS) {
    const derived = verifier.identities[name], expected = configuration.circuits[name];
    if (derived === undefined || compareBytes(derived.bytecode, expected.bytecode) !== 0 || compareBytes(derived.vk, expected.vk) !== 0) {
      await verifier.close();
      throw new ProgramError("IDENTITY", `the ${name} key the backend derives is not the configuration's`);
    }
  }
  return verifier;
}
