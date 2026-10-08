// Field elements of the pool's proof system, and the encodings pool-v2 §1
// fixes for them.
//
// A field element is canonical only in [0, p). It is written as 32 big-endian
// bytes, or as `0x` followed by exactly 64 lowercase hexadecimal digits; a
// value at or above p, a shorter or longer byte string, or any other spelling
// of the text form is malformed wherever it appears. The readers here are
// strict for the reason bytes.ts gives: a byte sequence either is THE
// canonical encoding of a value or it is rejected.
//
// A 32-byte identifier (a construction domain, segment identity or backing name) enters a circuit as
// two limbs, each the big-endian integer of 16 bytes and so below 2^128.
// Reducing the identifier modulo p is not a representation of it (§1), and
// the circuits range-check both limbs, so the host does the same.
//
// Bytes and integers convert through one hexadecimal string, not a bigint per
// byte: a replay and a wallet read convert several elements per record or
// note, and the per-byte form allocated about 2 KB a conversion (slice 15).

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { EncodingError } from "../bytes.js";

/** The BN254 scalar field modulus (pool-v2 §1). */
export const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** A limb of a 32-byte identifier is below this. */
export const LIMB_BOUND = 1n << 128n;
/** A note value or a public quantity is below this (pool-v2 §1, §10). */
export const VALUE_BOUND = 1n << 64n;

export function isField(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n && value < FIELD_MODULUS;
}

export function requireField(value: bigint, what: string): bigint {
  if (!isField(value)) throw new EncodingError(`${what} is not a canonical field element`);
  return value;
}

/** Whether `value` is a quantity the construction admits: a u64, zero included. */
export function isValue(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n && value < VALUE_BOUND;
}

/** A field element as 32 big-endian bytes. */
export function fieldToBytes(value: bigint): Uint8Array {
  requireField(value, "field element");
  return hexToBytes(value.toString(16).padStart(64, "0"));
}

/** Strict inverse of fieldToBytes: exactly 32 bytes, below p. */
export function bytesToField(bytes: Uint8Array): bigint {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new EncodingError("field element must be 32 bytes");
  }
  return requireField(BigInt(`0x${bytesToHex(bytes)}`), "field element");
}

/** A field element as text: `0x` and exactly 64 lowercase hexadecimal digits. */
export function fieldToHex(value: bigint): string {
  return "0x" + requireField(value, "field element").toString(16).padStart(64, "0");
}

/** Strict inverse of fieldToHex. Anything else, including uppercase, is malformed. */
export function hexToField(text: unknown): bigint {
  if (typeof text !== "string" || !/^0x[0-9a-f]{64}$/.test(text)) {
    throw new EncodingError("field element text must be 0x and 64 lowercase hex digits");
  }
  return requireField(BigInt(text), "field element");
}

/** The two limbs of a 32-byte identifier: the first 16 bytes, then the last 16. */
export function limbsOf(identifier: Uint8Array): readonly [bigint, bigint] {
  if (!(identifier instanceof Uint8Array) || identifier.length !== 32) {
    throw new EncodingError("identifier must be 32 bytes");
  }
  const hex = bytesToHex(identifier);
  return [BigInt(`0x${hex.slice(0, 32)}`), BigInt(`0x${hex.slice(32)}`)];
}

/** Strict inverse of limbsOf: both limbs below 2^128, or the pair is malformed. */
export function identifierOf(hi: bigint, lo: bigint): Uint8Array {
  for (const limb of [hi, lo]) {
    if (typeof limb !== "bigint" || limb < 0n || limb >= LIMB_BOUND) {
      throw new EncodingError("identifier limb out of range");
    }
  }
  return hexToBytes(hi.toString(16).padStart(32, "0") + lo.toString(16).padStart(32, "0"));
}
