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
// height, timestamp, context-selected difficulty, Autolykos work) and names the heaviest
// chain; a section counts only where it reproduces the transaction root of a
// header on that chain. Every output of every transaction of every block from
// the anchor's child to the witnessed index is read, so a record's absence is
// proven by exhaustion, never reported by a source (pool-v3 §13.2). A supplier
// can withhold, which leaves reads unresolved, but cannot make the reader
// accept a header without its work or a section its header did not commit to.
//
// **Reads are a materialised view.** `RecordVenue` is synchronous, so this syncs
// asynchronously and answers synchronously from the last complete snapshot.
// The view keeps its accepted headers, the best chain by height, each read
// block's raw section and the objects attributed at the four locations in
// SQLite rows (`ergo-store.ts`): in its journal's file, or in a private
// in-memory database for a view without one. Memory holds the anchor's context
// and one sync's reads, not the chain. A later sync reads the new blocks only,
// and a reopened view resumes from its rows without re-checking their work.
//
// **The witnessed index is the block that included the transaction**, index
// `i` being the block `i + 1` heights above the anchor, never a box's creation
// height, which its builder writes and may set lower: backdating a commitment
// would put it before a redemption leg it actually followed. **Nothing inside
// the finality depth is read at all**, and the depth is part of the venue's
// identity with the anchor and the locations, so naming the venue is agreeing
// the clock (C2.3.2). A block whose section no supplier supplies stops the
// clock at the index before it: a stale view, which every earlier snapshot
// also was, rather than an empty one, which would read as silence. The clock
// never moves back: a heavier chain that keeps the block it stands on leaves
// it there, however short that chain is (venue-ergo §2). A reorganization
// past the depth, one that leaves that block, is the venue's failure (§13.2):
// the view then refuses every read rather than change its mind about the past.
//
// **Publishing is a separate wallet the view hands records to**
// (`ergo-publisher.ts`): it builds, signs and broadcasts one transaction per
// record, and nothing it says reaches a read. A record the view publishes is
// held only once a later sync reads it from a verified block, like anyone
// else's; a view built without a publisher only reads.
import { blake2b } from "@noble/hashes/blake2b.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { arrayLength, byteLength, compareBytes, copyBytes, copyUnshared, EncodingError } from "./bytes.js";
import { decodeCompactBits, ergoHeaderStore, parseErgoHeader, ANCHOR_CONTEXT, INITIAL_DIFFICULTY, type ErgoHeaderRows, type ErgoHeaderStore } from "./ergo-headers.js";
import {
  attributeSection, ERGO_SYNTHETIC_REFERENCE, ERGO_TESTNET_REFERENCE, ergoProfileIdentity, orderedEntries, ownErgoProfile, type AttributedObject, type ErgoProfile, type ErgoTransactionView,
} from "./ergo-profile.js";
import type { ErgoPublication, ErgoPublisher, ErgoRecordRequest } from "./ergo-publisher.js";
import type { ErgoSupplier } from "./ergo-supplier.js";
import { ErgoVenueJournal, objectKey, type ErgoSectionRow, type ErgoViewState } from "./ergo-store.js";
import {
  copyLimits, copyRequest, encodeRangeAnswer, MAX_RANGE_RECORD_BYTES, type RangeLimits, type RangeRequest, type RecordKind,
} from "./record-range.js";
import type { RecordPublisher, RecordVenue } from "./record-venue.js";
import { VenueError } from "./venue-error.js";

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
  /** New headers one supplier may have outstanding that were off the best
   * chain at the end of the sync that added them; each is forgiven once the
   * best chain has advanced `SIDE_HEADER_HEIGHTS` (16) heights for it, so
   * honest reorganization traffic, far rarer than one header in 16 blocks,
   * never spends it. Past it the supplier's headers are not read and it no
   * longer holds the clock back: it is withholding until the chain forgives
   * enough. It is kept per supplier name, with the view's rows, so it
   * outlives the process and suppliers need distinct names. This bounds the
   * work and storage a cheap side branch can cost (venue-ergo.md §3: without
   * the node's clock rule, future timestamps lower a side branch's difficulty)
   * to this many headers, plus one sync's `headersPerSupplier`, plus one per
   * 16 heights of best-chain advance, per supplier name. */
  readonly sideHeadersPerSupplier: number;
  /** Section bytes received, matching or not, after which one sync reads no
   * further section; the next sync continues. */
  readonly sectionBytesPerSync: number;
  /** Bytes the retained objects may take in the view's rows (each record, its
   * subject and a fixed overhead); past it the clock stops until the budget is
   * raised. */
  readonly retainedBytes: number;
  /** A supplier call not settled in this many milliseconds did not supply. */
  readonly supplierTimeoutMs: number;
}
export const DEFAULT_ERGO_READER_POLICY: ErgoReaderPolicy = Object.freeze({
  headersPerSupplier: 2_000,
  headersPerRequest: 500,
  sideHeadersPerSupplier: 20_000,
  sectionBytesPerSync: 32 * 1024 * 1024,
  retainedBytes: 8 * 1024 * 1024 * 1024,
  supplierTimeoutMs: 60_000,
});
/** Heights of best-chain advance that forgive one header charged to a supplier's side-branch quota. */
const SIDE_HEADER_HEIGHTS = 16n;
/** What a retained object costs beside its record and subject. */
const OBJECT_OVERHEAD = 64;
/** The longest timer the runtime keeps: a longer one fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** The anchor's 1,025 headers come once per venue, possibly over several of a supplier's requests. */
const ANCHOR_CONTEXT_TIMEOUT_MS = 5 * 60_000;
/** The most transactions and bytes one section answer is read for, far above any block the network admits. */
const MAX_SECTION_TRANSACTIONS = 1 << 20, MAX_SECTION_BYTES = 64 * 1024 * 1024;

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

