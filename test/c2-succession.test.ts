import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { signCommitment, stateRoot } from "../src/commitment.js";
import {
  isAnOperator,
  operatorAt,
  operatorsOf,
  replacementHash,
  replacementMessage,
  ROLE_OPERATOR,
  type Replacement,
} from "../src/replacement.js";
import { isNamedSuccessor } from "../src/replacement.js";
import { isRewrittenHistory } from "../src/fault.js";
import { encodeIssuanceMessage, encodeTransferMessage } from "../src/messages.js";
import { receiptStatus } from "../src/receipt.js";
import { gapLegsFor, isOverdue, isSilent, snapshotRedemptions, stateIsAuthentic } from "../src/recovery.js";
import { attemptIdOf, demandHash, encodeAcceptance, encodeDemand, encodeLock, encodeRelease, encodeWithdrawal, NO_DECISION_VENUE } from "../src/presentation.js";
import { Sequencer, SequencerError } from "../src/sequencer.js";
import { LocalVenue, VenueError, type Venue } from "../src/venue.js";
import { KEYS, pub, SECRETS } from "./support.js";

// §C2, succession: "A replacement is itself a witnessed object. It is signed by
// whoever E's rule names, the backer by default, states the role, the successor
// and the effective index... Each replacement names its predecessor, so the
// chain from the original terms is walkable. Its effective index is no earlier
// than the index at which it is itself witnessed, and it takes effect only from
// the first index at which it has published its own commitment... Until then the
// predecessor's last commitment governs... From the effective index the old
// attester's co-signatures stop counting, which is why a wallet verifies the
// chain rather than the key it remembers."
//
// E's operator sits inside the name and invariant 1 forbids an edit, so a
// replacement does not change it — it supersedes it on a record anyone can walk.
// That is how the venue and the operator "move only under its replacement rule"
// while both stay inside the hash.
//
// **What this slice does NOT do:** let the successor serve. Registering,
// co-signing and adopting the predecessor's log are the successor's side of the
// handover, and they need the tail the predecessor left. The chain is declared,
// walkable, and read by the verifiers that ask who is in force; Sequencer still
// serves only the key E names. See DECISIONS.md.

const SILENCE = { noCommitmentDuration: 10n, challengeWindow: 5n };
const SUCCESSOR_SECRET = new Uint8Array(32).fill(0x0b);
const SUCCESSOR = pub(SUCCESSOR_SECRET);
const THIRD_SECRET = new Uint8Array(32).fill(0x0c);
const FOURTH_SECRET = new Uint8Array(32).fill(0x0d);
const FOURTH = pub(FOURTH_SECRET);
const THIRD = pub(THIRD_SECRET);

/** A backing whose replacement rule is the backer's own key — §C2's default. */
function setup(replaceable = true) {
  const venue = new LocalVenue();
  const backing = makeBacking({
    obligor: KEYS.backer,
    payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
    reliance: [],
    evidence: {
      setting: "transparent",
      operator: KEYS.operator,
      silence: SILENCE,
      ...(replaceable ? { replacementRule: KEYS.backer } : {}),
    },
  });
  return { venue, backing };
}

function replacementBy(
  backing: Backing,
  ruleSecret: Uint8Array,
  successorSecret: Uint8Array,
  predecessor: Uint8Array,
  effective: bigint,
): Replacement {
  // The successor's SECRET, not its key: §C2's replacement is co-signed, so a
  // fixture that could build one without the successor's consent would be
  // building something the law does not accept.
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
    signature: ed25519.sign(message, ruleSecret),
    successorSignature: ed25519.sign(message, successorSecret),
  };
}

/** Put a commitment from `secret` at the venue — what gives a successor force. */
function commitAs(venue: LocalVenue, secret: Uint8Array): void {
  const operator = ed25519.getPublicKey(secret);
  venue.publish(signCommitment(secret, venue.nextSequenceFor(operator), stateRoot([])));
}

function at(venue: LocalVenue, index: bigint): void {
  const now = venue.witnessedIndex();
  if (index > now) venue.advance(index - now);
}

describe("§C2: the chain from the original terms is walkable", () => {
  it("starts at the key E names, and stays there with no replacement", () => {
    const { venue, backing } = setup();
    expect(operatorsOf(backing, venue)).toHaveLength(1);
    expect(operatorAt(backing, venue, 0n)).toEqual(KEYS.operator);
    expect(operatorAt(backing, venue, 10_000n)).toEqual(KEYS.operator);
  });

  it("hands over at the effective index, and not before it", () => {
    // §C2 (2026-08-29): force is the effective index. The stage that also
    // required the successor's own first commitment is retired — it could not
    // be checked where force is read, and it made the act conferring the role
    // the same act that proved the fault.
    const { venue, backing } = setup();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 10n));
    at(venue, 9n);
    expect(operatorAt(backing, venue, 9n)).toEqual(KEYS.operator);
    at(venue, 10n);
    expect(operatorAt(backing, venue, 10n)).toEqual(SUCCESSOR);
  });

  it("does not read a successor's unrelated commitments as anything at all", () => {
    // What the retired second stage was reaching for, now free: a key that
    // already operates something else publishes commitments on its own
    // schedule, and none of them touches this backing's succession either way.
    const { venue, backing } = setup();
    commitAs(venue, SUCCESSOR_SECRET);
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 10n));
    commitAs(venue, SUCCESSOR_SECRET);
    at(venue, 9n);
    expect(operatorAt(backing, venue, 9n)).toEqual(KEYS.operator);
    at(venue, 10n);
    expect(operatorAt(backing, venue, 10n)).toEqual(SUCCESSOR);
  });

  it("walks a chain of two handovers", () => {
    const { venue, backing } = setup();
    const first = replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 6n);
    at(venue, 5n);
    venue.publishReplacement(backing.name, first);
    at(venue, 6n);
    commitAs(venue, SUCCESSOR_SECRET);
    at(venue, 20n);
    venue.publishReplacement(
      backing.name,
      replacementBy(backing, SECRETS.backer, THIRD_SECRET, replacementHash(backing.name, first), 21n),
    );
    at(venue, 21n);
    commitAs(venue, THIRD_SECRET);

    expect(operatorsOf(backing, venue)).toHaveLength(3);
    expect(operatorAt(backing, venue, 5n)).toEqual(KEYS.operator);
    expect(operatorAt(backing, venue, 20n)).toEqual(SUCCESSOR);
    expect(operatorAt(backing, venue, 21n)).toEqual(THIRD);
    expect(isAnOperator(backing, venue, KEYS.operator)).toBe(true);
    expect(isAnOperator(backing, venue, THIRD)).toBe(true);
    expect(isAnOperator(backing, venue, KEYS.mallory)).toBe(false);
  });
});

