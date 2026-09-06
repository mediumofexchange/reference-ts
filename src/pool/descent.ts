// C2.7.1–3 / C2.10.4: exact directory descent selects a candidate before
// replay checks it. No proof failure or missing history licenses fallback.
// This read does not finalize checkpoints or certify imported prefixes.
import { bytesToHex } from "@noble/hashes/utils.js";
import { makeBacking } from "../backing.js";
import { compareBytes, copyBytes, EncodingError } from "../bytes.js";
import { decodeCommitment, directoryRoot, encodeCommitment, verifyCommitment, type Commitment } from "../commitment.js";
import { VenueError, type Venue } from "../venue.js";
import { PoolAuthorityView } from "./authority.js";
import { PoolError, type Checkpoint, type SignedBacking } from "./segment.js";
import { configurationHash, copyConfiguration, copySegmentHeader, segmentIdentity, snapshotDigest,
  type PoolConfiguration, type SegmentHeader } from "./statement.js";

/** Preimage of one pool-v2 §9 snapshot digest. It authenticates the full
 * header without revealing or replaying local statements or imported history.
 * Totals and historyHash are assertions until the candidate is replayed. */
export interface PoolSnapshotEvidence {
  readonly backing: Uint8Array;
  readonly header: SegmentHeader;
  readonly historyHash: Uint8Array;
  readonly issued: bigint;
  readonly burned: bigint;
  readonly backings: readonly SignedBacking[];
}

/** The complete directory proves carriage or absence. If it carries the
 * queried backing, its snapshot preimage is needed to decide public lapse. */
export interface PoolDirectoryEvidence extends Checkpoint {
  readonly snapshot?: PoolSnapshotEvidence;
}

export type PoolPredecessor =
  | { readonly kind: "genesis" }
  | { readonly kind: "candidate"; readonly checkpoint: Checkpoint; readonly at: bigint; readonly header: SegmentHeader }
  | { readonly kind: "unavailable"; readonly commitment: Commitment; readonly evidence: "directory" | "scope" }
  | { readonly kind: "invalid"; readonly reason: string };

const ABOVE_SEQUENCE_RANGE = 1n << 64n;
function same(a: Uint8Array, b: Uint8Array): boolean { return compareBytes(a, b) === 0; }
function key(c: Commitment): string { return `${bytesToHex(c.operator)}:${c.sequence}:${bytesToHex(c.root)}`; }
function ownBacking(s: SignedBacking): SignedBacking {
  return { backing: makeBacking(s.backing), signature: copyBytes(s.signature) };
}
function ownEvidence(e: PoolDirectoryEvidence): PoolDirectoryEvidence {
  const checkpoint = { commitment: decodeCommitment(encodeCommitment(e.commitment)),
    directory: e.directory.map(d => ({ name: copyBytes(d.name), digest: copyBytes(d.digest) })) };
  if (e.snapshot === undefined) return checkpoint;
  return { ...checkpoint, snapshot: e.snapshot };
}
function ownSnapshot(s: PoolSnapshotEvidence): PoolSnapshotEvidence {
  return { backing: copyBytes(s.backing), header: copySegmentHeader(s.header),
    historyHash: copyBytes(s.historyHash), issued: s.issued, burned: s.burned, backings: s.backings.map(ownBacking) };
}
function requireThat(ok: boolean, reason: string): asserts ok {
  if (!ok) throw new PoolError("SEGMENT", reason);
}

/** Authenticate scope BEFORE consulting term ends. One carried snapshot
 * binds the whole header even if another scope name is selectively omitted;
 * such a directory cannot finalize the segment (C2.10.3), but its authenticated
 * scope can still prove public whole-scope lapse (C2.10.4). */
function lapsed(configuration: PoolConfiguration, venue: Venue, c: Commitment, at: bigint,
  backing: Uint8Array, digest: Uint8Array, snapshot: PoolSnapshotEvidence): boolean {
  const h = snapshot.header;
  requireThat(same(snapshot.backing, backing) && h.entries.some(e => same(e.backing, backing)), "snapshot does not scope this backing");
  requireThat(same(c.operator, h.operator) && c.sequence >= h.sequence, "checkpoint does not belong to this header");
  requireThat(same(snapshotDigest(backing, segmentIdentity(h), snapshot.historyHash, snapshot.issued, snapshot.burned), digest),
    "snapshot does not authenticate the header");
  const names = new Set(snapshot.backings.map(b => bytesToHex(b.backing.name)));
  requireThat(snapshot.backings.length === h.entries.length &&
    h.entries.every(e => names.has(bytesToHex(e.backing))), "scope terms are incomplete");
  const authority = new PoolAuthorityView(configuration, venue, snapshot.backings);
  // The authority constructor checks every backing's domain and venue;
  // authorizes also checks the header's domain and venue, but a lapsed header
  // is deliberately not authorized at the present. Check those identities here.
  requireThat(same(h.domain, configurationHash(configuration)) && same(h.venue, venue.id), "wrong scope domain or venue");
  const terms = h.entries.map(e => {
    const term = authority.termForLink(e.backing, e.link);
    requireThat(term !== undefined && same(term.operator, h.operator), "unknown or wrong-operator scope link");
    return term;
  });
  if (terms.some(t => t.until !== undefined && t.until <= at)) return true;
  requireThat(terms.every(t => t.from <= at), "scope term has not started");
  return false;
}

interface PoolDescentArguments {
  readonly configuration: PoolConfiguration;
  readonly venue: Venue;
  readonly backing: SignedBacking;
  readonly evidence: readonly PoolDirectoryEvidence[];
}

