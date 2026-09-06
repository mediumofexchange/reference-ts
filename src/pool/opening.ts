// C2.7.3 / C2.10.4–7 / pool-v2 §6: construct a new segment's opening
// from the current record, before any child commitment has been signed.
import { bytesToHex } from "@noble/hashes/utils.js";
import { makeBacking } from "../backing.js";
import { compareBytes, copyBytes, EncodingError } from "../bytes.js";
import { encodeCommitment, verifyCommitment, type Commitment } from "../commitment.js";
import { VenueError, type Venue } from "../venue.js";
import { PoolAuthorityView } from "./authority.js";
import { readPoolCheckpoints, type PoolCheckpointEvidence, type PoolCheckpointFailure } from "./checkpoint.js";
import { readPoolCurrent } from "./descent.js";
import { PoolError, Segment, type SignedBacking, type StatementVerifier } from "./segment.js";
import { configurationHash, copyConfiguration, copySegmentHeader, type PoolConfiguration } from "./statement.js";

export type PoolOpeningResult = PoolCheckpointFailure
  | { readonly kind: "prepared"; readonly segment: Segment; readonly witnessedIndex: bigint };

const SEQUENCE_BOUND = 1n << 64n;
function same(a: Uint8Array, b: Uint8Array): boolean { return compareBytes(a, b) === 0; }
function key(c: Commitment): string { return `${bytesToHex(c.operator)}:${c.sequence}:${bytesToHex(c.root)}`; }
function requireThat(ok: boolean, reason: string): asserts ok {
  if (!ok) throw new PoolError("SEGMENT", reason);
}

/** Prepare the computed opening of a new segment over the supplied scope.
 * Every selected checkpoint is final across its whole scope, and shared
 * ancestry is verified once. The returned Segment has no local statements.
 *
 * highestSignedSequence is an assertion from the operator's durable journal
 * over ALL its segments on this venue, including unsuccessful publications.
 * This reader can reject a counter behind the record; it cannot certify the
 * journal, reserve the next sequence, or prevent a concurrent signer.
 *
 * Preparation is not permission to abandon a live tail, sign or co-sign.
 * C2.10.9 still requires an elective change to witness its live tail and last
 * signed commitment, or public lapse/staleness to authorize discard. Restart
 * alone cannot reset a segment. Durable execution must recheck currency and
 * authority, apply the schedule and one-in-flight rule, and commit the opening
 * before receipts. No signed state or existing segment is changed here.
 *
 * Invalid inputs return invalid, missing evidence returns unavailable, and
 * venue/backend failures propagate. The read refuses changes of venue view
 * or same-index publications during asynchronous proof verification.
 */
export async function preparePoolOpening(args: {
  readonly configuration: PoolConfiguration;
  readonly venue: Venue;
  readonly operator: Uint8Array;
  readonly highestSignedSequence: bigint;
  readonly backings: readonly SignedBacking[];
  readonly evidence: readonly PoolCheckpointEvidence[];
  readonly verifier: StatementVerifier;
}): Promise<PoolOpeningResult> {
  if (typeof args !== "object" || args === null) return { kind: "invalid", reason: "malformed opening arguments" };
  const verifier = args.verifier;
  // Keep the trusted backend's exceptions outside malformed-input handling.
  let validation: ReturnType<typeof readPoolCheckpoints> | undefined;
  let segmentHeader: ReturnType<typeof copySegmentHeader>;
  let configuration: PoolConfiguration;
  let backings: SignedBacking[];
  let witnessedIndex: bigint;
  let stable = (): void => {};
  try {
    configuration = copyConfiguration(args.configuration);
    const operator = copyBytes(args.operator), highest = args.highestSignedSequence;
    requireThat(typeof highest === "bigint" && highest >= 0n && highest < SEQUENCE_BOUND - 1n, "invalid or exhausted signed sequence counter");
    backings = args.backings.map(b => ({ backing: makeBacking(b.backing), signature: copyBytes(b.signature) }));
    const venue = args.venue, venueId = copyBytes(venue.id), now = venue.witnessedIndex(), lag = venue.lag();
    witnessedIndex = now;
    let observed: Commitment | undefined;
    const latest = (): Commitment | undefined => {
      const c = venue.previousFor(operator, SEQUENCE_BOUND, now);
      if (c !== undefined && (!same(c.operator, operator) || !verifyCommitment(c))) throw new VenueError("inconsistent latest operator commitment");
      return c;
    };
    const stableClock = (): void => {
      if (venue.witnessedIndex() !== now || venue.lag() !== lag || !same(venue.id, venueId)) {
        throw new VenueError("venue view changed during opening construction");
      }
    };
    stable = stableClock;
    const authority = new PoolAuthorityView(configuration, venue, backings), scope = authority.scope(operator);
    requireThat(scope !== undefined, "operator does not hold the whole requested scope");
    observed = latest();
    stable = (): void => {
      stableClock();
      const current = latest();
      if (observed === undefined ? current !== undefined : current === undefined || !same(encodeCommitment(observed), encodeCommitment(current))) {
        throw new VenueError("operator record changed during opening construction");
      }
      stableClock();
    };
    requireThat(observed === undefined || highest >= observed.sequence, "signed sequence counter is behind the record");
    const terms = new Map(backings.map(b => [bytesToHex(b.backing.name), b])), checkpoints = new Map<string, Commitment>();
    const entries = [];
    for (const entry of scope) {
      const selected = readPoolCurrent({ configuration, venue, operator, backing: terms.get(bytesToHex(entry.backing))!,
        evidence: args.evidence.map(item => {
          const carries = item.directory.some(d => same(d.name, entry.backing));
          const snapshots = carries ? item.snapshots?.filter(s => same(s.backing, entry.backing)) ?? [] : [];
          requireThat(snapshots.length <= 1, "duplicate snapshot evidence for a backing");
          return { commitment: item.commitment, directory: item.directory, ...(snapshots[0] === undefined ? {} : { snapshot: snapshots[0] }) };
        }) });
      if (selected.kind === "invalid" || selected.kind === "unavailable") { stable(); return selected; }
      const opening = selected.kind === "candidate" ? selected.checkpoint.commitment : undefined;
      if (opening !== undefined) checkpoints.set(key(opening), opening);
      entries.push({ ...entry, ...(opening === undefined ? {} : { opening }) });
    }
    segmentHeader = copySegmentHeader({ domain: configurationHash(configuration), venue: venueId, operator, sequence: highest + 1n, entries });
    stable();
    // This call plans and copies EVERY required history synchronously before
    // the first verifier callback. Separate calls per root cannot do that.
    if (checkpoints.size !== 0) validation = readPoolCheckpoints({ configuration, venue,
      checkpoints: [...checkpoints.values()], evidence: args.evidence, verifier });
  } catch (cause) {
    stable();
    if (cause instanceof PoolError || cause instanceof EncodingError || cause instanceof TypeError || cause instanceof RangeError) {
      return { kind: "invalid", reason: cause.message };
    }
    throw cause;
  }
  const result = validation === undefined ? undefined : await validation;
  stable();
  if (result !== undefined && result.kind !== "final") return result;
  try {
    const segment = new Segment(configuration, segmentHeader, result?.checkpoints.map(c => c.prefix) ?? [], verifier);
    for (const b of backings) segment.register(b.backing, b.signature);
    stable();
    return { kind: "prepared", segment, witnessedIndex };
  } catch (cause) {
    if (cause instanceof PoolError || cause instanceof EncodingError || cause instanceof TypeError || cause instanceof RangeError) {
      return { kind: "invalid", reason: cause.message };
    }
    throw cause;
  }
}
