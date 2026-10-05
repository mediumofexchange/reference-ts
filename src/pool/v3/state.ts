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
// | adoption  | an adopted publication's own index  | no: exact bytes the force judgment verified  | spent/outputs only; no issue is adopted              |
// | force     | the publication's witnessed index  | yes; door deadlines apply                   | spent/outputs and recovery effects only               |
//
// The state lives in a ReplayStore (replay-store.ts, storage decision
// 2026-09-29): a judgment reads the pre-state and returns the effects, and the
// apply writes them synchronously, so a refusal writes nothing. Force keeps
// the snapshot's anchors fixed; it is an in-memory overlay with no tree or history.
//
// A record is read through its construction's view (construction.ts, slice 14 M14c): pool-v3's records here,
// lit-v1's beside them, judged by these same rules. A namespace replays one construction, which its handle carries.
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes } from "../../bytes.js";
import { isField, VALUE_BOUND } from "../field.js";
import { EMPTY_NOTE_ROOT, type NotePath } from "../note-tree.js";
import { POOL_V3, type Construction, type StatementView } from "./construction.js";
import type { EvidenceDigests, Record } from "./records.js";
import { checkRecovery, type Demand, type RecoveryView } from "./recovery.js";
import { EvidenceRefusal, requireReplay } from "./refusals.js";
import type { ImportEntry, Imports, ReplayStore, StoredEvent, StoredOutput, Totals, WitnessMark } from "./replay-store.js";
import type { VerifierIdentities } from "./configuration.js";
import type { RootTerms } from "./terms.js";

export type { Totals, WitnessMark } from "./replay-store.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

export type StepMode = "admission" | "replay" | "adoption" | "force";

/** A transition's proof verifier: true only for a proof of `kind` over exactly these public inputs. */
export interface ProofCheck {
  verify(kind: number, publicInputs: bigint[], proof: Uint8Array): Promise<boolean> | boolean;
  /** How many verifications it runs at once off the reader's thread. Where declared, a replay starts proofs ahead of the
   * record it judges (verify-ahead.ts); otherwise it asks for each proof when the judgment reaches it. */
  readonly parallel?: number | undefined;
}
/** A reader's, journal's or wallet's verifier: it names its circuits, which must be the configuration's six (§11.1,
 * `requireConfigurationVerifier`), and that name is the verifier's in replay identities and kept state (§14). */
export interface DeclaredVerifier extends ProofCheck {
  readonly identities: VerifierIdentities;
}

/** What the guards read of a state: note membership and recovery state. */
export interface StateView extends RecoveryView {
  hasNullifier(nf: bigint): boolean;
  hasOutput(cm: bigint): boolean;
  hasAnchor(root: bigint): boolean;
  /** Whether an input opening `cm` reads a note of this state (lit-v1 §7 "live"; under force, of the snapshot's). */
  isInput(cm: bigint): boolean;
  /** The demand (hex identity) whose settlement created output `cm`, where a settlement did (C3.8's taken release). */
  settledFor(cm: bigint): string | undefined;
  /** Every demand visible here naming `tag`, ended or not: the tag is presented (C3.1). */
  presentedWithTag(tag: bigint): readonly (readonly [string, Demand])[];
}

/** An output a receiver may scan: its capsule, or for a settlement the record naming its owner. */
export interface ScanOutput { readonly cm: bigint; readonly capsule?: Uint8Array | undefined; readonly settlement?: Record }
/** Which outputs a replay keeps incremental witnesses for (a wallet's own), and the mark kept with each: undefined
 * for an output it passes over. The identity it declares names it in kept state (§14), so it must fix exactly which
 * outputs the predicate accepts and their marks; an undeclared one is named per object. */
