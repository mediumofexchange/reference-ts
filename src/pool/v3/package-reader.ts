// Candidate §12 evidence and §13 record readers for any scope. Configuration,
// verifier, selection and reference venue are independently held by the reader.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes, copyUnshared, EncodingError } from "../../bytes.js";
import type { RecordVenue } from "../../record-venue.js";
import { decodeCommitment, directoryRoot, verifyCommitment } from "../../venue-records.js";
import { isValue } from "../field.js";
import { decodeSnapshot } from "./commitments.js";
import { configurationBytes, configurationHash, decodeConfiguration, type CandidateConfiguration } from "./configuration.js";
import { faultObserver, type FaultResult } from "./fault-observer.js";
import { requireReferenceVenue, type VenueReference } from "./guard.js";
import { decodeEvidenceDirectory, decodeEvidencePackage, type PackageLimits } from "./package.js";
import { decodedTrails, type ReaderSelection, type SignedTerms } from "./reader.js";
import { EvidenceRefusal, requireReplay } from "./refusals.js";
import { checkpointScope } from "./scope-evidence.js";
import { classifyScopeFrontier, classifyScopes, importLimitsOf, type FrontierContext, type FrontierResult, type ImportContext,
  type ImportLimits, type ScopeResult } from "./scope-reader.js";
import { ReplayStore } from "./replay-store.js";
import type { ProofCheck, ScanOutput } from "./state.js";
import { decodeRootTerms, rootTermsName, verifyRootTermsSignature } from "./terms.js";

