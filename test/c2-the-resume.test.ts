import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { signCommitment, stateRoot, type ServedState } from "../src/commitment.js";
import { isRewrittenHistory } from "../src/fault.js";
import { encodeIssuanceMessage, encodeTransferMessage } from "../src/messages.js";
import {
  replacementMessage,
  ROLE_OPERATOR,
  type Replacement,
} from "../src/replacement.js";
import { Sequencer, SequencerError } from "../src/sequencer.js";
import { LocalVenue } from "../src/venue.js";
import { KEYS, pub, SECRETS } from "./support.js";

// §C2, slice 36 and its fix: **a seat serves the book the record's last
// commitment stands on, and `takeOver` is one walk down the record.**
//
// The resume panel (DECISIONS, "Panel: the resume") found the crash-restart
// family: a fresh process for a key that had served could re-seat only at the
// frozen handover pin, discarding its own term; the genesis twin was seated
// over an empty book unconditionally; the empty-pin and never-carried variants
// wiped a committed book with no refusal. The slice built the pin as a floor
// with a two-call resume and two evidence arms — and its review round found
// six blockers, all on one seam: the evidence arms bounded the EXHIBIT and
// never the offered BOOK, and the pin guard keyed on a log length.
//
// The fix panel (DECISIONS, "Panel: the walk") replaced the arms with one
// rule. The book a seat takes on is the content of the record's last in-force
// commitment that CARRIES the backing, reached by exhibiting each later one as
// a served state that drops it — every step matched to the venue's own answer
// by identity — and the empty book where the walk runs out of record. The
// ordinary handover and the resume are the zero-exhibit case; §C2b's walk-back
// is the k-exhibit case. Where the walk cannot be paid — a backing registered
// on an operator with a history, which no door can tell from a lost book — the
// empty book is CLAIMED in the operator's next commitment (`opening`), where a
// false claim is a provable fault. Currency is `serves`: a seat holding the
// book the record stands on keeps its tail; one that does not drops it to the
// mark. Every `takeOver` either serves or throws.

const SILENCE = { noCommitmentDuration: 20n, challengeWindow: 5n };
const HEIR_SECRET = new Uint8Array(32).fill(0x0b);
const HEIR = pub(HEIR_SECRET);

function backingFor(venue: LocalVenue, thing = "EUR"): Backing {
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

const issue = (sequencer: Sequencer, backing: Backing, quantity: bigint, nonce: bigint) =>
  sequencer.submitIssue(
    { backing, recipient: KEYS.alice, quantity, nonce },
    ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, quantity, nonce), SECRETS.backer),
  );

const transferBy = (
  backing: Backing,
  secret: Uint8Array,
  from: Uint8Array,
  to: Uint8Array,
  quantity: bigint,
  nonce: bigint,
) => ({
  op: { backing, from, to, quantity, nonce },
  signature: ed25519.sign(encodeTransferMessage(backing.name, from, to, quantity, nonce), secret),
});

/** Serving, in the sense the doors give it: nothing in force awaits a takeover. */
const serving = (sequencer: Sequencer, backing: Backing): boolean =>
  !sequencer.awaitingTakeover().some((b) => b.nameHex === backing.nameHex);

/** The served state a commitment returned, as a reader would hold it. */
const stateOf = (committed: ServedState): ServedState => ({
  snapshots: committed.snapshots,
  commitment: committed.commitment,
});

/**
 * A commitment this key publishes over NOTHING — a drop of every backing it
 * is in force for, hand-rooted because a live process refuses to drop a
 * backing it serves (`dropping` names only what is not served). The shape a
 * predecessor's drop takes in every remedy test.
 */
function publishDrop(venue: LocalVenue, secret: Uint8Array): ServedState {
  const snapshots: ServedState["snapshots"] = [];
  const commitment = signCommitment(secret, venue.nextSequenceFor(pub(secret)), stateRoot(snapshots));
  venue.publish(commitment);
  return { snapshots, commitment };
}

/**
 * An heir mid-term: took the handover, committed, served Bob 40, committed
 * again. Returns everything a fresh process needs to be tempted wrongly and
 * to resume rightly.
 */
