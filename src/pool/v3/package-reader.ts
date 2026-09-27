// Single-backing candidate §12 evidence and §13 record reader. Configuration,
// verifier, selection and reference venue are independently held by the reader.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes, copyUnshared, EncodingError } from "../../bytes.js";
import type { RecordVenue } from "../../record-venue.js";
import { decodeCommitment, directoryRoot, verifyCommitment } from "../../venue-records.js";
import { isValue } from "../field.js";
import { decodeSnapshot } from "./commitments.js";
import { configurationBytes, configurationHash, decodeConfiguration, type CandidateConfiguration } from "./configuration.js";
import { requireReferenceVenue, type VenueReference } from "./guard.js";
import { classifyFrontier, classifyImports, importLimitsOf, type FrontierResult, type ImportLimits, type ImportResult } from "./import-reader.js";
import { decodeEvidenceDirectory, decodeEvidencePackage, type PackageLimits } from "./package.js";
import { decodedTrails, type ReaderSelection, type SignedTerms } from "./reader.js";
import { EvidenceRefusal, requireReplay, ScopeRequired } from "./refusals.js";
import { checkpointScope } from "./scope-evidence.js";
import type { ProofCheck } from "./state.js";
import { decodeRootTerms, rootTermsName, verifyRootTermsSignature } from "./terms.js";

export const PACKAGE_LIMITS: PackageLimits = Object.freeze({ maxBytes: 1_048_576n, maxItems: 1024n });
const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
export interface PackageReader {
  readonly configuration: CandidateConfiguration;
  readonly verifier: ProofCheck;
  readonly venue: RecordVenue;
  readonly reference: VenueReference;
  readonly importLimits?: ImportLimits;
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
 * Compact fault packages and multi-backing orchestration remain harness-only. */
export async function readSingleBackingPackage(bytes: Uint8Array, selected: ReaderSelection, options: PackageReader): Promise<ImportResult> {
  const { configuration: configurationIn, verifier: verifierIn, venue, reference: referenceIn, importLimits: limitsIn } = options;
  const configuration = decodeConfiguration(configurationBytes(configurationIn)), domain = configurationHash(configuration);
  const verify = verifierIn.verify;
  if (typeof verify !== "function") throw new TypeError("a proof verifier is required");
  const verifier: ProofCheck = { verify: verify.bind(verifierIn) };
  const reference = structuredClone(referenceIn), expectedVenue = requireReferenceVenue(reference, venue);
  const selection = ownSelection(selected);
  requireReplay(same(selection.venue, expectedVenue), "VENUE_REFERENCE");
  requireReplay(same(selection.domain, domain), "CONFIGURATION");
  const importLimits = limitsIn === undefined ? { maxCheckpoints: 128n, maxEvents: 8192n } :
    { maxCheckpoints: limitsIn.maxCheckpoints, maxEvents: limitsIn.maxEvents };
  if (!isValue(importLimits.maxCheckpoints) || !isValue(importLimits.maxEvents)) throw new TypeError("invalid import limits");
  const items = decodeEvidencePackage(bytes, PACKAGE_LIMITS);
  if (items.some(item => ![1, 2, 3, 4, 6, 10].includes(item.kind)) ||
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
  if (header.entries.length !== 1) throw new ScopeRequired();
  scope.fullTrail();
  requireReplay(same(header.domain, domain) && same(header.venue, selection.venue) && same(header.operator, selection.operator) &&
    header.sequence <= selection.sequence, "CONTEXT");
  const terms = scope.rootTerms[0]!;
  requireReplay(same(terms.configuration, domain) && same(terms.venue, header.venue), "TERMS_CONTEXT");
  return classifyImports({ selection, terms, header, verifier, reference, importLimits,
    ...(payloads(10).length === 0 ? {} : { receiptBytes: payloads(10)[0]! }) }, directories, venue, { snapshots, trails });
}

/** Descend every witnessed term for independently authenticated root terms.
 * An empty result is proved by the complete venue descent, never by missing
 * package objects. Selection and receipt metadata supply no frontier authority. */
export async function readSingleBackingFrontier(bytes: Uint8Array, signed: SignedTerms, judgingIndex: bigint,
  options: PackageReader): Promise<FrontierResult> {
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
  if (items.some(item => ![1, 2, 3, 4, 6, 10].includes(item.kind)) ||
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
  return classifyFrontier({ selection: { mode: "historical-fixture", domain, venue: venueId, backing, judgingIndex },
    terms, verifier, reference, importLimits }, directories, venue, { snapshots: payloads(4), trails: payloads(6) });
}