describe("§C2: two replacements naming one predecessor, and revocation before force", () => {
  // What replaced the qualification window. Force is the effective index, so
  // there is nothing for a successor to qualify for, and the usable-candidate
  // walk retires with the stage it fenced. The rule left is one sentence — a
  // later replacement at a link supersedes an earlier one only where it was
  // witnessed strictly before the earlier's effective index.
  //
  // **Two of that family were NOT fences and did not retire**, which this block
  // once claimed they did: the strictly-before boundary and the first-witnessing
  // dedup are both live, and the tests below hold them. The SAME-INDEX TIE was
  // open when this block was written — two witnessed at one index resolved by
  // arrival order, so two readers could disagree about a past index — and it
  // is closed now: they resolve to the lesser record hash, grindable by the
  // rule-holder and priced as such (the walk's docstring; DECISIONS.md). This
  // comment said "still open" for a slice longer than it was true (found by the
  // slice-37 panel's inventory angle).

  it("naming the incumbent is not a handover, and does not freeze the chain", () => {
    const { venue, backing } = setup();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SECRETS.operator, backing.name, 6n));
    at(venue, 8n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, THIRD_SECRET, backing.name, 9n));
    at(venue, 9n);
    expect(operatorAt(backing, venue, 9n)).toEqual(THIRD);
  });

  it("re-naming the incumbent revokes a successor not yet in force", () => {
    // The rule-holder's way to take back a handover it regrets. It has to reach
    // the record before the successor's effective index, which is what the lead
    // time is for on both sides.
    const { venue, backing } = setup();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 20n));
    at(venue, 9n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SECRETS.operator, backing.name, 10n));

    at(venue, 25n);
    expect(operatorAt(backing, venue, 25n)).toEqual(KEYS.operator);
    expect(isAnOperator(backing, venue, SUCCESSOR)).toBe(false);
  });

  it("recovers the link after a revocation: a successor named next takes force", () => {
    // The property audit-B-3 was about — naming somebody who never serves must
    // not end the chain — reached without the window machinery.
    const { venue, backing } = setup();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 20n));
    at(venue, 9n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SECRETS.operator, backing.name, 10n));
    at(venue, 15n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, THIRD_SECRET, backing.name, 30n));

    at(venue, 30n);
    expect(operatorAt(backing, venue, 30n)).toEqual(THIRD);
  });

  it("ignores one witnessed after the standing candidate took force", () => {
    // Past its effective index the successor IS the incumbent, and replacing it
    // is a replacement naming it. Admitting this one would move force at an
    // index a reader has already read.
    const { venue, backing } = setup();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 10n));
    at(venue, 10n);
    expect(operatorAt(backing, venue, 10n)).toEqual(SUCCESSOR);

    at(venue, 12n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, THIRD_SECRET, backing.name, 14n));
    at(venue, 14n);
    expect(operatorAt(backing, venue, 14n)).toEqual(SUCCESSOR);
    expect(operatorAt(backing, venue, 10n)).toEqual(SUCCESSOR);
  });

  it("ignores one witnessed AT the standing candidate's effective index, not only after it", () => {
    // The boundary itself, which nothing exercised. §C2: a later replacement
    // supersedes "where it was witnessed STRICTLY BEFORE the earlier one's
    // effective index", and "one witnessed AT or after that index names a link
    // the chain has already left". At the index force arrives the successor is
    // the incumbent, so a replacement naming its predecessor is too late by one.
    //
    // The test reads the same past index on both sides of the publication,
    // because the property the strictness buys is that no reading ever moves.
    const { venue, backing } = setup();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 20n));
    at(venue, 20n);
    expect(operatorAt(backing, venue, 20n)).toEqual(SUCCESSOR);

    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, THIRD_SECRET, backing.name, 21n));
    // Read from further on, so index 20 really is a PAST index on the second
    // read: the property strictness buys is that a settled reading cannot move,
    // and reading it only at `now` does not show that.
    at(venue, 25n);
    expect(operatorAt(backing, venue, 20n)).toEqual(SUCCESSOR);
    expect(operatorAt(backing, venue, 25n)).toEqual(SUCCESSOR);
    expect(isAnOperator(backing, venue, THIRD)).toBe(false);
  });

  it("does not seat a chain running backwards: a candidate effective before the link it names took force is void", () => {
    // A replacement naming the successor's own link, dated BEHIND the index that
    // successor takes force at. It can never take force — two operators would be
    // in force at one index and the chain would run backwards — so it is void
    // rather than superseding, and the rule-holder's mistake gets no more effect
    // than its intent.
    const { venue, backing } = setup();
    at(venue, 3n);
    const first = replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 10n);
    venue.publishReplacement(backing.name, first);
    const link = replacementHash(backing.name, first);
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, THIRD_SECRET, link, 7n));
    // **Void, not superseding**, which is the half the single-candidate fixture
    // could not show: a later good candidate at the same link must still be
    // seated. Letting the void one block the link would hand the rule-holder's
    // mistake more effect than its intent — and that variant passes every other
    // test in this file.
    at(venue, 8n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, FOURTH_SECRET, link, 30n));

    at(venue, 20n);
    // Before the real handover the genesis operator still governs; after it, the
    // successor does. Neither index reads as the party dated behind them both.
    expect(operatorAt(backing, venue, 8n)).toEqual(KEYS.operator);
    expect(operatorAt(backing, venue, 20n)).toEqual(SUCCESSOR);

    at(venue, 40n);
    expect(operatorsOf(backing, venue)).toHaveLength(3);
    expect(operatorAt(backing, venue, 40n)).toEqual(FOURTH);
    expect(isAnOperator(backing, venue, THIRD)).toBe(false);
  });

  it("a stranger republishing the rule-holder's own record does not undo a revocation", () => {
    // A candidate is dated by its FIRST witnessing. A replacement is one act of
    // the rule-holder, and `publishReplacement` verifies no signature, so anyone
    // may republish its bytes for free. Without the dedup the replay is a second
    // candidate witnessed late enough to supersede the revocation that passed the
    // original over — and a party holding no key at all reinstates an operator
    // the rule-holder took back.
    const { venue, backing } = setup();
    at(venue, 5n);
    const heir = replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 20n);
    venue.publishReplacement(backing.name, heir);
    // A revocation, in this file's sense and the code's: re-naming the
    // INCUMBENT. An ordinary supersession would leave the replay undoing a
    // superseded candidate rather than a live revocation, which is the milder
    // harm and not the one this test's name claims.
    at(venue, 12n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SECRETS.operator, backing.name, 13n));

    at(venue, 15n);
    venue.publishReplacement(backing.name, heir);

    at(venue, 30n);
    expect(operatorAt(backing, venue, 30n)).toEqual(KEYS.operator);
    expect(isAnOperator(backing, venue, SUCCESSOR)).toBe(false);
  });

  it("a passed-over candidate may prepare and never serve: named is a permission, force is the chain's alone", () => {
    // isNamedSuccessor survives the change: it is the authorization half, and
    // it still answers true for a candidate the rule-holder went on to revoke.
    const { venue, backing } = setup();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 20n));
    at(venue, 9n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SECRETS.operator, backing.name, 10n));

    expect(isNamedSuccessor(backing, venue, SUCCESSOR)).toBe(true);
    at(venue, 25n);
    expect(operatorAt(backing, venue, 25n)).toEqual(KEYS.operator);
  });
});

