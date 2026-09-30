// The reader's own copy of supplied evidence (storage decision 2026-09-29 item
// 8; pool-v3 §14 "Streamed input", "Incremental retrieval"): a package is
// copied into this store before any pass reads it, streamed or from memory,
// and every pass reads the copy. A party's file retains the evidence across
// reads, so a later package need carry only new objects:
// - directories and snapshots are kept once, by the SHA256 their users look
//   them up by;
// - a trail is a head (header and scoped terms) and a line of record
//   positions, each position's evidence chain value (§7) with the record
//   stored once under it. The value fixes every record through its position,
//   so trails that share a prefix share one line, and a new line starts only
//   where a trail forks from every kept one;
// - the items one read reads from its own package (kinds 1, 2, 7 and 10) stay
//   with that read's batch and go when the read ends.
// Nothing retained is trusted as stored: an object is checked against its hash
// when used and a record against the chain step to its position, and damage
// removes the object or line (`KeptEvidenceMismatch`), so kept evidence can
// only leave a read unresolved. Budgets are per object: a whole item, a
// header, a terms field, a record; the one aggregate is the party's quota on
// the bytes one batch takes. The only module that touches this database.
import { sha256 } from "@noble/hashes/sha2.js";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { compareBytes, copyBytes, copyUnshared, EncodingError, FrameFeed } from "../../bytes.js";
import type { SnapshotDigest } from "../../venue-records.js";
import { genesisEvidenceHash, nextEvidenceHash, snapshotDigest, type Snapshot } from "./commitments.js";
import type { ExpectedSnapshot } from "./fault-evidence.js";
import { decodeSegmentHeader } from "./headers.js";
import { decodeEvidenceDirectory, PackageLimitError, packageReader, type PackageSink, type PayloadSink } from "./package.js";
import { decodeRecord, evidenceHashes } from "./records.js";
import { EvidenceRefusal } from "./refusals.js";
import { trailReader, type TrailSink } from "./trail.js";

/** A whole item's local per-object budget; a trail is bounded per record instead. */
export const MAX_ITEM_BYTES = 1_048_576n;
/** The bytes one batch may take by default: a party's storage quota, never a protocol bound. A file is
 * sized for a closure at the design point (about 20 GB); memory for the short reads it serves. */
export const EVIDENCE_QUOTA = Object.freeze({ memory: 268_435_456n, file: 68_719_476_736n });
/** What an item's own row costs beside its payload: its keys, hash and index entries (about 130 bytes
 * measured on SQLite). Charged per item, so the quota bounds the item count too. */
const ITEM_ROW_BYTES = 128n;
/** What a trail position's rows cost beside its record's bytes: the position row, its evidence
 * index entry and the record row's key (about 200 bytes measured on SQLite). */
const RECORD_ROW_BYTES = 192n;
/** Kinds a v3 reader reads (§12). A package holding another is unsupported: the import refuses it
 * at that item's header, before its payload and without keeping anything. */
const READ_KINDS: readonly number[] = Object.freeze([1, 2, 3, 4, 6, 7, 10]);
/** Kinds one read takes from its own package: the configuration, the selected commitment, faults and a receipt. */
const PER_READ_KINDS: readonly number[] = Object.freeze([1, 2, 7, 10]);
/** The retained file's layout: a file of another layout is refused rather than read. */
const SCHEMA_VERSION = 1;

/** Retained evidence that failed its check on use (§14: a damaged cache never grounds an exclusion). The
 * store has already removed it, so the read runs again without it. */
