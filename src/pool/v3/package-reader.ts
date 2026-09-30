// Candidate §12 evidence and §13 record readers for any scope. Configuration,
// verifier, selection and reference venue are independently held by the reader.
// A package is copied into the reader's own evidence storage before any pass
// reads it (pool-v3 §14), from memory or streamed.
import { compareBytes, copyBytes, copyUnshared, EncodingError } from "../../bytes.js";
import type { RecordVenue } from "../../record-venue.js";
import { decodeCommitment, verifyCommitment } from "../../venue-records.js";
import { isValue } from "../field.js";
import { decodeSnapshot } from "./commitments.js";
import { configurationBytes, configurationHash, decodeConfiguration, requireConfigurationVerifier, type CandidateConfiguration } from "./configuration.js";
import { faultObserver, type FaultResult } from "./fault-observer.js";
import { requireReferenceVenue, type VenueReference } from "./guard.js";
import { EvidenceStore, type EvidenceBatch } from "./evidence-store.js";
import type { ReaderSelection, SignedTerms } from "./reader.js";
import { EvidenceRefusal, requireReplay } from "./refusals.js";
import { checkpointScope } from "./scope-evidence.js";
import { classifyScopeFrontier, classifyScopes, type FrontierContext, type FrontierResult, type ImportContext,
  type ScopeResult } from "./scope-reader.js";
import { KeptStateMismatch, ReplayStore } from "./replay-store.js";
import type { ProofCheck, WitnessPredicate } from "./state.js";
import { decodeRootTerms, rootTermsName, verifyRootTermsSignature } from "./terms.js";

/** A §12 package as a reader receives it: bytes in memory or a stream of chunks. */
export type PackageSource = Uint8Array | AsyncIterable<Uint8Array>;
const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
export interface PackageReader {
  readonly configuration: CandidateConfiguration;
  readonly verifier: ProofCheck;
  readonly venue: RecordVenue;
  readonly reference: VenueReference;
  /** The party's replay storage; a private in-memory store by default, kept alive by the result. */
  readonly store?: ReplayStore | undefined;
  /** The party's evidence storage the package is copied into before any pass; a private in-memory store by
   * default, closed when the read ends. A party's file keeps memory flat and retains the evidence across reads,
   * so a later package need carry only new objects and trails can be assembled (§14 incremental retrieval). */
  readonly evidence?: EvidenceStore | undefined;
  /** Outputs to keep incremental witnesses for (a wallet's own), so their paths can be read from the result. */
  readonly witness?: WitnessPredicate | undefined;
}

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
 * configuration's (§11.1) and name it in kept state (§14). */
function ownVerifier(configuration: CandidateConfiguration, verifierIn: ProofCheck, verify: ProofCheck["verify"]): ProofCheck {
  const declared = verifierIn.identities;
  if (declared === undefined) return { verify: verify.bind(verifierIn) };
  if (declared === null || typeof declared !== "object") throw new TypeError("invalid verifier identities");
  const identities: { [name: string]: { readonly bytecode: Uint8Array; readonly vk: Uint8Array } } = {};
  for (const name of Object.keys(declared)) {
    const entry = declared[name];
    if (entry === null || typeof entry !== "object") throw new TypeError("invalid verifier identities");
    const bytecode = copyBytes(entry.bytecode), vk = copyBytes(entry.vk);
    if (bytecode.length !== 32 || vk.length !== 32) throw new TypeError("invalid verifier identities");
    identities[name] = Object.freeze({ bytecode, vk });
  }
  requireConfigurationVerifier(configuration, identities);
  return { verify: verify.bind(verifierIn), identities: Object.freeze(identities) };
}

/** Copy the package into the reader's evidence storage, then read only the copy and what the store retains.
 * Bytes are copied before the first await; a stream is copied chunk by chunk. The package's own items go
 * when the read ends. */