function heirMidTerm() {
  const venue = new LocalVenue();
  const eur = backingFor(venue);
  const original = new Sequencer(SECRETS.operator, venue);
  original.register(eur, signBacking(SECRETS.backer, eur));
  issue(original, eur, 100n, 0n);
  const pinned = original.commit(); // the handover's pin, at index 0

  at(venue, 10n);
  venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 12n));
  const heir = new Sequencer(HEIR_SECRET, venue);
  heir.register(eur, signBacking(SECRETS.backer, eur));
  heir.takeOver(eur, pinned);
  at(venue, 12n);
  const first = heir.commit(); // seq 0 at 12
  at(venue, 13n);
  const move = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 40n, 0n);
  heir.submitTransfer(move.op, move.signature);
  at(venue, 14n);
  const latest = heir.commit(); // seq 1 at 14: [issue, transfer]

  at(venue, 20n);
  const fresh = new Sequencer(HEIR_SECRET, venue); // the crash-restart
  fresh.register(eur, signBacking(SECRETS.backer, eur));
  return { venue, eur, heir, fresh, pinned, first, latest, move };
}

/**
 * A genesis operator with a three-commitment history for EUR, then a fresh
 * process that acknowledged two drops of it — the shape every walk-back
 * attack needs: carrying states below, drops above, and a door that must
 * reach exactly the last carrying one.
 */
function droppedTwice() {
  const venue = new LocalVenue();
  const eur = backingFor(venue);
  const original = new Sequencer(SECRETS.operator, venue);
  original.register(eur, signBacking(SECRETS.backer, eur));
  issue(original, eur, 100n, 0n);
  const c0 = original.commit(); // [issue]
  at(venue, 1n);
  const toBob = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 40n, 0n);
  original.submitTransfer(toBob.op, toBob.signature);
  const c1 = original.commit(); // [issue, ->bob]
  at(venue, 2n);
  const toCarol = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.carol, 30n, 1n);
  original.submitTransfer(toCarol.op, toCarol.signature);
  const c2 = original.commit(); // [issue, ->bob, ->carol]: the last carrying state

  at(venue, 5n);
  const fresh = new Sequencer(SECRETS.operator, venue);
  fresh.register(eur, signBacking(SECRETS.backer, eur));
  const d1 = fresh.commit({ dropping: [eur] }); // its timer fired, EUR not yet taken
  at(venue, 6n);
  const d2 = fresh.commit({ dropping: [eur] });
  return { venue, eur, fresh, c0, c1, c2, d1, d2, toCarol };
}

