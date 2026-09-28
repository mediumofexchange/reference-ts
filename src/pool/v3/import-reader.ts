// Single-backing C2.10 import, silence, force and non-service classification.
// Caller-owned evidence and independent venue answers feed the one runtime replay.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes, EncodingError } from "../../bytes.js";
import { linkInForce, type RangeEntry } from "../../record-range.js";
import type { RecordVenue } from "../../record-venue.js";
import type { Commitment } from "../../venue-records.js";
import { isValue } from "../field.js";
import { ScopeTree } from "../scope.js";
import { decodeReceipt, decodeSnapshot } from "./commitments.js";
import { decodeSegmentHeader } from "./headers.js";
import type { VenueReference } from "./guard.js";
import { countNonService, type NonServiceCount } from "./non-service.js";
import { decodedTrails, readRecordView, replayTrail, type CarryingVerdict, type Directories,
  type FaultObserver, type ReaderSelection, type RecordView, type ReplayContext, type ReplayResult, type ValidCheckpoint } from "./reader.js";
import { receiptWalk, type ReceiptVerdict, type ReceiptWalk } from "./receipt-state.js";
import { decodePublication, encodeRecord, type Record } from "./records.js";
import { EvidenceRefusal, ReplayRefusal, ScopeRequired, requireReplay, type ClockRecord } from "./refusals.js";
import { checkpointScope } from "./scope-evidence.js";
import { applyForceEffects, applyForceRecord, openForceState } from "./state.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
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
  contextReceipt?: ReplayContext["contextReceipt"];
}
export interface ImportEvidence { readonly snapshots: readonly Uint8Array[]; readonly trails: readonly Uint8Array[] }
export type CheckpointIdentity = Pick<Commitment, "operator" | "sequence" | "root">;
export interface CanonicalCheckpoint {
  readonly commitment: Commitment; readonly index: bigint; readonly segment: Uint8Array; readonly scope: bigint;
  readonly state: ReplayResult;
}
export interface ForcedPublication { readonly index: bigint; readonly record: Record; readonly bytes: Uint8Array }
export interface ImportClock { readonly opening: bigint; boundary: bigint | undefined }
export interface PublicationVerdict { readonly index: string; readonly ordinal: string; force: boolean; check?: string }
export interface ImportCarryingVerdict extends CarryingVerdict { readonly operator: string }
export interface ImportRanges {
  readonly judgingIndex: bigint; readonly lag: bigint; readonly checkpointIndex: bigint; readonly revokedAt: bigint | undefined;
  readonly heldBefore: number; readonly heldAfter: number; readonly chain: RecordView["chain"];
  readonly publications: readonly PublicationVerdict[]; readonly nonService?: NonServiceCount;
}
/** A complete backing descent without an asserted selected checkpoint. */
export interface FrontierContext extends Omit<ImportContext, "selection" | "header" | "receiptBytes" | "receiptWalk" | "contextReceipt"> {
  readonly selection: Pick<ReaderSelection, "mode" | "domain" | "venue" | "backing" | "judgingIndex">;
}
export interface FrontierResult {
  readonly canonical: CanonicalCheckpoint | undefined;
  readonly force: readonly ForcedPublication[];
  readonly work: ImportWork;
  readonly carrying: readonly ImportCarryingVerdict[];
  readonly clock: ClockRecord | null | undefined;
  readonly ranges: Omit<ImportRanges, "checkpointIndex" | "heldBefore" | "heldAfter">;
}
export type ImportResult = {
  readonly receipt: ReceiptVerdict; readonly state?: undefined; readonly carrying?: undefined; readonly clock?: undefined;
  readonly ranges?: undefined; readonly canonical?: undefined; readonly force?: undefined; readonly selectedClock?: undefined;
  readonly work?: undefined;
} | {
  readonly receipt?: undefined; readonly state: ReplayResult; readonly carrying: readonly ImportCarryingVerdict[];
  readonly clock: ClockRecord | null; readonly ranges: ImportRanges; readonly canonical: CanonicalCheckpoint;
  readonly force: readonly ForcedPublication[]; readonly selectedClock: ImportClock;
  readonly work: ImportWork;
};
interface ImportSegment {
  readonly imported: ReplayResult | undefined; readonly predecessor: Commitment | undefined;
  lastValid: ValidCheckpoint | undefined; readonly openingIndex: bigint; readonly block: readonly ForcedPublication[];
  openingValid?: boolean;
}
export const NO_FAULTS: FaultObserver = { inspect: async () => {}, intrinsicFailure: () => undefined };