export type WitnessPredicate = ((output: ScanOutput) => WitnessMark | undefined) & { readonly identity?: Uint8Array | undefined };
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
  readonly construction: Construction;
  readonly #at: bigint | undefined;
  /** A namespace is read through the construction it replays; another is the caller's error. */
  constructor(store: ReplayStore, ns: number, at?: bigint, construction: Construction = POOL_V3 as Construction) {
    if (at === undefined && store.construction(ns).name !== construction.namespace.name) throw new TypeError("the namespace replays another construction");
    this.store = store; this.ns = ns; this.#at = at; this.construction = construction;
  }

  get position(): bigint { return this.#at ?? this.store.tip(this.ns).position; }
  get segment(): Uint8Array { return this.store.tip(this.ns).segment; }
  /** This namespace's state at `position`, fixed while its tip moves on. */
  at(position: bigint): StateHandle {
    // Unavailable history is not the genesis state (C2b.3.1): a position past the tip has no state to read.
    if (position < 0n || position > this.store.tip(this.ns).position) throw new RangeError("a state is read at or below its tip");
    return new StateHandle(this.store, this.ns, position, this.construction);
  }
  #event(): StoredEvent | undefined { const p = this.position; return p === 0n ? undefined : this.store.event(this.ns, p); }
  get history(): Uint8Array {
    if (this.#at === undefined) return this.store.tip(this.ns).history;
    return this.#event()?.history ?? this.construction.genesisHistory(this.segment);
  }
  get evidence(): Uint8Array {
    if (this.#at === undefined) return this.store.tip(this.ns).evidence;
    return this.#event()?.evidence ?? this.construction.genesisEvidence(this.segment);
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
  isInput(cm: bigint): boolean { return this.hasOutput(cm); }
  settledFor(cm: bigint): string | undefined {
    const stored = this.store.output(this.ns, this.position, cm);
    return stored?.settlement === true ? this.construction.settledDemand(this.store.event(stored.ns, stored.position)!.settlement!) : undefined;
  }
  hasSpentTag(tag: bigint): boolean { return this.store.hasSpentTag(this.ns, this.position, tag); }
  isEffective(id: string): boolean { return this.store.isEffective(this.ns, this.position, id); }
  hasStatement(identity: Uint8Array): boolean { return this.store.hasStatement(this.ns, this.position, identity); }
  /** A statement of any kind in the visible history, imports included. */
  hasEvent(identity: Uint8Array): boolean { return this.store.hasEvent(this.ns, this.position, identity); }
  /** An issuance of `backing` (hex) among this segment's own records after position `after`. */
  hasIssuanceAfter(after: bigint, backing: string): boolean { return this.store.hasIssuance(this.ns, this.position, after, backing); }
  demand(id: string): Demand | undefined { return this.store.demand(this.ns, this.position, id); }
  demandsWithTag(tag: bigint): [string, Demand][] { return this.store.demandsWithTag(this.ns, this.position, tag); }
  demands(): [string, Demand][] { return this.store.demands(this.ns, this.position); }
  presentedWithTag(tag: bigint): [string, Demand][] { return this.store.presentedWithTag(this.ns, this.position, tag); }
  /** A demand visible here, ended or not, with the events that stood it up and ended it (C3.8). */
  presented(id: string): ReturnType<ReplayStore["presented"]> { return this.store.presented(this.ns, this.position, id); }
  /** The visible events that spent a nullifier of tag `tag` (C3.8's void). */
  tagSpends(tag: bigint): StoredEvent[] { return this.store.tagSpends(this.ns, this.position, tag); }
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
  /** Pool-v3's scan (a capsule, or a settlement's record); a lit wallet reads outputs by their openings (M14e). */
  scanOutput(stored: StoredOutput): ScanOutput {
    if (this.construction !== POOL_V3) throw new TypeError("a capsule scan reads pool-v3 outputs");
    return stored.settlement ? { cm: stored.cm, settlement: POOL_V3.decode(this.store.event(stored.ns, stored.position)!.settlement!) } :
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
  /** Every forced demand, ended or not: its tags are presented (`presentedWithTag`). */
  readonly forced = new Map<string, Demand>();
  readonly ended = new Set<string>();
  readonly effective = new Set<string>();
  readonly spentTags = new Set<bigint>();
  /** Each forced settlement's output, with its demand. */
  readonly settled = new Map<bigint, string>();
  constructor(base: StateView) { this.base = base; }
  hasNullifier(nf: bigint): boolean { return this.nullifiers.has(nf) || this.base.hasNullifier(nf); }
  hasOutput(cm: bigint): boolean { return this.outputs.has(cm) || this.base.hasOutput(cm); }
  hasAnchor(root: bigint): boolean { return this.base.hasAnchor(root); }
  /** Force reads inputs in the snapshot's state only, as it reads anchors (lit-v1 §7). */
  isInput(cm: bigint): boolean { return this.base.isInput(cm); }
  settledFor(cm: bigint): string | undefined { return this.settled.get(cm) ?? this.base.settledFor(cm); }
  hasSpentTag(tag: bigint): boolean { return this.spentTags.has(tag) || this.base.hasSpentTag(tag); }
  isEffective(id: string): boolean { return this.effective.has(id) || this.base.isEffective(id); }
  demand(id: string): Demand | undefined { return this.ended.has(id) ? undefined : this.added.get(id) ?? this.base.demand(id); }
  demandsWithTag(tag: bigint): (readonly [string, Demand])[] {
    return [...this.base.demandsWithTag(tag), ...[...this.added].filter(([, d]) => d.tags.includes(tag))].filter(([id]) => !this.ended.has(id));
  }
  presentedWithTag(tag: bigint): (readonly [string, Demand])[] {
    return [...this.base.presentedWithTag(tag), ...[...this.forced].filter(([, d]) => d.tags.includes(tag))];
  }
}
export interface ForceContext {
  readonly mode: "force";
  readonly domain: Uint8Array;
  readonly backing: Uint8Array;
  readonly segment: Uint8Array;
  /** Pool-v3's scope root; undefined for a construction whose segment binds its scope. */
  readonly scope: bigint | undefined;
  readonly issuer: Uint8Array;
  readonly index: bigint;
  readonly lag: bigint;
  readonly verifier: ProofCheck;
}
export function openForceState(source: StateView): ForceState { return new ForceState(source); }
function checkUniqueEffects(nfs: readonly bigint[], outputs: readonly bigint[], state: Pick<StateView, "hasNullifier" | "hasOutput">): void {
  requireReplay(new Set(nfs).size === nfs.length && nfs.every(nf => nf !== 0n && !state.hasNullifier(nf)), "SPENT");
  requireReplay(new Set(outputs).size === outputs.length && outputs.every(cm => cm !== 0n && !state.hasOutput(cm)), "OUTPUT");
}
/** The inputs a record reads: pool-v3's anchors, or a construction's input commitments (lit-v1 §7). */
function checkInputs(view: StatementView, state: Pick<StateView, "hasAnchor" | "isInput">): void {
  requireReplay(view.roots.every(root => state.hasAnchor(root)), "ANCHOR");
  requireReplay(view.inputs.every(cm => state.isInput(cm)), "INPUT");
}
/** C3.8: a release whose every other condition holds is **taken** where its output already exists as the output of a
 * settlement of another demand, in the snapshot or forced earlier since its adoption index. It has no force either
 * way; a taken one releases its acceptance for the dishonour reading (dishonour.ts). Lit cannot reach it: equal
 * settlement outputs need equal nullifiers, refused as `SPENT` first (lit-v1 §7). */
function checkTaken(view: StatementView, state: ForceState): void {
  const by = view.kind === 6 ? state.settledFor(view.outputs[0]!) : undefined;
  requireReplay(by === undefined || by === view.ended, "TAKEN");
}
function applyForceView(state: ForceState, view: StatementView): void {
  const { demand, ended } = view;
  if (demand !== undefined) { state.added.set(demand.id, demand.value); state.forced.set(demand.id, demand.value); }
  if (ended !== undefined) { state.ended.add(ended); state.added.delete(ended); }
  state.effective.add(hex(view.identity));
  view.nfs.forEach((nf, i) => { state.nullifiers.add(nf); state.spentTags.add(view.tags[i]!); });
  view.outputs.forEach(cm => state.outputs.add(cm));
  if (view.kind === 6) state.settled.set(view.outputs[0]!, ended!);
}
/** Apply only an already-verified forced publication's effects when rebuilding its prefix. */
export function applyForceEffects<R = Record>(state: ForceState, record: R, construction: Construction<R> = POOL_V3 as Construction<R>): void {
  const kind = construction.kind(record);
  if (kind !== 4 && kind !== 5 && kind !== 6) throw new EvidenceRefusal("unsupported-scope");
  applyForceView(state, construction.view(record, id => state.demand(id)));
}
/** The reader establishes routing, an open gap, the strictly earlier snapshot and venue order.
 * Every check precedes mutation; force never extends the snapshot's forest. The checks run in replay's order,
 * new nullifiers and outputs last, so a release refused only for its output is told apart (`checkTaken`). */
export async function applyForceRecord(state: ForceState, bytes: Uint8Array, context: ForceContext, construction: Construction = POOL_V3): Promise<void> {
  const record = construction.decode(bytes), kind = construction.kind(record);
  if (context.mode !== "force" || (kind !== 4 && kind !== 5 && kind !== 6)) throw new EvidenceRefusal("unsupported-scope");
  const view = construction.view(record, id => state.demand(id));
  requireReplay(same(view.domain, context.domain) && same(view.segment, context.segment) && view.scope === context.scope, "CONTEXT");
  if (kind !== 5) requireReplay(view.backings.every(backing => same(backing, context.backing)), "BACKING");
  await view.check(context.verifier);
  checkInputs(view, state);
  checkRecovery(view, state, { check: requireReplay, backing: context.backing, issuer: context.issuer,
    at: context.index, lag: context.lag, door: true });
  checkUniqueEffects(view.nfs, [], state);
  checkTaken(view, state);
  checkUniqueEffects([], view.outputs, state);
  applyForceView(state, view);
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
export function openSegmentState(store: ReplayStore, segment: Uint8Array, identity: Uint8Array, imported: ImportSource | undefined,
  construction: Construction = POOL_V3 as Construction): SegmentState {
  if (imported !== undefined && imported.store !== store) throw new Error("an import is read from its own store");
  const frontier = imported === undefined ? undefined : imported instanceof StateHandle ? imported.frontier() : imported.frontier;
  const ns = store.open(segment, identity, frontier, { history: construction.genesisHistory(segment), evidence: construction.genesisEvidence(segment) },
    construction.namespace);
  return new StateHandle(store, ns, undefined, construction);
}

/** What stays fixed while one segment's trail replays. */
export interface SegmentReplay {
  /** The configuration's domain and the selected backing. */
  readonly domain: Uint8Array;
  readonly backing: Uint8Array;
  /** The segment's identity and its scope root (pool-v3; undefined for a construction whose segment binds its scope). */
  readonly segment: Uint8Array;
  readonly scope: bigint | undefined;
  /** The selected backing's terms, and for a multi-backing scope each scoped backing's by name. */
  readonly terms: RootTerms;
  readonly scopedTerms?: ReadonlyMap<string, RootTerms | undefined> | undefined;
  readonly verifier: ProofCheck;
  /** The checkpoint's witnessed index; in admission, the horizon. */
  readonly index: bigint;
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

/** A judged record: its effects on the state it was judged against. `record` is its construction's decoded record. */
export interface Judged<R = Record> {
  readonly bytes: Uint8Array;
  readonly record: R;
  readonly view: StatementView;
  readonly identity: Uint8Array;
  readonly at: bigint;
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
 * failure throws ReplayRefusal with its check; the verifier's own failures
 * propagate.
 */
export async function judgeRecord<R = Record>(state: SegmentState, bytes: Uint8Array, replay: SegmentReplay): Promise<Judged<R>> {
  const judgment = judgmentOf(state, bytes, replay);
  if (judgment.check) await judgment.view.check(replay.verifier);
  return judgment.finish() as Judged<R>;
}

/**
 * Judge the record at `state.position` inside the adopted block, without
 * awaiting: exact adopted bytes carry the proof the force judgment verified
 * (mode table above), so an operator can judge and apply its whole block in
 * one transaction. A position outside the block is the caller's error.
 */
export function judgeAdopted<R = Record>(state: SegmentState, bytes: Uint8Array, replay: SegmentReplay): Judged<R> {
  if (modeAt(replay, state.position) !== "adoption") throw new TypeError("the position is outside the adopted block");
  return judgmentOf(state, bytes, replay).finish() as Judged<R>;
}

/** The checks before the statement check, whether it runs, and the checks after it, in one order for every caller
 * and construction. */
function judgmentOf(state: SegmentState, bytes: Uint8Array, replay: SegmentReplay): { readonly check: boolean; readonly view: StatementView; finish(): Judged<unknown> } {
  const construction = state.construction;
  const position = state.position, mode = modeAt(replay, position), adopted = replay.block[Number(position)];
  const record = construction.decode(bytes), kind = construction.kind(record);
  // A request (kind 7) decodes but is never a history event (§7): a trail carrying one fails replay (§10.1).
  requireReplay([1, 2, 3, 4, 5, 6].includes(kind), "KIND");
  // §7: advancing past 2^64 − 1 refuses before any state is read or the u64 position framed.
  requireReplay(position + 1n < VALUE_BOUND, "CAPACITY");
  // Every mode judges at a witnessed index (in admission, the horizon); an untyped caller cannot omit it.
  if (typeof replay.index !== "bigint") throw new TypeError("a record is judged at a witnessed index");
  if (mode === "admission" && kind >= 4 && replay.lag === undefined) throw new TypeError("recovery admission needs the venue's lag");
  if (replay.witness !== undefined && !construction.namespace.tree) throw new TypeError("a construction without a note tree keeps no witness");
  const view = construction.view(record, id => state.demand(id));
  const demandId = view.ended, demand = demandId === undefined ? undefined : state.demand(demandId);
  // The backing the record is judged under: its demand's where it reads one, else the first it names, else the selected.
  const backing = view.needsDemand ? demand?.backing ?? replay.backing : view.backings[0] ?? replay.backing;
  const termsOf = (name: Uint8Array): RootTerms | undefined => (replay.scopedTerms === undefined ? replay.terms : replay.scopedTerms.get(hex(name)));
  const issuerKey = termsOf(backing)?.obligor ?? replay.terms.obligor;
  const key = hex(backing), total = state.total(key);
  const scoped = replay.scopedTerms !== undefined;
  // Exact admitted bytes, including proof and authorization, survive adoption.
  if (mode === "adoption") requireReplay(same(bytes, adopted!.bytes), "ADOPTION");
  else {
    requireReplay(same(view.domain, replay.domain) && same(view.segment, replay.segment), "CONTEXT");
    requireReplay(view.scope === replay.scope, "SCOPE");
  }
  requireReplay((view.needsDemand ? [backing] : view.backings).every(name => termsOf(name) !== undefined), "BACKING");
  if (view.needsDemand) requireReplay(demand !== undefined && (scoped || same(backing, replay.backing)), "DEMAND");
  const lastValid = replay.lastValid;
  const at = adopted?.index ?? (lastValid !== undefined && position < lastValid.position ? lastValid.judgedIndex?.(position + 1n) : undefined) ?? replay.index;
  const identity = view.identity;
  requireReplay(!state.hasStatement(identity), "REPEATED_STATEMENT");
  const digests = view.digests, evidence = construction.nextEvidence(state.evidence, digests, position + 1n);
  if (lastValid !== undefined && position + 1n === lastValid.position) requireReplay(same(evidence, lastValid.evidenceHash), "CONTINUITY");
  // Issuance witnessed at or after K's revocation is void (C2b.1). A position
  // the last valid checkpoint finalized was witnessed at its index, not here.
  if (kind === 1 && (lastValid === undefined || position + 1n > lastValid.position)) {
    const cutoff = replay.revocations === undefined ? replay.revokedAt : replay.revocations.get(key);
    requireReplay(cutoff === undefined || cutoff > replay.index, "REVOKED");
  }
  return { check: mode !== "adoption", view, finish: (): Judged<unknown> => {
    requireReplay(view.backings.every(name => scoped || same(name, replay.backing)), "BACKING");
    if (kind === 1) {
      requireReplay(view.issuerSigned(issuerKey), "SIGNATURE");
      requireReplay(total.issued + view.quantity! < VALUE_BOUND, "SUPPLY");
    } else if (kind === 3) requireReplay(view.quantity! <= total.issued - total.burned, "SUPPLY");
    if (mode !== "adoption") {
      checkInputs(view, state);
      checkRecovery(view, state, { check: requireReplay, backing, issuer: issuerKey, at,
        ...(replay.lag === undefined ? {} : { lag: replay.lag }), door: mode === "admission" && kind >= 4 });
    }
    checkUniqueEffects(view.nfs, view.outputs, state);
    if (construction.capacity !== undefined) requireReplay(state.leaves + BigInt(view.outputs.length) <= construction.capacity, "CAPACITY");
    return { bytes, record, view, identity, at, evidence, digests, backing: key, demand, demandId, position };
  } };
}

/**
 * Write a judged record's effects. Only the last check follows: at the last
 * valid checkpoint's position the new history hash must be its own, and a
 * mismatch undoes this record's writes before refusing.
 */
export function applyJudged(state: SegmentState, judged: Judged<unknown>, replay: SegmentReplay): void {
  const { view, identity, position } = judged, kind = view.kind, construction = state.construction;
  if (state.position !== position) throw new Error("the state moved since the record was judged");
  const next = position + 1n, { demand, ended } = view;
  const tags = kind === 4 ? demand!.value.tags.filter(tag => tag !== 0n) :
    kind === 5 ? judged.demand?.tags.filter(tag => tag !== 0n) ?? [] : view.tags;
  const touched = kind === 4 ? hex(identity) : judged.demandId;
  const scan = (cm: bigint, i: number): ScanOutput => (kind === 6 ? { cm, settlement: judged.record as Record } : { cm, capsule: view.capsules[i] });
  const markOf = (output: ScanOutput): WitnessMark | undefined => {
    const mark: unknown = replay.witness?.(output);
    if (mark !== undefined && !(typeof mark === "object" && mark !== null && isField((mark as WitnessMark).nf) && (mark as WitnessMark).note instanceof Uint8Array)) {
      throw new TypeError("a witness predicate returns a mark { nf, note } or undefined");
    }
    return mark as WitnessMark | undefined;
  };
  const previous = state.history, lastValid = replay.lastValid;
  state.store.atomic(() => {
    const tip = state.store.append(state.ns, {
      identity, kind, index: judged.at, record: judged.bytes, proofHash: judged.digests.proofHash,
      signatureHash: judged.digests.signatureHash, evidence: judged.evidence,
      supply: kind === 1 ? { backing: judged.backing, issued: view.quantity!, burned: 0n } :
        kind === 3 ? { backing: judged.backing, issued: 0n, burned: view.quantity! } : undefined,
      nullifiers: view.nfs.map((nf, i) => ({ nf, tag: view.tags[i]! })),
      outputs: view.outputs.map((cm, i) => ({ cm, capsule: view.capsules[i], settlement: kind === 6,
        witness: replay.witness === undefined ? undefined : markOf(scan(cm, i)) })),
      demand, ended, keys: [...tags.map(tag => `tag:${tag}`), ...(touched === undefined ? [] : [`demand:${touched}`])],
      history: (noteRoot, spentRoot) => construction.nextHistory(previous, identity, noteRoot, spentRoot, next),
    });
    if (lastValid !== undefined && next === lastValid.position) requireReplay(same(tip.history, lastValid.historyHash), "CONTINUITY");
  });
}

/** Judge then apply the record at `state.position`; a refusal leaves the state as it was. */
export async function applyRecord(state: SegmentState, bytes: Uint8Array, replay: SegmentReplay): Promise<void> {
  applyJudged(state, await judgeRecord<unknown>(state, bytes, replay), replay);
}
