import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { compareBytes } from "../src/bytes.js";
import { TransparentLedger } from "../src/ledger.js";
import { encodeBurnMessage, encodeIssuanceMessage, encodeTransferMessage } from "../src/messages.js";
import { type PublishedOp } from "../src/oplog.js";
import {
  encodeAcceptanceMessage,
  encodeDemandMessage,
  encodeLock,
  encodeReleaseMessage,
  encodeWithdrawalMessage,
  NO_DECISION_VENUE,
  signCommit,
  type LockOp,
} from "../src/presentation.js";
import { receiptStatus, verifyReceipt } from "../src/receipt.js";
import { gapLegsFor, gapOpen, isSilent, snapshotRedemptions, stateIsAuthentic } from "../src/recovery.js";
import { operatorAt, replacementMessage, ROLE_OPERATOR, type Replacement } from "../src/replacement.js";
import { Sequencer } from "../src/sequencer.js";
import { LocalVenue } from "../src/venue.js";
import { KEYS, makeTransparentBacking, pub, SECRETS, advanceWitnessedIndex } from "./support.js";

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
// present index have gap force, and against whose silence — which is the
// verifier's own `publishedInGap` read at the door. While it names this
// operator's own silence on any backing it serves, no door co-signs: acts are
// refused and name the commit, repeats are answered from a book already
// restored to the last commitment (the tail is the OPERATOR'S — one commitment
// covers every backing it serves, so one return restores every backing, or a
// set taken as one act would be torn); the commit adopts the gap; and from the
// index after that commitment the operator serves again.

const SILENCE = { noCommitmentDuration: 10n, challengeWindow: 5n };
const SUCCESSOR_SECRET = new Uint8Array(32).fill(0x0b);
const SUCCESSOR = pub(SUCCESSOR_SECRET);

function setup(silence: typeof SILENCE | null = SILENCE, startAt = 0n) {
  const venue = new LocalVenue();
  advanceWitnessedIndex(venue, startAt);
  const sequencer = new Sequencer(SECRETS.operator, venue);
  const backing = makeTransparentBacking(SECRETS.backer, "EUR", [], silence ?? undefined);
  sequencer.register(backing, signBacking(SECRETS.backer, backing));
  return { venue, sequencer, backing };
}

/** Two backings on one operator, EUR relying on GOLD x2, Alice holding 200 of each, each with its own silence duration. */
function pair(eurDuration: bigint, goldDuration: bigint) {
  const venue = new LocalVenue();
  const mk = (thing: string, duration: bigint, reliance: { target: Uint8Array; count: bigint }[] = []) =>
    makeBacking({
      obligor: KEYS.backer,
      payout: { thing, quantumExponent: -2, perUnit: 100n },
      reliance,
      evidence: {
        setting: "transparent",
        operator: KEYS.operator,
        silence: { noCommitmentDuration: duration, challengeWindow: 5n },
      },
    });
  const gold = mk("GOLD", goldDuration);
  const eur = mk("EUR", eurDuration, [{ target: gold.name, count: 2n }]);
  const sequencer = new Sequencer(SECRETS.operator, venue);
  for (const backing of [gold, eur]) {
    sequencer.register(backing, signBacking(SECRETS.backer, backing));
    issue(sequencer, backing, KEYS.alice, 200n, 0n);
  }
  return { venue, sequencer, eur, gold };
}

function issue(sequencer: Sequencer, backing: Backing, to: Uint8Array, quantity: bigint, nonce: bigint, secret = SECRETS.backer) {
  return sequencer.submitIssue(
    { backing, recipient: to, quantity, nonce },
    ed25519.sign(encodeIssuanceMessage(backing.name, to, quantity, nonce), secret),
  );
}

