// A note, its commitment and its nullifier (pool-v2 §3; Construction §C1.2,
// C1.2.1).
//
// A note opening is (domain, backing, value, owner, rho). The domain is the
// construction's configuration hash (§2): it names the relations a note is
// made under and nothing about who serves it, so a note keeps its commitment
// and its nullifier across operators, segments, scopes, anchors and paths.
// The owner is the declared hash of a spend secret the receiver generates
// and never reveals (invariant 25); rho is the creator's. The commitment
// binds the whole opening under the domain; the nullifier is a function of
// the immutable note and its owner's secret alone.
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

/** Domain tags, the first input of every in-circuit hash (pool-v2 §1). */
export const T_OWNER = 1001n;
export const T_NOTE = 1002n;
export const T_NULLIFIER = 1003n;
export const T_NODE = 1004n;
export const T_SCOPE_LEAF = 1005n;
export const T_SCOPE_NODE = 1006n;

export interface NoteOpening {
  /** The backing's name, entered as two limbs. */
  readonly backing: Uint8Array;
  /** A u64; zero for a padding input or an empty output (§7.2). */
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

/** cm = H(T_NOTE, domainHi, domainLo, backingHi, backingLo, value, owner, rho), nonzero. */
export function commitmentOf(domain: Uint8Array, note: NoteOpening): bigint {
  if (!isNoteOpening(note)) throw new EncodingError("malformed note opening");
  const [domainHi, domainLo] = limbsOf(domain);
  const [backingHi, backingLo] = limbsOf(note.backing);
  return nonzero(
    poseidon2Hash([T_NOTE, domainHi, domainLo, backingHi, backingLo, note.value, note.owner, note.rho]),
    "commitment",
  );
}

/** nf = H(T_NULLIFIER, domainHi, domainLo, cm, secret), nonzero: no operator, segment, anchor or path. */
export function nullifierOf(domain: Uint8Array, commitment: bigint, secret: bigint): bigint {
  const [domainHi, domainLo] = limbsOf(domain);
  return nonzero(
    poseidon2Hash([T_NULLIFIER, domainHi, domainLo, nonzero(commitment, "commitment"), nonzero(secret, "spend secret")]),
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