/** One complete view: the clock and the header at it, which later chains must
 * keep. Its objects are the rows through the clock. */
interface Snapshot {
  readonly witnessed: bigint;
  readonly witnessedHeaderId: Uint8Array;
}
/** A supplier's header pass: its report, the ids of the headers it added,
 * and, where the header budget stopped it before its tip, its last header. */
interface HeaderPass {
  readonly report: ErgoSupplierReport;
  readonly added: readonly Uint8Array[];
  readonly last?: Uint8Array;
  readonly protect?: Uint8Array;
}

/**
 * The anchor's context for a new view: the anchor and the 1,024 headers below
 * it, from one supplier. The header store authenticates them by linkage to
 * the anchor id alone, so any supplier will do.
 */
export async function ergoAnchorContext(supplier: ErgoSupplier, anchorId: Uint8Array, anchorHeight: bigint,
  timeoutMs = ANCHOR_CONTEXT_TIMEOUT_MS): Promise<Uint8Array[]> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw new TypeError("invalid anchor context timeout");
  const from = anchorHeight - BigInt(ANCHOR_CONTEXT);
  const answer = await supplied(() => supplier.headers(from, anchorHeight), timeoutMs);
  const context = answer.ok ? ownHeaders(answer.value, ANCHOR_CONTEXT + 1) : undefined;
  const last = context?.length === ANCHOR_CONTEXT + 1 && context.every(bytes => bytes !== undefined) ? parseErgoHeader(context[ANCHOR_CONTEXT]!) : undefined;
  if (last === undefined || compareBytes(last.id, anchorId) !== 0) throw new VenueError("the supplier did not supply the anchor's context");
  return context as Uint8Array[];
}

/**
 * The Ergo chain, read as a venue under the selected profile.
 *
 * Empty until a sync publishes a snapshot, and answering only from the last
 * complete one; a sync that runs or fails leaves the previous snapshot in
 * place. The id is derived from the profile, never handed in, so one declared
 * venue cannot be read on two clocks.
 */
