import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import type { ServedState } from "../src/commitment.js";
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
// one, and a door reads force where an act signed now is first witnessed.**
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
//   - **The floor.** effective ≥ witnessed + lag + 1, judged once per record
//     against the venue that answered it. A record below it is no replacement.
//     So the record precedes, on every party's clock, every act it can void:
//     a commitment signed before the record could be read lands inside the
//     predecessor's term, and one signed after is its own choice.
//   - **The door.** An operator co-signs only what can still be witnessed
//     while it is in force: in force at its clock AND at its clock plus the
//     lag. A predecessor's doors close the lag before the effective index; a
//     successor's open at the index itself, once nothing the predecessor could
//     still land in its term is unread. On a venue with no lag the two
//     questions are one and nothing moves.
//
// See DECISIONS.md, "Panel: the lead time".

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

/** The incumbent serving `backing` on `venue`, with one issuance to Alice, committed. */
function serving(venue: Venue, backing: Backing) {
  const sequencer = new Sequencer(SECRETS.operator, venue);
  sequencer.register(backing, signBacking(SECRETS.backer, backing));
  sequencer.submitIssue(
    { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
    ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
  );
  const { commitment } = sequencer.commit();
  const state: ServedState = { snapshots: sequencer.snapshot(), commitment };
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
    // walk — is held to it like any other. Its index is otherwise inert: a
    // self-naming candidate never becomes a link, and supersession is decided
    // by its witnessing. The width the exemption states is now "anywhere the
    // floor allows", and this is the row that shows the floor is in front.
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

  it("the floor is the venue's: one record, two views of one chain, admitted where the lag is short and refused where it is long", () => {
    // A record is judged against the venue that answered it (slice 37), and
    // the lag is that venue's constant. The same chain read through a view
    // with depth 1 admits a lead of 2; read through a view with depth 2 it
    // does not — and each view's memo holds its own verdict.
    const chain = new LocalVenue();
    const near = new LaggingView(chain, 1n);
    const far = new LaggingView(chain, 2n);
    const eur = backingFor(near);
    chainAt(chain, 10n);
    chain.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 12n));
    chainAt(chain, 20n);
    expect(near.lag()).toBe(1n);
    expect(far.lag()).toBe(2n);
    expect(operatorAt(eur, near, 18n)).toEqual(HEIR);
    expect(operatorAt(eur, far, 18n)).toEqual(KEYS.operator);
  });
});

