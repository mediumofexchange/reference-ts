// Portable evidence authentication and compact intrinsic exclusion for lit-v1
// §6: pool-v3 §9's frame with the evidence pair in place of the triple, and
// §9.1 with lit's two intrinsic failures. This does not classify checkpoints
// or establish finality.
import { arrayLength, byteLength, compareBytes, copyArray, copyBytes, EncodingError } from "../bytes.js";
import { isValidPublicKey } from "../keys.js";
import { LIT_FAULT_EVIDENCE_CONTEXT as CONTEXT, LIT_SNAPSHOT_CONTEXT as SNAPSHOT_CONTEXT } from "../contexts.js";
import { decodeSnapshot, snapshotBytes, SNAPSHOT_BYTES, verifyEvidenceOpening, type Snapshot } from "./commitments.js";
import { litConfigHash } from "./configuration.js";
import {
  arithmeticHolds, authorizationLength, decodeStatement, hashEvidenceFields, ownerSignaturesVerify, statementSignatureVerifies,
  type EvidencePair, type LitRecord,
} from "./records.js";

const MAX_U64 = (1n << 64n) - 1n;
/** Each target field's transport bound, over the largest valid field (a 583-byte spend statement). */
export const MAX_TARGET_FIELD_BYTES = 4096;
const POSITION = CONTEXT.length + SNAPSHOT_BYTES, PREVIOUS = POSITION + 16, FIELDS = PREVIOUS + 32;
/** The fixed bytes: context, snapshot, both positions, the previous hash and the two field lengths (244). */
export const FIXED_BYTES = FIELDS + 8;
const PAIR_BYTES = 64;

/** A local resource refusal, not malformed evidence or operator fault. */
export class FaultEvidenceLimitError extends Error {}

export interface FaultEvidence {
  readonly snapshot: Snapshot;
  readonly position: bigint;
  readonly length: bigint;
  readonly previous: Uint8Array;
  readonly statement: Uint8Array;
  readonly authorization: Uint8Array;
  readonly suffix: readonly EvidencePair[];
}
/** Established from the expected commitment's signed directory and the authenticated header, never from the record. */
export interface ExpectedSnapshot {
  readonly backing: Uint8Array;
  readonly segment: Uint8Array;
  readonly digest: Uint8Array;
}

function object(v: unknown): asserts v is { readonly [key: string]: unknown } {
  if (typeof v !== "object" || v === null) throw new EncodingError("not an object");
}
/** The caller's bytes as an owned copy: nothing below reads the caller again. */
function bytes(v: unknown, width?: number): Uint8Array {
  let own: Uint8Array;
  try { own = copyBytes(v as Uint8Array); } catch { throw new EncodingError("invalid bytes"); }
  if (width !== undefined && own.length !== width) throw new EncodingError("invalid bytes");
  return own;
}
function u64(v: unknown): v is bigint { return typeof v === "bigint" && v >= 0n && v <= MAX_U64; }
function suffixCount(position: unknown, length: unknown, maximum: bigint): bigint {
  if (!u64(maximum)) throw new EncodingError("invalid suffix budget");
  if (!u64(position) || position === 0n || !u64(length) || length < position) throw new EncodingError("invalid evidence positions");
  const count = length - position;
  if (count > maximum) throw new FaultEvidenceLimitError("suffix exceeds reader budget");
  return count;
}
function target(field: unknown): Uint8Array {
  const own = bytes(field);
  if (own.length > MAX_TARGET_FIELD_BYTES) throw new EncodingError("target field too long");
  return own;
}
/** Each caller field read once into the owned evidence returned, with its snapshot's bytes. */
function requireEvidence(e: FaultEvidence, maximum: bigint): { snapshot: Uint8Array; evidence: FaultEvidence } {
  object(e);
  const { position, length, suffix: suffixField } = e;
  const count = suffixCount(position, length, maximum);
  const declared = Array.isArray(suffixField) ? arrayLength(suffixField) : -1;
  if (BigInt(declared) !== count) throw new EncodingError("wrong evidence suffix length");
  const statement = target(e.statement), authorization = target(e.authorization);
  const previous = bytes(e.previous, 32), snapshot = snapshotBytes(e.snapshot);
  const pairs = copyArray(suffixField, (pair: EvidencePair) => {
    object(pair);
    return Object.freeze({ statementHash: bytes(pair.statementHash, 32), signatureHash: bytes(pair.signatureHash, 32) });
  }, declared);
  if (pairs.length !== declared) throw new EncodingError("wrong evidence suffix length");
  return { snapshot, evidence: Object.freeze({ snapshot: decodeSnapshot(snapshot), position: position as bigint,
    length: length as bigint, previous, statement, authorization, suffix: Object.freeze(pairs) }) };
}

/** Strict wire structure, `244 + statementLength + authorizationLength + 64(n − i)` bytes; the target need not be a
 * valid §3 record. The caller supplies its local suffix budget. */
export function encodeFaultEvidence(input: FaultEvidence, maxSuffixEntries: bigint): Uint8Array {
  const { snapshot, evidence: e } = requireEvidence(input, maxSuffixEntries);
  const out = new Uint8Array(FIXED_BYTES + e.statement.length + e.authorization.length + PAIR_BYTES * e.suffix.length);
  const view = new DataView(out.buffer);
  let offset = 0;
  const put = (b: Uint8Array): void => { out.set(b, offset); offset += b.length; };
  const u64 = (n: bigint): void => { view.setBigUint64(offset, n, false); offset += 8; };
  put(CONTEXT); put(snapshot); u64(e.position); u64(e.length); put(e.previous);
  for (const field of [e.statement, e.authorization]) { view.setUint32(offset, field.length, false); offset += 4; put(field); }
  for (const pair of e.suffix) { put(pair.statementHash); put(pair.signatureHash); }
  return out;
}