export class ErgoVenue implements RecordVenue, RecordPublisher {
  private readonly profile: ErgoProfile;
  private readonly venueId: Uint8Array;
  private readonly store: ErgoHeaderStore;
  private readonly policy: ErgoReaderPolicy;
  /** The rows: headers, sections through the clock and their objects. A sync reads no further than the clock it
   * publishes, and writes what it read in its one commit. */
  private readonly journal: ErgoVenueJournal;
  /** Whether the rows outlive this instance, in a journal the caller handed in. */
  private readonly durable: boolean;
  /** The header each supplier's last pass reached, by supplier name, kept through pruning until it is on the best chain:
   * a fork longer than one sync's budget, or one whose supplier failed mid-pass, accumulates across syncs and restarts. */
  private readonly protectedHeaders = new Map<string, Map<string, Uint8Array>>();
  /** A kept header at least the depth above the clock's block that descends from it. */
  private buried: Uint8Array | undefined;
  private retained = 0;
  /** Each supplier's outstanding side-branch charge, in heights (`SIDE_HEADER_HEIGHTS` per header it added that
   * ended a sync off the best chain, less the best chain's advance since), and the highest best-chain height
   * already credited against it. */
  private readonly sideHeaders = new Map<string, { readonly charge: bigint; readonly height: bigint }>();
  /** The supplier that supplied the last section, asked first for the next, so suppliers that fail cost nothing
   * while it supplies. */
  private preferred: ErgoSupplier | undefined;
  private snapshot: Snapshot | undefined;
  private syncing = false;
  private failure: string | undefined;
  /** Where this view's own records go out; a view without one only reads. */
  private publisher: ErgoPublisher | undefined;

  /** A view keeps its rows in `journal`, attached to it alone, or without one in a private in-memory database. */
  constructor(profile: ErgoProfile, anchorContext: readonly Uint8Array[], policy: Partial<ErgoReaderPolicy> = {}, publisher?: ErgoPublisher,
    journal?: ErgoVenueJournal) {
    this.publisher = publisher;
    this.profile = ownErgoProfile(profile);
    this.venueId = ergoProfileIdentity(this.profile);
    this.durable = journal !== undefined;
    this.journal = journal ?? ErgoVenueJournal.memory(this.venueId);
    const { rows, state } = this.journal.attach(this.venueId);
    let store: ErgoHeaderStore | undefined;
    try { store = ergoHeaderStore(this.profile.anchor, anchorContext, this.profile.reference === ERGO_TESTNET_REFERENCE ? "testnet" : "mainnet", rows); } catch (error) {
      // The store reads its best tip from the rows; a row it cannot read is stored evidence that reproduces nothing.
      if (error instanceof VenueError) throw error;
      throw new VenueError("stored Ergo evidence does not reproduce its witnessed view");
    }
    if (store === undefined) throw new VenueError("the anchor context does not authenticate the profile's anchor");
    // Each context selects its header rules, and a header id names no network, so each reference context also
    // bounds its anchor's difficulty; a header id commits to its ancestry, so the bound keeps a profile naming either
    // context off the mainnet. The synthetic context reads the mainnet rules only above an anchor of difficulty 1,
    // which no mainnet header has. The testnet context reads only above an anchor below mainnet's initial
    // difficulty: the testnet's rules keep a parent's difficulty within an epoch, so a mainnet anchor would
    // otherwise be followed up to its next epoch boundary (at most 127 headers, each with the mainnet's work).
    // No mainnet header sampled to date is below it (the newest about 51 times above); a mainnet hashrate collapse
    // past that margin would reopen the 127-header exposure, and testnet hashrate past it would refuse real anchors.
    if (this.profile.reference !== undefined) {
      const last: unknown = anchorContext[anchorContext.length - 1];
      const anchor = last instanceof Uint8Array ? parseErgoHeader(copyBytes(last)) : undefined;
      const difficulty = anchor !== undefined && compareBytes(anchor.id, this.profile.anchor) === 0 ? decodeCompactBits(anchor.nBits) : undefined;
      if (this.profile.reference === ERGO_SYNTHETIC_REFERENCE && difficulty !== 1n) {
        throw new VenueError("the synthetic reference context reads only a chain whose anchor has difficulty 1");
      }
      if (this.profile.reference === ERGO_TESTNET_REFERENCE && (difficulty === undefined || difficulty >= INITIAL_DIFFICULTY)) {
        throw new VenueError("the testnet reference context reads only a chain whose anchor is below mainnet's initial difficulty");
      }
    }
    this.store = store;
    // The caller's policy is read once; an unknown or impossible value is the caller's error.
    const owned = { ...DEFAULT_ERGO_READER_POLICY, ...policy };
    if (Object.keys(owned).length !== Object.keys(DEFAULT_ERGO_READER_POLICY).length ||
        !Object.values(owned).every(n => Number.isSafeInteger(n) && n > 0) || owned.supplierTimeoutMs > MAX_TIMEOUT_MS) {
      throw new TypeError("invalid Ergo reader policy");
    }
    this.policy = Object.freeze(owned);
    this.restore(state);
  }

