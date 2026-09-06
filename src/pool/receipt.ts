// The operator's acceptance evidence (pool-v1 §7). Receipt verification
// attributes signed fields to the expected configuration's operator. It
// does not establish a holding, a lawful history, or witnessed finality.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ByteWriter, compareBytes, copyBytes, EncodingError } from "../bytes.js";
import { POOL_RECEIPT_CONTEXT } from "../contexts.js";
import { verifySignatureStrict } from "../keys.js";
import type { AcceptedStatement, Pool } from "./pool.js";
import { configurationHash, copyConfiguration, ISSUE, statementHash, type PoolConfiguration, type Statement } from "./statement.js";

/** Exactly the fields covered by receiptBytes, in specification order. */
export interface PoolReceiptFields {
  readonly configHash: Uint8Array;
  /** The accepted statement's sequence, counted from 1. */
  readonly sequence: bigint;
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

/** Canonical receiptBytes (§7), with fixed widths and bigint u64 counters. */
export function poolReceiptBytes(receipt: PoolReceiptFields): Uint8Array {
  if (typeof receipt.sequence !== "bigint" || receipt.sequence < 1n) {
    throw new EncodingError("receipt sequences count from one");
  }
  if (typeof receipt.after !== "bigint") throw new EncodingError("receipt after must be a bigint");
  const w = new ByteWriter();
  const hash = (bytes: Uint8Array, what: string): void => {
    if (!(bytes instanceof Uint8Array)) throw new EncodingError(`${what} is not bytes`);
    w.key32(bytes, what);
  };
  w.context(POOL_RECEIPT_CONTEXT);
  hash(receipt.configHash, "configuration hash");
  w.u64(receipt.sequence);
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
    configHash: copyBytes(receipt.configHash),
    sequence: receipt.sequence,
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
 * Sign a trusted Pool.admit result under that pool's configuration. This is
 * the envelope only: the sequencing layer must supply the last SIGNED
 * commitment's sequence, retain the original receipt on retries, and make
 * admission and receipt durable before exposing it (C2.8.1, invariant 26).
 * Neither roots nor proof bytes are added to the specified signed frame.
 */
export function signPoolReceipt(
  operatorSecret: Uint8Array,
  configuration: PoolConfiguration,
  accepted: AcceptedStatement,
  after: bigint,
): PoolReceipt {
  const config = copyConfiguration(configuration);
  const operator = ed25519.getPublicKey(operatorSecret);
  if (compareBytes(operator, config.operator) !== 0) {
    throw new EncodingError("receipt signer is not the configuration's operator");
  }
  const fields: PoolReceiptFields = {
    configHash: configurationHash(config),
    sequence: accepted.sequence,
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
 * Strict signature and framing, pinned to the CALLER's configuration. A
 * self-asserted operator or configuration is not authority. Malformed
 * external data answers false, including in the predicates below.
 */
export function verifyPoolReceipt(configuration: PoolConfiguration, receipt: PoolReceipt): boolean {
  try {
    const config = copyConfiguration(configuration);
    const message = poolReceiptBytes(receipt);
    return receipt.operator instanceof Uint8Array &&
      compareBytes(receipt.operator, config.operator) === 0 &&
      compareBytes(receipt.configHash, configurationHash(config)) === 0 &&
      verifySignatureStrict(receipt.signature, message, receipt.operator);
  } catch {
    return false;
  }
}

/**
 * The operator signed this statement's identity. Evidence bytes do not enter
 * that identity (§5): re-proving it does not create another statement. This
 * attributes acceptance; it does not run admission or verify the proof.
 */
export function poolReceiptCovers(configuration: PoolConfiguration, statement: Statement, receipt: PoolReceipt): boolean {
  try {
    return verifyPoolReceipt(configuration, receipt) &&
      compareBytes(statementHash(receipt.configHash, statement.kind, statement.publicInputs), receipt.statementHash) === 0;
  } catch {
    return false;
  }
}

/**
 * Whether these are the exact evidence bytes the operator attested. A
 * replica's changed proof does not match; another valid proof of the same
 * statement need not match either. Deliberately does not check proof or
 * signature validity/length: even bad bytes can be attributed if the
 * operator signed their hashes (§7). This predicate alone alleges no fault.
 */
export function poolReceiptAttestsEvidence(configuration: PoolConfiguration, statement: Statement, receipt: PoolReceipt): boolean {
  try {
    if (!poolReceiptCovers(configuration, statement, receipt) || !(statement.proof instanceof Uint8Array)) return false;
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
 * The receipt's statement and history hash occur at its claimed sequence in
 * this Pool. For a served trail, obtain the Pool with Pool.replay using the
 * expected configuration's verifier first. A replayed prefix proves only
 * itself: this is not a check of currency, after, or witnessed finality.
 * Different valid proof bytes on replay preserve the same history (§7).
 */
export function poolReceiptInHistory(pool: Pool, receipt: PoolReceipt): boolean {
  try {
    if (!verifyPoolReceipt(pool.configuration, receipt)) return false;
    const accepted = pool.acceptedStatement(receipt.statementHash);
    return accepted !== undefined && accepted.sequence === receipt.sequence &&
      compareBytes(accepted.historyHash, receipt.historyHash) === 0;
  } catch {
    return false;
  }
}
