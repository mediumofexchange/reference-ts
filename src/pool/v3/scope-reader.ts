// The one C2.10.3–7, C2b.3.1–4.2 and C2b.5 reader walk, for a scope of one
// backing or several: whole-scope classification, merged finalized prefixes
// with per-backing totals and adoption indices, publication force and silence
// clocks per backing, receipt reads across a scope, the non-service count and
// compact faults. Candidate until adoption: reference venues only, no finality verdict.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes, EncodingError } from "../../bytes.js";
import { linkInForce, type HeldCommitment, type RangeEntry } from "../../record-range.js";
import type { RecordVenue } from "../../record-venue.js";
import type { Commitment } from "../../venue-records.js";
import { isValue, VALUE_BOUND } from "../field.js";
import { ScopeTree } from "../scope.js";
import { decodeReceipt, decodeSnapshot, type Snapshot } from "./commitments.js";
import type { SegmentHeader } from "./headers.js";
import type { VenueReference } from "./guard.js";
import { countNonService, type NonServiceCount } from "./non-service.js";
import { decodedTrails, lastValidOf, readRecordView, replayTrail, type CarryingVerdict, type Directories, type FaultObserver,
  type ReaderSelection, type RecordView, type ReplayContext, type ReplayResult, type ValidCheckpoint } from "./reader.js";
import { receiptWalk, type ReceiptVerdict, type ReceiptWalk } from "./receipt-state.js";
import { decodePublication, encodeRecord, type Record } from "./records.js";
import { EvidenceRefusal, ReplayRefusal, requireReplay, type ClockRecord } from "./refusals.js";
import { authenticatedScope, checkpointScope } from "./scope-evidence.js";
import type { ImportEntry, ReplayStore } from "./replay-store.js";
import { applyForceEffects, applyForceRecord, openForceState, type MergedImport } from "./state.js";
import type { RootTerms } from "./terms.js";

export interface ImportLimits { readonly maxCheckpoints: bigint; readonly maxEvents: bigint }
/** Actual work consumed by a successful read, under that read's independent limits. */
export interface ImportWork {
  readonly checkpoints: bigint;
  readonly events: bigint;
  /** The part of events spent verifying non-service request proof variants. */
  readonly requestProofs: bigint;
  /** At most one request-proof check per already-known publication. Reserve
   * this instead of requestProofs when later windows/state can admit more
   * known requests; it makes no allowance for future publication bytes. */
  readonly requestProofReserve: bigint;
}
export const IMPORT_LIMITS: ImportLimits = Object.freeze({ maxCheckpoints: 128n, maxEvents: 8192n });
export function importLimitsOf(value?: ImportLimits): ImportLimits {
  if (value === undefined) return IMPORT_LIMITS;
  if (value === null || typeof value !== "object") throw new TypeError("invalid import limits");
  const { maxCheckpoints, maxEvents } = value;
  if (!isValue(maxCheckpoints) || !isValue(maxEvents)) throw new TypeError("invalid import limits");
  return Object.freeze({ maxCheckpoints, maxEvents });
}
export interface ImportContext extends ReplayContext {
  readonly reference: VenueReference;
  readonly importLimits?: ImportLimits | undefined;
  readonly faults?: FaultObserver | undefined;
  readonly receiptBytes?: Uint8Array | undefined;
  /** Receipt evidence remains available to the caller after a later refusal. */
  receiptWalk?: Pick<ReceiptWalk, "evidence"> | undefined;
}
export interface ImportEvidence { readonly snapshots: readonly Uint8Array[]; readonly trails: readonly Uint8Array[] }
export interface CanonicalCheckpoint {
  readonly commitment: Commitment; readonly index: bigint; readonly segment: Uint8Array; readonly scope: bigint;
  readonly state: ReplayResult;
}
export interface ForcedPublication { readonly index: bigint; readonly record: Record; readonly bytes: Uint8Array }
export interface PublicationVerdict { readonly index: string; readonly ordinal: string; force: boolean; check?: string }
export interface ImportCarryingVerdict extends CarryingVerdict { readonly operator: string }
/** A complete backing descent without an asserted selected checkpoint. */
export interface FrontierContext extends Omit<ImportContext, "selection" | "header" | "receiptBytes" | "receiptWalk"> {
  readonly selection: Pick<ReaderSelection, "mode" | "domain" | "venue" | "backing" | "judgingIndex">;
}
export interface FrontierResult {
  readonly canonical: CanonicalCheckpoint | undefined;
  readonly force: readonly ScopeForcedPublication[];
  readonly work: ImportWork;
  readonly carrying: readonly ImportCarryingVerdict[];
  readonly clock: ClockRecord | null | undefined;
  readonly ranges: Omit<ScopeRanges, "checkpointIndex" | "heldBefore" | "heldAfter">;
  /** The replacement chain through the judging index of every backing the
   * canonical segment scopes, keyed by hex name. One ended term ends the
   * segment for all of them (C2.10.9). */
  readonly scopeChains: ReadonlyMap<string, RecordView["chain"]>;
}
export const NO_FAULTS: FaultObserver = { inspect: async () => {}, intrinsicFailure: () => undefined };

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
type Identity = Pick<Commitment, "operator" | "sequence" | "root">;
const keyOf = (c: Identity): string => `${hex(c.operator)}:${c.sequence}:${hex(c.root)}`;
const matches = (a: Identity | undefined, b: Identity | undefined): boolean => a !== undefined && b !== undefined && keyOf(a) === keyOf(b);
const byIndex = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
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
 * over the whole union. Each parent's events are charged, then each compared pair. */
