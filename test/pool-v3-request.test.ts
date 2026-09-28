import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { EncodingError } from "../src/bytes.js";
import * as contexts from "../src/contexts.js";
import { FIELD_MODULUS, fieldToBytes } from "../src/pool/field.js";
import { prepareExactOutput } from "../src/pool/v3/capsules.js";
import {
  authenticatePaymentRequest, encodePaymentRequest, PAYMENT_REQUEST_BYTES, paymentRequestDigest, readPaymentRequest,
  WALLET_V3_REQUEST_CONTEXT, type PaymentRequest,
} from "../src/pool/v3/wallet-request.js";

// C4.1 request exchange: one fixed-width frame, authenticated only by a digest
// the payer obtains independently from the intended receiver.
const b = (n: number) => new Uint8Array(32).fill(n), domain = b(1), backing = b(2);
const request = (seed = b(3), id = b(4), value = 7n): PaymentRequest => {
  const out = prepareExactOutput(seed, domain, id, backing, value);
  return { domain, opening: out.opening, cm: out.cm, capsule: out.capsule };
};
const tag = WALLET_V3_REQUEST_CONTEXT.length;
const at = { domain: tag, backing: tag + 32, value: tag + 64, owner: tag + 72, rho: tag + 104, capsule: tag + 136 };
const refused = (f: () => unknown) => expect(f).toThrow(EncodingError);

describe("v3 payment request frame (pool-delivery C4.1)", () => {
  it("round-trips one canonical fixed-width frame and returns owned copies", () => {
    const r = request(), frame = encodePaymentRequest(r), digest = paymentRequestDigest(frame);
    expect(frame.length).toBe(PAYMENT_REQUEST_BYTES); expect(PAYMENT_REQUEST_BYTES).toBe(246);
    expect(frame.subarray(0, tag)).toEqual(WALLET_V3_REQUEST_CONTEXT);
    expect(digest).toBe(bytesToHex(sha256(frame)));
    const tags = Object.values(contexts).filter((v): v is Uint8Array => v instanceof Uint8Array);
    expect(contexts.contextsArePrefixFree([...tags, WALLET_V3_REQUEST_CONTEXT])).toBe(true);
    // Display terms carry no capsule, so they cannot stand in for the request.
    const shown = readPaymentRequest(frame);
    expect(shown).toEqual({ domain, backing, value: 7n, cm: r.cm });
    const accepted = authenticatePaymentRequest(frame, digest);
    expect(accepted).toEqual(r); expect(encodePaymentRequest(accepted)).toEqual(frame);
    accepted.domain.fill(0); accepted.capsule.fill(0); accepted.opening.backing.fill(0);
    expect(authenticatePaymentRequest(frame, digest)).toEqual(r);
    // Hashing and decoding read one private copy of the caller's bytes.
    const shared = new Uint8Array(new SharedArrayBuffer(frame.length)); shared.set(frame);
    refused(() => authenticatePaymentRequest(shared, digest)); refused(() => readPaymentRequest(shared));
    // Each exact request has its own frame; the digest names only these bytes.
    expect(paymentRequestDigest(encodePaymentRequest(request(b(3), b(5))))).not.toBe(digest);
  });

  it("encodes only a consistent positive request with profile-1 capsule framing", () => {
    const r = request();
    for (const bad of [
      { ...r, cm: r.cm + 1n }, { ...r, domain: b(9) }, { ...r, domain: new Uint8Array(31) },
      { ...r, opening: { ...r.opening, value: 0n } }, { ...r, opening: { ...r.opening, owner: 0n } },
      { ...r, capsule: r.capsule.slice(1) }, { ...r, capsule: Uint8Array.from(r.capsule, (x, i) => i === 0 ? 2 : x) },
    ]) refused(() => encodePaymentRequest(bad));
  });

  it("refuses every noncanonical or foreign frame", () => {
    const frame = encodePaymentRequest(request());
    const edit = (offset: number, bytes: Uint8Array) => { const out = frame.slice(); out.set(bytes, offset); return out; };
    const frames = [
      frame.subarray(0, frame.length - 1), Uint8Array.of(...frame, 0), new Uint8Array(0),
      edit(0, new TextEncoder().encode("moe/wallet/v3/reques_")),
      edit(at.value, new Uint8Array(8)), // zero value
      edit(at.owner, new Uint8Array(32)), edit(at.rho, new Uint8Array(32)),
      edit(at.owner, fieldToBytes(FIELD_MODULUS - 1n).map((x, i) => i === 31 ? x + 1 : x)), // owner = p
      edit(at.rho, new Uint8Array(32).fill(0xff)),
      edit(at.capsule, Uint8Array.of(2)),
    ];
    for (const bad of frames) { refused(() => readPaymentRequest(bad)); refused(() => paymentRequestDigest(bad)); }
    for (const bad of ["", "not bytes", undefined, [...frame]]) refused(() => readPaymentRequest(bad as never));
  });

  it("binds every byte to the independently obtained digest", () => {
    const frame = encodePaymentRequest(request()), digest = paymentRequestDigest(frame);
    // Changing the domain, backing, value, owner or rho still decodes, to
    // another commitment: only the trusted digest detects the substitution.
    const substituted = frame.slice(); substituted[at.owner + 31]! ^= 1;
    expect(readPaymentRequest(substituted).cm).not.toBe(readPaymentRequest(frame).cm);
    for (let i = 0; i < frame.length; i++) {
      const changed = frame.slice(); changed[i]! ^= 1;
      refused(() => authenticatePaymentRequest(changed, digest));
    }
    // An attacker's own well-formed request carries its own honest digest.
    const other = encodePaymentRequest(request(b(8))), otherDigest = paymentRequestDigest(other);
    expect(authenticatePaymentRequest(other, otherDigest).cm).not.toBe(readPaymentRequest(frame).cm);
    refused(() => authenticatePaymentRequest(other, digest));
    for (const trusted of [digest.toUpperCase(), digest.slice(1), `${digest}0`, "", undefined, sha256(frame)])
      refused(() => authenticatePaymentRequest(frame, trusted as never));
    expect(() => authenticatePaymentRequest(frame, otherDigest)).toThrow("payment request does not match the trusted digest");
  });
});
