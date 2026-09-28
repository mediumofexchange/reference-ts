// Node 24 optional entry point. The pool-v3 operator journal (v3 runtime plan,
// slices 1–3): one durable command log per operator key and venue, fenced to one
// owner, in one SQLite database. It serves one backing, admits ordinary
// and recovery records through the state machine's admission
// mode (state.ts) with original signed receipts (§7.2), signs checkpoint
// commitments over v3 directories and snapshots (§7), publishes them through
// the record venue from an outbox, and serves §12 packages a reader verifies
// alone. A witnessed silence boundary permits an empty return opening, then
// exact adoption through its witnessed index before service. Replacement imports
// the record-derived frontier; reopening replays the journal commands.
//
// Candidate only: the configuration comes from the caller's manifest check
// and the venue must be a reference venue (guard.ts). Time is the venue's
// witnessed index. SQLite fences handles of this journal; it cannot fence
// another database or a copied key.
import { DatabaseSync } from "node:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes, EncodingError } from "../../bytes.js";
import type { ErgoPublisherPersistence } from "../../ergo-publisher.js";
import {
  admittedReplacements, decodeRangeAnswer, heldCommitments, RangeLimitError, replacementChain, revocationIndex,
  type ChainLink, type HeldCommitment, type RangeAnswer, type RecordKind,
} from "../../record-range.js";
import type { RecordPublisher, RecordVenue } from "../../record-venue.js";
import { VenueError } from "../../venue-error.js";
import { decodeCommitment, directoryRoot, encodeCommitment, signCommitment, verifyCommitment, type Commitment, type SnapshotDigest } from "../../venue-records.js";
import { identifierOf } from "../field.js";
import { scopeSchedule } from "../schedule.js";
import { ScopeTree } from "../scope.js";
import { encodeReceipt, receiptBytes, snapshotBytes, snapshotDigest, type Snapshot } from "./commitments.js";
import { configurationBytes, configurationHash, decodeConfiguration, type CandidateConfiguration } from "./configuration.js";
import { requireReferenceVenue, type VenueReference } from "./guard.js";
import { segmentBytes, segmentIdentity, type SegmentHeader } from "./headers.js";
import { decodeEvidencePackage, encodeEvidenceDirectory, encodeEvidencePackage, PackageLimitError, type EvidenceItem, type PackageLimits } from "./package.js";
import { RANGE_LIMITS, TRAIL_LIMITS, type SignedTerms } from "./reader.js";
import { readFrontier, readPackage } from "./package-reader.js";
import { IMPORT_LIMITS, type CanonicalCheckpoint, type FrontierResult } from "./import-reader.js";
import { decodeRecord, encodeRecord, evidenceHashes, statementHash } from "./records.js";
import { EvidenceRefusal, ReplayRefusal } from "./refusals.js";
import { mergeFinalizedPrefixes, type ScopeForcedPublication, type ScopeResult } from "./scope-reader.js";
import { applyRecord, openSegmentState, type ImportedState, type ProofCheck, type SegmentReplay, type SegmentState } from "./state.js";
import { decodeRootTerms, rootTermsName, verifyRootTermsSignature, type RootTerms } from "./terms.js";
import { encodeTrail, TrailLimitError } from "./trail.js";

const PROFILE = "pool-store/v3";
const U64 = 1n << 64n;
const SQLITE_LIMIT = (1n << 63n) - 1n;
/** The reference reader's package budget; a reader applies its own. */
export const SERVED_PACKAGE_LIMITS: PackageLimits = Object.freeze({ maxBytes: 1_048_576n, maxItems: 1024n });
/** What a served package may fill: the budget less one receipt item (§12 kind 10, a 355-byte record), so a receipt query still fits. */
const SERVED_ROOM: PackageLimits = Object.freeze({ maxBytes: SERVED_PACKAGE_LIMITS.maxBytes - 360n, maxItems: SERVED_PACKAGE_LIMITS.maxItems - 1n });
const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
const hexOf = (c: Commitment | undefined): string | null => (c === undefined ? null : bytesToHex(encodeCommitment(c)));
const copyCommitment = (c: Commitment): Commitment => decodeCommitment(encodeCommitment(c));

export class V3StoreError extends Error {
  constructor(readonly code: "STORAGE" | "FENCED" | "BUSY" | "CONFLICT" | "UNAVAILABLE" | "STALE" | "SCHEDULE" | "UNSUPPORTED" | "REFUSED",
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

/** Signed terms as stored: hex terms and signature. */
type TermsText = readonly [string, string];
type Command =
  | { kind: "open"; scope: readonly TermsText[]; at: string; observed: string | null }
  | { kind: "rescope"; take: readonly TermsText[]; keep: readonly string[]; evidence: string; at: string; observed: string | null }
  | { kind: "commit"; at: string; observed: string | null }
  | { kind: "admit"; record: string; horizon: string }
  | { kind: "return"; at: string; observed: string | null }
  | { kind: "adopt"; at: string; opening: string }
  | { kind: "published"; sequence: string };
const signedOf = ([terms, signature]: TermsText): SignedTerms => ({ terms: hexToBytes(terms), signature: hexToBytes(signature) });
const termsText = (signed: SignedTerms): TermsText => [bytesToHex(signed.terms), bytesToHex(signed.signature)];
const HEX = /^(?:[0-9a-f]{2})*$/;
const hexList = (value: unknown): readonly string[] => {
  requireThat(Array.isArray(value) && value.every(item => typeof item === "string" && HEX.test(item)), "STORAGE", "invalid journal command");
  return value as string[];
};
const termsList = (value: unknown): readonly TermsText[] => {
  requireThat(Array.isArray(value), "STORAGE", "invalid journal command");
  return value.map(pair => {
    const [terms, signature, ...rest] = hexList(pair);
    requireThat(terms !== undefined && signature !== undefined && rest.length === 0, "STORAGE", "invalid journal command");
    return [terms, signature] as const;
  });
};
function commandText(c: Command): string {
  switch (c?.kind) {
    case "open": return JSON.stringify({ kind: c.kind, scope: termsList(c.scope), at: c.at, observed: c.observed });
    case "rescope": requireThat(hexList(c.keep).every(name => name.length === 64), "STORAGE", "invalid journal command");
      return JSON.stringify({ kind: c.kind, take: termsList(c.take), keep: hexList(c.keep), evidence: hexList([c.evidence])[0],
      at: c.at, observed: c.observed });
    case "commit": return JSON.stringify({ kind: c.kind, at: c.at, observed: c.observed });
    case "admit": return JSON.stringify({ kind: c.kind, record: c.record, horizon: c.horizon });
    case "return": return JSON.stringify({ kind: c.kind, at: c.at, observed: c.observed });
    case "adopt": return JSON.stringify({ kind: c.kind, at: c.at, opening: c.opening });
    case "published": return JSON.stringify({ kind: c.kind, sequence: c.sequence });
    default: throw new V3StoreError("STORAGE", "unknown journal command");
  }
}

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
  readonly scope: bigint;
  readonly entries: readonly Scoped[];
}
function openedOf(header: SegmentHeader, entries: readonly Scoped[]): Opened {
  return { header, headerBytes: segmentBytes(header), segment: segmentIdentity(header), scope: new ScopeTree(header.entries).root(), entries };
}
/** C2.10.2: one clock per scope. A reader excludes a scope whose silence durations differ (SILENCE_SCOPE). */
function oneClock(entries: readonly Scoped[]): void {
  const durations = entries.map(({ terms }) => terms.silence?.noCommitmentDuration);
  requireThat(durations.every(duration => duration === durations[0]), "REFUSED", "the scoped backings declare different silence clocks", "SCOPE");
}
/** The term link a segment's header names for `backing`. */
const linkOf = (opened: Opened, backing: Uint8Array): Uint8Array => opened.header.entries.find(entry => same(entry.backing, backing))!.link;
const isTermsList = (value: SignedTerms | readonly SignedTerms[]): value is readonly SignedTerms[] => Array.isArray(value);
/** Snapshots have fixed width (commitments.ts). */
const SNAPSHOT_BYTES = snapshotBytes({ backing: new Uint8Array(32), segment: new Uint8Array(32), historyHash: new Uint8Array(32),
  evidenceHash: new Uint8Array(32), issued: 0n, burned: 0n }).length;
interface Signed {
  readonly opened: Opened;
  readonly commitment: Commitment;
  readonly length: bigint;
  readonly at: bigint;
  readonly observed: string | null;
  readonly directory: readonly SnapshotDigest[];
  /** One snapshot per scoped backing, in directory order. */
  readonly snapshots: readonly Uint8Array[];
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
interface Engine {
  revision: bigint;
  opened: Opened | undefined;
  state: SegmentState | undefined;
  readonly records: Uint8Array[];
  readonly receipts: Map<string, Uint8Array>;
  readonly signed: Signed[];
  /** The last admission's horizon; horizons never move back. */
  horizon: bigint;
  readonly archives: { readonly opened: Opened; readonly records: readonly Uint8Array[] }[];
  /** Public imported dependencies, never this key's signing history. */
  readonly evidence: EvidenceItem[];
  pendingReturn: boolean;
}
type StateRead = Extract<ScopeResult, { readonly state: object }>;
/** The venue at one instant: its clock and lag, this key's held commitments, every scoped backing's term boundary and each K's revocation. */
interface View {
  readonly now: bigint;
  readonly lag: bigint;
  readonly held: readonly HeldCommitment[];
  /** An authentic record of this key outside the durable signing history,
   * including records the venue's holding rule does not select. */
  readonly conflict: boolean;
  readonly boundaries: readonly bigint[];
  /** Each scoped backing's K revocation index, by backing name. */
  readonly revocations: ReadonlyMap<string, bigint | undefined>;
  /** Publications of each scoped backing with a non-service clause, by backing name. */
  readonly requests: ReadonlyMap<string, bigint>;
  readonly key: string;
}

/** What the journal needs besides its path. */
export interface V3StoreOptions {
  /** The candidate configuration from the caller's own manifest check (pool-v3 §11.1). */
  readonly configuration: CandidateConfiguration;
  /** The operator's Ed25519 secret; copied, and erased on close. */
  readonly secret: Uint8Array;
  readonly venue: RecordVenue & RecordPublisher;
  /** The venue identity's preimage the caller holds; the guard recomputes it. */
  readonly reference: VenueReference;
  /** Verifies proofs under the configuration's keys. */
  readonly verifier: ProofCheck;
}
/** A served §12 package with the selection it names; a reader makes its own selection and judges at its own index. */
export interface ServedPackage {
  readonly selection: {
    readonly domain: Uint8Array; readonly venue: Uint8Array; readonly backing: Uint8Array;
    readonly operator: Uint8Array; readonly sequence: bigint; readonly root: Uint8Array;
  };
  readonly package: Uint8Array;
}

export class V3OperatorJournal {
  private readonly db: DatabaseSync;
  private readonly configuration: CandidateConfiguration;
  private readonly domain: Uint8Array;
  private readonly secret: Uint8Array;
  private readonly operator: Uint8Array;
  private readonly venue: RecordVenue & RecordPublisher;
  private readonly venueId: Uint8Array;
  private readonly lag: bigint;
  private readonly verifier: ProofCheck;
  private readonly reference: VenueReference;
  private readonly owner: bigint;
  private readonly resumedAt: bigint | undefined;
  private observedIndex: bigint;
  private engine: Engine | undefined;
  private busy = false;
  /** Set once an action changes memory or writes the journal; see run(). */
  private diverging = false;
  private closed = false;

