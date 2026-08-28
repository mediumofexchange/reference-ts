import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { decodeBacking, encodeBacking, makeBacking, signBacking, type Backing } from "../src/backing.js";
import { encodeIssuanceMessage } from "../src/messages.js";
import {
  demandHash,
  encodeAcceptance,
  encodeDemand,
  encodeLock,
  encodeRelease,
  signCommit,
  encodeWithdrawal,
  type AcceptanceOp,
  type DemandOp,
  type LockOp,
  NO_DECISION_VENUE,
} from "../src/presentation.js";
import { dishonourOf, payoutOf } from "../src/presentability.js";
import { Sequencer, SequencerError } from "../src/sequencer.js";
import { LocalVenue } from "../src/venue.js";
import { compareBytes } from "../src/bytes.js";
import { snapshotRedemptions } from "../src/recovery.js";
import { isDishonoured, replayLog } from "../src/ledger.js";
import { signCommitment, stateRoot, type ServedState } from "../src/commitment.js";
import { type OpLogEntry } from "../src/oplog.js";
import { receiptCovers, type Receipt } from "../src/receipt.js";
import { advanceWitnessedIndex, KEYS, SECRETS } from "./support.js";

// §C3: "A payout paying in claims settles as a swap inside the settlement. The
// acceptance names the claims, or the fresh issuance, that will pay, and the
// release executes as one atomic exchange, surrendered set against paying
// claims, co-signed by every sequencer either side needs. That is §C1's swap
// run at settlement, so the backer cannot take the set and not pay. Neither
// party can write the other's outcome."
//
// P gains a form: one unit of this backing pays `perUnit` units of a named
// backing. The backer's ACCEPTANCE reserves them — a lock, the backer's own
// units, to the demand holder, under the demand's hash, convertible by the
// holder alone — and the holder's RELEASE settles surrendered set and payout
// as one act. The backer consented at the acceptance; the holder's release is
// the only signature that moves anything; the sequencer applies all or none.

const DEADLINE = 100n;

/** GOLD, plain; EUR pays 2 GOLD per unit. One operator serves both. With `gap`, both
 * declare a silence clause and a witnessing venue, so the operator can go dark. */
function setup(gap = false) {
  const venue = new LocalVenue();
  const evidence = gap
    ? {
        setting: "transparent" as const,
        operator: KEYS.operator,
        silence: { noCommitmentDuration: 10n, challengeWindow: 5n },
        witnessing: { venue: venue.id, interval: 5n },
      }
    : { setting: "transparent" as const, operator: KEYS.operator };
  const gold = makeBacking({
    obligor: KEYS.backer,
    payout: { thing: "GOLD", quantumExponent: -2, perUnit: 100n },
    reliance: [],
    evidence,
  });
  const eur = makeBacking({
    obligor: KEYS.backer,
    payout: { backing: gold.name, perUnit: 2n },
    reliance: [],
    evidence,
  });
  const sequencer = new Sequencer(SECRETS.operator, venue);
  for (const backing of [gold, eur]) sequencer.register(backing, signBacking(SECRETS.backer, backing));
  const issue = (backing: Backing, to: Uint8Array, quantity: bigint) => {
    const nonce = sequencer.nextNonce(KEYS.backer, backing);
    sequencer.submitIssue(
      { backing, recipient: to, quantity, nonce },
      ed25519.sign(encodeIssuanceMessage(backing.name, to, quantity, nonce), SECRETS.backer),
    );
  };
  issue(eur, KEYS.alice, 100n);
  issue(gold, KEYS.backer, 500n);
  return { venue, sequencer, eur, gold };
}

function file(f: ReturnType<typeof setup>, quantity: bigint) {
  const demand: DemandOp = {
    backing: f.eur,
    holder: KEYS.alice,
    quantity,
    instant: 0n,
    deadline: DEADLINE,
    nonce: f.sequencer.nextNonce(KEYS.alice, f.eur),
  };
  f.sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice));
  return { demand, hash: demandHash(demand) };
}

/** The backer's answer, with the paying lock §C3 asks for, or a variant of it. */
function accept(
  f: ReturnType<typeof setup>,
  hash: Uint8Array,
  quantity: bigint,
  variant: Partial<LockOp> = {},
  paying = true,
) {
  const op: AcceptanceOp = {
    backing: f.eur,
    demandHash: hash,
    instant: 0n,
    deadline: 90n,
    nonce: f.sequencer.nextNonce(KEYS.backer, f.eur),
  };
  const lock: LockOp = {
    backing: f.gold,
    attemptId: hash,
    holder: KEYS.backer,
    beneficiary: KEYS.alice,
    quantity: quantity * 2n,
    timeout: 95n,
    decisionVenue: NO_DECISION_VENUE,
    parties: [KEYS.alice],
    nonce: f.sequencer.nextNonce(KEYS.backer, f.gold),
    ...variant,
  };
  return f.sequencer.submitAcceptance(
    op,
    ed25519.sign(encodeAcceptance(op), SECRETS.backer),
    paying ? [{ op: lock, signature: ed25519.sign(encodeLock(lock), SECRETS.backer) }] : [],
  );
}

/** The holder's release of the set: the demand and the payout, one act, one signer. */
function release(f: ReturnType<typeof setup>, hash: Uint8Array, withPayout = true) {
  const head = { backing: f.eur, demandHash: hash, holder: KEYS.alice, nonce: f.sequencer.nextNonce(KEYS.alice, f.eur) };
  // The payout leg names the BACKER's record — the paying lock is the obligor's
  // own units — while Alice signs: the one record whose holder is not its converter.
  const pay = { backing: f.gold, demandHash: hash, holder: KEYS.backer, nonce: f.sequencer.nextNonce(KEYS.alice, f.gold) };
  return f.sequencer.submitRelease(
    head,
    ed25519.sign(encodeRelease(head), SECRETS.alice),
    withPayout ? [{ op: pay, signature: ed25519.sign(encodeRelease(pay), SECRETS.alice) }] : [],
  );
}

