// The reader's own copy of supplied evidence (storage decision 2026-09-29 item
// 8; pool-v3 §14 "Streamed input"): a package is copied into this store before
// any pass reads it, streamed or from memory, and every pass reads the copy.
// Whole items are rows, directories keyed by their root and snapshots by their
// digest; a trail is its header, terms and one row per record position, and
// each record is stored once, keyed by its segment's evidence chain value (§7),
// so overlapping trails share it. The §13 answers a read asks are kept beside
// its package, window by window. Budgets are per object: a whole item, a
// header, a terms field, a record, a range answer; the one aggregate is the
// party's quota on the bytes one batch keeps. The only module that touches
// this database besides replay-store.ts's own.
import { sha256 } from "@noble/hashes/sha2.js";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { compareBytes, copyUnshared, EncodingError, FrameFeed } from "../../bytes.js";
import type { HeldCommitment, RangeEntry } from "../../record-range.js";
import { directoryRoot, type SnapshotDigest } from "../../venue-records.js";
import { genesisEvidenceHash, nextEvidenceHash, snapshotDigest, type Snapshot } from "./commitments.js";
import type { ExpectedSnapshot } from "./fault-evidence.js";
import { decodeSegmentHeader } from "./headers.js";
import { decodeEvidenceDirectory, PackageLimitError, packageReader, type PackageSink, type PayloadSink } from "./package.js";
import { decodeRecord, evidenceHashes } from "./records.js";
import { EvidenceRefusal } from "./refusals.js";
import { trailReader, type TrailSink } from "./trail.js";

/** A whole item's local per-object budget; a trail is bounded per record instead. */
export const MAX_ITEM_BYTES = 1_048_576n;
/** The bytes one batch may keep by default: a party's storage quota, never a protocol bound. A file is
 * sized for a closure at the design point (about 20 GB); memory for the short reads it serves. */
export const EVIDENCE_QUOTA = Object.freeze({ memory: 268_435_456n, file: 68_719_476_736n });
/** Kinds a v3 reader reads (§12): others are passed over unstored and refused as unsupported by the reader. */
export const READ_KINDS: readonly number[] = Object.freeze([1, 2, 3, 4, 6, 7, 10]);

