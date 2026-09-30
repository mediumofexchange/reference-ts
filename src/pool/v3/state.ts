// One pool-v3 §5 record applied to a segment's replayed state: the note
// forest, the compressed spent set, outputs, supply totals, standing demands
// and locks, spent tags, and the history and evidence chains (§7). Every
// refusal is named. It is the v3 state machine of the runtime plan
// (decisions 2026-09-25); its callers differ in the index they judge at and in
// which checks apply:
//
// | Mode      | Judged at                          | Proof, context, anchor, recovery guards      | Issuer signature, revocation, supply, spent, outputs |
// |-----------|------------------------------------|----------------------------------------------|------------------------------------------------------|
// | admission | the horizon: read index plus lag    | yes; door deadlines apply                   | yes                                                  |
// | replay    | the checkpoint's witnessed index    | yes; door deadlines not re-judged (C3.8)     | yes                                                  |
// | adoption  | an adopted publication's own index  | no: exact bytes the force judgment verified  | yes                                                  |
// | force     | the publication's witnessed index  | yes; door deadlines apply                   | spent/outputs and recovery effects only               |
//
// The state lives in a ReplayStore (replay-store.ts, storage decision
// 2026-09-29): a judgment reads the pre-state and returns the effects, and the
// apply writes them synchronously, so a refusal writes nothing. Force keeps
// the snapshot's anchors fixed; it is an in-memory overlay with no tree or history.
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes } from "../../bytes.js";
import { verifySignatureStrict } from "../../keys.js";
import { identifierOf, VALUE_BOUND } from "../field.js";
import { EMPTY_NOTE_ROOT, NOTE_TREE_CAPACITY, type NotePath } from "../note-tree.js";
import { genesisEvidenceHash, genesisHistoryHash, nextEvidenceHash, nextHistoryHash } from "./commitments.js";
import { decodeRecord, evidenceHashes, statementBytes, statementHash, type EvidenceDigests, type Record } from "./records.js";
import { checkRecovery, effectOf, recoveryEffect, tagOf, type Demand, type RecoveryView } from "./recovery.js";
import { EvidenceRefusal, requireReplay } from "./refusals.js";
import type { ImportEntry, Imports, ReplayStore, StoredEvent, StoredOutput, Totals } from "./replay-store.js";
import type { RootTerms } from "./terms.js";

export type { Totals } from "./replay-store.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

export type StepMode = "admission" | "replay" | "adoption" | "force";

/** The reader's proof verifier: true only for a proof of `kind` over exactly these public inputs. Its circuits'
 * identities, where it declares them, name it in kept state (§14); an undeclared one is named per object. */
export interface ProofCheck {
  verify(kind: number, publicInputs: bigint[], proof: Uint8Array): Promise<boolean> | boolean;
  readonly identities?: { readonly [name: string]: { readonly bytecode: Uint8Array; readonly vk: Uint8Array; readonly kind?: number } } | undefined;
}

/** What the guards read of a state: note membership and recovery state. */
export interface StateView extends RecoveryView {
  hasNullifier(nf: bigint): boolean;
  hasOutput(cm: bigint): boolean;
  hasAnchor(root: bigint): boolean;
}

/** An output a receiver may scan: its capsule, or for a settlement the record naming its owner. */
export interface ScanOutput { readonly cm: bigint; readonly capsule?: Uint8Array | undefined; readonly settlement?: Record }
/** Which outputs a replay keeps incremental witnesses for (a wallet's own). The identity it declares names it in kept
 * state (§14), so it must fix exactly which outputs the predicate accepts; an undeclared one is named per object. */
export type WitnessPredicate = ((output: ScanOutput) => boolean) & { readonly identity?: Uint8Array | undefined };
/** The receipt's event, for a receipt read naming this segment and position (C2.10.9a). */
export interface ReceiptEvent extends EvidenceDigests {
  readonly position: bigint;
  readonly historyHash: Uint8Array;
}
/** A witnessed output's path against its segment's root; `local` where that segment is the read's own. */
export interface OutputPath { readonly leaf: bigint; readonly anchor: bigint; readonly path: NotePath; readonly local: boolean }

/**
 * One segment's replay state in a store: its namespace read at a fixed
 * position, or at the tip while a replay moves it. Every read is bounded by
 * that position and reads imports up to their imported positions.
 */
