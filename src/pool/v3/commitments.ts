// Byte conformance for pool-v3 §7 at 4a58fdc. This is not runtime replay,
// checkpoint classification, a certificate transport or an adopted domain.
import { sha256 } from "@noble/hashes/sha2.js";
import { ByteReader, ByteWriter, compareBytes, copyBytes, EncodingError } from "../../bytes.js";
import {
  V3_EVIDENCE_LINK_CONTEXT as LINK, V3_EVIDENCE_SEED_CONTEXT as SEED, V3_GENESIS_CONTEXT as GENESIS,
  V3_HISTORY_CONTEXT as HISTORY, V3_RECEIPT_CONTEXT as RECEIPT, V3_SNAPSHOT_CONTEXT as SNAPSHOT,
} from "../../contexts.js";
import { bytesToField, fieldToBytes, isValue } from "../field.js";
import { verifySignatureStrict } from "../../keys.js";
import type { EvidenceDigests } from "./records.js";


function object(value: unknown): void {
  if (value === null || typeof value !== "object") throw new EncodingError("not an object");
}
function fixed(w: ByteWriter, bytes: Uint8Array, width = 32): void {
  w.fixed(bytes, width, "fixed field");
}
/** An owned copy of a caller's 32-byte field. */
function owned(bytes: Uint8Array): Uint8Array {
  const own = copyBytes(bytes);
  if (own.length !== 32) throw new EncodingError("fixed field must be 32 bytes");
  return own;
}
function u64(w: ByteWriter, value: bigint, positive = false): void {
  if (!isValue(value) || (positive && value === 0n)) throw new EncodingError("invalid u64");
  w.u64(value);
}
function context(r: ByteReader, expected: Uint8Array): void {
  if (compareBytes(r.raw(expected.length), expected) !== 0) throw new EncodingError("wrong context");
}
function digest(w: ByteWriter): Uint8Array { return sha256(w.finish()); }
function seed(context: Uint8Array, segment: Uint8Array): Uint8Array {
  const w = new ByteWriter(); w.context(context); fixed(w, segment); return digest(w);
}
export function genesisHistoryHash(segment: Uint8Array): Uint8Array { return seed(GENESIS, segment); }
export function genesisEvidenceHash(segment: Uint8Array): Uint8Array { return seed(SEED, segment); }

/** Hash an assertion; caller supplies the validated resulting roots for valid replay. */
export function nextHistoryHash(previous: Uint8Array, statement: Uint8Array,
  noteRoot: bigint, spentRoot: Uint8Array, position: bigint): Uint8Array {
  const w = new ByteWriter(); w.context(HISTORY);
  fixed(w, previous); fixed(w, statement); fixed(w, fieldToBytes(noteRoot)); fixed(w, spentRoot); u64(w, position, true);
  return digest(w);
}
/** No proof/authorization validation: failing committed evidence must also hash. */
export function nextEvidenceHash(previous: Uint8Array, evidence: EvidenceDigests, position: bigint): Uint8Array {
  object(evidence);
  const w = new ByteWriter(); w.context(LINK); fixed(w, previous);
  fixed(w, evidence.statementHash); fixed(w, evidence.proofHash); fixed(w, evidence.signatureHash); u64(w, position, true);
  return digest(w);
}

export interface Snapshot {
  readonly backing: Uint8Array;
  readonly segment: Uint8Array;
  readonly historyHash: Uint8Array;
  readonly evidenceHash: Uint8Array;
  readonly issued: bigint;
  readonly burned: bigint;
}
/** Authenticate even an invalid supply assertion. Replay checks burned <= issued. */
export function snapshotBytes(s: Snapshot): Uint8Array {
  object(s);
  const w = new ByteWriter(); w.context(SNAPSHOT);
  for (const value of [s.backing, s.segment, s.historyHash, s.evidenceHash]) fixed(w, value);
  u64(w, s.issued); u64(w, s.burned); return w.finish();
}
export function snapshotDigest(s: Snapshot): Uint8Array { return sha256(snapshotBytes(s)); }
export function decodeSnapshot(bytes: Uint8Array): Snapshot {
  const r = new ByteReader(bytes); context(r, SNAPSHOT);
  const s = { backing: r.raw(32), segment: r.raw(32), historyHash: r.raw(32), evidenceHash: r.raw(32),
    issued: r.u64(), burned: r.u64() }; r.expectEnd();
  return Object.freeze(s);
}

/** A hash opening, not a wire certificate. The target digests must separately
 * match the supplied target bytes; later digests authenticate no later contents. */
export interface EvidenceOpening {
  readonly position: bigint;
  readonly length: bigint;
  readonly previous: Uint8Array;
  readonly target: EvidenceDigests;
  readonly suffix: readonly EvidenceDigests[];
}

/** The expected snapshot digest MUST come from the expected signed commitment's
 * authenticated directory. A caller-chosen digest has no authority. Returns
 * only preimage/suffix authentication; never validity, finality or exclusion.
 * Resource or unexpected programming failures propagate, not a fault verdict. */
