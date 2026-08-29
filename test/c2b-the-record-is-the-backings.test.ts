import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { compareBytes } from "../src/bytes.js";
import { signCommitment, stateRoot, type ServedState } from "../src/commitment.js";
import { isRewrittenHistory } from "../src/fault.js";
import { encodeIssuanceMessage, encodeTransferMessage } from "../src/messages.js";
import { type PublishedOp } from "../src/oplog.js";
import { isNonServing, isSilent, nonServingOperator, provesHolding, redemptionIsOpen, unservedRequests } from "../src/recovery.js";
import {
  operatorAt,
  replacementHash,
  replacementMessage,
  ROLE_OPERATOR,
  type Replacement,
} from "../src/replacement.js";
import { Sequencer } from "../src/sequencer.js";
import { LocalVenue } from "../src/venue.js";
import { KEYS, pub, SECRETS } from "./support.js";

// **The subject of the record is the backing, not the key.**
//
// §C2 (2026-08-29) made force a signed field: a replacement is co-signed and
// takes effect at its declared effective index. That retired an implication
// three mechanisms were quietly built on — under the two-stage rule a successor
// took force only by publishing a commitment, so "in force" implied "has
// committed" for free. Nothing replaced it, and the readers that leaned on it
// were not touched. Every test in this file is a place that leaned on it.
//
// The rule that replaces it, in §C2 and §C2b as amended:
//
//   - "The effective index is a routing field and never a clock."
//   - "A term of the chain, rather than a key, is the unit of obligation, of
//     accrual and of fault... A key the rule-holder names twice holds two terms
//     and answers for each separately."
//   - "The clock is the backing's, so a handover neither starts it nor stops it"
//     — the grade "runs from the last commitment witnessed from a party then in
//     force for this backing... and only a commitment closes it."
//   - "The snapshot is the backing's rather than a key's."
//
// One idea, four readers. See DECISIONS.md.

const SILENCE = { noCommitmentDuration: 10n, challengeWindow: 5n };
const NON_SERVICE = { duration: 5n, count: 2n, window: 1000n };

const HEIR_SECRET = new Uint8Array(32).fill(0x0b);
const HEIR = pub(HEIR_SECRET);
const THROWAWAY_SECRET = new Uint8Array(32).fill(0x0c);
const THROWAWAY = pub(THROWAWAY_SECRET);

/** A replaceable backing: E names an operator, a silence clause and a rule. */
function backingFor(thing: string): Backing {
  return makeBacking({
    obligor: KEYS.backer,
    payout: { thing, quantumExponent: -2, perUnit: 100n },
    reliance: [],
    evidence: {
      setting: "transparent",
      operator: KEYS.operator,
      silence: SILENCE,
      nonService: NON_SERVICE,
      replacementRule: KEYS.backer,
    },
  });
}

