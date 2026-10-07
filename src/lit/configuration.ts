// The lit configuration (lit-v1 §9, adopted: §1). It names no circuit,
// key, parameter or helper: its two bytes are the statement shape's bounds, and
// its hash is the domain of every lit statement and object.
import { sha256 } from "@noble/hashes/sha2.js";
import { compareBytes } from "../bytes.js";
import { LIT_CONFIG_CONTEXT as CONTEXT } from "../contexts.js";

/** The most inputs a spend, burn or demand consumes, and the most outputs a spend creates (§11). */
export const MAX_INPUTS = 2;
export const MAX_OUTPUTS = 4;
export const CONSTRUCTION = "moe/lit/v1";

const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!, x => parseInt(x, 16));
const BYTES = Uint8Array.of(...CONTEXT, MAX_INPUTS, MAX_OUTPUTS);
const HASH = hexBytes("17835aa2cc5e76c4cc1df8ec6486b5ca3419a96c732256ccb5abccd39c9a77c1");
if (compareBytes(sha256(BYTES), HASH) !== 0) throw new Error("lit configuration hash differs from lit-v1 §9");

/** `"moe/lit/v1/config" || u8(2) || u8(4)`, a fresh copy. */
export function litConfigurationBytes(): Uint8Array { return Uint8Array.from(BYTES); }
/** lit-v1 §9's configuration hash, a fresh copy. */
export function litConfigHash(): Uint8Array { return Uint8Array.from(HASH); }