export function verifyEvidenceOpening(expectedSnapshotDigest: Uint8Array, snapshot: Snapshot, opening: EvidenceOpening): boolean {
  try {
    const w = new ByteWriter(); fixed(w, expectedSnapshotDigest);
    if (compareBytes(snapshotDigest(snapshot), expectedSnapshotDigest) !== 0) return false;
    object(opening);
    if (!isValue(opening.position) || opening.position === 0n || !isValue(opening.length) ||
        opening.length < opening.position || !Array.isArray(opening.suffix) ||
        opening.length - opening.position !== BigInt(opening.suffix.length)) return false;
    if (opening.position === 1n) {
      fixed(w, opening.previous);
      if (compareBytes(opening.previous, genesisEvidenceHash(snapshot.segment)) !== 0) return false;
    }
    let result = nextEvidenceHash(opening.previous, opening.target, opening.position);
    for (let i = 0; i < opening.suffix.length; i++) {
      result = nextEvidenceHash(result, opening.suffix[i]!, opening.position + BigInt(i) + 1n);
    }
    return compareBytes(result, snapshot.evidenceHash) === 0;
  } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
}

export interface ReceiptFields extends EvidenceDigests {
  readonly domain: Uint8Array;
  readonly segment: Uint8Array;
  readonly scopeRoot: bigint;
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
  readonly scopeRoot: bigint;
  readonly operator: Uint8Array;
}
export function receiptBytes(r: ReceiptFields): Uint8Array {
  object(r);
  const w = new ByteWriter(); w.context(RECEIPT);
  fixed(w, r.domain); fixed(w, r.segment); fixed(w, fieldToBytes(r.scopeRoot)); u64(w, r.position, true);
  for (const bytes of [r.statementHash, r.historyHash, r.proofHash, r.signatureHash]) fixed(w, bytes);
  u64(w, r.after); return w.finish();
}
export function encodeReceipt(r: Receipt): Uint8Array {
  const w = new ByteWriter(); w.context(receiptBytes(r)); fixed(w, r.operator); fixed(w, r.signature, 64);
  return w.finish();
}
export function decodeReceipt(bytes: Uint8Array): Receipt {
  const r = new ByteReader(bytes); context(r, RECEIPT);
  const receipt = { domain: r.raw(32), segment: r.raw(32), scopeRoot: bytesToField(r.raw(32)), position: r.u64(),
    statementHash: r.raw(32), historyHash: r.raw(32), proofHash: r.raw(32), signatureHash: r.raw(32), after: r.u64(),
    operator: r.raw(32), signature: r.raw(64) };
  r.expectEnd();
  if (receipt.position === 0n) throw new EncodingError("receipt position is zero");
  return Object.freeze(receipt);
}
/** Verify exact signed fields against the expected segment authority. This
 * neither compares a statement's source segment nor authorizes adoption. */
export function verifyReceipt(authorityIn: ReceiptAuthority, receiptIn: Receipt): boolean {
  try {
    // Both arguments are read once into owned values; the answer is about them.
    object(authorityIn);
    const receipt = decodeReceipt(encodeReceipt(receiptIn)), message = receiptBytes(receipt);
    const authority = { domain: owned(authorityIn.domain), segment: owned(authorityIn.segment),
      operator: owned(authorityIn.operator), scopeRoot: authorityIn.scopeRoot };
    fieldToBytes(authority.scopeRoot);
    return compareBytes(authority.domain, receipt.domain) === 0 && compareBytes(authority.segment, receipt.segment) === 0 &&
      authority.scopeRoot === receipt.scopeRoot && compareBytes(authority.operator, receipt.operator) === 0 &&
      verifySignatureStrict(receipt.signature, message, authority.operator);
  } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
}

/** Compare the five inclusion fields to an event already authenticated in a
 * VALID checkpoint of the same segment. This comparison alone grants neither
 * validity nor inclusion; caller establishes the checkpoint/segment binding. */
export function receiptMatchesEvent(receiptIn: ReceiptFields, eventIn: Pick<ReceiptFields,
  "position" | "statementHash" | "historyHash" | "proofHash" | "signatureHash">): boolean {
  try {
    // Both arguments are read once into owned values; the answer is about them.
    object(receiptIn); object(eventIn);
    const receipt: ReceiptFields = { domain: owned(receiptIn.domain), segment: owned(receiptIn.segment),
      scopeRoot: receiptIn.scopeRoot, position: receiptIn.position, statementHash: owned(receiptIn.statementHash),
      historyHash: owned(receiptIn.historyHash), proofHash: owned(receiptIn.proofHash),
      signatureHash: owned(receiptIn.signatureHash), after: receiptIn.after };
    receiptBytes(receipt);
    const event = { position: eventIn.position, statementHash: owned(eventIn.statementHash), historyHash: owned(eventIn.historyHash),
      proofHash: owned(eventIn.proofHash), signatureHash: owned(eventIn.signatureHash) };
    if (!isValue(event.position) || event.position === 0n) throw new EncodingError("invalid u64");
    for (const key of ["statementHash", "historyHash", "proofHash", "signatureHash"] as const) {
      if (compareBytes(receipt[key], event[key]) !== 0) return false;
    }
    return receipt.position === event.position;
  } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
}
