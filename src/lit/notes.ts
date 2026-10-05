// Lit notes and derived outputs (lit-v1 §2). A statement carries each output
// without randomness; every reader derives it, so these functions are part of
// validity, not a wallet convention. No membership, spentness or ownership.
import { sha256 } from "@noble/hashes/sha2.js";
import { ByteWriter, copyBytes, EncodingError } from "../bytes.js";
import {
  LIT_NOTE_CONTEXT as NOTE, LIT_NULLIFIER_CONTEXT as NULLIFIER, LIT_RHO_ISSUE_CONTEXT as RHO_ISSUE,
  LIT_RHO_SPEND_CONTEXT as RHO_SPEND, LIT_TAG_CONTEXT as TAG,
} from "../contexts.js";
import { isValidPublicKey } from "../keys.js";
import { MAX_INPUTS, MAX_OUTPUTS } from "./configuration.js";

const MAX_U64 = (1n << 64n) - 1n;
export const OPENING_BYTES = 104;
export const OUTPUT_BYTES = 72;

/** An output as a statement carries it: `backing || u64 value || owner` (72 bytes). */
export interface Output {
  readonly backing: Uint8Array;
  readonly value: bigint;
  readonly owner: Uint8Array;
}
/** A note's opening `backing || u64 value || owner || rho` (104 bytes); its domain is the configuration's. */
export interface Opening extends Output {
  readonly rho: Uint8Array;
}

function object(value: unknown, what: string): asserts value is { readonly [key: string]: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EncodingError(`invalid ${what}`);
}
/** An owned 32-byte field. */
export function field32(value: unknown, what: string): Uint8Array {
  let own: Uint8Array;
  try { own = copyBytes(value as Uint8Array); } catch { throw new EncodingError(`invalid ${what}`); }
  if (own.length !== 32) throw new EncodingError(`${what} must be 32 bytes`);
  return own;
}
/** An owned key: 32 bytes, canonical and not of small order (§1). */
export function key32(value: unknown, what: string): Uint8Array {
  const own = field32(value, what);
  if (!isValidPublicKey(own)) throw new EncodingError(`invalid ${what} key`);
  return own;
}
/** A value or quantity: a positive u64 (§1). */
export function positive(value: unknown, what: string): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > MAX_U64) throw new EncodingError(`${what} is not a positive u64`);
  return value;
}

/** An owned, checked output; fields are read once. */
export function ownOutput(value: unknown): Output {
  object(value, "output");
  const { backing, value: amount, owner } = value;
  return Object.freeze({ backing: field32(backing, "backing"), value: positive(amount, "value"), owner: key32(owner, "owner") });
}
/** An owned, checked opening; fields are read once. */
export function ownOpening(value: unknown): Opening {
  object(value, "opening");
  const { backing, value: amount, owner, rho } = value;
  return Object.freeze({ backing: field32(backing, "backing"), value: positive(amount, "value"),
    owner: key32(owner, "owner"), rho: field32(rho, "rho") });
}

export function writeOutput(w: ByteWriter, o: Output): void {
  w.key32(o.backing, "backing"); w.u64(o.value); w.key32(o.owner, "owner");
}
export function writeOpening(w: ByteWriter, o: Opening): void {
  writeOutput(w, o); w.key32(o.rho, "rho");
}
export function openingBytes(opening: Opening): Uint8Array {
  const w = new ByteWriter(); writeOpening(w, ownOpening(opening)); return w.finish();
}

/** `cm = SHA256("moe/lit/v1/note" || domain || opening)`. */
export function noteCommitment(domain: Uint8Array, opening: Opening): Uint8Array {
  const w = new ByteWriter(); w.context(NOTE); w.key32(field32(domain, "domain"), "domain");
  writeOpening(w, ownOpening(opening));
  return sha256(w.finish());
}
/** `nf = SHA256("moe/lit/v1/nullifier" || cm)`: public, fixed when the note is created. */
export function noteNullifier(commitment: Uint8Array): Uint8Array {
  const w = new ByteWriter(); w.context(NULLIFIER); w.key32(field32(commitment, "commitment"), "commitment");
  return sha256(w.finish());
}
/** `tag = SHA256("moe/lit/v1/tag" || nf)`, pool-recovery C3.1's public name of a note; it hides nothing here. */
export function noteTag(nullifier: Uint8Array): Uint8Array {
  const w = new ByteWriter(); w.context(TAG); w.key32(field32(nullifier, "nullifier"), "nullifier");
  return sha256(w.finish());
}

/** An issued output's randomness, from its issue statement's fields (§2). */
export function issueRho(output: Output, nonce: Uint8Array): Uint8Array {
  const o = ownOutput(output);
  const w = new ByteWriter(); w.context(RHO_ISSUE); writeOutput(w, o); w.key32(field32(nonce, "nonce"), "nonce");
  return sha256(w.finish());
}
/** The randomness of output `position` of a statement consuming `nullifiers` in input order (§2). */
export function spendRho(nullifiers: readonly Uint8Array[], position: number): Uint8Array {
  if (!Array.isArray(nullifiers) || nullifiers.length < 1 || nullifiers.length > MAX_INPUTS) {
    throw new EncodingError("wrong nullifier count");
  }
  if (!Number.isInteger(position) || position < 0 || position >= MAX_OUTPUTS) throw new EncodingError("wrong output position");
  const w = new ByteWriter(); w.context(RHO_SPEND); w.u8(nullifiers.length);
  for (const nf of nullifiers) w.key32(field32(nf, "nullifier"), "nullifier");
  w.u8(position);
  return sha256(w.finish());
}
