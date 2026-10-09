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
//   outputs a replay chose to witness, each with the nullifier that spends it
//   and what the choosing predicate read of it. No note-tree interior node is kept.
// - A refused checkpoint rolls back a savepoint; nothing is copied to undo.
// - Classes, scopes, bases, publication verdicts and the venue answers they were read
//   from are kept across reads under one context (pool-v3 §§13.2, 14). A party's kept
//   file is reopened only where its digest, recorded at each keep point outside the
//   file, still matches.
// - An operator's journal hosts a store in its own database instead (store.ts):
//   its admission state is written inside the journal's command transactions, and
//   the journal owns the connection, its transactions and its durability. No walk
//   runs there: the journal's reads use a store of their own, and what a new
//   segment imports from a read is copied in (`copyFrontier`).
import { sha256 } from "@noble/hashes/sha2.js";
import { createHash, hash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { fileIdentity } from "../../file-identity.js";
import { V3_SPENT_EMPTY_CONTEXT, V3_SPENT_LEAF_CONTEXT as LEAF, V3_SPENT_NODE_CONTEXT as NODE } from "../../contexts.js";
import { bytesToField, fieldToBytes } from "../field.js";
import { EMPTY_NOTE_ROOT, EMPTY_NOTE_SUBTREE, NOTE_TREE_DEPTH, noteNode, type NotePath } from "../note-tree.js";
import type { HeldCommitment, RangeEntry } from "../../record-range.js";
import { EvidenceRefusal } from "./refusals.js";

export interface Totals { issued: bigint; burned: bigint }
/** A standing kind-4 demand, by its statement identity: its notice (C3.3), whose instant a wallet rebuilt from
 * its seed reads to derive the presenter key again. */
export interface Demand {
  readonly backing: Uint8Array;
  readonly quantity: bigint;
  readonly tags: readonly bigint[];
  readonly presenter: Uint8Array;
  readonly instant: bigint;
  readonly deadline: bigint;
  /** The input nullifiers in input order, where the construction's settlement consumes them without naming them
   * (lit-v1 §3); absent where the settlement names its own (pool-v3). */
  readonly nullifiers?: readonly bigint[];
}
/** A namespace's construction: its name, and whether it keeps a note tree with anchors and witnesses. */
export interface NamespaceConstruction { readonly name: string; readonly tree: boolean }
/** Pool-v3's namespaces: a note tree with anchors and witnesses. */
export const POOL_V3_NAMESPACE: NamespaceConstruction = Object.freeze({ name: "moe/pool/v3", tree: true });
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
/** What a witness predicate read of an output it chose, kept with the output's witness: the nullifier that spends
 * it, so a read leaves spent outputs out, and the predicate's own bytes, so a read need not scan the output again. */
export interface WitnessMark { readonly nf: bigint; readonly note: Uint8Array }
/** One output as a receiver scans it: its capsule, or for a settlement the event holding its record. */
export interface StoredOutput {
  readonly cm: bigint;
  readonly ns: number;
  readonly position: bigint;
  readonly leaf: bigint;
  readonly capsule: Uint8Array | undefined;
  readonly settlement: boolean;
}
/** A witnessed output with its kept mark. */
export interface WitnessedOutput extends StoredOutput { readonly mark: WitnessMark }
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
  readonly outputs: readonly { readonly cm: bigint; readonly capsule: Uint8Array | undefined; readonly settlement: boolean; readonly witness: WitnessMark | undefined }[];
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
const equal = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a.buffer, a.byteOffset, a.length).equals(b);
const bytes = (value: unknown): Uint8Array => new Uint8Array(value as Uint8Array);
const field = (value: unknown): bigint => bytesToField(bytes(value));
const U256 = 1n << 256n;
/** A nullifier, commitment or tag key: 32 big-endian bytes of a 256-bit value. A field element's bytes are its
 * `fieldToBytes` bytes, so a pool row is stored as before, and a construction whose keys are SHA-256 digests
 * (lit-v1 §2) is stored the same way. */
