// Node 24 optional entry point. The pool-v3 operator journal (v3 runtime plan,
// slices 1–3): one durable database per operator key and venue, fenced to one
// owner. It serves one scope of one construction, pool-v3's by default or
// lit-v1's (slice 14 M14f), whose records, receipts, snapshots, headers, terms,
// packages and configuration it reads and writes through construction.ts. It
// admits ordinary and recovery records through the state machine's admission
// mode (state.ts) with original signed receipts (§7.2), signs checkpoint commitments over v3 directories and snapshots (§7),
// publishes them through the record venue from an outbox, and serves §12
// packages a reader verifies alone. A witnessed silence boundary permits an
// empty return opening, then exact adoption through its witnessed index before
// service. Replacement imports the record-derived frontier.
//
// The database is the operator's authoritative log (storage decision
// 2026-09-29 item 7, M5b.5a). One transaction commits a command with all it
// changes: the admission state (a ReplayStore hosted here), the record,
// directory, snapshots and segment head it adds to the evidence the journal
// serves (an EvidenceStore hosted here), the receipt and the signed commitment.
// Nothing but the active segment's scope is held in memory, and reopening
// reads rows: it verifies no proof. It checks instead that the stored state
// reproduces its own tip and the last signed snapshot, and that the log's
// latest signed reply is the latest signed row. The journal's own reads of its
// history go through the public reader over the same evidence. Their classes
// and replays are a reader's kept state (§14) in a file of their own beside
// the database, so a read never holds the journal's connection and each
// record is verified there once; what a new segment imports from a read is
// copied into the database with the command that opens it. `audit`
// re-verifies from the evidence alone, keeping nothing of what it replays.
//
// What the journal reads of the venue for its own commands is kept in the
// database too (§§13.2–13.3): this key's held commitments, each scoped
// backing's admitted replacements and each K's revocation, through the index
// they were read to. A command asks the venue only for the windows after that
// index and verifies each commitment once, so neither grows with the venue's
// age. An answer stands while the venue's finality rule does (§13.2), so a
// command is judged by the view it read while the venue's clock has not moved. The kept answers are
// the journal's own rows, trusted as the rest of its state is; `audit` reads
// the venue again from its first index and compares.
//
// Evidence is served by parts, read from rows as a reader takes them (§14
// incremental retrieval): the objects of each checkpoint signed after the
// sequence the reader was served through, and each trail as its head and the
// records after the position that sequence reached. Served rows are never
// changed, so serving holds no operation and no transaction; memory holds one
// part or one record at a time. A whole package is those parts served from
// nothing, for a caller that holds one in memory.
//
// The journal runs under its construction's configuration (pool-v3 §11.4's, or
// lit-v1 §9's) and only on a reference venue (guard.ts). Time is the venue's witnessed index.
// SQLite fences handles of this journal; it cannot fence another database or
// a copied key.
import { DatabaseSync } from "node:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes, EncodingError } from "../../bytes.js";
import { fileIdentity } from "../../file-identity.js";
import type { ErgoPublisherPersistence } from "../../ergo-publisher.js";
import { RangeLimitError, replacementChain, type ChainLink, type HeldCommitment, type RangeAnswer, type RangeEntry,
  type ReplacementChain } from "../../record-range.js";
import type { RecordPublisher, RecordVenue } from "../../record-venue.js";
import { VenueError } from "../../venue-error.js";
import { decodeCommitment, encodeCommitment, signCommitment, verifyCommitment, type Commitment, type SnapshotDigest } from "../../venue-records.js";
import { scopeSchedule } from "../schedule.js";
import type { Snapshot } from "./commitments.js";
import { POOL_V3, type Construction, type ReaderFrames } from "./construction.js";
import { EvidenceStore, MAX_ITEM_BYTES, SERVED_PART_BYTES, SERVED_PART_ITEMS, topTrails, wholePackage, type EvidenceBatch, type EvidencePart, type StoredTrail, type TrailTip } from "./evidence-store.js";
import { requireReferenceVenue, type VenueReference } from "./guard.js";
import type { SegmentHeader } from "./headers.js";
import { decodeEvidenceDirectory, encodeEvidenceDirectory, PackageLimitError } from "./package.js";
import { keptAnswers, keptStateHolds, storedTipHolds, type KeptAnswers, type SignedTerms } from "./reader.js";
import { ownVerifier, readFrontier, readPackage } from "./package-reader.js";
import { EvidenceRefusal, ReplayRefusal } from "./refusals.js";
import { mergeFinalizedPrefixes, type CanonicalCheckpoint, type FrontierResult, type ScopeForcedPublication,
  type ScopeResult } from "./scope-reader.js";
import { FileInUse, ReplayStore } from "./replay-store.js";
import { applyJudged, judgeAdopted, judgeRecord, openSegmentState, StateHandle, type ImportSource, type DeclaredVerifier, type Judged, type SegmentReplay,
  type SegmentState } from "./state.js";
import type { RootTerms } from "./terms.js";

const PROFILE = "pool-store/v3/8";
/** Signed rows read at a time while serving. */
const SERVE_PAGE = 256n;
const U64 = 1n << 64n;
const SQLITE_LIMIT = (1n << 63n) - 1n;
const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
const bytes = (value: unknown): Uint8Array => new Uint8Array(value as Uint8Array);
const hexOf = (c: Commitment | undefined): string | null => (c === undefined ? null : bytesToHex(encodeCommitment(c)));
const copyCommitment = (c: Commitment): Commitment => decodeCommitment(encodeCommitment(c));
/** The replay identity a segment's admission state is kept under: the journal's own, never a reader's. */
const admissionIdentity = (segment: Uint8Array): Uint8Array => sha256(concatBytes(utf8ToBytes("v3-journal-admission"), segment));
/** The identity an imported segment's copied prefix is kept under. */
const importIdentity = (segment: Uint8Array): Uint8Array => sha256(concatBytes(utf8ToBytes("v3-journal-import"), segment));
/** A genesis segment: opened by `open`, each backing under its original term with nothing imported. Every other
 * opening waits for adoption (C2b.4.2, C2.10.9). */
const isGenesis = (header: SegmentHeader): boolean => header.sequence === 1n &&
  header.entries.every(entry => entry.opening === undefined && same(entry.link, entry.backing));

export class V3StoreError extends Error {
  constructor(readonly code: "STORAGE" | "FENCED" | "BUSY" | "CONFLICT" | "UNAVAILABLE" | "STALE" | "SCHEDULE" | "UNSUPPORTED" | "REFUSED" |
    "COPIED" | "RESTORED",
    message: string, readonly check?: string) {
    super(message); this.name = "V3StoreError";
  }
}
function requireThat(ok: boolean, code: V3StoreError["code"], message: string, check?: string): asserts ok {
  if (!ok) throw new V3StoreError(code, message, check);
}
function decimal(value: unknown): bigint {
  requireThat(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), "STORAGE", "invalid stored counter");
  return BigInt(value);
}

/** Signed terms as a command names them: hex terms and signature. */
type TermsText = readonly [string, string];
/** One row of the command log: what was asked, beside the reply it got. The records, evidence and state a
 * command added are rows of their own, committed with it. */
type Command =
  | { kind: "open"; scope: readonly TermsText[]; at: string; observed: string | null }
  | { kind: "rescope"; take: readonly TermsText[]; keep: readonly string[]; evidence: string; at: string; observed: string | null }
  | { kind: "commit"; at: string; observed: string | null }
  | { kind: "admit"; horizon: string }
  | { kind: "return"; at: string; observed: string | null }
  | { kind: "adopt"; at: string; opening: string }
  | { kind: "published"; sequence: string };
const termsText = (signed: SignedTerms): TermsText => [bytesToHex(signed.terms), bytesToHex(signed.signature)];

/** One scoped backing: its name and original signed terms. */
interface Scoped {
  readonly backing: Uint8Array;
  readonly terms: RootTerms;
  readonly signed: SignedTerms;
}
/** The active segment: its header, scope root and each scoped backing in header order. */
interface Opened {
  readonly header: SegmentHeader;
  readonly headerBytes: Uint8Array;
  readonly segment: Uint8Array;
  /** Pool-v3's scope root; undefined for a construction whose segment identity binds its scope (lit-v1). */
  readonly scope: bigint | undefined;
  readonly entries: readonly Scoped[];
}
function openedOf(frames: ReaderFrames, header: SegmentHeader, entries: readonly Scoped[]): Opened {
  // A reader takes a directory as one whole item: a scope whose directory passes that budget could not be served.
  requireThat(9n + 64n * BigInt(entries.length) <= MAX_ITEM_BYTES, "REFUSED", "the scope's directory would pass a reader's item budget", "RESOURCE");
  return { header, headerBytes: frames.header.segmentBytes(header), segment: frames.header.segmentIdentity(header), scope: frames.scopeRoot(header), entries };
}
/** C2.10.2: one clock per scope. A reader excludes a scope whose silence durations differ (SILENCE_SCOPE). */
function oneClock(entries: readonly Scoped[]): void {
  const durations = entries.map(({ terms }) => terms.silence?.noCommitmentDuration);
  requireThat(durations.every(duration => duration === durations[0]), "REFUSED", "the scoped backings declare different silence clocks", "SCOPE");
}
/** The term link a segment's header names for `backing`. */
const linkOf = (opened: Opened, backing: Uint8Array): Uint8Array => opened.header.entries.find(entry => same(entry.backing, backing))!.link;
const isTermsList = (value: SignedTerms | readonly SignedTerms[]): value is readonly SignedTerms[] => Array.isArray(value);
/** A signed commitment as its row keeps it: the segment and length it carries, the index it was signed at and
 * what the venue held of this key then. Its directory and snapshots are evidence, found by its root. */
interface Signed {
  readonly commitment: Commitment;
  readonly segment: Uint8Array;
  readonly length: bigint;
  readonly at: bigint;
  readonly observed: string | null;
  published: boolean;
}
/** A scope change (C2.10.9): successor terms to take from public evidence and
 * live backings of the active scope to keep from the journal's own state. */
export interface Rescope {
  readonly take?: readonly SignedTerms[];
  readonly keep?: readonly Uint8Array[];
  /** Public evidence for the taken terms' ancestry; required exactly when taking. */
  readonly evidence?: Uint8Array;
}
interface OwnRescope { readonly take: readonly SignedTerms[]; readonly keep: readonly Uint8Array[]; readonly evidence: Uint8Array }
/** What the journal holds in memory: its revision, the active segment's scope and state handle, and the latest
 * signed commitment. Everything that grows with history is rows. */
interface Engine {
  revision: bigint;
  opened: Opened | undefined;
  state: SegmentState | undefined;
  last: Signed | undefined;
  pendingReturn: boolean;
}
type StateRead = Extract<ScopeResult, { readonly state: object }>;
/** The venue at one instant: its clock and lag, the latest commitment it holds of this key, every scoped backing's
 * term boundary and each K's revocation. The held commitments themselves are rows, read through `now`. */
interface View {
  readonly now: bigint;
  readonly lag: bigint;
  readonly latest: HeldCommitment | undefined;
  /** An authentic record of this key outside the durable signing history,
   * including records the venue's holding rule does not select. */
  readonly conflict: boolean;
  readonly boundaries: readonly bigint[];
  /** Each scoped backing's K revocation index, by backing name. */
  readonly revocations: ReadonlyMap<string, bigint | undefined>;
}

/** What the journal needs besides its path. */
export interface V3StoreOptions {
  /** The operator's Ed25519 secret; copied, and erased on close. */
  readonly secret: Uint8Array;
  readonly venue: RecordVenue & RecordPublisher;
  /** The venue identity's preimage the caller holds; the guard recomputes it. */
  readonly reference: VenueReference;
  /** Verifies proofs under the configuration's keys; a construction without proofs (lit-v1) takes none. */
  readonly verifier?: DeclaredVerifier | undefined;
  /** The construction the journal's scope declares: pool-v3's by default, or lit-v1's (slice 14 M14f). Its domain is
   * the journal's identity, so a journal's file serves one construction. */
  readonly construction?: Construction | undefined;
  /** The owner restored this journal from a copy or backup (slice 13 M13d). It records the fact, and from then on signs
   * nothing but C2b.4's return, once the silence boundary is witnessed, at a sequence above any its lost instance can
   * have left unwitnessed, and that return's adopted block; adopting it lifts the fence. Recorded again before the
   * return is signed, it changes nothing; after, it is a restoration of its own (the copy may have been taken after
   * the return was signed) and draws a fresh spacing. Also the only way to open a journal whose file is not the one it
   * was made in. */
  readonly restored?: boolean | undefined;
}
/** A served §12 package with the selection it names; a reader makes its own selection and judges at its own index. */
export interface ServedPackage {
  readonly selection: {
    readonly domain: Uint8Array; readonly venue: Uint8Array; readonly backing: Uint8Array;
    readonly operator: Uint8Array; readonly sequence: bigint; readonly root: Uint8Array;
  };
  readonly package: Uint8Array;
}
/** Served evidence by parts (§14 incremental retrieval). `package` holds only the read's own items, the
 * configuration and the selected commitment. `parts` hold every other object a reader of the selection needs
 * that was not served through the sequence the reader named, and are read from rows as they are consumed. */
