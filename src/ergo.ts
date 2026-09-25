// Ergo as a witness venue (§C2), read under the selected Ergo venue profile
// (venue-ergo.md).
//
// The chain **witnesses, and adjudicates nothing**. No contract here verifies a
// signature; a record is a box's registers at a location the venue identity
// names, and everything that judges it — held commitments, succession,
// revocation, the silence grade — is done by whoever reads.
//
// **The reader verifies the chain itself; no supplier is trusted.** A node,
// the reader's own included, is a supplier of header bytes and block sections.
// The header store checks every header from the anchor's context (linkage,
// height, timestamp, EIP-37 difficulty, Autolykos work) and names the heaviest
// chain; a section counts only where it reproduces the transaction root of a
// header on that chain. Every output of every transaction of every block from
// the anchor's child to the witnessed index is read, so a record's absence is
// proven by exhaustion, never reported by a source (pool-v3 §13.2). A supplier
// can withhold, which leaves reads unresolved, but cannot make the reader
// accept a header without its work or a section its header did not commit to.
//
// **Reads are a materialised view.** `Venue` is synchronous, so this syncs
// asynchronously and answers synchronously from the last complete snapshot.
// The view keeps only the objects the profile attributes at the four
// locations, by index, and the headers it accepted; a later sync reads the new
// blocks only.
//
// **The witnessed index is the block that included the transaction**, index
// `i` being the block `i + 1` heights above the anchor, never a box's creation
// height, which its builder writes and may set lower: backdating a commitment
// would put it before a redemption leg it actually followed. **Nothing inside
// the finality depth is read at all**, and the depth is part of the venue's
// identity with the anchor and the locations, so naming the venue is agreeing
// the clock (C2.3.2). A block whose section no supplier supplies stops the
// clock at the index before it: a stale view, which every earlier snapshot
// also was, rather than an empty one, which would read as silence. A
// reorganization past the depth is the venue's failure (§13.2): the view then
// refuses every read rather than change its mind about the past.
//
// NOT here, deliberately: publishing. Building and signing a transaction needs
// an Ergo library, and this package's dependencies are @noble/hashes and
// @noble/curves. A verifier never publishes; the operator's wallet does.
import { blake2b } from "@noble/hashes/blake2b.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes, EncodingError } from "./bytes.js";
import type { Commitment } from "./commitment.js";
import { ergoHeaderStore, parseErgoHeader, ANCHOR_CONTEXT, type ErgoHeaderStore } from "./ergo-headers.js";
import {
  attributeSection, ergoProfileIdentity, ownErgoProfile, rangeEntries, type AttributedObject, type ErgoProfile, type ErgoTransactionView,
} from "./ergo-profile.js";
import type { ErgoSupplier } from "./ergo-supplier.js";
import {
  COMMITMENT_RANGE, copyRequest, encodeRangeAnswer, heldCommitments, RangeLimitError, REPLACEMENT_RANGE, REVOCATION_RANGE,
  type HeldCommitment, type RangeAnswer, type RangeLimits, type RangeRequest, type RecordKind,
} from "./record-range.js";
import { copyReplacement, decodeReplacement, forgetAdmitted, type WitnessedReplacement } from "./replacement.js";
import { copyRevocation, decodeRevocation, isSignedRevocation, type WitnessedRevocation } from "./revocation.js";
import { VenueError, type Venue, type WitnessedCommit, type WitnessedOp } from "./venue.js";

/** The reference runtime's finality depth: over one measured mainnet day,
 * 99.8% of included transactions landed inside C3.3's window at depth 10,
 * against 94% at 6 (venue-ergo.md §2). A deployment may choose another. */
export const DEFAULT_ERGO_DEPTH = 10n;

/** A deployment's profile with the reference default depth unless it names one. */
export function ergoProfile(anchor: Uint8Array, scripts: ErgoProfile["scripts"], depth: bigint = DEFAULT_ERGO_DEPTH): ErgoProfile {
  return ownErgoProfile({ anchor, depth, scripts });
}

/**
 * The reader's local budgets (venue-ergo.md §3, pool-v3 §13.1): they bound
 * work and memory, never an answer. A budget that runs out leaves the view
 * where withholding would, and the next sync continues from there.
 */
