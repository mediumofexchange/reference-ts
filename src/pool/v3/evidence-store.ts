// The reader's own copy of supplied evidence (storage decision 2026-09-29 item
// 8; pool-v3 §14 "Streamed input", "Incremental retrieval"): a package is
// copied into this store before any pass reads it, streamed or from memory,
// and every pass reads the copy. A party's file retains the evidence across
// reads, so a later package need carry only new objects:
// - directories and snapshots are kept once, by the SHA256 their users look
//   them up by;
// - a segment's trails share its header, kept once with the first supplied
//   terms field of each scoped backing that names it and verifies (§12.1);
//   fields that do not are not kept, so a supplier's junk adds no later work;
// - a trail's records are each stored once under their evidence chain value
//   (§7), with the segment whose trail supplied them and the value before.
//   The value fixes every record through its position, so trails that share
//   a prefix share its rows, a fork costs only its own records, and a trail
//   is read by walking back from the value its checkpoint names;
// - the items one read reads from its own package (kinds 1, 2, 7 and 10) stay
//   with that read's batch and go when the read ends.
// Nothing retained is trusted as stored: an object is checked against its hash
// when used and a record against the chain step to its position. Damage reads
// as absent evidence or leaves the read unresolved, never as a shorter trail
// or another record, and a copy supplied again repairs it. Budgets are per object: a whole item, a
// header, a terms field, a record; the one aggregate is the party's quota on
// the bytes one batch takes. The only module that touches this database.
//
// A supplier that serves incrementally sends parts (EvidencePart): whole §12
// packages of objects, and each trail as its head and the records after a
// position the receiver holds (`take`). The store keeps, for each supplier the
// party names, the sequence its evidence was supplied through, so the next
// request asks only for what came after. The file that holds the evidence
// holds that mark, so a lost file asks for everything again.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { randomBytes } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { compareBytes, copyBytes, copyUnshared, EncodingError, FrameFeed } from "../../bytes.js";
import type { SnapshotDigest } from "../../venue-records.js";
import { genesisEvidenceHash, nextEvidenceHash, snapshotDigest, type Snapshot } from "./commitments.js";
import type { ExpectedSnapshot } from "./fault-evidence.js";
import { decodeSegmentHeader, type SegmentEntry } from "./headers.js";
import { decodeEvidenceDirectory, decodeEvidencePackage, encodeEvidencePackage, PackageLimitError, packageReader, type PackageSink,
  type PayloadSink } from "./package.js";
import { decodeRecord, evidenceHashes } from "./records.js";
import { EvidenceRefusal } from "./refusals.js";
import { FileInUse } from "./replay-store.js";
import { verifyRootTermsSignature } from "./terms.js";
import { MAX_TRAIL_RECORD_BYTES, trailHead, trailReader, type TrailSink } from "./trail.js";

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
const SCHEMA_VERSION = 4;

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
  /** The §10 frame bytes of the cut's records, each behind its u32 length, as the kept rows state them. */
  readonly bytes: bigint;
  /** The frame bytes of the records through `position`, where the cut's chain passes through `evidence` there
   * (at 0, the seed). Read from the kept rows' links without checking a record: `records(position)` then
   * checks each later one. Undefined where it does not pass, or a link is missing. Gives up the process's
   * turn after each page of links walked. */
  reaches(position: bigint, evidence: Uint8Array): Promise<bigint | undefined>;
  /** The records after position `after` through `length`, in order, read from storage one at a time,
   * each checked against the chain value at its position before it is given. */
  records(after?: bigint): Iterable<Uint8Array>;
  /** `records`, giving up the process's turn after each page of links walked, so serving a long trail
   * leaves the process answering others; the links walked are never changed (§10). */
  stream(after?: bigint): AsyncIterable<Uint8Array>;
  /** evidenceHash at `position` (0 is the seed), for a position within the cut, checked by its chain step. */
  evidence(position: bigint): Uint8Array | undefined;
}
/** The trails a read may use (§10.1, §12.1). */
export interface TrailEvidence {
  /** The kept head of `segment` (its trails share one header), if any. */
  heads(segment: Uint8Array): Iterable<TrailHead>;
  /** The kept records of the snapshot's segment that reproduce the snapshot's evidence hash (at 0, the seed),
   * where the segment's head scopes its backing; later records are not its evidence. */
  served(expected: ExpectedSnapshot, snapshot: Snapshot): StoredTrail | undefined;
}
/** A retained store's identity and where its lineage stood when a batch began: one row per batch, each the hash of
 * the one before and fresh randomness, committed with what the batch kept. A store restored from an earlier copy
 * no longer holds a later mark, so a kept walk read from it is not resumed. */
export interface RetainedLineage {
  readonly identity: Uint8Array;
  readonly mark: Uint8Array;
  /** Whether this store's lineage still passes through `mark`. */
  holds(mark: Uint8Array): boolean;
}
/** The evidence a walk looks up, and the quota its venue answers are charged to. */
export interface WalkEvidence {
  /** The retained store the evidence is read from, where the store outlives the read (a file or a host's database);
   * undefined for a private in-memory store. A kept walk is bound to it (pool-v3 §14 kept walk). */
  readonly retained?: RetainedLineage | undefined;
  directory(root: Uint8Array): readonly SnapshotDigest[] | undefined;
  snapshot(digest: Uint8Array): Uint8Array | undefined;
  readonly trails: TrailEvidence;
  /** Count a kept venue answer's bytes against the read's quota: past it, a resource refusal (§14). */
  chargeAnswer(bytes: bigint): void;
}
/** A kept position of a segment's trail, by its chain value: the reader's own checkpoint that a later trail can be
 * fetched after, as a head and the records after it. */
