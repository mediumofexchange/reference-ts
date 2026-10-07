// Portable evidence authentication and compact intrinsic exclusion for lit-v1
// §6: pool-v3 §9's frame (the shared evidence chain's, `../pool/evidence-chain.ts`)
// with the evidence pair in place of the triple, and §9.1 with lit's two intrinsic
// failures. This does not classify checkpoints or establish finality.
import { compareBytes, copyBytes, EncodingError } from "../bytes.js";
import { isValidPublicKey, verifySignatureStrict } from "../keys.js";
import { FaultEvidenceLimitError, type FaultEvidence as ChainEvidence } from "../pool/evidence-chain.js";
import { LIT_CHAIN, MAX_TARGET_FIELD_BYTES } from "./commitments.js";
import { litConfigHash } from "./configuration.js";
import {
  arithmeticHolds, authorizationLength, decodeStatement, statementBytes, statementSignatureVerifies,
  type EvidencePair, type LitRecord,
} from "./records.js";

/** A local resource refusal, not malformed evidence or operator fault: pool-v3 §9's class, so a reader catches one
 * class whatever the construction. */
export { FaultEvidenceLimitError, MAX_TARGET_FIELD_BYTES };
export type { ExpectedSnapshot } from "../pool/evidence-chain.js";
export type FaultEvidence = ChainEvidence<keyof EvidencePair, "statement" | "authorization">;
/** The fixed bytes: context, snapshot, both positions, the previous hash and the two field lengths (244). */
export const FIXED_BYTES = LIT_CHAIN.fixedBytes;

/** Strict wire structure, `244 + statementLength + authorizationLength + 64(n − i)` bytes; the target need not be a
 * valid §3 record. The caller supplies its local suffix budget. */
export const encodeFaultEvidence: (input: FaultEvidence, maxSuffixEntries: bigint) => Uint8Array = LIT_CHAIN.encodeFaultEvidence;
/** Every boundary scanned before target or suffix data is copied, and a frame longer than the budget admits refused
 * before it is copied. */
export const decodeFaultEvidence: (bytes: Uint8Array, maxSuffixEntries: bigint) => FaultEvidence = LIT_CHAIN.decodeFaultEvidence;
/** True authenticates the exact target bytes only. False means malformed or unauthenticated data, never exclusion.
 * Budget and programming failures propagate, so callers cannot classify them as operator fault. */
export const verifyFaultEvidence = LIT_CHAIN.verifyFaultEvidence;

/** One §6 intrinsic failure of a target: its own arithmetic, or a signature under a key the statement names (an
 * input's owner) or K resolved from authenticated signed terms (an issue). */
export type IntrinsicFailure = { readonly check: "ARITHMETIC" } |
  { readonly check: "SIGNATURE"; readonly role: "issue" | "owner"; readonly signer: Uint8Array; readonly backing: Uint8Array };

/** Compact intrinsic exclusion (§6, pool-v3 §9.1): the authenticated target's statement decodes canonically under
 * the configuration's domain, its authorization has exactly its kind's length, and a signature under a key the
 * statement names (an input's owner, kinds 2–4) or, for an issue, the backing's K that `issuer` resolves from
 * authenticated signed terms fails, or the statement's own arithmetic does. Each failure is named, in the state
 * machine's order (`ARITHMETIC`, then each owner's `SIGNATURE` in input order). None for anything else: a malformed
 * target or a wrong authorization length (malformed, not intrinsic), an unresolved or invalid K, a withdrawal or
 * settlement (their keys need the demand) and a request (§6 names kinds 2–4 only). */
export function intrinsicFailures(statementIn: Uint8Array, authorizationIn: Uint8Array,
  issuer: (backing: Uint8Array) => Uint8Array | undefined): IntrinsicFailure[] {
  let record: LitRecord;
  try {
    const statement = decodeStatement(statementIn), authorization = copyBytes(authorizationIn);
    if (compareBytes(statement.domain, litConfigHash()) !== 0 || authorization.length !== authorizationLength(statement)) return [];
    record = { statement, authorization };
  } catch (error) {
    if (error instanceof EncodingError) return [];
    throw error;
  }
  const s = record.statement;
  if (s.kind === 5 || s.kind === 6 || s.kind === 7) return [];
  if (s.kind === 1) {
    const key = issuer(Uint8Array.from(s.backing));
    return key !== undefined && isValidPublicKey(key) && !statementSignatureVerifies(record, key) ?
      [{ check: "SIGNATURE", role: "issue", signer: Uint8Array.from(key), backing: Uint8Array.from(s.backing) }] : [];
  }
  const failures: IntrinsicFailure[] = arithmeticHolds(s) ? [] : [{ check: "ARITHMETIC" }], message = statementBytes(s);
  s.inputs.forEach((input, i) => {
    if (!verifySignatureStrict(record.authorization.subarray(64 * i, 64 * i + 64), message, input.owner)) {
      failures.push({ check: "SIGNATURE", role: "owner", signer: Uint8Array.from(input.owner), backing: Uint8Array.from(input.backing) });
    }
  });
  return failures;
}
/** Whether a target has any intrinsic failure (`intrinsicFailures`). */
export function intrinsicallyInvalid(statementIn: Uint8Array, authorizationIn: Uint8Array,
  issuer: (backing: Uint8Array) => Uint8Array | undefined): boolean {
  return intrinsicFailures(statementIn, authorizationIn, issuer).length > 0;
}