export interface ErgoReaderPolicy {
  /** Headers whose work one supplier may have checked in one sync. Accepted
   * headers are kept, so a heavier chain longer than this arrives over
   * several syncs: no supplier's budget refuses the heaviest chain, and one
   * supplier's side branches cannot spend another's. */
  readonly headersPerSupplier: number;
  /** Section bytes after which one sync reads no further section; the next continues. */
  readonly sectionBytesPerSync: number;
  /** Bytes of attributed objects the view retains. */
  readonly retainedBytes: number;
}
export const DEFAULT_ERGO_READER_POLICY: ErgoReaderPolicy = Object.freeze({
  headersPerSupplier: 2_000,
  sectionBytesPerSync: 256 * 1024 * 1024,
  retainedBytes: 256 * 1024 * 1024,
});
/** Headers asked of a supplier per request. */
const HEADER_BATCH = 500n;

/** What one sync did, for the operator's logs; the view's reads are the answers. */
export interface ErgoSyncReport {
  /** The view's clock after the sync; undefined while nothing is witnessed. */
  readonly witnessedIndex: bigint | undefined;
  /** The id of the block the clock stands on. */
  readonly witnessedHeaderId: Uint8Array | undefined;
  /** The index the best chain makes final under the depth, sections aside. */
  readonly chainWitnessedIndex: bigint | undefined;
  readonly tipHeight: bigint;
  readonly suppliers: readonly ErgoSupplierReport[];
  readonly sectionsRead: number;
  /** The first index past the clock whose section no supplier supplied within budget. */
  readonly unresolvedIndex: bigint | undefined;
}
export interface ErgoSupplierReport {
  readonly name: string;
  readonly headersAdded: number;
  /** Why this supplier stopped early: a refused header, a failure or its budget. */
  readonly stopped?: string;
}

/** One complete view: the clock, the attributed objects by index through it,
 * and the header at the clock, which later chains must keep. */
interface Snapshot {
  readonly witnessed: bigint;
  readonly sections: readonly (readonly AttributedObject[])[];
  readonly witnessedHeaderId: Uint8Array;
}

/**
 * The anchor's context for a new view: the anchor and the 1,024 headers below
 * it, from one supplier. The header store authenticates them by linkage to
 * the anchor id alone, so any supplier will do.
 */
export async function ergoAnchorContext(supplier: ErgoSupplier, anchorId: Uint8Array, anchorHeight: bigint): Promise<Uint8Array[]> {
  const from = anchorHeight - BigInt(ANCHOR_CONTEXT);
  const context = [...await supplier.headers(from, anchorHeight)];
  const last = context.length === ANCHOR_CONTEXT + 1 ? parseErgoHeader(context[ANCHOR_CONTEXT]!) : undefined;
  if (last === undefined || compareBytes(last.id, anchorId) !== 0) throw new VenueError("the supplier did not supply the anchor's context");
  return context;
}

/**
 * The Ergo chain, read as a venue under the selected profile.
 *
 * Empty until `sync` succeeds, and answering only from the last complete
 * snapshot. Reads refuse while a sync runs, and a failed sync leaves the
 * previous snapshot in place. The id is derived from the profile, never handed
 * in, so one declared venue cannot be read on two clocks.
 */
export class ErgoVenue implements Venue {
  private readonly profile: ErgoProfile;
  private readonly venueId: Uint8Array;
  private readonly store: ErgoHeaderStore;
  private readonly policy: ErgoReaderPolicy;
  /** Attributed objects by index, from index 0, read so far; may run past the clock. */
  private readonly sections: (readonly AttributedObject[])[] = [];
  /** The header ids the sections were read for, by index. */
  private readonly sectionHeaders: Uint8Array[] = [];
  private retained = 0;
  private snapshot: Snapshot | undefined;
  private syncing = false;
  private failure: string | undefined;
  /** Per-snapshot derivations, by kind and subject. */
  private held = new Map<string, readonly HeldCommitment[]>();