export interface TrailTip { readonly segment: Uint8Array; readonly position: bigint; readonly evidence: Uint8Array }
/** One part of the evidence a supplier streams (§14 incremental retrieval): a whole §12 package of objects, or a
 * trail as §10's head and the records after `after`, a position the receiver holds (without it, a complete
 * trail). `size` is the byte length of `chunks`. A supplier's stated position authenticates nothing: the receiver
 * looks it up in its own rows and continues its own evidence recurrence from there. */
export type EvidencePart =
  | { readonly package: Uint8Array }
  | { readonly trail: { readonly after?: TrailTip | undefined; readonly size: bigint;
      readonly chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array> } };
/** Records a walk back holds at a time: a trail is read in pages, so memory does not grow with its length. */
const PAGE = 4096n;
/** Records read forward between two turns of a served trail: each is checked (about 0.1 ms), so a turn comes
 * every few tens of milliseconds. */
const FORWARD_TURN = 256n;
/** What a walk yields after each page of links: a synchronous reader passes over it, an asynchronous one gives
 * up the process's turn there (about 30 ms of links a page). */
const TURN: unique symbol = Symbol("turn");
type Walk<T> = Generator<typeof TURN, T, void>;
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
async function walkedAsync<T>(walk: Walk<T>): Promise<T> {
  for (;;) { const step = walk.next(); if (step.done === true) return step.value; await turn(); }
}

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
const bytes = (value: unknown): Uint8Array => new Uint8Array(value as Uint8Array);
/** A u64 as eight big-endian bytes, so stored order is numeric order. */
export const u64be = (value: bigint): Uint8Array => { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, value); return out; };

const SCHEMA = `
  CREATE TABLE batch (id INTEGER PRIMARY KEY AUTOINCREMENT);
  CREATE TABLE item (batch INTEGER, seq INTEGER, kind INTEGER NOT NULL, payload BLOB, PRIMARY KEY(batch, seq)) WITHOUT ROWID;
  CREATE INDEX item_kind ON item(batch, kind, seq);
  CREATE TABLE object (kind INTEGER, hash BLOB, payload BLOB NOT NULL, PRIMARY KEY(kind, hash)) WITHOUT ROWID;
  CREATE TABLE segment_head (segment BLOB PRIMARY KEY, header BLOB NOT NULL) WITHOUT ROWID;
  CREATE TABLE segment_terms (segment BLOB, i INTEGER, terms BLOB NOT NULL, signature BLOB NOT NULL, PRIMARY KEY(segment, i)) WITHOUT ROWID;
  CREATE TABLE chain (evidence BLOB NOT NULL UNIQUE, segment BLOB NOT NULL, prev BLOB NOT NULL, position INTEGER NOT NULL, size INTEGER NOT NULL,
    bytes BLOB NOT NULL);
  CREATE INDEX chain_position ON chain(segment, position);
  CREATE TABLE supplier (source BLOB PRIMARY KEY, sequence INTEGER NOT NULL) WITHOUT ROWID;`;
/** A retained store's identity, drawn once when its file or host's tables are made. Added beside layout 4's tables
 * where missing, so a file made before it gains one: nothing else reads it. */
const IDENTITY_SCHEMA = `CREATE TABLE IF NOT EXISTS evidence_identity (id INTEGER PRIMARY KEY CHECK (id = 1), value BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS evidence_lineage (n INTEGER PRIMARY KEY, h BLOB NOT NULL);`;
/** Lineage rows kept: a kept walk whose mark is older is resumed no more, and its next read judges every checkpoint once. */
const LINEAGE_KEPT = 65_536n;

/** A kept position a trail is assembled after: its chain value and the frame bytes of its records. */
interface Base { readonly segment: Uint8Array; readonly position: bigint; readonly evidence: Uint8Array; readonly size: bigint }

export class EvidenceStore {
  readonly #db: DatabaseSync;
  readonly #q: Record<string, StatementSync>;
  readonly #quota: bigint;
  readonly #hosted: boolean;
  readonly #identity: Uint8Array | undefined;
  #busy = false;
  #savepoints = 0;