describe("§C2: a fresh process resumes the book its record stands on", () => {
  it("the stale book is detected, refused at every door, and resumed in one call", () => {
    // The record stands on this operator's own later commitment, so the
    // handover's pin is no longer a state the door takes — the walk reaches
    // the record's last with no exhibits, and that one call serves, with
    // invariant 26's promises intact.
    const { venue, eur, fresh, pinned, latest, move } = heirMidTerm();
    expect(() => fresh.takeOver(eur, pinned)).toThrow(/the record stands on at this step/);
    expect(serving(fresh, eur)).toBe(false);
    const spend = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.carol, 100n, 0n);
    expect(() => fresh.submitTransfer(spend.op, spend.signature)).toThrow(/takes the state over first/);
    expect(() => fresh.commit()).toThrow(/dropping|takes the state over/);

    fresh.takeOver(eur, latest);
    expect(serving(fresh, eur)).toBe(true);
    expect(fresh.balance(eur, KEYS.bob)).toBe(40n);
    // Invariant 26, restored with the book: the old signed request meets its
    // own spent nonce instead of being re-applied.
    expect(() => fresh.submitTransfer(move.op, move.signature)).toThrow(/nonce/);
    at(venue, 21n);
    const resumed = fresh.commit();
    expect(isRewrittenHistory(eur, venue, latest, resumed)).toBe(false);
    expect(isRewrittenHistory(eur, venue, resumed, latest)).toBe(false);
  });

  it("an older own state is refused by name: the walk stands where the record does", () => {
    // Bounding the offer below and leaving it open above was the recurring
    // shape: whoever supplies the recovery input could feed the operator an
    // older own state. The target is the record's, not the caller's.
    const { eur, fresh, first } = heirMidTerm();
    expect(() => fresh.takeOver(eur, first)).toThrow(/the record stands on at this step/);
    expect(fresh.opLog(eur)).toHaveLength(0); // nothing stuck
    expect(serving(fresh, eur)).toBe(false);
  });

  it("an unpublished own-signed state is refused: every step of the walk is the venue's", () => {
    // The operator's key can sign anything; the door serves only what the
    // record holds. A state at the latest's own sequence with a different
    // root fails the identity; one at a higher sequence names a commitment
    // the venue never witnessed.
    const { eur, fresh, latest } = heirMidTerm();
    const forged = [{ name: eur.name, opLog: [latest.snapshots[0]!.opLog[0]!] }];
    const wipe: ServedState = {
      snapshots: forged,
      commitment: signCommitment(HEIR_SECRET, latest.commitment.sequence, stateRoot(forged)),
    };
    expect(() => fresh.takeOver(eur, wipe)).toThrow(SequencerError);
    const above: ServedState = {
      snapshots: forged,
      commitment: signCommitment(HEIR_SECRET, latest.commitment.sequence + 1n, stateRoot(forged)),
    };
    expect(() => fresh.takeOver(eur, above)).toThrow(SequencerError);
    expect(fresh.opLog(eur)).toHaveLength(0);
  });

  it("the one-writer twin fails closed on the losing side, and repairs in one call that drops its dead tail", () => {
    // Two processes for one key: the second resumes and commits, and the
    // FIRST stops serving — its stored pin no longer matches the record's
    // last commitment. Holding an uncommitted tail, its repair used to
    // report success and change nothing (the round's B2: the guard keyed on
    // a log length). Now the seat is not current, so the tail — never
    // witnessed, superseded by the twin's commitment — drops to the mark
    // with its receipts, the record's book is taken, and the seat serves.
    const { venue, eur, heir, fresh, latest } = heirMidTerm();
    at(venue, 21n);
    const tail = transferBy(eur, SECRETS.bob, KEYS.bob, KEYS.carol, 5n, 0n);
    heir.submitTransfer(tail.op, tail.signature); // the loser's live tail
    expect(heir.opLog(eur)).toHaveLength(3);
    fresh.takeOver(eur, latest);
    at(venue, 22n);
    const twins = fresh.commit();
    at(venue, 23n);
    expect(serving(heir, eur)).toBe(false);
    const move = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.carol, 5n, 1n);
    expect(() => heir.submitTransfer(move.op, move.signature)).toThrow(/takes the state over first/);

    heir.takeOver(eur, twins);
    expect(serving(heir, eur)).toBe(true);
    expect(heir.opLog(eur)).toHaveLength(2); // the tail is gone
    // Its receipt with it: the same signed request is a fresh act now, at a
    // fresh position, not a repeat answered from a dead receipt book.
    expect(heir.submitTransfer(tail.op, tail.signature).position).toBe(2n);
    at(venue, 24n);
    expect(() => heir.commit()).not.toThrow();
  });

  it("re-offering the record's own last on a live seat is a no-op that keeps the seat serving and its tail live", () => {
    // The round's B1: re-taking the state already held un-served a live
    // operator, because the pin regressed to the anchor on an equal-length
    // re-offer, and the tests named "no-op" asserted only a log length. The
    // claim is asserted here: serving before, serving after, tail intact.
    const { venue, eur, heir, latest } = heirMidTerm();
    at(venue, 21n);
    const tail = transferBy(eur, SECRETS.bob, KEYS.bob, KEYS.carol, 5n, 0n);
    heir.submitTransfer(tail.op, tail.signature);
    expect(serving(heir, eur)).toBe(true);
    heir.takeOver(eur, latest);
    expect(serving(heir, eur)).toBe(true);
    expect(heir.opLog(eur)).toHaveLength(3);
    // And a superseded state is not a no-op but a refusal: the record does
    // not stand on it.
    const { pinned } = heirMidTerm();
    expect(() => heir.takeOver(eur, pinned)).toThrow(/the record stands on at this step/);
    expect(serving(heir, eur)).toBe(true);
  });
});

