// The shielded pool's frames (pool-v2 §§2, 6, 7, 9): the configuration whose
// hash is the construction domain, the segment header and its identity, what
// a statement asserts and the hash that is its identity, the record a
// statement is stored and served as, the ordered history's hash chain, and
// the snapshot digest a commitment's directory carries per backing.
//
// Every frame is a context string written raw, followed by fixed-width or
// length-prefixed fields in the order pool-v2 lists them, and SHA-256 over
// the frame (§1). contexts.ts asserts the pool's contexts are prefix-free
// among themselves and the rest.
//
// A statement's identity is `statementHash` (§7): two statements with one
// hash are one statement, whatever their proof bytes, which is what makes an
// exact resubmission return its prior receipt (invariant 26). The proof and
// the obligor's signature are evidence the operator verified, bound into the
// receipt by their own hashes (§9), never into the statement's identity. The
// segment identity and the scope root are public inputs of every kind, so a
// statement is a statement for one segment (C2.10.8).

import { sha256 } from "@noble/hashes/sha2.js";
import { POOL_CONSTRUCTION } from "../backing.js";
import { ByteReader, ByteWriter, compareBytes, copyBytes, EncodingError } from "../bytes.js";
import {
  POOL_CONFIG_CONTEXT,
  POOL_GENESIS_CONTEXT,
  POOL_HISTORY_CONTEXT,
  POOL_SEGMENT_CONTEXT,
  POOL_SNAPSHOT_CONTEXT,
  POOL_STATEMENT_CONTEXT,
} from "../contexts.js";
import { isValidPublicKey, KEY_LENGTH, SIGNATURE_LENGTH } from "../keys.js";
import { bytesToField, fieldToBytes, identifierOf, isField, isValue } from "./field.js";
import { isCanonicalScope, SCOPE_CAPACITY, ScopeTree, type ScopeEntry } from "./scope.js";

export { POOL_CONSTRUCTION };

/** The bounds this version fixes inside the configuration hash (§2). */
export const POOL_BOUNDS = Object.freeze({ noteTreeDepth: 32, scopeDepth: 16, inputs: 2, outputs: 2 });

/** SHA-256 of a circuit's compiled bytecode and of its verification key (§2). */
export interface CircuitIdentity {
  readonly bytecode: Uint8Array;
  readonly vk: Uint8Array;
}

/** The three circuits' identities, as a configuration names them and a verifier derives them. */
export interface CircuitIdentities {
  readonly issue: CircuitIdentity;
  readonly spend: CircuitIdentity;
  readonly burn: CircuitIdentity;
}

/**
 * The configuration (§2): what a backing's E names by hash, and what a wallet
 * and a verifier pin. Its hash is the construction domain (C1.2.1): it names
 * neither an operator nor a segment nor the backings it serves, so that one
 * domain is shared by everything compiled from the pinned sources and a
 * note keeps its identity across operators.
 */
export interface PoolConfiguration {
  readonly issue: CircuitIdentity;
  readonly spend: CircuitIdentity;
  readonly burn: CircuitIdentity;
  /** SHA-256 of the Poseidon2 helper source (§1). */
  readonly helper: Uint8Array;
}

export function configurationBytes(config: PoolConfiguration): Uint8Array {
  const w = new ByteWriter();
  w.context(POOL_CONFIG_CONTEXT);
  for (const kind of ["issue", "spend", "burn"] as const) {
    w.key32(config[kind].bytecode, `${kind} bytecode hash`);
    w.key32(config[kind].vk, `${kind} verification-key hash`);
  }
  w.key32(config.helper, "helper hash");
  w.u8(POOL_BOUNDS.noteTreeDepth);
  w.u8(POOL_BOUNDS.scopeDepth);
  w.u8(POOL_BOUNDS.inputs);
  w.u8(POOL_BOUNDS.outputs);
  return w.finish();
}

/** configHash: the construction domain, the 32 bytes E's `configuration` field carries. */
export function configurationHash(config: PoolConfiguration): Uint8Array {
  return sha256(configurationBytes(config));
}