  constructor(path: string, options: V3StoreOptions) {
    requireThat(typeof path === "string" && path.trim() !== "" && path !== ":memory:" && !path.startsWith("file:"), "STORAGE", "a persistent filesystem path is required");
    const { configuration, secret, venue, reference, verifier } = options;
    // The guard first: the candidate runs only on a reference venue.
    this.venueId = requireReferenceVenue(reference, venue);
    this.reference = structuredClone(reference);
    this.configuration = decodeConfiguration(configurationBytes(configuration)); this.domain = configurationHash(this.configuration);
    this.venue = venue; this.lag = venue.lag(); this.verifier = verifier;
    this.secret = copyBytes(secret); this.operator = ed25519.getPublicKey(this.secret);
    this.observedIndex = 0n;
    const now = this.clock();
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      requireThat(this.db.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal" &&
        this.db.prepare("PRAGMA synchronous").get()?.synchronous === 2, "STORAGE", "persistent WAL with FULL synchronization is required");
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec(`CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1),
        profile TEXT NOT NULL, domain TEXT NOT NULL, operator TEXT NOT NULL, venue TEXT NOT NULL,
        owner INTEGER NOT NULL, tip INTEGER NOT NULL, observed TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY CHECK(seq>0), id TEXT NOT NULL UNIQUE,
        request TEXT NOT NULL, command TEXT NOT NULL, response TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS ergo_publisher (id INTEGER PRIMARY KEY CHECK(id=1),
        revision INTEGER NOT NULL CHECK(revision>0), snapshot TEXT NOT NULL) STRICT;`);
      let meta = this.metadata();
      if (meta === undefined) {
        requireThat(this.db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n === 0, "STORAGE", "journal identity is missing");
        this.db.prepare("INSERT INTO identity VALUES(1,?,?,?,?,0,0,?)").run(PROFILE, bytesToHex(this.domain),
          bytesToHex(this.operator), bytesToHex(this.venueId), now.toString());
        meta = this.metadata()!;
      }
      this.identity(meta);
      requireThat(now >= decimal(meta.observed), "STORAGE", "venue clock is behind the durable journal");
      requireThat(typeof meta.owner === "bigint" && meta.owner < SQLITE_LIMIT, "STORAGE", "journal owner counter exhausted");
      this.owner = meta.owner + 1n;
      // C2.8.2: a restarted journal waits the lag before it signs again.
      this.resumedAt = meta.tip === 0n ? undefined : now;
      this.db.prepare("UPDATE identity SET owner=?,observed=? WHERE id=1").run(this.owner, now.toString());
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
    const row = () => {
      const query = this.db.prepare("SELECT revision,snapshot FROM ergo_publisher WHERE id=1"); query.setReadBigInts(true);
      return query.get();
    };
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

  private metadata() {
    const query = this.db.prepare("SELECT * FROM identity WHERE id=1"); query.setReadBigInts(true);
    return query.get();
  }
  private identity(meta: ReturnType<V3OperatorJournal["metadata"]>): void {
    requireThat(meta?.profile === PROFILE && meta.domain === bytesToHex(this.domain) &&
      meta.operator === bytesToHex(this.operator) && meta.venue === bytesToHex(this.venueId), "STORAGE", "journal identity does not match");
    const query = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(seq),0) AS tip FROM events"); query.setReadBigInts(true);
    const counts = query.get()!;
    requireThat(typeof meta.tip === "bigint" && meta.tip === counts.tip && meta.tip === counts.n, "STORAGE", "journal is truncated or noncontiguous");
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
  private transaction<T>(action: () => T): T {
    requireThat(!this.closed, "STORAGE", "store is closed");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const meta = this.metadata(); this.identity(meta);
      requireThat(meta!.owner === this.owner, "FENCED", "another process owns this journal");
      requireThat(this.engine === undefined || meta!.tip === this.engine.revision, "STORAGE", "journal changed behind its owner");
      const result = action(); this.db.exec("COMMIT"); return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* an uncertain commit is recovered by replay */ }
      this.engine = undefined; throw error;
    }
  }
  private async run<T>(action: (engine: Engine) => Promise<T>): Promise<T> {
    requireThat(!this.closed, "STORAGE", "store is closed");
    requireThat(!this.busy, "BUSY", "a journal operation is in progress");
    this.busy = true;
    this.diverging = false;
    try { await this.load(); return await action(this.engine!); }
    catch (error) {
      // Memory is discarded where it may differ from the journal: after a
      // transition or write this action has not finished reflecting, or on an
      // unexpected failure. A refusal before either leaves it as it was.
      if (this.diverging || !(error instanceof V3StoreError || error instanceof EncodingError)) this.engine = undefined;
      throw error;
    }
    finally { this.busy = false; }
  }