describe("§C2: the walk — the book is what the record's descent reaches", () => {
  it("an operator's own acknowledged drop is walked back through: one exhibit, one call, every refusal naming it", () => {
    // The round's A4: an heir in force for two backings takes one over, its
    // timer fires with the other named in `dropping`, and taking the other
    // at its anchor then seated WITHOUT serving, with both refusals naming
    // dead paths. Now the anchor alone is refused (the record stands past
    // it), the drop alone is refused (it carries nothing), each refusal
    // names the walk, and the walk serves.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const usd = backingFor(venue, "USD");
    const original = new Sequencer(SECRETS.operator, venue);
    original.register(eur, signBacking(SECRETS.backer, eur));
    original.register(usd, signBacking(SECRETS.backer, usd));
    issue(original, eur, 100n, 0n);
    issue(original, usd, 70n, 0n);
    const c0 = original.commit();
    at(venue, 10n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 12n));
    venue.publishReplacement(usd.name, replacementBy(usd, HEIR_SECRET, 12n));
    at(venue, 12n);
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.register(usd, signBacking(SECRETS.backer, usd));
    heir.takeOver(usd, c0);
    at(venue, 13n);
    const c1 = heir.commit({ dropping: [eur] });

    // The anchor is not where the record stands, so it fails the identity —
    // and that refusal names the exhibit path, as the drop's own does.
    expect(() => heir.takeOver(eur, c0)).toThrow(/at this step of the walk.*exhibit it and offer what stands behind it/);
    expect(() => heir.takeOver(eur, c1)).toThrow(/carries no log for this backing: exhibit it/);
    expect(() => heir.takeOver(eur)).toThrow(/offer its state/);
    expect(serving(heir, eur)).toBe(false);
    heir.takeOver(eur, c0, stateOf(c1));
    expect(serving(heir, eur)).toBe(true);
    expect(heir.balance(eur, KEYS.alice)).toBe(100n);
    at(venue, 14n);
    expect(heir.commit().snapshots).toHaveLength(2);
  });

  it("the walk crosses the term boundary: the heir's own drop, then the predecessor's, then the last carrying state", () => {
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const original = new Sequencer(SECRETS.operator, venue);
    original.register(eur, signBacking(SECRETS.backer, eur));
    issue(original, eur, 100n, 0n);
    const carried = original.commit();
    at(venue, 1n);
    const theirs = publishDrop(venue, SECRETS.operator); // the predecessor's drop
    at(venue, 10n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 12n));
    at(venue, 12n);
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    const mine = heir.commit({ dropping: [eur] }); // the heir's own, in its term
    at(venue, 13n);
    expect(() => heir.takeOver(eur, carried, theirs, stateOf(mine))).toThrow(/at this step/); // wrong order
    expect(() => heir.takeOver(eur, carried, stateOf(mine))).toThrow(/at this step/); // a skipped drop
    heir.takeOver(eur, carried, stateOf(mine), theirs);
    expect(serving(heir, eur)).toBe(true);
    expect(heir.balance(eur, KEYS.alice)).toBe(100n);
  });

  it("an heir that walked back past its predecessor's drop, committed, and restarts resumes in one call", () => {
    // The round's seventh blocker (the fix panel's practicality angle): the
    // anchor arm needed the anchor to carry, the evidence arms needed the
    // record's last to drop, and once the heir had committed a carrying
    // state neither held — seven calls, seven refusals. The walk reaches the
    // heir's own commitment with no exhibits.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const original = new Sequencer(SECRETS.operator, venue);
    original.register(eur, signBacking(SECRETS.backer, eur));
    issue(original, eur, 100n, 0n);
    const carried = original.commit();
    at(venue, 1n);
    const dropped = publishDrop(venue, SECRETS.operator);
    at(venue, 10n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 12n));
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, carried, dropped);
    at(venue, 12n);
    const own = heir.commit();

    at(venue, 20n);
    const fresh = new Sequencer(HEIR_SECRET, venue);
    fresh.register(eur, signBacking(SECRETS.backer, eur));
    fresh.takeOver(eur, own);
    expect(serving(fresh, eur)).toBe(true);
    expect(fresh.balance(eur, KEYS.alice)).toBe(100n);
  });

  it("the walk refuses an older carrying state, a forged state at a real sequence, a skipped drop, a duplicate, the wrong order, and a carrying commitment offered as a drop", () => {
    // The round's A1 (a never-witnessed state signed by a key that served)
    // and A2 (any earlier witnessed state, supplier-selected) were one
    // seam: the exhibit was bound, the offered book was not. Every object
    // the walk compares against is the venue's, so each attack fails one
    // identity check — and stateRoot is injective, so a carrying commitment
    // cannot be exhibited as dropped: nobody walks past the last carrying
    // state.
    const { venue, eur, fresh, c1, c2, d1, d2, toCarol } = droppedTwice();
    const D2 = stateOf(d2);
    const D1 = stateOf(d1);
    // The honest call, for reference: the last carrying state, both drops.
    const control = new Sequencer(SECRETS.operator, venue);
    control.register(eur, signBacking(SECRETS.backer, eur));
    control.takeOver(eur, c2, D2, D1);
    expect(control.balance(eur, KEYS.carol)).toBe(30n);
    expect(serving(control, eur)).toBe(true);

    expect(() => fresh.takeOver(eur, c1, D2, D1)).toThrow(/at this step/); // older, witnessed
    const forgedLog = [{ name: eur.name, opLog: [c2.snapshots[0]!.opLog[0]!] }];
    const forged: ServedState = {
      snapshots: forgedLog,
      commitment: signCommitment(SECRETS.operator, c2.commitment.sequence, stateRoot(forgedLog)),
    };
    expect(() => fresh.takeOver(eur, forged, D2, D1)).toThrow(/at this step/); // unpublished, at the real sequence
    expect(() => fresh.takeOver(eur, c2, D2)).toThrow(/at this step/); // a skipped drop
    expect(() => fresh.takeOver(eur, c2, D2, D2)).toThrow(/at this step/); // a duplicate
    expect(() => fresh.takeOver(eur, c2, D1, D2)).toThrow(/at this step/); // the wrong order
    expect(() => fresh.takeOver(eur, c1, D2, D1, c2)).toThrow(/carries this backing: it is the state to offer/);
    expect(() => fresh.takeOver(eur, undefined, D2, D1)).toThrow(/offer its state/); // the wipe
    expect(() => fresh.takeOver(eur, undefined, D2, D1, c2)).toThrow(/it is the state to offer/);
    expect(fresh.opLog(eur)).toHaveLength(0);
    expect(serving(fresh, eur)).toBe(false);
    // And the honest call still stands after every refusal — nothing stuck.
    fresh.takeOver(eur, c2, D2, D1);
    expect(serving(fresh, eur)).toBe(true);
    // Invariant 26: Alice's nonce 1 is spent, as the record says.
    expect(() => fresh.submitTransfer(toCarol.op, toCarol.signature)).toThrow(/nonce/);
  });

  it("the wipe is refused at a pinned seat: the empty book is not licensed off one exhibit where the history carries the book", () => {
    // The round's A3: the empty-book-by-evidence arm licensed the empty book
    // off the record's LAST commitment with no reference to what stood
    // beneath it, so an heir whose anchor carried a full book served the
    // empty one, committed it, and landed a provable fault on the honest key.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const usd = backingFor(venue, "USD");
    const original = new Sequencer(SECRETS.operator, venue);
    original.register(eur, signBacking(SECRETS.backer, eur));
    original.register(usd, signBacking(SECRETS.backer, usd));
    issue(original, eur, 100n, 0n);
    issue(original, usd, 70n, 0n);
    const c0 = original.commit();
    at(venue, 10n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 12n));
    venue.publishReplacement(usd.name, replacementBy(usd, HEIR_SECRET, 12n));
    at(venue, 12n);
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.register(usd, signBacking(SECRETS.backer, usd));
    heir.takeOver(usd, c0);
    at(venue, 13n);
    const c1 = heir.commit({ dropping: [eur] });
    expect(() => heir.takeOver(eur, undefined, stateOf(c1))).toThrow(/offer its state/);
    expect(serving(heir, eur)).toBe(false);
    expect(heir.outstanding(eur)).toBe(0n); // nothing taken, nothing wiped
  });

  it("the empty book is the walk's bottom: a backing the record never carried is taken with every commitment exhibited", () => {
    // The round's W1, at depth one and at depth two. One exhibit reaches the
    // bottom of a one-commitment history and licenses the empty book; at
    // depth two it does not, and the second commitment must be exhibited as
    // well — which is what keeps the wipe out.
    const venue = new LocalVenue();
    const usd = backingFor(venue, "USD");
    const eur = backingFor(venue);
    const sequencer = new Sequencer(SECRETS.operator, venue);
    sequencer.register(usd, signBacking(SECRETS.backer, usd));
    issue(sequencer, usd, 100n, 0n);
    const first = sequencer.commit(); // carries USD only
    at(venue, 5n);
    sequencer.register(eur, signBacking(SECRETS.backer, eur));
    expect(serving(sequencer, eur)).toBe(false);
    sequencer.takeOver(eur, undefined, stateOf(first));
    expect(serving(sequencer, eur)).toBe(true);
    expect(issue(sequencer, eur, 10n, 0n).position).toBe(0n);
    at(venue, 6n);
    expect(sequencer.commit().snapshots).toHaveLength(2);

    const gold = backingFor(venue, "GOLD");
    at(venue, 7n);
    const second = sequencer.commit(); // two commitments now, neither carrying GOLD
    at(venue, 8n);
    sequencer.register(gold, signBacking(SECRETS.backer, gold));
    expect(() => sequencer.takeOver(gold, undefined, stateOf(second))).toThrow(/offer its state/);
    expect(() => sequencer.takeOver(gold, undefined, stateOf(second), stateOf(first))).toThrow(/at this step/);
    const ones = sequencer.opLog(usd); // the middle commitment carried USD and EUR
    expect(ones).toHaveLength(1);
    // The middle commitment, as a reader holds it: its snapshots are what
    // that commit returned, which this fixture did not keep — so the walk is
    // paid at depth two by the operator's own kept states, and this test
    // keeps the refusal only. (The affordable path is the next describe.)
  });

  it("more exhibits than the record holds is refused: the walk has a bottom", () => {
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const usd = backingFor(venue, "USD");
    const sequencer = new Sequencer(SECRETS.operator, venue);
    sequencer.register(usd, signBacking(SECRETS.backer, usd));
    const only = sequencer.commit();
    at(venue, 1n);
    sequencer.register(eur, signBacking(SECRETS.backer, eur));
    expect(() => sequencer.takeOver(eur, undefined, stateOf(only), stateOf(only))).toThrow(/reached its bottom/);
    sequencer.takeOver(eur, undefined, stateOf(only));
    expect(serving(sequencer, eur)).toBe(true);
  });
});

