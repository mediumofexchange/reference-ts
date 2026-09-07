// C2.10.9a: classification at one supplied failed-publication repair boundary.
import { makeBacking } from "../backing.js";
import { compareBytes, copyBytes, EncodingError } from "../bytes.js";
import { decodeCommitment, encodeCommitment, type Commitment } from "../commitment.js";
import { VenueError, type Venue } from "../venue.js";
import { readPoolCheckpoints, type PoolCheckpointEvidence, type PoolCheckpointFailure } from "./checkpoint.js";
import { readPoolReceiptRecord } from "./receipt-record.js";
import { copyPoolReceipt, type PoolReceipt } from "./receipt.js";
import { PoolError, type SignedBacking, type StatementVerifier } from "./segment.js";
import { copyConfiguration, copySegmentHeader, segmentIdentity, type PoolConfiguration, type SegmentHeader } from "./statement.js";

export interface PoolReceiptCheckpointFact { readonly commitment: Commitment; readonly at: bigint }
export type PoolReceiptRepairResult = PoolCheckpointFailure
  | { readonly kind: "not-applicable"; readonly reason: "after-not-held" | "wrong-operator" | "no-gap" |
      "scope-boundary" | "not-opening" | "earlier-transition" }
  | { readonly kind: "repair"; readonly boundary: PoolReceiptCheckpointFact; readonly witnessedIndex: bigint;
      readonly includedAt: readonly PoolReceiptCheckpointFact[]; readonly contradictedAt: readonly PoolReceiptCheckpointFact[];
      readonly lapsed: boolean };

interface Arguments {
  readonly configuration: PoolConfiguration;
  readonly venue: Venue;
  readonly header: SegmentHeader;
  readonly receipt: PoolReceipt;
  readonly backings: readonly SignedBacking[];
  readonly repair: Commitment;
  readonly evidence: readonly PoolCheckpointEvidence[];
  readonly verifier: StatementVerifier;
}
function same(a: Uint8Array, b: Uint8Array): boolean { return compareBytes(a, b) === 0; }
function identical(a: Commitment, b: Commitment): boolean { return same(encodeCommitment(a), encodeCommitment(b)); }

/** Prove C2.10.9a at the supplied repair, not a global verdict at the current
 * index. Later inclusion must still be checked independently. This reader
 * covers a held `after` and original terms live at the repair; other scope
 * boundaries and unheld receipt references are outside this predicate.
 *
 * Enumerates only this operator's held interval [after, repair], using bounded
 * predecessor reads (never enumerates sequence holes). Canonical replay checks
 * every member and its required ancestors in one batch. Missing or invalid
 * evidence never excuses a tail. Inclusion and contradiction are independent;
 * only neither permits lapse. No result authorizes service or tail discard.
 * Venue and backend failures propagate. External data is owned before callbacks.
 */
