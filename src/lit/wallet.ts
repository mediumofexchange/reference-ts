// What the one wallet (pool/v3/wallet-store.ts) builds for a lit backing (slice 14 M14g; lit-v1 §8): the
// payment request, which names a backing, a quantity and an owner key in place of an exact output, and the
// statements it authorizes by its notes' owner keys in place of a proof.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ByteReader, ByteWriter, compareBytes, copyUnshared, EncodingError } from "../bytes.js";
import { field32, key32, positive, type Opening, type Output } from "./notes.js";
import {
  acceptanceBytes, acceptanceId, encodeRecord, encodeSettlementAuthorization, releaseBytes, statementBytes, statementHash, type Acceptance, type SignedAcceptance, type Statement,
} from "./records.js";
import { acceptSecret } from "./wallet-keys.js";
import type { KeyedRequest } from "../pool/v3/construction.js";

/** §8: what a payer is asked to pay, on an authenticated channel. The owner key is the receiver's for this request
 * alone; outputs are public, so the frame carries nothing secret. */
export type LitPaymentRequest = KeyedRequest;

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

/** §3: a statement of kinds 2–4 signed by each input's owner, in input order. */
function ownerSigned(statement: Statement, inputs: readonly LitInput[]): Uint8Array {
  const message = statementBytes(statement);
  const authorization = new Uint8Array(64 * inputs.length);
  inputs.forEach((input, i) => authorization.set(ed25519.sign(message, input.secret), 64 * i));
  return encodeRecord({ statement, authorization });
}
/** §3: a spend of `inputs` into `outputs` in `segment`, each input's owner signing the statement in input order. */
export function signedSpend(domain: Uint8Array, segment: Uint8Array, inputs: readonly LitInput[], outputs: readonly Output[]): Uint8Array {
  return ownerSigned({ domain, kind: 2, segment, inputs: inputs.map(input => input.opening), outputs }, inputs);
}
/** §3 kind 3: burn `quantity` of `inputs`, the rest (if any) to `change`. */
export function signedBurn(domain: Uint8Array, segment: Uint8Array, quantity: bigint, inputs: readonly LitInput[],
  change: Output | undefined): Uint8Array {
  return ownerSigned({ domain, kind: 3, segment, quantity, inputs: inputs.map(input => input.opening), outputs: change === undefined ? [] : [change] },
    inputs);
}
/** §3 kind 4: present `inputs` under `presenter` with the notice's instant and deadline. */
export function signedDemand(domain: Uint8Array, segment: Uint8Array, inputs: readonly LitInput[], presenter: Uint8Array, instant: bigint,
  deadline: bigint): Uint8Array {
  return ownerSigned({ domain, kind: 4, segment, inputs: inputs.map(input => input.opening), presenter, instant, deadline }, inputs);
}
/** §3 kind 5: withdraw `demand`, signed by its presenter key's secret. */
export function signedWithdrawal(domain: Uint8Array, segment: Uint8Array, demand: Uint8Array, presenter: Uint8Array): Uint8Array {
  const statement: Statement = { domain, kind: 5, segment, demand };
  return encodeRecord({ statement, authorization: ed25519.sign(statementBytes(statement), presenter) });
}
/** §§4, 8: the owner key's signature over the acceptance bytes, by K's `acceptSecret` of its domain, demand and deadline. */
export function ownerAcceptanceSignature(seed: Uint8Array, acceptance: Acceptance): Uint8Array {
  const message = acceptanceBytes(acceptance), secret = acceptSecret(seed, acceptance.domain, acceptance.demand, acceptance.deadline);
  try { return ed25519.sign(message, secret); } finally { secret.fill(0); }
}
/** §§3–4 kind 6: settle the acceptance's demand to its owner, K's and the owner's acceptance signatures carried and the
 * release signed by the presenter key's secret over this settlement's own statement hash. No signature is checked here. */
export function signedSettlement(domain: Uint8Array, segment: Uint8Array, acceptance: SignedAcceptance, presenter: Uint8Array): Uint8Array {
  const statement: Statement = { domain, kind: 6, segment, demand: acceptance.demand, owner: acceptance.owner };
  const release = ed25519.sign(releaseBytes(domain, acceptance.demand, acceptanceId(acceptance), statementHash(statement)), presenter);
  return encodeRecord({ statement, authorization: encodeSettlementAuthorization(acceptance.deadline, acceptance.signature, acceptance.ownerSignature, release) });
}
/** §3 kind 1: an issue of `output` under `nonce`; K signs `message`, and `record` carries that signature. */
export function unsignedIssue(domain: Uint8Array, segment: Uint8Array, output: Output, nonce: Uint8Array):
  { readonly message: Uint8Array; record(signature: Uint8Array): Uint8Array } {
  const statement: Statement = { domain, kind: 1, segment, backing: output.backing, quantity: output.value, owner: output.owner, nonce };
  const message = statementBytes(statement);
  return { message, record: signature => encodeRecord({ statement, authorization: signature }) };
}