describe("§C3: a payout paying in claims", () => {
  it("is a form of P, inside the name, and round-trips", () => {
    const { eur, gold } = setup();
    expect(decodeBacking(encodeBacking(eur)).payout).toEqual({ backing: gold.name, perUnit: 2n });
    const constant = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: { setting: "transparent", operator: KEYS.operator },
    });
    expect(eur.name).not.toEqual(constant.name);
  });

  it("the acceptance reserves the payout and the holder's release settles both sides", () => {
    const f = setup();
    const { hash } = file(f, 40n);
    accept(f, hash, 40n);
    expect(f.sequencer.availableBalance(f.gold, KEYS.backer)).toBe(500n - 80n);
    release(f, hash);
    expect(f.sequencer.balance(f.eur, KEYS.backer)).toBe(40n);
    expect(f.sequencer.balance(f.gold, KEYS.alice)).toBe(80n);
    expect(f.sequencer.balance(f.gold, KEYS.backer)).toBe(420n);
    expect(f.sequencer.openDemands(f.eur)).toHaveLength(0);
  });
});

describe("§C3: the backer cannot take the set and not pay, and the holder cannot take the payout and not surrender", () => {
  it("an acceptance of a claims-paying backing must reserve the payout", () => {
    const f = setup();
    const { hash } = file(f, 40n);
    expect(() => accept(f, hash, 40n, {}, false)).toThrow(/reserves its payout/);
    expect(f.sequencer.openDemands(f.eur)[0]?.acceptedDeadline).toBeUndefined();
  });

  it("the paying lock must carry the set's terms, the holder's key alone, and outlast the answer", () => {
    const f = setup();
    const { hash } = file(f, 40n);
    expect(() => accept(f, hash, 40n, { quantity: 79n })).toThrow(/does not cover/);
    expect(() => accept(f, hash, 40n, { beneficiary: KEYS.bob })).toThrow(/party the set names|convert/);
    expect(() => accept(f, hash, 40n, { parties: [KEYS.alice, KEYS.bob].sort(compareBytes) })).toThrow(/convert/);
    expect(() => accept(f, hash, 40n, { timeout: 89n })).toThrow(/outlast/);
    // Nothing of the above stuck: the demand stands unanswered, the GOLD is the backer's.
    expect(f.sequencer.availableBalance(f.gold, KEYS.backer)).toBe(500n);
    expect(f.sequencer.openDemands(f.eur)[0]?.acceptedDeadline).toBeUndefined();
  });

  it("the release must carry the payout leg, signed by the holder like every other", () => {
    const f = setup();
    const { hash } = file(f, 40n);
    accept(f, hash, 40n);
    expect(() => release(f, hash, false)).toThrow(/every reliance leg/);
    expect(f.sequencer.balance(f.eur, KEYS.backer)).toBe(0n);
    release(f, hash);
    expect(f.sequencer.balance(f.gold, KEYS.alice)).toBe(80n);
  });

  it("the paying lock released alone takes nothing: it is a leg, and a leg is not the head", () => {
    const f = setup();
    const { hash } = file(f, 40n);
    accept(f, hash, 40n);
    const pay = { backing: f.gold, demandHash: hash, holder: KEYS.backer, nonce: f.sequencer.nextNonce(KEYS.alice, f.gold) };
    expect(() =>
      f.sequencer.submitRelease(pay, ed25519.sign(encodeRelease(pay), SECRETS.alice)),
    ).toThrow(/leg of this demand/);
    expect(f.sequencer.balance(f.gold, KEYS.alice)).toBe(0n);
  });

  it("a backer whose acceptance expires unpaid frees its own payout, and only past its lock's timeout", () => {
    const f = setup();
    const { hash } = file(f, 40n);
    accept(f, hash, 40n);
    f.venue.advance(95n);
    const early = { backing: f.gold, demandHash: hash, holder: KEYS.backer, nonce: f.sequencer.nextNonce(KEYS.backer, f.gold) };
    expect(() => f.sequencer.submitWithdrawal(early, ed25519.sign(encodeWithdrawal(early), SECRETS.backer))).toThrow(/expired/);
    f.venue.advance(1n);
    const back = { backing: f.gold, demandHash: hash, holder: KEYS.backer, nonce: f.sequencer.nextNonce(KEYS.backer, f.gold) };
    f.sequencer.submitWithdrawal(back, ed25519.sign(encodeWithdrawal(back), SECRETS.backer));
    expect(f.sequencer.availableBalance(f.gold, KEYS.backer)).toBe(500n);
    // The demand still stands for the holder to withdraw: the answer lapsed, the claims did not move.
    expect(f.sequencer.openDemands(f.eur)).toHaveLength(1);
  });
});