describe("§C2: a replacement counts only on the terms E set", () => {
  it("counts nothing where E declares no replacement rule", () => {
    // §C2b: "Whether a sequencer can be replaced at all is answered in E."
    const { venue, backing } = setup(false);
    const replaceable = setup(true).backing;
    // Signed correctly for the OTHER backing's rule, and published here.
    venue.publishReplacement(
      backing.name,
      replacementBy(replaceable, SECRETS.backer, SUCCESSOR_SECRET, replaceable.name, 0n),
    );
    commitAs(venue, SUCCESSOR_SECRET);
    at(venue, 10n);
    expect(operatorAt(backing, venue, 10n)).toEqual(KEYS.operator);
  });

  it("ignores a replacement signed by anyone but the rule's key", () => {
    const { venue, backing } = setup();
    venue.publishReplacement(
      backing.name,
      replacementBy(backing, SECRETS.mallory, SUCCESSOR_SECRET, backing.name, 0n),
    );
    commitAs(venue, SUCCESSOR_SECRET);
    at(venue, 10n);
    expect(operatorAt(backing, venue, 10n)).toEqual(KEYS.operator);
  });

  it("ignores a replacement that names the wrong predecessor", () => {
    // The chain is hash-linked, so a link that attaches to nothing is not a
    // link. Walking backwards from any replacement reaches the original terms
    // or nothing at all.
    const { venue, backing } = setup();
    venue.publishReplacement(
      backing.name,
      // Dated past the void rule and the floor, so the predecessor filter is
      // the refusal (a pre-existing fixture the review's inventory angle found
      // refused by the void rule before its own rule was reached).
      replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, new Uint8Array(32).fill(0xee), 1n),
    );
    commitAs(venue, SUCCESSOR_SECRET);
    at(venue, 10n);
    expect(operatorAt(backing, venue, 10n)).toEqual(KEYS.operator);
  });

  it("refuses a replacement effective before it was itself witnessed", () => {
    // §C2: "Its effective index is no earlier than the index at which it is
    // itself witnessed." The rule-holder does not get to backdate a handover,
    // which would put two operators in force at one past index.
    const { venue, backing } = setup();
    at(venue, 50n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 49n));
    commitAs(venue, SUCCESSOR_SECRET);
    at(venue, 60n);
    expect(operatorAt(backing, venue, 60n)).toEqual(KEYS.operator);
  });

  it("refuses a handover to the incumbent itself", () => {
    // Dated past the floor (slice 38), so the walk's own rule is what refuses
    // it — the review's inventory angle found the floor reaching this fixture
    // first and the rule with one killer fewer.
    const { venue, backing } = setup();
    at(venue, 5n);
    venue.publishReplacement(
      backing.name,
      replacementBy(backing, SECRETS.backer, SECRETS.operator, backing.name, 6n),
    );
    commitAs(venue, SECRETS.operator);
    at(venue, 10n);
    expect(operatorsOf(backing, venue)).toHaveLength(1);
  });

  it("takes the earliest witnessed where the rule-holder signed two successors", () => {
    // Two replacements naming one predecessor are the rule-holder choosing
    // twice, and the one it published first is the one it chose first —
    // witnessing pins order (§C2), the rule two requests at one nonce follow —
    // provided it QUALIFIED in its window: it committed strictly before the
    // second was witnessed (the dead-successor rule, below).
    const { venue, backing } = setup();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 6n));
    at(venue, 6n);
    commitAs(venue, SUCCESSOR_SECRET);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, THIRD_SECRET, backing.name, 7n));
    at(venue, 7n);
    commitAs(venue, THIRD_SECRET);
    at(venue, 20n);
    expect(operatorAt(backing, venue, 20n)).toEqual(SUCCESSOR);
  });
});