export function mergeFinalizedPrefixes(store: ReplayStore, parents: readonly ({ readonly state: ReplayResult } | undefined)[],
  chargeEvents: (amount: bigint) => void): MergedPrefixes {
  const segments = new Map<string, ImportEntry>();
  for (const parent of new Set(parents)) {
    if (parent === undefined) continue;
    if (parent.state.store !== store) throw new Error("an import is read from its own store");
    chargeEvents(parent.state.eventCount());
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
      chargeEvents(1n);
      requireReplay(precedes(events[i]!, events[j]!) || precedes(events[j]!, events[i]!), "RECOVERY_CONFLICT");
    }
  }
  requireReplay(!facts.repeatedNullifier, "SPENT");
  requireReplay(!facts.repeatedOutput, "OUTPUT");
  requireReplay(!facts.repeatedRecovery, "REPEATED_STATEMENT");
  for (const total of facts.supply.values()) requireReplay(total.burned <= total.issued && total.issued < VALUE_BOUND, "SUPPLY");
  let events = 0n;
  for (const entry of segments.values()) events += store.eventCount(entry.ns, entry.upto) - store.eventCount(entry.ns, 0n);
  return { store, frontier: { segments, totals: facts.supply }, events, adoptionIndices: new Map() };
}

interface Classified {
  readonly commitment: Commitment; readonly index: bigint; readonly segment: Uint8Array;
  readonly header: SegmentHeader; readonly snapshot: Snapshot;
}
interface ValidScope extends Classified {
  readonly class: "valid"; readonly state: ReplayResult; readonly block: readonly ScopeForce[];
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
  readonly imported: MergedPrefixes; readonly block: readonly ScopeForce[]; readonly openingIndex: bigint;
  readonly parents: readonly (ValidScope | undefined)[];
}
interface ScopeForce { readonly backing: string; readonly index: bigint; readonly ordinal: bigint; readonly record: Record; readonly bytes: Uint8Array }
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
export interface ScopeForcedPublication extends ForcedPublication { readonly backing: string }
export type ScopeResult = {
  readonly receipt: ReceiptVerdict; readonly state?: undefined; readonly carrying?: undefined; readonly clock?: undefined;
  readonly ranges?: undefined; readonly canonical?: undefined; readonly force?: undefined; readonly work?: undefined;
} | {
  readonly receipt?: undefined; readonly state: ReplayResult; readonly carrying: readonly ImportCarryingVerdict[];
  readonly clock: ClockRecord | null; readonly ranges: ScopeRanges;
  /** The selected checkpoint, which a successful read establishes as the backing's canonical one. */
  readonly canonical: CanonicalCheckpoint;
  /** Every scoped backing's forced publications through the judging index, in venue order. */
  readonly force: readonly ScopeForcedPublication[];
  readonly work: ImportWork;
};
type Latest = (backing: Uint8Array, terms: RootTerms, child?: Child) => Promise<ValidScope | undefined>;

