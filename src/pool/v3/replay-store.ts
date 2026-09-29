// Replay state in node:sqlite (storage decision 2026-09-29, pool-v3 §14): the
// one module that touches the database, so a later node:sqlite change touches
// one file. A namespace holds one segment's replay under one replay identity.
//
// - Facts are append-only rows carrying the position that added them:
//   events, nullifiers (with their tags), outputs, anchors, demands and their
//   removals, cumulative totals. A read at (namespace, p) bounds every query by
//   p, and reads an imported namespace up to its imported position, so an
//   earlier position of a segment that has moved on stays readable.
// - Tip structures update in place and are read only at the tip: the spent
//   set's nodes, the note tree's frontier and the incremental witnesses of the
//   outputs a replay chose to witness. No note-tree interior node is kept.
// - A refused checkpoint rolls back a savepoint; nothing is copied to undo.
import { sha256 } from "@noble/hashes/sha2.js";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { V3_SPENT_EMPTY_CONTEXT, V3_SPENT_LEAF_CONTEXT as LEAF, V3_SPENT_NODE_CONTEXT as NODE } from "../../contexts.js";
import { bytesToField, fieldToBytes } from "../field.js";
import { EMPTY_NOTE_ROOT, EMPTY_NOTE_SUBTREE, NOTE_TREE_DEPTH, noteNode, type NotePath } from "../note-tree.js";

export interface Totals { issued: bigint; burned: bigint }
/** A standing kind-4 demand, by its statement identity. */
export interface Demand {
  readonly backing: Uint8Array;
  readonly quantity: bigint;
  readonly tags: readonly bigint[];
  readonly presenter: Uint8Array;
  readonly deadline: bigint;
}
/** The namespace and position an imported segment's rows are read to. */
export interface ImportEntry { readonly ns: number; readonly upto: bigint }
/** A new namespace's imported frontier: one namespace per imported segment (hex), and the totals it starts from. */
export interface Imports {
  readonly segments: ReadonlyMap<string, ImportEntry>;
  readonly totals: ReadonlyMap<string, Totals>;
}
/** A namespace's tip: position, chain values, the note tree's frontier and the spent set's top. */
export interface Tip {
  readonly segment: Uint8Array;
  readonly position: bigint;
  readonly history: Uint8Array;
  readonly evidence: Uint8Array;
  readonly leaves: bigint;
  readonly noteRoot: bigint;
  readonly spentRoot: Uint8Array;
}
/** One output as a receiver scans it: its capsule, or for a settlement the event holding its record. */
export interface StoredOutput {
  readonly cm: bigint;
  readonly ns: number;
  readonly position: bigint;
  readonly leaf: bigint;
  readonly capsule: Uint8Array | undefined;
  readonly settlement: boolean;
}
/** One replayed record: its identity and evidence digests, the index it was judged at and the chain values after it.
 * Record bytes stay in the evidence they came from; only a settlement keeps its record, which names its outputs' owner. */
export interface StoredEvent {
  readonly ns: number;
  readonly segment: string;
  readonly position: bigint;
  readonly identity: Uint8Array;
  readonly kind: number;
  readonly index: bigint | undefined;
  readonly proofHash: Uint8Array;
  readonly signatureHash: Uint8Array;
  readonly settlement: Uint8Array | undefined;
  readonly history: Uint8Array;
  readonly evidence: Uint8Array;
  readonly noteRoot: bigint;
  readonly spentRoot: Uint8Array;
}
/** Everything one accepted record writes; the caller has judged it against the pre-state. */
export interface Append {
  readonly identity: Uint8Array;
  readonly kind: number;
  readonly index: bigint | undefined;
  /** The record bytes, kept only for a settlement (kind 6). */
  readonly record: Uint8Array;
  readonly proofHash: Uint8Array;
  readonly signatureHash: Uint8Array;
  readonly evidence: Uint8Array;
  readonly supply: { readonly backing: string; readonly issued: bigint; readonly burned: bigint } | undefined;
  readonly nullifiers: readonly { readonly nf: bigint; readonly tag: bigint }[];
  readonly outputs: readonly { readonly cm: bigint; readonly capsule: Uint8Array | undefined; readonly settlement: boolean; readonly witness: boolean }[];
  readonly demand: { readonly id: string; readonly value: Demand } | undefined;
  readonly ended: string | undefined;
  /** The tags and demand this event touches, for C2.10.6's ordering check. */
  readonly keys: readonly string[];
  /** The history hash after this record, from the new roots. */
  history(noteRoot: bigint, spentRoot: Uint8Array): Uint8Array;
}
/** A witnessed output's path against its namespace's tip root. */
export interface WitnessPath { readonly leaf: bigint; readonly anchor: bigint; readonly path: NotePath; readonly ns: number }

const EMPTY_SPENT = sha256(V3_SPENT_EMPTY_CONTEXT);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const unhex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "hex"));
const bytes = (value: unknown): Uint8Array => new Uint8Array(value as Uint8Array);
const field = (value: unknown): bigint => bytesToField(bytes(value));
const optional = (value: unknown): bigint | undefined => (value === null || value === undefined ? undefined : BigInt(value as bigint));
const u64 = (value: bigint): string => value.toString();

// A row visible from (:ns, :p): the namespace's own rows through p, or an
// imported namespace's rows through its imported position.
const visible = (x: string): string =>
  `((${x}.ns = :ns AND ${x}.position <= :p) OR EXISTS (SELECT 1 FROM import i WHERE i.ns = :ns AND i.source = ${x}.ns AND ${x}.position <= i.upto))`;

