// The reader's own copy of supplied evidence (storage decision 2026-09-29 item
// 8; pool-v3 §14 "Streamed input"): a package is copied into this store before
// any pass reads it, streamed or from memory, and every pass reads the copy.
// Whole items are rows; a trail is its header, terms and one row per record
// position, and each record is stored once, keyed by its segment's evidence
// chain value (§7), so overlapping trails share it. Budgets are per object: a
// whole item, a header, a terms field, a record. The only module that touches
// this database besides replay-store.ts's own.
import { sha256 } from "@noble/hashes/sha2.js";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { compareBytes, copyUnshared, EncodingError, FrameFeed } from "../../bytes.js";
import { genesisEvidenceHash, nextEvidenceHash, snapshotDigest, type Snapshot } from "./commitments.js";
import type { ExpectedSnapshot } from "./fault-evidence.js";
import { decodeSegmentHeader } from "./headers.js";
import { PackageLimitError, packageReader, type PackageSink, type PayloadSink } from "./package.js";
import { decodeRecord, evidenceHashes } from "./records.js";
import { trailReader, type TrailSink } from "./trail.js";

/** A whole item's local per-object budget; a trail is bounded per record instead. */
export const MAX_ITEM_BYTES = 1_048_576n;
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

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
const bytes = (value: unknown): Uint8Array => new Uint8Array(value as Uint8Array);

const SCHEMA = `
  CREATE TABLE batch (id INTEGER PRIMARY KEY AUTOINCREMENT);
  CREATE TABLE item (batch INTEGER, seq INTEGER, kind INTEGER NOT NULL, hash BLOB, payload BLOB, PRIMARY KEY(batch, seq)) WITHOUT ROWID;
  CREATE INDEX item_kind ON item(batch, kind, seq);
  CREATE TABLE trail (id INTEGER PRIMARY KEY AUTOINCREMENT, batch INTEGER NOT NULL, seq INTEGER NOT NULL, segment BLOB NOT NULL,
    header BLOB NOT NULL, count INTEGER);
  CREATE INDEX trail_segment ON trail(batch, segment, seq);
  CREATE TABLE trail_terms (trail INTEGER, i INTEGER, terms BLOB, signature BLOB NOT NULL, PRIMARY KEY(trail, i)) WITHOUT ROWID;
  CREATE TABLE trail_record (trail INTEGER, position INTEGER, evidence BLOB NOT NULL, PRIMARY KEY(trail, position)) WITHOUT ROWID;
  CREATE INDEX trail_record_evidence ON trail_record(evidence, trail);
  CREATE TABLE record (evidence BLOB PRIMARY KEY, bytes BLOB NOT NULL) WITHOUT ROWID;`;

export class EvidenceStore {
  readonly #db: DatabaseSync;
  readonly #q: Record<string, StatementSync>;
  #busy = false;

