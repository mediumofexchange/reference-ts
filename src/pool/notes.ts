// A note, its commitment and its nullifier (pool-v1 §3; Construction §C1.2).
//
// A note opening is (pool, backing, value, owner, rho). The owner is the
// declared hash of a spend secret the receiver generates and never reveals
// (invariant 25); rho is the creator's. The commitment binds the whole
// opening under the pool identity; the nullifier is a function of the
// immutable note and its owner's secret alone, so one note has one nullifier
// whatever anchor or path it is later proved under.
//
// These are the host's copies of the relations `circuits/notes.nr` proves.
// The wallet computes commitments to build outputs and paths, and nullifiers
// to spend; the operator computes nothing here beyond the tree nodes, since a
// spend reveals neither the note nor the secret. The checks mirror the
// circuit's asserts so a host value the circuit would refuse is refused here
// first, with the reason named.

import { EncodingError } from "../bytes.js";
import { isField, isValue, limbsOf, requireField } from "./field.js";
import { poseidon2Hash } from "./poseidon2.js";

/** Domain tags, the first input of every in-circuit hash (pool-v1 §1). */
export const T_OWNER = 1001n;
export const T_NOTE = 1002n;
export const T_NULLIFIER = 1003n;
export const T_NODE = 1004n;

export interface NoteOpening {
  /** The backing's name, entered as two limbs. */
  readonly backing: Uint8Array;
  /** A u64; zero for a padding input or an empty output (§5.2). */
  readonly value: bigint;
  /** H(T_OWNER, secret) of the receiver's spend secret. */
  readonly owner: bigint;
  /** The creator's randomness, derived (invariant 26), nonzero. */
  readonly rho: bigint;
}

function nonzero(value: bigint, what: string): bigint {
  requireField(value, what);
  if (value === 0n) throw new EncodingError(`${what} must be nonzero`);
  return value;
}

/** owner = H(T_OWNER, secret), for a nonzero secret. */
export function ownerOf(secret: bigint): bigint {
  return nonzero(poseidon2Hash([T_OWNER, nonzero(secret, "spend secret")]), "owner");
}

/** Whether an opening's fields are in range; the constructor of nothing, so a plain predicate. */
export function isNoteOpening(note: unknown): note is NoteOpening {
  if (typeof note !== "object" || note === null) return false;
  const n = note as Record<string, unknown>;
  return (
    n["backing"] instanceof Uint8Array && n["backing"].length === 32 &&
    isValue(n["value"]) &&
    isField(n["owner"]) && n["owner"] !== 0n &&
    isField(n["rho"]) && n["rho"] !== 0n
  );
}

/** cm = H(T_NOTE, poolHi, poolLo, backingHi, backingLo, value, owner, rho), nonzero. */
export function commitmentOf(pool: Uint8Array, note: NoteOpening): bigint {
  if (!isNoteOpening(note)) throw new EncodingError("malformed note opening");
  const [poolHi, poolLo] = limbsOf(pool);
  const [backingHi, backingLo] = limbsOf(note.backing);
  return nonzero(
    poseidon2Hash([T_NOTE, poolHi, poolLo, backingHi, backingLo, note.value, note.owner, note.rho]),
    "commitment",
  );
}

/** nf = H(T_NULLIFIER, poolHi, poolLo, cm, secret), nonzero: no anchor, no path. */
export function nullifierOf(pool: Uint8Array, commitment: bigint, secret: bigint): bigint {
  const [poolHi, poolLo] = limbsOf(pool);
  return nonzero(
    poseidon2Hash([T_NULLIFIER, poolHi, poolLo, nonzero(commitment, "commitment"), nonzero(secret, "spend secret")]),
    "nullifier",
  );
}

/** A copy that owns its bytes. */
export function copyNoteOpening(note: NoteOpening): NoteOpening {
  if (!isNoteOpening(note)) throw new EncodingError("malformed note opening");
  return Object.freeze({
    backing: Uint8Array.prototype.slice.call(note.backing),
    value: note.value,
    owner: note.owner,
    rho: note.rho,
  });
}