describe("§C3: reading the payout, and the gap", () => {
  it("payoutOf tells the holder whether the payout is reserved before it releases", () => {
    const f = setup();
    const { hash } = file(f, 40n);
    const terms = (name: Uint8Array) => (compareBytes(name, f.gold.name) === 0 ? f.gold : undefined);
    const served = () => ({ snapshots: f.sequencer.snapshot(), commitment: f.sequencer.commit() });
    expect(payoutOf(f.eur, f.venue, terms, served(), hash)).toBe("unreserved");
    accept(f, hash, 40n);
    advanceWitnessedIndex(f.venue, 1n); // one commitment per witnessed index (28b: eras end legibly)
    expect(payoutOf(f.eur, f.venue, terms, served(), hash)).toBe("reserved");
    // And only while the acceptance is live: the lock outlasts the answer by the
    // door's rule, so it is the acceptance the holder's read must ask (found
    // regression-reviewing slice 27: "reserved" at 91 while the release was refused).
    advanceWitnessedIndex(f.venue, 90n);
    expect(payoutOf(f.eur, f.venue, terms, served(), hash)).toBe("reserved");
    advanceWitnessedIndex(f.venue, 91n);
    expect(payoutOf(f.eur, f.venue, terms, served(), hash)).toBe("unreserved");
    advanceWitnessedIndex(f.venue, 92n); // one commitment per witnessed index (28b: eras end legibly)
    expect(payoutOf(f.gold, f.venue, terms, served(), hash)).toBe("outside");
    advanceWitnessedIndex(f.venue, 93n); // one commitment per witnessed index (28b: eras end legibly)
    expect(payoutOf(f.eur, f.venue, () => undefined, served(), hash)).toBe("unreadable");
  });

  it("in a gap a presentation with a payout leg neither opens nor settles: it waits for the operator", () => {
    // adopt takes operations one at a time, never a set; a paying lock released
    // alone there would hand the holder the payout for nothing. 24a's posture,
    // one step further: claims go illiquid rather than dead.
    const venue = new LocalVenue();
    const mk = (payout: { thing: string; quantumExponent: number; perUnit: bigint } | { backing: Uint8Array; perUnit: bigint }) =>
      makeBacking({
        obligor: KEYS.backer,
        payout,
        reliance: [],
        evidence: {
          setting: "transparent",
          operator: KEYS.operator,
          silence: { noCommitmentDuration: 10n, challengeWindow: 5n },
          witnessing: { venue: venue.id, interval: 5n },
        },
      });
    const gold = mk({ thing: "GOLD", quantumExponent: -2, perUnit: 100n });
    const eur = mk({ backing: gold.name, perUnit: 2n });
    const sequencer = new Sequencer(SECRETS.operator, venue);
    for (const b of [gold, eur]) sequencer.register(b, signBacking(SECRETS.backer, b));
    const n0 = sequencer.nextNonce(KEYS.backer, eur);
    sequencer.submitIssue(
      { backing: eur, recipient: KEYS.alice, quantity: 100n, nonce: n0 },
      ed25519.sign(encodeIssuanceMessage(eur.name, KEYS.alice, 100n, n0), SECRETS.backer),
    );
    sequencer.commit();
    venue.advance(30n);
    const demand: DemandOp = { backing: eur, holder: KEYS.alice, quantity: 40n, instant: 30n, deadline: 200n, nonce: 0n };
    venue.publishOp(eur.name, {
      kind: "demand",
      holder: demand.holder,
      quantity: demand.quantity,
      instant: demand.instant,
      deadline: demand.deadline,
      nonce: demand.nonce,
      signature: ed25519.sign(encodeDemand(demand), SECRETS.alice),
    });
    venue.advance(1n);
    sequencer.commit();
    expect(sequencer.openDemands(eur)).toHaveLength(0);
  });
});

describe("§C3: what this implementation cannot represent, said plainly", () => {
  it("a backing that pays in the claims it relies on is refused at filing: one lock slot under the hash", () => {
    const venue = new LocalVenue();
    const gold = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "GOLD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: { setting: "transparent", operator: KEYS.operator },
    });
    const odd = makeBacking({
      obligor: KEYS.backer,
      payout: { backing: gold.name, perUnit: 1n },
      reliance: [{ target: gold.name, count: 1n }],
      evidence: { setting: "transparent", operator: KEYS.operator },
    });
    const sequencer = new Sequencer(SECRETS.operator, venue);
    for (const b of [gold, odd]) sequencer.register(b, signBacking(SECRETS.backer, b));
    const issue = (b: Backing, to: Uint8Array, q: bigint) => {
      const nonce = sequencer.nextNonce(KEYS.backer, b);
      sequencer.submitIssue({ backing: b, recipient: to, quantity: q, nonce }, ed25519.sign(encodeIssuanceMessage(b.name, to, q, nonce), SECRETS.backer));
    };
    issue(odd, KEYS.alice, 10n);
    issue(gold, KEYS.alice, 10n);
    issue(gold, KEYS.backer, 10n);
    const demand: DemandOp = { backing: odd, holder: KEYS.alice, quantity: 1n, instant: 0n, deadline: DEADLINE, nonce: 0n };
    const hash = demandHash(demand);
    const leg: LockOp = { backing: gold, attemptId: hash, holder: KEYS.alice, beneficiary: KEYS.backer, quantity: 1n, timeout: 95n, decisionVenue: NO_DECISION_VENUE, parties: [KEYS.alice], nonce: 0n };
    // Refused at FILING now (the audit slice's review): filed, it could never be
    // answered — every acceptance met "one lock slot, two locks" — and read as
    // dishonoured against a backer with no path. The (attempt, holder) key
    // recorded open in 24c would lift the restriction rather than refuse it.
    expect(() =>
      sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice), [{ op: leg, signature: ed25519.sign(encodeLock(leg), SECRETS.alice) }]),
    ).toThrow(/one lock slot/);
    expect(sequencer.openDemands(odd)).toHaveLength(0);
  });
});

