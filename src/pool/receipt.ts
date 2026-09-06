// The operator's acceptance evidence (pool-v2 §9; C2.10.8). Receipt
// verification attributes the signed fields to the expected segment's
// operator: the domain, the segment identity and its scope root are in the
// signed frame, and the signer is the header's operator. It does not
// establish a holding, a lawful history, witnessed finality, or that the
// scope's links were in force; those are the record's (C2.10.8).

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ByteWriter, compareBytes, copyBytes, EncodingError } from "../bytes.js";
import { POOL_RECEIPT_CONTEXT } from "../contexts.js";
import { verifySignatureStrict } from "../keys.js";
import { fieldToBytes } from "./field.js";
import type { AcceptedStatement, Segment } from "./segment.js";
import { copySegmentAuthority, ISSUE, statementHash, type SegmentAuthority, type Statement } from "./statement.js";

/** Exactly the fields covered by receiptBytes, in specification order. */
export interface PoolReceiptFields {
  /** configHash, the construction domain. */
  readonly domain: Uint8Array;
  readonly segment: Uint8Array;
  readonly scopeRoot: bigint;
  /** The accepted statement's position, counted from 1. */
  readonly position: bigint;
  readonly statementHash: Uint8Array;
  readonly historyHash: Uint8Array;
  readonly proofHash: Uint8Array;
  /** SHA256(K's admitted signature) for an issuance; 32 zero bytes otherwise. */
  readonly signatureHash: Uint8Array;
  /** Last signed commitment's sequence, starting at 1; 0 means none (C2b.4). */
  readonly after: bigint;
}

export interface PoolReceipt extends PoolReceiptFields {
  readonly operator: Uint8Array;
  readonly signature: Uint8Array;
}

/** Canonical receiptBytes (§9), with fixed widths and bigint u64 counters. */
export function poolReceiptBytes(receipt: PoolReceiptFields): Uint8Array {
  if (typeof receipt.position !== "bigint" || receipt.position < 1n) {
    throw new EncodingError("receipt positions count from one");
  }
  if (typeof receipt.after !== "bigint") throw new EncodingError("receipt after must be a bigint");
  const w = new ByteWriter();
  const hash = (bytes: Uint8Array, what: string): void => {
    if (!(bytes instanceof Uint8Array)) throw new EncodingError(`${what} is not bytes`);
    w.key32(bytes, what);
  };
  w.context(POOL_RECEIPT_CONTEXT);
  hash(receipt.domain, "configuration hash");
  hash(receipt.segment, "segment identity");
  w.key32(fieldToBytes(receipt.scopeRoot), "scope root");
  w.u64(receipt.position);
  hash(receipt.statementHash, "statement hash");
  hash(receipt.historyHash, "history hash");
  hash(receipt.proofHash, "proof hash");
  hash(receipt.signatureHash, "obligor signature hash");
  w.u64(receipt.after);
  return w.finish();
}

/** Owns every byte, including when a caller supplied Node Buffers. */
export function copyPoolReceipt(receipt: PoolReceipt): PoolReceipt {
  return Object.freeze({
    domain: copyBytes(receipt.domain),
    segment: copyBytes(receipt.segment),
    scopeRoot: receipt.scopeRoot,
    position: receipt.position,
    statementHash: copyBytes(receipt.statementHash),
    historyHash: copyBytes(receipt.historyHash),
    proofHash: copyBytes(receipt.proofHash),
    signatureHash: copyBytes(receipt.signatureHash),
    after: receipt.after,
    operator: copyBytes(receipt.operator),
    signature: copyBytes(receipt.signature),
  });
}

/**
 * Sign a trusted Segment.admit result under that segment's authority. This
 * is the envelope only: the sequencing layer must supply the last SIGNED
 * commitment's sequence, retain the original receipt on retries, and make
 * admission and receipt durable before exposing it (C2.8.1, invariant 26).
 * Neither roots nor proof bytes are added to the specified signed frame.
 */