const SCHEMA = `
  CREATE TABLE namespace (ns INTEGER PRIMARY KEY AUTOINCREMENT, segment BLOB NOT NULL, identity BLOB NOT NULL, position INTEGER NOT NULL,
    history BLOB NOT NULL, evidence BLOB NOT NULL, leaves INTEGER NOT NULL, note_root BLOB NOT NULL, ommers BLOB NOT NULL,
    spent_top INTEGER, spent_next INTEGER NOT NULL, base_spent BLOB NOT NULL);
  CREATE INDEX namespace_identity ON namespace(identity);
  CREATE TABLE import (ns INTEGER, segment BLOB, source INTEGER NOT NULL, upto INTEGER NOT NULL, PRIMARY KEY(ns, segment)) WITHOUT ROWID;
  CREATE UNIQUE INDEX import_source ON import(ns, source);
  CREATE TABLE event (ns INTEGER, position INTEGER, identity BLOB NOT NULL, kind INTEGER NOT NULL, idx TEXT, proof_hash BLOB NOT NULL,
    signature_hash BLOB NOT NULL, settlement BLOB,
    history BLOB NOT NULL, evidence BLOB NOT NULL, note_root BLOB NOT NULL, spent_root BLOB NOT NULL,
    backing BLOB, issued TEXT, burned TEXT, PRIMARY KEY(ns, position)) WITHOUT ROWID;
  CREATE INDEX event_identity ON event(identity);
  CREATE TABLE event_key (key TEXT, ns INTEGER, position INTEGER, PRIMARY KEY(key, ns, position)) WITHOUT ROWID;
  CREATE TABLE nullifier (nf BLOB, ns INTEGER, position INTEGER NOT NULL, tag BLOB NOT NULL, PRIMARY KEY(nf, ns)) WITHOUT ROWID;
  CREATE INDEX nullifier_tag ON nullifier(tag);
  CREATE INDEX nullifier_ns ON nullifier(ns, position);
  CREATE TABLE output (cm BLOB, ns INTEGER, position INTEGER NOT NULL, leaf INTEGER NOT NULL, capsule BLOB, settlement INTEGER NOT NULL,
    PRIMARY KEY(cm, ns)) WITHOUT ROWID;
  CREATE INDEX output_order ON output(ns, leaf);
  CREATE TABLE anchor (root BLOB, ns INTEGER, position INTEGER NOT NULL, PRIMARY KEY(root, ns)) WITHOUT ROWID;
  CREATE TABLE demand (id TEXT, ns INTEGER, position INTEGER NOT NULL, backing BLOB NOT NULL, quantity TEXT NOT NULL,
    tag0 BLOB NOT NULL, tag1 BLOB NOT NULL, presenter BLOB NOT NULL, deadline TEXT NOT NULL, PRIMARY KEY(id, ns)) WITHOUT ROWID;
  CREATE TABLE demand_tag (tag BLOB, id TEXT, ns INTEGER, PRIMARY KEY(tag, id, ns)) WITHOUT ROWID;
  CREATE TABLE demand_end (id TEXT, ns INTEGER, position INTEGER NOT NULL, PRIMARY KEY(id, ns)) WITHOUT ROWID;
  CREATE TABLE total (ns INTEGER, backing BLOB, position INTEGER, issued TEXT NOT NULL, burned TEXT NOT NULL,
    PRIMARY KEY(ns, backing, position)) WITHOUT ROWID;
  CREATE TABLE spent (ns INTEGER, id INTEGER, key BLOB NOT NULL, bit INTEGER, l INTEGER, r INTEGER, hash BLOB NOT NULL,
    PRIMARY KEY(ns, id)) WITHOUT ROWID;
  CREATE TABLE witness (ns INTEGER, leaf INTEGER, cm BLOB NOT NULL, siblings BLOB NOT NULL, PRIMARY KEY(ns, leaf)) WITHOUT ROWID;
  CREATE TABLE merging (ns INTEGER PRIMARY KEY, upto INTEGER NOT NULL);
  CREATE TABLE walk (id INTEGER PRIMARY KEY AUTOINCREMENT);
  CREATE TABLE walk_verdict (walk INTEGER, key BLOB, operator BLOB NOT NULL, seq BLOB NOT NULL, root BLOB NOT NULL, signature BLOB NOT NULL,
    idx BLOB NOT NULL, class TEXT NOT NULL, detail TEXT, segment BLOB NOT NULL, snapshot BLOB NOT NULL, ns INTEGER, position INTEGER,
    identity BLOB, issued TEXT, burned TEXT, adoption TEXT, opening BLOB, PRIMARY KEY(walk, key)) WITHOUT ROWID;
  CREATE INDEX walk_verdict_order ON walk_verdict(walk, idx, seq);
  CREATE TABLE walk_valid (walk INTEGER, backing BLOB, idx BLOB, seq BLOB, operator BLOB NOT NULL, key BLOB NOT NULL,
    PRIMARY KEY(walk, backing, idx, seq)) WITHOUT ROWID;
  CREATE TABLE walk_scope (walk INTEGER, segment BLOB, i INTEGER, bytes BLOB NOT NULL, signature BLOB, PRIMARY KEY(walk, segment, i)) WITHOUT ROWID;
  CREATE TABLE walk_base (walk INTEGER, segment BLOB, opening BLOB NOT NULL, parents TEXT NOT NULL, totals TEXT NOT NULL,
    adoption TEXT NOT NULL, PRIMARY KEY(walk, segment)) WITHOUT ROWID;
  CREATE TABLE walk_import (walk INTEGER, segment BLOB, name BLOB, ns INTEGER NOT NULL, upto INTEGER NOT NULL, PRIMARY KEY(walk, segment, name)) WITHOUT ROWID;
  CREATE TABLE walk_block (walk INTEGER, segment BLOB, n INTEGER, backing BLOB NOT NULL, idx BLOB NOT NULL, ordinal BLOB NOT NULL, bytes BLOB NOT NULL,
    PRIMARY KEY(walk, segment, n)) WITHOUT ROWID;
  CREATE TABLE walk_publication (walk INTEGER, backing BLOB, idx BLOB, ordinal BLOB, force INTEGER NOT NULL, detail TEXT, bytes BLOB,
    PRIMARY KEY(walk, backing, idx, ordinal)) WITHOUT ROWID;`;
const WALK_TABLES = ["walk_verdict", "walk_valid", "walk_scope", "walk_base", "walk_import", "walk_block", "walk_publication"];

/** A u64 as eight big-endian bytes, so stored order is numeric order. */
const be = (value: bigint): Uint8Array => { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, value); return out; };
const fromBe = (value: unknown): bigint => new DataView(bytes(value).buffer).getBigUint64(0);

/** A classified checkpoint as a walk keeps it (storage decision item 2): its commitment and index, its class with
 * the check of an exclusion or the clock record of a lapse, its segment and snapshot, and for a valid one the
 * replayed state's namespace, position and facts. */
export interface WalkVerdict {
  readonly key: Uint8Array;
  readonly operator: Uint8Array;
  readonly sequence: bigint;
  readonly root: Uint8Array;
  readonly signature: Uint8Array;
  readonly index: bigint;
  readonly class: "valid" | "lapsed" | "excluded";
  readonly detail: string | undefined;
  readonly segment: Uint8Array;
  readonly snapshot: Uint8Array;
  readonly state?: {
    readonly ns: number; readonly position: bigint; readonly identity: Uint8Array; readonly issued: bigint; readonly burned: bigint;
    readonly adoption: ReadonlyMap<string, bigint>; readonly opening: bigint;
  } | undefined;
}
/** What a segment's opening fixes for every checkpoint of it, as a walk keeps it: the opening index, each scoped
 * backing's imported predecessor by key, the merged imported frontier and each backing's adoption index, and the
 * adopted block. */
export interface WalkBase {
  readonly openingIndex: bigint;
  readonly parents: readonly (Uint8Array | undefined)[];
  readonly imports: ReadonlyMap<string, ImportEntry>;
  readonly totals: ReadonlyMap<string, Totals>;
  readonly adoption: ReadonlyMap<string, bigint>;
  readonly block: readonly WalkForce[];
}
/** A forced publication's inner record, by its backing (hex) and venue position. */
export interface WalkForce { readonly backing: string; readonly index: bigint; readonly ordinal: bigint; readonly bytes: Uint8Array }
/** A classified publication: forced, or not with the check that refused it (none where it was not a candidate). */
export interface WalkPublication { readonly index: bigint; readonly ordinal: bigint; readonly force: boolean; readonly check: string | undefined }
const mapJson = (map: ReadonlyMap<string, bigint>): string => JSON.stringify([...map].map(([k, v]) => [k, v.toString()]));
const jsonMap = (text: unknown): Map<string, bigint> => new Map((JSON.parse(text as string) as [string, string][]).map(([k, v]) => [k, BigInt(v)]));