export function copyConfiguration(config: PoolConfiguration): PoolConfiguration {
  const copy = (identity: CircuitIdentity): CircuitIdentity =>
    Object.freeze({ bytecode: copyBytes(identity.bytecode), vk: copyBytes(identity.vk) });
  return Object.freeze({
    issue: copy(config.issue),
    spend: copy(config.spend),
    burn: copy(config.burn),
    helper: copyBytes(config.helper),
  });
}

// ---------------------------------------------------------------------------
// The segment header (§6)

/** The exact commitment that fixes a backing's opening state (C2.7.1, C2.10.4): its operator, sequence and directory root. */
export interface OpeningCheckpoint {
  readonly operator: Uint8Array;
  /** Counted from 1 (Construction §C2.4.1). */
  readonly sequence: bigint;
  readonly root: Uint8Array;
}

/** One scope entry with its opening; no opening is the empty book (Construction §C2.7.3). */
export interface SegmentEntry extends ScopeEntry {
  readonly opening?: OpeningCheckpoint;
}

/**
 * What a segment fixes (C2.10.1): the domain, the venue every scoped
 * backing declares, the operator that admits and signs, the sequence of the
 * first commitment it signs for the segment, and the scope with each
 * backing's opening. Its hash is the segment's identity.
 */
export interface SegmentHeader {
  readonly domain: Uint8Array;
  readonly venue: Uint8Array;
  readonly operator: Uint8Array;
  readonly sequence: bigint;
  readonly entries: readonly SegmentEntry[];
}

const U64_BOUND = 1n << 64n;

function isU64(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n && value < U64_BOUND;
}

function isOpening(opening: unknown): opening is OpeningCheckpoint {
  if (typeof opening !== "object" || opening === null) return false;
  const o = opening as Record<string, unknown>;
  return o["operator"] instanceof Uint8Array && isValidPublicKey(o["operator"]) &&
    isU64(o["sequence"]) && o["sequence"] >= 1n &&
    o["root"] instanceof Uint8Array && o["root"].length === KEY_LENGTH;
}

/**
 * Whether `header` is a well-formed segment header (§6): 32-byte domain and
 * venue, a valid operator key, a sequence from 1, a canonical scope of
 * entries each with no opening or a well-formed one, and no opening by this
 * operator at or past this sequence (C2.10.5).
 */
export function isWellFormedHeader(header: unknown): header is SegmentHeader {
  if (typeof header !== "object" || header === null) return false;
  const h = header as Record<string, unknown>;
  if (!(h["domain"] instanceof Uint8Array) || h["domain"].length !== KEY_LENGTH) return false;
  if (!(h["venue"] instanceof Uint8Array) || h["venue"].length !== KEY_LENGTH) return false;
  if (!(h["operator"] instanceof Uint8Array) || !isValidPublicKey(h["operator"])) return false;
  if (!isU64(h["sequence"]) || h["sequence"] < 1n) return false;
  const entries = h["entries"];
  if (!isCanonicalScope(entries)) return false;
  for (let i = 0; i < entries.length; i++) {
    const opening = (entries[i] as unknown as Record<string, unknown>)["opening"];
    if (opening === undefined) continue;
    if (!isOpening(opening)) return false;
    if (compareBytes(opening.operator, h["operator"]) === 0 && opening.sequence >= h["sequence"]) return false;
  }
  return true;
}

/** A header as fresh, frozen copies; throws EncodingError on anything else. */
export function copySegmentHeader(header: SegmentHeader): SegmentHeader {
  if (!isWellFormedHeader(header)) throw new EncodingError("malformed segment header");
  return Object.freeze({
    domain: copyBytes(header.domain),
    venue: copyBytes(header.venue),
    operator: copyBytes(header.operator),
    sequence: header.sequence,
    entries: Object.freeze(header.entries.map((entry) => Object.freeze({
      backing: copyBytes(entry.backing),
      link: copyBytes(entry.link),
      ...(entry.opening === undefined ? {} : {
        opening: Object.freeze({
          operator: copyBytes(entry.opening.operator),
          sequence: entry.opening.sequence,
          root: copyBytes(entry.opening.root),
        }),
      }),
    }))),
  });
}

