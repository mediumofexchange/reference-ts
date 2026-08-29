import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { signCommitment, stateRoot, type ServedState } from "../src/commitment.js";
import { isRewrittenHistory } from "../src/fault.js";
import { encodeIssuanceMessage } from "../src/messages.js";
import {
  decodeReplacement,
  encodeReplacement,
  isSignedReplacement,
  operatorAt,
  operatorsOf,
  replacementMessage,
  ROLE_OPERATOR,
  type Replacement,
} from "../src/replacement.js";
import { Sequencer } from "../src/sequencer.js";
import { LocalVenue } from "../src/venue.js";
import { KEYS, pub, SECRETS } from "./support.js";

// §C2's succession, after the force rule changed (2026-08-29).
//
// Two things, and the second is what the first makes possible:
//
//   - **A replacement is co-signed by its successor.** Naming somebody is not a
//     power over them. Signed by the rule-holder alone, one published record
//     made any commitment-publishing key the operator of record of any backing
//     — and its own next punctual commitment then manufactured a permanent
//     fault proof against it. The conscription test below is that attack, run.
//   - **Force is the effective index.** The second stage — force from the first
//     commitment "over a spent set it serves in full" — could not be checked
//     where force is read, because whether a commitment carries a backing is
//     unreadable from a root. What got built was force from ANY commitment, and
//     then one fact both conferred force and proved the fault. §C0a rule 2:
//     the qualification window was a fence around that stage, so it goes with it.
//
// Both signatures are over the SAME message, so there is one record, one domain
// tag, and no second object to keep in step. See DECISIONS.md.

const SILENCE = { noCommitmentDuration: 20n, challengeWindow: 5n };
const NON_SERVICE = { duration: 10n, count: 2n, window: 100n };
const HEIR_SECRET = new Uint8Array(32).fill(0x0b);
const HEIR = pub(HEIR_SECRET);
const OTHER_SECRET = new Uint8Array(32).fill(0x0c);
const OTHER = pub(OTHER_SECRET);

function backingFor(
  venue: LocalVenue,
  thing = "EUR",
  operator = KEYS.operator,
  obligor = KEYS.backer,
  replacementRule = KEYS.backer,
): Backing {
  return makeBacking({
    obligor,
    payout: { thing, quantumExponent: -2, perUnit: 100n },
    reliance: [],
    evidence: {
      setting: "transparent",
      operator,
      silence: SILENCE,
      witnessing: { venue: venue.id, interval: 5n },
      nonService: NON_SERVICE,
      replacementRule,
    },
  });
}

/**
 * A replacement co-signed by the rule-holder and the successor, over one message.
 * `consent` omitted means the successor did not sign — the conscription shape.
 */
function replacementBy(
  backing: Backing,
  successor: Uint8Array,
  effective: bigint,
  predecessor: Uint8Array = backing.name,
  ruleSecret: Uint8Array = SECRETS.backer,
  consent?: Uint8Array,
): Replacement {
  const unsigned = {
    role: ROLE_OPERATOR,
    successor,
    predecessor,
    effective,
    signature: new Uint8Array(64),
    successorSignature: new Uint8Array(64),
  };
  const message = replacementMessage(backing.name, unsigned);
  return {
    ...unsigned,
    signature: ed25519.sign(message, ruleSecret),
    ...(consent === undefined ? {} : { successorSignature: ed25519.sign(message, consent) }),
  };
}

function at(venue: LocalVenue, index: bigint): void {
  const now = venue.witnessedIndex();
  if (index > now) venue.advance(index - now);
}

/** A sequencer serving `backing`, with one issuance in its book, committed. */
function serving(
  venue: LocalVenue,
  backing: Backing,
  secret = SECRETS.operator,
  obligorSecret = SECRETS.backer,
) {
  const sequencer = new Sequencer(secret, venue);
  sequencer.register(backing, signBacking(obligorSecret, backing));
  sequencer.submitIssue(
    { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
    ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), obligorSecret),
  );
  const { commitment } = sequencer.commit();
  const state: ServedState = { snapshots: sequencer.snapshot(), commitment };
  return { sequencer, state };
}

