// The v3 reader over one segment: pool-v3 §13 record reads through a
// RecordVenue and a checkpoint's trail replayed record by record through the
// state machine (state.ts). Candidate until adoption: no approved configuration
// or authenticated-chain finality verdict. The walk that classifies checkpoints,
// imports, receipts, force and counts is scope-reader.ts; package-reader.ts is its entry.
import { sha256 } from "@noble/hashes/sha2.js";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes, EncodingError } from "../../bytes.js";
import {
  admittedReplacements, decodeRangeAnswer, heldCommitments, RangeLimitError, replacementChain, revocationIndex,
  type AdmittedReplacement, type ChainLink, type HeldCommitment, type HeldPrior, type RangeAnswer, type RangeEntry, type RangeLimits, type RecordKind,
} from "../../record-range.js";
import type { RecordVenue } from "../../record-venue.js";
import { VenueError } from "../../venue-error.js";
import type { Commitment, SnapshotDigest } from "../../venue-records.js";
import { EMPTY_NOTE_ROOT, EMPTY_NOTE_SUBTREE, NOTE_TREE_DEPTH, noteNode } from "../note-tree.js";
import { ScopeTree } from "../scope.js";
import { genesisEvidenceHash, genesisHistoryHash, nextEvidenceHash, nextHistoryHash, type Snapshot } from "./commitments.js";
import { requireReferenceVenue, type VenueReference } from "./guard.js";
import type { SegmentHeader } from "./headers.js";
import { ReplayRefusal, EvidenceRefusal, requireReplay } from "./refusals.js";
import { KeptStateMismatch, type ReplayStore } from "./replay-store.js";
import {
  applyRecord, openSegmentState, StateHandle, type Adopted, type LastValid, type MergedImport, type ProofCheck, type SegmentReplay, type WitnessPredicate,
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
  readonly witness?: WitnessPredicate | undefined;
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
/** A segment's last valid checkpoint, carrying its replayed state for resumption and its snapshot's totals for §14's check. */
export interface ValidCheckpoint extends LastValid {
  readonly state?: ReplayResult | undefined;
  readonly totals?: { readonly backing: Uint8Array; readonly issued: bigint; readonly burned: bigint } | undefined;
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
export function lastValidOf(state: ReplayResult, snapshot: Pick<Snapshot, "historyHash" | "evidenceHash" | "backing" | "issued" | "burned">): ValidCheckpoint {
  return { position: state.position, historyHash: snapshot.historyHash, evidenceHash: snapshot.evidenceHash,
    judgedIndex: position => state.judgedIndex(position), state,
    totals: { backing: snapshot.backing, issued: snapshot.issued, burned: snapshot.burned } };
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
  // §7.1, §14 non-extension without replay: a continuation's authenticated trail extends the last valid
  // prefix exactly where its chain value at the prefix's length is the prefix's evidence hash. Otherwise it
  // is excluded on that ground, and none of its records is replayed.
  if (lastValid !== undefined) {
    const at = trail.length < lastValid.position ? undefined : trail.evidence(lastValid.position);
    requireReplay(at !== undefined && same(at, lastValid.evidenceHash), "CONTINUITY");
  }
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

/** The pool-v3 revision this reader implements. */
const SPECIFICATION = "pool-v3 8d48b25";
let rules: Uint8Array | undefined;
/** The reader rules (§14 kept classes): the specification revision and the implementation's own code, every
 * file of the package's source or build tree by path and content. Any change to either discards kept state. */
function replayRules(): Uint8Array {
  if (rules === undefined) {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", ".."), hash = createHash("sha256");
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) hash.update(identityFrame([relative(root, path).split(sep).join("/"), readFileSync(path)]));
      }
    };
    walk(root);
    rules = sha256(identityFrame(["v3-replay-rules", SPECIFICATION, new Uint8Array(hash.digest())]));
  }
  return rules;
}
/** Objects the reader cannot name by content are named once per process, never equal to another process's. */
const PROCESS = randomBytes(32);
const unnamed = new WeakMap<object, Uint8Array>();
let objects = 0n;
function processName(object: object): Uint8Array {
  if (!unnamed.has(object)) unnamed.set(object, sha256(identityFrame(["unnamed", PROCESS, ++objects])));
  return unnamed.get(object)!;
}
/** The selected verifier's name (§14 replay inputs): its circuits' bytecode and key identities where it
 * declares them (a ProofVerifier derives them from the artifacts it loaded), else a name of this object alone. */
