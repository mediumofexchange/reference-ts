import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { signBacking, type Backing } from "../src/backing.js";
import { compareBytes } from "../src/bytes.js";
import { encodeIssuanceMessage, encodeTransferMessage } from "../src/messages.js";
import { type PublishedOp } from "../src/oplog.js";
import {
  encodeAcceptanceMessage,
  encodeDemandMessage,
  encodeReleaseMessage,
  encodeWithdrawalMessage,
} from "../src/presentation.js";
import { receiptStatus, verifyReceipt } from "../src/receipt.js";
import { gapOpen, snapshotRedemptions, stateIsAuthentic } from "../src/recovery.js";
import { Sequencer, SequencerError } from "../src/sequencer.js";
import { LocalVenue } from "../src/venue.js";
import { KEYS, makeTransparentBacking, SECRETS, advanceWitnessedIndex } from "./support.js";

// §C2b: "a sequencer returning from silence adopts every nullifier witnessed
// during the gap before co-signing again", and the aggravated grade "runs from
// the first missed commitment until commitments resume".
//
// Read together those two sentences say what returning IS. A publication at the
// venue has force while the gap runs, and the gap runs until a commitment is
// witnessed — so an operator cannot have adopted "every nullifier witnessed
// during the gap" until it has closed the gap, and only its commitment closes
// it. Returning from silence is committing. And what the operator co-signed
// after its last commitment and before the silence was never witnessed: "a
// payment is final when witnessed, not when co-signed" (CLAUDE.md, §C2), so it
// died with the gap, exactly as a predecessor's tail dies when a successor takes
// over from the committed state (takeOver). The verifier's fold (walkGap) has
// always read the gap that way; until this slice the operator did not, so the
// two disagreed wherever the tail and the gap conflicted (the 2026-08-22 audit,
// B-2 and B-4), and again at the very index the return commitment landed, where
// a publication still counts as in the gap (the tie rule: judged strictly
// before its own index).
//
// One predicate settles both sides: `gapOpen` — would a publication at the
// present index have gap force — which is the verifier's own `publishedInGap`
// read at the door. While it answers yes the operator serves nothing; its
// commit first restores its book to the last commitment and then adopts the
// gap; from the index after that commitment it serves again.

const SILENCE = { noCommitmentDuration: 10n, challengeWindow: 5n };

function setup(silence: typeof SILENCE | null = SILENCE, startAt = 0n) {
  const venue = new LocalVenue();
  advanceWitnessedIndex(venue, startAt);
  const sequencer = new Sequencer(SECRETS.operator, venue);
  const backing = makeTransparentBacking(SECRETS.backer, "EUR", [], silence ?? undefined);
  sequencer.register(backing, signBacking(SECRETS.backer, backing));
  return { venue, sequencer, backing };
}

function issue(sequencer: Sequencer, backing: Backing, to: Uint8Array, quantity: bigint, nonce: bigint) {
  return sequencer.submitIssue(
    { backing, recipient: to, quantity, nonce },
    ed25519.sign(encodeIssuanceMessage(backing.name, to, quantity, nonce), SECRETS.backer),
  );
}

/**
 * The served state and the commitment it proves against — what a holder is
 * handed. Committed first, then snapshotted: a commit on return adopts the gap
 * (and restores the book) before it publishes, so a snapshot taken ahead of it
 * would be of a state the commitment does not root.
 */
function served(sequencer: Sequencer) {
  const commitment = sequencer.commit();
  return { snapshots: sequencer.snapshot(), commitment };
}

function transferOp(backing: Backing, secret: Uint8Array, from: Uint8Array, to: Uint8Array, quantity: bigint, nonce: bigint) {
  const op = { backing, from, to, quantity, nonce };
  const signature = ed25519.sign(encodeTransferMessage(backing.name, from, to, quantity, nonce), secret);
  const published: PublishedOp = { kind: "transfer", from, to, quantity, nonce, signature };
  return { op, signature, published };
}

