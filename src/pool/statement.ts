// The shielded pool's frames (pool-v1 §§2, 5, 7): the configuration E's hash
// names, the pool identity, what a statement asserts and the hash that is
// its identity, the record a statement is stored and served as, the ordered
// history's hash chain, and the snapshot digest a commitment's directory
// carries per backing.
//
// Every frame is a context string written raw, followed by fixed-width or
// length-prefixed fields in the order pool-v1 lists them, and SHA-256 over
// the frame (§1). contexts.ts asserts the pool's contexts are prefix-free
// among themselves and the rest.
//
// A statement's identity is `statementHash` (§5): two statements with one
// hash are one statement, whatever their proof bytes, which is what makes an
// exact resubmission return its prior receipt (invariant 26). The proof and
// the obligor's signature are evidence the operator verified, bound into the
// receipt by their own hashes (§7), never into the statement's identity.

import { sha256 } from "@noble/hashes/sha2.js";
import { POOL_CONSTRUCTION } from "../backing.js";
import { ByteReader, ByteWriter, copyBytes, EncodingError } from "../bytes.js";
import {
  POOL_CONFIG_CONTEXT,
  POOL_GENESIS_CONTEXT,
  POOL_HISTORY_CONTEXT,
  POOL_IDENTITY_CONTEXT,
  POOL_SNAPSHOT_CONTEXT,
  POOL_STATEMENT_CONTEXT,
} from "../contexts.js";
import { KEY_LENGTH, SIGNATURE_LENGTH } from "../keys.js";
import { bytesToField, fieldToBytes, identifierOf, isField, isValue } from "./field.js";

export { POOL_CONSTRUCTION };

/** The bounds this version fixes inside the configuration hash (§2). */
export const POOL_BOUNDS = Object.freeze({ noteTreeDepth: 32, inputs: 2, outputs: 2 });

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
 * and a verifier pin. It does not name the backings it serves; backings name
 * it, so that a backing's name can contain it.
 */
export interface PoolConfiguration {
  /** The pool identity, `poolIdentity(operator, creationIndex)`. */
  readonly pool: Uint8Array;
  /** The operator's Ed25519 public key. */
  readonly operator: Uint8Array;
  readonly issue: CircuitIdentity;
  readonly spend: CircuitIdentity;
  readonly burn: CircuitIdentity;
  /** SHA-256 of the Poseidon2 helper source (§1). */
  readonly helper: Uint8Array;
}

export function configurationBytes(config: PoolConfiguration): Uint8Array {
  const w = new ByteWriter();
  w.context(POOL_CONFIG_CONTEXT);
  w.key32(config.pool, "pool identity");
  w.key32(config.operator, "operator key");
  for (const kind of ["issue", "spend", "burn"] as const) {
    w.key32(config[kind].bytecode, `${kind} bytecode hash`);
    w.key32(config[kind].vk, `${kind} verification-key hash`);
  }
  w.key32(config.helper, "helper hash");
  w.u8(POOL_BOUNDS.noteTreeDepth);
  w.u8(POOL_BOUNDS.inputs);
  w.u8(POOL_BOUNDS.outputs);
  return w.finish();
}

/** configHash: the 32 bytes E's `configuration` field carries. */
export function configurationHash(config: PoolConfiguration): Uint8Array {
  return sha256(configurationBytes(config));
}

export function copyConfiguration(config: PoolConfiguration): PoolConfiguration {
  const copy = (identity: CircuitIdentity): CircuitIdentity =>
    Object.freeze({ bytecode: copyBytes(identity.bytecode), vk: copyBytes(identity.vk) });
  return Object.freeze({
    pool: copyBytes(config.pool),
    operator: copyBytes(config.operator),
    issue: copy(config.issue),
    spend: copy(config.spend),
    burn: copy(config.burn),
    helper: copyBytes(config.helper),
  });
}

