// Local, replayable Ergo evidence in SQLite rows. Node 24 only; never imported by the core barrel, so the `./ergo`
// subpath, which keeps its view here, needs Node 24's node:sqlite like every party's replay state.
// The rows are local state the view replayed itself, not a transferable venue certificate.
import { existsSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { blake2b } from "@noble/hashes/blake2b.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compareBytes, copyUnshared } from "./bytes.js";
import { fileIdentity } from "./file-identity.js";
import type { ErgoHeaderRow, ErgoHeaderRows } from "./ergo-headers.js";
import type { AttributedObject, ErgoTransactionView } from "./ergo-profile.js";
import { RangeLimitError, type RangeLimits, type RecordKind } from "./record-range.js";
import { VenueError } from "./venue-error.js";

const FORMAT = "moe/ergo-view/2";
/** The rules the rows were derived under: the header rules (`ergo-headers.ts`) and the attribution of objects
 * (`ergo-profile.ts`). A release that changes either names new rules here, and a view kept under other rules is
 * refused until it is synced again. */
export const ERGO_VIEW_RULES = "moe/ergo-view-rules/1";
/** The one failure a view keeps: a stored failure is refused unless it is exactly this. */
export const FAILURE = "venue failure: the best chain left a block witnessed under the depth";
const MAX_INDEX = 0x7fff_ffffn, MAX_HEIGHT = (1n << 31n) - 1n;
/** The token only `ErgoVenueJournal.memory` passes. */
const IN_MEMORY: unique symbol = Symbol("in-memory Ergo view");
const BESIDE: unique symbol = Symbol("Ergo view read beside its owner");

function requireStored(ok: boolean): asserts ok {
  if (!ok) throw new VenueError("invalid stored Ergo view");
}
const isBlob = (value: unknown, width?: number): value is Uint8Array =>
  value instanceof Uint8Array && (width === undefined || value.length === width);
const blob = (value: unknown, width?: number): Uint8Array => { requireStored(isBlob(value, width)); return Uint8Array.from(value); };
const integer = (value: unknown, max: bigint): bigint => { requireStored(typeof value === "bigint" && value >= 0n && value <= max); return value; };
const decimal = (value: unknown): bigint => { requireStored(typeof value === "string" && /^(0|[1-9][0-9]{0,99})$/.test(value)); return BigInt(value); };

/** One object's identity in the view's index: its kind, its 32-byte subject and its exact record bytes, each
 * fixed in width but the last, so no two objects share one. */
export function objectKey(kind: RecordKind, subject: Uint8Array, record: Uint8Array): Uint8Array {
  if (subject.length !== 32) throw new Error("an object's subject is 32 bytes");
  const bytes = new Uint8Array(1 + subject.length + record.length);
  bytes[0] = kind; bytes.set(subject, 1); bytes.set(record, 1 + subject.length);
  return blake2b(bytes, { dkLen: 32 });
}

/** A section's transaction views as one blob: a count, then each view's unsigned bytes and witness id, length-prefixed. */
function encodeViews(views: readonly ErgoTransactionView[]): Uint8Array {
  let length = 4;
  for (const view of views) length += 8 + view.unsigned.length + view.witnessId.length;
  const out = new Uint8Array(length), data = new DataView(out.buffer);
  data.setUint32(0, views.length);
  let at = 4;
  for (const view of views) {
    data.setUint32(at, view.unsigned.length); out.set(view.unsigned, at + 4); at += 4 + view.unsigned.length;
    data.setUint32(at, view.witnessId.length); out.set(view.witnessId, at + 4); at += 4 + view.witnessId.length;
  }
  return out;
}
/** A row read succinctly keeps no views: no block's section is empty. */
const NO_VIEWS = encodeViews([]);
function decodeViews(bytes: Uint8Array): ErgoTransactionView[] {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), views: ErgoTransactionView[] = [];
  const take = (at: number): { value: Uint8Array; next: number } => {
    requireStored(at + 4 <= bytes.length);
    const length = data.getUint32(at), next = at + 4 + length;
    requireStored(next <= bytes.length);
    return { value: bytes.slice(at + 4, next), next };
  };
  requireStored(bytes.length >= 4);
  let at = 4;
  for (let i = data.getUint32(0); i > 0; i--) {
    const unsigned = take(at), witnessId = take(unsigned.next);
    views.push({ unsigned: unsigned.value, witnessId: witnessId.value }); at = witnessId.next;
  }
  requireStored(at === bytes.length);
  return views;
}