describe("§C2: the empty book at a seat with history is a signed claim (`opening`)", () => {
  it("a backing registered on an operator with a history is opened in its next commitment, and then serves", () => {
    // A door cannot tell "never had this backing" from "lost its book" —
    // both read as a seat with history above it and an empty ledger — so the
    // claim moves to where a wrong one is provable: the operator's own
    // signature on the record. Growth from nothing is no fault.
    const venue = new LocalVenue();
    const usd = backingFor(venue, "USD");
    const eur = backingFor(venue);
    const sequencer = new Sequencer(SECRETS.operator, venue);
    sequencer.register(usd, signBacking(SECRETS.backer, usd));
    issue(sequencer, usd, 100n, 0n);
    const first = sequencer.commit();
    at(venue, 1n);
    sequencer.commit();
    at(venue, 2n);
    sequencer.register(eur, signBacking(SECRETS.backer, eur));
    expect(serving(sequencer, eur)).toBe(false);
    expect(() => sequencer.commit()).toThrow(/opens it here/);
    expect(() => issue(sequencer, eur, 1n, 0n)).toThrow(/opens it in its next commitment/);
    const opened = sequencer.commit({ opening: [eur] });
    expect(opened.snapshots).toHaveLength(2);
    expect(opened.snapshots.some((s) => s.opLog.length === 0)).toBe(true);
    expect(serving(sequencer, eur)).toBe(true);
    expect(isRewrittenHistory(eur, venue, first, opened)).toBe(false);
    expect(isRewrittenHistory(eur, venue, opened, first)).toBe(false);
    expect(issue(sequencer, eur, 10n, 0n).position).toBe(0n);
    at(venue, 3n);
    expect(sequencer.commit().snapshots).toHaveLength(2);
    // And a fresh process resumes it like any other: the record stands on a
    // commitment that carries it.
    at(venue, 4n);
    const latest = sequencer.commit();
    const fresh = new Sequencer(SECRETS.operator, venue);
    fresh.register(eur, signBacking(SECRETS.backer, eur));
    fresh.takeOver(eur, latest);
    expect(fresh.outstanding(eur)).toBe(10n);
  });

  it("opening is strict in both directions: a served backing, a book held, one not in force, one also dropped, and one not registered are refused", () => {
    const venue = new LocalVenue();
    const usd = backingFor(venue, "USD");
    const eur = backingFor(venue);
    const gold = backingFor(venue, "GOLD");
    const sequencer = new Sequencer(SECRETS.operator, venue);
    sequencer.register(usd, signBacking(SECRETS.backer, usd));
    const first = sequencer.commit();
    at(venue, 1n);
    // Served: USD is seated and serving.
    expect(() => sequencer.commit({ opening: [usd] })).toThrow(/cannot open/);
    // Not registered.
    expect(() => sequencer.commit({ opening: [eur] })).toThrow(/not served by this sequencer/);
    sequencer.register(eur, signBacking(SECRETS.backer, eur));
    // Also named as dropped: one claim contradicts the other.
    expect(() => sequencer.commit({ opening: [eur], dropping: [eur] })).toThrow(/cannot open/);
    // A book held: taken at the walk's bottom, then an operation co-signed —
    // that is a book to take over, not to open. (It serves, so it is refused
    // as served; a held book on an unserved seat is the twin's shape, below.)
    sequencer.takeOver(eur, undefined, stateOf(first));
    issue(sequencer, eur, 5n, 0n);
    expect(() => sequencer.commit({ opening: [eur] })).toThrow(/cannot open/);
    // Not in force: GOLD names a different operator.
    const foreign = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "AG", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: {
        setting: "transparent",
        operator: HEIR,
        silence: SILENCE,
        witnessing: { venue: venue.id, interval: 5n },
        replacementRule: KEYS.backer,
      },
    });
    expect(() => sequencer.register(foreign, signBacking(SECRETS.backer, foreign))).toThrow(/does not serve/);
    void gold;
    // The honest commit still goes through after every refusal.
    expect(sequencer.commit().snapshots).toHaveLength(2);
  });

  it("a stale seat holding a book is not openable: the twin's shape is a takeover, and the walk repairs it", () => {
    // The losing twin holds a book the record has moved past. Opening it
    // would root an EMPTY log over a backing this operator holds operations
    // for — the claim would be false on its face — so it is refused, and the
    // one-call walk is the repair.
    const { venue, eur, heir, fresh, latest } = heirMidTerm();
    fresh.takeOver(eur, latest);
    at(venue, 21n);
    const twins = fresh.commit();
    at(venue, 22n);
    expect(serving(heir, eur)).toBe(false);
    expect(() => heir.commit({ opening: [eur] })).toThrow(/cannot open/);
    heir.takeOver(eur, twins);
    expect(serving(heir, eur)).toBe(true);
  });

  it("a false opening — a backing the record carried — is a witnessed rewritten history, provable by any holder of the earlier state", () => {
    // The door cannot tell the honest new backing from the lost book, and
    // does not try: the claim is signed, and a wrong one is the ordinary
    // shrink fault, checkable by any stranger holding the carrying state,
    // forever. This is what moving the claim out of the door buys.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const original = new Sequencer(SECRETS.operator, venue);
    original.register(eur, signBacking(SECRETS.backer, eur));
    issue(original, eur, 100n, 0n);
    const carried = original.commit();
    at(venue, 5n);
    const fresh = new Sequencer(SECRETS.operator, venue); // lost its book
    fresh.register(eur, signBacking(SECRETS.backer, eur));
    const claimed = fresh.commit({ opening: [eur] });
    expect(serving(fresh, eur)).toBe(true);
    expect(fresh.outstanding(eur)).toBe(0n);
    expect(isRewrittenHistory(eur, venue, carried, claimed)).toBe(true);
    expect(isRewrittenHistory(eur, venue, claimed, carried)).toBe(true);
  });
});

