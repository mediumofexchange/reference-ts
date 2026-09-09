// Byte conformance for pool-v3 §7 at 4a58fdc. This is not runtime replay,
// checkpoint classification, a certificate transport or an adopted domain.
import { sha256 } from "@noble/hashes/sha2.js";
import { ByteReader, ByteWriter, compareBytes, EncodingError } from "../src/bytes.js";
import { bytesToField, fieldToBytes, isValue } from "../src/pool/field.js";
import { verifySignatureStrict } from "../src/keys.js";
import type { EvidenceDigests } from "./pool-v3-records.js";

const tag = (s: string): Uint8Array => new TextEncoder().encode(`moe/pool/v3/${s}`);
const GENESIS = tag("genesis"), HISTORY = tag("history"), SEED = tag("evidence-seed"),
  LINK = tag("evidence-link"), SNAPSHOT = tag("snapshot"), RECEIPT = tag("receipt");

function object(value: unknown): void {
  if (value === null || typeof value !== "object") throw new EncodingError("not an object");
}
function fixed(w: ByteWriter, bytes: Uint8Array, width = 32): void {
  if (!(bytes instanceof Uint8Array)) throw new EncodingError("not bytes");
  w.fixed(bytes, width, "fixed field");
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
export function verifyReceipt(authority: ReceiptAuthority, receipt: Receipt): boolean {
  try {
    object(authority);
    const message = receiptBytes(receipt), w = new ByteWriter();
    fixed(w, receipt.operator); fixed(w, receipt.signature, 64);
    fixed(w, authority.domain); fixed(w, authority.segment); fixed(w, authority.operator); fixed(w, fieldToBytes(authority.scopeRoot));
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
export function receiptMatchesEvent(receipt: ReceiptFields, event: Pick<ReceiptFields,
  "position" | "statementHash" | "historyHash" | "proofHash" | "signatureHash">): boolean {
  try {
    receiptBytes(receipt); object(event);
    const w = new ByteWriter(); u64(w, event.position, true);
    for (const key of ["statementHash", "historyHash", "proofHash", "signatureHash"] as const) {
      fixed(w, event[key]);
      if (compareBytes(receipt[key], event[key]) !== 0) return false;
    }
    return receipt.position === event.position;
  } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
}