const keyBytes = (value: bigint): Uint8Array => {
  if (typeof value !== "bigint" || value < 0n || value >= U256) throw new TypeError("a stored key is a 256-bit value");
  return Uint8Array.from(Buffer.from(value.toString(16).padStart(64, "0"), "hex"));
};
/** A stored key's value; a row holding anything but 32 bytes there is damaged kept state (§14), discarded and read again. */
const key = (value: unknown): bigint => {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new KeptStateMismatch("a stored key is 32 bytes");
  return BigInt(`0x${hex(value)}`);
};
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
    tag0 BLOB NOT NULL, tag1 BLOB NOT NULL, presenter BLOB NOT NULL, instant TEXT NOT NULL, deadline TEXT NOT NULL, PRIMARY KEY(id, ns)) WITHOUT ROWID;
  CREATE INDEX demand_order ON demand(ns, position);
  CREATE TABLE demand_tag (tag BLOB, id TEXT, ns INTEGER, PRIMARY KEY(tag, id, ns)) WITHOUT ROWID;
  CREATE TABLE demand_end (id TEXT, ns INTEGER, position INTEGER NOT NULL, PRIMARY KEY(id, ns)) WITHOUT ROWID;
  CREATE TABLE demand_nullifier (id TEXT, ns INTEGER, i INTEGER, nf BLOB NOT NULL, PRIMARY KEY(id, ns, i)) WITHOUT ROWID;
  CREATE TABLE namespace_construction (ns INTEGER PRIMARY KEY, construction TEXT NOT NULL, tree INTEGER NOT NULL);
  CREATE TABLE total (ns INTEGER, backing BLOB, position INTEGER, issued TEXT NOT NULL, burned TEXT NOT NULL,
    PRIMARY KEY(ns, backing, position)) WITHOUT ROWID;
  CREATE TABLE spent (ns INTEGER, id INTEGER, key BLOB NOT NULL, bit INTEGER, l INTEGER, r INTEGER, hash BLOB NOT NULL,
    PRIMARY KEY(ns, id)) WITHOUT ROWID;
  CREATE TABLE witness (ns INTEGER, leaf INTEGER, cm BLOB NOT NULL, nf BLOB NOT NULL, note BLOB NOT NULL, siblings BLOB NOT NULL,
    PRIMARY KEY(ns, leaf)) WITHOUT ROWID;
  CREATE TABLE kept_context (id INTEGER PRIMARY KEY CHECK (id = 1), key BLOB NOT NULL);
  CREATE TABLE verdict (key BLOB PRIMARY KEY, operator BLOB NOT NULL, seq BLOB NOT NULL, root BLOB NOT NULL, signature BLOB NOT NULL,
    idx BLOB NOT NULL, class TEXT NOT NULL, detail TEXT, segment BLOB NOT NULL, snapshot BLOB NOT NULL, ns INTEGER, position INTEGER,
    identity BLOB, issued TEXT, burned TEXT, adoption TEXT, opening BLOB) WITHOUT ROWID;
  CREATE TABLE scope (segment BLOB, i INTEGER, bytes BLOB NOT NULL, signature BLOB, PRIMARY KEY(segment, i)) WITHOUT ROWID;
  CREATE TABLE base (segment BLOB PRIMARY KEY, opening BLOB NOT NULL, parents TEXT NOT NULL, totals TEXT NOT NULL,
    adoption TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE base_import (segment BLOB, name BLOB, ns INTEGER NOT NULL, upto INTEGER NOT NULL, PRIMARY KEY(segment, name)) WITHOUT ROWID;
  CREATE TABLE base_block (segment BLOB, n INTEGER, backing BLOB NOT NULL, idx BLOB NOT NULL, ordinal BLOB NOT NULL, bytes BLOB NOT NULL,
    PRIMARY KEY(segment, n)) WITHOUT ROWID;
  CREATE TABLE publication (backing BLOB, idx BLOB, ordinal BLOB, record_hash BLOB NOT NULL, force INTEGER NOT NULL, detail TEXT, bytes BLOB,
    PRIMARY KEY(backing, idx, ordinal)) WITHOUT ROWID;
  CREATE TABLE answer (kind INTEGER, subject BLOB, through BLOB NOT NULL, value BLOB, PRIMARY KEY(kind, subject)) WITHOUT ROWID;
  CREATE TABLE answer_held (operator BLOB, seq BLOB, idx BLOB NOT NULL, root BLOB NOT NULL, signature BLOB NOT NULL,
    PRIMARY KEY(operator, seq)) WITHOUT ROWID;
  CREATE INDEX answer_held_idx ON answer_held(operator, idx, seq);
  CREATE TABLE answer_replacement (backing BLOB, identity BLOB, idx BLOB NOT NULL, record BLOB NOT NULL, PRIMARY KEY(backing, identity)) WITHOUT ROWID;
  CREATE INDEX answer_replacement_order ON answer_replacement(backing, idx, record);
  CREATE TABLE answer_publication (backing BLOB, idx BLOB, ordinal BLOB, record BLOB NOT NULL, PRIMARY KEY(backing, idx, ordinal)) WITHOUT ROWID;
  CREATE UNIQUE INDEX answer_publication_position ON answer_publication(idx, ordinal);
  CREATE TABLE walk (id INTEGER PRIMARY KEY AUTOINCREMENT);
  CREATE TABLE walk_verdict (walk INTEGER, key BLOB, idx BLOB NOT NULL, seq BLOB NOT NULL, operator BLOB NOT NULL, root BLOB NOT NULL,
    PRIMARY KEY(walk, key)) WITHOUT ROWID;
  CREATE INDEX walk_verdict_order ON walk_verdict(walk, idx, seq, operator, root);
  CREATE TABLE walk_valid (walk INTEGER, backing BLOB, idx BLOB, seq BLOB, operator BLOB NOT NULL, key BLOB NOT NULL,
    PRIMARY KEY(walk, backing, idx, seq)) WITHOUT ROWID;
  CREATE TABLE walk_carry (walk INTEGER, backing BLOB, key BLOB, idx BLOB NOT NULL, seq BLOB NOT NULL, operator BLOB NOT NULL, root BLOB NOT NULL,
    PRIMARY KEY(walk, backing, key)) WITHOUT ROWID;
  CREATE INDEX walk_carry_order ON walk_carry(walk, backing, idx, seq, operator, root);
  CREATE TABLE walk_cursor (walk INTEGER, backing BLOB, term INTEGER NOT NULL, link BLOB NOT NULL, after BLOB, PRIMARY KEY(walk, backing)) WITHOUT ROWID;
  CREATE TABLE walk_clock (walk INTEGER, backing BLOB, opening BLOB, upto BLOB NOT NULL, boundary BLOB,
    PRIMARY KEY(walk, backing, opening)) WITHOUT ROWID;
  CREATE TABLE walk_progress (walk INTEGER, backing BLOB, idx BLOB NOT NULL, ordinal BLOB NOT NULL, PRIMARY KEY(walk, backing)) WITHOUT ROWID;
  CREATE TABLE kept_walk (selected BLOB PRIMARY KEY, walk INTEGER NOT NULL, through BLOB NOT NULL, evidence BLOB NOT NULL, mark BLOB NOT NULL)
    WITHOUT ROWID;`;
/** Rows one read keeps for itself: what it classified (a verdict it judged or reused), each backing's valid candidates,
 * how far it has classified each backing's checkpoints and publications, and each silence clock's running state. */
const WALK_TABLES = ["walk_verdict", "walk_valid", "walk_carry", "walk_cursor", "walk_clock", "walk_progress"];
/** Rows kept across reads (pool-v3 §14 kept classes and kept walk): each is a function of authenticated bytes and the
 * record before its index. A kept walk's own rows stay under its walk; forgetting it orphans them. */
const KEPT_TABLES = ["verdict", "scope", "base", "base_import", "base_block", "publication", "kept_walk",
  "answer", "answer_held", "answer_replacement", "answer_publication"];
/** Kept venue answers refer to no namespace, so collection keeps them. */
const ANSWER_TABLES = ["answer", "answer_held", "answer_replacement", "answer_publication"];
/** The kept file's layout: another layout's file is discarded rather than read. 6: a witness row holds an
 * incomplete right block as the empty subtree, which an earlier build would return as its path. 7: a kept walk.
 * 8: a witness row holds its output's mark. 9: a mark keeps its nullifier's tag. 10: a write-ahead log and page digest.
 * 11: a namespace's construction, and a demand's nullifiers where its construction names them (lit-v1). 12: a namespace's
 * demands in position order (lit-v1 §10's rebuild reads them). */
const SCHEMA_VERSION = 12;
/** Replayed records between keep points inside one read, by default. */
const KEEP_EVERY = 10_000;
/** Milliseconds of a read between keep points, whatever it replayed: a read stopped sooner than it replays `every`
 * records (a restarted journal's whole replay inside a client's idle bound) still keeps its progress (storage
 * decision item 6's "count or time", Next 4 (bb)). */
const KEEP_MS = 5_000;
/** Every table holding a namespace's rows. */
const NAMESPACE_TABLES = ["namespace", "import", "event", "event_key", "nullifier", "output", "anchor", "demand", "demand_tag", "demand_end",
  "demand_nullifier", "namespace_construction", "total", "spent", "witness"];

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
/** What names a kept walk (pool-v3 §14 kept walk): the backing a read selects, the retained evidence it reads from,
 * and the judging index it reads through. */
export interface KeptWalkKey {
  readonly selected: Uint8Array;
  /** The retained evidence's identity, its lineage mark at this read, and whether its lineage passes a kept mark. */
  readonly evidence: Uint8Array;
  readonly mark: Uint8Array;
  holds(mark: Uint8Array): boolean;
  readonly through: bigint;
}
/** An open walk, and whether it resumed a kept walk's rows. */
export interface OpenedWalk { readonly walk: number; readonly resumed: boolean }
/** A forced publication's inner record, by its backing (hex) and venue position. */
export interface WalkForce { readonly backing: string; readonly index: bigint; readonly ordinal: bigint; readonly bytes: Uint8Array }
/** A classified publication: forced, or not with the check that refused it (none where it was not a candidate). */
export interface WalkPublication { readonly index: bigint; readonly ordinal: bigint; readonly force: boolean; readonly check: string | undefined }
/** A kept file (pool-v3 §14): the state as last committed, vouched for by a digest the party keeps outside it. */
export interface KeptFile {
  /** Where the party keeps the file's SHA256, which only it writes. */
  readonly digest: string;
  /** Replayed records between keep points inside one read (a long first sync keeps its progress). */
  readonly every?: number | undefined;
}
/** Kept state that failed a check before reuse (§14): the read discards it and classifies again. */
export class KeptStateMismatch extends Error {
  constructor(what: string) { super(`kept state does not match: ${what}`); this.name = "KeptStateMismatch"; }
}
/** A store's file that another connection holds: the caller's error (its handles overlap), never damage to discard. */
export class FileInUse extends Error {
  /** Which file: `kept replay file` or `evidence file`. */
  readonly file: string;
  constructor(file: string) { super(`the ${file} is in use`); this.name = "FileInUse"; this.file = file; }
}
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

// The frontier: ommers[h] is the completed left subtree of height h waiting for its right sibling, present where bit h of the leaf count is 1;
// ommers[NOTE_TREE_DEPTH] is the whole tree once it holds all 2^32 leaves (pool-v2 §4). A row written before that slot existed reads it absent.
const encodeOmmers = (ommers: readonly (bigint | undefined)[]): Uint8Array => {
  const out = new Uint8Array(33 * (NOTE_TREE_DEPTH + 1));
  ommers.forEach((value, h) => { if (value !== undefined) { out[33 * h] = 1; out.set(fieldToBytes(value), 33 * h + 1); } });
  return out;
};
const decodeOmmers = (blob: Uint8Array): (bigint | undefined)[] => Array.from({ length: NOTE_TREE_DEPTH + 1 }, (_, h) =>
  blob.length < 33 * h + 33 || blob[33 * h] === 0 ? undefined : bytesToField(blob.subarray(33 * h + 1, 33 * h + 33)));
const encodeSiblings = (siblings: readonly bigint[]): Uint8Array => {
  const out = new Uint8Array(32 * NOTE_TREE_DEPTH);
  siblings.forEach((value, h) => out.set(fieldToBytes(value), 32 * h));
  return out;
};
const decodeSiblings = (blob: Uint8Array): bigint[] => Array.from({ length: NOTE_TREE_DEPTH }, (_, h) => bytesToField(blob.subarray(32 * h, 32 * h + 32)));
/** At each height h, the node of the block holding the next free leaf, folded from the frontier of `leaves` leaves:
 * the still-filling block's node wherever `leaves` is not a multiple of 2^h. */
const fillingNodes = (leaves: bigint, ommers: readonly (bigint | undefined)[]): bigint[] => {
  const nodes = [EMPTY_NOTE_SUBTREE[0]!];
  for (let k = 0; k < NOTE_TREE_DEPTH - 1; k++) nodes.push(((leaves >> BigInt(k)) & 1n) === 1n ?
    noteNode(k, ommers[k]!, nodes[k]!) : noteNode(k, nodes[k]!, EMPTY_NOTE_SUBTREE[k]!));
  return nodes;
};

/** Page hashes per group: a keep point rehashes the groups its changed pages fall in, not the whole list. */
const GROUP = 256;
/** A kept file's digest (pool-v3 §14's one SHA256 over the whole kept state): SHA256 over the page size, the page
 * count and each group's SHA256 of its pages' SHA256s, a short last page hashed as it lies. Opening hashes every page
 * of the closed file; a keep point hashes only the page images its write-ahead log committed (storage decision
 * M11b12), so recording the digest costs what the read changed, not the file's length. */
class PageDigest {
  readonly pageSize: number;
  #pages = Buffer.alloc(0);
  #groups = Buffer.alloc(0);
  #length = 0;
  constructor(pageSize: number) { this.pageSize = pageSize; }
  /** Every page of the closed file at `path`, read in pieces so memory stays flat. */
  static of(path: string, pageSize: number): PageDigest {
    const digest = new PageDigest(pageSize), size = pageSize, fd = openSync(path, "r");
    try {
      const length = fstatSync(fd).size, count = Math.ceil(length / size), page = Buffer.alloc(size * GROUP), groups = new Set<number>();
      digest.#reserve(count);
      for (let from = 0; from < count; from += GROUP) {
        const n = Math.min(GROUP, count - from), read = readSync(fd, page, 0, Math.min(n * size, length - from * size), from * size);
        for (let i = 0; i < n; i++) {
          hash("sha256", page.subarray(i * size, Math.min((i + 1) * size, read)), "buffer").copy(digest.#pages, 32 * (from + i));
        }
        groups.add(from / GROUP);
      }
      digest.#regroup(count, groups);
    } finally { closeSync(fd); }
    return digest;
  }
  /** The state a log's commit leaves: its page images over the pages known, at the page count it commits. */
  apply(log: CommittedLog): void {
    const count = log.count, known = this.#length;
    // SQLite writes every page a commit adds to the log, so a page past the known length that the log lacks is no state.
    // Checked before any hash changes, so a refused log leaves the digest as it was.
    for (let p = known; p < count; p++) if (!log.pages.has(p + 1)) throw new Error("the write-ahead log lacks a page its commit adds");
    this.#reserve(count);
    for (const [n, image] of log.pages) if (n >= 1 && n <= count) image.copy(this.#pages, 32 * (n - 1));
    this.#regroup(count, new Set([...log.pages.keys()].filter(n => n >= 1 && n <= count).map(n => Math.floor((n - 1) / GROUP))));
  }
  /** Room for `count` page hashes, grown by doubling, so a keep point copies no hash list that has room for its new pages. */
  #reserve(count: number): void {
    if (32 * count <= this.#pages.length) return;
    const grown = Buffer.alloc(Math.max(32 * count, 2 * this.#pages.length)); this.#pages.copy(grown); this.#pages = grown;
  }
  /** Group hashes at `count` pages, hashed again for the `groups` named and for a shorter file's last group. */
  #regroup(count: number, groups: Set<number>): void {
    // A shorter file drops its last group's tail: that group is hashed again.
    if (count < this.#length && count > 0) groups.add(Math.floor((count - 1) / GROUP));
    const groupHashes = Buffer.alloc(32 * Math.ceil(count / GROUP)), pages = this.#pages;
    this.#groups.copy(groupHashes, 0, 0, Math.min(this.#groups.length, groupHashes.length));
    for (const g of groups) {
      if (g * GROUP >= count) continue;
      createHash("sha256").update("v3-kept-page-group").update(pages.subarray(32 * g * GROUP, 32 * Math.min(count, (g + 1) * GROUP)))
        .digest().copy(groupHashes, 32 * g);
    }
    this.#groups = groupHashes; this.#length = count;
  }
  /** The digest, as the party records it. */
  root(): string {
    const frame = Buffer.alloc(16); frame.writeBigUInt64BE(BigInt(this.pageSize), 0); frame.writeBigUInt64BE(BigInt(this.#length), 8);
    return createHash("sha256").update("v3-kept-file").update(frame).update(this.#groups).digest("hex");
  }
}
/** What a write-ahead log commits: each page's last committed image, by its SHA256, and the page count after the
 * last commit. */
interface CommittedLog { readonly pages: ReadonlyMap<number, Buffer>; readonly count: number }
/** The committed frames of a write-ahead log, as SQLite's recovery reads them (its file format, §4): frames that carry
 * the header's salts and continue its checksum chain, through the last commit frame among them; later frames (a
 * transaction not committed, a torn write) are not state. Undefined where the log commits nothing at `pageSize`. */
function committedLog(wal: string, pageSize: number): CommittedLog | undefined {
  if (!existsSync(wal)) return undefined;
  const fd = openSync(wal, "r");
  try {
    const length = fstatSync(fd).size, header = Buffer.alloc(32);
    if (length < 32 || readSync(fd, header, 0, 32, 0) !== 32) return undefined;
    const magic = header.readUInt32BE(0), raw = header.readUInt32BE(8), size = raw === 1 ? 65536 : raw;
    if ((magic & 0xfffffffe) !== 0x377f0682 || size !== pageSize) return undefined;
    // The checksum reads 32-bit words in the byte order the magic number's low bit names (1: big-endian).
    const big = (magic & 1) === 1, sum = (bytes: Buffer, s: [number, number]): [number, number] => {
      let [s0, s1] = s;
      for (let i = 0; i < bytes.length; i += 8) {
        s0 = (s0 + (big ? bytes.readUInt32BE(i) : bytes.readUInt32LE(i)) + s1) >>> 0;
        s1 = (s1 + (big ? bytes.readUInt32BE(i + 4) : bytes.readUInt32LE(i + 4)) + s0) >>> 0;
      }
      return [s0, s1];
    };
    let chain = sum(header.subarray(0, 24), [0, 0]);
    if (chain[0] !== header.readUInt32BE(24) || chain[1] !== header.readUInt32BE(28)) return undefined;
    const salts = header.subarray(16, 24), frame = Buffer.alloc(24 + size);
    const committed = new Map<number, Buffer>(), pending = new Map<number, Buffer>();
    let count: number | undefined;
    for (let at = 32; at + 24 + size <= length; at += 24 + size) {
      if (readSync(fd, frame, 0, 24 + size, at) !== 24 + size || !frame.subarray(8, 16).equals(salts)) break;
      chain = sum(frame.subarray(24), sum(frame.subarray(0, 8), chain));
      if (chain[0] !== frame.readUInt32BE(16) || chain[1] !== frame.readUInt32BE(20)) break;
      const page = frame.readUInt32BE(0);
      if (page === 0) break;
      pending.set(page, hash("sha256", frame.subarray(24), "buffer"));
      const after = frame.readUInt32BE(4);
      if (after !== 0) { for (const [n, image] of pending) committed.set(n, image); pending.clear(); count = after; }
    }
    return count === undefined ? undefined : { pages: committed, count };
  } finally { closeSync(fd); }
}
/** A closed database file's page size from its header (SQLite's file format, §1.3.2), or undefined where it names none. */
function headerPageSize(path: string): number | undefined {
  const header = Buffer.alloc(18), fd = openSync(path, "r");
  try { if (readSync(fd, header, 0, 18, 0) !== 18) return undefined; } finally { closeSync(fd); }
  const raw = header.readUInt16BE(16), size = raw === 1 ? 65536 : raw;
  return size >= 512 && (size & (size - 1)) === 0 ? size : undefined;
}
/** The digest a closed kept file gives (§14's check on opening), or undefined where its header names no page size. */
export function keptFileDigest(path: string): string | undefined {
  const size = headerPageSize(path);
  return size === undefined ? undefined : vouched(path, PageDigest.of(path, size));
}
/** The digest file's text: the page digest and the kept file's identity (slice 13 M13e). §14 wants the digest in
 * storage only the reader writes; a directory copied whole carries both files, and the copy's other identity leaves
 * its kept state discarded and replayed. */
const vouched = (path: string, pages: PageDigest): string => `${pages.root()}\n${fileIdentity(path)}`;
/** Replace a small file durably: a crash leaves the old contents or the new, never a torn one. */
function replaceFile(path: string, text: string): void {
  const partial = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.partial`, fd = openSync(partial, "w");
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(partial, path);
}
/** Remove a kept file's files, in order. One another store still holds cannot be removed (Windows): the caller's error. */
function removeFiles(files: readonly string[]): void {
  try { for (const file of files) rmSync(file, { force: true }); } catch (error) {
    if (["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new FileInUse("kept replay file");
    throw error;
  }
}
/** The exclusive lock a kept file's one handle holds beside it (`<file>.lock`, as the directory's `lock.db`), from
 * before the file is judged until the store closes; the operating system releases it if the process dies. A second
 * handle, in this process or another, is refused rather than opening the file: its opening would move or drop a log
 * the first still writes, and two writers would record digests over each other's pages (Next 4 (bg)). */
function lockKept(path: string): DatabaseSync {
  const lock = new DatabaseSync(`${path}.lock`, { timeout: 0 });
  try { lock.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE"); } catch (error) {
    lock.close();
    if (error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message)) throw new FileInUse("kept replay file");
    throw error;
  }
  return lock;
}
/** Remove the files of a kept file no handle holds: its log, the file and its digest, and `also` (a marker of the
 * caller's). One another handle holds is left as it is (false). Its lock file stays: removed, a handle opening the
 * file meanwhile and one after would each hold a lock of their own. */
export function removeKeptFile(path: string, digest: string, also: readonly string[] = []): boolean {
  let lock: DatabaseSync;
  try { lock = lockKept(path); } catch (error) {
    if (error instanceof FileInUse) return false;
    throw error;
  }
  try { removeFiles([`${path}-wal`, `${path}-shm`, `${path}-journal`, path, digest, ...also]); } catch (error) {
    if (error instanceof FileInUse) return false;
    throw error;
  } finally { lock.close(); }
  return true;
}
/** A kept file's page digest where it may be reused (§14's digest check): opening it recovers what its write-ahead
 * log committed and drops what it did not, the log is moved into the file, and the closed file must then hash to the
 * digest last recorded, at this layout.
 *
 * A keep point records its digest before it moves its log into the file (`#recordDigest`). One stopped between its
 * commit and its digest leaves the file as the recorded digest names it, beside a log whose commit no digest vouches
 * for: that log is dropped, so the state is the one last vouched for and only that keep point's work is read again
 * (Next 4 (bb): the whole file was discarded and the history replayed). One stopped after its digest leaves a log
 * whose commit the digest names, and recovery moves it in. */
function keptFileHolds(path: string, digest: string): PageDigest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = headerPageSize(path), log = `${path}-wal`;
    // The file as it lies, where its log holds a commit: hashed once, and reused below once its log is dropped.
    let dropped: PageDigest | undefined;
    if (raw !== undefined && existsSync(digest) && committedLog(log, raw) !== undefined) {
      const lying = PageDigest.of(path, raw);
      if (readFileSync(digest, "utf8") === vouched(path, lying)) { removeFiles([log, `${path}-shm`]); dropped = lying; }
    }
    // A rollback journal beside the file is played into it as it opens (a kept file keeps none; one there is not its own).
    const journal = existsSync(`${path}-journal`), db = new DatabaseSync(path, { readBigInts: true });
    let version: bigint, moved: boolean;
    try {
      version = (db.prepare("PRAGMA user_version").get() as { user_version: bigint }).user_version;
      // The file alone must hold the state the digest is checked against: a log another connection keeps from being
      // moved in whole leaves the file in use.
      const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: bigint; log: bigint; checkpointed: bigint };
      moved = checkpoint.busy === 0n && checkpoint.log === checkpoint.checkpointed;
    } finally { db.close(); }
    if (!moved || (existsSync(`${path}-wal`) && statSync(`${path}-wal`).size !== 0)) throw new FileInUse("kept replay file");
    const size = headerPageSize(path);
    if (version !== BigInt(SCHEMA_VERSION) || size === undefined || !existsSync(digest)) return undefined;
    // With no log or rollback journal left, opening and checkpointing wrote nothing: a dropped log's file is the one just hashed.
    const pages = dropped !== undefined && !journal && dropped.pageSize === size ? dropped : PageDigest.of(path, size);
    return readFileSync(digest, "utf8") === vouched(path, pages) ? pages : undefined;
  } catch (error) {
    // Another store holding the file is the caller's error, never damage to discard.
    if (error instanceof FileInUse) throw error;
    if (error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message)) throw new FileInUse("kept replay file");
    return undefined;
  }
}