/** What the view keeps of one index it read: its header, its raw section and the objects attributed from it. */
export interface ErgoSectionRow {
  readonly index: bigint;
  readonly header: Uint8Array;
  readonly views: readonly ErgoTransactionView[];
  readonly objects: readonly AttributedObject[];
}
/** A supplier's outstanding side-branch charge, kept by its name across processes. */
export interface ErgoSideCharge { readonly name: string; readonly charge: bigint; readonly height: bigint }
/** A header a supplier's last pass reached, kept through pruning under that supplier's name; a list keeps each
 * name's headers oldest first. */
export interface ErgoProtectedHeader { readonly name: string; readonly id: Uint8Array }
/** A key's count and chain value at a fold's end, as a succinct view keeps it (succinct-read §4.4). */
export interface ErgoKeptRow { readonly key: bigint; readonly count: bigint; readonly chain: bigint; readonly endHeight: bigint; readonly endId: Uint8Array }
/** Indices from `from` through `to` read succinctly: their rows hold only the followed subjects' objects. */
export interface ErgoSuccinctSpan { readonly from: bigint; readonly to: bigint }
/** A transaction a succinct read fetched, at its index and position, with its inclusion path (lone children null). */
export interface ErgoIncludedRow { readonly index: bigint; readonly position: bigint; readonly unsigned: Uint8Array; readonly steps: readonly (Uint8Array | null)[] }
/** A succinct view's state (succinct-read §4): the set it reads under, whether a transaction showed that set unsound
 * (§2 rule 7), the subjects it follows, its kept tuples and the spans it read succinctly. */
export interface ErgoSuccinctState {
  readonly identity: Uint8Array;
  readonly disagreement: boolean;
  readonly followed: readonly Uint8Array[];
  readonly kept: readonly ErgoKeptRow[];
  readonly spans: readonly ErgoSuccinctSpan[];
}
/** A sync's succinct changes: subjects newly followed, kept tuples replaced, a new span, the transactions it fetched
 * and the objects newly followed subjects hold at indices already kept. */
export interface ErgoSuccinctCommit {
  readonly identity: Uint8Array;
  readonly disagreement: boolean;
  readonly followed: readonly Uint8Array[];
  readonly kept: readonly ErgoKeptRow[];
  readonly span?: ErgoSuccinctSpan;
  readonly included: readonly ErgoIncludedRow[];
  readonly backfill: readonly (AttributedObject & { readonly index: bigint })[];
}

/** An inclusion path's steps as one blob: per step a flag byte (0 a lone child, 1 a sibling) and the sibling's bytes. */
function encodeSteps(steps: readonly (Uint8Array | null)[]): Uint8Array {
  const out = new Uint8Array(steps.reduce((n, s) => n + (s === null ? 1 : 33), 0));
  let at = 0;
  for (const step of steps) {
    if (step === null) { out[at++] = 0; continue; }
    out[at] = 1; out.set(step, at + 1); at += 33;
  }
  return out;
}
function decodeSteps(bytes: Uint8Array): (Uint8Array | null)[] {
  const steps: (Uint8Array | null)[] = [];
  for (let at = 0; at < bytes.length;) {
    if (bytes[at] === 0) { steps.push(null); at++; continue; }
    requireStored(bytes[at] === 1 && at + 33 <= bytes.length);
    steps.push(bytes.slice(at + 1, at + 33)); at += 33;
  }
  return steps;
}

/** The view's state beside its rows. */
export interface ErgoViewState {
  readonly witnessed: bigint | undefined;
  readonly pin: Uint8Array | undefined;
  /** A kept header at least the depth above the pin that descends from it (venue-ergo §2). */
  readonly buried: Uint8Array | undefined;
  readonly failure: string | undefined;
  /** Bytes of retained objects (record, subject and a fixed overhead each). */
  readonly retained: number;
  readonly charges: readonly ErgoSideCharge[];
  readonly protectedHeaders: readonly ErgoProtectedHeader[];
  /** A succinct view's state; undefined for a view that reads every section. */
  readonly succinct?: ErgoSuccinctState;
}
/** One sync's commit: its new sections, after the last held, and the state after it. A succinct view's sections read
 * succinctly carry no views and only the followed subjects' objects. */
export interface ErgoViewCommit extends Omit<ErgoViewState, "succinct"> {
  readonly sections: readonly ErgoSectionRow[];
  readonly succinct?: ErgoSuccinctCommit;
}
/** An object as a range reads it. */
export interface ErgoObjectRow { readonly index: bigint; readonly ordinal: bigint; readonly record: Uint8Array }

