import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { isRewrittenHistory } from "../src/fault.js";
import { encodeIssuanceMessage, encodeTransferMessage } from "../src/messages.js";
import {
  isNamedSuccessor,
  lastCommitmentInForce,
  operatorAt,
  replacementMessage,
  ROLE_OPERATOR,
  successionAhead,
  successionOf,
  termOf,
  type Replacement,
} from "../src/replacement.js";
import { Sequencer, SequencerError } from "../src/sequencer.js";
import { LocalVenue, type Venue } from "../src/venue.js";
import { chainAt, LaggingView } from "./lagging-view.js";
import { KEYS, pub, SECRETS } from "./support.js";

// §C2, slice 38: **a replacement's lead is floored at the venue's lag plus
// one.**
//
// The finding (slice 36's F4, re-measured by the slice-38 panel): a commitment
// the predecessor publishes at or past the effective index belongs to no term
// — not the book a successor takes on, placed by nothing, every fault
// predicate false — so a payment witnessed in it is dead and re-spendable.
// The rule-holder, the backer by default, could put the incumbent's newest
// commitment there for one record: dated its own index on a venue with no
// lag, or pre-armed by the finality depth on one that reads behind the chain,
// aimed at the cadence E declares. No boundary rule closes that without
// convicting an honest retiring operator or handing the retiring one an
// unprovable truncation; what closes it is NOTICE, and the notice a lead buys
// is measured in the venue's own lag — the least number of indices by which
// an act signed at the clock is witnessed after it.
//
//   - **The floor.** effective ≥ witnessed + 2·lag + 1, judged once per record
//     against the venue that answered it. A record below it is no replacement.
//     So every party reads the record by the last clock at which an act it
//     signs can still be witnessed in the incumbent's term — one index of
//     notice, at the venue's own speed.
//   - **What the parties do with it is theirs** (CLAUDE.md's party rule): the
//     incumbent commits at the first clock it can read the record and co-signs
//     nothing on or under the backing once the lag reaches the index; the
//     payee reads the same record. The slice first built that as a door, and
//     its review found the door a lever: a rule-holder held it shut, one
//     record per lag, by superseding each before it arrived, with nothing to
//     grade. A door shut only by its holder's own conduct is the shape a door
//     may have — and a rule can be declined where a door cannot: a party that
//     stops on every pending record can be stopped the same way, one that
//     reads a link re-armed as re-armed keeps serving at the price of one
//     window of dead co-signatures should the next record be real.
//
// The lagging double lands writes in the NEXT block, as a chain does: an act
// signed at clock c is witnessed at c + depth + 1. See DECISIONS.md, "Panel:
// the lead time" and the round that followed it.

const SILENCE = { noCommitmentDuration: 1000n, challengeWindow: 5n };
const HEIR_SECRET = new Uint8Array(32).fill(0x0b);
const HEIR = pub(HEIR_SECRET);
const RESCUER_SECRET = new Uint8Array(32).fill(0x0c);

function backingFor(venue: Venue, thing = "EUR"): Backing {
  return makeBacking({
    obligor: KEYS.backer,
    payout: { thing, quantumExponent: -2, perUnit: 100n },
    reliance: [],
    evidence: {
      setting: "transparent",
      operator: KEYS.operator,
      silence: SILENCE,
      witnessing: { venue: venue.id, interval: 5n },
      replacementRule: KEYS.backer,
    },
  });
}