export interface ServedEvidence extends ServedPackage {
  readonly parts: Iterable<EvidencePart> | AsyncIterable<EvidencePart>;
}

/** `V3OperatorJournal.status()`: indices are the venue's witnessed indices. */
export interface JournalStatus {
  readonly now: bigint;
  readonly signed?: { readonly sequence: bigint; readonly at: bigint; readonly published: boolean; readonly held: boolean; readonly admitted: bigint };
  readonly heldIndex?: bigint;
  readonly pendingReturn: boolean;
  /** The venue index at which the owner recorded a restoration whose opening is not yet adopted (M13d). */
  readonly restoredAt?: bigint;
  /** That restoration's opening sequence, once signed. */
  readonly restoredOpening?: bigint;
}

/** A restored journal's opening skips 2^16 sequences per spacing step (M13d): far above the few a lost instance's
 * one-in-flight rules can leave unwitnessed past the record's latest, and two restorations' openings, each with its
 * own random spacing, at least that far apart. */
const RESTORED_SKIP = 1n << 16n;
/** How far past a skip's base the lost instance's own unwitnessed commitments can lie: its one-in-flight rules leave an
 * ordinary commitment and a pending opening, about two; sixteen is margin. */
const LOST_IN_FLIGHT = 16n;

export class V3OperatorJournal {
  private readonly db: DatabaseSync;
  /** The construction the journal serves (its frames name the configuration domain). */
  readonly construction: Construction;
  private readonly frames: ReaderFrames;
  private readonly domain: Uint8Array;
  private readonly secret: Uint8Array;
  private readonly operator: Uint8Array;
  private readonly venue: RecordVenue & RecordPublisher;
  private readonly venueId: Uint8Array;
  private readonly lag: bigint;
  private readonly verifier: DeclaredVerifier;
  private readonly reference: VenueReference;
  private readonly owner: bigint;
  private readonly resumedAt: bigint | undefined;
  private readonly path: string;
  /** The admission state and the imported prefixes it reads, in this database. */
  private readonly replays: ReplayStore;
  /** The kept state of the journal's own reads, opened at the first read: a file beside the database,
   * named by the verifier's circuits (§14). */
  private reading: ReplayStore | undefined;
  /** The evidence the journal serves and reads: its own records, heads, directories and snapshots, and what a takeover took. */
  private readonly evidence: EvidenceStore;
  private readonly retained: EvidenceBatch;
  private observedIndex: bigint;
  private engine: Engine | undefined;
  private busy = false;
  private closed = false;