  constructor(profile: ErgoProfile, anchorContext: readonly Uint8Array[], policy: ErgoReaderPolicy = DEFAULT_ERGO_READER_POLICY) {
    this.profile = ownErgoProfile(profile);
    this.venueId = ergoProfileIdentity(this.profile);
    const store = ergoHeaderStore(this.profile.anchor, anchorContext);
    if (store === undefined) throw new VenueError("the anchor context does not authenticate the profile's anchor");
    this.store = store;
    const { headersPerSupplier, sectionBytesPerSync, retainedBytes } = policy;
    if (![headersPerSupplier, sectionBytesPerSync, retainedBytes].every(n => Number.isSafeInteger(n) && n > 0)) {
      throw new VenueError("invalid Ergo reader policy");
    }
    this.policy = Object.freeze({ headersPerSupplier, sectionBytesPerSync, retainedBytes });
  }

  get id(): Uint8Array {
    return copyBytes(this.venueId);
  }

  /** The depth plus one (C2.3.5): a constant of the identity, answered unsynced. */
  lag(): bigint {
    return this.profile.depth + 1n;
  }

  /**
   * Take the chain's current word from the suppliers, in the caller's order.
   *
   * Headers first: each supplier is asked from the depth below the best tip
   * (so a fork inside the unfinal zone is seen), stepping back while its chain
   * does not connect, and adds at most its budget of new headers. A supplier
   * that fails or serves a header the store refuses stops for this sync; the
   * headers it supplied before that stay. Then sections, index by index from
   * the first not yet read up to the index the best chain makes final: any
   * supplier's section that reproduces the header's root is read. The new
   * snapshot's clock is the last index whose section, and every one before it,
   * is held. It is published only when complete, with no await in between.
   *
   * Rejects with VenueError on a reorganization past the depth (the venue's
   * failure, after which every read refuses) and on a concurrent sync.
   */
  async sync(suppliers: readonly ErgoSupplier[]): Promise<ErgoSyncReport> {
    if (this.failure !== undefined) throw new VenueError(this.failure);
    if (this.syncing) throw new VenueError("a sync is already in progress");
    this.syncing = true;
    try {
      // The caller's list is read once; each supplier's name once, for its report.
      const sources = Array.from(suppliers, supplier => ({ supplier, name: String(supplier.name) }));
      const reports: ErgoSupplierReport[] = [], unfinished: Uint8Array[] = [];
      for (const source of sources) {
        const { report, last } = await this.syncHeaders(source.supplier, source.name);
        reports.push(report);
        if (last !== undefined) unfinished.push(last);
      }
      const best = this.store.best(), anchorHeight = this.store.tip().anchorHeight, depth = this.profile.depth;
      // The best chain must keep the header at the published clock: its id commits to every block before it.
      const previous = this.snapshot;
      if (previous !== undefined) {
        const kept = best.headers[Number(previous.witnessed)];
        if (kept === undefined || compareBytes(kept.id, previous.witnessedHeaderId) !== 0) {
          this.failure = "venue failure: the best chain left a block witnessed under the depth";
          throw new VenueError(this.failure);
        }
      }
      // Sections read past an earlier clock were read for headers the chain may since have left.
      const clock = previous?.witnessed ?? -1n;
      for (let i = this.sections.length - 1; i > Number(clock); i--) {
        const header = best.headers[i];
        if (header !== undefined && compareBytes(this.sectionHeaders[i]!, header.id) === 0) break;
        this.dropSection(i);
      }
      const chainWitnessed = best.height - depth - anchorHeight - 1n;
      // A supplier stopped before its tip may yet show a heavier chain from any of its headers: the clock stays
      // at or below where its last header meets the best chain, so a budget cannot make the reader witness a block
      // it would later have to unwitness.
      let bound = chainWitnessed;
      for (const id of unfinished) {
        const fork = this.store.forkHeight(id);
        if (fork !== undefined && fork - anchorHeight - 1n < bound) bound = fork - anchorHeight - 1n;
      }
      let spent = 0, sectionsRead = 0, unresolved: bigint | undefined;
      for (let index = BigInt(this.sections.length); index <= bound; index++) {
        // The budget is checked before each section, so one larger than it is still read, alone in its sync.
        if (spent >= this.policy.sectionBytesPerSync) { unresolved = index; break; }
        const header = best.headers[Number(index)]!;
        const read = await this.readSection(sources.map(source => source.supplier), header.id, header.transactionsRoot);
        if (read === undefined) { unresolved = index; break; }
        spent += read.bytes;
        this.sections.push(read.objects);
        this.sectionHeaders.push(copyBytes(header.id));
        sectionsRead++;
      }
      const witnessed = BigInt(this.sections.length) - 1n < bound ? BigInt(this.sections.length) - 1n : bound;
      if (witnessed >= 0n && (previous === undefined || witnessed >= previous.witnessed)) {
        // No await from here: the snapshot and every derivation change together.
        forgetAdmitted(this);
        this.held = new Map();
        this.snapshot = Object.freeze({ witnessed, sections: Object.freeze(this.sections.slice(0, Number(witnessed) + 1)),
          witnessedHeaderId: copyBytes(best.headers[Number(witnessed)]!.id) });
      }
      return Object.freeze({ witnessedIndex: this.snapshot?.witnessed, witnessedHeaderId: this.snapshot === undefined ? undefined : copyBytes(this.snapshot.witnessedHeaderId), chainWitnessedIndex: chainWitnessed >= 0n ? chainWitnessed : undefined,
        tipHeight: best.height, suppliers: Object.freeze(reports), sectionsRead, unresolvedIndex: unresolved });
    } finally {
      this.syncing = false;
    }
  }