/** A replacement co-signed by the rule-holder and the successor, over one message. */
function replacementBy(
  backing: Backing,
  successorSecret: Uint8Array,
  effective: bigint,
  predecessor: Uint8Array = backing.name,
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

/**
 * The incumbent serving `backing` on `venue`, with one issuance to Alice,
 * committed. The state is the commit's own return value, not `snapshot()`
 * afterwards: on a lagging view the seat reads stale until the commitment is
 * readable, and a stale seat serves nothing.
 */
function serving(venue: Venue, backing: Backing, chain?: LocalVenue) {
  const sequencer = new Sequencer(SECRETS.operator, venue);
  sequencer.register(backing, signBacking(SECRETS.backer, backing));
  // A process commits nothing until the venue's lag has passed since it
  // registered (slice 39), so that whatever it published before it died is
  // readable or gone. Zero-width on a venue with no lag, where these fixtures
  // pass no chain.
  if (chain !== undefined) {
    const start = venue.witnessedIndex();
    while (venue.witnessedIndex() < start + venue.lag()) {
      chainAt(chain, chain.witnessedIndex() + 1n);
    }
  }
  sequencer.submitIssue(
    { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
    ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
  );
  const state = sequencer.commit();
  return { sequencer, state };
}

function transferBy(
  backing: Backing,
  secret: Uint8Array,
  from: Uint8Array,
  to: Uint8Array,
  quantity: bigint,
  nonce: bigint,
) {
  return {
    op: { backing, from, to, quantity, nonce },
    signature: ed25519.sign(
      encodeTransferMessage(backing.name, from, to, quantity, nonce),
      secret,
    ),
  };
}

/**
 * The party rule, computed from the public readers alone: may an act signed
 * now still be witnessed in the term of the operator in force at the clock?
 * `successionAhead` carries the pending link, `lag()` the venue's constant.
 */
function actNow(backing: Backing, venue: Venue): boolean {
  const ahead = successionAhead(backing, venue);
  const tip = ahead[ahead.length - 1]!;
  const now = venue.witnessedIndex();
  return tip.from <= now || tip.from > now + venue.lag();
}

describe("§C2: a replacement's lead is floored at the venue's lag plus one", () => {
  it("a record effective at its own witnessing is no replacement, and one index later is, on a venue with no lag", () => {
    // LocalVenue's lag is zero — publication lands at the clock's own index —
    // so the floor is one: the record must precede the index it takes force
    // at. Below the floor the record is not refused as a bad handover; it is
    // not a handover at all, and nobody is named by it.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    serving(venue, eur);

    at(venue, 10n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 10n));
    expect(successionAhead(eur, venue)).toHaveLength(1);
    expect(isNamedSuccessor(eur, venue, HEIR)).toBe(false);
    at(venue, 20n);
    expect(operatorAt(eur, venue, 20n)).toEqual(KEYS.operator);

    // The honest path: the same rule-holder, the same successor, one index of
    // lead. A different effective index is a different record, so the memo's
    // dedup does not confuse the two.
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 21n));
    expect(isNamedSuccessor(eur, venue, HEIR)).toBe(true);
    at(venue, 21n);
    expect(operatorAt(eur, venue, 21n)).toEqual(HEIR);
  });

  it("the same-block erasure is refused: a record dated the index of the incumbent's newest commitment seats nobody, and the payment it carried stands", () => {
    // Slice 36's F4, run and closed. Carol is paid, the payment is committed
    // and witnessed at index 5 — final, by §C2's word — and the rule-holder
    // publishes in the same block a record naming a key it generated, effective
    // 5. Before the floor that put the commitment in no term: the book went
    // back one commitment, the successor took it over by the book, and alice's
    // nonce was free to spend again against carol, provably against nobody.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { sequencer: incumbent } = serving(venue, eur);

    at(venue, 5n);
    const paid = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.carol, 30n, 0n);
    incumbent.submitTransfer(paid.op, paid.signature);
    const { commitment: newest } = incumbent.commit();
    venue.publishReplacement(eur.name, replacementBy(eur, RESCUER_SECRET, 5n));

    // Nobody is seated; the newest commitment is the record's last, in term.
    const chain = successionOf(eur, venue);
    expect(chain).toHaveLength(1);
    expect(lastCommitmentInForce(chain, venue)?.commitment.sequence).toBe(newest.sequence);
    expect(termOf(chain, venue, KEYS.operator, newest.sequence)).toBe(0);
    const throwaway = new Sequencer(RESCUER_SECRET, venue);
    expect(() => throwaway.register(eur, signBacking(SECRETS.backer, eur))).toThrow(
      /does not serve that backing/,
    );

    // The incumbent serves on, carol's payment in its book, and alice's nonce
    // is spent: the re-spend the erasure bought is refused at the only door.
    expect(incumbent.balance(eur, KEYS.carol)).toBe(30n);
    const respend = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.mallory, 30n, 0n);
    expect(() => incumbent.submitTransfer(respend.op, respend.signature)).toThrow();
    const next = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 1n);
    expect(incumbent.submitTransfer(next.op, next.signature).position).toBe(2n);
  });

  it("a revocation dated at its own witnessing is no record, so the successor it meant to revoke takes force", () => {
    // The floor is read once per record, before any link is, so a self-naming
    // record — a revocation, exempt from the strictly-later rule at the
    // walk — is held to it like any other. Its index is otherwise inert as a
    // date: a self-naming candidate never becomes a link, and supersession is
    // decided by its witnessing. The width the exemption states is now
    // "anywhere the floor allows", and this is the row that shows the floor
    // is in front.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    serving(venue, eur);
    at(venue, 5n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 20n));
    at(venue, 9n);
    venue.publishReplacement(eur.name, replacementBy(eur, SECRETS.operator, 9n));
    at(venue, 20n);
    expect(operatorAt(eur, venue, 20n)).toEqual(HEIR);
  });

  it("and dated the floor ahead it revokes", () => {
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    serving(venue, eur);
    at(venue, 5n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 20n));
    at(venue, 9n);
    venue.publishReplacement(eur.name, replacementBy(eur, SECRETS.operator, 10n));
    at(venue, 20n);
    expect(operatorAt(eur, venue, 20n)).toEqual(KEYS.operator);
  });

  it("the floor is the venue's, which is why the venue's id must bind the lag: one record, two views of one chain declaring two lags, admitted by one and refused by the other", () => {
    // A record is judged against the venue that answered it (slice 37), and
    // the lag is that venue's constant. Read through a view declaring depth 1
    // (lag 2) a lead of 3 is admitted; through one declaring depth 2 (lag 3)
    // it is not — and the two views share one id, so this is the hazard the
    // Venue contract forbids, built to be seen: two honest readers of one
    // declared venue disagreeing about who is in force at a past index. A
    // real venue's id commits to its finality rule (`ergoVenueId`), so honest
    // readers of it share a lag; a view that declares another is out of
    // contract (the slice-38 review's security angle, S6).
    const chain = new LocalVenue();
    const near = new LaggingView(chain, 1n);
    const far = new LaggingView(chain, 2n);
    const eur = backingFor(near);
    chainAt(chain, 10n);
    chain.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 15n));
    chainAt(chain, 20n);
    expect(near.lag()).toBe(2n);
    expect(far.lag()).toBe(3n);
    expect(operatorAt(eur, near, 18n)).toEqual(HEIR);
    expect(operatorAt(eur, far, 18n)).toEqual(KEYS.operator);
  });
});

