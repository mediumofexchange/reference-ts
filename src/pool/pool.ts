// Admission against one committed view, the ordered history, and replay
// (pool-v1 §§6–7; Construction §C1.2).
//
// The pool holds what a stranger can recompute from genesis: the note tree,
// the anchor set, the spent set, per-backing issued and burned totals, the
// accepted statements in order and the history hash that binds them. It
// admits a statement by running §6's checks in order against that state and
// then changing it as one transition; a statement that fails any check
// leaves no trace, and an exact resubmission returns the prior result.
//
// Proof verification is the one asynchronous step, since the proof system
// lives in a WASM backend. So `admit` verifies the proof first, against the
// statement's own bytes and nothing in the pool, and then runs every state
// check and the transition synchronously with no await between them: two
// admissions that interleave at the proof step still see, and change, one
// view each. The verifier is an interface, pinned to the configuration's
// keys by whoever constructs it (barretenberg.ts), so the pool cannot be
// handed a key with a statement (§2); where the verifier can name the
// identities its keys were derived from, the pool refuses a configuration
// naming others (§9).
//
// Supply follows by induction from the empty pool (§C1.2, invariant 12):
// only a verified issuance introduces claims, every spend conserves them
// under a verified proof, every burn subtracts under one. `replay` runs this
// same class over a served trail, verifying every proof and every issuance
// signature itself, and accepts nothing it did not recompute (§7).
//
// Nothing that leaves this class aliases its state. `readonly` is erased at
// runtime and the bytes inside a frozen Backing's arrays are writable, so a
// served backing is rebuilt with makeBacking, the configuration and every
// hash are copied, and the accumulators are reachable only through reads.

import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { makeBacking, verifyBackingSignature, type Backing } from "../backing.js";
import { compareBytes, copyBytes } from "../bytes.js";
import type { SnapshotDigest } from "../commitment.js";
import { isValidPublicKey, verifySignatureStrict } from "../keys.js";
import { fieldToBytes, VALUE_BOUND } from "./field.js";
import { EMPTY_NOTE_ROOT, NOTE_TREE_CAPACITY, NoteTree, type NotePath } from "./note-tree.js";
import { SpentSet } from "./spent-set.js";
import {
  allFields,
  BURN,
  configurationHash,
  copyConfiguration,
  copyStatement,
  genesisHistoryHash,
  ISSUE,
  isStatementKind,
  isWellFormedStatement,
  nextHistoryHash,
  parsePublicInputs,
  POOL_CONSTRUCTION,
  PUBLIC_INPUT_COUNT,
  snapshotDigest,
  statementBytes,
  type CircuitIdentities,
  type ParsedInputs,
  type PoolConfiguration,
  type Statement,
  type StatementKind,
} from "./statement.js";

/**
 * Verifies a proof against the configuration's verification key for its
 * kind and these public inputs, and against nothing else (§6.2). Resolves to
 * exactly `true` for a proof that verifies; anything else, and never a
 * throw, for one that does not.
 */