/** What C2.10.6 checks over a union of imported prefixes, one namespace per segment. */
export interface UnionFacts {
  readonly repeatedNullifier: boolean;
  readonly repeatedOutput: boolean;
  readonly repeatedRecovery: boolean;
  /** Each tag or demand two or more events touch, with those events. */
  readonly shared: ReadonlyMap<string, readonly { readonly ns: number; readonly position: bigint; readonly segment: string }[]>;
  readonly supply: ReadonlyMap<string, Totals>;
}

interface SpentNode { readonly key: Uint8Array; readonly bit: number | null; readonly l: bigint | null; readonly r: bigint | null; readonly hash: Uint8Array }
const rightAt = (key: Uint8Array, bit: number): boolean => ((key[bit >> 3]! >> (7 - (bit & 7))) & 1) === 1;
const splitAt = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < 32; i++) { const x = a[i]! ^ b[i]!; if (x !== 0) return i * 8 + Math.clz32(x) - 24; }
  return 256;
};
const leafHash = (key: Uint8Array): Uint8Array => { const f = new Uint8Array(LEAF.length + 32); f.set(LEAF); f.set(key, LEAF.length); return sha256(f); };
const branchHash = (bit: number, left: Uint8Array, right: Uint8Array): Uint8Array => {
  const f = new Uint8Array(NODE.length + 66);
  f.set(NODE); f[NODE.length] = bit >> 8; f[NODE.length + 1] = bit & 255; f.set(left, NODE.length + 2); f.set(right, NODE.length + 34);
  return sha256(f);
};

// The frontier: ommers[h] is the completed left subtree of height h waiting for its right sibling, present where bit h of the leaf count is 1.
const encodeOmmers = (ommers: readonly (bigint | undefined)[]): Uint8Array => {
  const out = new Uint8Array(33 * NOTE_TREE_DEPTH);
  ommers.forEach((value, h) => { if (value !== undefined) { out[33 * h] = 1; out.set(fieldToBytes(value), 33 * h + 1); } });
  return out;
};
const decodeOmmers = (blob: Uint8Array): (bigint | undefined)[] => Array.from({ length: NOTE_TREE_DEPTH }, (_, h) =>
  blob[33 * h] === 0 ? undefined : bytesToField(blob.subarray(33 * h + 1, 33 * h + 33)));
const encodeSiblings = (siblings: readonly bigint[]): Uint8Array => {
  const out = new Uint8Array(32 * NOTE_TREE_DEPTH);
  siblings.forEach((value, h) => out.set(fieldToBytes(value), 32 * h));
  return out;
};
const decodeSiblings = (blob: Uint8Array): bigint[] => Array.from({ length: NOTE_TREE_DEPTH }, (_, h) => bytesToField(blob.subarray(32 * h, 32 * h + 32)));
const msb = (x: bigint): number => x.toString(2).length - 1;

export class ReplayStore {
  readonly #db: DatabaseSync;
  readonly #q: Record<string, StatementSync>;
  #savepoints = 0;
  #replaying = false;

