// The candidate guard (v3 runtime plan, decision 5): pool-v3 is unadopted, so
// its entry points run only on a reference venue. A 32-byte venue identity
// cannot be classified by looking at it, so the caller holds the identity's
// preimage, the guard recomputes the identity under one of the closed set of
// reference contexts, and the venue must present exactly that identity and
// its lag. venue-ergo's own context (the mainnet) and every other identity
// are refused. The candidate configuration itself comes from the caller's
// manifest check (pool-v3 §11.1) and is reported as candidate provenance.
// The guard stops misuse, not a hostile caller: an adapter that presents a
// reference identity while delegating elsewhere is outside what bytes can check.
import { compareBytes, copyBytes } from "../../bytes.js";
import { ergoLag, ergoProfileIdentity, ERGO_SYNTHETIC_REFERENCE, ERGO_TESTNET_REFERENCE, ownErgoProfile, type ErgoProfile } from "../../ergo-profile.js";
import { LOCAL_REFERENCE, localVenueIdentity, type RecordVenue } from "../../record-venue.js";

/** A reference venue's identity preimage, as the caller independently holds it. */
export type VenueReference =
  | { readonly context: typeof LOCAL_REFERENCE; readonly label: Uint8Array; readonly lag: bigint }
  | { readonly context: typeof ERGO_SYNTHETIC_REFERENCE | typeof ERGO_TESTNET_REFERENCE; readonly profile: ErgoProfile };

/** Reference contexts, with independently selected anchors for real testnet readers. */
export const CANDIDATE_CONTEXTS = Object.freeze([LOCAL_REFERENCE, ERGO_SYNTHETIC_REFERENCE, ERGO_TESTNET_REFERENCE] as const);

/** A venue the candidate may not run on, or a preimage outside the closed set. */
export class CandidateVenueError extends Error {
  constructor(message: string) { super(message); this.name = "CandidateVenueError"; }
}

/** The identity and lag `reference` names, recomputed; outside the closed set it refuses. */
export function referenceVenue(reference: VenueReference): { readonly id: Uint8Array; readonly lag: bigint } {
  if (reference === null || typeof reference !== "object") throw new CandidateVenueError("no reference venue preimage");
  const { context } = reference;
  try {
    if (context === LOCAL_REFERENCE) {
      const { label, lag } = reference;
      return { id: localVenueIdentity(label, lag), lag };
    }
    if (context === ERGO_SYNTHETIC_REFERENCE || context === ERGO_TESTNET_REFERENCE) {
      // Read once and owned, so the context checked is the context hashed.
      const profile = ownErgoProfile(reference.profile);
      // The preimage must select this same reference context; absence names the mainnet profile.
      if (profile.reference !== context) throw new CandidateVenueError("the candidate requires the selected reference profile");
      return { id: ergoProfileIdentity(profile), lag: ergoLag(profile) };
    }
  } catch (error) {
    if (error instanceof CandidateVenueError) throw error;
    throw new CandidateVenueError("invalid reference venue preimage");
  }
  throw new CandidateVenueError("not a candidate reference context");
}

/** The guard at a v3 entry point: `venue` must present the identity and lag recomputed from `reference`. Returns the identity. */
export function requireReferenceVenue(reference: VenueReference, venue: Pick<RecordVenue, "id" | "lag">): Uint8Array {
  const expected = referenceVenue(reference);
  const id: unknown = venue.id, lag: unknown = venue.lag();
  if (!(id instanceof Uint8Array) || compareBytes(id, expected.id) !== 0 || lag !== expected.lag) {
    throw new CandidateVenueError("the venue is not the reference venue its preimage names");
  }
  return copyBytes(expected.id);
}
