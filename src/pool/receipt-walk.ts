// C2.10.9a–b: how one held checkpoint relates to a receipt's segment, read
// from authenticated directory and snapshot evidence before any replay.
// Internal to the receipt readers; the barrel does not export it.
import { bytesToHex } from "@noble/hashes/utils.js";
import { compareBytes } from "../bytes.js";
import { directoryRoot, encodeCommitment, verifyCommitment, type Commitment } from "../commitment.js";
import type { PoolCheckpointEvidence } from "./checkpoint.js";
import { PoolError } from "./segment.js";
import { copySegmentHeader, segmentIdentity, snapshotDigest } from "./statement.js";

/**
 * `segment`: carries the scope under the receipt's own segment.
 * `transition`: carries a backing of the scope under another segment, so it
 * changes that backing's carrying state (C2.10.4).
 * `other`: carries none of the scope's backings; it is passed over.
 * A relation is the operator's authenticated claim; canonical validation of
 * the checkpoint remains the validator's (C2.10.3–5).
 */
export type HeldRelation =
  | { readonly kind: "segment" | "transition" | "other" }
  | { readonly kind: "unavailable"; readonly evidence: "directory" | "scope" };

function same(a: Uint8Array, b: Uint8Array): boolean { return compareBytes(a, b) === 0; }
function requireThat(ok: boolean, reason: string): asserts ok {
  if (!ok) throw new PoolError("SEGMENT", reason);
}
export function checkpointKey(c: Commitment): string { return `${bytesToHex(c.operator)}:${c.sequence}:${bytesToHex(c.root)}`; }

/** Index owned evidence by exact commitment; duplicates are malformed. */
export function indexEvidence(evidence: readonly PoolCheckpointEvidence[]): Map<string, PoolCheckpointEvidence> {
  const supplied = new Map<string, PoolCheckpointEvidence>();
  for (const item of evidence) {
    const id = checkpointKey(item.commitment);
    requireThat(!supplied.has(id), "duplicate checkpoint evidence");
    supplied.set(id, item);
  }
  return supplied;
}

/** Relate one exact held commitment to the receipt's scope and segment. The
 * directory proves carriage or its absence; one carried backing's snapshot
 * preimage authenticates the header the operator committed for it. Malformed
 * evidence throws PoolError/EncodingError for the caller to report as invalid. */
export function relateHeld(supplied: ReadonlyMap<string, PoolCheckpointEvidence>, held: Commitment,
  scope: readonly Uint8Array[], segment: Uint8Array): HeldRelation {
  const e = supplied.get(checkpointKey(held));
  if (e === undefined) return { kind: "unavailable", evidence: "directory" };
  requireThat(verifyCommitment(e.commitment) && same(encodeCommitment(e.commitment), encodeCommitment(held)) &&
    same(directoryRoot(e.directory), held.root), "directory does not match the held commitment");
  const carried = e.directory.find(d => scope.some(name => same(name, d.name)));
  if (carried === undefined) return { kind: "other" };
  const matches = (e.snapshots ?? []).filter(s => same(s.backing, carried.name));
  requireThat(matches.length <= 1, "duplicate snapshot evidence for a backing");
  const snapshot = matches[0];
  if (snapshot === undefined) return { kind: "unavailable", evidence: "scope" };
  const header = copySegmentHeader(snapshot.header);
  requireThat(typeof snapshot.issued === "bigint" && typeof snapshot.burned === "bigint", "malformed snapshot totals");
  const identity = segmentIdentity(header);
  requireThat(same(snapshotDigest(carried.name, identity, snapshot.historyHash, snapshot.issued, snapshot.burned), carried.digest),
    "snapshot does not authenticate the header");
  requireThat(same(header.operator, held.operator) && held.sequence >= header.sequence, "checkpoint does not belong to its header");
  return { kind: same(identity, segment) ? "segment" : "transition" };
}