describe("§C3: the other doors to the payout, closed", () => {
  it("the holder cannot convert the paying lock alone by publishing a commit: a leg names no venue", () => {
    // Found reviewing the slice: the paying lock is a one-party lock with the
    // holder as its party, which is exactly what a witnessed commit converts — so
    // the holder could take the payout and keep the claims. A set leg names no
    // decision venue, and no commit reaches it.
    const f = setup();
    const { hash } = file(f, 40n);
    accept(f, hash, 40n);
    f.venue.advance(2n);
    f.venue.publishCommit(signCommit(SECRETS.alice, hash));
    expect(() => f.sequencer.settle(f.gold, hash)).toThrow(/settles with its set/);
    expect(f.sequencer.balance(f.gold, KEYS.alice)).toBe(0n);
    // And the LAW refuses it, not only the sequencer's settle: a served log
    // carrying that commit against the paying lock does not replay, so a
    // verifier never calls the payout-taken-nothing-surrendered history one
    // that could have happened (found by the 2026-08-22 audit, twice).
    const commit = signCommit(SECRETS.alice, hash);
    const bare = { kind: "commit" as const, attemptId: commit.attemptId, signatures: commit.signatures };
    expect(replayLog(f.gold, [...f.sequencer.opLog(f.gold), { ...bare, position: f.sequencer.opLog(f.gold).length }])).toBeUndefined();
    // And the backer's own exit is untouched by that object: past the timeout it withdraws.
    f.venue.advance(94n);
    const back = { backing: f.gold, demandHash: hash, holder: KEYS.backer, nonce: f.sequencer.nextNonce(KEYS.backer, f.gold) };
    f.sequencer.submitWithdrawal(back, ed25519.sign(encodeWithdrawal(back), SECRETS.backer));
    expect(f.sequencer.availableBalance(f.gold, KEYS.backer)).toBe(500n);
  });

  it("nobody squats the paying slot: a stranger's lock under the demand's hash reserves only their own units", () => {
    // The slot the acceptance takes is (demand hash, OBLIGOR) — a lock is keyed
    // by (attempt, holder) — so the gate that refused any venue-naming lock
    // under a standing demand's hash is deleted with the squat it guarded
    // against: a stranger who predicts the hash reserves nothing the answer
    // needs. The one party who can occupy the paying slot is the backer itself,
    // and the law's own key-collision refusal reads that back to it — its lock,
    // its withdrawal, its problem (the residual family, invariant-13.lock-keying).
    const f = setup();
    const { hash } = file(f, 40n);
    const n = f.sequencer.nextNonce(KEYS.backer, f.gold);
    f.sequencer.submitIssue(
      { backing: f.gold, recipient: KEYS.mallory, quantity: 1n, nonce: n },
      ed25519.sign(encodeIssuanceMessage(f.gold.name, KEYS.mallory, 1n, n), SECRETS.backer),
    );
    const squat: LockOp = {
      backing: f.gold,
      attemptId: hash,
      holder: KEYS.mallory,
      beneficiary: KEYS.mallory,
      quantity: 1n,
      timeout: 10_000n,
      decisionVenue: f.venue.id,
      parties: [KEYS.mallory],
      nonce: f.sequencer.nextNonce(KEYS.mallory, f.gold),
    };
    f.sequencer.submitLock(squat, ed25519.sign(encodeLock(squat), SECRETS.mallory));
    accept(f, hash, 40n);
    expect(f.sequencer.availableBalance(f.gold, KEYS.backer)).toBe(420n);
    expect(f.sequencer.availableBalance(f.gold, KEYS.mallory)).toBe(0n);
  });

  it("in a gap the head's release and the paying lock's release are both refused, and the verifier agrees", () => {
    const f = setup(true);
    const { hash } = file(f, 40n);
    accept(f, hash, 40n);
    const commitment = f.sequencer.commit();
    const served = { snapshots: f.sequencer.snapshot(), commitment };
    f.venue.advance(30n);
    const head = { backing: f.eur, demandHash: hash, holder: KEYS.alice, nonce: f.sequencer.nextNonce(KEYS.alice, f.eur) };
    f.venue.publishOp(f.eur.name, { kind: "release", demandHash: hash, holder: KEYS.alice, nonce: head.nonce, signature: ed25519.sign(encodeRelease(head), SECRETS.alice) });
    const pay = { backing: f.gold, demandHash: hash, holder: KEYS.backer, nonce: f.sequencer.nextNonce(KEYS.alice, f.gold) };
    f.venue.publishOp(f.gold.name, { kind: "release", demandHash: hash, holder: KEYS.backer, nonce: pay.nonce, signature: ed25519.sign(encodeRelease(pay), SECRETS.alice) });
    f.venue.advance(1n);
    f.sequencer.commit();
    expect(f.sequencer.openDemands(f.eur)).toHaveLength(1);
    expect(f.sequencer.balance(f.gold, KEYS.alice)).toBe(0n);
    expect(snapshotRedemptions(f.venue, f.eur, served)).toEqual([]);
  });
});

describe("§C3: set legs come only with their set", () => {
  it("a bare lock naming no decision venue is refused, so nobody squats the paying slot that way either", () => {
    const f = setup();
    const { hash } = file(f, 40n);
    const bare: LockOp = {
      backing: f.gold,
      attemptId: hash,
      holder: KEYS.backer,
      beneficiary: KEYS.backer,
      quantity: 1n,
      timeout: 10_000n,
      decisionVenue: NO_DECISION_VENUE,
      parties: [KEYS.backer],
      nonce: f.sequencer.nextNonce(KEYS.backer, f.gold),
    };
    expect(() => f.sequencer.submitLock(bare, ed25519.sign(encodeLock(bare), SECRETS.backer))).toThrow(
      /set legs come with their set/,
    );
    accept(f, hash, 40n);
    expect(f.sequencer.availableBalance(f.gold, KEYS.backer)).toBe(420n);
  });
});

describe("§C3: the paying slot cannot be taken before the demand either", () => {
  it("a holder's own lock under her predicted hash on the paying backing leaves the backer's answer open", () => {
    // The attack this door guarded: a holder who predicted her own next hash
    // locked the paying slot first, filed, and left the backer no way to answer
    // — a dishonour she manufactured. Keyed by (attempt, holder) the slot the
    // acceptance takes is the OBLIGOR's own, so her lock reserves her own unit
    // and the answer goes through; the filing door that refused her with
    // "re-file with a fresh nonce" is deleted with the attack.
    const f = setup();
    const demand: DemandOp = {
      backing: f.eur,
      holder: KEYS.alice,
      quantity: 40n,
      instant: 0n,
      deadline: DEADLINE,
      nonce: f.sequencer.nextNonce(KEYS.alice, f.eur),
    };
    const hash = demandHash(demand);
    const n = f.sequencer.nextNonce(KEYS.backer, f.gold);
    f.sequencer.submitIssue(
      { backing: f.gold, recipient: KEYS.alice, quantity: 1n, nonce: n },
      ed25519.sign(encodeIssuanceMessage(f.gold.name, KEYS.alice, 1n, n), SECRETS.backer),
    );
    const first: LockOp = {
      backing: f.gold,
      attemptId: hash,
      holder: KEYS.alice,
      beneficiary: KEYS.alice,
      quantity: 1n,
      timeout: 10_000n,
      decisionVenue: f.venue.id,
      parties: [KEYS.alice],
      nonce: f.sequencer.nextNonce(KEYS.alice, f.gold),
    };
    f.sequencer.submitLock(first, ed25519.sign(encodeLock(first), SECRETS.alice));
    f.sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice));
    accept(f, hash, 40n);
    expect(f.sequencer.openDemands(f.eur)[0]?.acceptedDeadline).toBe(90n);
    expect(f.sequencer.availableBalance(f.gold, KEYS.backer)).toBe(420n);
  });
});

