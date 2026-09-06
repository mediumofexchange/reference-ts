// Combine already owned evidence from successful record reads. Histories are
// included only after checkpoint replay; descent contributes directories and
// the exact snapshot preimages it authenticated, never an unverified tail.
import { bytesToHex } from "@noble/hashes/utils.js";
import type { PoolCheckpointEvidence } from "./checkpoint.js";
import type { Commitment } from "../commitment.js";
import type { Segment } from "./segment.js";
import { ISSUE } from "./statement.js";

/** Derive snapshot preimages from a replayed prefix, not supplied assertions. */
export function replayedPoolEvidence(commitment: Commitment, segment: Segment, length = segment.length): PoolCheckpointEvidence {
  const prefix = segment.prefix(length), trail = segment.trail();
  const totals = new Map<string, { issued: bigint; burned: bigint }>();
  for (const event of prefix.events) if (event.lit !== undefined) {
    const name = bytesToHex(event.lit.backing), held = totals.get(name) ?? { issued: 0n, burned: 0n };
    if (event.lit.kind === ISSUE) held.issued += event.lit.quantity; else held.burned += event.lit.quantity;
    totals.set(name, held);
  }
  return { commitment, directory: prefix.directory,
    snapshots: trail.header.entries.map(e => ({ backing: e.backing, header: trail.header, historyHash: prefix.historyHash,
      ...(totals.get(bytesToHex(e.backing)) ?? { issued: 0n, burned: 0n }), backings: trail.backings })),
    history: { trail: { ...trail, statements: trail.statements.slice(0, Number(length)) }, length } };
}

export function mergePoolEvidence(items: readonly PoolCheckpointEvidence[]): PoolCheckpointEvidence[] {
  const retained = new Map<string, PoolCheckpointEvidence>();
  for (const item of items) {
    const c = item.commitment, key = `${bytesToHex(c.operator)}:${c.sequence}:${bytesToHex(c.root)}`;
    const previous = retained.get(key);
    const snapshots = new Map([...(previous?.snapshots ?? []), ...(item.snapshots ?? [])]
      .map(s => [bytesToHex(s.backing), s]));
    const history = item.history ?? previous?.history;
    retained.set(key, { commitment: item.commitment, directory: item.directory,
      ...(snapshots.size === 0 ? {} : { snapshots: [...snapshots.values()] }),
      ...(history === undefined ? {} : { history }) });
  }
  return [...retained.values()];
}