export interface SignedTermsField { readonly terms: Uint8Array; readonly signature: Uint8Array }
/** A stored trail's header, and its scoped terms field `i` read on demand; a field too long to verify is undefined. */
export interface TrailHead {
  readonly header: Uint8Array;
  term(i: number): SignedTermsField | undefined;
}
/** A checkpoint's served trail (§12.1): a stored trail cut at `length` records. */
export interface StoredTrail extends TrailHead {
  readonly segment: Uint8Array;
  readonly length: bigint;
  /** The records after position `after` through `length`, in order, read from storage one at a time. */
  records(after?: bigint): Iterable<Uint8Array>;
  /** evidenceHash at `position` (0 is the seed), for a position within the cut. */
  evidence(position: bigint): Uint8Array | undefined;
}
/** The trails a read may use (§10.1, §12.1). */
export interface TrailEvidence {
  /** Every well-formed trail of `segment`, in frame order, read one at a time. */
  heads(segment: Uint8Array): Iterable<TrailHead>;
  /** The prefix of the first trail of the snapshot's segment scoping its backing whose decodable
   * records reproduce the snapshot's evidence hash (at 0, the seed); later records are not its evidence. */
  served(expected: ExpectedSnapshot, snapshot: Snapshot): StoredTrail | undefined;
}
/** The §13 answers one read keeps, each kind and subject read once through the read's judging index. */
export interface KeptAnswers {
  /** Whether the answer for this kind and subject is kept, in full. */
  kept(kind: 1 | 4, subject: Uint8Array): boolean;
  /** Keep one answer: `read` stores its every window, then it is marked kept; if `read` throws, none of it stays. */
  keepAnswer(kind: 1 | 4, subject: Uint8Array, read: () => void): void;
  /** One window's held commitments of `operator` (C2.3.3), in sequence order. */
  keepHeld(operator: Uint8Array, held: readonly HeldCommitment[]): void;
  /** One window's publications of `backing`; a position another kept answer holds leaves the read unresolved. */
  keepPublications(backing: Uint8Array, entries: readonly RangeEntry[]): void;
  /** The kept held commitments of `operator`, in index and sequence order. */
  held(operator: Uint8Array): Iterable<HeldCommitment>;
  /** The kept held commitment of `operator` at `sequence`. */
  heldAt(operator: Uint8Array, sequence: bigint): HeldCommitment | undefined;
  /** Whether a kept held commitment of `operator` has a sequence above `sequence`. */
  heldAbove(operator: Uint8Array, sequence: bigint): boolean;
  /** The first kept held commitment of `operator` at or after `fromIndex` whose sequence exceeds `after`, if given.
   * Index and sequence rise together (C2.3.3), so `after` at or past `fromIndex` bounds both. */
  nextHeld(operator: Uint8Array, fromIndex: bigint, after?: bigint): HeldCommitment | undefined;
  /** The least index of a kept held commitment of `operator` in [from, to]. */
  firstHeldIndex(operator: Uint8Array, from: bigint, to: bigint): bigint | undefined;
  /** The kept publication of `backing` after `after` in venue order, or the first. */
  nextPublication(backing: Uint8Array, after?: Pick<RangeEntry, "index" | "ordinal">): RangeEntry | undefined;
  /** The kept publications of `backing`, in venue order. */
  publications(backing: Uint8Array): Iterable<RangeEntry>;
  publicationCount(backing: Uint8Array): number;
}
/** The package objects a walk looks up, and where it keeps its venue answers. */
export interface WalkEvidence {
  directory(root: Uint8Array): readonly SnapshotDigest[] | undefined;
  snapshot(digest: Uint8Array): Uint8Array | undefined;
  readonly trails: TrailEvidence;
  readonly answers: KeptAnswers;
}

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
const bytes = (value: unknown): Uint8Array => new Uint8Array(value as Uint8Array);
/** A u64 as eight big-endian bytes, so stored order is numeric order. */
export const u64be = (value: bigint): Uint8Array => { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, value); return out; };
const fromBe = (value: unknown): bigint => new DataView(bytes(value).buffer).getBigUint64(0);

const SCHEMA = `
  CREATE TABLE batch (id INTEGER PRIMARY KEY AUTOINCREMENT);
  CREATE TABLE item (batch INTEGER, seq INTEGER, kind INTEGER NOT NULL, hash BLOB, payload BLOB, root BLOB, PRIMARY KEY(batch, seq)) WITHOUT ROWID;
  CREATE INDEX item_kind ON item(batch, kind, seq);
  CREATE INDEX item_hash ON item(batch, kind, hash, seq);
  CREATE INDEX item_root ON item(batch, root, seq);
  CREATE TABLE trail (id INTEGER PRIMARY KEY AUTOINCREMENT, batch INTEGER NOT NULL, seq INTEGER NOT NULL, segment BLOB NOT NULL,
    header BLOB NOT NULL, count INTEGER);
  CREATE INDEX trail_segment ON trail(batch, segment, seq);
  CREATE TABLE trail_terms (trail INTEGER, i INTEGER, terms BLOB, signature BLOB NOT NULL, PRIMARY KEY(trail, i)) WITHOUT ROWID;
  CREATE TABLE trail_record (trail INTEGER, position INTEGER, evidence BLOB NOT NULL, PRIMARY KEY(trail, position)) WITHOUT ROWID;
  CREATE INDEX trail_record_evidence ON trail_record(evidence, trail);
  CREATE TABLE record (evidence BLOB PRIMARY KEY, bytes BLOB NOT NULL) WITHOUT ROWID;
  CREATE TABLE answer (batch INTEGER, kind INTEGER, subject BLOB, PRIMARY KEY(batch, kind, subject)) WITHOUT ROWID;
  CREATE TABLE held (batch INTEGER, operator BLOB, seq BLOB, idx BLOB NOT NULL, root BLOB NOT NULL, signature BLOB NOT NULL,
    PRIMARY KEY(batch, operator, seq)) WITHOUT ROWID;
  CREATE INDEX held_idx ON held(batch, operator, idx, seq);
  CREATE TABLE publication (batch INTEGER, backing BLOB, idx BLOB, ordinal BLOB, record BLOB NOT NULL,
    PRIMARY KEY(batch, backing, idx, ordinal)) WITHOUT ROWID;
  CREATE UNIQUE INDEX publication_position ON publication(batch, idx, ordinal);`;

