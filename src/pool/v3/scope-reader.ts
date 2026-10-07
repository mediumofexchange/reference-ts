// The one C2.10.3–7, C2b.3.1–4.2 and C2b.5 reader walk, for a scope of one
// backing or several: whole-scope classification, merged finalized prefixes
// with per-backing totals and adoption indices, publication force and silence
// clocks per backing, receipt reads across a scope, the non-service count and
// compact faults. Reference venues only (guard.ts). Every frame, snapshot, receipt, publication and request is
// read through the context's construction (construction.ts `reader`): pool-v3's, or lit-v1's (slice 14 M14d).
//
// The walk goes forward (M5b.3b): each backing's held checkpoints are
// classified once, in rank order, by a cursor over that backing's terms, and
// every verdict, valid candidate, segment scope, segment base and publication
// verdict is a row of the read's replay store. A checkpoint's last valid
// predecessors are then rows already written, so nothing recurses through
// history and nothing grows in memory with the number of checkpoints.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes, EncodingError } from "../../bytes.js";
import { linkInForce, RangeLimitError, type HeldCommitment, type RangeEntry } from "../../record-range.js";
import type { RecordVenue } from "../../record-venue.js";
import { VenueError } from "../../venue-error.js";
import type { Commitment } from "../../venue-records.js";
import { identifierOf, VALUE_BOUND } from "../field.js";
import type { Snapshot } from "./commitments.js";
import { POOL_V3, type Construction } from "./construction.js";
import type { SegmentHeader } from "./headers.js";
import type { VenueReference } from "./guard.js";
import { countNonService, type NonServiceCount } from "./non-service.js";
import type { WalkEvidence } from "./evidence-store.js";
import { keptContext, keptStateHolds, lastValidOf, readRecordView, replayTrail, ReplayResult, type CarryingVerdict, type FaultObserver,
  type ReaderSelection, type RecordView, type ReplayContext, type ValidCheckpoint } from "./reader.js";
import { receiptWalk, type ReceiptVerdict, type ReceiptWalk } from "./receipt-state.js";
import { decodePublication, settlementAuthorization, type Record, type SignedAcceptance } from "./records.js";
import { EvidenceRefusal, ReplayRefusal, requireReplay, type ClockRecord } from "./refusals.js";
import { authenticatedScope, checkpointScope } from "./scope-evidence.js";
import { KeptStateMismatch, type ImportEntry, type ReplayStore, type WalkBase, type WalkForce, type WalkVerdict } from "./replay-store.js";
import { applyForceEffects, applyForceRecord, openForceState, type MergedImport } from "./state.js";
import type { RootTerms } from "./terms.js";

export interface ImportContext extends ReplayContext {
  /** The construction the read selected by its configuration: every frame is read through it. */
  readonly construction: Construction;
  readonly reference: VenueReference;
  /** Unless false, the result lists the selected backing's carrying checkpoints through the judging index
   * (`carrying`): one row for every checkpoint ever held, so a party that reads none of them leaves them out. */
  readonly carrying?: boolean | undefined;
  readonly faults?: FaultObserver | undefined;
  readonly receiptBytes?: Uint8Array | undefined;
  /** Receipt evidence remains available to the caller after a later refusal. */
  receiptWalk?: Pick<ReceiptWalk, "evidence"> | undefined;
}
export interface CanonicalCheckpoint {
  readonly commitment: Commitment; readonly index: bigint; readonly segment: Uint8Array;
  /** Pool-v3's scope root; undefined for a construction whose segment identity binds its scope (lit-v1 §5). */
  readonly scope: bigint | undefined;
  /** The segment's header as the read authenticated it: `segment` is its identity and `scope` its entries' root. */
  readonly header: SegmentHeader;
  readonly state: ReplayResult;
}
/** A forced publication's record, decoded by its construction: pool-v3's `Record` by default, a lit read's `LitRecord`. */
export interface ForcedPublication<R = Record> { readonly index: bigint; readonly record: R; readonly bytes: Uint8Array }
/** A release (publication kind 3) as an answer carries it: the segment its settlement names, the output it discloses
 * with its `rho_out`, the presenter's signature with the exact message it must sign (C3.6), and its force verdict
 * (none where no gap could open: the backing declares no silence). The proof is not kept. */
export interface WitnessedRelease {
  readonly segment: Uint8Array; readonly output: bigint; readonly rho: bigint;
  readonly releaseMessage: Uint8Array; readonly releaseSignature: Uint8Array;
  /** Whether it had force; otherwise the check that refused it, `TAKEN` for a release taken by another demand's settlement (C3.8). */
  readonly force: boolean; readonly check: string | undefined;
}
/** An acceptance the venue witnessed routed to the backing, at its venue position: published on its own (publication
 * kind 2) or carried by a release (kind 3) with the release. Decoded only: nothing here verifies a signature or
 * resolves the demand it names, which C3.8's reader holds beside it (C2b.3.2). */
export interface WitnessedAnswer {
  readonly index: bigint; readonly ordinal: bigint;
  readonly acceptance: SignedAcceptance;
  readonly release: WitnessedRelease | undefined;
}
export interface PublicationVerdict { readonly index: string; readonly ordinal: string; force: boolean; check?: string }
export interface ImportCarryingVerdict extends CarryingVerdict { readonly operator: string }
/** A complete backing descent without an asserted selected checkpoint. */
export interface FrontierContext extends Omit<ImportContext, "selection" | "header" | "receiptBytes" | "receiptWalk"> {
  readonly selection: Pick<ReaderSelection, "mode" | "domain" | "venue" | "backing" | "judgingIndex">;
  /** List the backing's witnessed acceptances and releases (`FrontierResult.answers`); otherwise none is read for them. */
  readonly answers?: boolean;
}
export interface FrontierResult<R = Record> {
  readonly canonical: CanonicalCheckpoint | undefined;
  readonly force: readonly ScopeForcedPublication<R>[];
  /** The selected backing's carrying checkpoints through the judging index; empty, not listed, where the read
   * asked for none (`carrying: false`). */
  readonly carrying: readonly ImportCarryingVerdict[];
  readonly clock: ClockRecord | null | undefined;
  readonly ranges: Omit<ScopeRanges, "checkpointIndex" | "heldBefore" | "heldAfter">;
  /** The replacement chain through the judging index of every backing the
   * canonical segment scopes, keyed by hex name. One ended term ends the
   * segment for all of them (C2.10.9). */
  readonly scopeChains: ReadonlyMap<string, RecordView["chain"]>;
  /** Where the read asks for them (`FrontierContext.answers`), every acceptance the venue witnessed through the
   * judging index routed to the selected backing, alone or in a release, in venue order: what a holder's disclosure
   * count (C3.5) and C3.8's reading (dishonour.ts) read; otherwise empty. */
  readonly answers: readonly WitnessedAnswer[];
}
export const NO_FAULTS: FaultObserver = { inspect: async () => {}, intrinsicFailure: () => undefined };

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
type Identity = Pick<Commitment, "operator" | "sequence" | "root">;
const keyOf = (c: Identity): string => `${hex(c.operator)}:${c.sequence}:${hex(c.root)}`;
/** A commitment's row key: operator, sequence and root, each fixed width. */
const rowKey = (c: Identity): Uint8Array => {
  const out = new Uint8Array(72);
  out.set(c.operator); new DataView(out.buffer).setBigUint64(32, c.sequence); out.set(c.root, 40);
  return out;
};
const matches = (a: Identity | undefined, b: Identity | undefined): boolean => a !== undefined && b !== undefined && keyOf(a) === keyOf(b);
/** A segment base in comparable form. */
const baseKey = (base: WalkBase): string => JSON.stringify([base.openingIndex.toString(), base.parents.map(key => (key === undefined ? null : hex(key))),
  [...base.imports].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, entry]) => [name, entry.ns, entry.upto.toString()]),
  [...base.totals].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, t]) => [name, t.issued.toString(), t.burned.toString()]),
  [...base.adoption].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, at]) => [name, at.toString()]),
  base.block.map(force => [force.backing, force.index.toString(), force.ordinal.toString(), hex(force.bytes)])]);
export const venueOrder = (a: { readonly index: bigint; readonly ordinal: bigint }, b: { readonly index: bigint; readonly ordinal: bigint }): number =>
  a.index < b.index ? -1 : a.index > b.index ? 1 : a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : 0;

