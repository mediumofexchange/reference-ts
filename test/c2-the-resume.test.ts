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

// §C2, slice 36: **the pinned object is a floor, and a seat serves the book
// the record stands on.** The resume panel's design (DECISIONS, "Panel: the
// resume"), from the crash-restart family its probes proved:
//
//   - A fresh process for a key that had served could re-seat only at the
//     frozen handover pin, discarding its own term — its first served op a
//     double position, its next commit a shrink fault, both against an honest
//     key, with every liveness signal reading normal.
//   - The genesis twin had no door at all: register seated a restarted
//     process over an empty book unconditionally.
//   - The empty-pin and never-carried variants failed OPEN — a committed book
//     wiped with no refusal anywhere.
//
// The design: the raise (this operator's own latest witnessed commitment) is
// licensed only from a seat already holding the pinned book, through the
// existing fast-forward; the seat's stored pin is the identity of the
// commitment the BOOK stands on, rewritten by commit and compared by serves
// against the record's unbounded answer; registering is holding the book only
// where the record pins nothing — for every seat, genesis included.

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

describe("§C2: a fresh process resumes the book its record stands on", () => {
  it("the stale book is detected, refused at every door, and raised in one further call", () => {
    // The pin is a floor: the fresh process anchors at the pinned book — and
    // that seat serves NOTHING, because the record's last commitment is its
    // own, later. The door names the takeover; the raise is its own latest
    // witnessed commitment, through the ordinary fast-forward; and only then
    // does it serve — with invariant 26's promises intact.
    const { venue, eur, fresh, pinned, latest, move } = heirMidTerm();

    // The raise is licensed only FROM the anchor: a seatless process offering
    // the record's latest directly is refused — the anchor is what makes the
    // fast-forward's prefix loop the extension proof, and skipping it would
    // let a self-published truncation be resumed onto with nothing checked.
    expect(() => fresh.takeOver(eur, latest)).toThrow(/holding this link|pinned state/);
    fresh.takeOver(eur, pinned); // the anchor
    // Detection: the seat holds a book the record is past.
    expect(fresh.awaitingTakeover().map((b) => b.nameHex)).toEqual([eur.nameHex]);
    const spend = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.carol, 100n, 0n);
    expect(() => fresh.submitTransfer(spend.op, spend.signature)).toThrow(/takes the state over first/);
    expect(() => fresh.commit()).toThrow(/dropping|takes the state over/);

    fresh.takeOver(eur, latest); // the raise
    expect(fresh.awaitingTakeover()).toHaveLength(0);
    expect(fresh.balance(eur, KEYS.bob)).toBe(40n);
    // Invariant 26, restored with the book: the old signed request meets its
    // own spent nonce instead of being re-applied.
    expect(() => fresh.submitTransfer(move.op, move.signature)).toThrow(/nonce/);
    at(venue, 21n);
    const resumed = fresh.commit();
    expect(isRewrittenHistory(eur, venue, latest, resumed)).toBe(false);
    expect(isRewrittenHistory(eur, venue, resumed, latest)).toBe(false);
  });

  it("the raise takes the LATEST: an older own state is refused by name", () => {
    // Bounding the offer below and leaving it open above was the recurring
    // shape one rung up: whoever supplies the recovery input could feed the
    // operator an older own state and the whole price returned. The raised
    // target is the record's, not the caller's.
    const { eur, fresh, pinned, first } = heirMidTerm();
    fresh.takeOver(eur, pinned);
    expect(() => fresh.takeOver(eur, first)).toThrow(SequencerError);
    expect(fresh.opLog(eur)).toHaveLength(1); // nothing stuck
  });

  it("an unpublished own-signed state is refused: the raised target is venue-derived", () => {
    // The operator's key can sign anything; the door serves only what the
    // record holds. A state at the latest's own sequence with a different
    // root fails the identity; one at a higher sequence names a commitment
    // the venue never witnessed.
    const { eur, fresh, pinned, latest } = heirMidTerm();
    fresh.takeOver(eur, pinned);
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
    expect(fresh.opLog(eur)).toHaveLength(1);
  });

  it("the one-writer twin fails closed on the losing side", () => {
    // Two processes for one key: the second resumes and commits, and the
    // FIRST stops serving — its stored pin no longer matches the record's
    // last commitment. The one-writer rule keeps its subject (concurrency);
    // what changes is that the loser detects itself instead of co-signing on.
    const { venue, eur, heir, fresh, pinned, latest } = heirMidTerm();
    fresh.takeOver(eur, pinned);
    fresh.takeOver(eur, latest);
    at(venue, 21n);
    fresh.commit();
    at(venue, 22n);
    // The original process — which believes it serves — is refused.
    const move = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.carol, 5n, 1n);
    expect(() => heir.submitTransfer(move.op, move.signature)).toThrow(/takes the state over first/);
    expect(heir.awaitingTakeover().map((b) => b.nameHex)).toEqual([eur.nameHex]);
  });
});

