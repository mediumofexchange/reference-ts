// One pool-v3 §5 record applied to a segment's replayed state: the note
// forest, the compressed spent set, outputs, supply totals, standing demands
// and locks, spent tags, and the history and evidence chains (§7). Every
// refusal is named. It is the v3 state machine of the runtime plan
// (decisions 2026-09-25); its callers differ in the index they judge at and in
// which checks apply:
//
// | Mode     | Judged at                          | Proof, signature, context, anchor, recovery | State and supply |
// |----------|------------------------------------|---------------------------------------------|------------------|
// | replay   | the checkpoint's witnessed index    | yes; door deadlines not re-judged (C3.8)    | yes              |
// | adoption | an adopted publication's own index  | no: exact bytes the force judgment verified | yes              |
//
// Admission (the operator, at the horizon) and publication force (the
// reader, C2b.3.2) join as modes when their callers land.
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes } from "../../bytes.js";
import { verifySignatureStrict } from "../../keys.js";
import { fieldToBytes, identifierOf, VALUE_BOUND } from "../field.js";
import { EMPTY_NOTE_ROOT, NOTE_TREE_CAPACITY, NoteTree } from "../note-tree.js";
import { genesisEvidenceHash, genesisHistoryHash, nextEvidenceHash, nextHistoryHash } from "./commitments.js";
import { decodeRecord, evidenceHashes, statementBytes, statementHash, type EvidenceDigests, type Record } from "./records.js";
import { applyRecovery, checkRecovery, effectOf, recoveryState, tagOf, type RecoveryState } from "./recovery.js";
import { EvidenceRefusal, requireReplay } from "./refusals.js";
import { RadixSpentSet } from "./spent-set.js";
import type { RootTerms } from "./terms.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

export type StepMode = "replay" | "adoption";

/** The reader's proof verifier: true only for a proof of `kind` over exactly these public inputs. */
export interface ProofCheck {
  verify(kind: number, publicInputs: bigint[], proof: Uint8Array): Promise<boolean> | boolean;
}
/** An output a receiver may scan: its capsule, or for a settlement the record naming its owner. */
export interface ScanOutput { readonly cm: bigint; readonly capsule?: Uint8Array | undefined; readonly settlement?: Record }
export interface OutputLocation { readonly leaf: bigint; readonly tree: NoteTree }
export interface Totals { issued: bigint; burned: bigint }
/** One replayed record as later imports see it, keyed `segment:position`. */
export interface ReplayEvent {
  readonly identity: string;
  readonly record: Record;
  readonly segment: string;
  readonly position: bigint;
  /** The imported frontier the event's segment replayed over: segment → last imported position. */
  readonly ancestry: ReadonlyMap<string, bigint>;
  readonly tags: readonly bigint[];
  readonly demand: string | undefined;
}
/** The receipt's event, for a receipt read naming this segment and position (C2.10.9a). */
export interface ReceiptEvent extends EvidenceDigests {
  readonly position: bigint;
  readonly historyHash: Uint8Array;
}
/** The last valid checkpoint of a segment: the replay must reach it and reproduce its hashes (C2.10.12). */
export interface LastValid {
  readonly position: bigint;
  readonly historyHash: Uint8Array;
  readonly evidenceHash: Uint8Array;
  /** The index each of its records was judged at. */
  readonly eventIndices?: readonly (bigint | undefined)[];
}
/** A record of the segment's adopted block: its exact admitted bytes and its publication's index (C2b.4.1). */
export interface Adopted { readonly bytes: Uint8Array; readonly index: bigint }

/** The state one segment replay carries from record to record. */
export interface SegmentState extends RecoveryState {
  readonly tree: NoteTree;
  readonly spent: RadixSpentSet;
  readonly anchors: Set<bigint>;
  readonly nullifiers: Set<bigint>;
  readonly outputsSeen: Set<bigint>;
  readonly statements: Set<string>;
  readonly outputPositions: Map<bigint, OutputLocation>;
  readonly scanOutputs: ScanOutput[];
  readonly totals: Map<string, Totals>;
  readonly events: Map<string, ReplayEvent>;
  readonly eventIndices: (bigint | undefined)[];
  readonly ancestry: ReadonlyMap<string, bigint>;
  position: bigint;
  history: Uint8Array;
  evidence: Uint8Array;
  receiptEvent: ReceiptEvent | undefined;
}