describe("§C3: what the 2026-08-22 audit found around the paying lock", () => {
  it("a claims-paying demand whose paying backing this operator does not serve is refused at filing", () => {
    // §C3: single-phase is "the whole set and the paying leg inside one
    // operator". Filed without the paying leg reachable, the demand could never
    // be answered — every acceptance door was shut — and read as dishonoured
    // against a backer with no path (audit A3/C4). Refused where the question is
    // already asked, at filing: an abort rather than a demand nobody can answer.
    const venue = new LocalVenue();
    const other = KEYS.backer2; // another operator's key, never this sequencer's
    const gold = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "GOLD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: { setting: "transparent", operator: other },
    });
    const eur = makeBacking({
      obligor: KEYS.backer,
      payout: { backing: gold.name, perUnit: 2n },
      reliance: [],
      evidence: { setting: "transparent", operator: KEYS.operator },
    });
    const sequencer = new Sequencer(SECRETS.operator, venue);
    sequencer.register(eur, signBacking(SECRETS.backer, eur));
    const nonce = sequencer.nextNonce(KEYS.backer, eur);
    sequencer.submitIssue(
      { backing: eur, recipient: KEYS.alice, quantity: 100n, nonce },
      ed25519.sign(encodeIssuanceMessage(eur.name, KEYS.alice, 100n, nonce), SECRETS.backer),
    );
    const demand: DemandOp = { backing: eur, holder: KEYS.alice, quantity: 40n, instant: 0n, deadline: DEADLINE, nonce: 0n };
    expect(() => sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice))).toThrow(
      /paying backing/,
    );
    expect(sequencer.openDemands(eur)).toHaveLength(0);
    // The honest path the refusal names — an operator that serves both — is the
    // ordinary fixture: one operator, both backings, the demand files.
    const g = setup();
    file(g, 40n);
    expect(g.sequencer.openDemands(g.eur)).toHaveLength(1);
  });

  it("a repeated release of the set is answered with the prior receipt, and so is a repeated withdrawal", () => {
    // Invariant 26: "The rule covers locks and releases, so partition recovery
    // simply repeats the request." The set's shape was derived from live state
    // before the receipt lookup, so a repeat found the demand gone and was
    // refused — and the release receipt, the only evidence of the settlement
    // outside the operator's log, was unobtainable (audit C1).
    const f = setup();
    const { hash } = file(f, 40n);
    accept(f, hash, 40n);
    const head = { backing: f.eur, demandHash: hash, holder: KEYS.alice, nonce: f.sequencer.nextNonce(KEYS.alice, f.eur) };
    const pay = { backing: f.gold, demandHash: hash, holder: KEYS.backer, nonce: f.sequencer.nextNonce(KEYS.alice, f.gold) };
    const legs = [{ op: pay, signature: ed25519.sign(encodeRelease(pay), SECRETS.alice) }];
    const signature = ed25519.sign(encodeRelease(head), SECRETS.alice);
    const first = f.sequencer.submitRelease(head, signature, legs);
    const again = f.sequencer.submitRelease(head, signature, legs);
    expect(again).toEqual(first);
    expect(f.sequencer.balance(f.gold, KEYS.alice)).toBe(80n);
    expect(f.sequencer.balance(f.eur, KEYS.backer)).toBe(40n);

    const g = setup();
    const w = file(g, 40n);
    const out = { backing: g.eur, demandHash: w.hash, holder: KEYS.alice, nonce: g.sequencer.nextNonce(KEYS.alice, g.eur) };
    const outSig = ed25519.sign(encodeWithdrawal(out), SECRETS.alice);
    const once = g.sequencer.submitWithdrawal(out, outSig, []);
    expect(g.sequencer.submitWithdrawal(out, outSig, [])).toEqual(once);
    expect(g.sequencer.openDemands(g.eur)).toHaveLength(0);
  });
});

describe("§C3: every co-signed operation's receipt can be obtained by repeating it at its door", () => {
  it("the paying lock's receipt, co-signed beside the acceptance and returned to nobody, comes back through submitLock", () => {
    // `submit` returns the first item's receipt; the paying lock was co-signed
    // beside the acceptance. A repeat is answered before any door refuses it
    // (invariant 26; slice 27's review), so the bare door that refuses a fresh
    // set leg hands back the receipt of one it already co-signed — no second,
    // unauthenticated lookup needed (the audit slice's review: a public
    // `receiptOf` would have been an oracle over the uncommitted tail).
    const f = setup();
    const { hash } = file(f, 40n);
    accept(f, hash, 40n);
    const lock: LockOp = {
      backing: f.gold,
      attemptId: hash,
      holder: KEYS.backer,
      beneficiary: KEYS.alice,
      quantity: 80n,
      timeout: 95n,
      decisionVenue: NO_DECISION_VENUE,
      parties: [KEYS.alice],
      nonce: 1n, // the backer's GOLD nonce after its issuance
    };
    const signature = ed25519.sign(encodeLock(lock), SECRETS.backer);
    const receipt = f.sequencer.submitLock(lock, signature);
    expect(receiptCovers(f.gold.name, { kind: "lock", ...lock, signature } as never, receipt)).toBe(true);
    expect(receipt.operator).toEqual(KEYS.operator);
    // The same bytes again: the same receipt. Fresh bytes: the bare door.
    expect(f.sequencer.submitLock(lock, signature)).toEqual(receipt);
    const fresh = { ...lock, nonce: 9n };
    expect(() => f.sequencer.submitLock(fresh, ed25519.sign(encodeLock(fresh), SECRETS.backer))).toThrow(/bare lock/);
  });
});