/** C2b.3.1–4.2 per backing. Snapshots exclude the entire publication index;
 * canonical opening predecessors additionally include lower same-key sequences. */
function scopeRecovery(context: Pick<WalkContext, "selection" | "verifier" | "receiptBytes">, viewFor: (backing: Uint8Array, terms: RootTerms) => Promise<RecordView>,
  latest: Latest, charge: (amount: bigint) => void) {
  const { selection, verifier } = context;
  const answers = new Map<string, Promise<readonly RangeEntry[]>>(), positions = new Map<string, string>();
  const progress = new Map<string, { force: ScopeForce[]; verdicts: ScopePublicationVerdict[]; next: number; busy: boolean }>();
  const heldIndices = new Map<string, Promise<bigint[]>>(), clocks = new Map<string, Promise<ScopeClock>>();
  const snapshotAt = (backing: Uint8Array, terms: RootTerms, index: bigint): Promise<ValidScope | undefined> =>
    latest(backing, terms, { index, strict: true });
  // Each publication is charged once, when its answer is read; forces and
  // counts then pass over the same entries without charging them again.
  const publications = (backing: Uint8Array, terms: RootTerms): Promise<readonly RangeEntry[]> => {
    const name = hex(backing);
    if (!answers.has(name)) answers.set(name, (async () => {
      const view = await viewFor(backing, terms), answer = await view.ask(4, backing);
      for (const entry of answer.entries) {
        charge(1n);
        const position = `${entry.index}:${entry.ordinal}`;
        if (positions.has(position)) throw new EvidenceRefusal("unresolved-evidence");
        positions.set(position, name);
      }
      return answer.entries;
    })());
    return answers.get(name)!;
  };
  const classifyPublication = async (backing: Uint8Array, terms: RootTerms, view: RecordView, duration: bigint,
    entry: RangeEntry, item: ScopePublicationVerdict, force: ScopeForce[]): Promise<void> => {
    const name = hex(backing);
    let publication;
    try { publication = decodePublication(entry.record); }
    catch (error) {
      if (error instanceof EncodingError) return;
      throw error;
    }
    if (!same(publication.domain, selection.domain) || !same(publication.backing, backing) ||
        publication.kind === 2 || publication.kind === 5) return;
    const snapshot = await snapshotAt(backing, terms, entry.index);
    if (snapshot === undefined || entry.index - snapshot.index <= duration) return;
    const source = snapshot.state;
    const state = openForceState(source);
    for (const prior of force) if (prior.index > (source.adoptionIndices.get(name) ?? 0n)) {
      charge(1n); applyForceEffects(state, prior.record);
    }
    const record = publication.record;
    try {
      await applyForceRecord(state, encodeRecord(record), { mode: "force", domain: selection.domain, backing,
        segment: snapshot.segment, scope: new ScopeTree(snapshot.header.entries).root(), issuer: terms.obligor,
        index: entry.index, lag: view.lag, verifier });
      force.push({ backing: name, index: entry.index, ordinal: entry.ordinal, record, bytes: encodeRecord(record) });
      item.force = true;
    } catch (error) {
      if (!(error instanceof ReplayRefusal)) throw error;
      item.check = error.check;
    }
  };
  // A publication's verdict depends on its own index, the snapshot strictly
  // before it and the force of earlier publications, never on how far a caller
  // reads. Each backing's publications are therefore classified once, in venue
  // order, and a read through an index returns that prefix.
  const forces = async (backing: Uint8Array, terms: RootTerms, through: bigint):
    Promise<{ force: ScopeForce[]; verdicts: ScopePublicationVerdict[] }> => {
    const name = hex(backing), duration = terms.silence?.noCommitmentDuration;
    if (duration === undefined) return { force: [], verdicts: [] };
    // Earlier receipt inclusion must not depend on publication availability
    // after the first gap. Strict-prefix clock reads descend in index here.
    if (context.receiptBytes !== undefined && (await clock(backing, terms, 0n, through))!.boundary === undefined) return { force: [], verdicts: [] };
    const view = await viewFor(backing, terms), entries = await publications(backing, terms);
    if (!progress.has(name)) progress.set(name, { force: [], verdicts: [], next: 0, busy: false });
    const read = progress.get(name)!, { force, verdicts } = read;
    while (read.next < entries.length && entries[read.next]!.index <= through) {
      // Nested reads come from snapshots strictly before the entry in progress.
      if (read.busy) throw new Error("publication prefix order");
      read.busy = true;
      try {
        const entry = entries[read.next]!;
        const item: ScopePublicationVerdict = { backing: name, index: entry.index.toString(), ordinal: entry.ordinal.toString(), force: false };
        verdicts.push(item);
        await classifyPublication(backing, terms, view, duration, entry, item, force);
      } finally { read.busy = false; }
      read.next++;
    }
    const after = verdicts.findIndex(item => BigInt(item.index) > through);
    return { force: force.filter(event => event.index <= through),
      verdicts: verdicts.slice(0, after < 0 ? verdicts.length : after).map(item => ({ ...item })) };
  };
  // Every held index within its own term, scanned and charged once per backing.
  const termIndices = (backing: Uint8Array, terms: RootTerms): Promise<bigint[]> => {
    const name = hex(backing);
    if (!heldIndices.has(name)) heldIndices.set(name, (async () => {
      const view = await viewFor(backing, terms), indices = new Set<bigint>();
      for (let i = 0; i < view.chain.length; i++) for (const held of await view.heldBy(view.chain[i]!.operator)) {
        charge(1n);
        if (held.index >= view.chain[i]!.from && held.index <= view.termEnd(i)) indices.add(held.index);
      }
      return [...indices].sort(byIndex);
    })());
    return heldIndices.get(name)!;
  };
  // One clock per backing, opening and index; each caller receives its own copy.
  const clock = async (backing: Uint8Array, terms: RootTerms, opening: bigint, through: bigint): Promise<ScopeClock | null> => {
    const duration = terms.silence?.noCommitmentDuration;
    if (duration === undefined) return null;
    const key = `${hex(backing)}:${opening}:${through}`;
    if (!clocks.has(key)) clocks.set(key, (async () => {
      // A reset is a breakpoint even if the gap's first index has no record.
      const points = new Set([through]);
      for (const at of await termIndices(backing, terms)) if (at > opening && at <= through) points.add(at);
      let boundary: bigint | undefined, last = 0n;
      for (const at of [...points].sort(byIndex)) {
        last = (await snapshotAt(backing, terms, at))?.index ?? 0n;
        if (at > opening && at - last > duration && boundary === undefined) {
          const first = last + duration + 1n;
          boundary = first > opening ? first : opening + 1n;
        }
      }
      return { duration, snapshotIndex: last, gap: through - last, open: through - last > duration, boundary, opening };
    })());
    return { ...await clocks.get(key)! };
  };
  return { forces, clock, publications };
}