/**
 * Select the record-derived predecessor of one backing relative to an exact
 * HELD child commitment (C2.10.4). The child's own header/finality is outside
 * this read. Every scoped backing requires its own selection before replay.
 *
 * Directories are copied before record reads. Snapshot preimages are copied
 * only for carrying steps; absence needs no scope data. The read is synchronous
 * and no callbacks fetch histories or choose the descent. Each step consumes
 * the next held record within the backing's historical term. No global graph
 * or search through absent sequences is performed.
 *
 * A candidate is NOT a finalized prefix. Its full directory, history and
 * transitive canonical openings still require C2.10.3–5 validation. In
 * particular, invalid/withheld live history leaves this candidate in place.
 * Malformed evidence returns invalid; unavailable venue reads throw VenueError.
 */
export function readPoolPredecessor(args: PoolDescentArguments & { readonly child: Commitment }): PoolPredecessor {
  return readDescent(args, "held");
}

/** Select the latest carrying state for the operator currently in force,
 * before a new segment has a child commitment (C2.7.3, C2.10.4). All held
 * sequences at the current index are eligible; no caller-supplied sequence
 * can hide a newer record. Historical terms retain their exclusive ends.
 * This is candidate selection, not finality, signing or discard authority. */
export function readPoolCurrent(args: PoolDescentArguments & { readonly operator: Uint8Array }): PoolPredecessor {
  return readDescent(args, "current");
}

function readDescent(args: PoolDescentArguments & { readonly child?: Commitment; readonly operator?: Uint8Array }, mode: "held" | "current"): PoolPredecessor {
  try {
    const configuration = copyConfiguration(args.configuration), backing = ownBacking(args.backing);
    const child = mode === "held" ? decodeCommitment(encodeCommitment(args.child!)) : undefined;
    const operator = child?.operator ?? copyBytes(args.operator!);
    const supplied = args.evidence.map(ownEvidence), evidence = new Map<string, PoolDirectoryEvidence>();
    for (const e of supplied) {
      requireThat(!evidence.has(key(e.commitment)), "duplicate checkpoint evidence");
      evidence.set(key(e.commitment), e);
    }
    const venue = args.venue, authority = new PoolAuthorityView(configuration, venue, [backing]);
    const now = authority.witnessedIndex, venueId = copyBytes(venue.id);
    let atLimit = now;
    const sequenceLimit = child?.sequence ?? ABOVE_SEQUENCE_RANGE;
    if (child !== undefined) {
      requireThat(verifyCommitment(child), "invalid child signature");
      // This bounded read also makes an unfinished Ergo refresh refuse before
      // the legacy exact-index method is consulted.
      const held = venue.previousFor(child.operator, child.sequence + 1n, now);
      requireThat(held !== undefined && same(encodeCommitment(held), encodeCommitment(child)), "child checkpoint is not held");
      const childAt = venue.witnessedAtSequence(child.operator, child.sequence);
      if (typeof childAt !== "bigint" || childAt > now || childAt < 0n) throw new VenueError("inconsistent child index");
      atLimit = childAt;
    }
    requireThat(same(authority.term(backing.backing.name, atLimit)!.operator, operator), "operator is not in force for this backing");

    const select = (): PoolPredecessor => {
      let termAt = atLimit;
      for (;;) {
        const term = authority.term(backing.backing.name, termAt)!;
        // Other operators have no eligible edge at the child's index. Each
        // old term ends exclusively, including when the same key is appointed again.
        let limit = same(term.operator, operator) ? atLimit : atLimit - 1n;
        if (term.until !== undefined && term.until - 1n < limit) limit = term.until - 1n;
        let before = same(term.operator, operator) ? sequenceLimit : ABOVE_SEQUENCE_RANGE;
        while (limit >= term.from) {
          const c = venue.previousFor(term.operator, before, limit);
          if (c === undefined) break;
          const at = venue.witnessedAtSequence(c.operator, c.sequence);
          if (!same(c.operator, term.operator) || c.sequence >= before || typeof at !== "bigint" || at > limit || at < 0n || !verifyCommitment(c)) {
            throw new VenueError("inconsistent predecessor record");
          }
          if (at < term.from) break;
          const e = evidence.get(key(c));
          if (e === undefined) return { kind: "unavailable", commitment: c, evidence: "directory" };
          requireThat(same(encodeCommitment(e.commitment), encodeCommitment(c)) && same(directoryRoot(e.directory), c.root),
            "directory does not match the held commitment");
          const named = e.directory.find(d => same(d.name, backing.backing.name));
          if (named !== undefined) {
            if (e.snapshot === undefined) return { kind: "unavailable", commitment: c, evidence: "scope" };
            const snapshot = ownSnapshot(e.snapshot);
            if (!lapsed(configuration, venue, c, at, backing.backing.name, named.digest, snapshot)) {
              return { kind: "candidate", checkpoint: { commitment: c, directory: e.directory }, at, header: snapshot.header };
            }
          }
          before = c.sequence;
        }
        if (term.from === 0n) return { kind: "genesis" };
        termAt = term.from - 1n;
      }
    };
    const result = select();
    if (venue.witnessedIndex() !== now || venue.lag() !== authority.lag || !same(venue.id, venueId)) {
      throw new VenueError("venue view changed during predecessor read");
    }
    return result;
  } catch (cause) {
    if (cause instanceof PoolError || cause instanceof EncodingError || cause instanceof TypeError || cause instanceof RangeError) {
      return { kind: "invalid", reason: cause.message };
    }
    throw cause;
  }
}