describe("§C3: a repeat is a repeat of this request, and it is answered before a door refusal", () => {
  it("the release repeat is answered after a stranger locks under the settled demand's hash", () => {
    // Found in the audit slice's last regression pass: the "that backing is a
    // leg, not the head" refusal ran before the repeat, so a one-unit squat under
    // a settled hash — free once the set applied, and never retired (no
    // venue-naming lock stood there) — made the payee's release receipt
    // unobtainable forever.
    const f = setup();
    const { hash } = file(f, 40n);
    accept(f, hash, 40n);
    const head = { backing: f.eur, demandHash: hash, holder: KEYS.alice, nonce: f.sequencer.nextNonce(KEYS.alice, f.eur) };
    const pay = { backing: f.gold, demandHash: hash, holder: KEYS.backer, nonce: f.sequencer.nextNonce(KEYS.alice, f.gold) };
    const legs = [{ op: pay, signature: ed25519.sign(encodeRelease(pay), SECRETS.alice) }];
    const signature = ed25519.sign(encodeRelease(head), SECRETS.alice);
    const receipt = f.sequencer.submitRelease(head, signature, legs);
    // Mallory, one unit of EUR, a bundle lock under the settled hash.
    const n = f.sequencer.nextNonce(KEYS.backer, f.eur);
    f.sequencer.submitIssue({ backing: f.eur, recipient: KEYS.mallory, quantity: 1n, nonce: n }, ed25519.sign(encodeIssuanceMessage(f.eur.name, KEYS.mallory, 1n, n), SECRETS.backer));
    const squat: LockOp = { backing: f.eur, attemptId: hash, holder: KEYS.mallory, beneficiary: KEYS.mallory, quantity: 1n, timeout: 9000n, decisionVenue: f.venue.id, parties: [KEYS.mallory], nonce: 0n };
    f.sequencer.submitLock(squat, ed25519.sign(encodeLock(squat), SECRETS.mallory));
    expect(f.sequencer.submitRelease(head, signature, legs)).toEqual(receipt);
  });

  it("an acceptance repeat is answered with its companion of the set's shape, and refused with one of another shape", () => {
    // The act is the acceptance; its paying lock must be the set's (the backing P
    // names, the set's terms, the demand's hash) before the repeat is answered —
    // an answer's bytes with a companion of another shape is not a repeat of it
    // (found in the audit slice's last regression pass).
    const f = setup();
    const { hash } = file(f, 40n);
    const op: AcceptanceOp = { backing: f.eur, demandHash: hash, instant: 0n, deadline: 90n, nonce: f.sequencer.nextNonce(KEYS.backer, f.eur) };
    const signature = ed25519.sign(encodeAcceptance(op), SECRETS.backer);
    const lock: LockOp = { backing: f.gold, attemptId: hash, holder: KEYS.backer, beneficiary: KEYS.alice, quantity: 80n, timeout: 95n, decisionVenue: NO_DECISION_VENUE, parties: [KEYS.alice], nonce: f.sequencer.nextNonce(KEYS.backer, f.gold) };
    const paying = [{ op: lock, signature: ed25519.sign(encodeLock(lock), SECRETS.backer) }];
    const receipt = f.sequencer.submitAcceptance(op, signature, paying);
    expect(f.sequencer.submitAcceptance(op, signature, paying)).toEqual(receipt);
    const wrong = { ...lock, quantity: 79n, nonce: lock.nonce + 1n };
    expect(() => f.sequencer.submitAcceptance(op, signature, [{ op: wrong, signature: ed25519.sign(encodeLock(wrong), SECRETS.backer) }])).toThrow(/quantity/);
    expect(() => f.sequencer.submitAcceptance(op, signature, [])).toThrow(/exactly one paying lock/);
    expect(f.sequencer.availableBalance(f.gold, KEYS.backer)).toBe(420n);
  });
});