/**
 * segmentBytes (§6): frame("moe/pool/v2/segment" ‖ configHash ‖ venue ‖ operator ‖ u64 sequence
 * ‖ u32 n ‖ entries), each entry backing ‖ link ‖ u64 openingSequence ‖ openingOperator ‖ openingRoot,
 * with sequence 0 and sixty-four zero bytes for the empty book.
 */
export function segmentBytes(header: SegmentHeader): Uint8Array {
  if (!isWellFormedHeader(header)) throw new EncodingError("malformed segment header");
  const w = new ByteWriter();
  w.context(POOL_SEGMENT_CONTEXT);
  w.key32(header.domain, "configuration hash");
  w.key32(header.venue, "venue id");
  w.key32(header.operator, "operator key");
  w.u64(header.sequence);
  w.u32(header.entries.length);
  const zero = new Uint8Array(KEY_LENGTH);
  for (const entry of header.entries) {
    w.key32(entry.backing, "backing name");
    w.key32(entry.link, "replacement link");
    if (entry.opening === undefined) {
      w.u64(0n);
      w.key32(zero, "opening operator");
      w.key32(zero, "opening root");
    } else {
      w.u64(entry.opening.sequence);
      w.key32(entry.opening.operator, "opening operator");
      w.key32(entry.opening.root, "opening root");
    }
  }
  return w.finish();
}

/** segmentId (§6): the segment's identity in every statement, receipt, history and snapshot. */
export function segmentIdentity(header: SegmentHeader): Uint8Array {
  return sha256(segmentBytes(header));
}

/** Strict inverse of segmentBytes. Throws EncodingError on anything else. */
export function decodeSegmentHeader(bytes: Uint8Array): SegmentHeader {
  const r = new ByteReader(bytes);
  const context = r.raw(POOL_SEGMENT_CONTEXT.length);
  if (context.some((b, i) => b !== POOL_SEGMENT_CONTEXT[i])) throw new EncodingError("not a segment header");
  const domain = r.raw(KEY_LENGTH);
  const venue = r.raw(KEY_LENGTH);
  const operator = r.raw(KEY_LENGTH);
  const sequence = r.u64();
  const count = r.u32();
  if (count < 1 || count > SCOPE_CAPACITY) throw new EncodingError("a segment holds 1 to 65536 entries");
  const entries: SegmentEntry[] = [];
  for (let i = 0; i < count; i++) {
    const backing = r.raw(KEY_LENGTH);
    const link = r.raw(KEY_LENGTH);
    const openingSequence = r.u64();
    const openingOperator = r.raw(KEY_LENGTH);
    const openingRoot = r.raw(KEY_LENGTH);
    if (openingSequence === 0n) {
      if (openingOperator.some((b) => b !== 0) || openingRoot.some((b) => b !== 0)) {
        throw new EncodingError("an empty-book opening is sequence 0 with zero operator and root");
      }
      entries.push({ backing, link });
    } else {
      entries.push({ backing, link, opening: { operator: openingOperator, sequence: openingSequence, root: openingRoot } });
    }
  }
  r.expectEnd();
  const header: SegmentHeader = { domain, venue, operator, sequence, entries };
  if (!isWellFormedHeader(header)) throw new EncodingError("malformed segment header");
  return copySegmentHeader(header);
}

/**
 * What a receipt's verifier derives once from a header (§9): the domain, the
 * segment identity, its scope root and the operator whose signature counts.
 * Strict verification establishes the signature against these; whether the
 * scope and its links were in force is the record's to say (C2.10.8).
 */
export interface SegmentAuthority {
  readonly domain: Uint8Array;
  readonly segment: Uint8Array;
  readonly scopeRoot: bigint;
  readonly operator: Uint8Array;
}