export const PACKAGE_LIMITS: PackageLimits = Object.freeze({ maxBytes: 1_048_576n, maxItems: 1024n });
const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
export interface PackageReader {
  readonly configuration: CandidateConfiguration;
  readonly verifier: ProofCheck;
  readonly venue: RecordVenue;
  readonly reference: VenueReference;
  readonly importLimits?: ImportLimits;
  /** The party's replay storage; a private in-memory store by default, kept alive by the result. */
  readonly store?: ReplayStore | undefined;
  /** Outputs to keep incremental witnesses for (a wallet's own), so their paths can be read from the result. */
  readonly witness?: ((output: ScanOutput) => boolean) | undefined;
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

/** Returns a complete reference verdict/state or throws a named evidence/replay
 * refusal. Never returns a partial state or treats unavailable ancestry as empty.
 * The internal state is newly replayed per call; no asserted state is an input.
 * Compact faults replace only dependency-resolved non-opening target trails;
 * the selected envelope remains complete. The selection's scope and every
 * scope in its ancestry may name one backing or several (C2.10.3–7). */
export async function readPackage(bytes: Uint8Array, selected: ReaderSelection, options: PackageReader): Promise<ScopeResult & FaultResult> {
  const { context, directories, evidence, faults, venue } = openPackage(bytes, selected, options);
  const result = await classifyScopes(context, directories, venue, evidence);
  return { ...result, ...faults.result() };
}

function openPackage(bytes: Uint8Array, selected: ReaderSelection, options: PackageReader) {
  const { configuration: configurationIn, verifier: verifierIn, venue, reference: referenceIn, importLimits: limitsIn } = options;
  const configuration = decodeConfiguration(configurationBytes(configurationIn)), domain = configurationHash(configuration);
  const verify = verifierIn.verify;
  if (typeof verify !== "function") throw new TypeError("a proof verifier is required");
  const verifier: ProofCheck = { verify: verify.bind(verifierIn) };
  const reference = structuredClone(referenceIn), expectedVenue = requireReferenceVenue(reference, venue);
  const selection = ownSelection(selected);
  requireReplay(same(selection.venue, expectedVenue), "VENUE_REFERENCE");
  requireReplay(same(selection.domain, domain), "CONFIGURATION");
  const importLimits = importLimitsOf(limitsIn);
  const items = decodeEvidencePackage(bytes, PACKAGE_LIMITS);
  if (items.some(item => ![1, 2, 3, 4, 6, 7, 10].includes(item.kind)) ||
      [1, 2, 10].some(kind => items.filter(item => item.kind === kind).length > 1)) throw new EvidenceRefusal("unsupported-scope");
  const payloads = (kind: number): Uint8Array[] => items.filter(item => item.kind === kind).map(item => item.payload);
  if ([1, 2, 3, 4, 6].some(kind => payloads(kind).length === 0)) throw new EvidenceRefusal("unresolved-evidence");
  requireReplay(same(payloads(1)[0]!, configurationBytes(configuration)), "CONFIGURATION");
  const commitment = decodeCommitment(payloads(2)[0]!);
  if (!verifyCommitment(commitment)) throw new EvidenceRefusal("unresolved-evidence");
  if (!same(commitment.operator, selection.operator) || commitment.sequence !== selection.sequence || !same(commitment.root, selection.root)) {
    throw new EvidenceRefusal("selection-mismatch");
  }
  const directories = new Map(payloads(3).map(payload => {
    const entries = decodeEvidenceDirectory(payload, PACKAGE_LIMITS);
    return [hex(directoryRoot(entries)), entries] as const;
  }));
  const entry = directories.get(hex(commitment.root))?.find(value => same(value.name, selection.backing));
  if (entry === undefined) throw new EvidenceRefusal("unresolved-evidence");
  const snapshots = payloads(4), trails = payloads(6);
  const snapshotBytes = snapshots.find(payload => same(sha256(payload), entry.digest));
  if (snapshotBytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
  const snapshot = decodeSnapshot(snapshotBytes), scope = checkpointScope(decodedTrails(trails), selection.backing, entry.digest, snapshot);
  const { header } = scope;
  scope.fullTrail();
  requireReplay(same(header.domain, domain) && same(header.venue, selection.venue) && same(header.operator, selection.operator) &&
    header.sequence <= selection.sequence, "CONTEXT");
  const terms = scope.rootTerms[header.entries.findIndex(scoped => same(scoped.backing, selection.backing))]!;
  requireReplay(same(terms.configuration, domain) && same(terms.venue, header.venue), "TERMS_CONTEXT");
  const faults = faultObserver(payloads(7), selection, verifier);
  const context: ImportContext = { store: options.store ?? new ReplayStore(), witness: options.witness, selection, terms, header, verifier, reference, importLimits, faults,
    ...(payloads(10).length === 0 ? {} : { receiptBytes: payloads(10)[0]! }) };
  return { context, directories, evidence: { snapshots, trails }, faults, venue };
}

/** Descend every witnessed term for independently authenticated root terms,
 * through ancestry scoping one backing or several (C2.10.3–7). An empty result
 * is proved by the complete venue descent, never by missing package objects.
 * Selection and receipt metadata supply no frontier authority. */
export async function readFrontier(bytes: Uint8Array, signed: SignedTerms, judgingIndex: bigint,
  options: PackageReader): Promise<FrontierResult & FaultResult> {
  const { context, directories, evidence, faults, venue } = openFrontier(bytes, signed, judgingIndex, options);
  const result = await classifyScopeFrontier(context, directories, venue, evidence);
  return { ...result, ...faults.result() };
}

function openFrontier(bytes: Uint8Array, signed: SignedTerms, judgingIndex: bigint, options: PackageReader) {
  const { configuration: configurationIn, verifier: verifierIn, venue, reference: referenceIn, importLimits: limitsIn } = options;
  const configuration = decodeConfiguration(configurationBytes(configurationIn)), domain = configurationHash(configuration);
  const verify = verifierIn.verify;
  if (typeof verify !== "function") throw new TypeError("a proof verifier is required");
  const verifier: ProofCheck = { verify: verify.bind(verifierIn) };
  const reference = structuredClone(referenceIn);
  if (!isValue(judgingIndex)) throw new EncodingError("invalid judging index");
  const termsBytes = copyUnshared(signed.terms), signature = copyUnshared(signed.signature);
  requireReplay(verifyRootTermsSignature(termsBytes, signature), "TERMS_SIGNATURE");
  const terms = decodeRootTerms(termsBytes), backing = rootTermsName(termsBytes);
  requireReplay(same(terms.configuration, domain), "CONFIGURATION");
  const importLimits = importLimitsOf(limitsIn);
  const items = decodeEvidencePackage(bytes, PACKAGE_LIMITS);
  if (items.some(item => ![1, 2, 3, 4, 6, 7, 10].includes(item.kind)) ||
      [1, 2, 10].some(kind => items.filter(item => item.kind === kind).length > 1)) throw new EvidenceRefusal("unsupported-scope");
  const payloads = (kind: number): Uint8Array[] => items.filter(item => item.kind === kind).map(item => item.payload);
  if (payloads(1).length !== 0) requireReplay(same(payloads(1)[0]!, configurationBytes(configuration)), "CONFIGURATION");
  const directories = new Map(payloads(3).map(payload => {
    const entries = decodeEvidenceDirectory(payload, PACKAGE_LIMITS);
    return [hex(directoryRoot(entries)), entries] as const;
  }));
  // Invoke the external adapter only after every caller-owned input is copied.
  const venueId = requireReferenceVenue(reference, venue);
  requireReplay(same(terms.venue, venueId), "VENUE_REFERENCE");
  const selection = { mode: "historical-fixture" as const, domain, venue: venueId, backing, judgingIndex };
  const faults = faultObserver(payloads(7), selection, verifier);
  const context: FrontierContext = { store: options.store ?? new ReplayStore(), witness: options.witness, selection, terms, verifier, reference, importLimits, faults };
  return { context, directories, evidence: { snapshots: payloads(4), trails: payloads(6) }, faults, venue };
}