/** Header rows over the database, with the running sync's changes in memory until its commit writes them. */
class JournalHeaderRows implements ErgoHeaderRows {
  private readonly pending = new Map<string, { readonly id: Uint8Array; readonly row: ErgoHeaderRow }>();
  private readonly deleted = new Map<string, Uint8Array>();
  /** The best chain's changed heights: `ids` from `from` upward replace every stored height from `from`. */
  private changed: { from: bigint; ids: Uint8Array[] } | undefined;
  private stored: bigint | undefined;
  private readonly side = new Map<string, Uint8Array>();
  private readonly sideTouched = new Map<string, Uint8Array>();
  private readonly selectHeader: StatementSync;
  private readonly selectBest: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    this.selectHeader = db.prepare("SELECT height, parent, score, bytes FROM headers WHERE id=?");
    this.selectBest = db.prepare("SELECT id FROM best WHERE height=?");
    this.selectHeader.setReadBigInts(true);
    const top = db.prepare("SELECT max(height) AS top FROM best"); top.setReadBigInts(true);
    const row = top.get()!;
    if (row.top !== null) this.stored = integer(row.top, MAX_HEIGHT);
    for (const side of db.prepare("SELECT id FROM side").all()) { const id = blob(side.id, 32); this.side.set(bytesToHex(id), id); }
  }
  get(id: Uint8Array): ErgoHeaderRow | undefined {
    const key = bytesToHex(id);
    if (this.deleted.has(key)) return undefined;
    const pending = this.pending.get(key);
    if (pending !== undefined) return pending.row;
    const row = this.selectHeader.get(id);
    if (row === undefined) return undefined;
    return { height: integer(row.height, MAX_HEIGHT), parentId: blob(row.parent, 32), score: decimal(row.score), bytes: blob(row.bytes) };
  }
  put(id: Uint8Array, row: ErgoHeaderRow): void {
    const key = bytesToHex(id);
    this.deleted.delete(key); this.pending.set(key, { id, row });
  }
  delete(id: Uint8Array): void {
    const key = bytesToHex(id);
    this.pending.delete(key); this.deleted.set(key, id);
  }
  bestAt(height: bigint): Uint8Array | undefined {
    if (this.changed !== undefined && height >= this.changed.from) return this.changed.ids[Number(height - this.changed.from)];
    if (this.stored === undefined || height > this.stored) return undefined;
    const row = this.selectBest.get(height);
    return row === undefined ? undefined : blob(row.id, 32);
  }
  bestHeight(): bigint | undefined {
    return this.changed !== undefined ? this.changed.from + BigInt(this.changed.ids.length) - 1n : this.stored;
  }
  setBest(fromHeight: bigint, ids: readonly Uint8Array[]): void {
    const top = this.bestHeight();
    if (ids.length === 0 || (top !== undefined && fromHeight > top + 1n)) throw new Error("best chain rows must stay contiguous");
    if (this.changed !== undefined && fromHeight >= this.changed.from) {
      this.changed.ids.length = Number(fromHeight - this.changed.from);
      for (const id of ids) this.changed.ids.push(id);
    } else this.changed = { from: fromHeight, ids: [...ids] };
  }
  sides(): readonly Uint8Array[] { return [...this.side.values()]; }
  addSide(id: Uint8Array): void { const key = bytesToHex(id); this.side.set(key, id); this.sideTouched.set(key, id); }
  removeSide(id: Uint8Array): void { const key = bytesToHex(id); this.side.delete(key); this.sideTouched.set(key, id); }

  /** Write the running sync's changes, inside the caller's transaction. */
  write(): void {
    const remove = this.db.prepare("DELETE FROM headers WHERE id=?");
    for (const id of this.deleted.values()) remove.run(id);
    const insert = this.db.prepare("INSERT OR REPLACE INTO headers VALUES(?,?,?,?,?)");
    // Scores pass 2^63 within months of mainnet work, so they are kept as decimal text.
    for (const { id, row } of this.pending.values()) insert.run(id, row.height, row.parentId, row.score.toString(), row.bytes);
    if (this.changed !== undefined) {
      this.db.prepare("DELETE FROM best WHERE height>=?").run(this.changed.from);
      const best = this.db.prepare("INSERT INTO best VALUES(?,?)");
      this.changed.ids.forEach((id, i) => best.run(this.changed!.from + BigInt(i), id));
    }
    const addSide = this.db.prepare("INSERT OR IGNORE INTO side VALUES(?)"), removeSide = this.db.prepare("DELETE FROM side WHERE id=?");
    for (const [key, id] of this.sideTouched) (this.side.has(key) ? addSide : removeSide).run(id);
  }
  /** After the commit: the database now holds everything. */
  written(): void {
    if (this.changed !== undefined) this.stored = this.changed.from + BigInt(this.changed.ids.length) - 1n;
    this.pending.clear(); this.deleted.clear(); this.changed = undefined; this.sideTouched.clear();
  }
}