  private async load(): Promise<void> {
    if (this.engine !== undefined) { this.transaction(() => {}); return; }
    const rows = this.transaction(() => {
      const q = this.db.prepare("SELECT seq,id,request,command,response FROM events ORDER BY seq"); q.setReadBigInts(true);
      return q.all();
    });
    const engine: Engine = { revision: 0n, opened: undefined, state: undefined, records: [], receipts: new Map(), signed: [], horizon: 0n,
      archives: [], evidence: [], pendingReturn: false };
    for (const row of rows) {
      requireThat(row.seq === engine.revision + 1n && typeof row.command === "string" && typeof row.response === "string" &&
        typeof row.id === "string" && typeof row.request === "string", "STORAGE", "invalid journal row");
      let command: Command;
      try { command = JSON.parse(row.command) as Command; } catch { throw new V3StoreError("STORAGE", "invalid journal command"); }
      requireThat(commandText(command) === row.command, "STORAGE", "noncanonical journal command");
      await this.replay(engine, command, row.id, row.request, row.response);
      engine.revision++;
    }
    this.engine = engine;
    this.transaction(() => {}); // A new owner may have appeared while proofs were verified.
  }
  /** Re-apply one stored command and require its stored reply to be the one it produces. */
  private async replay(engine: Engine, command: Command, id: string, request: string, response: string): Promise<void> {
    const at = (value: string): bigint => {
      const index = decimal(value);
      requireThat(index <= this.observedIndex && index >= (engine.signed.at(-1)?.at ?? 0n), "STORAGE", "stored signing clock is inconsistent");
      return index;
    };
    if (command.kind === "open") {
      requireThat(engine.opened === undefined && /^command:/.test(id) && request === this.openRequest(command.scope),
        "STORAGE", "stored opening disagrees with replay");
      let opened: Opened;
      try { opened = this.opening(command.scope.map(signedOf)); } catch (error) {
        if (error instanceof V3StoreError) throw new V3StoreError("STORAGE", "a stored opening no longer opens");
        throw error;
      }
      engine.opened = opened;
      engine.state = openSegmentState(opened.segment, undefined, undefined, undefined, () => {});
      this.replaySigned(engine, command, at(command.at), response);
    } else if (command.kind === "rescope") {
      requireThat(/^command:/.test(id) && request === this.rescopeRequest(command.take, command.keep, command.evidence),
        "STORAGE", "stored scope change disagrees with replay");
      const index = at(command.at);
      try {
        await this.prepareRescope(engine, { take: command.take.map(signedOf), keep: command.keep.map(hexToBytes),
          evidence: hexToBytes(command.evidence) }, index);
      } catch (error) {
        // A venue without an answer stays retryable; any other refusal means the row disagrees.
        if (error instanceof V3StoreError && error.code !== "UNAVAILABLE") throw new V3StoreError("STORAGE", "a stored scope change no longer applies");
        throw error;
      }
      this.replaySigned(engine, command, index, response);
    } else if (command.kind === "commit") {
      requireThat(engine.opened !== undefined && /^command:/.test(id) && request === "commit", "STORAGE", "stored commitment disagrees with replay");
      this.replaySigned(engine, command, at(command.at), response);
    } else if (command.kind === "return") {
      requireThat(engine.opened !== undefined && !engine.pendingReturn && /^command:/.test(id) && request === "return", "STORAGE", "invalid return command");
      const index = at(command.at), source = await this.currentRead(engine, index);
      this.prepareReturn(engine, source, index);
      this.replaySigned(engine, command, index, response);
    } else if (command.kind === "adopt") {
      const opening = engine.opened;
      requireThat(opening !== undefined && engine.pendingReturn && command.opening === opening.header.sequence.toString() &&
        id === `adopt:${command.opening}` && request === "adopt", "STORAGE", "invalid adoption command");
      const index = decimal(command.at), source = await this.currentRead(engine, index);
      requireThat(source.canonical.index === index && source.canonical.commitment.sequence === opening.header.sequence, "STORAGE", "adoption index differs from the witnessed opening");
      const receipts = await this.applyAdoption(engine, source);
      requireThat(response === JSON.stringify(receipts.map(bytesToHex)), "STORAGE", "adoption receipts disagree with replay");
    } else if (command.kind === "admit") {
      const state = engine.state, opened = engine.opened;
      requireThat(state !== undefined && opened !== undefined, "STORAGE", "a receipt without a segment");
      const bytes = hexToBytes(command.record), hash = bytesToHex(statementHash(decodeRecord(bytes)));
      requireThat(id === `statement:${hash}` && request === hash && bytesToHex(encodeRecord(decodeRecord(bytes))) === command.record,
        "STORAGE", "stored statement disagrees with replay");
      // The original judgment at its horizon; the venue reads it made are not repeated.
      const horizon = decimal(command.horizon);
      requireThat(horizon >= engine.horizon && horizon <= this.observedIndex + this.lag, "STORAGE", "stored horizon is inconsistent");
      engine.horizon = horizon;
      try { await applyRecord(state, bytes, this.replayOf(opened, horizon, new Map())); } catch (error) {
        if (error instanceof ReplayRefusal || error instanceof EvidenceRefusal) throw new V3StoreError("STORAGE", "a stored statement no longer admits");
        throw error;
      }
      requireThat(response === bytesToHex(this.receipt(engine, bytes)), "STORAGE", "stored receipt disagrees with replay");
      engine.records.push(bytes); engine.receipts.set(hash, hexToBytes(response));
    } else {
      const last = engine.signed.at(-1);
      requireThat(last !== undefined && last.commitment.sequence === decimal(command.sequence) && id === `published:${command.sequence}` &&
        request === "published" && response === "", "STORAGE", "publication names another commitment");
      last.published = true;
    }
  }
  private replaySigned(engine: Engine, command: { observed: string | null }, at: bigint, response: string): void {
    const { directory, snapshots } = this.checkpoint(engine);
    const commitment = decodeCommitment(hexToBytes(response)), highest = engine.signed.at(-1)?.commitment.sequence ?? 0n;
    requireThat(hexOf(commitment) === response && verifyCommitment(commitment) && same(commitment.operator, this.operator) &&
      commitment.sequence === highest + 1n && same(commitment.root, directoryRoot(directory)), "STORAGE", "stored commitment disagrees with replay");
    // What the venue held of this key at signing: nothing yet, or a commitment this journal signed before.
    requireThat(command.observed === null || engine.signed.some(s => hexOf(s.commitment) === command.observed), "STORAGE", "invalid observed commitment");
    engine.signed.push({ opened: engine.opened!, commitment, length: BigInt(engine.records.length), at, observed: command.observed, directory, snapshots, published: false });
  }