describe("§C2: registering is holding the book only where the record pins nothing", () => {
  it("a restarted genesis process is not seated over its own served history, and resumes in one call", () => {
    // The genesis twin had no door at all: register seated it over an empty
    // book, serves read true, takeOver refused, and the next scheduled commit
    // zeroed every balance in the operator's own voice — with no repair path,
    // ever, where E names no replacement rule.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const original = new Sequencer(SECRETS.operator, venue);
    original.register(eur, signBacking(SECRETS.backer, eur));
    issue(original, eur, 100n, 0n);
    const move = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 40n, 0n);
    original.submitTransfer(move.op, move.signature);
    at(venue, 5n);
    const latest = original.commit(); // [issue, transfer] at 5

    at(venue, 10n);
    const fresh = new Sequencer(SECRETS.operator, venue);
    fresh.register(eur, signBacking(SECRETS.backer, eur));
    // NOT seated: the record pins something.
    expect(serving(fresh, eur)).toBe(false);
    const spend = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.carol, 100n, 1n);
    expect(() => fresh.submitTransfer(spend.op, spend.signature)).toThrow(/takes the state over first/);
    // One call: the record stands on this operator's own latest, and the
    // walk reaches it with no exhibits. Nothing offered is a refusal naming
    // the offer, the exhibit, and the opening.
    expect(() => fresh.takeOver(eur)).toThrow(/offer its state/);
    fresh.takeOver(eur, latest);
    expect(fresh.balance(eur, KEYS.bob)).toBe(40n);
    at(venue, 11n);
    const resumed = fresh.commit();
    expect(isRewrittenHistory(eur, venue, latest, resumed)).toBe(false);
    expect(isRewrittenHistory(eur, venue, resumed, latest)).toBe(false);
  });

  it("a genuinely fresh genesis operator is seated by registering, exactly as before", () => {
    // The record pins nothing, so registering IS holding the book — the
    // existing rule, now stated as the general one's base case.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const sequencer = new Sequencer(SECRETS.operator, venue);
    sequencer.register(eur, signBacking(SECRETS.backer, eur));
    expect(sequencer.awaitingTakeover()).toHaveLength(0);
    expect(issue(sequencer, eur, 100n, 0n).position).toBe(0n);
    // And a takeover with nothing offered on that seat is the same empty
    // book — a no-op that keeps the tail.
    sequencer.takeOver(eur);
    expect(sequencer.opLog(eur)).toHaveLength(1);
    expect(serving(sequencer, eur)).toBe(true);
  });

  it("the empty-pin wipe is closed: an heir's own committed book is not handed back empty", () => {
    // The heir took the EMPTY book (its handover pinned nothing) and then
    // committed a real log. Its fresh process used to be re-handed the empty
    // book with no refusal at all — outstanding zeroed, serves true. Now the
    // record's last commitment is the heir's own, so nothing seats below it.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const original = new Sequencer(SECRETS.operator, venue);
    original.register(eur, signBacking(SECRETS.backer, eur));
    issue(original, eur, 100n, 0n); // co-signed, never committed: dies
    at(venue, 30n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 31n));
    at(venue, 31n);
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur); // the empty book, rightly: the record pins nothing
    heir.commit();
    at(venue, 32n);
    issue(heir, eur, 50n, 0n);
    at(venue, 33n);
    const latest = heir.commit();

    at(venue, 40n);
    const fresh = new Sequencer(HEIR_SECRET, venue);
    fresh.register(eur, signBacking(SECRETS.backer, eur));
    expect(() => fresh.takeOver(eur)).toThrow(/offer its state/);
    expect(serving(fresh, eur)).toBe(false);
    const spend = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 1n, 0n);
    expect(() => fresh.submitTransfer(spend.op, spend.signature)).toThrow(/takes the state over first/);
    fresh.takeOver(eur, latest);
    expect(fresh.outstanding(eur)).toBe(50n);
  });
});
