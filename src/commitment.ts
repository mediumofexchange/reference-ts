// Commitments over ledger state (invariants 22, 23).
//
// At each interval a sequencer publishes a commitment: a signed hash over the
// state it serves — per backing, its name and its full operation log, all seven
// kinds with presentation included. Invariant 22: every state a sequencer
// asserts must prove against its latest published commitment, so two
// commitments at one sequence number over different roots, both validly signed
// by the operator, are provable equivocation.
//
// **The log is all that is committed, because the log is all there is.**
// Invariant 23 asks the commitment to commit to "the issuance log, the spent
// set, running totals and the standing demand record"; under transparent the log
// determines every one of them, so committing it commits them all. Balances,
// totals and the standing demands were once committed beside it and re-derived
// by the verifier — three mechanisms for data one of them fixes, and the source
// of a run of "field X is not tied to the log" bugs, each patched separately.
// Deriving them instead does not check that class of lie; it makes it
// unsayable. Invariant 10 comes with it: every operation the replay applies
// either conserves the total or moves issued/burned with it, so
// `outstanding = issued − burned` is a property of the fold rather than an
// assertion to police.
//
// The root must be INJECTIVE or invariant 22 is worthless: if two different
// served states hash to one root, an operator equivocates with a single
// signature and no provable fault. Injectivity comes from the framing rule —
// every key and name goes through key32 (fixed width, asserted) and every
// variable-length field is length-prefixed. Writing keys raw is what breaks
// it: a 31-byte and a 33-byte key concatenate exactly like two 32-byte keys.
//
// The root authenticates a complete directory of names and snapshot digests.
// A reader needs only the relevant logs plus that directory. A missing name
// proves omission; a named log that was not supplied is unavailable evidence.
// Neither the directory nor its digest proves availability or continuity.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ByteWriter, compareBytes, copyBytes, EncodingError } from "./bytes.js";
import { backingName, type Backing } from "./backing.js";
import type { BackingSnapshot } from "./ledger.js";
import { isAnOperator } from "./replacement.js";
import { answering, type Venue } from "./venue.js";
import { copyOpEntry, opIdentityOfEntry, type OpLogEntry } from "./oplog.js";
import {
  decodeCommitment, directoryRoot, encodeCommitment, verifyCommitment, type Commitment, type SnapshotDigest,
} from "./venue-records.js";

export type { BackingSnapshot } from "./ledger.js";
// The record, its signature and the directory root are construction-neutral
// (`venue-records.ts`); this module derives a directory from transparent logs.
export {
  commitmentIdentity, decodeCommitment, directoryRoot, encodeCommitment, isEquivocation, signCommitment, verifyCommitment,
  type Commitment, type SnapshotDigest,
} from "./venue-records.js";

/**
 * A logged operation is committed as the exact bytes the party signed. So the
 * commitment commits the operation a receipt attests to rather than a
 * re-description of it, "the committed entry reconstructs to the receipt's op
 * hash" holds by construction, and no kind tag is needed: every message opens
 * with its own domain tag, and contexts.ts asserts those are prefix-free.
 *
 * `opIdentityOfEntry` rather than the message, for the one kind where they
 * differ: a commit's signature SET decides which locks it converts, so two
 * objects under one attempt fold to different states from one log prefix. Rooted
 * by the message alone they rooted identically — one operator signature over two
 * lawful states, which is exactly the injectivity this root exists to have
 * (found regression-reviewing the receipt fix, which bound the object's identity
 * for the receipt and left it unbound here).
 */
function writeOpEntry(w: ByteWriter, name: Uint8Array, entry: OpLogEntry, index: number): void {
  // The position is pinned to the array index, not merely well-formed. A
  // self-declared position lets an operator commit to a log with a gap, so a
  // holder's valid receipt for the missing position proves against nothing
  // while the state itself still verifies — asserted state that hides an
  // accepted operation. Pinned, the position carries no information the index
  // does not, so it is not written.
  if (entry.position !== index) {
    throw new EncodingError("op-log position does not match its index");
  }
  w.lengthPrefixed(opIdentityOfEntry(name, entry));
}

function encodeSnapshot(snapshot: BackingSnapshot): Uint8Array {
  const w = new ByteWriter();
  w.key32(snapshot.name, "backing name");
  w.u32(snapshot.opLog.length);
  snapshot.opLog.forEach((entry, i) => writeOpEntry(w, snapshot.name, entry, i));
  return w.finish();
}

/** Derive a canonical directory, copying its names and rejecting duplicate snapshots. */
export function directoryOf(snapshots: readonly BackingSnapshot[]): SnapshotDigest[] {
  const sorted = [...snapshots].sort((a, b) => compareBytes(a.name, b.name));
  for (let i = 1; i < sorted.length; i++) {
    if (compareBytes((sorted[i - 1] as BackingSnapshot).name, (sorted[i] as BackingSnapshot).name) === 0) {
      throw new EncodingError("duplicate backing in state");
    }
  }
  return sorted.map((snapshot) => ({ name: copyBytes(snapshot.name), digest: sha256(encodeSnapshot(snapshot)) }));
}

/** Deterministic root over all snapshots. External proofs use stateProvesCommitment. */
export function stateRoot(snapshots: readonly BackingSnapshot[]): Uint8Array {
  return directoryRoot(directoryOf(snapshots));
}

/**
 * Whether a served state is the state a commitment commits to (invariant 22).
 * Never throws: a malformed state is a failed proof, not a crash.
 */