export class EvidenceStore {
  readonly #db: DatabaseSync;
  readonly #q: Record<string, StatementSync>;
  readonly #quota: bigint;
  #busy = false;

  /** A private in-memory database by default; a file path keeps memory flat for a long history.
   * The file is a new one, and one import runs at a time; keeping and pruning it across reads is M5b.4's.
   * `maxBatchBytes` is the party's quota on what one batch keeps (EVIDENCE_QUOTA by default). */
  constructor(path = ":memory:", options: { readonly maxBatchBytes?: bigint } = {}) {
    const quota = options.maxBatchBytes ?? (path === ":memory:" ? EVIDENCE_QUOTA.memory : EVIDENCE_QUOTA.file);
    if (typeof quota !== "bigint" || quota < 0n) throw new TypeError("invalid evidence quota");
    this.#quota = quota;
    this.#db = new DatabaseSync(path, { readBigInts: true });
    this.#db.exec("PRAGMA journal_mode=TRUNCATE; PRAGMA synchronous=FULL;");
    this.#db.exec(SCHEMA);
    this.#q = Object.fromEntries(Object.entries({
      batch: "INSERT INTO batch VALUES (NULL) RETURNING id",
      item: "INSERT INTO item VALUES (?, ?, ?, ?, ?, ?)",
      payloads: "SELECT payload FROM item WHERE batch = ? AND kind = ? ORDER BY seq",
      count: "SELECT count(*) AS c FROM item WHERE batch = ? AND kind = ?",
      kinds: "SELECT DISTINCT kind FROM item WHERE batch = ?",
      unrooted: "SELECT 1 FROM item WHERE batch = ? AND kind = 3 AND root IS NULL LIMIT 1",
      byHash: "SELECT payload FROM item WHERE batch = ? AND kind = ? AND hash = ? ORDER BY seq LIMIT 1",
      byRoot: "SELECT payload FROM item WHERE batch = ? AND root = ? ORDER BY seq LIMIT 1",
      trail: "INSERT INTO trail VALUES (NULL, ?, ?, ?, ?, NULL) RETURNING id",
      trailCount: "UPDATE trail SET count = ? WHERE id = ?",
      terms: "INSERT INTO trail_terms VALUES (?, ?, ?, ?)",
      position: "INSERT INTO trail_record VALUES (?, ?, ?)",
      record: "INSERT INTO record VALUES (?, ?) ON CONFLICT DO NOTHING",
      recordBytes: "SELECT bytes FROM record WHERE evidence = ?",
      headTerm: "SELECT terms, signature FROM trail_terms WHERE trail = ? AND i = ?",
      at: "SELECT position FROM trail_record WHERE evidence = ? AND trail = ?",
      evidenceAt: "SELECT evidence FROM trail_record WHERE trail = ? AND position = ?",
      kept: "SELECT 1 FROM answer WHERE batch = ? AND kind = ? AND subject = ?",
      keep: "INSERT INTO answer VALUES (?, ?, ?)",
      putHeld: "INSERT INTO held VALUES (?, ?, ?, ?, ?, ?)",
      heldAt: "SELECT seq, idx, root, signature FROM held WHERE batch = ? AND operator = ? AND seq = ?",
      heldAbove: "SELECT 1 FROM held WHERE batch = ? AND operator = ? AND seq > ? LIMIT 1",
      heldAfter: "SELECT seq, idx, root, signature FROM held WHERE batch = ? AND operator = ? AND seq > ? ORDER BY seq LIMIT 1",
      heldFrom: "SELECT seq, idx, root, signature FROM held WHERE batch = ? AND operator = ? AND idx >= ? ORDER BY idx, seq LIMIT 1",
      heldIndex: "SELECT idx FROM held WHERE batch = ? AND operator = ? AND idx >= ? AND idx <= ? ORDER BY idx LIMIT 1",
      putPublication: "INSERT INTO publication VALUES (?, ?, ?, ?, ?)",
      firstPublication: "SELECT idx, ordinal, record FROM publication WHERE batch = ? AND backing = ? ORDER BY idx, ordinal LIMIT 1",
      nextPublication: `SELECT idx, ordinal, record FROM publication WHERE batch = ? AND backing = ? AND (idx > ? OR (idx = ? AND ordinal > ?))
        ORDER BY idx, ordinal LIMIT 1`,
      publicationCount: "SELECT count(*) AS c FROM publication WHERE batch = ? AND backing = ?",
    }).map(([name, sql]) => [name, this.#db.prepare(sql)]));
  }

  close(): void { if (this.#db.isOpen) this.#db.close(); }

  /** Copy a package held in memory: EncodingError for a malformed package and
   * PackageLimitError for a whole item past its budget or a batch past the quota, keeping nothing. */
  importBytes(input: Uint8Array): EvidenceBatch {
    // The size is known, so the count and each length are checked against it before any payload.
    const own = copyUnshared(input);
    return this.#import(feed => { feed.feed(own); }, BigInt(own.length));
  }

  /** Copy a package from a stream of chunks, each copied as it arrives. */
  async importStream(source: AsyncIterable<Uint8Array>): Promise<EvidenceBatch> {
    return this.#importAsync(async feed => { for await (const chunk of source) feed.feed(chunk); });
  }

  /** Bare §10 trail frames, as a harness supplies them: one that does not frame is not stored. */
  importTrails(trails: readonly Uint8Array[]): EvidenceBatch {
    return this.#transaction(() => {
      const batch = this.#batch();
      trails.forEach((input, seq) => {
        this.#q.item!.run(batch.id, seq, 6, null, null, null);
        const receiver = this.#trail(batch, seq, BigInt(input.length));
        receiver.data(input); receiver.end(sha256(input));
      });
      return batch;
    });
  }

  #batch(): EvidenceBatch {
    const id = (this.#q.batch!.get() as { id: bigint }).id;
    return new EvidenceBatch(this.#db, this.#q, id, this.#quota);
  }

  #sink(batch: EvidenceBatch): PackageSink {
    let seq = 0;
    return {
      stream: (kind, length): PayloadSink | undefined => {
        if (kind === 6) {
          this.#q.item!.run(batch.id, seq, 6, null, null, null);
          return this.#trail(batch, seq++, length);
        }
        if (READ_KINDS.includes(kind)) return undefined;
        // Passed over unkept, but still under the per-object budget.
        if (length > MAX_ITEM_BYTES) throw new PackageLimitError("package item exceeds the reader's budget");
        this.#q.item!.run(batch.id, seq++, kind, null, null, null);
        return { data: () => {}, end: () => {} };
      },
      item: (kind, payload, hash) => {
        batch.charge(BigInt(payload.length), PackageLimitError);
        // A directory is found by its root; one that does not decode has none, and the reader refuses it as malformed.
        let root: Uint8Array | null = null;
        if (kind === 3) {
          try { root = directoryRoot(decodeEvidenceDirectory(payload)); } catch (error) { if (!(error instanceof EncodingError)) throw error; }
        }
        this.#q.item!.run(batch.id, seq++, kind, hash, payload, root);
      },
    };
  }

  /** One trail item's rows inside its own savepoint: a trail that does not frame (§10.1) is no evidence and leaves none. */
  #trail(batch: EvidenceBatch, seq: number, length: bigint): PayloadSink {
    const name = `trail_${seq}`;
    this.#db.exec(`SAVEPOINT ${name}`);
    let feed: FrameFeed<void> | undefined;
    const drop = (error: unknown): void => {
      if (!(error instanceof EncodingError)) throw error;
      feed = undefined;
      this.#db.exec(`ROLLBACK TO ${name}`); this.#db.exec(`RELEASE ${name}`);
    };
    try { feed = new FrameFeed(trailReader(this.#rows(batch.id, seq), length)); } catch (error) { drop(error); }
    return {
      data: piece => {
        // Every trail byte counts toward the quota, kept or not: it is what the supplier sent.
        batch.charge(BigInt(piece.length), PackageLimitError);
        if (feed !== undefined) try { feed.feed(piece); } catch (error) { drop(error); }
      },
      end: () => {
        // A savepoint dropped at the start or midway is already released.
        if (feed === undefined) return;
        try { feed.end(); } catch (error) { drop(error); return; }
        this.#db.exec(`RELEASE ${name}`);
      },
    };
  }

  /** A trail's rows. The evidence chain runs over the longest prefix whose records decode (§5); only
   * that prefix can serve a checkpoint (§12.1), so later records are not kept. */
  #rows(batch: bigint, seq: number): TrailSink {
    let id: bigint | undefined, chain: Uint8Array | undefined;
    return {
      header: (header) => {
        id = (this.#q.trail!.get(batch, seq, sha256(header), header) as { id: bigint }).id;
        chain = genesisEvidenceHash(sha256(header));
      },
      terms: (i, terms, signature) => { this.#q.terms!.run(id!, i, terms ?? null, signature); },
      count: events => { this.#q.trailCount!.run(events, id!); },
      record: (position, record) => {
        if (chain === undefined) return;
        let digests;
        try { digests = evidenceHashes(decodeRecord(record)); } catch (error) {
          if (!(error instanceof EncodingError)) throw error;
          chain = undefined;
          return;
        }
        chain = nextEvidenceHash(chain, digests, position);
        this.#q.position!.run(id!, position, chain);
        // The chain value fixes every record through its position, so an existing row holds these bytes.
        if (this.#q.record!.run(chain, record).changes === 0 &&
            !same(bytes((this.#q.recordBytes!.get(chain) as { bytes: unknown }).bytes), record)) throw new Error("evidence chain collision");
      },
    };
  }

  #import(body: (feed: FrameFeed<void>) => void, total: bigint): EvidenceBatch {
    return this.#transaction(() => {
      const batch = this.#batch(), feed = new FrameFeed(packageReader(this.#sink(batch), { maxItemBytes: MAX_ITEM_BYTES, total }));
      body(feed); feed.end();
      return batch;
    });
  }

  async #importAsync(body: (feed: FrameFeed<void>) => Promise<void>): Promise<EvidenceBatch> {
    if (this.#busy) throw new Error("an import is already open on this store");
    this.#busy = true;
    this.#db.exec("BEGIN");
    try {
      const batch = this.#batch(), feed = new FrameFeed(packageReader(this.#sink(batch), { maxItemBytes: MAX_ITEM_BYTES }));
      await body(feed); feed.end();
      this.#db.exec("COMMIT");
      return batch;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    } finally { this.#busy = false; }
  }

  #transaction<T>(body: () => T): T {
    if (this.#busy) throw new Error("an import is already open on this store");
    this.#db.exec("BEGIN");
    try {
      const result = body();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}

interface Head extends TrailHead { readonly id: bigint }

/** One imported package's evidence, and the venue answers the read of it keeps, as a read uses them. */
export class EvidenceBatch implements WalkEvidence, KeptAnswers {
  readonly #db: DatabaseSync;
  readonly #q: Record<string, StatementSync>;
  readonly #quota: bigint;
  #bytes = 0n;
  readonly id: bigint;

  constructor(db: DatabaseSync, q: Record<string, StatementSync>, id: bigint, quota: bigint) {
    this.#db = db; this.#q = q; this.id = id; this.#quota = quota;
  }

  /** Count kept bytes against the party's quota. */
  charge(amount: bigint, Refusal: new (message: string) => Error): void {
    this.#bytes += amount;
    if (this.#bytes > this.#quota) throw new Refusal("the reader's evidence quota is exhausted");
  }

  get trails(): TrailEvidence { return this; }
  get answers(): KeptAnswers { return this; }

  /** Every item of `kind`, in frame order; payloads of kinds a reader does not read are not kept. */
  payloads(kind: number): Uint8Array[] {
    return this.#q.payloads!.all(this.id, kind).filter(row => (row as { payload: unknown }).payload !== null)
      .map(row => bytes((row as { payload: unknown }).payload));
  }
  count(kind: number): number { return Number((this.#q.count!.get(this.id, kind) as { c: bigint }).c); }
  kinds(): number[] { return this.#q.kinds!.all(this.id).map(row => Number((row as { kind: bigint }).kind)); }
  /** Whether some directory item does not decode. */
  malformedDirectory(): boolean { return this.#q.unrooted!.get(this.id) !== undefined; }

  /** The first directory item with this root, decoded. */
  directory(root: Uint8Array): readonly SnapshotDigest[] | undefined {
    const row = this.#q.byRoot!.get(this.id, root) as { payload: unknown } | undefined;
    return row === undefined ? undefined : decodeEvidenceDirectory(bytes(row.payload));
  }
  /** The snapshot item whose SHA256 is `digest`. */
  snapshot(digest: Uint8Array): Uint8Array | undefined {
    const row = this.#q.byHash!.get(this.id, 4, digest) as { payload: unknown } | undefined;
    return row === undefined ? undefined : bytes(row.payload);
  }

  heads(segment: Uint8Array): Iterable<TrailHead> { return this.#heads(segment); }

  /** Heads are read one at a time and not kept, so many trails of one segment hold no memory. */
  *#heads(segment: Uint8Array): Generator<Head> {
    const q = this.#q, rows = this.#db.prepare("SELECT id, header FROM trail WHERE batch = ? AND segment = ? ORDER BY seq");
    for (const row of rows.iterate(this.id, segment)) {
      const { id, header } = row as { id: bigint; header: unknown };
      yield Object.freeze({ id, header: bytes(header), term(i: number): SignedTermsField | undefined {
        const found = q.headTerm!.get(id, i) as { terms: unknown; signature: unknown } | undefined;
        return found === undefined || found.terms === null ? undefined : Object.freeze({ terms: bytes(found.terms), signature: bytes(found.signature) });
      } });
    }
  }

  served(expected: ExpectedSnapshot, snapshot: Snapshot): StoredTrail | undefined {
    if (!same(snapshot.backing, expected.backing) || !same(snapshot.segment, expected.segment) ||
        !same(snapshotDigest(snapshot), expected.digest)) return undefined;
    const seed = genesisEvidenceHash(expected.segment), atSeed = same(snapshot.evidenceHash, seed);
    for (const head of this.#heads(expected.segment)) {
      if (!decodeSegmentHeader(head.header).entries.some(entry => same(entry.backing, expected.backing))) continue;
      const row = atSeed ? undefined : this.#q.at!.get(snapshot.evidenceHash, head.id) as { position: bigint } | undefined;
      if (atSeed || row !== undefined) return this.#cut(head, expected.segment, seed, atSeed ? 0n : row!.position);
    }
    return undefined;
  }

  #cut(head: Head, segment: Uint8Array, seed: Uint8Array, length: bigint): StoredTrail {
    const db = this.#db, q = this.#q, trail = head.id;
    return Object.freeze({ header: head.header, segment, term: head.term, length,
      *records(after = 0n): Iterable<Uint8Array> {
        const rows = db.prepare(`SELECT r.bytes FROM trail_record t JOIN record r ON r.evidence = t.evidence
          WHERE t.trail = ? AND t.position > ? AND t.position <= ? ORDER BY t.position`);
        for (const row of rows.iterate(trail, after, length)) yield bytes((row as { bytes: unknown }).bytes);
      },
      evidence(position: bigint): Uint8Array | undefined {
        if (position < 0n || position > length) return undefined;
        if (position === 0n) return seed;
        const row = q.evidenceAt!.get(trail, position) as { evidence: unknown } | undefined;
        return row === undefined ? undefined : bytes(row.evidence);
      } });
  }

  // --- Kept §13 answers --------------------------------------------------------------------

  kept(kind: 1 | 4, subject: Uint8Array): boolean { return this.#q.kept!.get(this.id, kind, subject) !== undefined; }
  keepAnswer(kind: 1 | 4, subject: Uint8Array, read: () => void): void {
    if (this.kept(kind, subject)) throw new Error("this answer is already kept");
    // One savepoint: the answer commits once, and one that fails leaves no rows or quota behind.
    const charged = this.#bytes;
    this.#db.exec("SAVEPOINT answer");
    try {
      read();
      this.#q.keep!.run(this.id, kind, subject);
      this.#db.exec("RELEASE answer");
    } catch (error) {
      this.#db.exec("ROLLBACK TO answer"); this.#db.exec("RELEASE answer");
      this.#bytes = charged;
      throw error;
    }
  }
  keepHeld(operator: Uint8Array, held: readonly HeldCommitment[]): void {
    for (const { index, commitment } of held) {
      this.charge(136n, EvidenceRefusalQuota);
      this.#q.putHeld!.run(this.id, operator, u64be(commitment.sequence), u64be(index), commitment.root, commitment.signature);
    }
  }
  keepPublications(backing: Uint8Array, entries: readonly RangeEntry[]): void {
    for (const { index, ordinal, record } of entries) {
      this.charge(BigInt(record.length), EvidenceRefusalQuota);
      try { this.#q.putPublication!.run(this.id, backing, u64be(index), u64be(ordinal), record); }
      catch (error) {
        // One venue position answered for two subjects cannot be both (§13.1); only that index names it.
        if (error instanceof Error && /UNIQUE constraint failed: publication\.batch, publication\.idx, publication\.ordinal$/.test(error.message)) {
          throw new EvidenceRefusal("unresolved-evidence");
        }
        throw error;
      }
    }
  }
  #held(operator: Uint8Array, row: Record<string, unknown>): HeldCommitment {
    return Object.freeze({ index: fromBe(row["idx"]), commitment: Object.freeze({ sequence: fromBe(row["seq"]), root: bytes(row["root"]),
      operator: new Uint8Array(operator), signature: bytes(row["signature"]) }) });
  }
  // Iterations take one row per query, so no statement stays open while the walk writes between steps.
  *held(operator: Uint8Array): Iterable<HeldCommitment> {
    for (let held = this.nextHeld(operator, 0n); held !== undefined; held = this.nextHeld(operator, 0n, held.commitment.sequence)) yield held;
  }
  heldAt(operator: Uint8Array, sequence: bigint): HeldCommitment | undefined {
    const row = this.#q.heldAt!.get(this.id, operator, u64be(sequence)) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#held(operator, row);
  }
  heldAbove(operator: Uint8Array, sequence: bigint): boolean { return this.#q.heldAbove!.get(this.id, operator, u64be(sequence)) !== undefined; }
  nextHeld(operator: Uint8Array, fromIndex: bigint, after?: bigint): HeldCommitment | undefined {
    const row = (after === undefined ? this.#q.heldFrom!.get(this.id, operator, u64be(fromIndex)) :
      this.#q.heldAfter!.get(this.id, operator, u64be(after))) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    const held = this.#held(operator, row);
    return held.index >= fromIndex ? held : this.nextHeld(operator, fromIndex);
  }
  firstHeldIndex(operator: Uint8Array, from: bigint, to: bigint): bigint | undefined {
    if (from > to) return undefined;
    const row = this.#q.heldIndex!.get(this.id, operator, u64be(from), u64be(to)) as { idx: unknown } | undefined;
    return row === undefined ? undefined : fromBe(row.idx);
  }
  nextPublication(backing: Uint8Array, after?: Pick<RangeEntry, "index" | "ordinal">): RangeEntry | undefined {
    const row = (after === undefined ? this.#q.firstPublication!.get(this.id, backing) : this.#q.nextPublication!.get(this.id, backing,
      u64be(after.index), u64be(after.index), u64be(after.ordinal))) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : Object.freeze({ index: fromBe(row["idx"]), ordinal: fromBe(row["ordinal"]), record: bytes(row["record"]) });
  }
  *publications(backing: Uint8Array): Iterable<RangeEntry> {
    for (let entry = this.nextPublication(backing); entry !== undefined; entry = this.nextPublication(backing, entry)) yield entry;
  }
  publicationCount(backing: Uint8Array): number { return Number((this.#q.publicationCount!.get(this.id, backing) as { c: bigint }).c); }
}

/** A venue answer past the quota is a resource refusal of the read, like any other budget (§14). */
class EvidenceRefusalQuota extends EvidenceRefusal { constructor() { super("resource-refusal"); } }