  /** A private in-memory database by default; a file path is the party's retained evidence, reopened at its
   * layout and kept across reads. One import runs at a time, and a party opens its file once.
   * `maxBatchBytes` is the party's quota on what one batch takes (EVIDENCE_QUOTA by default).
   *
   * A host's open connection (one that reads integers as BigInt) places the store in the host's database
   * instead, as an operator's journal does (store.ts): the host owns durability and closing, its layout names
   * this one, and what the host keeps of its own (`keep`, `keepHead`, `append`) joins the host's open transaction. */
  constructor(source: string | DatabaseSync = ":memory:", options: { readonly maxBatchBytes?: bigint } = {}) {
    const quota = options.maxBatchBytes ?? (source === ":memory:" ? EVIDENCE_QUOTA.memory : EVIDENCE_QUOTA.file);
    if (typeof quota !== "bigint" || quota < 0n) throw new TypeError("invalid evidence quota");
    this.#quota = quota;
    if (typeof source !== "string") {
      this.#db = source; this.#hosted = true;
      if (this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'chain'").get() === undefined) this.#db.exec(SCHEMA);
      // No read of this host is open, so any per-read items are a crashed read's.
      else this.#db.exec("DELETE FROM item; DELETE FROM batch;");
    } else {
      this.#db = new DatabaseSync(source, { readBigInts: true }); this.#hosted = false;
      // A file that is no database, or that another connection holds, leaves no handle open on it.
      try {
        this.#db.exec("PRAGMA journal_mode=TRUNCATE; PRAGMA synchronous=FULL;");
        const version = (this.#db.prepare("PRAGMA user_version").get() as { user_version: bigint }).user_version;
        if (version === 0n) this.#db.exec(`${SCHEMA}; PRAGMA user_version = ${SCHEMA_VERSION};`);
        else if (version !== BigInt(SCHEMA_VERSION)) throw new TypeError("the evidence file has another layout");
        // No read is open, so any per-read items are a crashed read's.
        else this.#db.exec("DELETE FROM item; DELETE FROM batch;");
      } catch (error) {
        this.#db.close();
        if (error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message)) throw new FileInUse("the evidence file");
        throw error;
      }
    }
    // A store that outlives its reads keeps one identity in its own rows; a private in-memory one has none.
    if (source === ":memory:") this.#identity = undefined;
    else {
      this.#db.exec(IDENTITY_SCHEMA);
      this.#db.prepare("INSERT OR IGNORE INTO evidence_identity VALUES (1, ?)").run(randomBytes(16));
      this.#identity = new Uint8Array((this.#db.prepare("SELECT value FROM evidence_identity WHERE id = 1").get() as { value: Uint8Array }).value);
    }
    this.#q = Object.fromEntries(Object.entries({
      batch: "INSERT INTO batch VALUES (NULL) RETURNING id",
      item: "INSERT INTO item VALUES (?, ?, ?, ?)",
      payloads: "SELECT payload FROM item WHERE batch = ? AND kind = ? AND payload IS NOT NULL ORDER BY seq",
      count: "SELECT count(*) AS c FROM item WHERE batch = ? AND kind = ?",
      release: "DELETE FROM item WHERE batch = ?",
      releaseBatch: "DELETE FROM batch WHERE id = ?",
      keep: "INSERT INTO object VALUES (?, ?, ?) ON CONFLICT(kind, hash) DO UPDATE SET payload = excluded.payload WHERE payload != excluded.payload",
      object: "SELECT payload FROM object WHERE kind = ? AND hash = ?",
      // A header or verified terms field supplied again replaces a kept one that storage damaged.
      putHead: "INSERT INTO segment_head VALUES (?, ?) ON CONFLICT(segment) DO UPDATE SET header = excluded.header WHERE header != excluded.header",
      putTerms: `INSERT INTO segment_terms VALUES (?, ?, ?, ?) ON CONFLICT(segment, i) DO UPDATE SET terms = excluded.terms, signature = excluded.signature
        WHERE terms != excluded.terms OR signature != excluded.signature`,
      head: "SELECT header FROM segment_head WHERE segment = ?",
      headTerm: "SELECT terms, signature FROM segment_terms WHERE segment = ? AND i = ?",
      // A record supplied again under its chain value replaces a kept row that storage damaged.
      record: `INSERT INTO chain VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(evidence) DO UPDATE SET segment = excluded.segment, prev = excluded.prev,
        position = excluded.position, size = excluded.size, bytes = excluded.bytes WHERE segment != excluded.segment OR prev != excluded.prev
        OR position != excluded.position OR size != excluded.size OR bytes != excluded.bytes`,
      step: "SELECT prev, position, size FROM chain WHERE evidence = ? AND segment = ?",
      entry: "SELECT prev, position, bytes FROM chain WHERE evidence = ? AND segment = ?",
      // A forward step: the kept values of a segment at one position; two say a fork.
      at: "SELECT evidence FROM chain WHERE segment = ? AND position = ? LIMIT 2",
      supplied: "SELECT sequence FROM supplier WHERE source = ?",
      supply: "INSERT INTO supplier VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET sequence = excluded.sequence",
    }).map(([name, sql]) => [name, this.#db.prepare(sql)]));
  }

  close(): void { if (!this.#hosted && this.#db.isOpen) this.#db.close(); }

  /** The retained evidence alone, as a read uses it, with no package of its own. */
  retained(): EvidenceBatch { return this.#batch(); }

  // --- A party's own evidence (an operator's journal): kept as supplied evidence is, and read the same way.
  // Each is one statement or a few, so inside the host's open transaction it commits with the host's command.

  /** Keep the party's own directory (3) or snapshot (4) under the SHA256 its users look it up by. */
  keep(kind: 3 | 4, payload: Uint8Array): void {
    const own = copyBytes(payload);
    if (kind === 3) decodeEvidenceDirectory(own);
    this.#q.keep!.run(kind, sha256(own), own);
  }

  /** Keep the party's own segment head: its header and each scoped entry's signed terms, under §12.1's rule. */
  keepHead(header: Uint8Array, terms: readonly SignedTermsField[]): void {
    const own = copyBytes(header), segment = sha256(own), entries = decodeSegmentHeader(own).entries;
    this.#q.putHead!.run(segment, own);
    terms.forEach((field, i) => this.#keepTerms(segment, entries, i, copyBytes(field.terms), copyBytes(field.signature)));
  }

  /** Only a field that names its entry's backing and verifies is evidence (§12.1); it is the one kept. A field
   * already kept byte for byte was verified when it was kept, so a head served again costs no signature check. */
  #keepTerms(segment: Uint8Array, entries: readonly SegmentEntry[], i: number, terms: Uint8Array | undefined, signature: Uint8Array): void {
    const entry = entries[i];
    if (terms === undefined || entry === undefined || !same(sha256(terms), entry.backing)) return;
    const kept = this.#q.headTerm!.get(segment, i) as { terms: unknown; signature: unknown } | undefined;
    if (kept !== undefined && same(bytes(kept.terms), terms) && same(bytes(kept.signature), signature)) return;
    if (verifyRootTermsSignature(terms, signature)) {
      this.#q.putTerms!.run(segment, i, terms, signature);
    }
  }

  /** Keep the party's own record at the position after `after`, a kept position of its segment's trail (0 is
   * the seed), under the chain value the evidence recurrence gives it; returns that position. */
  append(after: TrailTip, record: Uint8Array): TrailTip {
    const segment = copyBytes(after.segment), previous = copyBytes(after.evidence), own = copyBytes(record);
    const base = after.position === 0n ? (same(previous, genesisEvidenceHash(segment)) ? { size: 0n } : undefined) :
      this.#base({ segment, position: after.position, evidence: previous });
    if (base === undefined) throw new Error("no kept trail position to append after");
    if (own.length > MAX_TRAIL_RECORD_BYTES) throw new EncodingError("trail record too long");
    const position = after.position + 1n, evidence = nextEvidenceHash(previous, evidenceHashes(decodeRecord(own)), position);
    this.#q.record!.run(evidence, segment, previous, position, base.size + 4n + BigInt(own.length), own);
    return { segment, position, evidence };
  }

  /** Copy a package held in memory: EncodingError for a malformed package and
   * PackageLimitError for a whole item past its budget or a batch past the quota, keeping nothing. */
  importBytes(input: Uint8Array): EvidenceBatch { return this.#importBytes(input, 0n); }

  /** `importBytes`, its batch charged from `spent` on. */
  #importBytes(input: Uint8Array, spent: bigint): EvidenceBatch {
    // The size is known, so the count and each length are checked against it before any payload.
    const own = copyUnshared(input);
    return this.#transaction(() => {
      const batch = this.#batch(spent), feed = new FrameFeed(packageReader(this.#sink(batch), { maxItemBytes: MAX_ITEM_BYTES, total: BigInt(own.length) }));
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
   * recurrence continues from the kept chain value; the stated position authenticates nothing. The head must
   * be of `after.segment`. Without `after`, or after position 0 (the segment's seed), the source is a complete
   * trail. A stream states its byte length (`size`). Resolves true where the trail framed and was kept; false
   * where it does not frame, is of another segment, or `after` is no kept position. PackageLimitError past the
   * quota.
   */
  async importTrail(source: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
    options: { readonly after?: TrailTip | undefined; readonly size?: bigint | undefined } = {}): Promise<boolean> {
    return (await this.#importTrail(source, options, 0n)).kept;
  }

  /** `importTrail`, its batch charged from `spent` on; resolves what it kept and the charge it reached. */
  async #importTrail(source: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
    options: { readonly after?: TrailTip | undefined; readonly size?: bigint | undefined }, spent: bigint): Promise<{ kept: boolean; charged: bigint }> {
    const streamed = !(source instanceof Uint8Array), own = streamed ? undefined : copyUnshared(source);
    const size = own === undefined ? options.size : BigInt(own.length);
    if (typeof size !== "bigint" || size < 0n) throw new TypeError("a streamed trail states its byte length");
    const after = options.after === undefined ? undefined :
      { segment: copyBytes(options.after.segment), position: options.after.position, evidence: copyBytes(options.after.evidence) };
    if (after !== undefined && (typeof after.position !== "bigint" || after.position < 0n || after.evidence.length !== 32 || after.segment.length !== 32)) {
      throw new TypeError("invalid trail position");
    }
    return this.#transactionAsync(async () => {
      let base: Base | undefined;
      if (after !== undefined) {
        base = after.position === 0n ? (same(after.evidence, genesisEvidenceHash(after.segment)) ? { ...after, size: 0n } : undefined) : this.#base(after);
        // A trail that is not read still costs its supplier's stated bytes: every trail byte counts, kept or not.
        if (base === undefined) return { kept: false, charged: spent + size };
      }
      const batch = this.#batch(spent);
      batch.charge(ITEM_ROW_BYTES, PackageLimitError);
      const receiver = this.#trail(batch, size, base);
      if (own !== undefined) receiver.data(own);
      else for await (const chunk of source as AsyncIterable<Uint8Array>) receiver.data(chunk);
      receiver.end(new Uint8Array(32));
      batch.release();
      return { kept: receiver.kept(), charged: batch.charged };
    });
  }

  /** Keep a supplier's parts, each whole or not at all: a package as `importBytes` copies it, its per-read items
   * dropped at once, and a trail as `importTrail` assembles it. Resolves false where some trail was not kept;
   * the other parts stay, since each is authenticated only when a read uses it. The party's quota bounds
   * all the parts together as it bounds one package, rows charged as well as bytes: a part whose stated size
   * does not fit what is left is refused before it is read, and one whose rows pass it while being kept. */
  async take(parts: Iterable<EvidencePart> | AsyncIterable<EvidencePart>): Promise<boolean> {
    let kept = true, charged = 0n;
    for await (const part of parts) {
      if (charged + ("package" in part ? BigInt(part.package.length) : part.trail.size) > this.#quota) {
        throw new PackageLimitError("the reader's evidence quota is exhausted");
      }
      if ("package" in part) {
        const batch = this.#importBytes(part.package, charged);
        charged = batch.charged; batch.release();
      } else {
        const trail = await this.#importTrail(part.trail.chunks, { after: part.trail.after, size: part.trail.size }, charged);
        charged = trail.charged; if (!trail.kept) kept = false;
      }
    }
    return kept;
  }

  /** The sequence through which the supplier the party names `source` has supplied its evidence; 0 for none. */
  suppliedThrough(source: Uint8Array): bigint {
    const row = this.#q.supplied!.get(copyBytes(source)) as { sequence: bigint } | undefined;
    return row === undefined ? 0n : BigInt(row.sequence);
  }
  /** Record that `source` has supplied everything through `sequence`, once all of it is kept. */
  supplied(source: Uint8Array, sequence: bigint): void {
    if (typeof sequence !== "bigint" || sequence < 0n || sequence >= 1n << 63n) throw new TypeError("invalid supplier sequence");
    this.#q.supply!.run(copyBytes(source), sequence);
  }

  /** The kept position `after` names, if a trail of it is kept there. */
  #base(after: TrailTip): Base | undefined {
    const row = this.#q.step!.get(after.evidence, after.segment) as { position: bigint; size: bigint } | undefined;
    return row === undefined || BigInt(row.position) !== after.position ? undefined :
      { segment: after.segment, position: after.position, evidence: after.evidence, size: BigInt(row.size) };
  }

  /** A new batch; `spent` is what earlier parts of the same supply already charged to the quota. */
  #batch(spent = 0n): EvidenceBatch {
    const id = (this.#q.batch!.get() as { id: bigint }).id;
    return new EvidenceBatch(this.#db, this.#q, id, this.#quota, spent, this.#lineage());
  }

  /** A new lineage row for a batch of a retained store, in the batch's own transaction where it has one. */
  #lineage(): RetainedLineage | undefined {
    const identity = this.#identity;
    if (identity === undefined) return undefined;
    const last = this.#db.prepare("SELECT n, h FROM evidence_lineage ORDER BY n DESC LIMIT 1").get() as { n: bigint; h: Uint8Array } | undefined;
    const n = (last?.n ?? 0n) + 1n, h = sha256(concatBytes(last === undefined ? identity : new Uint8Array(last.h), randomBytes(16)));
    this.#db.prepare("INSERT INTO evidence_lineage VALUES (?, ?)").run(n, h);
    if (n > LINEAGE_KEPT) this.#db.prepare("DELETE FROM evidence_lineage WHERE n <= ?").run(n - LINEAGE_KEPT);
    const mark = new Uint8Array(40); new DataView(mark.buffer).setBigUint64(0, n); mark.set(h, 8);
    const db = this.#db;
    return { identity: copyBytes(identity), mark, holds(kept: Uint8Array): boolean {
      if (!(kept instanceof Uint8Array) || kept.length !== 40) return false;
      const row = db.prepare("SELECT h FROM evidence_lineage WHERE n = ?").get(new DataView(kept.buffer, kept.byteOffset).getBigUint64(0)) as
        { h: Uint8Array } | undefined;
      return row !== undefined && compareBytes(new Uint8Array(row.h), kept.subarray(8)) === 0;
    } };
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
    let segment: Uint8Array | undefined, entries: readonly SegmentEntry[] = [];
    let chain: Uint8Array | undefined, size = base?.size ?? 0n;
    return {
      header: header => {
        segment = sha256(header);
        // The recurrence continues only within its own segment, whose seed began the kept chain.
        if (base !== undefined && !same(segment, base.segment)) throw new EncodingError("an assembled trail of another segment");
        // The frame refuses a header that does not decode at its end; its entries name the terms fields to keep.
        entries = decodeSegmentHeader(header).entries;
        q.putHead!.run(segment, header);
        chain = base?.evidence ?? genesisEvidenceHash(segment);
      },
      terms: (i, terms, signature) => { this.#keepTerms(segment!, entries, i, terms, signature); },
      count: () => {},
      record: (position, record) => {
        if (chain === undefined) return;
        let digests;
        try { digests = evidenceHashes(decodeRecord(record)); } catch (error) {
          if (!(error instanceof EncodingError)) throw error;
          chain = undefined;
          return;
        }
        const previous = chain;
        chain = nextEvidenceHash(previous, digests, position);
        size += 4n + BigInt(record.length);
        batch.charge(RECORD_ROW_BYTES, PackageLimitError);
        // The chain value fixes every record through its position, so a kept row under it holds these bytes
        // unless storage damaged it; the supplied copy repairs it.
        q.record!.run(chain, segment!, previous, position, size, record);
      },
    };
  }

  /** One import, all or nothing. Inside a host's open transaction it is a savepoint of it, so it commits with the host's command. */
  #transaction<T>(body: () => T): T {
    if (this.#busy) throw new Error("an import is already open on this store");
    const nested = this.#db.isTransaction, [begin, commit, rollback] = nested ?
      ["SAVEPOINT import", "RELEASE import", "ROLLBACK TO import; RELEASE import"] : ["BEGIN", "COMMIT", "ROLLBACK"];
    this.#db.exec(begin);
    try {
      const result = body();
      this.#db.exec(commit);
      return result;
    } catch (error) {
      this.#db.exec(rollback);
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

/** One imported package's own items, and the evidence the store retains, as a read uses them. */
export class EvidenceBatch implements WalkEvidence, TrailEvidence {
  readonly #db: DatabaseSync;
  readonly #q: Record<string, StatementSync>;
  readonly #quota: bigint;
  #bytes = 0n;
  readonly id: bigint;

  readonly retained: RetainedLineage | undefined;

  constructor(db: DatabaseSync, q: Record<string, StatementSync>, id: bigint, quota: bigint, spent = 0n, retained?: RetainedLineage) {
    this.#db = db; this.#q = q; this.id = id; this.#quota = quota; this.#bytes = spent; this.retained = retained;
  }

  /** Count taken bytes against the party's quota. */
  charge(amount: bigint, Refusal: new (message: string) => Error): void {
    this.#bytes += amount;
    if (this.#bytes > this.#quota) throw new Refusal("the reader's evidence quota is exhausted");
  }
  /** What the batch has charged to the quota, with what it started from. */
  get charged(): bigint { return this.#bytes; }
  chargeAnswer(amount: bigint): void { this.charge(amount, EvidenceRefusalQuota); }

  get trails(): TrailEvidence { return this; }

  /** Every whole item of a per-read kind (1, 2, 7, 10) in this package, in frame order. */
  payloads(kind: number): Uint8Array[] {
    return this.#q.payloads!.all(this.id, kind).map(row => bytes((row as { payload: unknown }).payload));
  }
  /** Items of `kind` this package carried. */
  count(kind: number): number { return Number((this.#q.count!.get(this.id, kind) as { c: bigint }).c); }
  /** Forget this read's own items once it ends; retained evidence stays. */
  release(): void { if (this.#db.isOpen) { this.#q.release!.run(this.id); this.#q.releaseBatch!.run(this.id); } }

  /** A kept object by the hash its users look it up by. One that no longer hashes to it is absent, as if never
   * supplied; a copy supplied again replaces it. */
  object(kind: 3 | 4, hash: Uint8Array): Uint8Array | undefined {
    const row = this.#q.object!.get(kind, hash) as { payload: unknown } | undefined;
    const payload = row === undefined ? undefined : bytes(row.payload);
    return payload !== undefined && same(sha256(payload), hash) ? payload : undefined;
  }
  /** The kept directory whose root is `root`, decoded. */
  directory(root: Uint8Array): readonly SnapshotDigest[] | undefined {
    const payload = this.object(3, root);
    return payload === undefined ? undefined : decodeEvidenceDirectory(payload);
  }
  /** The kept snapshot whose SHA256 is `digest`. */
  snapshot(digest: Uint8Array): Uint8Array | undefined { return this.object(4, digest); }

  /** The segment's kept head, if its header still hashes to the segment: its header and, for each scoped entry, the
   * first supplied terms field that named the entry's backing and verified (§12.1); a field that did not was never kept. */
  heads(segment: Uint8Array): Iterable<TrailHead> {
    const q = this.#q, row = q.head!.get(segment) as { header: unknown } | undefined;
    const header = row === undefined ? undefined : bytes(row.header);
    if (header === undefined || !same(sha256(header), segment)) return [];
    return [Object.freeze({ header, term(i: number): SignedTermsField | undefined {
      const found = q.headTerm!.get(segment, i) as { terms: unknown; signature: unknown } | undefined;
      return found === undefined ? undefined : Object.freeze({ terms: bytes(found.terms), signature: bytes(found.signature) });
    } })];
  }

  served(expected: ExpectedSnapshot, snapshot: Snapshot): StoredTrail | undefined {
    if (!same(snapshot.backing, expected.backing) || !same(snapshot.segment, expected.segment) ||
        !same(snapshotDigest(snapshot), expected.digest)) return undefined;
    const [head] = this.heads(expected.segment);
    if (head === undefined || !decodeSegmentHeader(head.header).entries.some(entry => same(entry.backing, expected.backing))) return undefined;
    return this.trail(expected.segment, snapshot.evidenceHash);
  }

  /** The kept records of `segment` through the chain value `evidence` (at its seed, none), with the segment's kept head. */
  trail(segment: Uint8Array, evidence: Uint8Array): StoredTrail | undefined {
    const seed = genesisEvidenceHash(segment), [head] = this.heads(segment);
    if (head === undefined) return undefined;
    if (same(evidence, seed)) return this.#cut(head, segment, seed, undefined, 0n, 0n);
    // A chain value fixes the records before it, and a kept row belongs to the segment whose trail supplied it: the
    // records of this segment under the snapshot's evidence hash serve it. The row's own chain step is checked
    // before its position gives the trail's length, so a damaged row is absent rather than a shorter trail.
    const row = this.#q.step!.get(evidence, segment) as { position: bigint; size: bigint } | undefined;
    if (row === undefined) return undefined;
    const length = BigInt(row.position);
    return chainStep(this.#q, segment, evidence, length) === undefined ? undefined :
      this.#cut(head, segment, seed, evidence, length, BigInt(row.size));
  }

  #cut(head: TrailHead, segment: Uint8Array, seed: Uint8Array, top: Uint8Array | undefined, length: bigint, size: bigint): StoredTrail {
    const q = this.#q;
    // Damage met on a walk leaves the read unresolved; nothing is deleted, and a copy supplied again repairs it.
    const broken = (): never => { throw new EvidenceRefusal("unresolved-evidence"); };
    /** One step back from the value kept at position `p`: the value before it, unchecked. */
    const stepBack = (value: Uint8Array, p: bigint): Uint8Array => {
      const row = q.step!.get(value, segment) as { prev: unknown; position: bigint } | undefined;
      return row === undefined || BigInt(row.position) !== p ? broken() : bytes(row.prev);
    };
    /** The values from position `to` down to `from`, walking back from `start` at `to`, highest first. */
    const back = (start: Uint8Array, to: bigint, from: bigint): Uint8Array[] => {
      const values: Uint8Array[] = [];
      for (let p = to, value = start; p >= from; p--) { values.push(value); value = stepBack(value, p); }
      return values;
    };
    /** The record kept under `value` at position `p`, after its chain step (and its link to `previous`, where known). */
    const checked = (value: Uint8Array, p: bigint, previous?: Uint8Array): { record: Uint8Array; prev: Uint8Array } => {
      const step = chainStep(q, segment, value, p);
      return step === undefined || (previous !== undefined && !same(step.prev, previous)) ? broken() : step;
    };
    /** `through`'s walk back from the top to `position`. */
    function* reach(position: bigint, evidence: Uint8Array): Walk<bigint | undefined> {
      if (position < 0n || position > length) return undefined;
      if (position === 0n) return same(evidence, seed) ? 0n : undefined;
      const held = q.step!.get(evidence, segment) as { position: bigint; size: bigint } | undefined;
      if (held === undefined || BigInt(held.position) !== position) return undefined;
      // The only value kept at the position is the cut's own, since every value of the cut is kept: no walk.
      if ((q.at!.all(segment, position) as unknown[]).length === 1) return BigInt(held.size);
      let value = top!;
      for (let p = length; p > position; p--) {
        if (p !== length && (length - p) % PAGE === 0n) yield TURN;
        const row = q.step!.get(value, segment) as { prev: unknown; position: bigint } | undefined;
        if (row === undefined || BigInt(row.position) !== p) return undefined;
        value = bytes(row.prev);
      }
      return same(value, evidence) ? BigInt(held.size) : undefined;
    }
    /** `records`, with a turn after each page of links walked; `expected` is a value at `after` its caller established. */
    function* walk(after: bigint, expected?: Uint8Array): Generator<Uint8Array | typeof TURN, void, void> {
      if (after >= length) return;
      // Walk back once to position `after`, keeping only the value at each page's top.
      const tops: Uint8Array[] = [];
      let value = top!;
      for (let p = length; p > after; p--) {
        if ((length - p) % PAGE === 0n) {
          if (p !== length) yield TURN;
          tops.push(value);
        }
        value = stepBack(value, p);
      }
      // The chain starts at the seed, or at the kept value at `after` that the caller checked against its own state.
      if (after === 0n && !same(value, seed)) broken();
      if (expected !== undefined && !same(value, expected)) broken();
      // Then read the pages forward, one page's values in memory at a time, each record checked before it is given.
      let previous = value, p = after + 1n;
      for (let i = tops.length - 1; i >= 0; i--) {
        yield TURN;
        const to = length - BigInt(i) * PAGE, page = back(tops[i]!, to, p).reverse();
        for (const entry of page) {
          if (p > after + 1n && (p - after - 1n) % FORWARD_TURN === 0n) yield TURN;
          const { record } = checked(entry, p, previous);
          previous = entry; p++;
          yield record;
        }
      }
    }
    /** `records` read forward by position: where one value is kept at a position it is the cut's own, since every
     * value of the cut is kept, so no walk back precedes the first record. Two values at a position (a fork kept
     * beside the cut) leave the rest to the walk back. Damage met forward refuses after the records before it,
     * each a genuine step of its segment, which a receiver checks against the chain it holds. */
    function* forward(after: bigint): Generator<Uint8Array | typeof TURN, void, void> {
      if (after >= length) return;
      let previous = seed;
      if (after > 0n) {
        const at = q.at!.all(segment, after) as { evidence: unknown }[];
        if (at.length !== 1) { yield* walk(after); return; }
        previous = bytes(at[0]!.evidence);
      }
      for (let p = after + 1n; p <= length; p++) {
        if ((p - after) % FORWARD_TURN === 0n) yield TURN;
        const next = q.at!.all(segment, p) as { evidence: unknown }[];
        if (next.length === 0) broken();
        // The walk back must meet the value read forward at p − 1; a different one is no part of this trail.
        if (next.length > 1) { yield* walk(p - 1n, previous); return; }
        // `checked` holds the value's chain step and its link back to `previous`.
        const value = bytes(next[0]!.evidence), { record } = checked(value, p, previous);
        previous = value;
        yield record;
      }
      if (!same(previous, top!)) broken();
    }
    return Object.freeze({ header: head.header, segment, term: head.term, length, bytes: size,
      reaches: (position: bigint, evidence: Uint8Array): Promise<bigint | undefined> => walkedAsync(reach(position, evidence)),
      *records(after = 0n): Iterable<Uint8Array> {
        for (const step of walk(after)) if (step !== TURN) yield step;
      },
      async *stream(after = 0n): AsyncIterable<Uint8Array> {
        for (const step of forward(after)) {
          if (step === TURN) await turn();
          else yield step;
        }
      },
      evidence(position: bigint): Uint8Array | undefined {
        if (position < 0n || position > length) return undefined;
        if (position === 0n) return seed;
        // Every step walked is checked, so the value returned is chained to the one the snapshot names.
        let value = top!;
        for (let p = length; p > position; p--) value = checked(value, p).prev;
        checked(value, position);
        return value;
      } });
  }
}

/** A kept trail as a supplier streams it: §10's head, then each record after `after` behind its u32 length, read
 * and checked one at a time. Undefined where the trail's chain does not pass through `after`. A scoped terms
 * field the evidence does not hold is served empty: it names no backing, so it is no evidence (§12.1). */
export async function trailPart(trail: StoredTrail, after?: TrailTip): Promise<EvidencePart | undefined> {
  const held = after === undefined ? 0n : await trail.reaches(after.position, after.evidence);
  if (held === undefined) return undefined;
  const count = decodeSegmentHeader(trail.header).entries.length;
  const head = trailHead(trail.header, Array.from({ length: count }, (_, i) => trail.term(i) ?? { terms: new Uint8Array(), signature: new Uint8Array(64) }), trail.length);
  const chunks = async function* (): AsyncIterable<Uint8Array> {
    yield head;
    for await (const record of trail.stream(after?.position ?? 0n)) {
      const framed = new Uint8Array(4 + record.length);
      new DataView(framed.buffer).setUint32(0, record.length, false); framed.set(record, 4);
      yield framed;
    }
  };
  return { trail: { after, size: BigInt(head.length) + trail.bytes - held, chunks: chunks() } };
}

/** One §12 package of a read's own items and a supplier's parts served from nothing, for a caller that holds a
 * whole package in memory. A trail served after a position is refused: it is no §10 frame by itself. At its peak it
 * holds about three times the package: its items, the encoder's own copy of them and the encoded package. A party
 * that keeps evidence takes the parts into a store instead (`EvidenceStore.take`), one part at a time. */
export async function wholePackage(own: Uint8Array, parts: Iterable<EvidencePart> | AsyncIterable<EvidencePart>): Promise<Uint8Array> {
  const items = new Map<string, { kind: number; payload: Uint8Array; hash: Uint8Array }>();
  const add = (kind: number, payload: Uint8Array): void => {
    const hash = sha256(payload); items.set(`${kind}:${bytesToHex(hash)}`, { kind, payload, hash });
  };
  for (const item of decodeEvidencePackage(own)) add(item.kind, item.payload);
  for await (const part of parts) {
    if ("package" in part) for (const item of decodeEvidencePackage(part.package)) add(item.kind, item.payload);
    else {
      if (part.trail.after !== undefined) throw new EncodingError("a whole package takes whole trails");
      const chunks: Uint8Array[] = [];
      for await (const chunk of part.trail.chunks) chunks.push(chunk);
      add(6, concatBytes(...chunks));
    }
  }
  return encodeEvidencePackage([...items.values()].sort((a, b) => a.kind - b.kind || compareBytes(a.hash, b.hash)));
}

/** The record kept under `value` at position `p` of `segment`, and the value before it, where its chain step holds. */
function chainStep(q: Record<string, StatementSync>, segment: Uint8Array, value: Uint8Array, p: bigint): { record: Uint8Array; prev: Uint8Array } | undefined {
  const row = q.entry!.get(value, segment) as { prev: unknown; position: bigint; bytes: unknown } | undefined;
  if (row === undefined || BigInt(row.position) !== p) return undefined;
  const record = bytes(row.bytes), prev = bytes(row.prev);
  let next: Uint8Array | undefined;
  try { next = nextEvidenceHash(prev, evidenceHashes(decodeRecord(record)), p); } catch (error) { if (!(error instanceof EncodingError)) throw error; }
  return next !== undefined && same(next, value) ? { record, prev } : undefined;
}

/** A venue answer past the quota is a resource refusal of the read, like any other budget (§14). */
class EvidenceRefusalQuota extends EvidenceRefusal { constructor() { super("resource-refusal"); } }