function setup(thing = "EUR") {
  const venue = new LocalVenue();
  const sequencer = new Sequencer(SECRETS.operator, venue);
  const backing = backingFor(thing);
  sequencer.register(backing, signBacking(SECRETS.backer, backing));
  sequencer.submitIssue(
    { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
    ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
  );
  return { venue, sequencer, backing };
}

/**
 * A replacement the rule-holder signs and the successor co-signs. The successor's
 * SECRET, because §C2's replacement is co-signed and a fixture that could build
 * one without consent would be building something the law does not accept.
 */
function replacementBy(
  backing: Backing,
  successorSecret: Uint8Array,
  predecessor: Uint8Array,
  effective: bigint,
): Replacement {
  const unsigned = {
    role: ROLE_OPERATOR,
    successor: ed25519.getPublicKey(successorSecret),
    predecessor,
    effective,
    signature: new Uint8Array(64),
    successorSignature: new Uint8Array(64),
  };
  const message = replacementMessage(backing.name, unsigned);
  return {
    ...unsigned,
    signature: ed25519.sign(message, SECRETS.backer),
    successorSignature: ed25519.sign(message, successorSecret),
  };
}

function at(venue: LocalVenue, index: bigint): void {
  const now = venue.witnessedIndex();
  if (index > now) venue.advance(index - now);
}

/** Alice's signed request to move units to Bob — §C2b's non-service object. */
function request(backing: Backing, quantity: bigint, nonce: bigint): PublishedOp {
  return {
    kind: "transfer",
    from: KEYS.alice,
    to: KEYS.bob,
    quantity,
    nonce,
    signature: ed25519.sign(
      encodeTransferMessage(backing.name, KEYS.alice, KEYS.bob, quantity, nonce),
      SECRETS.alice,
    ),
  };
}

describe("§C2b: the snapshot is the backing's, not a key's", () => {
  it("a holder's redemption proof survives a handover to an heir that has not committed", () => {
    // The verified finding the rebuild exists for. §C2b's snapshot redemption is
    // the only checkable remedy a holder has against a dark operator, and it
    // runs on a state that proves the holding. Read against "whatever the party
    // in force has last committed", ONE published record naming a key that has
    // committed nothing destroys the proof — and the rule-holder is the backer
    // by default, which is the party that owes the money.
    const { venue, sequencer, backing } = setup();
    const snapshot = sequencer.commit();
    expect(provesHolding(venue, backing, snapshot, KEYS.alice, 100n)).toBe(true);

    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, HEIR_SECRET, backing.name, 6n));
    at(venue, 6n);
    expect(operatorAt(backing, venue, 6n)).toEqual(HEIR);

    // Past the declared silence, with the heir having published nothing.
    at(venue, 40n);
    expect(isSilent(venue, backing)).toBe(true);
    // The predecessor's last commitment is still the backing's last commitment,
    // and it is what the remedy runs on.
    expect(provesHolding(venue, backing, snapshot, KEYS.alice, 100n)).toBe(true);
    expect(redemptionIsOpen(venue, backing, snapshot, KEYS.alice, 100n)).toBe(true);
  });

  it("proves no more than the holder holds, against that same snapshot", () => {
    // The remedy surviving must not become a remedy for more than was held —
    // the quantity check is the half a "still answers" fix could quietly drop.
    const { venue, sequencer, backing } = setup();
    const snapshot = sequencer.commit();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, HEIR_SECRET, backing.name, 6n));
    at(venue, 40n);
    expect(provesHolding(venue, backing, snapshot, KEYS.alice, 101n)).toBe(false);
    expect(provesHolding(venue, backing, snapshot, KEYS.bob, 1n)).toBe(false);
  });
});

describe("§C2b: the clock is the backing's, and only a commitment closes a gap", () => {
  it("is not cancelled by hopping to a throwaway key and back", () => {
    // Two published records, no commitment anywhere, and a standing aggravated
    // grade disappears. The rule-holder generates the throwaway key and
    // co-signs both halves itself, so this costs it one publication per
    // duration — and the party with the motive is the party that owes.
    // Sharper than it looks: hopping to a FRESH key every duration defeats any
    // clock read per key, so only a backing clock closes it.
    const { venue, sequencer, backing } = setup();
    sequencer.commit();
    at(venue, 20n);
    expect(isSilent(venue, backing)).toBe(true);

    const out = replacementBy(backing, THROWAWAY_SECRET, backing.name, 20n);
    venue.publishReplacement(backing.name, out);
    at(venue, 21n);
    venue.publishReplacement(
      backing.name,
      replacementBy(backing, SECRETS.operator, replacementHash(backing.name, out), 21n),
    );
    at(venue, 22n);

    expect(operatorAt(backing, venue, 22n)).toEqual(KEYS.operator);
    expect(isSilent(venue, backing)).toBe(true);
  });

  it("closes when a commitment is witnessed, whoever is in force", () => {
    // The other half of the same rule, and the honest path the refusal above
    // leaves open: a gap ends on a commitment and on nothing else. Without
    // this the fix would read as "silence is permanent", which is not the rule.
    const { venue, sequencer, backing } = setup();
    sequencer.commit();
    at(venue, 20n);
    expect(isSilent(venue, backing)).toBe(true);
    sequencer.commit();
    expect(isSilent(venue, backing)).toBe(false);
  });

  it("gives an heir the remainder of its predecessor's window, not a fresh one", () => {
    // The cost §C2b now states, kept executable. A backer cannot rescue a dark
    // backing by appointing a live successor: the grade stands until a
    // commitment lands. No reader can tell that heir from a rule-holder
    // colluding with itself, so the rule does not try to.
    const { venue, sequencer, backing } = setup();
    sequencer.commit();
    at(venue, 20n);
    expect(isSilent(venue, backing)).toBe(true);
    venue.publishReplacement(backing.name, replacementBy(backing, HEIR_SECRET, backing.name, 20n));
    at(venue, 21n);
    expect(operatorAt(backing, venue, 21n)).toEqual(HEIR);
    expect(isSilent(venue, backing)).toBe(true);
  });

  it("does not read a punctual predecessor's handover as an heir's silence", () => {
    // The honest case, and the one a per-key clock got wrong in the other
    // direction: a backing handed over by an operator that was committing on
    // time is not dark the index after the handover.
    const { venue, sequencer, backing } = setup();
    at(venue, 18n);
    sequencer.commit();
    venue.publishReplacement(backing.name, replacementBy(backing, HEIR_SECRET, backing.name, 19n));
    at(venue, 21n);
    expect(operatorAt(backing, venue, 21n)).toEqual(HEIR);
    expect(isSilent(venue, backing)).toBe(false);
  });
});