/** C2.10.3–7 over a scope of several backings. Each checkpoint is classified
 * once from its own committed evidence: its authenticated header fixes the
 * scope, every scoped backing's canonical predecessor is found by descending
 * that backing's terms in reverse rank order, and an opening imports their
 * merged finalized prefixes with each backing's adoption index. Continuations
 * resume from their segment's opening. Unrelated old trails are not read.
 * A receipt instead returns its verdict at the deciding checkpoint or boundary. */
export async function classifyScopes(context: ImportContext, directories: Directories, record: RecordVenue,
  evidence: ImportEvidence): Promise<ScopeResult> {
  const { selection } = context;
  const walk = scopeWalk(context, directories, record, evidence), { viewFor, latest, recovery, classify, inspect, chargeEvents } = walk;
  const trails = decodedTrails(evidence.trails);
  const view = await viewFor(selection.backing, context.terms);
  const selectedHeld = (await view.heldBy(selection.operator)).find(held => matches(held.commitment, selection));
  if (selectedHeld === undefined) throw new EvidenceRefusal("selection-mismatch");
  if (context.receiptBytes !== undefined) {
    const receipt = decodeReceipt(context.receiptBytes);
    const original = authenticatedScope(trails, receipt.segment);
    const { header } = original, scopeViews = new Map<string, RecordView>(), termsByBacking = new Map<string, RootTerms>();
    // authenticatedScope resolved and verified every scoped terms field.
    for (let i = 0; i < header.entries.length; i++) {
      const scoped = header.entries[i]!, terms = original.rootTerms[i]!;
      if (!same(terms.configuration, selection.domain) || !same(terms.venue, selection.venue)) throw new EvidenceRefusal("invalid-receipt");
      termsByBacking.set(hex(scoped.backing), terms);
      scopeViews.set(hex(scoped.backing), await viewFor(scoped.backing, terms));
    }
    const walk = await receiptWalk(context.receiptBytes, context, view, trails, evidence.snapshots, scopeViews);
    context.receiptWalk = walk;
    let openingIndex: bigint | undefined;
    const boundary = async (at: bigint): Promise<ReceiptVerdict | undefined> => {
      if (openingIndex === undefined) return undefined;
      const through = walk.termBoundary !== undefined && walk.termBoundary < at ? walk.termBoundary : at;
      let earliest: bigint | undefined;
      for (const scoped of header.entries) {
        const clock = await recovery.clock(scoped.backing, termsByBacking.get(hex(scoped.backing))!, openingIndex, through);
        if (clock?.boundary !== undefined && (earliest === undefined || clock.boundary < earliest)) earliest = clock.boundary;
      }
      return walk.boundary(at, { boundary: earliest });
    };
    for (const held of await view.heldBy(header.operator)) {
      if (held.commitment.sequence < header.sequence) continue;
      inspect(held);
      const ended = await boundary(held.index);
      if (ended !== undefined) return { receipt: ended };
      const scoped = header.entries.find(entry => scopeViews.get(hex(entry.backing))!.carries(held) !== undefined);
      if (scoped === undefined) { walk.checkpoint(held, undefined, undefined, undefined, "other"); continue; }
      const result = await classify(held, scoped.backing);
      const verdict = walk.checkpoint(held, result.segment, result.class === "valid" ? result.state : undefined, result.header, result.class);
      // The original opening as witnessed anchors the boundary, valid or excluded (C2b.4.1).
      if (result.class !== "lapsed" && same(result.segment, receipt.segment) && held.commitment.sequence === header.sequence) openingIndex = held.index;
      if (verdict !== undefined) return { receipt: verdict };
    }
    return { receipt: await boundary(view.t) ?? walk.finish() };
  }
  if (!same(linkInForce(view.chain, selectedHeld.index).operator, selection.operator)) throw new EvidenceRefusal("lapsed-selection");
  // Every held commitment in the backing's terms, carrying or not, counted around the
  // selection. Those after it are placed by their directories before any proof is
  // checked, so evidence withheld there refuses before the selection's trail is verified.
  let heldBefore = 0, heldAfter = 0, passed = false;
  for (let i = 0; i < view.chain.length; i++) for (const held of await view.heldBy(view.chain[i]!.operator)) {
    if (held.index < view.chain[i]!.from || held.index > view.termEnd(i)) continue;
    if (matches(held.commitment, selection)) passed = true;
    else if (passed) { heldAfter++; view.carries(held); } else heldBefore++;
  }
  const selected = await classify(selectedHeld, selection.backing);
  if (selected.class === "lapsed") throw Object.assign(new EvidenceRefusal("lapsed-selection"), selected.clock === undefined ? {} : { clock: selected.clock });
  if (selected.class === "excluded") throw new ReplayRefusal(selected.check);
  const current = await latest(selection.backing, context.terms);
  if (!matches(current?.commitment, selection)) throw new EvidenceRefusal("superseded-selection");
  const { clock, publications, force, nonService } = await walk.around(selected, context.terms, view);
  const { carrying } = await walk.carrying();
  return { state: selected.state, carrying, clock, canonical: canonicalOf(selected), force, work: await walk.work(context.terms), ranges: {
    judgingIndex: view.t, lag: view.lag, checkpointIndex: selectedHeld.index, revokedAt: view.revokedAt, chain: view.chain,
    heldBefore, heldAfter, publications, ...(nonService === undefined ? {} : { nonService }) } };
}

