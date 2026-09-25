// Node 24 optional entry point. The pool-v3 operator journal (v3 runtime plan,
// slice 1): one durable command log per operator key and venue, fenced to one
// owner, on PoolStore's SQLite pattern. It opens the genesis segment of one
// backing, admits issue, spend and burn through the state machine's admission
// mode (state.ts) with original signed receipts (§7.2), signs checkpoint
// commitments over v3 directories and snapshots (§7), publishes them through
// the record venue from an outbox, and serves §12 packages a reader verifies
// alone. Imports, recovery kinds, replacement and several backings are later
// slices; a journal reopened after a restart replays its commands.
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
import {
  admittedReplacements, decodeRangeAnswer, heldCommitments, RangeLimitError, replacementChain, revocationIndex,
  type HeldCommitment, type RangeAnswer, type RecordKind,
} from "../../record-range.js";
import type { RecordPublisher, RecordVenue } from "../../record-venue.js";
import { VenueError } from "../../venue-error.js";
import { decodeCommitment, directoryRoot, encodeCommitment, signCommitment, verifyCommitment, type Commitment, type SnapshotDigest } from "../../venue-records.js";
import { scopeSchedule } from "../schedule.js";
import { ScopeTree } from "../scope.js";
import { encodeReceipt, receiptBytes, snapshotBytes, snapshotDigest, type Snapshot } from "./commitments.js";
import { configurationBytes, configurationHash, type CandidateConfiguration } from "./configuration.js";
import { requireReferenceVenue, type VenueReference } from "./guard.js";
import { segmentBytes, segmentIdentity, type SegmentHeader } from "./headers.js";
import { encodeEvidenceDirectory, encodeEvidencePackage, PackageLimitError, type EvidenceItem, type PackageLimits } from "./package.js";
import { RANGE_LIMITS, TRAIL_LIMITS, type SignedTerms } from "./reader.js";
import { decodeRecord, encodeRecord, evidenceHashes, statementHash } from "./records.js";
import { EvidenceRefusal, ReplayRefusal } from "./refusals.js";
import { applyRecord, openSegmentState, type ProofCheck, type SegmentReplay, type SegmentState } from "./state.js";
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
function requireThat(ok: boolean, code: V3StoreError["code"], message: string): asserts ok {
  if (!ok) throw new V3StoreError(code, message);
}
function decimal(value: unknown): bigint {
  requireThat(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), "STORAGE", "invalid stored counter");
  return BigInt(value);
}

type Command =
  | { kind: "open"; terms: string; signature: string; at: string; observed: string | null }
  | { kind: "commit"; at: string; observed: string | null }
  | { kind: "admit"; record: string; horizon: string }
  | { kind: "published"; sequence: string };
function commandText(c: Command): string {
  switch (c?.kind) {
    case "open": return JSON.stringify({ kind: c.kind, terms: c.terms, signature: c.signature, at: c.at, observed: c.observed });
    case "commit": return JSON.stringify({ kind: c.kind, at: c.at, observed: c.observed });
    case "admit": return JSON.stringify({ kind: c.kind, record: c.record, horizon: c.horizon });
    case "published": return JSON.stringify({ kind: c.kind, sequence: c.sequence });
    default: throw new V3StoreError("STORAGE", "unknown journal command");
  }
}

