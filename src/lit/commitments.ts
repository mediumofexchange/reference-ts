// Byte conformance for lit-v1 §5: the history and evidence chains, the snapshot
// and the receipt, pool-v3 §7's frames with lit contexts, the evidence pair in
// place of the triple and no note or scope root. Not replay, checkpoint
// classification or adoption.
import { sha256 } from "@noble/hashes/sha2.js";
import { arrayLength, ByteReader, ByteWriter, compareBytes, copyArray, EncodingError } from "../bytes.js";
import {
  LIT_EVIDENCE_LINK_CONTEXT as LINK, LIT_EVIDENCE_SEED_CONTEXT as SEED, LIT_GENESIS_CONTEXT as GENESIS,
  LIT_HISTORY_CONTEXT as HISTORY, LIT_RECEIPT_CONTEXT as RECEIPT, LIT_SNAPSHOT_CONTEXT as SNAPSHOT,
} from "../contexts.js";
import { verifySignatureStrict } from "../keys.js";
import { field32 } from "./notes.js";
import type { EvidencePair } from "./records.js";

const MAX_U64 = (1n << 64n) - 1n;
export const SNAPSHOT_BYTES = SNAPSHOT.length + 144;
export const RECEIPT_MESSAGE_BYTES = RECEIPT.length + 176;
export const RECEIPT_BYTES = RECEIPT_MESSAGE_BYTES + 96;

function object(value: unknown): asserts value is { readonly [key: string]: unknown } {
  if (value === null || typeof value !== "object") throw new EncodingError("not an object");
}
function u64(value: unknown, positive = false): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64 || (positive && value === 0n)) throw new EncodingError("invalid u64");
  return value;
}
function context(r: ByteReader, expected: Uint8Array): void {
  if (compareBytes(r.raw(expected.length), expected) !== 0) throw new EncodingError("wrong context");
}
function ownPair(value: EvidencePair): EvidencePair {
  object(value);
  const { statementHash, signatureHash } = value;
  return { statementHash: field32(statementHash, "statement hash"), signatureHash: field32(signatureHash, "signature hash") };
}
function seed(tag: Uint8Array, segment: Uint8Array): Uint8Array {
  const w = new ByteWriter(); w.context(tag); w.key32(field32(segment, "segment"), "segment"); return sha256(w.finish());
}
export function genesisHistoryHash(segment: Uint8Array): Uint8Array { return seed(GENESIS, segment); }
export function genesisEvidenceHash(segment: Uint8Array): Uint8Array { return seed(SEED, segment); }

/** `historyHash_i`; the caller supplies the spent root valid replay produced (pool-spent C1.2.8–9). */
export function nextHistoryHash(previous: Uint8Array, statement: Uint8Array, spentRoot: Uint8Array, position: bigint): Uint8Array {
  const w = new ByteWriter(); w.context(HISTORY);
  w.key32(field32(previous, "previous"), "previous"); w.key32(field32(statement, "statement hash"), "statement hash");
  w.key32(field32(spentRoot, "spent root"), "spent root"); w.u64(u64(position, true));
  return sha256(w.finish());
}
/** `evidenceHash_i`; failing committed evidence hashes too, so nothing is validated here. */
export function nextEvidenceHash(previous: Uint8Array, evidence: EvidencePair, position: bigint): Uint8Array {
  const pair = ownPair(evidence), w = new ByteWriter(); w.context(LINK);
  w.key32(field32(previous, "previous"), "previous"); w.key32(pair.statementHash, "statement hash");
  w.key32(pair.signatureHash, "signature hash"); w.u64(u64(position, true));
  return sha256(w.finish());
}

export interface Snapshot {
  readonly backing: Uint8Array;
  readonly segment: Uint8Array;
  readonly historyHash: Uint8Array;
  readonly evidenceHash: Uint8Array;
  readonly issued: bigint;
  readonly burned: bigint;
}
/** The 163-byte snapshot; authenticates even an invalid supply assertion, which replay judges. */
export function snapshotBytes(snapshot: Snapshot): Uint8Array {
  object(snapshot);
  const { backing, segment, historyHash, evidenceHash, issued, burned } = snapshot;
  const w = new ByteWriter(); w.context(SNAPSHOT);
  for (const [value, what] of [[backing, "backing"], [segment, "segment"], [historyHash, "history hash"], [evidenceHash, "evidence hash"]] as const) {
    w.key32(field32(value, what), what);
  }
  w.u64(u64(issued)); w.u64(u64(burned));
  return w.finish();
}
export function snapshotDigest(snapshot: Snapshot): Uint8Array { return sha256(snapshotBytes(snapshot)); }
export function decodeSnapshot(bytes: Uint8Array): Snapshot {
  const r = new ByteReader(bytes); context(r, SNAPSHOT);
  const s = { backing: r.raw(32), segment: r.raw(32), historyHash: r.raw(32), evidenceHash: r.raw(32), issued: r.u64(), burned: r.u64() };
  r.expectEnd();
  return Object.freeze(s);
}

/** A hash opening of the evidence chain at `position` of a snapshot `length` long. */
export interface EvidenceOpening {
  readonly position: bigint;
  readonly length: bigint;
  readonly previous: Uint8Array;
  readonly target: EvidencePair;
  readonly suffix: readonly EvidencePair[];
}
/** The expected digest must come from an authenticated directory; a caller-chosen one has no authority. Answers
 * preimage and suffix authentication only, never validity, finality or exclusion. */