describe("§C2: a term of the chain is the unit of obligation and of fault", () => {
  it("a re-appointed operator does not launder its first term's book", () => {
    // The unprovability half of the stale-latch defect. A key that appears
    // twice in the chain ranks at its FIRST link, so every fault predicate that
    // orders two states by that rank reads a second-term state as belonging to
    // the first term — and any re-appointed key is exempt from this fault by
    // construction. Here the operator re-asserts its stale pre-handover book:
    // a holder's units gone from the state of record, and nobody can prove it.
    const { venue, sequencer, backing } = setup();
    sequencer.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 50n, nonce: 1n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 50n, 1n), SECRETS.backer),
    );
    const full = sequencer.commit();
    const fullLog = sequencer.opLog(backing);
    expect(fullLog).toHaveLength(2);

    at(venue, 10n);
    const out = replacementBy(backing, HEIR_SECRET, backing.name, 10n);
    venue.publishReplacement(backing.name, out);
    // The heir serves its term — INSIDE it, at 12 — and commits the book whole:
    // the state of record for as long as it holds the role.
    at(venue, 12n);
    const heirSnapshots = [{ name: backing.name, opLog: fullLog }];
    const heirCommitment = signCommitment(
      HEIR_SECRET,
      venue.nextSequenceFor(HEIR),
      stateRoot(heirSnapshots),
    );
    venue.publish(heirCommitment);
    const heirFull: ServedState = { snapshots: heirSnapshots, commitment: heirCommitment };

    at(venue, 20n);
    venue.publishReplacement(
      backing.name,
      replacementBy(backing, SECRETS.operator, replacementHash(backing.name, out), 20n),
    );
    at(venue, 25n);
    expect(operatorAt(backing, venue, 25n)).toEqual(KEYS.operator);

    // Its second term, asserting a log that has shrunk back to one issuance:
    // Alice's 50 units gone from the state of record.
    const snapshots = [{ name: backing.name, opLog: fullLog.slice(0, 1) }];
    const commitment = signCommitment(
      SECRETS.operator,
      venue.nextSequenceFor(KEYS.operator),
      stateRoot(snapshots),
    );
    venue.publish(commitment);
    const shrunk: ServedState = { snapshots, commitment };

    // Ranked by key, the re-appointed operator sits at its FIRST link, so its
    // second-term state reads as older than the heir's and the shrink reads as
    // growth. Ranked by term, it is what it is.
    expect(isRewrittenHistory(backing, venue, heirFull, shrunk)).toBe(true);
    expect(isRewrittenHistory(backing, venue, shrunk, heirFull)).toBe(true);
    // And its own first-term state is still ordered correctly against it, which
    // the sequence comparison alone already gets right.
    expect(isRewrittenHistory(backing, venue, full, shrunk)).toBe(true);
  });

  it("an honest successor committing its other backings in the lead time accuses itself of nothing", () => {
    // §C2 gives the successor a lead time and FORBIDS it to carry the backing
    // in it — the predecessor is still serving. A shared operator batches, so
    // the successor's punctual commitment over its own other backings drops
    // this one as a matter of obedience. Ranked by key rather than by term, the
    // chain tip "has no excuse for dropping it", so every punctual
    // multi-backing successor manufactures a permanent, stranger-checkable
    // fault proof against itself.
    const { venue, sequencer, backing } = setup();
    const full = sequencer.commit();

    const other = backingFor("GOLD");

    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, HEIR_SECRET, backing.name, 10n));
    // Its own other backing: the heir commits GOLD at 8, inside the lead time,
    // carrying no log for EUR because §C2 forbids it to carry one there.
    at(venue, 8n);
    const snapshots = [{ name: other.name, opLog: [] }];
    const commitment = signCommitment(HEIR_SECRET, venue.nextSequenceFor(HEIR), stateRoot(snapshots));
    venue.publish(commitment);
    const leadTime: ServedState = { snapshots, commitment };

    at(venue, 20n);
    expect(operatorAt(backing, venue, 20n)).toEqual(HEIR);
    expect(isRewrittenHistory(backing, venue, full, leadTime)).toBe(false);
    expect(isRewrittenHistory(backing, venue, leadTime, full)).toBe(false);
  });
});

