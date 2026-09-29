// The v3 reader over one segment: pool-v3 §13 record reads through a
// RecordVenue and a checkpoint's trail replayed record by record through the
// state machine (state.ts). Candidate until adoption: no approved configuration
// or authenticated-chain finality verdict. The walk that classifies checkpoints,
// imports, receipts, force and counts is scope-reader.ts; package-reader.ts is its entry.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes, EncodingError } from "../../bytes.js";
import {
  admittedReplacements, decodeRangeAnswer, heldCommitments, RangeLimitError, replacementChain, revocationIndex,
  type AdmittedReplacement, type ChainLink, type HeldCommitment, type HeldPrior, type RangeAnswer, type RangeEntry, type RangeLimits, type RecordKind,
} from "../../record-range.js";
import type { RecordVenue } from "../../record-venue.js";
import { VenueError } from "../../venue-error.js";
import type { Commitment, SnapshotDigest } from "../../venue-records.js";
import { ScopeTree } from "../scope.js";
import type { Snapshot } from "./commitments.js";
import { requireReferenceVenue, type VenueReference } from "./guard.js";
import type { SegmentHeader } from "./headers.js";
import { ReplayRefusal, EvidenceRefusal, requireReplay } from "./refusals.js";
import type { ReplayStore } from "./replay-store.js";
import {
  applyRecord, openSegmentState, StateHandle, type Adopted, type LastValid, type MergedImport, type ProofCheck, type ScanOutput, type SegmentReplay,
} from "./state.js";
import type { KeptAnswers, StoredTrail, WalkEvidence } from "./evidence-store.js";
import type { RootTerms } from "./terms.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

/** The reader's local budget for one range answer; never a protocol bound. */
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
export interface SignedTerms { readonly terms: Uint8Array; readonly signature: Uint8Array }

/** §13 reads over [0, t] for one backing: its replacement chain, K's revocation, and the held commitments
 * and publications a read asks for, read window by window and kept in the read's evidence. */
export interface RecordView {
  readonly t: bigint;
  readonly lag: bigint;
  readonly chain: readonly ChainLink[];
  readonly revokedAt: bigint | undefined;
  /** Held commitments of `operator` (C2.3.3), in index and sequence order. */
  held(operator: Uint8Array): Iterable<HeldCommitment>;
  heldAt(operator: Uint8Array, sequence: bigint): HeldCommitment | undefined;
  heldAbove(operator: Uint8Array, sequence: bigint): boolean;
  /** The first held commitment of `operator` at or after `fromIndex` whose sequence exceeds `after`, if given. */
  nextHeld(operator: Uint8Array, fromIndex: bigint, after?: bigint): HeldCommitment | undefined;
  /** The last held commitment of `operator` at or below `toIndex` whose sequence is below `before`, if given. */
  previousHeld(operator: Uint8Array, toIndex: bigint, before?: bigint): HeldCommitment | undefined;
  /** The least index in [from, to] at which `operator` holds a commitment. */
  firstHeldIndex(operator: Uint8Array, from: bigint, to: bigint): bigint | undefined;
  termEnd(i: number): bigint;
  carries(held: HeldCommitment): SnapshotDigest | undefined;
  /** This backing's publications (kind 4), in venue order; a venue position two backings share leaves the read unresolved. */
  nextPublication(after?: Pick<RangeEntry, "index" | "ordinal">): RangeEntry | undefined;
  publications(): Iterable<RangeEntry>;
  publicationCount(): number;
}

/** A venue read; a venue with no answer at all (unsynced or failed) leaves the read unresolved. A
 * `RecordVenue` answers synchronously, so a promise is the caller's error, never missing evidence. */
function read<T>(call: () => T): T {
  let value: T;
  try { value = call(); } catch (error) {
    if (error instanceof VenueError) throw new EvidenceRefusal("unresolved-evidence");
    throw error;
  }
  if (value instanceof Promise) throw new TypeError("a RecordVenue answers synchronously");
  return value;
}