describe("§C2: the grade follows the incumbent", () => {
  it("measures silence on the operator in force, not the key E names", () => {
    const { venue, backing } = setup();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 6n));
    at(venue, 6n);
    commitAs(venue, SUCCESSOR_SECRET);
    // The genesis operator has published nothing at all and would be silent;
    // the successor just committed, so the backing is not.
    expect(operatorAt(backing, venue, venue.witnessedIndex())).toEqual(SUCCESSOR);
    expect(isSilent(venue, backing)).toBe(false);
    expect(isOverdue(venue, backing)).toBe(false);
  });

  it("grades the successor once IT goes quiet", () => {
    const { venue, backing } = setup();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 6n));
    at(venue, 6n);
    commitAs(venue, SUCCESSOR_SECRET);
    at(venue, 6n + SILENCE.noCommitmentDuration + 1n);
    expect(operatorAt(backing, venue, venue.witnessedIndex())).toEqual(SUCCESSOR);
    expect(isSilent(venue, backing)).toBe(true);
  });
});

describe("§C2: the venue records a replacement and judges nothing", () => {
  it("refuses a replacement whose bytes do not encode", () => {
    const { venue, backing } = setup();
    expect(() =>
      venue.publishReplacement(backing.name, {
        role: ROLE_OPERATOR,
        successor: new Uint8Array(31),
        predecessor: backing.name,
        effective: 0n,
        signature: new Uint8Array(64),
        successorSignature: new Uint8Array(64),
      }),
    ).toThrow(VenueError);
    expect(venue.replacementsFor(backing.name)).toHaveLength(0);
  });

  it("hands out copies, in and out", () => {
    // Its own copy of the key, because this test mutates what it hands over and
    // SUCCESSOR is shared across the file.
    const { venue, backing } = setup();
    const published = replacementBy(backing, SECRETS.backer, Uint8Array.from(SUCCESSOR_SECRET), backing.name, 0n);
    venue.publishReplacement(backing.name, published);
    published.successor.fill(0xff);
    const first = venue.replacementsFor(backing.name)[0]!.replacement;
    expect(first.successor).toEqual(SUCCESSOR);
    first.successor.fill(0xff);
    expect(venue.replacementsFor(backing.name)[0]!.replacement.successor).toEqual(SUCCESSOR);
  });

  it("carries a successor that has never committed, once its index has come", () => {
    const { venue, backing } = setup();
    // Witnessed at 1, effective 2: the least lead this venue's floor allows
    // (slice 38 — one more than its lag of zero), and past the incumbent's
    // force at 0 as §C2's strictly-later rule requires. The earliest a
    // genesis handover can land here is index 2.
    at(venue, 1n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 2n));
    at(venue, 2n);
    // Published, co-signed, and its index come — so it is in force now. Under
    // the retired rule this same record left the successor outside the chain
    // until it published a commitment of its own, which is what let a key that
    // never touched the backing be seated by its own unrelated business.
    expect(venue.replacementsFor(backing.name)).toHaveLength(1);
    expect(operatorAt(backing, venue, 2n)).toEqual(SUCCESSOR);
    expect(isAnOperator(backing, venue, SUCCESSOR)).toBe(true);
    expect(venue.firstCommitmentFor(SUCCESSOR)).toBeUndefined();
  });
});