export class ReplayStore {
  readonly #db: DatabaseSync;
  readonly #q: Record<string, StatementSync>;
  readonly #kept: (KeptFile & { readonly path: string }) | undefined;
  /** A kept file's lock, held while the store is open (`lockKept`). */
  readonly #lock: DatabaseSync | undefined;
  readonly #hosted: boolean;
  #savepoints = 0;
  #replaying = false;
  #sinceKeep = 0;
  /** When the last keep point recorded its digest, or the store opened (`performance.now()`). */
  #keptAt = performance.now();
  /** The connection's count of changed rows when the file's digest was last recorded: a read that changed nothing
   * leaves the digest as it is. */
  #digestedAt: bigint | undefined;
  /** A kept file's page hashes as of its last recorded digest. */
  #pages: PageDigest | undefined;
  /** A resumed kept walk's mark for this read, moved at its close where the walk changed a row. */
  #keptMark: { readonly walk: number; readonly selected: Uint8Array; readonly mark: Uint8Array; readonly changes: bigint } | undefined;
  /** A keep point found another store holding or changing the file: the walk stops and closes without writing. */
  #lost = false;
  /** Counts the times rows this store held may have gone: a discard, a collection or a rolled-back walk. A savepoint's
   * rollback inside a walk does not count: nothing it wrote was known (`replayTrail` records a replay once it stands). */
  #generation = 0;
  /** The last frontier `witness` folded, by its namespace, leaf count and root: the paths of one tip share it. */
  #filling: { readonly key: string; readonly nodes: readonly bigint[] } | undefined;