export function segmentAuthority(header: SegmentHeader): SegmentAuthority {
  const copy = copySegmentHeader(header);
  return Object.freeze({
    domain: copy.domain,
    segment: segmentIdentity(copy),
    scopeRoot: new ScopeTree(copy.entries).root(),
    operator: copy.operator,
  });
}

export function copySegmentAuthority(authority: SegmentAuthority): SegmentAuthority {
  if (typeof authority !== "object" || authority === null || !isField(authority.scopeRoot)) {
    throw new EncodingError("malformed segment authority");
  }
  return Object.freeze({
    domain: copyBytes(authority.domain),
    segment: copyBytes(authority.segment),
    scopeRoot: authority.scopeRoot,
    operator: copyBytes(authority.operator),
  });
}

// ---------------------------------------------------------------------------
// Statements (§7)

/** `kind` is 1 for issue, 2 for spend, 3 for burn (§7). */
export type StatementKind = 1 | 2 | 3;
export const ISSUE = 1 as const;
export const SPEND = 2 as const;
export const BURN = 3 as const;
export const STATEMENT_KINDS: readonly StatementKind[] = Object.freeze([ISSUE, SPEND, BURN]);

/** Exactly nine, eleven and thirteen public fields (§7, §13). */
export const PUBLIC_INPUT_COUNT: Readonly<Record<StatementKind, number>> = Object.freeze({ 1: 9, 2: 11, 3: 13 });

/** Proof bytes: nonzero in length, a multiple of 32, at most this (§12). */
export const MAX_PROOF_BYTES = 131072;

export function isStatementKind(kind: unknown): kind is StatementKind {
  return kind === ISSUE || kind === SPEND || kind === BURN;
}

export function isWellFormedProof(proof: unknown): proof is Uint8Array {
  return proof instanceof Uint8Array && proof.length > 0 && proof.length <= MAX_PROOF_BYTES && proof.length % 32 === 0;
}

/**
 * Whether `values` is an array of exactly `count` canonical field elements.
 * By index rather than `every`, which skips a sparse array's holes and would
 * call a list with a hole well-formed.
 */
export function allFields(values: unknown, count: number): values is readonly bigint[] {
  if (!Array.isArray(values) || values.length !== count) return false;
  for (let i = 0; i < count; i++) if (!isField(values[i])) return false;
  return true;
}

/** A statement as submitted, stored and served: kind, public inputs, proof, and K's signature for an issuance. */
export interface Statement {
  readonly kind: StatementKind;
  /** The verifier's order, of exactly the stated length, each a canonical field element. */
  readonly publicInputs: readonly bigint[];
  readonly proof: Uint8Array;
  /** K's strict Ed25519 signature over `statementBytes`; present exactly for an issuance (§7.1). */
  readonly obligorSignature?: Uint8Array;
}

/** Shape only: the field bounds §7 states per position are parsePublicInputs's. */
export function isWellFormedStatement(statement: unknown): statement is Statement {
  if (typeof statement !== "object" || statement === null) return false;
  const s = statement as Record<string, unknown>;
  if (!isStatementKind(s["kind"])) return false;
  if (!allFields(s["publicInputs"], PUBLIC_INPUT_COUNT[s["kind"]])) return false;
  if (!isWellFormedProof(s["proof"])) return false;
  const signature = s["obligorSignature"];
  if (s["kind"] === ISSUE) return signature instanceof Uint8Array && signature.length === SIGNATURE_LENGTH;
  return signature === undefined;
}

export function copyStatement(statement: Statement): Statement {
  if (!isWellFormedStatement(statement)) throw new EncodingError("malformed statement");
  return Object.freeze({
    kind: statement.kind,
    publicInputs: Object.freeze([...statement.publicInputs]),
    proof: copyBytes(statement.proof),
    ...(statement.obligorSignature === undefined ? {} : { obligorSignature: copyBytes(statement.obligorSignature) }),
  });
}

/**
 * What a statement asserts, independently of its proof (§7):
 * frame("moe/pool/v2/statement" ‖ configHash ‖ u8 kind ‖ u32 n ‖ publicInputs).
 * K signs exactly these bytes to authorize an issuance.
 */