/** A finished replay's state as a later replay resumes from it or imports it. */
export interface ReplayedState extends RecoveryState {
  readonly tree: NoteTree;
  readonly spent: RadixSpentSet;
  readonly anchors: ReadonlySet<bigint>;
  readonly nullifiers: ReadonlySet<bigint>;
  readonly outputsSeen: ReadonlySet<bigint>;
  readonly statements: ReadonlySet<string>;
  readonly outputPositions: ReadonlyMap<bigint, OutputLocation>;
  readonly scanOutputs: readonly ScanOutput[];
  readonly totals: ReadonlyMap<string, Totals>;
  readonly events: ReadonlyMap<string, ReplayEvent>;
  readonly eventIndices: readonly (bigint | undefined)[];
  readonly ancestry: ReadonlyMap<string, bigint>;
  readonly position: bigint;
  readonly history: Uint8Array;
  readonly receiptEvent: ReceiptEvent | undefined;
}
/** What a replay imports: a checkpoint's replayed state or finalized prefixes merged from several. */
export interface ImportedState extends Partial<RecoveryState> {
  readonly anchors?: Iterable<bigint>;
  readonly nullifiers?: Iterable<bigint>;
  readonly outputsSeen?: Iterable<bigint>;
  readonly outputPositions?: Iterable<readonly [bigint, OutputLocation]>;
  readonly scanOutputs?: readonly ScanOutput[];
  readonly events?: Iterable<readonly [string, ReplayEvent]>;
  readonly totals?: Iterable<readonly [string, Totals]>;
}

/**
 * The state a segment replay starts from: a copy of `base`, a valid earlier
 * checkpoint of this segment whose records the trail repeats (C2.10.12), or
 * else the `imported` frontier, or else the empty state. Building a fresh
 * replay's ancestry reads each imported event once, charged to `chargeEvents`.
 */
export function openSegmentState(segment: Uint8Array, base: ReplayedState | undefined, imported: ImportedState | undefined,
  lastValid: LastValid | undefined, chargeEvents: (amount: bigint) => void): SegmentState {
  const from: ImportedState | undefined = base ?? imported;
  const tree = base?.tree.clone() ?? new NoteTree(), spent = base?.spent.fork() ?? new RadixSpentSet();
  const anchors = new Set(from?.anchors ?? [EMPTY_NOTE_ROOT]);
  const nullifiers = new Set(from?.nullifiers), outputsSeen = new Set(from?.outputsSeen);
  if (base === undefined) for (const nf of nullifiers) spent.insert(fieldToBytes(nf));
  const statements = new Set(base?.statements), outputPositions = new Map(from?.outputPositions), scanOutputs = [...(from?.scanOutputs ?? [])];
  // The resumed prefix's local outputs belong to this replay's own tree copy.
  if (base !== undefined) {
    for (const [cm, location] of outputPositions) if (location.tree === base.tree) outputPositions.set(cm, { leaf: location.leaf, tree });
  }
  const recovery = recoveryState(from), eventIndices = [...(base?.eventIndices ?? [])];
  const events = new Map(from?.events), totals = new Map([...(from?.totals ?? [])].map(([key, value]) => [key, { ...value }]));
  // One immutable imported frontier per local segment replay, shared by its
  // events. Local positions order themselves without quadratic ancestor sets.
  // Building it reads each imported event once; a resumed replay reuses it.
  let ancestry = base?.ancestry;
  if (ancestry === undefined) {
    const built = new Map<string, bigint>();
    for (const event of new Map(imported?.events).values()) {
      chargeEvents(1n);
      if (event.segment !== undefined && (built.get(event.segment) ?? 0n) < event.position) built.set(event.segment, event.position);
    }
    ancestry = built;
  }
  return { tree, spent, anchors, nullifiers, outputsSeen, statements, outputPositions, scanOutputs, ...recovery, events, totals,
    eventIndices, ancestry, position: base?.position ?? 0n, receiptEvent: base?.receiptEvent,
    history: base?.history ?? genesisHistoryHash(segment),
    evidence: base === undefined ? genesisEvidenceHash(segment) : lastValid!.evidenceHash };
}

