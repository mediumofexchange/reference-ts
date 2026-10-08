// §12 evidence and §13 record readers for any scope, under the configuration of the
// construction the reader reads (pool-v3 §11.4's by default, or lit-v1 §9's: slice
// 14 M14d), which reads every frame. The construction, verifier (one with proofs),
// selection and reference venue are independently held by the reader.
// A package is copied into the reader's own evidence storage before any pass
// reads it (pool-v3 §14), from memory or streamed.
import { compareBytes, copyBytes, copyUnshared, EncodingError } from "../../bytes.js";
import type { RecordVenue } from "../../record-venue.js";
import { decodeCommitment, verifyCommitment } from "../../venue-records.js";
import { isValue } from "../field.js";
import type { Snapshot } from "./commitments.js";
import { POOL_V3, type Construction } from "./construction.js";
import { faultObserver, type FaultResult, type ReportingFaultObserver } from "./fault-observer.js";
import { requireReferenceVenue, type VenueReference } from "./guard.js";
import { EvidenceStore, type EvidenceBatch } from "./evidence-store.js";
import type { ReaderSelection, SignedTerms } from "./reader.js";
import type { Record } from "./records.js";
import { EvidenceRefusal, requireReplay } from "./refusals.js";
import type { ReceiptFact } from "./receipt-state.js";
import { checkpointScope } from "./scope-evidence.js";
import { classifyScopeFrontier, classifyScopes, withCause, type FrontierContext, type FrontierResult, type ImportContext,
  type ScopeResult } from "./scope-reader.js";
import { KeptStateMismatch, ReplayStore } from "./replay-store.js";
import type { DeclaredVerifier, WitnessPredicate } from "./state.js";
import { declaredParallel } from "./verify-ahead.js";

/** A §12 package as a reader receives it: bytes in memory or a stream of chunks. */
export type PackageSource = Uint8Array | AsyncIterable<Uint8Array>;
const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
export interface PackageReader {
  /** The construction read, whose configuration the selection must name: pool-v3 by default. */
  readonly construction?: Construction | undefined;
  /** The proof verifier of a construction with proofs (pool-v3); see `ReadOptions` for a read of one without. */
  readonly verifier: DeclaredVerifier;
  readonly venue: RecordVenue;
  readonly reference: VenueReference;
  /** The party's replay storage; a private in-memory store by default, kept alive by the result. */
  readonly store?: ReplayStore | undefined;
  /** The party's evidence storage the package is copied into before any pass, of the read's construction; a private
   * in-memory store by default, closed when the read ends. A party's file keeps memory flat and retains the evidence across reads,
   * so a later package need carry only new objects and trails can be assembled (§14 incremental retrieval). */
  readonly evidence?: EvidenceStore | undefined;
  /** Outputs to keep incremental witnesses for (a wallet's own), so their paths can be read from the result. */
  readonly witness?: WitnessPredicate | undefined;
  /** False leaves the result's `carrying` listing empty: it reads one row per checkpoint ever held, which a party that
   * uses none of them (the operator's own reads before each admission) need not pay. */
  readonly carrying?: boolean | undefined;
}
/** A frontier read's options: `answers` also lists the acceptances and releases the venue witnessed for the backing
 * (a holder settling reads its disclosure count from them, C3.5, and C3.8's reading its outcome); other reads leave
 * it unset. */
export interface FrontierReader extends PackageReader { readonly answers?: boolean | undefined }
/** A read's options: a construction whose records carry no proof (lit-v1) asks no verifier, and ignores one given. */
export type ReadOptions = Omit<PackageReader, "verifier"> & { readonly verifier?: DeclaredVerifier | undefined };
export type FrontierReadOptions = Omit<FrontierReader, "verifier"> & { readonly verifier?: DeclaredVerifier | undefined };

