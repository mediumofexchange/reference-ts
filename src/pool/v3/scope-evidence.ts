// Public scope authentication under pool-v3 §12.1. A partial trail can carry
// header/terms bytes but supplies no event verdict. Trails are the reader's own stored copies.
import { compareBytes } from "../../bytes.js";
import { snapshotDigest, type Snapshot } from "./commitments.js";
import type { StoredTrail, TrailEvidence } from "./evidence-store.js";
import { decodeSegmentHeader, type SegmentHeader, type SegmentEntry } from "./headers.js";
import type { SignedTerms } from "./reader.js";
import { EvidenceRefusal } from "./refusals.js";
import { decodeRootTerms, rootTermsName, verifyRootTermsSignature, type RootTerms } from "./terms.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

/** Resolve by name from any strictly verifying scoped field. Invalid fields
 * are ignored, never conflicting authority. */
export function resolveTerms(trails: TrailEvidence, segment: Uint8Array,
  entry: Pick<SegmentEntry, "backing">, index: number): SignedTerms | undefined {
  for (const trail of trails.heads(segment)) {
    const signed = trail.terms[index];
    if (signed !== undefined && verifyRootTermsSignature(signed.terms, signed.signature) &&
        same(rootTermsName(signed.terms), entry.backing)) return signed;
  }
  return undefined;
}

export interface AuthenticatedScope {
  readonly header: SegmentHeader;
  readonly terms: readonly SignedTerms[];
  readonly rootTerms: readonly RootTerms[];
}

export function authenticatedScope(trails: TrailEvidence, segment: Uint8Array): AuthenticatedScope {
  const carrier = trails.heads(segment)[0];
  if (carrier === undefined) throw new EvidenceRefusal("unresolved-evidence");
  const header = decodeSegmentHeader(carrier.header);
  const terms = header.entries.map((entry, i) => {
    const signed = resolveTerms(trails, segment, entry, i);
    if (signed === undefined) throw new EvidenceRefusal("unresolved-evidence");
    return signed;
  });
  return { header, terms, rootTerms: terms.map(signed => decodeRootTerms(signed.terms)) };
}

export interface CheckpointScope extends AuthenticatedScope {
  fullTrail(): StoredTrail;
  classificationEvidence(intrinsic?: string): { trail: StoredTrail; intrinsic?: undefined } | { intrinsic: string; trail?: undefined };
}

export function checkpointScope(trails: TrailEvidence, backing: Uint8Array,
  digest: Uint8Array, snapshot: Snapshot): CheckpointScope {
  if (!same(snapshot.backing, backing) || !same(snapshotDigest(snapshot), digest)) throw new EvidenceRefusal("unresolved-evidence");
  const scope = authenticatedScope(trails, snapshot.segment);
  if (!scope.header.entries.some(entry => same(entry.backing, backing))) throw new EvidenceRefusal("unresolved-evidence");
  let full: StoredTrail | undefined;
  const fullTrail = (): StoredTrail => {
    full ??= trails.served({ backing, segment: snapshot.segment, digest }, snapshot);
    if (full === undefined) throw new EvidenceRefusal("unresolved-evidence");
    return full;
  };
  return { ...scope, fullTrail, classificationEvidence(intrinsic) {
    try { return { trail: fullTrail() }; }
    catch (error) {
      if (!(error instanceof EvidenceRefusal) || error.status !== "unresolved-evidence" || intrinsic === undefined) throw error;
      return { intrinsic };
    }
  } };
}