  private openRequest(scope: readonly TermsText[]): string {
    return JSON.stringify({ kind: "open", scope });
  }
  private rescopeRequest(take: readonly TermsText[], keep: readonly string[], evidence: string): string {
    return JSON.stringify({ kind: "rescope", take, keep, evidence });
  }
  private signedTerms(signed: SignedTerms): RootTerms {
    let terms: RootTerms;
    try { terms = decodeRootTerms(signed.terms); } catch (error) {
      if (error instanceof EncodingError) throw new V3StoreError("REFUSED", "the terms do not decode", "TERMS");
      throw error;
    }
    requireThat(verifyRootTermsSignature(signed.terms, signed.signature), "REFUSED", "the backer's signature does not verify");
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
    return openedOf(header, entries);
  }
  /** Authenticated terms in header order, each backing once. */
  private scoped(scope: readonly SignedTerms[]): Scoped[] {
    const entries = scope.map(signed => {
      const terms = this.signedTerms(signed);
      return { backing: rootTermsName(signed.terms), terms, signed: { terms: copyBytes(signed.terms), signature: copyBytes(signed.signature) } };
    }).sort((a, b) => compareBytes(a.backing, b.backing));
    requireThat(entries.every((entry, i) => i === 0 || !same(entries[i - 1]!.backing, entry.backing)), "REFUSED", "the scope names a backing twice", "SCOPE");
    oneClock(entries);
    return entries;
  }
  /** A backing's witnessed term chain at `at` and any pending replacement. */
  private chain(backing: Uint8Array, terms: RootTerms, at: bigint) {
    return replacementChain(admittedReplacements(this.ask(2, backing, at), terms.replacementRule),
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
      const last = engine.signed.at(-1)!, held = heldCommitments(this.ask(1, this.operator, at)).held;
      requireThat(!engine.pendingReturn && same(last.opened.segment, old.segment) && last.length === BigInt(engine.records.length) &&
        held.some(h => hexOf(h.commitment) === hexOf(last.commitment)), "STALE", "an elective scope change first witnesses the whole tail", "TAIL");
    }
    const sequence = (engine.signed.at(-1)?.commitment.sequence ?? 0n) + 1n;
    requireThat(sequence < U64, "STORAGE", "signed sequence counter exhausted");
    const header: SegmentHeader = { domain: this.domain, venue: this.venueId, operator: this.operator, sequence,
      entries: all.map(({ backing }) => ({ backing, link: links.get(bytesToHex(backing))!.link })) };
    return { opened: openedOf(header, all), taken, links };
  }
  private readerOptions() {
    return { configuration: this.configuration, verifier: this.verifier, venue: this.venue, reference: this.reference };
  }
  /** Read every opening from bytes: a taken term by the public reader's
   * complete descent of the evidence, including proof of an empty book, and a
   * kept backing by the journal's own canonical read. No asserted state,
   * selected predecessor or imported signing counter (C2.7, C2.10.4–7). */
  private async prepareRescope(engine: Engine, spec: OwnRescope, at: bigint): Promise<void> {
    const target = this.rescopeTarget(engine, spec, at), openings = new Map<string, CanonicalCheckpoint | undefined>();
    let checkpoints = 0n, events = 0n, provided: EvidenceItem[] = [], evidence = spec.evidence;
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
      try { provided = decodeEvidencePackage(spec.evidence, SERVED_PACKAGE_LIMITS).filter(item => [3, 4, 6, 7].includes(item.kind)); }
      catch (error) { unestablished(error); }
      // A journal with history reads its own checkpoints beside the public
      // evidence: a taken term may follow, or already hold, one of this key's (C2.7.1).
      if (engine.opened !== undefined) evidence = this.encodePackage(engine.opened, engine.signed, engine.signed.at(-1)!.commitment,
        engine.records, engine.archives, [...engine.evidence, ...provided]);
    }
    for (const entry of target.taken) {
      let source: FrontierResult;
      try { source = await readFrontier(evidence, entry.signed, at, this.readerOptions()); } catch (error) { return unestablished(error); }
      const current = source.ranges.chain.at(-1)!;
      requireThat(same(current.link, target.links.get(bytesToHex(entry.backing))!.link), "STALE", "the replacement chain changed during takeover");
      requireThat(source.canonical === undefined || source.canonical.index < current.from, "STALE", "the current successor term already has a carrying checkpoint");
      openings.set(bytesToHex(entry.backing), source.canonical);
      checkpoints += source.work.checkpoints; events += this.reservedEventWork(source);
    }
    for (const name of spec.keep) {
      const source = await this.currentRead(engine, at, name);
      openings.set(bytesToHex(name), source.canonical);
      checkpoints += source.work.checkpoints; events += this.reservedEventWork(source);
    }
    // One import per distinct canonical checkpoint; several are merged once (C2.10.6–7).
    const parents = new Map<string, CanonicalCheckpoint>();
    for (const canonical of openings.values()) if (canonical !== undefined) parents.set(hexOf(canonical.commitment)!, canonical);
    const { imported, work } = this.openingImports([...parents.values()]);
    this.reserveReadCheckpoints(engine, heldCommitments(this.ask(1, this.operator, at)).held, checkpoints, 2n);
    requireThat(events + work <= IMPORT_LIMITS.maxEvents, "REFUSED", "the scope change leaves no reader budget for service", "RESOURCE");
    const header: SegmentHeader = { ...target.opened.header, entries: target.opened.header.entries.map(entry => {
      const canonical = openings.get(bytesToHex(entry.backing));
      return canonical === undefined ? entry : { ...entry, opening: { operator: copyBytes(canonical.commitment.operator),
        sequence: canonical.commitment.sequence, root: copyBytes(canonical.commitment.root) } };
    }) };
    const opened = openedOf(header, target.opened.entries);
    this.diverging = true;
    if (engine.opened !== undefined) engine.archives.push({ opened: engine.opened, records: [...engine.records] });
    if (target.taken.length > 0) {
      const retained = new Map(engine.evidence.map(item => [`${item.kind}:${bytesToHex(sha256(item.payload))}`, item]));
      for (const item of provided) if (item.kind !== 7) retained.set(`${item.kind}:${bytesToHex(sha256(item.payload))}`, item);
      engine.evidence.splice(0, engine.evidence.length, ...retained.values());
    }
    engine.records.splice(0);
    engine.opened = opened;
    engine.state = openSegmentState(opened.segment, undefined, imported, undefined, () => {});
    engine.pendingReturn = true;
  }
  /**
   * An opening's import and the event work a reader spends reading it beyond its
   * parents' own reads: a scope reader merges every distinct parent's events,
   * comparing events that share a tag or demand (C2.10.6), then reads the merged
   * ancestry once more; a single-backing reader reads one parent's ancestry only.
   * Both are counted, so the reservation never falls short of either reader.
   */
  private openingImports(parents: readonly CanonicalCheckpoint[]): { readonly imported: ImportedState | undefined; readonly work: bigint } {
    let work = 0n, merged;
    try { merged = mergeFinalizedPrefixes(parents.map(parent => ({ state: parent.state })), amount => { work += amount; }); } catch (error) {
      if (error instanceof ReplayRefusal) throw new V3StoreError("UNAVAILABLE", "the imported histories conflict");
      throw error;
    }
    const imported = parents.length === 0 ? undefined : parents.length === 1 ? parents[0]!.state : merged;
    return { imported, work: work + BigInt(merged.events.size) };
  }
  /** Each scoped K's revocation index as witnessed through `at`. */
  private revocations(opened: Opened, at: bigint): Map<string, bigint | undefined> {
    return new Map(opened.entries.map(({ backing, terms }) => [bytesToHex(backing), revocationIndex(this.ask(3, terms.obligor, at))]));
  }
  /** Admission, or a stored judgment, under the scope's terms and each scoped K's revocation. */
  private replayOf(opened: Opened, horizon: bigint, revocations: ReadonlyMap<string, bigint | undefined>): SegmentReplay {
    const first = opened.entries[0]!, scoped = opened.entries.length > 1;
    return { domain: this.domain, backing: first.backing, segment: opened.segment, scope: opened.scope, terms: first.terms,
      ...(scoped ? { scopedTerms: new Map(opened.entries.map(entry => [bytesToHex(entry.backing), entry.terms])), revocations } :
        { revokedAt: revocations.get(bytesToHex(first.backing)) }),
      verifier: this.verifier, index: horizon, lag: this.lag, admission: true, block: [] };
  }
  /** Every scoped backing's current snapshot and the directory over them (§7, C2.10.3). */
  private checkpoint(engine: Engine): { readonly directory: readonly SnapshotDigest[]; readonly snapshots: readonly Uint8Array[] } {
    const opened = engine.opened!, state = engine.state!;
    const snapshots: Snapshot[] = opened.entries.map(({ backing }) => {
      const totals = state.totals.get(bytesToHex(backing)) ?? { issued: 0n, burned: 0n };
      return { backing, segment: opened.segment, historyHash: state.history, evidenceHash: state.evidence, issued: totals.issued, burned: totals.burned };
    });
    return { directory: snapshots.map(s => ({ name: copyBytes(s.backing), digest: snapshotDigest(s) })), snapshots: snapshots.map(snapshotBytes) };
  }
  /** The receipt of the record just applied at the state's position (§7.2), after the last signed commitment. */
  private receipt(engine: Engine, bytes: Uint8Array): Uint8Array {
    const opened = engine.opened!, state = engine.state!, record = decodeRecord(bytes);
    const fields = { domain: this.domain, segment: opened.segment, scopeRoot: opened.scope, position: state.position,
      ...evidenceHashes(record), historyHash: state.history, after: engine.signed.at(-1)!.commitment.sequence };
    return encodeReceipt({ ...fields, operator: this.operator, signature: ed25519.sign(receiptBytes(fields), this.secret) });
  }

