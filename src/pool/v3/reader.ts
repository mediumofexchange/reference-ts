// The v3 reader over one segment: pool-v3 §13 record reads through a
// RecordVenue, a checkpoint's trail replayed record by record through the
// state machine (state.ts), and the original segment's carrying checkpoints
// classified in held order with the C2b.6.1 clock and C2b.4.1 lapse.
// Candidate until adoption: no approved configuration or authenticated-chain
// finality verdict. Imports, multiple backings, receipts and recovery force
// are read by the conditional replay harness over these pieces
// (`scripts/pool/v3/`) until their slices promote them.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes, EncodingError } from "../../bytes.js";
import {
  admittedReplacements, decodeRangeAnswer, heldCommitments, linkInForce, replacementChain, revocationIndex,
  type ChainLink, type HeldCommitment, type RangeAnswer, type RangeLimits, type RecordKind,
} from "../../record-range.js";
import type { RecordVenue } from "../../record-venue.js";
import { VenueError } from "../../venue-error.js";
import type { Commitment, SnapshotDigest } from "../../venue-records.js";
import { ScopeTree } from "../scope.js";
import { decodeSnapshot, type Snapshot } from "./commitments.js";
import type { SegmentHeader } from "./headers.js";
import { ReplayRefusal, EvidenceRefusal, ScopeRequired, requireReplay, type ClockRecord } from "./refusals.js";
import { servedTrail, trailEvidenceChain } from "./served-trail.js";
import {
  applyRecord, openSegmentState, type Adopted, type ImportedState, type LastValid, type ProofCheck, type ReplayedState, type SegmentReplay,
} from "./state.js";
import type { RootTerms } from "./terms.js";
import { decodeTrail, type ServedTrail, type TrailLimits } from "./trail.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

/** The reader's local budgets for one trail and one range answer; never protocol bounds. */
export const TRAIL_LIMITS: TrailLimits = Object.freeze({ maxBytes: 1_048_576n, maxEvents: 1024n });
export const RANGE_LIMITS: RangeLimits = Object.freeze({ maxBytes: 1_048_576n, maxEntries: 4096n });

/** The reader's independently chosen selection: one configuration, venue, backing and commitment, judged at one index. */
export interface ReaderSelection {
  readonly mode: "current-fixture" | "historical-fixture";
  readonly domain: Uint8Array;
  readonly venue: Uint8Array;
  readonly backing: Uint8Array;
  readonly operator: Uint8Array;
  readonly root: Uint8Array;
  readonly sequence: bigint;
  readonly judgingIndex: bigint;
}
/** Packaged directories by the hex of their root. */
export type Directories = ReadonlyMap<string, readonly SnapshotDigest[]>;
export interface SignedTerms { readonly terms: Uint8Array; readonly signature: Uint8Array }

/** §13 reads over [0, t] for one backing: its replacement chain, held commitments and K's revocation. */
export interface RecordView {
  readonly t: bigint;
  readonly lag: bigint;
  readonly chain: readonly ChainLink[];
  readonly revokedAt: bigint | undefined;
  heldBy(operator: Uint8Array): Promise<readonly HeldCommitment[]>;
  termEnd(i: number): bigint;
  carries(held: HeldCommitment): SnapshotDigest | undefined;
  ask(kind: RecordKind, subject: Uint8Array): Promise<RangeAnswer>;
}

/** A venue read; a venue with no answer at all (unsynced or failed) leaves the read unresolved. */
function read<T>(call: () => T): T {
  try { return call(); } catch (error) {
    if (error instanceof VenueError) throw new EvidenceRefusal("unresolved-evidence");
    throw error;
  }
}

/** §13 reads against the reader's independently selected venue over [0, t]:
 * the replacement chain (C2.5) from the kind-2 answer under the venue's lag,
 * the held commitments (C2.3.3) of every party in force within its term
 * (C2.10.13), each passed by its packaged directory (C2.4.2) or listed as
 * carrying the backing, and K's revocation (C2b.1). The clock and lag are the
 * venue's; a supplied answer is never evidence. This view is shared by the
 * original-segment clock and the import walks. Nothing here classifies a
 * checkpoint. */