  /** A private in-memory database by default: short reads and tests run the same code. A path with `kept`
   * is the party's kept state (§14): reopened only where the digest check passes, discarded otherwise, and
   * committed with a new digest at each keep point. A path without `kept` is a new file used once.
   *
   * A host's open connection (one that reads integers as BigInt) places the store in the host's database
   * instead: the host owns its transactions and durability, a write made while the host's transaction is
   * open joins it, and closing is the host's. The host's layout names this one: it has no version of its own.
   * A hosted store holds state only; a walk needs a store of its own. */
  constructor(source: string | DatabaseSync = ":memory:", kept?: KeptFile) {
    if (typeof source !== "string") {
      if (kept !== undefined) throw new TypeError("a hosted store is not a kept file");
      this.#db = source; this.#hosted = true;
      if (this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'namespace'").get() === undefined) this.#db.exec(SCHEMA);
    } else {
      const path = source;
      let held: PageDigest | undefined;
      if (kept !== undefined) {
        if (path === ":memory:" || typeof kept.digest !== "string" ||
          [path, `${path}-wal`, `${path}-shm`, `${path}-journal`, `${path}.lock`].includes(kept.digest)) {
          throw new TypeError("a kept store is a file with its own digest");
        }
        if (kept.every !== undefined && (!Number.isSafeInteger(kept.every) || kept.every < 1)) throw new TypeError("invalid keep interval");
        this.#kept = { ...kept, path };
        this.#lock = lockKept(path);
        try {
          held = keptFileHolds(path, kept.digest);
          // The log goes before the file: a log left beside a new file would be read into it.
          if (held === undefined) removeFiles([`${path}-wal`, `${path}-shm`, `${path}-journal`, path, kept.digest]);
        } catch (error) { this.#lock.close(); throw error; }
      }
      const reopened = kept !== undefined && existsSync(path);
      try { this.#db = new DatabaseSync(path, { readBigInts: true }); } catch (error) { this.#lock?.close(); throw error; }
      this.#hosted = false;
      try {
        // Temporary storage in files: a replay's savepoint journals the pages the walk's transaction already
        // changed, and in memory that journal grows with every record until the walk commits.
        // A kept file writes ahead into a log, which names the pages each keep point changed, and moves it into the file
        // only at keep points, so no page changes unnamed.
        const mode = (this.#db.prepare(`PRAGMA journal_mode=${kept === undefined ? "TRUNCATE" : "WAL"}`).get() as { journal_mode: string }).journal_mode;
        // SQLite keeps the old mode where it cannot keep a log (no shared memory): every later opening would then discard the file.
        if (kept !== undefined && mode !== "wal") throw new Error("the kept replay file cannot keep a write-ahead log here");
        this.#db.exec("PRAGMA synchronous=FULL; PRAGMA temp_store=FILE;");
        if (kept !== undefined) this.#db.exec("PRAGMA wal_autocheckpoint=0");
        if (!reopened) this.#db.exec(`${SCHEMA}; PRAGMA user_version = ${SCHEMA_VERSION};`);
        if (kept !== undefined) this.#pages = held ?? new PageDigest(Number((this.#db.prepare("PRAGMA page_size").get() as { page_size: bigint }).page_size));
      } catch (error) { if (this.#db.isOpen) this.#db.close(); this.#lock?.close(); throw error; }
    }
    // C2.10.6's union is a working set of one connection: it never changes the file, so a kept file's digest stands.
    this.#db.exec("CREATE TEMP TABLE IF NOT EXISTS merging (ns INTEGER PRIMARY KEY, upto INTEGER NOT NULL)");
    // A reopened kept file passed the digest check: its recorded digest is the file's until a row changes.
    if (this.#kept !== undefined && existsSync(this.#kept.digest)) this.#digestedAt = this.#changes();
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
      visibleEvent: `SELECT 1 FROM event x WHERE x.identity = :key AND ${v}`,
      statement: "SELECT 1 FROM event WHERE identity = ? AND ns = ? AND position <= ?",
      demand: `SELECT x.* FROM demand x WHERE x.id = :key AND ${v} AND NOT EXISTS (SELECT 1 FROM demand_end y WHERE y.id = x.id AND ${visible("y")})`,
      demandsWithTag: `SELECT x.* FROM demand_tag t JOIN demand x ON x.id = t.id AND x.ns = t.ns WHERE t.tag = :key AND ${v}
        AND NOT EXISTS (SELECT 1 FROM demand_end y WHERE y.id = x.id AND ${visible("y")})`,
      demands: `SELECT x.* FROM demand x WHERE ${v} AND NOT EXISTS (SELECT 1 FROM demand_end y WHERE y.id = x.id AND ${visible("y")}) ORDER BY x.ns, x.position`,
      presented: `SELECT x.* FROM demand x WHERE x.id = :key AND ${v}`,
      presentedWithTag: `SELECT x.* FROM demand_tag t JOIN demand x ON x.id = t.id AND x.ns = t.ns WHERE t.tag = :key AND ${v}`,
      demandEnd: `SELECT x.ns, x.position FROM demand_end x WHERE x.id = :key AND ${v}`,
      tagSpends: `SELECT x.ns, x.position FROM nullifier x WHERE x.tag = :key AND ${v} ORDER BY x.ns, x.position`,
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
      insertDemand: "INSERT INTO demand VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      insertDemandTag: "INSERT OR IGNORE INTO demand_tag VALUES (?, ?, ?)",
      insertDemandEnd: "INSERT INTO demand_end VALUES (?, ?, ?)",
      outputs: `SELECT x.* FROM output x WHERE ${v} ORDER BY x.ns, x.leaf`,
      ownOutputs: "SELECT * FROM output WHERE ns = ? AND leaf >= ? ORDER BY leaf",
      ownOutputsAll: "SELECT * FROM output WHERE ns = ? ORDER BY leaf",
      ownDemands: "SELECT id, position FROM demand WHERE ns = ? AND position > ? AND position <= ? ORDER BY position",
      ownDemandsThrough: "SELECT id, position FROM demand WHERE ns = ? AND position <= ? ORDER BY position",
      demandPast: "SELECT 1 FROM demand WHERE ns = ? AND position > ? LIMIT 1",
      // A namespace number holds no output or demand row before its namespace is made (lit-v1 §10 rebuilds those).
      heldRows: "SELECT 1 FROM output WHERE ns = ?1 UNION ALL SELECT 1 FROM demand WHERE ns = ?1 LIMIT 1",
      // Nor a demand identity a nullifier or end row before its demand stands (a settlement derives from its nullifiers).
      heldDemandRows: "SELECT 1 FROM demand_nullifier WHERE id = ?1 AND ns = ?2 UNION ALL SELECT 1 FROM demand_end WHERE id = ?1 AND ns = ?2 LIMIT 1",
      outputOf: `SELECT x.* FROM output x WHERE x.cm = :key AND ${v}`,
      construction: "SELECT construction, tree FROM namespace_construction WHERE ns = ?",
      insertConstruction: "INSERT INTO namespace_construction VALUES (?, ?, ?)",
      demandNullifiers: "SELECT nf FROM demand_nullifier WHERE id = ? AND ns = ? ORDER BY i",
      insertDemandNullifier: "INSERT INTO demand_nullifier VALUES (?, ?, ?, ?)",
      // Driven from the witness rows, so a read visits this predicate's outputs only, not every output in the store.
      unspentWitnessed: `SELECT x.*, w.nf AS mark_nf, w.note AS mark_note FROM witness w CROSS JOIN output x ON x.ns = w.ns AND x.leaf = w.leaf
        WHERE ${v} AND NOT EXISTS (SELECT 1 FROM nullifier y WHERE y.nf = w.nf AND ${visible("y")}) ORDER BY x.ns, x.leaf`,
      witnessed: `SELECT x.*, w.nf AS mark_nf, w.note AS mark_note FROM witness w CROSS JOIN output x ON x.ns = w.ns AND x.leaf = w.leaf
        WHERE ${v} ORDER BY x.ns, x.leaf`,
      consumedAt: "SELECT nf FROM nullifier WHERE ns = ? AND position = ? ORDER BY nf",
      marked: `SELECT 1 FROM witness w CROSS JOIN output x ON x.ns = w.ns AND x.leaf = w.leaf WHERE w.nf = :key AND ${v}`,
      nullifiers: `SELECT x.nf FROM nullifier x WHERE ${v} ORDER BY x.ns, x.position`,
      importedNullifiers: "SELECT nf FROM nullifier WHERE ns = ? AND position <= ?",
      spentGet: "SELECT key, bit, l, r, hash FROM spent WHERE ns = ? AND id = ?",
      spentPut: "INSERT OR REPLACE INTO spent VALUES (?, ?, ?, ?, ?, ?, ?)",
      witnessesIn: "SELECT leaf, siblings FROM witness WHERE ns = ? AND leaf >= ? AND leaf < ?",
      witness: "SELECT siblings FROM witness WHERE ns = ? AND leaf = ?",
      putWitness: "INSERT INTO witness VALUES (?, ?, ?, ?, ?, ?)",
      moveWitness: "UPDATE witness SET siblings = ? WHERE ns = ? AND leaf = ?",
    }).map(([name, sql]) => [name, this.#db.prepare(sql)]));
  }

  close(): void {
    if (!this.#hosted && this.#db.isOpen) this.#db.close();
    if (this.#lock?.isOpen === true) this.#lock.close();
  }

  /** Whether this store is a party's kept file. */
  get kept(): boolean { return this.#kept !== undefined; }

  /** Record the committed state's digest (a keep point's second half), then move the log into the file. The digest
   * is computed from the page images the log committed, so it is recorded before the file changes: a crash before it
   * leaves the file the old digest names and a log the next open drops, one after it a log recovery moves in
   * (`keptFileHolds`); either way only this keep point's work can be lost (Next 4 (bb)). */
  #recordDigest(): void {
    const changes = this.#changes(), path = this.#kept!.path;
    if (changes !== this.#digestedAt) {
      // The log holds what changed since the file was last moved in: every committed page image, since a log that was
      // not moved in at an earlier keep point (another connection kept it) is still there, its images already counted.
      const log = committedLog(`${path}-wal`, this.#pages!.pageSize);
      if (log !== undefined) this.#pages!.apply(log);
      replaceFile(this.#kept!.digest, vouched(path, this.#pages!));
      // A log another connection keeps from being moved in leaves the file in use; the digest already names its state.
      const checkpoint = this.#db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: bigint; log: bigint; checkpointed: bigint };
      if (checkpoint.busy !== 0n || checkpoint.log !== checkpoint.checkpointed) throw new FileInUse("kept replay file");
    }
    this.#digestedAt = changes; this.#sinceKeep = 0; this.#keptAt = performance.now();
  }
  /** Move a resumed kept walk's mark to this read's where the walk changed a row since it opened. */
  #moveMark(walk: number): void {
    const marked = this.#keptMark;
    if (marked === undefined || marked.walk !== walk || this.#changes() <= marked.changes) return;
    this.#db.prepare("UPDATE kept_walk SET mark = ? WHERE selected = ? AND walk = ?").run(marked.mark, marked.selected, walk);
    this.#keptMark = { ...marked, changes: this.#changes() };
  }
  /** Rows this connection has inserted, updated or deleted since it opened. */
  #changes(): bigint { return BigInt((this.#db.prepare("SELECT total_changes() AS c").get() as { c: bigint | number }).c); }
  /** A keep point inside a walk where one is due: only between checkpoints (no savepoint or replay open), once
   * `every` records have replayed since the last or a record has and `KEEP_MS` have passed, so a killed long read
   * keeps its progress. */
  keepPoint(): void {
    const kept = this.#kept;
    if (kept === undefined || this.#lost || this.#savepoints !== 0 || this.#replaying || !this.#db.isTransaction ||
        this.#sinceKeep === 0 || (this.#sinceKeep < (kept.every ?? KEEP_EVERY) && performance.now() - this.#keptAt < KEEP_MS)) return;
    // The walk takes its write lock again at once, as openWalk took it: while it awaits a verifier or a venue
    // after the keep point, another store's walk is refused, not free to take the walk rows as a crashed read's.
    // A store that wrote in the moment between is found by the file's data version, and this walk stops.
    // Read inside the transaction: this connection's own commit leaves the version as it is.
    const version = this.#dataVersion();
    // What a keep point commits was kept from this read's evidence too.
    if (this.#keptMark !== undefined) this.#moveMark(this.#keptMark.walk);
    this.#db.exec("COMMIT");
    try { this.#recordDigest(); } catch (error) {
      // Another connection kept the log from being moved in (it holds or changed the file), or the digest could not be
      // recorded: the walk stops as below, and what it writes after commits nothing.
      this.#lost = true;
      throw error;
    } finally {
      try { this.#db.exec("BEGIN IMMEDIATE"); } catch (error) {
        if (!(error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message))) throw error;
        // Writes still in flight go into a transaction closeWalk rolls back, never into the file.
        this.#lost = true; this.#db.exec("BEGIN");
      }
    }
    if (!this.#lost && this.#dataVersion() !== version) this.#lost = true;
    if (this.#lost) throw new FileInUse("kept replay file");
  }
  /** SQLite's count of commits other connections made to the file, as this connection sees it. */
  #dataVersion(): bigint {
    return BigInt((this.#db.prepare("PRAGMA data_version").get() as { data_version: bigint }).data_version);
  }
  /** Changes whenever rows this store held may have gone (a discard, a collection or a rolled-back walk), so what a
   * caller learned of its namespaces before is not carried past it (lit-v1 §10's known outputs). */
  get generation(): number { return this.#generation; }
  #rollback(): void {
    this.#generation++;
    if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
  }
  /** Forget every kept row (§14: kept state that fails a check is discarded); a kept file also drops its namespaces, and
   * every namespace row with them, a row under no namespace included. */
  discardKept(): void {
    if (this.#db.isTransaction || this.#replaying) throw new Error("a walk is open on this store");
    this.#generation++;
    this.#atomic(() => {
      for (const table of KEPT_TABLES) this.#db.prepare(`DELETE FROM ${table}`).run();
      this.#db.prepare("DELETE FROM kept_context").run();
      if (this.#kept !== undefined) for (const table of NAMESPACE_TABLES) this.#db.prepare(`DELETE FROM ${table}`).run();
    });
  }
  /** The kept note frontier of `ns` (leaf count and completed left subtrees), for §14's snapshot check. */
  frontier(ns: number): { readonly leaves: bigint; readonly ommers: readonly (bigint | undefined)[] } {
    const row = this.#q.tip!.get(ns) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error("unknown replay namespace");
    return { leaves: BigInt(row["leaves"] as bigint), ommers: decodeOmmers(bytes(row["ommers"])) };
  }
  /** The spent root of `ns` recomputed from its top node's stored children (C1.2.8–9), for §14's snapshot check. */
  spentRootFromChildren(ns: number): Uint8Array {
    const top = optional((this.#q.tip!.get(ns) as Record<string, unknown>)["spent_top"]);
    if (top === undefined) return EMPTY_SPENT;
    const node = this.#spentNode(ns, top);
    return node.bit === null ? leafHash(node.key) : branchHash(node.bit, this.#spentNode(ns, node.l!).hash, this.#spentNode(ns, node.r!).hash);
  }

  // --- Namespaces -------------------------------------------------------------------------

  /** A fresh namespace for `segment` under `identity`: the empty tree and anchor, the
   * imported frontier's rows by reference, its spent set built from them (C1.2.8), and
   * the totals it starts from. */
  open(segment: Uint8Array, identity: Uint8Array, imports: Imports | undefined, genesis: { history: Uint8Array; evidence: Uint8Array },
    construction: NamespaceConstruction = POOL_V3_NAMESPACE): number {
    // A scope holds backings of one construction (C1.2), so a segment imports only segments of its own.
    for (const entry of imports?.segments.values() ?? []) {
      const source = this.construction(entry.ns);
      if (source.name !== construction.name || source.tree !== construction.tree) throw new TypeError("an import is of another construction");
    }
    return this.#atomic(() => {
      const row = this.#q.insertNamespace!.get(segment, identity, genesis.history, genesis.evidence, fieldToBytes(EMPTY_NOTE_ROOT),
        encodeOmmers([]), EMPTY_SPENT) as { ns: bigint };
      const ns = Number(row.ns);
      if (this.#holdsRows(ns)) throw new KeptStateMismatch("a new namespace's number holds rows");
      this.#q.insertConstruction!.run(ns, construction.name, construction.tree ? 1 : 0);
      for (const [name, entry] of imports?.segments ?? []) this.#q.insertImport!.run(ns, unhex(name), entry.ns, entry.upto);
      if (construction.tree) this.#q.insertAnchor!.run(fieldToBytes(EMPTY_NOTE_ROOT), ns, 0n);
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

  hasNamespace(ns: number): boolean { return this.#q.tip!.get(ns) !== undefined; }

  /** The construction a namespace replays. */
  construction(ns: number): NamespaceConstruction {
    const row = this.#q.construction!.get(ns) as { construction: string; tree: bigint } | undefined;
    if (row === undefined) throw new Error("unknown replay namespace");
    return { name: row.construction, tree: row.tree === 1n };
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
      // SQLite may have rolled the whole transaction back itself (a full disk, an I/O error): then what was known goes too.
      if (this.#db.isTransaction) { this.#db.exec(`ROLLBACK TO ${name}`); this.#db.exec(`RELEASE ${name}`); } else this.#generation++;
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
      // SQLite may have rolled the whole transaction back itself (a full disk, an I/O error): then what was known goes too.
      if (this.#db.isTransaction) { this.#db.exec(`ROLLBACK TO ${name}`); this.#db.exec(`RELEASE ${name}`); } else this.#generation++;
      throw error;
    } finally { this.#savepoints--; }
  }

  /** Drop every namespace that neither `keep` nor anything they import reads. Kept classes, scopes, bases and
   * publication verdicts refer to namespaces, so dropping any also forgets them: a later read classifies again.
   * Kept venue answers refer to none and stay. */
  collect(keep: readonly number[]): void {
    if (this.#replaying) throw new Error("a replay is open on this store");
    const live = new Set<number>();
    for (const ns of keep) { live.add(ns); for (const entry of this.imports(ns).values()) live.add(entry.ns); }
    const dead = (this.#db.prepare("SELECT ns FROM namespace").all() as { ns: bigint }[]).map(r => Number(r.ns)).filter(ns => !live.has(ns));
    if (dead.length === 0) return;
    this.#generation++;
    this.#atomic(() => {
      for (const table of NAMESPACE_TABLES) {
        const drop = this.#db.prepare(`DELETE FROM ${table} WHERE ns = ?`);
        for (const ns of dead) drop.run(ns);
      }
      for (const table of KEPT_TABLES) if (!ANSWER_TABLES.includes(table)) this.#db.prepare(`DELETE FROM ${table}`).run();
    });
  }

  /**
   * Copy an imported frontier read in another store into this one, so a namespace opened here can import it
   * (an operator's new segment imports what its own read replayed). Each imported segment's rows through its
   * imported position are copied into a namespace kept under `identity(segment)`; a copy already here that
   * holds the same prefix, by its history hash at that position, is used instead. Only fact rows are copied:
   * an imported namespace is read at its position, never moved. Runs inside the caller's transaction.
   */
  copyFrontier(source: ReplayStore, frontier: Imports, identity: (segment: Uint8Array) => Uint8Array): Imports {
    if (source === this) return frontier;
    if (source.#db.isTransaction || source.#replaying) throw new Error("a walk is open on the imported store");
    const from = source.#db, segments = new Map<string, ImportEntry>();
    const facts = ["event", "event_key", "nullifier", "output", "anchor", "demand", "demand_end", "total"];
    // One read transaction on the source: every table is copied from the same committed state, whoever else holds the file.
    from.exec("BEGIN");
    try { this.#atomic(() => {
      for (const [name, entry] of frontier.segments) {
        const tip = source.tip(entry.ns), at = entry.upto === 0n ? undefined : source.event(entry.ns, entry.upto);
        if (hex(tip.segment) !== name || entry.upto > tip.position || (entry.upto > 0n && at === undefined)) throw new Error("an imported frontier names no replayed position");
        const name_ = identity(tip.segment);
        const held = this.namespaces(name_).find(ns => {
          const own = this.tip(ns);
          return equal(own.segment, tip.segment) && own.position >= entry.upto &&
            (entry.upto === 0n || equal(this.event(ns, entry.upto)!.history, at!.history));
        });
        if (held !== undefined) { segments.set(name, { ns: held, upto: entry.upto }); continue; }
        // The copy's tip is its imported position. Its other tip fields and structures are never read: an
        // imported namespace answers only from its fact rows.
        const ns = Number((this.#q.insertNamespace!.get(tip.segment, name_, at?.history ?? new Uint8Array(32), at?.evidence ?? new Uint8Array(32),
          fieldToBytes(at?.noteRoot ?? EMPTY_NOTE_ROOT), encodeOmmers([]), EMPTY_SPENT) as { ns: bigint }).ns);
        if (this.#holdsRows(ns)) throw new KeptStateMismatch("a new namespace's number holds rows");
        this.#db.prepare("UPDATE namespace SET position = ? WHERE ns = ?").run(entry.upto, ns);
        const construction = source.construction(entry.ns);
        this.#q.insertConstruction!.run(ns, construction.name, construction.tree ? 1 : 0);
        const copy = (table: string, rows: Iterable<unknown>): void => {
          let put: StatementSync | undefined;
          for (const item of rows) {
            const values = { ...(item as Record<string, unknown>), ns } as Record<string, Uint8Array | bigint | string | number | null>;
            put ??= this.#db.prepare(`INSERT INTO ${table} (${Object.keys(values).join(", ")}) VALUES (${Object.keys(values).map(() => "?").join(", ")})`);
            put.run(...Object.values(values));
          }
        };
        // A copied demand derives from its nullifier rows, so none may wait under its identity here (as `append` refuses).
        for (const row of from.prepare("SELECT id FROM demand WHERE ns = ? AND position <= ?").iterate(entry.ns, entry.upto)) {
          if (this.#q.heldDemandRows!.get((row as { id: string }).id, ns) !== undefined) throw new KeptStateMismatch("a demand's rows before it stands");
        }
        for (const table of facts) copy(table, from.prepare(`SELECT * FROM ${table} WHERE ns = ? AND position <= ?`).iterate(entry.ns, entry.upto));
        copy("demand_tag", from.prepare("SELECT t.* FROM demand_tag t JOIN demand d ON d.id = t.id AND d.ns = t.ns WHERE t.ns = ? AND d.position <= ?")
          .iterate(entry.ns, entry.upto));
        copy("demand_nullifier", from.prepare("SELECT t.* FROM demand_nullifier t JOIN demand d ON d.id = t.id AND d.ns = t.ns WHERE t.ns = ? AND d.position <= ?")
          .iterate(entry.ns, entry.upto));
        segments.set(name, { ns, upto: entry.upto });
      }
    }); } finally { from.exec("COMMIT"); }
    return { segments, totals: new Map(frontier.totals) };
  }

  /** Drop one namespace nothing else reads: no namespace imports it and no kept class or base names it
   * (a journal's retired admission state). Kept rows stay. */
  drop(ns: number): void {
    if (this.#replaying) throw new Error("a replay is open on this store");
    const read = (sql: string): boolean => this.#db.prepare(sql).get(ns) !== undefined;
    if (read("SELECT 1 FROM import WHERE source = ? LIMIT 1") || read("SELECT 1 FROM base_import WHERE ns = ? LIMIT 1") ||
        read("SELECT 1 FROM verdict WHERE ns = ? LIMIT 1")) throw new Error("the namespace is still read");
    this.#atomic(() => { for (const table of NAMESPACE_TABLES) this.#db.prepare(`DELETE FROM ${table} WHERE ns = ?`).run(ns); });
  }

  // --- Reads at (ns, p) -------------------------------------------------------------------

  #has(query: string, ns: number, p: bigint, key: Uint8Array | string): boolean {
    return this.#q[query]!.get({ ns, p, key }) !== undefined;
  }
  hasNullifier(ns: number, p: bigint, nf: bigint): boolean { return this.#has("nullifier", ns, p, keyBytes(nf)); }
  hasOutput(ns: number, p: bigint, cm: bigint): boolean { return this.#has("output", ns, p, keyBytes(cm)); }
  hasAnchor(ns: number, p: bigint, root: bigint): boolean { return this.#has("anchor", ns, p, fieldToBytes(root)); }
  hasSpentTag(ns: number, p: bigint, tag: bigint): boolean { return this.#has("spentTag", ns, p, keyBytes(tag)); }
  /** A recovery statement (kind 4–6) already effective in the visible history. */
  isEffective(ns: number, p: bigint, id: string): boolean { return this.#has("effective", ns, p, unhex(id)); }
  /** A statement of any kind in the visible history, imports included. */
  hasEvent(ns: number, p: bigint, identity: Uint8Array): boolean { return this.#has("visibleEvent", ns, p, identity); }
  /** A statement already in this segment's own history (imports are not statements of it). */
  hasStatement(ns: number, p: bigint, identity: Uint8Array): boolean { return this.#q.statement!.get(identity, ns, p) !== undefined; }
  /** A digest of every fact visible from (ns, p), imports included, whatever namespaces hold them: an audit
   * compares a stored state with a fresh replay of the same history by it. Linear in the state. */
  factDigest(ns: number, p: bigint): Uint8Array {
    const hash = createHash("sha256");
    const tables: [string, string[]][] = [["event", ["identity", "kind", "proof_hash", "signature_hash", "history", "evidence", "note_root", "spent_root"]],
      ["nullifier", ["nf", "tag"]], ["output", ["cm", "leaf", "settlement"]], ["anchor", ["root"]],
      ["demand", ["id", "backing", "quantity", "tag0", "tag1", "presenter", "instant", "deadline"]], ["demand_end", ["id"]],
      // A lit demand's nullifiers, visible with their demand: a settlement spends them (lit-v1 §7).
      ["demand_nullifier", ["id", "i", "nf"]]];
    for (const [table, columns] of tables) {
      hash.update(`${table}:`);
      const own = table === "demand_nullifier" ? "t" : "x", list = columns.map(column => `${own}.${column}`).join(", ");
      const from = own === "t" ? "demand_nullifier t JOIN demand x ON x.id = t.id AND x.ns = t.ns" : `${table} x`;
      for (const row of this.#db.prepare(`SELECT ${list} FROM ${from} WHERE ${visible("x")} ORDER BY ${list}`).iterate({ ns, p })) {
        for (const column of columns) {
          const value = (row as Record<string, unknown>)[column];
          const field = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
          hash.update(be(BigInt(field.length))); hash.update(field);
        }
      }
    }
    return new Uint8Array(hash.digest());
  }
  /** An issuance of `backing` (hex) among this segment's own records after position `after` through `p`. */
  hasIssuance(ns: number, p: bigint, after: bigint, backing: string): boolean {
    return this.#db.prepare("SELECT 1 FROM event WHERE ns = ? AND position > ? AND position <= ? AND kind = 1 AND backing = ? LIMIT 1")
      .get(ns, after, p, unhex(backing)) !== undefined;
  }

  #demand(row: Record<string, unknown>): [string, Demand] {
    const id = row["id"] as string;
    const nullifiers = this.#q.demandNullifiers!.all(id, row["ns"] as bigint).map(r => key((r as { nf: unknown }).nf));
    return [id, { backing: bytes(row["backing"]), quantity: BigInt(row["quantity"] as string),
      tags: [key(row["tag0"]), key(row["tag1"])], presenter: bytes(row["presenter"]), instant: BigInt(row["instant"] as string),
      deadline: BigInt(row["deadline"] as string), ...(nullifiers.length === 0 ? {} : { nullifiers }) }];
  }
  demand(ns: number, p: bigint, id: string): Demand | undefined {
    const row = this.#q.demand!.get({ ns, p, key: id }) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#demand(row)[1];
  }
  demandsWithTag(ns: number, p: bigint, tag: bigint): [string, Demand][] {
    return this.#q.demandsWithTag!.all({ ns, p, key: keyBytes(tag) }).map(row => this.#demand(row as Record<string, unknown>));
  }
  /** Every demand visible from (ns, p) naming `tag`, ended or not. */
  presentedWithTag(ns: number, p: bigint, tag: bigint): [string, Demand][] {
    return this.#q.presentedWithTag!.all({ ns, p, key: keyBytes(tag) }).map(row => this.#demand(row as Record<string, unknown>));
  }
  demands(ns: number, p: bigint): [string, Demand][] {
    return this.#q.demands!.all({ ns, p }).map(row => this.#demand(row as Record<string, unknown>));
  }
  /** A demand visible from (ns, p) whether or not it ended, with the event that stood it up and the one that ended it. */
  presented(ns: number, p: bigint, id: string): { readonly demand: Demand; readonly event: StoredEvent; readonly end: StoredEvent | undefined } | undefined {
    const row = this.#q.presented!.get({ ns, p, key: id }) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    const end = this.#q.demandEnd!.get({ ns, p, key: id }) as { ns: bigint; position: bigint } | undefined;
    return { demand: this.#demand(row)[1], event: this.event(Number(row["ns"] as bigint), BigInt(row["position"] as bigint))!,
      end: end === undefined ? undefined : this.event(Number(end.ns), BigInt(end.position))! };
  }
  /** The visible events that spent a nullifier of tag `tag`, in namespace and position order. */
  tagSpends(ns: number, p: bigint, tag: bigint): StoredEvent[] {
    return this.#q.tagSpends!.all({ ns, p, key: keyBytes(tag) }).map(row => {
      const { ns: at, position } = row as { ns: bigint; position: bigint };
      return this.event(Number(at), BigInt(position))!;
    });
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
    return { cm: key(row["cm"]), ns: Number(row["ns"] as bigint), position: BigInt(row["position"] as bigint), leaf: BigInt(row["leaf"] as bigint),
      capsule: row["capsule"] === null ? undefined : bytes(row["capsule"]), settlement: row["settlement"] === 1n };
  }
  /** A namespace's own outputs from leaf `from` on, or all of them, in leaf order (lit-v1 §10's rebuild reads them past
   * what it checked). A row whose position or leaf is not an integer is returned as undefined, which matches nothing. */
  *ownOutputs(ns: number, from?: bigint): Generator<StoredOutput | undefined> {
    const rows = from === undefined ? this.#q.ownOutputsAll!.iterate(ns) : this.#q.ownOutputs!.iterate(ns, from);
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      yield typeof r["position"] === "bigint" && typeof r["leaf"] === "bigint" ? this.#output(r) : undefined;
    }
  }
  /** A namespace's own demands stood up past position `after` (or from its first) through `through`, each identity with
   * its position, in position order (lit-v1 §10's rebuild reads them as it reads the outputs). A position stored as
   * something other than an integer is returned as undefined, which matches no record's. */
  *ownDemands(ns: number, after: bigint | undefined, through: bigint): Generator<{ readonly id: unknown; readonly position: bigint | undefined }> {
    const rows = after === undefined ? this.#q.ownDemandsThrough!.iterate(ns, through) : this.#q.ownDemands!.iterate(ns, after, through);
    for (const row of rows) {
      const r = row as { id: unknown; position: unknown };
      yield { id: r.id, position: typeof r.position === "bigint" ? r.position : undefined };
    }
  }
  /** Whether a namespace number holds an output or demand row: none may before its namespace is made. */
  #holdsRows(ns: number): boolean { return this.#q.heldRows!.get(ns) !== undefined; }
  /** Whether a namespace holds an own demand row past `position`. */
  demandPast(ns: number, position: bigint): boolean { return this.#q.demandPast!.get(ns, position) !== undefined; }
  /** Every visible output, in namespace then leaf order. */
  *outputs(ns: number, p: bigint): Generator<StoredOutput> {
    for (const row of this.#q.outputs!.iterate({ ns, p })) yield this.#output(row as Record<string, unknown>);
  }
  /** The visible outputs the replay kept a witness for whose kept nullifier is not visibly spent, in scan order. */
  *unspentWitnessed(ns: number, p: bigint): Generator<WitnessedOutput> {
    yield* this.#witnessed("unspentWitnessed", ns, p);
  }
  /** Every visible output the replay kept a witness for, spent or not, in scan order (lit-v1 §8's highest index). */
  *witnessed(ns: number, p: bigint): Generator<WitnessedOutput> {
    yield* this.#witnessed("witnessed", ns, p);
  }
  /** The nullifiers the record at (`ns`, `position`) inserted: the notes it consumed. */
  consumedAt(ns: number, position: bigint): bigint[] {
    return this.#q.consumedAt!.all(ns, position).map(row => key((row as { nf: unknown }).nf));
  }
  /** Whether a visible output the replay kept a witness for is spent by `nf`. */
  marked(ns: number, p: bigint, nf: bigint): boolean {
    return this.#q.marked!.get({ ns, p, key: keyBytes(nf) }) !== undefined;
  }
  *#witnessed(query: "unspentWitnessed" | "witnessed", ns: number, p: bigint): Generator<WitnessedOutput> {
    // A pool mark's nullifier is a field element; a construction without a note tree keys SHA-256 digests (lit-v1 §2).
    const trees = new Map<number, boolean>();
    for (const row of this.#q[query]!.iterate({ ns, p })) {
      const r = row as Record<string, unknown>, output = this.#output(r);
      let tree = trees.get(output.ns);
      if (tree === undefined) trees.set(output.ns, tree = this.construction(output.ns).tree);
      yield { ...output, mark: { nf: tree ? field(r["mark_nf"]) : key(r["mark_nf"]), note: bytes(r["mark_note"]) } };
    }
  }
  output(ns: number, p: bigint, cm: bigint): StoredOutput | undefined {
    const row = this.#q.outputOf!.get({ ns, p, key: keyBytes(cm) }) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#output(row);
  }
  *nullifiers(ns: number, p: bigint): Generator<bigint> {
    for (const row of this.#q.nullifiers!.iterate({ ns, p })) yield key((row as { nf: unknown }).nf);
  }

  /** The path of a witnessed output at `ns`'s tip, which must be at `position`. Witnesses are kept only at the
   * tip: a kept file whose namespace an earlier read moved past `position` cannot answer, so it is discarded
   * and the read replays (§14); within one read no path is read below a tip. */
  witness(ns: number, position: bigint, leaf: bigint): WitnessPath | undefined {
    const tip = this.tip(ns);
    if (tip.position !== position && this.#kept !== undefined) throw new KeptStateMismatch("a kept witness is past the read position");
    if (tip.position !== position) throw new Error("the witnessed namespace has moved past the read position");
    const row = this.#q.witness!.get(ns, leaf) as { siblings: Uint8Array } | undefined;
    if (row === undefined) return undefined;
    const siblings = decodeSiblings(bytes(row.siblings)), right = Array.from({ length: NOTE_TREE_DEPTH }, (_, h) => ((leaf >> BigInt(h)) & 1n) === 1n);
    // A right sibling is kept once its block completes; an empty block is the empty subtree, and the one block
    // still filling (where the path meets the last leaf's) is folded from the frontier.
    const leaves = tip.leaves, key = `${ns}:${leaves}:${tip.noteRoot}`;
    if (this.#filling?.key !== key) this.#filling = { key, nodes: fillingNodes(leaves, this.frontier(ns).ommers) };
    for (let h = 0; h < NOTE_TREE_DEPTH; h++) {
      if (right[h]) continue;
      const start = ((leaf >> BigInt(h)) + 1n) << BigInt(h);
      if (start >= leaves) siblings[h] = EMPTY_NOTE_SUBTREE[h]!;
      else if (start + (1n << BigInt(h)) > leaves) siblings[h] = this.#filling.nodes[h]!;
    }
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

  // --- A read's walk: verdicts, valid candidates, scopes, bases, publications ---------------
  //
  // A walk's classification lives in rows, so it holds no verdict, scope or base in memory. What a
  // class, scope, base or publication verdict is depends only on authenticated bytes and the record
  // before its index (C2.10.11), so those rows are kept across reads under one context (pool-v3 §14
  // kept classes): the configuration, venue, lag, verifier and witness predicate the reader names.
  // A walk keeps for itself what it classified, each backing's valid candidates, how far it has classified
  // each backing's checkpoints and publications, and each silence clock's running state, all bounded by its
  // own judging index. A temporary walk's rows go when it closes. A kept walk (§14 kept walk) stays for the
  // next read of the same selected backing from the same retained evidence at the same or a later judging
  // index, which resumes it and classifies only what is new.

  // A walk runs in one transaction: its rows and replays commit once, when it closes, or at a keep point.
  // A walk that overflows the page cache spills to the file, so memory stays bounded. One walk at a time:
  // a second open while one is open is the caller's error. Another context than the kept one discards the
  // kept rows, kept walks included: a store keeps one context.
  /** Open a walk. With `keep`, the kept walk of `keep.selected` is resumed where it was read from the same retained
   * evidence through no later index than `keep.through`, or one is begun where there is none or it was read from
   * other retained evidence; a kept walk read past `keep.through` stays as it is and this read's walk is temporary. */
  openWalk(context: Uint8Array, keep?: KeptWalkKey): OpenedWalk {
    // A walk holds its transaction across the reader's awaits, which a host's connection cannot.
    if (this.#hosted) throw new Error("a hosted store runs no walk");
    if (this.#db.isTransaction) throw new Error("a walk or transaction is already open on this store");
    // A read's time between keep points counts from its own start: one shorter than KEEP_MS commits only at its close.
    this.#lost = false; this.#keptMark = undefined; this.#keptAt = performance.now();
    // The write lock is taken with the transaction: a file another store is writing refuses here, with nothing open.
    try { this.#db.exec("BEGIN IMMEDIATE"); } catch (error) {
      if (error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message)) throw new FileInUse("kept replay file");
      throw error;
    }
    try {
      const kept = this.#db.prepare("SELECT key FROM kept_context WHERE id = 1").get() as { key: unknown } | undefined;
      if (kept === undefined || !equal(bytes(kept.key), context)) {
        for (const table of KEPT_TABLES) this.#db.prepare(`DELETE FROM ${table}`).run();
        // A kept file's namespaces were replayed under the old context and can never resume under this one.
        if (this.#kept !== undefined) for (const table of NAMESPACE_TABLES) this.#db.prepare(`DELETE FROM ${table}`).run();
        this.#db.prepare("INSERT OR REPLACE INTO kept_context VALUES (1, ?)").run(context);
      }
      let resumed: { walk: bigint; through: Uint8Array; evidence: Uint8Array; mark: Uint8Array } | undefined;
      if (keep !== undefined) {
        resumed = this.#db.prepare("SELECT walk, through, evidence, mark FROM kept_walk WHERE selected = ?").get(keep.selected) as typeof resumed;
        // Read from other retained evidence, or from this evidence restored to before the kept walk's last read: its
        // classes were grounded on evidence this read may not hold, so it is begun again (§14: a class is reused only
        // while its evidence is retained).
        if (resumed !== undefined && (!equal(bytes(resumed.evidence), keep.evidence) || !keep.holds(bytes(resumed.mark)))) {
          this.#db.prepare("DELETE FROM kept_walk WHERE selected = ?").run(keep.selected);
          resumed = undefined;
        }
      }
      // No walk is open, so the rows of any walk that is not kept are a crashed read's or a forgotten kept walk's.
      this.#db.prepare("DELETE FROM walk WHERE id NOT IN (SELECT walk FROM kept_walk)").run();
      for (const table of WALK_TABLES) this.#db.prepare(`DELETE FROM ${table} WHERE walk NOT IN (SELECT walk FROM kept_walk)`).run();
      if (keep !== undefined && resumed !== undefined) {
        // A kept walk read past this read's index keeps candidates this read must not see: this read's is temporary.
        if (fromBe(resumed.through) > keep.through) return { walk: this.#newWalk(), resumed: false };
        // Raised in the walk's transaction before any row it writes, so rows a refused or interrupted read kept stay
        // within the index the kept walk names.
        if (fromBe(resumed.through) < keep.through) this.#db.prepare("UPDATE kept_walk SET through = ? WHERE selected = ?").run(be(keep.through), keep.selected);
        this.#keptMark = { walk: Number(resumed.walk), selected: keep.selected, mark: keep.mark, changes: this.#changes() };
        return { walk: Number(resumed.walk), resumed: true };
      }
      const walk = this.#newWalk();
      if (keep !== undefined) this.#db.prepare("INSERT INTO kept_walk VALUES (?, ?, ?, ?, ?)").run(keep.selected, walk, be(keep.through), keep.evidence, keep.mark);
      this.#keptMark = undefined;
      return { walk, resumed: false };
    } catch (error) {
      // A walk that did not open leaves no transaction behind.
      this.#rollback();
      throw error;
    }
  }
  #newWalk(): number { return Number((this.#db.prepare("INSERT INTO walk VALUES (NULL) RETURNING id").get() as { id: bigint }).id); }
  /** Drop a temporary walk's own rows (a kept walk keeps them) and commit what it kept, refused read or not; a kept
   * file records its digest where a row changed (a keep point). If the commit fails, what the walk wrote since its
   * last keep point is rolled back and no transaction stays open. */
  closeWalk(walk: number): void {
    // A walk that lost its file at a keep point leaves it to the store that took it: nothing to drop or digest here.
    if (this.#lost) {
      this.#lost = false; this.#keptMark = undefined;
      this.#rollback();
      return;
    }
    try {
      // A resumed walk that kept anything kept it from this read's evidence: its mark moves to this read's, so a store
      // restored to before it no longer resumes the walk. A read that changed nothing leaves the mark, and the file.
      this.#moveMark(walk);
      this.#keptMark = undefined;
      if (this.#db.prepare("SELECT 1 FROM kept_walk WHERE walk = ?").get(walk) === undefined) {
        for (const table of WALK_TABLES) this.#db.prepare(`DELETE FROM ${table} WHERE walk = ?`).run(walk);
        this.#db.prepare("DELETE FROM walk WHERE id = ?").run(walk);
      }
      // A walk whose transaction SQLite already rolled back has nothing to commit, and what it knew goes with it.
      if (this.#db.isTransaction) this.#db.exec("COMMIT"); else this.#generation++;
    } catch (error) {
      this.#keptMark = undefined;
      this.#rollback();
      throw error;
    }
    if (this.#kept !== undefined) this.#recordDigest();
  }
  /** Mark every kept walk read from the retained evidence `evidence` with `mark`: a point its lineage reached after those
   * walks had read (a preparation beside the evidence's owner, whose batches stand at the owner's last row, marks its walk
   * once it has read, Next 4 (bg)), so the evidence restored to before it no longer resumes them. Outside a walk. */
  remark(evidence: Uint8Array, mark: Uint8Array): void {
    if (this.#db.isTransaction) throw new Error("a walk or transaction is open on this store");
    try { this.#db.exec("BEGIN IMMEDIATE"); } catch (error) {
      if (error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message)) throw new FileInUse("kept replay file");
      throw error;
    }
    try { this.#db.prepare("UPDATE kept_walk SET mark = ? WHERE evidence = ?").run(mark, evidence); this.#db.exec("COMMIT"); } catch (error) {
      this.#rollback();
      throw error;
    }
    if (this.#kept !== undefined) this.#recordDigest();
  }
  /** Rows held for walks still open, kept walks aside: none once every read has closed its walk. */
  walkRows(): number {
    let rows = 0;
    for (const table of ["walk", ...WALK_TABLES]) {
      const column = table === "walk" ? "id" : "walk";
      rows += Number((this.#db.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${column} NOT IN (SELECT walk FROM kept_walk)`).get() as { c: bigint }).c);
    }
    return rows;
  }
  /** How far a walk has classified `backing`'s held checkpoints: the term (its position in the chain and its link)
   * and the last sequence classified within it. */
  cursor(walk: number, backing: Uint8Array): { term: number; link: Uint8Array; after: bigint | undefined } | undefined {
    const row = this.#db.prepare("SELECT term, link, after FROM walk_cursor WHERE walk = ? AND backing = ?").get(walk, backing) as
      { term: bigint; link: unknown; after: unknown } | undefined;
    return row === undefined ? undefined : { term: Number(row.term), link: bytes(row.link), after: row.after === null ? undefined : fromBe(row.after) };
  }
  putCursor(walk: number, backing: Uint8Array, term: number, link: Uint8Array, after: bigint | undefined): void {
    this.#db.prepare("INSERT OR REPLACE INTO walk_cursor VALUES (?, ?, ?, ?, ?)").run(walk, backing, term, link, after === undefined ? null : be(after));
  }
  /** A silence clock's running state for `backing` from an opening index: read through `upto`, with its boundary if found. */
  clockState(walk: number, backing: Uint8Array, opening: bigint): { upto: bigint; boundary: bigint | undefined } | undefined {
    const row = this.#db.prepare("SELECT upto, boundary FROM walk_clock WHERE walk = ? AND backing = ? AND opening = ?").get(walk, backing, be(opening)) as
      { upto: unknown; boundary: unknown } | undefined;
    return row === undefined ? undefined : { upto: fromBe(row.upto), boundary: row.boundary === null ? undefined : fromBe(row.boundary) };
  }
  putClockState(walk: number, backing: Uint8Array, opening: bigint, upto: bigint, boundary: bigint | undefined): void {
    this.#db.prepare("INSERT OR REPLACE INTO walk_clock VALUES (?, ?, ?, ?, ?)").run(walk, backing, be(opening), be(upto), boundary === undefined ? null : be(boundary));
  }
  /** The venue position of the last of `backing`'s publications a walk classified. */
  progress(walk: number, backing: Uint8Array): { index: bigint; ordinal: bigint } | undefined {
    const row = this.#db.prepare("SELECT idx, ordinal FROM walk_progress WHERE walk = ? AND backing = ?").get(walk, backing) as
      { idx: unknown; ordinal: unknown } | undefined;
    return row === undefined ? undefined : { index: fromBe(row.idx), ordinal: fromBe(row.ordinal) };
  }
  putProgress(walk: number, backing: Uint8Array, index: bigint, ordinal: bigint): void {
    this.#db.prepare("INSERT OR REPLACE INTO walk_progress VALUES (?, ?, ?, ?)").run(walk, backing, be(index), be(ordinal));
  }
  /** Rows kept across reads. */
  keptRows(): number {
    let rows = 0;
    for (const table of KEPT_TABLES) rows += Number((this.#db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: bigint }).c);
    return rows;
  }

  /** Keep a class the walk judged, and count it as classified by the walk. */
  putVerdict(walk: number, v: WalkVerdict): void {
    const s = v.state;
    this.#db.prepare("INSERT OR REPLACE INTO verdict VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(v.key, v.operator,
      be(v.sequence), v.root, v.signature, be(v.index), v.class, v.detail ?? null, v.segment, v.snapshot, s?.ns ?? null, s?.position ?? null,
      s?.identity ?? null, s === undefined ? null : u64(s.issued), s === undefined ? null : u64(s.burned),
      s === undefined ? null : mapJson(s.adoption), s === undefined ? null : be(s.opening));
    this.touch(walk, v);
  }
  /** Count a kept class as classified by the walk (once). */
  touch(walk: number, v: Pick<WalkVerdict, "key" | "index" | "sequence" | "operator" | "root">): void {
    this.#db.prepare("INSERT OR IGNORE INTO walk_verdict VALUES (?, ?, ?, ?, ?, ?)").run(walk, v.key, be(v.index), be(v.sequence), v.operator, v.root);
  }
  #verdict(row: Record<string, unknown>): WalkVerdict {
    const state = row["ns"] === null ? undefined : { ns: Number(row["ns"] as bigint), position: BigInt(row["position"] as bigint),
      identity: bytes(row["identity"]), issued: BigInt(row["issued"] as string), burned: BigInt(row["burned"] as string),
      adoption: jsonMap(row["adoption"]), opening: fromBe(row["opening"]) };
    return { key: bytes(row["key"]), operator: bytes(row["operator"]), sequence: fromBe(row["seq"]), root: bytes(row["root"]),
      signature: bytes(row["signature"]), index: fromBe(row["idx"]), class: row["class"] as WalkVerdict["class"],
      detail: row["detail"] === null ? undefined : row["detail"] as string, segment: bytes(row["segment"]), snapshot: bytes(row["snapshot"]), state };
  }
  /** A class the walk classified. */
  verdict(walk: number, key: Uint8Array): WalkVerdict | undefined {
    const row = this.#db.prepare("SELECT v.* FROM walk_verdict w JOIN verdict v ON v.key = w.key WHERE w.walk = ? AND w.key = ?")
      .get(walk, key) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#verdict(row);
  }
  /** A kept class, whether or not this walk has classified it yet. */
  keptVerdict(key: Uint8Array): WalkVerdict | undefined {
    const row = this.#db.prepare("SELECT * FROM verdict WHERE key = ?").get(key) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.#verdict(row);
  }
  /** Tag a class the walk's cursor classified as one of `backing`'s carrying checkpoints within its terms. */
  carry(walk: number, backing: Uint8Array, key: Uint8Array, index: bigint, sequence: bigint, operator: Uint8Array, root: Uint8Array): void {
    this.#db.prepare("INSERT OR IGNORE INTO walk_carry VALUES (?, ?, ?, ?, ?, ?, ?)").run(walk, backing, key, be(index), be(sequence), operator, root);
  }
  /** `backing`'s tagged carrying checkpoints through index `t`, by index, sequence, then operator and root bytes. */
  *carried(walk: number, backing: Uint8Array, t: bigint): Generator<WalkVerdict> {
    for (const row of this.#db.prepare(`SELECT v.* FROM walk_carry c JOIN verdict v ON v.key = c.key WHERE c.walk = ? AND c.backing = ? AND c.idx <= ?
        ORDER BY c.idx, c.seq, c.operator, c.root`).iterate(walk, backing, be(t))) {
      yield this.#verdict(row as Record<string, unknown>);
    }
  }
  /** A valid carrying candidate of `backing` (hex) within its term, for the latest-valid reads. */
  putValid(walk: number, backing: Uint8Array, index: bigint, operator: Uint8Array, sequence: bigint, key: Uint8Array): void {
    this.#db.prepare("INSERT OR REPLACE INTO walk_valid VALUES (?, ?, ?, ?, ?, ?)").run(walk, backing, be(index), be(sequence), operator, key);
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
  putScope(segment: Uint8Array, header: Uint8Array, terms: readonly { readonly terms: Uint8Array; readonly signature: Uint8Array }[]): void {
    // This read's authenticated scope replaces a kept one.
    const put = this.#db.prepare("INSERT OR REPLACE INTO scope VALUES (?, ?, ?, ?)");
    put.run(segment, -1, header, null);
    terms.forEach((signed, i) => put.run(segment, i, signed.terms, signed.signature));
  }
  scope(segment: Uint8Array): { header: Uint8Array; terms: { terms: Uint8Array; signature: Uint8Array }[] } | undefined {
    const rows = this.#db.prepare("SELECT i, bytes, signature FROM scope WHERE segment = ? ORDER BY i").all(segment) as
      { i: bigint; bytes: unknown; signature: unknown }[];
    if (rows.length === 0) return undefined;
    return { header: bytes(rows[0]!.bytes), terms: rows.slice(1).map(r => ({ terms: bytes(r.bytes), signature: bytes(r.signature) })) };
  }

  putBase(segment: Uint8Array, base: WalkBase): void {
    this.#db.prepare("INSERT INTO base VALUES (?, ?, ?, ?, ?)").run(segment, be(base.openingIndex),
      JSON.stringify(base.parents.map(key => (key === undefined ? null : hex(key)))),
      JSON.stringify([...base.totals].map(([k, t]) => [k, t.issued.toString(), t.burned.toString()])), mapJson(base.adoption));
    const put = this.#db.prepare("INSERT INTO base_import VALUES (?, ?, ?, ?)");
    for (const [name, entry] of base.imports) put.run(segment, unhex(name), entry.ns, entry.upto);
    const block = this.#db.prepare("INSERT INTO base_block VALUES (?, ?, ?, ?, ?, ?)");
    base.block.forEach((force, n) => block.run(segment, n, unhex(force.backing), be(force.index), be(force.ordinal), force.bytes));
  }
  base(segment: Uint8Array): WalkBase | undefined {
    const row = this.#db.prepare("SELECT * FROM base WHERE segment = ?").get(segment) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    const imports = new Map<string, ImportEntry>();
    for (const r of this.#db.prepare("SELECT name, ns, upto FROM base_import WHERE segment = ? ORDER BY name").iterate(segment)) {
      const i = r as { name: unknown; ns: bigint; upto: bigint };
      imports.set(hex(bytes(i.name)), { ns: Number(i.ns), upto: BigInt(i.upto) });
    }
    const block = (this.#db.prepare("SELECT backing, idx, ordinal, bytes FROM base_block WHERE segment = ? ORDER BY n").all(segment) as
      Record<string, unknown>[]).map(b => ({ backing: hex(bytes(b["backing"])), index: fromBe(b["idx"]), ordinal: fromBe(b["ordinal"]), bytes: bytes(b["bytes"]) }));
    return { openingIndex: fromBe(row["opening"]), adoption: jsonMap(row["adoption"]),
      parents: (JSON.parse(row["parents"] as string) as (string | null)[]).map(key => (key === null ? undefined : unhex(key))),
      totals: new Map((JSON.parse(row["totals"] as string) as [string, string, string][]).map(([k, i, b]) => [k, { issued: BigInt(i), burned: BigInt(b) }])),
      imports, block };
  }

  /** Keep a classified publication, with the SHA256 of the venue's record at its position. */
  putPublication(backing: Uint8Array, p: WalkPublication, recordHash: Uint8Array, bytes: Uint8Array | undefined): void {
    this.#db.prepare("INSERT INTO publication VALUES (?, ?, ?, ?, ?, ?, ?)").run(backing, be(p.index), be(p.ordinal), recordHash, p.force ? 1 : 0,
      p.check ?? null, bytes ?? null);
  }
  /** The publication verdict kept at this position, with the SHA256 of the record it was classified from. */
  keptPublication(backing: Uint8Array, index: bigint, ordinal: bigint): { readonly recordHash: Uint8Array; readonly force: boolean; readonly check: string | undefined } | undefined {
    const row = this.#db.prepare("SELECT record_hash, force, detail FROM publication WHERE backing = ? AND idx = ? AND ordinal = ?")
      .get(backing, be(index), be(ordinal)) as { record_hash: unknown; force: unknown; detail: unknown } | undefined;
    return row === undefined ? undefined : { recordHash: bytes(row.record_hash), force: row.force === 1n, check: row.detail === null ? undefined : row.detail as string };
  }
  /** `backing`'s classified publications through `through`, in venue order. */
  *publicationVerdicts(backing: Uint8Array, through: bigint): Generator<WalkPublication> {
    for (const row of this.#db.prepare("SELECT idx, ordinal, force, detail FROM publication WHERE backing = ? AND idx <= ? ORDER BY idx, ordinal")
      .iterate(backing, be(through))) {
      const r = row as Record<string, unknown>;
      yield { index: fromBe(r["idx"]), ordinal: fromBe(r["ordinal"]), force: r["force"] === 1n, check: r["detail"] === null ? undefined : r["detail"] as string };
    }
  }
  /** `backing`'s forced publications in (after, through], or through `through` without `after`, in venue order. */
  *forced(backing: Uint8Array, after: bigint | undefined, through: bigint): Generator<WalkForce> {
    if (after !== undefined && after >= through) return;
    const rows = after === undefined ?
      this.#db.prepare(`SELECT idx, ordinal, bytes FROM publication WHERE backing = ? AND force = 1
        AND idx <= ? ORDER BY idx, ordinal`).iterate(backing, be(through)) :
      this.#db.prepare(`SELECT idx, ordinal, bytes FROM publication WHERE backing = ? AND force = 1
        AND idx > ? AND idx <= ? ORDER BY idx, ordinal`).iterate(backing, be(after), be(through));
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      yield { backing: hex(backing), index: fromBe(r["idx"]), ordinal: fromBe(r["ordinal"]), bytes: bytes(r["bytes"]) };
    }
  }

  // --- Kept venue answers (pool-v3 §13.2–13.3) ------------------------------------------
  //
  // A §13 answer the reader read from its own venue is kept for each kind and subject through the index it
  // was read to, and a later read extends it by windows after that index (§13.3's adjacent earlier answer).
  // Every query is bounded by the reading's own judging index, so a read at or below the kept index reads
  // exactly its own range. Kept answers are kept rows: under the file's digest, and dropped with the context.

  /** The kept answer of `kind` for `subject`: the index it is kept through, and its carried value (kind 1:
   * the highest sequence held through it; kind 3: the revocation's index, once found). */
  keptAnswer(kind: number, subject: Uint8Array): { readonly through: bigint; readonly value: bigint | undefined } | undefined {
    const row = this.#db.prepare("SELECT through, value FROM answer WHERE kind = ? AND subject = ?").get(kind, subject) as
      { through: unknown; value: unknown } | undefined;
    return row === undefined ? undefined : { through: fromBe(row.through), value: row.value === null ? undefined : fromBe(row.value) };
  }
  /** Kept answers stand only while the venue's finality rule does (§13.2): a view whose clock `at` is behind what
   * this state was read through is not the view it was read from, so every kept row is discarded and the read
   * asks the venue for everything. (One replaced at the same clock is believed, as any venue's answers are.) */
  discardKeptAfter(at: bigint): void {
    const seen = this.answersThrough();
    if (seen !== undefined && at < seen) this.discardKept();
  }
  /** The furthest index any kept answer was read through, if one is kept: the venue clock this state has seen. */
  answersThrough(): bigint | undefined {
    const row = this.#db.prepare("SELECT max(through) AS through FROM answer").get() as { through: unknown } | undefined;
    return row === undefined || row.through === null ? undefined : fromBe(row.through);
  }
  /** Extend (or start) a kept answer: `read` writes its windows and returns what it now holds through. An
   * answer whose read throws keeps none of its windows. */
  keepAnswer(kind: number, subject: Uint8Array, read: () => { readonly through: bigint; readonly value: bigint | undefined }): void {
    this.#atomic(() => {
      const held = read();
      this.#db.prepare("INSERT OR REPLACE INTO answer VALUES (?, ?, ?, ?)").run(kind, subject, be(held.through),
        held.value === undefined ? null : be(held.value));
    });
  }
  putHeld(operator: Uint8Array, held: readonly HeldCommitment[]): void {
    const put = this.#db.prepare("INSERT INTO answer_held VALUES (?, ?, ?, ?, ?)");
    for (const { index, commitment } of held) put.run(operator, be(commitment.sequence), be(index), commitment.root, commitment.signature);
  }
  /** An admitted replacement, kept at its first witnessing only (§13.3). */
  putReplacement(backing: Uint8Array, identity: Uint8Array, index: bigint, record: Uint8Array): void {
    this.#db.prepare("INSERT OR IGNORE INTO answer_replacement VALUES (?, ?, ?, ?)").run(backing, identity, be(index), record);
  }
  putPublications(backing: Uint8Array, entries: readonly RangeEntry[]): void {
    // One venue position answered for two subjects cannot be both (§13.1): a kept row at the position leaves the read
    // unresolved. Each answer is extended once past its kept index, so a same-subject repeat does not arise.
    const put = this.#db.prepare("INSERT INTO answer_publication VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING");
    for (const { index, ordinal, record } of entries) {
      if (Number(put.run(backing, be(index), be(ordinal), record).changes) === 0) throw new EvidenceRefusal("unresolved-evidence");
    }
  }
  #held(operator: Uint8Array, row: Record<string, unknown> | undefined): HeldCommitment | undefined {
    return row === undefined ? undefined : Object.freeze({ index: fromBe(row["idx"]), commitment: Object.freeze({ sequence: fromBe(row["seq"]),
      root: bytes(row["root"]), operator: new Uint8Array(operator), signature: bytes(row["signature"]) }) });
  }
  #heldRow(sql: string, ...values: (Uint8Array | bigint)[]): Record<string, unknown> | undefined {
    return this.#db.prepare(`SELECT seq, idx, root, signature FROM answer_held WHERE ${sql}`).get(...values) as Record<string, unknown> | undefined;
  }
  /** The kept held commitment of `operator` at `sequence`, witnessed by `t`. */
  heldAt(operator: Uint8Array, sequence: bigint, t: bigint): HeldCommitment | undefined {
    return this.#held(operator, this.#heldRow("operator = ? AND seq = ? AND idx <= ?", operator, be(sequence), be(t)));
  }
  heldAbove(operator: Uint8Array, sequence: bigint, t: bigint): boolean {
    return this.#heldRow("operator = ? AND seq > ? AND idx <= ? LIMIT 1", operator, be(sequence), be(t)) !== undefined;
  }
  /** The first kept held commitment of `operator` in [fromIndex, t] whose sequence exceeds `after`, if given.
   * Index and sequence rise together (C2.3.3), so `after` at or past `fromIndex` bounds both. */
  nextHeld(operator: Uint8Array, fromIndex: bigint, after: bigint | undefined, t: bigint): HeldCommitment | undefined {
    const held = this.#held(operator, after === undefined ?
      this.#heldRow("operator = ? AND idx >= ? AND idx <= ? ORDER BY idx, seq LIMIT 1", operator, be(fromIndex), be(t)) :
      this.#heldRow("operator = ? AND seq > ? AND idx <= ? ORDER BY seq LIMIT 1", operator, be(after), be(t)));
    return held === undefined || held.index >= fromIndex ? held : this.nextHeld(operator, fromIndex, undefined, t);
  }
  /** The last kept held commitment of `operator` at or below `toIndex` (and `t`) whose sequence is below `before`, if given. */
  previousHeld(operator: Uint8Array, toIndex: bigint, before: bigint | undefined, t: bigint): HeldCommitment | undefined {
    const bound = be(toIndex < t ? toIndex : t);
    return this.#held(operator, before === undefined ?
      this.#heldRow("operator = ? AND idx <= ? ORDER BY idx DESC, seq DESC LIMIT 1", operator, bound) :
      this.#heldRow("operator = ? AND seq < ? AND idx <= ? ORDER BY seq DESC LIMIT 1", operator, be(before), bound));
  }
  /** How many kept held commitments of `operator` lie in [from, to], below sequence `before` if given. */
  heldCount(operator: Uint8Array, from: bigint, to: bigint, before?: bigint): number {
    if (from > to) return 0;
    const row = (before === undefined ?
      this.#db.prepare("SELECT count(*) AS c FROM answer_held WHERE operator = ? AND idx >= ? AND idx <= ?").get(operator, be(from), be(to)) :
      this.#db.prepare("SELECT count(*) AS c FROM answer_held WHERE operator = ? AND idx >= ? AND idx <= ? AND seq < ?").get(operator, be(from), be(to), be(before))) as
      { c: bigint | number };
    return Number(row.c);
  }
  /** The least index of a kept held commitment of `operator` in [from, to]. */
  firstHeldIndex(operator: Uint8Array, from: bigint, to: bigint): bigint | undefined {
    if (from > to) return undefined;
    const row = this.#db.prepare("SELECT idx FROM answer_held WHERE operator = ? AND idx >= ? AND idx <= ? ORDER BY idx LIMIT 1")
      .get(operator, be(from), be(to)) as { idx: unknown } | undefined;
    return row === undefined ? undefined : fromBe(row.idx);
  }
  /** `backing`'s kept admitted replacements witnessed by `t`, in answer order (index, then record bytes). */
  replacements(backing: Uint8Array, t: bigint): RangeEntry[] {
    return this.#db.prepare("SELECT idx, record FROM answer_replacement WHERE backing = ? AND idx <= ? ORDER BY idx, record").all(backing, be(t))
      .map(row => { const r = row as { idx: unknown; record: unknown }; return Object.freeze({ index: fromBe(r.idx), ordinal: 0n, record: bytes(r.record) }); });
  }
  /** `backing`'s kept publication after `after` in venue order (or the first), witnessed by `t`. */
  nextPublication(backing: Uint8Array, after: Pick<RangeEntry, "index" | "ordinal"> | undefined, t: bigint): RangeEntry | undefined {
    const row = (after === undefined ?
      this.#db.prepare("SELECT idx, ordinal, record FROM answer_publication WHERE backing = ? AND idx <= ? ORDER BY idx, ordinal LIMIT 1").get(backing, be(t)) :
      this.#db.prepare(`SELECT idx, ordinal, record FROM answer_publication WHERE backing = ? AND (idx > ? OR (idx = ? AND ordinal > ?)) AND idx <= ?
        ORDER BY idx, ordinal LIMIT 1`).get(backing, be(after.index), be(after.index), be(after.ordinal), be(t))) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : Object.freeze({ index: fromBe(row["idx"]), ordinal: fromBe(row["ordinal"]), record: bytes(row["record"]) });
  }
  publicationCount(backing: Uint8Array, t: bigint): number {
    return Number((this.#db.prepare("SELECT count(*) AS c FROM answer_publication WHERE backing = ? AND idx <= ?").get(backing, be(t)) as { c: bigint }).c);
  }

  // --- The one write --------------------------------------------------------------------

  /** Write one judged record at the tip of `ns`, atomically. */
  append(ns: number, record: Append): Tip {
    this.#sinceKeep++;
    return this.#atomic(() => {
      const row = this.#q.tip!.get(ns) as Record<string, unknown>;
      const position = BigInt(row["position"] as bigint) + 1n;
      let leaves = BigInt(row["leaves"] as bigint), noteRoot = field(row["note_root"]);
      const ommers = decodeOmmers(bytes(row["ommers"]));
      const { tree } = this.construction(ns);
      // A construction without a note tree (lit-v1 §5) numbers its outputs in scan order and keeps no root. A
      // witnessed output keeps its mark with no path: a lit note is spent by its opening, not by membership.
      if (!tree) {
        for (const output of record.outputs) {
          const leaf = leaves++;
          this.#q.insertOutput!.run(keyBytes(output.cm), ns, position, leaf, output.capsule ?? null, output.settlement ? 1 : 0);
          if (output.witness !== undefined) {
            this.#q.putWitness!.run(ns, leaf, keyBytes(output.cm), keyBytes(output.witness.nf), output.witness.note, new Uint8Array(0));
          }
        }
      // Note tree: append each output, recording blocks completed on the way, then fold from the last leaf.
      } else if (record.outputs.length > 0) {
        const first = leaves, completed = new Map<string, bigint>(), born: { leaf: bigint; siblings: bigint[] }[] = [];
        let before: (bigint | undefined)[] = ommers;
        for (const output of record.outputs) {
          const leaf = leaves++;
          before = [...ommers];
          if (output.witness !== undefined) born.push({ leaf, siblings: Array.from({ length: NOTE_TREE_DEPTH }, (_, h) =>
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
        // A witness row holds the siblings that no longer change: the left ones from its birth, and a right one
        // once the block beside it completes; `witness` takes a still-filling right block from the frontier.
        // Only the witnesses beside a block completed here are rewritten, each at most once per height over its
        // life (31 times), so the work per record does not grow with the outputs ever witnessed on average; a
        // record completing a block of height h rewrites the witnesses among the 2^h leaves left of it.
        for (const w of born) {
          const output = record.outputs[Number(w.leaf - first)]!;
          this.#q.putWitness!.run(ns, w.leaf, fieldToBytes(output.cm), fieldToBytes(output.witness!.nf), output.witness!.note, encodeSiblings(w.siblings));
        }
        const moved = new Map<bigint, bigint[]>();
        for (const [key, value] of completed) {
          const [h, block] = key.split(":").map(BigInt) as [bigint, bigint];
          if (h >= BigInt(NOTE_TREE_DEPTH) || (block & 1n) === 0n) continue;
          for (const w of this.#q.witnessesIn!.iterate(ns, (block - 1n) << h, block << h)) {
            const r = w as { leaf: bigint; siblings: Uint8Array }, leaf = BigInt(r.leaf);
            const siblings = moved.get(leaf) ?? decodeSiblings(bytes(r.siblings));
            siblings[Number(h)] = value;
            moved.set(leaf, siblings);
          }
        }
        for (const [leaf, siblings] of moved) this.#q.moveWitness!.run(encodeSiblings(siblings), ns, leaf);
      }
      const spent = this.#spent(ns);
      for (const { nf, tag } of record.nullifiers) {
        spent.insert(keyBytes(nf));
        this.#q.insertNullifier!.run(keyBytes(nf), ns, position, keyBytes(tag));
      }
      spent.save();
      const spentRoot = spent.root();
      if (tree) this.#q.insertAnchor!.run(fieldToBytes(noteRoot), ns, position);
      if (record.demand !== undefined) {
        const { id, value } = record.demand;
        if (this.#q.heldDemandRows!.get(id, ns) !== undefined) throw new KeptStateMismatch("a demand's rows before it stands");
        this.#q.insertDemand!.run(id, ns, position, value.backing, u64(value.quantity), keyBytes(value.tags[0]!), keyBytes(value.tags[1]!),
          value.presenter, u64(value.instant), u64(value.deadline));
        for (const tag of value.tags) this.#q.insertDemandTag!.run(keyBytes(tag), id, ns);
        value.nullifiers?.forEach((nf, i) => this.#q.insertDemandNullifier!.run(id, ns, i, keyBytes(nf)));
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