/**
 * The served state and the commitment it proves against — what a holder is
 * handed. Committed first, then snapshotted: a commit on return restores the
 * book and adopts the gap before it publishes, so a snapshot taken ahead of it
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

/** A signed request, as the doors take it. */
function signed<T extends { backing: Backing }>(op: T, message: Uint8Array, secret: Uint8Array) {
  return { op, signature: ed25519.sign(message, secret) };
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

function replacementBy(backing: Backing, ruleSecret: Uint8Array, successor: Uint8Array, predecessor: Uint8Array, effective: bigint): Replacement {
  const unsigned = { role: ROLE_OPERATOR, successor, predecessor, effective, signature: new Uint8Array(64) };
  return { ...unsigned, signature: ed25519.sign(replacementMessage(backing.name, unsigned), ruleSecret) };
}

const kinds = (sequencer: Sequencer, backing: Backing) => sequencer.opLog(backing).map((entry) => entry.kind);
const RETURNING = /commits first/;

describe("§C2b: while its own gap is open the operator co-signs nothing, and its commit is the way back", () => {
  it("gapOpen answers exactly where a publication now would have force — the verifier's own fold — names whose silence it is, and is silent on a record the backing does not declare", () => {
    const { venue, sequencer, backing } = setup();
    sequencer.commit(); // at 0
    // At every index from 1 to 25 (the return commitment lands at 20): the door's
    // answer and the fold's agree — a demand published at t is a gap leg iff
    // gapOpen answered at t.
    const seen: [bigint, boolean, boolean][] = [];
    for (let t = 1n; t <= 25n; t++) {
      advanceWitnessedIndex(venue, t);
      if (t === 20n) sequencer.commit();
      const open = gapOpen(venue, backing);
      const claim = demandOp(backing, SECRETS.alice, KEYS.alice, 1n, t, t + 50n, t); // the nonce varies the bytes
      venue.publishOp(backing.name, claim.published);
      const hasForce = gapLegsFor(venue, backing).some((w) => w.at === t);
      seen.push([t, open !== undefined, hasForce]);
      if (open !== undefined) expect(compareBytes(open, KEYS.operator)).toBe(0);
    }
    for (const [, open, hasForce] of seen) expect(open).toBe(hasForce);
    // And the shape of it: closed through 10, open from 11 — including 20, the
    // return index itself, where a publication is judged strictly before it —
    // closed from 21.
    expect(seen.map(([, open]) => open)).toEqual([...Array(25)].map((_, i) => i + 1 >= 11 && i + 1 <= 20));
    // A record the backing does not declare gives a publication no force, so
    // the door's answer there is "nothing", as every clause reader's is.
    const other = new LocalVenue(new Uint8Array(32).fill(0x0e));
    advanceWitnessedIndex(other, 100n);
    const declared = makeTransparentBacking(SECRETS.backer, "EUR", [], SILENCE, { venue: venue.id, interval: 5n });
    expect(gapOpen(other, declared)).toBeUndefined();
  });

  it("every door refuses an act while the gap is open, naming the commit — and a repeat of a committed operation is answered, since a repeat is a read", () => {
    const { venue, sequencer, eur, gold } = pair(10n, 10n);
    const first = issue(sequencer, eur, KEYS.carol, 10n, 1n);
    // A reliant demand with its leg, and a bundle lock whose commit the venue
    // will show: the doors the gap must shut are shaped so that each one's own
    // checks pass and only the gap stands in the way.
    const claim = demandOp(eur, SECRETS.alice, KEYS.alice, 40n, 0n, 90n, 0n);
    const leg: LockOp = { backing: gold, attemptId: claim.hash, holder: KEYS.alice, beneficiary: KEYS.backer, quantity: 80n, timeout: 8n, decisionVenue: NO_DECISION_VENUE, parties: [KEYS.alice], nonce: 0n };
    sequencer.submitDemand(claim.op, claim.signature, [signed(leg, encodeLock(leg), SECRETS.alice)]);
    const attempt = new Uint8Array(32).fill(0x5e);
    const bundle: LockOp = { backing: gold, attemptId: attempt, holder: KEYS.alice, beneficiary: KEYS.bob, quantity: 10n, timeout: 100n, decisionVenue: venue.id, parties: [KEYS.alice], nonce: 1n };
    sequencer.submitLock(bundle, ed25519.sign(encodeLock(bundle), SECRETS.alice));
    sequencer.commit(); // at 0
    advanceWitnessedIndex(venue, 11n);
    venue.publishCommit(signCommit(SECRETS.alice, attempt));
    const at = (door: () => unknown) => expect(door).toThrow(RETURNING);
    at(() => issue(sequencer, eur, KEYS.carol, 10n, 2n));
    const spend = transferOp(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 1n);
    at(() => sequencer.submitTransfer(spend.op, spend.signature));
    at(() => sequencer.submitBurn({ backing: eur, holder: KEYS.alice, quantity: 1n, nonce: 1n }, ed25519.sign(encodeBurnMessage(eur.name, KEYS.alice, 1n, 1n), SECRETS.alice)));
    const plain = demandOp(gold, SECRETS.alice, KEYS.alice, 5n, 11n, 50n, 2n);
    at(() => sequencer.submitDemand(plain.op, plain.signature));
    const another: LockOp = { ...bundle, attemptId: new Uint8Array(32).fill(0x5f), nonce: 2n };
    at(() => sequencer.submitLock(another, ed25519.sign(encodeLock(another), SECRETS.alice)));
    // The leg's timeout (8) has passed, so a re-prepare is the holder's honest
    // move — refused here by the gap, ahead of the law.
    const again: LockOp = { ...leg, timeout: 60n, nonce: 2n };
    at(() => sequencer.submitLeg(eur, claim.hash, signed(again, encodeLock(again), SECRETS.alice)));
    at(() => sequencer.settle(gold, attempt));
    at(() => sequencer.submitAcceptance({ backing: eur, demandHash: claim.hash, instant: 0n, deadline: 90n, nonce: 2n }, ed25519.sign(encodeAcceptanceMessage(eur.name, claim.hash, 0n, 90n, 2n), SECRETS.backer)));
    const head = withdrawalOp(eur, SECRETS.alice, claim.hash, 1n);
    const legOut = signed({ backing: gold, demandHash: claim.hash, nonce: 2n }, encodeWithdrawalMessage(gold.name, claim.hash, 2n), SECRETS.alice);
    at(() => sequencer.submitWithdrawal(head.op, head.signature, [legOut]));
    const release = signed({ backing: eur, demandHash: claim.hash, nonce: 1n }, encodeReleaseMessage(eur.name, claim.hash, 1n), SECRETS.alice);
    const legRelease = signed({ backing: gold, demandHash: claim.hash, nonce: 2n }, encodeReleaseMessage(gold.name, claim.hash, 2n), SECRETS.alice);
    at(() => sequencer.submitRelease(release.op, release.signature, [legRelease]));
    // Nothing was co-signed: the books are as committed.
    expect(kinds(sequencer, eur)).toEqual(["issue", "issue", "demand"]);
    expect(kinds(sequencer, gold)).toEqual(["issue", "lock", "lock"]);
    // The repeat of a committed operation is answered, with its receipt: a read
    // of the receipt book, not an act (DECISIONS 2026-08-22, the door order).
    expect(sequencer.submitIssue({ backing: eur, recipient: KEYS.carol, quantity: 10n, nonce: 1n }, new Uint8Array(64))).toEqual(first);
    // The honest path the refusal names: commit, then serve from the next index.
    sequencer.commit(); // at 11 — the return index is inside the gap
    at(() => sequencer.submitTransfer(spend.op, spend.signature));
    advanceWitnessedIndex(venue, 12n);
    expect(verifyReceipt(sequencer.submitTransfer(spend.op, spend.signature))).toBe(true);
    expect(verifyReceipt(sequencer.settle(gold, attempt))).toBe(true);
    expect(sequencer.balance(gold, KEYS.bob)).toBe(10n);
  });

  it("a fresh operator at an index past the duration commits before it serves: quiet is counted from the venue's genesis", () => {
    // Otherwise never publishing at all would be the way to escape the grade,
    // and everything it served meanwhile would be a tail nobody witnessed.
    const { venue, sequencer, backing } = setup(SILENCE, 50n);
    expect(() => issue(sequencer, backing, KEYS.alice, 100n, 0n)).toThrow(RETURNING);
    sequencer.commit(); // at 50
    advanceWitnessedIndex(venue, 51n);
    expect(verifyReceipt(issue(sequencer, backing, KEYS.alice, 100n, 0n))).toBe(true);
  });

  it("a backing that declares no silence clause has no gap to open: on its own it keeps its tail through any quiet", () => {
    const { venue, sequencer, backing } = setup(null);
    issue(sequencer, backing, KEYS.alice, 100n, 0n);
    sequencer.commit();
    advanceWitnessedIndex(venue, 1n);
    const spend = transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    sequencer.submitTransfer(spend.op, spend.signature);
    advanceWitnessedIndex(venue, 1_000_000n);
    expect(gapOpen(venue, backing)).toBeUndefined();
    const again = transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 1n);
    expect(verifyReceipt(sequencer.submitTransfer(again.op, again.signature))).toBe(true);
    sequencer.commit();
    expect(kinds(sequencer, backing)).toEqual(["issue", "transfer", "transfer"]);
    expect(sequencer.balance(backing, KEYS.bob)).toBe(20n);
  });

  it("one quiet, two durations: the grades and the gap's force are each backing's own, and the book is the operator's — one return restores both tails and shuts both doors", () => {
    const venue = new LocalVenue();
    const sequencer = new Sequencer(SECRETS.operator, venue);
    const patient = makeTransparentBacking(SECRETS.backer, "EUR", [], { noCommitmentDuration: 100n, challengeWindow: 5n });
    const strict = makeTransparentBacking(SECRETS.backer2, "kWh", [], { noCommitmentDuration: 5n, challengeWindow: 5n });
    sequencer.register(patient, signBacking(SECRETS.backer, patient));
    sequencer.register(strict, signBacking(SECRETS.backer2, strict));
    issue(sequencer, patient, KEYS.alice, 100n, 0n);
    issue(sequencer, strict, KEYS.alice, 100n, 0n, SECRETS.backer2);
    sequencer.commit(); // at 0
    advanceWitnessedIndex(venue, 1n);
    // The tail, on both.
    const onPatient = transferOp(patient, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    const onStrict = transferOp(strict, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    sequencer.submitTransfer(onPatient.op, onPatient.signature);
    sequencer.submitTransfer(onStrict.op, onStrict.signature);
    advanceWitnessedIndex(venue, 20n);
    // Per backing: the grade, and whether a publication has force.
    expect(isSilent(venue, strict)).toBe(true);
    expect(isSilent(venue, patient)).toBe(false);
    expect(gapOpen(venue, strict)).toBeDefined();
    expect(gapOpen(venue, patient)).toBeUndefined();
    venue.publishOp(strict.name, demandOp(strict, SECRETS.alice, KEYS.alice, 5n, 20n, 70n, 0n).published);
    venue.publishOp(patient.name, demandOp(patient, SECRETS.alice, KEYS.alice, 5n, 20n, 70n, 0n).published);
    expect(gapLegsFor(venue, strict)).toHaveLength(1);
    expect(gapLegsFor(venue, patient)).toHaveLength(0);
    // Per operator: the silence is its own, so the book is dead on both and no
    // door co-signs on either — a payment co-signed on the patient backing now
    // would be the next tail to die.
    const more = transferOp(patient, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 1n);
    expect(() => sequencer.submitTransfer(more.op, more.signature)).toThrow(RETURNING);
    const refused = transferOp(strict, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 1n);
    expect(() => sequencer.submitTransfer(refused.op, refused.signature)).toThrow(RETURNING);
    sequencer.commit(); // at 20: both restored; the strict backing's gap leg adopted
    expect(kinds(sequencer, patient)).toEqual(["issue"]);
    expect(kinds(sequencer, strict)).toEqual(["issue", "demand"]);
    expect(sequencer.balance(patient, KEYS.bob)).toBe(0n);
    expect(sequencer.balance(strict, KEYS.bob)).toBe(0n);
  });

  it("a set the ledger took as one act dies as one: the head's backing returning restores the leg's backing too, whatever its own duration says", () => {
    // Found reviewing this slice: restored per backing, a settlement whose head
    // sat on EUR (short duration, gap open) and whose leg sat on GOLD (long
    // duration, no gap) lost its head and kept its leg — the backer holding the
    // accompaniment and none of the claims. One commitment covers both logs, so
    // both halves are tail, and the tail is the operator's.
    const { venue, sequencer, eur, gold } = pair(10n, 1000n);
    const claim = demandOp(eur, SECRETS.alice, KEYS.alice, 40n, 0n, 90n, 0n);
    const leg: LockOp = { backing: gold, attemptId: claim.hash, holder: KEYS.alice, beneficiary: KEYS.backer, quantity: 80n, timeout: 500n, decisionVenue: NO_DECISION_VENUE, parties: [KEYS.alice], nonce: 0n };
    sequencer.submitDemand(claim.op, claim.signature, [signed(leg, encodeLock(leg), SECRETS.alice)]);
    sequencer.commit(); // at 0: the demand and its leg are committed
    advanceWitnessedIndex(venue, 1n);
    // The tail: the backer answers, Alice releases the set — both halves co-signed, neither witnessed.
    sequencer.submitAcceptance({ backing: eur, demandHash: claim.hash, instant: 0n, deadline: 90n, nonce: 1n }, ed25519.sign(encodeAcceptanceMessage(eur.name, claim.hash, 0n, 90n, 1n), SECRETS.backer));
    const release = signed({ backing: eur, demandHash: claim.hash, nonce: 1n }, encodeReleaseMessage(eur.name, claim.hash, 1n), SECRETS.alice);
    const legRelease = signed({ backing: gold, demandHash: claim.hash, nonce: 1n }, encodeReleaseMessage(gold.name, claim.hash, 1n), SECRETS.alice);
    sequencer.submitRelease(release.op, release.signature, [legRelease]);
    expect(sequencer.balance(eur, KEYS.backer)).toBe(40n);
    expect(sequencer.balance(gold, KEYS.backer)).toBe(80n);
    advanceWitnessedIndex(venue, 11n); // EUR's gap is open; GOLD's is not
    expect(gapOpen(venue, eur)).toBeDefined();
    expect(gapOpen(venue, gold)).toBeUndefined();
    sequencer.commit(); // the return
    // Whole again: the demand stands, the leg is reserved, nothing has moved.
    expect(kinds(sequencer, eur)).toEqual(["issue", "demand"]);
    expect(kinds(sequencer, gold)).toEqual(["issue", "lock"]);
    expect(sequencer.openDemands(eur)).toHaveLength(1);
    expect(sequencer.balance(eur, KEYS.backer)).toBe(0n);
    expect(sequencer.balance(gold, KEYS.backer)).toBe(0n);
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(120n);
  });

  it("whose silence it is decides whose book is dead: a successor at its handover index shuts the handed-over backing's doors for that index and keeps its own tail", () => {
    // The gap read at the handover index is the predecessor's: the operator in
    // force just before it. A publication there still lands with force on that
    // backing, so its doors shut for the index; but nothing of the successor's
    // own is unwitnessed for it, so its other backing's tail — co-signed while
    // it was punctual — is not restored.
    const venue = new LocalVenue();
    const eur = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: { setting: "transparent", operator: KEYS.operator, silence: SILENCE, replacementRule: KEYS.backer },
    });
    const usd = makeBacking({
      obligor: KEYS.backer2,
      payout: { thing: "USD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: { setting: "transparent", operator: SUCCESSOR, silence: { noCommitmentDuration: 50n, challengeWindow: 5n } },
    });
    const incumbent = new Sequencer(SECRETS.operator, venue);
    incumbent.register(eur, signBacking(SECRETS.backer, eur));
    issue(incumbent, eur, KEYS.alice, 100n, 0n);
    const before = served(incumbent); // at 0; then the incumbent goes dark
    const successor = new Sequencer(SUCCESSOR_SECRET, venue);
    successor.register(usd, signBacking(SECRETS.backer2, usd));
    issue(successor, usd, KEYS.carol, 100n, 0n, SECRETS.backer2);
    // The backer names the successor at 12, effective at 15; the successor's
    // commitment at 12 is what will give it force — from 15.
    advanceWitnessedIndex(venue, 12n);
    venue.publishReplacement(eur.name, replacementBy(eur, SECRETS.backer, SUCCESSOR, eur.name, 15n));
    successor.register(eur, signBacking(SECRETS.backer, eur));
    successor.takeOver(eur, before);
    successor.commit(); // at 12
    // Its own USD tail, co-signed at 13.
    advanceWitnessedIndex(venue, 13n);
    const own = transferOp(usd, SECRETS.carol, KEYS.carol, KEYS.bob, 10n, 0n);
    successor.submitTransfer(own.op, own.signature);
    advanceWitnessedIndex(venue, 15n);
    expect(operatorAt(eur, venue, 15n)).toEqual(SUCCESSOR);
    // EUR's gap at 15 is the predecessor's silence (last commitment at 0).
    expect(compareBytes(gapOpen(venue, eur) as Uint8Array, KEYS.operator)).toBe(0);
    const spend = transferOp(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    expect(() => successor.submitTransfer(spend.op, spend.signature)).toThrow(RETURNING);
    // USD is served at 15, and its tail stands.
    const more = transferOp(usd, SECRETS.carol, KEYS.carol, KEYS.bob, 10n, 1n);
    expect(verifyReceipt(successor.submitTransfer(more.op, more.signature))).toBe(true);
    expect(kinds(successor, usd)).toEqual(["issue", "transfer", "transfer"]);
    // From 16 EUR is served too, and the next commitment carries everything.
    advanceWitnessedIndex(venue, 16n);
    expect(verifyReceipt(successor.submitTransfer(spend.op, spend.signature))).toBe(true);
    const after = served(successor);
    expect(kinds(successor, usd)).toEqual(["issue", "transfer", "transfer"]);
    expect(kinds(successor, eur)).toEqual(["issue", "transfer"]);
    expect(stateIsAuthentic(eur, venue, after)).toBe(true);
  });

  it("a retired operator answers a repeat of a receipt it gave in force while its successor's gap is open, and a named successor not yet in force is refused for that reason and not this one", () => {
    const venue = new LocalVenue();
    const eur = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: { setting: "transparent", operator: KEYS.operator, silence: SILENCE, replacementRule: KEYS.backer },
    });
    const incumbent = new Sequencer(SECRETS.operator, venue);
    incumbent.register(eur, signBacking(SECRETS.backer, eur));
    const receipt = issue(incumbent, eur, KEYS.alice, 100n, 0n);
    const before = served(incumbent); // at 0
    advanceWitnessedIndex(venue, 5n);
    venue.publishReplacement(eur.name, replacementBy(eur, SECRETS.backer, SUCCESSOR, eur.name, 5n));
    const successor = new Sequencer(SUCCESSOR_SECRET, venue);
    successor.register(eur, signBacking(SECRETS.backer, eur));
    successor.takeOver(eur, before);
    // Named and not yet committed: refused at the in-force door, in its own words.
    const spend = transferOp(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    expect(() => successor.submitTransfer(spend.op, spend.signature)).toThrow(/not yet in force/);
    successor.commit(); // at 5: in force from here
    // The successor then goes dark past the duration. The RETIRED operator still
    // answers the repeat of what it co-signed in force: a read of its own book.
    advanceWitnessedIndex(venue, 30n);
    expect(gapOpen(venue, eur)).toBeDefined();
    expect(incumbent.submitIssue({ backing: eur, recipient: KEYS.alice, quantity: 100n, nonce: 0n }, new Uint8Array(64))).toEqual(receipt);
    expect(() => incumbent.submitTransfer(spend.op, spend.signature)).toThrow(/not yet in force/);
  });

  it("a successor's own silence on one backing does not disturb a log it took over: what was taken on is committed, and a restore leaves it whole", () => {
    // takeOver marks the taken log committed. Without the mark a restore — run
    // for the successor's own silence on another backing — would cut the taken
    // log to nothing, as if nothing had ever been committed for it.
    const venue = new LocalVenue();
    const eur = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: { setting: "transparent", operator: KEYS.operator, silence: { noCommitmentDuration: 1000n, challengeWindow: 5n }, replacementRule: KEYS.backer },
    });
    const usd = makeBacking({
      obligor: KEYS.backer2,
      payout: { thing: "USD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: { setting: "transparent", operator: SUCCESSOR, silence: SILENCE },
    });
    const incumbent = new Sequencer(SECRETS.operator, venue);
    incumbent.register(eur, signBacking(SECRETS.backer, eur));
    issue(incumbent, eur, KEYS.alice, 100n, 0n);
    const before = served(incumbent); // at 0
    const successor = new Sequencer(SUCCESSOR_SECRET, venue);
    successor.register(usd, signBacking(SECRETS.backer2, usd));
    issue(successor, usd, KEYS.carol, 100n, 0n, SECRETS.backer2);
    successor.commit(); // at 0
    advanceWitnessedIndex(venue, 2n);
    venue.publishReplacement(eur.name, replacementBy(eur, SECRETS.backer, SUCCESSOR, eur.name, 2n));
    successor.register(eur, signBacking(SECRETS.backer, eur));
    successor.takeOver(eur, before);
    // The successor goes quiet past USD's duration without ever committing EUR.
    advanceWitnessedIndex(venue, 20n);
    successor.commit(); // its return: USD restored; EUR, taken on committed, untouched
    expect(kinds(successor, eur)).toEqual(["issue"]);
    expect(successor.balance(eur, KEYS.alice)).toBe(100n);
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
    expect(() => sequencer.submitTransfer(spend.op, spend.signature)).toThrow(RETURNING);
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
    // accused of lying about its log for having gone silent; isDoublePosition
    // reads the dead and the fresh receipt the same way. A receipt must say
    // which record it was signed against before a reader can tell a dead tail
    // from a lie; until then this pins the question rather than the answer.
    expect(receiptStatus(backing, venue, dead, after)).toBe("contradicted");
  });

  it("adopting inside one gap is idempotent: one book, one set of positions, and the receipt of a gap leg is the same on every ask — inside the gap and after the return", () => {
    const { venue, sequencer, backing } = setup();
    issue(sequencer, backing, KEYS.alice, 100n, 0n);
    sequencer.commit();
    advanceWitnessedIndex(venue, 1n);
    const spend = transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    sequencer.submitTransfer(spend.op, spend.signature); // the tail
    const claim = redeemAtVenue(venue, backing, 11n, 0n, 1n, 90n);
    sequencer.adopt(backing);
    const once = sequencer.opLog(backing);
    // A repeat inside the gap is answered, from the restored book.
    const ask = () => sequencer.submitRelease({ backing, demandHash: claim.hash, nonce: 1n }, new Uint8Array(64));
    const first = ask();
    expect(first.position).toBe(3n);
    sequencer.adopt(backing);
    expect(sequencer.opLog(backing)).toEqual(once);
    expect(ask()).toEqual(first);
    expect(kinds(sequencer, backing)).toEqual(["issue", "demand", "acceptance", "release"]);
    advanceWitnessedIndex(venue, 15n);
    sequencer.commit();
    advanceWitnessedIndex(venue, 16n);
    expect(ask()).toEqual(first);
    expect(verifyReceipt(first)).toBe(true);
  });

  it("the first ask after the return for the receipt of a leg the venue took is answered, and the restore drops only the tail, never the committed prefix", () => {
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

  it("a book no commitment ever carried is all tail: an operator that first commits past the duration, or registers a backing after its last commitment and then goes quiet, loses that book — quiet counts from genesis", () => {
    // The convention quietFor already had, and its consequence: commit after
    // registering, inside the declared duration, or what was served meanwhile
    // was never witnessed. Recorded as the convention's consequence (DECISIONS).
    const late = setup();
    issue(late.sequencer, late.backing, KEYS.alice, 100n, 0n);
    advanceWitnessedIndex(late.venue, 10n);
    issue(late.sequencer, late.backing, KEYS.bob, 50n, 1n); // still inside: 10 - 0 = 10
    advanceWitnessedIndex(late.venue, 11n);
    late.sequencer.commit(); // the first commitment, one past the duration: all tail
    expect(kinds(late.sequencer, late.backing)).toEqual([]);
    expect(late.sequencer.outstanding(late.backing)).toBe(0n);
    // And a punctual operator that registers a second backing after its last
    // commitment and then misses the next: the new backing's whole book is tail.
    const { venue, sequencer, backing: eur } = setup();
    issue(sequencer, eur, KEYS.alice, 100n, 0n);
    sequencer.commit(); // at 0
    advanceWitnessedIndex(venue, 1n);
    const gold = makeTransparentBacking(SECRETS.backer2, "GOLD", [], SILENCE);
    sequencer.register(gold, signBacking(SECRETS.backer2, gold));
    issue(sequencer, gold, KEYS.bob, 30n, 0n, SECRETS.backer2);
    advanceWitnessedIndex(venue, 11n);
    sequencer.commit(); // the return
    expect(kinds(sequencer, gold)).toEqual([]);
    expect(kinds(sequencer, eur)).toEqual(["issue"]);
  });
});

describe("the ledger's committed mark: the one place a log shrinks, and it shrinks only to the mark", () => {
  it("restore cuts the log back to the mark and refolds the state; the mark is set by markCommitted and never moves back", () => {
    const ledger = new TransparentLedger();
    const backing = makeTransparentBacking(SECRETS.backer, "EUR");
    ledger.register(backing, signBacking(SECRETS.backer, backing));
    const apply = (op: PublishedOp) => ledger.apply(backing, op, undefined);
    const issued = (to: Uint8Array, quantity: bigint, nonce: bigint): PublishedOp => ({
      kind: "issue", recipient: to, quantity, nonce,
      signature: ed25519.sign(encodeIssuanceMessage(backing.name, to, quantity, nonce), SECRETS.backer),
    });
    apply(issued(KEYS.alice, 100n, 0n));
    // No mark yet: a restore empties the book.
    expect(ledger.committedLength(backing)).toBe(0);
    expect(ledger.restore(backing)).toBe(0);
    expect(ledger.opLog(backing)).toHaveLength(0);
    expect(ledger.balance(backing, KEYS.alice)).toBe(0n);
    expect(ledger.nextNonce(KEYS.backer, backing)).toBe(0n);
    // Marked, a restore is a no-op; past the mark, it cuts back to it exactly.
    apply(issued(KEYS.alice, 100n, 0n));
    apply(issued(KEYS.bob, 50n, 1n));
    ledger.markCommitted(backing);
    expect(ledger.committedLength(backing)).toBe(2);
    expect(ledger.restore(backing)).toBe(2);
    expect(ledger.opLog(backing)).toHaveLength(2);
    apply(transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.carol, 40n, 0n).published);
    apply(issued(KEYS.carol, 5n, 2n));
    expect(ledger.balance(backing, KEYS.carol)).toBe(45n);
    expect(ledger.restore(backing)).toBe(2);
    expect(ledger.opLog(backing).map((e) => e.kind)).toEqual(["issue", "issue"]);
    expect(ledger.balance(backing, KEYS.carol)).toBe(0n);
    expect(ledger.balance(backing, KEYS.alice)).toBe(100n);
    expect(ledger.nextNonce(KEYS.alice, backing)).toBe(0n);
    expect(ledger.nextNonce(KEYS.backer, backing)).toBe(2n);
    // The mark only advances: marking again at the same length changes nothing,
    // and there is no call that lowers it — or shrinks a log by any other name.
    ledger.markCommitted(backing);
    expect(ledger.committedLength(backing)).toBe(2);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(ledger));
    expect(methods.filter((k) => /trunc|rewind|reset|unmark|rollback/i.test(k))).toEqual([]);
  });
});
