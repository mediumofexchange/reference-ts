// C2.10.9–9b, C2b.4: a receipt's verdict at one venue index, read from the
// operator's held record and the receipt's own segment evidence.
import { makeBacking } from "../backing.js";
import { compareBytes, copyBytes, EncodingError } from "../bytes.js";
import { decodeCommitment, encodeCommitment, type Commitment } from "../commitment.js";
import { VenueError, type Venue } from "../venue.js";
import { readPoolCheckpoint, type PoolCheckpointEvidence, type PoolCheckpointFailure, type PoolCheckpointResult } from "./checkpoint.js";
import { readPoolReceiptRecord, type PoolReceiptRecordResult, type PoolReceiptSequence } from "./receipt-record.js";
import type { PoolReceiptCheckpointFact } from "./receipt-repair.js";
import { indexEvidence, relateHeld, type HeldRelation } from "./receipt-walk.js";
import { copyPoolReceipt, type PoolReceipt } from "./receipt.js";
import { PoolError, type SignedBacking, type StatementVerifier } from "./segment.js";
import { copyConfiguration, copySegmentHeader, segmentIdentity, type PoolConfiguration, type SegmentHeader } from "./statement.js";

export type PoolReceiptStatus = "final" | "contradicted" | "abandoned" | "lapsed" | "pending";
export type PoolReceiptLapse =
  | { readonly kind: "moved-past" }
  | { readonly kind: "repair"; readonly boundary: PoolReceiptCheckpointFact }
  | { readonly kind: "scope-boundary"; readonly at: bigint };
export type PoolReceiptStatusResult =
  /** No verdict; contradictions the validated checkpoints before the stop proved remain evidence. */
  | (PoolCheckpointFailure & { readonly contradictedAt: readonly PoolReceiptCheckpointFact[] })
  | { readonly kind: "status"; readonly status: PoolReceiptStatus; readonly witnessedIndex: bigint;
      readonly sequence: PoolReceiptSequence; readonly scope: "not-started" | "live" | "ended";
      /** The earliest witnessed end of an original scope term, exclusive. */
      readonly boundary?: bigint;
      readonly includedAt: readonly PoolReceiptCheckpointFact[]; readonly contradictedAt: readonly PoolReceiptCheckpointFact[];
      /** Present only when the status is abandoned. */
      readonly abandonedAt?: PoolReceiptCheckpointFact;
      /** Present only when the status is lapsed. */
      readonly lapse?: PoolReceiptLapse };

interface Arguments {
  readonly configuration: PoolConfiguration;
  readonly venue: Venue;
  readonly header: SegmentHeader;
  readonly receipt: PoolReceipt;
  readonly backings: readonly SignedBacking[];
  readonly evidence: readonly PoolCheckpointEvidence[];
  readonly verifier: StatementVerifier;
}
interface Held { readonly commitment: Commitment; readonly at: bigint }
type Verified = Extract<PoolCheckpointResult, { kind: "final" }>;

function same(a: Uint8Array, b: Uint8Array): boolean { return compareBytes(a, b) === 0; }
function identical(a: Commitment, b: Commitment): boolean { return same(encodeCommitment(a), encodeCommitment(b)); }
function malformed(cause: unknown): cause is Error {
  return cause instanceof PoolError || cause instanceof EncodingError || cause instanceof TypeError || cause instanceof RangeError ||
    (cause instanceof DOMException && cause.name === "DataCloneError");
}

/**
 * Classify a receipt from the record at the present index (C2.10.9b).
 *
 * The walk covers this operator's held commitments in signed sequence order
 * through bounded predecessor reads that never enumerate holes: the receipt's
 * segment checkpoint at `after`, or its latest live one below `after`, then
 * every held commitment above `after`. It stops at the earliest term end, or
 * at the first checkpoint of another segment that carries a backing of the
 * receipt's scope: that transition is either a proven failed-publication
 * repair (C2.10.9a) or an elective scope change that abandoned the receipt.
 * Held checkpoints carrying none of the scope are passed over; they occupy
 * their sequences and are neither holes nor transitions. Each checkpoint is
 * related and, for the segment's own, replayed in ascending order, and the
 * read ends at the first inclusion: `final` survives every later fact. The
 * transition is replayed only where it decides between repair and
 * abandonment. Malformed, invalid or missing evidence yields no verdict
 * beyond the facts already proven, which the failure carries.
 *
 * `contradicted` keeps its facts beside a later inclusion; `abandoned` and
 * `lapsed` are terminal for this segment; `pending` may still change. No
 * result authorizes service or discard. Venue failures, changed views and
 * verifier programming failures propagate.
 */