  /** Attach once after opening the owning operator journal's outbox. */
  attachPublisher(publisher: ErgoPublisher): void {
    if (this.publisher !== undefined || this.syncing) throw new VenueError("publisher is already attached or sync is running");
    this.publisher = publisher;
  }

  /** The stored clock, checked as far as is cheap: the rows are this view's own (pool-v3 §14), so no work or root is
   * re-checked, but the clock's block must stand on the best chain the rows name, and some kept header must have
   * buried it at the depth (venue-ergo §2). */
  private restore(state: ErgoViewState): void {
    const invalid = (): never => { throw new VenueError("stored Ergo evidence does not reproduce its witnessed view"); };
    if (state.retained > this.policy.retainedBytes) throw new VenueError("stored Ergo evidence exceeds the retained budget");
    this.retained = state.retained;
    try { this.restoreClock(state); } catch (error) {
      // A row the checks read but cannot find or parse is stored evidence that does not reproduce the view.
      if (error instanceof VenueError) throw error;
      invalid();
    }
  }
  private restoreClock(state: ErgoViewState): void {
    const invalid = (): never => { throw new VenueError("stored Ergo evidence does not reproduce its witnessed view"); };
    for (const { name, id } of state.protectedHeaders) {
      if (this.store.heightOf(id) === undefined) invalid();
      const kept = this.protectedHeaders.get(name) ?? new Map<string, Uint8Array>();
      kept.set(bytesToHex(id), copyBytes(id)); this.protectedHeaders.set(name, kept);
    }
    for (const { name, charge, height } of state.charges) this.sideHeaders.set(name, { charge, height });
    if (state.witnessed !== undefined) {
      const anchor = this.store.tip().anchorHeight, height = anchor + 1n + state.witnessed;
      if (state.failure === undefined) {
        const final = this.store.bestAt(height);
        if (final === undefined || compareBytes(final.id, state.pin!) !== 0) invalid();
        // A heavier chain can be shorter, so the burying header may be on a side branch, meeting the best chain at or
        // above the clock's block.
        const buried = state.buried!, top = this.store.heightOf(buried), meets = this.store.forkHeight(buried);
        if (top === undefined || top < height + this.profile.depth || meets === undefined || meets < height) invalid();
      }
      this.buried = state.buried;
      this.snapshot = Object.freeze({ witnessed: state.witnessed, witnessedHeaderId: copyBytes(state.pin!) });
    }
    this.failure = state.failure;
  }