/** The one genesis segment: its header, scope and signed terms. */
interface Opened {
  readonly header: SegmentHeader;
  readonly headerBytes: Uint8Array;
  readonly segment: Uint8Array;
  readonly scope: bigint;
  readonly backing: Uint8Array;
  readonly terms: RootTerms;
  readonly signed: SignedTerms;
}
interface Signed {
  readonly commitment: Commitment;
  readonly length: bigint;
  readonly at: bigint;
  readonly observed: string | null;
  readonly directory: readonly SnapshotDigest[];
  readonly snapshot: Uint8Array;
  published: boolean;
}
interface Engine {
  revision: bigint;
  opened: Opened | undefined;
  state: SegmentState | undefined;
  readonly records: Uint8Array[];
  readonly receipts: Map<string, Uint8Array>;
  readonly signed: Signed[];
  /** The last admission's horizon; horizons never move back. */
  horizon: bigint;
}
/** The venue at one instant: its clock and lag, this key's held commitments, the backing's term boundaries and K's revocation. */
interface View {
  readonly now: bigint;
  readonly lag: bigint;
  readonly held: readonly HeldCommitment[];
  readonly boundaries: readonly bigint[];
  readonly revokedAt: bigint | undefined;
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
    this.configuration = configuration; this.domain = configurationHash(configuration);
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
        request TEXT NOT NULL, command TEXT NOT NULL, response TEXT NOT NULL) STRICT;`);
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
    const engine: Engine = { revision: 0n, opened: undefined, state: undefined, records: [], receipts: new Map(), signed: [], horizon: 0n };
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
      requireThat(engine.opened === undefined && /^command:/.test(id) && request === this.openRequest(command.terms, command.signature),
        "STORAGE", "stored opening disagrees with replay");
      let opened: Opened;
      try { opened = this.opening({ terms: hexToBytes(command.terms), signature: hexToBytes(command.signature) }); } catch (error) {
        if (error instanceof V3StoreError) throw new V3StoreError("STORAGE", "a stored opening no longer opens");
        throw error;
      }
      engine.opened = opened;
      engine.state = openSegmentState(opened.segment, undefined, undefined, undefined, () => {});
      this.replaySigned(engine, command, at(command.at), response);
    } else if (command.kind === "commit") {
      requireThat(engine.opened !== undefined && /^command:/.test(id) && request === "commit", "STORAGE", "stored commitment disagrees with replay");
      this.replaySigned(engine, command, at(command.at), response);
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
      try { await applyRecord(state, bytes, this.replayOf(opened, horizon, undefined)); } catch (error) {
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
    const { directory, snapshot } = this.checkpoint(engine);
    const commitment = decodeCommitment(hexToBytes(response)), highest = engine.signed.at(-1)?.commitment.sequence ?? 0n;
    requireThat(hexOf(commitment) === response && verifyCommitment(commitment) && same(commitment.operator, this.operator) &&
      commitment.sequence === highest + 1n && same(commitment.root, directoryRoot(directory)), "STORAGE", "stored commitment disagrees with replay");
    // What the venue held of this key at signing: nothing yet, or a commitment this journal signed before.
    requireThat(command.observed === null || engine.signed.some(s => hexOf(s.commitment) === command.observed), "STORAGE", "invalid observed commitment");
    engine.signed.push({ commitment, length: BigInt(engine.records.length), at, observed: command.observed, directory, snapshot, published: false });
  }

  private openRequest(terms: string, signature: string): string {
    return JSON.stringify({ kind: "open", terms, signature });
  }
  /** The genesis segment of the backing `signed` names, served by this key on this venue (C2.4.1, pool-v3 §8). */
  private opening(signed: SignedTerms): Opened {
    let terms: RootTerms;
    try { terms = decodeRootTerms(signed.terms); } catch (error) {
      if (error instanceof EncodingError) throw new V3StoreError("REFUSED", "the terms do not decode", "TERMS");
      throw error;
    }
    requireThat(verifyRootTermsSignature(signed.terms, signed.signature), "REFUSED", "the backer's signature does not verify");
    requireThat(same(terms.operator, this.operator) && same(terms.configuration, this.domain) && same(terms.venue, this.venueId),
      "REFUSED", "the terms name another operator, configuration or venue");
    // The failure path (silence, non-service) lands in slice 3.
    requireThat(terms.silence === undefined && terms.nonService === undefined, "UNSUPPORTED", "silence and non-service clauses are not served yet");
    const backing = rootTermsName(signed.terms);
    const header: SegmentHeader = { domain: this.domain, venue: this.venueId, operator: this.operator, sequence: 1n, entries: [{ backing, link: backing }] };
    return { header, headerBytes: segmentBytes(header), segment: segmentIdentity(header), scope: new ScopeTree(header.entries).root(), backing,
      terms, signed: { terms: copyBytes(signed.terms), signature: copyBytes(signed.signature) } };
  }
  private replayOf(opened: Opened, horizon: bigint, revokedAt: bigint | undefined): SegmentReplay {
    return { domain: this.domain, backing: opened.backing, segment: opened.segment, scope: opened.scope, terms: opened.terms,
      verifier: this.verifier, index: horizon, admission: true, revokedAt, block: [] };
  }
  /** The current snapshot of the one backing and its directory (§7). */
  private checkpoint(engine: Engine): { readonly directory: readonly SnapshotDigest[]; readonly snapshot: Uint8Array } {
    const opened = engine.opened!, state = engine.state!;
    const totals = state.totals.get(bytesToHex(opened.backing)) ?? { issued: 0n, burned: 0n };
    const snapshot: Snapshot = { backing: opened.backing, segment: opened.segment, historyHash: state.history, evidenceHash: state.evidence,
      issued: totals.issued, burned: totals.burned };
    return { directory: [{ name: copyBytes(opened.backing), digest: snapshotDigest(snapshot) }], snapshot: snapshotBytes(snapshot) };
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
    const now = this.clock(), held = heldCommitments(this.ask(1, this.operator, now)).held;
    let boundaries: bigint[] = [], revokedAt: bigint | undefined;
    const opened = engine.opened;
    if (opened !== undefined) {
      // The original operator's term ends where a replacement takes force (C2.5); its revocation ends issuance (C2b.1).
      const admitted = admittedReplacements(this.ask(2, opened.backing, now), opened.terms.replacementRule);
      const { chain, pending } = replacementChain(admitted, { backing: opened.backing, original: this.operator, lag: this.lag, now });
      const end = chain[1]?.from ?? pending?.from;
      boundaries = end === undefined ? [] : [end];
      revokedAt = revocationIndex(this.ask(3, opened.terms.obligor, now));
    }
    const key = JSON.stringify([now.toString(), held.map(h => [h.index.toString(), hexOf(h.commitment)]), boundaries.map(String), revokedAt?.toString() ?? null]);
    return { now, lag: this.lag, held, boundaries, revokedAt, key };
  }
  private stable(engine: Engine, view: View): void {
    requireThat(this.view(engine).key === view.key, "STALE", "the venue changed during the journal operation");
  }
  private isHeld(view: View, signed: Signed): boolean {
    const held = view.held.find(h => h.commitment.sequence === signed.commitment.sequence);
    return held !== undefined && hexOf(held.commitment) === hexOf(signed.commitment);
  }
  /** Service needs the current signed state, the scope's schedule open, and for issuance an unrevoked backer. */
  private ready(engine: Engine, view: View, action: "admit" | "commit"): void {
    requireThat(engine.opened !== undefined && engine.state !== undefined, "STALE", "open the segment first");
    const last = engine.signed.at(-1)!, latest = hexOf(view.held.at(-1)?.commitment);
    // Another commitment of this key at a sequence the journal never signed means the key has another journal.
    requireThat(view.held.every(h => hexOf(engine.signed[Number(h.commitment.sequence) - 1]?.commitment) === hexOf(h.commitment)),
      "CONFLICT", "the venue holds a commitment this journal did not sign");
    const current = latest === hexOf(last.commitment) || (last.published && view.now < last.at + view.lag && latest === last.observed);
    requireThat(current, "STALE", "the signed state is not current");
    const schedule = scopeSchedule({ now: view.now, lag: view.lag, boundaries: view.boundaries,
      ...(this.isHeld(view, last) ? {} : { unwitnessedSignedAt: last.at }), ...(this.resumedAt === undefined ? {} : { resumedAt: this.resumedAt }) });
    requireThat(!schedule.lapsed, "STALE", "the operator's term has ended");
    requireThat(action === "admit" ? schedule.admissionOpen : schedule.commitNow, "SCHEDULE", "the scope's signing schedule is closed");
    if (view.revokedAt !== undefined) {
      // Only issuance finalized before K's revocation stays; a later tail needs recovery (slice 3).
      let finalized = 0n;
      for (const signed of engine.signed) {
        const held = view.held.find(h => h.commitment.sequence === signed.commitment.sequence);
        if (held !== undefined && hexOf(held.commitment) === hexOf(signed.commitment) && held.index < view.revokedAt && signed.length > finalized) finalized = signed.length;
      }
      requireThat(!engine.records.slice(Number(finalized)).some(bytes => decodeRecord(bytes).kind === 1), "UNSUPPORTED",
        "issuance without pre-revocation finality needs recovery");
    }
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

  /** Open and sign the genesis segment of the backing `signed` names (C2.4.1). Publishing is explicit. */
  async open(id: string, signed: SignedTerms): Promise<Commitment> {
    const commandId = this.commandId(id);
    const own = { terms: copyBytes(signed?.terms), signature: copyBytes(signed?.signature) };
    const request = this.openRequest(bytesToHex(own.terms), bytesToHex(own.signature));
    return this.run(async engine => {
      const prior = this.prior(commandId, request);
      if (prior !== undefined) return decodeCommitment(hexToBytes(prior));
      requireThat(engine.opened === undefined, "UNSUPPORTED", "the journal holds one genesis segment");
      const opened = this.opening(own), view = this.view(engine);
      requireThat(view.held.length === 0, "CONFLICT", "this key already has commitments on the venue");
      const admitted = admittedReplacements(this.ask(2, opened.backing, view.now), opened.terms.replacementRule);
      const { chain, pending } = replacementChain(admitted, { backing: opened.backing, original: this.operator, lag: this.lag, now: view.now });
      requireThat(chain.length === 1, "STALE", "the operator's term has ended");
      requireThat(revocationIndex(this.ask(3, opened.terms.obligor, view.now)) === undefined, "UNSUPPORTED", "the backer has revoked K");
      // A witnessed replacement ends the term at its effective index: the opening is signed by C2.6.1's last signing index.
      const schedule = scopeSchedule({ now: view.now, lag: view.lag, boundaries: pending === undefined ? [] : [pending.from],
        ...(this.resumedAt === undefined ? {} : { resumedAt: this.resumedAt }) });
      requireThat(schedule.commitNow, "SCHEDULE", "the opening's signing schedule is closed");
      const state = openSegmentState(opened.segment, undefined, undefined, undefined, () => {});
      const probe: Engine = { ...engine, opened, state };
      const { directory, snapshot } = this.checkpoint(probe);
      const commitment = this.transaction(() => {
        this.stable(engine, view);
        const c = signCommitment(this.secret, 1n, directoryRoot(directory));
        this.append(engine, commandId, request, { kind: "open", terms: bytesToHex(own.terms), signature: bytesToHex(own.signature),
          at: view.now.toString(), observed: null }, bytesToHex(encodeCommitment(c)));
        return c;
      });
      engine.opened = opened; engine.state = state;
      engine.signed.push({ commitment, length: 0n, at: view.now, observed: null, directory, snapshot, published: false });
      engine.revision++;
      return copyCommitment(commitment);
    });
  }

  /**
   * Admit one kind 1–3 record at the horizon (the read index plus the lag)
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
      this.ready(engine, view, "admit");
      const opened = engine.opened!, state = engine.state!, horizon = view.now + view.lag;
      requireThat(horizon < U64, "SCHEDULE", "the horizon is past the venue's index space");
      // The checkpoint that will carry this record must still be served within the reader's budget.
      const last = engine.signed.at(-1)!;
      this.encodePackage(opened, [...engine.signed, { directory: [{ name: opened.backing, digest: new Uint8Array(32) }],
        snapshot: new Uint8Array(last.snapshot.length) }], last.commitment, [...engine.records, bytes]);
      const before = state.position;
      try { await applyRecord(state, bytes, this.replayOf(opened, horizon, view.revokedAt)); }
      catch (error) {
        if (state.position !== before) this.diverging = true;
        if (error instanceof ReplayRefusal) throw new V3StoreError("REFUSED", `admission refused: ${error.check}`, error.check);
        if (error instanceof EvidenceRefusal) throw new V3StoreError("UNSUPPORTED", "this record kind is not admitted yet");
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
      this.ready(engine, view, "commit");
      const last = engine.signed.at(-1)!, sequence = last.commitment.sequence + 1n;
      requireThat(sequence < U64, "STORAGE", "signed sequence counter exhausted");
      const { directory, snapshot } = this.checkpoint(engine), observed = hexOf(view.held.at(-1)?.commitment);
      this.encodePackage(engine.opened!, [...engine.signed, { directory, snapshot }], last.commitment, engine.records);
      const commitment = this.transaction(() => {
        this.stable(engine, view);
        const c = signCommitment(this.secret, sequence, directoryRoot(directory));
        this.append(engine, commandId, "commit", { kind: "commit", at: view.now.toString(), observed }, bytesToHex(encodeCommitment(c)));
        return c;
      });
      engine.signed.push({ commitment, length: BigInt(engine.records.length), at: view.now, observed, directory, snapshot, published: false });
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
  private encodePackage(opened: Opened, signed: readonly Pick<Signed, "directory" | "snapshot">[], selected: Commitment,
    records: readonly Uint8Array[]): Uint8Array {
    try {
      const payloads = new Map<string, EvidenceItem>();
      const add = (kind: number, payload: Uint8Array): void => { payloads.set(`${kind}:${bytesToHex(sha256(payload))}`, { kind, payload }); };
      add(1, configurationBytes(this.configuration)); add(2, encodeCommitment(selected));
      add(6, encodeTrail({ header: opened.headerBytes, terms: [opened.signed], records }, TRAIL_LIMITS));
      for (const s of signed) { add(3, encodeEvidenceDirectory(s.directory, SERVED_PACKAGE_LIMITS)); add(4, s.snapshot); }
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
   * where a lost reply left its publication unrecorded.
   */
  async package(): Promise<ServedPackage> {
    return this.run(async engine => {
      const view = this.view(engine), opened = engine.opened, at = engine.signed.findLastIndex(s => s.published || this.isHeld(view, s));
      requireThat(opened !== undefined && at >= 0, "STALE", "no published commitment to serve");
      const selected = engine.signed[at]!, through = engine.signed.slice(0, at + 1);
      return { selection: { domain: copyBytes(this.domain), venue: copyBytes(this.venueId), backing: copyBytes(opened.backing),
        operator: copyBytes(this.operator), sequence: selected.commitment.sequence, root: copyBytes(selected.commitment.root) },
      package: this.encodePackage(opened, through, selected.commitment, engine.records.slice(0, Number(selected.length))) };
    });
  }

  close(): void {
    requireThat(!this.busy, "BUSY", "cannot close during a journal operation");
    if (!this.closed) { this.db.close(); this.secret.fill(0); this.engine = undefined; this.closed = true; }
  }
}