export function verifyEvidenceOpening(expectedIn: Uint8Array, snapshotIn: Snapshot, opening: EvidenceOpening): boolean {
  try {
    const expected = field32(expectedIn, "digest"), snapshot = decodeSnapshot(snapshotBytes(snapshotIn));
    if (compareBytes(snapshotDigest(snapshot), expected) !== 0) return false;
    object(opening);
    const { position, length, previous: previousIn, target: targetIn, suffix: suffixIn } = opening;
    if (typeof position !== "bigint" || typeof length !== "bigint" || position < 1n || length > MAX_U64 || length < position ||
        !Array.isArray(suffixIn) || length - position !== BigInt(arrayLength(suffixIn))) return false;
    const previous = field32(previousIn, "previous"), target = ownPair(targetIn);
    const suffix = copyArray(suffixIn, ownPair, Number(length - position));
    if (BigInt(suffix.length) !== length - position) return false;
    if (position === 1n && compareBytes(previous, genesisEvidenceHash(snapshot.segment)) !== 0) return false;
    let result = nextEvidenceHash(previous, target, position);
    for (let i = 0; i < suffix.length; i++) result = nextEvidenceHash(result, suffix[i]!, position + BigInt(i) + 1n);
    return compareBytes(result, snapshot.evidenceHash) === 0;
  } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
}

export interface ReceiptFields extends EvidencePair {
  readonly domain: Uint8Array;
  readonly segment: Uint8Array;
  readonly position: bigint;
  readonly historyHash: Uint8Array;
  readonly after: bigint;
}
export interface Receipt extends ReceiptFields {
  readonly operator: Uint8Array;
  readonly signature: Uint8Array;
}
export interface ReceiptAuthority {
  readonly domain: Uint8Array;
  readonly segment: Uint8Array;
  readonly operator: Uint8Array;
}
function ownFields(value: ReceiptFields): ReceiptFields {
  object(value);
  const { domain, segment, position, statementHash, historyHash, signatureHash, after } = value;
  return { domain: field32(domain, "domain"), segment: field32(segment, "segment"), position: u64(position, true),
    statementHash: field32(statementHash, "statement hash"), historyHash: field32(historyHash, "history hash"),
    signatureHash: field32(signatureHash, "signature hash"), after: u64(after) };
}
/** The operator's 194-byte signed message: no scope root, since the segment binds the scope. */
export function receiptBytes(fields: ReceiptFields): Uint8Array {
  const r = ownFields(fields), w = new ByteWriter(); w.context(RECEIPT);
  w.key32(r.domain, "domain"); w.key32(r.segment, "segment"); w.u64(r.position);
  w.key32(r.statementHash, "statement hash"); w.key32(r.historyHash, "history hash"); w.key32(r.signatureHash, "signature hash");
  w.u64(r.after);
  return w.finish();
}
/** The 290-byte receipt record: the message, the operator key and its signature. */
export function encodeReceipt(receipt: Receipt): Uint8Array {
  object(receipt);
  const { operator, signature } = receipt;
  const w = new ByteWriter(); w.context(receiptBytes(receipt)); w.key32(field32(operator, "operator"), "operator");
  w.fixed(signature, 64, "signature");
  return w.finish();
}
export function decodeReceipt(bytes: Uint8Array): Receipt {
  const r = new ByteReader(bytes); context(r, RECEIPT);
  const receipt = { domain: r.raw(32), segment: r.raw(32), position: r.u64(), statementHash: r.raw(32), historyHash: r.raw(32),
    signatureHash: r.raw(32), after: r.u64(), operator: r.raw(32), signature: r.raw(64) };
  r.expectEnd();
  if (receipt.position === 0n) throw new EncodingError("receipt position is zero");
  return Object.freeze(receipt);
}
/** Verify the exact signed fields against the expected segment authority. Whether `after` is of the receipt's
 * segment (§6, pool-v3 §7.1) and whether the statement was adopted are the caller's. */
export function verifyReceipt(authorityIn: ReceiptAuthority, receiptIn: Receipt): boolean {
  try {
    object(authorityIn);
    const receipt = decodeReceipt(encodeReceipt(receiptIn));
    const { domain, segment, operator } = authorityIn;
    return compareBytes(field32(domain, "domain"), receipt.domain) === 0 && compareBytes(field32(segment, "segment"), receipt.segment) === 0 &&
      compareBytes(field32(operator, "operator"), receipt.operator) === 0 &&
      verifySignatureStrict(receipt.signature, receiptBytes(receipt), receipt.operator);
  } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
}
/** Compare the inclusion fields to an event already authenticated in a valid checkpoint of the same segment; this
 * comparison alone grants neither validity nor inclusion. */
export function receiptMatchesEvent(receiptIn: ReceiptFields,
  eventIn: Pick<ReceiptFields, "position" | "statementHash" | "historyHash" | "signatureHash">): boolean {
  try {
    const receipt = ownFields(receiptIn);
    object(eventIn);
    const { position, statementHash, historyHash, signatureHash } = eventIn;
    const event = { position: u64(position, true), statementHash: field32(statementHash, "statement hash"),
      historyHash: field32(historyHash, "history hash"), signatureHash: field32(signatureHash, "signature hash") };
    return receipt.position === event.position && compareBytes(receipt.statementHash, event.statementHash) === 0 &&
      compareBytes(receipt.historyHash, event.historyHash) === 0 && compareBytes(receipt.signatureHash, event.signatureHash) === 0;
  } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
}