describe("§C2: a successor serves, and only once it is in force", () => {
  /** The incumbent, holding Alice's 100 with 40 already moved to Bob. */
  function incumbentServing(venue: LocalVenue, backing: Backing) {
    const server = new Sequencer(SECRETS.operator, venue);
    server.register(backing, signBacking(SECRETS.backer, backing));
    const issue = { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n };
    const issued = server.submitIssue(
      issue,
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    server.submitTransfer(
      { backing, from: KEYS.alice, to: KEYS.bob, quantity: 40n, nonce: 0n },
      ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, KEYS.bob, 40n, 0n), SECRETS.alice),
    );
    const { commitment } = server.commit();
    return { server, issued, served: { snapshots: server.snapshot(), commitment } };
  }

  // Witnessed at 5, effective at 8. The lead time is what the successor takes
  // the predecessor's committed state on in (§C2), and it is the window every
  // test below that serves "before force" lives in.
  const HANDOVER_AT = 8n;

  function handedOver() {
    const { venue, backing } = setup();
    const incumbent = incumbentServing(venue, backing);
    at(venue, 5n);
    venue.publishReplacement(
      backing.name,
      replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, HANDOVER_AT),
    );
    const successor = new Sequencer(SUCCESSOR_SECRET, venue);
    successor.register(backing, signBacking(SECRETS.backer, backing));
    return { venue, backing, incumbent, successor };
  }

  it("lets a named successor serve before it is in force, and refuses its receipts", () => {
    // §C2's two stages have a gap somebody has to live in: force comes from the
    // successor's own first commitment, and it cannot commit a state it was
    // never allowed to take on. So it may serve, and "no new co-signatures
    // issue" until it is in force.
    const { venue, backing, incumbent, successor } = handedOver();
    expect(operatorAt(backing, venue, venue.witnessedIndex())).toEqual(KEYS.operator);
    successor.takeOver(backing, incumbent.served);
    expect(() =>
      successor.submitTransfer(
        { backing, from: KEYS.alice, to: KEYS.carol, quantity: 10n, nonce: 1n },
        ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, KEYS.carol, 10n, 1n), SECRETS.alice),
      ),
    ).toThrow(SequencerError);
  });

  it("takes force at the effective index, carrying the state it took over", () => {
    const { venue, backing, incumbent, successor } = handedOver();
    // Taken over in the lead time, which is what the lead time is for, and in
    // force at the declared index without publishing anything.
    successor.takeOver(backing, incumbent.served);
    at(venue, HANDOVER_AT);

    expect(operatorAt(backing, venue, venue.witnessedIndex())).toEqual(SUCCESSOR);
    expect(successor.balance(backing, KEYS.alice)).toBe(60n);
    expect(successor.balance(backing, KEYS.bob)).toBe(40n);
    expect(successor.outstanding(backing)).toBe(100n);
    // And it serves: the next operation is the claimant's next nonce, on the
    // state the predecessor left.
    const receipt = successor.submitTransfer(
      { backing, from: KEYS.alice, to: KEYS.carol, quantity: 10n, nonce: 1n },
      ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, KEYS.carol, 10n, 1n), SECRETS.alice),
    );
    expect(receipt.position).toBe(2n);
  });

  it("stops the predecessor co-signing once the handover has happened", () => {
    // "From the effective index the old attester's co-signatures stop counting."
    // Refused at the source as well as discounted by a reader.
    const { venue, backing, incumbent, successor } = handedOver();
    successor.takeOver(backing, incumbent.served);
    at(venue, HANDOVER_AT);
    successor.commit();
    expect(operatorAt(backing, venue, venue.witnessedIndex())).toEqual(SUCCESSOR);
    expect(() =>
      incumbent.server.submitTransfer(
        { backing, from: KEYS.alice, to: KEYS.carol, quantity: 10n, nonce: 1n },
        ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, KEYS.carol, 10n, 1n), SECRETS.alice),
      ),
    ).toThrow(SequencerError);
  });

  it("keeps the predecessor's receipts good against both committed states", () => {
    // A receipt records an operation and a position and never when it was
    // signed, so a retired operator's co-signature over an operation its own log
    // really held stays evidence of what it accepted. And the successor's log
    // holds the same entries at the same positions, because it took them on.
    const { venue, backing, incumbent, successor } = handedOver();
    successor.takeOver(backing, incumbent.served);
    at(venue, HANDOVER_AT);
    successor.commit();
    const theirs = { snapshots: successor.snapshot(), commitment: venue.latestFor(SUCCESSOR)! };

    expect(receiptStatus(backing, venue, incumbent.issued, incumbent.served)).toBe("witnessed");
    expect(receiptStatus(backing, venue, incumbent.issued, theirs)).toBe("witnessed");
    expect(stateIsAuthentic(backing, venue, theirs)).toBe(true);
  });

  it("reads an honest handover as no rewritten history", () => {
    // The successor's log starts where the predecessor's committed state left
    // off, so comparing across a handover must not report a takeover as a
    // rewrite — which is why the predicate is about one operator's own history.
    const { venue, backing, incumbent, successor } = handedOver();
    successor.takeOver(backing, incumbent.served);
    at(venue, HANDOVER_AT);
    successor.commit();
    const theirs = { snapshots: successor.snapshot(), commitment: venue.latestFor(SUCCESSOR)! };
    expect(isRewrittenHistory(backing, venue, incumbent.served, theirs)).toBe(false);
  });

  it("refuses a state nobody committed, and re-takes the pinned state as a no-op", () => {
    const { venue, backing, incumbent, successor } = handedOver();
    // A state nobody committed.
    expect(() =>
      successor.takeOver(backing, {
        snapshots: incumbent.served.snapshots,
        commitment: signCommitment(SECRETS.mallory, 0n, stateRoot(incumbent.served.snapshots)),
      }),
    ).toThrow(SequencerError);
    // And once in force and committed, re-taking the pinned state is ordinary
    // re-syncing with an empty delta, not an error (35d retired the one-shot
    // rule): the book already carries it, and nothing changes.
    successor.takeOver(backing, incumbent.served);
    at(venue, HANDOVER_AT);
    const own = successor.commit();
    const before = successor.opLog(backing).length;
    successor.takeOver(backing, own);
    expect(successor.opLog(backing)).toHaveLength(before);
    // "No-op" is a claim about serving, not a log length (the slice-36
    // round's B1): still seated, still serving.
    expect(successor.awaitingTakeover()).toHaveLength(0);
  });

  it("refuses a sequencer that is neither in force nor named", () => {
    const { venue, backing } = setup();
    const stranger = new Sequencer(THIRD_SECRET, venue);
    expect(() => stranger.register(backing, signBacking(SECRETS.backer, backing))).toThrow(
      SequencerError,
    );
  });
});