/** One §13 answer over [0, t], read as successive windows. A window over the
 * reader's per-answer budget is asked again in halves; one index over it stays
 * refused (RangeLimitError), as a whole answer over it was. Each window's
 * answer must be the exact answer to its own request (§13.1). */
function readWindows(venue: RecordVenue, venueId: Uint8Array, kind: RecordKind, subject: Uint8Array, t: bigint,
  take: (answer: RangeAnswer) => boolean | void): void {
  let from = 0n, span = t + 1n;
  while (from <= t) {
    const to = from + span - 1n > t ? t : from + span - 1n;
    const request = Object.freeze({ venue: copyBytes(venueId), kind, subject: copyBytes(subject), fromIndex: from, toIndex: to });
    let bytes: unknown;
    try { bytes = read(() => venue.range(request, RANGE_LIMITS)); } catch (error) {
      if (error instanceof RangeLimitError && to > from) { span = (to - from + 1n) / 2n; continue; }
      throw error;
    }
    if (bytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
    if (!(bytes instanceof Uint8Array)) throw new EncodingError("range answer");
    // `take` returns true once it needs no later window.
    if (take(decodeRangeAnswer(bytes, request, RANGE_LIMITS)) === true) return;
    from = to + 1n; span *= 2n;
  }
}

/** §13 reads against the reader's independently selected venue over [0, t]:
 * the replacement chain (C2.5) from the kind-2 answer under the venue's lag,
 * the held commitments (C2.3.3) of every party in force within its term
 * (C2.10.13), each passed by its packaged directory (C2.4.2) or listed as
 * carrying the backing, and K's revocation (C2b.1). The clock and lag are the
 * venue's; a supplied answer is never evidence. Answers are read window by
 * window; held commitments and publications are kept in the read's evidence,
 * each kind and subject once, so memory does not grow with the venue's age.
 * This view is shared by the original-segment clock and the import walks.
 * Nothing here classifies a checkpoint. */
export async function readRecordView(selection: Pick<ReaderSelection, "mode" | "domain" | "venue" | "backing" | "judgingIndex">, terms: RootTerms,
  evidence: Pick<WalkEvidence, "directory" | "answers">, venue: RecordVenue, reference: VenueReference): Promise<RecordView> {
  // The caller holds this preimage independently of supplied record evidence.
  // Candidate v3 never reads a deployment venue, even if it offers valid ranges.
  const lag = read(() => venue.lag());
  const id = requireReferenceVenue(reference, { id: venue.id, lag: () => lag });
  if (!same(id, selection.venue)) throw new EvidenceRefusal("selection-mismatch");
  const t = selection.judgingIndex, now: unknown = read(() => venue.witnessedIndex());
  if (typeof now !== "bigint" || typeof lag !== "bigint" || t > now || (selection.mode === "current-fixture" && t !== now)) {
    throw new EvidenceRefusal("unresolved-evidence");
  }
  const { answers } = evidence, backing = copyBytes(selection.backing);
  // One identity counts once, at its first witnessing, across windows as within one answer.
  const admitted: AdmittedReplacement[] = [];
  readWindows(venue, selection.venue, 2, backing, t, answer => {
    for (const entry of admittedReplacements(answer, terms.replacementRule)) {
      if (!admitted.some(earlier => same(earlier.identity, entry.identity))) admitted.push(entry);
    }
  });
  const { chain } = replacementChain(admitted, { backing, original: terms.operator, lag, now: t });
  let revokedAt: bigint | undefined;
  readWindows(venue, selection.venue, 3, terms.obligor, t, answer => (revokedAt = revocationIndex(answer)) !== undefined);
  const heldOf = (operator: Uint8Array): KeptAnswers => {
    if (!answers.kept(1, operator)) answers.keepAnswer(1, operator, () => {
      let prior: HeldPrior | undefined;
      readWindows(venue, selection.venue, 1, operator, t, answer => {
        const { held, next } = heldCommitments(answer, prior);
        answers.keepHeld(operator, held); prior = next;
      });
    });
    return answers;
  };
  const publicationsKept = (): KeptAnswers => {
    if (!answers.kept(4, backing)) answers.keepAnswer(4, backing, () => {
      readWindows(venue, selection.venue, 4, backing, t, answer => { answers.keepPublications(backing, answer.entries); });
    });
    return answers;
  };
  const termEnd = (i: number): bigint => (i + 1 < chain.length ? chain[i + 1]!.from - 1n : t);
  const carries = (h: HeldCommitment): SnapshotDigest | undefined => {
    const directory = evidence.directory(h.commitment.root);
    if (directory === undefined) throw new EvidenceRefusal("unresolved-evidence");
    return directory.find(entry => same(entry.name, backing));
  };
  return { t, lag, chain, revokedAt, termEnd, carries,
    held: operator => heldOf(operator).held(operator),
    heldAt: (operator, sequence) => heldOf(operator).heldAt(operator, sequence),
    heldAbove: (operator, sequence) => heldOf(operator).heldAbove(operator, sequence),
    nextHeld: (operator, fromIndex, after) => heldOf(operator).nextHeld(operator, fromIndex, after),
    previousHeld: (operator, toIndex, before) => heldOf(operator).previousHeld(operator, toIndex, before),
    firstHeldIndex: (operator, from, to) => heldOf(operator).firstHeldIndex(operator, from, to),
    nextPublication: after => publicationsKept().nextPublication(backing, after),
    publications: () => publicationsKept().publications(backing),
    publicationCount: () => publicationsKept().publicationCount(backing) };
}

/** What a trail replay reads besides its records: the store its state lives
 * in, the selection, the selected backing's terms (and each scoped backing's),
 * the segment's header, the proof verifier and the outputs to witness. */
export interface ReplayContext {
  readonly store: ReplayStore;
  readonly selection: ReaderSelection;
  readonly terms: RootTerms;
  readonly scopedTerms?: ReadonlyMap<string, RootTerms | undefined> | undefined;
  readonly header: SegmentHeader;
  readonly verifier: ProofCheck;
  readonly witness?: ((output: ScanOutput) => boolean) | undefined;
}
/** A replayed checkpoint's state at its position, as a later replay resumes or imports it. */
export class ReplayResult extends StateHandle {
  readonly issued: bigint;
  readonly burned: bigint;
  /** Each scoped backing's adoption index, keyed by hex name. */
  readonly adoptionIndices: ReadonlyMap<string, bigint>;
  /** The replay identity its namespace is kept under (storage decision item 5). */
  readonly identity: Uint8Array;
  constructor(store: ReplayStore, ns: number, position: bigint, facts: Pick<ReplayResult, "issued" | "burned" | "adoptionIndices" | "identity">) {
    super(store, ns, position);
    this.issued = facts.issued; this.burned = facts.burned; this.adoptionIndices = facts.adoptionIndices; this.identity = facts.identity;
  }
  /** Events this segment's opening imported. */
  importedEventCount(): bigint { return this.store.eventCount(this.ns, 0n); }
}
/** A segment's last valid checkpoint, carrying its replayed state for resumption. */
export interface ValidCheckpoint extends LastValid {
  readonly state?: ReplayResult | undefined;
}
/** A predecessor's replayed state or merged finalized prefixes, as imported by a new segment. */
export type ImportedFrontier = ReplayResult | (MergedImport & { readonly adoptionIndices: ReadonlyMap<string, bigint> });
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
  /** Every scoped backing's snapshot in the checkpoint's directory: their totals are checked inside the replay. */
  readonly scopedSnapshots?: readonly Snapshot[] | undefined;
}