  /** Write one sync's sections and the state after it, in one transaction. */
  private persist(snapshot: Snapshot | undefined, sections: readonly ErgoSectionRow[]): void {
    if (snapshot !== undefined) {
      // A pin the best chain buries at the depth takes its tip as the burying header; otherwise, as when a heavier but
      // shorter chain leads, the pin has not moved and the earlier burying header still descends from it.
      const tip = this.store.tip(), height = tip.anchorHeight + 1n + snapshot.witnessed;
      if (this.failure === undefined && tip.height >= height + this.profile.depth) this.buried = tip.id;
    }
    this.journal.commit({ sections, witnessed: snapshot?.witnessed, pin: snapshot?.witnessedHeaderId, buried: snapshot === undefined ? undefined : this.buried,
      failure: this.failure, retained: this.retained,
      charges: [...this.sideHeaders].map(([name, { charge, height }]) => ({ name, charge, height })),
      protectedHeaders: [...this.protectedHeaders].flatMap(([name, ids]) => [...ids.values()].map(id => ({ name, id }))) });
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
   * failure, after which every read refuses) and on a concurrent sync. Any
   * other rejection is the view's own failure, after which it refuses too.
   */
  async sync(suppliers: readonly ErgoSupplier[]): Promise<ErgoSyncReport> {
    if (this.failure !== undefined) throw new VenueError(this.failure);
    if (this.syncing) throw new VenueError("a sync is already in progress");
    // The caller's list is read once, before the sync starts, so a list that is not one is the caller's error alone;
    // each supplier's name once, for its report.
    const sources = Array.from(suppliers, supplier => ({ supplier, name: nameOf(supplier) }));
    this.syncing = true;
    try {
      this.journal?.assertOwner();
      const passes: { supplier: ErgoSupplier; name: string; pass: HeaderPass }[] = [];
      for (const source of sources) passes.push({ ...source, pass: await this.syncHeaders(source.supplier, source.name) });
      // A supplier whose passes reached a header keeps only what they reached under its name, whatever ended them; one
      // that reached none (down, or refused at once) keeps what it had.
      for (const { name, pass } of passes) if (pass.protect !== undefined) this.protectedHeaders.delete(name);
      for (const { name, pass } of passes) if (pass.protect !== undefined) {
        const id = blake2b(pass.protect, { dkLen: 32 }), kept = this.protectedHeaders.get(name) ?? new Map<string, Uint8Array>();
        kept.set(bytesToHex(id), id); this.protectedHeaders.set(name, kept);
      }
      const best = this.store.tip(), anchorHeight = best.anchorHeight, depth = this.profile.depth;
      // Each supplier is charged, whatever ended its pass, exactly the headers it added that are not on the best
      // chain: a supplier whose chain keeps ending off it spends its side-branch quota and is then withholding, and a
      // branch that briefly leads charges an honest supplier only its headers past the fork. The best chain's advance
      // since a supplier's last charge forgives one header per `SIDE_HEADER_HEIGHTS`: the network's work, never the
      // supplier's, so a cheap branch gains only that rate, and an honest supplier's orphans never accumulate.
      for (const { name, pass } of passes) {
        const off = BigInt(pass.added.filter(id => !this.store.isBest(id)).length), entry = this.sideHeaders.get(name);
        if (entry === undefined) {
          if (off > 0n) this.sideHeaders.set(name, { charge: off * SIDE_HEADER_HEIGHTS, height: best.height });
          continue;
        }
        // A heavier shorter chain lowers the best height; the credited height never falls, so no advance counts twice.
        const advance = best.height > entry.height ? best.height - entry.height : 0n;
        const charge = (entry.charge > advance ? entry.charge - advance : 0n) + off * SIDE_HEADER_HEIGHTS;
        if (charge === 0n) this.sideHeaders.delete(name);
        else this.sideHeaders.set(name, { charge, height: entry.height + advance });
      }
      // The best chain must keep the header at the published clock: its id commits to every block before it.
      const previous = this.snapshot, clock = previous?.witnessed ?? -1n;
      if (previous !== undefined) {
        const kept = this.store.bestAt(anchorHeight + 1n + previous.witnessed);
        if (kept === undefined || compareBytes(kept.id, previous.witnessedHeaderId) !== 0) {
          this.failure = "venue failure: the best chain left a block witnessed under the depth";
          this.persist(previous, []);
          throw new VenueError(this.failure);
        }
      }
      // Every sync reads sections only up to the clock it publishes, so the stored sections are exactly those through
      // the clock, all on the chain that keeps its block; this sync's are held here until its commit.
      const read: ErgoSectionRow[] = [];
      const chainWitnessed = best.height - depth - anchorHeight - 1n;
      let bound = chainWitnessed;
      for (const { name, pass: { last } } of passes) {
        if (last === undefined) continue;
        // A supplier the header budget stopped before its tip may yet show a heavier chain from its last header, so
        // the clock stays at or below where that header meets the best chain: the reader's own budget cannot make it
        // witness a block it would later have to unwitness. A fork below the published clock bounds nothing,
        // since such a chain, were it heavier, fails the venue either way; and a supplier past its side-branch quota
        // is withholding. Only this stop bounds the clock: it takes a budget of headers with their work, while
        // failing costs a supplier nothing.
        const header = parseErgoHeader(last), fork = header === undefined ? undefined : this.store.forkHeight(header.id), height = header?.height;
        if (fork === undefined || height === undefined) continue;
        if (this.sideQuotaSpent(name)) continue;
        const forkIndex = fork - anchorHeight - 1n;
        if (forkIndex >= clock && forkIndex < bound) bound = forkIndex;
      }
      const missed = new Set<ErgoSupplier>();
      let spent = 0, sectionsRead = 0, unresolved: bigint | undefined, reason: ErgoSyncReport["unresolvedReason"];
      for (let index = clock + 1n; index <= bound; index++) {
        // Checked before each section, so one larger than the budget is still read, alone in its sync.
        if (spent >= this.policy.sectionBytesPerSync) { unresolved = index; reason = "section budget"; break; }
        const header = this.store.bestAt(anchorHeight + 1n + index)!;
        const asked = sources.map(source => source.supplier).filter(s => !missed.has(s));
        const first = this.preferred === undefined ? -1 : asked.indexOf(this.preferred);
        if (first > 0) asked.unshift(...asked.splice(first, 1));
        const section = await this.readSection(asked, missed, header.id, header.transactionsRoot);
        spent += section.bytes;
        if (section.objects === undefined) { unresolved = index; reason = section.retainedStop ? "retained budget" : "no section"; break; }
        this.preferred = section.supplier;
        read.push({ index, header: header.id, views: section.views!,
          objects: section.objects });
        sectionsRead++;
      }
      // Every section read is at or below the bound, so the clock is the last one read.
      const witnessed = clock + BigInt(read.length);
      let next = this.snapshot;
      if (witnessed >= 0n && witnessed > clock) {
        next = Object.freeze({ witnessed, witnessedHeaderId: copyBytes(read[read.length - 1]!.header) });
      }
      if (next !== undefined) {
        for (const [name, ids] of this.protectedHeaders) {
          for (const [key, id] of ids) if (this.store.isBest(id)) ids.delete(key);
          if (ids.size === 0) this.protectedHeaders.delete(name);
        }
        this.store.prune(next.witnessedHeaderId, [...this.protectedHeaders.values()].flatMap(ids => [...ids.values()]));
      }
      // No await: commit evidence and pin before exposing the new snapshot.
      this.persist(next, read);
      this.snapshot = next;
      const snapshot = this.snapshot;
      // The publisher forgets what this view now holds, in its own queue: it never fails or holds up the sync.
      if (this.publisher !== undefined && snapshot !== undefined) this.publisher.settle(request => this.holds(request)).catch(() => {});
      return Object.freeze({
        witnessedIndex: snapshot?.witnessed, witnessedHeaderId: snapshot === undefined ? undefined : copyBytes(snapshot.witnessedHeaderId),
        chainWitnessedIndex: chainWitnessed >= 0n ? chainWitnessed : undefined, tipHeight: this.store.tip().height, suppliers: Object.freeze(passes.map(({ pass }) => pass.report)),
        sectionsRead, unresolvedIndex: unresolved, ...(reason === undefined ? {} : { unresolvedReason: reason }),
      });
    } catch (error) {
      // Suppliers' failures are answers, so whatever reaches here is the view's own: it may have read sections past
      // its clock, and it fails closed rather than answer from a state no sync completed.
      if (this.failure === undefined) {
        this.failure = this.durable ? "durable Ergo sync failed; reopen the journal" : "Ergo sync failed; open a new view";
      }
      throw error;
    } finally {
      this.syncing = false;
    }
  }