describe("§C3: dishonour where P pays in claims — the branch where no acceptance with its payout reserved answered", () => {
  // The audit's question 3, decided by Bob. The law's isDishonoured reads one
  // record and stays blind to legs; where the backer answered WITH the payout
  // reserved through the whole window, an expired acceptance is the holder's
  // lapse, and dishonourOf is the reader that says so across the served state.

  const gold = (f: ReturnType<typeof setup>) => (name: Uint8Array) =>
    compareBytes(name, f.gold.name) === 0 ? f.gold : undefined;
  const servedOf = (f: ReturnType<typeof setup>): ServedState => {
    const commitment = f.sequencer.commit();
    return { snapshots: f.sequencer.snapshot(), commitment };
  };

  /** An answer straight into the served eur log, no door asked. */
  const bareAcceptance = (f: ReturnType<typeof setup>, hash: Uint8Array, deadline: bigint): OpLogEntry => {
    const nonce = f.sequencer.nextNonce(KEYS.backer, f.eur);
    const answer: AcceptanceOp = { backing: f.eur, demandHash: hash, instant: 0n, deadline, nonce };
    return {
      position: f.sequencer.opLog(f.eur).length,
      kind: "acceptance",
      demandHash: hash,
      instant: 0n,
      deadline,
      nonce,
      signature: ed25519.sign(encodeAcceptance(answer), SECRETS.backer),
    };
  };

  /** A lawful lock straight into the served gold log — signed, funded, next nonce. */
  const goldLock = (f: ReturnType<typeof setup>, over: Partial<LockOp>): OpLogEntry => {
    const base: LockOp = {
      backing: f.gold,
      attemptId: new Uint8Array(32),
      holder: KEYS.backer,
      beneficiary: KEYS.alice,
      quantity: 80n,
      timeout: 200n,
      decisionVenue: NO_DECISION_VENUE,
      parties: [KEYS.alice],
      nonce: f.sequencer.nextNonce(KEYS.backer, f.gold),
      ...over,
    };
    return {
      position: f.sequencer.opLog(f.gold).length,
      kind: "lock",
      attemptId: base.attemptId,
      holder: base.holder,
      beneficiary: base.beneficiary,
      quantity: base.quantity,
      timeout: base.timeout,
      decisionVenue: base.decisionVenue,
      parties: base.parties,
      nonce: base.nonce,
      signature: ed25519.sign(encodeLock(base), SECRETS.backer),
    };
  };

  /** The operator's story: both logs with whatever appended, committed and witnessed. */
  const serve = (
    f: ReturnType<typeof setup>,
    eurExtra: OpLogEntry[],
    goldExtra: OpLogEntry[],
    at: bigint,
  ): ServedState => {
    const snapshots = [
      { name: f.eur.name, opLog: [...f.sequencer.opLog(f.eur), ...eurExtra] },
      { name: f.gold.name, opLog: [...f.sequencer.opLog(f.gold), ...goldExtra] },
    ];
    advanceWitnessedIndex(f.venue, at);
    const commitment = signCommitment(SECRETS.operator, 0n, stateRoot(snapshots));
    f.venue.publish(commitment);
    return { snapshots, commitment };
  };

  it("an expired acceptance whose payout stood reserved through its window is the holder's lapse, and the record alone still reads dishonour", () => {
    const f = setup();
    const { hash } = file(f, 40n);
    accept(f, hash, 40n); // deadline 90, the paying lock to 95
    advanceWitnessedIndex(f.venue, 101n); // past the demand's own deadline
    const state = servedOf(f);
    // The law's blind read: true — one record, no legs in view.
    const record = replayLog(f.eur, f.sequencer.opLog(f.eur))!.demands.values().next().value!;
    expect(isDishonoured(record, f.venue.witnessedIndex())).toBe(true);
    // The reader across the served state: the claims were payable all window.
    expect(dishonourOf(f.eur, f.venue, gold(f), state, hash)).toBe("lapsed");
  });

  it("no answer at all is dishonour", () => {
    const f = setup();
    const { hash } = file(f, 40n);
    advanceWitnessedIndex(f.venue, 101n);
    expect(dishonourOf(f.eur, f.venue, gold(f), servedOf(f), hash)).toBe("dishonoured");
  });

  it("pending before the deadline, and while a live acceptance stands", () => {
    const f = setup();
    const { hash } = file(f, 40n);
    expect(dishonourOf(f.eur, f.venue, gold(f), servedOf(f), hash)).toBe("pending");
    accept(f, hash, 40n);
    advanceWitnessedIndex(f.venue, 50n);
    expect(dishonourOf(f.eur, f.venue, gold(f), servedOf(f), hash)).toBe("pending");
  });

  it("unreadable for a demand not standing, and for terms not to hand", () => {
    const f = setup();
    const { hash } = file(f, 40n);
    advanceWitnessedIndex(f.venue, 101n);
    const state = servedOf(f);
    expect(dishonourOf(f.eur, f.venue, gold(f), state, new Uint8Array(32).fill(9))).toBe("unreadable");
    expect(dishonourOf(f.eur, f.venue, () => undefined, state, hash)).toBe("unreadable");
  });

  it("where P pays outside the claim layer the record is the whole answer: an expired acceptance had nothing to reserve", () => {
    // The refinement is only for claims-paying backings. GOLD pays a thing, so
    // an acceptance stands with no leg beside it and its expiry is dishonour
    // plain — the backer-as-holder files to keep the fixture small.
    const f = setup();
    const demand = { backing: f.gold, holder: KEYS.backer, quantity: 10n, instant: 0n, deadline: 20n, nonce: f.sequencer.nextNonce(KEYS.backer, f.gold) };
    f.sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.backer));
    const hash = demandHash(demand);
    expect(dishonourOf(f.gold, f.venue, gold(f), servedOf(f), hash)).toBe("pending");
    const answer: AcceptanceOp = { backing: f.gold, demandHash: hash, instant: 0n, deadline: 15n, nonce: f.sequencer.nextNonce(KEYS.backer, f.gold) };
    f.sequencer.submitAcceptance(answer, ed25519.sign(encodeAcceptance(answer), SECRETS.backer), []);
    advanceWitnessedIndex(f.venue, 21n);
    expect(dishonourOf(f.gold, f.venue, gold(f), servedOf(f), hash)).toBe("dishonoured");
  });

  it("a served log carrying an acceptance the door never took — no reserved payout beside it — reads dishonoured", () => {
    // The law replays an acceptance without seeing legs, so a lying operator
    // can serve one bare; the reader checks the paying log, not the door.
    const f = setup();
    const { hash } = file(f, 40n);
    const eurLog = f.sequencer.opLog(f.eur);
    const answer = { backing: f.eur, demandHash: hash, instant: 0n, deadline: 90n, nonce: 1n };
    const bare: OpLogEntry = {
      position: eurLog.length,
      kind: "acceptance",
      demandHash: hash,
      instant: 0n,
      deadline: 90n,
      nonce: 1n,
      signature: ed25519.sign(encodeAcceptance(answer), SECRETS.backer),
    };
    const snapshots = [
      { name: f.eur.name, opLog: [...eurLog, bare] },
      { name: f.gold.name, opLog: f.sequencer.opLog(f.gold) },
    ];
    advanceWitnessedIndex(f.venue, 101n);
    const commitment = signCommitment(SECRETS.operator, 0n, stateRoot(snapshots));
    f.venue.publish(commitment);
    expect(dishonourOf(f.eur, f.venue, gold(f), { snapshots, commitment }, hash)).toBe("dishonoured");
  });

  it("a reservation too short for the answer is no reservation: the lock must reach the acceptance's own deadline", () => {
    // The door enforces "the paying lock must outlast the acceptance"; a lying
    // operator's log need not, so the reader asks the timeout itself.
    const f = setup();
    const { hash } = file(f, 40n);
    const shortLock = { backing: f.gold, attemptId: hash, holder: KEYS.backer, beneficiary: KEYS.alice, quantity: 80n, timeout: 50n, decisionVenue: NO_DECISION_VENUE, parties: [KEYS.alice], nonce: 1n };
    const lockEntry: OpLogEntry = {
      position: f.sequencer.opLog(f.gold).length,
      kind: "lock",
      attemptId: hash,
      holder: KEYS.backer,
      beneficiary: KEYS.alice,
      quantity: 80n,
      timeout: 50n,
      decisionVenue: NO_DECISION_VENUE,
      parties: [KEYS.alice],
      nonce: 1n,
      signature: ed25519.sign(encodeLock(shortLock), SECRETS.backer),
    };
    const answer = { backing: f.eur, demandHash: hash, instant: 0n, deadline: 90n, nonce: 1n };
    const acceptance: OpLogEntry = {
      position: f.sequencer.opLog(f.eur).length,
      kind: "acceptance",
      demandHash: hash,
      instant: 0n,
      deadline: 90n,
      nonce: 1n,
      signature: ed25519.sign(encodeAcceptance(answer), SECRETS.backer),
    };
    const snapshots = [
      { name: f.eur.name, opLog: [...f.sequencer.opLog(f.eur), acceptance] },
      { name: f.gold.name, opLog: [...f.sequencer.opLog(f.gold), lockEntry] },
    ];
    advanceWitnessedIndex(f.venue, 101n);
    const commitment = signCommitment(SECRETS.operator, 0n, stateRoot(snapshots));
    f.venue.publish(commitment);
    expect(dishonourOf(f.eur, f.venue, gold(f), { snapshots, commitment }, hash)).toBe("dishonoured");
  });

  it("a lock reaching exactly the acceptance's deadline is a reservation: the boundary is the door's own", () => {
    // The door refuses only a lock that falls short of the acceptance
    // (timeout < deadline), so timeout === deadline is a lawful answer and the
    // reader must not read it as dishonour.
    const f = setup();
    const { hash } = file(f, 40n);
    accept(f, hash, 40n, { timeout: 90n }); // the acceptance's own deadline
    advanceWitnessedIndex(f.venue, 101n);
    expect(dishonourOf(f.eur, f.venue, gold(f), servedOf(f), hash)).toBe("lapsed");
  });

  it("a paying log that does not replay under the law answers nothing", () => {
    // Replay is the one bound on what an operator can ADD to a log: an
    // omission is caught by the holder's receipt position, an addition only by
    // this. A junk lock nobody signed, with the set's own terms, must not
    // become the reservation that exonerates the backer.
    const f = setup();
    const { hash } = file(f, 40n);
    const junk = { ...goldLock(f, { attemptId: hash }), signature: new Uint8Array(64) };
    const state = serve(f, [bareAcceptance(f, hash, 90n)], [junk], 101n);
    expect(replayLog(f.gold, state.snapshots[1]!.opLog)).toBeUndefined();
    expect(dishonourOf(f.eur, f.venue, gold(f), state, hash)).toBe("unreadable");
  });

  it("an acceptance whose deadline precedes the demand's instant is not a history: the head log will not replay", () => {
    // Both values are the parties' own signed terms, so the law checks them
    // with no clock — the instant is at or before the filing index, the
    // acceptance at or after it. Without this, a fabricated deadline-0 answer
    // made "reserved through the window" vacuously true for any lock at all.
    const f = setup();
    advanceWitnessedIndex(f.venue, 5n);
    const demand: DemandOp = { backing: f.eur, holder: KEYS.alice, quantity: 40n, instant: 5n, deadline: DEADLINE, nonce: f.sequencer.nextNonce(KEYS.alice, f.eur) };
    f.sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice));
    const hash = demandHash(demand);
    const nonce = f.sequencer.nextNonce(KEYS.backer, f.eur);
    const answer: AcceptanceOp = { backing: f.eur, demandHash: hash, instant: 5n, deadline: 2n, nonce };
    const vacuous: OpLogEntry = {
      position: f.sequencer.opLog(f.eur).length,
      kind: "acceptance",
      demandHash: hash,
      instant: 5n,
      deadline: 2n,
      nonce,
      signature: ed25519.sign(encodeAcceptance(answer), SECRETS.backer),
    };
    const state = serve(f, [vacuous], [goldLock(f, { attemptId: hash, timeout: 2n })], 101n);
    expect(replayLog(f.eur, state.snapshots[0]!.opLog)).toBeUndefined();
    expect(dishonourOf(f.eur, f.venue, gold(f), state, hash)).toBe("unreadable");
  });

  it("a reservation to somebody else is no reservation", () => {
    const f = setup();
    const { hash } = file(f, 40n);
    const state = serve(
      f,
      [bareAcceptance(f, hash, 90n)],
      [goldLock(f, { attemptId: hash, beneficiary: KEYS.bob, parties: [KEYS.bob] })],
      101n,
    );
    expect(dishonourOf(f.eur, f.venue, gold(f), state, hash)).toBe("dishonoured");
  });

  it("a reservation of half the payout is no reservation", () => {
    const f = setup();
    const { hash } = file(f, 40n);
    const state = serve(f, [bareAcceptance(f, hash, 90n)], [goldLock(f, { attemptId: hash, quantity: 40n })], 101n);
    expect(dishonourOf(f.eur, f.venue, gold(f), state, hash)).toBe("dishonoured");
  });

  it("a reservation under another attempt is no reservation", () => {
    const f = setup();
    const { hash } = file(f, 40n);
    const state = serve(
      f,
      [bareAcceptance(f, hash, 90n)],
      [goldLock(f, { attemptId: new Uint8Array(32).fill(3) })],
      101n,
    );
    expect(dishonourOf(f.eur, f.venue, gold(f), state, hash)).toBe("dishonoured");
  });

  it("the log answers, not the record: a reserved first round under a bare second is the holder's lapse", () => {
    // The record keeps only the LAST acceptance's deadline; the reader scans
    // the log, where an earlier round that stood fully reserved answers for
    // its own window even though the served record's answer was never taken
    // at any door.
    const f = setup();
    const { hash } = file(f, 40n);
    const op1: AcceptanceOp = { backing: f.eur, demandHash: hash, instant: 0n, deadline: 40n, nonce: f.sequencer.nextNonce(KEYS.backer, f.eur) };
    const lock1: LockOp = { backing: f.gold, attemptId: hash, holder: KEYS.backer, beneficiary: KEYS.alice, quantity: 80n, timeout: 40n, decisionVenue: NO_DECISION_VENUE, parties: [KEYS.alice], nonce: f.sequencer.nextNonce(KEYS.backer, f.gold) };
    f.sequencer.submitAcceptance(op1, ed25519.sign(encodeAcceptance(op1), SECRETS.backer), [{ op: lock1, signature: ed25519.sign(encodeLock(lock1), SECRETS.backer) }]);
    advanceWitnessedIndex(f.venue, 41n); // round 1 expires
    const state = serve(f, [bareAcceptance(f, hash, 90n)], [], 101n);
    const record = replayLog(f.eur, state.snapshots[0]!.opLog)!.demands.values().next().value!;
    expect(record.acceptedDeadline).toBe(90n); // the record's own answer: bare
    expect(dishonourOf(f.eur, f.venue, gold(f), state, hash)).toBe("lapsed"); // round 1 answers
  });

  it("a resolver handing back another backing under the name asked for is unreadable", () => {
    // "A resolver whose every answer is checked against the name asked for" —
    // the regression the terms readers were hardened against, asked of this one.
    const f = setup();
    const { hash } = file(f, 40n);
    accept(f, hash, 40n);
    advanceWitnessedIndex(f.venue, 101n);
    expect(dishonourOf(f.eur, f.venue, () => f.eur, servedOf(f), hash)).toBe("unreadable");
  });
});
