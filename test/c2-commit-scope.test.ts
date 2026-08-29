import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { compareBytes } from "../src/bytes.js";
import { committedLogFor, stateProvesCommitment, type ServedState } from "../src/commitment.js";
import { isRewrittenHistory } from "../src/fault.js";
import { encodeIssuanceMessage } from "../src/messages.js";
import {
  operatorAt,
  replacementMessage,
  ROLE_OPERATOR,
  type Replacement,
} from "../src/replacement.js";
import { Sequencer } from "../src/sequencer.js";
import { LocalVenue } from "../src/venue.js";
import { KEYS, pub, SECRETS } from "./support.js";

// **What a commitment carries** — §C2's "a root of ITS backings' commitments".
//
// `serves` is in force AND holding the book, and both halves are load-bearing:
//
//   - In force alone roots a book this operator may never have seen. §C2 seats a
//     successor at its effective index whether or not it took the state on.
//   - Holding the book alone roots it through the LEAD TIME, beside the
//     predecessor that is still serving — two operators asserting one log at one
//     index, which is exactly what a root is supposed to make impossible.
//
// The previous attempt at this rule (slice 33, retired) could not work, because
// it was written while force arrived on a successor's first commitment: the
// predicate read a fact that publishing changed, so it flipped mid-`commit` and
// the pair a verifier is handed did not prove itself. Force is a signed field
// now, so nothing `serves` reads is anything `commit` writes. See DECISIONS.md.

const SILENCE = { noCommitmentDuration: 50n, challengeWindow: 5n };
const NON_SERVICE = { duration: 10n, count: 2n, window: 100n };
const HEIR_SECRET = new Uint8Array(32).fill(0x0b);
const HEIR = pub(HEIR_SECRET);

function setup() {
  const venue = new LocalVenue();
  const make = (thing: string) =>
    makeBacking({
      obligor: KEYS.backer,
      payout: { thing, quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: {
        setting: "transparent",
        operator: KEYS.operator,
        silence: SILENCE,
        witnessing: { venue: venue.id, interval: 5n },
        nonService: NON_SERVICE,
        replacementRule: KEYS.backer,
      },
    });
  // Two backings under one operator — §C5's topology, and the reason the
  // question bites: the operator goes on serving one after handing over the
  // other, so its commitments keep coming.
  const eur = make("EUR");
  const usd = make("USD");
  const sequencer = new Sequencer(SECRETS.operator, venue);
  for (const backing of [eur, usd]) {
    sequencer.register(backing, signBacking(SECRETS.backer, backing));
    sequencer.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
  }
  return { venue, sequencer, eur, usd };
}

function handover(backing: Backing, effective: bigint): Replacement {
  const unsigned = {
    role: ROLE_OPERATOR,
    successor: HEIR,
    predecessor: backing.name,
    effective,
    signature: new Uint8Array(64),
    successorSignature: new Uint8Array(64),
  };
  const message = replacementMessage(backing.name, unsigned);
  return {
    ...unsigned,
    signature: ed25519.sign(message, SECRETS.backer),
    successorSignature: ed25519.sign(message, HEIR_SECRET),
  };
}

function at(venue: LocalVenue, index: bigint): void {
  const now = venue.witnessedIndex();
  if (index > now) venue.advance(index - now);
}

const carries = (state: ServedState, backing: Backing, venue: LocalVenue) =>
  committedLogFor(backing, venue, state)?.kind === "log";

describe("§C2: one operator asserts one book at one index", () => {
  it("leaves the book with the predecessor through the lead time", () => {
    // The heir has taken the state on and is not in force yet. If holding the
    // book were enough, both would root EUR at the same index.
    const { venue, sequencer, eur } = setup();
    const before = sequencer.commit();
    at(venue, 5n);
    venue.publishReplacement(eur.name, handover(eur, 20n));
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, before);

    at(venue, 10n);
    expect(operatorAt(eur, venue, 10n)).toEqual(KEYS.operator);
    expect(carries(sequencer.commit(), eur, venue)).toBe(true);
    expect(carries(heir.commit(), eur, venue)).toBe(false);
  });

  it("moves it to the heir at the effective index, and off the predecessor", () => {
    const { venue, sequencer, eur, usd } = setup();
    const before = sequencer.commit();
    at(venue, 5n);
    venue.publishReplacement(eur.name, handover(eur, 20n));
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, before);

    at(venue, 20n);
    const theirs = heir.commit();
    const retired = sequencer.commit();
    expect(carries(theirs, eur, venue)).toBe(true);
    expect(carries(retired, eur, venue)).toBe(false);
    // And the one it was not replaced on is untouched.
    expect(carries(retired, usd, venue)).toBe(true);
  });

  it("hands the verifier a pair that proves itself", () => {
    // `commit` returns the snapshots it rooted, so the two cannot be separate
    // reads of a clock that moves between them.
    const { venue, sequencer, eur } = setup();
    const before = sequencer.commit();
    at(venue, 5n);
    venue.publishReplacement(eur.name, handover(eur, 20n));
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, before);

    at(venue, 20n);
    const retired = sequencer.commit();
    expect(stateProvesCommitment(retired.snapshots, retired.commitment)).toBe(true);
    expect(retired.snapshots.some((s) => compareBytes(s.name, eur.name) === 0)).toBe(false);
  });
});

describe("§C2: the cost the section states", () => {
  it("roots nothing for a backing the heir was seated on without taking the book", () => {
    // Force is the effective index, so a successor that never takes the state on
    // is seated holding nothing. §C2 says so and names the price.
    const { venue, sequencer, eur } = setup();
    sequencer.commit();
    at(venue, 5n);
    venue.publishReplacement(eur.name, handover(eur, 20n));
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));

    at(venue, 20n);
    expect(operatorAt(eur, venue, 20n)).toEqual(HEIR);
    expect(carries(heir.commit(), eur, venue)).toBe(false);
  });

  it("and answers for it, which the co-signature is what makes just", () => {
    // The heir is nameable here, and that is the difference the successor's own
    // signature buys: it agreed to the role. Naming a party that never signed
    // for a backing it never heard of is the conscription this rule closed.
    const { venue, sequencer, eur } = setup();
    const carrying = sequencer.commit();
    at(venue, 5n);
    venue.publishReplacement(eur.name, handover(eur, 20n));
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));

    at(venue, 20n);
    expect(isRewrittenHistory(eur, venue, carrying, heir.commit())).toBe(true);
  });
});