describe("§C2: a successor that does not serve the state in full", () => {
  it("is a rewritten history, even though the log is not its own", () => {
    // §C2 gives a successor force only over a state "it serves in full". A
    // successor committing a shorter log than the predecessor's is the same
    // fault by the party the chain just handed the backing to — so the
    // predicate has to reach across a handover, and the chain is what orders
    // the two states, since a sequence is an operator's own count.
    const { venue, backing } = setup();
    const incumbent = new Sequencer(SECRETS.operator, venue);
    incumbent.register(backing, signBacking(SECRETS.backer, backing));
    incumbent.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    const served = incumbent.commit();

    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 6n));
    at(venue, 6n);
    // The successor, in force, commits an EMPTY log for this backing rather
    // than the one it was handed.
    const dropped = [{ name: backing.name, opLog: [] }];
    const theirs = {
      snapshots: dropped,
      commitment: signCommitment(SUCCESSOR_SECRET, 0n, stateRoot(dropped)),
    };
    venue.publish(theirs.commitment);

    expect(operatorAt(backing, venue, venue.witnessedIndex())).toEqual(SUCCESSOR);
    expect(isRewrittenHistory(backing, venue, served, theirs)).toBe(true);
    expect(isRewrittenHistory(backing, venue, theirs, served)).toBe(true);
  });
});

describe("§C2: a takeover is all or nothing", () => {
  it("refuses a committed state that is not a history that could have happened", () => {
    // committedLogFor checks the root and the signature and does not replay the
    // law. Applied entry by entry, a well-rooted log that goes wrong part-way
    // would leave a truncated state this operator then commits — which is the
    // fault isRewrittenHistory watches a handover for, committed by the party
    // that was handed the backing.
    const { venue, backing } = setup();
    const incumbent = new Sequencer(SECRETS.operator, venue);
    incumbent.register(backing, signBacking(SECRETS.backer, backing));
    incumbent.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    const honest = incumbent.snapshot()[0]!;
    // A second entry the law would refuse: Alice spending more than she holds.
    const overspend = {
      kind: "transfer" as const,
      from: KEYS.alice,
      to: KEYS.bob,
      quantity: 500n,
      nonce: 0n,
      position: 1,
      signature: ed25519.sign(
        encodeTransferMessage(backing.name, KEYS.alice, KEYS.bob, 500n, 0n),
        SECRETS.alice,
      ),
    };
    const snapshots = [{ name: backing.name, opLog: [honest.opLog[0]!, overspend] }];
    const rooted = {
      snapshots,
      commitment: signCommitment(SECRETS.operator, venue.nextSequenceFor(KEYS.operator), stateRoot(snapshots)),
    };
    venue.publish(rooted.commitment);

    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 6n));
    const successor = new Sequencer(SUCCESSOR_SECRET, venue);
    successor.register(backing, signBacking(SECRETS.backer, backing));

    expect(() => successor.takeOver(backing, rooted)).toThrow(SequencerError);
    // And nothing of it stuck, so an honest state can still be taken over.
    expect(successor.opLog(backing)).toHaveLength(0);
  });
});

describe("§C2: a retired operator still answers a repeat, and refuses a new act", () => {
  it("a lock it co-signed before the handover is answered with its receipt afterwards; a fresh lock is refused", () => {
    // A repeat is a read of the receipt book, not an act: the co-signature was
    // given while the operator was in force, and the successor cannot produce
    // it — so refusing to re-serve it would deny the payee the only evidence of
    // what happened (invariant 26; CLAUDE.md's receipt rule). "No new
    // co-signatures issue" is about acts, which `ready` refuses. Slice 27's
    // review first put the in-force check ahead of the repeat and then reversed
    // it, for this reason.
    const { venue, backing } = setup();
    const incumbent = new Sequencer(SECRETS.operator, venue);
    incumbent.register(backing, signBacking(SECRETS.backer, backing));
    incumbent.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    const salt = new Uint8Array(32).fill(0x4e);
    const lock = {
      backing,
      attemptId: attemptIdOf(salt, venue.id, 500n, [KEYS.alice]),
      salt,
      holder: KEYS.alice,
      beneficiary: KEYS.bob,
      quantity: 10n,
      timeout: 500n,
      decisionVenue: venue.id,
      parties: [KEYS.alice],
      nonce: 0n,
    };
    const signature = ed25519.sign(encodeLock(lock), SECRETS.alice);
    const receipt = incumbent.submitLock(lock, signature);
    const served = incumbent.commit();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 8n));
    const successor = new Sequencer(SUCCESSOR_SECRET, venue);
    successor.register(backing, signBacking(SECRETS.backer, backing));
    successor.takeOver(backing, served);
    at(venue, 8n);
    successor.commit();
    expect(operatorAt(backing, venue, venue.witnessedIndex())).toEqual(SUCCESSOR);
    // The repeat: the same receipt, from the retired operator's own book.
    expect(incumbent.submitLock(lock, signature)).toEqual(receipt);
    // A new act: refused.
    const fresh = { ...lock, attemptId: new Uint8Array(32).fill(0x4f), nonce: 1n };
    expect(() => incumbent.submitLock(fresh, ed25519.sign(encodeLock(fresh), SECRETS.alice))).toThrow(/not yet in force/);
  });
});