export async function readPoolReceiptRepair(args: Arguments): Promise<PoolReceiptRepairResult> {
  let stable = (): void => {};
  let owned: Omit<Arguments, "venue" | "verifier">, targets: Commitment[], witnessedIndex: bigint;
  let venue: Venue, verifier: StatementVerifier;
  try {
    venue = args.venue; verifier = args.verifier;
    owned = { configuration: copyConfiguration(args.configuration), header: copySegmentHeader(args.header),
      receipt: copyPoolReceipt(args.receipt),
      backings: args.backings.map(b => ({ backing: makeBacking(b.backing), signature: copyBytes(b.signature) })),
      repair: decodeCommitment(encodeCommitment(args.repair)),
      // Evidence frames contain only structured data. Clone before any venue
      // callback; the canonical validator still owns and validates each used frame.
      evidence: structuredClone(args.evidence) };
    const now = venue.witnessedIndex(), lag = venue.lag(), venueId = copyBytes(venue.id);
    witnessedIndex = now;
    stable = (): void => {
      if (venue.witnessedIndex() !== now || venue.lag() !== lag || !same(venue.id, venueId)) {
        throw new VenueError("venue view changed while reading receipt repair");
      }
    };
    const recordArgs = { ...owned, venue };
    const record = readPoolReceiptRecord(recordArgs);
    stable();
    if (record.kind === "invalid") return record;
    const clockStable = stable;
    stable = (): void => {
      clockStable();
      const fresh = readPoolReceiptRecord(recordArgs);
      if (fresh.kind !== "record" || fresh.terms.some((t, i) => t.from !== record.terms[i]!.from || t.until !== record.terms[i]!.until)) {
        throw new VenueError("receipt scope changed while reading repair");
      }
      clockStable();
    };
    const { receipt, repair } = owned;
    if (record.sequence.kind !== "held") return { kind: "not-applicable", reason: "after-not-held" };
    if (!same(repair.operator, receipt.operator)) return { kind: "not-applicable", reason: "wrong-operator" };
    if (repair.sequence - 1n <= receipt.after) return { kind: "not-applicable", reason: "no-gap" };
    const held = venue.previousFor(receipt.operator, repair.sequence + 1n, now);
    const at = venue.witnessedAtSequence(receipt.operator, repair.sequence);
    if (held === undefined || !identical(held, repair) || typeof at !== "bigint" || at < 0n || at > now) {
      stable(); return { kind: "invalid", reason: "repair checkpoint is not exactly held" };
    }
    if (record.terms.some(t => t.from > at || (t.until !== undefined && t.until <= at))) {
      stable(); return { kind: "not-applicable", reason: "scope-boundary" };
    }
    targets = [repair];
    let upper = repair.sequence;
    while (upper > receipt.after) {
      const previous = venue.previousFor(receipt.operator, upper, at);
      if (previous === undefined || previous.sequence >= upper || previous.sequence < receipt.after || !same(previous.operator, receipt.operator)) {
        throw new VenueError("inconsistent receipt repair interval");
      }
      if (upper === repair.sequence) {
        const gapAt = venue.witnessedAtSequence(receipt.operator, repair.sequence - 1n);
        if (previous.sequence === repair.sequence - 1n) {
          if (typeof gapAt !== "bigint") throw new VenueError("inconsistent repair gap lookup");
          stable(); return { kind: "not-applicable", reason: "no-gap" };
        }
        if (gapAt !== undefined) throw new VenueError("inconsistent repair gap lookup");
      }
      targets.push(decodeCommitment(encodeCommitment(previous)));
      upper = previous.sequence;
    }
    if (!identical(targets.at(-1)!, record.sequence.commitment)) throw new VenueError("receipt reference changed during repair read");
    targets.reverse();
    stable();
  } catch (cause) {
    stable();
    if (cause instanceof PoolError || cause instanceof EncodingError || cause instanceof TypeError || cause instanceof RangeError ||
        (cause instanceof DOMException && cause.name === "DataCloneError")) return { kind: "invalid", reason: cause.message };
    throw cause;
  }
  // Keep proof-backend exceptions outside the malformed-input catch.
  const result = await readPoolCheckpoints({ ...owned, venue, verifier, checkpoints: targets });
  stable();
  if (result.kind !== "final") return result;
  const first = result.checkpoints[0]!, last = result.checkpoints.at(-1)!;
  if (!same(segmentIdentity(first.prefix.header), owned.receipt.segment)) {
    return { kind: "invalid", reason: "receipt after checkpoint belongs to another segment" };
  }
  if (same(segmentIdentity(last.prefix.header), owned.receipt.segment) || last.prefix.length !== 0n ||
      last.prefix.header.sequence !== owned.repair.sequence) return { kind: "not-applicable", reason: "not-opening" };
  const includedAt: PoolReceiptCheckpointFact[] = [], contradictedAt: PoolReceiptCheckpointFact[] = [];
  for (const checkpoint of result.checkpoints.slice(0, -1)) {
    if (!same(segmentIdentity(checkpoint.prefix.header), owned.receipt.segment)) {
      return { kind: "not-applicable", reason: "earlier-transition" };
    }
    const accepted = checkpoint.accepted.find(a => a.position === owned.receipt.position);
    const included = accepted !== undefined && same(accepted.statementHash, owned.receipt.statementHash) && same(accepted.historyHash, owned.receipt.historyHash);
    const fact = { commitment: checkpoint.commitment, at: checkpoint.at };
    if (included) includedAt.push(fact);
    else if (accepted !== undefined || checkpoint.commitment.sequence > owned.receipt.after) contradictedAt.push(fact);
  }
  return { kind: "repair", boundary: { commitment: last.commitment, at: last.at }, witnessedIndex,
    includedAt, contradictedAt, lapsed: includedAt.length === 0 && contradictedAt.length === 0 };
}