/** C2.10.3–7 for a single backing. Its canonical
 * ancestry is linear: each new segment imports the last valid checkpoint's
 * closure once. Every checkpoint is classified at its own prefix, and every
 * continuation replays from its segment's fixed opening base. No union of
 * raw trails, recursion, or replica-provided finality is involved. */
export async function classifyImports(context: ImportContext, directories: Directories, record: RecordVenue,
  evidence: ImportEvidence): Promise<ImportResult> {
  return walkImports(context, directories, record, evidence, context);
}

export async function classifyFrontier(context: FrontierContext, directories: Directories, record: RecordVenue,
  evidence: ImportEvidence): Promise<FrontierResult> {
  return walkImports(context, directories, record, evidence);
}

function walkImports(context: FrontierContext, directories: Directories, record: RecordVenue,
  evidence: ImportEvidence): Promise<FrontierResult>;
function walkImports(context: FrontierContext, directories: Directories, record: RecordVenue,
  evidence: ImportEvidence, selectedContext: ImportContext): Promise<ImportResult>;
async function walkImports(context: FrontierContext, directories: Directories, record: RecordVenue,
  evidence: ImportEvidence, selectedContext?: ImportContext): Promise<ImportResult | FrontierResult> {
  const { selection, terms } = context;
  const selectedSelection = selectedContext?.selection, receiptBytes = selectedContext?.receiptBytes;
  const faults = context.faults ?? NO_FAULTS;
  const view = await readRecordView(selection, terms, directories, record, context.reference);
  const { chain, heldBy, termEnd, carries, revokedAt, t, lag } = view;
  const duration = terms.silence?.noCommitmentDuration;
  const counting = terms.nonService !== undefined && receiptBytes === undefined;
  let publications: readonly RangeEntry[] | undefined = duration === undefined && !counting ? [] : receiptBytes === undefined ?
    (await view.ask(4, selection.backing)).entries : undefined;
  const selectedHeld = selectedSelection === undefined ? undefined : (await heldBy(selectedSelection.operator))
    .find(h => h.commitment.sequence === selectedSelection.sequence && same(h.commitment.root, selectedSelection.root));
  if (selectedSelection !== undefined) {
    if (selectedHeld === undefined) throw new EvidenceRefusal("selection-mismatch");
    if (!same(linkInForce(chain, selectedHeld.index).operator, selectedSelection.operator)) throw new EvidenceRefusal("lapsed-selection");
  }
  const trails = decodedTrails(evidence.trails), segments = new Map<string, ImportSegment>(), clocks = new Map<string, ImportClock>(), carrying: ImportCarryingVerdict[] = [];
  if (receiptBytes !== undefined) {
    const receipt = decodeReceipt(receiptBytes);
    const original = trails.find(trail => same(sha256(trail.header), receipt.segment));
    if (original !== undefined && decodeSegmentHeader(original.header).entries.length !== 1) throw new ScopeRequired();
  }
  const walk = receiptBytes === undefined ? undefined :
    await receiptWalk(receiptBytes, selectedContext!, view, trails, evidence.snapshots);
  if (selectedContext !== undefined) {
    selectedContext.receiptWalk = walk;
    selectedContext.contextReceipt = walk?.receipt;
  }
  const matches = (a: CheckpointIdentity | undefined, b: CheckpointIdentity | undefined): boolean => a !== undefined && b !== undefined && a.sequence === b.sequence && same(a.operator, b.operator) && same(a.root, b.root);
  let canonical: CanonicalCheckpoint | undefined, countSnapshot: CanonicalCheckpoint | undefined;
  let selectedState: ReplayResult | undefined, selectedClock: ImportClock | undefined;
  let checkpoints = 0n, events = 0n, heldBefore = 0, heldAfter = 0;
  let publicationAt = 0;
  const force: ForcedPublication[] = [], publicationVerdicts: PublicationVerdict[] = [];
  const limits = importLimitsOf(context.importLimits);
  const charge = (amount = 1n) => { events += amount; if (events > limits.maxEvents) throw new EvidenceRefusal("resource-refusal"); };
  // Each publication is charged once, for its answer; later passes do not charge it again.
  if (publications !== undefined) charge(BigInt(publications.length));
  // At one index the whole publication group is read BEFORE any checkpoint.
  // Effects change recovery state but never extend the snapshot's forest.
  const publishThrough = async (through: bigint): Promise<void> => {
    // A non-service clause alone gives requests a count, never recovery force.
    if (duration === undefined) return;
    // Receipt inclusion before any gap needs no later publication evidence.
    if (publications === undefined) {
      if (canonical === undefined || through - canonical.index <= duration) return;
      publications = (await view.ask(4, selection.backing)).entries;
      charge(BigInt(publications.length));
    }
    while (publicationAt < publications.length && publications[publicationAt]!.index <= through) {
      const entry = publications[publicationAt++]!, item: PublicationVerdict = { index: entry.index.toString(), ordinal: entry.ordinal.toString(), force: false };
      publicationVerdicts.push(item);
      let publication;
      try { publication = decodePublication(entry.record); }
      catch (error) {
        if (error instanceof EncodingError) continue;
        throw error;
      }
      if (!same(publication.domain, selection.domain) || !same(publication.backing, selection.backing) ||
          publication.kind === 2 || publication.kind === 5 || canonical === undefined ||
          entry.index - canonical.index <= duration) continue;
      // canonical is strictly before entry.index: the group is processed once
      // before the first held checkpoint there, including non-carrying ones.
      if (canonical.index >= entry.index) throw new Error("publication prefix order");
      const source = canonical.state, state = openForceState(source);
      for (const prior of force) if (prior.index > source.adoptionIndex) { charge(); applyForceEffects(state, prior.record); }
      const record = publication.record;
      try {
        await applyForceRecord(state, encodeRecord(record), { mode: "force", domain: selection.domain, backing: selection.backing,
          segment: canonical.segment, scope: canonical.scope, issuer: terms.obligor, index: entry.index, lag, verifier: context.verifier });
        force.push({ index: entry.index, record, bytes: encodeRecord(record) }); item.force = true;
      } catch (error) {
        if (!(error instanceof ReplayRefusal)) throw error;
        item.check = error.check;
      }
    }
  };
  let latestValid = 0n, closing = 0n, currentIndex = -1n;
  const advanceClock = (at: bigint): void => {
    if (at !== currentIndex) { closing = latestValid; currentIndex = at; }
    if (duration === undefined || at - closing <= duration) return;
    // Record intervening gaps BEFORE any segment resets the backing's clock.
    // Every old boundary survives a later return, including excluded openings.
    for (const clock of clocks.values()) {
      if (clock.boundary === undefined && at > clock.opening) {
        const gap = closing + duration + 1n;
        clock.boundary = gap > clock.opening ? gap : clock.opening + 1n;
      }
    }
  };
  const clockRecord = (at: bigint, clock: ImportClock): ClockRecord => ({ duration: duration!.toString(), snapshotIndex: closing.toString(),
    gap: (at - closing).toString(), open: at - closing > duration!,
    boundary: clock.boundary === undefined ? null : clock.boundary.toString(), opening: clock.opening.toString() });
  for (let termIndex = 0; termIndex < chain.length; termIndex++) {
    const term = chain[termIndex]!;
    for (const held of await heldBy(term.operator)) {
      if (held.index < term.from || held.index > termEnd(termIndex)) continue;
      advanceClock(held.index);
      const boundary = walk?.boundary(held.index, clocks.get(hex(walk.receipt.segment)));
      if (boundary !== undefined) return { receipt: boundary };
      await publishThrough(held.index);
      if (++checkpoints > limits.maxCheckpoints) throw new EvidenceRefusal("resource-refusal");
      const c = held.commitment, selected = matches(c, selectedSelection);
      if (!selected) { if (selectedState === undefined) heldBefore++; else heldAfter++; }
      const entry = carries(held);
      if (entry === undefined) { walk?.checkpoint(held, undefined, undefined, undefined, "other"); continue; }
      if (directories.get(hex(c.root))!.length !== 1) throw new ScopeRequired();
      const bytes = evidence.snapshots.find(x => same(sha256(x), entry.digest));
      if (bytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
      const snapshot = decodeSnapshot(bytes);
      const scope = checkpointScope(trails, selection.backing, entry.digest, snapshot), { header } = scope;
      if (header.entries.length !== 1) throw new ScopeRequired();
      await faults.inspect(held, directories.get(hex(c.root))!, scope);
      // checkpointScope resolved this one-entry scope's terms for the selected backing.
      const scoped = header.entries[0]!;
      const item = { operator: hex(c.operator), sequence: c.sequence.toString(), index: held.index.toString() };
      try {
        requireReplay(same(header.domain, selection.domain) && same(header.venue, selection.venue) && same(header.operator, c.operator) &&
          same(scoped.backing, selection.backing) && header.sequence <= c.sequence, "CONTEXT");
        const ownTerm = chain.find(link => same(link.link, scoped.link));
        requireReplay(ownTerm !== undefined && same(ownTerm.operator, header.operator), "TERMS_SCOPE");
        if (!same(ownTerm.link, term.link) && ownTerm.from < term.from) {
          carrying.push({ ...item, class: "lapsed" });
          walk?.checkpoint(held, snapshot.segment, undefined, header, "lapsed");
          if (selected && !walk) throw new EvidenceRefusal("lapsed-selection");
          continue;
        }
        requireReplay(same(ownTerm.link, term.link), "TERMS_SCOPE");
        const id = hex(snapshot.segment);
        let clock = clocks.get(id);
        if (clock === undefined) {
          const openingHeld = (await heldBy(header.operator)).some(h => h.commitment.sequence === header.sequence);
          if (!openingHeld) throw new EvidenceRefusal("unresolved-evidence");
          requireReplay(c.sequence === header.sequence, "OPENING");
          clock = { opening: held.index, boundary: undefined };
          clocks.set(id, clock);
        }
        if (duration !== undefined && c.sequence !== header.sequence &&
            (held.index - closing > duration || (clock.boundary !== undefined && clock.boundary < held.index))) {
          carrying.push({ ...item, class: "lapsed" });
          walk?.checkpoint(held, snapshot.segment, undefined, header, "lapsed");
          if (selected && !walk) throw Object.assign(new EvidenceRefusal("lapsed-selection"), { clock: clockRecord(held.index, clock) });
          continue;
        }
        let segment = segments.get(id);
        if (segment === undefined) {
          // Missing opening evidence is not an exclusion certificate. In
          // particular it cannot let a successor roll back to an older state.
          const openingHeld = (await heldBy(header.operator)).some(h => h.commitment.sequence === header.sequence);
          if (!openingHeld) throw new EvidenceRefusal("unresolved-evidence");
          // The first checkpoint carries the opening. A later first sighting
          // cannot substitute for an omitted or differently scoped opening.
          requireReplay(c.sequence === header.sequence, "OPENING");
          // C2.10.4–5 / C2b.4.1: every fresh opening imports the canonical
          // child-relative predecessor, including lower same-index sequences.
          // Publication force and the gap still use the strictly-before state;
          // an empty opening inherits the unadopted block via adoptionIndex.
          requireReplay(canonical === undefined ? scoped.opening === undefined : matches(scoped.opening, canonical.commitment), "IMPORT");
          if (canonical !== undefined) {
            requireReplay(canonical.index < held.index || (same(canonical.commitment.operator, c.operator) && canonical.commitment.sequence < c.sequence), "IMPORT_RANK");
            if (!same(canonical.commitment.operator, c.operator)) requireReplay(canonical.index < term.from, "IMPORT_RANK");
          }
          segment = { imported: canonical?.state, predecessor: canonical?.commitment, lastValid: undefined,
            openingIndex: held.index, block: force.filter(event => event.index > (canonical?.state.adoptionIndex ?? 0n)) };
          segments.set(id, segment);
        }
        // Returning to an older segment cannot abandon a valid newer segment.
        requireReplay(canonical === undefined || same(canonical.segment, snapshot.segment) || matches(segment.predecessor, canonical.commitment), "CONTINUITY");
        // §9.1: the valid opening derived this segment's adopted block from the
        // complete publication range. A compact fault excludes only a target
        // position after that block; positions inside it keep ordinary evidence.
        const intrinsic = segment.openingValid && segment.lastValid !== undefined ?
          faults.intrinsicFailure(held, scope, BigInt(segment.block.length)) : undefined;
        const evidence = scope.classificationEvidence(intrinsic);
        if (evidence.intrinsic !== undefined) {
          carrying.push({ ...item, class: "excluded", check: evidence.intrinsic });
          walk?.checkpoint(held, snapshot.segment, undefined, header, "excluded");
          continue;
        }
        const trail = evidence.trail!;
        if (c.sequence === header.sequence) requireReplay(trail.records.length === 0, "OPENING");
        const state = await replayTrail({ ...context, header,
          selection: selectedSelection ?? { ...selection, operator: c.operator, sequence: c.sequence, root: c.root },
          contextReceipt: selectedContext?.contextReceipt }, snapshot, trail,
          { index: held.index, revokedAt, lastValid: segment.lastValid, imported: segment.imported,
            block: c.sequence === header.sequence ? [] : segment.block, openingIndex: segment.openingIndex, isOpening: c.sequence === header.sequence,
            chargeEvents: charge, chargeRecords: charge });
        segment.lastValid = { position: state.position, historyHash: snapshot.historyHash, evidenceHash: snapshot.evidenceHash, eventIndices: state.eventIndices, state };
        if (c.sequence === header.sequence) segment.openingValid = true;
        canonical = { commitment: c, index: held.index, segment: snapshot.segment, scope: new ScopeTree(header.entries).root(), state };
        if (held.index < t) countSnapshot = canonical;
        latestValid = held.index;
        carrying.push({ ...item, class: "valid" });
        const verdict = walk?.checkpoint(held, snapshot.segment, state, header, "valid");
        if (verdict !== undefined) return { receipt: verdict };
        if (selectedContext !== undefined && selectedState !== undefined && !walk) throw new EvidenceRefusal("superseded-selection");
        if (selected) { selectedState = state; selectedClock = clock; }
      } catch (error) {
        if (!(error instanceof ReplayRefusal)) throw error;
        scope.fullTrail(); // Other failures still require the complete event evidence.
        if (selected && !walk) throw error;
        carrying.push({ ...item, class: "excluded", check: error.check });
        walk?.checkpoint(held, snapshot.segment, undefined, header, "excluded");
      }
    }
  }
  if (selectedContext !== undefined && selectedState === undefined && !walk) throw new EvidenceRefusal("unresolved-evidence");
  advanceClock(t);
  if (walk) return { receipt: walk.boundary(t, clocks.get(hex(walk.receipt.segment))) ?? walk.finish() };
  await publishThrough(t);
  const frontierClock = canonical === undefined ? undefined : clocks.get(hex(canonical.segment));
  const chosenClock = selectedContext === undefined ? frontierClock : selectedClock;
  const clock = chosenClock === undefined ? undefined : duration === undefined ? null : clockRecord(t, chosenClock);
  let requestProofs = 0n;
  const nonService = counting ? await countNonService(context, view, countSnapshot, publications!, (amount = 1n) => {
    requestProofs += amount; charge(amount);
  }) : undefined;
  // Each publication contributes at most one record to one statement-identity
  // group. countNonService visits each variant at most once, and a successful
  // tag skips any later identities, so the full answer is an upper bound even
  // when known requests enter a later counting window or gain valid anchors.
  const requestProofReserve = counting ? BigInt(publications!.length) : 0n;
  const work = { checkpoints, events, requestProofs, requestProofReserve };
  const ranges = { judgingIndex: t, lag, revokedAt, chain,
    publications: publicationVerdicts, ...(nonService === undefined ? {} : { nonService }) };
  if (selectedContext === undefined) return { canonical, force, work, carrying, clock, ranges };
  if (selectedState === undefined || canonical === undefined || selectedClock === undefined || selectedHeld === undefined || clock === undefined) {
    throw new EvidenceRefusal("unresolved-evidence");
  }
  return { state: selectedState, carrying, clock, canonical, force, selectedClock,
    work, ranges: { ...ranges, checkpointIndex: selectedHeld.index, heldBefore, heldAfter } };
}