describe("§C2: a publication is judged against the record that governed at its index", () => {
  // Found by the 2026-08-22 audit. Both gap readers asked for the operator in
  // force AT the publication's index and then looked strictly BEFORE it — so at
  // the index a successor takes force it had nothing before, the quiet time
  // read from the venue's genesis, and an orderly handover opened one gap index
  // in which the operator adopted legs no verifier could resolve. The operator
  // in force just before the index is whose record governed: "Until then the
  // predecessor's last commitment governs."
  function punctualThenHandedOver(lastCommit: bigint, handoverAt: bigint) {
    const { venue, backing } = setup();
    const incumbent = new Sequencer(SECRETS.operator, venue);
    incumbent.register(backing, signBacking(SECRETS.backer, backing));
    incumbent.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    let served = incumbent.commit();
    for (let i = 5n; i <= lastCommit; i += 5n) {
      at(venue, i);
      served = incumbent.commit();
    }
    // Published where the venue already stands, effective at the handover
    // index: the gap between the two is §C2's lead time, and it is what the
    // successor takes the predecessor's state on in.
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, handoverAt));
    const successor = new Sequencer(SUCCESSOR_SECRET, venue);
    successor.register(backing, signBacking(SECRETS.backer, backing));
    successor.takeOver(backing, served);
    at(venue, handoverAt);
    successor.commit();
    expect(operatorAt(backing, venue, handoverAt)).toEqual(SUCCESSOR);
    return { venue, backing, served, successor };
  }
  const legsAt = (venue: LocalVenue, backing: Backing, index: bigint) => {
    const demand = { backing, holder: KEYS.alice, quantity: 40n, instant: index, deadline: index + 50n, nonce: 0n };
    venue.publishOp(backing.name, {
      kind: "demand",
      holder: demand.holder,
      quantity: demand.quantity,
      instant: demand.instant,
      deadline: demand.deadline,
      nonce: demand.nonce,
      signature: ed25519.sign(encodeDemand(demand), SECRETS.alice),
    });
    return demandHash(demand);
  };

  it("an orderly handover from a punctual operator opens no gap at the successor's force index", () => {
    const { venue, backing, successor } = punctualThenHandedOver(30n, 31n);
    legsAt(venue, backing, 31n);
    expect(isSilent(venue, backing)).toBe(false);
    expect(gapLegsFor(venue, backing)).toEqual([]);
    venue.advance(1n); // one commitment per witnessed index (28b: eras end legibly)
    successor.commit();
    expect(successor.openDemands(backing)).toHaveLength(0);
  });

  it("legs published at the force index of a successor to a SILENT predecessor resolve against the predecessor's last snapshot, for the verifier as for the operator", () => {
    const { venue, backing, served, successor } = punctualThenHandedOver(0n, 20n);
    const hash = legsAt(venue, backing, 20n);
    // The backer's nonce 0 went on the issuance; its answer is its next.
    const answer = { backing, demandHash: hash, instant: 20n, deadline: 60n, nonce: 1n };
    venue.publishOp(backing.name, {
      kind: "acceptance",
      demandHash: hash,
      instant: answer.instant,
      deadline: answer.deadline,
      nonce: answer.nonce,
      signature: ed25519.sign(encodeAcceptance(answer), SECRETS.backer),
    });
    const settle = { backing, demandHash: hash, holder: KEYS.alice, nonce: 1n };
    venue.publishOp(backing.name, {
      kind: "release",
      demandHash: hash,
      holder: KEYS.alice,
      nonce: settle.nonce,
      signature: ed25519.sign(encodeRelease(settle), SECRETS.alice),
    });
    // The verifier, against the predecessor's last commitment — the record that governed.
    expect(snapshotRedemptions(venue, backing, served)).toHaveLength(1);
    // The operator, adopting.
    venue.advance(1n); // one commitment per witnessed index (28b: eras end legibly)
    successor.commit();
    expect(successor.balance(backing, KEYS.backer)).toBe(40n);
    expect(successor.openDemands(backing)).toHaveLength(0);
  });
});