  private dropSection(index: number): void {
    for (const object of this.sections[index]!) this.retained -= object.record.length;
    this.sections.length = index;
    this.sectionHeaders.length = index;
  }

  /** One supplier's headers, and the id of the last it supplied where it
   * stopped before its tip (budget or failure): that supplier's chain may
   * still be heavier from there. */
  private async syncHeaders(supplier: ErgoSupplier, name: string): Promise<{ report: ErgoSupplierReport; last?: Uint8Array }> {
    let added = 0, fetched = 0, last: Uint8Array | undefined;
    const done = (stopped?: string): { report: ErgoSupplierReport } =>
      ({ report: Object.freeze(stopped === undefined ? { name, headersAdded: added } : { name, headersAdded: added, stopped }) });
    const unfinished = (stopped: string): { report: ErgoSupplierReport; last?: Uint8Array } =>
      last === undefined ? done(stopped) : { ...done(stopped), last };
    const budget = this.policy.headersPerSupplier, fetchBudget = 4 * budget + 2 * ANCHOR_CONTEXT;
    const anchorHeight = this.store.tip().anchorHeight, depth = this.profile.depth;
    const tip = await supplied(() => supplier.tipHeight());
    if (!tip.ok) return done(tip.failure);
    if (typeof tip.value !== "bigint") return done("no tip height");
    const start = this.store.tip().height - depth;
    let from = start > anchorHeight ? start : anchorHeight + 1n, back = depth + 1n;
    while (from <= tip.value) {
      if (added >= budget) return unfinished("header budget");
      if (fetched >= fetchBudget) return unfinished("fetch budget");
      const to = from + HEADER_BATCH - 1n < tip.value ? from + HEADER_BATCH - 1n : tip.value;
      const answer = await supplied(() => supplier.headers(from, to));
      if (!answer.ok) return unfinished(answer.failure);
      const batch = answer.value;
      if (!Array.isArray(batch) || batch.length === 0) return done();
      let steppedBack = false, position = 0;
      for (const item of batch) {
        if (added >= budget) return unfinished("header budget");
        fetched++;
        // Owned before the store reads it, so the id taken below is of the bytes the store judged.
        const bytes = item instanceof Uint8Array && !(item.buffer instanceof SharedArrayBuffer) ? copyBytes(item) : undefined;
        const outcome = bytes === undefined ? "malformed" : this.store.add(bytes);
        if (outcome === "added" || outcome === "known") {
          if (outcome === "added") added++;
          last = blake2b(bytes!, { dkLen: 32 });
        } else if (outcome === "unknown-parent" && position === 0 && from > anchorHeight + 1n) {
          // The supplier's chain leaves ours below `from`: step back until it connects.
          from = from - back > anchorHeight ? from - back : anchorHeight + 1n;
          back *= 2n;
          steppedBack = true;
          break;
        } else return done(`refused header: ${outcome}`);
        position++;
      }
      if (steppedBack) continue;
      if (BigInt(batch.length) < to - from + 1n) return done();
      from = to + 1n;
    }
    return done();
  }