function contextAt(input: Uint8Array, start: number, expected: Uint8Array): void {
  for (let i = 0; i < expected.length; i++) if (input[start + i] !== expected[i]) throw new EncodingError("wrong evidence context");
}
/** Every boundary scanned before target or suffix data is copied; the suffix count is judged against the budget
 * before its bytes, and against the exact remaining length after. */
export function decodeFaultEvidence(bytesIn: Uint8Array, maxSuffixEntries: bigint): FaultEvidence {
  if (!u64(maxSuffixEntries)) throw new EncodingError("invalid suffix budget");
  // The longest frame the budget admits, judged before the input is copied.
  if (BigInt(byteLength(bytesIn)) > BigInt(FIXED_BYTES + 2 * MAX_TARGET_FIELD_BYTES) + BigInt(PAIR_BYTES) * maxSuffixEntries) {
    throw new FaultEvidenceLimitError("evidence exceeds reader budget");
  }
  const input = bytes(bytesIn);
  if (input.length < FIXED_BYTES) throw new EncodingError("truncated evidence");
  contextAt(input, 0, CONTEXT); contextAt(input, CONTEXT.length, SNAPSHOT_CONTEXT);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const position = view.getBigUint64(POSITION, false), length = view.getBigUint64(POSITION + 8, false);
  const count = suffixCount(position, length, maxSuffixEntries);
  const fields: { offset: number; length: number }[] = [];
  let offset = FIELDS;
  for (let i = 0; i < 2; i++) {
    if (offset + 4 > input.length) throw new EncodingError("truncated target length");
    const fieldLength = view.getUint32(offset, false); offset += 4;
    if (fieldLength > MAX_TARGET_FIELD_BYTES) throw new EncodingError("target field too long");
    if (offset + fieldLength > input.length) throw new EncodingError("truncated target field");
    fields.push({ offset, length: fieldLength }); offset += fieldLength;
  }
  if (BigInt(input.length - offset) !== BigInt(PAIR_BYTES) * count) throw new EncodingError("wrong suffix byte length");
  const entries = Number(count); // bounded by the input's exact length
  const take = (start: number, n: number): Uint8Array => copyBytes(input.subarray(start, start + n));
  const suffix: EvidencePair[] = [];
  for (let i = 0; i < entries; i++, offset += PAIR_BYTES) {
    suffix.push(Object.freeze({ statementHash: take(offset, 32), signatureHash: take(offset + 32, 32) }));
  }
  return Object.freeze({ snapshot: decodeSnapshot(input.subarray(CONTEXT.length, POSITION)), position, length,
    previous: take(PREVIOUS, 32), statement: take(fields[0]!.offset, fields[0]!.length),
    authorization: take(fields[1]!.offset, fields[1]!.length), suffix: Object.freeze(suffix) });
}

/** True authenticates the exact target bytes only. False means malformed or unauthenticated data, never exclusion.
 * Budget and programming failures propagate, so callers cannot classify them as operator fault. */
export function verifyFaultEvidence(expectedIn: ExpectedSnapshot, input: FaultEvidence, maxSuffixEntries: bigint): boolean {
  try {
    object(expectedIn);
    const expected = { backing: bytes(expectedIn.backing, 32), segment: bytes(expectedIn.segment, 32), digest: bytes(expectedIn.digest, 32) };
    const { evidence: e } = requireEvidence(input, maxSuffixEntries);
    if (compareBytes(e.snapshot.backing, expected.backing) !== 0 || compareBytes(e.snapshot.segment, expected.segment) !== 0) return false;
    return verifyEvidenceOpening(expected.digest, e.snapshot, { position: e.position, length: e.length, previous: e.previous,
      target: hashEvidenceFields(e.statement, e.authorization), suffix: e.suffix });
  } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
}

/** Compact intrinsic exclusion (§6, pool-v3 §9.1): the authenticated target's statement decodes canonically under
 * the configuration's domain, its authorization has exactly its kind's length, and a signature under a key the
 * statement names (an input's owner, kinds 2–4) or, for an issue, the backing's K that `issuer` resolves from
 * authenticated signed terms fails, or the statement's own arithmetic does. False for anything else: a malformed
 * target or a wrong authorization length (malformed, not intrinsic), an unresolved or invalid K, a withdrawal or
 * settlement (their keys need the demand) and a request (§6 names kinds 2–4 only). */
export function intrinsicallyInvalid(statementIn: Uint8Array, authorizationIn: Uint8Array,
  issuer: (backing: Uint8Array) => Uint8Array | undefined): boolean {
  let record: LitRecord;
  try {
    const statement = decodeStatement(statementIn), authorization = bytes(authorizationIn);
    if (compareBytes(statement.domain, litConfigHash()) !== 0 || authorization.length !== authorizationLength(statement)) return false;
    record = { statement, authorization };
  } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
  const s = record.statement;
  if (s.kind === 5 || s.kind === 6 || s.kind === 7) return false;
  if (s.kind === 1) {
    const key = issuer(Uint8Array.from(s.backing));
    return key !== undefined && isValidPublicKey(key) && !statementSignatureVerifies(record, key);
  }
  return !ownerSignaturesVerify(record) || !arithmeticHolds(s);
}
