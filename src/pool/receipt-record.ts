// C2.3.4, C2.10.8–9: receipt record facts, kept separate from recovery.
import { bytesToHex } from "@noble/hashes/utils.js";
import { makeBacking } from "../backing.js";
import { compareBytes, copyBytes, EncodingError } from "../bytes.js";
import { decodeCommitment, encodeCommitment, type Commitment } from "../commitment.js";
import { VenueError, type Venue } from "../venue.js";
import { PoolAuthorityView, type PoolTerm } from "./authority.js";
import { readPoolCheckpoint, type PoolCheckpointEvidence, type PoolCheckpointFailure } from "./checkpoint.js";
import { copyPoolReceipt, verifyPoolReceipt, type PoolReceipt } from "./receipt.js";
import { PoolError, type SignedBacking, type StatementVerifier } from "./segment.js";
import { configurationHash, copyConfiguration, copySegmentHeader, segmentAuthority,
  type PoolConfiguration, type SegmentHeader } from "./statement.js";

export type PoolReceiptSequence =
  | { readonly kind: "held"; readonly commitment: Commitment; readonly at: bigint }
  | { readonly kind: "not-reached" }
  | { readonly kind: "moved-past" };

export type PoolReceiptRecordResult =
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "record"; readonly witnessedIndex: bigint; readonly sequence: PoolReceiptSequence;
      readonly terms: readonly PoolTerm[]; readonly scope: "not-started" | "live" | "ended" };

interface ReceiptArguments {
  readonly configuration: PoolConfiguration;
  readonly venue: Venue;
  readonly header: SegmentHeader;
  readonly receipt: PoolReceipt;
}

function same(a: Uint8Array, b: Uint8Array): boolean { return compareBytes(a, b) === 0; }
function requireThat(ok: boolean, message: string): asserts ok {
  if (!ok) throw new PoolError("SEGMENT", message);
}
function invalid(cause: unknown): { kind: "invalid"; reason: string } {
  if (cause instanceof PoolError || cause instanceof EncodingError || cause instanceof TypeError || cause instanceof RangeError) {
    return { kind: "invalid", reason: cause.message };
  }
  throw cause;
}

/** Resolve the receipt's exact signed sequence and complete scope terms.
 *
 * The receipt authenticates the supplied header; signed terms and the venue
 * authenticate its links. `scope` describes those links NOW, not when an
 * undated receipt was signed. `held` only resolves a sequence: it does not
 * prove that commitment carries this segment. These facts are neither final
 * inclusion nor lapse/contradiction verdicts and never authorize tail discard.
 * In particular, final inclusion and historical contradictions must be checked
 * before recovery may excuse an unfinalized tail (C2.10.9).
 * Malformed evidence returns invalid; unavailable/inconsistent venue reads throw.
 */
