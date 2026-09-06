// A segment's state: finalized import, admission against one committed
// view, the ordered history, the directory, and replay (pool-v2 §§8–10;
// Construction §C1.2; C2.10.5–7).
//
// A segment holds what a stranger can recompute from its header and the
// evidence for its openings: the deduplicated closure of imported events,
// the accepted-root forest, the combined spent set and output set, the
// per-backing totals, its own local note tree, the accepted local statements
// in order and the history hash that binds them. It admits a statement by
// running §8's checks in order against that state and then changing it as
// one transition; a statement that fails any check leaves no trace, and an
// exact resubmission returns the prior result.
//
// Proof verification is the one asynchronous step, since the proof system
// lives in a WASM backend. So `admit` verifies the proof first, against the
// statement's own bytes and nothing in the segment, and then runs every
// state check and the transition synchronously with no await between them:
// two admissions that interleave at the proof step still see, and change,
// one view each. The verifier is an interface, pinned to the configuration's
// keys by whoever constructs it (barretenberg.ts), so the segment cannot be
// handed a key with a statement (§2); where the verifier can name the
// identities its keys were derived from, the segment refuses a configuration
// naming others (§12).
//
// Supply follows by induction from the empty book and canonical finalized
// imports (§C1.2, invariant 12): only a verified issuance introduces claims,
// every spend conserves them under a verified proof, every burn subtracts
// under one, and shared ancestor events count once. `replay` runs this same
// class over a served trail and the evidence for its openings, verifying
// every proof and every issuance signature itself, in the segment and in
// its supplied ancestry, and accepts nothing it did not recompute (§10).
// What it does not decide is the record's: whether an opening is the
// backing's canonical predecessor, whether the scope's links are in force,
// and which checkpoint is current (Construction §C2.7, C2.10.3–4).
//
// Nothing that leaves this class aliases its state. `readonly` is erased at
// runtime and the bytes inside a frozen Backing's arrays are writable, so a
// served backing is rebuilt with makeBacking, the configuration, the header
// and every hash are copied, and the accumulators are reachable only
// through reads.

import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { makeBacking, verifyBackingSignature, type Backing } from "../backing.js";
import { compareBytes, copyBytes } from "../bytes.js";
import { decodeCommitment, encodeCommitment, directoryRoot, verifyCommitment, type Commitment, type SnapshotDigest } from "../commitment.js";
import { verifySignatureStrict } from "../keys.js";
import { fieldToBytes, isField, isValue, VALUE_BOUND } from "./field.js";
import { EMPTY_NOTE_ROOT, NOTE_TREE_CAPACITY, NoteTree, type NotePath } from "./note-tree.js";
import { ScopeTree, type ScopeEntry } from "./scope.js";
import { SpentSet } from "./spent-set.js";
import {
  allFields,
  BURN,
  configurationHash,
  copyConfiguration,
  copySegmentHeader,
  copyStatement,
  genesisHistoryHash,
  ISSUE,
  isStatementKind,
  isWellFormedHeader,
  isWellFormedStatement,
  nextHistoryHash,
  parsePublicInputs,
  POOL_CONSTRUCTION,
  PUBLIC_INPUT_COUNT,
  segmentAuthority,
  segmentIdentity,
  snapshotDigest,
  SPEND,
  statementBytes,
  type CircuitIdentities,
  type ParsedInputs,
  type PoolConfiguration,
  type SegmentAuthority,
  type SegmentHeader,
  type Statement,
  type StatementKind,
} from "./statement.js";

/**
 * Verifies a proof against the configuration's verification key for its
 * kind and these public inputs, and against nothing else (§8 check 2).
 * Resolves to exactly `true` for a proof that verifies; anything else, and
 * never a throw, for one that does not.
 */
export interface StatementVerifier {
  verify(kind: StatementKind, publicInputs: readonly bigint[], proof: Uint8Array): Promise<boolean>;
  /**
   * The identities of the circuits whose keys this verifier holds, where it
   * can say (barretenberg.ts derives them). A segment refuses a configuration
   * naming other identities (§12).
   */
  readonly identities?: CircuitIdentities;
}

export type PoolErrorCode =
  | "MALFORMED"
  | "PROOF"
  | "BACKING"
  | "SIGNATURE"
  | "SUPPLY"
  | "ANCHOR"
  | "SPENT"
  | "OUTPUT"
  | "CAPACITY"
  | "CONFIGURATION"
  | "SEGMENT"
  | "IMPORT";

/** A refused statement, header or import, with the check it failed. Refusal changes nothing. */
export class PoolError extends Error {
  constructor(
    readonly code: PoolErrorCode,
    message: string,
    /** In replay, the position of the statement that failed. */
    readonly position?: bigint,
  ) {
    super(message);
    this.name = "PoolError";
  }
}

/**
 * What admission records for an accepted statement, and what the receipt
 * (§9) is signed over: the position, the statement's identity, the history
 * hash after it, the roots after it, and the hashes of the evidence the
 * operator verified. The operator's signature and `after` are the
 * sequencing layer's.
 */
export interface AcceptedStatement {
  /** The statement's position in the segment's history, counted from 1. */
  readonly position: bigint;
  readonly statementHash: Uint8Array;
  readonly historyHash: Uint8Array;
  readonly noteRoot: bigint;
  readonly spentRoot: Uint8Array;
  /** SHA-256 of the proof bytes the operator verified. */
  readonly proofHash: Uint8Array;
  /** SHA-256 of the obligor signature the operator verified; present for an issuance. */
  readonly obligorSignatureHash?: Uint8Array;
}

