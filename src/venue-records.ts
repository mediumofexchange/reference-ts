// The venue records of kinds 1–3 (pool-v3 §13.1): a commitment with the
// directory its root authenticates (C2.3), a replacement (C2.5) and a
// revocation (C2b.1). Their exact bytes, signed messages, hashes and signature
// checks, and nothing else: no ledger, venue view, backing terms or walk. Every
// construction reads these records, so they live apart from any one of them;
// `commitment.ts`, `replacement.ts` and `revocation.ts` re-export them for the
// transparent path and pool-v2.
//
// Everything that reads bytes here is a verifier: the bytes come from whoever
// publishes them.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ByteReader, ByteWriter, compareBytes, copyBytes, EncodingError } from "./bytes.js";
import { COMMITMENT_CONTEXT, DIRECTORY_MAGIC, REPLACEMENT_CONTEXT, REVOCATION_CONTEXT } from "./contexts.js";
import { verifySignatureStrict } from "./keys.js";

// --- Kind 1: commitments (C2.3) ----------------------------------------------

export interface Commitment {
  /**
   * The operator's own count of its commitments — NOT the venue's witnessed
   * index. Equivocation is two different roots signed at one sequence number;
   * the clock deadlines are read against is the venue's (venue.ts).
   */
  readonly sequence: bigint;
  readonly root: Uint8Array;
  readonly operator: Uint8Array;
  readonly signature: Uint8Array;
}

/** One entry in the complete authenticated directory, ordered by backing name. */
export interface SnapshotDigest {
  readonly name: Uint8Array;
  readonly digest: Uint8Array;
}

/**
 * Hash the strict canonical directory; never sort or repair external evidence.
 *
 * The root must be INJECTIVE or equivocation is unprovable: if two different
 * served states hash to one root, an operator equivocates with a single
 * signature. Every name and digest is written at a fixed, asserted width.
 * The root authenticates a complete directory of names and snapshot digests:
 * a missing name proves omission; a named snapshot that was not supplied is
 * unavailable evidence. Neither the directory nor its digest proves
 * availability or continuity.
 */
export function directoryRoot(directory: readonly SnapshotDigest[]): Uint8Array {
  const w = new ByteWriter();
  w.context(DIRECTORY_MAGIC);
  w.u8(1);
  w.u32(directory.length);
  let previous: Uint8Array | undefined;
  for (const entry of directory) {
    w.key32(entry.name, "backing name");
    w.key32(entry.digest, "snapshot digest");
    if (previous !== undefined && compareBytes(previous, entry.name) >= 0) {
      throw new EncodingError("directory names must be strictly increasing");
    }
    previous = entry.name;
  }
  return sha256(w.finish());
}

/**
 * A commitment's identity as one comparable value: operator, sequence, root —
 * the triple every reader that asks "is this THAT commitment" compares. A
 * string rather than bytes, deliberately: it is compared and stored in private
 * maps, never signed or hashed, and a string retains no live reference to the
 * arrays.
 */
export function commitmentIdentity(commitment: Commitment): string {
  return `${bytesToHex(commitment.operator)}:${commitment.sequence.toString()}:${bytesToHex(commitment.root)}`;
}

function commitmentMessage(sequence: bigint, root: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  w.context(COMMITMENT_CONTEXT);
  w.u64(sequence);
  w.key32(root, "root");
  return w.finish();
}

/**
 * Sign a root as this operator's next commitment. Does not copy `root`: a
 * commitment is retained only by the venue, which copies on the way in. The
 * returned object does alias `root`, so a caller that mutates it before
 * publishing invalidates its own commitment and nobody else's.
 */
export function signCommitment(
  operatorSecret: Uint8Array,
  sequence: bigint,
  root: Uint8Array,
): Commitment {
  const operator = ed25519.getPublicKey(operatorSecret);
  const signature = ed25519.sign(commitmentMessage(sequence, root), operatorSecret);
  return { sequence, root, operator, signature };
}

/**
 * A commitment as a **record**, for a venue that stores bytes rather than
 * objects: sequence, root, operator, signature. Fixed width throughout, so there
 * is one spelling and no length to disagree with.
 */
export function encodeCommitment(commitment: Commitment): Uint8Array {
  const w = new ByteWriter();
  w.u64(commitment.sequence);
  w.key32(commitment.root, "root");
  w.key32(commitment.operator, "operator key");
  w.fixed(commitment.signature, 64, "signature");
  return w.finish();
}