/** A valid checkpoint as the next one's last valid checkpoint. */
export function lastValidOf(state: ReplayResult, snapshot: Pick<Snapshot, "historyHash" | "evidenceHash">): ValidCheckpoint {
  return { position: state.position, historyHash: snapshot.historyHash, evidenceHash: snapshot.evidenceHash,
    judgedIndex: position => state.judgedIndex(position), state };
}

/** One checkpoint's trail under the segment's scope and terms, through the
 * state machine. A deterministic failure, a kind-7 record included, throws
 * ReplayRefusal with its check; an unindexed recovery record throws
 * EvidenceRefusal; the verifier's own failures propagate. `lastValid` is the segment's last valid checkpoint
 * before this one: the trail must reach its length and reproduce its evidence
 * and history hashes there (C2.10.12, pool-v3 §7.1), the evidence before any
 * verification. The replay runs in one savepoint of the store: a refusal
 * leaves nothing behind, and a new namespace it opened disappears. */
export async function replayTrail(context: ReplayContext, snapshot: Snapshot, trail: StoredTrail, options: TrailOptions): Promise<ReplayResult> {
  const { store, selection, terms, scopedTerms, header, verifier, witness } = context;
  const { index, revokedAt, revocations, lastValid, imported, block = [], openingIndex, isOpening = false } = options;
  const scope = new ScopeTree(header.entries).root();
  const identity = replayIdentity(context, snapshot, { imported, block, openingIndex, revokedAt, revocations });
  return store.replay(async () => {
    const resumed = isOpening ? undefined : resumable(store, identity, snapshot.segment, trail, lastValid);
    const state = resumed ?? openSegmentState(store, snapshot.segment, identity, imported);
    if (!isOpening) requireReplay(trail.length >= BigInt(block.length), "ADOPTION");
    const replay: SegmentReplay = { domain: selection.domain, backing: selection.backing, segment: snapshot.segment, scope, terms, scopedTerms,
      verifier, index, revokedAt, revocations, lastValid, block, witness };
    // Records are read from the reader's own storage one at a time.
    for (const bytes of trail.records(state.position)) await applyRecord(state, bytes, replay);
    const position = state.position;
    requireReplay(lastValid === undefined || position >= lastValid.position, "CONTINUITY");
    const { issued, burned } = state.total(hex(snapshot.backing));
    requireReplay(same(state.history, snapshot.historyHash) && issued === snapshot.issued && burned === snapshot.burned, "SNAPSHOT");
    // Inside the savepoint: a sibling's misstated totals refuse the checkpoint and leave nothing behind.
    for (const s of options.scopedSnapshots ?? []) {
      const total = state.total(hex(s.backing));
      requireReplay(s.issued === total.issued && s.burned === total.burned, "SNAPSHOT");
    }
    const adoptionIndices = new Map(imported?.adoptionIndices);
    for (const entry of header.entries) adoptionIndices.set(hex(entry.backing), isOpening ?
      imported?.adoptionIndices.get(hex(entry.backing)) ?? 0n : openingIndex ?? 0n);
    return new ReplayResult(store, state.ns, position, { issued, burned, adoptionIndices, identity });
  });
}