/** Own selection bytes and primitive fields before any asynchronous proof check. */
export function ownSelection(input: ReaderSelection): ReaderSelection {
  if (input === null || typeof input !== "object" ||
      Object.keys(input).sort().join(",") !== "backing,domain,judgingIndex,mode,operator,root,sequence,venue") throw new EncodingError("invalid selection");
  const { mode, sequence, judgingIndex, backing, domain, operator, root, venue } = input;
  if (!isValue(sequence) || sequence === 0n || !isValue(judgingIndex) || !["current-fixture", "historical-fixture"].includes(mode)) {
    throw new EncodingError("invalid selection");
  }
  const fixed = (value: Uint8Array): Uint8Array => {
    const result = copyBytes(value);
    if (result.length !== 32) throw new EncodingError("invalid selection identifier");
    return result;
  };
  return { mode, sequence, judgingIndex, backing: fixed(backing), domain: fixed(domain), operator: fixed(operator), root: fixed(root), venue: fixed(venue) };
}

/** The caller's verifier bound once, with a copy of the circuit identities it declares, which must be the
 * configuration's (§11.1) and name it in kept state (§14). A construction without proofs takes none: its verifier
 * names no circuit, and a call of it is a programming failure. */
export function ownVerifier(construction: Construction, verifierIn: DeclaredVerifier | undefined): DeclaredVerifier {
  if (!construction.reader.proofs) {
    return { verify: () => { throw new Error("a record of this construction has no proof"); }, identities: construction.reader.verifierIdentities(undefined) };
  }
  const verify = verifierIn?.verify;
  if (typeof verify !== "function") throw new TypeError("a proof verifier is required");
  const parallel = declaredParallel(verifierIn!);
  return { verify: verify.bind(verifierIn), identities: construction.reader.verifierIdentities(verifierIn!.identities), ...(parallel === undefined ? {} : { parallel }) };
}

/** Copy the package into the reader's evidence storage, then read only the copy and what the store retains.
 * Bytes are copied before the first await; a stream is copied chunk by chunk. The package's own items go
 * when the read ends. */
async function withEvidence<T>(source: PackageSource, options: ReadOptions, construction: Construction,
  read: (batch: EvidenceBatch) => Promise<T>): Promise<T> {
  if (options.evidence !== undefined && options.evidence.construction !== construction) throw new TypeError("the evidence store reads another construction's evidence");
  const own = options.evidence === undefined, store = options.evidence ?? new EvidenceStore(":memory:", { construction });
  let batch: EvidenceBatch | undefined, result: T;
  const done = (): void => { if (own) store.close(); else batch?.release(); };
  try {
    const streamed = source !== null && typeof source === "object" &&
      typeof (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function";
    batch = streamed ? await store.importStream(source as AsyncIterable<Uint8Array>) : store.importBytes(source as Uint8Array);
    result = await read(batch);
  } catch (error) {
    // A failed cleanup does not replace the read's own failure (as `closing` in scope-reader.ts).
    try { done(); } catch (cleanup) { withCause(error, cleanup); }
    throw error;
  }
  done();
  return result;
}

/** Each of kinds 1, 2 and 10 at most once in the package; the import refused kinds a v3 reader does not read. */
function readKinds(batch: EvidenceBatch): void {
  if ([1, 2, 10].some(kind => batch.count(kind) > 1)) throw new EvidenceRefusal("unsupported-scope");
}

/** Returns a complete reference verdict/state or throws a named evidence/replay
 * refusal. Never returns a partial state or treats unavailable ancestry as empty.
 * The internal state is newly replayed per call; no asserted state is an input.
 * Compact faults replace only dependency-resolved non-opening target trails;
 * the selected envelope remains complete. The selection's scope and every
 * scope in its ancestry may name one backing or several (C2.10.3–7). */
export async function readPackage<R = Record>(source: PackageSource, selected: ReaderSelection, options: ReadOptions): Promise<ScopeResult<R> & FaultResult> {
  return withFacts(async attach => {
    const owned = ownPackageRead(selected, options);
    return withEvidence(source, options, owned.construction, batch => keptOrAgain(options, async () => {
      const { context, faults, venue } = openPackage(batch, owned, options);
      try {
        const result = await classifyScopes<R>(context, venue, batch);
        return { ...result, ...faults.result() };
      } catch (error) { throw attach(error, faults, context); }
    }));
  });
}

/** What a package read had established when it refused: the observational fault facts (pool-v3 §9) and a
 * receipt walk's contradictions (C2.10.9b). Neither changes the refusal; a caller may report them beside it. */
export interface RefusalFacts extends FaultResult {
  readonly receiptEvidence?: { readonly contradictedAt: readonly ReceiptFact[] };
}
const established = new WeakMap<object, RefusalFacts>();
/** The facts a package read established before it threw `error` (WORK.md Next 4(h)); undefined for an error
 * thrown before the walk began. Facts are keyed by the error object: an adapter sharing one error instance
 * between concurrent reads may see one read's facts cleared by the other's. */
export function refusalFacts(error: unknown): RefusalFacts | undefined {
  return error !== null && typeof error === "object" ? established.get(error) : undefined;
}
type Attach = (error: unknown, faults: ReportingFaultObserver, context: Pick<ImportContext, "receiptWalk">) => unknown;
/** One read whose walk attaches its facts to what it throws. An error this read threw without attaching (one a
 * caller's adapter shares across reads, say) keeps no facts of an earlier read. */
async function withFacts<T>(read: (attach: Attach) => Promise<T>): Promise<T> {
  let attached: unknown;
  const attach: Attach = (error, faults, context) => {
    if (error !== null && typeof error === "object") {
      established.set(error, { ...faults.result(), ...(context.receiptWalk === undefined ? {} : { receiptEvidence: context.receiptWalk.evidence() }) });
    }
    attached = error;
    return error;
  };
  try { return await read(attach); } catch (error) {
    if (error !== attached && error !== null && typeof error === "object") established.delete(error);
    throw error;
  }
}

/** §14: kept state that fails a check before reuse is discarded, and the read classifies again from the evidence.
 * A second mismatch, with nothing kept, is a programming failure and stays visible. (Retained evidence that
 * fails its check reads as absent or leaves the read unresolved; see evidence-store.ts.) */
async function keptOrAgain<T>(options: ReadOptions, read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) {
    if (!(error instanceof KeptStateMismatch) || options.store === undefined) throw error;
    options.store.discardKept();
    return read();
  }
}

