// Portable evidence authentication, pool-v3 §9 at 322bcae: the shared evidence
// chain's frame (`../evidence-chain.ts`) with v3's contexts, the statement,
// proof and authorization as target fields and the digest triple. This does
// not classify checkpoints, validate target records/proofs or establish finality.
import { FaultEvidenceLimitError, type FaultEvidence as ChainEvidence } from "../evidence-chain.js";
import { MAX_TARGET_FIELD_BYTES, V3_CHAIN } from "./commitments.js";
import type { EvidenceDigests } from "./records.js";

/** A local resource refusal, not malformed evidence or operator fault. */
export { FaultEvidenceLimitError, MAX_TARGET_FIELD_BYTES };
export type { ExpectedSnapshot } from "../evidence-chain.js";
export type FaultEvidence = ChainEvidence<keyof EvidenceDigests, "statement" | "proof" | "authorization">;

/** Strict wire structure; raw target bytes need not be valid §5 records.
 * The caller must supply its local suffix budget, including zero if desired. */
export const encodeFaultEvidence: (input: FaultEvidence, maxSuffixEntries: bigint) => Uint8Array = V3_CHAIN.encodeFaultEvidence;
/** Scan every boundary without copying target/suffix data first. */
export const decodeFaultEvidence: (bytes: Uint8Array, maxSuffixEntries: bigint) => FaultEvidence = V3_CHAIN.decodeFaultEvidence;
/** True authenticates the exact target bytes only. False means malformed or
 * unauthenticated data, never exclusion. Budget/resource/programming failures
 * propagate, so callers cannot accidentally classify them as operator fault. */
export const verifyFaultEvidence = V3_CHAIN.verifyFaultEvidence;