export function statementBytes(domain: Uint8Array, kind: StatementKind, publicInputs: readonly bigint[]): Uint8Array {
  if (!isStatementKind(kind)) throw new EncodingError("unknown statement kind");
  if (publicInputs.length !== PUBLIC_INPUT_COUNT[kind]) throw new EncodingError("public-input count does not match the kind");
  const w = new ByteWriter();
  w.context(POOL_STATEMENT_CONTEXT);
  w.key32(domain, "configuration hash");
  w.u8(kind);
  w.u32(publicInputs.length);
  for (const input of publicInputs) w.key32(fieldToBytes(input), "public input");
  return w.finish();
}

/** The statement's identity in admission, receipts, the history and delivery (§7). */
export function statementHash(domain: Uint8Array, kind: StatementKind, publicInputs: readonly bigint[]): Uint8Array {
  return sha256(statementBytes(domain, kind, publicInputs));
}

/**
 * A statement as a record: its statement bytes, then the proof and the
 * obligor's signature, each length-prefixed. The record names its domain,
 * so a trail served for one construction cannot be read as another's.
 */
export function encodeStatement(domain: Uint8Array, statement: Statement): Uint8Array {
  if (!isWellFormedStatement(statement)) throw new EncodingError("malformed statement");
  const w = new ByteWriter();
  w.context(statementBytes(domain, statement.kind, statement.publicInputs));
  w.lengthPrefixed(statement.proof);
  w.lengthPrefixed(statement.obligorSignature ?? new Uint8Array(0));
  return w.finish();
}

/** Strict inverse of encodeStatement. Throws EncodingError on anything else. */
export function decodeStatement(bytes: Uint8Array): { readonly domain: Uint8Array; readonly statement: Statement } {
  const r = new ByteReader(bytes);
  const context = r.raw(POOL_STATEMENT_CONTEXT.length);
  if (context.some((b, i) => b !== POOL_STATEMENT_CONTEXT[i])) throw new EncodingError("not a pool statement record");
  const domain = r.raw(KEY_LENGTH);
  const kind = r.u8();
  if (!isStatementKind(kind)) throw new EncodingError("unknown statement kind");
  const count = r.u32();
  if (count !== PUBLIC_INPUT_COUNT[kind]) throw new EncodingError("public-input count does not match the kind");
  const publicInputs: bigint[] = [];
  for (let i = 0; i < count; i++) publicInputs.push(bytesToField(r.raw(32)));
  const proof = r.lengthPrefixed(MAX_PROOF_BYTES);
  if (!isWellFormedProof(proof)) throw new EncodingError("malformed proof bytes");
  const signature = r.lengthPrefixed(SIGNATURE_LENGTH);
  r.expectEnd();
  if (kind === ISSUE) {
    if (signature.length !== SIGNATURE_LENGTH) throw new EncodingError("an issuance carries the obligor's signature");
    return { domain, statement: Object.freeze({ kind, publicInputs: Object.freeze(publicInputs), proof, obligorSignature: signature }) };
  }
  if (signature.length !== 0) throw new EncodingError("only an issuance carries a signature");
  return { domain, statement: Object.freeze({ kind, publicInputs: Object.freeze(publicInputs), proof }) };
}

/** What every kind's public inputs begin with (§7): the domain, the segment identity and the scope root. */
export interface CommonInputs {
  readonly domain: Uint8Array;
  readonly segment: Uint8Array;
  readonly scopeRoot: bigint;
}

/** The public inputs of an issuance, read by position (§7.1). */
export interface IssueInputs extends CommonInputs {
  readonly kind: 1;
  readonly backing: Uint8Array;
  readonly quantity: bigint;
  readonly anchors: readonly [];
  readonly nullifiers: readonly [];
  readonly outputs: readonly [bigint];
}

/** The public inputs of a spend (§7.2): one anchor per input. */
export interface SpendInputs extends CommonInputs {
  readonly kind: 2;
  readonly anchors: readonly [bigint, bigint];
  readonly nullifiers: readonly [bigint, bigint];
  readonly outputs: readonly [bigint, bigint];
}

