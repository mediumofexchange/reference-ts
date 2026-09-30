// Public scope authentication under pool-v3 §12.1. A partial trail can carry
// header/terms bytes but supplies no event verdict. Trails are the reader's own stored copies.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes } from "../../bytes.js";
import { snapshotDigest, type Snapshot } from "./commitments.js";
import type { StoredTrail, TrailEvidence } from "./evidence-store.js";
import { decodeSegmentHeader, type SegmentHeader, type SegmentEntry } from "./headers.js";
import type { SignedTerms } from "./reader.js";
import { EvidenceRefusal } from "./refusals.js";
import { decodeRootTerms, verifyRootTermsSignature, type RootTerms } from "./terms.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

/** Resolve by name from any strictly verifying scoped field. Invalid fields
 * are ignored, never conflicting authority. The name is a hash of the field's
 * bytes, compared before the signature is verified. */
export function resolveTerms(trails: TrailEvidence, segment: Uint8Array,
  entry: Pick<SegmentEntry, "backing">, index: number): SignedTerms | undefined {
  for (const trail of trails.heads(segment)) {
    const signed = trail.term(index);
    if (signed !== undefined && same(sha256(signed.terms), entry.backing) &&
        verifyRootTermsSignature(signed.terms, signed.signature)) return signed;
  }
  return undefined;
}

export interface AuthenticatedScope {
  readonly header: SegmentHeader;
  readonly terms: readonly SignedTerms[];
  readonly rootTerms: readonly RootTerms[];
}

/** Scopes authenticated per batch of trails, which do not change once imported. A read judges each
 * checkpoint of a segment against the same scope, so the last few segments' are kept, not re-verified. */
const SCOPES = 4;
const authenticated = new WeakMap<TrailEvidence, Map<string, AuthenticatedScope>>();

export function authenticatedScope(trails: TrailEvidence, segment: Uint8Array): AuthenticatedScope {
  const key = hex(segment);
  let kept = authenticated.get(trails);
  if (kept === undefined) { kept = new Map(); authenticated.set(trails, kept); }
  const found = kept.get(key);
  if (found !== undefined) { kept.delete(key); kept.set(key, found); return found; }
  const [carrier] = trails.heads(segment);
  if (carrier === undefined) throw new EvidenceRefusal("unresolved-evidence");
  const header = decodeSegmentHeader(carrier.header);
  const terms = header.entries.map((entry, i) => {
    const signed = resolveTerms(trails, segment, entry, i);
    if (signed === undefined) throw new EvidenceRefusal("unresolved-evidence");
    return signed;
  });
  const scope = Object.freeze({ header, terms: Object.freeze(terms), rootTerms: Object.freeze(terms.map(signed => decodeRootTerms(signed.terms))) });
  kept.set(key, scope);
  if (kept.size > SCOPES) kept.delete(kept.keys().next().value!);
  return scope;
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
