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
// **Publishing is a separate wallet the view hands records to**
// (`ergo-publisher.ts`): it builds, signs and broadcasts one transaction per
// record, and nothing it says reaches a read. A record the view publishes is
// held only once a later sync reads it from a verified block, like anyone
// else's; a view built without a publisher only reads.
import { blake2b } from "@noble/hashes/blake2b.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes, EncodingError } from "./bytes.js";
import { encodeCommitment, verifyCommitment, type Commitment } from "./commitment.js";
import { ergoHeaderStore, parseErgoHeader, ANCHOR_CONTEXT, type ErgoHeaderStore } from "./ergo-headers.js";
import {
  attributeSection, ergoProfileIdentity, ownErgoProfile, rangeEntries, type AttributedObject, type ErgoProfile, type ErgoTransactionView,
} from "./ergo-profile.js";
import type { ErgoPublisher, ErgoRecordRequest } from "./ergo-publisher.js";
import type { ErgoSupplier } from "./ergo-supplier.js";
import {
  COMMITMENT_RANGE, copyRequest, encodeRangeAnswer, heldCommitments, RangeLimitError, REPLACEMENT_RANGE, REVOCATION_RANGE,
  type HeldCommitment, type RangeAnswer, type RangeLimits, type RangeRequest, type RecordKind,
} from "./record-range.js";
import { copyReplacement, decodeReplacement, encodeReplacement, forgetAdmitted, type Replacement, type WitnessedReplacement } from "./replacement.js";
import { copyRevocation, decodeRevocation, encodeRevocation, isSignedRevocation, type Revocation, type WitnessedRevocation } from "./revocation.js";
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
  /** New headers whose work one supplier may have checked in one sync.
   * Accepted headers are kept, so a heavier chain longer than this arrives
   * over several syncs, and one supplier's side branches cannot spend
   * another's budget. */
  readonly headersPerSupplier: number;
  /** Headers asked of a supplier per request; a longer answer is cut to it. */
  readonly headersPerRequest: number;
  /** New headers one supplier may add, over the view's life, that are off
   * the best chain at the end of the sync that added them. Past it the
   * supplier's headers are not read and it no longer holds the clock back:
   * it is withholding. It is kept per supplier object, so a caller reuses
   * its supplier objects across syncs. This bounds the
   * work and memory a cheap side branch can cost (venue-ergo.md §3: without
   * the node's clock rule, future timestamps lower a side branch's
   * difficulty). */
  readonly sideHeadersPerSupplier: number;
  /** Section bytes received, matching or not, after which one sync reads no
   * further section; the next sync continues. */
  readonly sectionBytesPerSync: number;
  /** Bytes the retained objects may take (each record, its subject and a
   * fixed overhead); past it the clock stops until the budget is raised. */
  readonly retainedBytes: number;
  /** A supplier call not settled in this many milliseconds did not supply. */
  readonly supplierTimeoutMs: number;
}
export const DEFAULT_ERGO_READER_POLICY: ErgoReaderPolicy = Object.freeze({
  headersPerSupplier: 2_000,
  headersPerRequest: 500,
  sideHeadersPerSupplier: 20_000,
  sectionBytesPerSync: 256 * 1024 * 1024,
  retainedBytes: 256 * 1024 * 1024,
  supplierTimeoutMs: 60_000,
});
/** What a retained object costs beside its record and subject. */
const OBJECT_OVERHEAD = 64;

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
  /** The first index past the clock not read in this sync, and why. */
  readonly unresolvedIndex: bigint | undefined;
  readonly unresolvedReason?: "no section" | "section budget" | "retained budget";
}
export interface ErgoSupplierReport {
  readonly name: string;
  readonly headersAdded: number;
  /** Why this supplier stopped early: a refused header, a failure or a budget. */
  readonly stopped?: string;
}

/** One complete view: the clock, the attributed objects by index through it,
 * and the header at the clock, which later chains must keep. */
interface Snapshot {
  readonly witnessed: bigint;
  readonly sections: readonly (readonly AttributedObject[])[];
  readonly witnessedHeaderId: Uint8Array;
}
/** A supplier's header pass: its report, the ids of the headers it added,
 * and, where the header budget stopped it before its tip, its last header. */