export interface StatementVerifier {
  verify(kind: StatementKind, publicInputs: readonly bigint[], proof: Uint8Array): Promise<boolean>;
  /**
   * The identities of the circuits whose keys this verifier holds, where it
   * can say (barretenberg.ts derives them). A pool refuses a configuration
   * naming other identities (§9: an implementation refuses a configuration
   * whose identities do not match what it derived).
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
  | "CONFIGURATION";

/** A refused statement, with the §6 check it failed. Refusal changes nothing. */
export class PoolError extends Error {
  constructor(
    readonly code: PoolErrorCode,
    message: string,
    /** In replay, the number of the statement that failed. */
    readonly sequence?: bigint,
  ) {
    super(message);
    this.name = "PoolError";
  }
}

/**
 * What admission records for an accepted statement, and what the receipt
 * (§7) is signed over: the sequence, the statement's identity, the history
 * hash after it, the roots after it, and the hashes of the evidence the
 * operator verified. The operator's signature and `after` are the
 * sequencing layer's.
 */
export interface AcceptedStatement {
  /** The statement's number in the history, counted from 1. */
  readonly sequence: bigint;
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
    sequence: accepted.sequence,
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

interface Totals {
  issued: bigint;
  burned: bigint;
}

/** The served trail (§7): everything a stranger needs to replay from genesis. */
export interface Trail {
  readonly configuration: PoolConfiguration;
  readonly backings: readonly SignedBacking[];
  readonly statements: readonly Statement[];
}

/** Whether `count` more leaves fit under 2^32 when `size` are in use (§4, §6 check 5). */
export function outputsFit(size: bigint, count: number): boolean {
  return size >= 0n && Number.isInteger(count) && count >= 0 && size + BigInt(count) <= NOTE_TREE_CAPACITY;
}

function malformed(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

export class Pool {
  private readonly config: PoolConfiguration;
  private readonly hash: Uint8Array;
  private readonly verifier: StatementVerifier;
  private readonly tree = new NoteTree();
  private readonly anchors = new Set<bigint>([EMPTY_NOTE_ROOT]);
  private readonly spent = new SpentSet();
  private readonly backings = new Map<string, { readonly signed: SignedBacking; readonly totals: Totals }>();
  private readonly accepted = new Map<string, AcceptedStatement>();
  private readonly statements: Statement[] = [];
  private history: Uint8Array;

  constructor(configuration: PoolConfiguration, verifier: StatementVerifier) {
    try {
      this.config = copyConfiguration(configuration);
      this.hash = configurationHash(this.config);
    } catch (cause) {
      throw new PoolError("CONFIGURATION", malformed(cause, "malformed configuration"));
    }
    if (!isValidPublicKey(this.config.operator)) {
      throw new PoolError("CONFIGURATION", "operator key is not a valid non-small-order Ed25519 point");
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
    this.history = genesisHistoryHash(this.hash);
  }

  /** A copy of the configuration this pool serves under. */
  get configuration(): PoolConfiguration {
    return copyConfiguration(this.config);
  }

  /** configHash (§2), copied. */
  get configHash(): Uint8Array {
    return copyBytes(this.hash);
  }

  /** The number of accepted statements, n. */
  get length(): bigint {
    return BigInt(this.statements.length);
  }

  /** historyHash_n. */
  historyHash(): Uint8Array {
    return copyBytes(this.history);
  }

  /** noteRoot_n, the latest anchor. */
  noteRoot(): bigint {
    return this.tree.root();
  }

  /** spentRoot_n. */
  spentRoot(): Uint8Array {
    return this.spent.root();
  }

  /** Whether `anchor` is a root after some accepted statement, or z_32 (§4). */
  isAnchor(anchor: bigint): boolean {
    return this.anchors.has(anchor);
  }

  /** Whether the nullifier is in the spent set. */
  isSpent(nullifier: bigint): boolean {
    return this.spent.has(fieldToBytes(nullifier));
  }

  /** The encoded spent-set proof for a nullifier, member or not (§8). */
  spentProof(nullifier: bigint): Uint8Array {
    return this.spent.proof(fieldToBytes(nullifier));
  }

  /** Every leaf in acceptance order: what a wallet syncs to compute its own paths (§4). */
  leaves(): readonly bigint[] {
    return this.tree.leaves();
  }

  /** The leaf at a position, or undefined past the used leaves. */
  leaf(position: bigint): bigint | undefined {
    return this.tree.leaf(position);
  }

  /** The path for a used leaf against the current root; a wallet computes the same from `leaves()`. */
  path(position: bigint): NotePath {
    return this.tree.path(position);
  }

  /**
   * Take on a backing whose E names this operator and this configuration,
   * with the obligor's signature over its name. Idempotent for the same
   * backing. The pool keeps its own copy of the terms: issuance reads
   * authority from the registered obligor.
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
      compareBytes(evidence.configuration, this.hash) !== 0 ||
      compareBytes(evidence.operator, this.config.operator) !== 0
    ) {
      throw new PoolError("BACKING", "this backing's E does not name this operator and configuration");
    }
    if (this.backings.has(stored.nameHex)) return;
    this.backings.set(stored.nameHex, {
      signed: Object.freeze({ backing: stored, signature: copyBytes(signature) }),
      totals: { issued: 0n, burned: 0n },
    });
  }

  /** The signed terms of a backing this pool serves, by name, as fresh copies. */
  backing(name: Uint8Array): SignedBacking | undefined {
    const held = this.backings.get(bytesToHex(name));
    return held === undefined
      ? undefined
      : { backing: makeBacking(held.signed.backing), signature: copyBytes(held.signed.signature) };
  }

  issued(name: Uint8Array): bigint | undefined {
    return this.backings.get(bytesToHex(name))?.totals.issued;
  }

  burned(name: Uint8Array): bigint | undefined {
    return this.backings.get(bytesToHex(name))?.totals.burned;
  }

  /** outstanding(b) = issued(b) − burned(b) (invariant 10). */
  outstanding(name: Uint8Array): bigint | undefined {
    const totals = this.backings.get(bytesToHex(name))?.totals;
    return totals === undefined ? undefined : totals.issued - totals.burned;
  }

  /** snapshot(b) at the pool's current length (§7), for a served backing. */
  snapshot(name: Uint8Array): Uint8Array | undefined {
    const totals = this.backings.get(bytesToHex(name))?.totals;
    return totals === undefined ? undefined : snapshotDigest(name, this.history, totals.issued, totals.burned);
  }

  /**
   * The directory a commitment authenticates (§C2.4.2): every served backing
   * with its snapshot digest, by name. The set of served backings is the
   * commitment's to bind, not the history's: a backing no statement names
   * changes no history hash, and a replayer compares directories, not only
   * history hashes, to check what an operator committed to serving.
   */
  directory(): SnapshotDigest[] {
    return [...this.backings.values()]
      .map(({ signed, totals }) => ({
        name: copyBytes(signed.backing.name),
        digest: snapshotDigest(signed.backing.name, this.history, totals.issued, totals.burned),
      }))
      .sort((a, b) => compareBytes(a.name, b.name));
  }

  /** The accepted statement with this identity, if any. */
  acceptedStatement(statementHash: Uint8Array): AcceptedStatement | undefined {
    const found = this.accepted.get(bytesToHex(statementHash));
    return found === undefined ? undefined : copyAccepted(found);
  }

  /** The served trail: configuration, every backing's signed terms, and every statement in order with its evidence. */
  trail(): Trail {
    return {
      configuration: copyConfiguration(this.config),
      backings: [...this.backings.values()].map(({ signed }) => ({
        backing: makeBacking(signed.backing),
        signature: copyBytes(signed.signature),
      })),
      statements: this.statements.map(copyStatement),
    };
  }

  /**
   * Admit one statement (§6). Returns the accepted record, the same one for
   * an exact resubmission; throws PoolError, changing nothing, for a
   * statement that fails a check.
   */
  async admit(statement: Statement): Promise<AcceptedStatement> {
    // Check 1, on what the statement asserts: kind, count, canonical fields,
    // ranges, and this pool. The evidence is not read yet.
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
    const hash = sha256(statementBytes(this.hash, kind, publicInputs));
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
    if (compareBytes(inputs.pool, this.config.pool) !== 0) throw new PoolError("MALFORMED", "statement names another pool");
    return inputs;
  }

  /** Checks 3–5 and the transition, synchronously. */
  private apply(statement: Statement, inputs: ParsedInputs, hash: Uint8Array): AcceptedStatement {
    // Check 3: the backing, the obligor's authority, and the supply bounds.
    let totals: Totals | undefined;
    if (inputs.kind !== 2) {
      const held = this.backings.get(bytesToHex(inputs.backing));
      if (held === undefined) throw new PoolError("BACKING", "the backing is not served in this pool");
      totals = held.totals;
      if (inputs.kind === ISSUE) {
        const message = statementBytes(this.hash, statement.kind, statement.publicInputs);
        if (!verifySignatureStrict(statement.obligorSignature as Uint8Array, message, held.signed.backing.obligor)) {
          throw new PoolError("SIGNATURE", "the obligor did not sign this issuance");
        }
        if (totals.issued + inputs.quantity >= VALUE_BOUND) throw new PoolError("SUPPLY", "issued total would reach 2^64");
      } else if (totals.issued - totals.burned < inputs.quantity) {
        throw new PoolError("SUPPLY", "burn exceeds the backing's outstanding claims");
      }
    }
    // Check 4: the anchor is one of this pool's own roots; no nullifier is spent; the nullifiers are distinct.
    if (inputs.kind !== ISSUE) {
      if (!this.anchors.has(inputs.anchor)) throw new PoolError("ANCHOR", "anchor is not an accepted root of this pool");
      const [first, second] = inputs.nullifiers;
      if (first === second) throw new PoolError("SPENT", "a statement's nullifiers must be distinct");
      for (const nullifier of inputs.nullifiers) {
        if (this.spent.has(fieldToBytes(nullifier))) throw new PoolError("SPENT", "nullifier already spent");
      }
    }
    // Check 5: every output is new, the outputs are distinct, and they fit.
    const outputs: readonly bigint[] = inputs.outputs;
    if (new Set(outputs).size !== outputs.length) throw new PoolError("OUTPUT", "a statement's outputs must be distinct");
    for (const output of outputs) {
      if (output === 0n || this.tree.has(output)) throw new PoolError("OUTPUT", "output commitment is not new");
    }
    if (!outputsFit(this.tree.size, outputs.length)) throw new PoolError("CAPACITY", "the note tree cannot hold these outputs");
    // The transition, as one: outputs appended in order, nullifiers inserted,
    // totals moved, the statement appended, the history hash advanced.
    this.tree.appendAll(outputs);
    this.anchors.add(this.tree.root());
    for (const nullifier of inputs.nullifiers) this.spent.insert(fieldToBytes(nullifier));
    if (inputs.kind === ISSUE && totals !== undefined) totals.issued += inputs.quantity;
    if (inputs.kind === BURN && totals !== undefined) totals.burned += inputs.quantity;
    this.statements.push(statement);
    const sequence = BigInt(this.statements.length);
    const noteRoot = this.tree.root();
    const spentRoot = this.spent.root();
    this.history = nextHistoryHash(this.history, hash, noteRoot, spentRoot, sequence);
    const record: AcceptedStatement = Object.freeze({
      sequence,
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
    return copyAccepted(record);
  }

  /**
   * Replay a served trail from genesis (§7): every check of §6 run again,
   * every proof and issuance signature verified by `verifier`. Stops at the
   * first statement that fails, throwing that statement's PoolError with its
   * number, and accepts nothing it did not recompute. A replayed prefix
   * proves only itself; which history is current is the witnessed
   * commitment's to say (§C2).
   */
  static async replay(trail: Trail, verifier: StatementVerifier): Promise<Pool> {
    const pool = new Pool(trail.configuration, verifier);
    for (const { backing, signature } of trail.backings) pool.register(backing, signature);
    let sequence = 0n;
    for (const statement of trail.statements) {
      sequence += 1n;
      let accepted: AcceptedStatement;
      try {
        accepted = await pool.admit(statement);
      } catch (cause) {
        if (cause instanceof PoolError) throw new PoolError(cause.code, `statement ${sequence}: ${cause.message}`, sequence);
        throw cause;
      }
      // A trail that repeats a statement is not the history: an exact
      // resubmission is answered with its prior record, which numbers it
      // earlier than its place in the trail.
      if (accepted.sequence !== sequence) {
        throw new PoolError("MALFORMED", `statement ${sequence} repeats statement ${accepted.sequence}`, sequence);
      }
    }
    return pool;
  }
}
