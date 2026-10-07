// The evidence chain a construction commits, in one implementation: pool-v3 §7's segment seed, evidence link,
// snapshot and hash opening, and §9's portable fault-evidence frame. lit-v1 §5 and §6 read the same frames with
// lit's contexts and the evidence pair in place of the triple, so each construction instantiates `evidenceChain`
// with its contexts, the digests one evidence entry holds and the target fields its fault evidence carries.
// Bytes and verdicts are each construction's own; nothing here classifies checkpoints or establishes finality.
import { sha256 } from "@noble/hashes/sha2.js";
import { arrayLength, ByteReader, ByteWriter, byteLength, compareBytes, copyArray, copyBytes, EncodingError } from "../bytes.js";
import { isValue } from "./field.js";

/** A local resource refusal, not malformed evidence or operator fault: one class whatever the construction. */
export class FaultEvidenceLimitError extends Error {}

export interface Snapshot {
  readonly backing: Uint8Array;
  readonly segment: Uint8Array;
  readonly historyHash: Uint8Array;
  readonly evidenceHash: Uint8Array;
  readonly issued: bigint;
  readonly burned: bigint;
}
/** Established from the expected commitment's signed directory and the authenticated header, never from the record. */
export interface ExpectedSnapshot {
  readonly backing: Uint8Array;
  readonly segment: Uint8Array;
  readonly digest: Uint8Array;
}
/** One evidence entry: its digests by name, in the construction's order. */
export type Digests<D extends string> = { readonly [K in D]: Uint8Array };
/** A hash opening of the evidence chain at `position` of a snapshot `length` long, not a wire certificate. The target
 * digests must separately match the target bytes; later digests authenticate no later contents. */
export interface EvidenceOpening<D extends string> {
  readonly position: bigint;
  readonly length: bigint;
  readonly previous: Uint8Array;
  readonly target: Digests<D>;
  readonly suffix: readonly Digests<D>[];
}
/** Fault evidence: an opening carrying the target's raw fields in place of its digests. */
export type FaultEvidence<D extends string, F extends string> = {
  readonly snapshot: Snapshot;
  readonly position: bigint;
  readonly length: bigint;
  readonly previous: Uint8Array;
  readonly suffix: readonly Digests<D>[];
} & { readonly [K in F]: Uint8Array };

export interface ChainProfile<D extends string, F extends string> {
  readonly contexts: {
    readonly seed: Uint8Array; readonly link: Uint8Array; readonly snapshot: Uint8Array; readonly faultEvidence: Uint8Array;
  };
  /** The digests of one evidence entry, in link and frame order. */
  readonly digests: readonly D[];
  /** The fault evidence's target fields, in frame order. */
  readonly fields: readonly F[];
  /** Each target field's transport bound. */
  readonly maxTargetFieldBytes: number;
  /** Whether a frame longer than the budget admits is refused as a resource limit before it is copied (lit-v1 §6), or
   * left to the frame's own checks (pool-v3 §9, as adopted). */
  readonly boundBeforeCopy: boolean;
  /** The target's entry from its raw fields. */
  readonly target: (fields: { readonly [K in F]: Uint8Array }) => Digests<D>;
}

const SNAPSHOT_FIELDS = ["backing", "segment", "historyHash", "evidenceHash"] as const;

function object(value: unknown): asserts value is { readonly [key: string]: unknown } {
  if (value === null || typeof value !== "object") throw new EncodingError("not an object");
}
/** The caller's bytes as an owned copy, of `width` bytes where given: nothing below reads the caller again. */
function bytes(value: unknown, width?: number): Uint8Array {
  const own = copyBytes(value as Uint8Array);
  if (width !== undefined && own.length !== width) throw new EncodingError("invalid bytes");
  return own;
}
function u64(w: ByteWriter, value: bigint, positive = false): void {
  if (!isValue(value) || (positive && value === 0n)) throw new EncodingError("invalid u64");
  w.u64(value);
}
function contextAt(input: Uint8Array, start: number, expected: Uint8Array): void {
  for (let i = 0; i < expected.length; i++) if (input[start + i] !== expected[i]) throw new EncodingError("wrong evidence context");
}