  /** Whether a supplier's outstanding side-branch charge has reached its quota, as of the last sync it took part in. */
  private sideQuotaSpent(name: string): boolean {
    return (this.sideHeaders.get(name)?.charge ?? 0n) >= BigInt(this.policy.sideHeadersPerSupplier) * SIDE_HEADER_HEIGHTS;
  }

  private async syncHeaders(supplier: ErgoSupplier, name: string): Promise<HeaderPass> {
    let added = 0, fetched = 0, last: Uint8Array | undefined;
    const ids: Uint8Array[] = [];
    // Every pass protects the last header it reached above the anchor, whatever ended it.
    const done = (stopped?: string): HeaderPass => ({ added: ids, ...(last === undefined ? {} : { protect: last }),
      report: Object.freeze(stopped === undefined ? { name, headersAdded: added } : { name, headersAdded: added, stopped }) });
    const unfinished = (): HeaderPass => last === undefined ? done("header budget") : { ...done("header budget"), last };
    const { headersPerSupplier: budget, supplierTimeoutMs: timeout } = this.policy;
    if (this.sideQuotaSpent(name)) return done("side-branch quota");
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
          const id = blake2b(bytes!, { dkLen: 32 });
          if (outcome === "added") { added++; ids.push(id); }
          // Only a header above the anchor can be protected: the anchor and its context are never retained,
          // so a supplier repeating them would leave a protected id no reopen can reproduce.
          if ((this.store.heightOf(id) ?? anchorHeight) > anchorHeight) last = bytes!;
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
    Promise<{ objects?: readonly AttributedObject[]; views?: readonly ErgoTransactionView[]; supplier?: ErgoSupplier; bytes: number; retainedStop?: boolean }> {
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
      return { objects, views: owned.views!, supplier, bytes };
    }
    return { bytes };
  }

