// C4.1: the receiver's exact public output, shared on an authenticated channel.
import { compareBytes, copyUnshared, EncodingError } from "../../bytes.js";
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