function demandOp(backing: Backing, secret: Uint8Array, holder: Uint8Array, quantity: bigint, instant: bigint, deadline: bigint, nonce: bigint) {
  const message = encodeDemandMessage(backing.name, holder, quantity, instant, deadline, nonce);
  const signature = ed25519.sign(message, secret);
  const published: PublishedOp = { kind: "demand", holder, quantity, instant, deadline, nonce, signature };
  return { op: { backing, holder, quantity, instant, deadline, nonce }, signature, published, hash: sha256(message) };
}

function acceptanceOp(backing: Backing, hash: Uint8Array, instant: bigint, deadline: bigint, nonce: bigint): PublishedOp {
  const message = encodeAcceptanceMessage(backing.name, hash, instant, deadline, nonce);
  return { kind: "acceptance", demandHash: hash, instant, deadline, nonce, signature: ed25519.sign(message, SECRETS.backer) };
}

function releaseOp(backing: Backing, secret: Uint8Array, hash: Uint8Array, nonce: bigint): PublishedOp {
  const message = encodeReleaseMessage(backing.name, hash, nonce);
  return { kind: "release", demandHash: hash, nonce, signature: ed25519.sign(message, secret) };
}

function withdrawalOp(backing: Backing, secret: Uint8Array, hash: Uint8Array, nonce: bigint) {
  const signature = ed25519.sign(encodeWithdrawalMessage(backing.name, hash, nonce), secret);
  return { op: { backing, demandHash: hash, nonce }, signature };
}

/** Publish at exactly witnessed index `at`. */
function publishAt(venue: LocalVenue, at: bigint, backing: Backing, op: PublishedOp): void {
  advanceWitnessedIndex(venue, at);
  venue.publishOp(backing.name, op);
}

/** Alice presents at the venue: demand, the backer's answer, her release — three consecutive indices from `from`. */
function redeemAtVenue(venue: LocalVenue, backing: Backing, from: bigint, holderNonce: bigint, backerNonce: bigint, quantity = 100n) {
  const claim = demandOp(backing, SECRETS.alice, KEYS.alice, quantity, from, from + 60n, holderNonce);
  publishAt(venue, from, backing, claim.published);
  publishAt(venue, from + 1n, backing, acceptanceOp(backing, claim.hash, from, from + 60n, backerNonce));
  publishAt(venue, from + 2n, backing, releaseOp(backing, SECRETS.alice, claim.hash, holderNonce + 1n));
  return claim;
}

const kinds = (sequencer: Sequencer, backing: Backing) => sequencer.opLog(backing).map((entry) => entry.kind);