export class KeptEvidenceMismatch extends Error {
  constructor(what: string) { super(`kept evidence does not authenticate: ${what}`); this.name = "KeptEvidenceMismatch"; }
}

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
  /** The records after position `after` through `length`, in order, read from storage one at a time,
   * each checked against the chain value at its position before it is given. */
  records(after?: bigint): Iterable<Uint8Array>;
  /** evidenceHash at `position` (0 is the seed), for a position within the cut, checked by its chain step. */
  evidence(position: bigint): Uint8Array | undefined;
}
/** The trails a read may use (§10.1, §12.1). */
export interface TrailEvidence {
  /** Every well-formed trail head of `segment`, in the order kept, read one at a time. */
  heads(segment: Uint8Array): Iterable<TrailHead>;
  /** The kept records of the snapshot's segment that reproduce the snapshot's evidence hash (at 0, the seed),
   * under the first head scoping its backing; later records are not its evidence. */
  served(expected: ExpectedSnapshot, snapshot: Snapshot): StoredTrail | undefined;
}
/** The evidence a walk looks up, and the quota its venue answers are charged to. */
export interface WalkEvidence {
  directory(root: Uint8Array): readonly SnapshotDigest[] | undefined;
  snapshot(digest: Uint8Array): Uint8Array | undefined;
  readonly trails: TrailEvidence;
  /** Count a kept venue answer's bytes against the read's quota: past it, a resource refusal (§14). */
  chargeAnswer(bytes: bigint): void;
}
/** Where a kept line of a segment ends: a later trail of it can be fetched as a head and the records after this. */
export interface TrailTip { readonly position: bigint; readonly evidence: Uint8Array }

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
const bytes = (value: unknown): Uint8Array => new Uint8Array(value as Uint8Array);
/** A u64 as eight big-endian bytes, so stored order is numeric order. */
export const u64be = (value: bigint): Uint8Array => { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, value); return out; };
const frame = (part: Uint8Array): Uint8Array => { const out = new Uint8Array(4 + part.length); new DataView(out.buffer).setUint32(0, part.length); out.set(part, 4); return out; };

const SCHEMA = `
  CREATE TABLE batch (id INTEGER PRIMARY KEY AUTOINCREMENT);
  CREATE TABLE item (batch INTEGER, seq INTEGER, kind INTEGER NOT NULL, payload BLOB, PRIMARY KEY(batch, seq)) WITHOUT ROWID;
  CREATE INDEX item_kind ON item(batch, kind, seq);
  CREATE TABLE object (kind INTEGER, hash BLOB, payload BLOB NOT NULL, PRIMARY KEY(kind, hash)) WITHOUT ROWID;
  CREATE TABLE head (id INTEGER PRIMARY KEY AUTOINCREMENT, segment BLOB NOT NULL, digest BLOB, header BLOB NOT NULL);
  CREATE INDEX head_segment ON head(segment, id);
  CREATE UNIQUE INDEX head_digest ON head(digest);
  CREATE TABLE head_terms (head INTEGER, i INTEGER, terms BLOB, signature BLOB NOT NULL, PRIMARY KEY(head, i)) WITHOUT ROWID;
  CREATE TABLE line (id INTEGER PRIMARY KEY AUTOINCREMENT, segment BLOB NOT NULL, position INTEGER NOT NULL);
  CREATE INDEX line_segment ON line(segment, position);
  CREATE TABLE link (line INTEGER, position INTEGER, evidence BLOB NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(line, position)) WITHOUT ROWID;
  CREATE INDEX link_evidence ON link(evidence);
  CREATE TABLE record (evidence BLOB PRIMARY KEY, bytes BLOB NOT NULL) WITHOUT ROWID;`;

/** A kept position a trail is assembled after: its line, chain value and the frame bytes of its records. */
interface Base { readonly line: bigint; readonly position: bigint; readonly evidence: Uint8Array; readonly size: bigint; readonly segment: Uint8Array }

export class EvidenceStore {
  readonly #db: DatabaseSync;
  readonly #q: Record<string, StatementSync>;
  readonly #quota: bigint;
  #busy = false;
  #savepoints = 0;