  /** A private in-memory database by default: short reads and tests run the same code. */
  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path, { readBigInts: true });
    this.#db.exec("PRAGMA journal_mode=TRUNCATE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;");
    this.#db.exec(SCHEMA);
    const v = visible("x");
    this.#q = Object.fromEntries(Object.entries({
      tip: "SELECT * FROM namespace WHERE ns = ?",
      namespaces: "SELECT ns FROM namespace WHERE identity = ? ORDER BY ns",
      insertNamespace: "INSERT INTO namespace VALUES (NULL, ?, ?, 0, ?, ?, 0, ?, ?, NULL, 1, ?) RETURNING ns",
      updateTip: "UPDATE namespace SET position = ?, history = ?, evidence = ?, leaves = ?, note_root = ?, ommers = ?, spent_top = ?, spent_next = ? WHERE ns = ?",
      imports: "SELECT segment, source, upto FROM import WHERE ns = ? ORDER BY source",
      insertImport: "INSERT INTO import VALUES (?, ?, ?, ?)",
      nullifier: `SELECT 1 FROM nullifier x WHERE x.nf = :key AND ${v}`,
      output: `SELECT 1 FROM output x WHERE x.cm = :key AND ${v}`,
      anchor: `SELECT 1 FROM anchor x WHERE x.root = :key AND ${v}`,
      spentTag: `SELECT 1 FROM nullifier x WHERE x.tag = :key AND ${v}`,
      effective: `SELECT 1 FROM event x WHERE x.identity = :key AND x.kind >= 4 AND ${v}`,
      statement: "SELECT 1 FROM event WHERE identity = ? AND ns = ? AND position <= ?",
      demand: `SELECT x.* FROM demand x WHERE x.id = :key AND ${v} AND NOT EXISTS (SELECT 1 FROM demand_end y WHERE y.id = x.id AND ${visible("y")})`,
      demandsWithTag: `SELECT x.* FROM demand_tag t JOIN demand x ON x.id = t.id AND x.ns = t.ns WHERE t.tag = :key AND ${v}
        AND NOT EXISTS (SELECT 1 FROM demand_end y WHERE y.id = x.id AND ${visible("y")})`,
      demands: `SELECT x.* FROM demand x WHERE ${v} AND NOT EXISTS (SELECT 1 FROM demand_end y WHERE y.id = x.id AND ${visible("y")}) ORDER BY x.ns, x.position`,
      totals: "SELECT backing, issued, burned FROM total t WHERE ns = ? AND position = (SELECT max(position) FROM total u WHERE u.ns = t.ns AND u.backing = t.backing AND u.position <= ?)",
      total: "SELECT issued, burned FROM total WHERE ns = ? AND backing = ? AND position <= ? ORDER BY position DESC LIMIT 1",
      insertTotal: "INSERT OR REPLACE INTO total VALUES (?, ?, ?, ?, ?)",
      event: "SELECT e.*, n.segment FROM event e JOIN namespace n ON n.ns = e.ns WHERE e.ns = ? AND e.position = ?",
      events: `SELECT x.*, n.segment FROM event x JOIN namespace n ON n.ns = x.ns WHERE ${v} ORDER BY x.ns, x.position`,
      eventCount: `SELECT count(*) AS c FROM event x WHERE ${v}`,
      ownEvents: "SELECT position, idx FROM event WHERE ns = ? AND position <= ? ORDER BY position",
      insertEvent: "INSERT INTO event VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      insertKey: "INSERT INTO event_key VALUES (?, ?, ?)",
      insertNullifier: "INSERT INTO nullifier VALUES (?, ?, ?, ?)",
      insertOutput: "INSERT INTO output VALUES (?, ?, ?, ?, ?, ?)",
      insertAnchor: "INSERT OR IGNORE INTO anchor VALUES (?, ?, ?)",
      insertDemand: "INSERT INTO demand VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      insertDemandTag: "INSERT OR IGNORE INTO demand_tag VALUES (?, ?, ?)",
      insertDemandEnd: "INSERT INTO demand_end VALUES (?, ?, ?)",
      outputs: `SELECT x.* FROM output x WHERE ${v} ORDER BY x.ns, x.leaf`,
      outputOf: `SELECT x.* FROM output x WHERE x.cm = :key AND ${v}`,
      witnessed: `SELECT x.* FROM output x JOIN witness w ON w.ns = x.ns AND w.leaf = x.leaf WHERE ${v} ORDER BY x.ns, x.leaf`,
      nullifiers: `SELECT x.nf FROM nullifier x WHERE ${v} ORDER BY x.ns, x.position`,
      importedNullifiers: "SELECT nf FROM nullifier WHERE ns = ? AND position <= ?",
      spentGet: "SELECT key, bit, l, r, hash FROM spent WHERE ns = ? AND id = ?",
      spentPut: "INSERT OR REPLACE INTO spent VALUES (?, ?, ?, ?, ?, ?, ?)",
      witnesses: "SELECT leaf, siblings FROM witness WHERE ns = ?",
      witness: "SELECT siblings FROM witness WHERE ns = ? AND leaf = ?",
      putWitness: "INSERT INTO witness VALUES (?, ?, ?, ?)",
      moveWitness: "UPDATE witness SET siblings = ? WHERE ns = ? AND leaf = ?",
    }).map(([name, sql]) => [name, this.#db.prepare(sql)]));
  }

  close(): void { if (this.#db.isOpen) this.#db.close(); }

  // --- Namespaces -------------------------------------------------------------------------

  /** A fresh namespace for `segment` under `identity`: the empty tree and anchor, the
   * imported frontier's rows by reference, its spent set built from them (C1.2.8), and
   * the totals it starts from. */
  open(segment: Uint8Array, identity: Uint8Array, imports: Imports | undefined, genesis: { history: Uint8Array; evidence: Uint8Array }): number {
    return this.#atomic(() => {
      const row = this.#q.insertNamespace!.get(segment, identity, genesis.history, genesis.evidence, fieldToBytes(EMPTY_NOTE_ROOT),
        encodeOmmers([]), EMPTY_SPENT) as { ns: bigint };
      const ns = Number(row.ns);
      for (const [name, entry] of imports?.segments ?? []) this.#q.insertImport!.run(ns, unhex(name), entry.ns, entry.upto);
      this.#q.insertAnchor!.run(fieldToBytes(EMPTY_NOTE_ROOT), ns, 0n);
      for (const [backing, total] of imports?.totals ?? []) this.#q.insertTotal!.run(ns, unhex(backing), 0n, u64(total.issued), u64(total.burned));
      // The successor's spent set holds every imported nullifier.
      const spent = this.#spent(ns);
      for (const entry of imports?.segments.values() ?? []) {
        for (const nf of this.#q.importedNullifiers!.iterate(entry.ns, entry.upto)) spent.insert(bytes((nf as { nf: unknown }).nf));
      }
      spent.save();
      this.#db.prepare("UPDATE namespace SET base_spent = ? WHERE ns = ?").run(spent.root(), ns);
      return ns;
    });
  }

  identity(ns: number): Uint8Array {
    return bytes((this.#db.prepare("SELECT identity FROM namespace WHERE ns = ?").get(ns) as { identity: unknown }).identity);
  }

  /** The namespaces holding replays under `identity`, oldest first. */
  namespaces(identity: Uint8Array): number[] {
    return this.#q.namespaces!.all(identity).map(row => Number((row as { ns: bigint }).ns));
  }

  /** The spent root a namespace opened with: its imported nullifiers'. */
  baseSpentRoot(ns: number): Uint8Array {
    return bytes((this.#db.prepare("SELECT base_spent FROM namespace WHERE ns = ?").get(ns) as { base_spent: unknown }).base_spent);
  }

  tip(ns: number): Tip {
    const row = this.#q.tip!.get(ns) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error("unknown replay namespace");
    const spentTop = optional(row["spent_top"]);
    return { segment: bytes(row["segment"]), position: BigInt(row["position"] as bigint), history: bytes(row["history"]), evidence: bytes(row["evidence"]),
      leaves: BigInt(row["leaves"] as bigint), noteRoot: field(row["note_root"]),
      spentRoot: spentTop === undefined ? EMPTY_SPENT : this.#spentNode(ns, spentTop).hash };
  }

  /** The imported frontier of `ns`: each imported segment (hex) → namespace and position. */
  imports(ns: number): Map<string, ImportEntry> {
    const out = new Map<string, ImportEntry>();
    for (const row of this.#q.imports!.iterate(ns)) {
      const r = row as { segment: Uint8Array; source: bigint; upto: bigint };
      out.set(hex(bytes(r.segment)), { ns: Number(r.source), upto: BigInt(r.upto) });
    }
    return out;
  }

  // --- Savepoints -------------------------------------------------------------------------

  /** One checkpoint's replay: its writes stand only if `body` returns. A replay never
   * opens inside another (parents are classified before the child's replay opens). */
  async replay<T>(body: () => Promise<T>): Promise<T> {
    if (this.#replaying) throw new Error("a replay is already open on this store");
    this.#replaying = true;
    try { return await this.#savepoint(body); } finally { this.#replaying = false; }
  }

  /** Synchronous writes that stand only if `body` returns. */
  atomic<T>(body: () => T): T { return this.#atomic(body); }

  #atomic<T>(body: () => T): T {
    const name = `s${this.#savepoints++}`;
    this.#db.exec(`SAVEPOINT ${name}`);
    try {
      const result = body();
      this.#db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.#db.exec(`ROLLBACK TO ${name}`); this.#db.exec(`RELEASE ${name}`);
      throw error;
    } finally { this.#savepoints--; }
  }

  async #savepoint<T>(body: () => Promise<T>): Promise<T> {
    const name = `s${this.#savepoints++}`;
    this.#db.exec(`SAVEPOINT ${name}`);
    try {
      const result = await body();
      this.#db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.#db.exec(`ROLLBACK TO ${name}`); this.#db.exec(`RELEASE ${name}`);
      throw error;
    } finally { this.#savepoints--; }
  }

  /** Drop every namespace that neither `keep` nor anything they import reads. */
  collect(keep: readonly number[]): void {
    if (this.#replaying) throw new Error("a replay is open on this store");
    const live = new Set<number>();
    for (const ns of keep) { live.add(ns); for (const entry of this.imports(ns).values()) live.add(entry.ns); }
    const dead = (this.#db.prepare("SELECT ns FROM namespace").all() as { ns: bigint }[]).map(r => Number(r.ns)).filter(ns => !live.has(ns));
    if (dead.length === 0) return;
    this.#atomic(() => {
      for (const table of ["namespace", "import", "event", "event_key", "nullifier", "output", "anchor", "demand", "demand_tag", "demand_end",
        "total", "spent", "witness"]) {
        const drop = this.#db.prepare(`DELETE FROM ${table} WHERE ns = ?`);
        for (const ns of dead) drop.run(ns);
      }
    });
  }

  // --- Reads at (ns, p) -------------------------------------------------------------------

  #has(query: string, ns: number, p: bigint, key: Uint8Array | string): boolean {
    return this.#q[query]!.get({ ns, p, key }) !== undefined;
  }
  hasNullifier(ns: number, p: bigint, nf: bigint): boolean { return this.#has("nullifier", ns, p, fieldToBytes(nf)); }
  hasOutput(ns: number, p: bigint, cm: bigint): boolean { return this.#has("output", ns, p, fieldToBytes(cm)); }
  hasAnchor(ns: number, p: bigint, root: bigint): boolean { return this.#has("anchor", ns, p, fieldToBytes(root)); }
  hasSpentTag(ns: number, p: bigint, tag: bigint): boolean { return this.#has("spentTag", ns, p, fieldToBytes(tag)); }
  /** A recovery statement (kind 4–6) already effective in the visible history. */
  isEffective(ns: number, p: bigint, id: string): boolean { return this.#has("effective", ns, p, unhex(id)); }
  /** A statement already in this segment's own history (imports are not statements of it). */
  hasStatement(ns: number, p: bigint, identity: Uint8Array): boolean { return this.#q.statement!.get(identity, ns, p) !== undefined; }

  #demand(row: Record<string, unknown>): [string, Demand] {
    return [row["id"] as string, { backing: bytes(row["backing"]), quantity: BigInt(row["quantity"] as string),
      tags: [field(row["tag0"]), field(row["tag1"])], presenter: bytes(row["presenter"]), deadline: BigInt(row["deadline"] as string) }];
  }
  demand(ns: number, p: bigint, id: string): Demand | undefined {
    const row = this.#q.demand!.get({ ns, p, key: id }) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#demand(row)[1];
  }
  demandsWithTag(ns: number, p: bigint, tag: bigint): [string, Demand][] {
    return this.#q.demandsWithTag!.all({ ns, p, key: fieldToBytes(tag) }).map(row => this.#demand(row as Record<string, unknown>));
  }
  demands(ns: number, p: bigint): [string, Demand][] {
    return this.#q.demands!.all({ ns, p }).map(row => this.#demand(row as Record<string, unknown>));
  }

  total(ns: number, p: bigint, backing: string): Totals {
    const row = this.#q.total!.get(ns, unhex(backing), p) as { issued: string; burned: string } | undefined;
    return row === undefined ? { issued: 0n, burned: 0n } : { issued: BigInt(row.issued), burned: BigInt(row.burned) };
  }
  totals(ns: number, p: bigint): Map<string, Totals> {
    const out = new Map<string, Totals>();
    for (const row of this.#q.totals!.iterate(ns, p)) {
      const r = row as { backing: Uint8Array; issued: string; burned: string };
      out.set(hex(bytes(r.backing)), { issued: BigInt(r.issued), burned: BigInt(r.burned) });
    }
    return out;
  }

  #event(row: Record<string, unknown>): StoredEvent {
    return { ns: Number(row["ns"] as bigint), segment: hex(bytes(row["segment"])), position: BigInt(row["position"] as bigint),
      identity: bytes(row["identity"]), kind: Number(row["kind"] as bigint),
      index: row["idx"] === null ? undefined : BigInt(row["idx"] as string), proofHash: bytes(row["proof_hash"]),
      signatureHash: bytes(row["signature_hash"]), settlement: row["settlement"] === null ? undefined : bytes(row["settlement"]), history: bytes(row["history"]),
      evidence: bytes(row["evidence"]), noteRoot: field(row["note_root"]), spentRoot: bytes(row["spent_root"]) };
  }
  /** The event at `position` of `ns` itself. */
  event(ns: number, position: bigint): StoredEvent | undefined {
    const row = this.#q.event!.get(ns, position) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#event(row);
  }
  /** Every visible event, imports first. */
  *events(ns: number, p: bigint): Generator<StoredEvent> {
    for (const row of this.#q.events!.iterate({ ns, p })) yield this.#event(row as Record<string, unknown>);
  }
  eventCount(ns: number, p: bigint): bigint { return BigInt((this.#q.eventCount!.get({ ns, p }) as { c: bigint }).c); }
  /** The index each of this segment's own records was judged at, by position from 1. */
  judgedIndices(ns: number, p: bigint): (bigint | undefined)[] {
    return this.#q.ownEvents!.all(ns, p).map(row => ((row as { idx: string | null }).idx === null ? undefined : BigInt((row as { idx: string }).idx)));
  }

  #output(row: Record<string, unknown>): StoredOutput {
    return { cm: field(row["cm"]), ns: Number(row["ns"] as bigint), position: BigInt(row["position"] as bigint), leaf: BigInt(row["leaf"] as bigint),
      capsule: row["capsule"] === null ? undefined : bytes(row["capsule"]), settlement: row["settlement"] === 1n };
  }
  /** Every visible output, in namespace then leaf order. */
  *outputs(ns: number, p: bigint): Generator<StoredOutput> {
    for (const row of this.#q.outputs!.iterate({ ns, p })) yield this.#output(row as Record<string, unknown>);
  }
  /** The visible outputs the replay kept a witness for, in scan order. */
  *witnessedOutputs(ns: number, p: bigint): Generator<StoredOutput> {
    for (const row of this.#q.witnessed!.iterate({ ns, p })) yield this.#output(row as Record<string, unknown>);
  }
  output(ns: number, p: bigint, cm: bigint): StoredOutput | undefined {
    const row = this.#q.outputOf!.get({ ns, p, key: fieldToBytes(cm) }) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#output(row);
  }
  *nullifiers(ns: number, p: bigint): Generator<bigint> {
    for (const row of this.#q.nullifiers!.iterate({ ns, p })) yield field((row as { nf: unknown }).nf);
  }

  /** The path of a witnessed output at `ns`'s tip, which must be at `position`. */
  witness(ns: number, position: bigint, leaf: bigint): WitnessPath | undefined {
    const tip = this.tip(ns);
    if (tip.position !== position) throw new Error("the witnessed namespace has moved past the read position");
    const row = this.#q.witness!.get(ns, leaf) as { siblings: Uint8Array } | undefined;
    if (row === undefined) return undefined;
    const siblings = decodeSiblings(bytes(row.siblings)), right = Array.from({ length: NOTE_TREE_DEPTH }, (_, h) => ((leaf >> BigInt(h)) & 1n) === 1n);
    return { leaf, anchor: tip.noteRoot, ns, path: Object.freeze({ siblings: Object.freeze(siblings), right: Object.freeze(right) }) };
  }

  /** The facts C2.10.6 checks over the union of `entries`' rows; nothing stays written. */
  unionFacts(entries: readonly ImportEntry[]): UnionFacts {
    const m = "JOIN merging m ON x.ns = m.ns AND x.position <= m.upto";
    const any = (sql: string): boolean => this.#db.prepare(sql).get() !== undefined;
    return this.#atomic(() => {
      const put = this.#db.prepare("INSERT INTO merging VALUES (?, ?)");
      for (const entry of entries) put.run(entry.ns, entry.upto);
      try {
        const repeatedNullifier = any(`SELECT 1 FROM nullifier x ${m} GROUP BY x.nf HAVING count(*) > 1 LIMIT 1`);
        const repeatedOutput = any(`SELECT 1 FROM output x ${m} GROUP BY x.cm HAVING count(*) > 1 LIMIT 1`);
        const repeatedRecovery = any(`SELECT 1 FROM event x ${m} WHERE x.kind >= 4 GROUP BY x.identity HAVING count(*) > 1 LIMIT 1`);
        const shared = new Map<string, { ns: number; position: bigint; segment: string }[]>();
        for (const row of this.#db.prepare(`SELECT x.key, x.ns, x.position, n.segment FROM event_key x ${m} JOIN namespace n ON n.ns = x.ns
            WHERE x.key IN (SELECT y.key FROM event_key y JOIN merging w ON y.ns = w.ns AND y.position <= w.upto GROUP BY y.key HAVING count(*) > 1)
            ORDER BY x.key, x.ns, x.position`).iterate()) {
          const r = row as { key: string; ns: bigint; position: bigint; segment: Uint8Array };
          const list = shared.get(r.key) ?? [];
          list.push({ ns: Number(r.ns), position: BigInt(r.position), segment: hex(bytes(r.segment)) });
          shared.set(r.key, list);
        }
        const supply = new Map<string, Totals>();
        for (const row of this.#db.prepare(`SELECT x.backing, x.issued, x.burned FROM event x ${m} WHERE x.backing IS NOT NULL`).iterate()) {
          const r = row as { backing: Uint8Array; issued: string; burned: string }, name = hex(bytes(r.backing));
          const total = supply.get(name) ?? { issued: 0n, burned: 0n };
          supply.set(name, { issued: total.issued + BigInt(r.issued), burned: total.burned + BigInt(r.burned) });
        }
        return { repeatedNullifier, repeatedOutput, repeatedRecovery, shared, supply };
      } finally { this.#db.exec("DELETE FROM merging"); }
    });
  }

  // --- A read's walk (M5b.3b): verdicts, valid candidates, scopes, bases, publications -----
  //
  // One read's classification lives in rows under its walk id, so the walk holds
  // no verdict, scope or base in memory; the rows go when the read closes the walk.

  // A walk runs in one transaction: its rows and replays commit once, when it closes, rather than a
  // commit per row. A walk that overflows the page cache spills to the file, so memory stays bounded.
  // One walk at a time: a second open while one is open is the caller's error.
  openWalk(): number {
    if (this.#db.isTransaction) throw new Error("a walk or transaction is already open on this store");
    this.#db.exec("BEGIN");
    // No walk is open, so any walk rows are a crashed read's: they are no one's.
    for (const table of ["walk", ...WALK_TABLES]) this.#db.prepare(`DELETE FROM ${table}`).run();
    return Number((this.#db.prepare("INSERT INTO walk VALUES (NULL) RETURNING id").get() as { id: bigint }).id);
  }
  /** Drop the walk's rows and commit what its replays kept, refused read or not. If that fails, nothing
   * of the walk commits and the store is left without an open transaction. */
  closeWalk(walk: number): void {
    try {
      for (const table of WALK_TABLES) this.#db.prepare(`DELETE FROM ${table} WHERE walk = ?`).run(walk);
      this.#db.prepare("DELETE FROM walk WHERE id = ?").run(walk);
      if (this.#db.isTransaction) this.#db.exec("COMMIT");
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Rows held for walks still open: none once every read has closed its walk. */
  walkRows(): number {
    let rows = 0;
    for (const table of ["walk", ...WALK_TABLES]) rows += Number((this.#db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: bigint }).c);
    return rows;
  }

  putVerdict(walk: number, v: WalkVerdict): void {
    const s = v.state;
    this.#db.prepare("INSERT INTO walk_verdict VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(walk, v.key, v.operator,
      be(v.sequence), v.root, v.signature, be(v.index), v.class, v.detail ?? null, v.segment, v.snapshot, s?.ns ?? null, s?.position ?? null,
      s?.identity ?? null, s === undefined ? null : u64(s.issued), s === undefined ? null : u64(s.burned),
      s === undefined ? null : mapJson(s.adoption), s === undefined ? null : be(s.opening));
  }
  #verdict(row: Record<string, unknown>): WalkVerdict {
    const state = row["ns"] === null ? undefined : { ns: Number(row["ns"] as bigint), position: BigInt(row["position"] as bigint),
      identity: bytes(row["identity"]), issued: BigInt(row["issued"] as string), burned: BigInt(row["burned"] as string),
      adoption: jsonMap(row["adoption"]), opening: fromBe(row["opening"]) };
    return { key: bytes(row["key"]), operator: bytes(row["operator"]), sequence: fromBe(row["seq"]), root: bytes(row["root"]),
      signature: bytes(row["signature"]), index: fromBe(row["idx"]), class: row["class"] as WalkVerdict["class"],
      detail: row["detail"] === null ? undefined : row["detail"] as string, segment: bytes(row["segment"]), snapshot: bytes(row["snapshot"]), state };
  }
  verdict(walk: number, key: Uint8Array): WalkVerdict | undefined {
    const row = this.#db.prepare("SELECT * FROM walk_verdict WHERE walk = ? AND key = ?").get(walk, key) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#verdict(row);
  }
  /** Every verdict of the walk, by index, sequence, then operator and root bytes. */
  *verdicts(walk: number): Generator<WalkVerdict> {
    for (const row of this.#db.prepare("SELECT * FROM walk_verdict WHERE walk = ? ORDER BY idx, seq, operator, root").iterate(walk)) {
      yield this.#verdict(row as Record<string, unknown>);
    }
  }
  /** A valid carrying candidate of `backing` (hex) within its term, for the latest-valid reads. */
  putValid(walk: number, backing: Uint8Array, index: bigint, operator: Uint8Array, sequence: bigint, key: Uint8Array): void {
    this.#db.prepare("INSERT INTO walk_valid VALUES (?, ?, ?, ?, ?, ?)").run(walk, backing, be(index), be(sequence), operator, key);
  }
  /** The key of `backing`'s latest valid candidate strictly before an index, or before a held checkpoint in rank
   * order (at its index, only the same operator's lower sequences), or of all. */
  latestValid(walk: number, backing: Uint8Array,
    bound?: { readonly index: bigint; readonly strict: true } | { readonly index: bigint; readonly operator: Uint8Array; readonly sequence: bigint }): Uint8Array | undefined {
    const order = "ORDER BY idx DESC, seq DESC LIMIT 1", base = "SELECT key FROM walk_valid WHERE walk = ? AND backing = ?";
    const row = (bound === undefined ? this.#db.prepare(`${base} ${order}`).get(walk, backing) : "strict" in bound ?
      this.#db.prepare(`${base} AND idx < ? ${order}`).get(walk, backing, be(bound.index)) :
      this.#db.prepare(`${base} AND (idx < ? OR (idx = ? AND operator = ? AND seq < ?)) ${order}`)
        .get(walk, backing, be(bound.index), be(bound.index), bound.operator, be(bound.sequence))) as { key: unknown } | undefined;
    return row === undefined ? undefined : bytes(row.key);
  }

  /** A segment's authenticated header (i = -1) and scoped signed terms. */
  putScope(walk: number, segment: Uint8Array, header: Uint8Array, terms: readonly { readonly terms: Uint8Array; readonly signature: Uint8Array }[]): void {
    const put = this.#db.prepare("INSERT OR IGNORE INTO walk_scope VALUES (?, ?, ?, ?, ?)");
    put.run(walk, segment, -1, header, null);
    terms.forEach((signed, i) => put.run(walk, segment, i, signed.terms, signed.signature));
  }
  scope(walk: number, segment: Uint8Array): { header: Uint8Array; terms: { terms: Uint8Array; signature: Uint8Array }[] } | undefined {
    const rows = this.#db.prepare("SELECT i, bytes, signature FROM walk_scope WHERE walk = ? AND segment = ? ORDER BY i").all(walk, segment) as
      { i: bigint; bytes: unknown; signature: unknown }[];
    if (rows.length === 0) return undefined;
    return { header: bytes(rows[0]!.bytes), terms: rows.slice(1).map(r => ({ terms: bytes(r.bytes), signature: bytes(r.signature) })) };
  }

  putBase(walk: number, segment: Uint8Array, base: WalkBase): void {
    this.#db.prepare("INSERT INTO walk_base VALUES (?, ?, ?, ?, ?, ?)").run(walk, segment, be(base.openingIndex),
      JSON.stringify(base.parents.map(key => (key === undefined ? null : hex(key)))),
      JSON.stringify([...base.totals].map(([k, t]) => [k, t.issued.toString(), t.burned.toString()])), mapJson(base.adoption));
    const put = this.#db.prepare("INSERT INTO walk_import VALUES (?, ?, ?, ?, ?)");
    for (const [name, entry] of base.imports) put.run(walk, segment, unhex(name), entry.ns, entry.upto);
    const block = this.#db.prepare("INSERT INTO walk_block VALUES (?, ?, ?, ?, ?, ?, ?)");
    base.block.forEach((force, n) => block.run(walk, segment, n, unhex(force.backing), be(force.index), be(force.ordinal), force.bytes));
  }
  base(walk: number, segment: Uint8Array): WalkBase | undefined {
    const row = this.#db.prepare("SELECT * FROM walk_base WHERE walk = ? AND segment = ?").get(walk, segment) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    const imports = new Map<string, ImportEntry>();
    for (const r of this.#db.prepare("SELECT name, ns, upto FROM walk_import WHERE walk = ? AND segment = ? ORDER BY name").iterate(walk, segment)) {
      const i = r as { name: unknown; ns: bigint; upto: bigint };
      imports.set(hex(bytes(i.name)), { ns: Number(i.ns), upto: BigInt(i.upto) });
    }
    const block = (this.#db.prepare("SELECT backing, idx, ordinal, bytes FROM walk_block WHERE walk = ? AND segment = ? ORDER BY n").all(walk, segment) as
      Record<string, unknown>[]).map(b => ({ backing: hex(bytes(b["backing"])), index: fromBe(b["idx"]), ordinal: fromBe(b["ordinal"]), bytes: bytes(b["bytes"]) }));
    return { openingIndex: fromBe(row["opening"]), adoption: jsonMap(row["adoption"]),
      parents: (JSON.parse(row["parents"] as string) as (string | null)[]).map(key => (key === null ? undefined : unhex(key))),
      totals: new Map((JSON.parse(row["totals"] as string) as [string, string, string][]).map(([k, i, b]) => [k, { issued: BigInt(i), burned: BigInt(b) }])),
      imports, block };
  }

  putPublication(walk: number, backing: Uint8Array, p: WalkPublication, bytes: Uint8Array | undefined): void {
    this.#db.prepare("INSERT INTO walk_publication VALUES (?, ?, ?, ?, ?, ?, ?)").run(walk, backing, be(p.index), be(p.ordinal), p.force ? 1 : 0,
      p.check ?? null, bytes ?? null);
  }
  /** `backing`'s classified publications through `through`, in venue order. */
  *publicationVerdicts(walk: number, backing: Uint8Array, through: bigint): Generator<WalkPublication> {
    for (const row of this.#db.prepare("SELECT idx, ordinal, force, detail FROM walk_publication WHERE walk = ? AND backing = ? AND idx <= ? ORDER BY idx, ordinal")
      .iterate(walk, backing, be(through))) {
      const r = row as Record<string, unknown>;
      yield { index: fromBe(r["idx"]), ordinal: fromBe(r["ordinal"]), force: r["force"] === 1n, check: r["detail"] === null ? undefined : r["detail"] as string };
    }
  }
  /** `backing`'s forced publications in (after, through], or through `through` without `after`, in venue order. */
  *forced(walk: number, backing: Uint8Array, after: bigint | undefined, through: bigint): Generator<WalkForce> {
    if (after !== undefined && after >= through) return;
    const rows = after === undefined ?
      this.#db.prepare(`SELECT idx, ordinal, bytes FROM walk_publication WHERE walk = ? AND backing = ? AND force = 1
        AND idx <= ? ORDER BY idx, ordinal`).iterate(walk, backing, be(through)) :
      this.#db.prepare(`SELECT idx, ordinal, bytes FROM walk_publication WHERE walk = ? AND backing = ? AND force = 1
        AND idx > ? AND idx <= ? ORDER BY idx, ordinal`).iterate(walk, backing, be(after), be(through));
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      yield { backing: hex(backing), index: fromBe(r["idx"]), ordinal: fromBe(r["ordinal"]), bytes: bytes(r["bytes"]) };
    }
  }

  // --- The one write --------------------------------------------------------------------

  /** Write one judged record at the tip of `ns`, atomically. */
  append(ns: number, record: Append): Tip {
    return this.#atomic(() => {
      const row = this.#q.tip!.get(ns) as Record<string, unknown>;
      const position = BigInt(row["position"] as bigint) + 1n;
      let leaves = BigInt(row["leaves"] as bigint), noteRoot = field(row["note_root"]);
      const ommers = decodeOmmers(bytes(row["ommers"]));
      // Note tree: append each output, recording blocks completed on the way, then fold from the last leaf.
      if (record.outputs.length > 0) {
        const first = leaves, completed = new Map<string, bigint>(), born: { leaf: bigint; siblings: bigint[] }[] = [];
        let before: (bigint | undefined)[] = ommers;
        for (const output of record.outputs) {
          const leaf = leaves++;
          before = [...ommers];
          if (output.witness) born.push({ leaf, siblings: Array.from({ length: NOTE_TREE_DEPTH }, (_, h) =>
            ((leaf >> BigInt(h)) & 1n) === 1n ? before[h]! : EMPTY_NOTE_SUBTREE[h]!) });
          let node = output.cm, h = 0;
          completed.set(`0:${leaf}`, node);
          while (((leaf >> BigInt(h)) & 1n) === 1n) {
            node = noteNode(h, ommers[h]!, node); ommers[h] = undefined; h++;
            completed.set(`${h}:${leaf >> BigInt(h)}`, node);
          }
          ommers[h] = node;
          this.#q.insertOutput!.run(fieldToBytes(output.cm), ns, position, leaf, output.capsule ?? null, output.settlement ? 1 : 0);
        }
        const last = leaves - 1n, rightmost: bigint[] = [record.outputs.at(-1)!.cm];
        let node = rightmost[0]!;
        for (let h = 0; h < NOTE_TREE_DEPTH; h++) {
          node = ((last >> BigInt(h)) & 1n) === 1n ? noteNode(h, before[h]!, node) : noteNode(h, node, EMPTY_NOTE_SUBTREE[h]!);
          rightmost.push(node);
        }
        noteRoot = node;
        // A witness's sibling at height h changes when a leaf lands in the block beside it at h.
        const valueAt = (h: number, block: bigint): bigint => completed.get(`${h}:${block}`) ??
          (block === last >> BigInt(h) ? rightmost[h]! : (() => { throw new Error("witness block is neither complete nor rightmost"); })());
        const update = (leaf: bigint, siblings: bigint[]): void => {
          const levels = new Set<number>();
          for (let j = first > leaf ? first : leaf + 1n; j <= last; j++) levels.add(msb(leaf ^ j));
          for (const h of levels) siblings[h] = valueAt(h, (leaf >> BigInt(h)) ^ 1n);
        };
        for (const w of this.#q.witnesses!.all(ns)) {
          const r = w as { leaf: bigint; siblings: Uint8Array }, siblings = decodeSiblings(bytes(r.siblings));
          update(BigInt(r.leaf), siblings);
          this.#q.moveWitness!.run(encodeSiblings(siblings), ns, r.leaf);
        }
        for (const w of born) {
          update(w.leaf, w.siblings);
          this.#q.putWitness!.run(ns, w.leaf, fieldToBytes(record.outputs[Number(w.leaf - first)]!.cm), encodeSiblings(w.siblings));
        }
      }
      const spent = this.#spent(ns);
      for (const { nf, tag } of record.nullifiers) {
        spent.insert(fieldToBytes(nf));
        this.#q.insertNullifier!.run(fieldToBytes(nf), ns, position, fieldToBytes(tag));
      }
      spent.save();
      const spentRoot = spent.root();
      this.#q.insertAnchor!.run(fieldToBytes(noteRoot), ns, position);
      if (record.demand !== undefined) {
        const { id, value } = record.demand;
        this.#q.insertDemand!.run(id, ns, position, value.backing, u64(value.quantity), fieldToBytes(value.tags[0]!), fieldToBytes(value.tags[1]!),
          value.presenter, u64(value.deadline));
        for (const tag of value.tags) this.#q.insertDemandTag!.run(fieldToBytes(tag), id, ns);
      }
      if (record.ended !== undefined) this.#q.insertDemandEnd!.run(record.ended, ns, position);
      if (record.supply !== undefined) {
        const { backing, issued, burned } = record.supply, total = this.total(ns, position - 1n, backing);
        this.#q.insertTotal!.run(ns, unhex(backing), position, u64(total.issued + issued), u64(total.burned + burned));
      }
      const history = record.history(noteRoot, spentRoot);
      this.#q.insertEvent!.run(ns, position, record.identity, record.kind, record.index === undefined ? null : u64(record.index), record.proofHash,
        record.signatureHash, record.kind === 6 ? record.record : null, history, record.evidence, fieldToBytes(noteRoot), spentRoot, record.supply === undefined ? null : unhex(record.supply.backing),
        record.supply === undefined ? null : u64(record.supply.issued), record.supply === undefined ? null : u64(record.supply.burned));
      for (const key of new Set(record.keys)) this.#q.insertKey!.run(key, ns, position);
      this.#q.updateTip!.run(position, history, record.evidence, leaves, fieldToBytes(noteRoot), encodeOmmers(ommers), spent.top ?? null, spent.next, ns);
      return this.tip(ns);
    });
  }

  // --- The spent set's stored nodes (pool-spent C1.2.8–9) --------------------------------

  #spentNode(ns: number, id: bigint): SpentNode {
    const row = this.#q.spentGet!.get(ns, id) as Record<string, unknown>;
    return { key: bytes(row["key"]), bit: row["bit"] === null ? null : Number(row["bit"] as bigint), l: optional(row["l"]) ?? null,
      r: optional(row["r"]) ?? null, hash: bytes(row["hash"]) };
  }

  /** The namespace's spent set, updated in place along each insert's path. */
  #spent(ns: number) {
    const row = this.#q.tip!.get(ns) as Record<string, unknown>;
    const state = { top: optional(row["spent_top"]), next: BigInt(row["spent_next"] as bigint) };
    const get = (id: bigint): SpentNode => this.#spentNode(ns, id);
    const put = (id: bigint, node: SpentNode): void => { this.#q.spentPut!.run(ns, id, node.key, node.bit, node.l, node.r, node.hash); };
    const store = this;
    return {
      get top() { return state.top; },
      get next() { return state.next; },
      root: (): Uint8Array => (state.top === undefined ? EMPTY_SPENT : get(state.top).hash),
      insert(key: Uint8Array): void {
        const leafId = state.next++, hash = leafHash(key);
        put(leafId, { key, bit: null, l: null, r: null, hash });
        if (state.top === undefined) { state.top = leafId; return; }
        const path: { id: bigint; node: SpentNode; right: boolean }[] = [];
        let id = state.top, node = get(id);
        for (;;) {
          const bit = splitAt(node.key, key);
          if (node.bit === null || bit < node.bit) {
            if (bit === 256) throw new Error("nullifier already in the spent set");
            const branchId = state.next++, right = rightAt(key, bit);
            let h = right ? branchHash(bit, node.hash, hash) : branchHash(bit, hash, node.hash);
            put(branchId, { key: node.key, bit, l: right ? id : leafId, r: right ? leafId : id, hash: h });
            if (path.length === 0) state.top = branchId;
            let child = branchId;
            for (let i = path.length - 1; i >= 0; i--) {
              const { id: pid, node: parent, right: isRight } = path[i]!;
              const other = get(isRight ? parent.l! : parent.r!).hash;
              h = isRight ? branchHash(parent.bit!, other, h) : branchHash(parent.bit!, h, other);
              put(pid, { ...parent, l: isRight ? parent.l : child, r: isRight ? child : parent.r, hash: h });
              child = pid;
            }
            return;
          }
          const right = rightAt(key, node.bit);
          path.push({ id, node, right });
          id = right ? node.r! : node.l!;
          node = get(id);
        }
      },
      save(): void {
        store.#db.prepare("UPDATE namespace SET spent_top = ?, spent_next = ? WHERE ns = ?").run(state.top ?? null, state.next, ns);
      },
    };
  }
}