/** The reader's own inputs, checked before the package is read. */
function ownPackageRead(selected: ReaderSelection, options: ReadOptions) {
  const { verifier: verifierIn, venue, reference: referenceIn } = options;
  const construction = options.construction ?? POOL_V3 as Construction, domain = construction.reader.domain();
  const verifier = ownVerifier(construction, verifierIn);
  const reference = structuredClone(referenceIn), expectedVenue = requireReferenceVenue(reference, venue);
  const selection = ownSelection(selected);
  requireReplay(same(selection.venue, expectedVenue), "VENUE_REFERENCE");
  requireReplay(same(selection.domain, domain), "CONFIGURATION");
  return { construction, domain, verifier, reference, selection };
}

function openPackage(batch: EvidenceBatch, owned: ReturnType<typeof ownPackageRead>, options: ReadOptions) {
  const { construction, domain, verifier, reference, selection } = owned, { venue } = options, frames = construction.reader;
  readKinds(batch);
  const payloads = (kind: number): Uint8Array[] => batch.payloads(kind);
  // Directories, snapshots and trails may be retained from earlier packages; each lookup below needs its own.
  if ([1, 2].some(kind => batch.count(kind) === 0)) throw new EvidenceRefusal("unresolved-evidence");
  requireReplay(frames.verifyConfiguration(payloads(1)[0]!), "CONFIGURATION");
  const commitment = decodeCommitment(payloads(2)[0]!);
  if (!verifyCommitment(commitment)) throw new EvidenceRefusal("unresolved-evidence");
  if (!same(commitment.operator, selection.operator) || commitment.sequence !== selection.sequence || !same(commitment.root, selection.root)) {
    throw new EvidenceRefusal("selection-mismatch");
  }
  const directory = batch.directory(commitment.root);
  if (directory?.some(value => same(value.name, selection.backing)) !== true) throw new EvidenceRefusal("unresolved-evidence");
  // The scope is the one the directory's first snapshot names, as the checkpoint's judgment reads it (pool-v3 §7.1,
  // C2.10.11), so a selected backing whose own snapshot names another segment reads the class every backing reads.
  // A preimage that does not decode is no snapshot (§7): unresolved, never a verdict.
  const first = directory[0]!, snapshotBytes = batch.snapshot(first.digest);
  if (snapshotBytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
  let snapshot: Snapshot;
  try { snapshot = frames.snapshot.decode(snapshotBytes); } catch (error) {
    if (error instanceof EncodingError) throw new EvidenceRefusal("unresolved-evidence");
    throw error;
  }
  const scope = checkpointScope(construction, batch, first.name, first.digest, snapshot), { header } = scope;
  scope.fullTrail();
  requireReplay(same(header.domain, domain) && same(header.venue, selection.venue) && same(header.operator, selection.operator) &&
    header.sequence <= selection.sequence, "CONTEXT");
  // A directory entry the scope does not name gives no terms to read the selected backing under.
  const scoped = header.entries.findIndex(item => same(item.backing, selection.backing));
  if (scoped < 0) throw new EvidenceRefusal("unresolved-evidence");
  const terms = scope.rootTerms[scoped]!;
  requireReplay(same(terms.configuration, domain) && same(terms.venue, header.venue), "TERMS_CONTEXT");
  const faults = faultObserver(payloads(7), selection, verifier, construction);
  const context: ImportContext = { construction, store: options.store ?? new ReplayStore(), witness: options.witness, carrying: options.carrying, selection, terms, header, verifier, reference, faults,
    ...(batch.count(10) === 0 ? {} : { receiptBytes: payloads(10)[0]! }) };
  return { context, faults, venue };
}

/** Descend every witnessed term for independently authenticated root terms,
 * through ancestry scoping one backing or several (C2.10.3–7). An empty result
 * is proved by the complete venue descent, never by missing package objects.
 * Selection and receipt metadata supply no frontier authority. */
export async function readFrontier<R = Record>(source: PackageSource, signed: SignedTerms, judgingIndex: bigint,
  options: FrontierReadOptions): Promise<FrontierResult<R> & FaultResult> {
  return withFacts(async attach => {
    const owned = ownFrontierRead(signed, judgingIndex, options);
    return withEvidence(source, options, owned.construction, batch => keptOrAgain(options, async () => {
      const { context, faults, venue } = openFrontier(batch, owned, judgingIndex, options);
      try {
        const result = await classifyScopeFrontier<R>(context, venue, batch);
        return { ...result, ...faults.result() };
      } catch (error) { throw attach(error, faults, {}); }
    }));
  });
}

/** The reader's own inputs and the authenticated terms, checked before the package is read. The terms decode under
 * the construction read, whose clause they must name (pool-v3 §11.2, lit-v1 §9). */
function ownFrontierRead(signed: SignedTerms, judgingIndex: bigint, options: ReadOptions) {
  const { verifier: verifierIn, reference: referenceIn } = options;
  const construction = options.construction ?? POOL_V3 as Construction, frames = construction.reader, domain = frames.domain();
  const verifier = ownVerifier(construction, verifierIn);
  const reference = structuredClone(referenceIn);
  if (!isValue(judgingIndex)) throw new EncodingError("invalid judging index");
  const termsBytes = copyUnshared(signed.terms), signature = copyUnshared(signed.signature);
  requireReplay(frames.terms.verifyRootTermsSignature(termsBytes, signature), "TERMS_SIGNATURE");
  const terms = frames.terms.decodeRootTerms(termsBytes), backing = frames.terms.rootTermsName(termsBytes);
  requireReplay(same(terms.configuration, domain), "CONFIGURATION");
  return { construction, domain, verifier, reference, terms, backing };
}

function openFrontier(batch: EvidenceBatch, owned: ReturnType<typeof ownFrontierRead>, judgingIndex: bigint, options: FrontierReadOptions) {
  const { construction, domain, verifier, reference, terms, backing } = owned, { venue } = options;
  readKinds(batch);
  const payloads = (kind: number): Uint8Array[] => batch.payloads(kind);
  if (batch.count(1) !== 0) requireReplay(construction.reader.verifyConfiguration(payloads(1)[0]!), "CONFIGURATION");
  // Invoke the external adapter only after every caller-owned input is copied.
  const venueId = requireReferenceVenue(reference, venue);
  requireReplay(same(terms.venue, venueId), "VENUE_REFERENCE");
  const selection = { mode: "historical-fixture" as const, domain, venue: venueId, backing, judgingIndex };
  const faults = faultObserver(payloads(7), selection, verifier, construction);
  const context: FrontierContext = { construction, store: options.store ?? new ReplayStore(), witness: options.witness, carrying: options.carrying, selection, terms, verifier, reference, faults,
    answers: options.answers === true };
  return { context, faults, venue };
}