  /** The first supplier's section that reproduces the root, attributed, or
   * undefined where none does or its objects would exceed the retained bytes. */
  private async readSection(suppliers: readonly ErgoSupplier[], headerId: Uint8Array, root: Uint8Array):
    Promise<{ objects: readonly AttributedObject[]; bytes: number } | undefined> {
    for (const supplier of suppliers) {
      const answer = await supplied(() => supplier.section(copyBytes(headerId)));
      if (!answer.ok || !Array.isArray(answer.value)) continue;
      const section: readonly ErgoTransactionView[] = answer.value;
      let bytes = 0;
      for (const transaction of section) bytes += transaction !== null && typeof transaction === "object" && transaction.unsigned instanceof Uint8Array ? transaction.unsigned.length : 0;
      const objects = attributeSection(this.profile, section, root);
      if (objects === undefined) continue;
      const size = objects.reduce((total, object) => total + object.record.length, 0);
      if (this.retained + size > this.policy.retainedBytes) return undefined;
      this.retained += size;
      return { objects, bytes };
    }
    return undefined;
  }

  // --- Reads ------------------------------------------------------------------

  private requireSnapshot(): Snapshot {
    if (this.failure !== undefined) throw new VenueError(this.failure);
    if (this.syncing || this.snapshot === undefined) throw new VenueError("this view has no settled snapshot");
    return this.snapshot;
  }

  witnessedIndex(): bigint {
    return this.requireSnapshot().witnessed;
  }

  /**
   * pool-v3 §13's answer to one request from this view, or undefined where the
   * request names another venue, reaches past the clock or exceeds `limits`.
   * The answer is the reader's own, computed from the verified sections, so a
   * replay may consume it as its venue-evidence verifier's output (§12.1).
   */
  range(request: RangeRequest, limits: RangeLimits): Uint8Array | undefined {
    const snapshot = this.requireSnapshot();
    let own: RangeRequest;
    try { own = copyRequest(request); } catch (error) {
      if (error instanceof EncodingError) return undefined;
      throw error;
    }
    if (compareBytes(own.venue, this.venueId) !== 0 || own.toIndex > snapshot.witnessed) return undefined;
    const entries = rangeEntries(index => snapshot.sections[Number(index)], own)!;
    try {
      return encodeRangeAnswer({ request: own, entries }, limits);
    } catch (error) {
      if (error instanceof EncodingError || error instanceof RangeLimitError) return undefined;
      throw error;
    }
  }

  /** Every object of one kind and subject through the clock, as §13.3 reads them. */
  private entries(kind: RecordKind, subject: Uint8Array): RangeAnswer {
    const snapshot = this.requireSnapshot();
    if (!(subject instanceof Uint8Array) || subject.length !== 32) throw new EncodingError("a subject is 32 bytes");
    const request = copyRequest({ venue: this.venueId, kind, subject, fromIndex: 0n, toIndex: snapshot.witnessed });
    return { request, entries: rangeEntries(index => snapshot.sections[Number(index)], request)! };
  }

  /** C2.3.3 read index by index (§13.3): the held commitments of one key, rising in sequence as they rise in index. */
  private heldFor(operator: Uint8Array): readonly HeldCommitment[] {
    const key = bytesToHex(operator);
    const cached = this.held.get(key);
    if (cached !== undefined) return cached;
    const held = heldCommitments(this.entries(COMMITMENT_RANGE, operator)).held;
    this.held.set(key, held);
    return held;
  }

  publish(): void {
    throw new VenueError("this venue reads the chain; publishing is the operator's wallet");
  }

  publishOp(): void {
    throw new VenueError("this venue reads the chain; publishing is the operator's wallet");
  }

  publishReplacement(): void {
    throw new VenueError("this venue reads the chain; publishing is the operator's wallet");
  }

  publishRevocation(): void {
    throw new VenueError("this venue reads the chain; publishing is the backer's wallet");
  }

  publishCommit(): void {
    throw new VenueError("this venue reads the chain; publishing is the holder's wallet");
  }

