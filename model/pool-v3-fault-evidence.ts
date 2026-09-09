// Portable evidence authentication, pool-v3 §9 at 322bcae. This does not
// classify checkpoints, validate target records/proofs or establish finality.
import { sha256 } from "@noble/hashes/sha2.js";
import { compareBytes, copyBytes, EncodingError } from "../src/bytes.js";
import { isValue } from "../src/pool/field.js";
import { decodeSnapshot, snapshotBytes, verifyEvidenceOpening, type Snapshot } from "./pool-v3-commitments.js";
import { hashEvidenceFields, type EvidenceDigests } from "./pool-v3-records.js";

const CONTEXT = new TextEncoder().encode("moe/pool/v3/fault-evidence");
const SNAPSHOT_CONTEXT = new TextEncoder().encode("moe/pool/v3/snapshot");
export const MAX_TARGET_FIELD_BYTES = 131072;
const FIXED_BYTES = 250, TRIPLE_BYTES = 96;

/** A local resource refusal, not malformed evidence or operator fault. */
export class FaultEvidenceLimitError extends Error {}

export interface FaultEvidence {
  readonly snapshot: Snapshot;
  readonly position: bigint;
  readonly length: bigint;
  readonly previous: Uint8Array;
  readonly statement: Uint8Array;
  readonly proof: Uint8Array;
  readonly authorization: Uint8Array;
  readonly suffix: readonly EvidenceDigests[];
}
/** Established separately from the expected commitment's signed directory
 * and authenticated header context. Never take these from the record itself. */
export interface ExpectedSnapshot {
  readonly backing: Uint8Array;
  readonly segment: Uint8Array;
  readonly digest: Uint8Array;
}

function object(v: unknown): void {
  if (typeof v !== "object" || v === null) throw new EncodingError("not an object");
}
function bytes(v: unknown, width?: number): asserts v is Uint8Array {
  if (!(v instanceof Uint8Array) || (width !== undefined && v.length !== width)) throw new EncodingError("invalid bytes");
}
function suffixCount(position: bigint, length: bigint, maximum: bigint): bigint {
  if (!isValue(maximum)) throw new EncodingError("invalid suffix budget");
  if (!isValue(position) || position === 0n || !isValue(length) || length < position) {
    throw new EncodingError("invalid evidence positions");
  }
  const count = length - position;
  if (count > maximum) throw new FaultEvidenceLimitError("suffix exceeds reader budget");
  return count;
}
function requireEvidence(e: FaultEvidence, maximum: bigint): Uint8Array {
  object(e);
  const count = suffixCount(e.position, e.length, maximum);
  if (!Array.isArray(e.suffix) || BigInt(e.suffix.length) !== count) throw new EncodingError("wrong evidence suffix length");
  for (const field of [e.statement, e.proof, e.authorization]) {
    bytes(field);
    if (field.length > MAX_TARGET_FIELD_BYTES) throw new EncodingError("target field too long");
  }
  bytes(e.previous, 32);
  const snapshot = snapshotBytes(e.snapshot);
  for (let i = 0; i < e.suffix.length; i++) {
    const triple = e.suffix[i]!; object(triple);
    bytes(triple.statementHash, 32); bytes(triple.proofHash, 32); bytes(triple.signatureHash, 32);
  }
  return snapshot;
}

/** Strict wire structure; raw target bytes need not be valid §5 records.
 * The caller must supply its local suffix budget, including zero if desired. */
export function encodeFaultEvidence(e: FaultEvidence, maxSuffixEntries: bigint): Uint8Array {
  const snapshot = requireEvidence(e, maxSuffixEntries);
  const size = FIXED_BYTES + e.statement.length + e.proof.length + e.authorization.length + TRIPLE_BYTES * e.suffix.length;
  const out = new Uint8Array(size), view = new DataView(out.buffer);
  let offset = 0;
  const put = (b: Uint8Array): void => { out.set(b, offset); offset += b.length; };
  const u64 = (n: bigint): void => { view.setBigUint64(offset, n, false); offset += 8; };
  put(CONTEXT); put(snapshot); u64(e.position); u64(e.length); put(e.previous);
  for (const field of [e.statement, e.proof, e.authorization]) {
    view.setUint32(offset, field.length, false); offset += 4; put(field);
  }
  for (const triple of e.suffix) { put(triple.statementHash); put(triple.proofHash); put(triple.signatureHash); }
  return out;
}

function contextAt(input: Uint8Array, start: number, expected: Uint8Array): void {
  for (let i = 0; i < expected.length; i++) if (input[start + i] !== expected[i]) throw new EncodingError("wrong evidence context");
}

/** Scan every boundary without copying target/suffix data first. Counts use
 * bigint until exact remaining-byte equality establishes a safe array count. */
export function decodeFaultEvidence(input: Uint8Array, maxSuffixEntries: bigint): FaultEvidence {
  bytes(input);
  if (!isValue(maxSuffixEntries)) throw new EncodingError("invalid suffix budget");
  if (input.length < FIXED_BYTES) throw new EncodingError("truncated evidence");
  contextAt(input, 0, CONTEXT); contextAt(input, 26, SNAPSHOT_CONTEXT);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const position = view.getBigUint64(190, false), length = view.getBigUint64(198, false);
  const count = suffixCount(position, length, maxSuffixEntries);
  const fields: { offset: number; length: number }[] = [];
  let offset = 238;
  for (let i = 0; i < 3; i++) {
    if (offset + 4 > input.length) throw new EncodingError("truncated target length");
    const length = view.getUint32(offset, false); offset += 4;
    if (length > MAX_TARGET_FIELD_BYTES) throw new EncodingError("target field too long");
    if (offset + length > input.length) throw new EncodingError("truncated target field");
    fields.push({ offset, length }); offset += length;
  }
  if (BigInt(input.length - offset) !== BigInt(TRIPLE_BYTES) * count) throw new EncodingError("wrong suffix byte length");
  // This conversion is bounded by the already allocated input's exact length.
  const entries = Number(count);
  const take = (start: number, length: number): Uint8Array => copyBytes(input.subarray(start, start + length));
  const target = fields.map(f => take(f.offset, f.length));
  const suffix: EvidenceDigests[] = [];
  for (let i = 0; i < entries; i++) {
    suffix.push(Object.freeze({ statementHash: take(offset, 32), proofHash: take(offset + 32, 32), signatureHash: take(offset + 64, 32) }));
    offset += TRIPLE_BYTES;
  }
  return Object.freeze({ snapshot: decodeSnapshot(input.subarray(26, 190)), position, length,
    previous: take(206, 32), statement: target[0]!, proof: target[1]!, authorization: target[2]!, suffix: Object.freeze(suffix) });
}

/** True authenticates the exact target bytes only. False means malformed or
 * unauthenticated data, never exclusion. Budget/resource/programming failures
 * propagate, so callers cannot accidentally classify them as operator fault. */
export function verifyFaultEvidence(expected: ExpectedSnapshot, e: FaultEvidence, maxSuffixEntries: bigint): boolean {
  try {
    object(expected); bytes(expected.backing, 32); bytes(expected.segment, 32); bytes(expected.digest, 32);
    requireEvidence(e, maxSuffixEntries);
    if (compareBytes(e.snapshot.backing, expected.backing) !== 0 || compareBytes(e.snapshot.segment, expected.segment) !== 0) return false;
    const target = hashEvidenceFields(sha256(e.statement), e.proof, e.authorization);
    return verifyEvidenceOpening(expected.digest, e.snapshot, { position: e.position, length: e.length,
      previous: e.previous, target, suffix: e.suffix });
  } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
}