interface HeaderPass {
  readonly report: ErgoSupplierReport;
  readonly added: readonly Uint8Array[];
  readonly last?: Uint8Array;
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
 * Empty until a sync publishes a snapshot, and answering only from the last
 * complete one; a sync that runs or fails leaves the previous snapshot in
 * place. The id is derived from the profile, never handed in, so one declared
 * venue cannot be read on two clocks.
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
  /** Headers each supplier added while its chain ended off the best chain. */
  private readonly sideHeaders = new WeakMap<object, number>();
  private snapshot: Snapshot | undefined;
  private syncing = false;
  private failure: string | undefined;
  /** Per-snapshot derivations, by kind and subject. */
  private held = new Map<string, readonly HeldCommitment[]>();

  /** Where this view's own records go out; a view without one only reads. */
  private readonly publisher: ErgoPublisher | undefined;

  constructor(profile: ErgoProfile, anchorContext: readonly Uint8Array[], policy: Partial<ErgoReaderPolicy> = {}, publisher?: ErgoPublisher) {
    this.publisher = publisher;
    this.profile = ownErgoProfile(profile);
    this.venueId = ergoProfileIdentity(this.profile);
    const store = ergoHeaderStore(this.profile.anchor, anchorContext);
    if (store === undefined) throw new VenueError("the anchor context does not authenticate the profile's anchor");
    this.store = store;
    const owned = { ...DEFAULT_ERGO_READER_POLICY, ...policy };
    if (!Object.values(owned).every(n => Number.isSafeInteger(n) && n > 0)) throw new VenueError("invalid Ergo reader policy");
    this.policy = Object.freeze(owned);
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
   * Headers first: each supplier is asked from the depth below the lower of
   * the best tip and its own (so a fork inside the unfinal zone, or a heavier
   * shorter chain, is seen), stepping back while its chain does not connect,
   * and adds at most its budget of new headers. A supplier that fails, times
   * out or serves a header the store refuses stops for this sync; the headers
   * it supplied before that stay. Then sections, index by index from the
   * first not yet read up to the index the clock may reach: any supplier's
   * section that reproduces the header's root is read, and a supplier that
   * misses one is not asked again in this sync. The new snapshot is published
   * only when complete, with no await in between; reads meanwhile answer from
   * the previous one.
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
      const sources = Array.from(suppliers, supplier => ({ supplier, name: nameOf(supplier) }));
      const passes: { supplier: ErgoSupplier; pass: HeaderPass }[] = [];
      for (const source of sources) passes.push({ supplier: source.supplier, pass: await this.syncHeaders(source.supplier, source.name) });
      const best = this.store.best(), anchorHeight = this.store.tip().anchorHeight, depth = this.profile.depth;
      // Each supplier is charged, whatever ended its pass, exactly the headers it added that are not on the best
      // chain: a supplier whose chain keeps ending off it spends its side-branch quota and is then withholding, and a
      // branch that briefly leads charges an honest supplier only its headers past the fork.
      let lowest: bigint | undefined;
      for (const { pass } of passes) for (const id of pass.added) {
        const height = this.store.heightOf(id);
        if (height !== undefined && (lowest === undefined || height < lowest)) lowest = height;
      }
      const onBest = new Set<string>();
      if (lowest !== undefined) for (let i = Number(lowest - anchorHeight - 1n); i < best.headers.length; i++) onBest.add(bytesToHex(best.headers[i]!.id));
      for (const { supplier, pass } of passes) {
        const off = pass.added.filter(id => !onBest.has(bytesToHex(id))).length;
        if (off > 0) this.sideHeaders.set(supplier, (this.sideHeaders.get(supplier) ?? 0) + off);
      }
      // The best chain must keep the header at the published clock: its id commits to every block before it.
      const previous = this.snapshot, clock = previous?.witnessed ?? -1n;
      if (previous !== undefined) {
        const kept = best.headers[Number(previous.witnessed)];
        if (kept === undefined || compareBytes(kept.id, previous.witnessedHeaderId) !== 0) {
          this.failure = "venue failure: the best chain left a block witnessed under the depth";
          throw new VenueError(this.failure);
        }
      }
      // Sections read past an earlier clock were read for headers the chain may since have left.
      for (let i = this.sections.length - 1; i > Number(clock); i--) {
        const header = best.headers[i];
        if (header !== undefined && compareBytes(this.sectionHeaders[i]!, header.id) === 0) break;
        this.dropSection(i);
      }
      const chainWitnessed = best.height - depth - anchorHeight - 1n;
      let bound = chainWitnessed;
      for (const { supplier, pass: { last } } of passes) {
        if (last === undefined) continue;
        // A supplier the header budget stopped before its tip may yet show a heavier chain from its last header, so
        // the clock stays at or below where that header meets the best chain: the reader's own budget cannot make it
        // witness a block it would later have to unwitness. A fork below the published clock bounds nothing,
        // since such a chain, were it heavier, fails the venue either way; and a supplier past its side-branch quota
        // is withholding. Only this stop bounds the clock: it takes a budget of headers with their work, while
        // failing costs a supplier nothing.
        const header = parseErgoHeader(last), fork = header === undefined ? undefined : this.store.forkHeight(header.id), height = header?.height;
        if (fork === undefined || height === undefined) continue;
        if ((this.sideHeaders.get(supplier) ?? 0) >= this.policy.sideHeadersPerSupplier) continue;
        const forkIndex = fork - anchorHeight - 1n;
        if (forkIndex >= clock && forkIndex < bound) bound = forkIndex;
      }
      const missed = new Set<ErgoSupplier>();
      let spent = 0, sectionsRead = 0, unresolved: bigint | undefined, reason: ErgoSyncReport["unresolvedReason"];
      for (let index = BigInt(this.sections.length); index <= bound; index++) {
        // Checked before each section, so one larger than the budget is still read, alone in its sync.
        if (spent >= this.policy.sectionBytesPerSync) { unresolved = index; reason = "section budget"; break; }
        const header = best.headers[Number(index)]!;
        const read = await this.readSection(sources.map(source => source.supplier).filter(s => !missed.has(s)), missed,
          header.id, header.transactionsRoot);
        spent += read.bytes;
        if (read.objects === undefined) { unresolved = index; reason = read.retainedStop ? "retained budget" : "no section"; break; }
        this.sections.push(read.objects);
        this.sectionHeaders.push(copyBytes(header.id));
        sectionsRead++;
      }
      const witnessed = BigInt(this.sections.length) - 1n < bound ? BigInt(this.sections.length) - 1n : bound;
      if (witnessed >= 0n && witnessed >= clock) {
        // No await from here: the snapshot and every derivation change together.
        forgetAdmitted(this);
        this.held = new Map();
        this.snapshot = Object.freeze({ witnessed, sections: Object.freeze(this.sections.slice(0, Number(witnessed) + 1)),
          witnessedHeaderId: copyBytes(best.headers[Number(witnessed)]!.id) });
      }
      const snapshot = this.snapshot;
      // The publisher forgets what this view now holds; its supplier calls never fail the sync.
      if (this.publisher !== undefined && snapshot !== undefined) await this.publisher.settle(request => this.holds(request));
      return Object.freeze({
        witnessedIndex: snapshot?.witnessed, witnessedHeaderId: snapshot === undefined ? undefined : copyBytes(snapshot.witnessedHeaderId),
        chainWitnessedIndex: chainWitnessed >= 0n ? chainWitnessed : undefined, tipHeight: best.height, suppliers: Object.freeze(passes.map(({ pass }) => pass.report)),
        sectionsRead, unresolvedIndex: unresolved, ...(reason === undefined ? {} : { unresolvedReason: reason }),
      });
    } finally {
      this.syncing = false;
    }
  }

  private dropSection(index: number): void {
    for (const object of this.sections[index]!) this.retained -= retainedSize(object);
    this.sections.length = index;
    this.sectionHeaders.length = index;
  }

  private async syncHeaders(supplier: ErgoSupplier, name: string): Promise<HeaderPass> {
    let added = 0, fetched = 0, last: Uint8Array | undefined;
    const ids: Uint8Array[] = [];
    const done = (stopped?: string): HeaderPass => ({ added: ids,
      report: Object.freeze(stopped === undefined ? { name, headersAdded: added } : { name, headersAdded: added, stopped }) });
    const unfinished = (): HeaderPass => last === undefined ? done("header budget") : { ...done("header budget"), last };
    const { headersPerSupplier: budget, sideHeadersPerSupplier: sideQuota, supplierTimeoutMs: timeout } = this.policy;
    if ((this.sideHeaders.get(supplier) ?? 0) >= sideQuota) return done("side-branch quota");
    const fetchBudget = 4 * budget + 2 * ANCHOR_CONTEXT, perRequest = BigInt(this.policy.headersPerRequest);
    const anchorHeight = this.store.tip().anchorHeight, depth = this.profile.depth;
    const tip = await supplied(() => supplier.tipHeight(), timeout);
    if (!tip.ok) return done(tip.failure);
    if (typeof tip.value !== "bigint") return done("no tip height");
    const ours = this.store.tip().height, start = (tip.value < ours ? tip.value : ours) - depth;
    let from = start > anchorHeight ? start : anchorHeight + 1n, back = depth + 1n;
    while (from <= tip.value) {
      if (added >= budget) return unfinished();
      if (fetched >= fetchBudget) return done("fetch budget");
      const to = from + perRequest - 1n < tip.value ? from + perRequest - 1n : tip.value, asked = Number(to - from + 1n);
      const answer = await supplied(() => supplier.headers(from, to), timeout);
      if (!answer.ok) return done(answer.failure);
      // The answer is cut to what was asked and owned before any header is judged.
      const batch = ownHeaders(answer.value, asked);
      if (batch === undefined) return done("malformed answer");
      if (batch.length === 0) return done();
      let steppedBack = false, position = 0;
      for (const bytes of batch) {
        if (added >= budget) return unfinished();
        fetched++;
        const outcome = bytes === undefined ? "malformed" : this.store.add(bytes);
        if (outcome === "added" || outcome === "known") {
          if (outcome === "added") { added++; ids.push(blake2b(bytes!, { dkLen: 32 })); }
          last = bytes!;
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
      if (batch.length < asked) return done();
      from = to + 1n;
    }
    return done();
  }

  /** The first supplier's section that reproduces the root, attributed, and
   * the bytes received from every supplier asked; no objects where none does
   * or they would exceed the retained bytes. A supplier that does not supply
   * joins `missed`. */
  private async readSection(suppliers: readonly ErgoSupplier[], missed: Set<ErgoSupplier>, headerId: Uint8Array, root: Uint8Array):
    Promise<{ objects?: readonly AttributedObject[]; bytes: number; retainedStop?: boolean }> {
    let bytes = 0;
    for (const supplier of suppliers) {
      const answer = await supplied(() => supplier.section(copyBytes(headerId)), this.policy.supplierTimeoutMs);
      const owned = answer.ok ? ownSection(answer.value) : { bytes: 0 };
      bytes += owned.bytes;
      const objects = owned.views === undefined ? undefined : attributeSection(this.profile, owned.views, root);
      if (objects === undefined) { missed.add(supplier); continue; }
      const size = objects.reduce((total, object) => total + retainedSize(object), 0);
      if (this.retained + size > this.policy.retainedBytes) return { bytes, retainedStop: true };
      this.retained += size;
      return { objects, bytes };
    }
    return { bytes };
  }

  // --- Reads ------------------------------------------------------------------

  private requireSnapshot(): Snapshot {
    if (this.failure !== undefined) throw new VenueError(this.failure);
    if (this.snapshot === undefined) throw new VenueError("this view has no settled snapshot");
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

  /** Publish a signed commitment through the view's publisher (kind 1, filed
   * under its operator). A refusal throws at once; the returned promise
   * settles when a supplier accepted the transaction, and a caller awaits it,
   * as `PoolStore.publish` does. */
  publish(commitment: Commitment): Promise<void> {
    if (!verifyCommitment(commitment)) throw new VenueError("commitment signature invalid");
    return this.publishRecord(COMMITMENT_RANGE, commitment.operator, encodeCommitment(commitment));
  }

  publishOp(): void {
    throw new VenueError("this venue carries no transparent operation records");
  }

  /** Publish a replacement record (kind 2, filed under its backing). Whether it
   * is signed and in force is the walk's question, as on every venue. */
  publishReplacement(backingName: Uint8Array, replacement: Replacement): Promise<void> {
    let record: Uint8Array;
    try {
      record = encodeReplacement(backingName, replacement);
    } catch (cause) {
      throw new VenueError(`published replacement does not encode: ${String(cause)}`);
    }
    return this.publishRecord(REPLACEMENT_RANGE, backingName, record);
  }

  /** Publish a revocation signed by the key it revokes (kind 3, filed under that key). */
  publishRevocation(revocation: Revocation): Promise<void> {
    if (!isSignedRevocation(revocation)) throw new VenueError("revocation is not signed by the key it revokes");
    return this.publishRecord(REVOCATION_RANGE, revocation.obligor, encodeRevocation(revocation));
  }

  /**
   * One record at its kind's location, through the view's publisher, with
   * every output created at the tip of the chain this view verified: at most
   * the height of the block that will include it, which the network requires,
   * and never a supplier's word. Resolves when a supplier accepted the
   * transaction; the record counts once a later sync reads it.
   */
  private publishRecord(kind: 1 | 2 | 3, subject: Uint8Array, record: Uint8Array): Promise<void> {
    if (this.publisher === undefined) throw new VenueError("this view has no publisher; publishing is the operator's wallet");
    this.requireSnapshot();
    return this.publisher.publish({ location: this.profile.scripts[kind], subject, record, height: this.store.tip().height }).then(() => {});
  }

  /** Whether the snapshot holds this exact record at its location under its subject. */
  private holds(request: ErgoRecordRequest): boolean {
    const kind = ([1, 2, 3] as const).find(k => compareBytes(this.profile.scripts[k], request.location) === 0);
    return kind !== undefined && this.entries(kind, request.subject).entries.some(entry => compareBytes(entry.record, request.record) === 0);
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
    // The venue holds a sequence only above zero (pool-v3 §13.3; pool sequences count from one).
    return latest === undefined ? 1n : latest.commitment.sequence + 1n;
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

/** A supplier's answer, or its failure: a supplier that throws, rejects or
 * does not settle within `timeoutMs` is one that did not supply. Only
 * supplier calls and the reading of their answers are guarded, so the
 * reader's own failures stay visible. */
async function supplied<T>(call: () => Promise<T>, timeoutMs: number): Promise<{ ok: true; value: T } | { ok: false; failure: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), timeoutMs); });
  try {
    return { ok: true, value: await Promise.race([Promise.resolve().then(call), late]) };
  } catch (error) {
    return { ok: false, failure: `failed: ${describe(error)}` };
  } finally {
    clearTimeout(timer);
  }
}
/** An error's message, whatever a supplier threw. */
function describe(error: unknown): string {
  try { return error instanceof Error ? String(error.message) : String(error); } catch { return "an unreadable error"; }
}
function nameOf(supplier: ErgoSupplier): string {
  try { return String(supplier.name); } catch { return "unnamed supplier"; }
}
const isRealBytes = (value: unknown): value is Uint8Array =>
  ArrayBuffer.isView(value) && value instanceof Uint8Array && !(value.buffer instanceof SharedArrayBuffer);
