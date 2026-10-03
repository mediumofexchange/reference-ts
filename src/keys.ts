// Key and signature rules shared by every layer.
//
// Every verification key that carries authority must be a valid,
// non-small-order Ed25519 point: a small-order key accepts a forged signature
// over any message under permissive verification, and even under strict
// verification a balance under an invalid point is unspendable garbage.
//
// Applied to the keys a backing's terms name, where they are decoded
// (`pool/v3/terms.ts`), and to every key a record or statement carries.
// A signer needs no separate check: strict verification decompresses the key and
// rejects a small-order point, so a valid signature already proves it.
//
// Verification is strict (non-ZIP215) throughout.

import { ed25519 } from "@noble/curves/ed25519.js";
import { byteLength, copyBytes } from "./bytes.js";

export const KEY_LENGTH = 32;
export const SIGNATURE_LENGTH = 64;

/**
 * Owned bytes of the given length, or undefined. The brand and length are read
 * through the intrinsic getters (`bytes.ts`): a DataView, another typed array or
 * a Proxy can claim the Uint8Array prototype and pass `instanceof`, and genuine
 * bytes can carry an own `length`; either reached noble's unguarded reads. The
 * length is judged on the copy, since a view over growable shared memory can
 * change length between any two reads of the caller's object.
 */
function owned(value: unknown, length?: number): Uint8Array | undefined {
  try {
    if (length !== undefined && byteLength(value as Uint8Array) !== length) return undefined;
    const own = copyBytes(value as Uint8Array);
    return length === undefined || own.length === length ? own : undefined;
  } catch {
    return undefined;
  }
}

export function isValidPublicKey(key: Uint8Array): boolean {
  const own = owned(key, KEY_LENGTH);
  if (own === undefined) return false;
  try {
    return !ed25519.Point.fromHex(own).isSmallOrder();
  } catch {
    return false;
  }
}

/**
 * Strict Ed25519 verification, and the only verification path in the system.
 * Returns false — never throws — for any of the three arguments being absent, of
 * some other type, only claiming to be bytes, or the wrong length. noble checks the public key's length and
 * the message's type outside its own try/catch, so an unchecked argument turns
 * every verifier above this into a crash on hostile input.
 *
 * The line stops here, deliberately. This and isValidPublicKey are the
 * predicates that answer questions about adversary-supplied data and are
 * documented to answer rather than throw, so they are total. A codec is not
 * one: its contract is EncodingError, and it reads a caller's fields once into
 * owned values before judging them.
 */
export function verifySignatureStrict(
  signature: Uint8Array,
  message: Uint8Array,
  key: Uint8Array,
): boolean {
  // Bytes first, then length, each read once into owned copies. `readonly Uint8Array` is erased at
  // runtime, so a field that arrives from outside absent, as some other type, or as an object
  // only claiming the type reaches here typed as bytes, and noble's own reads of it throw —
  // turning every verifier above into a crash on hostile input, which is the hole the length
  // checks themselves exist to close. This is the one function they all funnel through.
  // Length only for the key: noble length-checks it OUTSIDE its own try/catch. The small-order
  // rejection that isValidPublicKey also does is already performed inside the strict
  // (non-ZIP215) verify path, so repeating it here would be a second point decompression per
  // verification for no added safety.
  const ownSignature = owned(signature, SIGNATURE_LENGTH), ownKey = owned(key, KEY_LENGTH), ownMessage = owned(message);
  if (ownSignature === undefined || ownKey === undefined || ownMessage === undefined) return false;
  return ed25519.verify(ownSignature, ownMessage, ownKey, { zip215: false });
}