/** A descent's bound: strictly before an index, or before a held checkpoint in rank order. */
type Child = { readonly index: bigint; readonly strict: true } | (HeldCommitment & { readonly strict?: undefined });
const before = (held: { readonly index: bigint; readonly commitment: Identity }, child: Child | undefined): boolean =>
  child === undefined || held.index < child.index || (held.index === child.index && child.strict === undefined &&
    same(held.commitment.operator, child.commitment.operator) && held.commitment.sequence < child.commitment.sequence);

/** Imported finalized prefixes merged for a new multi-backing segment: one
 * namespace per imported segment, read to the furthest position any parent
 * imports, with the union's per-backing totals. */
export interface MergedPrefixes extends MergedImport {
  readonly adoptionIndices: Map<string, bigint>;
}

/** C2.10.5–6: imported roots retain their original trees. Parents agree on
 * each segment they share, up to the shorter prefix, by its history hash;
 * distinct events may never share nullifiers or outputs, and two touching one
 * tag or demand must be ordered by ancestry. Supply is checked per backing
 * over the whole union. A parent state named twice is merged once. */
export function mergeFinalizedPrefixes(store: ReplayStore, parents: readonly ({ readonly state: ReplayResult } | undefined)[]): MergedPrefixes {
  const segments = new Map<string, ImportEntry>(), seen = new Set<string>();
  for (const parent of parents) {
    if (parent === undefined) continue;
    if (parent.state.store !== store) throw new Error("an import is read from its own store");
    const state = `${parent.state.ns}:${parent.state.position}`;
    if (seen.has(state)) continue;
    seen.add(state);
    for (const [name, entry] of parent.state.frontier().segments) {
      const prior = segments.get(name);
      if (prior === undefined) { segments.set(name, entry); continue; }
      const [low, high] = prior.upto <= entry.upto ? [prior, entry] : [entry, prior];
      // Two replays of one segment agree on every event up to the shorter prefix exactly when their history hashes there agree.
      if (low.ns !== high.ns && low.upto > 0n) requireReplay(same(store.event(low.ns, low.upto)!.history, store.event(high.ns, low.upto)!.history), "CONTINUITY");
      segments.set(name, high);
    }
  }
  const facts = store.unionFacts([...segments.values()]);
  const precedes = (a: { ns: number; position: bigint; segment: string }, b: { ns: number; position: bigint; segment: string }): boolean =>
    a.segment === b.segment ? a.position < b.position : (store.imports(b.ns).get(a.segment)?.upto ?? 0n) >= a.position;
  for (const events of facts.shared.values()) {
    for (let j = 1; j < events.length; j++) for (let i = 0; i < j; i++) {
      requireReplay(precedes(events[i]!, events[j]!) || precedes(events[j]!, events[i]!), "RECOVERY_CONFLICT");
    }
  }
  requireReplay(!facts.repeatedNullifier, "SPENT");
  requireReplay(!facts.repeatedOutput, "OUTPUT");
  requireReplay(!facts.repeatedRecovery, "REPEATED_STATEMENT");
  for (const total of facts.supply.values()) requireReplay(total.burned <= total.issued && total.issued < VALUE_BOUND, "SUPPLY");
  return { store, frontier: { segments, totals: facts.supply }, adoptionIndices: new Map() };
}

interface Classified {
  readonly commitment: Commitment; readonly index: bigint; readonly segment: Uint8Array;
  readonly header: SegmentHeader; readonly snapshot: Snapshot;
}
interface ValidScope extends Classified {
  readonly class: "valid"; readonly state: ReplayResult;
  readonly scopedTerms: ReadonlyMap<string, RootTerms>; readonly openingIndex: bigint;
}
/** A lapse by silence carries the clock record proving it (C2b.4.1); a lapse by term needs none. */
type ScopeVerdict = ValidScope | (Classified & { readonly class: "lapsed"; readonly clock?: ClockRecord }) |
  (Classified & { readonly class: "excluded"; readonly check: string });
/** What a segment's opening fixes once it passes the segment-wide checks (context, terms,
 * IMPORT, IMPORT_RANK and the merge), whether or not its own evidence is then valid:
 * the imported base and adopted block every checkpoint of the segment replays from, the
 * opening index its clock runs from, and each scoped backing's imported predecessor. */
interface SegmentBase {
  readonly imported: MergedPrefixes; readonly block: readonly WalkForce[]; readonly openingIndex: bigint;
  readonly parents: readonly (Uint8Array | undefined)[];
}
interface ScopeClock {
  readonly duration: bigint; readonly snapshotIndex: bigint; readonly gap: bigint; readonly open: boolean;
  boundary: bigint | undefined; readonly opening: bigint;
}
export interface ScopePublicationVerdict extends PublicationVerdict { readonly backing: string }
export interface ScopeRanges {
  readonly judgingIndex: bigint; readonly lag: bigint; readonly checkpointIndex: bigint; readonly revokedAt: bigint | undefined;
  readonly chain: RecordView["chain"]; readonly heldBefore: number; readonly heldAfter: number;
  readonly publications: readonly ScopePublicationVerdict[]; readonly nonService?: NonServiceCount;
}
/** A forced publication and the backing it names. */
export interface ScopeForcedPublication<R = Record> extends ForcedPublication<R> { readonly backing: string }
export type ScopeResult<R = Record> = {
  readonly receipt: ReceiptVerdict; readonly state?: undefined; readonly carrying?: undefined; readonly clock?: undefined;
  readonly ranges?: undefined; readonly canonical?: undefined; readonly force?: undefined;
} | {
  readonly receipt?: undefined; readonly state: ReplayResult;
  /** As `FrontierResult.carrying`: empty, not listed, where the read asked for none (`carrying: false`). */
  readonly carrying: readonly ImportCarryingVerdict[];
  readonly clock: ClockRecord | null; readonly ranges: ScopeRanges;
  /** The selected checkpoint, which a successful read establishes as the backing's canonical one. */
  readonly canonical: CanonicalCheckpoint;
  /** Every scoped backing's forced publications through the judging index, in venue order. */
  readonly force: readonly ScopeForcedPublication<R>[];
};
type Latest = (backing: Uint8Array, terms: RootTerms, child?: Child) => Promise<ValidScope | undefined>;
/** A forced publication as a read returns it, with its venue ordinal. */
type ScopeForce = ScopeForcedPublication<unknown> & { readonly ordinal: bigint };
const forcedOf = (construction: Construction, force: WalkForce): ScopeForce =>
  ({ backing: force.backing, index: force.index, ordinal: force.ordinal, record: construction.decode(force.bytes), bytes: force.bytes });
/** Silence clocks kept per backing and opening while the walk moves forward; older ones recompute. */
const RUNNING_CLOCKS = 256;

/** C2b.3.1–4.2 per backing. Snapshots exclude the entire publication index;
 * canonical opening predecessors additionally include lower same-key sequences. */
