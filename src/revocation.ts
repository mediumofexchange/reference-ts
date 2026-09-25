// §C2b's first failure branch: the backer's key is stolen.
//
// "If a backer's key is stolen, the damage is unbounded and permanent, since K
// alone authorises issuance and nothing expires. So K may publish a revocation:
// witnessed, and prospective, so existing claims keep their terms and no further
// issuance is valid."
//
// **A stop-loss, not a remedy.** A thief issues fast and a backer notices
// slowly, so by the time a revocation is witnessed the fraudulent supply is
// already committed and stands — "the damage is unbounded and permanent", and "a
// thief's purpose is to issue, so it revokes only on the way out". What actually
// prevents the loss is a threshold K, which §C2b calls "the strongest argument"
// for one, and which is invisible here: t-of-n aggregated to a single Ed25519
// key leaves the name, E and strict verification untouched. That is the same
// shape as docs/PROTOCOL_RULES.md's one-writer rule for the operator, one role along.
//
// **It revokes a KEY, not a backing**, which makes it the one venue record that
// does not name a backing. §C2b: "published by K to every venue its backings
// name" — one K obligates many backings, and revoking it revokes all of them at
// once. Slice 15's rule that every record names its own backing was written for
// records about a backing; this is a record about a key, so it names the key.
//
// **And it carries nothing else.** No sequence, because "revocation is the one
// act no later signature can repair" and there is no second one to order. No
// venue, because the paper wants it relayed everywhere and a copy at another
// venue is a copy anyone may make. No expiry, because "de-revocation would carry
// the same K". Two revocations by one key are byte-identical, which is what
// makes republishing harmless.

import type { Backing } from "./backing.js";
import { venueIsDeclared, type Venue } from "./venue.js";
import type { Revocation } from "./venue-records.js";

// The record and its signature check are construction-neutral
// (`venue-records.ts`); this module reads them on a transparent venue view.
export {
  copyRevocation, decodeRevocation, encodeRevocation, isSignedRevocation, revocationMessage, signRevocation, type Revocation,
} from "./venue-records.js";

/** A revocation together with the venue's word on when it witnessed it. */
export interface WitnessedRevocation {
  readonly revocation: Revocation;
  readonly at: bigint;
}

/**
 * The witnessed index this backing's obligor was revoked at, or undefined if it
 * was not — on this venue, which must be the one the backing declares.
 *
 * **Earliest wins**, where two replacements at one predecessor also take the
 * earliest (§C2, witnessing pins order) but for a different reason: there is no
 * choice being made here and no later act can repair it, so a second publication
 * is a copy of the first rather than a competing claim. Taking the latest would
 * let a thief holding K push its own boundary forward by republishing.
 *
 * **Read on the declared venue**, because §C2b makes a revocation "effective for
 * each backing at its witnessed index on that backing's declared venue" — the
 * same sentence the grades are read under, so the same guard. A backing that
 * declares no venue is answered by whichever record its reader holds, which is
 * the setting its backer chose.
 */
export function revokedAt(venue: Venue, backing: Backing): bigint | undefined {
  if (!venueIsDeclared(venue, backing)) return undefined;
  // **No catch here, and that is the whole point.** Undefined means NOT REVOKED,
  // so swallowing an exception turns a venue that declines to answer into a
  // clean bill of health for a stolen key — and a view that was never synced for
  // this obligor is exactly the case ErgoVenue guards against. Nothing here
  // reads adversary-supplied data: the backing is validated, and a venue's
  // records were checked when it took them. isSilent takes the same posture.
  let earliest: bigint | undefined;
  for (const witnessed of venue.revocationsFor(backing.obligor)) {
    if (earliest === undefined || witnessed.at < earliest) earliest = witnessed.at;
  }
  return earliest;
}