export async function readPoolReceiptStatus(args: Arguments): Promise<PoolReceiptStatusResult> {
  let stable = (): void => {};
  let owned: Omit<Arguments, "venue" | "verifier">, venue: Venue, verifier: StatementVerifier;
  let record: Extract<PoolReceiptRecordResult, { kind: "record" }>, boundary: bigint | undefined;
  let base: Held | undefined, above: Held[], relate: (h: Held) => HeldRelation;
  try {
    venue = args.venue; verifier = args.verifier;
    owned = { configuration: copyConfiguration(args.configuration), header: copySegmentHeader(args.header),
      receipt: copyPoolReceipt(args.receipt),
      backings: args.backings.map(b => ({ backing: makeBacking(b.backing), signature: copyBytes(b.signature) })),
      // Evidence frames contain only structured data. Clone before any venue
      // callback; the canonical validator still owns and validates each used frame.
      evidence: structuredClone(args.evidence) };
    const now = venue.witnessedIndex(), lag = venue.lag(), venueId = copyBytes(venue.id);
    stable = (): void => {
      if (venue.witnessedIndex() !== now || venue.lag() !== lag || !same(venue.id, venueId)) {
        throw new VenueError("venue view changed while classifying receipt");
      }
    };
    const recordArgs = { ...owned, venue };
    const read = readPoolReceiptRecord(recordArgs);
    stable();
    if (read.kind === "invalid") return { ...read, contradictedAt: [] };
    record = read;
    const clockStable = stable;
    stable = (): void => {
      clockStable();
      const fresh = readPoolReceiptRecord(recordArgs);
      if (fresh.kind !== "record" || fresh.sequence.kind !== record.sequence.kind ||
          fresh.terms.some((t, i) => t.from !== record.terms[i]!.from || t.until !== record.terms[i]!.until)) {
        throw new VenueError("receipt record changed while classifying");
      }
      clockStable();
    };
    const { receipt, header } = owned, operator = receipt.operator;
    const scope = header.entries.map(e => e.backing);
    const ends = record.terms.flatMap(t => t.until === undefined ? [] : [t.until]);
    boundary = ends.length === 0 ? undefined : ends.reduce((a, b) => a < b ? a : b);
    const end = boundary;
    const live = (at: bigint): boolean => end === undefined || at < end;
    const supplied = indexEvidence(owned.evidence);
    const held = (c: Commitment): Held => {
      const at = venue.witnessedAtSequence(operator, c.sequence);
      if (!same(c.operator, operator) || typeof at !== "bigint" || at < 0n || at > now) throw new VenueError("inconsistent receipt record walk");
      return { commitment: decodeCommitment(encodeCommitment(c)), at };
    };
    const before = (c: Commitment): Commitment | undefined => {
      const previous = venue.previousFor(operator, c.sequence, now);
      if (previous !== undefined && (previous.sequence >= c.sequence || !same(previous.operator, operator))) {
        throw new VenueError("inconsistent receipt record walk");
      }
      return previous;
    };
    // Relation reads owned evidence only; no venue callback runs inside it.
    relate = (h: Held): HeldRelation => relateHeld(supplied, h.commitment, scope, receipt.segment);

    // Every held commitment above `after`, then in ascending sequence order,
    // stopping at the earliest term end: checkpoints witnessed from it on are
    // lapsed for the whole scope and neither finalize nor contradict.
    above = [];
    let cursor = venue.latestFor(operator, now);
    while (cursor !== undefined && cursor.sequence > receipt.after) { above.push(held(cursor)); cursor = before(cursor); }
    above.reverse();
    const lapsedFrom = above.findIndex(h => !live(h.at));
    if (lapsedFrom >= 0) above.length = lapsedFrom;
    const reference = record.sequence;
    if (reference.kind === "held" ? cursor === undefined || !identical(cursor, reference.commitment) : cursor?.sequence === receipt.after) {
      throw new VenueError("receipt reference changed while classifying");
    }
    // The segment's checkpoint at `after`, authenticated whatever its index,
    // or else its latest live checkpoint below `after`: inclusion is read
    // there before any lapse, and a position held otherwise there contradicts.
    // The segment has no checkpoint below its opening sequence.
    if (reference.kind === "held") {
      const h = { commitment: reference.commitment, at: reference.at }, r = relate(h);
      if (r.kind === "unavailable") { stable(); return { kind: "unavailable", commitment: h.commitment, evidence: r.evidence, contradictedAt: [] }; }
      if (r.kind !== "segment") { stable(); return { kind: "invalid", reason: "receipt after checkpoint belongs to another segment", contradictedAt: [] }; }
      if (live(h.at)) base = h;
      cursor = before(reference.commitment);
    }
    for (; base === undefined && cursor !== undefined && cursor.sequence >= header.sequence; cursor = before(cursor)) {
      const h = held(cursor);
      if (!live(h.at)) continue;
      const r = relate(h);
      if (r.kind === "unavailable") { stable(); return { kind: "unavailable", commitment: h.commitment, evidence: r.evidence, contradictedAt: [] }; }
      if (r.kind === "segment") base = h;
    }
    stable();
  } catch (cause) {
    stable();
    if (malformed(cause)) return { kind: "invalid", reason: cause.message, contradictedAt: [] };
    throw cause;
  }
  // Keep proof-backend exceptions outside the malformed-input catch.
  const { receipt } = owned, heldReference = record.sequence.kind === "held";
  const includedAt: PoolReceiptCheckpointFact[] = [], contradictedAt: PoolReceiptCheckpointFact[] = [];
  const verify = async (h: Held): Promise<Verified | PoolReceiptStatusResult> => {
    const result = await readPoolCheckpoint({ ...owned, venue, verifier, checkpoint: h.commitment });
    stable();
    return result.kind === "final" ? result : { ...result, contradictedAt };
  };
  const related = (h: Held): HeldRelation | PoolReceiptStatusResult => {
    try { return relate(h); }
    catch (cause) { if (malformed(cause)) return { kind: "invalid", reason: cause.message, contradictedAt }; throw cause; }
  };
  let abandonedAt: PoolReceiptCheckpointFact | undefined, repair: PoolReceiptCheckpointFact | undefined;
  let lapse: PoolReceiptLapse | undefined;
  const finish = (status: PoolReceiptStatus): PoolReceiptStatusResult => ({
    kind: "status", status, witnessedIndex: record.witnessedIndex, sequence: record.sequence, scope: record.scope,
    ...(boundary === undefined ? {} : { boundary }), includedAt, contradictedAt,
    ...(status === "abandoned" && abandonedAt !== undefined ? { abandonedAt } : {}),
    ...(status === "lapsed" && lapse !== undefined ? { lapse } : {}) });
  /** Replay one checkpoint of the segment; true once the receipt is included. */
  const replay = async (h: Held): Promise<boolean | PoolReceiptStatusResult> => {
    const c = await verify(h);
    if (c.kind !== "final") return c;
    if (!same(segmentIdentity(c.prefix.header), receipt.segment)) throw new Error("validated checkpoint disagrees with its authenticated relation");
    const fact = { commitment: h.commitment, at: c.at };
    const accepted = c.accepted.find(a => a.position === receipt.position);
    if (accepted !== undefined && same(accepted.statementHash, receipt.statementHash) && same(accepted.historyHash, receipt.historyHash)) {
      includedAt.push(fact);
      return true;
    }
    // An omission above a held `after` contradicts; above a moved-past
    // `after` it is that lapse (C2b.4). A position occupied otherwise at or
    // below `after` was fixed before the receipt's era and contradicts either way.
    if (h.commitment.sequence > receipt.after ? heldReference : accepted !== undefined) contradictedAt.push(fact);
    return false;
  };
  if (base !== undefined) {
    const done = await replay(base);
    if (done === true) return finish("final");
    if (done !== false) return done;
  }
  let lastSegment = receipt.after, passedOver = 0n;
  for (const h of above) {
    const r = related(h);
    if (r.kind === "unavailable") return { kind: "unavailable", commitment: h.commitment, evidence: r.evidence, contradictedAt };
    if (r.kind === "invalid") return r;
    if (r.kind === "other") { passedOver++; continue; }
    if (r.kind === "segment") {
      const done = await replay(h);
      if (done === true) return finish("final");
      if (done !== false) return done;
      lastSegment = h.commitment.sequence; passedOver = 0n;
      continue;
    }
    // Nothing above a carrying checkpoint can be a canonical checkpoint of
    // the segment, so this transition ends the read. It decides between
    // repair and abandonment only where nothing else has decided: a held
    // reference with neither inclusion nor a proven contradiction before it.
    if (!heldReference || contradictedAt.length !== 0) break;
    const c = await verify(h);
    if (c.kind !== "final") return c;
    if (same(segmentIdentity(c.prefix.header), receipt.segment)) throw new Error("validated checkpoint disagrees with its authenticated relation");
    // C2.10.9a's hole: a sequence between the segment's last held checkpoint
    // and this transition that the record never held.
    const fact = { commitment: h.commitment, at: c.at };
    const hole = h.commitment.sequence - lastSegment - 1n > passedOver;
    if (c.prefix.length === 0n && c.prefix.header.sequence === h.commitment.sequence && hole) repair = fact; else abandonedAt = fact;
    break;
  }
  if (record.sequence.kind === "moved-past") lapse = { kind: "moved-past" };
  else if (repair !== undefined) lapse = { kind: "repair", boundary: repair };
  else if (boundary !== undefined && record.witnessedIndex >= boundary) lapse = { kind: "scope-boundary", at: boundary };
  return finish(contradictedAt.length !== 0 ? "contradicted" : abandonedAt !== undefined ? "abandoned" : lapse !== undefined ? "lapsed" : "pending");
}