export function signPoolReceipt(
  operatorSecret: Uint8Array,
  authority: SegmentAuthority,
  accepted: AcceptedStatement,
  after: bigint,
): PoolReceipt {
  const own = copySegmentAuthority(authority);
  const operator = ed25519.getPublicKey(operatorSecret);
  if (compareBytes(operator, own.operator) !== 0) {
    throw new EncodingError("receipt signer is not the segment's operator");
  }
  const fields: PoolReceiptFields = {
    domain: own.domain,
    segment: own.segment,
    scopeRoot: own.scopeRoot,
    position: accepted.position,
    statementHash: copyBytes(accepted.statementHash),
    historyHash: copyBytes(accepted.historyHash),
    proofHash: copyBytes(accepted.proofHash),
    signatureHash: accepted.obligorSignatureHash === undefined
      ? new Uint8Array(32) : copyBytes(accepted.obligorSignatureHash),
    after,
  };
  return Object.freeze({ ...fields, operator, signature: ed25519.sign(poolReceiptBytes(fields), operatorSecret) });
}

/**
 * Strict signature and framing, pinned to the CALLER's segment authority:
 * its domain, segment identity, scope root and operator. A self-asserted
 * operator, segment or scope is not authority. Malformed external data
 * answers false, including in the predicates below.
 */
export function verifyPoolReceipt(authority: SegmentAuthority, receipt: PoolReceipt): boolean {
  try {
    const own = copySegmentAuthority(authority);
    const message = poolReceiptBytes(receipt);
    return receipt.operator instanceof Uint8Array &&
      compareBytes(receipt.operator, own.operator) === 0 &&
      compareBytes(receipt.domain, own.domain) === 0 &&
      compareBytes(receipt.segment, own.segment) === 0 &&
      receipt.scopeRoot === own.scopeRoot &&
      verifySignatureStrict(receipt.signature, message, receipt.operator);
  } catch {
    return false;
  }
}

/**
 * The operator signed this statement's identity. Evidence bytes do not enter
 * that identity (§7): re-proving it does not create another statement. This
 * attributes acceptance; it does not run admission or verify the proof.
 */
export function poolReceiptCovers(authority: SegmentAuthority, statement: Statement, receipt: PoolReceipt): boolean {
  try {
    return verifyPoolReceipt(authority, receipt) &&
      compareBytes(statementHash(receipt.domain, statement.kind, statement.publicInputs), receipt.statementHash) === 0;
  } catch {
    return false;
  }
}

/**
 * Whether these are the exact evidence bytes the operator attested. A
 * replica's changed proof does not match; another valid proof of the same
 * statement need not match either. Deliberately does not check proof or
 * signature validity/length: even bad bytes can be attributed if the
 * operator signed their hashes (§9). This predicate alone alleges no fault.
 */
export function poolReceiptAttestsEvidence(authority: SegmentAuthority, statement: Statement, receipt: PoolReceipt): boolean {
  try {
    if (!poolReceiptCovers(authority, statement, receipt) || !(statement.proof instanceof Uint8Array)) return false;
    if (compareBytes(sha256(statement.proof), receipt.proofHash) !== 0) return false;
    if (statement.kind === ISSUE) {
      return statement.obligorSignature instanceof Uint8Array &&
        compareBytes(sha256(statement.obligorSignature), receipt.signatureHash) === 0;
    }
    return statement.obligorSignature === undefined &&
      compareBytes(new Uint8Array(32), receipt.signatureHash) === 0;
  } catch {
    return false;
  }
}

/**
 * The receipt's statement and history hash occur at its claimed position in
 * this Segment. For a served trail, obtain the Segment with Segment.replay
 * using the expected configuration's verifier first. A replayed segment
 * proves only itself and its supplied ancestry: this is not a check of
 * currency, `after`, or witnessed finality. Different valid proof bytes on
 * replay preserve the same history (§9).
 */
export function poolReceiptInHistory(segment: Segment, receipt: PoolReceipt): boolean {
  try {
    if (!verifyPoolReceipt(segment.authority(), receipt)) return false;
    const accepted = segment.acceptedStatement(receipt.statementHash);
    return accepted !== undefined && accepted.position === receipt.position &&
      compareBytes(accepted.historyHash, receipt.historyHash) === 0;
  } catch {
    return false;
  }
}