/** C2.7 descent for one backing's independently authenticated terms in any
 * scope: its canonical checkpoint, if the record holds one, with every scoped
 * backing's forced publications, the clock and the work. */
export async function classifyScopeFrontier(context: FrontierContext, directories: Directories, record: RecordVenue,
  evidence: ImportEvidence): Promise<FrontierResult> {
  const { selection, terms } = context, walk = scopeWalk(context, directories, record, evidence);
  const view = await walk.viewFor(selection.backing, terms), canonical = await walk.latest(selection.backing, terms);
  const around = await walk.around(canonical, terms, view), { carrying } = await walk.carrying();
  const scopeChains = new Map<string, RecordView["chain"]>();
  for (const [name, scoped] of canonical?.scopedTerms ?? []) scopeChains.set(name, (await walk.viewFor(hexToBytes(name), scoped)).chain);
  return { canonical: canonical === undefined ? undefined : canonicalOf(canonical), force: around.force, work: await walk.work(terms), carrying, scopeChains,
    clock: canonical === undefined ? undefined : around.clock, ranges: { judgingIndex: view.t, lag: view.lag, revokedAt: view.revokedAt,
      chain: view.chain, publications: around.publications, ...(around.nonService === undefined ? {} : { nonService: around.nonService }) } };
}