describe("§C2b: while the gap is open the operator serves nothing, and its commit is the way back", () => {
  it("gapOpen is the verifier's own predicate read at the present index: open from duration+1 after the last commitment, closed from the index after the next", () => {
    const { venue, sequencer, backing } = setup();
    sequencer.commit(); // at 0
    advanceWitnessedIndex(venue, 10n);
    expect(gapOpen(venue, backing)).toBe(false);
    advanceWitnessedIndex(venue, 11n);
    expect(gapOpen(venue, backing)).toBe(true);
    advanceWitnessedIndex(venue, 20n);
    sequencer.commit(); // the return, at 20
    // A publication at 20 is judged strictly before its own index, where the last
    // commitment is still the one at 0: the return index is inside the gap.
    expect(gapOpen(venue, backing)).toBe(true);
    advanceWitnessedIndex(venue, 21n);
    expect(gapOpen(venue, backing)).toBe(false);
  });

  it("every door refuses while the gap is open — an act, and a repeat of a committed operation alike — and names the commit", () => {
    const { venue, sequencer, backing } = setup();
    const first = issue(sequencer, backing, KEYS.alice, 100n, 0n);
    sequencer.commit(); // at 0
    advanceWitnessedIndex(venue, 11n);
    const spend = transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    expect(() => sequencer.submitTransfer(spend.op, spend.signature)).toThrow(/commits first/);
    const claim = demandOp(backing, SECRETS.alice, KEYS.alice, 10n, 11n, 50n, 0n);
    expect(() => sequencer.submitDemand(claim.op, claim.signature)).toThrow(/commits first/);
    // The repeat too: a repeat is a read of the receipt book, and while the gap
    // is open that book is about to be rebuilt. It is answered from the index
    // after the commit, as every other door is.
    expect(() => issue(sequencer, backing, KEYS.alice, 100n, 0n)).toThrow(/commits first/);
    expect(() => sequencer.submitIssue({ backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n }, new Uint8Array(64))).toThrow(SequencerError);
    // The honest path the refusal names: commit, then serve from the next index.
    sequencer.commit(); // at 11
    expect(() => sequencer.submitTransfer(spend.op, spend.signature)).toThrow(/commits first/);
    advanceWitnessedIndex(venue, 12n);
    expect(verifyReceipt(sequencer.submitTransfer(spend.op, spend.signature))).toBe(true);
    expect(sequencer.submitIssue({ backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n }, new Uint8Array(64))).toEqual(first);
  });

  it("a fresh operator at an index past the duration commits before it serves: quiet is counted from the venue's genesis", () => {
    // Otherwise never publishing at all would be the way to escape the grade,
    // and everything it served meanwhile would be a tail nobody witnessed.
    const { venue, sequencer, backing } = setup(SILENCE, 50n);
    expect(() => issue(sequencer, backing, KEYS.alice, 100n, 0n)).toThrow(/commits first/);
    sequencer.commit(); // at 50
    advanceWitnessedIndex(venue, 51n);
    expect(verifyReceipt(issue(sequencer, backing, KEYS.alice, 100n, 0n))).toBe(true);
  });

  it("a backing that declares no silence clause has no gap to open: its tail lives through any quiet", () => {
    const { venue, sequencer, backing } = setup(null);
    issue(sequencer, backing, KEYS.alice, 100n, 0n);
    sequencer.commit();
    advanceWitnessedIndex(venue, 1n);
    const spend = transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    sequencer.submitTransfer(spend.op, spend.signature);
    advanceWitnessedIndex(venue, 1_000_000n);
    expect(gapOpen(venue, backing)).toBe(false);
    const again = transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 1n);
    expect(verifyReceipt(sequencer.submitTransfer(again.op, again.signature))).toBe(true);
    sequencer.commit();
    expect(kinds(sequencer, backing)).toEqual(["issue", "transfer", "transfer"]);
    expect(sequencer.balance(backing, KEYS.bob)).toBe(20n);
  });

  it("two backings grade one quiet by their own durations: only the one whose gap opened is rebuilt, and only its doors are shut", () => {
    const venue = new LocalVenue();
    const sequencer = new Sequencer(SECRETS.operator, venue);
    const patient = makeTransparentBacking(SECRETS.backer, "EUR", [], { noCommitmentDuration: 100n, challengeWindow: 5n });
    const strict = makeTransparentBacking(SECRETS.backer2, "kWh", [], { noCommitmentDuration: 5n, challengeWindow: 5n });
    sequencer.register(patient, signBacking(SECRETS.backer, patient));
    sequencer.register(strict, signBacking(SECRETS.backer2, strict));
    issue(sequencer, patient, KEYS.alice, 100n, 0n);
    sequencer.submitIssue(
      { backing: strict, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(strict.name, KEYS.alice, 100n, 0n), SECRETS.backer2),
    );
    sequencer.commit(); // at 0
    advanceWitnessedIndex(venue, 1n);
    // The tail, on both.
    const onPatient = transferOp(patient, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    const onStrict = transferOp(strict, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    sequencer.submitTransfer(onPatient.op, onPatient.signature);
    sequencer.submitTransfer(onStrict.op, onStrict.signature);
    advanceWitnessedIndex(venue, 20n);
    expect(gapOpen(venue, strict)).toBe(true);
    expect(gapOpen(venue, patient)).toBe(false);
    // The patient backing's doors are open; the strict one's are shut.
    const more = transferOp(patient, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 1n);
    expect(verifyReceipt(sequencer.submitTransfer(more.op, more.signature))).toBe(true);
    const refused = transferOp(strict, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 1n);
    expect(() => sequencer.submitTransfer(refused.op, refused.signature)).toThrow(/commits first/);
    sequencer.commit(); // at 20: strict is rebuilt, patient is not
    expect(kinds(sequencer, patient)).toEqual(["issue", "transfer", "transfer"]);
    expect(kinds(sequencer, strict)).toEqual(["issue"]);
    expect(sequencer.balance(strict, KEYS.bob)).toBe(0n);
    expect(sequencer.balance(patient, KEYS.bob)).toBe(20n);
  });
});

describe("§C2b: the return commit restores the book to the last commitment, then adopts the gap — so the operator and the verifier read one history", () => {
  it("a demand withdrawn in the tail and settled in the gap: the withdrawal died unwitnessed, and the settlement stands for both readers (audit B-2)", () => {
    const { venue, sequencer, backing } = setup();
    issue(sequencer, backing, KEYS.alice, 100n, 0n);
    const claim = demandOp(backing, SECRETS.alice, KEYS.alice, 100n, 0n, 60n, 0n);
    sequencer.submitDemand(claim.op, claim.signature);
    const before = served(sequencer); // at 0, the demand standing
    // The tail: unanswered, so Alice may withdraw — the operator co-signs, and
    // then goes dark before it ever commits again.
    advanceWitnessedIndex(venue, 1n);
    const w = withdrawalOp(backing, SECRETS.alice, claim.hash, 1n);
    const deadReceipt = sequencer.submitWithdrawal(w.op, w.signature);
    expect(sequencer.openDemands(backing)).toHaveLength(0);
    // The gap: the backer, reading the last committed snapshot, answers the
    // standing demand at the venue; Alice releases.
    publishAt(venue, 11n, backing, acceptanceOp(backing, claim.hash, 0n, 60n, 1n));
    publishAt(venue, 12n, backing, releaseOp(backing, SECRETS.alice, claim.hash, 1n));
    advanceWitnessedIndex(venue, 18n);
    const redemptions = snapshotRedemptions(venue, backing, before);
    expect(redemptions).toHaveLength(1);
    expect(compareBytes(redemptions[0]!.payments[0]!.payee, KEYS.alice)).toBe(0);
    expect(redemptions[0]!.payments[0]!.quantity).toBe(100n);
    // The return: the operator commits, and its book is the verifier's history.
    const after = served(sequencer); // at 18
    expect(kinds(sequencer, backing)).toEqual(["issue", "demand", "acceptance", "release"]);
    expect(sequencer.balance(backing, KEYS.alice)).toBe(0n);
    expect(sequencer.balance(backing, KEYS.backer)).toBe(100n);
    expect(stateIsAuthentic(backing, venue, after)).toBe(true);
    // The withdrawal's receipt attests an act the operator took and never
    // witnessed: its position now holds the acceptance. What a reader should
    // make of that is 28b's question (below); what this slice settles is that
    // the book no longer holds the act.
    expect(deadReceipt.position).toBe(2n);
    advanceWitnessedIndex(venue, 19n);
    expect(() => sequencer.submitWithdrawal(w.op, w.signature)).toThrow(/no such standing demand/);
  });

  it("a transfer in the tail, the same units redeemed in the gap, the payee challenging: the payee is paid once, by the payout, and holds no units (audit B-4)", () => {
    const { venue, sequencer, backing } = setup();
    issue(sequencer, backing, KEYS.alice, 100n, 0n);
    const before = served(sequencer); // at 0
    advanceWitnessedIndex(venue, 1n);
    const spend = transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.bob, 100n, 0n);
    sequencer.submitTransfer(spend.op, spend.signature);
    expect(sequencer.balance(backing, KEYS.bob)).toBe(100n);
    // The gap: Alice redeems the units she already paid away, against the last
    // committed snapshot; Bob challenges with the request that spent them.
    const claim = redeemAtVenue(venue, backing, 11n, 0n, 1n);
    publishAt(venue, 14n, backing, spend.published);
    advanceWitnessedIndex(venue, 19n);
    const redemption = snapshotRedemptions(venue, backing, before)[0]!;
    expect(compareBytes(redemption.demandHash, claim.hash)).toBe(0);
    expect(redemption.payments).toHaveLength(1);
    expect(compareBytes(redemption.payments[0]!.payee, KEYS.bob)).toBe(0);
    expect(redemption.payments[0]!.quantity).toBe(100n);
    // The return: the tail transfer is gone, the redemption is in the book.
    sequencer.commit();
    expect(kinds(sequencer, backing)).toEqual(["issue", "demand", "acceptance", "release"]);
    expect(sequencer.balance(backing, KEYS.bob)).toBe(0n);
    expect(sequencer.balance(backing, KEYS.alice)).toBe(0n);
    expect(sequencer.balance(backing, KEYS.backer)).toBe(100n);
    expect(sequencer.outstanding(backing)).toBe(100n);
  });

  it("a leg published at the return commitment's own index is adopted at the next index, onto the committed state, and nothing was co-signed in between (the return-index probe)", () => {
    const { venue, sequencer, backing } = setup();
    issue(sequencer, backing, KEYS.alice, 100n, 0n);
    const before = served(sequencer); // at 0
    advanceWitnessedIndex(venue, 20n);
    sequencer.commit(); // the return, at 20
    // At 20 the operator co-signs nothing — a transfer here is what let Bob hold
    // the units while the verifier paid Alice for them.
    const spend = transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.bob, 100n, 0n);
    expect(() => sequencer.submitTransfer(spend.op, spend.signature)).toThrow(/commits first/);
    // Alice presents at 20, after the commit: still in the gap by the tie rule.
    const claim = demandOp(backing, SECRETS.alice, KEYS.alice, 100n, 20n, 80n, 0n);
    venue.publishOp(backing.name, claim.published);
    venue.publishOp(backing.name, acceptanceOp(backing, claim.hash, 20n, 80n, 1n));
    venue.publishOp(backing.name, releaseOp(backing, SECRETS.alice, claim.hash, 1n));
    advanceWitnessedIndex(venue, 21n);
    // The first door at 21 adopts the three legs before it co-signs anything:
    // Alice's nonce 0 is her demand now, and the transfer at it is refused.
    expect(() => sequencer.submitTransfer(spend.op, spend.signature)).toThrow(/nonce already spent/);
    expect(kinds(sequencer, backing)).toEqual(["issue", "demand", "acceptance", "release"]);
    expect(sequencer.balance(backing, KEYS.backer)).toBe(100n);
    advanceWitnessedIndex(venue, 26n);
    const redemptions = snapshotRedemptions(venue, backing, before);
    expect(redemptions).toHaveLength(1);
    expect(compareBytes(redemptions[0]!.payments[0]!.payee, KEYS.alice)).toBe(0);
  });

  it("an operation the gap killed is a fresh act when resubmitted: it applies at a new position with a new receipt, and the dead receipt is forgotten", () => {
    const { venue, sequencer, backing } = setup();
    issue(sequencer, backing, KEYS.alice, 100n, 0n);
    issue(sequencer, backing, KEYS.carol, 100n, 1n);
    sequencer.commit(); // at 0
    advanceWitnessedIndex(venue, 1n);
    const spend = transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.bob, 100n, 0n);
    const dead = sequencer.submitTransfer(spend.op, spend.signature);
    expect(dead.position).toBe(2n);
    // The gap: Carol presents at the venue, and is settled.
    const claim = demandOp(backing, SECRETS.carol, KEYS.carol, 100n, 11n, 70n, 0n);
    publishAt(venue, 11n, backing, claim.published);
    publishAt(venue, 12n, backing, acceptanceOp(backing, claim.hash, 11n, 70n, 2n));
    publishAt(venue, 13n, backing, releaseOp(backing, SECRETS.carol, claim.hash, 1n));
    advanceWitnessedIndex(venue, 20n);
    const after = served(sequencer); // the return, at 20
    expect(kinds(sequencer, backing)).toEqual(["issue", "issue", "demand", "acceptance", "release"]);
    expect(sequencer.balance(backing, KEYS.bob)).toBe(0n);
    // Bob holds the signed request and resubmits it himself once the operator
    // serves again. Had the operator kept the dead receipt, invariant 26 would
    // have answered him with it and applied nothing.
    advanceWitnessedIndex(venue, 21n);
    const fresh = sequencer.submitTransfer(spend.op, spend.signature);
    expect(fresh.position).toBe(5n);
    expect(sequencer.balance(backing, KEYS.bob)).toBe(100n);
    // And the repeat of the fresh act is the fresh receipt.
    expect(sequencer.submitTransfer(spend.op, spend.signature)).toEqual(fresh);
    // OPEN (28b): the dead receipt's position holds the demand now, and a reader
    // of the return commitment calls that `contradicted` — an honest operator
    // accused of lying about its log for having gone silent. The receipt must
    // say which record it was signed against before a reader can tell a dead
    // tail from a lie; until then this pins the question rather than the answer.
    expect(receiptStatus(backing, venue, dead, after)).toBe("contradicted");
  });

  it("adopting twice in one gap is idempotent: one book, one set of positions, and the receipts are the same on the first ask after the return", () => {
    const { venue, sequencer, backing } = setup();
    issue(sequencer, backing, KEYS.alice, 100n, 0n);
    sequencer.commit();
    advanceWitnessedIndex(venue, 1n);
    const spend = transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    sequencer.submitTransfer(spend.op, spend.signature); // the tail
    const claim = redeemAtVenue(venue, backing, 11n, 0n, 1n, 90n);
    sequencer.adopt(backing);
    const once = sequencer.opLog(backing);
    sequencer.adopt(backing);
    expect(sequencer.opLog(backing)).toEqual(once);
    expect(kinds(sequencer, backing)).toEqual(["issue", "demand", "acceptance", "release"]);
    // And the return commit leaves the book as the adopts did: the legs sit at
    // the positions they were first given, and their receipts are obtainable.
    advanceWitnessedIndex(venue, 15n);
    sequencer.commit();
    advanceWitnessedIndex(venue, 16n);
    const release = sequencer.submitRelease({ backing, demandHash: claim.hash, nonce: 1n }, new Uint8Array(64));
    expect(release.position).toBe(3n);
    expect(verifyReceipt(release)).toBe(true);
  });

  it("the first ask after the return for the receipt of a leg the venue took is answered, and the rebuild drops only the tail, never the committed prefix", () => {
    const { venue, sequencer, backing } = setup();
    const first = issue(sequencer, backing, KEYS.alice, 100n, 0n);
    const second = issue(sequencer, backing, KEYS.carol, 50n, 1n);
    sequencer.commit(); // at 0
    advanceWitnessedIndex(venue, 1n);
    const spend = transferOp(backing, SECRETS.carol, KEYS.carol, KEYS.bob, 50n, 0n);
    sequencer.submitTransfer(spend.op, spend.signature); // the tail
    const claim = redeemAtVenue(venue, backing, 11n, 0n, 2n);
    advanceWitnessedIndex(venue, 20n);
    sequencer.commit();
    advanceWitnessedIndex(venue, 21n);
    // Committed receipts survive; the gap's legs have theirs; the tail's are gone.
    expect(sequencer.submitIssue({ backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n }, new Uint8Array(64))).toEqual(first);
    expect(sequencer.submitIssue({ backing, recipient: KEYS.carol, quantity: 50n, nonce: 1n }, new Uint8Array(64))).toEqual(second);
    const release = sequencer.submitRelease({ backing, demandHash: claim.hash, nonce: 1n }, new Uint8Array(64));
    expect(release.position).toBe(4n);
    expect(sequencer.balance(backing, KEYS.carol)).toBe(50n);
    expect(sequencer.balance(backing, KEYS.bob)).toBe(0n);
  });
});