  /**
   * The profile carries no transparent operation record, and this refuses
   * rather than answering empty: no operations reads as nothing published.
   */
  publishedOpsFor(): WitnessedOp[] {
    throw new VenueError("this venue carries no transparent operation records");
  }

  /**
   * Nor commits (pool-v3 §13.1 names them outside the frame): no commits reads
   * as "the attempt did not commit", which frees a reservation that may have
   * settled elsewhere.
   */
  commitsFor(): WitnessedCommit[] {
    throw new VenueError("this venue carries no commit records");
  }

  /** Every revocation object K published here that decodes, names K and verifies, in witnessed order. */
  revocationsFor(obligor: Uint8Array): WitnessedRevocation[] {
    const out: WitnessedRevocation[] = [];
    for (const entry of this.entries(REVOCATION_RANGE, obligor).entries) {
      try {
        const revocation = decodeRevocation(entry.record);
        if (compareBytes(revocation.obligor, obligor) !== 0 || !isSignedRevocation(revocation)) continue;
        out.push({ revocation: copyRevocation(revocation), at: entry.index });
      } catch (error) {
        if (error instanceof EncodingError) continue;
        throw error;
      }
    }
    return out;
  }

  /**
   * Every replacement object filed under the backing that decodes and names
   * it, in witnessed order, as copies. Signatures, the lead floor and the walk
   * are the reader's (`successionOf`).
   */
  replacementsFor(backingName: Uint8Array): WitnessedReplacement[] {
    const out: WitnessedReplacement[] = [];
    for (const entry of this.entries(REPLACEMENT_RANGE, backingName).entries) {
      try {
        const decoded = decodeReplacement(entry.record);
        if (compareBytes(decoded.backingName, backingName) !== 0) continue;
        out.push({ replacement: copyReplacement(decoded.replacement), at: entry.index });
      } catch (error) {
        if (error instanceof EncodingError) continue;
        throw error;
      }
    }
    return out;
  }

  latestFor(operator: Uint8Array, asOf?: bigint): Commitment | undefined {
    return copyCommitment(this.latestHeld(operator, asOf)?.commitment);
  }

  previousFor(operator: Uint8Array, beforeSequence: bigint, asOf?: bigint): Commitment | undefined {
    return copyCommitment(this.latestHeld(operator, asOf, beforeSequence)?.commitment);
  }

  witnessedAtFor(operator: Uint8Array, asOf?: bigint): bigint | undefined {
    return this.latestHeld(operator, asOf)?.index;
  }

  witnessedAtSequence(operator: Uint8Array, sequence: bigint): bigint | undefined {
    const held = this.latestHeld(operator, undefined, sequence + 1n);
    return held?.commitment.sequence === sequence ? held.index : undefined;
  }

  firstCommitmentFor(operator: Uint8Array, notBefore = 0n): bigint | undefined {
    for (const held of this.heldFor(operator)) if (held.index >= notBefore) return held.index;
    return undefined;
  }

  nextSequenceFor(operator: Uint8Array): bigint {
    const latest = this.latestHeld(operator);
    return latest === undefined ? 0n : latest.commitment.sequence + 1n;
  }

  /** The last held commitment witnessed at or before `asOf` with a sequence
   * below `beforeSequence`; held commitments rise in both, so one search. */
  private latestHeld(operator: Uint8Array, asOf?: bigint, beforeSequence?: bigint): HeldCommitment | undefined {
    const log = this.heldFor(operator), limit = asOf ?? this.requireSnapshot().witnessed;
    let low = 0, high = log.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      const held = log[mid]!;
      if (held.index <= limit && (beforeSequence === undefined || held.commitment.sequence < beforeSequence)) low = mid + 1;
      else high = mid;
    }
    return log[low - 1];
  }
}

/** A supplier's answer, or its failure: a supplier that throws or rejects is
 * one that did not supply. Only supplier calls are wrapped, so the reader's
 * own failures stay visible. */
async function supplied<T>(call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; failure: string }> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, failure: `failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function copyCommitment(value: Commitment | undefined): Commitment | undefined {
  return value === undefined ? undefined : {
    sequence: value.sequence, root: copyBytes(value.root), operator: copyBytes(value.operator), signature: copyBytes(value.signature),
  };
}