describe("§C2: registering is holding the book only where the record pins nothing", () => {
  it("a restarted genesis process is not seated over its own served history, and resumes by the same two calls", () => {
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
    expect(fresh.awaitingTakeover().map((b) => b.nameHex)).toEqual([eur.nameHex]);
    const spend = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.carol, 100n, 1n);
    expect(() => fresh.submitTransfer(spend.op, spend.signature)).toThrow(/takes the state over first/);
    // The anchor at a genesis seat is the empty book; the raise is its own
    // latest witnessed commitment. Registering did NOT seat it (the record
    // pins its own commitment), so a direct raise is refused — it anchors
    // first, exactly as any other seat does.
    expect(() => fresh.takeOver(eur, latest)).toThrow(/empty|pins no commitment/);
    fresh.takeOver(eur);
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
    heir.takeOver(eur); // the empty book, rightly
    heir.commit();
    at(venue, 32n);
    issue(heir, eur, 50n, 0n);
    at(venue, 33n);
    const latest = heir.commit();

    at(venue, 40n);
    const fresh = new Sequencer(HEIR_SECRET, venue);
    fresh.register(eur, signBacking(SECRETS.backer, eur));
    // The empty anchor still stands — but it serves nothing, and the raise
    // restores the real book.
    fresh.takeOver(eur);
    expect(fresh.awaitingTakeover().map((b) => b.nameHex)).toEqual([eur.nameHex]);
    const spend = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 1n, 0n);
    expect(() => fresh.submitTransfer(spend.op, spend.signature)).toThrow(/takes the state over first/);
    fresh.takeOver(eur, latest);
    expect(fresh.outstanding(eur)).toBe(50n);
  });

  it("the never-carried wall is closed: a backing registered after the operator's last commitment is servable", () => {
    // The operator committed for USD, then registered EUR. EUR's record
    // "pins" the USD-covering commitment — unreadable from the root — so the
    // empty book could fire neither on undefined nor through the successor's
    // evidence path (no carrying state ever existed). The operator's own
    // latest state, exhibited as carrying nothing for EUR, licenses the
    // empty book exactly as a predecessor's does.
    const venue = new LocalVenue();
    const usd = backingFor(venue, "USD");
    const eur = backingFor(venue);
    const sequencer = new Sequencer(SECRETS.operator, venue);
    sequencer.register(usd, signBacking(SECRETS.backer, usd));
    issue(sequencer, usd, 100n, 0n);
    const latest = sequencer.commit(); // carries USD only

    at(venue, 5n);
    sequencer.register(eur, signBacking(SECRETS.backer, eur));
    expect(sequencer.awaitingTakeover().map((b) => b.nameHex)).toEqual([eur.nameHex]);
    // The exhibit: my own latest commitment, carrying nothing for EUR.
    sequencer.takeOver(eur, undefined, { snapshots: latest.snapshots, commitment: latest.commitment });
    expect(sequencer.awaitingTakeover()).toHaveLength(0);
    expect(issue(sequencer, eur, 10n, 0n).position).toBe(0n);
    at(venue, 6n);
    expect(sequencer.commit().snapshots).toHaveLength(2);
  });
});
