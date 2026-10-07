// The reference guard (v3 runtime plan, decision 5). pool-v3 is adopted
// (§11.4), but this implementation is not released: running it where claims
// carry real value needs the release gates of docs/PRODUCTION_REQUIREMENTS.md
// and separate authority. So its entry points run only on a reference venue.
// A 32-byte venue identity cannot be classified by looking at it, so the caller
// holds the identity's preimage, the guard recomputes the identity under one of
// the closed set of reference contexts, and the venue must present exactly that
// identity and its lag. venue-ergo's own context (the mainnet) and every other
// identity are refused. The guard stops misuse, not a hostile caller: an
// adapter that presents a reference identity while delegating elsewhere is
// outside what bytes can check.
import { compareBytes, copyBytes } from "../../bytes.js";
import { ergoLag, ergoProfileIdentity, ERGO_SYNTHETIC_REFERENCE, ERGO_TESTNET_REFERENCE, ownErgoProfile, type ErgoProfile } from "../../ergo-profile.js";
import { ergoRunCarries } from "../../ergo-publisher.js";
import { LOCAL_REFERENCE, localVenueIdentity, type RecordVenue } from "../../record-venue.js";
import { PROOF_BYTES } from "./configuration.js";
import { publicationBound } from "./records.js";

/** Pool-v3's longest publication: venue-ergo §8 requires a configuration's to fit one transaction at an Ergo venue's kind-4
 * location. Lit-v1's is 569 bytes (lit-v1 §10), so a location carrying this carries it; the guard checks this one for both. */
const LONGEST_PUBLICATION = publicationBound(PROOF_BYTES);

/** A reference venue's identity preimage, as the caller independently holds it. */
export type VenueReference =
  | { readonly context: typeof LOCAL_REFERENCE; readonly label: Uint8Array; readonly lag: bigint }
  | { readonly context: typeof ERGO_SYNTHETIC_REFERENCE | typeof ERGO_TESTNET_REFERENCE; readonly profile: ErgoProfile };

/** Reference contexts, with independently selected anchors for real testnet readers. */
export const REFERENCE_CONTEXTS = Object.freeze([LOCAL_REFERENCE, ERGO_SYNTHETIC_REFERENCE, ERGO_TESTNET_REFERENCE] as const);

/** A venue the reference may not run on, or a preimage outside the closed set. */
export class ReferenceVenueError extends Error {
  constructor(message: string) { super(message); this.name = "ReferenceVenueError"; }
}

/** The identity and lag `reference` names, recomputed; outside the closed set it refuses. */
export function referenceVenue(reference: VenueReference): { readonly id: Uint8Array; readonly lag: bigint } {
  if (reference === null || typeof reference !== "object") throw new ReferenceVenueError("no reference venue preimage");
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
      if (profile.reference !== context) throw new ReferenceVenueError("the guard requires the selected reference profile");
      // venue-ergo §8: a configuration is publishable on the venue only where its longest publication fits one
      // transaction at the kind-4 location.
      if (!ergoRunCarries(profile.scripts[4], LONGEST_PUBLICATION)) throw new ReferenceVenueError("the venue's kind-4 location cannot carry the configuration's longest publication in one transaction");
      return { id: ergoProfileIdentity(profile), lag: ergoLag(profile) };
    }
  } catch (error) {
    if (error instanceof ReferenceVenueError) throw error;
    throw new ReferenceVenueError("invalid reference venue preimage");
  }
  throw new ReferenceVenueError("not a reference context");
}

/** The guard at a v3 entry point: `venue` must present the identity and lag recomputed from `reference`. Returns the identity. */
export function requireReferenceVenue(reference: VenueReference, venue: Pick<RecordVenue, "id" | "lag">): Uint8Array {
  const expected = referenceVenue(reference);
  const id: unknown = venue.id, lag: unknown = venue.lag();
  if (!(id instanceof Uint8Array) || compareBytes(id, expected.id) !== 0 || lag !== expected.lag) {
    throw new ReferenceVenueError("the venue is not the reference venue its preimage names");
  }
  return copyBytes(expected.id);
}