  /**
   * Re-check every row this view keeps, as a reader that never trusted them
   * would: every header's linkage, difficulty and score (and its work where
   * `work` is set, the costly part), every section's transaction root against
   * the best chain's header at its index, every object attributed again from
   * its section under this release's rules, and the retained bytes. For a view
   * restored from a backup or copied from elsewhere, or after a disk fault:
   * reopening checks only what is cheap. Linear in the rows; it reads nothing
   * from suppliers and changes nothing. Throws `VenueError` naming the first
   * row that does not reproduce; answers what it checked.
   */
  audit(options: { readonly work?: boolean } = {}): { readonly headers: number; readonly sections: bigint; readonly objects: bigint } {
    const work = options.work === true;
    if (this.syncing) throw new VenueError("a sync is in progress");
    const snapshot = this.requireSnapshot(), anchorHeight = this.store.tip().anchorHeight;
    const refuse = (why: string): never => { throw new VenueError(`Ergo view audit: ${why}`); };
    let headers = 0;
    try { headers = this.store.audit(work); } catch (error) {
      if (error instanceof VenueError) throw error;
      refuse(error instanceof Error ? error.message : String(error));
    }
    let next = 0n, objects = 0n, retained = 0;
    try { for (const section of this.journal.sections()) {
      const header = this.store.bestAt(anchorHeight + 1n + section.index);
      if (section.index !== next || header === undefined || compareBytes(header.id, section.header) !== 0) refuse(`section ${section.index} is not the best chain's next`);
      const derived = attributeSection(this.profile, section.views, header!.transactionsRoot);
      if (derived === undefined) refuse(`section ${section.index} does not reproduce its header's root`);
      const same = derived!.length === section.objects.length && derived!.every((object, i) => {
        const kept = section.objects[i]!;
        return object.kind === kept.kind && object.ordinal === kept.ordinal && compareBytes(object.subject, kept.subject) === 0 &&
          compareBytes(object.record, kept.record) === 0 && compareBytes(objectKey(object.kind, object.subject, object.record), kept.key) === 0;
      });
      if (!same) refuse(`section ${section.index}'s objects are not those it attributes`);
      for (const object of derived!) retained += retainedSize(object);
      objects += BigInt(derived!.length); next++;
    } } catch (error) {
      if (error instanceof VenueError) throw error;
      refuse(`section ${next}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (next !== snapshot.witnessed + 1n) refuse("the sections do not reach the clock");
    if (this.journal.objectCount() !== objects) refuse("objects are kept beyond the sections");
    if (retained !== this.retained) refuse("the retained bytes are not the objects'");
    return Object.freeze({ headers, sections: next, objects });
  }

  // --- Reads ------------------------------------------------------------------

  private requireSnapshot(): Snapshot {
    this.journal.assertOwner();
    if (this.failure !== undefined) throw new VenueError(this.failure);
    if (this.snapshot === undefined) throw new VenueError("this view has no settled snapshot");
    return this.snapshot;
  }

  witnessedIndex(): bigint {
    return this.requireSnapshot().witnessed;
  }

  /**
   * pool-v3 §13's answer to one request from this view, or undefined where the
   * request is malformed, names another venue or reaches past the clock; an
   * answer over `limits` throws `RangeLimitError` (`RecordVenue`). The answer
   * is the reader's own, computed from the verified sections, so a replay
   * consumes it as its venue-evidence verifier's output (§12.1).
   */
  range(request: RangeRequest, limits: RangeLimits): Uint8Array | undefined {
    const snapshot = this.requireSnapshot();
    let own: RangeRequest;
    try { own = copyRequest(request); } catch (error) {
      if (error instanceof EncodingError) return undefined;
      throw error;
    }
    if (compareBytes(own.venue, this.venueId) !== 0 || own.toIndex > snapshot.witnessed) return undefined;
    const bound = copyLimits(limits);
    const objects = this.journal.objects(own.kind, own.subject, own.fromIndex, own.toIndex, bound);
    return encodeRangeAnswer({ request: own, entries: orderedEntries(own.kind, objects) }, bound);
  }

  /**
   * One record at its kind's location, through the view's publisher, with
   * every output created at the tip of the chain this view verified: at most
   * the height of the block that will include it, which the network requires,
   * and never a supplier's word. Resolves when a supplier accepted the
   * transaction; the record counts once a later sync reads it. Kinds 1–3 are
   * carried without judging their signatures or contents (venue-ergo §6).
   * Kind 4 is one adjacent same-subject output run in that same transaction.
   *
   * The lag bounds inclusion against this view's clock: a caller hands only
   * records signed at or below it. While a heavier, shorter chain that keeps
   * the clock's block is the best (venue-ergo §2), its next block could fall
   * inside that lag, so nothing is built or sent, in the publisher's turn and
   * before each transaction, until the chain is again as long as the clock's
   * depth; the publisher keeps what it built for later.
   */
  async publishRecord(kind: RecordKind, subject: Uint8Array, record: Uint8Array): Promise<void> {
    await this.publish(kind, subject, record);
  }

  /** `publishRecord`, answering the publication the publisher built last for the record (where an earlier one it
   * replaced lands instead, that one carries the record), or undefined where this view already holds the record and
   * nothing was sent. */
  async publish(kind: RecordKind, subject: Uint8Array, record: Uint8Array): Promise<ErgoPublication | undefined> {
    if (kind !== 1 && kind !== 2 && kind !== 3 && kind !== 4) throw new EncodingError("invalid Ergo record kind");
    const length = byteLength(record);
    if (byteLength(subject) !== 32 || (kind === 4 ? length > MAX_RANGE_RECORD_BYTES[4] : length !== MAX_RANGE_RECORD_BYTES[kind])) {
      throw new EncodingError("invalid Ergo record length");
    }
    const ownSubject = copyUnshared(subject), ownRecord = copyUnshared(record);
    if (this.publisher === undefined) throw new VenueError("this view has no publisher; publishing is the operator's wallet");
    this.requireSnapshot();
    const request = { location: this.profile.scripts[kind], subject: ownSubject, record: ownRecord, height: this.store.tip().height, chunked: kind === 4 };
    // Held already, as when a sync settled it after the caller last read: nothing to send.
    if (this.holds(request)) return undefined;
    const ready = (): void => {
      const clock = this.requireSnapshot().witnessed, tip = this.store.tip();
      if (tip.height < tip.anchorHeight + 1n + clock + this.profile.depth) {
        throw new VenueError("the best chain is shorter than the clock's depth; publish once it grows");
      }
    };
    ready();
    return this.publisher.publish(request, ready);
  }

  /** The first index this view witnessed the exact record at, under its kind and subject, or undefined where its
   * witnessed index holds none. */
  witnessedAt(kind: RecordKind, subject: Uint8Array, record: Uint8Array): bigint | undefined {
    const snapshot = this.requireSnapshot(), first = this.journal.firstIndex(objectKey(kind, copyUnshared(subject), copyUnshared(record)));
    return first !== undefined && first <= snapshot.witnessed ? first : undefined;
  }

  /** Whether the snapshot holds this exact record at its location under its subject. */
  private holds(request: ErgoRecordRequest): boolean {
    const kind = ([1, 2, 3, 4] as const).find(k => compareBytes(this.profile.scripts[k], request.location) === 0);
    return kind !== undefined && this.witnessedAt(kind, request.subject, request.record) !== undefined;
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
    // By index over its own length, never its iterator, and no further than any block's bounds.
    const count = arrayLength(answer as unknown[]);
    if (count > MAX_SECTION_TRANSACTIONS) return { bytes };
    const views: ErgoTransactionView[] = [];
    for (let i = 0; i < count; i++) {
      const transaction: unknown = (answer as unknown[])[i];
      if (transaction === null || typeof transaction !== "object") return { bytes };
      const { unsigned, witnessId } = transaction as Record<string, unknown>;
      if (!isRealBytes(unsigned) || !isRealBytes(witnessId)) return { bytes };
      const view = { unsigned: copyBytes(unsigned), witnessId: copyBytes(witnessId) };
      bytes += view.unsigned.length + view.witnessId.length;
      if (bytes > MAX_SECTION_BYTES) return { bytes };
      views.push(view);
    }
    return { views, bytes };
  } catch {
    return { bytes };
  }
}
/** What one retained object costs: its record, its subject and a fixed overhead. */
const retainedSize = (object: AttributedObject): number => object.record.length + object.subject.length + OBJECT_OVERHEAD;

