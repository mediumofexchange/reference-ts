// Byte conformance for lit-v1 §5: the history and evidence chains, the snapshot
// and the receipt, pool-v3 §7's frames with lit contexts, the evidence pair in
// place of the triple and no note or scope root. The evidence chain (seed, link,
// snapshot, opening and §6's fault-evidence frame) is the one in
// `../pool/evidence-chain.ts`. Not replay, checkpoint classification or adoption.
import { sha256 } from "@noble/hashes/sha2.js";
import { ByteReader, ByteWriter, compareBytes, EncodingError } from "../bytes.js";
import {
  LIT_EVIDENCE_LINK_CONTEXT as LINK, LIT_EVIDENCE_SEED_CONTEXT as SEED, LIT_FAULT_EVIDENCE_CONTEXT as FAULT_EVIDENCE,
  LIT_GENESIS_CONTEXT as GENESIS, LIT_HISTORY_CONTEXT as HISTORY, LIT_RECEIPT_CONTEXT as RECEIPT, LIT_SNAPSHOT_CONTEXT as SNAPSHOT,
} from "../contexts.js";
import { verifySignatureStrict } from "../keys.js";
import { evidenceChain, segmentSeed, type EvidenceOpening as ChainOpening } from "../pool/evidence-chain.js";
import { field32 } from "./notes.js";
import { hashEvidenceFields, type EvidencePair } from "./records.js";

const MAX_U64 = (1n << 64n) - 1n;
export type { Snapshot } from "../pool/evidence-chain.js";
export type EvidenceOpening = ChainOpening<keyof EvidencePair>;
/** Each fault-evidence target field's transport bound, over the largest valid field (a 583-byte spend statement). */
export const MAX_TARGET_FIELD_BYTES = 4096;
/** lit's evidence chain; its fault evidence refuses a frame longer than the budget admits before copying it (§6). */
export const LIT_CHAIN = evidenceChain({
  contexts: { seed: SEED, link: LINK, snapshot: SNAPSHOT, faultEvidence: FAULT_EVIDENCE },
  digests: ["statementHash", "signatureHash"], fields: ["statement", "authorization"],
  maxTargetFieldBytes: MAX_TARGET_FIELD_BYTES, boundBeforeCopy: true,
  target: e => hashEvidenceFields(e.statement, e.authorization),
});
export const {
  genesisEvidenceHash, nextEvidenceHash, snapshotBytes, snapshotDigest, decodeSnapshot, verifyEvidenceOpening,
} = LIT_CHAIN;
export const SNAPSHOT_BYTES = LIT_CHAIN.snapshotLength;

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
export function genesisHistoryHash(segment: Uint8Array): Uint8Array { return segmentSeed(GENESIS, segment); }

/** `historyHash_i`; the caller supplies the spent root valid replay produced (pool-spent C1.2.8–9). */
export function nextHistoryHash(previous: Uint8Array, statement: Uint8Array, spentRoot: Uint8Array, position: bigint): Uint8Array {
  const w = new ByteWriter(); w.context(HISTORY);
  w.key32(field32(previous, "previous"), "previous"); w.key32(field32(statement, "statement hash"), "statement hash");
  w.key32(field32(spentRoot, "spent root"), "spent root"); w.u64(u64(position, true));
  return sha256(w.finish());
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