  /** §13 answer over [0, now]; a venue that cannot answer leaves the operation unavailable. */
  private ask(kind: RecordKind, subject: Uint8Array, now: bigint): RangeAnswer {
    const request = Object.freeze({ venue: copyBytes(this.venueId), kind, subject: copyBytes(subject), fromIndex: 0n, toIndex: now });
    try {
      const bytes: unknown = this.venue.range(request, RANGE_LIMITS);
      if (!(bytes instanceof Uint8Array)) throw new V3StoreError("UNAVAILABLE", "the venue has no answer");
      return decodeRangeAnswer(bytes, request, RANGE_LIMITS);
    } catch (error) {
      if (error instanceof VenueError || error instanceof RangeLimitError || error instanceof EncodingError) {
        throw new V3StoreError("UNAVAILABLE", "the venue has no answer");
      }
      throw error;
    }
  }
  private view(engine: Engine): View {
    const now = this.clock(), answer = this.ask(1, this.operator, now), held = heldCommitments(answer).held;
    const signed = new Set(engine.signed.map(s => hexOf(s.commitment)));
    // C2.3.3 selects held state; it does not erase evidence that another
    // process has signed with this key (§13.3, invariant 22). Exact local
    // bytes were authenticated when signed or reloaded. Verify every other
    // same-key record before treating it as a conflict, including old twins.
    const conflict = answer.entries.some(entry => {
      if (signed.has(bytesToHex(entry.record))) return false;
      let c: Commitment;
      try { c = decodeCommitment(entry.record); }
      catch (error) { if (error instanceof EncodingError) return false; throw error; }
      return same(c.operator, this.operator) && verifyCommitment(c);
    });
    const boundaries: bigint[] = [], revocations = new Map<string, bigint | undefined>(), requests = new Map<string, bigint>();
    const evidence: string[] = [];
    const bind = (answer: RangeAnswer): void => {
      evidence.push(JSON.stringify(answer.entries.map(e => [e.index.toString(), e.ordinal.toString(), bytesToHex(sha256(e.record))])));
    };
    bind(answer);
    // Every scoped backing's term chain, K's revocation and publications; the
    // scope's schedule follows its earliest term boundary (C2.10.9).
    for (const { backing, terms } of engine.opened?.entries ?? []) {
      const replacements = this.ask(2, backing, now); bind(replacements);
      const admitted = admittedReplacements(replacements, terms.replacementRule);
      const { chain, pending } = replacementChain(admitted, { backing, original: terms.operator, lag: this.lag, now });
      const term = chain.findIndex(link => same(link.link, linkOf(engine.opened!, backing)) && same(link.operator, this.operator));
      requireThat(term >= 0, "STALE", "the segment's term is not in the witnessed chain");
      const end = chain[term + 1]?.from ?? pending?.from;
      if (end !== undefined) boundaries.push(end);
      const revoked = this.ask(3, terms.obligor, now); bind(revoked);
      revocations.set(bytesToHex(backing), revocationIndex(revoked));
      const operators = new Map(chain.map(link => [bytesToHex(link.operator), link.operator]));
      for (const operator of operators.values()) if (!same(operator, this.operator)) bind(this.ask(1, operator, now));
      if (terms.silence !== undefined || terms.nonService !== undefined) {
        const publications = this.ask(4, backing, now); bind(publications);
        if (terms.nonService !== undefined) requests.set(bytesToHex(backing), BigInt(publications.entries.length));
      }
    }
    const key = JSON.stringify([now.toString(), evidence, conflict, boundaries.map(String),
      [...revocations].map(([name, at]) => [name, at?.toString() ?? null])]);
    return { now, lag: this.lag, held, conflict, boundaries, revocations, requests, key };
  }
  private exclusive(view: View): void {
    requireThat(!view.conflict, "CONFLICT", "the venue contains a commitment this journal did not sign");
  }
  private stable(engine: Engine, view: View): void {
    const current = this.view(engine);
    this.exclusive(current);
    requireThat(current.key === view.key, "STALE", "the venue changed during the journal operation");
  }
  private signingSchedule(view: View, admission = false): void {
    const schedule = scopeSchedule({ now: view.now, lag: view.lag, boundaries: view.boundaries,
      ...(this.resumedAt === undefined ? {} : { resumedAt: this.resumedAt }) });
    requireThat(!schedule.lapsed, "STALE", "the operator's term has ended");
    requireThat(admission ? schedule.admissionOpen : schedule.commitNow, "SCHEDULE", "the scope's signing schedule is closed");
  }
  private isHeld(view: View, signed: Signed): boolean {
    const held = view.held.find(h => h.commitment.sequence === signed.commitment.sequence);
    return held !== undefined && hexOf(held.commitment) === hexOf(signed.commitment);
  }
  /** Service needs the current signed state, the scope's schedule open, and for issuance an unrevoked backer. */
  private async ready(engine: Engine, view: View, action: "admit" | "commit"): Promise<void> {
    this.exclusive(view);
    requireThat(engine.opened !== undefined && engine.state !== undefined, "STALE", "open the segment first");
    requireThat(!engine.pendingReturn, "STALE", "the return opening must be witnessed and its block adopted before service");
    const last = engine.signed.at(-1)!, latest = hexOf(view.held.at(-1)?.commitment);
    const current = latest === hexOf(last.commitment) || (last.published && view.now < last.at + view.lag && latest === last.observed);
    requireThat(current, "STALE", "the signed state is not current");
    const schedule = scopeSchedule({ now: view.now, lag: view.lag, boundaries: view.boundaries,
      ...(this.isHeld(view, last) ? {} : { unwitnessedSignedAt: last.at }), ...(this.resumedAt === undefined ? {} : { resumedAt: this.resumedAt }) });
    requireThat(!schedule.lapsed, "STALE", "the operator's term has ended");
    requireThat(action === "admit" ? schedule.admissionOpen : schedule.commitNow, "SCHEDULE", "the scope's signing schedule is closed");
    if (engine.evidence.length > 0 || engine.opened.entries.some(({ terms }) => terms.silence !== undefined || terms.nonService !== undefined)) {
      const source = await this.currentRead(engine, view.now);
      this.serviceClock(source, view.now);
      this.reserveReadCheckpoints(engine, view.held, source.work.checkpoints);
      this.reserveEvents(engine, source, (action === "admit" ? 1n : 0n) + this.otherRequests(engine, view));
    }
    for (const { backing } of engine.opened.entries) {
      const revokedAt = view.revocations.get(bytesToHex(backing));
      if (revokedAt === undefined) continue;
      // Only issuance finalized before K's revocation stays; a later tail needs recovery (slice 3).
      let finalized = 0n;
      for (const signed of engine.signed) {
        const held = view.held.find(h => h.commitment.sequence === signed.commitment.sequence);
        if (same(signed.opened.segment, engine.opened.segment) && held !== undefined && hexOf(held.commitment) === hexOf(signed.commitment) && held.index < revokedAt && signed.length > finalized) finalized = signed.length;
      }
      requireThat(!engine.records.slice(Number(finalized)).some(bytes => {
        const record = decodeRecord(bytes);
        return record.kind === 1 && same(identifierOf(record.publicInputs[5]!, record.publicInputs[6]!), backing);
      }), "UNSUPPORTED", "issuance without pre-revocation finality needs recovery");
    }
  }

  /** Read all dependencies from bytes, including later lapsed/excluded signed
   * checkpoints. Trying an older selection never omits those checkpoints.
   * The read selects `backing` (by default the scope's first) in any scope. */
  private async currentRead(engine: Engine, at: bigint, backing = engine.opened?.entries[0]!.backing): Promise<StateRead> {
    const opened = engine.opened;
    requireThat(opened !== undefined && backing !== undefined, "STALE", "there is no segment to read");
    const held = heldCommitments(this.ask(1, this.operator, at)).held;
    for (const candidate of [...engine.signed].reverse()) {
      if (!held.some(h => hexOf(h.commitment) === hexOf(candidate.commitment))) continue;
      if (!candidate.directory.some(entry => same(entry.name, backing))) continue;
      const c = candidate.commitment;
      const bytes = this.encodePackage(opened, engine.signed, c, engine.records, engine.archives, engine.evidence);
      try {
        const result = await readPackage(bytes, { mode: "historical-fixture", domain: this.domain, venue: this.venueId,
          backing, operator: this.operator, sequence: c.sequence, root: c.root, judgingIndex: at }, this.readerOptions());
        requireThat(result.state !== undefined, "UNAVAILABLE", "a journal state read returned a receipt");
        return result;
      } catch (error) {
        if (error instanceof ReplayRefusal || (error instanceof EvidenceRefusal && error.status === "lapsed-selection")) continue;
        if (error instanceof EvidenceRefusal) throw new V3StoreError("UNAVAILABLE", `canonical evidence: ${error.status}`);
        throw error;
      }
    }
    throw new V3StoreError("UNAVAILABLE", "no canonical witnessed checkpoint is available");
  }