export async function readRecordView(selection: ReaderSelection, terms: RootTerms, directories: Directories, venue: RecordVenue): Promise<RecordView> {
  const t = selection.judgingIndex, now: unknown = read(() => venue.witnessedIndex()), lag: unknown = read(() => venue.lag());
  if (typeof now !== "bigint" || typeof lag !== "bigint" || t > now || (selection.mode === "current-fixture" && t !== now)) {
    throw new EvidenceRefusal("unresolved-evidence");
  }
  const ask = async (kind: RecordKind, subject: Uint8Array): Promise<RangeAnswer> => {
    const request = Object.freeze({ venue: copyBytes(selection.venue), kind, subject: copyBytes(subject), fromIndex: 0n, toIndex: t });
    const bytes: unknown = read(() => venue.range(request, RANGE_LIMITS));
    if (bytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
    if (!(bytes instanceof Uint8Array)) throw new EncodingError("range answer");
    return decodeRangeAnswer(bytes, request, RANGE_LIMITS);
  };
  const admitted = admittedReplacements(await ask(2, selection.backing), terms.replacementRule);
  const { chain } = replacementChain(admitted, { backing: selection.backing, original: terms.operator, lag, now: t });
  const revokedAt = revocationIndex(await ask(3, terms.obligor));
  const heldOf = new Map<string, readonly HeldCommitment[]>();
  const heldBy = async (operator: Uint8Array): Promise<readonly HeldCommitment[]> => {
    const key = hex(operator);
    if (!heldOf.has(key)) heldOf.set(key, heldCommitments(await ask(1, operator)).held);
    return heldOf.get(key)!;
  };
  const termEnd = (i: number): bigint => (i + 1 < chain.length ? chain[i + 1]!.from - 1n : t);
  const carries = (h: HeldCommitment): SnapshotDigest | undefined => {
    const directory = directories.get(hex(h.commitment.root));
    if (directory === undefined) throw new EvidenceRefusal("unresolved-evidence");
    return directory.find(entry => same(entry.name, selection.backing));
  };
  return { t, lag, chain, revokedAt, heldBy, termEnd, carries, ask };
}

/** A carrying checkpoint of the original operator's first term, in held order. */
export interface CarryingCheckpoint {
  readonly commitment: Commitment;
  readonly index: bigint;
  readonly sequence: bigint;
  readonly digest: Uint8Array;
  readonly position: "before" | "selected" | "after";
}
export interface OriginalRanges {
  readonly judgingIndex: bigint;
  readonly lag: bigint;
  readonly checkpointIndex: bigint;
  readonly revokedAt: bigint | undefined;
  readonly heldBefore: number;
  readonly heldAfter: number;
  readonly chain: readonly ChainLink[];
  readonly carrying: readonly CarryingCheckpoint[];
  /** The segment's opening checkpoint's index, if the record holds it carrying the backing. */
  readonly opening: bigint | undefined;
  /** Whether the record holds a commitment at the header's opening sequence at all. */
  readonly openingHeld: boolean;
}

/** Original-segment selection: its opening checkpoint anchors the silence
 * boundary. Successor and import selections take the import walk instead. */
export async function readRecordRanges(selection: ReaderSelection, terms: RootTerms, header: SegmentHeader,
  directories: Directories, venue: RecordVenue): Promise<OriginalRanges> {
  const { t, lag, chain, revokedAt, heldBy, termEnd, carries } = await readRecordView(selection, terms, directories, venue);
  const held = await heldBy(chain[0]!.operator);
  const at = held.findIndex(h => h.commitment.sequence === selection.sequence && same(h.commitment.root, selection.root));
  if (at < 0) throw new EvidenceRefusal("selection-mismatch");
  // Witnessed in another party's term the selection is lapsed (C2.10.11); in a
  // later term of its own key it opens a new segment (C2.10.4), unsupported here.
  const inForce = linkInForce(chain, held[at]!.index);
  if (!same(inForce.operator, chain[0]!.operator)) throw new EvidenceRefusal("lapsed-selection");
  if (inForce.from !== 0n) throw new EvidenceRefusal("unsupported-scope");
  // The original's first term: past it, its commitments are not read for the backing (C2.7.1).
  const term = held.filter(h => h.index <= termEnd(0)), carrying: CarryingCheckpoint[] = [];
  for (const [i, h] of term.entries()) {
    const entry = carries(h);
    if (entry === undefined) continue;
    // A carrying checkpoint is read under the one-backing scope, as the selection is.
    if (directories.get(hex(h.commitment.root))!.length !== 1) throw new ScopeRequired();
    carrying.push({ commitment: h.commitment, index: h.index, sequence: h.commitment.sequence, digest: entry.digest,
      position: i < at ? "before" : i === at ? "selected" : "after" });
  }
  for (let i = 1; i < chain.length; i++) {
    for (const h of await heldBy(chain[i]!.operator)) {
      if (h.index < chain[i]!.from || h.index > termEnd(i)) continue;
      if (carries(h) !== undefined) throw new EvidenceRefusal("unsupported-scope");
    }
  }
  // The segment's opening checkpoint is the carrying checkpoint at the header's opening sequence (C2b.4.1).
  const opening = carrying.find(c => c.sequence === header.sequence)?.index;
  const openingHeld = term.some(h => h.commitment.sequence === header.sequence);
  return { judgingIndex: t, lag, checkpointIndex: held[at]!.index, revokedAt, heldBefore: at, heldAfter: term.length - at - 1,
    chain, carrying, opening, openingHeld };
}

/** Trails that decode under the budget; one that does not decode is no
 * evidence for any checkpoint (§10.1) and is not read, while the budget holds. */
export function decodedTrails(trails: readonly Uint8Array[]): ServedTrail[] {
  const decoded: ServedTrail[] = [];
  for (const bytes of trails) {
    try { decoded.push(decodeTrail(bytes, TRAIL_LIMITS)); } catch (error) {
      if (!(error instanceof EncodingError)) throw error;
    }
  }
  return decoded;
}

/** What a trail replay reads besides its records: the selection, the
 * selected backing's terms (and each scoped backing's), the segment's header,
 * the proof verifier and a receipt's position to record. */
export interface ReplayContext {
  readonly selection: ReaderSelection;
  readonly terms: RootTerms;
  readonly scopedTerms?: ReadonlyMap<string, RootTerms | undefined> | undefined;
  readonly header: SegmentHeader;
  readonly verifier: ProofCheck;
  readonly contextReceipt?: { readonly position: bigint; readonly segment: Uint8Array } | undefined;
}
/** A replayed checkpoint's state, as a later replay resumes or imports it. */
export interface ReplayResult extends ReplayedState {
  readonly issued: bigint;
  readonly burned: bigint;
  readonly adoptionIndices: ReadonlyMap<string, bigint>;
  readonly adoptionIndex: bigint;
  readonly resumeKey: ResumeKey;
}
/** A segment's last valid checkpoint, carrying its replayed state for resumption. */
export interface ValidCheckpoint extends LastValid {
  readonly state?: ReplayResult | undefined;
}
/** A predecessor's replayed state or merged finalized prefixes, as imported by a new segment. */
export interface ImportedFrontier extends ImportedState {
  readonly adoptionIndex?: bigint;
  readonly adoptionIndices?: ReadonlyMap<string, bigint>;
}
export interface TrailOptions {
  /** The checkpoint's witnessed index; undefined for a read without venue answers. */
  readonly index?: bigint | undefined;
  readonly revokedAt?: bigint | undefined;
  readonly revocations?: ReadonlyMap<string, bigint | undefined> | undefined;
  readonly lastValid?: ValidCheckpoint | undefined;
  readonly imported?: ImportedFrontier | undefined;
  readonly block?: readonly Adopted[];
  readonly openingIndex?: bigint | undefined;
  readonly isOpening?: boolean;
  readonly chargeEvents?: (amount: bigint) => void;
  readonly chargeRecords?: (amount: bigint) => void;
}

/** One checkpoint's trail under the segment's scope and terms, through the
 * state machine. A deterministic failure throws ReplayRefusal with its check;
 * an unsupported record kind throws EvidenceRefusal; the verifier's own
 * failures propagate. `lastValid` is the segment's last valid checkpoint
 * before this one: the trail must reach its length and reproduce its evidence
 * and history hashes there (C2.10.12, pool-v3 §7.1), the evidence before any
 * verification. */
export async function replayTrail(context: ReplayContext, snapshot: Snapshot, trail: ServedTrail, options: TrailOptions): Promise<ReplayResult> {
  const { selection, terms, scopedTerms, header, verifier, contextReceipt } = context;
  const { index, revokedAt, revocations, lastValid, imported, block = [], openingIndex, isOpening = false } = options;
  const chargeEvents = options.chargeEvents ?? ((): void => {}), chargeRecords = options.chargeRecords ?? chargeEvents;
  const scope = new ScopeTree(header.entries).root();
  const resumeKey = resumeKeyOf(context, snapshot, { imported, block, openingIndex });
  const base = isOpening ? undefined : resumable(snapshot.segment, trail, lastValid, resumeKey);
  const state = openSegmentState(snapshot.segment, base, imported, lastValid, chargeEvents);
  if (!isOpening) requireReplay(trail.records.length >= block.length, "ADOPTION");
  chargeRecords(BigInt(trail.records.length) - (base?.position ?? 0n));
  const replay: SegmentReplay = { domain: selection.domain, backing: selection.backing, segment: snapshot.segment, scope, terms, scopedTerms,
    verifier, index, revokedAt, revocations, lastValid, block, contextReceipt };
  for (const bytes of base === undefined ? trail.records : trail.records.slice(Number(base.position))) await applyRecord(state, bytes, replay);
  requireReplay(lastValid === undefined || state.position >= lastValid.position, "CONTINUITY");
  const own = state.totals.get(hex(snapshot.backing)) ?? { issued: 0n, burned: 0n };
  if (!state.totals.has(hex(snapshot.backing))) state.totals.set(hex(snapshot.backing), own);
  const { issued, burned } = own;
  requireReplay(same(state.history, snapshot.historyHash) && issued === snapshot.issued && burned === snapshot.burned, "SNAPSHOT");
  const adoptionIndices = new Map(imported?.adoptionIndices);
  for (const entry of header.entries) adoptionIndices.set(hex(entry.backing), isOpening ?
    imported?.adoptionIndices?.get(hex(entry.backing)) ?? 0n : openingIndex ?? 0n);
  return { tree: state.tree, spent: state.spent, issued, burned, position: state.position, history: state.history,
    scanOutputs: state.scanOutputs, outputPositions: state.outputPositions, anchors: state.anchors, nullifiers: state.nullifiers,
    outputsSeen: state.outputsSeen, adoptionIndices, demands: state.demands, effective: state.effective, spentTags: state.spentTags,
    events: state.events, totals: state.totals, receiptEvent: state.receiptEvent, eventIndices: state.eventIndices,
    adoptionIndex: isOpening ? imported?.adoptionIndex ?? 0n : openingIndex ?? 0n, statements: state.statements,
    ancestry: state.ancestry, resumeKey };
}

/** Everything a replayed prefix's state depends on besides its records and
 * their indices. Revocation and the checkpoint's own index bear only on
 * positions after the last valid checkpoint, so they are not part of it. */
export interface ResumeKey {
  readonly text: string;
  readonly verifier: ProofCheck;
  readonly contextReceipt: ReplayContext["contextReceipt"];
  readonly imported: ImportedFrontier | undefined;
  readonly block: readonly Adopted[];
}
function resumeKeyOf({ selection, terms, scopedTerms, verifier, contextReceipt }: ReplayContext, snapshot: Snapshot,
  { imported, block, openingIndex }: { imported: ImportedFrontier | undefined; block: readonly Adopted[]; openingIndex: bigint | undefined }): ResumeKey {
  const obligors = scopedTerms === undefined ? `selected:${hex(terms.obligor)}` :
    [...scopedTerms].map(([name, t]) => `${name}:${t === undefined ? "" : hex(t.obligor)}`).sort().join(",");
  return { text: [hex(selection.domain), hex(selection.backing), hex(snapshot.segment), obligors, String(openingIndex)].join("|"),
    verifier, contextReceipt, imported, block };
}
const sameResumeKey = (a: ResumeKey, b: ResumeKey): boolean => a.text === b.text && a.verifier === b.verifier &&
  a.contextReceipt === b.contextReceipt && a.imported === b.imported && (a.block === b.block || (a.block.length === 0 && b.block.length === 0));

/** C2.10.12, pool-v3 §7.1: a trail whose first n records reproduce the last
 * valid checkpoint's evidence hash carries that checkpoint's exact statement,
 * proof and authorization bytes. Under the same replay context their replayed
 * state is that checkpoint's, so the replay resumes from a copy of it instead
 * of verifying the prefix again. Anything else replays in full, keeping the
 * first failing check and its order. */
function resumable(segment: Uint8Array, trail: ServedTrail, lastValid: ValidCheckpoint | undefined, key: ResumeKey): ReplayResult | undefined {
  const base = lastValid?.state;
  if (base?.resumeKey === undefined || !sameResumeKey(base.resumeKey, key) || base.position !== lastValid!.position ||
      BigInt(trail.records.length) < base.position || !same(sha256(trail.header), segment)) return undefined;
  const chain = trailEvidenceChain(trail);
  return chain.length > Number(base.position) && same(chain[Number(base.position)]!, lastValid!.evidenceHash) &&
    same(base.history, lastValid!.historyHash) ? base : undefined;
}

/** §9's compact fault evidence as the reader observes it: facts recorded per
 * held checkpoint, and a §9.1 intrinsic failure only after the segment's
 * adopted block. */
export interface FaultObserver {
  inspect(held: { readonly commitment: Commitment; readonly index: bigint }, directory: readonly SnapshotDigest[],
    scope: { readonly header: SegmentHeader; readonly terms: readonly SignedTerms[] }): Promise<void>;
  intrinsicFailure(held: { readonly commitment: Commitment; readonly index: bigint },
    scope: { readonly header: SegmentHeader; readonly terms: readonly SignedTerms[] }, blockLength: bigint): string | undefined;
}
/** A carrying checkpoint's verdict as the reader reports it. */
export interface CarryingVerdict {
  readonly sequence: string;
  readonly index: string;
  readonly class: "valid" | "excluded" | "lapsed";
  readonly check?: string;
}
export interface ClassifyContext extends ReplayContext {
  readonly signedTerms: readonly SignedTerms[];
  readonly faults: FaultObserver;
}
export interface OriginalEvidence {
  readonly snapshot: Snapshot;
  readonly trail: ServedTrail;
  readonly snapshots: readonly Uint8Array[];
  readonly trails: readonly Uint8Array[];
}

/** C2.10.11 over the original operator's carrying checkpoints in held order,
 * each at its own record prefix. Lapse by term is settled by the chain; lapse
 * by silence is read here (C2b.6.1, C2b.4.1): under a declared clause, c(i)
 * is the last valid carrying checkpoint strictly before index i, the gap is
 * open at i where i − c(i) exceeds the duration, the segment's silence
 * boundary is the first index strictly after its opening at which the gap
 * is open, and a non-opening checkpoint of this segment witnessed while the
 * gap is open or after the boundary is lapsed for its whole scope: held,
 * its snapshot resolved to establish the segment but its trail neither
 * resolved nor replayed, closing nothing. Otherwise each is valid, excluded
 * or unresolved from its own snapshot and evidence, with §9.1's bounded
 * intrinsic replacement after a valid opening, and the segment continues
 * from its last valid checkpoint (C2.10.12). A carrying checkpoint of
 * another segment contradicts the header's empty opening before the
 * selection (C2.7.3) and is an unsupported segment after it, whatever the
 * clock says. A valid later checkpoint supersedes the selection (C2.7.5);
 * an excluded or lapsed one is passed. Unresolved evidence anywhere in the
 * order stops the read. The clock at the judging index follows from the
 * same walk; a lapsed selection refuses with the clock record proving the
 * lapse; without a clause there is no gap. */
export async function classifyCarrying(context: ClassifyContext, ranges: OriginalRanges, evidence: OriginalEvidence):
  Promise<{ carrying: CarryingVerdict[]; state: ReplayResult | undefined; clock: ClockRecord | null }> {
  const { selection, header, terms } = context, { snapshot, trail, snapshots } = evidence;
  const trails = decodedTrails(evidence.trails), carrying: CarryingVerdict[] = [];
  const duration = terms.silence?.noCommitmentDuration, opening = ranges.opening;
  const later = (a: bigint, b: bigint): bigint => (a > b ? a : b);
  // The segment's opening checkpoint carries every scoped backing (C2b.4.1, C2.10.9a), clause or not: a held
  // commitment at the opening sequence carrying nothing for the backing contradicts the header; an opening
  // sequence the record does not hold is missing evidence.
  if (opening === undefined) {
    if (ranges.openingHeld) throw new ReplayRefusal("OPENING");
    throw new EvidenceRefusal("unresolved-evidence");
  }
  const clockRecord = (at: bigint, snapshotIndex: bigint, boundaryAt: bigint | undefined): ClockRecord => ({
    duration: duration!.toString(), snapshotIndex: snapshotIndex.toString(), gap: (at - snapshotIndex).toString(),
    open: at - snapshotIndex > duration!, boundary: boundaryAt === undefined ? null : boundaryAt.toString(), opening: opening.toString() });
  let lastValid: ValidCheckpoint | undefined, state: ReplayResult | undefined, openingValid = false;
  let latestValid = 0n, closing = 0n, currentIndex = -1n, boundary: bigint | undefined;
  for (const c of ranges.carrying) {
    await context.faults.inspect(c, [{ name: selection.backing, digest: c.digest }], { header, terms: context.signedTerms });
    // c(i) reads only checkpoints strictly before i: two at one index do not close each other's gap.
    if (c.index !== currentIndex) { closing = latestValid; currentIndex = c.index; }
    let s = snapshot, tr: ServedTrail | undefined = trail;
    if (c.position !== "selected") {
      // The record pins an earlier state of this operator that the header's empty opening denies.
      if (c.sequence < header.sequence) throw new ReplayRefusal("OPENING");
      const bytes = snapshots.find(x => same(sha256(x), c.digest));
      if (bytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
      s = decodeSnapshot(bytes);
      if (!same(s.segment, snapshot.segment) || !same(s.backing, selection.backing)) {
        if (c.position === "before") throw new ReplayRefusal("OPENING");
        throw new EvidenceRefusal("unsupported-scope");
      }
    }
    // Lapse by silence (C2b.4.1): a non-opening checkpoint of this segment witnessed while the gap is open or past the boundary.
    if (duration !== undefined && c.sequence !== header.sequence) {
      const open = c.index - closing > duration;
      if (open && boundary === undefined && c.index > opening) boundary = later(closing + duration + 1n, opening + 1n);
      if (open || (boundary !== undefined && boundary < c.index)) {
        carrying.push({ sequence: c.sequence.toString(), index: c.index.toString(), class: "lapsed" });
        if (c.position === "selected") throw Object.assign(new EvidenceRefusal("lapsed-selection"), { clock: clockRecord(c.index, closing, boundary) });
        continue;
      }
    }
    if (c.position !== "selected") {
      // Its served trail authenticates its committed evidence (§10.1), from any supplied trail's prefix (§12.1).
      tr = servedTrail({ backing: selection.backing, segment: s.segment, digest: c.digest }, s, trails);
      // This original-only path proves a valid empty opening with no earlier
      // carrying checkpoint. No pre-opening snapshot can give a publication
      // force (C2b.3.2), so its adopted block is empty even with silence.
      if (tr === undefined && openingValid && lastValid !== undefined) {
        const intrinsic = context.faults.intrinsicFailure(c, { header, terms: context.signedTerms }, 0n);
        if (intrinsic !== undefined) {
          carrying.push({ sequence: c.sequence.toString(), index: c.index.toString(), class: "excluded", check: intrinsic });
          continue;
        }
      }
      // Same segment and scope as the selection, whose terms are already resolved (§12.1).
      if (tr === undefined) throw new EvidenceRefusal("unresolved-evidence");
    }
    let verdict: { class: "valid" } | { class: "excluded"; check: string };
    try {
      requireReplay(c.sequence !== header.sequence || tr!.records.length === 0, "OPENING");
      const replayed = await replayTrail(context, s, tr!, { index: c.index, revokedAt: ranges.revokedAt, lastValid });
      verdict = { class: "valid" };
      lastValid = { position: replayed.position, historyHash: s.historyHash, evidenceHash: s.evidenceHash,
        eventIndices: replayed.eventIndices, state: replayed };
      latestValid = c.index;
      if (c.sequence === header.sequence) openingValid = true;
      if (c.position === "selected") state = replayed;
    } catch (error) {
      if (!(error instanceof ReplayRefusal) || c.position === "selected") throw error;
      verdict = { class: "excluded", check: error.check };
    }
    carrying.push({ sequence: c.sequence.toString(), index: c.index.toString(), ...verdict });
    if (verdict.class === "valid" && c.position === "after") throw new EvidenceRefusal("superseded-selection");
  }
  let clock: ClockRecord | null = null;
  if (duration !== undefined) {
    // The gap at the judging index t: c(t) is the last valid carrying checkpoint strictly before t.
    const t = ranges.judgingIndex, snapshotIndex = latestValid < t ? latestValid : closing;
    if (t - snapshotIndex > duration && boundary === undefined && t > opening) boundary = later(snapshotIndex + duration + 1n, opening + 1n);
    clock = clockRecord(t, snapshotIndex, boundary);
  }
  return { carrying, state, clock };
}