export function verifierName(verifier: ProofCheck): Uint8Array {
  const identities = verifier.identities;
  if (identities === undefined) return processName(verifier);
  const parts: (Uint8Array | string)[] = ["verifier"];
  for (const name of Object.keys(identities).sort()) parts.push(name, identities[name]!.bytecode, identities[name]!.vk);
  return sha256(identityFrame(parts));
}
/** A witness predicate's name: the identity it declares, else a name of this object alone. */
export function witnessName(witness: WitnessPredicate): Uint8Array {
  return witness.identity instanceof Uint8Array ? sha256(identityFrame(["witness", witness.identity])) : processName(witness);
}
/** The context kept classes are reused under (§14): the rules, configuration, venue identity (which fixes its lag), verifier and witness predicate. */
export function keptContext(parts: { readonly domain: Uint8Array; readonly venue: Uint8Array; readonly verifier: ProofCheck;
  readonly witness?: WitnessPredicate | undefined }): Uint8Array {
  return sha256(identityFrame(["v3-kept-context", replayRules(), parts.domain, parts.venue, verifierName(parts.verifier),
    parts.witness === undefined ? undefined : witnessName(parts.witness)]));
}

// Framed fields of the replay identity: no delimiter concatenation.
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
 * rules, configuration and backing, the segment and scoped terms, the imported
 * frontier by segment, position and history hash, the adopted block and
 * opening index, the verifier by its circuit identities, the witness predicate
 * and the revocation indices (storage decision item 5). */