const canonicalOf = (valid: ValidScope): CanonicalCheckpoint => ({ commitment: valid.commitment, index: valid.index, segment: valid.segment,
  scope: new ScopeTree(valid.header.entries).root(), state: valid.state });

/** What a scope read needs besides a selected checkpoint or backing. */
type WalkContext = FrontierContext & Pick<ImportContext, "receiptBytes">;

/** Whole-scope classification, shared by selected and frontier reads. Every
 * checkpoint is classified once; work is charged against the reader's limits. */
function scopeWalk(context: WalkContext, directories: Directories, record: RecordVenue, evidence: ImportEvidence) {
  const { selection } = context, faults = context.faults ?? NO_FAULTS, limits = importLimitsOf(context.importLimits);
  const trails = decodedTrails(evidence.trails), snapshots = new Map(evidence.snapshots.map(bytes => [hex(sha256(bytes)), bytes]));
  const views = new Map<string, Promise<RecordView>>(), verified = new Map<string, Promise<ScopeVerdict>>();
  const heldSeen = new Set<string>(), latestCache = new Map<string, Promise<ValidScope | undefined>>();
  let eventWork = 0n, requestProofs = 0n;
  const chargeEvents = (amount: bigint): void => {
    eventWork += amount;
    if (eventWork > limits.maxEvents) throw new EvidenceRefusal("resource-refusal");
  };
  const inspect = (held: HeldCommitment): void => {
    heldSeen.add(keyOf(held.commitment));
    if (BigInt(heldSeen.size) > limits.maxCheckpoints) throw new EvidenceRefusal("resource-refusal");
  };
  const viewFor = (backing: Uint8Array, terms: RootTerms): Promise<RecordView> => {
    const id = hex(backing);
    if (!views.has(id)) views.set(id, readRecordView({ ...selection, backing }, terms, directories, record, context.reference));
    return views.get(id)!;
  };
  const snapshotFor = (digest: Uint8Array): Snapshot => {
    const bytes = snapshots.get(hex(digest));
    if (bytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
    return decodeSnapshot(bytes);
  };
  // Descend authenticated carriage in reverse rank order. A valid candidate
  // recursively resolves its own predecessors; unrelated old trails are not read.
  const latest: Latest = (backing, terms, child) => {
    const cacheKey = `${hex(backing)}:${child === undefined ? "current" : child.strict ? `before:${child.index}` : keyOf(child.commitment)}`;
    if (latestCache.has(cacheKey)) return latestCache.get(cacheKey)!;
    const pending = (async () => {
      const view = await viewFor(backing, terms);
      for (let i = view.chain.length - 1; i >= 0; i--) {
        const term = view.chain[i]!;
        if (child !== undefined && (term.from > child.index ||
            (term.from === child.index && (child.strict || !same(term.operator, child.commitment.operator))))) continue;
        const held = await view.heldBy(term.operator);
        for (let j = held.length - 1; j >= 0; j--) {
          const candidate = held[j]!;
          inspect(candidate);
          if (candidate.index < term.from || candidate.index > view.termEnd(i) || !before(candidate, child)) continue;
          if (view.carries(candidate) === undefined) continue;
          const result = await classify(candidate, backing);
          if (result.class === "valid") return result;
        }
      }
      return undefined;
    })();
    latestCache.set(cacheKey, pending);
    return pending;
  };
  const recovery = scopeRecovery(context, viewFor, latest, chargeEvents);
  const bases = new Map<string, SegmentBase>();
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
  const classify =(held: HeldCommitment, backing: Uint8Array): Promise<ScopeVerdict> => {
    const id = keyOf(held.commitment);
    if (verified.has(id)) return verified.get(id)!;
    const pending = (async (): Promise<ScopeVerdict> => {
      inspect(held);
      const c = held.commitment, directory = directories.get(hex(c.root));
      if (directory === undefined) throw new EvidenceRefusal("unresolved-evidence");
      const entry = directory.find(item => same(item.name, backing));
      if (entry === undefined) throw new EvidenceRefusal("unresolved-evidence");
      const snapshot = snapshotFor(entry.digest);
      const scope = checkpointScope(trails, backing, entry.digest, snapshot), { header } = scope;
      await faults.inspect(held, directory, scope);
      // Required scope is discovered only after its header is authenticated;
      // checkpointScope resolved and verified every scoped terms field.
      const scopedTerms = new Map(header.entries.map((scoped, i) => [hex(scoped.backing), scope.rootTerms[i]!]));
      const scopeViews = new Map<string, RecordView>();
      const base: Classified = { commitment: c, index: held.index, segment: snapshot.segment, header, snapshot };
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
          const merged = mergeFinalizedPrefixes(context.store, parents, chargeEvents), adopted: ScopeForce[] = [];
          for (let i = 0; i < header.entries.length; i++) {
            const scoped = header.entries[i]!, name = hex(scoped.backing);
            merged.adoptionIndices.set(name, parents[i]?.state.adoptionIndices.get(name) ?? 0n);
            const published = await recovery.forces(scoped.backing, scopedTerms.get(name)!, held.index);
            adopted.push(...published.force.filter(event => event.index > merged.adoptionIndices.get(name)!));
          }
          segmentBase = { imported: merged, block: adopted.sort(venueOrder), openingIndex: held.index, parents };
          if (!bases.has(hex(snapshot.segment))) bases.set(hex(snapshot.segment), segmentBase);
          // The segment stands from here even if this opening's own evidence fails below:
          // a later valid checkpoint of it finalizes (C2.10.12).
          requireReplay(scope.fullTrail().records.length === 0, "OPENING");
          openingValid = true;
        } else {
          const firstView = scopeViews.values().next().value!;
          const openingHeld = (await firstView.heldBy(c.operator)).find(item => item.commitment.sequence === header.sequence);
          if (openingHeld === undefined) throw new EvidenceRefusal("unresolved-evidence");
          requireReplay(before(openingHeld, held), "IMPORT_RANK");
          const openingDirectory = directories.get(hex(openingHeld.commitment.root));
          if (openingDirectory === undefined) throw new EvidenceRefusal("unresolved-evidence");
          const openingEntry = openingDirectory.find(item => same(item.name, backing));
          requireReplay(openingEntry !== undefined && same(snapshotFor(openingEntry.digest).segment, snapshot.segment), "OPENING");
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
          openingValid = (await classify(openingHeld, backing)).class === "valid";
          const parents = await parentsOf(), established = bases.get(hex(snapshot.segment));
          requireReplay(established !== undefined && established.openingIndex === openingHeld.index, "OPENING");
          segmentBase = established;
          // Returning to an older segment cannot abandon a valid newer one: the last valid checkpoint
          // before this one is in this segment for every scoped backing, or else each backing's
          // predecessor that the opening imported.
          const inSegment = parents.every(parent => parent !== undefined && same(parent.segment, snapshot.segment) &&
            matches(parent.commitment, parents[0]!.commitment));
          requireReplay(inSegment || parents.every((parent, i) => parent === undefined ? segmentBase.parents[i] === undefined :
            matches(parent.commitment, segmentBase.parents[i]?.commitment)), "CONTINUITY");
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
          requireReplay(same(s.backing, scoped.backing) && same(s.segment, snapshot.segment) &&
            same(s.historyHash, snapshot.historyHash) && same(s.evidenceHash, snapshot.evidenceHash), "SNAPSHOT");
          return s;
        });
        // §9.1: the opening's record-derived block bounds compact exclusion to later positions.
        const intrinsic = !opening && openingValid && lastValid !== undefined ? faults.intrinsicFailure(held, scope, BigInt(block.length)) : undefined;
        const classification = scope.classificationEvidence(intrinsic);
        if (classification.intrinsic !== undefined) return { ...base, class: "excluded", check: classification.intrinsic };
        const revocations = new Map([...scopeViews].map(([name, view]) => [name, view.revokedAt]));
        const state = await replayTrail({ ...context, selection: { ...selection, backing, operator: c.operator, sequence: c.sequence, root: c.root }, terms: scopedTerms.get(hex(backing))!, header, scopedTerms },
          snapshot, classification.trail, { index: held.index, revocations, lastValid, imported, isOpening: opening,
            block: opening ? [] : block, openingIndex, chargeEvents, scopedSnapshots });
        return { ...base, state, block, scopedTerms, openingIndex, class: "valid" };
      } catch (error) {
        if (!(error instanceof ReplayRefusal)) throw error;
        scope.fullTrail(); // Header-only faults are not exclusion certificates.
        return { ...base, class: "excluded", check: error.check };
      }
    })();
    verified.set(id, pending);
    return pending;
  };
  // Around a classified checkpoint: every scoped backing's publications through
  // t, the clock from its segment's opening with the scope's earliest boundary,
  // and the selected backing's non-service count strictly before t.
  const around = async (valid: ValidScope | undefined, terms: RootTerms, view: RecordView) => {
    const publications: ScopePublicationVerdict[] = [], force: ScopeForce[] = [];
    for (const scoped of valid?.header.entries ?? [{ backing: selection.backing }]) {
      const scopedTerms = valid?.scopedTerms.get(hex(scoped.backing)) ?? terms;
      const published = await recovery.forces(scoped.backing, scopedTerms, selection.judgingIndex);
      publications.push(...published.verdicts);
      force.push(...published.force);
    }
    const clock = valid === undefined ? null : (await scopeClocks(valid.header, name => valid.scopedTerms.get(hex(name))!,
      selection.backing, valid.openingIndex, selection.judgingIndex)).record;
    publications.sort((a, b) => venueOrder({ index: BigInt(a.index), ordinal: BigInt(a.ordinal) }, { index: BigInt(b.index), ordinal: BigInt(b.ordinal) }));
    force.sort(venueOrder);
    // The audit may select a checkpoint at t; C2b.5.2 instead reads the whole
    // canonical scope strictly before t. Unadopted force never mutates it.
    const nonService = terms.nonService === undefined ? undefined : await countNonService({ selection, terms, verifier: context.verifier }, view,
      await latest(selection.backing, terms, { index: view.t, strict: true }),
      await recovery.publications(selection.backing, terms), () => { requestProofs++; chargeEvents(1n); });
    return { clock, publications, force, nonService };
  };
  const carrying = async () => {
    const results = await Promise.all(verified.values());
    return { results, carrying: results.sort((a, b) => a.index < b.index ? -1 : a.index > b.index ? 1 :
      a.commitment.sequence < b.commitment.sequence ? -1 : a.commitment.sequence > b.commitment.sequence ? 1 : 0)
      .map(item => ({ operator: hex(item.commitment.operator), sequence: item.commitment.sequence.toString(), index: item.index.toString(),
        class: item.class, ...(item.class === "excluded" ? { check: item.check } : {}) })) };
  };
  // Known requests may enter a later counting window: at most one proof check
  // per already-known publication of the selected backing (ImportWork).
  const work = async (terms: RootTerms): Promise<ImportWork> => ({ checkpoints: BigInt(heldSeen.size), events: eventWork, requestProofs,
    requestProofReserve: terms.nonService === undefined ? 0n : BigInt((await recovery.publications(selection.backing, terms)).length) });
  return { viewFor, latest, recovery, classify, inspect, chargeEvents, around, carrying, work };
}