// Framed fields of the replay identity: no delimiter concatenation.
const verifierIds = new WeakMap<object, number>();
let verifiers = 0;
function identityFrame(parts: readonly (Uint8Array | bigint | string | undefined)[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const bytes = part === undefined ? new Uint8Array() : part instanceof Uint8Array ? part :
      new TextEncoder().encode(typeof part === "bigint" ? `n${part}` : `s${part}`);
    const length = new Uint8Array(5); length[0] = part === undefined ? 0 : 1; new DataView(length.buffer).setUint32(1, bytes.length);
    chunks.push(length, bytes);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** The digest of everything a replayed prefix's state depends on besides its
 * records and the index each was judged at (kept in its event rows): the
 * configuration and backing, the segment and scoped terms, the imported
 * frontier by segment, position and history hash, the adopted block and
 * opening index, the verifier, the witness predicate and the revocation
 * indices. Within one process the verifier and predicate are named by object; M5b.4 names it by its circuit identities. */
function replayIdentity({ selection, terms, scopedTerms, verifier, witness }: ReplayContext, snapshot: Snapshot,
  { imported, block, openingIndex, revokedAt, revocations }: { imported: ImportedFrontier | undefined; block: readonly Adopted[];
    openingIndex: bigint | undefined; revokedAt: bigint | undefined; revocations: ReadonlyMap<string, bigint | undefined> | undefined }): Uint8Array {
  const id = (object: object | undefined): bigint | undefined => {
    if (object === undefined) return undefined;
    if (!verifierIds.has(object)) verifierIds.set(object, ++verifiers);
    return BigInt(verifierIds.get(object)!);
  };
  // The witness predicate decides which paths the namespace can answer, so it is part of the identity too.
  const parts: (Uint8Array | bigint | string | undefined)[] = ["v3-replay-identity", selection.domain, selection.backing, snapshot.segment,
    openingIndex, id(verifier), id(witness), revokedAt];
  const obligors = scopedTerms === undefined ? [["selected", terms.obligor] as const] : [...scopedTerms].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, t]) => [name, t?.obligor] as const);
  for (const [name, obligor] of obligors) parts.push(name, obligor);
  for (const [name, at] of [...(revocations ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) parts.push(name, at);
  if (imported !== undefined) {
    const frontier = imported instanceof StateHandle ? imported.frontier() : imported.frontier;
    for (const [name, entry] of [...frontier.segments].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      parts.push(name, entry.upto, entry.upto === 0n ? undefined : imported.store.event(entry.ns, entry.upto)!.history);
    }
  }
  for (const adopted of block) parts.push(sha256(adopted.bytes), adopted.index);
  return sha256(identityFrame(parts));
}

/** C2.10.12, pool-v3 §7.1: a trail whose first n records reproduce the last
 * valid checkpoint's evidence hash carries that checkpoint's exact statement,
 * proof and authorization bytes. Under the same replay identity their
 * replayed state is that checkpoint's, so the replay resumes in the
 * namespace whose tip is that checkpoint instead of verifying the prefix
 * again. Anything else replays in a fresh namespace, keeping the first failing
 * check and its order. */
function resumable(store: ReplayStore, identity: Uint8Array, segment: Uint8Array, trail: StoredTrail, lastValid: ValidCheckpoint | undefined): StateHandle | undefined {
  if (lastValid === undefined || trail.length < lastValid.position || !same(trail.segment, segment)) return undefined;
  const own = lastValid.state?.ns, candidates = [...(own === undefined ? [] : [own]), ...store.namespaces(identity).filter(ns => ns !== own)];
  for (const ns of candidates) {
    const tip = store.tip(ns);
    if (!same(store.identity(ns), identity)) continue;
    if (tip.position !== lastValid.position || !same(tip.history, lastValid.historyHash) || !same(tip.evidence, lastValid.evidenceHash)) continue;
    const evidence = trail.evidence(tip.position);
    return evidence !== undefined && same(evidence, lastValid.evidenceHash) ? new StateHandle(store, ns) : undefined;
  }
  return undefined;
}

/** §9's compact fault evidence as the reader observes it: facts recorded per
 * held checkpoint, and a §9.1 intrinsic failure only after the segment's
 * adopted block. */
export interface FaultObserver {
  inspect(held: { readonly commitment: Commitment; readonly index: bigint }, directory: readonly SnapshotDigest[],
    scope: { readonly header: SegmentHeader; readonly terms: readonly SignedTerms[] }): Promise<void>;
  intrinsicFailure(held: { readonly commitment: Commitment; readonly index: bigint },
    scope: { readonly header: SegmentHeader; readonly terms: readonly SignedTerms[] }, blockLength: bigint): string | undefined;
  /** Whether any fault evidence was supplied, so that inspecting a checkpoint can report anything. */
  holdsEvidence?(): boolean;
}
/** A carrying checkpoint's verdict as the reader reports it. */
export interface CarryingVerdict {
  readonly sequence: string;
  readonly index: string;
  readonly class: "valid" | "excluded" | "lapsed";
  readonly check?: string;
}
