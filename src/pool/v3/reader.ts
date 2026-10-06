// The v3 reader over one segment: pool-v3 §13 record reads through a
// RecordVenue and a checkpoint's trail replayed record by record through the
// state machine (state.ts), on reference venues only (guard.ts). A replay reads
// its records through its construction (construction.ts): pool-v3's, or lit-v1's
// beside it (slice 14 M14d). The walk that
// classifies checkpoints, imports, receipts, force and counts is
// scope-reader.ts; package-reader.ts is its entry.
import { sha256 } from "@noble/hashes/sha2.js";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes, EncodingError } from "../../bytes.js";
import {
  admittedReplacements, copyLimits, decodeRangeAnswer, heldCommitments, RangeLimitError, replacementChain, revocationIndex,
  type AdmittedReplacement, type ChainLink, type HeldCommitment, type HeldPrior, type RangeAnswer, type RangeEntry, type RangeLimits, type RecordKind,
} from "../../record-range.js";
import type { RecordVenue } from "../../record-venue.js";
import { VenueError } from "../../venue-error.js";
import type { Commitment, SnapshotDigest } from "../../venue-records.js";
import { EMPTY_NOTE_ROOT, EMPTY_NOTE_SUBTREE, NOTE_TREE_DEPTH, noteNode } from "../note-tree.js";
import type { Snapshot } from "./commitments.js";
import { POOL_V3, type Construction } from "./construction.js";
import { requireReferenceVenue, type VenueReference } from "./guard.js";
import type { SegmentHeader } from "./headers.js";
import { ReplayRefusal, EvidenceRefusal, requireReplay } from "./refusals.js";
import { KeptStateMismatch, type Demand, type ReplayStore } from "./replay-store.js";
import {
  applyRecord, openSegmentState, StateHandle, type Adopted, type LastValid, type MergedImport, type DeclaredVerifier, type SegmentReplay, type WitnessPredicate,
} from "./state.js";
import type { StoredTrail, TrailEvidence, WalkEvidence } from "./evidence-store.js";
import { verifyAhead } from "./verify-ahead.js";
import type { RootTerms } from "./terms.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

/** The reader's local budget for one range answer; never a protocol bound. */
export const RANGE_LIMITS: RangeLimits = Object.freeze({ maxBytes: 1_048_576n, maxEntries: 4096n });
/** The most the reader takes for one index past RANGE_LIMITS, whatever its venue declares. An entry costs
 * about 1 KB of memory across the Ergo view's read, the answer and its decoding (M11b2 review), so one such
 * answer stays near 400 MB with its bytes' copies, within the declared 1 GiB. 2^18 entries is a section of
 * about 9 MiB, seven times Ergo's voted block size, filled with empty records. Never a protocol bound. */
export const INDEX_LIMITS: RangeLimits = Object.freeze({ maxBytes: 32n << 20n, maxEntries: 1n << 18n });

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
  /** How many commitments `operator` holds in [from, to], below sequence `before` if given. */
  heldCount(operator: Uint8Array, from: bigint, to: bigint, before?: bigint): number;
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

/** One §13 answer over [start, t], read as successive windows. A window over the
 * reader's per-answer budget is asked again in halves. One index over it is asked
 * again under the venue's own bound for an index (`indexLimits`), capped at the
 * reader's INDEX_LIMITS, since anyone can fill one index under a subject past a
 * fixed budget; past that bound, or where the venue declares none, it stays
 * refused (RangeLimitError). The budgets
 * are local (§13.1). Each window's answer must be the exact answer to its own
 * request. */