async function withEvidence<T>(source: PackageSource, options: PackageReader, read: (batch: EvidenceBatch) => Promise<T>): Promise<T> {
  const own = options.evidence === undefined, store = options.evidence ?? new EvidenceStore();
  let batch: EvidenceBatch | undefined;
  try {
    const streamed = source !== null && typeof source === "object" &&
      typeof (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function";
    batch = streamed ? await store.importStream(source as AsyncIterable<Uint8Array>) : store.importBytes(source as Uint8Array);
    return await read(batch);
  } finally { if (own) store.close(); else batch?.release(); }
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
export async function readPackage(source: PackageSource, selected: ReaderSelection, options: PackageReader): Promise<ScopeResult & FaultResult> {
  const owned = ownPackageRead(selected, options);
  return withEvidence(source, options, batch => keptOrAgain(options, async () => {
    const { context, faults, venue } = openPackage(batch, owned, options);
    const result = await classifyScopes(context, venue, batch);
    return { ...result, ...faults.result() };
  }));
}

/** §14: kept state that fails a check before reuse is discarded, and the read classifies again from the evidence.
 * A second mismatch, with nothing kept, is a programming failure and stays visible. (Retained evidence that
 * fails its check reads as absent or leaves the read unresolved; see evidence-store.ts.) */
async function keptOrAgain<T>(options: PackageReader, read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) {
    if (!(error instanceof KeptStateMismatch) || options.store === undefined) throw error;
    options.store.discardKept();
    return read();
  }
}

/** The reader's own inputs, checked before the package is read. */
function ownPackageRead(selected: ReaderSelection, options: PackageReader) {
  const { configuration: configurationIn, verifier: verifierIn, venue, reference: referenceIn } = options;
  const configuration = decodeConfiguration(configurationBytes(configurationIn)), domain = configurationHash(configuration);
  const verify = verifierIn.verify;
  if (typeof verify !== "function") throw new TypeError("a proof verifier is required");
  const verifier = ownVerifier(configuration, verifierIn, verify);
  const reference = structuredClone(referenceIn), expectedVenue = requireReferenceVenue(reference, venue);
  const selection = ownSelection(selected);
  requireReplay(same(selection.venue, expectedVenue), "VENUE_REFERENCE");
  requireReplay(same(selection.domain, domain), "CONFIGURATION");
  return { configuration, domain, verifier, reference, selection };
}

function openPackage(batch: EvidenceBatch, owned: ReturnType<typeof ownPackageRead>, options: PackageReader) {
  const { configuration, domain, verifier, reference, selection } = owned, { venue } = options;
  readKinds(batch);
  const payloads = (kind: number): Uint8Array[] => batch.payloads(kind);
  // Directories, snapshots and trails may be retained from earlier packages; each lookup below needs its own.
  if ([1, 2].some(kind => batch.count(kind) === 0)) throw new EvidenceRefusal("unresolved-evidence");
  requireReplay(same(payloads(1)[0]!, configurationBytes(configuration)), "CONFIGURATION");
  const commitment = decodeCommitment(payloads(2)[0]!);
  if (!verifyCommitment(commitment)) throw new EvidenceRefusal("unresolved-evidence");
  if (!same(commitment.operator, selection.operator) || commitment.sequence !== selection.sequence || !same(commitment.root, selection.root)) {
    throw new EvidenceRefusal("selection-mismatch");
  }
  const entry = batch.directory(commitment.root)?.find(value => same(value.name, selection.backing));
  if (entry === undefined) throw new EvidenceRefusal("unresolved-evidence");
  const snapshotBytes = batch.snapshot(entry.digest);
  if (snapshotBytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
  const snapshot = decodeSnapshot(snapshotBytes), scope = checkpointScope(batch, selection.backing, entry.digest, snapshot);
  const { header } = scope;
  scope.fullTrail();
  requireReplay(same(header.domain, domain) && same(header.venue, selection.venue) && same(header.operator, selection.operator) &&
    header.sequence <= selection.sequence, "CONTEXT");
  const terms = scope.rootTerms[header.entries.findIndex(scoped => same(scoped.backing, selection.backing))]!;
  requireReplay(same(terms.configuration, domain) && same(terms.venue, header.venue), "TERMS_CONTEXT");
  const faults = faultObserver(payloads(7), selection, verifier);
  const context: ImportContext = { store: options.store ?? new ReplayStore(), witness: options.witness, selection, terms, header, verifier, reference, faults,
    ...(batch.count(10) === 0 ? {} : { receiptBytes: payloads(10)[0]! }) };
  return { context, faults, venue };
}

/** Descend every witnessed term for independently authenticated root terms,
 * through ancestry scoping one backing or several (C2.10.3–7). An empty result
 * is proved by the complete venue descent, never by missing package objects.
 * Selection and receipt metadata supply no frontier authority. */
export async function readFrontier(source: PackageSource, signed: SignedTerms, judgingIndex: bigint,
  options: PackageReader): Promise<FrontierResult & FaultResult> {
  const owned = ownFrontierRead(signed, judgingIndex, options);
  return withEvidence(source, options, batch => keptOrAgain(options, async () => {
    const { context, faults, venue } = openFrontier(batch, owned, judgingIndex, options);
    const result = await classifyScopeFrontier(context, venue, batch);
    return { ...result, ...faults.result() };
  }));
}

/** The reader's own inputs and the authenticated terms, checked before the package is read. */
function ownFrontierRead(signed: SignedTerms, judgingIndex: bigint, options: PackageReader) {
  const { configuration: configurationIn, verifier: verifierIn, reference: referenceIn } = options;
  const configuration = decodeConfiguration(configurationBytes(configurationIn)), domain = configurationHash(configuration);
  const verify = verifierIn.verify;
  if (typeof verify !== "function") throw new TypeError("a proof verifier is required");
  const verifier = ownVerifier(configuration, verifierIn, verify);
  const reference = structuredClone(referenceIn);
  if (!isValue(judgingIndex)) throw new EncodingError("invalid judging index");
  const termsBytes = copyUnshared(signed.terms), signature = copyUnshared(signed.signature);
  requireReplay(verifyRootTermsSignature(termsBytes, signature), "TERMS_SIGNATURE");
  const terms = decodeRootTerms(termsBytes), backing = rootTermsName(termsBytes);
  requireReplay(same(terms.configuration, domain), "CONFIGURATION");
  return { configuration, domain, verifier, reference, terms, backing };
}

function openFrontier(batch: EvidenceBatch, owned: ReturnType<typeof ownFrontierRead>, judgingIndex: bigint, options: PackageReader) {
  const { configuration, domain, verifier, reference, terms, backing } = owned, { venue } = options;
  readKinds(batch);
  const payloads = (kind: number): Uint8Array[] => batch.payloads(kind);
  if (batch.count(1) !== 0) requireReplay(same(payloads(1)[0]!, configurationBytes(configuration)), "CONFIGURATION");
  // Invoke the external adapter only after every caller-owned input is copied.
  const venueId = requireReferenceVenue(reference, venue);
  requireReplay(same(terms.venue, venueId), "VENUE_REFERENCE");
  const selection = { mode: "historical-fixture" as const, domain, venue: venueId, backing, judgingIndex };
  const faults = faultObserver(payloads(7), selection, verifier);
  const context: FrontierContext = { store: options.store ?? new ReplayStore(), witness: options.witness, selection, terms, verifier, reference, faults };
  return { context, faults, venue };
}