/** What stays fixed while one segment's trail replays. */
export interface SegmentReplay {
  /** The configuration's domain and the selected backing. */
  readonly domain: Uint8Array;
  readonly backing: Uint8Array;
  /** The segment's identity and its scope root. */
  readonly segment: Uint8Array;
  readonly scope: bigint;
  /** The selected backing's terms, and for a multi-backing scope each scoped backing's by name. */
  readonly terms: RootTerms;
  readonly scopedTerms?: ReadonlyMap<string, RootTerms | undefined> | undefined;
  readonly verifier: ProofCheck;
  /** The checkpoint's witnessed index; undefined for a read without venue answers. */
  readonly index?: bigint | undefined;
  /** K's revocation index (C2b.1), or per scoped backing. */
  readonly revokedAt?: bigint | undefined;
  readonly revocations?: ReadonlyMap<string, bigint | undefined> | undefined;
  readonly lastValid?: LastValid | undefined;
  /** The adopted block, by position from the segment's first record. */
  readonly block: readonly Adopted[];
  readonly contextReceipt?: { readonly position: bigint; readonly segment: Uint8Array } | undefined;
}

/** The mode a position replays in: exact adopted bytes inside the adopted block, replay after it. */
export function modeAt(replay: SegmentReplay, position: bigint): StepMode {
  return replay.block[Number(position)] === undefined ? "replay" : "adoption";
}

/**
 * Apply the record at `state.position` (C2.10.12, pool-v3 §§5, 7). Every
 * guard reads the same pre-state and the state changes only after all of them
 * pass, but for the last check, which compares the new history hash with the
 * last valid checkpoint's; a caller discards the state on any refusal. A deterministic failure throws
 * ReplayRefusal with its check, an unsupported kind or an unindexed recovery
 * record EvidenceRefusal; the verifier's own failures propagate.
 */
