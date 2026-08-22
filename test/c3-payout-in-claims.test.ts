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
import { payoutOf } from "../src/presentability.js";
import { Sequencer, SequencerError } from "../src/sequencer.js";
import { LocalVenue } from "../src/venue.js";
import { compareBytes } from "../src/bytes.js";
import { snapshotRedemptions } from "../src/recovery.js";
import { replayLog } from "../src/ledger.js";
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
  const head = { backing: f.eur, demandHash: hash, nonce: f.sequencer.nextNonce(KEYS.alice, f.eur) };
  const pay = { backing: f.gold, demandHash: hash, nonce: f.sequencer.nextNonce(KEYS.alice, f.gold) };
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
    const pay = { backing: f.gold, demandHash: hash, nonce: f.sequencer.nextNonce(KEYS.alice, f.gold) };
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
    const early = { backing: f.gold, demandHash: hash, nonce: f.sequencer.nextNonce(KEYS.backer, f.gold) };
    expect(() => f.sequencer.submitWithdrawal(early, ed25519.sign(encodeWithdrawal(early), SECRETS.backer))).toThrow(/expired/);
    f.venue.advance(1n);
    const back = { backing: f.gold, demandHash: hash, nonce: f.sequencer.nextNonce(KEYS.backer, f.gold) };
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
    expect(payoutOf(f.eur, f.venue, terms, served(), hash)).toBe("reserved");
    // And only while the acceptance is live: the lock outlasts the answer by the
    // door's rule, so it is the acceptance the holder's read must ask (found
    // regression-reviewing slice 27: "reserved" at 91 while the release was refused).
    advanceWitnessedIndex(f.venue, 90n);
    expect(payoutOf(f.eur, f.venue, terms, served(), hash)).toBe("reserved");
    advanceWitnessedIndex(f.venue, 91n);
    expect(payoutOf(f.eur, f.venue, terms, served(), hash)).toBe("unreserved");
    expect(payoutOf(f.gold, f.venue, terms, served(), hash)).toBe("outside");
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
    const back = { backing: f.gold, demandHash: hash, nonce: f.sequencer.nextNonce(KEYS.backer, f.gold) };
    f.sequencer.submitWithdrawal(back, ed25519.sign(encodeWithdrawal(back), SECRETS.backer));
    expect(f.sequencer.availableBalance(f.gold, KEYS.backer)).toBe(500n);
  });

  it("nobody squats the paying slot: a lock naming a venue under a standing demand's hash is refused", () => {
    const f = setup();
    const { hash } = file(f, 40n);
    const squat: LockOp = {
      backing: f.gold,
      attemptId: hash,
      holder: KEYS.backer,
      beneficiary: KEYS.backer,
      quantity: 1n,
      timeout: 10_000n,
      decisionVenue: f.venue.id,
      parties: [KEYS.backer],
      nonce: f.sequencer.nextNonce(KEYS.backer, f.gold),
    };
    expect(() => f.sequencer.submitLock(squat, ed25519.sign(encodeLock(squat), SECRETS.backer))).toThrow(
      /standing demand/,
    );
    accept(f, hash, 40n);
    expect(f.sequencer.availableBalance(f.gold, KEYS.backer)).toBe(420n);
  });

  it("in a gap the head's release and the paying lock's release are both refused, and the verifier agrees", () => {
    const f = setup(true);
    const { hash } = file(f, 40n);
    accept(f, hash, 40n);
    const commitment = f.sequencer.commit();
    const served = { snapshots: f.sequencer.snapshot(), commitment };
    f.venue.advance(30n);
    const head = { backing: f.eur, demandHash: hash, nonce: f.sequencer.nextNonce(KEYS.alice, f.eur) };
    f.venue.publishOp(f.eur.name, { kind: "release", demandHash: hash, nonce: head.nonce, signature: ed25519.sign(encodeRelease(head), SECRETS.alice) });
    const pay = { backing: f.gold, demandHash: hash, nonce: f.sequencer.nextNonce(KEYS.alice, f.gold) };
    f.venue.publishOp(f.gold.name, { kind: "release", demandHash: hash, nonce: pay.nonce, signature: ed25519.sign(encodeRelease(pay), SECRETS.alice) });
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
  it("a demand whose paying slot already holds a lock is refused at filing: re-file with a fresh nonce", () => {
    // Found regression-reviewing the review: the gate refused a lock under a
    // STANDING demand's hash, so a holder who predicted her own next hash could
    // lock the paying slot first, file, and leave the backer no way to answer.
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
    expect(() => f.sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice))).toThrow(
      /re-file with a fresh nonce/,
    );
    expect(f.sequencer.openDemands(f.eur)).toHaveLength(0);
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
    const head = { backing: f.eur, demandHash: hash, nonce: f.sequencer.nextNonce(KEYS.alice, f.eur) };
    const pay = { backing: f.gold, demandHash: hash, nonce: f.sequencer.nextNonce(KEYS.alice, f.gold) };
    const legs = [{ op: pay, signature: ed25519.sign(encodeRelease(pay), SECRETS.alice) }];
    const signature = ed25519.sign(encodeRelease(head), SECRETS.alice);
    const first = f.sequencer.submitRelease(head, signature, legs);
    const again = f.sequencer.submitRelease(head, signature, legs);
    expect(again).toEqual(first);
    expect(f.sequencer.balance(f.gold, KEYS.alice)).toBe(80n);
    expect(f.sequencer.balance(f.eur, KEYS.backer)).toBe(40n);

    const g = setup();
    const w = file(g, 40n);
    const out = { backing: g.eur, demandHash: w.hash, nonce: g.sequencer.nextNonce(KEYS.alice, g.eur) };
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
