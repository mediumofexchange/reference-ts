// A lit wallet's key derivation (lit-v1 §8): owner keys by index, K's
// acceptance owners and presenter keys, each a 32-byte Ed25519 private seed
// (RFC 8032) under one of three HKDF-SHA256 roots of the wallet seed. Index
// allocation, the look-ahead window and restoration are the wallet's.
import { createHmac, hkdfSync } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ByteWriter, EncodingError } from "../bytes.js";
import { utf8Encoder } from "../contexts.js";
import { field32 } from "./notes.js";

const MAX_U64 = (1n << 64n) - 1n;
const OWNER_INFO = utf8Encoder.encode("moe/wallet/lit/v1/owner");
const SETTLEMENT_INFO = utf8Encoder.encode("moe/wallet/lit/v1/settlement");
const PRESENTER_INFO = utf8Encoder.encode("moe/wallet/lit/v1/presenter");
/** Restoration's look-ahead: owner indices are scanned until this many consecutive ones appear in no output. */
export const OWNER_LOOK_AHEAD = 256n;

function u64(value: unknown, what: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) throw new EncodingError(`${what} outside u64`);
  return value;
}
function root(seed: Uint8Array, domain: Uint8Array, info: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", field32(seed, "seed"), field32(domain, "domain"), info, 32));
}
function hmac(key: Uint8Array, message: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(message).digest());
}

/** `ownerSecret_i = HMAC-SHA256(ownerRoot, u64 i)`. */
export function ownerSecret(seed: Uint8Array, domain: Uint8Array, index: bigint): Uint8Array {
  const w = new ByteWriter(); w.u64(u64(index, "owner index"));
  return hmac(root(seed, domain, OWNER_INFO), w.finish());
}
/** K's `acceptSecret = HMAC-SHA256(settlementRoot, demand || u64 acceptanceDeadline)`. */
export function acceptSecret(seed: Uint8Array, domain: Uint8Array, demand: Uint8Array, deadline: bigint): Uint8Array {
  const w = new ByteWriter(); w.key32(field32(demand, "demand"), "demand"); w.u64(u64(deadline, "acceptance deadline"));
  return hmac(root(seed, domain, SETTLEMENT_INFO), w.finish());
}
/** `presentSecret = HMAC-SHA256(presenterRoot, tag_1 || tag_2 || u64 instant || u64 deadline)`, `tag_2` 32 zero bytes
 * for a demand over one note: every field is public in the demand, so a restored wallet finds its standing demands. */
export function presentSecret(seed: Uint8Array, domain: Uint8Array, tags: readonly Uint8Array[], instant: bigint,
  deadline: bigint): Uint8Array {
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > 2) throw new EncodingError("wrong tag count");
  const own = tags.map((tag, i) => field32(tag, `tag ${i + 1}`));
  const w = new ByteWriter();
  w.key32(own[0]!, "tag 1"); w.key32(own[1] ?? new Uint8Array(32), "tag 2");
  w.u64(u64(instant, "instant")); w.u64(u64(deadline, "deadline"));
  return hmac(root(seed, domain, PRESENTER_INFO), w.finish());
}
/** The key (§1) of a derived secret: an Ed25519 public key is canonical and, from a hashed seed, never of small order. */
export function publicKeyOf(secret: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(field32(secret, "secret"));
}