function scopeRecovery(context: Pick<WalkContext, "construction" | "selection" | "verifier" | "receiptBytes" | "store">, walk: number,
  viewFor: (backing: Uint8Array, terms: RootTerms) => Promise<RecordView>, latest: Latest,
  snapshotIndexAt: (backing: Uint8Array, terms: RootTerms, index: bigint) => Promise<bigint>) {
  const { construction, selection, verifier, store } = context, frames = construction.reader;
  const progress = new Map<string, { last: Pick<RangeEntry, "index" | "ordinal"> | undefined; busy: boolean }>();
  const running = new Map<string, { upto: bigint; boundary: bigint | undefined }>();
  const forceStates = new Map<string, { key: string; state: ReturnType<typeof openForceState> }>();
  const snapshotAt = (backing: Uint8Array, terms: RootTerms, index: bigint): Promise<ValidScope | undefined> =>
    latest(backing, terms, { index, strict: true });
  // What a publication's verdict reads besides its own bytes: the backing's latest valid snapshot strictly before
  // its index, classified on this read's evidence. Undefined where the publication cannot force.
  const dependency = async (backing: Uint8Array, terms: RootTerms, duration: bigint,
    entry: RangeEntry): Promise<{ readonly record: Uint8Array; readonly snapshot: ValidScope } | undefined> => {
    let publication;
    try { publication = frames.publication(entry.record); }
    catch (error) {
      if (error instanceof EncodingError) return undefined;
      throw error;
    }
    if (!same(publication.domain, selection.domain) || !same(publication.backing, backing) ||
        publication.kind === 2 || publication.kind === 5) return undefined;
    const snapshot = await snapshotAt(backing, terms, entry.index);
    if (snapshot === undefined || entry.index - snapshot.index <= duration) return undefined;
    return { record: publication.record!, snapshot };
  };
  const classifyPublication = async (backing: Uint8Array, terms: RootTerms, view: RecordView, duration: bigint,
    entry: RangeEntry): Promise<{ force: boolean; check?: string; bytes?: Uint8Array }> => {
    const name = hex(backing), found = await dependency(backing, terms, duration, entry);
    if (found === undefined) return { force: false };
    const { snapshot } = found, source = snapshot.state, key = `${source.ns}:${source.position}`;
    // The snapshot's view with every earlier forced publication of this backing after its adoption index,
    // in venue order. The snapshot only moves forward with the index, so one running state per backing
    // extends while it stays; a publication that forces applies its effects to it, and a refused one
    // leaves it unchanged (every check precedes mutation).
    let kept = forceStates.get(name);
    if (kept === undefined || kept.key !== key) {
      const state = openForceState(source);
      for (const prior of store.forced(backing, source.adoptionIndices.get(name) ?? 0n, entry.index)) applyForceEffects(state, construction.decode(prior.bytes), construction);
      kept = { key, state }; forceStates.set(name, kept);
    }
    const { state } = kept, bytes = found.record;
    try {
      await applyForceRecord(state, bytes, { mode: "force", domain: selection.domain, backing,
        segment: snapshot.segment, scope: frames.scopeRoot(snapshot.header), issuer: terms.obligor,
        index: entry.index, lag: view.lag, verifier }, construction);
      return { force: true, bytes };
    } catch (error) {
      if (!(error instanceof ReplayRefusal)) throw error;
      return { force: false, check: error.check };
    }
  };
  // A publication's verdict depends on its own index, the snapshot strictly
  // before it and the force of earlier publications, never on how far a caller
  // reads. Each backing's publications are therefore classified once, in venue
  // order, into the walk's rows, and a read through an index reads that prefix.
  // False where a receipt read has no silence boundary through `through`: then no publication counts.
  const forces = async (backing: Uint8Array, terms: RootTerms, through: bigint): Promise<boolean> => {
    const name = hex(backing), duration = terms.silence?.noCommitmentDuration;
    if (duration === undefined) return false;
    // Earlier receipt inclusion must not depend on publication availability
    // after the first gap. Strict-prefix clock reads descend in index here.
    if (context.receiptBytes !== undefined && (await clock(backing, terms, 0n, through))!.boundary === undefined) return false;
    const view = await viewFor(backing, terms);
    if (!progress.has(name)) progress.set(name, { last: store.progress(walk, backing), busy: false });
    const read = progress.get(name)!;
    for (let entry = view.nextPublication(read.last); entry !== undefined && entry.index <= through; entry = view.nextPublication(read.last)) {
      // Nested reads come from snapshots strictly before the entry in progress.
      if (read.busy) throw new Error("publication prefix order");
      read.busy = true;
      try {
        // A verdict kept by an earlier read stands for the same record at the same venue position (§14 kept classes),
        // once its snapshot is classified on this read's evidence: only the force check is taken from it.
        const recordHash = sha256(entry.record), kept = store.keptPublication(backing, entry.index, entry.ordinal);
        if (kept !== undefined) {
          if (!same(kept.recordHash, recordHash)) throw new KeptStateMismatch("a kept publication's record");
          // A publication that cannot force is refused with no check; one that can is forced or refused by one.
          const unforceable = await dependency(backing, terms, duration, entry) === undefined;
          if (unforceable !== (!kept.force && kept.check === undefined)) throw new KeptStateMismatch("a kept publication");
          // The running force state did not apply it, so the next classification rebuilds from the rows.
          forceStates.delete(name);
        } else {
          const verdict = await classifyPublication(backing, terms, view, duration, entry);
          store.putPublication(backing, { index: entry.index, ordinal: entry.ordinal, force: verdict.force, check: verdict.check }, recordHash, verdict.bytes);
        }
      } finally { read.busy = false; }
      read.last = entry; store.putProgress(walk, backing, entry.index, entry.ordinal);
    }
    return true;
  };
  const verdictsThrough = (backing: Uint8Array, through: bigint): ScopePublicationVerdict[] =>
    [...store.publicationVerdicts(backing, through)].map(p => ({ backing: hex(backing), index: p.index.toString(),
      ordinal: p.ordinal.toString(), force: p.force, ...(p.check === undefined ? {} : { check: p.check }) }));
  // The least held index of any of the backing's terms' operators within its own term in [from, to].
  const firstPoint = (view: RecordView, from: bigint, to: bigint): bigint | undefined => {
    for (let i = 0; i < view.chain.length; i++) {
      const term = view.chain[i]!, low = term.from > from ? term.from : from, end = view.termEnd(i), high = end < to ? end : to;
      const found = view.firstHeldIndex(term.operator, low, high);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  // C2b.6.1 per backing, opening and index: the breakpoints are every held index within its own term after
  // the opening, and the index itself. The first gap over the duration fixes the boundary; the running
  // state per backing and opening extends as the walk reads later indices, so each breakpoint is read once.
  const clock = async (backing: Uint8Array, terms: RootTerms, opening: bigint, through: bigint): Promise<ScopeClock | null> => {
    const duration = terms.silence?.noCommitmentDuration;
    if (duration === undefined) return null;
    const view = await viewFor(backing, terms), key = `${hex(backing)}:${opening}`;
    // A copy: clock reads nested in this one's awaits never share its state. A kept walk's state is where an
    // earlier read left it.
    let kept = running.get(key);
    if (kept === undefined && (kept = store.clockState(walk, backing, opening)) !== undefined) running.set(key, kept);
    const state = kept !== undefined && kept.upto <= through ? { ...kept } : { upto: opening, boundary: undefined }, began = { ...state };
    for (let at = firstPoint(view, state.upto + 1n, through); at !== undefined && state.boundary === undefined; at = firstPoint(view, at + 1n, through)) {
      const last = await snapshotIndexAt(backing, terms, at);
      // A reset is a breakpoint even if the gap's first index has no record.
      if (at - last > duration) { const first = last + duration + 1n; state.boundary = first > opening ? first : opening + 1n; }
      state.upto = at;
    }
    // The walk keeps the fold over the breakpoints read, never one computed afresh behind its furthest.
    if (state.upto !== began.upto || state.boundary !== began.boundary) {
      const row = store.clockState(walk, backing, opening);
      if (row === undefined || row.upto <= state.upto) store.putClockState(walk, backing, opening, state.upto, state.boundary);
    }
    if (state.boundary !== undefined && state.upto < through) state.upto = through;
    // Keep the furthest state: a clock read for an earlier index during this one's awaits computes afresh.
    const saved = running.get(key);
    if (saved === undefined || saved.upto <= state.upto) {
      running.delete(key); running.set(key, state);
      if (running.size > RUNNING_CLOCKS) running.delete(running.keys().next().value!);
    }
    const last = await snapshotIndexAt(backing, terms, through);
    let boundary = state.boundary;
    if (boundary === undefined && through > opening && through - last > duration) { const first = last + duration + 1n; boundary = first > opening ? first : opening + 1n; }
    return { duration, snapshotIndex: last, gap: through - last, open: through - last > duration, boundary, opening };
  };
  return { forces, verdictsThrough, clock };
}

/** C2.10.3–7 over a scope of several backings. Each checkpoint is classified
 * once from its own committed evidence: its authenticated header fixes the
 * scope, every scoped backing's canonical predecessor is that backing's latest
 * valid checkpoint before it in rank order, and an opening imports their
 * merged finalized prefixes with each backing's adoption index. Continuations
 * resume from their segment's opening. Unrelated old trails are not read.
 * A receipt instead returns its verdict at the deciding checkpoint or boundary. */
export async function classifyScopes<R = Record>(context: ImportContext, record: RecordVenue, evidence: WalkEvidence): Promise<ScopeResult<R>> {
  const walk = scopeWalk(context, record, evidence);
  return closing(walk, async () => {
    try { return await selectedRead(context, evidence, walk) as ScopeResult<R>; } catch (error) {
      if (error instanceof EvidenceRefusal && context.receiptBytes === undefined) await walk.inspectRefused(context.selection.backing, context.terms);
      throw error;
    }
  });
}

/** Run `read` over `walk`, then close the walk. A read's own failure is what its caller sees: a walk that then fails
 * to close does not replace the read's refusal, and goes with it as its `cause` where it has none. After a read
 * that succeeded, a failed close is the caller's to see: what the read kept did not commit, or committed without its
 * digest, so a later keep point records one or the next opening discards it. */
async function closing<T>(walk: { close(): void }, read: () => Promise<T>): Promise<T> {
  let result: T;
  try { result = await read(); } catch (error) {
    try { walk.close(); } catch (closed) { withCause(error, closed); }
    throw error;
  }
  walk.close();
  return result;
}
/** A cleanup's failure kept beside the failure it followed, which stands. */
export function withCause(error: unknown, cause: unknown): void {
  if (error instanceof Error && error.cause === undefined) error.cause = cause;
}

async function selectedRead(context: ImportContext, evidence: WalkEvidence, walk: ReturnType<typeof scopeWalk>): Promise<ScopeResult<unknown>> {
  const { selection, construction } = context, { viewFor, latest, recovery, classify } = walk;
  const { trails } = evidence;
  const view = await viewFor(selection.backing, context.terms);
  const selectedHeld = view.heldAt(selection.operator, selection.sequence);
  if (selectedHeld === undefined || !matches(selectedHeld.commitment, selection)) throw new EvidenceRefusal("selection-mismatch");
  if (context.receiptBytes !== undefined) {
    const receipt = construction.reader.receipt(context.receiptBytes);
    const original = authenticatedScope(construction, trails, receipt.segment);
    const { header } = original, scopeViews = new Map<string, RecordView>(), termsByBacking = new Map<string, RootTerms>();
    // authenticatedScope resolved and verified every scoped terms field.
    for (let i = 0; i < header.entries.length; i++) {
      const scoped = header.entries[i]!, terms = original.rootTerms[i]!;
      if (!same(terms.configuration, selection.domain) || !same(terms.venue, selection.venue)) throw new EvidenceRefusal("invalid-receipt");
      termsByBacking.set(hex(scoped.backing), terms);
      scopeViews.set(hex(scoped.backing), await viewFor(scoped.backing, terms));
    }
    const receiptRead = await receiptWalk(context.receiptBytes, context, view, trails, digest => evidence.snapshot(digest), root => evidence.directory(root), scopeViews);
    context.receiptWalk = receiptRead;
    let openingIndex: bigint | undefined;
    const boundary = async (at: bigint): Promise<ReceiptVerdict | undefined> => {
      if (openingIndex === undefined) return undefined;
      const through = receiptRead.termBoundary !== undefined && receiptRead.termBoundary < at ? receiptRead.termBoundary : at;
      let earliest: bigint | undefined;
      for (const scoped of header.entries) {
        const clock = await recovery.clock(scoped.backing, termsByBacking.get(hex(scoped.backing))!, openingIndex, through);
        if (clock?.boundary !== undefined && (earliest === undefined || clock.boundary < earliest)) earliest = clock.boundary;
      }
      return receiptRead.boundary(at, { boundary: earliest });
    };
    for (let held = view.nextHeld(header.operator, 0n); held !== undefined; held = view.nextHeld(header.operator, 0n, held.commitment.sequence)) {
      if (held.commitment.sequence < header.sequence) continue;
      const ended = await boundary(held.index);
      if (ended !== undefined) return { receipt: ended };
      const scoped = header.entries.find(entry => scopeViews.get(hex(entry.backing))!.carries(held) !== undefined);
      if (scoped === undefined) { receiptRead.checkpoint(held, undefined, undefined, undefined, "other"); continue; }
      const result = await classify(held, scoped.backing);
      const verdict = receiptRead.checkpoint(held, result.segment, result.class === "valid" ? result.state : undefined, result.header, result.class);
      // The original opening as witnessed anchors the boundary, valid or excluded (C2b.4.1).
      if (result.class !== "lapsed" && same(result.segment, receipt.segment) && held.commitment.sequence === header.sequence) openingIndex = held.index;
      if (verdict !== undefined) return { receipt: verdict };
    }
    return { receipt: await boundary(view.t) ?? receiptRead.finish() };
  }
  if (!same(linkInForce(view.chain, selectedHeld.index).operator, selection.operator)) throw new EvidenceRefusal("lapsed-selection");
  // Every held commitment in the backing's terms, carrying or not, counted around the
  // selection. Those after it are placed by their directories before any proof is
  // checked, so evidence withheld there refuses before the selection's trail is verified.
  // The selection lies in the term in force at its index, which is its operator's (above); terms cover disjoint
  // ranges in chain order, and within one a key's index and sequence rise together, so those before it are counted.
  let heldBefore = 0, heldAfter = 0;
  for (let i = 0; i < view.chain.length; i++) {
    const term = view.chain[i]!, end = view.termEnd(i);
    const own = term.from <= selectedHeld.index && selectedHeld.index <= end;
    if (!own && term.from > selectedHeld.index) {
      for (let held = view.nextHeld(term.operator, term.from); held !== undefined && held.index <= end;
        held = view.nextHeld(term.operator, term.from, held.commitment.sequence)) { heldAfter++; view.carries(held); }
      continue;
    }
    if (!own) { heldBefore += view.heldCount(term.operator, term.from, end); continue; }
    heldBefore += view.heldCount(term.operator, term.from, end, selection.sequence);
    for (let held = view.nextHeld(term.operator, term.from, selection.sequence); held !== undefined && held.index <= end;
      held = view.nextHeld(term.operator, term.from, held.commitment.sequence)) { heldAfter++; view.carries(held); }
  }
  // A refusal met classifying the selection is met below it, where the descent had gone: its fault pass starts there.
  walk.refusedBelow(selectedHeld);
  const selected = await classify(selectedHeld, selection.backing);
  if (selected.class === "lapsed") throw Object.assign(new EvidenceRefusal("lapsed-selection"), selected.clock === undefined ? {} : { clock: selected.clock });
  if (selected.class === "excluded") throw new ReplayRefusal(selected.check);
  walk.refusedBelow(undefined);
  const current = await latest(selection.backing, context.terms);
  if (!matches(current?.commitment, selection)) throw new EvidenceRefusal("superseded-selection");
  const { clock, publications, force, nonService } = await walk.around(selected, context.terms, view);
  return { state: selected.state, carrying: context.carrying === false ? [] : walk.carrying(), clock, canonical: canonicalOf(construction, selected), force, ranges: {
    judgingIndex: view.t, lag: view.lag, checkpointIndex: selectedHeld.index, revokedAt: view.revokedAt, chain: view.chain,
    heldBefore, heldAfter, publications, ...(nonService === undefined ? {} : { nonService }) } };
}

/** C2.7 descent for one backing's independently authenticated terms in any
 * scope: its canonical checkpoint, if the record holds one, with every scoped
 * backing's forced publications and the clock. */
export async function classifyScopeFrontier<R = Record>(context: FrontierContext, record: RecordVenue, evidence: WalkEvidence): Promise<FrontierResult<R>> {
  const { selection, terms, construction } = context;
  // A holder's answers read pool-v3's releases (C3.5's disclosure, C3.8); lit's are the lit wallet's (WORK.md slice 14).
  if (context.answers === true && construction !== POOL_V3 as Construction) throw new TypeError("a lit read lists no answers");
  const walk = scopeWalk(context, record, evidence);
  return closing(walk, async () => { try {
    const view = await walk.viewFor(selection.backing, terms), canonical = await walk.latest(selection.backing, terms);
    const around = await walk.around(canonical, terms, view);
    const scopeChains = new Map<string, RecordView["chain"]>();
    for (const [name, scoped] of canonical?.scopedTerms ?? []) scopeChains.set(name, (await walk.viewFor(hexToBytes(name), scoped)).chain);
    // Every acceptance and release of the backing with the classification's verdict on a release; where the backing
    // declares no silence nothing is classified and none has force, but a release published there still discloses
    // its output (C3.5) and witnesses its acceptance.
    const name = hex(selection.backing), verdicts = new Map(around.publications.filter(p => p.backing === name)
      .map(p => [`${p.index}:${p.ordinal}`, p]));
    const answers: WitnessedAnswer[] = [];
    for (const entry of context.answers === true ? view.publications() : []) {
      let publication;
      try {
        publication = decodePublication(entry.record);
        if (!same(publication.domain, selection.domain) || !same(publication.backing, selection.backing)) continue;
        if (publication.kind === 2) { answers.push({ index: entry.index, ordinal: entry.ordinal, acceptance: publication.acceptance, release: undefined }); continue; }
        if (publication.kind !== 3) continue;
        const { acceptance, releaseMessage, releaseSignature } = settlementAuthorization(publication.record), p = publication.record.publicInputs;
        const verdict = verdicts.get(`${entry.index}:${entry.ordinal}`);
        answers.push({ index: entry.index, ordinal: entry.ordinal, acceptance, release: { segment: identifierOf(p[2]!, p[3]!), output: p[14]!,
          rho: p[9]!, releaseMessage, releaseSignature, force: verdict?.force === true, check: verdict?.check } });
      } catch (error) {
        if (error instanceof EncodingError) continue;
        throw error;
      }
    }
    return { canonical: canonical === undefined ? undefined : canonicalOf(construction, canonical), force: around.force as ScopeForcedPublication<R>[], carrying: context.carrying === false ? [] : walk.carrying(), scopeChains, answers,
      clock: canonical === undefined ? undefined : around.clock, ranges: { judgingIndex: view.t, lag: view.lag, revokedAt: view.revokedAt,
        chain: view.chain, publications: around.publications, ...(around.nonService === undefined ? {} : { nonService: around.nonService }) } };
  } catch (error) {
    if (error instanceof EvidenceRefusal) await walk.inspectRefused(selection.backing, terms);
    throw error;
  } });
}

const canonicalOf = (construction: Construction, valid: ValidScope): CanonicalCheckpoint => ({ commitment: valid.commitment, index: valid.index,
  segment: valid.segment, scope: construction.reader.scopeRoot(valid.header), header: valid.header, state: valid.state });

/** What a scope read needs besides a selected checkpoint or backing. */
type WalkContext = FrontierContext & Pick<ImportContext, "receiptBytes">;

/** Whole-scope classification, shared by selected and frontier reads. Every
 * checkpoint is classified once, into the walk's rows; close() drops them. */
function scopeWalk(context: WalkContext, record: RecordVenue, evidence: WalkEvidence) {
  const { selection, store, construction } = context, faults = context.faults ?? NO_FAULTS, frames = construction.reader;
  // These walks are exported: a selection under another configuration is refused here, not trusted from a caller.
  requireReplay(same(selection.domain, frames.domain()), "CONFIGURATION");
  // The verifier's circuits name every replay and kept class (§14), so they must be the configuration's. A kept
  // store keeps state across processes, so where the read witnesses outputs, the predicate's identity must be
  // declared too, not named per object. Witnesses stay only at a namespace's tip; a path read below it discards
  // the kept state (replay-store.ts `witness`).
  const identities = frames.verifierIdentities(context.verifier.identities);
  if (store.kept && context.witness !== undefined && !(context.witness.identity instanceof Uint8Array)) {
    throw new TypeError("a kept store needs a witness predicate that declares its identity");
  }
  // The venue's identity fixes its lag (§13), so the configuration, venue, verifier and witness predicate name the kept context.
  // A read from the party's retained evidence, with no fault items or receipt of its own, resumes the selected
  // backing's kept walk (§14 kept walk): what it classified stands, and this read classifies what is new.
  // A read past the venue's witnessed index is refused when its view is read; it does not raise the kept index.
  const witnessed = ((): bigint | undefined => { try { const now: unknown = record.witnessedIndex(); return typeof now === "bigint" ? now : undefined; } catch { return undefined; } })();
  const retained = evidence.retained, keptWalk = retained !== undefined && context.receiptBytes === undefined &&
    faults.holdsEvidence?.() !== true && witnessed !== undefined && selection.judgingIndex <= witnessed ? { selected: selection.backing, evidence: retained.identity, mark: retained.mark,
      holds: (mark: Uint8Array) => retained.holds(mark), through: selection.judgingIndex } : undefined;
  const { trails } = evidence, { walk, resumed } = store.openWalk(keptContext({ construction, domain: selection.domain, venue: selection.venue,
    verifier: { verify: context.verifier.verify, identities }, witness: context.witness }), keptWalk);
  const views = new Map<string, Promise<RecordView>>(), running = new Map<string, Promise<ScopeVerdict>>();
  const cursors = new Map<string, { term: number; after: bigint | undefined; busy: boolean }>();
  // Whether any classification began, and the bound a refused read's fault pass starts below.
  let began = false, below: HeldCommitment | undefined;
  const viewFor = (backing: Uint8Array, terms: RootTerms): Promise<RecordView> => {
    const id = hex(backing);
    if (!views.has(id)) views.set(id, readRecordView({ ...selection, backing }, terms, evidence, record, context.reference, store));
    return views.get(id)!;
  };
  const snapshotFor = (digest: Uint8Array): Snapshot => {
    const bytes = evidence.snapshot(digest);
    if (bytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
    return frames.snapshot.decode(bytes);
  };
  // A resumed walk reads a class an earlier read made only after §14's checks on this read's evidence: the venue
  // holds the same commitment at the same index, the kept snapshot authenticates against the checkpoint's retained
  // directory and scope, and a valid class's trail is retained and its state passes the snapshot check. Evidence no
  // longer retained leaves the read unresolved, as a read of every checkpoint would; anything else that does not
  // match is kept state to discard. Classes behind the cursor that the read does not load are not read again.
  const judgedHere = new Set<string>(), rechecked = new Set<string>();
  const recheck = (row: WalkVerdict): void => {
    const id = hex(row.key);
    if (!resumed || judgedHere.has(id) || rechecked.has(id)) return;
    const held = store.heldAt(row.operator, row.sequence, selection.judgingIndex);
    if (held === undefined || held.index !== row.index || !same(held.commitment.root, row.root) || !same(held.commitment.signature, row.signature)) {
      throw new KeptStateMismatch("a kept walk's commitment");
    }
    let snapshot: Snapshot;
    try { snapshot = frames.snapshot.decode(row.snapshot); } catch (error) {
      if (error instanceof EncodingError) throw new KeptStateMismatch("a kept walk's snapshot");
      throw error;
    }
    const directory = evidence.directory(row.root);
    if (directory === undefined) throw new EvidenceRefusal("unresolved-evidence");
    const entry = directory.find(item => same(item.name, snapshot.backing));
    if (entry === undefined || !same(entry.digest, frames.snapshot.digest(snapshot))) throw new KeptStateMismatch("a kept walk's snapshot");
    if (evidence.snapshot(entry.digest) === undefined) throw new EvidenceRefusal("unresolved-evidence");
    // The scope is authenticated as the judgment did, from the directory's first snapshot (C2.10.11, pool-v3 §7.1):
    // the row's snapshot is that of whichever backing last judged it, and in an excluded or lapsed class it may
    // name another segment.
    const first = directory[0]!, named = same(first.name, snapshot.backing) ? snapshot : snapshotFor(first.digest);
    if (!same(named.segment, row.segment)) throw new KeptStateMismatch("a kept walk's segment");
    const scope = checkpointScope(construction, trails, first.name, first.digest, named);
    const s = row.state;
    if (row.class === "valid") {
      const trail = scope.fullTrail();
      if (s === undefined || !keptStateHolds(store, s.ns, s.position, s.identity, snapshot, construction, trail, trails)) throw new KeptStateMismatch("a kept walk's state");
      // Every scoped sibling's snapshot is the same state's, with that backing's totals at its position.
      for (const sibling of directory) {
        const bytes = evidence.snapshot(sibling.digest);
        if (bytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
        const other = frames.snapshot.decode(bytes), total = store.total(s.ns, s.position, hex(other.backing));
        if (!same(other.segment, snapshot.segment) || !same(other.historyHash, snapshot.historyHash) || !same(other.evidenceHash, snapshot.evidenceHash) ||
            total.issued !== other.issued || total.burned !== other.burned) throw new KeptStateMismatch("a kept walk's sibling");
      }
    }
    rechecked.add(id);
  };
  /** A verdict row as the walk reads it for `backing`, its scope from the segment's row. A valid class's totals are
   * that backing's at its position: the row is shared by every backing the checkpoint scopes, and a walk for
   * another backing writes it again with its own. */
  const load = (row: WalkVerdict, backing: Uint8Array): ScopeVerdict => {
    recheck(row);
    try { return loaded(row, backing); } catch (error) {
      // A row that does not decode, or whose segment's scope is missing, is kept state to discard (§14).
      if (error instanceof EncodingError || error instanceof SyntaxError) {
        throw new KeptStateMismatch("a kept walk's class");
      }
      throw error;
    }
  };
  const loaded = (row: WalkVerdict, backing: Uint8Array): ScopeVerdict => {
    const scope = store.scope(row.segment);
    if (scope === undefined) throw new KeptStateMismatch("a kept walk's scope");
    const header = frames.header.decodeSegmentHeader(scope.header);
    const base: Classified = { commitment: { operator: row.operator, sequence: row.sequence, root: row.root, signature: row.signature },
      index: row.index, segment: row.segment, header, snapshot: frames.snapshot.decode(row.snapshot) };
    if (row.class === "excluded") return { ...base, class: "excluded", check: row.detail! };
    if (row.class === "lapsed") return { ...base, class: "lapsed", ...(row.detail === undefined ? {} : { clock: JSON.parse(row.detail) as ClockRecord }) };
    const s = row.state!;
    const { issued, burned } = store.total(s.ns, s.position, hex(backing));
    return { ...base, class: "valid", openingIndex: s.opening,
      scopedTerms: new Map(header.entries.map((scoped, i) => [hex(scoped.backing), frames.terms.decodeRootTerms(scope.terms[i]!.terms)])),
      state: new ReplayResult(store, s.ns, s.position, { issued, burned, adoptionIndices: s.adoption, identity: s.identity }, construction) };
  };
  const keep = (held: HeldCommitment, verdict: ScopeVerdict): void => {
    const c = held.commitment, state = verdict.class === "valid" ? verdict.state : undefined;
    store.putVerdict(walk, { key: rowKey(c), operator: c.operator, sequence: c.sequence, root: c.root, signature: c.signature, index: held.index,
      class: verdict.class, segment: verdict.segment, snapshot: frames.snapshot.bytes(verdict.snapshot),
      detail: verdict.class === "excluded" ? verdict.check : verdict.class === "lapsed" && verdict.clock !== undefined ? JSON.stringify(verdict.clock) : undefined,
      state: state === undefined || verdict.class !== "valid" ? undefined : { ns: state.ns, position: state.position, identity: state.identity,
        issued: state.issued, burned: state.burned, adoption: state.adoptionIndices, opening: verdict.openingIndex } });
  };
  // Each backing's held checkpoints within its terms, carrying it, classified in rank order up to a bound.
  // A classification in progress reads only earlier checkpoints of any backing, so a nested advance of
  // the same backing never passes the one in progress.
  // The cursor moves past a term only where a later term begins: the last term stays open to a later read, whose view
  // can hold more of its checkpoints. Each move is kept with the walk.
  const advance = async (backing: Uint8Array, terms: RootTerms, child: Child | undefined): Promise<void> => {
    const name = hex(backing), view = await viewFor(backing, terms);
    if (!cursors.has(name)) {
      // A kept cursor's term is the same link in this read's chain: links in force at the kept index stay (C2.5.3), and
      // later ones are appended after them.
      const kept = store.cursor(walk, backing);
      if (kept !== undefined && !same(view.chain[kept.term]?.link ?? new Uint8Array(), kept.link)) throw new KeptStateMismatch("a kept walk's term");
      cursors.set(name, { term: kept?.term ?? 0, after: kept?.after, busy: false });
    }
    const cursor = cursors.get(name)!;
    while (cursor.term < view.chain.length) {
      const term = view.chain[cursor.term]!, next = view.nextHeld(term.operator, term.from, cursor.after);
      if (next === undefined || next.index > view.termEnd(cursor.term)) {
        if (cursor.term + 1 === view.chain.length) return;
        cursor.term++; cursor.after = undefined; store.putCursor(walk, backing, cursor.term, view.chain[cursor.term]!.link, cursor.after);
        continue;
      }
      if (!before(next, child)) return;
      if (cursor.busy) throw new Error("candidate order");
      cursor.busy = true;
      try {
        if (view.carries(next) !== undefined) {
          const c = next.commitment, key = rowKey(c), verdict = await classify(next, backing);
          store.carry(walk, backing, key, next.index, c.sequence, c.operator, c.root);
          if (verdict.class === "valid") store.putValid(walk, backing, next.index, c.operator, c.sequence, key);
        }
      } finally { cursor.busy = false; }
      cursor.after = next.commitment.sequence; store.putCursor(walk, backing, cursor.term, term.link, cursor.after);
    }
  };
  // The latest valid carrying checkpoint of a backing within its terms before a bound (rank order), or of all.
  const latest: Latest = async (backing, terms, child) => {
    await advance(backing, terms, child);
    const key = store.latestValid(walk, backing, child === undefined ? undefined : child.strict ? { index: child.index, strict: true } :
      { index: child.index, operator: child.commitment.operator, sequence: child.commitment.sequence });
    if (key === undefined) return undefined;
    return load(candidate(key), backing) as ValidScope;
  };
  // A valid candidate's class: a kept walk's row missing its class is kept state to discard.
  const candidate = (key: Uint8Array): WalkVerdict => {
    const row = store.verdict(walk, key);
    if (row === undefined) throw new KeptStateMismatch("a kept walk's candidate");
    return row;
  };
  const snapshotIndexAt = async (backing: Uint8Array, terms: RootTerms, index: bigint): Promise<bigint> => {
    await advance(backing, terms, { index, strict: true });
    const key = store.latestValid(walk, backing, { index, strict: true });
    if (key === undefined) return 0n;
    const row = candidate(key);
    recheck(row);
    return row.index;
  };
  const recovery = scopeRecovery(context, walk, viewFor, latest, snapshotIndexAt);
  // Every scoped backing's clock from a segment's opening through an index, and one
  // backing's record carrying the scope's earliest boundary (C2b.4.1, C2.10.9).
  const scopeClocks = async (header: SegmentHeader, termsOf: (backing: Uint8Array) => RootTerms, backing: Uint8Array,
    opening: bigint, through: bigint): Promise<{ clocks: (ScopeClock | null)[]; record: ClockRecord | null }> => {
    const clocks: (ScopeClock | null)[] = [];
    for (const scoped of header.entries) clocks.push(await recovery.clock(scoped.backing, termsOf(scoped.backing), opening, through));
    const own = clocks[header.entries.findIndex(entry => same(entry.backing, backing))];
    if (own === null || own === undefined) return { clocks, record: null };
    let boundary = own.boundary;
    for (const clock of clocks) if (clock?.boundary !== undefined && (boundary === undefined || clock.boundary < boundary)) boundary = clock.boundary;
    return { clocks, record: { duration: own.duration.toString(), snapshotIndex: own.snapshotIndex.toString(), gap: own.gap.toString(),
      open: own.open, boundary: boundary === undefined ? null : boundary.toString(), opening: own.opening.toString() } };
  };
  // A kept base row that does not decode is kept state to discard (§14), not a refusal.
  const keptBase = (segment: Uint8Array): WalkBase | undefined => {
    try { return store.base(segment); } catch (error) {
      if (error instanceof SyntaxError || error instanceof RangeError || error instanceof TypeError) throw new KeptStateMismatch("a kept segment base");
      throw error;
    }
  };
  const baseOf = (segment: Uint8Array): SegmentBase | undefined => {
    const base = keptBase(segment);
    return base === undefined ? undefined : { openingIndex: base.openingIndex, parents: base.parents, block: base.block,
      imported: { store, frontier: { segments: new Map(base.imports), totals: base.totals }, adoptionIndices: new Map(base.adoption) } };
  };
  const classify = (held: HeldCommitment, backing: Uint8Array): Promise<ScopeVerdict> => {
    const id = keyOf(held.commitment), key = rowKey(held.commitment), classified = store.verdict(walk, key);
    if (classified !== undefined) return Promise.resolve(load(classified, backing));
    if (running.has(id)) return running.get(id)!;
    let kept: WalkVerdict | undefined;
    try { kept = store.keptVerdict(key); } catch (error) {
      if (error instanceof SyntaxError || error instanceof RangeError) throw new KeptStateMismatch("a kept class's row");
      throw error;
    }
    // §14 kept classes: the venue must hold the same commitment at the same index.
    if (kept !== undefined && (kept.index !== held.index || !same(kept.signature, held.commitment.signature))) {
      return Promise.reject(new KeptStateMismatch("a kept class's commitment"));
    }
    const pending = judge(held, backing, kept).then(verdict => {
      // Every check before replay ran afresh, so a kept class is the one it gives.
      if (kept !== undefined && verdict.class !== kept.class) throw new KeptStateMismatch("a kept class");
      // The row is written again from this judgment, so what later reads load comes from this read's evidence.
      keep(held, verdict); judgedHere.add(hex(key));
      store.keepPoint();
      return verdict;
    });
    running.set(id, pending);
    const done = (): void => { running.delete(id); };
    pending.then(done, done);
    return pending;
  };
  // Judge a checkpoint. With a kept class, every check and dependency the judgment reads still runs, on this
  // read's evidence; only the replay is taken from the kept class (§14), once its state passes its checks.
  const judge = async (held: HeldCommitment, backing: Uint8Array, kept?: WalkVerdict): Promise<ScopeVerdict> => {
    const c = held.commitment, directory = evidence.directory(c.root);
    if (directory === undefined) throw new EvidenceRefusal("unresolved-evidence");
    const entry = directory.find(item => same(item.name, backing));
    if (entry === undefined) throw new EvidenceRefusal("unresolved-evidence");
    const snapshot = snapshotFor(entry.digest);
    // The segment and scope are those the directory's first snapshot names, whichever backing the reader
    // holds, so every reader judges one class (C2.10.11, pool-v3 §7.1); a snapshot naming another segment
    // fails SNAPSHOT below, after lapse.
    const first = directory[0]!, named = same(first.name, backing) ? snapshot : snapshotFor(first.digest);
    const scope = checkpointScope(construction, trails, first.name, first.digest, named), { header } = scope, { segment } = named;
    await faults.inspect(held, directory, scope);
    // The descent had visited this checkpoint once its faults were inspected.
    began = true;
    store.putScope(segment, frames.header.segmentBytes(header), scope.terms);
    // Required scope is discovered only after its header is authenticated;
    // checkpointScope resolved and verified every scoped terms field.
    const scopedTerms = new Map(header.entries.map((scoped, i) => [hex(scoped.backing), scope.rootTerms[i]!]));
    const scopeViews = new Map<string, RecordView>();
    const base: Classified = { commitment: c, index: held.index, segment, header, snapshot };
    try {
      requireReplay(same(header.domain, selection.domain) && same(header.venue, selection.venue) &&
        same(header.operator, c.operator) && header.sequence <= c.sequence, "CONTEXT");
      let lapsed = false, termsInForce = true;
      for (const scoped of header.entries) {
        const terms = scopedTerms.get(hex(scoped.backing))!;
        requireReplay(same(terms.configuration, selection.domain) && same(terms.venue, selection.venue), "TERMS_CONTEXT");
        const view = await viewFor(scoped.backing, terms); scopeViews.set(hex(scoped.backing), view);
        const own = view.chain.find(term => same(term.link, scoped.link));
        const current = linkInForce(view.chain, held.index);
        if (own !== undefined && same(own.operator, c.operator) && own.from < current.from) lapsed = true;
        if (own === undefined || !same(own.operator, c.operator) || !same(own.link, current.link)) termsInForce = false;
      }
      if (lapsed) return { ...base, class: "lapsed" };
      requireReplay(termsInForce, "TERMS_SCOPE");
      const durations = [...scopedTerms.values()].map(terms => terms.silence?.noCommitmentDuration);
      requireReplay(durations.every(duration => duration === durations[0]), "SILENCE_SCOPE");
      // Each scoped backing's last valid checkpoint before this one, in rank order.
      const parentsOf = async (): Promise<(ValidScope | undefined)[]> => {
        const found: (ValidScope | undefined)[] = [];
        for (const scoped of header.entries) found.push(await latest(scoped.backing, scopedTerms.get(hex(scoped.backing))!, held));
        return found;
      };
      let segmentBase: SegmentBase, lastValid: ValidCheckpoint | undefined, openingValid: boolean;
      const opening = c.sequence === header.sequence;
      if (opening) {
        const parents = await parentsOf();
        for (let i = 0; i < header.entries.length; i++) {
          const scoped = header.entries[i]!, parent = parents[i];
          requireReplay(parent === undefined ? scoped.opening === undefined : matches(scoped.opening, parent.commitment), "IMPORT");
          if (parent !== undefined && !same(parent.commitment.operator, c.operator)) {
            const view = scopeViews.get(hex(scoped.backing))!;
            requireReplay(parent.index < linkInForce(view.chain, held.index).from, "IMPORT_RANK");
          }
        }
        const merged = mergeFinalizedPrefixes(store, parents), adopted: WalkForce[] = [];
        for (let i = 0; i < header.entries.length; i++) {
          const scoped = header.entries[i]!, name = hex(scoped.backing);
          merged.adoptionIndices.set(name, parents[i]?.state.adoptionIndices.get(name) ?? 0n);
          if (await recovery.forces(scoped.backing, scopedTerms.get(name)!, held.index)) {
            for (const forced of store.forced(scoped.backing, merged.adoptionIndices.get(name)!, held.index)) adopted.push(forced);
          }
        }
        segmentBase = { imported: merged, block: adopted.sort(venueOrder), openingIndex: held.index, parents: parents.map(p => p === undefined ? undefined : rowKey(p.commitment)) };
        const computed: WalkBase = { openingIndex: held.index, parents: segmentBase.parents, imports: merged.frontier.segments,
          totals: merged.frontier.totals, adoption: merged.adoptionIndices, block: segmentBase.block };
        const stored = keptBase(segment);
        if (stored === undefined) store.putBase(segment, computed);
        // A kept base must be the one this read derives (§14 kept classes).
        else if (baseKey(stored) !== baseKey(computed)) throw new KeptStateMismatch("a kept segment base");
        // The segment stands from here even if this opening's own evidence fails below:
        // a later valid checkpoint of it finalizes (C2.10.12).
        requireReplay(scope.fullTrail().length === 0n, "OPENING");
        openingValid = true;
      } else {
        const firstView = scopeViews.values().next().value!;
        const openingHeld = firstView.heldAt(c.operator, header.sequence);
        if (openingHeld === undefined) throw new EvidenceRefusal("unresolved-evidence");
        requireReplay(before(openingHeld, held), "IMPORT_RANK");
        const openingDirectory = evidence.directory(openingHeld.commitment.root);
        if (openingDirectory === undefined) throw new EvidenceRefusal("unresolved-evidence");
        // The opening is this segment's where its own first snapshot names it, as its judgment reads it,
        // whichever backing this read holds: one it omits too (C2.10.12).
        // A first entry this segment does not scope is not its opening, which the directory alone shows.
        const openingEntry = openingDirectory[0];
        requireReplay(openingEntry !== undefined && header.entries.some(scoped => same(scoped.backing, openingEntry.name)) &&
          same(snapshotFor(openingEntry.digest).segment, segment), "OPENING");
        // Lapse is judged before validity (C2.10.11), on the clock from the opening as
        // witnessed, valid or not (C2b.4.1).
        const termsOf = (name: Uint8Array): RootTerms => scopedTerms.get(hex(name))!;
        const { clocks } = await scopeClocks(header, termsOf, backing, openingHeld.index, held.index);
        const lapses = (clock: ScopeClock | null | undefined): boolean =>
          clock != null && (clock.open || (clock.boundary !== undefined && clock.boundary < held.index));
        const own = header.entries.findIndex(entry => same(entry.backing, backing)), cause = lapses(clocks[own]) ? own : clocks.findIndex(lapses);
        if (cause >= 0) {
          // The record is the clock of a backing whose gap proves the lapse (its own first).
          const { record } = await scopeClocks(header, termsOf, header.entries[cause]!.backing, openingHeld.index, held.index);
          return { ...base, class: "lapsed", ...(record === null ? {} : { clock: record }) };
        }
        openingValid = (await classify(openingHeld, openingEntry.name)).class === "valid";
        const parents = await parentsOf(), established = baseOf(segment);
        requireReplay(established !== undefined && established.openingIndex === openingHeld.index, "OPENING");
        segmentBase = established;
        // Returning to an older segment cannot abandon a valid newer one: the last valid checkpoint
        // before this one is in this segment for every scoped backing, or else each backing's
        // predecessor that the opening imported.
        const inSegment = parents.every(parent => parent !== undefined && same(parent.segment, segment) &&
          matches(parent.commitment, parents[0]!.commitment));
        const importedKey = (i: number): string | undefined => { const key = segmentBase.parents[i]; return key === undefined ? undefined : hex(key); };
        requireReplay(inSegment || parents.every((parent, i) => parent === undefined ? segmentBase.parents[i] === undefined :
          hex(rowKey(parent.commitment)) === importedKey(i)), "CONTINUITY");
        if (inSegment) lastValid = lastValidOf(parents[0]!.state, parents[0]!.snapshot);
      }
      // The segment's fixed imported base and block (C2.10.12): with an empty block a
      // continuation's replay identity is the opening's, so it resumes in that namespace.
      const { imported, block, openingIndex } = segmentBase;
      // One carried snapshot authenticates the full scope for lapse even
      // when this directory omits a sibling. Complete carriage and matching
      // sibling snapshots are finalization conditions, checked after lapse.
      requireReplay(directory.length === header.entries.length && header.entries.every(scoped =>
        directory.some(item => same(item.name, scoped.backing))), "SCOPE");
      const scopedSnapshots = header.entries.map(scoped => {
        const s = snapshotFor(directory.find(item => same(item.name, scoped.backing))!.digest);
        requireReplay(same(s.backing, scoped.backing) && same(s.segment, segment) &&
          same(s.historyHash, snapshot.historyHash) && same(s.evidenceHash, snapshot.evidenceHash), "SNAPSHOT");
        return s;
      });
      // §9.1: the opening's record-derived block bounds compact exclusion to later positions.
      const intrinsic = !opening && openingValid && lastValid !== undefined ? faults.intrinsicFailure(held, scope, BigInt(block.length)) : undefined;
      const classification = scope.classificationEvidence(intrinsic);
      if (classification.intrinsic !== undefined) return { ...base, class: "excluded", check: classification.intrinsic };
      // A kept class stands in for the replay. Its state must pass §14's checks against this read's snapshot.
      const s = kept?.state;
      if (kept !== undefined) {
        let verdict: ScopeVerdict;
        if (kept.class === "excluded" && kept.detail !== undefined) verdict = { ...base, class: "excluded", check: kept.detail };
        else if (kept.class === "valid" && s !== undefined && keptStateHolds(store, s.ns, s.position, s.identity, snapshot, construction, classification.trail, trails) &&
            scopedSnapshots.every(sibling => { const t = store.total(s.ns, s.position, hex(sibling.backing)); return t.issued === sibling.issued && t.burned === sibling.burned; })) {
          const { issued, burned } = store.total(s.ns, s.position, hex(backing));
          verdict = { ...base, class: "valid", scopedTerms, openingIndex,
            state: new ReplayResult(store, s.ns, s.position, { issued, burned, adoptionIndices: s.adoption, identity: s.identity }, construction) };
        } else throw new KeptStateMismatch("a kept class or its state");
        return verdict;
      }
      const revocations = new Map([...scopeViews].map(([name, view]) => [name, view.revokedAt]));
      const state = await replayTrail({ ...context, selection: { ...selection, backing, operator: c.operator, sequence: c.sequence, root: c.root }, terms: scopedTerms.get(hex(backing))!, header, scopedTerms },
        snapshot, classification.trail, { index: held.index, revocations, lastValid, imported, isOpening: opening,
          block: opening ? [] : block, openingIndex, scopedSnapshots });
      return { ...base, state, scopedTerms, openingIndex, class: "valid" };
    } catch (error) {
      if (!(error instanceof ReplayRefusal)) throw error;
      scope.fullTrail(); // Header-only faults are not exclusion certificates.
      return { ...base, class: "excluded", check: error.check };
    }
  };
  // Around a classified checkpoint: every scoped backing's publications through
  // t, the clock from its segment's opening with the scope's earliest boundary,
  // and the selected backing's non-service count strictly before t.
  const around = async (valid: ValidScope | undefined, terms: RootTerms, view: RecordView) => {
    const publications: ScopePublicationVerdict[] = [], force: ScopeForce[] = [];
    for (const scoped of valid?.header.entries ?? [{ backing: selection.backing }]) {
      const scopedTerms = valid?.scopedTerms.get(hex(scoped.backing)) ?? terms;
      if (!await recovery.forces(scoped.backing, scopedTerms, selection.judgingIndex)) continue;
      for (const verdict of recovery.verdictsThrough(scoped.backing, selection.judgingIndex)) publications.push(verdict);
      for (const forced of store.forced(scoped.backing, undefined, selection.judgingIndex)) force.push(forcedOf(construction, forced));
    }
    const clock = valid === undefined ? null : (await scopeClocks(valid.header, name => valid.scopedTerms.get(hex(name))!,
      selection.backing, valid.openingIndex, selection.judgingIndex)).record;
    publications.sort((a, b) => venueOrder({ index: BigInt(a.index), ordinal: BigInt(a.ordinal) }, { index: BigInt(b.index), ordinal: BigInt(b.ordinal) }));
    force.sort(venueOrder);
    // The audit may select a checkpoint at t; C2b.5.2 instead reads the whole
    // canonical scope strictly before t. Unadopted force never mutates it.
    const nonService = terms.nonService === undefined ? undefined : await countNonService({ construction, selection, terms, verifier: context.verifier }, view,
      await latest(selection.backing, terms, { index: view.t, strict: true }), view.publications());
    return { clock, publications, force, nonService };
  };
  // Reports survive a later refusal (decision 2026-09-20). The descent met a backing's newest checkpoints
  // before an older refusal and reported their compact faults, so a refused read authenticates the backing's
  // unclassified carrying checkpoints newest first (below the selection when classifying it refused) and
  // inspects them, stopping at the first classified one or the first whose directory, snapshot or scope does
  // not authenticate. It runs only with fault evidence and once classification began, as the descent visited
  // nothing otherwise. Nothing here classifies, and the read's own refusal stands: a pass stopped by missing,
  // malformed or unanswered evidence ends silently; only other failures, such as the verifier's, surface.
  const inspectRefused = async (backing: Uint8Array, terms: RootTerms): Promise<void> => {
    if (!began || faults.holdsEvidence?.() !== true) return;
    try {
      const view = await viewFor(backing, terms);
      for (let i = view.chain.length - 1; i >= 0; i--) {
        const term = view.chain[i]!, end = view.termEnd(i);
        for (let held = view.previousHeld(term.operator, end); held !== undefined && held.index >= term.from;
          held = view.previousHeld(term.operator, end, held.commitment.sequence)) {
          if (below !== undefined && !before(held, below)) continue;
          if (store.verdict(walk, rowKey(held.commitment)) !== undefined) return;
          const directory = evidence.directory(held.commitment.root);
          if (directory === undefined) return;
          const entry = directory.find(item => same(item.name, backing));
          if (entry === undefined) continue;
          const snapshot = snapshotFor(entry.digest);
          await faults.inspect(held, directory, checkpointScope(construction, trails, backing, entry.digest, snapshot));
        }
      }
    } catch (error) {
      if (!(error instanceof EvidenceRefusal || error instanceof EncodingError || error instanceof RangeLimitError || error instanceof VenueError)) throw error;
    }
  };
  // The selected backing's own carrying checkpoints within its terms through the judging index: every read classifies
  // each of them, so the listing is the same whichever earlier reads of a kept walk classified them. A dependency of
  // another backing is classified but not listed.
  // Each is tagged once, when the cursor classifies it.
  const carrying = (): ImportCarryingVerdict[] => [...store.carried(walk, selection.backing, selection.judgingIndex)].map(item => ({
    operator: hex(item.operator), sequence: item.sequence.toString(), index: item.index.toString(), class: item.class,
    ...(item.class === "excluded" ? { check: item.detail! } : {}) }));
  const refusedBelow = (held: HeldCommitment | undefined): void => { below = held; };
  return { viewFor, latest, recovery, classify, around, carrying, inspectRefused, refusedBelow, close: (): void => { store.closeWalk(walk); } };
}