export class StateHandle implements StateView {
  readonly store: ReplayStore;
  readonly ns: number;
  readonly #at: bigint | undefined;
  constructor(store: ReplayStore, ns: number, at?: bigint) { this.store = store; this.ns = ns; this.#at = at; }

  get position(): bigint { return this.#at ?? this.store.tip(this.ns).position; }
  get segment(): Uint8Array { return this.store.tip(this.ns).segment; }
  /** This namespace's state at `position`, fixed while its tip moves on. */
  at(position: bigint): StateHandle { return new StateHandle(this.store, this.ns, position); }
  #event(): StoredEvent | undefined { const p = this.position; return p === 0n ? undefined : this.store.event(this.ns, p); }
  get history(): Uint8Array {
    if (this.#at === undefined) return this.store.tip(this.ns).history;
    return this.#event()?.history ?? genesisHistoryHash(this.segment);
  }
  get evidence(): Uint8Array {
    if (this.#at === undefined) return this.store.tip(this.ns).evidence;
    return this.#event()?.evidence ?? genesisEvidenceHash(this.segment);
  }
  noteRoot(): bigint {
    if (this.#at === undefined) return this.store.tip(this.ns).noteRoot;
    return this.#event()?.noteRoot ?? EMPTY_NOTE_ROOT;
  }
  spentRoot(): Uint8Array {
    if (this.#at === undefined) return this.store.tip(this.ns).spentRoot;
    return this.#event()?.spentRoot ?? this.store.baseSpentRoot(this.ns);
  }
  /** Leaves in this segment's own note tree, at the tip. */
  get leaves(): bigint { return this.store.tip(this.ns).leaves; }

  hasNullifier(nf: bigint): boolean { return this.store.hasNullifier(this.ns, this.position, nf); }
  hasOutput(cm: bigint): boolean { return this.store.hasOutput(this.ns, this.position, cm); }
  hasAnchor(root: bigint): boolean { return this.store.hasAnchor(this.ns, this.position, root); }
  hasSpentTag(tag: bigint): boolean { return this.store.hasSpentTag(this.ns, this.position, tag); }
  isEffective(id: string): boolean { return this.store.isEffective(this.ns, this.position, id); }
  hasStatement(identity: Uint8Array): boolean { return this.store.hasStatement(this.ns, this.position, identity); }
  /** An issuance of `backing` (hex) among this segment's own records after position `after`. */
  hasIssuanceAfter(after: bigint, backing: string): boolean { return this.store.hasIssuance(this.ns, this.position, after, backing); }
  demand(id: string): Demand | undefined { return this.store.demand(this.ns, this.position, id); }
  demandsWithTag(tag: bigint): [string, Demand][] { return this.store.demandsWithTag(this.ns, this.position, tag); }
  demands(): [string, Demand][] { return this.store.demands(this.ns, this.position); }
  total(backing: string): Totals { return this.store.total(this.ns, this.position, backing); }
  totals(): Map<string, Totals> { return this.store.totals(this.ns, this.position); }
  nullifiers(): bigint[] { return [...this.store.nullifiers(this.ns, this.position)]; }
  events(): Generator<StoredEvent> { return this.store.events(this.ns, this.position); }
  eventCount(): bigint { return this.store.eventCount(this.ns, this.position); }
  /** The index each own record was judged at, by position from 1. */
  eventIndices(): (bigint | undefined)[] { return this.store.judgedIndices(this.ns, this.position); }
  judgedIndex(position: bigint): bigint | undefined {
    return position < 1n || position > this.position ? undefined : this.store.event(this.ns, position)?.index;
  }
  /** Imported segments (hex) → namespace and position; this segment itself excluded. */
  imports(): Map<string, ImportEntry> { return this.store.imports(this.ns); }
  /** The frontier a successor importing this state reads. */
  frontier(): Imports {
    const segments = this.imports();
    segments.set(hex(this.segment), { ns: this.ns, upto: this.position });
    return { segments, totals: this.totals() };
  }
  /** Every visible output in scan order, imports first; a settlement carries its record. */
  *outputs(): Generator<ScanOutput> {
    for (const stored of this.store.outputs(this.ns, this.position)) yield this.scanOutput(stored);
  }
  /** The visible output `cm`, as a receiver scans it. */
  output(cm: bigint): ScanOutput | undefined {
    const stored = this.store.output(this.ns, this.position, cm);
    return stored === undefined ? undefined : this.scanOutput(stored);
  }
  scanOutput(stored: StoredOutput): ScanOutput {
    return stored.settlement ? { cm: stored.cm, settlement: decodeRecord(this.store.event(stored.ns, stored.position)!.settlement!) } :
      { cm: stored.cm, capsule: stored.capsule };
  }
  /** The path of an output the replay witnessed, against the root of the segment holding it. */
  path(cm: bigint): OutputPath | undefined {
    const output = this.store.output(this.ns, this.position, cm);
    if (output === undefined) return undefined;
    const upto = output.ns === this.ns ? this.position : this.imports().get(hex(this.store.tip(output.ns).segment))?.upto;
    if (upto === undefined) return undefined;
    const witness = this.store.witness(output.ns, upto, output.leaf);
    return witness === undefined ? undefined : { leaf: witness.leaf, anchor: witness.anchor, path: witness.path, local: output.ns === this.ns };
  }
  /** The event at `position` of this segment, as a receipt names it (C2.10.9a). */
  receiptEvent(position: bigint): ReceiptEvent | undefined {
    if (position < 1n || position > this.position) return undefined;
    const event = this.store.event(this.ns, position)!;
    return { position, statementHash: event.identity, historyHash: event.history, proofHash: event.proofHash, signatureHash: event.signatureHash };
  }
}
/** The state one segment replay moves: a handle at its namespace's tip. */
export type SegmentState = StateHandle;

/** C2b.3.2 recovery over a fixed snapshot state, without a segment's local
 * history: the snapshot's view with forced effects held in memory over it. */
export class ForceState implements StateView {
  readonly base: StateView;
  readonly nullifiers = new Set<bigint>();
  readonly outputs = new Set<bigint>();
  readonly added = new Map<string, Demand>();
  readonly ended = new Set<string>();
  readonly effective = new Set<string>();
  readonly spentTags = new Set<bigint>();
  constructor(base: StateView) { this.base = base; }
  hasNullifier(nf: bigint): boolean { return this.nullifiers.has(nf) || this.base.hasNullifier(nf); }
  hasOutput(cm: bigint): boolean { return this.outputs.has(cm) || this.base.hasOutput(cm); }
  hasAnchor(root: bigint): boolean { return this.base.hasAnchor(root); }
  hasSpentTag(tag: bigint): boolean { return this.spentTags.has(tag) || this.base.hasSpentTag(tag); }
  isEffective(id: string): boolean { return this.effective.has(id) || this.base.isEffective(id); }
  demand(id: string): Demand | undefined { return this.ended.has(id) ? undefined : this.added.get(id) ?? this.base.demand(id); }
  demandsWithTag(tag: bigint): (readonly [string, Demand])[] {
    return [...this.base.demandsWithTag(tag), ...[...this.added].filter(([, d]) => d.tags.includes(tag))].filter(([id]) => !this.ended.has(id));
  }
}
export interface ForceContext {
  readonly mode: "force";
  readonly domain: Uint8Array;
  readonly backing: Uint8Array;
  readonly segment: Uint8Array;
  readonly scope: bigint;
  readonly issuer: Uint8Array;
  readonly index: bigint;
  readonly lag: bigint;
  readonly verifier: ProofCheck;
}
export function openForceState(source: StateView): ForceState { return new ForceState(source); }
async function checkProof(record: Record, verifier: ProofCheck): Promise<void> {
  if (record.kind !== 5) requireReplay(await verifier.verify(record.kind, [...record.publicInputs], new Uint8Array(record.proof)) === true, "PROOF");
}
function checkUniqueEffects(nfs: readonly bigint[], outputs: readonly bigint[], state: Pick<StateView, "hasNullifier" | "hasOutput">): void {
  requireReplay(new Set(nfs).size === nfs.length && nfs.every(nf => nf !== 0n && !state.hasNullifier(nf)), "SPENT");
  requireReplay(new Set(outputs).size === outputs.length && outputs.every(cm => cm !== 0n && !state.hasOutput(cm)), "OUTPUT");
}
/** Apply only an already-verified forced publication's effects when rebuilding its prefix. */
export function applyForceEffects(state: ForceState, record: Record): void {
  if (record.kind !== 4 && record.kind !== 5 && record.kind !== 6) throw new EvidenceRefusal("unsupported-scope");
  const { demand, ended } = recoveryEffect(record);
  if (demand !== undefined) state.added.set(demand.id, demand.value);
  if (ended !== undefined) { state.ended.add(ended); state.added.delete(ended); }
  state.effective.add(hex(statementHash(record)));
  const { nfs, outputs } = effectOf(record);
  for (const nf of nfs) { state.nullifiers.add(nf); state.spentTags.add(tagOf(nf)); }
  outputs.forEach(cm => state.outputs.add(cm));
}
/** The reader establishes routing, an open gap, the strictly earlier snapshot and venue order.
 * Every check precedes mutation; force never extends the snapshot's forest. */
export async function applyForceRecord(state: ForceState, bytes: Uint8Array, context: ForceContext): Promise<void> {
  const record = decodeRecord(bytes), p = record.publicInputs;
  if (context.mode !== "force" || ![4, 5, 6].includes(record.kind)) throw new EvidenceRefusal("unsupported-scope");
  requireReplay(same(record.domain, context.domain) && same(identifierOf(p[2]!, p[3]!), context.segment) && p[4] === context.scope, "CONTEXT");
  if (record.kind !== 5) requireReplay(same(identifierOf(p[5]!, p[6]!), context.backing), "BACKING");
  await checkProof(record, context.verifier);
  const { roots, nfs, outputs } = effectOf(record);
  requireReplay(roots.every(root => state.hasAnchor(root)), "ANCHOR");
  checkUniqueEffects(nfs, outputs, state);
  checkRecovery(record, state, { check: requireReplay, backing: context.backing, issuer: context.issuer,
    at: context.index, lag: context.lag, door: true });
  applyForceEffects(state, record);
}

/** The last valid checkpoint of a segment: the replay must reach it and reproduce its hashes (C2.10.12). */
export interface LastValid {
  readonly position: bigint;
  readonly historyHash: Uint8Array;
  readonly evidenceHash: Uint8Array;
  /** The index a record of its prefix was judged at. */
  readonly judgedIndex?: ((position: bigint) => bigint | undefined) | undefined;
}
/** A record of the segment's adopted block: its exact admitted bytes and its publication's index (C2b.4.1). */
export interface Adopted { readonly bytes: Uint8Array; readonly index: bigint }

/** What a new segment imports: a checkpoint's state, or finalized prefixes merged from several in the same store. */
export interface MergedImport { readonly store: ReplayStore; readonly frontier: Imports }
export type ImportSource = StateHandle | MergedImport;

/**
 * A fresh namespace for `segment` under `identity`, over the imported
 * frontier or else the empty state. Its imports are read by reference;
 * building the successor's spent set reads each imported nullifier once.
 */
export function openSegmentState(store: ReplayStore, segment: Uint8Array, identity: Uint8Array, imported: ImportSource | undefined): SegmentState {
  if (imported !== undefined && imported.store !== store) throw new Error("an import is read from its own store");
  const frontier = imported === undefined ? undefined : imported instanceof StateHandle ? imported.frontier() : imported.frontier;
  const ns = store.open(segment, identity, frontier, { history: genesisHistoryHash(segment), evidence: genesisEvidenceHash(segment) });
  return new StateHandle(store, ns);
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
  /** The checkpoint's witnessed index; undefined for a read without venue answers. In admission, the horizon. */
  readonly index?: bigint | undefined;
  /** The operator's admission (store.ts) rather than a reader's replay. */
  readonly admission?: boolean | undefined;
  /** The actual venue lag, required for recovery admission's door checks. */
  readonly lag?: bigint | undefined;
  /** K's revocation index (C2b.1), or per scoped backing. */
  readonly revokedAt?: bigint | undefined;
  readonly revocations?: ReadonlyMap<string, bigint | undefined> | undefined;
  readonly lastValid?: LastValid | undefined;
  /** The adopted block, by position from the segment's first record. */
  readonly block: readonly Adopted[];
  /** Outputs to keep an incremental witness for, so their paths can be read later (a wallet's own). */
  readonly witness?: WitnessPredicate | undefined;
}

/** The mode a position applies in: exact adopted bytes inside the adopted block, then the caller's admission or replay. */
export function modeAt(replay: SegmentReplay, position: bigint): Exclude<StepMode, "force"> {
  return replay.block[Number(position)] !== undefined ? "adoption" : replay.admission === true ? "admission" : "replay";
}

/** A judged record: its effects on the state it was judged against. */
export interface Judged {
  readonly bytes: Uint8Array;
  readonly record: Record;
  readonly identity: Uint8Array;
  readonly at: bigint | undefined;
  readonly evidence: Uint8Array;
  readonly digests: EvidenceDigests;
  readonly backing: string;
  readonly demand: Demand | undefined;
  readonly demandId: string | undefined;
  readonly position: bigint;
}

/**
 * Judge the record at `state.position` (C2.10.12, pool-v3 §§5, 7): every
 * guard reads the same pre-state and nothing is written. A deterministic
 * failure throws ReplayRefusal with its check, an unindexed recovery record
 * EvidenceRefusal; the verifier's own failures propagate.
 */
export async function judgeRecord(state: SegmentState, bytes: Uint8Array, replay: SegmentReplay): Promise<Judged> {
  const judgment = judgmentOf(state, bytes, replay);
  if (judgment.proof) await checkProof(judgment.record, replay.verifier);
  return judgment.finish();
}

/**
 * Judge the record at `state.position` inside the adopted block, without
 * awaiting: exact adopted bytes carry the proof the force judgment verified
 * (mode table above), so an operator can judge and apply its whole block in
 * one transaction. A position outside the block is the caller's error.
 */
export function judgeAdopted(state: SegmentState, bytes: Uint8Array, replay: SegmentReplay): Judged {
  if (modeAt(replay, state.position) !== "adoption") throw new TypeError("the position is outside the adopted block");
  return judgmentOf(state, bytes, replay).finish();
}

/** The checks before the proof, whether the proof is checked, and the checks after it, in one order for every caller. */
function judgmentOf(state: SegmentState, bytes: Uint8Array, replay: SegmentReplay): { readonly proof: boolean; readonly record: Record; finish(): Judged } {
  const position = state.position, mode = modeAt(replay, position), adopted = replay.block[Number(position)];
  const record = decodeRecord(bytes), p = record.publicInputs, kind = record.kind;
  // A request (kind 7) decodes but is never a history event (§7): a trail carrying one fails replay (§10.1).
  requireReplay([1, 2, 3, 4, 5, 6].includes(kind), "KIND");
  if (mode === "admission") {
    if (replay.index === undefined) throw new TypeError("admission is judged at the horizon");
    if (kind >= 4 && replay.lag === undefined) throw new TypeError("recovery admission needs the venue's lag");
  }
  const demandId = kind === 5 || kind === 6 ? hex(identifierOf(p[kind === 5 ? 5 : 15]!, p[kind === 5 ? 6 : 16]!)) : undefined;
  const demand = demandId === undefined ? undefined : state.demand(demandId);
  const backing = kind === 5 ? demand?.backing ?? replay.backing : kind !== 2 ? identifierOf(p[5]!, p[6]!) : replay.backing;
  const ownTerms = replay.scopedTerms === undefined ? replay.terms : replay.scopedTerms.get(hex(backing));
  const issuerKey = ownTerms?.obligor ?? replay.terms.obligor;
  const key = hex(backing), total = state.total(key);
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
  const at = adopted?.index ?? (lastValid !== undefined && position < lastValid.position ? lastValid.judgedIndex?.(position + 1n) : undefined) ?? replay.index;
  if (kind >= 4 && at === undefined) throw new EvidenceRefusal("unsupported-scope");
  const identity = statementHash(record);
  requireReplay(!state.hasStatement(identity), "REPEATED_STATEMENT");
  const digests = evidenceHashes(record), evidence = nextEvidenceHash(state.evidence, digests, position + 1n);
  if (lastValid !== undefined && position + 1n === lastValid.position) requireReplay(same(evidence, lastValid.evidenceHash), "CONTINUITY");
  // Issuance witnessed at or after K's revocation is void (C2b.1). A position
  // the last valid checkpoint finalized was witnessed at its index, not here.
  if (kind === 1 && replay.index !== undefined && (lastValid === undefined || position + 1n > lastValid.position)) {
    const cutoff = replay.revocations === undefined ? replay.revokedAt : replay.revocations.get(hex(backing));
    requireReplay(cutoff === undefined || cutoff > replay.index, "REVOKED");
  }
  return { proof: mode !== "adoption", record, finish: (): Judged => {
    if (kind !== 2 && kind !== 5) {
      requireReplay(scoped || same(backing, replay.backing), "BACKING");
      if (kind === 1) {
        requireReplay(verifySignatureStrict(record.authorization, statementBytes(record), issuerKey), "SIGNATURE");
        requireReplay(total.issued + p[7]! < VALUE_BOUND, "SUPPLY");
      } else if (kind === 3) requireReplay(p[7]! <= total.issued - total.burned, "SUPPLY");
    }
    const { nfs, roots, outputs } = effectOf(record);
    if (mode !== "adoption") {
      requireReplay(roots.every(root => state.hasAnchor(root)), "ANCHOR");
      checkRecovery(record, state, { check: requireReplay, backing, issuer: issuerKey, at,
        ...(replay.lag === undefined ? {} : { lag: replay.lag }), door: mode === "admission" && kind >= 4 });
    }
    checkUniqueEffects(nfs, outputs, state);
    requireReplay(state.leaves + BigInt(outputs.length) <= NOTE_TREE_CAPACITY && position + 1n < VALUE_BOUND, "CAPACITY");
    return { bytes, record, identity, at, evidence, digests, backing: key, demand, demandId, position };
  } };
}

/**
 * Write a judged record's effects. Only the last check follows: at the last
 * valid checkpoint's position the new history hash must be its own, and a
 * mismatch undoes this record's writes before refusing.
 */
export function applyJudged(state: SegmentState, judged: Judged, replay: SegmentReplay): void {
  const { record, identity, position } = judged, p = record.publicInputs, kind = record.kind;
  if (state.position !== position) throw new Error("the state moved since the record was judged");
  const { nfs, outputs } = effectOf(record), next = position + 1n, { demand, ended } = recoveryEffect(record);
  const tags = kind === 4 ? p.slice(10, 12).filter(tag => tag !== 0n) :
    kind === 5 ? judged.demand?.tags.filter(tag => tag !== 0n) ?? [] : nfs.map(tagOf);
  const touched = kind === 4 ? hex(identity) : judged.demandId;
  const scan = outputs.map((cm, i): ScanOutput => (kind === 6 ? { cm, settlement: record } : { cm, capsule: record.capsules[i] }));
  const previous = state.history, lastValid = replay.lastValid;
  state.store.atomic(() => {
    const tip = state.store.append(state.ns, {
      identity, kind, index: judged.at, record: judged.bytes, proofHash: judged.digests.proofHash,
      signatureHash: judged.digests.signatureHash, evidence: judged.evidence,
      supply: kind === 1 ? { backing: judged.backing, issued: p[7]!, burned: 0n } : kind === 3 ? { backing: judged.backing, issued: 0n, burned: p[7]! } : undefined,
      nullifiers: nfs.map(nf => ({ nf, tag: tagOf(nf) })),
      outputs: scan.map(output => ({ cm: output.cm, capsule: output.capsule, settlement: output.settlement !== undefined,
        witness: replay.witness?.(output) === true })),
      demand, ended, keys: [...tags.map(tag => `tag:${tag}`), ...(touched === undefined ? [] : [`demand:${touched}`])],
      history: (noteRoot, spentRoot) => nextHistoryHash(previous, identity, noteRoot, spentRoot, next),
    });
    if (lastValid !== undefined && next === lastValid.position) requireReplay(same(tip.history, lastValid.historyHash), "CONTINUITY");
  });
}

/** Judge then apply the record at `state.position`; a refusal leaves the state as it was. */
export async function applyRecord(state: SegmentState, bytes: Uint8Array, replay: SegmentReplay): Promise<void> {
  applyJudged(state, await judgeRecord(state, bytes, replay), replay);
}