export function stateProvesCommitment(
  snapshots: readonly BackingSnapshot[],
  commitment: Commitment,
  directory?: readonly SnapshotDigest[],
): boolean {
  // The whole body, not only the root: a malformed COMMITMENT threw past the
  // guard (found by the 2026-08-22 audit).
  try {
    const supplied = directoryOf(snapshots);
    const complete = directory === undefined ? supplied : directory;
    if (compareBytes(directoryRoot(complete), commitment.root) !== 0 || !verifyCommitment(commitment)) {
      return false;
    }
    const digests = new Map(complete.map((entry) => [bytesToHex(entry.name), entry.digest]));
    return supplied.every((entry) => {
      const expected = digests.get(bytesToHex(entry.name));
      return expected !== undefined && compareBytes(entry.digest, expected) === 0;
    });
  } catch {
    return false;
  }
}

/** A served state and the commitment it must prove against — what a holder is handed. */
export interface ServedState {
  readonly snapshots: readonly BackingSnapshot[];
  readonly commitment: Commitment;
  /** Complete authenticated directory when unrelated logs have been omitted. */
  readonly directory?: readonly SnapshotDigest[];
}

/** Keep requested logs and the complete directory, with no mutable input aliases. */
export function compactState(served: ServedState, names: readonly Uint8Array[]): ServedState {
  if (!stateProvesCommitment(served.snapshots, served.commitment, served.directory)) {
    throw new EncodingError("served state does not prove its commitment");
  }
  const wanted = new Set(names.map(bytesToHex));
  return {
    snapshots: served.snapshots.filter((snapshot) => wanted.has(bytesToHex(snapshot.name))).map((snapshot) => ({
      name: copyBytes(snapshot.name),
      opLog: snapshot.opLog.map(copyOpEntry),
    })),
    commitment: decodeCommitment(encodeCommitment(served.commitment)),
    directory: (served.directory ?? directoryOf(served.snapshots)).map((entry) => ({
      name: copyBytes(entry.name), digest: copyBytes(entry.digest),
    })),
  };
}

/**
 * What a served state turns out to be, read for **one** backing.
 *
 *   - `log`       this operator's committed operation log for the backing.
 *   - `dropped`   genuinely this operator's committed state, well-rooted, and it
 *                 carries no entry for this backing at all.
 *   - `undefined` invalid evidence, wrong operator, or a named but withheld log.
 *
 * **The middle answer is the slice.** It used to be merged into `undefined`, and
 * the two are not the same fact: one says "you are asking the wrong party", the
 * other says "your own operator's state has nothing in it for you". Merged, every
 * caller reported the second as the first — which is the exonerating direction,
 * and it left §C2's shared operator able to freeze one backing while looking
 * punctual on the rest (§C2: "a shared operator publishes one transaction over a
 * root of its backings' commitments", so a commitment omitting one is not a
 * commitment for it, and a stranger reading a root cannot tell).
 *
 * `dropped` is a description of the state, never an accusation. A commitment made
 * before the backing was ever registered drops it perfectly innocently, and a
 * commitment carries no venue index to place it by. Naming the fault takes two
 * states, ordered, which is isRewrittenHistory's job.
 *
 * Both answers carry the sequence, because every caller that compares two
 * committed states needs to know which came first, and taking that from the
 * caller would let it choose.
 */
export type CommittedLog =
  | {
      readonly kind: "log";
      readonly sequence: bigint;
      readonly opLog: readonly OpLogEntry[];
    }
  | { readonly kind: "dropped"; readonly sequence: bigint };

/**
 * This backing's operation log out of a state one of its **own** operators
 * really committed — or, where that state carries nothing for this backing, the
 * fact that it does not.
 *
 * Three questions that always travel together: is this commitment signed by a
 * key that has served this backing (anyone can sign a valid commitment over any
 * state they like), is the served state the one it commits to, and does it carry
 * this backing at all. They were asked in three places — the redemption walk, a
 * receipt's standing, and a rewritten history — so they are asked here instead.
 *
 * **A key that has served, not the key E names.** After a handover the state of
 * record is the successor's, and a predecessor's committed state is still the
 * history it really committed — §C2's "a wallet verifies the chain rather than
 * the key it remembers". Membership rather than time, because a commitment
 * carries a sequence of its operator's own counting and not a venue index, so
 * "was this key in force then" is not a question its bytes can answer. What
 * decides which committed state is current is the operator in force now
 * (replayLatestState), and that does read the chain by index.
 */
export function committedLogFor(
  backing: Backing,
  venue: Venue,
  served: ServedState,
): CommittedLog | undefined {
  return answering(() => {
    if (!isAnOperator(backing, venue, served.commitment.operator)) return undefined;
    if (!stateProvesCommitment(served.snapshots, served.commitment, served.directory)) return undefined;
    const sequence = served.commitment.sequence;
    // By the RECOMPUTED name: a resolver's object carrying another backing's
    // `.name` field steered every reader into that backing's state after the
    // hash check had passed (found in the last regression pass) — the one place a
    // snapshot is picked, so every reader inherits it.
    const name = backingName(backing);
    const snapshot = served.snapshots.find((s) => compareBytes(s.name, name) === 0);
    if (snapshot === undefined) {
      if (served.directory?.some((entry) => compareBytes(entry.name, name) === 0)) return undefined;
      return { kind: "dropped", sequence };
    }
    return { kind: "log", sequence, opLog: snapshot.opLog };
  }, undefined);
}