/** SHA256("moe/pool/v1/pool" ‖ operator[32] ‖ u64 creationIndex): one per configuration. */
export function poolIdentity(operator: Uint8Array, creationIndex: bigint): Uint8Array {
  const w = new ByteWriter();
  w.context(POOL_IDENTITY_CONTEXT);
  w.key32(operator, "operator key");
  w.u64(creationIndex);
  return sha256(w.finish());
}

/** `kind` is 1 for issue, 2 for spend, 3 for burn (§5). */
export type StatementKind = 1 | 2 | 3;
export const ISSUE = 1 as const;
export const SPEND = 2 as const;
export const BURN = 3 as const;
export const STATEMENT_KINDS: readonly StatementKind[] = Object.freeze([ISSUE, SPEND, BURN]);

/** Exactly six, seven and nine public fields (§5, §10). */
export const PUBLIC_INPUT_COUNT: Readonly<Record<StatementKind, number>> = Object.freeze({ 1: 6, 2: 7, 3: 9 });

/** Proof bytes: nonzero in length, a multiple of 32, at most this (§9). */
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
  /** K's strict Ed25519 signature over `statementBytes`; present exactly for an issuance (§5.1). */
  readonly obligorSignature?: Uint8Array;
}

/** Shape only: the field bounds §5 states per position are parsePublicInputs's. */
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
 * What a statement asserts, independently of its proof (§5):
 * frame("moe/pool/v1/statement" ‖ configHash ‖ u8 kind ‖ u32 n ‖ publicInputs).
 * K signs exactly these bytes to authorize an issuance.
 */
export function statementBytes(configHash: Uint8Array, kind: StatementKind, publicInputs: readonly bigint[]): Uint8Array {
  if (!isStatementKind(kind)) throw new EncodingError("unknown statement kind");
  if (publicInputs.length !== PUBLIC_INPUT_COUNT[kind]) throw new EncodingError("public-input count does not match the kind");
  const w = new ByteWriter();
  w.context(POOL_STATEMENT_CONTEXT);
  w.key32(configHash, "configuration hash");
  w.u8(kind);
  w.u32(publicInputs.length);
  for (const input of publicInputs) w.key32(fieldToBytes(input), "public input");
  return w.finish();
}

/** The statement's identity in admission, receipts, the history and delivery (§5). */
export function statementHash(configHash: Uint8Array, kind: StatementKind, publicInputs: readonly bigint[]): Uint8Array {
  return sha256(statementBytes(configHash, kind, publicInputs));
}

/**
 * A statement as a record: its statement bytes, then the proof and the
 * obligor's signature, each length-prefixed. The record names its
 * configuration, so a trail served for one pool cannot be read as another's.
 */
export function encodeStatement(configHash: Uint8Array, statement: Statement): Uint8Array {
  if (!isWellFormedStatement(statement)) throw new EncodingError("malformed statement");
  const w = new ByteWriter();
  w.context(statementBytes(configHash, statement.kind, statement.publicInputs));
  w.lengthPrefixed(statement.proof);
  w.lengthPrefixed(statement.obligorSignature ?? new Uint8Array(0));
  return w.finish();
}

/** Strict inverse of encodeStatement. Throws EncodingError on anything else. */
export function decodeStatement(bytes: Uint8Array): { readonly configHash: Uint8Array; readonly statement: Statement } {
  const r = new ByteReader(bytes);
  const context = r.raw(POOL_STATEMENT_CONTEXT.length);
  if (context.some((b, i) => b !== POOL_STATEMENT_CONTEXT[i])) throw new EncodingError("not a pool statement record");
  const configHash = r.raw(KEY_LENGTH);
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
    return { configHash, statement: Object.freeze({ kind, publicInputs: Object.freeze(publicInputs), proof, obligorSignature: signature }) };
  }
  if (signature.length !== 0) throw new EncodingError("only an issuance carries a signature");
  return { configHash, statement: Object.freeze({ kind, publicInputs: Object.freeze(publicInputs), proof }) };
}

/** The public inputs of an issuance, read by position (§5.1). */
export interface IssueInputs {
  readonly kind: 1;
  readonly pool: Uint8Array;
  readonly backing: Uint8Array;
  readonly quantity: bigint;
  readonly nullifiers: readonly [];
  readonly outputs: readonly [bigint];
}