describe("§C2b: the count stands against the backing, and the grade names the incumbent", () => {
  it("does not grade a retired operator with requests witnessed after its duty ended", () => {
    // Live on main, and not this branch's doing. The defect is the SUBJECT:
    // isNonServing named no party, so a reader supplied the only one in the
    // call — whoever signed the evidence. A holder acting alone published two
    // requests twenty indices after the handover, folded them onto the retired
    // operator's own honest state, and the grade read true against a party
    // whose duty had ended. §15 prices a key's history, so that is worth
    // manufacturing. The count does not move — a boundary the rule-holder
    // draws must not partition a count of absences, or one publication per
    // (m−1) requests resets the aggregate forever — the NAME does: the grade
    // is the incumbent's, and the retired key is never a present reading's
    // subject.
    const { venue, sequencer, backing } = setup();
    const honest = sequencer.commit();

    at(venue, 10n);
    venue.publishReplacement(backing.name, replacementBy(backing, HEIR_SECRET, backing.name, 10n));
    expect(operatorAt(backing, venue, 10n)).toEqual(HEIR);

    at(venue, 30n);
    venue.publishOp(backing.name, request(backing, 10n, 0n));
    venue.publishOp(backing.name, request(backing, 20n, 1n));

    at(venue, 45n);
    expect(unservedRequests(venue, backing, honest)).toHaveLength(2);
    expect(nonServingOperator(venue, backing, honest)).toEqual(HEIR);
  });

  it("still grades the operator that was handed the requests and sat on them", () => {
    // The honest path the naming leaves open, and the case the grade exists
    // for: a stalling operator that publishes on time. A door closed to one
    // party is a door closed to everyone who used it, so the renaming above is
    // only right if this still fires — and fires against the staller.
    const { venue, sequencer, backing } = setup();
    const honest = sequencer.commit();

    at(venue, 5n);
    venue.publishOp(backing.name, request(backing, 10n, 0n));
    venue.publishOp(backing.name, request(backing, 20n, 1n));

    at(venue, 45n);
    expect(unservedRequests(venue, backing, honest)).toHaveLength(2);
    expect(nonServingOperator(venue, backing, honest)).toEqual(KEYS.operator);
    expect(isNonServing(venue, backing, honest)).toBe(true);
  });

  it("a successor inherits the standing requests, and clears them only by serving them", () => {
    // The two halves of the inheritance, walked. The grade names the heir the
    // index it takes force — it co-signed the replacement with the standing
    // requests in view, which is what makes naming it fair — and no
    // publication clears the count: only serving does. An heir that takes the
    // book over, replays the requests and commits reads a count of zero
    // against its own state, because a served request leaves the count.
    const { venue, sequencer, backing } = setup();
    const honest = sequencer.commit();

    at(venue, 5n);
    venue.publishOp(backing.name, request(backing, 10n, 0n));
    venue.publishOp(backing.name, request(backing, 20n, 1n));

    at(venue, 30n);
    venue.publishReplacement(backing.name, replacementBy(backing, HEIR_SECRET, backing.name, 30n));
    at(venue, 40n);
    // The handover moved the name and not the count.
    expect(unservedRequests(venue, backing, honest)).toHaveLength(2);
    expect(nonServingOperator(venue, backing, honest)).toEqual(HEIR);
  });
});

describe("§C2: two replacements witnessed at one index", () => {
  it("resolve the same way for every reader, whatever order they arrived in", () => {
    // Witnessing pins order, and at one index it cannot, so the rule has to
    // live in the objects themselves: the lesser record hash. Sorted on the
    // index alone, two honest wallets holding the SAME two records disagree
    // permanently about who was operator at a past index — which is the "two
    // readers disagree about who is at fault" hazard fault.ts forbids outright,
    // arriving through publication order instead of served state.
    const a = backingFor("EUR");
    const first = replacementBy(a, HEIR_SECRET, a.name, 5n);
    const second = replacementBy(a, THROWAWAY_SECRET, a.name, 5n);
    const lesser =
      compareBytes(replacementHash(a.name, first), replacementHash(a.name, second)) < 0 ? HEIR : THROWAWAY;

    const forward = new LocalVenue();
    forward.advance(5n);
    forward.publishReplacement(a.name, first);
    forward.publishReplacement(a.name, second);

    const backward = new LocalVenue();
    backward.advance(5n);
    backward.publishReplacement(a.name, second);
    backward.publishReplacement(a.name, first);

    expect(operatorAt(a, forward, 5n)).toEqual(lesser);
    expect(operatorAt(a, backward, 5n)).toEqual(lesser);
  });
});