  /** A private in-memory database by default; a file path is the party's retained evidence, reopened at its
   * layout and kept across reads. One import runs at a time, and a party opens its file once.
   * `maxBatchBytes` is the party's quota on what one batch takes (EVIDENCE_QUOTA by default). */
  constructor(path = ":memory:", options: { readonly maxBatchBytes?: bigint } = {}) {
    const quota = options.maxBatchBytes ?? (path === ":memory:" ? EVIDENCE_QUOTA.memory : EVIDENCE_QUOTA.file);
    if (typeof quota !== "bigint" || quota < 0n) throw new TypeError("invalid evidence quota");
    this.#quota = quota;
    this.#db = new DatabaseSync(path, { readBigInts: true });
    this.#db.exec("PRAGMA journal_mode=TRUNCATE; PRAGMA synchronous=FULL;");
    const version = (this.#db.prepare("PRAGMA user_version").get() as { user_version: bigint }).user_version;
    if (version === 0n) this.#db.exec(`${SCHEMA}; PRAGMA user_version = ${SCHEMA_VERSION};`);
    else if (version !== BigInt(SCHEMA_VERSION)) { this.#db.close(); throw new TypeError("the evidence file has another layout"); }
    // No read is open, so any per-read items are a crashed read's.
    else this.#db.exec("DELETE FROM item");
    this.#q = Object.fromEntries(Object.entries({
      batch: "INSERT INTO batch VALUES (NULL) RETURNING id",
      item: "INSERT INTO item VALUES (?, ?, ?, ?)",
      payloads: "SELECT payload FROM item WHERE batch = ? AND kind = ? AND payload IS NOT NULL ORDER BY seq",
      count: "SELECT count(*) AS c FROM item WHERE batch = ? AND kind = ?",
      release: "DELETE FROM item WHERE batch = ?",
      keep: "INSERT INTO object VALUES (?, ?, ?) ON CONFLICT(kind, hash) DO UPDATE SET payload = excluded.payload",
      object: "SELECT payload FROM object WHERE kind = ? AND hash = ?",
      dropObject: "DELETE FROM object WHERE kind = ? AND hash = ?",
      head: "INSERT INTO head VALUES (NULL, ?, NULL, ?) RETURNING id",
      headDigest: "UPDATE head SET digest = ? WHERE id = ?",
      headByDigest: "SELECT id FROM head WHERE digest = ?",
      dropHead: "DELETE FROM head WHERE id = ?",
      dropHeadTerms: "DELETE FROM head_terms WHERE head = ?",
      terms: "INSERT INTO head_terms VALUES (?, ?, ?, ?)",
      headTerm: "SELECT terms, signature FROM head_terms WHERE head = ? AND i = ?",
      heads: "SELECT id, header FROM head WHERE segment = ? AND id > ? ORDER BY id LIMIT 1",
      newLine: "INSERT INTO line VALUES (NULL, ?, ?) RETURNING id",
      lineTip: "SELECT position FROM line WHERE id = ?",
      moveTip: "UPDATE line SET position = ? WHERE id = ?",
      tip: `SELECT l.position, k.evidence FROM line l JOIN link k ON k.line = l.id AND k.position = l.position
        WHERE l.segment = ? ORDER BY l.position DESC, l.id LIMIT 1`,
      link: "INSERT INTO link VALUES (?, ?, ?, ?)",
      fork: "INSERT INTO link SELECT ?, position, evidence, size FROM link WHERE line = ? AND position < ?",
      find: "SELECT k.line, k.position, k.size, l.segment FROM link k JOIN line l ON l.id = k.line WHERE k.evidence = ? ORDER BY k.line LIMIT 1",
      at: "SELECT k.evidence, r.bytes FROM link k LEFT JOIN record r ON r.evidence = k.evidence WHERE k.line = ? AND k.position = ?",
      dropLinks: "DELETE FROM link WHERE line = ?",
      dropLine: "DELETE FROM line WHERE id = ?",
      record: "INSERT INTO record VALUES (?, ?) ON CONFLICT(evidence) DO UPDATE SET bytes = excluded.bytes WHERE bytes != excluded.bytes",
    }).map(([name, sql]) => [name, this.#db.prepare(sql)]));
  }

  close(): void { if (this.#db.isOpen) this.#db.close(); }

  /** Copy a package held in memory: EncodingError for a malformed package and
   * PackageLimitError for a whole item past its budget or a batch past the quota, keeping nothing. */
  importBytes(input: Uint8Array): EvidenceBatch {
    // The size is known, so the count and each length are checked against it before any payload.
    const own = copyUnshared(input);
    return this.#transaction(() => {
      const batch = this.#batch(), feed = new FrameFeed(packageReader(this.#sink(batch), { maxItemBytes: MAX_ITEM_BYTES, total: BigInt(own.length) }));
      feed.feed(own); feed.end();
      return batch;
    });
  }

  /** Copy a package from a stream of chunks, each copied as it arrives. */
  async importStream(source: AsyncIterable<Uint8Array>): Promise<EvidenceBatch> {
    return this.#transactionAsync(async () => {
      const batch = this.#batch(), feed = new FrameFeed(packageReader(this.#sink(batch), { maxItemBytes: MAX_ITEM_BYTES }));
      for await (const chunk of source) feed.feed(chunk);
      feed.end();
      return batch;
    });
  }