/** Strict inverse of encodeCommitment. Throws EncodingError on anything else. */
export function decodeCommitment(bytes: Uint8Array): Commitment {
  const r = new ByteReader(bytes);
  const sequence = r.u64();
  const root = r.raw(32);
  const operator = r.raw(32);
  const signature = r.raw(64);
  r.expectEnd();
  return { sequence, root, operator, signature };
}

/** A commitment is valid iff the operator signed exactly (sequence, root). */
export function verifyCommitment(commitment: Commitment): boolean {
  try {
    const message = commitmentMessage(commitment.sequence, commitment.root);
    return verifySignatureStrict(commitment.signature, message, commitment.operator);
  } catch {
    return false;
  }
}

/**
 * Two commitments are equivocation iff the same operator validly signed two
 * different roots at one sequence number. Keyed on the operator's own
 * sequence, not on the venue's clock: an operator publishing two roots in one
 * venue interval is ordinary batching, while signing two roots as its Nth
 * commitment is the fault. A verifier: anyone may exhibit two commitments they
 * found at a venue, so a malformed one fails the proof instead of throwing.
 */
export function isEquivocation(a: Commitment, b: Commitment): boolean {
  try {
    return (
      compareBytes(a.operator, b.operator) === 0 &&
      a.sequence === b.sequence &&
      compareBytes(a.root, b.root) !== 0 &&
      verifyCommitment(a) &&
      verifyCommitment(b)
    );
  } catch {
    return false;
  }
}

// --- Kind 2: replacements (C2.5) ---------------------------------------------
//
// Canonical message, signed by the key E's replacement clause names and
// co-signed by the successor:
//
//   context "moe/replacement/v1"
//     || 32-byte backing name
//     || u8 role (0x01 operator)
//     || 32-byte successor
//     || 32-byte predecessor (the backing name at the first link)
//     || u64 effective index
//
// The chain is hash-linked: each replacement names its predecessor by the hash
// of that predecessor's own canonical message, and the first link names the
// backing itself. One role is defined, and the field is still written, so a
// replacement of the operator is never read as a replacement of something else.

/** The only role that can be replaced. */
export const ROLE_OPERATOR = 0x01;

export interface Replacement {
  /** Which role is being replaced. Only ROLE_OPERATOR is served. */
  readonly role: number;
  /** The key taking over. */
  readonly successor: Uint8Array;
  /** The previous link: that replacement's own hash, or the backing name. */
  readonly predecessor: Uint8Array;
  /** The witnessed index from which the successor may take over. */
  readonly effective: bigint;
  /** The signature of the key E's replacement clause names. */
  readonly signature: Uint8Array;
  /**
   * The successor's own signature, over the SAME message: naming somebody is
   * not a power over them. One message rather than two, so there is one
   * record, one domain tag and nothing that can fall out of step with itself.
   */
  readonly successorSignature: Uint8Array;
}

/** The bytes the replacement rule's key signs. Throws on a malformed field. */
export function replacementMessage(backingName: Uint8Array, replacement: Replacement): Uint8Array {
  const w = new ByteWriter();
  w.context(REPLACEMENT_CONTEXT);
  w.key32(backingName, "backing name");
  w.u8(replacement.role);
  w.key32(replacement.successor, "successor key");
  w.key32(replacement.predecessor, "predecessor");
  w.u64(replacement.effective);
  return w.finish();
}

/** A replacement's identity, and the value its successor names as predecessor. */
export function replacementHash(backingName: Uint8Array, replacement: Replacement): Uint8Array {
  return sha256(replacementMessage(backingName, replacement));
}

/**
 * A replacement as a **record**, for a venue that stores bytes: the backing it
 * replaces the operator of, the signed fields, then the signature. The backing
 * name is in the record so a record stands alone; it is already inside the
 * signature, so it cannot disagree with itself.
 */
export function encodeReplacement(
  backingName: Uint8Array,
  replacement: Replacement,
): Uint8Array {
  const w = new ByteWriter();
  w.key32(backingName, "backing name");
  w.u8(replacement.role);
  w.key32(replacement.successor, "successor key");
  w.key32(replacement.predecessor, "predecessor");
  w.u64(replacement.effective);
  w.fixed(replacement.signature, 64, "signature");
  w.fixed(replacement.successorSignature, 64, "successor signature");
  return w.finish();
}