  private serviceClock(source: StateRead, now: bigint): void {
    const clock = source.clock;
    if (clock === null) return;
    if (clock.boundary !== null && BigInt(clock.boundary) <= now) throw new V3StoreError("STALE", "the segment is permanently retired by silence", "SILENCE");
    if (now + this.lag - source.canonical.index > BigInt(clock.duration)) {
      throw new V3StoreError("SCHEDULE", "the witnessing horizon reaches silence", "SILENCE");
    }
  }

  /** Every signed checkpoint can still reach the venue. Deduplicated package
   * bytes do not bound the reader's checkpoint work, so reserve that separately. */
  private reserveCheckpoint(engine: Engine, count = 1n): void {
    if (BigInt(engine.signed.length) + count > IMPORT_LIMITS.maxCheckpoints) {
      throw new V3StoreError("REFUSED", "the next checkpoint exceeds the reader's work budget", "RESOURCE");
    }
  }
  /** Held public ancestry plus every own unheld signing that can still land,
   * and the checkpoint(s) needed to finalize the proposed work. */
  private reserveReadCheckpoints(engine: Engine, held: readonly HeldCommitment[], checkpoints: bigint, count = 1n): void {
    const known = new Set(held.map(h => hexOf(h.commitment)));
    const unheld = BigInt(engine.signed.filter(signed => !known.has(hexOf(signed.commitment))).length);
    requireThat(checkpoints + unheld + count <= IMPORT_LIMITS.maxCheckpoints, "REFUSED", "the next checkpoint exceeds the reader's work budget", "RESOURCE");
  }

  /** Known record-prefix work for the next continuation. A first continuation
   * with an adopted block replays from the imported frontier, not its empty
   * opening. Later independent venue publications can still exhaust a reader's
   * local budgets; no journal can bound what other parties publish. */
  private reserveEvents(engine: Engine, source: StateRead, extra: bigint): void {
    const unadopted = this.unadopted(source);
    const rebuild = source.canonical.commitment.sequence === engine.opened!.header.sequence && unadopted.length > 0;
    const ancestry = rebuild ? BigInt(new Map(source.state.resumeKey.imported?.events).size) : 0n;
    const records = BigInt(engine.records.length) + extra - (rebuild ? 0n : source.state.position);
    if (this.reservedEventWork(source) + ancestry + records > IMPORT_LIMITS.maxEvents) {
      throw new V3StoreError("REFUSED", "the continuation exceeds the reader's event budget", "RESOURCE");
    }
  }

  /** Forced publications after the canonical state's adoption index of their
   * backing, through its index, in venue order: an opening's exact block (C2b.4.1). */
  private unadopted(source: StateRead): readonly ScopeForcedPublication[] {
    const { state, canonical } = source;
    return source.force.filter(event => event.index <= canonical.index &&
      event.index > (event.backing === undefined ? state.adoptionIndex : state.adoptionIndices.get(event.backing) ?? 0n));
  }

  /** The journal reads the scope's first backing. A reader selecting another
   * backing with a non-service clause may also read its publications and check
   * one request proof per publication (C2b.5.2); reserve both for each. */
  private otherRequests(engine: Engine, view: View): bigint {
    return (engine.opened?.entries.slice(1) ?? []).reduce((sum, { backing }) => sum + 2n * (view.requests.get(bytesToHex(backing)) ?? 0n), 0n);
  }

  /** Known requests may enter the counting window before the next checkpoint. */
  private reservedEventWork(source: Pick<StateRead, "work">): bigint {
    return source.work.events - source.work.requestProofs + source.work.requestProofReserve;
  }

  /** Change only the in-memory segment; the caller atomically records the
   * signed empty opening. Old bytes stay as evidence, not live accepted state. */
  private prepareReturn(engine: Engine, source: StateRead, at: bigint): void {
    const old = engine.opened!;
    requireThat(!engine.pendingReturn && source.clock?.boundary !== null && source.clock?.boundary !== undefined &&
      BigInt(source.clock.boundary) <= at && same(source.canonical.segment, old.segment), "STALE", "return needs the active segment's witnessed silence boundary");
    const sequence = engine.signed.at(-1)!.commitment.sequence + 1n;
    requireThat(sequence < U64, "STORAGE", "signed sequence counter exhausted");
    // The whole scope returns from its one canonical checkpoint (C2.10.3).
    const predecessor = source.canonical.commitment;
    const header: SegmentHeader = { ...old.header, sequence, entries: old.header.entries.map(({ backing, link }) => ({ backing, link,
      opening: { operator: copyBytes(predecessor.operator), sequence: predecessor.sequence, root: copyBytes(predecessor.root) } })) };
    const opened = openedOf(header, old.entries);
    engine.archives.push({ opened: old, records: [...engine.records] });
    engine.records.splice(0);
    engine.opened = opened;
    engine.state = openSegmentState(opened.segment, undefined, source.state, undefined, () => {});
    engine.pendingReturn = true;
  }

  /** The verified opening determines the exact block. Force was checked by
   * the reader at each original index; adoption changes the fresh local tree. */
  private async applyAdoption(engine: Engine, source: StateRead, beforeReceipt?: () => void): Promise<Uint8Array[]> {
    const opened = engine.opened!, state = engine.state!;
    requireThat(engine.pendingReturn && source.canonical.commitment.sequence === opened.header.sequence &&
      same(source.canonical.segment, opened.segment), "STALE", "the witnessed opening is not this return");
    const block = this.unadopted(source), receipts: Uint8Array[] = [];
    const replay: SegmentReplay = { ...this.replayOf(opened, source.canonical.index, this.revocations(opened, source.canonical.index)),
      admission: false, block };
    for (const event of block) {
      await applyRecord(state, event.bytes, replay);
      engine.records.push(copyBytes(event.bytes));
      // Live adoption rechecks after every await and before signing; journal
      // reload only reproduces already durable replies and supplies no guard.
      beforeReceipt?.();
      const receipt = this.receipt(engine, event.bytes), identity = bytesToHex(statementHash(event.record));
      receipts.push(receipt);
      if (!engine.receipts.has(identity)) engine.receipts.set(identity, receipt);
    }
    engine.pendingReturn = false;
    return receipts;
  }

  /** C2b.4.1: sign an empty successor only after witnessed silence. This does
   * not authorize service; publish, wait for witnessing, then call adopt(). */
  async return(id: string): Promise<Commitment> {
    const commandId = this.commandId(id);
    return this.run(async engine => {
      const prior = this.prior(commandId, "return");
      if (prior !== undefined) return decodeCommitment(hexToBytes(prior));
      const view = this.view(engine);
      this.exclusive(view);
      requireThat(engine.opened !== undefined && !engine.pendingReturn, "STALE", "a return is already pending or no segment exists");
      this.reserveCheckpoint(engine, 2n); // Empty return and its service continuation.
      const schedule = scopeSchedule({ now: view.now, lag: view.lag, boundaries: view.boundaries,
        ...(this.resumedAt === undefined ? {} : { resumedAt: this.resumedAt }) });
      requireThat(!schedule.lapsed && schedule.commitNow, "SCHEDULE", "return signing is outside the operator's term");
      const source = await this.currentRead(engine, view.now);
      this.reserveReadCheckpoints(engine, view.held, source.work.checkpoints, 2n);
      if (this.reservedEventWork(source) + this.openingImports([source.canonical]).work + this.otherRequests(engine, view) > IMPORT_LIMITS.maxEvents) {
        throw new V3StoreError("REFUSED", "the return exceeds the reader's ancestry budget", "RESOURCE");
      }
      this.diverging = true;
      this.prepareReturn(engine, source, view.now);
      const opened = engine.opened!, { directory, snapshots } = this.checkpoint(engine), observed = hexOf(view.held.at(-1)?.commitment);
      const previous = engine.signed.at(-1)!.commitment;
      this.encodePackage(opened, [...engine.signed, { directory, snapshots }], previous, [], engine.archives, engine.evidence);
      const commitment = this.transaction(() => {
        this.stable(engine, view);
        const c = signCommitment(this.secret, opened.header.sequence, directoryRoot(directory));
        this.append(engine, commandId, "return", { kind: "return", at: view.now.toString(), observed }, bytesToHex(encodeCommitment(c)));
        return c;
      });
      engine.signed.push({ opened, commitment, length: 0n, at: view.now, observed, directory, snapshots, published: false });
      engine.revision++;
      return copyCommitment(commitment);
    });
  }