function copyAccepted(accepted: AcceptedStatement): AcceptedStatement {
  return Object.freeze({
    position: accepted.position,
    statementHash: copyBytes(accepted.statementHash),
    historyHash: copyBytes(accepted.historyHash),
    noteRoot: accepted.noteRoot,
    spentRoot: copyBytes(accepted.spentRoot),
    proofHash: copyBytes(accepted.proofHash),
    ...(accepted.obligorSignatureHash === undefined ? {} : { obligorSignatureHash: copyBytes(accepted.obligorSignatureHash) }),
  });
}

/** A backing's terms and the obligor's signature over its name, as the operator holds and serves them. */
export interface SignedBacking {
  readonly backing: Backing;
  readonly signature: Uint8Array;
}

/** The lit effect of an issue or burn: what moves a backing's totals (§9). */
export interface LitEffect {
  readonly kind: 1 | 3;
  readonly backing: Uint8Array;
  readonly quantity: bigint;
}

/**
 * One event of a finalized history (§10): its identity `(segment, position)`,
 * the statement it is bound to, and the statement's public effects. Events
 * are what an import deduplicates and what a conflict is found between.
 */
export interface PoolEvent {
  readonly segment: Uint8Array;
  readonly position: bigint;
  readonly statementHash: Uint8Array;
  readonly nullifiers: readonly bigint[];
  readonly outputs: readonly bigint[];
  readonly lit?: LitEffect;
}

/**
 * A finalized prefix (§10): what a replayed segment holds at a length, as a
 * later segment imports it. `events` is the deduplicated closure of the
 * segment's own imports with its local events through `length`; `roots` is
 * the forest at that length; `directory` is what the checkpoint carried.
 */
export interface FinalizedPrefix {
  readonly header: SegmentHeader;
  readonly length: bigint;
  readonly historyHash: Uint8Array;
  readonly events: readonly PoolEvent[];
  readonly roots: readonly bigint[];
  readonly directory: readonly SnapshotDigest[];
}

/** The served trail of a segment (§9): everything a stranger needs to replay it, given its openings' evidence. */
export interface SegmentTrail {
  readonly configuration: PoolConfiguration;
  readonly header: SegmentHeader;
  readonly backings: readonly SignedBacking[];
  readonly statements: readonly Statement[];
}

/** A commitment with the directory whose root it signed (Construction §C2.4.2). */
export interface Checkpoint {
  readonly commitment: Commitment;
  readonly directory: readonly SnapshotDigest[];
}

/** The evidence for one opening (§10): the checkpoint, the trail it checkpointed, and the length it checkpointed at. */
export interface ImportEvidence {
  readonly checkpoint: Checkpoint;
  readonly trail: SegmentTrail;
  readonly length: bigint;
}

interface Totals {
  issued: bigint;
  burned: bigint;
}

/** Whether `count` more leaves fit under 2^32 when `size` are in use (§4, §8 check 5). */
export function outputsFit(size: bigint, count: number): boolean {
  return size >= 0n && Number.isInteger(count) && count >= 0 && size + BigInt(count) <= NOTE_TREE_CAPACITY;
}