function replayIdentity({ selection, terms, scopedTerms, verifier, witness }: ReplayContext, snapshot: Snapshot,
  { imported, block, openingIndex, revokedAt, revocations }: { imported: ImportedFrontier | undefined; block: readonly Adopted[];
    openingIndex: bigint | undefined; revokedAt: bigint | undefined; revocations: ReadonlyMap<string, bigint | undefined> | undefined }): Uint8Array {
  // The witness predicate decides which paths the namespace can answer, so it is part of the identity too.
  const parts: (Uint8Array | bigint | string | undefined)[] = ["v3-replay-identity", replayRules(), selection.domain, selection.backing, snapshot.segment,
    openingIndex, verifierName(verifier), witness === undefined ? undefined : witnessName(witness), revokedAt];
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
 * again, once §14's snapshot check passes. Otherwise it replays in a fresh
 * namespace from the segment's seed. */
function resumable(store: ReplayStore, identity: Uint8Array, segment: Uint8Array, trail: StoredTrail, lastValid: ValidCheckpoint | undefined): StateHandle | undefined {
  if (lastValid === undefined || trail.length < lastValid.position || !same(trail.segment, segment)) return undefined;
  const own = lastValid.state?.ns, candidates = [...(own === undefined ? [] : [own]), ...store.namespaces(identity).filter(ns => ns !== own)];
  for (const ns of candidates) {
    const tip = store.tip(ns);
    if (!same(store.identity(ns), identity)) continue;
    if (tip.position !== lastValid.position || !same(tip.history, lastValid.historyHash) || !same(tip.evidence, lastValid.evidenceHash)) continue;
    if (!keptTipHolds(store, ns, lastValid)) throw new KeptStateMismatch("a resumed tip is not its checkpoint's snapshot");
    const evidence = trail.evidence(tip.position);
    return evidence !== undefined && same(evidence, lastValid.evidenceHash) ? new StateHandle(store, ns) : undefined;
  }
  return undefined;
}

/** §14 kept classes: a kept valid class's state at position m of namespace `ns`, against its re-authenticated
 * snapshot. At the tip the snapshot check recomputes it; below, the stored chain values and totals at m must be
 * the snapshot's, and the file's digest vouches for the other rows at or below m. */
export function keptStateHolds(store: ReplayStore, ns: number, position: bigint, identity: Uint8Array, snapshot: Snapshot): boolean {
  if (!store.hasNamespace(ns) || !same(store.identity(ns), identity) || !same(store.tip(ns).segment, snapshot.segment)) return false;
  const tip = store.tip(ns), checkpoint: ValidCheckpoint = { position, historyHash: snapshot.historyHash, evidenceHash: snapshot.evidenceHash,
    totals: { backing: snapshot.backing, issued: snapshot.issued, burned: snapshot.burned } };
  if (tip.position === position) return keptTipHolds(store, ns, checkpoint);
  if (tip.position < position) return false;
  const event = position === 0n ? undefined : store.event(ns, position), total = store.total(ns, position, hex(snapshot.backing));
  const history = position === 0n ? genesisHistoryHash(snapshot.segment) : event?.history;
  const evidence = position === 0n ? genesisEvidenceHash(snapshot.segment) : event?.evidence;
  return history !== undefined && evidence !== undefined && same(history, snapshot.historyHash) && same(evidence, snapshot.evidenceHash) &&
    total.issued === snapshot.issued && total.burned === snapshot.burned;
}

/** The note root of a stored frontier: each completed left subtree folded with what lies to its right. */
function frontierRoot(leaves: bigint, ommers: readonly (bigint | undefined)[]): bigint | undefined {
  let node: bigint | undefined;
  for (let h = 0; h < NOTE_TREE_DEPTH; h++) {
    const left = ommers[h];
    if ((left !== undefined) !== (((leaves >> BigInt(h)) & 1n) === 1n)) return undefined;
    if (left !== undefined) node = noteNode(h, left, node ?? EMPTY_NOTE_SUBTREE[h]!);
    else if (node !== undefined) node = noteNode(h, node, EMPTY_NOTE_SUBTREE[h]!);
  }
  return leaves >> BigInt(NOTE_TREE_DEPTH) !== 0n ? undefined : node ?? EMPTY_NOTE_ROOT;
}

/** §14's snapshot check before resuming: the note root from the stored frontier, the spent root from the
 * top node's stored children, the totals from their rows and both chains at n from the stored values at
 * n − 1 and record n's digests, against the checkpoint's authenticated snapshot rather than values stored
 * beside them; and the stored tip must be that position. */
function keptTipHolds(store: ReplayStore, ns: number, lastValid: ValidCheckpoint): boolean {
  const tip = store.tip(ns), n = tip.position, segment = tip.segment;
  if (n !== lastValid.position) return false;
  let history = genesisHistoryHash(segment), evidence = genesisEvidenceHash(segment);
  if (n > 0n) {
    const event = store.event(ns, n), before = n === 1n ? undefined : store.event(ns, n - 1n), frontier = store.frontier(ns);
    const noteRoot = frontierRoot(frontier.leaves, frontier.ommers);
    if (event === undefined || (n > 1n && before === undefined) || noteRoot === undefined) return false;
    history = nextHistoryHash(before?.history ?? history, event.identity, noteRoot, store.spentRootFromChildren(ns), n);
    evidence = nextEvidenceHash(before?.evidence ?? evidence,
      { statementHash: event.identity, proofHash: event.proofHash, signatureHash: event.signatureHash }, n);
  }
  const totals = lastValid.totals === undefined ? true : (() => {
    const kept = store.total(ns, n, hex(lastValid.totals.backing));
    return kept.issued === lastValid.totals.issued && kept.burned === lastValid.totals.burned;
  })();
  return totals && same(history, lastValid.historyHash) && same(evidence, lastValid.evidenceHash) &&
    same(tip.history, history) && same(tip.evidence, evidence);
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