  constructor(path: string, options: V3StoreOptions) {
    requireThat(typeof path === "string" && path.trim() !== "" && path !== ":memory:" && !path.startsWith("file:"), "STORAGE", "a persistent filesystem path is required");
    const { secret, venue, reference, verifier } = options;
    // The guard first: the journal runs only on a reference venue.
    this.venueId = requireReferenceVenue(reference, venue);
    this.reference = structuredClone(reference);
    this.construction = options.construction ?? POOL_V3 as Construction; this.frames = this.construction.reader;
    this.domain = this.frames.domain();
    // The circuit identities are copied once: what later reads name and check is what was checked here.
    this.verifier = ownVerifier(this.construction, verifier);
    this.venue = venue; this.lag = venue.lag();
    this.secret = copyBytes(secret); this.operator = ed25519.getPublicKey(this.secret);
    this.observedIndex = 0n; this.path = path;
    const now = this.clock();
    this.db = new DatabaseSync(path, { timeout: 5000, readBigInts: true });
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      requireThat(this.db.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal" &&
        this.db.prepare("PRAGMA synchronous").get()?.synchronous === 2n, "STORAGE", "persistent WAL with FULL synchronization is required");
      try { this.db.exec("BEGIN IMMEDIATE"); } catch (error) {
        if (error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message)) throw new V3StoreError("BUSY", "the journal database is held by another handle");
        throw error;
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1),
        profile TEXT NOT NULL, domain TEXT NOT NULL, operator TEXT NOT NULL, venue TEXT NOT NULL,
        owner INTEGER NOT NULL, tip INTEGER NOT NULL, observed TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY CHECK(seq>0), id TEXT NOT NULL UNIQUE,
        request TEXT NOT NULL, command TEXT NOT NULL, response TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS ergo_publisher (id INTEGER PRIMARY KEY CHECK(id=1),
        revision INTEGER NOT NULL CHECK(revision>0), snapshot TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS journal_state (id INTEGER PRIMARY KEY CHECK(id=1), segment BLOB NOT NULL, ns INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS journal_signed (sequence INTEGER PRIMARY KEY CHECK(sequence>0), commitment BLOB NOT NULL,
        segment BLOB NOT NULL, length INTEGER NOT NULL, at TEXT NOT NULL, observed TEXT, published INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS journal_receipt (statement BLOB PRIMARY KEY, receipt BLOB NOT NULL) STRICT, WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS journal_signed_segment ON journal_signed(segment, sequence);
        CREATE TABLE IF NOT EXISTS journal_taken (sequence INTEGER NOT NULL, kind INTEGER NOT NULL, hash BLOB NOT NULL, PRIMARY KEY(sequence, kind, hash)) STRICT, WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS journal_conflict (id INTEGER PRIMARY KEY CHECK(id=1), idx TEXT NOT NULL, record BLOB NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS journal_file (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS journal_restored (id INTEGER PRIMARY KEY CHECK(id=1), idx TEXT NOT NULL,
        spacing INTEGER NOT NULL, opening INTEGER) STRICT;
        CREATE TABLE IF NOT EXISTS journal_skipped (sequence INTEGER PRIMARY KEY, below INTEGER NOT NULL) STRICT;`);
      let meta = this.metadata();
      if (meta === undefined) {
        requireThat(this.db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n === 0n, "STORAGE", "journal identity is missing");
        this.db.prepare("INSERT INTO identity VALUES(1,?,?,?,?,0,0,?)").run(PROFILE, bytesToHex(this.domain),
          bytesToHex(this.operator), bytesToHex(this.venueId), now.toString());
        meta = this.metadata()!;
      }
      this.identity(meta, true);
      // M13d: a journal opened from a copy co-signs nothing on the segment it holds. Its book may lack a tail whose
      // receipts the original exposed (C2.8.1 assumes the book it held is durable), which no record shows.
      const file = fileIdentity(path), kept = this.db.prepare("SELECT identity FROM journal_file WHERE id=1").get()?.identity;
      if (options.restored === true) {
        const spacing = BigInt(crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff);
        // A copy taken after the restoration's return was signed may stand beside an instance that adopted it and
        // co-signed in its segment: that return is never this restoration's to adopt (it is adopted as any pending
        // opening, keeping the fence) and the next skips past it.
        this.db.prepare("DELETE FROM journal_restored WHERE id=1 AND opening IS NOT NULL").run();
        // A copy taken while the fence stands holds its spacing too: each recording draws a fresh one, keeping the
        // index, so no two restorations sign one return (nothing is signed under a spacing before the return).
        this.db.prepare("INSERT INTO journal_restored VALUES(1,?,?,NULL) ON CONFLICT(id) DO UPDATE SET spacing=excluded.spacing")
          .run(now.toString(), spacing);
      } else {
        requireThat(kept === undefined || kept === file, "COPIED", "this journal's file is not the one it was made in: if it is a copy " +
          "or a restored backup, run moe operator restore, which signs nothing on its segment and returns after silence");
      }
      this.db.prepare("INSERT INTO journal_file VALUES(1,?) ON CONFLICT(id) DO UPDATE SET identity=excluded.identity").run(file);
      // A venue still catching up to what this journal has read of it: nothing is wrong with the rows.
      requireThat(now >= decimal(meta.observed), "UNAVAILABLE", "the venue's clock is behind what this journal has read");
      requireThat(typeof meta.owner === "bigint" && meta.owner < SQLITE_LIMIT, "STORAGE", "journal owner counter exhausted");
      this.owner = meta.owner + 1n;
      // C2.8.2: a restarted journal waits the lag before it signs again.
      this.resumedAt = meta.tip === 0n ? undefined : now;
      this.db.prepare("UPDATE identity SET owner=?,observed=? WHERE id=1").run(this.owner, now.toString());
      // Both stores' tables are part of this database's layout, which PROFILE names.
      this.replays = new ReplayStore(this.db);
      this.evidence = new EvidenceStore(this.db, { construction: this.construction });
      this.retained = this.evidence.retained();
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      this.db.close(); this.secret.fill(0); throw error;
    }
  }

  /** The operator's public key. */
  get operatorKey(): Uint8Array { return copyBytes(this.operator); }
  /** The configuration's domain. */
  get configurationDomain(): Uint8Array { return copyBytes(this.domain); }

  /** The venue-bound durable publication outbox under this journal's owner
   * fence. These synchronous transactions may run within publish(); they do
   * not reenter run() or advance the protocol command log's revision. Each
   * adapter also fences stale publisher instances sharing the same owner. */
  publisherPersistence(): ErgoPublisherPersistence {
    let revision: bigint | undefined;
    const row = () => this.db.prepare("SELECT revision,snapshot FROM ergo_publisher WHERE id=1").get();
    const current = () => {
      const found = row();
      requireThat(revision === undefined || (found?.revision ?? 0n) === revision, "FENCED", "another publisher changed this outbox");
      return found;
    };
    return Object.freeze({
      load: (): string | undefined => this.transaction(() => {
        requireThat(revision === undefined, "STORAGE", "publisher persistence adapter is already loaded");
        const found = current(); revision = found === undefined ? 0n : found.revision as bigint;
        requireThat(found === undefined || (typeof found.revision === "bigint" && typeof found.snapshot === "string"), "STORAGE", "invalid publisher outbox");
        return found?.snapshot as string | undefined;
      }),
      guard: (): void => this.transaction(() => { current(); }),
      save: (snapshot: string): void => {
        requireThat(typeof snapshot === "string" && revision !== undefined && revision < SQLITE_LIMIT, "STORAGE", "publisher outbox is not loaded or full");
        const next = revision + 1n;
        this.transaction(() => {
          current();
          this.db.prepare("INSERT INTO ergo_publisher VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,snapshot=excluded.snapshot").run(next, snapshot);
        });
        revision = next;
      },
    });
  }

  private metadata() { return this.db.prepare("SELECT * FROM identity WHERE id=1").get(); }
  /** The owner's recorded restoration (M13d): the venue index it was recorded at, its spacing and its return, once signed. */
  private restoration(): { readonly at: bigint; readonly spacing: bigint; readonly opening?: bigint } | undefined {
    const row = this.db.prepare("SELECT idx,spacing,opening FROM journal_restored WHERE id=1").get();
    if (row === undefined) return undefined;
    requireThat(typeof row.spacing === "bigint" && (row.opening === null || typeof row.opening === "bigint"), "STORAGE", "invalid restoration row");
    return { at: decimal(row.idx), spacing: row.spacing, ...(row.opening === null ? {} : { opening: row.opening as bigint }) };
  }
  /** A restored journal signs nothing but its one opening and that opening's adopted block (deny by default). */
  private unrestored(): void {
    requireThat(this.restoration() === undefined, "RESTORED", "this journal was restored from a copy: it signs nothing but a return past " +
      "any sequence its lost instance can have signed, once silence is witnessed (moe operator restore), then adopts it");
  }
  /** The restored journal's return sequence at `at`: past its own last signed sequence and the record's latest held
   * one for this key by RESTORED_SKIP times one more than its spacing (M13d, Construction C2.4.1). */
  private restoredSequence(engine: Engine, at: bigint, spacing: bigint): bigint {
    const own = engine.last?.commitment.sequence ?? 0n, held = this.heldBelow(at)?.commitment.sequence ?? 0n;
    const sequence = (own > held ? own : held) + RESTORED_SKIP * (1n + spacing);
    requireThat(sequence < SQLITE_LIMIT && sequence < U64, "STORAGE", "signed sequence counter exhausted");
    return sequence;
  }
  /** Whether `sequence` is one a restored journal's lost instance can have left unwitnessed just past the skip's base
   * (M13d, Construction C2.4.1): landing late, the record moves past it (pool-v3 §13.3), and it is no other signer's.
   * Elsewhere in the gap a commitment of this key is another signer's, a conflict as anywhere. */
  private lostInstance(sequence: bigint): boolean {
    return this.db.prepare("SELECT 1 FROM journal_skipped WHERE below<? AND ?<=below+? AND sequence>?").get(sequence, sequence, LOST_IN_FLIGHT, sequence) !== undefined;
  }
  /** Inside the return's transaction: the restoration's opening is `sequence`, and serving passes the gap below it. */
  private restoredOpening(engine: Engine, sequence: bigint): void {
    this.db.prepare("UPDATE journal_restored SET opening=? WHERE id=1 AND opening IS NULL").run(sequence);
    this.db.prepare("INSERT INTO journal_skipped VALUES(?,?)").run(sequence, engine.last?.commitment.sequence ?? 0n);
  }
  /** The journal is this configuration's, key's and venue's, and its log ends at the recorded tip. Opening also
   * counts the log, once: a count at every transaction would cost each command the whole history. */
  private identity(meta: ReturnType<V3OperatorJournal["metadata"]>, opening = false): void {
    requireThat(meta?.profile === PROFILE && meta.domain === bytesToHex(this.domain) &&
      meta.operator === bytesToHex(this.operator) && meta.venue === bytesToHex(this.venueId), "STORAGE", "journal identity does not match");
    const tip = this.db.prepare("SELECT COALESCE(MAX(seq),0) AS tip FROM events").get()!.tip;
    requireThat(typeof meta.tip === "bigint" && meta.tip === tip &&
      (!opening || this.db.prepare("SELECT COUNT(*) AS n FROM events").get()!.n === tip), "STORAGE", "journal is truncated or noncontiguous");
  }
  private clock(): bigint {
    let now: unknown, lag: unknown, id: unknown;
    try { now = this.venue.witnessedIndex(); lag = this.venue.lag(); id = this.venue.id; } catch (error) {
      if (error instanceof VenueError) throw new V3StoreError("UNAVAILABLE", "the venue has no view");
      throw error;
    }
    if (typeof now !== "bigint" || now < this.observedIndex || lag !== this.lag || !(id instanceof Uint8Array) || !same(id, this.venueId)) {
      throw new V3StoreError("UNAVAILABLE", "the venue view changed or moved backwards");
    }
    this.observedIndex = now; return now;
  }
  /** One durable step under the owner fence. A failure rolls every row back and drops what memory holds, so the
   * next operation reads the journal as stored. */
  private transaction<T>(action: () => T): T {
    requireThat(!this.closed, "STORAGE", "store is closed");
    try { this.db.exec("BEGIN IMMEDIATE"); } catch (error) {
      // Another handle holds the database past the busy timeout: nothing was read or written here.
      if (error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message)) throw new V3StoreError("BUSY", "the journal database is held by another handle");
      throw error;
    }
    try {
      const meta = this.metadata(); this.identity(meta);
      requireThat(meta!.owner === this.owner, "FENCED", "another process owns this journal");
      requireThat(this.engine === undefined || meta!.tip === this.engine.revision, "STORAGE", "journal changed behind its owner");
      const result = action(); this.db.exec("COMMIT"); return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* an uncertain commit is read back from the rows */ }
      this.engine = undefined; throw error;
    }
  }
  private async run<T>(action: (engine: Engine) => Promise<T>): Promise<T> {
    requireThat(!this.closed, "STORAGE", "store is closed");
    requireThat(!this.busy, "BUSY", "a journal operation is in progress");
    this.busy = true;
    try { this.load(); return await action(this.engine!); }
    catch (error) {
      // Memory follows the rows only after they commit, so a refusal leaves it as it was; an unexpected failure drops it.
      if (!(error instanceof V3StoreError || error instanceof EncodingError)) this.engine = undefined;
      throw error;
    }
    finally {
      this.busy = false;
    }
  }
  /** The store the journal's own reads keep their classes and replays in. */
  private reads(): ReplayStore {
    if (this.reading === undefined) {
      try { this.reading = new ReplayStore(`${this.path}.reads`, { digest: `${this.path}.reads.sha256` }); } catch (error) {
        if (error instanceof FileInUse) throw new V3StoreError("BUSY", "another handle is reading this journal's history");
        throw error;
      }
    }
    return this.reading;
  }

  /** Memory from the rows, under the fence. Nothing is verified again: the stored state must reproduce (storage
   * decision item 7). */
  private load(): void {
    if (this.engine !== undefined) { this.transaction(() => {}); return; }
    this.engine = this.transaction(() => {
      try { return this.stored(); } catch (error) {
        if (error instanceof EncodingError) throw new V3StoreError("STORAGE", "stored journal state does not decode");
        // A lit journal reads its trail back on reopening (lit-v1 §10): a record that no longer chains is damage.
        if (error instanceof EvidenceRefusal) throw new V3StoreError("STORAGE", "the journal's own evidence does not read back");
        throw error;
      }
    });
  }
  private stored(): Engine {
    const meta = this.metadata()!, row = this.db.prepare("SELECT segment,ns FROM journal_state WHERE id=1").get();
    const found = this.db.prepare("SELECT * FROM journal_signed ORDER BY sequence DESC LIMIT 1").get();
    requireThat((row === undefined) === (meta.tip === 0n) && (row === undefined) === (found === undefined), "STORAGE", "journal state disagrees with its command log");
    if (row === undefined || found === undefined) return { revision: 0n, opened: undefined, state: undefined, last: undefined, pendingReturn: false };
    const segment = bytes(row.segment), ns = Number(row.ns), last = this.signedOf(found), identity = admissionIdentity(segment);
    requireThat(this.replays.hasNamespace(ns) && same(this.replays.identity(ns), identity) && same(this.replays.tip(ns).segment, segment),
      "STORAGE", "the admission state is not the active segment's");
    const opened = this.openedFrom(segment), state = new StateHandle(this.replays, ns, undefined, this.construction);
    requireThat(same(last.segment, segment) && same(last.commitment.operator, this.operator) && verifyCommitment(last.commitment) &&
      last.length <= state.position && last.at <= this.observedIndex, "STORAGE", "the last signed commitment is not this journal's");
    // Every signed sequence has its row, but for those a restored journal's return skipped (M13d), and the log's
    // latest signing reply is the latest row: a lost row would let the next commitment reuse its sequence.
    const count = this.db.prepare("SELECT COUNT(*) + (SELECT COALESCE(SUM(sequence - below - 1), 0) FROM journal_skipped) AS n FROM journal_signed").get()!.n;
    // Each skip spans exactly from a signed row (or nothing) to the return signed past it, with no row inside.
    for (const skip of this.db.prepare("SELECT sequence,below FROM journal_skipped").all()) {
      const rows = this.db.prepare("SELECT COUNT(*) AS n FROM journal_signed WHERE sequence>? AND sequence<?").get(skip.below as bigint, skip.sequence as bigint)!.n;
      const ends = this.db.prepare("SELECT COUNT(*) AS n FROM journal_signed WHERE sequence=? OR sequence=?").get(skip.below as bigint, skip.sequence as bigint)!.n;
      requireThat(rows === 0n && ends === (skip.below === 0n ? 1n : 2n), "STORAGE", "a skipped range disagrees with the signed rows");
    }
    const reply = this.db.prepare("SELECT response FROM events WHERE id LIKE 'command:%' ORDER BY seq DESC LIMIT 1").get()?.response;
    requireThat(count === last.commitment.sequence && reply === hexOf(last.commitment), "STORAGE", "the signed commitments disagree with the command log");
    // The roots and chains recomputed from the stored state, against the last signed snapshot of every scoped backing.
    const directory = this.retained.directory(last.commitment.root);
    requireThat(directory !== undefined && directory.length === opened.entries.length, "STORAGE", "the last signed directory is missing");
    // A construction without a note tree also rebuilds its outputs through the tip, and its imports', from the trails the
    // journal serves (lit-v1 §10): the trail through the tip is the one its admissions appended.
    const trail = this.retained.trail(segment, state.evidence);
    requireThat(trail?.length === state.position, "STORAGE", "the stored trail does not reach the admission state");
    for (const entry of directory) {
      const snapshot = this.retained.snapshot(entry.digest);
      requireThat(snapshot !== undefined && keptStateHolds(this.replays, ns, last.length, identity, this.frames.snapshot.decode(snapshot),
        this.construction, trail, this.retained), "STORAGE", "the stored state does not reproduce the last signed snapshot");
    }
    requireThat(storedTipHolds(this.replays, ns, this.construction, trail, this.retained), "STORAGE", "the stored state does not reproduce its own tip");
    // An opening other than the genesis is pending until its adoption is logged.
    const adopted = this.db.prepare("SELECT 1 FROM events WHERE id=?").get(`adopt:${opened.header.sequence}`) !== undefined;
    return { revision: meta.tip as bigint, opened, state, last, pendingReturn: !isGenesis(opened.header) && !adopted };
  }
  /** The active segment's scope from its kept head: the header and each scoped backing's terms, which its name binds. */
  private openedFrom(segment: Uint8Array): Opened {
    const [head] = this.retained.heads(segment);
    requireThat(head !== undefined, "STORAGE", "the active segment's head is missing");
    const header = this.frames.header.decodeSegmentHeader(head.header);
    return openedOf(this.frames, header, header.entries.map((entry, i) => {
      const signed = head.term(i);
      requireThat(signed !== undefined && same(this.frames.terms.rootTermsName(signed.terms), entry.backing), "STORAGE", "the active segment's terms are missing");
      return { backing: entry.backing, terms: this.frames.terms.decodeRootTerms(signed.terms), signed };
    }));
  }
  private signedOf(row: { [column: string]: unknown }): Signed {
    return { commitment: decodeCommitment(bytes(row.commitment)), segment: bytes(row.segment), length: row.length as bigint,
      at: decimal(row.at), observed: row.observed as string | null, published: row.published === 1n };
  }
  /** The commitment this journal signed at `sequence`, if any. A row holding another sequence's commitment is damage. */
  private signedAt(sequence: bigint): Signed | undefined {
    if (sequence > SQLITE_LIMIT) return undefined;
    const row = this.db.prepare("SELECT * FROM journal_signed WHERE sequence=?").get(sequence);
    if (row === undefined) return undefined;
    const signed = this.signedOf(row);
    requireThat(signed.commitment.sequence === sequence, "STORAGE", "a signed row is damaged");
    return signed;
  }
  /** A signed commitment's directory, from the evidence the journal serves. */
  private directoryOf(signed: Signed): readonly SnapshotDigest[] {
    const directory = this.retained.directory(signed.commitment.root);
    requireThat(directory !== undefined, "STORAGE", "a signed directory is missing");
    return directory;
  }

  private openRequest(scope: readonly TermsText[]): string {
    return JSON.stringify({ kind: "open", scope });
  }
  private rescopeRequest(take: readonly TermsText[], keep: readonly string[], evidence: string): string {
    return JSON.stringify({ kind: "rescope", take, keep, evidence });
  }
  private signedTerms(signed: SignedTerms): RootTerms {
    let terms: RootTerms;
    try { terms = this.frames.terms.decodeRootTerms(signed.terms); } catch (error) {
      if (error instanceof EncodingError) throw new V3StoreError("REFUSED", "the terms do not decode", "TERMS");
      throw error;
    }
    requireThat(this.frames.terms.verifyRootTermsSignature(signed.terms, signed.signature), "REFUSED", "the backer's signature does not verify");
    requireThat(same(terms.configuration, this.domain) && same(terms.venue, this.venueId), "REFUSED", "the terms name another configuration or venue");
    return terms;
  }
  /** The genesis segment of the backings `scope` names, served by this key on this venue (C2.4.1, C2.10.1, pool-v3 §8). */
  private opening(scope: readonly SignedTerms[]): Opened {
    const entries = this.scoped(scope);
    requireThat(entries.length > 0, "REFUSED", "a segment scopes at least one backing", "SCOPE");
    requireThat(entries.every(({ terms }) => same(terms.operator, this.operator)), "REFUSED", "the terms name another operator, configuration or venue");
    const header: SegmentHeader = { domain: this.domain, venue: this.venueId, operator: this.operator, sequence: 1n,
      entries: entries.map(({ backing }) => ({ backing, link: backing })) };
    return openedOf(this.frames, header, entries);
  }
  /** Authenticated terms in header order, each backing once. */
  private scoped(scope: readonly SignedTerms[]): Scoped[] {
    const entries = scope.map(signed => {
      const terms = this.signedTerms(signed);
      return { backing: this.frames.terms.rootTermsName(signed.terms), terms, signed: { terms: copyBytes(signed.terms), signature: copyBytes(signed.signature) } };
    }).sort((a, b) => compareBytes(a.backing, b.backing));
    requireThat(entries.every((entry, i) => i === 0 || !same(entries[i - 1]!.backing, entry.backing)), "REFUSED", "the scope names a backing twice", "SCOPE");
    oneClock(entries);
    return entries;
  }
  /** A backing's witnessed term chain at `at` and any pending replacement. */
  private chain(backing: Uint8Array, terms: RootTerms, at: bigint, store = this.replays): ReplacementChain {
    return replacementChain(this.answers(at, answers => answers.replacements(backing, terms.replacementRule), store),
      { backing, original: terms.operator, lag: this.lag, now: at });
  }
  /**
   * The next segment's scope at `at`, before any opening is read (C2.10.9).
   * Each taken term is this key's current successor term, ending the active
   * segment's own term for that backing; each kept backing's current term is
   * still the active segment's. An elective change, while every old term is
   * live, first needs the whole admitted tail and latest commitment witnessed.
   */
  private rescopeTarget(engine: Engine, spec: OwnRescope, at: bigint): { readonly opened: Opened; readonly taken: readonly Scoped[];
    readonly links: ReadonlyMap<string, ChainLink> } {
    const old = engine.opened, taken = this.scoped(spec.take), links = new Map<string, ChainLink>();
    requireThat(spec.keep.length === 0 || (old !== undefined && !engine.pendingReturn), "STALE", "only an adopted segment's backings can be kept");
    const kept = spec.keep.map(name => {
      const entry = old?.entries.find(scoped => same(scoped.backing, name));
      requireThat(entry !== undefined, "REFUSED", "a kept backing is outside the active scope", "SCOPE");
      return entry;
    });
    const all = [...taken, ...kept].sort((a, b) => compareBytes(a.backing, b.backing));
    requireThat(all.length > 0 && all.every((entry, i) => i === 0 || !same(all[i - 1]!.backing, entry.backing)), "REFUSED",
      "the new scope names each backing once", "SCOPE");
    oneClock(all);
    for (const entry of taken) {
      const { chain } = this.chain(entry.backing, entry.terms, at), current = chain.at(-1)!;
      requireThat(chain.length > 1 && same(current.operator, this.operator), "STALE", "this key has no current successor term");
      if (old !== undefined && old.entries.some(scoped => same(scoped.backing, entry.backing))) {
        const previous = chain.findIndex(link => same(link.link, linkOf(old, entry.backing)));
        requireThat(previous >= 0 && previous < chain.length - 1, "STALE", "the active segment's term has not ended");
      }
      links.set(bytesToHex(entry.backing), current);
    }
    let lapsed = false;
    for (const entry of old?.entries ?? []) {
      const current = this.chain(entry.backing, entry.terms, at).chain.at(-1)!;
      const live = same(current.link, linkOf(old!, entry.backing)) && same(current.operator, this.operator);
      lapsed ||= !live;
      if (kept.includes(entry)) {
        requireThat(live, "STALE", "a kept backing's term has ended");
        links.set(bytesToHex(entry.backing), current);
      }
    }
    if (old !== undefined && !lapsed) {
      const last = engine.last!;
      requireThat(!engine.pendingReturn && same(last.segment, old.segment) && last.length === engine.state!.position &&
        this.isHeld(at, last), "STALE", "an elective scope change first witnesses the whole tail", "TAIL");
    }
    const sequence = this.nextSequence(engine);
    const header: SegmentHeader = { domain: this.domain, venue: this.venueId, operator: this.operator, sequence,
      entries: all.map(({ backing }) => ({ backing, link: links.get(bytesToHex(backing))!.link })) };
    return { opened: openedOf(this.frames, header, all), taken, links };
  }
  private nextSequence(engine: Engine): bigint {
    const sequence = (engine.last?.commitment.sequence ?? 0n) + 1n;
    requireThat(sequence < SQLITE_LIMIT && sequence < U64, "STORAGE", "signed sequence counter exhausted");
    return sequence;
  }
  /** The journal's reads go through the public reader over the evidence it serves, keeping their classes and
   * replays (§14), so a later read verifies only what it has not. The fence is checked first: a replaced
   * owner reads and keeps nothing. */
  private readerOptions(store?: ReplayStore, evidence: EvidenceStore = this.evidence) {
    this.transaction(() => {});
    // The journal reads its own state, clock and force, never the listing of its carrying checkpoints, which grows
    // by one row per checkpoint and would otherwise be read before every admission (M11c2).
    return { construction: this.construction, verifier: this.verifier, venue: this.venue, reference: this.reference,
      store: store ?? this.reads(), evidence, carrying: false };
  }
  /** One read through the public reader. A kept file another handle is writing leaves the operation BUSY. */
  private async whileReading<T>(read: () => Promise<T>): Promise<T> {
    try { return await read(); } catch (error) {
      if (error instanceof FileInUse) throw new V3StoreError("BUSY", "another handle is reading this journal's history");
      throw error;
    }
  }
  /** A fresh admission state for a segment, kept under the journal's own identity, over its import: the
   * frontier a read replayed, copied into this database inside the command's transaction. */
  private segmentState(segment: Uint8Array, imported: ImportSource | undefined): SegmentState {
    if (imported === undefined) return openSegmentState(this.replays, segment, admissionIdentity(segment), undefined, this.construction);
    const frontier = imported instanceof StateHandle ? imported.frontier() : imported.frontier;
    return openSegmentState(this.replays, segment, admissionIdentity(segment),
      { store: this.replays, frontier: this.replays.copyFrontier(imported.store, frontier, importIdentity) }, this.construction);
  }
  /** Read every opening from bytes: a taken term by the public reader's
   * complete descent of the evidence, including proof of an empty book, and a
   * kept backing by the journal's own canonical read. No asserted state,
   * selected predecessor or imported signing counter (C2.7, C2.10.4–7). The
   * supplied evidence is read in a store of its own, beside a copy of what the
   * journal serves, and joins the journal's evidence only in the transaction
   * that signs the opening: a refused scope change keeps none of it. */
  private async planRescope(engine: Engine, spec: OwnRescope, at: bigint, target: ReturnType<V3OperatorJournal["rescopeTarget"]>):
    Promise<{ readonly opened: Opened; readonly imported: ImportSource | undefined; readonly evidence: Uint8Array | undefined;
      readonly taken: readonly (readonly [number, Uint8Array])[] }> {
    const openings = new Map<string, CanonicalCheckpoint | undefined>(), taken: [number, Uint8Array][] = [];
    let evidence = spec.evidence;
    const supplied = new EvidenceStore(":memory:", { construction: this.construction });
    try {
    const unestablished = (error: unknown): never => {
      if ((error instanceof EvidenceRefusal && error.status === "resource-refusal") || error instanceof PackageLimitError) {
        throw new V3StoreError("REFUSED", "takeover evidence exceeds the reader's budget", "RESOURCE");
      }
      if (error instanceof EvidenceRefusal || error instanceof ReplayRefusal || error instanceof EncodingError) {
        throw new V3StoreError("UNAVAILABLE", "the public evidence does not establish the takeover state");
      }
      throw error;
    };
    if (target.taken.length > 0) {
      // Only public dependencies are read from the supplied package: directories, snapshots, trails and, for
      // these reads alone, faults. The first three are served from now on beside the journal's own.
      try {
        const provided = this.frames.package.decodeEvidencePackage(spec.evidence).filter(item => [3, 4, 6, 7].includes(item.kind));
        for (const item of provided) if (item.kind !== 7) taken.push([item.kind, sha256(item.payload)]);
        evidence = this.frames.package.encodeEvidencePackage(provided);
      } catch (error) { unestablished(error); }
    }
    // A journal with history reads its own checkpoints beside the public evidence: a taken term may follow,
    // or already hold, one of this key's (C2.7.1).
    if (target.taken.length > 0 && engine.last !== undefined) {
      try { requireThat(await supplied.take(this.parts(engine.last, 0n)), "STORAGE", "the journal's own evidence does not read back"); } catch (error) {
        if (error instanceof EvidenceRefusal || error instanceof EncodingError) throw new V3StoreError("STORAGE", "the journal's own evidence does not read back");
        if (error instanceof PackageLimitError) unestablished(error);
        throw error;
      }
    }
    for (const entry of target.taken) {
      let source: FrontierResult;
      try { source = await this.whileReading(() => readFrontier(evidence, entry.signed, at, this.readerOptions(undefined, supplied))); } catch (error) { return unestablished(error); }
      const current = source.ranges.chain.at(-1)!;
      requireThat(same(current.link, target.links.get(bytesToHex(entry.backing))!.link), "STALE", "the replacement chain changed during takeover");
      requireThat(source.canonical === undefined || source.canonical.index < current.from, "STALE", "the current successor term already has a carrying checkpoint");
      openings.set(bytesToHex(entry.backing), source.canonical);
    }
    for (const name of spec.keep) {
      const source = await this.currentRead(engine, at, name);
      openings.set(bytesToHex(name), source.canonical);
    }
    // One import per distinct canonical checkpoint; several are merged once (C2.10.6–7).
    const parents = new Map<string, CanonicalCheckpoint>();
    for (const canonical of openings.values()) if (canonical !== undefined) parents.set(hexOf(canonical.commitment)!, canonical);
    const imported = this.openingImports([...parents.values()]);
    const header: SegmentHeader = { ...target.opened.header, entries: target.opened.header.entries.map(entry => {
      const canonical = openings.get(bytesToHex(entry.backing));
      return canonical === undefined ? entry : { ...entry, opening: { operator: copyBytes(canonical.commitment.operator),
        sequence: canonical.commitment.sequence, root: copyBytes(canonical.commitment.root) } };
    }) };
    return { opened: openedOf(this.frames, header, target.opened.entries), imported, taken, evidence: target.taken.length > 0 ? evidence : undefined };
    } finally { supplied.close(); }
  }
  /** An opening's import: the one parent's state, or the parents' merged finalized prefixes (C2.10.6). */
  private openingImports(parents: readonly CanonicalCheckpoint[]): ImportSource | undefined {
    let merged;
    try { merged = mergeFinalizedPrefixes(this.reads(), parents.map(parent => ({ state: parent.state }))); } catch (error) {
      if (error instanceof ReplayRefusal) throw new V3StoreError("UNAVAILABLE", "the imported histories conflict");
      throw error;
    }
    return parents.length === 0 ? undefined : parents.length === 1 ? parents[0]!.state : merged;
  }
  /** Each scoped K's revocation index as witnessed through `at`, an index the view reaches. */
  private revocations(view: View, at: bigint): Map<string, bigint | undefined> {
    return new Map([...view.revocations].map(([name, revoked]) => [name, revoked !== undefined && revoked <= at ? revoked : undefined]));
  }
  /** Admission, or an adopted block's judgment, under the scope's terms and each scoped K's revocation. */
  private replayOf(opened: Opened, horizon: bigint, revocations: ReadonlyMap<string, bigint | undefined>): SegmentReplay {
    const first = opened.entries[0]!, scoped = opened.entries.length > 1;
    return { domain: this.domain, backing: first.backing, segment: opened.segment, scope: opened.scope, terms: first.terms,
      ...(scoped ? { scopedTerms: new Map(opened.entries.map(entry => [bytesToHex(entry.backing), entry.terms])), revocations } :
        { revokedAt: revocations.get(bytesToHex(first.backing)) }),
      verifier: this.verifier, index: horizon, lag: this.lag, admission: true, block: [] };
  }
  /** Every scoped backing's current snapshot and the directory over them (§7, C2.10.3). */
  private checkpoint(opened: Opened, state: SegmentState): { readonly directory: readonly SnapshotDigest[]; readonly snapshots: readonly Uint8Array[] } {
    const snapshots: Snapshot[] = opened.entries.map(({ backing }) => {
      const totals = state.total(bytesToHex(backing));
      return { backing, segment: opened.segment, historyHash: state.history, evidenceHash: state.evidence, issued: totals.issued, burned: totals.burned };
    });
    return { directory: snapshots.map(s => ({ name: copyBytes(s.backing), digest: this.frames.snapshot.digest(s) })), snapshots: snapshots.map(this.frames.snapshot.bytes) };
  }
  /** The receipt of the record just applied at the state's position (§7.2), after the last signed commitment. */
  private receipt(opened: Opened, state: SegmentState, judged: Judged<unknown>, after: bigint): Uint8Array {
    return this.construction.journal.receipt({ domain: this.domain, segment: opened.segment, scopeRoot: opened.scope, position: state.position,
      digests: judged.digests, historyHash: state.history, after }, this.operator, message => ed25519.sign(message, this.secret));
  }

  // --- Inside a command's transaction: each writes rows that commit with the command's log row. ---

  /** Apply one judged record to the admission state, keep its bytes in the segment's served trail and sign its
   * receipt. `submit` answers a statement it holds a receipt for, so only adoption finds a row: one a discarded
   * tail was given (C2b.4.1), never a live admission, since force refuses a recovery statement already effective
   * (REPEATED_STATEMENT). The adopted statement's receipt replaces it (C2b.4.2, §7.2); the tail's stays in the
   * command log. */
  private admit(engine: Engine, judged: Judged<unknown>, replay: SegmentReplay): Uint8Array {
    const opened = engine.opened!, state = engine.state!;
    const tip = { segment: opened.segment, position: state.position, evidence: state.evidence };
    applyJudged(state, judged, replay);
    this.evidence.append(tip, judged.bytes);
    const receipt = this.receipt(opened, state, judged, engine.last!.commitment.sequence);
    this.db.prepare("INSERT INTO journal_receipt VALUES(?,?) ON CONFLICT(statement) DO UPDATE SET receipt=excluded.receipt").run(judged.identity, receipt);
    return receipt;
  }
  /** Sign the commitment at `sequence` over `state`'s directory, and keep the directory and snapshots that serve it. */
  private sign(opened: Opened, state: SegmentState, sequence: bigint, at: bigint, observed: string | null): Signed {
    const { directory, snapshots } = this.checkpoint(opened, state);
    // One encoding of the directory: the root signed is the hash of the preimage kept.
    const preimage = encodeEvidenceDirectory(directory);
    const commitment = signCommitment(this.secret, sequence, sha256(preimage));
    this.evidence.keep(3, preimage);
    for (const snapshot of snapshots) this.evidence.keep(4, snapshot);
    this.db.prepare("INSERT INTO journal_signed VALUES(?,?,?,?,?,?,0)").run(sequence, encodeCommitment(commitment), opened.segment,
      state.position, at.toString(), observed);
    return { commitment, segment: opened.segment, length: state.position, at, observed, published: false };
  }
  /** Open a segment's admission state over its import, keep its head as evidence and sign its empty opening;
   * the state of the segment it replaces, which nothing imports, goes. */
  private openSegment(engine: Engine, opened: Opened, imported: ImportSource | undefined, at: bigint, observed: string | null):
    { readonly state: SegmentState; readonly signed: Signed } {
    const state = this.segmentState(opened.segment, imported);
    if (engine.state !== undefined) this.replays.drop(engine.state.ns);
    this.evidence.keepHead(opened.headerBytes, opened.entries.map(entry => entry.signed));
    const signed = this.sign(opened, state, opened.header.sequence, at, observed);
    this.db.prepare("INSERT INTO journal_state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET segment=excluded.segment,ns=excluded.ns").run(opened.segment, state.ns);
    return { state, signed };
  }
  private append(engine: Engine, id: string, request: string, command: Command, response: string): void {
    requireThat(engine.revision < SQLITE_LIMIT, "STORAGE", "journal is full");
    this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?)").run(engine.revision + 1n, id, request, JSON.stringify(command), response);
    this.db.prepare("UPDATE identity SET tip=?,observed=? WHERE id=1").run(engine.revision + 1n, this.observedIndex.toString());
    // Memory follows only after SQLite commits; every uncertain outcome reads the rows again.
  }

  /** The journal's kept §13 answers through `at` (§§13.2–13.3), by default in its own database, where no
   * reader's quota bounds them. Extending one there writes, so it runs inside a journal transaction, under
   * the fence. A venue that cannot answer, or one index past the venue's bound for an index, leaves the
   * operation unavailable. */
  private answers<T>(at: bigint, read: (answers: KeptAnswers) => T, store = this.replays): T {
    if (store === this.replays && !this.db.isTransaction) throw new Error("venue answers are kept inside a journal transaction");
    try { return read(keptAnswers(this.venue, this.venueId, store, at, () => {})); } catch (error) {
      if (error instanceof EvidenceRefusal || error instanceof RangeLimitError || error instanceof EncodingError) {
        throw new V3StoreError("UNAVAILABLE", "the venue has no answer");
      }
      throw error;
    }
  }
  /** C2.3.3 selects held state; it does not erase evidence that another process has signed with this key
   * (§13.3, invariant 22). Exact local bytes were authenticated when signed. Every other same-key record of
   * a newly read window is verified before it counts as a conflict, including old twins. */
  private foreign(window: RangeAnswer): RangeEntry | undefined {
    return window.entries.find(entry => {
      let c: Commitment, own: Signed | undefined;
      try { c = decodeCommitment(entry.record); }
      catch (error) { if (error instanceof EncodingError) return false; throw error; }
      try { own = this.signedAt(c.sequence); }
      catch (error) { if (error instanceof EncodingError) throw new V3StoreError("STORAGE", "a signed row does not decode"); throw error; }
      if (own !== undefined && same(encodeCommitment(own.commitment), entry.record)) return false;
      if (!same(c.operator, this.operator) || !verifyCommitment(c)) return false;
      if (own === undefined && this.lostInstance(c.sequence)) return false;
      // This journal's own row at that sequence that no longer verifies as its commitment is damage, not another signer's.
      requireThat(own === undefined || (same(own.commitment.operator, this.operator) && verifyCommitment(own.commitment)), "STORAGE",
        "a signed row is damaged");
      return true;
    });
  }
  /**
   * The venue through `now`, from the answers `store` keeps: this key's held commitments, read by windows
   * past the index they are kept through, and every scoped backing's term chain and K's revocation; the
   * scope's schedule follows its earliest term boundary (C2.10.9). `found` is given the first record of a
   * newly read window that this key signed and this journal did not; `conflicted` says whether one was ever found.
   */
  private observe(opened: Opened | undefined, now: bigint, store: ReplayStore, found: (entry: RangeEntry) => void, conflicted: () => boolean): View {
    this.answers(now, answers => answers.held(this.operator, window => {
      // One conflict ends service for good, so later windows are not searched for another.
      const entry = conflicted() ? undefined : this.foreign(window);
      if (entry !== undefined) found(entry);
    }), store);
    const boundaries: bigint[] = [], revocations = new Map<string, bigint | undefined>();
    for (const { backing, terms } of opened?.entries ?? []) {
      const { chain, pending } = this.chain(backing, terms, now, store);
      const term = chain.findIndex(link => same(link.link, linkOf(opened!, backing)) && same(link.operator, this.operator));
      requireThat(term >= 0, "STALE", "the segment's term is not in the witnessed chain");
      const end = chain[term + 1]?.from ?? pending?.from;
      if (end !== undefined) boundaries.push(end);
      revocations.set(bytesToHex(backing), this.answers(now, answers => answers.revocation(terms.obligor), store));
    }
    return { now, lag: this.lag, latest: store.previousHeld(this.operator, now, undefined, now), conflict: conflicted(), boundaries, revocations };
  }
  /** Inside a journal transaction: the view at the venue's clock, from the journal's kept answers. The first
   * conflict found is kept with the answer that showed it, so it stands for every later command. The clock
   * the answers reach is recorded, so a restart refuses a venue that is behind them. */
  private viewed(opened: Opened | undefined): View {
    const now = this.clock();
    if (decimal(this.metadata()!.observed) < now) this.db.prepare("UPDATE identity SET observed=? WHERE id=1").run(now.toString());
    const conflict = (): boolean => this.db.prepare("SELECT 1 FROM journal_conflict WHERE id=1").get() !== undefined;
    return this.observe(opened, now, this.replays, entry => {
      this.db.prepare("INSERT OR IGNORE INTO journal_conflict VALUES(1,?,?)").run(entry.index.toString(), entry.record);
    }, conflict);
  }
  /** A transaction that only keeps venue answers. Each answer is kept whole or not at all, with any conflict
   * its windows showed, so what was kept before a refusal stands: the refusal is given once that is committed,
   * and memory is left as it was. */
  private keeping<T>(read: () => T): T {
    let refused = undefined as V3StoreError | undefined;
    const result = this.transaction(() => {
      try { return read(); } catch (error) {
        if (!(error instanceof V3StoreError)) throw error;
        refused = error; return undefined;
      }
    });
    if (refused !== undefined) throw refused;
    return result as T;
  }
  private view(engine: Engine): View {
    return this.keeping(() => this.viewed(engine.opened));
  }
  private exclusive(view: View): void {
    requireThat(!view.conflict, "CONFLICT", "the venue contains a commitment this journal did not sign");
  }
  /** Inside a command's transaction: the venue's clock has not moved since `view` was read, so every answer
   * the command was judged by still stands (a witnessed index is final, §§13.1–13.2). */
  private stable(view: View): void {
    requireThat(this.clock() === view.now, "STALE", "the venue changed during the journal operation");
  }
  /** This key's latest commitment the venue holds at or below `index`, below sequence `before` if given; the
   * view has kept them through its clock. */
  private heldBelow(index: bigint, before?: bigint): HeldCommitment | undefined {
    return this.replays.previousHeld(this.operator, index, before, index);
  }
  private signingSchedule(view: View, admission = false): void {
    const schedule = scopeSchedule({ now: view.now, lag: view.lag, boundaries: view.boundaries,
      ...(this.resumedAt === undefined ? {} : { resumedAt: this.resumedAt }) });
    requireThat(!schedule.lapsed, "STALE", "the operator's term has ended");
    requireThat(admission ? schedule.admissionOpen : schedule.commitNow, "SCHEDULE", "the scope's signing schedule is closed");
  }
  /** Whether the venue holds exactly the commitment this journal signed at that sequence. */
  private ownHeld(held: HeldCommitment): Signed | undefined {
    const signed = this.signedAt(held.commitment.sequence);
    return signed !== undefined && hexOf(signed.commitment) === hexOf(held.commitment) ? signed : undefined;
  }
  /** Whether the venue holds exactly `signed` by index `at`, which the kept answers reach. */
  private isHeld(at: bigint, signed: Signed): boolean {
    return hexOf(this.replays.heldAt(this.operator, signed.commitment.sequence, at)?.commitment) === hexOf(signed.commitment);
  }
  /** Service needs the current signed state, the scope's schedule open, and for issuance an unrevoked backer. */
  private async ready(engine: Engine, view: View, action: "admit" | "commit"): Promise<void> {
    this.exclusive(view);
    this.unrestored();
    const opened = engine.opened, state = engine.state, last = engine.last;
    requireThat(opened !== undefined && state !== undefined && last !== undefined, "STALE", "open the segment first");
    requireThat(!engine.pendingReturn, "STALE", "the return opening must be witnessed and its block adopted before service");
    const latest = hexOf(view.latest?.commitment);
    const current = latest === hexOf(last.commitment) || (last.published && view.now < last.at + view.lag && latest === last.observed);
    requireThat(current, "STALE", "the signed state is not current");
    const schedule = scopeSchedule({ now: view.now, lag: view.lag, boundaries: view.boundaries,
      ...(this.isHeld(view.now, last) ? {} : { unwitnessedSignedAt: last.at }), ...(this.resumedAt === undefined ? {} : { resumedAt: this.resumedAt }) });
    requireThat(!schedule.lapsed, "STALE", "the operator's term has ended");
    requireThat(action === "admit" ? schedule.admissionOpen : schedule.commitNow, "SCHEDULE", "the scope's signing schedule is closed");
    if (this.db.prepare("SELECT 1 FROM journal_taken LIMIT 1").get() !== undefined ||
        opened.entries.some(({ terms }) => terms.silence !== undefined || terms.nonService !== undefined)) {
      const source = await this.currentRead(engine, view.now);
      this.serviceClock(source, view.now);
    }
    for (const { backing } of opened.entries) {
      const revokedAt = view.revocations.get(bytesToHex(backing));
      if (revokedAt === undefined) continue;
      // Only issuance finalized before K's revocation stays; a later tail needs recovery (slice 3). The active
      // segment's commitments are this key's from its opening sequence on, each at least as long as the one
      // before, so the latest of them held before the revocation carries the finalized length.
      let finalized = 0n;
      for (let held = revokedAt === 0n ? undefined : this.heldBelow(revokedAt - 1n);
        held !== undefined && held.commitment.sequence >= opened.header.sequence; held = this.heldBelow(revokedAt - 1n, held.commitment.sequence)) {
        const signed = this.ownHeld(held);
        if (signed !== undefined && same(signed.segment, opened.segment)) { finalized = signed.length; break; }
      }
      requireThat(!state.hasIssuanceAfter(finalized, bytesToHex(backing)), "UNSUPPORTED", "issuance without pre-revocation finality needs recovery");
    }
  }

  /** Read all dependencies from the evidence the journal serves, including
   * later lapsed/excluded signed checkpoints. Trying an older selection never
   * omits those checkpoints. The read selects `backing` (by default the
   * scope's first) in any scope; its package is only the configuration and the
   * selected commitment, since every other object is retained. */
  private async currentRead(engine: Engine, at: bigint, backing = engine.opened?.entries[0]!.backing, audit?: ReplayStore): Promise<StateRead> {
    requireThat(engine.opened !== undefined && backing !== undefined, "STALE", "there is no segment to read");
    let carried = false;
    for (let candidate = this.heldBelow(at); candidate !== undefined; candidate = this.heldBelow(at, candidate.commitment.sequence)) {
      const signed = this.ownHeld(candidate);
      if (signed === undefined || !this.directoryOf(signed).some(entry => same(entry.name, backing))) continue;
      carried = true;
      const c = signed.commitment;
      const selected = this.ownPackage(c);
      try {
        const result = await this.whileReading(() => readPackage(selected, { mode: "historical-fixture", domain: this.domain, venue: this.venueId,
          backing, operator: this.operator, sequence: c.sequence, root: c.root, judgingIndex: at }, this.readerOptions(audit)));
        requireThat(result.state !== undefined, "UNAVAILABLE", "a journal state read returned a receipt");
        return result;
      } catch (error) {
        // An audit does not pass over a witnessed checkpoint of its own that a reader excludes.
        if (error instanceof ReplayRefusal && audit !== undefined) throw new V3StoreError("STORAGE", `a witnessed checkpoint does not replay: ${error.check}`, error.check);
        if (error instanceof ReplayRefusal || (error instanceof EvidenceRefusal && error.status === "lapsed-selection")) continue;
        if (error instanceof EvidenceRefusal) throw new V3StoreError("UNAVAILABLE", `canonical evidence: ${error.status}`);
        throw error;
      }
    }
    throw new V3StoreError("UNAVAILABLE", "no canonical witnessed checkpoint is available", carried ? undefined : "UNCARRIED");
  }

  /** A read's own §12 package: the configuration and the selected commitment, in the construction's frame. */
  private ownPackage(commitment: Commitment): Uint8Array {
    return this.frames.package.encodeEvidencePackage([{ kind: 1, payload: this.construction.journal.configuration() },
      { kind: 2, payload: encodeCommitment(commitment) }]);
  }

  private serviceClock(source: StateRead, now: bigint): void {
    const clock = source.clock;
    if (clock === null) return;
    if (clock.boundary !== null && BigInt(clock.boundary) <= now) throw new V3StoreError("STALE", "the segment is permanently retired by silence", "SILENCE");
    if (now + this.lag - source.canonical.index > BigInt(clock.duration)) {
      throw new V3StoreError("SCHEDULE", "the witnessing horizon reaches silence", "SILENCE");
    }
  }

  /** Forced publications after the canonical state's adoption index of their
   * backing, through its index, in venue order: an opening's exact block (C2b.4.1). */
  private unadopted(source: StateRead): readonly ScopeForcedPublication[] {
    const { state, canonical } = source;
    return source.force.filter(event => event.index <= canonical.index &&
      event.index > (state.adoptionIndices.get(event.backing) ?? 0n));
  }

  /** The empty successor of the active segment at a witnessed silence boundary (C2b.4.1): the whole scope
   * returns from its one canonical checkpoint (C2.10.3). Old bytes stay as evidence, not live accepted state. */
  private returnOpening(engine: Engine, source: StateRead, at: bigint, restored?: bigint): Opened {
    const old = engine.opened!;
    requireThat(!engine.pendingReturn && source.clock?.boundary !== null && source.clock?.boundary !== undefined &&
      BigInt(source.clock.boundary) <= at && same(source.canonical.segment, old.segment), "STALE", "return needs the active segment's witnessed silence boundary", "SILENCE");
    const sequence = restored ?? this.nextSequence(engine), predecessor = source.canonical.commitment;
    const header: SegmentHeader = { ...old.header, sequence, entries: old.header.entries.map(({ backing, link }) => ({ backing, link,
      opening: { operator: copyBytes(predecessor.operator), sequence: predecessor.sequence, root: copyBytes(predecessor.root) } })) };
    return openedOf(this.frames, header, old.entries);
  }

  /** C2b.4.1: sign an empty successor only after witnessed silence. This does
   * not authorize service; publish, wait for witnessing, then call adopt(). */
  async return(id: string): Promise<Commitment> {
    const commandId = this.commandId(id);
    return this.run(async engine => {
      const prior = this.prior(commandId, "return");
      if (prior !== undefined) {
        // Under a restoration, only its own return answers again; an earlier return's identifier signs nothing and is refused.
        const answered = decodeCommitment(hexToBytes(prior)), fence = this.restoration();
        requireThat(fence === undefined || fence.opening === answered.sequence, "RESTORED", "this identifier names a return before this restoration: use a new --id");
        return answered;
      }
      const view = this.view(engine);
      this.exclusive(view);
      requireThat(engine.opened !== undefined && !engine.pendingReturn, "STALE", "a return is already pending or no segment exists");
      const fence = this.restoration();
      requireThat(fence?.opening === undefined, "RESTORED", "the restoration's opening is signed: adopt it");
      const schedule = scopeSchedule({ now: view.now, lag: view.lag, boundaries: view.boundaries,
        ...(this.resumedAt === undefined ? {} : { resumedAt: this.resumedAt }) });
      requireThat(!schedule.lapsed && schedule.commitNow, "SCHEDULE", "return signing is outside the operator's term");
      const source = await this.currentRead(engine, view.now);
      const restored = fence === undefined ? undefined : this.restoredSequence(engine, view.now, fence.spacing);
      const opened = this.returnOpening(engine, source, view.now, restored), observed = hexOf(view.latest?.commitment);
      const { state, signed } = this.transaction(() => {
        this.stable(view);
        if (restored !== undefined) this.restoredOpening(engine, restored);
        const next = this.openSegment(engine, opened, source.state, view.now, observed);
        this.append(engine, commandId, "return", { kind: "return", at: view.now.toString(), observed }, bytesToHex(encodeCommitment(next.signed.commitment)));
        return next;
      });
      engine.opened = opened; engine.state = state; engine.last = signed; engine.pendingReturn = true; engine.revision++;
      return copyCommitment(signed.commitment);
    });
  }

  /** C2b.4.2: wait for the actual opening index r and re-read through r before
   * co-signing its exact adopted block: the verified opening determines it, and
   * force was checked by the reader at each original index. The block, its
   * receipts and the end of the pending return commit together. Exact retry
   * returns the same receipts. */
  async adopt(): Promise<readonly Uint8Array[]> {
    return this.run(async engine => {
      const opened = engine.opened, state = engine.state, last = engine.last;
      requireThat(opened !== undefined && state !== undefined && last !== undefined, "STALE", "no return opening exists");
      const id = `adopt:${opened.header.sequence}`, prior = this.prior(id, "adopt");
      if (prior !== undefined) return (JSON.parse(prior) as string[]).map(hexToBytes);
      requireThat(engine.pendingReturn, "STALE", "the segment is not a pending return");
      const view = this.view(engine), held = this.replays.heldAt(this.operator, opened.header.sequence, view.now);
      this.exclusive(view);
      this.signingSchedule(view, true);
      requireThat(held !== undefined && hexOf(held.commitment) === hexOf(last.commitment), "UNAVAILABLE", "the return opening is not witnessed");
      const current = await this.currentRead(engine, view.now);
      this.serviceClock(current, view.now);
      const source = await this.currentRead(engine, held.index);
      requireThat(source.canonical.commitment.sequence === opened.header.sequence && same(source.canonical.segment, opened.segment),
        "STALE", "the witnessed opening is not this return");
      const block = this.unadopted(source);
      const replay: SegmentReplay = { ...this.replayOf(opened, source.canonical.index, this.revocations(view, source.canonical.index)),
        admission: false, block };
      const receipts = this.transaction(() => {
        this.stable(view); this.signingSchedule(view, true);
        let signed: Uint8Array[];
        // The reader forced each record at its own index; one the opening's state refuses leaves the block unadopted,
        // named by its check like any admission refusal, and nothing of it is kept.
        try { signed = block.map(event => this.admit(engine, judgeAdopted(state, event.bytes, replay), replay)); } catch (error) {
          if (error instanceof ReplayRefusal) throw new V3StoreError("REFUSED", `adoption refused: ${error.check}`, error.check);
          throw error;
        }
        this.append(engine, id, "adopt", { kind: "adopt", at: held.index.toString(), opening: opened.header.sequence.toString() }, JSON.stringify(signed.map(bytesToHex)));
        // Adopting the restoration's own return lifts its fence: the new segment's receipts start at its own
        // positions, and what was co-signed after the last witnessed commitment was never final (C2b.4). An opening
        // pending when the copy was made is adopted exactly as the lost instance would (the same record gives the same
        // receipts) and leaves the fence standing.
        if (this.restoration()?.opening === opened.header.sequence) this.db.prepare("DELETE FROM journal_restored WHERE id=1").run();
        return signed;
      });
      engine.pendingReturn = false; engine.revision++;
      return receipts.map(copyBytes);
    });
  }

  /** Fenced lookup of an earlier command's reply; the same identifier with other content conflicts. */
  private prior(id: string, request: string): string | undefined {
    const row = this.transaction(() => {
      const found = this.db.prepare("SELECT request,response FROM events WHERE id=?").get(id);
      return found === undefined ? undefined : { request: found.request, response: found.response };
    });
    if (row === undefined) return undefined;
    requireThat(row.request === request && typeof row.response === "string", "CONFLICT", "command identifier names different content");
    return row.response;
  }
  private commandId(id: string): string {
    requireThat(typeof id === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(id), "CONFLICT", "invalid command identifier");
    return `command:${id}`;
  }

  /** Open and sign the genesis segment of the backings `signed` names, one or
   * several (C2.4.1, C2.10.1). Publishing is explicit. */
  async open(id: string, signed: SignedTerms | readonly SignedTerms[]): Promise<Commitment> {
    const commandId = this.commandId(id);
    const own = (isTermsList(signed) ? [...signed] : [signed]).map(s => ({ terms: copyBytes(s?.terms), signature: copyBytes(s?.signature) }));
    const scope = own.map(termsText), request = this.openRequest(scope);
    return this.run(async engine => {
      const prior = this.prior(commandId, request);
      if (prior !== undefined) return decodeCommitment(hexToBytes(prior));
      this.unrestored();
      requireThat(engine.opened === undefined, "UNSUPPORTED", "the journal holds one genesis segment");
      const opened = this.opening(own), view = this.view(engine);
      this.exclusive(view);
      requireThat(view.latest === undefined, "CONFLICT", "this key already has commitments on the venue");
      // A witnessed replacement ends a term at its effective index: the opening is signed by C2.6.1's last signing index.
      const boundaries = this.keeping(() => {
        const ends: bigint[] = [];
        for (const { backing, terms } of opened.entries) {
          const { chain, pending } = this.chain(backing, terms, view.now);
          requireThat(chain.length === 1, "STALE", "the operator's term has ended");
          requireThat(this.answers(view.now, answers => answers.revocation(terms.obligor)) === undefined, "UNSUPPORTED", "the backer has revoked K");
          if (pending !== undefined) ends.push(pending.from);
        }
        return ends;
      });
      const schedule = scopeSchedule({ now: view.now, lag: view.lag, boundaries,
        ...(this.resumedAt === undefined ? {} : { resumedAt: this.resumedAt }) });
      requireThat(schedule.commitNow, "SCHEDULE", "the opening's signing schedule is closed");
      const { state, signed: first } = this.transaction(() => {
        this.stable(view);
        const next = this.openSegment(engine, opened, undefined, view.now, null);
        this.append(engine, commandId, request, { kind: "open", scope, at: view.now.toString(), observed: null }, bytesToHex(encodeCommitment(next.signed.commitment)));
        return next;
      });
      engine.opened = opened; engine.state = state; engine.last = first; engine.revision++;
      return copyCommitment(first.commitment);
    });
  }

  /**
   * C2.7, C2.10.9: sign the empty opening of a new scope at a committed
   * boundary. Taken successor terms import from `evidence` alone; kept
   * backings of the active scope import the journal's own canonical state;
   * backings left out are dropped. The opening must be published, witnessed
   * and adopted before service.
   */
  async rescope(id: string, change: Rescope): Promise<Commitment> {
    const commandId = this.commandId(id);
    const take = [...(change?.take ?? [])].map(s => ({ terms: copyBytes(s?.terms), signature: copyBytes(s?.signature) }));
    const keep = [...(change?.keep ?? [])].map(name => copyBytes(name));
    const evidence = change?.evidence === undefined ? new Uint8Array() : copyBytes(change.evidence);
    requireThat(keep.every(name => name.length === 32) && (take.length > 0) === (change?.evidence !== undefined), "REFUSED",
      "evidence accompanies exactly the taken terms; kept backings are 32-byte names", "SCOPE");
    const own: OwnRescope = { take, keep, evidence };
    // The command names its evidence by hash: the evidence itself is kept once, among what the journal serves.
    const texts = take.map(termsText), names = keep.map(name => bytesToHex(name)), named = bytesToHex(sha256(evidence));
    const request = this.rescopeRequest(texts, names, named);
    return this.run(async engine => {
      const prior = this.prior(commandId, request);
      if (prior !== undefined) return decodeCommitment(hexToBytes(prior));
      // A scope change, a repair among them, would excuse a tail its lost instance co-signed (C2.10.9): a restored
      // journal only returns (M13d).
      this.unrestored();
      const { at, target, view } = this.keeping(() => {
        // This key's held commitments are kept through the clock first: the target's checks read them.
        const at = this.viewed(undefined).now, target = this.rescopeTarget(engine, own, at), view = this.viewed(target.opened);
        requireThat(view.now === at, "STALE", "the venue changed during the scope change");
        return { at, target, view };
      });
      this.exclusive(view); this.signingSchedule(view);
      const plan = await this.planRescope(engine, own, at, target), opened = plan.opened, observed = hexOf(view.latest?.commitment);
      const { state, signed } = this.transaction(() => {
        this.stable(view);
        const next = this.openSegment(engine, opened, plan.imported, at, observed);
        // What was taken joins the evidence the journal serves, with the opening it supports.
        if (plan.evidence !== undefined) this.evidence.importBytes(plan.evidence).release();
        // Each taken object is served from the opening that took it on. One taken again is named under the later
        // opening too: that take may bring the trail or terms its first one lacked.
        const taken = this.db.prepare("INSERT OR IGNORE INTO journal_taken VALUES(?,?,?)");
        for (const [kind, hash] of plan.taken) taken.run(next.signed.commitment.sequence, kind, hash);
        this.append(engine, commandId, request, { kind: "rescope", take: texts, keep: names, evidence: named, at: at.toString(), observed },
          bytesToHex(encodeCommitment(next.signed.commitment)));
        return next;
      });
      engine.opened = opened; engine.state = state; engine.last = signed; engine.pendingReturn = true; engine.revision++;
      return copyCommitment(signed.commitment);
    });
  }

  /** C2.7: activate one witnessed successor term from public evidence alone;
   * a `rescope` that takes that term and keeps nothing else. */
  takeover(id: string, signed: SignedTerms, evidence: Uint8Array): Promise<Commitment> {
    return this.rescope(id, { take: [signed], evidence });
  }

  /**
   * Admit one kind 1–6 record at the horizon (the read index plus the lag)
   * and return its original signed receipt record (§7.2). An exact statement
   * already admitted returns its original receipt, even with another proof.
   * The proof is verified before the transaction that applies the record,
   * keeps its bytes and signs its receipt, all or nothing.
   */
  async submit(record: Uint8Array): Promise<Uint8Array> {
    let own: Uint8Array, statement: Uint8Array;
    const { decode, journal } = this.construction;
    try { own = journal.encode(decode(copyBytes(record))); statement = journal.identity(decode(own)); } catch (error) {
      if (error instanceof EncodingError) throw new V3StoreError("REFUSED", "the record does not decode", "MALFORMED");
      throw error;
    }
    const hash = bytesToHex(statement);
    return this.run(async engine => {
      const prior = this.db.prepare("SELECT receipt FROM journal_receipt WHERE statement=?").get(statement);
      if (prior !== undefined) return bytes(prior.receipt);
      const view = this.view(engine);
      await this.ready(engine, view, "admit");
      const opened = engine.opened!, state = engine.state!, horizon = view.now + view.lag;
      requireThat(horizon < U64, "SCHEDULE", "the horizon is past the venue's index space");
      const replay = this.replayOf(opened, horizon, view.revocations);
      let judged: Judged<unknown>;
      try { judged = await judgeRecord(state, own, replay); }
      catch (error) {
        if (error instanceof ReplayRefusal) throw new V3StoreError("REFUSED", `admission refused: ${error.check}`, error.check);
        if (error instanceof EvidenceRefusal) throw new V3StoreError("UNSUPPORTED", "the record needs evidence admission does not hold");
        throw error;
      }
      const receipt = this.transaction(() => {
        // The proof was verified between the reads; judge against the same view or not at all.
        this.stable(view);
        const signed = this.admit(engine, judged, replay);
        this.append(engine, `statement:${hash}`, hash, { kind: "admit", horizon: horizon.toString() }, bytesToHex(signed));
        return signed;
      });
      engine.revision++;
      return copyBytes(receipt);
    });
  }

  /** Sign the next checkpoint commitment over the current directory (§7). Publishing is explicit. */
  async commit(id: string): Promise<Commitment> {
    const commandId = this.commandId(id);
    return this.run(async engine => {
      const prior = this.prior(commandId, "commit");
      if (prior !== undefined) return decodeCommitment(hexToBytes(prior));
      const view = this.view(engine);
      await this.ready(engine, view, "commit");
      const sequence = this.nextSequence(engine), observed = hexOf(view.latest?.commitment);
      const signed = this.transaction(() => {
        this.stable(view);
        const next = this.sign(engine.opened!, engine.state!, sequence, view.now, observed);
        this.append(engine, commandId, "commit", { kind: "commit", at: view.now.toString(), observed }, bytesToHex(encodeCommitment(next.commitment)));
        return next;
      });
      engine.last = signed; engine.revision++;
      return copyCommitment(signed.commitment);
    });
  }

  /** Publish the latest signed commitment from the outbox, unless the venue already holds exactly it. */
  async publish(): Promise<Commitment> {
    return this.run(async engine => {
      const last = engine.last;
      requireThat(last !== undefined, "STALE", "no signed commitment to publish");
      // An obsolete instance publishes nothing under a record holding a later commitment of this key, which it did not
      // sign: a restored copy's opening, say (M13d). Its own bytes at a sequence the record holds are only republished.
      const view = this.view(engine);
      requireThat(view.latest === undefined || view.latest.commitment.sequence <= last.commitment.sequence, "CONFLICT",
        "the venue holds a later commitment of this key that this journal did not sign");
      const held = this.isHeld(view.now, last);
      this.transaction(() => {}); // Fence again before the venue call.
      if (!held) {
        try { await this.venue.publishRecord(1, this.operator, encodeCommitment(last.commitment)); } catch (error) {
          if (error instanceof VenueError) throw new V3StoreError("UNAVAILABLE", "the venue did not take the commitment");
          throw error;
        }
      }
      if (!last.published) {
        this.transaction(() => {
          this.db.prepare("UPDATE journal_signed SET published=1 WHERE sequence=?").run(last.commitment.sequence);
          this.append(engine, `published:${last.commitment.sequence}`, "published", { kind: "published", sequence: last.commitment.sequence.toString() }, "");
        });
        last.published = true; engine.revision++;
      }
      return copyCommitment(last.commitment);
    });
  }

  /** Where the journal stands, for a caller that schedules checkpoints and publication on the witnessed index
   * (`moe operator serve`): the venue's clock; the latest signed commitment, the index it was signed at, whether
   * its publication was recorded and whether the venue holds exactly it; the statements admitted past it; the
   * index at which the venue witnessed this key's latest commitment; and whether a return awaits adoption. Signs
   * and publishes nothing and changes no signed state or revision; like every command it records what it has
   * read of the venue (its observed index and held answers) under the owner fence. */
  async status(): Promise<JournalStatus> {
    return this.run(async engine => {
      const view = this.view(engine), last = engine.last;
      const restoration = this.restoration();
      return { now: view.now, pendingReturn: engine.pendingReturn,
        ...(restoration === undefined ? {} : { restoredAt: restoration.at, ...(restoration.opening === undefined ? {} : { restoredOpening: restoration.opening }) }),
        ...(last === undefined ? {} : { signed: { sequence: last.commitment.sequence, at: last.at, published: last.published,
          held: this.isHeld(view.now, last), admitted: (engine.state?.position ?? last.length) - last.length } }),
        ...(view.latest === undefined ? {} : { heldIndex: view.latest.index }) };
    });
  }

  /** The furthest record of `segment` that this journal's own checkpoints through `sequence` name: what a
   * reader served through that sequence holds of the segment's trail. */
  private ownTop(segment: Uint8Array, sequence: bigint): TrailTip | undefined {
    const row = this.db.prepare("SELECT * FROM journal_signed WHERE segment=? AND sequence<=? ORDER BY sequence DESC LIMIT 1").get(segment, sequence);
    if (row === undefined) return undefined;
    const signed = this.signedOf(row), snapshot = this.retained.snapshot(this.directoryOf(signed)[0]!.digest);
    requireThat(snapshot !== undefined, "STORAGE", "a signed snapshot is missing");
    return { segment, position: signed.length, evidence: this.frames.snapshot.decode(snapshot).evidenceHash };
  }

  /**
   * What serves `selected` and was not served through sequence `after`, read from rows as it is consumed
   * (§12.1, §14): each directory and snapshot signed after `after` through the selection, what an opening in
   * that range took, and for each segment those snapshots name, a trail through each furthest top no other reaches
   * (one, unless snapshots lie on two forks), whose prefixes serve each earlier checkpoint (`topTrails`). Objects go
   * in whole §12 packages of bounded size. A trail goes as its head and the records after the furthest one this
   * journal's checkpoints through `after` name, where the trail passes through it, else whole; a trail already served
   * that far is left out. Memory holds one package part or one record at a time. Served rows are never changed, so no command waits for a reader.
   */
  private async *parts(selected: Signed, after: bigint): AsyncIterable<EvidencePart> {
    try {
      const through = selected.commitment.sequence, from = after < through ? after : through;
      // Each segment's tops that no other of them reaches: one in the common case, one per fork where snapshots of a taken
      // predecessor lie on two (Next 4 (o)).
      const tops = new Map<string, { readonly tip: TrailTip; readonly trail: StoredTrail }[]>(), batch = new Map<string, { kind: number; payload: Uint8Array; hash: Uint8Array }>();
      let held = 0;
      const add = (kind: number, payload: Uint8Array): void => {
        const hash = sha256(payload), key = `${kind}:${bytesToHex(hash)}`;
        if (!batch.has(key)) { batch.set(key, { kind, payload, hash }); held += payload.length; }
      };
      const full = (): boolean => batch.size >= SERVED_PART_ITEMS || held >= SERVED_PART_BYTES;
      const packed = (): EvidencePart => {
        const items = [...batch.values()].sort((a, b) => a.kind - b.kind || compareBytes(a.hash, b.hash));
        batch.clear(); held = 0;
        return { package: this.frames.package.encodeEvidencePackage(items) };
      };
      // A snapshot names the furthest record of its segment that a reader of it needs. Every segment this journal
      // signed keeps its trail, so an own snapshot without one is damage, never a shorter package; a taken snapshot
      // is served as it was taken, with its trail where that came too.
      const snapshot = async (payload: Uint8Array, own: boolean): Promise<void> => {
        let named: Snapshot;
        try { named = this.frames.snapshot.decode(payload); } catch (error) { if (error instanceof EncodingError && !own) return; throw error; }
        const key = bytesToHex(named.segment), frontier = tops.get(key) ?? [];
        if (frontier.some(top => same(top.tip.evidence, named.evidenceHash))) return;
        const trail = this.retained.trail(named.segment, named.evidenceHash);
        requireThat(trail !== undefined || !own, "STORAGE", "a signed segment's trail is missing");
        if (trail === undefined) return;
        const tip: TrailTip = { segment: named.segment, position: trail.length, evidence: named.evidenceHash };
        const reaches = async (held: StoredTrail, to: TrailTip): Promise<boolean> => held.length >= to.position && await held.reaches(to.position, to.evidence) !== undefined;
        // A top a kept one reaches is served with it; a kept top this one reaches is served with this one.
        for (const top of frontier) if (await reaches(top.trail, tip)) return;
        const kept: { readonly tip: TrailTip; readonly trail: StoredTrail }[] = [];
        for (const top of frontier) if (!await reaches(trail, top.tip)) kept.push(top);
        tops.set(key, [...kept, { tip, trail }]);
      };
      for (let cursor = from; cursor < through;) {
        const rows = this.db.prepare("SELECT sequence,commitment FROM journal_signed WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?").all(cursor, through, SERVE_PAGE);
        if (rows.length === 0) break;
        for (const row of rows) {
          // Every signed sequence keeps its row: a gap is damage, never a checkpoint left out, except below a restored
          // journal's opening, which skipped it (M13d).
          const skipped = row.sequence === cursor + 1n ? undefined : this.db.prepare("SELECT below FROM journal_skipped WHERE sequence=?").get(row.sequence as bigint)?.below;
          // A reader served through a sequence inside the skip (the lost instance's in-flight commitment, C2.4.4) is
          // served from the return on.
          requireThat(row.sequence === cursor + 1n || (typeof skipped === "bigint" && skipped <= cursor),
            "STORAGE", "a signed row is missing");
          const directory = this.retained.object(3, decodeCommitment(bytes(row.commitment)).root);
          requireThat(directory !== undefined, "STORAGE", "a signed directory is missing");
          add(3, directory);
          for (const entry of decodeEvidenceDirectory(directory)) {
            const payload = this.retained.snapshot(entry.digest);
            requireThat(payload !== undefined, "STORAGE", "a signed snapshot is missing");
            add(4, payload); await snapshot(payload, true);
            if (full()) yield packed();
          }
          cursor = row.sequence as bigint;
        }
      }
      // What the openings in range took, in (sequence, kind, hash) order from a mark no row at `from` passes (kinds are below 9).
      for (let mark: [bigint, bigint, Uint8Array] = [from, 9n, new Uint8Array()]; ;) {
        const rows = this.db.prepare(`SELECT sequence,kind,hash FROM journal_taken WHERE (sequence,kind,hash)>(?,?,?) AND sequence<=? AND kind IN (3,4)
          ORDER BY sequence,kind,hash LIMIT ?`).all(...mark, through, SERVE_PAGE);
        if (rows.length === 0) break;
        for (const row of rows) {
          mark = [row.sequence as bigint, row.kind as bigint, bytes(row.hash)];
          const kind = row.kind === 3n ? 3 : 4, payload = this.retained.object(kind, mark[2]);
          if (payload === undefined) continue;
          add(kind, payload);
          if (kind === 4) await snapshot(payload, false);
          if (full()) yield packed();
        }
      }
      if (batch.size > 0) yield packed();
      // A reader served through `from` holds what this journal's own checkpoints through it name of each segment.
      const order = [...tops.values()].flatMap(frontier => frontier.map(top => top.tip).sort((a, b) =>
        a.position > b.position ? -1 : a.position < b.position ? 1 : compareBytes(a.evidence, b.evidence)));
      yield* topTrails(order, (segment, value) => this.retained.trail(segment, value),
        segment => from === 0n ? undefined : this.ownTop(segment, from), this.construction);
    } catch (error) {
      if (error instanceof EvidenceRefusal || error instanceof EncodingError) throw new V3StoreError("STORAGE", "the journal's own evidence does not read back");
      throw error;
    }
  }

  /**
   * The evidence for the latest commitment held on the venue or published and still in flight (C2.4.3–4), by parts (§14 incremental
   * retrieval): the read's own §12 package (the configuration and that commitment), and every other object
   * of every checkpoint signed through it that a reader served through sequence `after` does not hold yet
   * (`parts`). Records admitted after the selection are not served, nor is a commitment still in the outbox.
   * A held one counts even where a lost reply left its publication unrecorded. The selection names `backing`
   * (by default the scope's first); a reader selects its own. `after` is the selection's sequence of an earlier
   * call whose parts the reader kept; it authenticates nothing, and a reader that lacks what it implies asks
   * again from 0. The parts are read after this call returns, while other commands run.
   *
   * Serving reads signed rows, which a command changes only inside one synchronous transaction (a publication
   * marks its row), so it takes no journal turn: it neither waits for a
   * command nor makes one BUSY. It writes only where the venue's clock has passed the index this key's held
   * commitments are kept through, keeping them through the clock as a command's view would (with any conflict
   * their windows show); otherwise it checks the fence and identity and reads.
   */
  async serve(backing?: Uint8Array, after = 0n): Promise<ServedEvidence> {
    const named = backing === undefined ? undefined : copyBytes(backing);
    requireThat(typeof after === "bigint" && after >= 0n && after < U64, "REFUSED", "the served sequence is not a u64", "SEQUENCE");
    requireThat(!this.closed, "STORAGE", "store is closed");
    // Everything from the clock to the selection runs without an await, so no command's transaction falls between.
    const view = this.servingView();
    // A published commitment the venue has not shown is served while it is in flight (C2.4.4); once the lag
    // from its signing has passed without it, the operator can no longer assume it (C2.4.3), and the latest
    // held one is served instead.
    let selected = this.db.prepare("SELECT * FROM journal_signed WHERE published=1 ORDER BY sequence DESC LIMIT 1").get();
    if (selected !== undefined && view.now >= decimal(selected.at) + this.lag) selected = undefined;
    for (let held = view.latest; held !== undefined; held = this.heldBelow(view.now, held.commitment.sequence)) {
      if (selected !== undefined && held.commitment.sequence <= (selected.sequence as bigint)) break;
      if (this.ownHeld(held) === undefined) {
        // Each held commitment of this key without its signed row was recorded as a conflict when its window was
        // read (`foreign`); with none recorded, the row was lost or changed since: damage, not another signer's.
        // The lost instance's commitment landing inside a restored journal's skip is passed over the same way (M13d).
        requireThat(view.conflict || this.lostInstance(held.commitment.sequence), "STORAGE", "a held commitment's signed row is missing");
        continue;
      }
      selected = this.db.prepare("SELECT * FROM journal_signed WHERE sequence=?").get(held.commitment.sequence);
      break;
    }
    requireThat(selected !== undefined, "STALE", "no published commitment to serve");
    let signed: Signed;
    try { signed = this.signedOf(selected); } catch (error) {
      if (error instanceof EncodingError) throw new V3StoreError("STORAGE", "a signed row does not decode");
      throw error;
    }
    const directory = this.directoryOf(signed);
    // The selection names `backing`, by default the scope's first; its directory must carry it.
    const name = named ?? directory[0]!.name;
    requireThat(directory.some(entry => same(entry.name, name)), "REFUSED", "the served commitment does not carry the backing", "SCOPE");
    const own = this.ownPackage(signed.commitment);
    return { selection: { domain: copyBytes(this.domain), venue: copyBytes(this.venueId), backing: copyBytes(name),
      operator: copyBytes(this.operator), sequence: signed.commitment.sequence, root: copyBytes(signed.commitment.root) },
      package: own, parts: this.parts(signed, after) };
  }
  /** The venue as a serve reads it: the clock, and this key's latest commitment held by it. The held commitments
   * are kept through the clock first where they are behind it, in a transaction of their own under the fence;
   * kept through it already, they are read after a fence check that writes nothing. */
  private servingView(): { readonly now: bigint; readonly latest: HeldCommitment | undefined; readonly conflict: boolean } {
    const now = this.clock();
    // Under the fence and before any answer is kept: a damaged row must not be read as another signer's commitment
    // (`foreign`).
    if (this.replays.keptAnswer(1, this.operator)?.through !== now) return this.keeping(() => { this.latestSignedHolds(); return this.viewed(undefined); });
    // One read snapshot, which takes no write lock: another owner's commit cannot fall between the checks.
    this.db.exec("BEGIN");
    try {
      const meta = this.metadata();
      requireThat(meta?.owner === this.owner, "FENCED", "another process owns this journal");
      this.identity(meta); this.latestSignedHolds();
      return { now, latest: this.heldBelow(now), conflict: this.db.prepare("SELECT 1 FROM journal_conflict WHERE id=1").get() !== undefined };
    } finally { this.db.exec("COMMIT"); }
  }

  /** As reopening checks (`stored`): the latest signed row is the log's latest signing reply, byte for byte, so a
   * lost or changed row is damage that serving refuses, never an older selection. The rows below it are checked as
   * they are served (`parts`). */
  private latestSignedHolds(): void {
    const found = this.db.prepare("SELECT commitment FROM journal_signed ORDER BY sequence DESC LIMIT 1").get();
    const reply = this.db.prepare("SELECT response FROM events WHERE id LIKE 'command:%' ORDER BY seq DESC LIMIT 1").get()?.response;
    requireThat(found === undefined ? reply === undefined : reply === bytesToHex(bytes(found.commitment)), "STORAGE",
      "the signed commitments disagree with the command log");
  }

  /** `serve` from nothing as one §12 package held in memory, for a caller that reads a whole package. */
  async package(backing?: Uint8Array): Promise<ServedPackage> {
    const served = await this.serve(backing);
    try { return { selection: served.selection, package: await wholePackage(served.package, served.parts, this.construction) }; } catch (error) {
      // A trail's records are checked as they are read, after its part is handed over.
      if (error instanceof EvidenceRefusal || error instanceof EncodingError) throw new V3StoreError("STORAGE", "the journal's own evidence does not read back");
      throw error;
    }
  }

  /**
   * Re-verification on request (storage decision item 7). Reopening trusts the rows; this does not:
   * - each scoped backing's canonical checkpoint is read again through the public reader, from the segments'
   *   seeds over the evidence the journal serves, with nothing kept, so every proof through it is verified
   *   again. A witnessed checkpoint of this journal that a reader excludes fails the audit, whatever the cause. Where that checkpoint is of the active segment, the journal's stored state at its position must be
   *   the state the read replayed: its chains, totals and every fact it holds, imports included;
   * - every signed row must be the reply its command was given, in order, and carry the publication the log records;
   * - every record of the active segment must have a receipt this key signed, and one naming the active
   *   segment must be its row's.
   * Records admitted after the canonical checkpoint are not proved again here: no reader has judged them.
   * A failure is STORAGE; evidence that no longer reads is UNAVAILABLE, as for any of the journal's reads.
   */
  async audit(): Promise<void> {
    return this.run(async engine => {
      const opened = engine.opened, state = engine.state, view = this.view(engine), now = view.now;
      this.auditAnswers(opened, view);
      if (opened === undefined || state === undefined) return;
      for (const { backing } of opened.entries) {
        const fresh = new ReplayStore();
        try {
          let source: StateRead;
          try { source = await this.currentRead(engine, now, backing, fresh); } catch (error) {
            // Nothing this journal signed is witnessed as carrying the backing yet: there is no read to compare.
            if (error instanceof V3StoreError && error.check === "UNCARRIED") continue;
            throw error;
          }
          const { canonical, state: read } = source;
          if (!same(canonical.segment, opened.segment)) continue;
          requireThat(read.position <= state.position, "STORAGE", "the stored state is behind the witnessed evidence");
          const mine = state.at(read.position), totals = mine.total(bytesToHex(backing));
          requireThat(same(mine.history, read.history) && same(mine.evidence, read.evidence) && totals.issued === read.issued &&
            totals.burned === read.burned && same(this.replays.factDigest(mine.ns, mine.position), fresh.factDigest(read.ns, read.position)),
            "STORAGE", "the stored state is not the state the evidence replays to");
        } finally { fresh.close(); }
      }
      // The signed rows against the log, in step.
      const replies = this.db.prepare("SELECT response FROM events WHERE id LIKE 'command:%' ORDER BY seq").iterate();
      for (const row of this.db.prepare("SELECT sequence,commitment,published FROM journal_signed ORDER BY sequence").iterate()) {
        const reply = replies.next().value?.response;
        requireThat(reply === bytesToHex(bytes(row.commitment)), "STORAGE", "a signed row is not its command's reply");
        const logged = this.db.prepare("SELECT 1 FROM events WHERE id=?").get(`published:${row.sequence}`) !== undefined;
        requireThat(logged === (row.published === 1n), "STORAGE", "a signed row's publication disagrees with the log");
      }
      requireThat(replies.next().done === true, "STORAGE", "a signing reply has no signed row");
      for (let position = 1n; position <= state.position; position++) {
        const event = state.receiptEvent(position)!, row = this.db.prepare("SELECT receipt FROM journal_receipt WHERE statement=?").get(event.statementHash);
        requireThat(row !== undefined, "STORAGE", "an admitted record has no receipt");
        let receipt;
        try { receipt = this.frames.receipt(bytes(row.receipt)); } catch (error) {
          if (error instanceof EncodingError) throw new V3StoreError("STORAGE", "a stored receipt does not decode");
          throw error;
        }
        // A statement first admitted in an earlier segment keeps that segment's receipt, signed by this key under the
        // header of that segment, which the journal still serves.
        const here = same(receipt.segment, opened.segment), [head] = here ? [] : this.retained.heads(receipt.segment);
        const header = here ? opened.header : head === undefined ? undefined : this.frames.header.decodeSegmentHeader(head.header);
        requireThat(header !== undefined && receipt.verify({ domain: this.domain, header, operator: this.operator }) &&
          (!here || receipt.matches(event)), "STORAGE", "a stored receipt does not authenticate its record");
      }
    });
  }

  /** The kept venue answers a view reads against the venue itself, read again from its first index into a
   * store of its own: the same conflict, the same term boundaries and revocations of the active scope, the
   * same held commitments of this key at the same indices, each kept through the view's clock. Answers kept
   * for a backing outside the active scope are not read by a view and are not compared. */
  private auditAnswers(opened: Opened | undefined, view: View): void {
    const fresh = new ReplayStore(), failed = "the kept venue answers are not the venue's";
    try {
      let first: RangeEntry | undefined;
      const again = this.observe(opened, view.now, fresh, entry => { first ??= entry; }, () => first !== undefined);
      const text = (v: View): string => JSON.stringify([v.conflict, v.boundaries.map(String),
        [...v.revocations].map(([name, at]) => [name, at?.toString() ?? null])]);
      requireThat(text(again) === text(view), "STORAGE", failed);
      const stored = this.db.prepare("SELECT idx,record FROM journal_conflict WHERE id=1").get();
      requireThat((stored === undefined) === (first === undefined) && (stored === undefined || first === undefined ||
        (stored.idx === first.index.toString() && same(bytes(stored.record), first.record))), "STORAGE", failed);
      // A kept answer reaches the view's clock exactly; a revocation once found is not extended.
      const through = (kind: number, subject: Uint8Array): bigint | undefined => this.replays.keptAnswer(kind, subject)?.through;
      requireThat(through(1, this.operator) === view.now && (opened?.entries ?? []).every(({ backing, terms }) =>
        through(2, backing) === view.now && (view.revocations.get(bytesToHex(backing)) !== undefined || through(3, terms.obligor) === view.now)),
      "STORAGE", failed);
      const next = (store: ReplayStore, after?: HeldCommitment): HeldCommitment | undefined =>
        store.nextHeld(this.operator, 0n, after?.commitment.sequence, view.now);
      for (let kept = next(this.replays), read = next(fresh); kept !== undefined || read !== undefined; kept = next(this.replays, kept), read = next(fresh, read)) {
        requireThat(kept !== undefined && read !== undefined && kept.index === read.index && hexOf(kept.commitment) === hexOf(read.commitment), "STORAGE", failed);
      }
    } finally { fresh.close(); }
  }

  close(): void {
    requireThat(!this.busy, "BUSY", "cannot close during a journal operation");
    if (!this.closed) { this.db.close(); this.reading?.close(); this.secret.fill(0); this.engine = undefined; this.closed = true; }
  }
}