describe("§C2: a replacement is co-signed by its successor", () => {
  it("is not a replacement at all without the successor's signature", () => {
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    expect(isSignedReplacement(eur, replacementBy(eur, HEIR, 10n))).toBe(false);
    expect(
      isSignedReplacement(eur, replacementBy(eur, HEIR, 10n, eur.name, SECRETS.backer, HEIR_SECRET)),
    ).toBe(true);
  });

  it("takes both signatures over one message, so there is one record and one tag", () => {
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const replacement = replacementBy(eur, HEIR, 10n, eur.name, SECRETS.backer, HEIR_SECRET);
    const message = replacementMessage(eur.name, replacement);
    expect(ed25519.verify(replacement.signature, message, KEYS.backer)).toBe(true);
    expect(ed25519.verify(replacement.successorSignature, message, HEIR)).toBe(true);
    // And it round-trips as one record.
    const decoded = decodeReplacement(encodeReplacement(eur.name, replacement));
    expect(decoded.replacement.successorSignature).toEqual(replacement.successorSignature);
    expect(decoded.replacement.signature).toEqual(replacement.signature);
  });

  it("refuses a successor's signature over a different successor's terms", () => {
    // The successor key is inside the signed message, so a consent obtained for
    // one handover cannot be lifted into another.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const forHeir = replacementBy(eur, HEIR, 10n, eur.name, SECRETS.backer, HEIR_SECRET);
    const forOther = replacementBy(eur, OTHER, 10n, eur.name, SECRETS.backer, OTHER_SECRET);
    const lifted: Replacement = { ...forOther, successorSignature: forHeir.successorSignature };
    expect(isSignedReplacement(eur, lifted)).toBe(false);
  });

  it("closes conscription: a stranger cannot be seated by anyone else's publication", () => {
    // The whole attack, run. Anyone creates a backing naming the victim as
    // operator AND as rule-holder, issues, commits, then publishes one
    // replacement naming a real shared operator. Before this rule the victim's
    // next ordinary punctual commitment seated it and manufactured a permanent
    // fault proof against it, for a backing it had never heard of.
    const venue = new LocalVenue();
    // The attacker's own backing, top to bottom: it obligates it, it operates
    // it, and it holds the replacement rule. Nothing here is the victim's.
    const junk = backingFor(venue, "JUNK", OTHER, OTHER, OTHER);
    const attacker = serving(venue, junk, OTHER_SECRET, OTHER_SECRET);

    at(venue, 10n);
    // The attacker holds the rule key, so the rule-holder's half is free. What
    // it cannot produce is the victim's own signature.
    venue.publishReplacement(
      junk.name,
      replacementBy(junk, KEYS.operator, 10n, junk.name, OTHER_SECRET),
    );

    // The victim publishes an ordinary commitment of its own, for its own book.
    at(venue, 11n);
    const victim = signCommitment(SECRETS.operator, venue.nextSequenceFor(KEYS.operator), stateRoot([]));
    venue.publish(victim);

    expect(operatorAt(junk, venue, venue.witnessedIndex())).toEqual(OTHER);
    expect(operatorsOf(junk, venue)).toHaveLength(1);
    expect(
      isRewrittenHistory(junk, venue, attacker.state, { snapshots: [], commitment: victim }),
    ).toBe(false);
  });
});

describe("§C2: force is the effective index", () => {
  it("arrives there, with no commitment by the successor at all", () => {
    // The retired rule needed the successor to publish a commitment before it
    // could hold the role. It publishes nothing here.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    serving(venue, eur);

    at(venue, 10n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR, 20n, eur.name, SECRETS.backer, HEIR_SECRET));

    at(venue, 19n);
    expect(operatorAt(eur, venue, 19n)).toEqual(KEYS.operator);
    at(venue, 20n);
    expect(operatorAt(eur, venue, 20n)).toEqual(HEIR);
  });

  it("leaves the predecessor serving through the lead time", () => {
    // "Until the effective index the predecessor governs and goes on serving" —
    // a handover that froze the backing in between would hand any named
    // successor a stall.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { sequencer } = serving(venue, eur);

    at(venue, 10n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR, 20n, eur.name, SECRETS.backer, HEIR_SECRET));

    at(venue, 15n);
    expect(operatorAt(eur, venue, 15n)).toEqual(KEYS.operator);
    // And it can still co-sign, which is what "goes on serving" means.
    sequencer.submitIssue(
      { backing: eur, recipient: KEYS.bob, quantity: 50n, nonce: 1n },
      ed25519.sign(encodeIssuanceMessage(eur.name, KEYS.bob, 50n, 1n), SECRETS.backer),
    );
    expect(sequencer.outstanding(eur)).toBe(150n);
  });

  it("seats a successor that never commits, which used to end the chain", () => {
    // The retired rule's own justification for the qualification window was
    // "naming a successor that never commits does not end the chain". With force
    // at the effective index there is nothing to qualify for, so the window and
    // its whole family retire: a seated successor that does not serve is
    // answered by the non-service grade like any other operator.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    serving(venue, eur);

    at(venue, 10n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR, 12n, eur.name, SECRETS.backer, HEIR_SECRET));
    at(venue, 12n);

    expect(operatorAt(eur, venue, 12n)).toEqual(HEIR);
    expect(venue.firstCommitmentFor(HEIR)).toBeUndefined();
  });
});

describe("§C2: two replacements naming one predecessor", () => {
  it("resolve to the later, where it was witnessed before the earlier took force", () => {
    // Re-naming revokes a successor not yet in force.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    serving(venue, eur);

    at(venue, 10n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR, 30n, eur.name, SECRETS.backer, HEIR_SECRET));
    at(venue, 20n);
    venue.publishReplacement(eur.name, replacementBy(eur, OTHER, 40n, eur.name, SECRETS.backer, OTHER_SECRET));

    at(venue, 30n);
    // The first one's effective index has passed, but it was superseded at 20.
    expect(operatorAt(eur, venue, 30n)).toEqual(KEYS.operator);
    at(venue, 40n);
    expect(operatorAt(eur, venue, 40n)).toEqual(OTHER);
  });

  it("ignore one witnessed after the earlier took force, so no past reading moves", () => {
    // Past the effective index the successor IS the incumbent, and replacing it
    // is a replacement naming it. Admitting this one would move force at an
    // index readers have already read.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    serving(venue, eur);

    at(venue, 10n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR, 15n, eur.name, SECRETS.backer, HEIR_SECRET));
    at(venue, 15n);
    expect(operatorAt(eur, venue, 15n)).toEqual(HEIR);

    // A second one at the same link, witnessed after the first took force.
    at(venue, 20n);
    venue.publishReplacement(eur.name, replacementBy(eur, OTHER, 25n, eur.name, SECRETS.backer, OTHER_SECRET));
    at(venue, 25n);

    expect(operatorAt(eur, venue, 25n)).toEqual(HEIR);
    // And the reading at 15 is exactly what it was before the second appeared.
    expect(operatorAt(eur, venue, 15n)).toEqual(HEIR);
  });
});