  /** C2b.4.2: wait for the actual opening index r and re-read through r before
   * co-signing its exact adopted block. Exact retry returns the same receipts. */
  async adopt(): Promise<readonly Uint8Array[]> {
    return this.run(async engine => {
      const opened = engine.opened;
      requireThat(opened !== undefined, "STALE", "no return opening exists");
      const id = `adopt:${opened.header.sequence}`, prior = this.prior(id, "adopt");
      if (prior !== undefined) return (JSON.parse(prior) as string[]).map(hexToBytes);
      requireThat(engine.pendingReturn, "STALE", "the segment is not a pending return");
      const view = this.view(engine), held = view.held.find(h => h.commitment.sequence === opened.header.sequence);
      this.exclusive(view);
      this.signingSchedule(view, true);
      requireThat(held !== undefined && hexOf(held.commitment) === hexOf(engine.signed.at(-1)!.commitment), "UNAVAILABLE", "the return opening is not witnessed");
      const current = await this.currentRead(engine, view.now);
      this.serviceClock(current, view.now);
      this.reserveReadCheckpoints(engine, view.held, current.work.checkpoints);
      const source = await this.currentRead(engine, held.index);
      const block = this.unadopted(source);
      this.reserveCheckpoint(engine);
      this.reserveEvents(engine, current, BigInt(block.length) + this.otherRequests(engine, view));
      this.encodePackage(opened, [...engine.signed, this.placeholder(opened)],
        held.commitment, [...engine.records, ...block.map(event => event.bytes)], engine.archives, engine.evidence);
      this.diverging = true;
      const receipts = await this.applyAdoption(engine, source, () => {
        this.stable(engine, view); this.signingSchedule(view, true);
      }), { directory, snapshots } = this.checkpoint(engine);
      this.encodePackage(opened, [...engine.signed, { directory, snapshots }], held.commitment, engine.records, engine.archives, engine.evidence);
      this.transaction(() => {
        this.stable(engine, view);
        this.append(engine, id, "adopt", { kind: "adopt", at: held.index.toString(), opening: opened.header.sequence.toString() }, JSON.stringify(receipts.map(bytesToHex)));
      });
      engine.revision++;
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
  private append(engine: Engine, id: string, request: string, command: Command, response: string): void {
    this.diverging = true;
    requireThat(engine.revision < SQLITE_LIMIT, "STORAGE", "journal is full");
    this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?)").run(engine.revision + 1n, id, request, commandText(command), response);
    this.db.prepare("UPDATE identity SET tip=?,observed=? WHERE id=1").run(engine.revision + 1n, this.observedIndex.toString());
    // Memory follows only after SQLite commits; every uncertain outcome reloads.
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
      requireThat(engine.opened === undefined, "UNSUPPORTED", "the journal holds one genesis segment");
      const opened = this.opening(own), view = this.view(engine);
      this.exclusive(view);
      requireThat(view.held.length === 0, "CONFLICT", "this key already has commitments on the venue");
      // A witnessed replacement ends a term at its effective index: the opening is signed by C2.6.1's last signing index.
      const boundaries: bigint[] = [];
      for (const { backing, terms } of opened.entries) {
        const { chain, pending } = this.chain(backing, terms, view.now);
        requireThat(chain.length === 1, "STALE", "the operator's term has ended");
        requireThat(revocationIndex(this.ask(3, terms.obligor, view.now)) === undefined, "UNSUPPORTED", "the backer has revoked K");
        if (pending !== undefined) boundaries.push(pending.from);
      }
      const schedule = scopeSchedule({ now: view.now, lag: view.lag, boundaries,
        ...(this.resumedAt === undefined ? {} : { resumedAt: this.resumedAt }) });
      requireThat(schedule.commitNow, "SCHEDULE", "the opening's signing schedule is closed");
      const state = openSegmentState(opened.segment, undefined, undefined, undefined, () => {});
      const { directory, snapshots } = this.checkpoint({ ...engine, opened, state });
      this.encodePackage(opened, [{ directory, snapshots }], this.unsigned(1n, directory), []);
      const commitment = this.transaction(() => {
        this.stable(engine, view);
        const c = signCommitment(this.secret, 1n, directoryRoot(directory));
        this.append(engine, commandId, request, { kind: "open", scope, at: view.now.toString(), observed: null }, bytesToHex(encodeCommitment(c)));
        return c;
      });
      engine.opened = opened; engine.state = state;
      engine.signed.push({ opened, commitment, length: 0n, at: view.now, observed: null, directory, snapshots, published: false });
      engine.revision++;
      return copyCommitment(commitment);
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
    const texts = take.map(termsText), names = keep.map(name => bytesToHex(name)), encoded = bytesToHex(evidence);
    const request = this.rescopeRequest(texts, names, encoded);
    return this.run(async engine => {
      const prior = this.prior(commandId, request);
      if (prior !== undefined) return decodeCommitment(hexToBytes(prior));
      const at = this.clock(), target = this.rescopeTarget(engine, own, at);
      const view = this.view({ ...engine, opened: target.opened });
      requireThat(view.now === at, "STALE", "the venue changed during the scope change");
      this.exclusive(view); this.signingSchedule(view);
      this.reserveCheckpoint(engine, 2n);
      await this.prepareRescope(engine, own, at);
      const opened = engine.opened!, { directory, snapshots } = this.checkpoint(engine), observed = hexOf(view.held.at(-1)?.commitment);
      // Budget the exact wire shape before signing. Signature bytes have fixed size.
      this.encodePackage(opened, [...engine.signed, { directory, snapshots }], this.unsigned(opened.header.sequence, directory), [],
        engine.archives, engine.evidence);
      const commitment = this.transaction(() => {
        this.stable(engine, view);
        const c = signCommitment(this.secret, opened.header.sequence, directoryRoot(directory));
        this.append(engine, commandId, request, { kind: "rescope", take: texts, keep: names, evidence: encoded, at: at.toString(), observed },
          bytesToHex(encodeCommitment(c)));
        return c;
      });
      engine.signed.push({ opened, commitment, length: 0n, at, observed, directory, snapshots, published: false });
      engine.revision++;
      return copyCommitment(commitment);
    });
  }

  /** C2.7: activate one witnessed successor term from public evidence alone;
   * a `rescope` that takes that term and keeps nothing else. */
  takeover(id: string, signed: SignedTerms, evidence: Uint8Array): Promise<Commitment> {
    return this.rescope(id, { take: [signed], evidence });
  }
  /** A commitment's wire size before signing: signatures have fixed width. */
  private unsigned(sequence: bigint, directory: readonly SnapshotDigest[]): Commitment {
    return { operator: this.operator, sequence, root: directoryRoot(directory), signature: new Uint8Array(64) };
  }
  /** A checkpoint's wire size before its state is known: every scoped snapshot
   * and directory entry has fixed width; distinct fills never deduplicate. */
  private placeholder(opened: Opened): Pick<Signed, "directory" | "snapshots"> {
    return { directory: opened.entries.map(({ backing }) => ({ name: backing, digest: new Uint8Array(32) })),
      snapshots: opened.entries.map((_, i) => { const bytes = new Uint8Array(SNAPSHOT_BYTES); new DataView(bytes.buffer).setUint32(0, i + 1); return bytes; }) };
  }

  /**
   * Admit one kind 1–6 record at the horizon (the read index plus the lag)
   * and return its original signed receipt record (§7.2). An exact statement
   * already admitted returns its original receipt, even with another proof.
   */
  async submit(record: Uint8Array): Promise<Uint8Array> {
    let bytes: Uint8Array, hash: string;
    try { bytes = encodeRecord(decodeRecord(copyBytes(record))); hash = bytesToHex(statementHash(decodeRecord(bytes))); } catch (error) {
      if (error instanceof EncodingError) throw new V3StoreError("REFUSED", "the record does not decode", "MALFORMED");
      throw error;
    }
    return this.run(async engine => {
      const prior = engine.receipts.get(hash);
      if (prior !== undefined) return copyBytes(prior);
      const view = this.view(engine);
      this.reserveCheckpoint(engine);
      await this.ready(engine, view, "admit");
      const opened = engine.opened!, state = engine.state!, horizon = view.now + view.lag;
      requireThat(horizon < U64, "SCHEDULE", "the horizon is past the venue's index space");
      // The checkpoint that will carry this record must still be served within the reader's budget.
      const last = engine.signed.at(-1)!;
      this.encodePackage(opened, [...engine.signed, this.placeholder(opened)],
        last.commitment, [...engine.records, bytes], engine.archives, engine.evidence);
      const before = state.position;
      try { await applyRecord(state, bytes, this.replayOf(opened, horizon, view.revocations)); }
      catch (error) {
        if (state.position !== before) this.diverging = true;
        if (error instanceof ReplayRefusal) throw new V3StoreError("REFUSED", `admission refused: ${error.check}`, error.check);
        if (error instanceof EvidenceRefusal) throw new V3StoreError("UNSUPPORTED", "the record needs evidence admission does not hold");
        throw error;
      }
      this.diverging = true;
      const receipt = this.transaction(() => {
        // The proof was verified between the reads; judge against the same view or not at all.
        this.stable(engine, view);
        const r = this.receipt(engine, bytes);
        this.append(engine, `statement:${hash}`, hash, { kind: "admit", record: bytesToHex(bytes), horizon: horizon.toString() }, bytesToHex(r));
        return r;
      });
      engine.records.push(bytes); engine.receipts.set(hash, receipt); engine.horizon = horizon; engine.revision++;
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
      this.reserveCheckpoint(engine);
      await this.ready(engine, view, "commit");
      const last = engine.signed.at(-1)!, sequence = last.commitment.sequence + 1n;
      requireThat(sequence < U64, "STORAGE", "signed sequence counter exhausted");
      const { directory, snapshots } = this.checkpoint(engine), observed = hexOf(view.held.at(-1)?.commitment);
      this.encodePackage(engine.opened!, [...engine.signed, { directory, snapshots }], last.commitment, engine.records, engine.archives, engine.evidence);
      const commitment = this.transaction(() => {
        this.stable(engine, view);
        const c = signCommitment(this.secret, sequence, directoryRoot(directory));
        this.append(engine, commandId, "commit", { kind: "commit", at: view.now.toString(), observed }, bytesToHex(encodeCommitment(c)));
        return c;
      });
      engine.signed.push({ opened: engine.opened!, commitment, length: BigInt(engine.records.length), at: view.now, observed, directory, snapshots, published: false });
      engine.revision++;
      return copyCommitment(commitment);
    });
  }

  /** Publish the latest signed commitment from the outbox, unless the venue already holds exactly it. */
  async publish(): Promise<Commitment> {
    return this.run(async engine => {
      const last = engine.signed.at(-1);
      requireThat(last !== undefined, "STALE", "no signed commitment to publish");
      const held = this.isHeld(this.view(engine), last);
      this.transaction(() => {}); // Fence again before the venue call.
      if (!held) {
        try { await this.venue.publishRecord(1, this.operator, encodeCommitment(last.commitment)); } catch (error) {
          if (error instanceof VenueError) throw new V3StoreError("UNAVAILABLE", "the venue did not take the commitment");
          throw error;
        }
      }
      if (!last.published) {
        this.transaction(() => this.append(engine, `published:${last.commitment.sequence}`, "published",
          { kind: "published", sequence: last.commitment.sequence.toString() }, ""));
        last.published = true; engine.revision++;
      }
      return copyCommitment(last.commitment);
    });
  }

  /**
   * The served §12 package: the configuration, `selected`, every directory and
   * snapshot of `signed`, and the one trail through `records`, whose prefixes
   * serve each earlier checkpoint (§12.1). A package past the reader's budget
   * (`TRAIL_LIMITS`, `SERVED_PACKAGE_LIMITS` with room for one receipt) refuses as RESOURCE, so the
   * journal admits and signs only what it can still serve.
   */
  private encodePackage(opened: Opened, signed: readonly Pick<Signed, "directory" | "snapshots">[], selected: Commitment,
    records: readonly Uint8Array[], archives: Engine["archives"] = [], evidence: Engine["evidence"] = []): Uint8Array {
    try {
      const payloads = new Map<string, EvidenceItem>();
      const add = (kind: number, payload: Uint8Array): void => { payloads.set(`${kind}:${bytesToHex(sha256(payload))}`, { kind, payload }); };
      for (const item of evidence) add(item.kind, item.payload);
      add(1, configurationBytes(this.configuration)); add(2, encodeCommitment(selected));
      const termsOf = (scope: Opened): SignedTerms[] => scope.entries.map(entry => entry.signed);
      add(6, encodeTrail({ header: opened.headerBytes, terms: termsOf(opened), records }, TRAIL_LIMITS));
      for (const archive of archives) add(6, encodeTrail({ header: archive.opened.headerBytes, terms: termsOf(archive.opened), records: archive.records }, TRAIL_LIMITS));
      for (const s of signed) { add(3, encodeEvidenceDirectory(s.directory, SERVED_PACKAGE_LIMITS)); for (const snapshot of s.snapshots) add(4, snapshot); }
      const items = [...payloads.values()].sort((a, b) => a.kind - b.kind || compareBytes(sha256(a.payload), sha256(b.payload)));
      return encodeEvidencePackage(items, SERVED_ROOM);
    } catch (error) {
      if (error instanceof TrailLimitError || error instanceof PackageLimitError) {
        throw new V3StoreError("REFUSED", "the served package would pass the reader's budget", "RESOURCE");
      }
      throw error;
    }
  }

  /**
   * The §12 package for the latest commitment published or held on the venue,
   * with every checkpoint signed through it. Records admitted after it are not
   * served, nor is a commitment still in the outbox. A held one counts even
   * where a lost reply left its publication unrecorded. The selection names
   * `backing` (by default the scope's first); a reader selects its own.
   */
  async package(backing?: Uint8Array): Promise<ServedPackage> {
    const named = backing === undefined ? undefined : copyBytes(backing);
    return this.run(async engine => {
      const view = this.view(engine), opened = engine.opened, at = engine.signed.findLastIndex(s => s.published || this.isHeld(view, s));
      requireThat(opened !== undefined && at >= 0, "STALE", "no published commitment to serve");
      const selected = engine.signed[at]!, through = engine.signed.slice(0, at + 1);
      // The selection names `backing`, by default the scope's first; its directory must carry it.
      const name = named ?? selected.opened.entries[0]!.backing;
      requireThat(selected.directory.some(entry => same(entry.name, name)), "REFUSED", "the served commitment does not carry the backing", "SCOPE");
      return { selection: { domain: copyBytes(this.domain), venue: copyBytes(this.venueId), backing: copyBytes(name),
        operator: copyBytes(this.operator), sequence: selected.commitment.sequence, root: copyBytes(selected.commitment.root) },
      package: this.encodePackage(opened, through, selected.commitment,
        same(selected.opened.segment, opened.segment) ? engine.records.slice(0, Number(selected.length)) : [], engine.archives, engine.evidence) };
    });
  }

  close(): void {
    requireThat(!this.busy, "BUSY", "cannot close during a journal operation");
    if (!this.closed) { this.db.close(); this.secret.fill(0); this.engine = undefined; this.closed = true; }
  }
}