export async function applyRecord(state: SegmentState, bytes: Uint8Array, replay: SegmentReplay): Promise<void> {
  const { position } = state, mode = modeAt(replay, position), adopted = replay.block[Number(position)];
  const record = decodeRecord(bytes), p = record.publicInputs, kind = record.kind;
  if (![1, 2, 3, 4, 5, 6].includes(kind)) throw new EvidenceRefusal("unsupported-scope");
  const demandId = kind === 5 || kind === 6 ? hex(identifierOf(p[kind === 5 ? 5 : 15]!, p[kind === 5 ? 6 : 16]!)) : undefined;
  const demand = demandId === undefined ? undefined : state.demands.get(demandId);
  const backing = kind === 5 ? demand?.backing ?? replay.backing : kind !== 2 ? identifierOf(p[5]!, p[6]!) : replay.backing;
  const ownTerms = replay.scopedTerms === undefined ? replay.terms : replay.scopedTerms.get(hex(backing));
  const issuerKey = ownTerms?.obligor ?? replay.terms.obligor;
  const key = hex(backing), total = state.totals.get(key) ?? { issued: 0n, burned: 0n };
  const scoped = replay.scopedTerms !== undefined;
  // Exact admitted bytes, including proof and authorization, survive adoption.
  if (mode === "adoption") requireReplay(same(bytes, adopted!.bytes), "ADOPTION");
  else {
    requireReplay(same(record.domain, replay.domain) && same(identifierOf(p[2]!, p[3]!), replay.segment), "CONTEXT");
    requireReplay(p[4] === replay.scope, "SCOPE");
  }
  if (kind !== 2) requireReplay(ownTerms !== undefined, "BACKING");
  if (kind === 5) requireReplay(demand !== undefined && (scoped || same(backing, replay.backing)), "DEMAND");
  const lastValid = replay.lastValid;
  const at = adopted?.index ?? lastValid?.eventIndices?.[Number(position)] ?? replay.index;
  if (kind >= 4 && at === undefined) throw new EvidenceRefusal("unsupported-scope");
  const identity = statementHash(record), id = hex(identity);
  requireReplay(!state.statements.has(id), "REPEATED_STATEMENT");
  const evidence = nextEvidenceHash(state.evidence, evidenceHashes(record), position + 1n);
  if (lastValid !== undefined && position + 1n === lastValid.position) requireReplay(same(evidence, lastValid.evidenceHash), "CONTINUITY");
  // Issuance witnessed at or after K's revocation is void (C2b.1). A position
  // the last valid checkpoint finalized was witnessed at its index, not here.
  if (kind === 1 && replay.index !== undefined && (lastValid === undefined || position + 1n > lastValid.position)) {
    const cutoff = replay.revocations === undefined ? replay.revokedAt : replay.revocations.get(hex(backing));
    requireReplay(cutoff === undefined || cutoff > replay.index, "REVOKED");
  }
  if (mode === "replay" && kind !== 5) requireReplay(await replay.verifier.verify(kind, [...p], new Uint8Array(record.proof)) === true, "PROOF");
  if (kind !== 2 && kind !== 5) {
    requireReplay(scoped || same(backing, replay.backing), "BACKING");
    if (kind === 1) {
      requireReplay(verifySignatureStrict(record.authorization, statementBytes(record), issuerKey), "SIGNATURE");
      requireReplay(total.issued + p[7]! < VALUE_BOUND, "SUPPLY");
    } else if (kind === 3) requireReplay(p[7]! <= total.issued - total.burned, "SUPPLY");
  }
  const { nfs, roots, outputs } = effectOf(record);
  if (mode === "replay") {
    requireReplay(roots.every(root => state.anchors.has(root)), "ANCHOR");
    checkRecovery(record, state, { check: requireReplay, backing, issuer: issuerKey, at });
  }
  requireReplay(new Set(nfs).size === nfs.length && nfs.every(nf => nf !== 0n && !state.spent.has(fieldToBytes(nf))), "SPENT");
  requireReplay(new Set(outputs).size === outputs.length && outputs.every(cm => cm !== 0n && !state.outputsSeen.has(cm)), "OUTPUT");
  requireReplay(state.tree.size + BigInt(outputs.length) <= NOTE_TREE_CAPACITY && position + 1n < VALUE_BOUND, "CAPACITY");

  const leaves = state.tree.appendAll(outputs);
  outputs.forEach((cm, i) => {
    state.outputsSeen.add(cm);
    state.outputPositions.set(cm, { leaf: leaves[i]!, tree: state.tree });
    state.scanOutputs.push(kind === 6 ? { cm, settlement: record } : { cm, capsule: record.capsules[i] });
  });
  nfs.forEach(nf => { state.spent.insert(fieldToBytes(nf)); state.nullifiers.add(nf); });
  applyRecovery(record, state);
  state.eventIndices.push(at);
  state.totals.set(key, total);
  if (kind === 1) total.issued += p[7]!;
  if (kind === 3) total.burned += p[7]!;
  const next = position + 1n;
  state.position = next;
  state.evidence = evidence;
  const tags = kind === 4 ? p.slice(10, 12).filter(tag => tag !== 0n) :
    kind === 5 ? demand?.tags.filter(tag => tag !== 0n) ?? [] : nfs.map(tagOf);
  state.events.set(`${hex(replay.segment)}:${next}`, { identity: id, record, segment: hex(replay.segment), position: next,
    ancestry: state.ancestry, tags, demand: kind === 4 ? id : demandId });
  state.anchors.add(state.tree.root()); state.statements.add(id);
  state.history = nextHistoryHash(state.history, identity, state.tree.root(), state.spent.root(), next);
  if (replay.contextReceipt?.position === next && same(replay.contextReceipt.segment, replay.segment)) {
    const { statementHash: statement, proofHash, signatureHash } = evidenceHashes(record);
    state.receiptEvent = { position: next, statementHash: statement, historyHash: state.history, proofHash, signatureHash };
  }
  if (lastValid !== undefined && next === lastValid.position) requireReplay(same(state.history, lastValid.historyHash), "CONTINUITY");
}