describe("§C2: what a door asks of a backing it touches, and of one it only reads", () => {
  it("a filing is not refused for the operator's force on the PAYING backing, which the filing never touches", () => {
    // Found regression-reviewing slice 27: readying every slot backing at filing
    // asked in-force of the paying backing — handed to a successor, and only
    // it — and refused an honest filing the never-served operator would take.
    // The paying lock arrives at the acceptance; the filing only reads the slot.
    const { venue, backing: gold } = setup();
    const eur = makeBacking({
      obligor: KEYS.backer,
      payout: { backing: gold.name, perUnit: 2n },
      reliance: [],
      evidence: { setting: "transparent", operator: KEYS.operator, silence: SILENCE, replacementRule: KEYS.backer },
    });
    const incumbent = new Sequencer(SECRETS.operator, venue);
    for (const b of [gold, eur]) incumbent.register(b, signBacking(SECRETS.backer, b));
    incumbent.submitIssue(
      { backing: eur, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(eur.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    incumbent.commit();
    // GOLD, and only GOLD, goes to a successor that takes force.
    at(venue, 5n);
    venue.publishReplacement(gold.name, replacementBy(gold, SECRETS.backer, SUCCESSOR_SECRET, gold.name, 6n));
    at(venue, 6n);
    commitAs(venue, SUCCESSOR_SECRET);
    expect(operatorAt(gold, venue, venue.witnessedIndex())).toEqual(SUCCESSOR);
    expect(operatorAt(eur, venue, venue.witnessedIndex())).toEqual(KEYS.operator);
    const demand = { backing: eur, holder: KEYS.alice, quantity: 40n, instant: 0n, deadline: 100n, nonce: 0n };
    incumbent.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice));
    expect(incumbent.openDemands(eur)).toHaveLength(1);
  });

  it("a successor refuses to take over a state carrying a lock on a decision venue it does not watch", () => {
    // Found reviewing the audit slice: taken over, such a lock made the successor
    // refuse at every door forever — adoption asked a record that was not the
    // lock's. The gate asks this of every lock it prepares; takeOver is the one
    // other path that applies many operations.
    const { venue, backing } = setup();
    const other = new LocalVenue(new Uint8Array(32).fill(0x6c));
    const incumbent = new Sequencer(SECRETS.operator, venue);
    incumbent.register(backing, signBacking(SECRETS.backer, backing));
    incumbent.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    const lockSalt = new Uint8Array(32).fill(0x3a);
    const lock = { backing, attemptId: attemptIdOf(lockSalt, venue.id, 500n, [KEYS.alice]), salt: lockSalt, holder: KEYS.alice, beneficiary: KEYS.bob, quantity: 10n, timeout: 500n, decisionVenue: venue.id, parties: [KEYS.alice], nonce: 0n };
    incumbent.submitLock(lock, ed25519.sign(encodeLock(lock), SECRETS.alice));
    const served = incumbent.commit();
    other.publish(served.commitment);
    at(venue, 5n); at(other, 5n);
    // Effective ahead of witnessing, so both takeovers happen in the lead time.
    const replacement = replacementBy(backing, SECRETS.backer, SUCCESSOR_SECRET, backing.name, 9n);
    venue.publishReplacement(backing.name, replacement);
    other.publishReplacement(backing.name, replacement);
    // On the venue the lock names: fine. On another: refused, in the sequencer's voice.
    const onVenue = new Sequencer(SUCCESSOR_SECRET, venue);
    onVenue.register(backing, signBacking(SECRETS.backer, backing));
    onVenue.takeOver(backing, served);
    const onOther = new Sequencer(SUCCESSOR_SECRET, other);
    onOther.register(backing, signBacking(SECRETS.backer, backing));
    expect(() => onOther.takeOver(backing, served)).toThrow(/does not watch/);
  });
});

describe("§C2: a re-prepare is written against the demanded backing's record, so that record must be this operator's", () => {
  it("a handed-over operator reading its stale record refuses to re-prepare under a demand the successor now holds", () => {
    // Found in the audit slice's last regression pass: caught up but not asked
    // in-force of the demanded backing, the old operator took a lock under a
    // demand the successor had ended, reading its own stale record.
    const { venue, backing: gold } = setup();
    const eur = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
      reliance: [{ target: gold.name, count: 2n }],
      evidence: { setting: "transparent", operator: KEYS.operator, silence: SILENCE, replacementRule: KEYS.backer },
    });
    const old = new Sequencer(SECRETS.operator, venue);
    for (const b of [gold, eur]) {
      old.register(b, signBacking(SECRETS.backer, b));
      old.submitIssue(
        { backing: b, recipient: KEYS.alice, quantity: 200n, nonce: 0n },
        ed25519.sign(encodeIssuanceMessage(b.name, KEYS.alice, 200n, 0n), SECRETS.backer),
      );
    }
    const demand = { backing: eur, holder: KEYS.alice, quantity: 40n, instant: 0n, deadline: 100n, nonce: 0n };
    const hash = demandHash(demand);
    const leg = { backing: gold, attemptId: hash, holder: KEYS.alice, beneficiary: KEYS.backer, quantity: 80n, timeout: 10n, decisionVenue: NO_DECISION_VENUE, parties: [KEYS.alice], nonce: 0n };
    old.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice), [{ op: leg, signature: ed25519.sign(encodeLock(leg), SECRETS.alice) }]);
    old.commit();
    // EUR — and only EUR — goes to a successor, which takes force.
    at(venue, 20n);
    venue.publishReplacement(eur.name, replacementBy(eur, SECRETS.backer, SUCCESSOR_SECRET, eur.name, 21n));
    at(venue, 21n);
    commitAs(venue, SUCCESSOR_SECRET);
    expect(operatorAt(eur, venue, venue.witnessedIndex())).toEqual(SUCCESSOR);
    // The old operator has been quiet past GOLD's duration: it commits before it
    // serves GOLD again, from the next index (c2b-return-from-silence).
    old.commit();
    at(venue, 22n);
    // The lapsed leg is withdrawn at the old operator (still GOLD's).
    const out = { backing: gold, demandHash: hash, holder: KEYS.alice, nonce: 1n };
    old.submitWithdrawal(out, ed25519.sign(encodeWithdrawal(out), SECRETS.alice));
    // Re-preparing under the demand at the old operator: refused — EUR is not its to read.
    const again = { ...leg, timeout: 500n, nonce: 2n };
    expect(() => old.submitLeg(eur, hash, { op: again, signature: ed25519.sign(encodeLock(again), SECRETS.alice) })).toThrow(/not yet in force/);
    expect(old.availableBalance(gold, KEYS.alice)).toBe(200n);
  });
});
