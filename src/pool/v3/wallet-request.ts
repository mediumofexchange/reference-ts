// C4.1: the receiver's exact public output, shared on an authenticated channel.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ByteReader, ByteWriter, compareBytes, copyUnshared, EncodingError } from "../../bytes.js";
import { bytesToField, fieldToBytes } from "../field.js";
import { commitmentOf, copyNoteOpening } from "../notes.js";
import { CAPSULE_BYTES, PROFILE } from "./capsules.js";
import type { OutputNote } from "./witness.js";

/** No root key, spend secret, nullifier or local invoice label is disclosed. */
export interface PaymentRequest extends OutputNote { readonly domain: Uint8Array }

/** Own and check the payer's agreed domain/backing/amount and exact output.
 * Capsule validation is framing only: only the receiver can decrypt it.
 * This is not recipient authentication or evidence of payment. */
export function copyPaymentRequest(input: PaymentRequest,
  expected: { readonly domain: Uint8Array; readonly backing: Uint8Array; readonly value: bigint }): PaymentRequest {
  const domain = copyUnshared(input.domain), opening = copyNoteOpening(input.opening);
  const cm = input.cm, capsule = copyUnshared(input.capsule);
  const agreedDomain = copyUnshared(expected.domain), agreedBacking = copyUnshared(expected.backing), value = expected.value;
  if (domain.length !== 32 || agreedDomain.length !== 32 || agreedBacking.length !== 32 ||
      compareBytes(domain, agreedDomain) !== 0 || compareBytes(opening.backing, agreedBacking) !== 0 ||
      opening.value <= 0n || opening.value !== value || commitmentOf(domain, opening) !== cm ||
      capsule.length !== CAPSULE_BYTES || capsule[0] !== PROFILE) throw new EncodingError("invalid exact payment request");
  return { domain, opening, cm, capsule };
}

/** An application frame's tag, never signed or part of a statement; like the
 * capsule's HKDF strings it lives beside its codec, and its test checks it
 * against contexts.ts for prefix freedom. */
export const WALLET_V3_REQUEST_CONTEXT = new TextEncoder().encode("moe/wallet/v3/request");

/** Tag, domain, backing, value, owner, rho and capsule; `cm` is recomputed. */
export const PAYMENT_REQUEST_BYTES = WALLET_V3_REQUEST_CONTEXT.length + 32 + 32 + 8 + 32 + 32 + CAPSULE_BYTES;

/** The canonical fixed-width frame of an exact request. It links the output to
 * whoever holds it, so it travels privately; it carries no secret and no
 * authentication of its own. */
export function encodePaymentRequest(request: PaymentRequest): Uint8Array {
  const domain = copyUnshared(request.domain), opening = copyNoteOpening(request.opening);
  const own = copyPaymentRequest({ domain, opening, cm: request.cm, capsule: request.capsule },
    { domain, backing: opening.backing, value: opening.value });
  const w = new ByteWriter();
  w.context(WALLET_V3_REQUEST_CONTEXT);
  w.key32(own.domain, "request domain"); w.key32(own.opening.backing, "request backing"); w.u64(own.opening.value);
  w.key32(fieldToBytes(own.opening.owner), "request owner"); w.key32(fieldToBytes(own.opening.rho), "request rho");
  w.fixed(own.capsule, CAPSULE_BYTES, "request capsule");
  return w.finish();
}

function decode(frame: Uint8Array): PaymentRequest {
  const r = new ByteReader(frame);
  if (compareBytes(r.raw(WALLET_V3_REQUEST_CONTEXT.length), WALLET_V3_REQUEST_CONTEXT) !== 0) throw new EncodingError("not a payment request");
  const domain = r.raw(32), backing = r.raw(32), value = r.u64();
  const owner = bytesToField(r.raw(32)), rho = bytesToField(r.raw(32)), capsule = r.raw(CAPSULE_BYTES);
  r.expectEnd();
  const opening = copyNoteOpening({ backing, value, owner, rho });
  return copyPaymentRequest({ domain, opening, cm: commitmentOf(domain, opening), capsule }, { domain, backing, value });
}

/** SHA-256 of the exact frame, as 64 lowercase hex digits. The frame opens
 * with its own tag, so the digest names nothing else. */
export function paymentRequestDigest(frame: Uint8Array): string {
  const own = copyUnshared(frame);
  decode(own);
  return bytesToHex(sha256(own));
}

/** What a payer is asked to agree to, without the capsule, so it cannot be paid. */
export interface PaymentRequestTerms {
  readonly domain: Uint8Array; readonly backing: Uint8Array; readonly value: bigint; readonly cm: bigint;
}

/** Strict structural reading for display only: it authenticates nothing and
 * returns no capsule, so `prepare` refuses its result. */
export function readPaymentRequest(frame: Uint8Array): PaymentRequestTerms {
  const r = decode(copyUnshared(frame));
  return { domain: r.domain, backing: r.opening.backing, value: r.opening.value, cm: r.cm };
}

/** The payer's entry: the frame must hash to a digest obtained independently
 * from the intended receiver (never from the frame's own carrier). The payer's
 * agreement to domain, backing and amount is checked again by `prepare`. */
export function authenticatePaymentRequest(frame: Uint8Array, trustedDigest: string): PaymentRequest {
  const own = copyUnshared(frame);
  if (typeof trustedDigest !== "string" || !/^[0-9a-f]{64}$/.test(trustedDigest) || bytesToHex(sha256(own)) !== trustedDigest)
    throw new EncodingError("payment request does not match the trusted digest");
  return decode(own);
}