/** The public inputs of a spend (§5.2). */
export interface SpendInputs {
  readonly kind: 2;
  readonly pool: Uint8Array;
  readonly anchor: bigint;
  readonly nullifiers: readonly [bigint, bigint];
  readonly outputs: readonly [bigint, bigint];
}

/** The public inputs of a burn (§5.3). */
export interface BurnInputs {
  readonly kind: 3;
  readonly pool: Uint8Array;
  readonly backing: Uint8Array;
  readonly quantity: bigint;
  readonly anchor: bigint;
  readonly nullifiers: readonly [bigint, bigint];
  readonly outputs: readonly [bigint];
}

export type ParsedInputs = IssueInputs | SpendInputs | BurnInputs;

/**
 * Read a statement's public inputs by kind. Limbs must be below 2^128 and a
 * quantity positive and below 2^64 (§5.1, §5.3, §10); the circuit proves
 * the same, so this refuses what no valid proof could carry, with the reason
 * named, before the proof is looked at.
 */
export function parsePublicInputs(kind: StatementKind, inputs: readonly bigint[]): ParsedInputs {
  if (!isStatementKind(kind) || !allFields(inputs, PUBLIC_INPUT_COUNT[kind])) {
    throw new EncodingError("public inputs do not match the kind");
  }
  const at = (i: number): bigint => inputs[i] as bigint;
  const pool = identifierOf(at(0), at(1));
  if (kind === SPEND) {
    const spend: SpendInputs = { kind, pool, anchor: at(2), nullifiers: [at(3), at(4)], outputs: [at(5), at(6)] };
    return Object.freeze(spend);
  }
  const backing = identifierOf(at(2), at(3));
  const quantity = at(4);
  if (!isValue(quantity) || quantity === 0n) throw new EncodingError("quantity must be positive and below 2^64");
  if (kind === ISSUE) {
    const issue: IssueInputs = { kind, pool, backing, quantity, nullifiers: [], outputs: [at(5)] };
    return Object.freeze(issue);
  }
  const burn: BurnInputs = { kind, pool, backing, quantity, anchor: at(5), nullifiers: [at(6), at(7)], outputs: [at(8)] };
  return Object.freeze(burn);
}

/** historyHash_0 = SHA256("moe/pool/v1/genesis" ‖ configHash) (§7). */
export function genesisHistoryHash(configHash: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  w.context(POOL_GENESIS_CONTEXT);
  w.key32(configHash, "configuration hash");
  return sha256(w.finish());
}

/**
 * historyHash_i = SHA256("moe/pool/v1/history" ‖ historyHash_{i−1} ‖ statementHash_i
 *                        ‖ noteRoot_i ‖ spentRoot_i ‖ u64 i) (§7), i counted from 1.
 */
export function nextHistoryHash(
  previous: Uint8Array,
  statementHash: Uint8Array,
  noteRoot: bigint,
  spentRoot: Uint8Array,
  sequence: bigint,
): Uint8Array {
  if (sequence < 1n) throw new EncodingError("history sequences count from one");
  const w = new ByteWriter();
  w.context(POOL_HISTORY_CONTEXT);
  w.key32(previous, "previous history hash");
  w.key32(statementHash, "statement hash");
  w.key32(fieldToBytes(noteRoot), "note root");
  w.key32(spentRoot, "spent root");
  w.u64(sequence);
  return sha256(w.finish());
}

/** snapshot(b) = SHA256("moe/pool/v1/snapshot" ‖ b ‖ historyHash_n ‖ u64 issued(b) ‖ u64 burned(b)) (§7). */
export function snapshotDigest(backing: Uint8Array, historyHash: Uint8Array, issued: bigint, burned: bigint): Uint8Array {
  const w = new ByteWriter();
  w.context(POOL_SNAPSHOT_CONTEXT);
  w.key32(backing, "backing name");
  w.key32(historyHash, "history hash");
  w.u64(issued);
  w.u64(burned);
  return sha256(w.finish());
}