/** One fenced owner, WAL/FULL, and one transaction per sync before any new view is
 * exposed. Rows are appended as the chain grows; a reopen reads the clock and
 * checks what is cheap (format, rules, venue, fence, the last section is the
 * pin's), and the view checks the pin on the best chain and its burial. No
 * work or root is re-checked at reopen (venue-ergo §10: each header's work is
 * checked once); `ErgoVenue.audit` re-checks every row. Disk corruption, copied
 * journals and malicious rollback are outside this local transaction
 * guarantee: a view restored or copied from elsewhere is audited before use.
 * No funding secrets are stored. */
export class ErgoVenueJournal {
  private readonly db: DatabaseSync;
  private readonly owner: bigint;
  private readonly identity: string;
  private rows: JournalHeaderRows | undefined;
  private closed = false;
  /** Read beside the owner (`beside`): a read-only connection that never writes or fences. */
  private readonly beside: boolean;
  /** The identity of the file this view was kept in, where it is another file's (a copy or a restored backup), until
   * the view that attaches the journal has audited every row (slice 13 M13e). */
  private copiedFrom: { readonly path: string; readonly identity: string } | undefined;

  constructor(path: string, venueId: Uint8Array, memory?: typeof IN_MEMORY | typeof BESIDE) {
    const durable = memory !== IN_MEMORY;
    if (durable && (typeof path !== "string" || path.trim() === "" || path === ":memory:" || path.startsWith("file:"))) {
      throw new VenueError("a persistent filesystem path is required");
    }
    this.identity = ErgoVenueJournal.identityOf(venueId);
    this.beside = memory === BESIDE;
    if (this.beside && !existsSync(path)) throw new VenueError("this view has never synced");
    this.db = new DatabaseSync(durable ? path : ":memory:", { timeout: 5000, readOnly: this.beside });
    this.owner = this.beside ? this.read() : this.open(durable);
    if (durable) this.judgeFile(path);
  }
  /** A view's rows read beside the process that owns and syncs them (an operator's `prepare` beside its `serve`,
   * Next 4 (bg)): read-only, taking no ownership, at the clock the rows held when it attached. Rows are appended per
   * index and never removed below the clock, so its answers are the owner's for every index through that clock. A
   * copied file, which its owner audits before any read, is refused. */
  static beside(path: string, venueId: Uint8Array): ErgoVenueJournal {
    return new ErgoVenueJournal(path, venueId, BESIDE);
  }
  /** Beside the owner: the stored format, rules and venue, as an opening checks them, with nothing written. */
  private read(): bigint {
    try {
      requireStored(this.db.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal");
      // The view attaches in one read snapshot (`settled` ends it): the owner's sync rewrites header rows in place.
      this.db.exec("BEGIN");
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='meta'").get() === undefined) throw new VenueError("this view has never synced");
      const row = this.meta();
      requireStored(row?.format === FORMAT && row.venue === this.identity && typeof row.owner === "bigint");
      if (row!.rules !== ERGO_VIEW_RULES) throw new VenueError("this Ergo view was kept under other view rules; remove it and sync again");
      return row!.owner as bigint;
    } catch (error) { this.db.close(); throw error; }
  }
  /** Beside the owner, once the view has attached: end the read snapshot it attached in. Its answers then read rows
   * through the clock it attached at, which the owner never changes. */
  settled(): void {
    if (this.beside && this.db.isTransaction) this.db.exec("COMMIT");
  }
  /** A private in-memory database: a view without a journal keeps the same rows, for as long as it lives. */
  static memory(venueId: Uint8Array): ErgoVenueJournal {
    return new ErgoVenueJournal(":memory:", venueId, IN_MEMORY);
  }

  private static identityOf(venueId: Uint8Array): string {
    const id = copyUnshared(venueId);
    if (id.length !== 32) throw new VenueError("invalid Ergo journal identity");
    return bytesToHex(id);
  }
  private open(durable: boolean): bigint {
    try {
      try {
        if (durable) {
          this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
          requireStored(this.db.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal" &&
            this.db.prepare("PRAGMA synchronous").get()?.synchronous === 2);
        }
        this.db.exec("BEGIN IMMEDIATE");
      } catch (error) {
        // Another process holds the file through a long commit; opening again later fences it.
        if (error instanceof Error && /locked|busy/i.test(error.message)) throw new VenueError("the Ergo journal is busy; open it again");
        throw error;
      }
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='ergo_checkpoint'").get() !== undefined) {
        throw new VenueError("this Ergo view was stored in an older format; remove it and sync again");
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), format TEXT NOT NULL, rules TEXT NOT NULL, venue TEXT NOT NULL,
          owner INTEGER NOT NULL, witnessed INTEGER, pin BLOB, buried BLOB, failure TEXT, retained INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS headers (id BLOB PRIMARY KEY, height INTEGER NOT NULL, parent BLOB NOT NULL, score TEXT NOT NULL,
          bytes BLOB NOT NULL) STRICT, WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS best (height INTEGER PRIMARY KEY, id BLOB NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS side (id BLOB PRIMARY KEY) STRICT, WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS charges (name TEXT PRIMARY KEY, charge TEXT NOT NULL, height INTEGER NOT NULL) STRICT, WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS protected (name TEXT NOT NULL, id BLOB NOT NULL, age INTEGER NOT NULL, PRIMARY KEY(name, id)) STRICT, WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS sections (idx INTEGER PRIMARY KEY, header BLOB NOT NULL, views BLOB NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS objects (idx INTEGER NOT NULL, position INTEGER NOT NULL, kind INTEGER NOT NULL, subject BLOB NOT NULL,
          ordinal INTEGER NOT NULL, record BLOB NOT NULL, key BLOB NOT NULL, PRIMARY KEY(idx, position)) STRICT, WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS objects_subject ON objects(kind, subject, idx);
        CREATE INDEX IF NOT EXISTS objects_key ON objects(key, idx);
        CREATE TABLE IF NOT EXISTS succinct (id INTEGER PRIMARY KEY CHECK(id=1), identity BLOB NOT NULL, disagreement INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS followed (subject BLOB PRIMARY KEY) STRICT, WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS kept (key INTEGER PRIMARY KEY, count TEXT NOT NULL, chain TEXT NOT NULL, end_height INTEGER NOT NULL,
          end_id BLOB NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS spans (from_idx INTEGER PRIMARY KEY, to_idx INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS included (idx INTEGER NOT NULL, position INTEGER NOT NULL, unsigned BLOB NOT NULL, steps BLOB NOT NULL,
          PRIMARY KEY(idx, position)) STRICT, WITHOUT ROWID;`);
      this.db.prepare(`INSERT OR IGNORE INTO meta VALUES(1,'${FORMAT}','${ERGO_VIEW_RULES}',?,0,NULL,NULL,NULL,NULL,0)`).run(this.identity);
      const row = this.meta();
      requireStored(row?.format === FORMAT && row.venue === this.identity &&
        typeof row.owner === "bigint" && row.owner >= 0n && row.owner < 0x7fff_ffff_ffff_ffffn);
      if (row!.rules !== ERGO_VIEW_RULES) throw new VenueError("this Ergo view was kept under other view rules; remove it and sync again");
      const owner = row!.owner as bigint + 1n;
      this.db.prepare("UPDATE meta SET owner=? WHERE id=1").run(owner);
      this.db.exec("COMMIT");
      return owner;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve cause */ }
      this.db.close(); throw error;
    }
  }
  /** A durable view keeps its file's identity: a file it was not made in is a copy, which `ErgoVenue` audits before any
   * read, recording the identity only once the audit passes (slice 13 M13e). */
  private judgeFile(path: string): void {
    try {
      if (this.beside) {
        const kept = this.db.prepare("SELECT identity FROM file WHERE id=1").get()?.identity;
        if (kept !== fileIdentity(path)) throw new VenueError("this view's file is not the one it was kept in: its owner audits it first");
        return;
      }
      this.db.exec("CREATE TABLE IF NOT EXISTS file (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL) STRICT");
      const identity = fileIdentity(path), kept = this.db.prepare("SELECT identity FROM file WHERE id=1").get()?.identity;
      if (kept === undefined) this.db.prepare("INSERT INTO file VALUES(1,?)").run(identity);
      else if (kept !== identity) this.copiedFrom = { path, identity };
    } catch (error) { this.db.close(); throw error; }
  }
  /** Whether this view's file is a copy not yet audited. */
  copied(): boolean { return this.copiedFrom !== undefined; }
  /** After an audit of every row: this file is the view's own from now on. */
  audited(): void {
    if (this.beside) throw new VenueError("a view read beside its owner keeps nothing");
    this.assertOwner();
    if (this.copiedFrom === undefined) return;
    this.db.prepare("UPDATE file SET identity=? WHERE id=1").run(this.copiedFrom.identity);
    this.copiedFrom = undefined;
  }
  private meta() {
    const q = this.db.prepare("SELECT * FROM meta WHERE id=1"); q.setReadBigInts(true); return q.get();
  }
  assertOwner(): void {
    if (this.closed) throw new VenueError("Ergo journal is closed");
    const row = this.meta();
    // Beside the owner, the owner may change: the rows stay the view's.
    if ((!this.beside && row?.owner !== this.owner) || row?.venue !== this.identity || row.format !== FORMAT) {
      throw new VenueError("another owner fenced this Ergo journal");
    }
  }
  /** A journal handle attaches to exactly one view: its header rows and its stored state. */
  attach(venueId: Uint8Array): { readonly rows: ErgoHeaderRows; readonly state: ErgoViewState } {
    this.assertOwner();
    if (this.rows !== undefined || ErgoVenueJournal.identityOf(venueId) !== this.identity) {
      throw new VenueError("Ergo journal is already attached or names another venue");
    }
    const row = this.meta()!;
    const witnessed = row.witnessed === null ? undefined : integer(row.witnessed, MAX_INDEX);
    requireStored(row.failure === null || row.failure === FAILURE);
    requireStored(witnessed === undefined ? row.pin === null && row.buried === null && row.failure === null : isBlob(row.pin, 32) && isBlob(row.buried, 32));
    // Sections are appended one index at a time from zero and never removed, so their ends name them all; the last is
    // the pin's. `audit` reads every one.
    const ends = this.db.prepare("SELECT min(idx) AS low, max(idx) AS top FROM sections"); ends.setReadBigInts(true);
    const sections = ends.get()!;
    requireStored(witnessed === undefined ? sections.top === null : sections.low === 0n && sections.top === witnessed);
    if (witnessed !== undefined) {
      const last = this.db.prepare("SELECT header FROM sections WHERE idx=?").get(witnessed);
      requireStored(isBlob(last?.header, 32) && compareBytes(last.header, row.pin as Uint8Array) === 0);
    }
    const charges = this.db.prepare("SELECT name, charge, height FROM charges"); charges.setReadBigInts(true);
    // Oldest first within a name, as the view evicts them.
    const protectedHeaders = this.db.prepare("SELECT name, id FROM protected ORDER BY name, age").all().map(p => {
      requireStored(typeof p.name === "string"); return { name: p.name as string, id: blob(p.id, 32) };
    });
    const succinct = this.succinctState(witnessed);
    this.rows = new JournalHeaderRows(this.db);
    return { rows: this.rows, state: { witnessed, pin: row.pin === null ? undefined : blob(row.pin, 32), buried: row.buried === null ? undefined : blob(row.buried, 32),
      failure: row.failure === null ? undefined : FAILURE, retained: Number(integer(row.retained, BigInt(Number.MAX_SAFE_INTEGER))), protectedHeaders,
      charges: charges.all().map(c => { requireStored(typeof c.name === "string"); return { name: c.name as string, charge: decimal(c.charge), height: integer(c.height, MAX_HEIGHT) }; }),
      ...(succinct === undefined ? {} : { succinct }) } };
  }
  /** A succinct view's stored state, checked as far as is cheap: spans are disjoint, within the clock, and each of
   * their rows holds no views; included transactions lie in spans. Undefined for a view that reads every section (a
   * file kept before succinct views has none of these tables, which only an owner's opening adds). */
  private succinctState(witnessed: bigint | undefined): ErgoSuccinctState | undefined {
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='succinct'").get() === undefined) return undefined;
    const meta = this.db.prepare("SELECT identity, disagreement FROM succinct WHERE id=1"); meta.setReadBigInts(true);
    const row = meta.get();
    if (row === undefined) {
      requireStored(this.db.prepare("SELECT 1 FROM spans UNION ALL SELECT 1 FROM followed UNION ALL SELECT 1 FROM kept UNION ALL SELECT 1 FROM included LIMIT 1").get() === undefined);
      return undefined;
    }
    requireStored(row.disagreement === 0n || row.disagreement === 1n);
    const spansQuery = this.db.prepare("SELECT from_idx, to_idx FROM spans ORDER BY from_idx"); spansQuery.setReadBigInts(true);
    const spans: ErgoSuccinctSpan[] = [];
    for (const s of spansQuery.all()) {
      const from = integer(s.from_idx, MAX_INDEX), to = integer(s.to_idx, MAX_INDEX), last = spans[spans.length - 1];
      requireStored(from <= to && witnessed !== undefined && to <= witnessed && (last === undefined || last.to < from));
      spans.push({ from, to });
    }
    const views = this.db.prepare("SELECT count(*) AS n FROM sections WHERE idx BETWEEN ? AND ? AND views=?"); views.setReadBigInts(true);
    for (const { from, to } of spans) requireStored(views.get(from, to, NO_VIEWS)!.n === to - from + 1n);
    const keptQuery = this.db.prepare("SELECT key, count, chain, end_height, end_id FROM kept ORDER BY key"); keptQuery.setReadBigInts(true);
    const kept = keptQuery.all().map(k => ({ key: integer(k.key, 0xffff_ffffn), count: decimal(k.count), chain: decimal(k.chain),
      endHeight: integer(k.end_height, MAX_HEIGHT), endId: blob(k.end_id, 32) }));
    const outside = this.db.prepare("SELECT count(*) AS n FROM included WHERE NOT EXISTS (SELECT 1 FROM spans WHERE idx BETWEEN from_idx AND to_idx)");
    outside.setReadBigInts(true);
    requireStored(outside.get()!.n === 0n);
    return { identity: blob(row.identity, 32), disagreement: row.disagreement === 1n, spans, kept,
      followed: this.db.prepare("SELECT subject FROM followed ORDER BY subject").all().map(f => blob(f.subject, 32)) };
  }
  /** One sync's rows and state, in one transaction. A throw leaves the transaction rolled back or uncertain; the
   * caller fails its view. */
  commit(state: ErgoViewCommit): void {
    if (this.rows === undefined) throw new Error("commit before attach");
    if (this.beside) throw new VenueError("a view read beside its owner keeps nothing");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertOwner();
      this.rows.write();
      const section = this.db.prepare("INSERT INTO sections VALUES(?,?,?)");
      const object = this.db.prepare("INSERT INTO objects VALUES(?,?,?,?,?,?,?)");
      for (const row of state.sections) {
        section.run(row.index, row.header, encodeViews(row.views));
        row.objects.forEach((o, position) => object.run(row.index, position, o.kind, o.subject, o.ordinal, o.record, objectKey(o.kind, o.subject, o.record)));
      }
      if (state.succinct !== undefined) this.commitSuccinct(state.succinct, object);
      this.db.prepare("DELETE FROM protected").run();
      const keep = this.db.prepare("INSERT OR IGNORE INTO protected VALUES(?,?,?)");
      state.protectedHeaders.forEach(({ name, id }, age) => keep.run(name, id, age));
      this.db.prepare("DELETE FROM charges").run();
      const charge = this.db.prepare("INSERT INTO charges VALUES(?,?,?)");
      for (const c of state.charges) charge.run(c.name, c.charge.toString(), c.height);
      this.db.prepare("UPDATE meta SET witnessed=?,pin=?,buried=?,failure=?,retained=? WHERE id=1")
        .run(state.witnessed ?? null, state.pin ?? null, state.buried ?? null, state.failure ?? null, state.retained);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* caller poisons the view on uncertainty */ }
      throw error;
    }
    this.rows.written();
  }
  /** A succinct sync's rows, inside the commit's transaction. A newly followed subject's objects at kept indices take
   * positions after those already there, so each index keeps them in the order they were read. */
  private commitSuccinct(state: ErgoSuccinctCommit, object: StatementSync): void {
    this.db.prepare("INSERT INTO succinct VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET disagreement=excluded.disagreement")
      .run(state.identity, state.disagreement ? 1 : 0);
    const follow = this.db.prepare("INSERT OR IGNORE INTO followed VALUES(?)");
    for (const subject of state.followed) follow.run(subject);
    const keep = this.db.prepare("INSERT OR REPLACE INTO kept VALUES(?,?,?,?,?)");
    for (const k of state.kept) keep.run(k.key, k.count.toString(), k.chain.toString(), k.endHeight, k.endId);
    if (state.span !== undefined) this.db.prepare("INSERT INTO spans VALUES(?,?)").run(state.span.from, state.span.to);
    const include = this.db.prepare("INSERT OR IGNORE INTO included VALUES(?,?,?,?)");
    for (const t of state.included) include.run(t.index, t.position, t.unsigned, encodeSteps(t.steps));
    const next = this.db.prepare("SELECT coalesce(max(position) + 1, 0) AS next FROM objects WHERE idx=?"); next.setReadBigInts(true);
    for (const o of state.backfill) object.run(o.index, next.get(o.index)!.next as bigint, o.kind, o.subject, o.ordinal, o.record, objectKey(o.kind, o.subject, o.record));
  }
  /** The section read natively at `index`: its header id and views; undefined for an index not kept or read succinctly. */
  section(index: bigint): { readonly header: Uint8Array; readonly views: readonly ErgoTransactionView[] } | undefined {
    const row = this.db.prepare("SELECT header, views FROM sections WHERE idx=?").get(index);
    if (row === undefined) return undefined;
    const views = decodeViews(blob(row.views));
    return views.length === 0 ? undefined : { header: blob(row.header, 32), views };
  }
  /** The transactions a succinct read fetched at `index`, in position order, for an audit. */
  included(index: bigint): ErgoIncludedRow[] {
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='included'").get() === undefined) return [];
    const q = this.db.prepare("SELECT position, unsigned, steps FROM included WHERE idx=? ORDER BY position"); q.setReadBigInts(true);
    return q.all(index).map(t => ({ index, position: integer(t.position, 0xffff_ffffn), unsigned: blob(t.unsigned), steps: decodeSteps(blob(t.steps)) }));
  }
  /** The objects of one kind and subject at indices `from` to `to`, in index and section order. Read one at a time
   * and refused (`RangeLimitError`) as soon as they pass the answer's budget, so no read holds more than an answer
   * may; each row's key is recomputed from its bytes. */
  objects(kind: RecordKind, subject: Uint8Array, from: bigint, to: bigint, bound: RangeLimits): ErgoObjectRow[] {
    const q = this.db.prepare("SELECT idx, ordinal, record, key FROM objects WHERE kind=? AND subject=? AND idx BETWEEN ? AND ? ORDER BY idx, position");
    q.setReadBigInts(true);
    const out: ErgoObjectRow[] = [];
    let bytes = 0n;
    for (const row of q.iterate(kind, subject, from, to)) {
      const record = blob(row.record);
      requireStored(isBlob(row.key, 32) && compareBytes(row.key, objectKey(kind, subject, record)) === 0);
      bytes += BigInt(record.length);
      if (BigInt(out.length) >= bound.maxEntries || bytes > bound.maxBytes) throw new RangeLimitError("range reader budget exceeded");
      out.push({ index: integer(row.idx, MAX_INDEX), ordinal: integer(row.ordinal, 1n << 62n), record });
    }
    return out;
  }
  /** The first index holding an object with this key. */
  firstIndex(key: Uint8Array): bigint | undefined {
    const q = this.db.prepare("SELECT min(idx) AS first FROM objects WHERE key=?"); q.setReadBigInts(true);
    const first = q.get(key)?.first;
    return first === null || first === undefined ? undefined : integer(first, MAX_INDEX);
  }
  /** Every stored section in index order with the objects stored for it, for an audit. */
  *sections(): Generator<{ readonly index: bigint; readonly header: Uint8Array; readonly views: readonly ErgoTransactionView[];
    readonly objects: readonly (AttributedObject & { readonly key: Uint8Array })[] }> {
    const sections = this.db.prepare("SELECT idx, header, views FROM sections ORDER BY idx"); sections.setReadBigInts(true);
    const objects = this.db.prepare("SELECT kind, subject, ordinal, record, key FROM objects WHERE idx=? ORDER BY position"); objects.setReadBigInts(true);
    for (const row of sections.iterate()) {
      const index = integer(row.idx, MAX_INDEX);
      yield { index, header: blob(row.header, 32), views: decodeViews(blob(row.views)), objects: objects.all(index).map(o => ({
        kind: Number(integer(o.kind, 4n)) as RecordKind, subject: blob(o.subject), ordinal: integer(o.ordinal, 1n << 62n), record: blob(o.record), key: blob(o.key, 32) })) };
    }
  }
  /** How many header rows are stored, for an audit. */
  headerCount(): number {
    return Number(this.db.prepare("SELECT count(*) AS n FROM headers").get()!.n);
  }
  /** How many objects are stored, for an audit. */
  objectCount(): bigint {
    const q = this.db.prepare("SELECT count(*) AS n FROM objects"); q.setReadBigInts(true);
    return q.get()!.n as bigint;
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