/** At most `limit` header byte strings of a supplier's answer, each owned
 * (undefined where it is not bytes); undefined for an answer that is not a
 * list or throws while read. */
function ownHeaders(answer: unknown, limit: number): (Uint8Array | undefined)[] | undefined {
  try {
    if (!Array.isArray(answer)) return undefined;
    const out: (Uint8Array | undefined)[] = [];
    for (let i = 0; i < answer.length && i < limit; i++) {
      const item: unknown = answer[i];
      out.push(isRealBytes(item) ? copyBytes(item) : undefined);
    }
    return out;
  } catch {
    return undefined;
  }
}
/** A supplier's section as owned views, and the bytes received, which are
 * charged whether or not the section is the header's; no views for an answer
 * that is not a list of transaction views or throws while read. */
function ownSection(answer: unknown): { views?: ErgoTransactionView[]; bytes: number } {
  let bytes = 0;
  try {
    if (!Array.isArray(answer)) return { bytes };
    const views: ErgoTransactionView[] = [];
    for (const transaction of answer as unknown[]) {
      if (transaction === null || typeof transaction !== "object") return { bytes };
      const { unsigned, witnessId } = transaction as Record<string, unknown>;
      if (!isRealBytes(unsigned) || !isRealBytes(witnessId)) return { bytes };
      const view = { unsigned: copyBytes(unsigned), witnessId: copyBytes(witnessId) };
      bytes += view.unsigned.length + view.witnessId.length;
      views.push(view);
    }
    return { views, bytes };
  } catch {
    return { bytes };
  }
}
/** What one retained object costs: its record, its subject and a fixed overhead. */
const retainedSize = (object: AttributedObject): number => object.record.length + object.subject.length + OBJECT_OVERHEAD;

function copyCommitment(value: Commitment | undefined): Commitment | undefined {
  return value === undefined ? undefined : {
    sequence: value.sequence, root: copyBytes(value.root), operator: copyBytes(value.operator), signature: copyBytes(value.signature),
  };
}