  /** Bare §10 trail frames, as a harness supplies them: one that does not frame is not stored. */
  importTrails(trails: readonly Uint8Array[]): EvidenceBatch {
    return this.#transaction(() => {
      const batch = this.#batch();
      trails.forEach((input, seq) => {
        batch.charge(ITEM_ROW_BYTES, PackageLimitError);
        this.#q.item!.run(batch.id, seq, 6, null);
        const receiver = this.#trail(batch, BigInt(input.length), undefined);
        receiver.data(input); receiver.end(sha256(input));
      });
      return batch;
    });
  }

  /**
   * §14 incremental retrieval: a later trail of a segment this store holds through `after`, fetched as its
   * head (context, header, scoped terms and count) followed by the records after `after.position`. §10's frame
   * is read over the head, the retained records and the fetched ones to the exact end, and the evidence
   * recurrence continues from the kept chain value; the stated position authenticates nothing. Without `after`
   * the source is a complete trail. A stream states its byte length (`size`). Resolves true where the trail
   * framed and was kept; false where it does not frame or `after` is no kept position. PackageLimitError past
   * the quota.
   */
  async importTrail(source: Uint8Array | AsyncIterable<Uint8Array>,
    options: { readonly after?: TrailTip | undefined; readonly size?: bigint | undefined } = {}): Promise<boolean> {
    const streamed = !(source instanceof Uint8Array), own = streamed ? undefined : copyUnshared(source);
    const size = own === undefined ? options.size : BigInt(own.length);
    if (typeof size !== "bigint" || size < 0n) throw new TypeError("a streamed trail states its byte length");
    const after = options.after === undefined ? undefined : { position: options.after.position, evidence: copyBytes(options.after.evidence) };
    if (after !== undefined && (typeof after.position !== "bigint" || after.position < 0n || after.evidence.length !== 32)) throw new TypeError("invalid trail position");
    return this.#transactionAsync(async () => {
      let base: Base | undefined;
      if (after !== undefined && after.position > 0n) {
        base = this.#base(after);
        if (base === undefined) return false;
      }
      const batch = this.#batch();
      batch.charge(ITEM_ROW_BYTES, PackageLimitError);
      const receiver = this.#trail(batch, size, base);
      if (own !== undefined) receiver.data(own);
      else for await (const chunk of source as AsyncIterable<Uint8Array>) receiver.data(copyUnshared(chunk));
      receiver.end(new Uint8Array(32));
      return receiver.kept();
    });
  }

  /** The furthest kept position of `segment`'s lines, where a later trail of it can be fetched from. */
  tip(segment: Uint8Array): TrailTip | undefined {
    const row = this.#q.tip!.get(copyBytes(segment)) as { position: bigint; evidence: unknown } | undefined;
    return row === undefined ? undefined : Object.freeze({ position: BigInt(row.position), evidence: bytes(row.evidence) });
  }

  #base(after: TrailTip): Base | undefined {
    const row = this.#q.find!.get(after.evidence) as { line: bigint; position: bigint; size: bigint; segment: unknown } | undefined;
    return row === undefined || BigInt(row.position) !== after.position ? undefined :
      { line: row.line, position: after.position, evidence: after.evidence, size: BigInt(row.size), segment: bytes(row.segment) };
  }

  #batch(): EvidenceBatch {
    const id = (this.#q.batch!.get() as { id: bigint }).id;
    return new EvidenceBatch(this.#db, this.#q, id, this.#quota);
  }

  #sink(batch: EvidenceBatch): PackageSink {
    let seq = 0;
    return {
      stream: (kind, length): PayloadSink | undefined => {
        if (!READ_KINDS.includes(kind)) throw new EvidenceRefusal("unsupported-scope");
        batch.charge(ITEM_ROW_BYTES, PackageLimitError);
        if (kind !== 6) return undefined;
        this.#q.item!.run(batch.id, seq++, 6, null);
        return this.#trail(batch, length, undefined);
      },
      item: (kind, payload, hash) => {
        batch.charge(BigInt(payload.length), PackageLimitError);
        this.#q.item!.run(batch.id, seq++, kind, PER_READ_KINDS.includes(kind) ? payload : null);
        // A directory is found by its root, the SHA256 of its canonical preimage. One that does not decode
        // has none, so no commitment finds it: like a trail that does not frame, it is no evidence (§12).
        if (kind === 3) {
          try { decodeEvidenceDirectory(payload); } catch (error) { if (!(error instanceof EncodingError)) throw error; return; }
        }
        // A copy supplied again replaces the kept one, so evidence damaged in storage is repaired by resupply.
        if (kind === 3 || kind === 4) this.#q.keep!.run(kind, hash, payload);
      },
    };
  }

  /** One trail's rows inside its own savepoint: a trail that does not frame (§10.1) is no evidence and leaves none. */
  #trail(batch: EvidenceBatch, length: bigint, base: Base | undefined): PayloadSink & { kept(): boolean } {
    const name = `trail_${this.#savepoints++}`;
    this.#db.exec(`SAVEPOINT ${name}`);
    let feed: FrameFeed<void> | undefined, kept = false;
    const drop = (error: unknown): void => {
      if (!(error instanceof EncodingError)) throw error;
      feed = undefined;
      this.#db.exec(`ROLLBACK TO ${name}`); this.#db.exec(`RELEASE ${name}`);
    };
    try {
      feed = new FrameFeed(trailReader(this.#rows(batch, base), length + (base?.size ?? 0n),
        base === undefined ? {} : { retained: { events: base.position, bytes: base.size } }));
    } catch (error) { drop(error); }
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
        kept = true;
      },
      kept: () => kept,
    };
  }

  /** A trail's rows. The evidence chain runs over the longest prefix whose records decode (§5); only
   * that prefix can serve a checkpoint (§12.1), so later records are not kept. */
  #rows(batch: EvidenceBatch, base: Base | undefined): TrailSink {
    const q = this.#q;
    let head: bigint | undefined, digest: ReturnType<typeof sha256.create> | undefined, segment: Uint8Array | undefined;
    let chain: Uint8Array | undefined, line = base?.line, size = base?.size ?? 0n;
    return {
      header: header => {
        segment = sha256(header);
        // The recurrence continues only within its own segment: its seed is the segment's.
        if (base !== undefined && !same(segment, base.segment)) throw new EncodingError("an assembled trail of another segment");
        head = (q.head!.get(segment, header) as { id: bigint }).id;
        digest = sha256.create().update(frame(header));
        chain = base?.evidence ?? genesisEvidenceHash(segment);
      },
      terms: (i, terms, signature) => {
        q.terms!.run(head!, i, terms ?? null, signature);
        digest!.update(Uint8Array.of(terms === undefined ? 0 : 1)).update(frame(terms ?? new Uint8Array(0))).update(signature);
      },
      count: () => {
        // A head supplied again (one trail's head and its later assembled one, or a package resent) is kept once.
        const value = digest!.digest(), existing = q.headByDigest!.get(value) as { id: bigint } | undefined;
        if (existing === undefined) q.headDigest!.run(value, head!);
        else { q.dropHeadTerms!.run(head!); q.dropHead!.run(head!); }
      },
      record: (position, record) => {
        if (chain === undefined) return;
        let digests;
        try { digests = evidenceHashes(decodeRecord(record)); } catch (error) {
          if (!(error instanceof EncodingError)) throw error;
          chain = undefined;
          return;
        }
        chain = nextEvidenceHash(chain, digests, position);
        size += 4n + BigInt(record.length);
        batch.charge(RECORD_ROW_BYTES, PackageLimitError);
        line = this.#link(segment!, line, position, chain, size);
        // The chain value fixes every record through its position, so a kept row under it holds these bytes
        // unless storage damaged it; the supplied copy repairs it.
        q.record!.run(chain, record);
      },
    };
  }

  /** Place position `p` (chain value `evidence`) on a line: the kept line already holding it, else the end of
   * the line being followed, else a new line; one that forks copies the prefix it shares. */
  #link(segment: Uint8Array, line: bigint | undefined, p: bigint, evidence: Uint8Array, size: bigint): bigint {
    const q = this.#q, found = q.find!.get(evidence) as { line: bigint; position: bigint } | undefined;
    // A kept row under this value at another position is damage: it is not followed.
    if (found !== undefined && BigInt(found.position) === p) return found.line;
    if (line !== undefined && BigInt((q.lineTip!.get(line) as { position: bigint }).position) === p - 1n) {
      q.link!.run(line, p, evidence, size); q.moveTip!.run(p, line);
      return line;
    }
    const next = (q.newLine!.get(segment, p) as { id: bigint }).id;
    if (line !== undefined) q.fork!.run(next, line, p);
    q.link!.run(next, p, evidence, size);
    return next;
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

  async #transactionAsync<T>(body: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new Error("an import is already open on this store");
    this.#busy = true;
    this.#db.exec("BEGIN");
    try {
      const result = await body();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    } finally { this.#busy = false; }
  }
}