function readWindows(venue: RecordVenue, venueId: Uint8Array, kind: RecordKind, subject: Uint8Array, start: bigint, t: bigint,
  take: (answer: RangeAnswer) => boolean | void): void {
  let from = start, span = t - start + 1n;
  while (from <= t) {
    const to = from + span - 1n > t ? t : from + span - 1n;
    const request = Object.freeze({ venue: copyBytes(venueId), kind, subject: copyBytes(subject), fromIndex: from, toIndex: to });
    let limits = RANGE_LIMITS, bytes: unknown;
    try { bytes = read(() => venue.range(request, limits)); } catch (error) {
      if (!(error instanceof RangeLimitError)) throw error;
      if (to > from) { span = (to - from + 1n) / 2n; continue; }
      if (venue.indexLimits === undefined) throw error;
      const declared = copyLimits(read(() => venue.indexLimits!()));
      limits = { maxBytes: declared.maxBytes < INDEX_LIMITS.maxBytes ? declared.maxBytes : INDEX_LIMITS.maxBytes,
        maxEntries: declared.maxEntries < INDEX_LIMITS.maxEntries ? declared.maxEntries : INDEX_LIMITS.maxEntries };
      bytes = read(() => venue.range(request, limits));
    }
    if (bytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
    if (!(bytes instanceof Uint8Array)) throw new EncodingError("range answer");
    // `take` returns true once it needs no later window.
    if (take(decodeRangeAnswer(bytes, request, limits)) === true) return;
    from = to + 1n; span *= 2n;
  }
}

/** A party's kept §13 answers through one index t of its own venue (§§13.2–13.3). Each kind and subject's
 * answer is kept in `store` through the index it was read to and read window by window only past it (§13.3's
 * adjacent earlier answer), so neither memory nor a later read's venue requests grow with the venue's age.
 * Each call extends its answer to t where needed; what it returns, and every query of the kept rows, is
 * bounded by t. A read that fails keeps none of its windows. */
export interface KeptAnswers {
  /** `backing`'s admitted replacements (C2.5) under its declared rule, each at its first witnessing. */
  replacements(backing: Uint8Array, rule: Uint8Array | undefined): readonly AdmittedReplacement[];
  /** The index of `obligor`'s first revocation (C2b.1), if witnessed by t. */
  revocation(obligor: Uint8Array): bigint | undefined;
  /** Keep `operator`'s held commitments (C2.3.3) through t and return it, to read them from the store.
   * `window` is given each answer newly read from the venue, with every record it carries, held or not. */
  held(operator: Uint8Array, window?: (answer: RangeAnswer) => void): Uint8Array;
  /** Keep `backing`'s publications (kind 4) through t and return it, to read them from the store. */
  publications(backing: Uint8Array): Uint8Array;
}
/** `charge` counts what an answer keeps against the party's quota. The venue's identity is the caller's own. */
export function keptAnswers(venue: RecordVenue, venueId: Uint8Array, store: ReplayStore, t: bigint, charge: (bytes: bigint) => void): KeptAnswers {
  /** Extend the kept answer of `kind` for `subject` to t, unless it already decides t. */
  const extend = (kind: RecordKind, subject: Uint8Array, decided: (kept: { through: bigint; value: bigint | undefined }) => boolean,
    windows: (from: bigint, value: bigint | undefined) => bigint | undefined): void => {
    const kept = store.keptAnswer(kind, subject);
    if (kept !== undefined && (kept.through >= t || decided(kept))) return;
    store.keepAnswer(kind, subject, () => ({ through: t, value: windows(kept === undefined ? 0n : kept.through + 1n, kept?.value) }));
  };
  return {
    replacements(backing, rule) {
      // Admitted replacements are kept at their first witnessing, so one identity counts once across windows and reads.
      extend(2, backing, () => false, from => {
        readWindows(venue, venueId, 2, backing, from, t, answer => {
          for (const entry of answer.entries) {
            const [admitted] = admittedReplacements({ request: answer.request, entries: [entry] }, rule);
            if (admitted !== undefined) { charge(BigInt(entry.record.length)); store.putReplacement(backing, admitted.identity, entry.index, entry.record); }
          }
        });
        return undefined;
      });
      return admittedReplacements({ request: { venue: venueId, kind: 2, subject: backing, fromIndex: 0n, toIndex: t },
        entries: store.replacements(backing, t) }, rule);
    },
    revocation(obligor) {
      // K's first revocation decides every later index, so an answer that found one is not extended.
      extend(3, obligor, kept => kept.value !== undefined, from => {
        let found: bigint | undefined;
        readWindows(venue, venueId, 3, obligor, from, t, answer => (found = revocationIndex(answer)) !== undefined);
        return found;
      });
      const revocation = store.keptAnswer(3, obligor)!.value;
      return revocation !== undefined && revocation <= t ? revocation : undefined;
    },
    held(operator, window) {
      extend(1, operator, () => false, (from, highest) => {
        let prior: HeldPrior | undefined = from === 0n ? undefined : { fromIndex: from, highest: highest! };
        readWindows(venue, venueId, 1, operator, from, t, answer => {
          const { held, next } = heldCommitments(answer, prior);
          charge(136n * BigInt(held.length)); store.putHeld(operator, held); prior = next;
          window?.(answer);
        });
        return prior?.highest ?? highest ?? 0n;
      });
      return operator;
    },
    publications(backing) {
      extend(4, backing, () => false, from => {
        readWindows(venue, venueId, 4, backing, from, t, answer => {
          charge(answer.entries.reduce((sum, entry) => sum + BigInt(entry.record.length), 0n));
          store.putPublications(backing, answer.entries);
        });
        return undefined;
      });
      return backing;
    },
  };
}

/** §13 reads against the reader's independently selected venue over [0, t]:
 * the replacement chain (C2.5) from the kind-2 answer under the venue's lag,
 * the held commitments (C2.3.3) of every party in force within its term
 * (C2.10.13), each passed by its packaged directory (C2.4.2) or listed as
 * carrying the backing, and K's revocation (C2b.1). The clock and lag are the
 * venue's; a supplied answer is never evidence. The answers are the reader's
 * kept ones (`keptAnswers`), extended to t. This view is shared by the
 * original-segment clock and the import walks. Nothing here classifies a
 * checkpoint. */
export async function readRecordView(selection: Pick<ReaderSelection, "mode" | "domain" | "venue" | "backing" | "judgingIndex">, terms: RootTerms,
  evidence: Pick<WalkEvidence, "directory" | "chargeAnswer">, venue: RecordVenue, reference: VenueReference, store: ReplayStore): Promise<RecordView> {
  // The caller holds this preimage independently of supplied record evidence.
  // The reference never reads a deployment venue, even if it offers valid ranges (guard.ts).
  const lag = read(() => venue.lag());
  const id = requireReferenceVenue(reference, { id: venue.id, lag: () => lag });
  if (!same(id, selection.venue)) throw new EvidenceRefusal("selection-mismatch");
  const t = selection.judgingIndex, now: unknown = read(() => venue.witnessedIndex());
  if (typeof now !== "bigint" || typeof lag !== "bigint" || t > now || (selection.mode === "current-fixture" && t !== now)) {
    throw new EvidenceRefusal("unresolved-evidence");
  }
  const backing = copyBytes(selection.backing);
  const answers = keptAnswers(venue, copyBytes(selection.venue), store, t, bytes => evidence.chargeAnswer(bytes));
  const { chain } = replacementChain(answers.replacements(backing, terms.replacementRule), { backing, original: terms.operator, lag, now: t });
  const revokedAt = answers.revocation(terms.obligor);
  const heldOf = (operator: Uint8Array): Uint8Array => answers.held(operator);
  const publicationsKept = (): Uint8Array => answers.publications(backing);
  const termEnd = (i: number): bigint => (i + 1 < chain.length ? chain[i + 1]!.from - 1n : t);
  const carries = (h: HeldCommitment): SnapshotDigest | undefined => {
    const directory = evidence.directory(h.commitment.root);
    if (directory === undefined) throw new EvidenceRefusal("unresolved-evidence");
    return directory.find(entry => same(entry.name, backing));
  };
  // Iterations take one row per query, so no statement stays open while the walk writes between steps.
  function* held(operator: Uint8Array): Iterable<HeldCommitment> {
    for (let next = store.nextHeld(heldOf(operator), 0n, undefined, t); next !== undefined; next = store.nextHeld(operator, 0n, next.commitment.sequence, t)) yield next;
  }
  function* publications(): Iterable<RangeEntry> {
    for (let next = store.nextPublication(publicationsKept(), undefined, t); next !== undefined; next = store.nextPublication(backing, next, t)) yield next;
  }
  return { t, lag, chain, revokedAt, termEnd, carries, held,
    heldAt: (operator, sequence) => store.heldAt(heldOf(operator), sequence, t),
    heldAbove: (operator, sequence) => store.heldAbove(heldOf(operator), sequence, t),
    nextHeld: (operator, fromIndex, after) => store.nextHeld(heldOf(operator), fromIndex, after, t),
    previousHeld: (operator, toIndex, before) => store.previousHeld(heldOf(operator), toIndex, before, t),
    firstHeldIndex: (operator, from, to) => store.firstHeldIndex(heldOf(operator), from, to < t ? to : t),
    heldCount: (operator, from, to, before) => store.heldCount(heldOf(operator), from, to < t ? to : t, before),
    nextPublication: after => store.nextPublication(publicationsKept(), after, t),
    publications, publicationCount: () => store.publicationCount(publicationsKept(), t) };
}

/** What a trail replay reads besides its records: the construction (pool-v3's
 * by default), the store its state lives in, the selection, the selected
 * backing's terms (and each scoped backing's), the segment's header, the proof
 * verifier and the outputs to witness. */
export interface ReplayContext {
  readonly construction?: Construction | undefined;
  readonly store: ReplayStore;
  readonly selection: ReaderSelection;
  readonly terms: RootTerms;
  readonly scopedTerms?: ReadonlyMap<string, RootTerms | undefined> | undefined;
  readonly header: SegmentHeader;
  readonly verifier: DeclaredVerifier;
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
  /** Read through the construction its namespace replays (pool-v3's by default; another's namespace is refused). */
  constructor(store: ReplayStore, ns: number, position: bigint, facts: Pick<ReplayResult, "issued" | "burned" | "adoptionIndices" | "identity">,
    construction: Construction = POOL_V3 as Construction) {
    super(store, ns, position, construction);
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
  /** The checkpoint's witnessed index. */
  readonly index: bigint;
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
 * ReplayRefusal with its check; the verifier's own failures propagate. `lastValid` is the segment's last valid checkpoint
 * before this one: the trail must reach its length and reproduce its evidence
 * and history hashes there (C2.10.12, pool-v3 §7.1), the evidence before any
 * verification. The replay runs in one savepoint of the store: a refusal
 * leaves nothing behind, and a new namespace it opened disappears. */
export async function replayTrail(context: ReplayContext, snapshot: Snapshot, trail: StoredTrail, options: TrailOptions): Promise<ReplayResult> {
  const { store, selection, terms, scopedTerms, header, verifier, witness } = context, construction = context.construction ?? POOL_V3 as Construction;
  // Exported: a selection under another configuration is refused here, not trusted from a caller.
  requireReplay(same(selection.domain, construction.reader.domain()), "CONFIGURATION");
  const { index, revokedAt, revocations, lastValid, imported, block = [], openingIndex, isOpening = false } = options;
  const scope = construction.reader.scopeRoot(header);
  // §7.1, §14 non-extension without replay: a continuation's authenticated trail extends the last valid
  // prefix exactly where its chain value at the prefix's length is the prefix's evidence hash. Otherwise it
  // is excluded on that ground, and none of its records is replayed.
  if (lastValid !== undefined) {
    const at = trail.length < lastValid.position ? undefined : trail.evidence(lastValid.position);
    requireReplay(at !== undefined && same(at, lastValid.evidenceHash), "CONTINUITY");
  }
  const identity = replayIdentity(context, snapshot, { imported, block, openingIndex, revokedAt, revocations });
  return store.replay(async () => {
    const resumed = isOpening ? undefined : resumable(store, identity, snapshot.segment, trail, lastValid, construction);
    const state = resumed ?? openSegmentState(store, snapshot.segment, identity, imported, construction);
    if (!isOpening) requireReplay(trail.length >= BigInt(block.length), "ADOPTION");
    // Records are read from the reader's own storage one at a time, their proofs started ahead where the verifier runs off this thread.
    const ahead = verifyAhead(verifier, trail.records(state.position), state.position, block);
    const replay: SegmentReplay = { domain: selection.domain, backing: selection.backing, segment: snapshot.segment, scope, terms, scopedTerms,
      verifier: ahead.verifier, index, revokedAt, revocations, lastValid, block, witness };
    for (const bytes of ahead.records) await applyRecord(state, bytes, replay);
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
    replayedOutputs(store, state.ns, construction);
    return new ReplayResult(store, state.ns, position, { issued, burned, adoptionIndices, identity }, construction);
  });
}

let code: Uint8Array | undefined;
/** The reader rules (§14 kept classes): the construction's specification revision (construction.ts `specification`)
 * and the implementation's own code, every file of the package's source or build tree by path and content. Any change
 * to either discards kept state. */
function replayRules(specification: string): Uint8Array {
  return sha256(identityFrame(["v3-replay-rules", specification, codeName()]));
}
function codeName(): Uint8Array {
  if (code === undefined) {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", ".."), hash = createHash("sha256");
    const add = (name: string, path: string): void => { hash.update(identityFrame([name, readFileSync(path)])); };
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        // Directories are entered only as themselves, so a linked directory cannot loop; a linked file is read.
        const path = join(dir, name), own = lstatSync(path);
        if (own.isDirectory()) walk(path);
        else if (own.isFile() || (own.isSymbolicLink() && statSync(path).isFile())) add(relative(root, path).split(sep).join("/"), path);
      }
    };
    walk(root);
    // The package's manifest and lockfile, where present, name the dependencies the code runs on.
    for (const name of ["package.json", "package-lock.json"]) if (existsSync(join(root, "..", name))) add(`../${name}`, join(root, "..", name));
    code = new Uint8Array(hash.digest());
  }
  return code;
}
// Named when the module loads, so a later rebuild cannot give old code the new name.
codeName();
/** A witness predicate the reader cannot name by content is named once per process, never equal to another process's. */
const PROCESS = randomBytes(32);
const unnamed = new WeakMap<object, Uint8Array>();
let objects = 0n;
function processName(object: object): Uint8Array {
  if (!unnamed.has(object)) unnamed.set(object, sha256(identityFrame(["unnamed", PROCESS, ++objects])));
  return unnamed.get(object)!;
}
/** The selected verifier's name (§14 replay inputs): its circuits' bytecode and key identities (a ProofVerifier
 * derives them from the relations it loaded). */
export function verifierName(verifier: DeclaredVerifier): Uint8Array {
  const identities = verifier.identities;
  const parts: (Uint8Array | string)[] = ["verifier"];
  for (const name of Object.keys(identities).sort()) parts.push(name, identities[name]!.bytecode, identities[name]!.vk);
  return sha256(identityFrame(parts));
}
/** A witness predicate's name: the identity it declares, else a name of this object alone. */
export function witnessName(witness: WitnessPredicate): Uint8Array {
  return witness.identity instanceof Uint8Array ? sha256(identityFrame(["witness", witness.identity])) : processName(witness);
}
/** The context kept classes are reused under (§14): the construction's rules, configuration, venue identity (which
 * fixes its lag), verifier and witness predicate. */
export function keptContext(parts: { readonly construction: Construction; readonly domain: Uint8Array; readonly venue: Uint8Array;
  readonly verifier: DeclaredVerifier; readonly witness?: WitnessPredicate | undefined }): Uint8Array {
  return sha256(identityFrame(["v3-kept-context", replayRules(parts.construction.reader.specification), parts.domain, parts.venue, verifierName(parts.verifier),
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
function replayIdentity({ construction, selection, terms, scopedTerms, verifier, witness }: ReplayContext, snapshot: Snapshot,
  { imported, block, openingIndex, revokedAt, revocations }: { imported: ImportedFrontier | undefined; block: readonly Adopted[];
    openingIndex: bigint | undefined; revokedAt: bigint | undefined; revocations: ReadonlyMap<string, bigint | undefined> | undefined }): Uint8Array {
  // The witness predicate decides which paths the namespace can answer, so it is part of the identity too.
  const parts: (Uint8Array | bigint | string | undefined)[] = ["v3-replay-identity",
    replayRules((construction ?? POOL_V3 as Construction).reader.specification), selection.domain, selection.backing, snapshot.segment,
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
function resumable(store: ReplayStore, identity: Uint8Array, segment: Uint8Array, trail: StoredTrail, lastValid: ValidCheckpoint | undefined,
  construction: Construction): StateHandle | undefined {
  if (lastValid === undefined || trail.length < lastValid.position || !same(trail.segment, segment)) return undefined;
  const own = lastValid.state?.ns, candidates = [...(own === undefined ? [] : [own]), ...store.namespaces(identity).filter(ns => ns !== own)];
  for (const ns of candidates) {
    const tip = store.tip(ns);
    if (!same(store.identity(ns), identity)) continue;
    if (tip.position !== lastValid.position || !same(tip.history, lastValid.historyHash) || !same(tip.evidence, lastValid.evidenceHash)) continue;
    if (!keptTipHolds(store, ns, lastValid, construction) || !keptOutputsHold(store, ns, construction, trail, lastValid.position)) {
      throw new KeptStateMismatch("a resumed tip is not its checkpoint's snapshot");
    }
    const evidence = trail.evidence(tip.position);
    return evidence !== undefined && same(evidence, lastValid.evidenceHash) ? new StateHandle(store, ns, undefined, construction) : undefined;
  }
  return undefined;
}

/** §14 kept classes: a kept valid class's state at position m of namespace `ns`, against its re-authenticated
 * snapshot. At the tip the snapshot check recomputes it; below, the stored chain values and totals at m must be
 * the snapshot's, and the file's digest vouches for the other rows at or below m. A construction without a note
 * tree also rebuilds its outputs from `trail`, the class's served trail, and each imported namespace's from its own
 * segment's trail in `trails` (lit-v1 §10, `keptOutputsHold`, `keptImportsHold`). */
export function keptStateHolds(store: ReplayStore, ns: number, position: bigint, identity: Uint8Array, snapshot: Snapshot,
  construction: Construction = POOL_V3 as Construction, trail?: StoredTrail, trails?: Pick<TrailEvidence, "trail">): boolean {
  return keptRowsHold(store, ns, position, identity, snapshot, construction) && keptOutputsHold(store, ns, construction, trail, position) &&
    keptImportsHold(store, ns, construction, trails);
}
/** Lit-v1 §10's imports: a resumed lit state reads its imported closure's outputs from the imported namespaces' rows,
 * which no root in its snapshot checks either. Each imported namespace's own outputs through the position imported
 * must be its segment's trail's, through the chain value kept there; a namespace this process replayed or already
 * rebuilt is known and reads nothing. A trail `trails` does not hold leaves the state unmatched (kept state to
 * discard; a read without the evidence is then unresolved). The chain value and demand rows the rebuild reads are
 * vouched for by §14's digest, as the pool's rows beyond its roots are. A construction with a note tree checks its roots
 * instead. */
function keptImportsHold(store: ReplayStore, ns: number, construction: Construction, trails: Pick<TrailEvidence, "trail"> | undefined): boolean {
  if (construction.namespace.tree) return true;
  for (const [segment, { ns: source, upto }] of store.imports(ns)) {
    const from = known(store).get(source);
    if (upto === 0n || (from !== undefined && from.position >= upto)) continue;
    const event = store.event(source, upto), named = Uint8Array.from(Buffer.from(segment, "hex"));
    const trail = event === undefined || trails === undefined || !same(store.tip(source).segment, named) ? undefined :
      trails.trail(named, event.evidence);
    if (trail === undefined || !keptOutputsHold(store, source, construction, trail, upto)) return false;
  }
  return true;
}
function keptRowsHold(store: ReplayStore, ns: number, position: bigint, identity: Uint8Array, snapshot: Snapshot, construction: Construction): boolean {
  if (!store.hasNamespace(ns) || store.construction(ns).name !== construction.namespace.name || !same(store.identity(ns), identity) ||
      !same(store.tip(ns).segment, snapshot.segment)) return false;
  const tip = store.tip(ns), checkpoint: ValidCheckpoint = { position, historyHash: snapshot.historyHash, evidenceHash: snapshot.evidenceHash,
    totals: { backing: snapshot.backing, issued: snapshot.issued, burned: snapshot.burned } };
  if (tip.position === position) return keptTipHolds(store, ns, checkpoint, construction);
  if (tip.position < position) return false;
  const event = position === 0n ? undefined : store.event(ns, position), total = store.total(ns, position, hex(snapshot.backing));
  const history = position === 0n ? construction.genesisHistory(snapshot.segment) : event?.history;
  const evidence = position === 0n ? construction.genesisEvidence(snapshot.segment) : event?.evidence;
  return history !== undefined && evidence !== undefined && same(history, snapshot.historyHash) && same(evidence, snapshot.evidenceHash) &&
    total.issued === snapshot.issued && total.burned === snapshot.burned;
}

/** Where each namespace's own outputs are known to be its trail's (lit-v1 §10), per store this process holds: through a
 * position, with the own outputs (leaves) and the demands its trail stood up there. A namespace this process's replay
 * wrote is known through what it wrote; one loaded from a kept file is known only once rebuilt, so each is rebuilt once,
 * from where it is known on, never per checkpoint. */
interface KnownOutputs { readonly position: bigint; readonly leaves: bigint; readonly demands: ReadonlyMap<string, Demand> }
const knownOutputs = new WeakMap<ReplayStore, Map<number, KnownOutputs>>();
function known(store: ReplayStore): Map<number, KnownOutputs> {
  let map = knownOutputs.get(store);
  if (map === undefined) { map = new Map(); knownOutputs.set(store, map); }
  return map;
}
/** Record that this process's own replay wrote namespace `ns` through its tip. */
function replayedOutputs(store: ReplayStore, ns: number, construction: Construction): void {
  if (construction.namespace.tree) return;
  const tip = store.tip(ns), prior = known(store).get(ns);
  known(store).set(ns, { position: tip.position, leaves: tip.leaves, demands: prior?.position === tip.position ? prior.demands : new Map() });
}

/** Lit-v1 §10: no root in a lit snapshot checks the output set, so a reader resuming a namespace without a note tree
 * rebuilds it from the kept statements: its own output rows through `position` must be exactly, in order, the outputs
 * `trail`'s first `position` records derive (§2), read past where they are already known (`knownOutputs`). A
 * settlement reads its demand from the trail's records, or, one stood up before what is rebuilt (an imported one, or one
 * this process's replay wrote), from the state before it; imported outputs are their own namespaces' (each rebuilt by
 * `keptImportsHold` before a state importing it is reused). The caller has checked the trail's chain at `position`
 * against the namespace's, so its records are the namespace's. A construction with a note tree has its root checked instead (`keptTipHolds`). */
function keptOutputsHold(store: ReplayStore, ns: number, construction: Construction, trail: StoredTrail | undefined, position: bigint): boolean {
  if (construction.namespace.tree) return true;
  const from = known(store).get(ns);
  // Rows through a known position are a prefix of those known: a position at or below it holds.
  if (from !== undefined && from.position >= position) return true;
  if (trail === undefined || trail.length < position) return false;
  const after = from?.position ?? 0n, local = new Map(from?.demands);
  const derived: { readonly cm: bigint; readonly position: bigint }[] = [];
  let at = after;
  for (const bytes of position === after ? [] : trail.records(after)) {
    if (++at > position) break;
    let record;
    try { record = construction.decode(bytes); } catch (error) {
      // A record no valid prefix holds (malformed, or a request below) leaves the kept state unmatched.
      if (error instanceof EncodingError) return false;
      throw error;
    }
    const kind = construction.kind(record), before = at - 1n;
    if (kind < 1 || kind > 6) return false;
    const view = construction.view(record, id => local.get(id) ?? new StateHandle(store, ns, before, construction).demand(id));
    if (view.demand !== undefined) local.set(view.demand.id, view.demand.value);
    for (const cm of view.outputs) derived.push({ cm, position: at });
  }
  // Every own row past the known leaves at or below `position` is a derived output, in order, and none is missing.
  let k = 0;
  for (const output of store.ownOutputs(ns, from?.leaves ?? 0n)) {
    if (output.position > position) continue;
    const expected = derived[k++];
    if (expected === undefined || expected.cm !== output.cm || expected.position !== output.position) return false;
  }
  if (k !== derived.length) return false;
  known(store).set(ns, { position, leaves: (from?.leaves ?? 0n) + BigInt(k), demands: local });
  return true;
}

/** Whether a namespace's stored tip reproduces from its own rows (§14's snapshot check with the tip's chain values in
 * the snapshot's place): an operator's journal checks its admission state so when it reopens, without re-verifying. */
export function storedTipHolds(store: ReplayStore, ns: number, construction: Construction = POOL_V3 as Construction): boolean {
  const tip = store.tip(ns);
  return keptTipHolds(store, ns, { position: tip.position, historyHash: tip.history, evidenceHash: tip.evidence }, construction);
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
  // A full tree (2^32 leaves, pool-v2 §4) has no left subtree waiting: its root is the stored whole tree.
  const full = ommers[NOTE_TREE_DEPTH];
  if (leaves === 1n << BigInt(NOTE_TREE_DEPTH)) return node === undefined ? full : undefined;
  return leaves >> BigInt(NOTE_TREE_DEPTH) !== 0n || full !== undefined ? undefined : node ?? EMPTY_NOTE_ROOT;
}

/** §14's snapshot check before resuming: the note root from the stored frontier (a construction with a note
 * tree), the spent root from the top node's stored children, the totals from their rows and both chains at n
 * from the stored values at n − 1 and record n's digests, against the checkpoint's authenticated snapshot
 * rather than values stored beside them; and the stored tip must be that position. Lit-v1 §10's output set, which no
 * root checks, is rebuilt from the trail (`keptOutputsHold`). */
function keptTipHolds(store: ReplayStore, ns: number, lastValid: ValidCheckpoint, construction: Construction): boolean {
  const tip = store.tip(ns), n = tip.position, segment = tip.segment;
  if (n !== lastValid.position || store.construction(ns).name !== construction.namespace.name) return false;
  let history = construction.genesisHistory(segment), evidence = construction.genesisEvidence(segment);
  if (n > 0n) {
    const event = store.event(ns, n), before = n === 1n ? undefined : store.event(ns, n - 1n);
    const frontier = construction.namespace.tree ? store.frontier(ns) : undefined;
    const noteRoot = frontier === undefined ? 0n : frontierRoot(frontier.leaves, frontier.ommers);
    if (event === undefined || (n > 1n && before === undefined) || noteRoot === undefined) return false;
    history = construction.nextHistory(before?.history ?? history, event.identity, noteRoot, store.spentRootFromChildren(ns), n);
    evidence = construction.nextEvidence(before?.evidence ?? evidence,
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