/**
 * Strict inverse of encodeReplacement, handing back the backing it names.
 * Throws EncodingError on anything else.
 */
export function decodeReplacement(bytes: Uint8Array): {
  readonly backingName: Uint8Array;
  readonly replacement: Replacement;
} {
  const r = new ByteReader(bytes);
  const backingName = r.raw(32);
  const role = r.u8();
  const successor = r.raw(32);
  const predecessor = r.raw(32);
  const effective = r.u64();
  const signature = r.raw(64);
  const successorSignature = r.raw(64);
  r.expectEnd();
  return {
    backingName,
    replacement: { role, successor, predecessor, effective, signature, successorSignature },
  };
}

/**
 * Whether this is a well-formed replacement of the operator of the named
 * backing, signed by `ruleKey` (the key E's replacement clause names) and by
 * the successor, over the same message. Both halves or it is not a
 * replacement; the successor key is inside the message, so a consent obtained
 * for one handover cannot be lifted into another. Never throws.
 */
export function verifyReplacement(backingName: Uint8Array, replacement: Replacement, ruleKey: Uint8Array): boolean {
  try {
    if (replacement.role !== ROLE_OPERATOR) return false;
    const message = replacementMessage(backingName, replacement);
    return (
      verifySignatureStrict(replacement.signature, message, ruleKey) &&
      verifySignatureStrict(replacement.successorSignature, message, replacement.successor)
    );
  } catch {
    return false;
  }
}

/** A replacement as the reader's own: every byte array copied. */
export function copyReplacement(replacement: Replacement): Replacement {
  return {
    role: replacement.role,
    successor: copyBytes(replacement.successor),
    predecessor: copyBytes(replacement.predecessor),
    effective: replacement.effective,
    signature: copyBytes(replacement.signature),
    successorSignature: copyBytes(replacement.successorSignature),
  };
}

// --- Kind 3: revocations (C2b.1) ---------------------------------------------
//
// It revokes a KEY, not a backing: one K obligates many backings, and revoking
// it revokes all of them at once, so the record names the key. It carries
// nothing else — no sequence, venue or expiry — so two revocations by one key
// are byte-identical, which is what makes republishing harmless.

/** K's own signature that K issues no more. */
export interface Revocation {
  /** The obligor key being revoked. */
  readonly obligor: Uint8Array;
  /** That key's signature over the message below. */
  readonly signature: Uint8Array;
}

/** The bytes K signs: the tag and K itself, and nothing more. Throws on a malformed key. */
export function revocationMessage(obligor: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  w.context(REVOCATION_CONTEXT);
  w.key32(obligor, "obligor key");
  return w.finish();
}

/** Revoke this key. Idempotent by construction: the bytes are always the same. */
export function signRevocation(obligorSecret: Uint8Array): Revocation {
  const obligor = ed25519.getPublicKey(obligorSecret);
  return {
    obligor,
    signature: ed25519.sign(revocationMessage(obligor), obligorSecret),
  };
}

/**
 * A revocation as a **record**: the key, then the signature. Fixed width
 * throughout, so there is one spelling and no length to disagree with.
 */
export function encodeRevocation(revocation: Revocation): Uint8Array {
  const w = new ByteWriter();
  w.key32(revocation.obligor, "obligor key");
  w.fixed(revocation.signature, 64, "signature");
  return w.finish();
}

/** Strict inverse of encodeRevocation. Throws EncodingError on anything else. */
export function decodeRevocation(bytes: Uint8Array): Revocation {
  const r = new ByteReader(bytes);
  const obligor = r.raw(32);
  const signature = r.raw(64);
  r.expectEnd();
  return { obligor, signature };
}

/**
 * Whether this really is K's signature over K. A verifier: anything malformed
 * is a revocation that is not proven rather than a throw. A revocation is one
 * key's word about itself, which is why anyone at all may relay one.
 */
export function isSignedRevocation(revocation: Revocation): boolean {
  try {
    return verifySignatureStrict(
      revocation.signature,
      revocationMessage(revocation.obligor),
      revocation.obligor,
    );
  } catch {
    return false;
  }
}

/** A copy, for the same reason every other record hands out copies. */
export function copyRevocation(revocation: Revocation): Revocation {
  return {
    obligor: copyBytes(revocation.obligor),
    signature: copyBytes(revocation.signature),
  };
}