  /** A private in-memory database by default; a file path keeps memory flat for a long history.
   * The file is a new one, and one import runs at a time; keeping and pruning it across reads is M5b.4's. */
  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path, { readBigInts: true });
    this.#db.exec("PRAGMA journal_mode=TRUNCATE; PRAGMA synchronous=FULL;");
    this.#db.exec(SCHEMA);
    this.#q = Object.fromEntries(Object.entries({
      batch: "INSERT INTO batch VALUES (NULL) RETURNING id",
      item: "INSERT INTO item VALUES (?, ?, ?, ?, ?)",
      payloads: "SELECT payload FROM item WHERE batch = ? AND kind = ? ORDER BY seq",
      count: "SELECT count(*) AS c FROM item WHERE batch = ? AND kind = ?",
      kinds: "SELECT DISTINCT kind FROM item WHERE batch = ?",
      trail: "INSERT INTO trail VALUES (NULL, ?, ?, ?, ?, NULL) RETURNING id",
      trailCount: "UPDATE trail SET count = ? WHERE id = ?",
      terms: "INSERT INTO trail_terms VALUES (?, ?, ?, ?)",
      position: "INSERT INTO trail_record VALUES (?, ?, ?)",
      record: "INSERT INTO record VALUES (?, ?) ON CONFLICT DO NOTHING",
      recordBytes: "SELECT bytes FROM record WHERE evidence = ?",
      headTerm: "SELECT terms, signature FROM trail_terms WHERE trail = ? AND i = ?",
      at: "SELECT position FROM trail_record WHERE evidence = ? AND trail = ?",
      evidenceAt: "SELECT evidence FROM trail_record WHERE trail = ? AND position = ?",
    }).map(([name, sql]) => [name, this.#db.prepare(sql)]));
  }

  close(): void { if (this.#db.isOpen) this.#db.close(); }

  /** Copy a package held in memory: EncodingError for a malformed package and
   * PackageLimitError for a whole item past its budget, keeping nothing. */
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
        this.#q.item!.run(batch.id, seq, 6, null, null);
        const receiver = this.#trail(batch.id, seq, BigInt(input.length));
        receiver.data(input); receiver.end(sha256(input));
      });
      return batch;
    });
  }

  #batch(): EvidenceBatch {
    const id = (this.#q.batch!.get() as { id: bigint }).id;
    return new EvidenceBatch(this.#db, this.#q, id);
  }

  #sink(batch: bigint): PackageSink {
    let seq = 0;
    return {
      stream: (kind, length): PayloadSink | undefined => {
        if (kind === 6) {
          this.#q.item!.run(batch, seq, 6, null, null);
          return this.#trail(batch, seq++, length);
        }
        if (READ_KINDS.includes(kind)) return undefined;
        // Passed over unkept, but still under the per-object budget.
        if (length > MAX_ITEM_BYTES) throw new PackageLimitError("package item exceeds the reader's budget");
        this.#q.item!.run(batch, seq++, kind, null, null);
        return { data: () => {}, end: () => {} };
      },
      item: (kind, payload, hash) => { this.#q.item!.run(batch, seq++, kind, hash, payload); },
    };
  }

  /** One trail item's rows inside its own savepoint: a trail that does not frame (§10.1) is no evidence and leaves none. */
  #trail(batch: bigint, seq: number, length: bigint): PayloadSink {
    const name = `trail_${seq}`;
    this.#db.exec(`SAVEPOINT ${name}`);
    let feed: FrameFeed<void> | undefined;
    const drop = (error: unknown): void => {
      if (!(error instanceof EncodingError)) throw error;
      feed = undefined;
      this.#db.exec(`ROLLBACK TO ${name}`); this.#db.exec(`RELEASE ${name}`);
    };
    try { feed = new FrameFeed(trailReader(this.#rows(batch, seq), length)); } catch (error) { drop(error); }
    return {
      data: piece => { if (feed !== undefined) try { feed.feed(piece); } catch (error) { drop(error); } },
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
      const batch = this.#batch(), feed = new FrameFeed(packageReader(this.#sink(batch.id), { maxItemBytes: MAX_ITEM_BYTES, total }));
      body(feed); feed.end();
      return batch;
    });
  }

  async #importAsync(body: (feed: FrameFeed<void>) => Promise<void>): Promise<EvidenceBatch> {
    if (this.#busy) throw new Error("an import is already open on this store");
    this.#busy = true;
    this.#db.exec("BEGIN");
    try {
      const batch = this.#batch(), feed = new FrameFeed(packageReader(this.#sink(batch.id), { maxItemBytes: MAX_ITEM_BYTES }));
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

/** One imported package's evidence, as a read uses it. */
export class EvidenceBatch implements TrailEvidence {
  readonly #db: DatabaseSync;
  readonly #q: Record<string, StatementSync>;
  readonly id: bigint;

  constructor(db: DatabaseSync, q: Record<string, StatementSync>, id: bigint) { this.#db = db; this.#q = q; this.id = id; }

  /** Every item of `kind`, in frame order; payloads of kinds a reader does not read are not kept. */
  payloads(kind: number): Uint8Array[] {
    return this.#q.payloads!.all(this.id, kind).filter(row => (row as { payload: unknown }).payload !== null)
      .map(row => bytes((row as { payload: unknown }).payload));
  }
  count(kind: number): number { return Number((this.#q.count!.get(this.id, kind) as { c: bigint }).c); }
  kinds(): number[] { return this.#q.kinds!.all(this.id).map(row => Number((row as { kind: bigint }).kind)); }

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
}