interface Head extends TrailHead { readonly id: bigint }

/** One imported package's own items, and the evidence the store retains, as a read uses them. */
export class EvidenceBatch implements WalkEvidence, TrailEvidence {
  readonly #db: DatabaseSync;
  readonly #q: Record<string, StatementSync>;
  readonly #quota: bigint;
  #bytes = 0n;
  readonly id: bigint;

  constructor(db: DatabaseSync, q: Record<string, StatementSync>, id: bigint, quota: bigint) {
    this.#db = db; this.#q = q; this.id = id; this.#quota = quota;
  }

  /** Count taken bytes against the party's quota. */
  charge(amount: bigint, Refusal: new (message: string) => Error): void {
    this.#bytes += amount;
    if (this.#bytes > this.#quota) throw new Refusal("the reader's evidence quota is exhausted");
  }
  chargeAnswer(amount: bigint): void { this.charge(amount, EvidenceRefusalQuota); }

  get trails(): TrailEvidence { return this; }

  /** Every whole item of a per-read kind (1, 2, 7, 10) in this package, in frame order. */
  payloads(kind: number): Uint8Array[] {
    return this.#q.payloads!.all(this.id, kind).map(row => bytes((row as { payload: unknown }).payload));
  }
  /** Items of `kind` this package carried. */
  count(kind: number): number { return Number((this.#q.count!.get(this.id, kind) as { c: bigint }).c); }
  /** Forget this read's own items once it ends; retained evidence stays. */
  release(): void { if (this.#db.isOpen) this.#q.release!.run(this.id); }

  /** A kept object by the hash its users look it up by, checked against that hash on use. */
  #object(kind: 3 | 4, hash: Uint8Array): Uint8Array | undefined {
    const row = this.#q.object!.get(kind, hash) as { payload: unknown } | undefined;
    if (row === undefined) return undefined;
    const payload = bytes(row.payload);
    if (!same(sha256(payload), hash)) {
      this.#q.dropObject!.run(kind, hash);
      throw new KeptEvidenceMismatch(kind === 3 ? "a directory" : "a snapshot");
    }
    return payload;
  }
  /** The kept directory whose root is `root`, decoded. */
  directory(root: Uint8Array): readonly SnapshotDigest[] | undefined {
    const payload = this.#object(3, root);
    return payload === undefined ? undefined : decodeEvidenceDirectory(payload);
  }
  /** The kept snapshot whose SHA256 is `digest`. */
  snapshot(digest: Uint8Array): Uint8Array | undefined { return this.#object(4, digest); }

  heads(segment: Uint8Array): Iterable<TrailHead> { return this.#heads(segment); }

  /** Heads are read one at a time and not kept, so many trails of one segment hold no memory. Each is its
   * segment's by the SHA256 of its header. */
  *#heads(segment: Uint8Array): Generator<Head> {
    const q = this.#q;
    for (let after = 0n; ;) {
      const row = q.heads!.get(segment, after) as { id: bigint; header: unknown } | undefined;
      if (row === undefined) return;
      const { id } = row, header = bytes(row.header);
      after = id;
      if (!same(sha256(header), segment)) {
        q.dropHeadTerms!.run(id); q.dropHead!.run(id);
        throw new KeptEvidenceMismatch("a trail head");
      }
      yield Object.freeze({ id, header, term(i: number): SignedTermsField | undefined {
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
      if (atSeed) return this.#cut(head, expected.segment, seed, undefined, 0n);
      // Every head of a segment has its header, and a chain value fixes the records before it, so any
      // kept line holding the snapshot's evidence hash serves it.
      const row = this.#q.find!.get(snapshot.evidenceHash) as { line: bigint; position: bigint; segment: unknown } | undefined;
      return row === undefined || !same(bytes(row.segment), expected.segment) ? undefined :
        this.#cut(head, expected.segment, seed, row.line, BigInt(row.position));
    }
    return undefined;
  }

  /** A line removed for damage: its positions no longer serve, and a trail supplied again rebuilds it. */
  #damaged(line: bigint): never {
    this.#q.dropLinks!.run(line); this.#q.dropLine!.run(line);
    throw new KeptEvidenceMismatch("a trail's records");
  }

  #cut(head: Head, segment: Uint8Array, seed: Uint8Array, line: bigint | undefined, length: bigint): StoredTrail {
    const db = this.#db, q = this.#q, damaged = (at: bigint): never => this.#damaged(at);
    // The chain value kept at `p` (the seed at 0), without its check.
    const kept = (p: bigint): Uint8Array | undefined => {
      if (p === 0n) return seed;
      const row = q.at!.get(line!, p) as { evidence: unknown } | undefined;
      return row === undefined ? undefined : bytes(row.evidence);
    };
    // The chain step to `p` from `previous` over `record`, or undefined where the record does not decode.
    const step = (previous: Uint8Array, record: Uint8Array, p: bigint): Uint8Array | undefined => {
      try { return nextEvidenceHash(previous, evidenceHashes(decodeRecord(record)), p); } catch (error) {
        if (!(error instanceof EncodingError)) throw error;
        return undefined;
      }
    };
    return Object.freeze({ header: head.header, segment, term: head.term, length,
      *records(after = 0n): Iterable<Uint8Array> {
        if (after >= length) return;
        let chain = kept(after), expected = after + 1n, broken = chain === undefined;
        if (!broken) {
          const rows = db.prepare(`SELECT k.position, k.evidence, r.bytes FROM link k LEFT JOIN record r ON r.evidence = k.evidence
            WHERE k.line = ? AND k.position > ? AND k.position <= ? ORDER BY k.position`);
          for (const row of rows.iterate(line!, after, length)) {
            const { position, evidence, bytes: stored } = row as { position: bigint; evidence: unknown; bytes: unknown };
            const record = stored === null ? undefined : bytes(stored);
            const next = record === undefined || BigInt(position) !== expected ? undefined : step(chain!, record, expected);
            if (next === undefined || !same(next, bytes(evidence))) { broken = true; break; }
            chain = next; expected++;
            yield record!;
          }
        }
        // A record missing, out of place or off the chain is damage, found before it could be replayed.
        if (broken || expected !== length + 1n) damaged(line!);
      },
      evidence(position: bigint): Uint8Array | undefined {
        if (position < 0n || position > length) return undefined;
        if (position === 0n) return seed;
        const previous = kept(position - 1n), row = q.at!.get(line!, position) as { evidence: unknown; bytes: unknown } | undefined;
        const value = row === undefined ? undefined : bytes(row.evidence);
        if (previous === undefined || value === undefined || row!.bytes === null) return damaged(line!);
        const next = step(previous, bytes(row!.bytes), position);
        if (next === undefined || !same(next, value)) return damaged(line!);
        return value;
      } });
  }
}

/** A venue answer past the quota is a resource refusal of the read, like any other budget (§14). */
class EvidenceRefusalQuota extends EvidenceRefusal { constructor() { super("resource-refusal"); } }