export function readPoolReceiptRecord(args: ReceiptArguments & { readonly backings: readonly SignedBacking[] }): PoolReceiptRecordResult {
  let stable = (): void => {};
  try {
    const configuration = copyConfiguration(args.configuration), header = copySegmentHeader(args.header);
    const receipt = copyPoolReceipt(args.receipt);
    const backings = args.backings.map(b => ({ backing: makeBacking(b.backing), signature: copyBytes(b.signature) }));
    requireThat(verifyPoolReceipt(segmentAuthority(header), receipt), "invalid receipt for this segment");
    requireThat(same(configurationHash(configuration), header.domain), "wrong receipt configuration");
    requireThat(receipt.after >= header.sequence, "receipt names a sequence before its segment opening");
    const names = new Set(backings.map(b => b.backing.nameHex));
    requireThat(backings.length === header.entries.length && header.entries.every(e => names.has(bytesToHex(e.backing))),
      "receipt scope terms are incomplete");
    const venue = args.venue, now = venue.witnessedIndex(), lag = venue.lag(), venueId = copyBytes(venue.id);
    stable = (): void => {
      if (venue.witnessedIndex() !== now || venue.lag() !== lag || !same(venue.id, venueId)) {
        throw new VenueError("venue view changed while reading receipt record");
      }
    };
    requireThat(same(header.venue, venueId), "wrong receipt venue");
    const view = new PoolAuthorityView(configuration, venue, backings);
    const terms = header.entries.map(e => {
      const term = view.termForLink(e.backing, e.link);
      requireThat(term !== undefined && same(term.operator, header.operator), "unknown or wrong-operator receipt scope link");
      return term;
    });
    const from = terms.reduce((at, t) => t.from > at ? t.from : at, 0n);
    const ends = terms.flatMap(t => t.until === undefined ? [] : [t.until]);
    const until = ends.length === 0 ? undefined : ends.reduce((a, b) => a < b ? a : b);
    requireThat(until === undefined || from < until, "receipt scope terms never overlap");
    // A bounded exact read preserves lower sequences sharing the latest index.
    // The +1 sentinel also works for the largest u64 signed sequence.
    const held = venue.previousFor(receipt.operator, receipt.after + 1n, now);
    const at = venue.witnessedAtSequence(receipt.operator, receipt.after);
    let sequence: PoolReceiptSequence;
    if (held?.sequence === receipt.after) {
      if (typeof at !== "bigint" || at < 0n || at > now) throw new VenueError("inconsistent receipt sequence index");
      sequence = { kind: "held", commitment: decodeCommitment(encodeCommitment(held)), at };
    } else {
      if (at !== undefined) throw new VenueError("inconsistent receipt sequence lookup");
      const latest = venue.latestFor(receipt.operator, now);
      if (latest?.sequence === receipt.after) throw new VenueError("inconsistent receipt sequence lookup");
      sequence = { kind: latest !== undefined && latest.sequence > receipt.after ? "moved-past" : "not-reached" };
    }
    stable();
    return { kind: "record", witnessedIndex: now, sequence, terms,
      scope: until !== undefined && now >= until ? "ended" : now < from ? "not-started" : "live" };
  } catch (cause) {
    stable();
    return invalid(cause);
  }
}

export type PoolReceiptCheckpointResult = PoolCheckpointFailure
  | { readonly kind: "included" | "not-included"; readonly at: bigint; readonly witnessedIndex: bigint };

/** Check receipt inclusion in one exact held checkpoint of ITS OWN segment.
 * Use the source checkpoint when a later segment imports this receipt's event.
 * Replay validates the whole scope, canonical openings and supplied ancestry.
 * Inclusion binds position, statement identity and history hash; re-proving
 * with different valid evidence preserves inclusion (pool-v2 §9).
 *
 * `not-included` only describes this checkpoint: an earlier checkpoint may
 * predate acceptance and another checkpoint may include it. It is never a
 * global pending, lapse or fault verdict. `included` proves C2.10 inclusion,
 * not a holding or recovery-valid value: C2b revocation and silence recovery
 * remain separate, unsupported questions. No current-term or `after` test can
 * erase inclusion, and missing history remains unavailable after replacement.
 */
export async function readPoolReceiptCheckpoint(args: ReceiptArguments & {
  readonly checkpoint: Commitment;
  readonly evidence: readonly PoolCheckpointEvidence[];
  readonly verifier: StatementVerifier;
}): Promise<PoolReceiptCheckpointResult> {
  let header: SegmentHeader, receipt: PoolReceipt;
  try {
    header = copySegmentHeader(args.header);
    receipt = copyPoolReceipt(args.receipt);
    requireThat(verifyPoolReceipt(segmentAuthority(header), receipt), "invalid receipt for this segment");
  } catch (cause) { return invalid(cause); }
  // Leave backend exceptions outside the malformed-input catch, even TypeError.
  const result = await readPoolCheckpoint(args);
  if (result.kind !== "final") return result;
  if (!same(segmentAuthority(result.prefix.header).segment, receipt.segment)) {
    return { kind: "invalid", reason: "checkpoint belongs to another receipt segment" };
  }
  const record = result.accepted.find(a => a.position === receipt.position);
  const included = record !== undefined && same(record.statementHash, receipt.statementHash) && same(record.historyHash, receipt.historyHash);
  return { kind: included ? "included" : "not-included", at: result.at, witnessedIndex: result.witnessedIndex };
}