describe("§C2: the floor on a lagging venue, and what the parties do with the index it buys", () => {
  it("an incumbent that commits at the first clock it can read the record keeps every payment in term, and the successor serves them from the effective index", () => {
    // The panel's decisive row, under the party rule. Depth 2, so the lag is
    // 3: an act signed at clock c lands at c + 3. The rule-holder dates its
    // record the floor ahead of its own witnessing — 7 — so the incumbent
    // reads it at clock 12, and a commitment it signs there lands at 15,
    // inside its term. Before the floor, the same record dated earlier put a
    // commitment the incumbent signed at clock 13 in no term, with carol's
    // payment in it.
    const chain = new LocalVenue();
    const incumbentsView = new LaggingView(chain, 2n);
    const heirsView = new LaggingView(chain, 2n);
    const eur = backingFor(incumbentsView);
    chainAt(chain, 2n); // the clock reads 0, and the lag is honest from here
    const { sequencer: incumbent } = serving(incumbentsView, eur, chain);

    // The rule-holder pre-arms: witnessed at 12, effective 19 — the floor.
    chainAt(chain, 12n);
    chain.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 19n));

    // Clock 11: the record is ahead of what the incumbent can read. It
    // co-signs carol's payment in good faith, and the rule says act.
    chainAt(chain, 13n);
    expect(successionAhead(eur, incumbentsView)).toHaveLength(1);
    expect(actNow(eur, incumbentsView)).toBe(true);
    const paid = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.carol, 30n, 0n);
    expect(incumbent.submitTransfer(paid.op, paid.signature).position).toBe(1n);

    // Clock 12: the record is readable; an act signed now lands at 15, inside
    // the term, and the rule still says act. The incumbent co-signs one more
    // and commits at once — the party rule — and the commitment lands at 15.
    chainAt(chain, 14n);
    expect(successionAhead(eur, incumbentsView)).toHaveLength(2);
    expect(actNow(eur, incumbentsView)).toBe(true);
    const more = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 1n);
    expect(incumbent.submitTransfer(more.op, more.signature).position).toBe(2n);
    const handed = incumbent.commit();
    // The view knows its own in-flight commitment before the chain shows it.
    expect(incumbentsView.nextSequenceFor(KEYS.operator)).toBe(handed.commitment.sequence + 1n);
    chainAt(chain, 15n);
    expect(chain.witnessedAtFor(KEYS.operator)).toBe(15n);

    // Clock 16: an act signed now is first witnessed at 19, where the pen is
    // the successor's. The rule says stop.
    chainAt(chain, 18n);
    expect(actNow(eur, incumbentsView)).toBe(false);

    // The heir prepares on its own view — the incumbent's last has been
    // readable since clock 15 — and its door stays shut until the index.
    const heir = new Sequencer(HEIR_SECRET, heirsView);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, handed);
    const late = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 2n);
    expect(() => heir.submitTransfer(late.op, late.signature)).toThrow(/not yet in force/);

    // Clock 19: in force, holding the book the record stands on — the
    // incumbent's commitment at 15, carol's payment inside it — and serving.
    chainAt(chain, 21n);
    expect(heir.submitTransfer(late.op, late.signature).position).toBe(3n);
    expect(heir.balance(eur, KEYS.carol)).toBe(30n);
    const respend = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.mallory, 30n, 0n);
    expect(() => heir.submitTransfer(respend.op, respend.signature)).toThrow();

    // And every verifier places the incumbent's last where the book is.
    const walked = successionOf(eur, heirsView);
    expect(walked).toHaveLength(2);
    expect(lastCommitmentInForce(walked, heirsView)?.commitment.sequence).toBe(handed.commitment.sequence);
    expect(termOf(walked, heirsView, KEYS.operator, handed.commitment.sequence)).toBe(0);
  });

  it("an act co-signed once the lag reaches the index dies with the handover, and the party rule reads that from the public readers", () => {
    // The cost of not following the rule, measured, and the rule itself: at
    // clock 16 the record has been readable for four clocks, the pending link
    // takes force at 19, and an act signed now lands at 19 — in the
    // successor's term. The reference implementation's door is open there
    // (a door a rule-holder's record could shut was a lever, the review
    // found), so the incumbent co-signs, commits, and both die.
    const chain = new LocalVenue();
    const view = new LaggingView(chain, 2n);
    const heirsView = new LaggingView(chain, 2n);
    const eur = backingFor(view);
    chainAt(chain, 2n);
    const { sequencer: incumbent, state } = serving(view, eur, chain);
    chainAt(chain, 12n);
    chain.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 19n));

    chainAt(chain, 18n); // clock 16
    expect(actNow(eur, view)).toBe(false);
    const doomed = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    expect(incumbent.submitTransfer(doomed.op, doomed.signature).position).toBe(1n);
    const past = incumbent.commit();
    chainAt(chain, 19n);
    expect(chain.witnessedAtFor(KEYS.operator)).toBe(19n);

    // Clock 19: the record's last in-force commitment is the genesis one; the
    // commitment at 19 is neither the book nor placed, and accuses nobody.
    chainAt(chain, 21n);
    const walked = successionOf(eur, heirsView);
    expect(walked).toHaveLength(2);
    expect(lastCommitmentInForce(walked, heirsView)?.commitment.sequence).toBe(state.commitment.sequence);
    expect(termOf(walked, heirsView, KEYS.operator, past.commitment.sequence)).toBeUndefined();
    expect(isRewrittenHistory(eur, heirsView, state, past)).toBe(false);
    expect(isRewrittenHistory(eur, heirsView, past, state)).toBe(false);
    const heir = new Sequencer(HEIR_SECRET, heirsView);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    expect(() => heir.takeOver(eur, past)).toThrow(SequencerError);
    heir.takeOver(eur, state);
    // The doomed act is gone: alice's nonce is free again at the successor.
    expect(heir.submitTransfer(doomed.op, doomed.signature).position).toBe(1n);
    expect(actNow(eur, heirsView)).toBe(true);
  });

  for (const depth of [1n, 2n]) {
    it(`the doors move at the effective index: the incumbent's open the clock before and shut at it, the successor's shut the clock before and open at it, on a venue reading ${depth} behind`, () => {
      // Pinned against a door that would close early: the incumbent's
      // co-signature at effective − 1 is accepted (and dies — the rule's
      // cost), refused at effective for force alone; the successor's is
      // refused at effective − 1 and accepted at effective. The record is
      // witnessed at 10, effective at the floor.
      const chain = new LocalVenue();
      const view = new LaggingView(chain, depth);
      const lag = view.lag();
      const eur = backingFor(view);
      chainAt(chain, depth);
      const { sequencer: incumbent, state } = serving(view, eur, chain);
      const effective = 10n + 2n * lag + 1n;
      chainAt(chain, 10n);
      chain.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, effective));
      chainAt(chain, 10n + depth); // clock 10: the record is readable
      const heir = new Sequencer(HEIR_SECRET, view);
      heir.register(eur, signBacking(SECRETS.backer, eur));
      heir.takeOver(eur, state);

      // Clock effective − 1.
      chainAt(chain, effective - 1n + depth);
      const first = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
      expect(incumbent.submitTransfer(first.op, first.signature).position).toBe(1n);
      expect(() => heir.submitTransfer(first.op, first.signature)).toThrow(/not yet in force/);
      // Clock effective.
      chainAt(chain, effective + depth);
      const second = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 1n);
      expect(() => incumbent.submitTransfer(second.op, second.signature)).toThrow(/not yet in force/);
      expect(heir.submitTransfer(first.op, first.signature).position).toBe(1n);
    });
  }

  it("on a venue with no lag nothing moves: the predecessor serves to the index before force, and the successor from it", () => {
    // Lag zero: the clock and the index an act is first witnessed at are one.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { sequencer: incumbent, state } = serving(venue, eur);
    at(venue, 10n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 12n));
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, state);

    at(venue, 11n);
    expect(actNow(eur, venue)).toBe(true);
    const first = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    expect(incumbent.submitTransfer(first.op, first.signature).position).toBe(1n);
    const handed = incumbent.commit();
    expect(() => heir.submitTransfer(first.op, first.signature)).toThrow(/not yet in force/);

    at(venue, 12n);
    const second = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 1n);
    expect(() => incumbent.submitTransfer(second.op, second.signature)).toThrow(/not yet in force/);
    // The incumbent's commitment at 11 moved the book; the heir re-syncs once,
    // told by the door, and serves.
    expect(heir.awaitingTakeover().map((b) => b.nameHex)).toEqual([eur.nameHex]);
    heir.takeOver(eur, handed);
    expect(heir.submitTransfer(second.op, second.signature).position).toBe(2n);
  });

  it("an incumbent's commitment witnessed at the effective index still carries the book, lands out of its term, is not the book, and accuses nobody", () => {
    // What a commitment landing past the index IS — the claim the whole
    // boundary decision rests on (the panel rejected every re-attribution of
    // it): not the book, placed in no term, not a rewrite in either order,
    // refused as a takeOver offer. Depth 2, record at 12, effective 19; the
    // incumbent's last commitment is the genesis one, so its seat is current
    // and its commit at clock 16 goes through — and lands at 19.
    const chain = new LocalVenue();
    const view = new LaggingView(chain, 2n);
    const heirsView = new LaggingView(chain, 2n);
    const eur = backingFor(view);
    chainAt(chain, 2n);
    const { sequencer: incumbent, state: inTerm } = serving(view, eur, chain);
    chainAt(chain, 12n);
    chain.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 19n));
    chainAt(chain, 18n);
    const past = incumbent.commit();
    expect(past.snapshots.some((s) => s.name.every((b, i) => b === eur.name[i]))).toBe(true);
    chainAt(chain, 19n);
    expect(chain.witnessedAtFor(KEYS.operator)).toBe(19n);

    chainAt(chain, 21n);
    const walked = successionOf(eur, heirsView);
    expect(walked).toHaveLength(2);
    expect(lastCommitmentInForce(walked, heirsView)?.commitment.sequence).toBe(inTerm.commitment.sequence);
    expect(termOf(walked, heirsView, KEYS.operator, past.commitment.sequence)).toBeUndefined();
    expect(isRewrittenHistory(eur, heirsView, inTerm, past)).toBe(false);
    expect(isRewrittenHistory(eur, heirsView, past, inTerm)).toBe(false);
    const heir = new Sequencer(HEIR_SECRET, heirsView);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    expect(() => heir.takeOver(eur, past)).toThrow(SequencerError);
    heir.takeOver(eur, inTerm);
    expect(heir.outstanding(eur)).toBe(100n);
  });
});
