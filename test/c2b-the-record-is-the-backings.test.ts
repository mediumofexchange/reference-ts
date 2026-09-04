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
    // The exact holding first, or a provesHolding that answered false to
    // everything would pass this test's refusals for the wrong reason.
    const { venue, sequencer, backing } = setup();
    const snapshot = sequencer.commit();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, HEIR_SECRET, backing.name, 6n));
    at(venue, 40n);
    expect(provesHolding(venue, backing, snapshot, KEYS.alice, 100n)).toBe(true);
    expect(provesHolding(venue, backing, snapshot, KEYS.alice, 101n)).toBe(false);
    expect(provesHolding(venue, backing, snapshot, KEYS.bob, 1n)).toBe(false);
  });

  it("an heir that re-commits the predecessor's book verbatim leaves the holder's copy proving", () => {
    // The state, not the signer. After an orderly handover the heir's first
    // commitment can carry the predecessor's book byte-identically — same log,
    // same root, its own key, and a fresh key's first sequence is the
    // predecessor's first too. The holder keeping the predecessor's copy is
    // following the rule CLAUDE.md gives them, and the root is injective over
    // states (inv 22), so refusing on the SIGNER refused the state of record
    // itself (found reviewing this slice).
    const { venue, sequencer, backing } = setup();
    const snapshot = sequencer.commit();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, HEIR_SECRET, backing.name, 8n));
    at(venue, 10n);
    const heirCommitment = signCommitment(
      HEIR_SECRET,
      venue.nextSequenceFor(HEIR),
      stateRoot(snapshot.snapshots),
    );
    venue.publish(heirCommitment);
    expect(heirCommitment.sequence).toBe(snapshot.commitment.sequence);

    at(venue, 25n);
    expect(isSilent(venue, backing)).toBe(true);
    expect(provesHolding(venue, backing, snapshot, KEYS.alice, 100n)).toBe(true);
    expect(redemptionIsOpen(venue, backing, snapshot, KEYS.alice, 100n)).toBe(true);
    // And the heir's own copy proves identically: one state, two signatures.
    const heirCopy: ServedState = { snapshots: snapshot.snapshots, commitment: heirCommitment };
    expect(provesHolding(venue, backing, heirCopy, KEYS.alice, 100n)).toBe(true);
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

    // Each record dated the floor ahead of its witnessing (slice 38): the hop
    // has to really happen for the test to say anything, and the review's
    // inventory angle found this fixture passing with nobody hopped at all.
    const out = replacementBy(backing, THROWAWAY_SECRET, backing.name, 21n);
    venue.publishReplacement(backing.name, out);
    at(venue, 21n);
    venue.publishReplacement(
      backing.name,
      replacementBy(backing, SECRETS.operator, replacementHash(backing.name, out), 22n),
    );
    at(venue, 23n);

    expect(operatorAt(backing, venue, 21n)).toEqual(THROWAWAY);
    expect(operatorAt(backing, venue, 23n)).toEqual(KEYS.operator);
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

    // And WHOEVER is in force, exercised: the same gap reopened, an heir
    // seated into it, and the heir's own commitment closing it.
    at(venue, 40n);
    expect(isSilent(venue, backing)).toBe(true);
    venue.publishReplacement(backing.name, replacementBy(backing, HEIR_SECRET, backing.name, 41n));
    at(venue, 42n);
    expect(operatorAt(backing, venue, 42n)).toEqual(HEIR);
    expect(isSilent(venue, backing)).toBe(true);
    venue.publish(signCommitment(HEIR_SECRET, venue.nextSequenceFor(HEIR), stateRoot([])));
    expect(isSilent(venue, backing)).toBe(false);
  });

  it("gives an heir the remainder of its predecessor's window, not a fresh one", () => {
    // The cost §C2b now states, kept executable — and a REMAINDER, so the
    // window has to be live at the handover: expired-at-handover would not
    // distinguish inheriting a clock from inheriting a corpse. The predecessor
    // commits at 12; the heir is seated at 15 with 7 indices left; at 22 it is
    // still inside them, at 23 the inherited window runs out. No reader can
    // tell that heir from a rule-holder colluding with itself, so the rule
    // does not try to.
    const { venue, sequencer, backing } = setup();
    at(venue, 12n);
    sequencer.commit();
    venue.publishReplacement(backing.name, replacementBy(backing, HEIR_SECRET, backing.name, 15n));
    at(venue, 22n);
    expect(operatorAt(backing, venue, 22n)).toEqual(HEIR);
    expect(isSilent(venue, backing)).toBe(false);
    at(venue, 23n);
    expect(isSilent(venue, backing)).toBe(true);
  });

  it("a commitment carrying nothing for this backing closes its gap, and the remedy moves to requests", () => {
    // The cost of §C2b's own concession, pinned: "the grade fires on the
    // operator publishing nothing, not on it covering nothing" — coverage is
    // unreadable from a root. So an heir's routine commitment for its OTHER
    // backings closes this one's gap, and the snapshot redemption that was
    // open dies with it. What is left is the non-service grade, and it is the
    // HOLDER's to arm: it reads false here only because nobody has filed a
    // request yet, and the still-grades test in this file is that path walked.
    const { venue, sequencer, backing } = setup();
    const snapshot = sequencer.commit();
    at(venue, 20n);
    venue.publishReplacement(backing.name, replacementBy(backing, HEIR_SECRET, backing.name, 21n));
    at(venue, 30n);
    expect(redemptionIsOpen(venue, backing, snapshot, KEYS.alice, 100n)).toBe(true);
    // The heir's commitment, rooted over nothing of this backing's.
    venue.publish(signCommitment(HEIR_SECRET, venue.nextSequenceFor(HEIR), stateRoot([])));
    at(venue, 31n);
    expect(isSilent(venue, backing)).toBe(false);
    expect(redemptionIsOpen(venue, backing, snapshot, KEYS.alice, 100n)).toBe(false);
    expect(isNonServing(venue, backing, snapshot)).toBe(false);
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
    const out = replacementBy(backing, HEIR_SECRET, backing.name, 11n);
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
      replacementBy(backing, SECRETS.operator, replacementHash(backing.name, out), 21n),
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

  it("one signer's rewrite stays provable however the chain grows after it signed", () => {
    // The review round's sharpest find. Ranked through the term windows, ONE
    // published replacement closed the predecessor's term, its unwitnessed
    // rewrite no longer placed anywhere, and invariant 22's fault against it
    // was erased for one free record — signed by the rule-holder, which is the
    // backer, which is the party the fault is against. One signer's states
    // compare by its own sequence field, so the chain's growth changes nothing.
    const { venue, sequencer, backing } = setup();
    sequencer.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 50n, nonce: 1n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 50n, 1n), SECRETS.backer),
    );
    const full = sequencer.commit();
    const fullLog = sequencer.opLog(backing);
    expect(fullLog).toHaveLength(2);
    const snapshots = [{ name: backing.name, opLog: fullLog.slice(0, 1) }];
    // A shrink at the next sequence, served and never published.
    const shrunk: ServedState = {
      snapshots,
      commitment: signCommitment(SECRETS.operator, full.commitment.sequence + 1n, stateRoot(snapshots)),
    };
    expect(isRewrittenHistory(backing, venue, full, shrunk)).toBe(true);

    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, HEIR_SECRET, backing.name, 6n));
    at(venue, 10n);
    expect(operatorAt(backing, venue, 10n)).toEqual(HEIR);
    expect(isRewrittenHistory(backing, venue, full, shrunk)).toBe(true);
    expect(isRewrittenHistory(backing, venue, shrunk, full)).toBe(true);
  });

  it("a state the record cannot place accuses nobody: a re-appointed key's old serving is not its later shrink", () => {
    // The other direction of the same find. X honestly served past its last
    // commitment in its FIRST term; the tail died at the handover, unwitnessed.
    // By sequence alone that state is indistinguishable from one X signed in
    // its SECOND term — and ranked there, X's old serving sorted AFTER its
    // successor's genuinely later state, read as a shrink, and became a
    // permanent stranger-checkable fault X armed by consenting to its own
    // re-appointment. The record cannot place it, so nothing is said.
    const { venue, sequencer, backing } = setup();
    sequencer.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 50n, nonce: 1n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 50n, 1n), SECRETS.backer),
    );
    sequencer.commit();
    const fullLog = sequencer.opLog(backing);
    expect(fullLog).toHaveLength(2);

    // X's witnessed first-term commitment carries an empty book; its honest
    // serving ran one entry ahead of it, at seq 1, never witnessed.
    const empty = [{ name: backing.name, opLog: [] }];
    const xTailSnapshots = [{ name: backing.name, opLog: fullLog.slice(0, 1) }];
    const xTail: ServedState = {
      snapshots: xTailSnapshots,
      commitment: signCommitment(HEIR_SECRET, 1n, stateRoot(xTailSnapshots)),
    };
    const first = replacementBy(backing, HEIR_SECRET, backing.name, 3n);
    at(venue, 2n);
    venue.publishReplacement(backing.name, first);
    at(venue, 4n);
    venue.publish(signCommitment(HEIR_SECRET, 0n, stateRoot(empty)));

    // Y takes over and commits the fuller, two-entry book; X is re-appointed
    // after. Placed in X's second term, xTail would sort after yState and its
    // one entry would read as a shrink of two.
    const yFull = [{ name: backing.name, opLog: fullLog }];
    const yState: ServedState = {
      snapshots: yFull,
      commitment: signCommitment(THROWAWAY_SECRET, 0n, stateRoot(yFull)),
    };
    const second = replacementBy(backing, THROWAWAY_SECRET, replacementHash(backing.name, first), 11n);
    at(venue, 10n);
    venue.publishReplacement(backing.name, second);
    at(venue, 11n);
    venue.publish(yState.commitment);
    at(venue, 20n);
    venue.publishReplacement(
      backing.name,
      replacementBy(backing, HEIR_SECRET, replacementHash(backing.name, second), 21n),
    );
    at(venue, 25n);
    expect(operatorAt(backing, venue, 25n)).toEqual(HEIR);

    expect(isRewrittenHistory(backing, venue, yState, xTail)).toBe(false);
    expect(isRewrittenHistory(backing, venue, xTail, yState)).toBe(false);
  });

  it("an unwitnessed drop convicts a genesis operator, and nobody once a succession exists", () => {
    // The uniform policy the regression review forced, pinned with its price.
    // While the chain is the genesis link alone, nothing this key signed could
    // belong to a period out of force, so its served-but-unpublished dropped
    // state places at the tip and the fault fires. Once ANY succession exists,
    // every key has had a period out of force, and a shared operator's honest
    // service in it produces signed states that drop this backing — by
    // sequence alone indistinguishable, so nothing is said. What that costs,
    // priced in DECISIONS: past the first handover, this pair alone no longer
    // proves an in-force operator's unwitnessed drop — the witnessed drop and
    // the non-service grade are the reach there.
    const { venue, sequencer, backing } = setup();
    const full = sequencer.commit();
    const dropped: ServedState = {
      snapshots: [],
      commitment: signCommitment(SECRETS.operator, full.commitment.sequence + 1n, stateRoot([])),
    };
    expect(isRewrittenHistory(backing, venue, full, dropped)).toBe(true);

    // Out to a throwaway and back: the same two states, and the record can no
    // longer place the unwitnessed one.
    const out = replacementBy(backing, THROWAWAY_SECRET, backing.name, 7n);
    at(venue, 6n);
    venue.publishReplacement(backing.name, out);
    at(venue, 9n);
    venue.publishReplacement(
      backing.name,
      replacementBy(backing, SECRETS.operator, replacementHash(backing.name, out), 10n),
    );
    at(venue, 12n);
    expect(operatorAt(backing, venue, 12n)).toEqual(KEYS.operator);
    expect(isRewrittenHistory(backing, venue, full, dropped)).toBe(false);
  });

  it("a re-appointed key's honest second term accuses nobody either", () => {
    // The honest path beside the launder test: the re-appointed operator
    // re-commits the book WHOLE in its second term, and no pairing of the
    // three states names a fault. A refusal that reached this case would make
    // resuming the role itself the fault.
    const { venue, sequencer, backing } = setup();
    sequencer.commit();
    const fullLog = sequencer.opLog(backing);
    const full = [{ name: backing.name, opLog: fullLog }];

    const first = replacementBy(backing, HEIR_SECRET, backing.name, 11n);
    at(venue, 10n);
    venue.publishReplacement(backing.name, first);
    at(venue, 12n);
    const heirState: ServedState = {
      snapshots: full,
      commitment: signCommitment(HEIR_SECRET, 0n, stateRoot(full)),
    };
    venue.publish(heirState.commitment);
    at(venue, 20n);
    venue.publishReplacement(
      backing.name,
      replacementBy(backing, SECRETS.operator, replacementHash(backing.name, first), 21n),
    );
    at(venue, 25n);
    const resumed: ServedState = {
      snapshots: full,
      commitment: signCommitment(SECRETS.operator, venue.nextSequenceFor(KEYS.operator), stateRoot(full)),
    };
    venue.publish(resumed.commitment);

    expect(isRewrittenHistory(backing, venue, heirState, resumed)).toBe(false);
    expect(isRewrittenHistory(backing, venue, resumed, heirState)).toBe(false);
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
    venue.publishReplacement(backing.name, replacementBy(backing, HEIR_SECRET, backing.name, 11n));
    at(venue, 11n);
    expect(operatorAt(backing, venue, 11n)).toEqual(HEIR);

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
    venue.publishReplacement(backing.name, replacementBy(backing, HEIR_SECRET, backing.name, 35n));
    // The book moves in the lead time — past the effective index takeOver's
    // own guard refuses, which is the 35d lockout, not this test's business.
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(backing, signBacking(SECRETS.backer, backing));
    at(venue, 32n);
    heir.takeOver(backing, honest);
    at(venue, 40n);
    // The handover moved the name and not the count.
    expect(unservedRequests(venue, backing, honest)).toHaveLength(2);
    expect(nonServingOperator(venue, backing, honest)).toEqual(HEIR);

    // And SERVING clears it — walked, not narrated. The heir commits its way
    // through the inherited gap, serves both standing requests, and commits
    // the log that carries them. Against the state of record the count is
    // zero; against the predecessor's stale copy it still reads two, which is
    // a fact about that state and not about the heir — the count is read off
    // the log it is folded on, and the log moved.
    heir.commit();
    at(venue, 41n);
    heir.submitTransfer(
      { backing, from: KEYS.alice, to: KEYS.bob, quantity: 10n, nonce: 0n },
      ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, KEYS.bob, 10n, 0n), SECRETS.alice),
    );
    heir.submitTransfer(
      { backing, from: KEYS.alice, to: KEYS.bob, quantity: 20n, nonce: 1n },
      ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, KEYS.bob, 20n, 1n), SECRETS.alice),
    );
    at(venue, 42n);
    const servedState = heir.commit();
    expect(unservedRequests(venue, backing, servedState)).toHaveLength(0);
    expect(isNonServing(venue, backing, servedState)).toBe(false);
    expect(unservedRequests(venue, backing, honest)).toHaveLength(2);
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
    const first = replacementBy(a, HEIR_SECRET, a.name, 6n);
    const second = replacementBy(a, THROWAWAY_SECRET, a.name, 6n);
    const lesser =
      compareBytes(replacementHash(a.name, first), replacementHash(a.name, second)) < 0 ? HEIR : THROWAWAY;

    const forward = new LocalVenue();
    forward.advance(5n);
    forward.publishReplacement(a.name, first);
    forward.publishReplacement(a.name, second);
    forward.advance(1n);

    const backward = new LocalVenue();
    backward.advance(5n);
    backward.publishReplacement(a.name, second);
    backward.publishReplacement(a.name, first);
    backward.advance(1n);

    expect(operatorAt(a, forward, 6n)).toEqual(lesser);
    expect(operatorAt(a, backward, 6n)).toEqual(lesser);
  });

  it("resolve to the lesser hash under a lead time too, in both arrival orders", () => {
    // The tie above declares the least lead the floor allows (slice 38 — it
    // used to declare effective == witnessed, which shut the supersession
    // window before the sibling was read, so the loop's own same-index rule
    // went unexercised there). With a longer lead the window is wide open: a
    // sibling that could displace the sorted winner handed the win to the
    // GREATER hash (found reviewing this slice), and this is the fixture that
    // reached it.
    const a = backingFor("EUR");
    const first = replacementBy(a, HEIR_SECRET, a.name, 20n);
    const second = replacementBy(a, THROWAWAY_SECRET, a.name, 20n);
    const lesser =
      compareBytes(replacementHash(a.name, first), replacementHash(a.name, second)) < 0 ? HEIR : THROWAWAY;

    for (const order of [[first, second], [second, first]]) {
      const venue = new LocalVenue();
      venue.advance(5n);
      for (const r of order) venue.publishReplacement(a.name, r);
      venue.advance(20n);
      expect(operatorAt(a, venue, 25n)).toEqual(lesser);
    }
  });

  it("a revocation holds the tie its hash wins, and loses the one it does not", () => {
    // A revocation re-names the incumbent, and it ties like any other record:
    // where its hash is lesser, the incumbent stays and the fresh naming at
    // the same index does not stand fresh behind it; where greater, the fresh
    // naming wins. Before this rule a same-index naming beat the revocation in
    // EVERY hash order (found reviewing this slice) — deterministic, but not
    // what §C2 says. The two fresh keys are chosen so each side of the hash
    // order occurs; the search is over fixed fills, so it is the same records
    // forever.
    const a = backingFor("EUR");
    const revoke = replacementBy(a, SECRETS.operator, a.name, 12n);
    const revokeHash = replacementHash(a.name, revoke);
    let lesserSide: Uint8Array | undefined;
    let greaterSide: Uint8Array | undefined;
    for (let fill = 0x30; fill < 0x40; fill++) {
      const secret = new Uint8Array(32).fill(fill);
      const naming = replacementBy(a, secret, a.name, 12n);
      const cmp = compareBytes(revokeHash, replacementHash(a.name, naming));
      if (cmp < 0 && lesserSide === undefined) lesserSide = secret;
      if (cmp > 0 && greaterSide === undefined) greaterSide = secret;
    }
    expect(lesserSide).toBeDefined();
    expect(greaterSide).toBeDefined();

    for (const [namingSecret, winner] of [
      [lesserSide as Uint8Array, KEYS.operator],
      [greaterSide as Uint8Array, ed25519.getPublicKey(greaterSide as Uint8Array)],
    ] as const) {
      const naming = replacementBy(a, namingSecret, a.name, 12n);
      for (const order of [[revoke, naming], [naming, revoke]]) {
        const venue = new LocalVenue();
        venue.advance(5n);
        for (const r of order) venue.publishReplacement(a.name, r);
        venue.advance(20n);
        expect(operatorAt(a, venue, 25n)).toEqual(winner);
      }
    }
  });
});