function malformed(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function eventKey(segment: Uint8Array, position: bigint): string {
  return `${bytesToHex(segment)}:${position}`;
}

function isLit(lit: unknown): lit is LitEffect {
  if (typeof lit !== "object" || lit === null) return false;
  const l = lit as Record<string, unknown>;
  return (l["kind"] === ISSUE || l["kind"] === BURN) &&
    l["backing"] instanceof Uint8Array && l["backing"].length === 32 &&
    isValue(l["quantity"]) && l["quantity"] !== 0n;
}

function fieldList(values: unknown, max: number): values is readonly bigint[] {
  if (!Array.isArray(values) || values.length > max) return false;
  for (let i = 0; i < values.length; i++) if (!isField(values[i])) return false;
  return true;
}

function isPoolEvent(event: unknown): event is PoolEvent {
  if (typeof event !== "object" || event === null) return false;
  const e = event as Record<string, unknown>;
  return e["segment"] instanceof Uint8Array && e["segment"].length === 32 &&
    typeof e["position"] === "bigint" && e["position"] >= 1n &&
    e["statementHash"] instanceof Uint8Array && e["statementHash"].length === 32 &&
    fieldList(e["nullifiers"], 2) && fieldList(e["outputs"], 2) &&
    (e["lit"] === undefined || isLit(e["lit"]));
}

function copyEvent(event: PoolEvent): PoolEvent {
  return Object.freeze({
    segment: copyBytes(event.segment),
    position: event.position,
    statementHash: copyBytes(event.statementHash),
    nullifiers: Object.freeze([...event.nullifiers]),
    outputs: Object.freeze([...event.outputs]),
    ...(event.lit === undefined ? {} : {
      lit: Object.freeze({ kind: event.lit.kind, backing: copyBytes(event.lit.backing), quantity: event.lit.quantity }),
    }),
  });
}

function sameEvent(a: PoolEvent, b: PoolEvent): boolean {
  const sameList = (x: readonly bigint[], y: readonly bigint[]): boolean => x.length === y.length && x.every((v, i) => v === y[i]);
  const sameLit = a.lit === undefined
    ? b.lit === undefined
    : b.lit !== undefined && a.lit.kind === b.lit.kind && a.lit.quantity === b.lit.quantity && compareBytes(a.lit.backing, b.lit.backing) === 0;
  return compareBytes(a.statementHash, b.statementHash) === 0 && sameList(a.nullifiers, b.nullifiers) && sameList(a.outputs, b.outputs) && sameLit;
}

function isDirectory(directory: unknown): directory is readonly SnapshotDigest[] {
  if (!Array.isArray(directory)) return false;
  for (let i = 0; i < directory.length; i++) {
    const entry: unknown = directory[i];
    if (typeof entry !== "object" || entry === null) return false;
    const d = entry as Record<string, unknown>;
    if (!(d["name"] instanceof Uint8Array) || d["name"].length !== 32) return false;
    if (!(d["digest"] instanceof Uint8Array) || d["digest"].length !== 32) return false;
  }
  return true;
}

function sameDirectory(a: readonly SnapshotDigest[], b: readonly SnapshotDigest[]): boolean {
  return a.length === b.length && a.every((entry, i) => {
    const other = b[i] as SnapshotDigest;
    return compareBytes(entry.name, other.name) === 0 && compareBytes(entry.digest, other.digest) === 0;
  });
}

function isFinalizedPrefix(prefix: unknown): prefix is FinalizedPrefix {
  if (typeof prefix !== "object" || prefix === null) return false;
  const p = prefix as Record<string, unknown>;
  if (!isWellFormedHeader(p["header"])) return false;
  if (typeof p["length"] !== "bigint" || p["length"] < 0n) return false;
  if (!(p["historyHash"] instanceof Uint8Array) || p["historyHash"].length !== 32) return false;
  const events = p["events"];
  if (!Array.isArray(events)) return false;
  for (let i = 0; i < events.length; i++) if (!isPoolEvent(events[i])) return false;
  const roots = p["roots"];
  if (!Array.isArray(roots)) return false;
  for (let i = 0; i < roots.length; i++) if (!isField(roots[i])) return false;
  return isDirectory(p["directory"]);
}

/** Fold the lit effects of events into totals, then hold every backing to §10's bounds. */
function foldTotals(totals: Map<string, Totals>, events: readonly PoolEvent[]): void {
  for (const event of events) {
    if (event.lit === undefined) continue;
    const key = bytesToHex(event.lit.backing);
    const held = totals.get(key) ?? { issued: 0n, burned: 0n };
    if (event.lit.kind === ISSUE) held.issued += event.lit.quantity;
    else held.burned += event.lit.quantity;
    totals.set(key, held);
  }
  for (const [key, held] of totals) {
    if (held.issued >= VALUE_BOUND) throw new PoolError("IMPORT", `issued total of ${key.slice(0, 8)} would reach 2^64`);
    if (held.burned > held.issued) throw new PoolError("IMPORT", `burned total of ${key.slice(0, 8)} exceeds its issued total`);
  }
}

function directoryOf(entries: readonly ScopeEntry[], segment: Uint8Array, historyHash: Uint8Array, totals: ReadonlyMap<string, Totals>): SnapshotDigest[] {
  return entries.map((entry) => {
    const held = totals.get(bytesToHex(entry.backing)) ?? { issued: 0n, burned: 0n };
    return { name: copyBytes(entry.backing), digest: snapshotDigest(entry.backing, segment, historyHash, held.issued, held.burned) };
  });
}

interface Merged {
  readonly events: readonly PoolEvent[];
  readonly roots: readonly bigint[];
  readonly totals: Map<string, Totals>;
}

/**
 * §10's merge: check each supplied prefix against itself, match every opening
 * to exactly one of them and every prefix to an opening, then deduplicate
 * the events, refuse a conflict, fold the totals and union the roots.
 */
function mergeImports(domain: Uint8Array, header: SegmentHeader, imports: readonly FinalizedPrefix[]): Merged {
  interface Supplied {
    readonly prefix: FinalizedPrefix;
    readonly identity: Uint8Array;
    readonly root: Uint8Array;
    used: boolean;
  }
  const supplied: Supplied[] = [];
  for (const prefix of imports) {
    if (!isFinalizedPrefix(prefix)) throw new PoolError("IMPORT", "malformed finalized prefix");
    if (compareBytes(prefix.header.domain, domain) !== 0) throw new PoolError("IMPORT", "an import names another construction");
    if (compareBytes(prefix.header.venue, header.venue) !== 0) throw new PoolError("IMPORT", "an import names another venue (C2.10.2)");
    const identity = segmentIdentity(prefix.header);
    // The prefix's local events are exactly positions 1 … length of its own segment.
    const local = prefix.events.filter((event) => compareBytes(event.segment, identity) === 0);
    if (BigInt(local.length) !== prefix.length || !local.every((event, i) => event.position === BigInt(i + 1))) {
      throw new PoolError("IMPORT", "a finalized prefix's local events do not match its length");
    }
    // Its directory is what its own events and history say it is.
    const totals = new Map<string, Totals>();
    foldTotals(totals, prefix.events);
    if (!sameDirectory(prefix.directory, directoryOf(prefix.header.entries, identity, prefix.historyHash, totals))) {
      throw new PoolError("IMPORT", "a finalized prefix's directory does not match its events");
    }
    let root: Uint8Array;
    try {
      root = directoryRoot(prefix.directory);
    } catch (cause) {
      throw new PoolError("IMPORT", malformed(cause, "malformed directory"));
    }
    supplied.push({ prefix, identity, root, used: false });
  }
  for (const entry of header.entries) {
    if (entry.opening === undefined) continue;
    const opening = entry.opening;
    // Every supplied copy of the opening's prefix is the opening's; identical copies deduplicate below.
    const found = supplied.filter((s) =>
      compareBytes(s.root, opening.root) === 0 && compareBytes(s.prefix.header.operator, opening.operator) === 0);
    if (found.length === 0) {
      throw new PoolError("IMPORT", `no finalized prefix for the opening of backing ${bytesToHex(entry.backing).slice(0, 8)}`);
    }
    for (const match of found) {
      if (opening.sequence < match.prefix.header.sequence) {
        throw new PoolError("IMPORT", "an opening predates the segment's first commitment sequence (§6)");
      }
      if (!match.prefix.header.entries.some((e) => compareBytes(e.backing, entry.backing) === 0)) {
        throw new PoolError("IMPORT", `the opening of backing ${bytesToHex(entry.backing).slice(0, 8)} does not scope it`);
      }
      match.used = true;
    }
  }
  if (supplied.some((s) => !s.used)) throw new PoolError("IMPORT", "a finalized prefix that no opening names");
  // Deduplicate by event identity; one identity, one statement, and so one
  // set of effects (C2.10.6). A prefix that agrees on the statement's hash
  // but not on what it did is not the same history either.
  const events = new Map<string, PoolEvent>();
  for (const { prefix } of supplied) {
    for (const event of prefix.events) {
      const key = eventKey(event.segment, event.position);
      const prior = events.get(key);
      if (prior === undefined) {
        events.set(key, copyEvent(event));
      } else if (!sameEvent(prior, event)) {
        throw new PoolError("IMPORT", `conflicting prefixes of one segment at ${key.slice(0, 8)}:${event.position}`);
      }
    }
  }
  // Across distinct events no nullifier and no output repeats; a union does not repair that.
  const nullifiers = new Set<bigint>();
  const outputs = new Set<bigint>();
  for (const event of events.values()) {
    for (const nullifier of event.nullifiers) {
      if (nullifiers.has(nullifier)) throw new PoolError("IMPORT", "one nullifier in two distinct events");
      nullifiers.add(nullifier);
    }
    for (const output of event.outputs) {
      if (outputs.has(output)) throw new PoolError("IMPORT", "one output commitment in two distinct events");
      outputs.add(output);
    }
  }
  const totals = new Map<string, Totals>();
  foldTotals(totals, [...events.values()]);
  const roots = new Set<bigint>([EMPTY_NOTE_ROOT]);
  for (const { prefix } of supplied) for (const root of prefix.roots) roots.add(root);
  return { events: Object.freeze([...events.values()]), roots: Object.freeze([...roots]), totals };
}

export class Segment {
  private readonly config: PoolConfiguration;
  private readonly domain: Uint8Array;
  private readonly head: SegmentHeader;
  private readonly id: Uint8Array;
  private readonly scopeTree: ScopeTree;
  private readonly verifier: StatementVerifier;
  private readonly tree = new NoteTree();
  private readonly anchors: Set<bigint>;
  private readonly importedRoots: readonly bigint[];
  private readonly localRoots: bigint[] = [EMPTY_NOTE_ROOT];
  private readonly spent = new SpentSet();
  private readonly outputs = new Set<bigint>();
  private readonly imported: readonly PoolEvent[];
  private readonly importedTotals: ReadonlyMap<string, Totals>;
  private readonly totals: Map<string, Totals>;
  private readonly terms = new Map<string, SignedBacking>();
  private readonly accepted = new Map<string, AcceptedStatement>();
  private readonly records: AcceptedStatement[] = [];
  private readonly statements: Statement[] = [];
  private readonly local: PoolEvent[] = [];
  private history: Uint8Array;

  /**
   * Open a segment over `header` from the finalized prefixes its openings
   * name (§10). `imports` is one prefix per distinct opening commitment,
   * each as `Segment.replay` or `prefix()` produced it; the constructor
   * checks each against itself and against the header, and refuses the
   * set on any conflict. This is a trusted in-process state API, not a
   * verifier of serialized prefixes: untrusted histories must enter through
   * `Segment.replay`, which derives their events and roots from proofs.
   * Whether each opening is the record's canonical
   * predecessor is the caller's to have established (C2.10.4).
   */
  constructor(configuration: PoolConfiguration, header: SegmentHeader, imports: readonly FinalizedPrefix[], verifier: StatementVerifier) {
    try {
      this.config = copyConfiguration(configuration);
      this.domain = configurationHash(this.config);
    } catch (cause) {
      throw new PoolError("CONFIGURATION", malformed(cause, "malformed configuration"));
    }
    const identities = verifier.identities;
    if (identities !== undefined) {
      for (const kind of ["issue", "spend", "burn"] as const) {
        if (
          compareBytes(identities[kind].bytecode, this.config[kind].bytecode) !== 0 ||
          compareBytes(identities[kind].vk, this.config[kind].vk) !== 0
        ) {
          throw new PoolError("CONFIGURATION", `the verifier's ${kind} circuit is not the configuration's`);
        }
      }
    }
    this.verifier = verifier;
    try {
      this.head = copySegmentHeader(header);
    } catch (cause) {
      throw new PoolError("SEGMENT", malformed(cause, "malformed segment header"));
    }
    if (compareBytes(this.head.domain, this.domain) !== 0) {
      throw new PoolError("SEGMENT", "the header names another construction");
    }
    this.id = segmentIdentity(this.head);
    this.scopeTree = new ScopeTree(this.head.entries);
    if (!Array.isArray(imports)) throw new PoolError("IMPORT", "imports must be a list of finalized prefixes");
    const merged = mergeImports(this.domain, this.head, imports);
    this.imported = merged.events;
    this.importedRoots = merged.roots;
    this.importedTotals = new Map([...merged.totals].map(([key, held]) => [key, { ...held }]));
    this.totals = merged.totals;
    this.anchors = new Set(merged.roots);
    for (const event of this.imported) {
      for (const nullifier of event.nullifiers) this.spent.insert(fieldToBytes(nullifier));
      for (const output of event.outputs) this.outputs.add(output);
    }
    this.history = genesisHistoryHash(this.id);
  }

  /** A copy of the configuration this segment serves under. */
  get configuration(): PoolConfiguration {
    return copyConfiguration(this.config);
  }

  /** configHash, the construction domain (§2), copied. */
  get configHash(): Uint8Array {
    return copyBytes(this.domain);
  }

  /** The header, copied. */
  get header(): SegmentHeader {
    return copySegmentHeader(this.head);
  }

  /** segmentId (§6), copied. */
  get identity(): Uint8Array {
    return copyBytes(this.id);
  }

  /** scopeRoot (§5): what every statement of this segment names. */
  scopeRoot(): bigint {
    return this.scopeTree.root();
  }

  /** The scope's entries in sorted order, as copies. */
  scope(): ScopeEntry[] {
    return this.scopeTree.entries();
  }

  /** What a receipt of this segment is verified against (§9). */
  authority(): SegmentAuthority {
    return segmentAuthority(this.head);
  }

  /** The number of accepted local statements, n. */
  get length(): bigint {
    return BigInt(this.statements.length);
  }

  /** historyHash_n. */
  historyHash(): Uint8Array {
    return copyBytes(this.history);
  }

  /** noteRoot_n, the local tree's root. */
  noteRoot(): bigint {
    return this.tree.root();
  }

  /** spentRoot_n. */
  spentRoot(): Uint8Array {
    return this.spent.root();
  }

  /** Whether `anchor` is in the accepted-root forest (§4). */
  isAnchor(anchor: bigint): boolean {
    return this.anchors.has(anchor);
  }

  /** Whether the nullifier is in the combined spent set. */
  isSpent(nullifier: bigint): boolean {
    return this.spent.has(fieldToBytes(nullifier));
  }

  /** The encoded spent-set proof for a nullifier, member or not (§11). */
  spentProof(nullifier: bigint): Uint8Array {
    return this.spent.proof(fieldToBytes(nullifier));
  }

  /** Every local leaf in acceptance order: what a wallet syncs to compute its own paths (§4). */
  leaves(): readonly bigint[] {
    return this.tree.leaves();
  }

  /** The local leaf at a position, or undefined past the used leaves. */
  leaf(position: bigint): bigint | undefined {
    return this.tree.leaf(position);
  }

  /** The path for a used local leaf against the current local root; a wallet computes the same from `leaves()`. */
  path(position: bigint): NotePath {
    return this.tree.path(position);
  }

  /**
   * Hold the signed terms of a scoped backing whose E names this
   * construction and this domain (§8 check 3). E's original operator is not
   * compared: current authority is the record's, and the header's scope
   * says what this segment serves. Idempotent for the same backing.
   */
  register(backing: Backing, signature: Uint8Array): void {
    let stored: Backing;
    try {
      stored = makeBacking(backing);
    } catch (cause) {
      throw new PoolError("BACKING", malformed(cause, "malformed backing"));
    }
    if (!verifyBackingSignature(stored, signature)) throw new PoolError("BACKING", "backing signature invalid");
    const evidence = stored.evidence;
    if (
      evidence.setting !== "pool" ||
      evidence.construction !== POOL_CONSTRUCTION ||
      compareBytes(evidence.configuration, this.domain) !== 0
    ) {
      throw new PoolError("BACKING", "this backing's E does not name this construction and configuration");
    }
    if (!this.scopeTree.has(stored.name)) throw new PoolError("BACKING", "the backing is not in this segment's scope");
    if (this.terms.has(stored.nameHex)) return;
    this.terms.set(stored.nameHex, Object.freeze({ backing: stored, signature: copyBytes(signature) }));
  }

  /** The signed terms of a scoped backing this segment holds, by name, as fresh copies. */
  backing(name: Uint8Array): SignedBacking | undefined {
    const held = this.terms.get(bytesToHex(name));
    return held === undefined ? undefined : { backing: makeBacking(held.backing), signature: copyBytes(held.signature) };
  }

  private totalsOf(name: Uint8Array): Totals | undefined {
    if (!(name instanceof Uint8Array) || !this.scopeTree.has(name)) return undefined;
    return this.totals.get(bytesToHex(name)) ?? { issued: 0n, burned: 0n };
  }

  /** issued(b) for a scoped backing, over the imported closure and the local history. */
  issued(name: Uint8Array): bigint | undefined {
    return this.totalsOf(name)?.issued;
  }

  burned(name: Uint8Array): bigint | undefined {
    return this.totalsOf(name)?.burned;
  }

  /** outstanding(b) = issued(b) − burned(b) (invariant 10). */
  outstanding(name: Uint8Array): bigint | undefined {
    const totals = this.totalsOf(name);
    return totals === undefined ? undefined : totals.issued - totals.burned;
  }

  /** snapshot(b) at the segment's current length (§9), for a scoped backing. */
  snapshot(name: Uint8Array): Uint8Array | undefined {
    const totals = this.totalsOf(name);
    return totals === undefined ? undefined : snapshotDigest(name, this.id, this.history, totals.issued, totals.burned);
  }

  /**
   * The directory a commitment of this segment authenticates (§9, C2.10.3):
   * every scoped backing with its snapshot digest, by name. The whole scope,
   * always: a commitment finalizes the scope or nothing.
   */
  directory(): SnapshotDigest[] {
    return directoryOf(this.head.entries, this.id, this.history, this.totals);
  }

  /** The accepted local statement with this identity, if any. */
  acceptedStatement(statementHash: Uint8Array): AcceptedStatement | undefined {
    const found = this.accepted.get(bytesToHex(statementHash));
    return found === undefined ? undefined : copyAccepted(found);
  }

  /** The deduplicated imported closure followed by the local events, as copies. */
  events(): PoolEvent[] {
    return [...this.imported, ...this.local].map(copyEvent);
  }

  /** The served trail: header, every held backing's signed terms, and every local statement in order with its evidence. */
  trail(): SegmentTrail {
    return {
      configuration: copyConfiguration(this.config),
      header: copySegmentHeader(this.head),
      backings: [...this.terms.values()].map(({ backing, signature }) => ({ backing: makeBacking(backing), signature: copyBytes(signature) })),
      statements: this.statements.map(copyStatement),
    };
  }

  /**
   * The finalized prefix at `length` (§10), the current length by default:
   * what a later segment imports once the record has finalized a checkpoint
   * at that length. Finality itself is not this class's to say.
   */
  prefix(length: bigint = this.length): FinalizedPrefix {
    if (typeof length !== "bigint" || length < 0n || length > this.length) {
      throw new PoolError("MALFORMED", "no prefix at that length");
    }
    const n = Number(length);
    const local = this.local.slice(0, n);
    const totals = new Map([...this.importedTotals].map(([key, held]) => [key, { ...held }]));
    foldTotals(totals, local);
    const historyHash = n === 0 ? genesisHistoryHash(this.id) : copyBytes((this.records[n - 1] as AcceptedStatement).historyHash);
    return Object.freeze({
      header: copySegmentHeader(this.head),
      length,
      historyHash,
      events: Object.freeze([...this.imported, ...local].map(copyEvent)),
      roots: Object.freeze([...this.importedRoots, ...this.localRoots.slice(1, n + 1)]),
      directory: Object.freeze(directoryOf(this.head.entries, this.id, historyHash, totals)),
    });
  }

  /**
   * Admit one statement (§8). Returns the accepted record, the same one for
   * an exact resubmission; throws PoolError, changing nothing, for a
   * statement that fails a check.
   */
  async admit(statement: Statement): Promise<AcceptedStatement> {
    // Check 1, on what the statement asserts: kind, count, canonical fields,
    // ranges, this domain, this segment and this scope. The evidence is not read yet.
    if (typeof statement !== "object" || statement === null) throw new PoolError("MALFORMED", "malformed statement");
    const kind: unknown = statement.kind;
    const inputs: unknown = statement.publicInputs;
    if (!isStatementKind(kind) || !allFields(inputs, PUBLIC_INPUT_COUNT[kind])) {
      throw new PoolError("MALFORMED", "public inputs do not match the kind");
    }
    const publicInputs: readonly bigint[] = Object.freeze([...inputs]);
    const parsed = this.parse(kind, publicInputs);
    // Invariant 26 first: an exact resubmission is the same statement
    // whatever its proof bytes, and is answered before the evidence is looked at.
    const hash = sha256(statementBytes(this.domain, kind, publicInputs));
    const prior = this.accepted.get(bytesToHex(hash));
    if (prior !== undefined) return copyAccepted(prior);
    if (!isWellFormedStatement(statement)) throw new PoolError("MALFORMED", "malformed proof or signature");
    const own = copyStatement(statement);
    // Check 2, on the statement alone: the proof, against the configuration's
    // key for this kind. Asynchronous, and the only await in admission.
    if ((await this.verifier.verify(own.kind, own.publicInputs, own.proof)) !== true) {
      throw new PoolError("PROOF", "proof does not verify");
    }
    // From here down nothing yields, so the checks and the transition read
    // and change one view. The resubmission check runs again because another
    // admission of the same statement may have completed during the await.
    const raced = this.accepted.get(bytesToHex(hash));
    if (raced !== undefined) return copyAccepted(raced);
    return this.apply(own, parsed, hash);
  }

  private parse(kind: StatementKind, publicInputs: readonly bigint[]): ParsedInputs {
    let inputs: ParsedInputs;
    try {
      inputs = parsePublicInputs(kind, publicInputs);
    } catch (cause) {
      throw new PoolError("MALFORMED", malformed(cause, "malformed public inputs"));
    }
    if (compareBytes(inputs.domain, this.domain) !== 0) throw new PoolError("MALFORMED", "statement names another construction");
    if (compareBytes(inputs.segment, this.id) !== 0) throw new PoolError("SEGMENT", "statement is for another segment");
    if (inputs.scopeRoot !== this.scopeTree.root()) throw new PoolError("SEGMENT", "statement names another scope root");
    return inputs;
  }

  /** Checks 3–5 and the transition, synchronously. */
  private apply(statement: Statement, inputs: ParsedInputs, hash: Uint8Array): AcceptedStatement {
    // Check 3: a scoped backing whose terms are held, the obligor's authority, and the supply bounds.
    let totals: Totals | undefined;
    let lit: LitEffect | undefined;
    if (inputs.kind !== SPEND) {
      if (!this.scopeTree.has(inputs.backing)) throw new PoolError("BACKING", "the backing is not in this segment's scope");
      const held = this.terms.get(bytesToHex(inputs.backing));
      if (held === undefined) throw new PoolError("BACKING", "the backing's signed terms are not held");
      totals = this.totals.get(held.backing.nameHex) ?? { issued: 0n, burned: 0n };
      if (inputs.kind === ISSUE) {
        const message = statementBytes(this.domain, statement.kind, statement.publicInputs);
        if (!verifySignatureStrict(statement.obligorSignature as Uint8Array, message, held.backing.obligor)) {
          throw new PoolError("SIGNATURE", "the obligor did not sign this issuance");
        }
        if (totals.issued + inputs.quantity >= VALUE_BOUND) throw new PoolError("SUPPLY", "issued total would reach 2^64");
      } else if (totals.issued - totals.burned < inputs.quantity) {
        throw new PoolError("SUPPLY", "burn exceeds the backing's outstanding claims");
      }
      lit = { kind: inputs.kind, backing: copyBytes(inputs.backing), quantity: inputs.quantity };
    }
    // Check 4: every anchor is in the forest, the padding input's included; no nullifier is spent; the nullifiers are distinct.
    if (inputs.kind !== ISSUE) {
      for (const anchor of inputs.anchors) {
        if (!this.anchors.has(anchor)) throw new PoolError("ANCHOR", "anchor is not an accepted root of this segment");
      }
      const [first, second] = inputs.nullifiers;
      if (first === second) throw new PoolError("SPENT", "a statement's nullifiers must be distinct");
      for (const nullifier of inputs.nullifiers) {
        if (this.spent.has(fieldToBytes(nullifier))) throw new PoolError("SPENT", "nullifier already spent");
      }
    }
    // Check 5: every output is new across the closure and the local tree, the outputs are distinct, and they fit.
    const outputs: readonly bigint[] = inputs.outputs;
    if (new Set(outputs).size !== outputs.length) throw new PoolError("OUTPUT", "a statement's outputs must be distinct");
    for (const output of outputs) {
      if (output === 0n || this.outputs.has(output)) throw new PoolError("OUTPUT", "output commitment is not new");
    }
    if (!outputsFit(this.tree.size, outputs.length)) throw new PoolError("CAPACITY", "the note tree cannot hold these outputs");
    // The transition, as one: outputs appended in order and the root joins the
    // forest, nullifiers inserted, totals moved, the statement appended, the
    // history hash advanced.
    this.tree.appendAll(outputs);
    const noteRoot = this.tree.root();
    this.localRoots.push(noteRoot);
    this.anchors.add(noteRoot);
    for (const output of outputs) this.outputs.add(output);
    for (const nullifier of inputs.nullifiers) this.spent.insert(fieldToBytes(nullifier));
    if (totals !== undefined && lit !== undefined) {
      if (lit.kind === ISSUE) totals.issued += lit.quantity;
      else totals.burned += lit.quantity;
      this.totals.set(bytesToHex(lit.backing), totals);
    }
    this.statements.push(statement);
    const position = BigInt(this.statements.length);
    const spentRoot = this.spent.root();
    this.history = nextHistoryHash(this.history, hash, noteRoot, spentRoot, position);
    this.local.push(Object.freeze({
      segment: this.id,
      position,
      statementHash: hash,
      nullifiers: Object.freeze([...inputs.nullifiers]),
      outputs: Object.freeze([...outputs]),
      ...(lit === undefined ? {} : { lit: Object.freeze(lit) }),
    }));
    const record: AcceptedStatement = Object.freeze({
      position,
      statementHash: hash,
      historyHash: copyBytes(this.history),
      noteRoot,
      spentRoot,
      proofHash: sha256(statement.proof),
      ...(statement.kind === ISSUE && statement.obligorSignature !== undefined
        ? { obligorSignatureHash: sha256(statement.obligorSignature) }
        : {}),
    });
    this.accepted.set(bytesToHex(hash), record);
    this.records.push(record);
    return copyAccepted(record);
  }

  /**
   * Replay a served trail (§10): the evidence for every opening is checked
   * and its segment replayed to the checkpointed length, transitively; then
   * this segment's statements are admitted in order with every proof and
   * issuance signature verified by `verifier`. Stops at the first check
   * that fails, throwing that PoolError (with the statement's position where
   * one failed), and accepts nothing it did not recompute. A replayed
   * segment proves itself and the ancestry it was handed; which opening is
   * canonical and which checkpoint is current is the record's to say (§C2).
   */
  static async replay(trail: SegmentTrail, verifier: StatementVerifier, evidence: readonly ImportEvidence[] = []): Promise<Segment> {
    // Own the entire supplied graph before the first proof yields, including
    // later statements and ancestors we have not yet reached. A saved map key
    // must never name an evidence object the caller can replace underneath it.
    const ownTrail = copyReplayTrail(trail);
    const byKey = new Map<string, ImportEvidence>();
    if (!Array.isArray(evidence)) throw new PoolError("IMPORT", "malformed import evidence");
    for (const item of evidence as readonly ImportEvidence[]) {
      const commitment: unknown = item?.checkpoint?.commitment;
      if (typeof commitment !== "object" || commitment === null) throw new PoolError("IMPORT", "malformed import evidence");
      const c = commitment as Record<string, unknown>;
      if (!(c["operator"] instanceof Uint8Array) || typeof c["sequence"] !== "bigint" || !(c["root"] instanceof Uint8Array)) {
        throw new PoolError("IMPORT", "malformed import evidence");
      }
      let own: ImportEvidence;
      try {
        if (!isDirectory(item.checkpoint.directory)) throw new Error("malformed checkpoint directory");
        if (!Array.isArray(item.trail?.statements) || typeof item.length !== "bigint" ||
            item.length < 0n || item.length > BigInt(item.trail.statements.length)) {
          throw new Error("an opening's checkpointed length exceeds its trail");
        }
        own = {
          checkpoint: {
            commitment: decodeCommitment(encodeCommitment(item.checkpoint.commitment)),
            directory: item.checkpoint.directory.map(e => ({ name: copyBytes(e.name), digest: copyBytes(e.digest) })),
          },
          // Evidence outside the checkpointed prefix is not imported or verified.
          trail: copyReplayTrail({ ...item.trail, statements: item.trail.statements.slice(0, Number(item.length)) }),
          length: item.length,
        };
      } catch (cause) {
        throw new PoolError("IMPORT", malformed(cause, "malformed import evidence"));
      }
      const held = own.checkpoint.commitment;
      byKey.set(`${bytesToHex(held.operator)}:${held.sequence}:${bytesToHex(held.root)}`, own);
    }
    return replayWith(ownTrail, verifier, byKey, new Map(), new Set());
  }
}

function copyReplayTrail(trail: SegmentTrail): SegmentTrail {
  if (typeof trail !== "object" || trail === null || !isWellFormedHeader(trail.header)) {
    throw new PoolError("SEGMENT", "malformed segment header");
  }
  if (!Array.isArray(trail.backings) || !Array.isArray(trail.statements)) throw new PoolError("MALFORMED", "malformed trail");
  try {
    return {
      configuration: copyConfiguration(trail.configuration),
      header: copySegmentHeader(trail.header),
      backings: Array.from(trail.backings, b => ({ backing: makeBacking(b.backing), signature: copyBytes(b.signature) })),
      statements: Array.from(trail.statements, copyStatement),
    };
  } catch (cause) {
    throw new PoolError("MALFORMED", malformed(cause, "malformed trail"));
  }
}

async function replayWith(
  trail: SegmentTrail,
  verifier: StatementVerifier,
  evidence: ReadonlyMap<string, ImportEvidence>,
  memo: Map<string, FinalizedPrefix>,
  inProgress: Set<string>,
): Promise<Segment> {
  if (typeof trail !== "object" || trail === null || !isWellFormedHeader(trail.header)) {
    throw new PoolError("SEGMENT", "malformed segment header");
  }
  const header = copySegmentHeader(trail.header);
  const imports: FinalizedPrefix[] = [];
  const included = new Set<string>();
  for (const entry of header.entries) {
    if (entry.opening === undefined) continue;
    const key = `${bytesToHex(entry.opening.operator)}:${entry.opening.sequence}:${bytesToHex(entry.opening.root)}`;
    let prefix = memo.get(key);
    if (prefix === undefined) {
      if (inProgress.has(key)) throw new PoolError("IMPORT", "an opening's ancestry returns to a segment being replayed");
      const item = evidence.get(key);
      if (item === undefined) {
        throw new PoolError("IMPORT", `no evidence for the opening of backing ${bytesToHex(entry.backing).slice(0, 8)}`);
      }
      inProgress.add(key);
      prefix = await importPrefix(item, header, verifier, evidence, memo, inProgress);
      inProgress.delete(key);
      memo.set(key, prefix);
    }
    if (!included.has(key)) {
      included.add(key);
      imports.push(prefix);
    }
  }
  const segment = new Segment(trail.configuration, header, imports, verifier);
  if (!Array.isArray(trail.backings) || !Array.isArray(trail.statements)) throw new PoolError("MALFORMED", "malformed trail");
  for (const { backing, signature } of trail.backings) segment.register(backing, signature);
  let position = 0n;
  for (const statement of trail.statements) {
    position += 1n;
    let accepted: AcceptedStatement;
    try {
      accepted = await segment.admit(statement);
    } catch (cause) {
      if (cause instanceof PoolError) throw new PoolError(cause.code, `statement ${position}: ${cause.message}`, position);
      throw cause;
    }
    // A trail that repeats a statement is not the history: an exact
    // resubmission is answered with its prior record, which places it
    // earlier than its place in the trail.
    if (accepted.position !== position) {
      throw new PoolError("MALFORMED", `statement ${position} repeats statement ${accepted.position}`, position);
    }
  }
  return segment;
}

/** §10's checks on one opening's evidence, and the replay of the segment it checkpointed. */
async function importPrefix(
  item: ImportEvidence,
  header: SegmentHeader,
  verifier: StatementVerifier,
  evidence: ReadonlyMap<string, ImportEvidence>,
  memo: Map<string, FinalizedPrefix>,
  inProgress: Set<string>,
): Promise<FinalizedPrefix> {
  const { checkpoint, trail, length } = item;
  if (!verifyCommitment(checkpoint.commitment)) throw new PoolError("IMPORT", "an opening commitment does not verify");
  if (!isDirectory(checkpoint.directory)) throw new PoolError("IMPORT", "malformed checkpoint directory");
  let root: Uint8Array;
  try {
    root = directoryRoot(checkpoint.directory);
  } catch (cause) {
    throw new PoolError("IMPORT", malformed(cause, "malformed checkpoint directory"));
  }
  if (compareBytes(root, checkpoint.commitment.root) !== 0) {
    throw new PoolError("IMPORT", "a checkpoint's directory is not the one its commitment signed");
  }
  if (typeof trail !== "object" || trail === null || !isWellFormedHeader(trail.header)) {
    throw new PoolError("IMPORT", "an opening's trail has a malformed header");
  }
  if (compareBytes(trail.header.operator, checkpoint.commitment.operator) !== 0) {
    throw new PoolError("IMPORT", "an opening's trail is not the checkpoint operator's");
  }
  if (checkpoint.commitment.sequence < trail.header.sequence) {
    throw new PoolError("IMPORT", "a checkpoint predates the segment's first commitment sequence (§6)");
  }
  if (compareBytes(trail.header.domain, header.domain) !== 0) throw new PoolError("IMPORT", "an import names another construction");
  if (compareBytes(trail.header.venue, header.venue) !== 0) throw new PoolError("IMPORT", "an import names another venue (C2.10.2)");
  if (!Array.isArray(trail.statements) || typeof length !== "bigint" || length < 0n || length > BigInt(trail.statements.length)) {
    throw new PoolError("IMPORT", "an opening's checkpointed length exceeds its trail");
  }
  let segment: Segment;
  try {
    segment = await replayWith({ ...trail, statements: trail.statements.slice(0, Number(length)) }, verifier, evidence, memo, inProgress);
  } catch (cause) {
    if (cause instanceof PoolError) throw new PoolError(cause.code, `imported segment: ${cause.message}`, cause.position);
    throw cause;
  }
  const prefix = segment.prefix();
  if (!sameDirectory(prefix.directory, checkpoint.directory)) {
    throw new PoolError("IMPORT", "a checkpoint's directory is not the replayed prefix's (C2.10.3)");
  }
  return prefix;
}