/** The public inputs of a burn (§7.3). */
export interface BurnInputs extends CommonInputs {
  readonly kind: 3;
  readonly backing: Uint8Array;
  readonly quantity: bigint;
  readonly anchors: readonly [bigint, bigint];
  readonly nullifiers: readonly [bigint, bigint];
  readonly outputs: readonly [bigint];
}

export type ParsedInputs = IssueInputs | SpendInputs | BurnInputs;

/**
 * Read a statement's public inputs by kind. Limbs must be below 2^128 and a
 * quantity positive and below 2^64 (§7, §13); the circuit proves the same,
 * so this refuses what no valid proof could carry, with the reason named,
 * before the proof is looked at.
 */
export function parsePublicInputs(kind: StatementKind, inputs: readonly bigint[]): ParsedInputs {
  if (!isStatementKind(kind) || !allFields(inputs, PUBLIC_INPUT_COUNT[kind])) {
    throw new EncodingError("public inputs do not match the kind");
  }
  const at = (i: number): bigint => inputs[i] as bigint;
  const common: CommonInputs = { domain: identifierOf(at(0), at(1)), segment: identifierOf(at(2), at(3)), scopeRoot: at(4) };
  if (kind === SPEND) {
    const spend: SpendInputs = { kind, ...common, anchors: [at(5), at(6)], nullifiers: [at(7), at(8)], outputs: [at(9), at(10)] };
    return Object.freeze(spend);
  }
  const backing = identifierOf(at(5), at(6));
  const quantity = at(7);
  if (!isValue(quantity) || quantity === 0n) throw new EncodingError("quantity must be positive and below 2^64");
  if (kind === ISSUE) {
    const issue: IssueInputs = { kind, ...common, backing, quantity, anchors: [], nullifiers: [], outputs: [at(8)] };
    return Object.freeze(issue);
  }
  const burn: BurnInputs = { kind, ...common, backing, quantity, anchors: [at(8), at(9)], nullifiers: [at(10), at(11)], outputs: [at(12)] };
  return Object.freeze(burn);
}

// ---------------------------------------------------------------------------
// The ordered history and the snapshot (§9)

/** historyHash_0 = SHA256("moe/pool/v2/genesis" ‖ segmentId) (§9). */
export function genesisHistoryHash(segment: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  w.context(POOL_GENESIS_CONTEXT);
  w.key32(segment, "segment identity");
  return sha256(w.finish());
}

/**
 * historyHash_i = SHA256("moe/pool/v2/history" ‖ historyHash_{i−1} ‖ statementHash_i
 *                        ‖ noteRoot_i ‖ spentRoot_i ‖ u64 i) (§9), i counted from 1.
 */
export function nextHistoryHash(
  previous: Uint8Array,
  statementHash: Uint8Array,
  noteRoot: bigint,
  spentRoot: Uint8Array,
  position: bigint,
): Uint8Array {
  if (position < 1n) throw new EncodingError("history positions count from one");
  const w = new ByteWriter();
  w.context(POOL_HISTORY_CONTEXT);
  w.key32(previous, "previous history hash");
  w.key32(statementHash, "statement hash");
  w.key32(fieldToBytes(noteRoot), "note root");
  w.key32(spentRoot, "spent root");
  w.u64(position);
  return sha256(w.finish());
}

/** snapshot(b) = SHA256("moe/pool/v2/snapshot" ‖ b ‖ segmentId ‖ historyHash_n ‖ u64 issued(b) ‖ u64 burned(b)) (§9). */
export function snapshotDigest(
  backing: Uint8Array,
  segment: Uint8Array,
  historyHash: Uint8Array,
  issued: bigint,
  burned: bigint,
): Uint8Array {
  const w = new ByteWriter();
  w.context(POOL_SNAPSHOT_CONTEXT);
  w.key32(backing, "backing name");
  w.key32(segment, "segment identity");
  w.key32(historyHash, "history hash");
  w.u64(issued);
  w.u64(burned);
  return sha256(w.finish());
}