/** `H(context || segment)`: a chain's genesis value. */
export function segmentSeed(context: Uint8Array, segment: Uint8Array): Uint8Array {
  const w = new ByteWriter(); w.context(context); w.key32(segment, "segment"); return sha256(w.finish());
}

export function evidenceChain<D extends string, F extends string>(profile: ChainProfile<D, F>) {
  const { contexts, digests, fields, maxTargetFieldBytes, boundBeforeCopy, target } = profile;
  const snapshotLength = contexts.snapshot.length + 144, entryBytes = 32 * digests.length;
  const positionAt = contexts.faultEvidence.length + snapshotLength, fieldsAt = positionAt + 16 + 32;
  const fixedBytes = fieldsAt + 4 * fields.length;

  /** An owned entry, each digest read once. */
  function ownEntry(value: Digests<D>): Digests<D> {
    object(value);
    const own = {} as { [K in D]: Uint8Array };
    for (const name of digests) own[name] = bytes(value[name], 32);
    return Object.freeze(own);
  }
  /** `evidenceHash_i`; failing committed evidence hashes too, so nothing is validated here. */
  function nextEvidenceHash(previous: Uint8Array, evidence: Digests<D>, position: bigint): Uint8Array {
    const entry = ownEntry(evidence), w = new ByteWriter(); w.context(contexts.link); w.key32(previous, "previous");
    for (const name of digests) w.key32(entry[name], name);
    u64(w, position, true);
    return sha256(w.finish());
  }
  const genesisEvidenceHash = (segment: Uint8Array): Uint8Array => segmentSeed(contexts.seed, segment);

  /** The snapshot's bytes; authenticates even an invalid supply assertion, which replay judges. */
  function snapshotBytes(snapshot: Snapshot): Uint8Array {
    object(snapshot);
    const w = new ByteWriter(); w.context(contexts.snapshot);
    for (const name of SNAPSHOT_FIELDS) w.key32(snapshot[name], name);
    u64(w, snapshot.issued); u64(w, snapshot.burned);
    return w.finish();
  }
  const snapshotDigest = (snapshot: Snapshot): Uint8Array => sha256(snapshotBytes(snapshot));
  function decodeSnapshot(input: Uint8Array): Snapshot {
    const r = new ByteReader(input);
    if (compareBytes(r.raw(contexts.snapshot.length), contexts.snapshot) !== 0) throw new EncodingError("wrong context");
    const s = { backing: r.raw(32), segment: r.raw(32), historyHash: r.raw(32), evidenceHash: r.raw(32), issued: r.u64(), burned: r.u64() };
    r.expectEnd();
    return Object.freeze(s);
  }

  /** The expected digest must come from the expected signed commitment's authenticated directory; a caller-chosen one
   * has no authority. Answers preimage and suffix authentication only, never validity, finality or exclusion.
   * Resource or unexpected programming failures propagate, not a fault verdict. */
  function verifyEvidenceOpening(expectedIn: Uint8Array, snapshotIn: Snapshot, opening: EvidenceOpening<D>): boolean {
    try {
      // Every argument is read once into owned values; the answer is about them.
      const expected = bytes(expectedIn, 32), snapshot = decodeSnapshot(snapshotBytes(snapshotIn));
      if (compareBytes(snapshotDigest(snapshot), expected) !== 0) return false;
      object(opening);
      const { position, length, previous: previousIn, target: targetIn, suffix: suffixIn } = opening;
      if (!isValue(position) || position === 0n || !isValue(length) || length < position || !Array.isArray(suffixIn) ||
          length - position !== BigInt(arrayLength(suffixIn))) return false;
      const previous = bytes(previousIn, 32), entry = ownEntry(targetIn);
      const suffix = copyArray(suffixIn, ownEntry, Number(length - position));
      if (BigInt(suffix.length) !== length - position) return false;
      if (position === 1n && compareBytes(previous, genesisEvidenceHash(snapshot.segment)) !== 0) return false;
      let result = nextEvidenceHash(previous, entry, position);
      for (let i = 0; i < suffix.length; i++) result = nextEvidenceHash(result, suffix[i]!, position + BigInt(i) + 1n);
      return compareBytes(result, snapshot.evidenceHash) === 0;
    } catch (error) {
      if (error instanceof EncodingError) return false;
      throw error;
    }
  }

  function suffixCount(position: unknown, length: unknown, maximum: bigint): bigint {
    if (!isValue(maximum)) throw new EncodingError("invalid suffix budget");
    if (!isValue(position) || position === 0n || !isValue(length) || length < position) {
      throw new EncodingError("invalid evidence positions");
    }
    const count = length - position;
    if (count > maximum) throw new FaultEvidenceLimitError("suffix exceeds reader budget");
    return count;
  }
  function targetField(value: unknown): Uint8Array {
    const own = bytes(value);
    if (own.length > maxTargetFieldBytes) throw new EncodingError("target field too long");
    return own;
  }
  /** Each caller field read once into the owned evidence returned, with its snapshot's bytes, the only values the
   * encoder and the verifier then read. */
  function requireEvidence(e: FaultEvidence<D, F>, maximum: bigint): { snapshot: Uint8Array; evidence: FaultEvidence<D, F> } {
    object(e);
    const position = e.position, length = e.length, suffixField = e.suffix;
    const count = suffixCount(position, length, maximum);
    // The suffix length is checked before any entry is read, then each entry is read and judged once, so a long
    // sparse array stops at its first hole.
    const declared = Array.isArray(suffixField) ? arrayLength(suffixField) : -1;
    if (BigInt(declared) !== count) throw new EncodingError("wrong evidence suffix length");
    const own = {} as { [K in F]: Uint8Array };
    for (const name of fields) own[name] = targetField(e[name]);
    const previous = bytes(e.previous, 32), snapshot = snapshotBytes(e.snapshot);
    const entries = copyArray(suffixField, ownEntry, declared);
    if (entries.length !== declared) throw new EncodingError("wrong evidence suffix length");
    return { snapshot, evidence: Object.freeze({ snapshot: decodeSnapshot(snapshot), position, length, previous, ...own,
      suffix: Object.freeze(entries) }) as FaultEvidence<D, F> };
  }

  /** Strict wire structure: context, snapshot, both positions, the previous hash, each target field behind its u32
   * length, then the suffix's entries. The target need not be a valid record. The caller supplies its local suffix
   * budget, including zero if desired. */
  function encodeFaultEvidence(input: FaultEvidence<D, F>, maxSuffixEntries: bigint): Uint8Array {
    const { snapshot, evidence: e } = requireEvidence(input, maxSuffixEntries);
    const targets = fields.map(name => e[name] as Uint8Array);
    const out = new Uint8Array(fixedBytes + targets.reduce((n, field) => n + field.length, 0) + entryBytes * e.suffix.length);
    const view = new DataView(out.buffer);
    let offset = 0;
    const put = (b: Uint8Array): void => { out.set(b, offset); offset += b.length; };
    const u64 = (n: bigint): void => { view.setBigUint64(offset, n, false); offset += 8; };
    put(contexts.faultEvidence); put(snapshot); u64(e.position); u64(e.length); put(e.previous);
    for (const field of targets) { view.setUint32(offset, field.length, false); offset += 4; put(field); }
    for (const entry of e.suffix) for (const name of digests) put(entry[name]);
    return out;
  }

  /** Every boundary scanned before target or suffix data is copied; the suffix count is judged against the budget
   * before its bytes, and against the exact remaining length after. */
  function decodeFaultEvidence(bytesIn: Uint8Array, maxSuffixEntries: bigint): FaultEvidence<D, F> {
    if (!isValue(maxSuffixEntries)) throw new EncodingError("invalid suffix budget");
    if (boundBeforeCopy && BigInt(byteLength(bytesIn)) >
        BigInt(fixedBytes + fields.length * maxTargetFieldBytes) + BigInt(entryBytes) * maxSuffixEntries) {
      throw new FaultEvidenceLimitError("evidence exceeds reader budget");
    }
    const input = bytes(bytesIn);
    if (input.length < fixedBytes) throw new EncodingError("truncated evidence");
    contextAt(input, 0, contexts.faultEvidence); contextAt(input, contexts.faultEvidence.length, contexts.snapshot);
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const position = view.getBigUint64(positionAt, false), length = view.getBigUint64(positionAt + 8, false);
    const count = suffixCount(position, length, maxSuffixEntries);
    const spans: { offset: number; length: number }[] = [];
    let offset = fieldsAt;
    for (let i = 0; i < fields.length; i++) {
      if (offset + 4 > input.length) throw new EncodingError("truncated target length");
      const fieldLength = view.getUint32(offset, false); offset += 4;
      if (fieldLength > maxTargetFieldBytes) throw new EncodingError("target field too long");
      if (offset + fieldLength > input.length) throw new EncodingError("truncated target field");
      spans.push({ offset, length: fieldLength }); offset += fieldLength;
    }
    if (BigInt(input.length - offset) !== BigInt(entryBytes) * count) throw new EncodingError("wrong suffix byte length");
    const entries = Number(count); // bounded by the already allocated input's exact length
    const take = (start: number, n: number): Uint8Array => copyBytes(input.subarray(start, start + n));
    const own = {} as { [K in F]: Uint8Array };
    fields.forEach((name, i) => { own[name] = take(spans[i]!.offset, spans[i]!.length); });
    const suffix: Digests<D>[] = [];
    for (let i = 0; i < entries; i++) {
      const entry = {} as { [K in D]: Uint8Array };
      for (const name of digests) { entry[name] = take(offset, 32); offset += 32; }
      suffix.push(Object.freeze(entry));
    }
    return Object.freeze({ snapshot: decodeSnapshot(input.subarray(contexts.faultEvidence.length, positionAt)), position, length,
      previous: take(positionAt + 16, 32), ...own, suffix: Object.freeze(suffix) }) as FaultEvidence<D, F>;
  }

  /** True authenticates the exact target bytes only. False means malformed or unauthenticated data, never exclusion.
   * Budget, resource and programming failures propagate, so callers cannot classify them as operator fault. */
  function verifyFaultEvidence(expectedIn: ExpectedSnapshot, input: FaultEvidence<D, F>, maxSuffixEntries: bigint): boolean {
    try {
      // Every argument is read once into owned values; the answer is about them.
      object(expectedIn);
      const expected = { backing: bytes(expectedIn.backing, 32), segment: bytes(expectedIn.segment, 32), digest: bytes(expectedIn.digest, 32) };
      const { evidence: e } = requireEvidence(input, maxSuffixEntries);
      if (compareBytes(e.snapshot.backing, expected.backing) !== 0 || compareBytes(e.snapshot.segment, expected.segment) !== 0) return false;
      return verifyEvidenceOpening(expected.digest, e.snapshot, { position: e.position, length: e.length, previous: e.previous,
        target: target(e), suffix: e.suffix });
    } catch (error) {
      if (error instanceof EncodingError) return false;
      throw error;
    }
  }

  return Object.freeze({
    snapshotLength, fixedBytes, genesisEvidenceHash, nextEvidenceHash, snapshotBytes, snapshotDigest, decodeSnapshot,
    verifyEvidenceOpening, encodeFaultEvidence, decodeFaultEvidence, verifyFaultEvidence,
  });
}
