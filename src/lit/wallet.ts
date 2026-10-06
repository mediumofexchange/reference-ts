// What the one wallet (pool/v3/wallet-store.ts) builds for a lit backing (slice 14 M14g; lit-v1 §8, a draft until
// adopted): the payment request, which names a backing, a quantity and an owner key in place of an exact output, and the
// statements it authorizes by its notes' owner keys in place of a proof.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ByteReader, ByteWriter, compareBytes, copyUnshared, EncodingError } from "../bytes.js";
import { field32, key32, positive, type Opening, type Output } from "./notes.js";
import { encodeRecord, statementBytes, type Statement } from "./records.js";

/** §8: what a payer is asked to pay, on an authenticated channel. The owner key is the receiver's for this request
 * alone; outputs are public, so the frame carries nothing secret. */
export interface LitPaymentRequest {
  readonly domain: Uint8Array;
  readonly backing: Uint8Array;
  readonly value: bigint;
  readonly owner: Uint8Array;
}

/** Own and check a request against the payer's agreed domain, backing and amount. This is not recipient
 * authentication or evidence of payment. */
export function copyLitPaymentRequest(input: LitPaymentRequest,
  expected: { readonly domain: Uint8Array; readonly backing: Uint8Array; readonly value: bigint }): LitPaymentRequest {
  let own: LitPaymentRequest;
  try {
    const { domain, backing, value, owner } = input;
    own = { domain: field32(domain, "request domain"), backing: field32(backing, "request backing"), value: positive(value, "request value"),
      owner: key32(owner, "request owner") };
  } catch { throw new EncodingError("invalid lit payment request"); }
  if (compareBytes(own.domain, copyUnshared(expected.domain)) !== 0 || compareBytes(own.backing, copyUnshared(expected.backing)) !== 0 ||
      own.value !== expected.value) throw new EncodingError("invalid lit payment request");
  return own;
}

/** An application frame's tag, never signed or part of a statement; like pool-v3's request tag it lives beside its
 * codec, and its test checks it against contexts.ts for prefix freedom. */
export const WALLET_LIT_REQUEST_CONTEXT = new TextEncoder().encode("moe/wallet/lit/v1/request");
/** Tag, domain, backing, value and owner key. */
export const LIT_PAYMENT_REQUEST_BYTES = WALLET_LIT_REQUEST_CONTEXT.length + 32 + 32 + 8 + 32;

/** The canonical fixed-width frame of a request. */
export function encodeLitPaymentRequest(request: LitPaymentRequest): Uint8Array {
  const own = copyLitPaymentRequest(request, { domain: request.domain, backing: request.backing, value: request.value });
  const w = new ByteWriter();
  w.context(WALLET_LIT_REQUEST_CONTEXT);
  w.key32(own.domain, "request domain"); w.key32(own.backing, "request backing"); w.u64(own.value); w.key32(own.owner, "request owner");
  return w.finish();
}
function decode(frame: Uint8Array): LitPaymentRequest {
  const r = new ByteReader(frame);
  if (compareBytes(r.raw(WALLET_LIT_REQUEST_CONTEXT.length), WALLET_LIT_REQUEST_CONTEXT) !== 0) throw new EncodingError("not a lit payment request");
  const domain = r.raw(32), backing = r.raw(32), value = r.u64(), owner = r.raw(32);
  r.expectEnd();
  return copyLitPaymentRequest({ domain, backing, value, owner }, { domain, backing, value });
}
/** SHA-256 of the exact frame, as 64 lowercase hex digits. */
export function litPaymentRequestDigest(frame: Uint8Array): string {
  const own = copyUnshared(frame);
  decode(own);
  return bytesToHex(sha256(own));
}
/** Strict structural reading for display; it authenticates nothing. */
export function readLitPaymentRequest(frame: Uint8Array): LitPaymentRequest { return decode(copyUnshared(frame)); }
/** The payer's entry: the frame must hash to a digest obtained independently from the intended receiver. */
export function authenticateLitPaymentRequest(frame: Uint8Array, trustedDigest: string): LitPaymentRequest {
  const own = copyUnshared(frame);
  if (typeof trustedDigest !== "string" || !/^[0-9a-f]{64}$/.test(trustedDigest) || bytesToHex(sha256(own)) !== trustedDigest) {
    throw new EncodingError("payment request does not match the trusted digest");
  }
  return decode(own);
}

/** A note to spend: its opening and its owner's secret (an Ed25519 private seed the caller zeroes). */
export interface LitInput { readonly opening: Opening; readonly secret: Uint8Array }

/** §3: a spend of `inputs` into `outputs` in `segment`, each input's owner signing the statement in input order. */
export function signedSpend(domain: Uint8Array, segment: Uint8Array, inputs: readonly LitInput[], outputs: readonly Output[]): Uint8Array {
  const statement: Statement = { domain, kind: 2, segment, inputs: inputs.map(input => input.opening), outputs };
  const message = statementBytes(statement);
  const authorization = new Uint8Array(64 * inputs.length);
  inputs.forEach((input, i) => authorization.set(ed25519.sign(message, input.secret), 64 * i));
  return encodeRecord({ statement, authorization });
}