describe("§C2: a door reads force where an act signed now is first witnessed", () => {
  it("closes the pre-armed erasure on a lagging venue: the incumbent's doors close the lag before the index, its commitment on reading the record lands in term, and the successor's doors open at the index", () => {
    // The panel's decisive row. A view that reads two behind the chain: an act
    // signed at clock c lands at chain height c + 2. The rule-holder dates its
    // record the floor ahead of its own witnessing — 3 = lag + 1 — so the
    // incumbent reads it at clock 12, one index before any act it signs could
    // land at the effective index 15. Before the floor and the door, the same
    // record dated one index earlier put a commitment the incumbent signed at
    // clock 13 in no term, with carol's payment in it.
    const chain = new LocalVenue();
    const incumbentsView = new LaggingView(chain, 2n);
    const heirsView = new LaggingView(chain, 2n);
    const eur = backingFor(incumbentsView);
    chainAt(chain, 2n); // the clock reads 0, and the lag is honest from here
    const { sequencer: incumbent } = serving(incumbentsView, eur);

    // The rule-holder pre-arms: witnessed at 12, effective 15.
    chainAt(chain, 12n);
    chain.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 15n));

    // Clock 11: the record is two indices ahead of what the incumbent can
    // read. It co-signs carol's payment in good faith.
    chainAt(chain, 13n);
    expect(successionAhead(eur, incumbentsView)).toHaveLength(1);
    const paid = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.carol, 30n, 0n);
    expect(incumbent.submitTransfer(paid.op, paid.signature).position).toBe(1n);

    // Clock 12: the record is readable. The door is still open — an act
    // signed now lands at 14, inside the term — and the incumbent commits at
    // once, which is the party rule: the commitment lands at 14, in term.
    chainAt(chain, 14n);
    expect(successionAhead(eur, incumbentsView)).toHaveLength(2);
    const more = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 1n);
    expect(incumbent.submitTransfer(more.op, more.signature).position).toBe(2n);
    const handed = incumbent.commit();
    const last = handed.commitment;
    expect(chain.witnessedAtFor(KEYS.operator)).toBe(14n);

    // Clock 13: an act signed now is first witnessed at 15, where the pen is
    // the successor's. The door closes and names it.
    chainAt(chain, 15n);
    const late = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 2n);
    expect(() => incumbent.submitTransfer(late.op, late.signature)).toThrow(/first witnessed/);
    expect(() => incumbent.submitTransfer(late.op, late.signature)).toThrow(/successor/);

    // Clock 14: the incumbent's own commitment is readable again, so its seat
    // is current and nothing awaits repair — a closed door is not a stale
    // seat — and the door is still closed. (At 12 and 13 the seat read stale
    // for a different reason: a commitment is unreadable for the lag after it
    // lands, the blind window the slice-38 security angle recorded as F11,
    // which is not this slice's.) The heir prepares on its own view, and its
    // doors stay shut until the index itself: at clock 14 the predecessor
    // could still have landed a commitment in its term that this view has
    // not read.
    chainAt(chain, 16n);
    expect(incumbent.awaitingTakeover()).toHaveLength(0);
    expect(() => incumbent.submitTransfer(late.op, late.signature)).toThrow(/first witnessed/);
    const heir = new Sequencer(HEIR_SECRET, heirsView);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, handed);
    expect(() => heir.submitTransfer(late.op, late.signature)).toThrow(/not yet in force/);

    // Clock 15: in force, holding the book the record stands on — the
    // incumbent's commitment at 14, carol's payment inside it — and serving.
    chainAt(chain, 17n);
    expect(heir.submitTransfer(late.op, late.signature).position).toBe(3n);
    expect(heir.balance(eur, KEYS.carol)).toBe(30n);
    const respend = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.mallory, 30n, 0n);
    expect(() => heir.submitTransfer(respend.op, respend.signature)).toThrow();

    // And every verifier places the incumbent's last where the book is.
    const walked = successionOf(eur, heirsView);
    expect(walked).toHaveLength(2);
    expect(lastCommitmentInForce(walked, heirsView)?.commitment.sequence).toBe(last.sequence);
    expect(termOf(walked, heirsView, KEYS.operator, last.sequence)).toBe(0);
  });

  it("on a venue with no lag the doors are what they were: the predecessor serves to the index before force, and the successor from it", () => {
    // Lag zero: the clock and the index an act is first witnessed at are one,
    // so the door's second question is its first. This pins that the lookahead
    // costs a venue with immediate publication nothing — no stall, no early
    // close — which is every test in this suite that was written before it.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { sequencer: incumbent, state } = serving(venue, eur);
    at(venue, 10n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 12n));
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, state);

    at(venue, 11n);
    const first = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    expect(incumbent.submitTransfer(first.op, first.signature).position).toBe(1n);
    const handed = incumbent.commit();
    expect(() => heir.submitTransfer(first.op, first.signature)).toThrow(/not yet in force/);

    at(venue, 12n);
    // At 12 the heir is in force at the clock itself, so the incumbent is
    // refused by the question the doors always asked; the lookahead is never
    // reached at lag zero, which is the point.
    const second = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 1n);
    expect(() => incumbent.submitTransfer(second.op, second.signature)).toThrow(/not yet in force/);
    // The incumbent's commitment at 11 moved the book; the heir re-syncs once,
    // told by the door, and serves.
    expect(heir.awaitingTakeover().map((b) => b.nameHex)).toEqual([eur.nameHex]);
    heir.takeOver(eur, handed);
    expect(heir.submitTransfer(second.op, second.signature).position).toBe(2n);
  });
});
