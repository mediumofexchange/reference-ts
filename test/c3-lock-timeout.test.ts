import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { replayLog } from "../src/ledger.js";
import { compareBytes } from "../src/bytes.js";
import { snapshotRedemptions } from "../src/recovery.js";
import { encodeIssuanceMessage, encodeTransferMessage } from "../src/messages.js";
import {
  demandHash,
  encodeAcceptance,
  encodeDemand,
  encodeLock,
  encodeRelease,
  encodeWithdrawal,
  signCommit,
  type DemandOp,
  type LockOp,
  NO_DECISION_VENUE,
} from "../src/presentation.js";
import { Sequencer } from "../src/sequencer.js";
import { LocalVenue } from "../src/venue.js";
import { advanceWitnessedIndex, KEYS, SECRETS } from "./support.js";

// §C3's fourth step, and the only one slice 22 left out.
//
//   "**Abort.** The **lock timeout** the holder declared in the prepare, itself a
//   witnessed index, unlocks everywhere, and expired locks unlock unilaterally.
//   It is not the demand's deadline: the timeout ends the atomic attempt, the
//   deadline governs evidence, and a demand outlives its locks."
//
// **The timeout gates the release, and never the balances.** That is not a
// softening — it is what keeps a replay exact. Every TIME rule in this ledger
// refuses an action and none moves units, because `applyEntry`'s clock is
// undefined on replay: if an expiring lock silently freed its units, an operator
// that correctly accepted a transfer after the timeout would have a log that no
// verifier could replay, and stateIsAuthentic would call an honest history
// unlawful. The existing demand deadline works the same way — a demand past its
// deadline still holds its units until a withdrawal ends it.
//
// So "unlocks unilaterally" is read as: past the timeout the set can no longer
// settle, so the holder's exit needs nobody's cooperation. Withdrawal is that
// exit -- and since 24c it opens ONLY past the timeout. Before it the lock is
// the holder's own declared commitment, and an exit open there let a holder
// take back one half of a bundle the record had already committed (the last
// block below, and c3-atomic-bundle).

const TIMEOUT = 40n;

function setup() {
  const venue = new LocalVenue();
  const mk = (thing: string, reliance: { target: Uint8Array; count: bigint }[] = []) =>
    makeBacking({
      obligor: KEYS.backer,
      payout: { thing, quantumExponent: -2, perUnit: 100n },
      reliance,
      evidence: { setting: "transparent", operator: KEYS.operator },
    });
  const gold = mk("GOLD");
  const eur = mk("EUR", [{ target: gold.name, count: 2n }]);
  const sequencer = new Sequencer(SECRETS.operator, venue);
  for (const backing of [gold, eur]) {
    sequencer.register(backing, signBacking(SECRETS.backer, backing));
    const nonce = sequencer.nextNonce(KEYS.backer, backing);
    sequencer.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 200n, nonce },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 200n, nonce), SECRETS.backer),
    );
  }
  return { venue, sequencer, eur, gold };
}

function file(
  sequencer: Sequencer,
  venue: LocalVenue,
  eur: Backing,
  gold: Backing,
  quantity: bigint,
  timeout = TIMEOUT,
) {
  const demand: DemandOp = {
    backing: eur,
    holder: KEYS.alice,
    quantity,
    instant: 0n,
    deadline: 100n,
    nonce: sequencer.nextNonce(KEYS.alice, eur),
  };
  const hash = demandHash(demand);
  const lock: LockOp = {
    backing: gold,
    attemptId: hash,
    holder: KEYS.alice,
    beneficiary: KEYS.backer,
    quantity: quantity * 2n,
    timeout,
    decisionVenue: NO_DECISION_VENUE,
    parties: [KEYS.alice],
    nonce: sequencer.nextNonce(KEYS.alice, gold),
  };
  sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice), [
    { op: lock, signature: ed25519.sign(encodeLock(lock), SECRETS.alice) },
  ]);
  return { hash, lock };
}

function accept(sequencer: Sequencer, eur: Backing, hash: Uint8Array, deadline = 90n) {
  const op = {
    backing: eur,
    demandHash: hash,
    instant: 0n,
    deadline,
    nonce: sequencer.nextNonce(KEYS.backer, eur),
  };
  sequencer.submitAcceptance(op, ed25519.sign(encodeAcceptance(op), SECRETS.backer));
}

function releaseSet(sequencer: Sequencer, eur: Backing, gold: Backing, hash: Uint8Array) {
  const head = { backing: eur, demandHash: hash, nonce: sequencer.nextNonce(KEYS.alice, eur) };
  const leg = { backing: gold, demandHash: hash, nonce: sequencer.nextNonce(KEYS.alice, gold) };
  return sequencer.submitRelease(head, ed25519.sign(encodeRelease(head), SECRETS.alice), [
    { op: leg, signature: ed25519.sign(encodeRelease(leg), SECRETS.alice) },
  ]);
}

function withdrawSet(sequencer: Sequencer, eur: Backing, gold: Backing, hash: Uint8Array) {
  const head = { backing: eur, demandHash: hash, nonce: sequencer.nextNonce(KEYS.alice, eur) };
  const leg = { backing: gold, demandHash: hash, nonce: sequencer.nextNonce(KEYS.alice, gold) };
  return sequencer.submitWithdrawal(head, ed25519.sign(encodeWithdrawal(head), SECRETS.alice), [
    { op: leg, signature: ed25519.sign(encodeWithdrawal(leg), SECRETS.alice) },
  ]);
}

/** Alice withdraws her GOLD leg alone — open only past its timeout (24c). */
function withdrawLeg(sequencer: Sequencer, gold: Backing, hash: Uint8Array) {
  const leg = { backing: gold, demandHash: hash, nonce: sequencer.nextNonce(KEYS.alice, gold) };
  return sequencer.submitWithdrawal(leg, ed25519.sign(encodeWithdrawal(leg), SECRETS.alice));
}

/** Alice re-prepares the GOLD leg of her standing demand, with a fresh timeout. */
function relock(
  sequencer: Sequencer,
  eur: Backing,
  gold: Backing,
  hash: Uint8Array,
  timeout: bigint,
  quantity = 80n,
) {
  const lock: LockOp = {
    backing: gold,
    attemptId: hash,
    holder: KEYS.alice,
    beneficiary: KEYS.backer,
    quantity,
    timeout,
    decisionVenue: NO_DECISION_VENUE,
    parties: [KEYS.alice],
    nonce: sequencer.nextNonce(KEYS.alice, gold),
  };
  return sequencer.submitLeg(eur, hash, { op: lock, signature: ed25519.sign(encodeLock(lock), SECRETS.alice) });
}

/** Whether a move the holder tries is accepted; a refusal is an answer, not a failure. */
function tryMove(move: () => void): boolean {
  try {
    move();
    return true;
  } catch {
    return false;
  }
}

describe("§C3: the lock timeout ends the atomic attempt", () => {
  it("settles inside the timeout", () => {
    const { venue, sequencer, eur, gold } = setup();
    const { hash } = file(sequencer, venue, eur, gold, 40n);
    accept(sequencer, eur, hash);
    venue.advance(TIMEOUT);
    releaseSet(sequencer, eur, gold, hash);
    expect(sequencer.balance(gold, KEYS.backer)).toBe(80n);
  });

  it("and refuses to settle one index past it", () => {
    // "was a valid release witnessed at or before the lock timeout?" — at is
    // inside, one past is not.
    const { venue, sequencer, eur, gold } = setup();
    const { hash } = file(sequencer, venue, eur, gold, 40n);
    accept(sequencer, eur, hash);
    venue.advance(TIMEOUT + 1n);
    expect(() => releaseSet(sequencer, eur, gold, hash)).toThrow(/timeout/);
    expect(sequencer.balance(gold, KEYS.backer)).toBe(0n);
  });

  it("refuses a lock whose timeout has already passed", () => {
    const { venue, sequencer, eur, gold } = setup();
    venue.advance(50n);
    expect(() => file(sequencer, venue, eur, gold, 40n, 40n)).toThrow(/timeout/);
    // And one whose timeout IS the current index: strictly ahead, or the attempt
    // has no index to run in (the boundary 24c's review caught moving).
    expect(() => file(sequencer, venue, eur, gold, 40n, 50n)).toThrow(/timeout/);
  });

  it("the demand outlives its locks, and can be relocked", () => {
    // §C3: "the timeout ends the atomic attempt, the deadline governs evidence,
    // and a demand outlives its locks." So an expired attempt is a retry, not a
    // lost demand — the whole point of the timeout being separate. The retry is
    // re-prepare: the expired leg is withdrawn (the holder's alone, past its
    // timeout) and locked again under the standing demand, and the set settles
    // against the acceptance that was live all along.
    const { venue, sequencer, eur, gold } = setup();
    const { hash } = file(sequencer, venue, eur, gold, 40n);
    accept(sequencer, eur, hash);
    venue.advance(TIMEOUT + 1n);
    expect(() => releaseSet(sequencer, eur, gold, hash)).toThrow(/timeout/);

    // The demand still stands, and its units are still committed to it.
    expect(sequencer.openDemands(eur)).toHaveLength(1);
    expect(sequencer.availableBalance(eur, KEYS.alice)).toBe(160n);

    withdrawLeg(sequencer, gold, hash);
    relock(sequencer, eur, gold, hash, 95n);
    releaseSet(sequencer, eur, gold, hash);
    expect(sequencer.balance(gold, KEYS.backer)).toBe(80n);
    expect(sequencer.balance(eur, KEYS.backer)).toBe(40n);
    expect(sequencer.openDemands(eur)).toHaveLength(0);
  });
});

describe("§C3: an expired lock unlocks unilaterally", () => {
  it("withdrawal frees it with nobody else's cooperation", () => {
    const { venue, sequencer, eur, gold } = setup();
    const { hash } = file(sequencer, venue, eur, gold, 40n);
    venue.advance(TIMEOUT + 5n);
    withdrawSet(sequencer, eur, gold, hash);
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(200n);
    expect(sequencer.balance(gold, KEYS.backer)).toBe(0n);
  });

  it("but the units stay committed until it is withdrawn", () => {
    // The rule that keeps a replay exact: no clock moves a balance. An expiring
    // lock that silently freed its units would make an operator's correct
    // history unreplayable, since applyEntry has no clock on a replay.
    const { venue, sequencer, eur, gold } = setup();
    file(sequencer, venue, eur, gold, 40n);
    venue.advance(TIMEOUT + 5n);
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(120n);
    const nonce = sequencer.nextNonce(KEYS.alice, gold);
    expect(() =>
      sequencer.submitTransfer(
        { backing: gold, from: KEYS.alice, to: KEYS.bob, quantity: 130n, nonce },
        ed25519.sign(
          encodeTransferMessage(gold.name, KEYS.alice, KEYS.bob, 130n, nonce),
          SECRETS.alice,
        ),
      ),
    ).toThrow(/insufficient/);
  });

  it("and the whole history still replays after the timeout passes", () => {
    const { venue, sequencer, eur, gold } = setup();
    const { hash } = file(sequencer, venue, eur, gold, 40n);
    venue.advance(TIMEOUT + 5n);
    withdrawSet(sequencer, eur, gold, hash);
    const nonce = sequencer.nextNonce(KEYS.alice, gold);
    sequencer.submitTransfer(
      { backing: gold, from: KEYS.alice, to: KEYS.bob, quantity: 200n, nonce },
      ed25519.sign(
        encodeTransferMessage(gold.name, KEYS.alice, KEYS.bob, 200n, nonce),
        SECRETS.alice,
      ),
    );
    // The verifier has no clock, and does not need one: every balance here was
    // moved by an operation rather than by time passing.
    expect(replayLog(gold, sequencer.opLog(gold))).toBeDefined();
    expect(replayLog(eur, sequencer.opLog(eur))).toBeDefined();
  });
});

describe("§C2b: the gap path cannot open a reliant presentation", () => {
  it("refuses to adopt a demand on a backing with reliance", () => {
    // Found regression-reviewing this slice, and it reaches back into slice 22.
    // That slice removed applyEntry's refusal of a reliant demand — correctly,
    // since the legs live in other states — and made the sequencer enforce the
    // set. But `adopt` applies gap publications straight to the ledger, so the
    // gap path inherited the relaxed law with nothing in its place: a holder
    // published demand, acceptance and release at the venue while the operator
    // was dark, and settled 40 units to the backer with none of the 80 that must
    // accompany them, keeping the lot. Invariant 13, through the back door.
    //
    // Refused, and refusing is §C2b's own posture: claims "go illiquid rather
    // than dead" while the operator is away. A lock is not a gap leg either
    // (recovery.ts), so there is nothing that could have accompanied it.
    const venue = new LocalVenue();
    const silence = { noCommitmentDuration: 10n, challengeWindow: 5n };
    const mk = (thing: string, reliance: { target: Uint8Array; count: bigint }[] = []) =>
      makeBacking({
        obligor: KEYS.backer,
        payout: { thing, quantumExponent: -2, perUnit: 100n },
        reliance,
        evidence: {
          setting: "transparent",
          operator: KEYS.operator,
          silence,
          witnessing: { venue: venue.id, interval: 5n },
        },
      });
    const gold = mk("GOLD");
    const eur = mk("EUR", [{ target: gold.name, count: 2n }]);
    const sequencer = new Sequencer(SECRETS.operator, venue);
    for (const backing of [gold, eur]) {
      sequencer.register(backing, signBacking(SECRETS.backer, backing));
      const nonce = sequencer.nextNonce(KEYS.backer, backing);
      sequencer.submitIssue(
        { backing, recipient: KEYS.alice, quantity: 200n, nonce },
        ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 200n, nonce), SECRETS.backer),
      );
    }
    sequencer.commit();
    venue.advance(30n);

    const demand: DemandOp = {
      backing: eur,
      holder: KEYS.alice,
      quantity: 40n,
      instant: venue.witnessedIndex(),
      deadline: 200n,
      nonce: 0n,
    };
    const hash = demandHash(demand);
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
    const answer = {
      backing: eur,
      demandHash: hash,
      instant: demand.instant,
      deadline: 150n,
      nonce: sequencer.nextNonce(KEYS.backer, eur),
    };
    venue.publishOp(eur.name, {
      kind: "acceptance",
      demandHash: hash,
      instant: answer.instant,
      deadline: answer.deadline,
      nonce: answer.nonce,
      signature: ed25519.sign(encodeAcceptance(answer), SECRETS.backer),
    });
    venue.advance(1n);
    const settle = { backing: eur, demandHash: hash, nonce: demand.nonce + 1n };
    venue.publishOp(eur.name, {
      kind: "release",
      demandHash: hash,
      nonce: settle.nonce,
      signature: ed25519.sign(encodeRelease(settle), SECRETS.alice),
    });

    venue.advance(1n);
    sequencer.commit();

    expect(sequencer.balance(eur, KEYS.backer)).toBe(0n);
    expect(sequencer.balance(eur, KEYS.alice)).toBe(200n);
    expect(sequencer.openDemands(eur)).toHaveLength(0);
  });

  it("but a backing with no reliance settles through the gap as before", () => {
    // The guard must be exactly as wide as the reason for it.
    const venue = new LocalVenue();
    const gold = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "GOLD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: {
        setting: "transparent",
        operator: KEYS.operator,
        silence: { noCommitmentDuration: 10n, challengeWindow: 5n },
        witnessing: { venue: venue.id, interval: 5n },
      },
    });
    const sequencer = new Sequencer(SECRETS.operator, venue);
    sequencer.register(gold, signBacking(SECRETS.backer, gold));
    const nonce = sequencer.nextNonce(KEYS.backer, gold);
    sequencer.submitIssue(
      { backing: gold, recipient: KEYS.alice, quantity: 200n, nonce },
      ed25519.sign(encodeIssuanceMessage(gold.name, KEYS.alice, 200n, nonce), SECRETS.backer),
    );
    sequencer.commit();
    venue.advance(30n);

    const demand: DemandOp = {
      backing: gold,
      holder: KEYS.alice,
      quantity: 40n,
      instant: venue.witnessedIndex(),
      deadline: 200n,
      nonce: 0n,
    };
    const hash = demandHash(demand);
    venue.publishOp(gold.name, {
      kind: "demand",
      holder: demand.holder,
      quantity: demand.quantity,
      instant: demand.instant,
      deadline: demand.deadline,
      nonce: demand.nonce,
      signature: ed25519.sign(encodeDemand(demand), SECRETS.alice),
    });
    venue.advance(1n);
    const answer = {
      backing: gold,
      demandHash: hash,
      instant: demand.instant,
      deadline: 150n,
      nonce: sequencer.nextNonce(KEYS.backer, gold),
    };
    venue.publishOp(gold.name, {
      kind: "acceptance",
      demandHash: hash,
      instant: answer.instant,
      deadline: answer.deadline,
      nonce: answer.nonce,
      signature: ed25519.sign(encodeAcceptance(answer), SECRETS.backer),
    });
    venue.advance(1n);
    const settle = { backing: gold, demandHash: hash, nonce: 1n };
    venue.publishOp(gold.name, {
      kind: "release",
      demandHash: hash,
      nonce: settle.nonce,
      signature: ed25519.sign(encodeRelease(settle), SECRETS.alice),
    });
    venue.advance(1n);
    sequencer.commit();

    expect(sequencer.balance(gold, KEYS.backer)).toBe(40n);
  });
});

describe("§C3: a lock is withdrawable only past its timeout", () => {
  // Found reviewing 24b. Slice 22 let a set be withdrawn at any index, and the
  // bundle inherited it: a holder freed a lock BEFORE its own timeout, after the
  // commit was witnessed, and one witnessed object then settled at one
  // sequencer and not the other. §C3's abort is "**expired** locks unlock
  // unilaterally". Before that the two exits are complements on the timeout,
  // exactly as release and withdrawal are complements on the acceptance for a
  // demand: at or before it, commit or release; past it, withdrawal; never
  // both, never neither.
  it("refuses a withdrawal at the timeout, which is inside it", () => {
    const { venue, sequencer, eur, gold } = setup();
    const { hash } = file(sequencer, venue, eur, gold, 40n);
    venue.advance(TIMEOUT);
    expect(() => withdrawSet(sequencer, eur, gold, hash)).toThrow(/expired/);
    // And the whole set stood, the demand with its leg: all or none.
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(120n);
    expect(sequencer.openDemands(eur)).toHaveLength(1);
  });

  it("and allows it one index past", () => {
    const { venue, sequencer, eur, gold } = setup();
    const { hash } = file(sequencer, venue, eur, gold, 40n);
    venue.advance(TIMEOUT + 1n);
    withdrawSet(sequencer, eur, gold, hash);
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(200n);
    expect(sequencer.openDemands(eur)).toHaveLength(0);
  });
});

/**
 * One backing that can go dark and be adopted from: a silence clause to date
 * the gap, a witnessing venue to read it on. Alice holds 200.
 */
function gapGold() {
  const venue = new LocalVenue();
  const gold = makeBacking({
    obligor: KEYS.backer,
    payout: { thing: "GOLD", quantumExponent: -2, perUnit: 100n },
    reliance: [],
    evidence: {
      setting: "transparent",
      operator: KEYS.operator,
      silence: { noCommitmentDuration: 10n, challengeWindow: 5n },
      witnessing: { venue: venue.id, interval: 5n },
    },
  });
  const sequencer = new Sequencer(SECRETS.operator, venue);
  sequencer.register(gold, signBacking(SECRETS.backer, gold));
  const nonce = sequencer.nextNonce(KEYS.backer, gold);
  sequencer.submitIssue(
    { backing: gold, recipient: KEYS.alice, quantity: 200n, nonce },
    ed25519.sign(encodeIssuanceMessage(gold.name, KEYS.alice, 200n, nonce), SECRETS.backer),
  );
  return { venue, gold, sequencer };
}

/** Alice reserves 90 GOLD for Bob under `attempt`, timeout 100, and the operator commits. */
function lockAndCommit(f: ReturnType<typeof gapGold>, attempt: Uint8Array) {
  const lock: LockOp = {
    backing: f.gold,
    attemptId: attempt,
    holder: KEYS.alice,
    beneficiary: KEYS.bob,
    quantity: 90n,
    timeout: 100n,
    decisionVenue: f.venue.id,
    parties: [KEYS.alice],
    nonce: f.sequencer.nextNonce(KEYS.alice, f.gold),
  };
  f.sequencer.submitLock(lock, ed25519.sign(encodeLock(lock), SECRETS.alice));
  const commitment = f.sequencer.commit();
  return { lock, commitment };
}

/** A withdrawal of `attempt`'s lock, published at the venue while the operator is dark. */
function publishWithdrawal(f: ReturnType<typeof gapGold>, attempt: Uint8Array, nonce: bigint) {
  const op = { backing: f.gold, demandHash: attempt, nonce };
  f.venue.publishOp(f.gold.name, {
    kind: "withdrawal",
    demandHash: attempt,
    nonce,
    signature: ed25519.sign(encodeWithdrawal(op), SECRETS.alice),
  });
}

describe("§C3: the gap path reads the same exits, because the rules are the law's and the record's", () => {
  // 24a's lesson: `adopt` applies gap publications straight to the law, so a
  // rule that lived only in the sequencer's submit path would be bypassed by
  // going dark. Both halves of 24c are checked here: the law's (no withdrawal
  // while the lock is live) and the sequencer's (no withdrawal where the record
  // already shows the half committed) — the second sits on adopt as well.
  const ATTEMPT = new Uint8Array(32).fill(0xc3);

  it("a withdrawal published before the timeout is not adopted", () => {
    const f = gapGold();
    const { lock } = lockAndCommit(f, ATTEMPT);
    f.venue.advance(30n);
    publishWithdrawal(f, ATTEMPT, lock.nonce + 1n);
    f.venue.advance(1n);
    f.sequencer.commit();
    expect(f.sequencer.availableBalance(f.gold, KEYS.alice)).toBe(110n);
    // And the commit witnessed in time settles the half she tried to take back.
    f.venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    f.sequencer.settle(f.gold, ATTEMPT);
    expect(f.sequencer.balance(f.gold, KEYS.bob)).toBe(90n);
  });

  it("nor is one published past the timeout, where a commit was witnessed in time", () => {
    const f = gapGold();
    const { lock } = lockAndCommit(f, ATTEMPT);
    f.venue.advance(30n);
    f.venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    advanceWitnessedIndex(f.venue, 101n);
    publishWithdrawal(f, ATTEMPT, lock.nonce + 1n);
    f.venue.advance(1n);
    f.sequencer.commit();
    expect(f.sequencer.availableBalance(f.gold, KEYS.alice)).toBe(110n);
    f.sequencer.settle(f.gold, ATTEMPT);
    expect(f.sequencer.balance(f.gold, KEYS.bob)).toBe(90n);
  });

  it("a withdrawal published past the timeout with nothing committed is adopted", () => {
    // The guard is exactly as wide as its reason.
    const f = gapGold();
    const { lock } = lockAndCommit(f, ATTEMPT);
    advanceWitnessedIndex(f.venue, 101n);
    publishWithdrawal(f, ATTEMPT, lock.nonce + 1n);
    f.venue.advance(1n);
    f.sequencer.commit();
    expect(f.sequencer.availableBalance(f.gold, KEYS.alice)).toBe(200n);
  });
});

/** gapGold's two-backing sibling: EUR relies on GOLD x2, both adoptable, Alice holds 200 of each. */
function gapPair() {
  const venue = new LocalVenue();
  const mk = (thing: string, reliance: { target: Uint8Array; count: bigint }[] = []) =>
    makeBacking({
      obligor: KEYS.backer,
      payout: { thing, quantumExponent: -2, perUnit: 100n },
      reliance,
      evidence: {
        setting: "transparent",
        operator: KEYS.operator,
        silence: { noCommitmentDuration: 10n, challengeWindow: 5n },
        witnessing: { venue: venue.id, interval: 5n },
      },
    });
  const gold = mk("GOLD");
  const eur = mk("EUR", [{ target: gold.name, count: 2n }]);
  const sequencer = new Sequencer(SECRETS.operator, venue);
  for (const backing of [gold, eur]) {
    sequencer.register(backing, signBacking(SECRETS.backer, backing));
    const nonce = sequencer.nextNonce(KEYS.backer, backing);
    sequencer.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 200n, nonce },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 200n, nonce), SECRETS.backer),
    );
  }
  return { venue, sequencer, eur, gold };
}

describe("§C3: a set published into a gap is read one record at a time", () => {
  it("an early set withdrawal lands the head and leaves the leg to its own timeout", () => {
    // The gap path has no set: adopt applies each publication at its stamped
    // index, so the head's exit (no live acceptance) and the leg's (past its
    // timeout) are read separately. Published at 30 with a timeout of 100, the
    // demand ends and the lock stands — a reservation nobody can settle but
    // its own holder's commit, withdrawable alone once its timeout passes.
    // Pinned so the shape is known rather than assumed; not harmful, since the
    // window is the holder's own.
    const { venue, sequencer, eur, gold } = gapPair();
    const { hash, lock } = file(sequencer, venue, eur, gold, 40n, 100n);
    sequencer.commit();
    venue.advance(30n);
    const head = { backing: eur, demandHash: hash, nonce: 1n };
    venue.publishOp(eur.name, {
      kind: "withdrawal",
      demandHash: hash,
      nonce: head.nonce,
      signature: ed25519.sign(encodeWithdrawal(head), SECRETS.alice),
    });
    const leg = { backing: gold, demandHash: hash, nonce: lock.nonce + 1n };
    venue.publishOp(gold.name, {
      kind: "withdrawal",
      demandHash: hash,
      nonce: leg.nonce,
      signature: ed25519.sign(encodeWithdrawal(leg), SECRETS.alice),
    });
    venue.advance(1n);
    sequencer.commit();
    expect(sequencer.openDemands(eur)).toHaveLength(0);
    expect(sequencer.availableBalance(eur, KEYS.alice)).toBe(200n);
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(120n);

    advanceWitnessedIndex(venue, 101n);
    const alone = { backing: gold, demandHash: hash, nonce: sequencer.nextNonce(KEYS.alice, gold) };
    sequencer.submitWithdrawal(alone, ed25519.sign(encodeWithdrawal(alone), SECRETS.alice));
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(200n);
  });
});

describe("§C3: the verifier's gap fold reads the record the way the operator does", () => {
  it("a withdrawal the operator skips, walkGap skips too, so snapshot redemptions agree", () => {
    // Found reviewing 24c: the sequencer skipped a gap withdrawal of a committed
    // lock while recovery.ts's fold applied it, so a verifier saw 90 more units
    // free than the operator did — and a demand for 150, accepted and released
    // in the gap, read as a redemption to one and as over-spent to the other.
    const f = gapGold();
    const ATTEMPT = new Uint8Array(32).fill(0xd1);
    const { lock, commitment } = lockAndCommit(f, ATTEMPT);
    const served = { snapshots: f.sequencer.snapshot(), commitment };
    f.venue.advance(30n);
    f.venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    advanceWitnessedIndex(f.venue, 101n);
    publishWithdrawal(f, ATTEMPT, lock.nonce + 1n);
    f.venue.advance(1n);
    const demand: DemandOp = {
      backing: f.gold,
      holder: KEYS.alice,
      quantity: 150n,
      instant: f.venue.witnessedIndex(),
      deadline: 300n,
      nonce: lock.nonce + 2n,
    };
    const hash = demandHash(demand);
    f.venue.publishOp(f.gold.name, {
      kind: "demand",
      holder: demand.holder,
      quantity: demand.quantity,
      instant: demand.instant,
      deadline: demand.deadline,
      nonce: demand.nonce,
      signature: ed25519.sign(encodeDemand(demand), SECRETS.alice),
    });
    f.venue.advance(1n);
    const answer = { backing: f.gold, demandHash: hash, instant: demand.instant, deadline: 200n, nonce: 1n };
    f.venue.publishOp(f.gold.name, {
      kind: "acceptance",
      demandHash: hash,
      instant: answer.instant,
      deadline: answer.deadline,
      nonce: answer.nonce,
      signature: ed25519.sign(encodeAcceptance(answer), SECRETS.backer),
    });
    f.venue.advance(1n);
    const settle = { backing: f.gold, demandHash: hash, nonce: demand.nonce + 1n };
    f.venue.publishOp(f.gold.name, {
      kind: "release",
      demandHash: hash,
      nonce: settle.nonce,
      signature: ed25519.sign(encodeRelease(settle), SECRETS.alice),
    });
    // The verifier: no redemption, because the 90 are still reserved.
    expect(snapshotRedemptions(f.venue, f.gold, served)).toEqual([]);
    // The operator, on return: the same. The commit settles the lock, nothing else moved.
    f.venue.advance(1n);
    f.sequencer.commit();
    f.sequencer.settle(f.gold, ATTEMPT);
    expect(f.sequencer.balance(f.gold, KEYS.bob)).toBe(90n);
    expect(f.sequencer.balance(f.gold, KEYS.backer)).toBe(0n);
    expect(f.sequencer.openDemands(f.gold)).toHaveLength(0);
  });
});

describe("§C2b: what a gap still takes for a set with legs", () => {
  it("a timely acceptance published in a gap is adopted: the answer is the whole act where P pays outside", () => {
    // The set's demand and releases wait for the operator (slice 26), but an
    // acceptance on a backing whose payout settles outside the claim layer brings
    // nothing with it and is the backer's whole act; refusing it would record a
    // backer that answered in time as unanswered past its deadline.
    const { venue, sequencer, eur, gold } = gapPair();
    const { hash } = file(sequencer, venue, eur, gold, 40n, 200n);
    sequencer.commit();
    venue.advance(30n);
    const answer = { backing: eur, demandHash: hash, instant: 0n, deadline: 90n, nonce: sequencer.nextNonce(KEYS.backer, eur) };
    venue.publishOp(eur.name, {
      kind: "acceptance",
      demandHash: hash,
      instant: answer.instant,
      deadline: answer.deadline,
      nonce: answer.nonce,
      signature: ed25519.sign(encodeAcceptance(answer), SECRETS.backer),
    });
    venue.advance(1n);
    sequencer.commit();
    expect(sequencer.openDemands(eur)[0]?.acceptedDeadline).toBe(90n);
  });
});

describe("§C3: a demand outlives its locks, so an expired attempt is a retry", () => {
  // "The lock timeout... is not the demand's deadline: the timeout ends the
  // atomic attempt, the deadline governs evidence, and a demand outlives its
  // locks." A lapsed attempt is re-prepared, not re-filed: re-filing would cost
  // the demand its instant, which is the value it fixes ("the payout is fixed at
  // the demand's instant up to the deadline").
  //
  // Slice 26 closed both doors a stranger could squat a leg slot through, and
  // the holder's own re-prepare went with them (review-demand-outlives-locks.mjs):
  // past a leg's timeout the set could neither settle nor, under a live
  // acceptance, be withdrawn. `submitLeg` is the holder's door back in, through
  // the checks the legs passed at filing.
  it("a leg that lapses inside a live acceptance: at every boundary exactly one of release, withdrawal or re-prepare-then-release is open", () => {
    // The set-level form of "exactly one exit is open at every index". Leg
    // timeout 40, acceptance deadline 90, demand deadline 100; each move on its
    // own fresh fixture, so exclusivity is what is measured and not only that
    // some move exists. Before the slice the holder had NO move in (40, 90]:
    // release refused at the leg, withdrawal refused at the head, no door to
    // re-prepare. Every index 0..102 holds the same (review27-R7-3.mjs); the
    // boundaries and their neighbours are what is run here.
    for (const at of [0n, 1n, 39n, 40n, 41n, 42n, 89n, 90n, 91n, 92n, 99n, 100n, 101n, 102n]) {
      const fresh = () => {
        const f = setup();
        const { hash } = file(f.sequencer, f.venue, f.eur, f.gold, 40n);
        accept(f.sequencer, f.eur, hash, 90n);
        advanceWitnessedIndex(f.venue, at);
        return { ...f, hash };
      };
      const a = fresh();
      const released = tryMove(() => releaseSet(a.sequencer, a.eur, a.gold, a.hash));
      const b = fresh();
      const withdrew = tryMove(() => withdrawSet(b.sequencer, b.eur, b.gold, b.hash));
      const c = fresh();
      const reprepared = tryMove(() => {
        withdrawLeg(c.sequencer, c.gold, c.hash);
        relock(c.sequencer, c.eur, c.gold, c.hash, at + 10n);
        releaseSet(c.sequencer, c.eur, c.gold, c.hash);
      });
      expect([at, released, withdrew, reprepared]).toEqual([at, at <= 40n, at > 90n, at > 40n && at <= 90n]);
      // And whichever moved, the set moved whole.
      for (const [f, settled] of [[a, released], [c, reprepared]] as const) {
        if (!settled) continue;
        expect(f.sequencer.balance(f.eur, KEYS.backer)).toBe(40n);
        expect(f.sequencer.balance(f.gold, KEYS.backer)).toBe(80n);
        expect(f.sequencer.openDemands(f.eur)).toHaveLength(0);
      }
      if (withdrew) {
        expect(b.sequencer.balance(b.eur, KEYS.backer)).toBe(0n);
        expect(b.sequencer.availableBalance(b.gold, KEYS.alice)).toBe(200n);
        expect(b.sequencer.openDemands(b.eur)).toHaveLength(0);
      }
    }
  });

  it("the set's exit table: an exit at or before a leg's timeout only while an acceptance is live, else the holder waits out the timeout it signed", () => {
    // The one sentence the docs make (found reviewing the slice: the first draft
    // claimed "never stuck"). Leg timeout 40, demand deadline 100. With the
    // acceptance ending at 30 — or with none — the indices up to 40 have no
    // set-level exit: release needs a live answer, withdrawal a lapsed leg, and
    // re-prepare a withdrawn one. The bound is the timeout the holder signed.
    for (const [label, deadline] of [["acceptance to 30", 30n], ["no acceptance", undefined]] as const) {
      for (const at of [0n, 30n, 31n, 40n, 41n, 100n, 101n]) {
        const { venue, sequencer, eur, gold } = setup();
        const { hash } = file(sequencer, venue, eur, gold, 40n);
        if (deadline !== undefined) accept(sequencer, eur, hash, deadline);
        advanceWitnessedIndex(venue, at);
        const release = tryMove(() => releaseSet(sequencer, eur, gold, hash));
        const b = setup();
        const bh = file(b.sequencer, b.venue, b.eur, b.gold, 40n).hash;
        if (deadline !== undefined) accept(b.sequencer, b.eur, bh, deadline);
        advanceWitnessedIndex(b.venue, at);
        const withdraw = tryMove(() => withdrawSet(b.sequencer, b.eur, b.gold, bh));
        const c = setup();
        const ch = file(c.sequencer, c.venue, c.eur, c.gold, 40n).hash;
        if (deadline !== undefined) accept(c.sequencer, c.eur, ch, deadline);
        advanceWitnessedIndex(c.venue, at);
        const reprepare = tryMove(() => {
          withdrawLeg(c.sequencer, c.gold, ch);
          relock(c.sequencer, c.eur, c.gold, ch, at + 10n);
          releaseSet(c.sequencer, c.eur, c.gold, ch);
        });
        const live = deadline !== undefined && at <= deadline;
        expect([label, at, release, withdraw, reprepare]).toEqual([label, at, live && at <= 40n, at > 40n, false]);
      }
    }
  });

  it("re-prepare past the demand's own deadline is refused, and names the exit it leaves open", () => {
    // Nothing can settle a demand past its deadline — no acceptance can be live
    // again — so a leg re-prepared then could only shut the holder's withdrawal
    // until the timeout it signs (found reviewing the slice).
    const { venue, sequencer, eur, gold } = setup();
    const { hash } = file(sequencer, venue, eur, gold, 40n);
    advanceWitnessedIndex(venue, 41n);
    withdrawLeg(sequencer, gold, hash);
    advanceWitnessedIndex(venue, 101n);
    expect(() => relock(sequencer, eur, gold, hash, 400n)).toThrow(/own deadline has passed.*withdraw/);
    const head = { backing: eur, demandHash: hash, nonce: sequencer.nextNonce(KEYS.alice, eur) };
    sequencer.submitWithdrawal(head, ed25519.sign(encodeWithdrawal(head), SECRETS.alice));
    expect(sequencer.openDemands(eur)).toHaveLength(0);
  });

  it("re-prepare reads each leg against the set's terms exactly as filing did", () => {
    const { venue, sequencer, eur, gold } = setup();
    const { hash } = file(sequencer, venue, eur, gold, 40n);
    venue.advance(TIMEOUT + 1n);
    withdrawLeg(sequencer, gold, hash);
    const leg = (over: Partial<LockOp>, secret: Uint8Array = SECRETS.alice): LockOp => ({
      backing: gold,
      attemptId: hash,
      holder: KEYS.alice,
      beneficiary: KEYS.backer,
      quantity: 80n,
      timeout: 95n,
      decisionVenue: NO_DECISION_VENUE,
      parties: [KEYS.alice],
      nonce: sequencer.nextNonce(secret === SECRETS.alice ? KEYS.alice : KEYS.mallory, gold),
      ...over,
    });
    const submit = (op: LockOp, secret: Uint8Array = SECRETS.alice) =>
      sequencer.submitLeg(eur, hash, { op, signature: ed25519.sign(encodeLock(op), secret) });
    // A stranger's units are not the set's accompaniment, however many.
    expect(() => submit(leg({ holder: KEYS.mallory }, SECRETS.mallory), SECRETS.mallory)).toThrow(/holder/);
    // Not the quantity, not the beneficiary, not a venue, not a leg R(b) does not name.
    expect(() => submit(leg({ quantity: 79n }))).toThrow(/quantity/);
    expect(() => submit(leg({ beneficiary: KEYS.mallory }))).toThrow(/pay/);
    expect(() => submit(leg({ decisionVenue: venue.id }))).toThrow(/venue/);
    expect(() => submit(leg({ backing: eur }))).toThrow(/not a reliance leg/);
    expect(() => submit(leg({ attemptId: new Uint8Array(32).fill(9) }))).toThrow(/must name the demand/);
    // Not under a demand that does not stand.
    expect(() =>
      sequencer.submitLeg(eur, new Uint8Array(32).fill(9), { op: leg({}), signature: new Uint8Array(64) }),
    ).toThrow(/no demand stands/);
    // Nothing above reserved anything.
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(200n);
    // And the one that carries the terms is taken.
    submit(leg({}));
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(120n);
  });

  it("a standing leg is not re-prepared over: the slot is the lock that stands", () => {
    const { venue, sequencer, eur, gold } = setup();
    const { hash } = file(sequencer, venue, eur, gold, 40n);
    // Live or expired, a lock that stands holds its slot until it is withdrawn —
    // the law's rule, and the only one needed.
    expect(() => relock(sequencer, eur, gold, hash, 95n)).toThrow(/already has a lock/);
    venue.advance(TIMEOUT + 1n);
    expect(() => relock(sequencer, eur, gold, hash, 95n)).toThrow(/already has a lock/);
  });

  it("with two legs only the lapsed one is re-prepared, and the release still takes both", () => {
    const venue = new LocalVenue();
    const mk = (thing: string, reliance: { target: Uint8Array; count: bigint }[] = []) =>
      makeBacking({
        obligor: KEYS.backer,
        payout: { thing, quantumExponent: -2, perUnit: 100n },
        reliance: [...reliance].sort((a, b) => compareBytes(a.target, b.target)),
        evidence: { setting: "transparent", operator: KEYS.operator },
      });
    const gold = mk("GOLD");
    const silver = mk("SILVER");
    const eur = mk("EUR", [
      { target: gold.name, count: 2n },
      { target: silver.name, count: 1n },
    ]);
    const sequencer = new Sequencer(SECRETS.operator, venue);
    for (const backing of [gold, silver, eur]) {
      sequencer.register(backing, signBacking(SECRETS.backer, backing));
      const nonce = sequencer.nextNonce(KEYS.backer, backing);
      sequencer.submitIssue(
        { backing, recipient: KEYS.alice, quantity: 200n, nonce },
        ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 200n, nonce), SECRETS.backer),
      );
    }
    const demand: DemandOp = { backing: eur, holder: KEYS.alice, quantity: 40n, instant: 0n, deadline: 100n, nonce: 0n };
    const hash = demandHash(demand);
    const lockOn = (backing: Backing, quantity: bigint, timeout: bigint): LockOp => ({
      backing,
      attemptId: hash,
      holder: KEYS.alice,
      beneficiary: KEYS.backer,
      quantity,
      timeout,
      decisionVenue: NO_DECISION_VENUE,
      parties: [KEYS.alice],
      nonce: sequencer.nextNonce(KEYS.alice, backing),
    });
    const signed = (op: LockOp) => ({ op, signature: ed25519.sign(encodeLock(op), SECRETS.alice) });
    // A leg named twice is refused at filing, and nothing is consumed.
    expect(() =>
      sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice), [
        signed(lockOn(gold, 80n, 40n)),
        signed(lockOn(gold, 80n, 40n)),
      ]),
    ).toThrow(/named twice/);
    // GOLD lapses at 40, SILVER runs to 200.
    sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice), [
      signed(lockOn(gold, 80n, 40n)),
      signed(lockOn(silver, 40n, 200n)),
    ]);
    accept(sequencer, eur, hash, 90n);
    venue.advance(41n);
    withdrawLeg(sequencer, gold, hash);
    sequencer.submitLeg(eur, hash, signed(lockOn(gold, 80n, 95n)));
    const rel = (backing: Backing) => {
      const op = { backing, demandHash: hash, nonce: sequencer.nextNonce(KEYS.alice, backing) };
      return { op, signature: ed25519.sign(encodeRelease(op), SECRETS.alice) };
    };
    const head = rel(eur);
    sequencer.submitRelease(head.op, head.signature, [rel(gold), rel(silver)]);
    expect(sequencer.balance(gold, KEYS.backer)).toBe(80n);
    expect(sequencer.balance(silver, KEYS.backer)).toBe(40n);
    expect(sequencer.balance(eur, KEYS.backer)).toBe(40n);
  });

  it("a repeated re-prepare is answered with the prior receipt (invariant 26)", () => {
    const { venue, sequencer, eur, gold } = setup();
    const { hash } = file(sequencer, venue, eur, gold, 40n);
    venue.advance(TIMEOUT + 1n);
    withdrawLeg(sequencer, gold, hash);
    const lock: LockOp = {
      backing: gold,
      attemptId: hash,
      holder: KEYS.alice,
      beneficiary: KEYS.backer,
      quantity: 80n,
      timeout: 95n,
      decisionVenue: NO_DECISION_VENUE,
      parties: [KEYS.alice],
      nonce: sequencer.nextNonce(KEYS.alice, gold),
    };
    const leg = { op: lock, signature: ed25519.sign(encodeLock(lock), SECRETS.alice) };
    const first = sequencer.submitLeg(eur, hash, leg);
    const again = sequencer.submitLeg(eur, hash, leg);
    expect(again).toEqual(first);
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(120n);
  });

  it("the bare door stays shut while the set's door opens: one lock, two answers", () => {
    // The same lock, signed once: through submitLock it is a leg of nothing and
    // refused (slice 26); through submitLeg it is the standing demand's own leg
    // and taken. The door is the set, not the bytes.
    const { venue, sequencer, eur, gold } = setup();
    const { hash } = file(sequencer, venue, eur, gold, 40n);
    venue.advance(TIMEOUT + 1n);
    withdrawLeg(sequencer, gold, hash);
    const lock: LockOp = {
      backing: gold,
      attemptId: hash,
      holder: KEYS.alice,
      beneficiary: KEYS.backer,
      quantity: 80n,
      timeout: 95n,
      decisionVenue: NO_DECISION_VENUE,
      parties: [KEYS.alice],
      nonce: sequencer.nextNonce(KEYS.alice, gold),
    };
    const signature = ed25519.sign(encodeLock(lock), SECRETS.alice);
    expect(() => sequencer.submitLock(lock, signature)).toThrow(/bare lock/);
    const receipt = sequencer.submitLeg(eur, hash, { op: lock, signature });
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(120n);
    // Once co-signed, the same bytes are a repeat at every door, and answered as
    // one (invariant 26; found reviewing this slice): the bare door refuses a
    // fresh leg, never a receipt this operator already owes.
    expect(sequencer.submitLock(lock, signature)).toEqual(receipt);
  });
});

describe("§C3: a demand's window is open when it is set, on the gap path as at the door", () => {
  it("a demand published in a gap with a deadline not ahead of its witnessed index is not adopted, and the verifier agrees", () => {
    // The law's TIME rule (invariant-27.presentation), read at the venue's
    // STAMP and not at the index the operator returns: a demand stamped 30 with
    // deadline 35 is adopted at 40, one with deadline 30 is not. `adopt` and the
    // verifier's fold apply one applyEntry at one clock, so a release chain
    // behind the shut demand settles nothing for either reader, and the open
    // one settles for both.
    const f = gapGold();
    f.sequencer.commit();
    f.venue.advance(30n);
    const publish = (deadline: bigint, nonce: bigint) => {
      const op: DemandOp = { backing: f.gold, holder: KEYS.alice, quantity: 40n, instant: f.venue.witnessedIndex(), deadline, nonce };
      f.venue.publishOp(f.gold.name, {
        kind: "demand",
        holder: op.holder,
        quantity: op.quantity,
        instant: op.instant,
        deadline: op.deadline,
        nonce: op.nonce,
        signature: ed25519.sign(encodeDemand(op), SECRETS.alice),
      });
      return { hash: demandHash(op), instant: op.instant };
    };
    const shut = publish(30n, 0n); // deadline AT the stamp: shut
    const open = publish(35n, 0n); // same nonce, window open at the stamp, shut by the time the operator returns
    f.venue.advance(1n);
    // The backer answers, and the holder releases, both in the gap — once for each.
    for (const d of [shut, open]) {
      const answer = { backing: f.gold, demandHash: d.hash, instant: d.instant, deadline: 34n, nonce: f.sequencer.nextNonce(KEYS.backer, f.gold) };
      f.venue.publishOp(f.gold.name, {
        kind: "acceptance",
        demandHash: d.hash,
        instant: answer.instant,
        deadline: answer.deadline,
        nonce: answer.nonce,
        signature: ed25519.sign(encodeAcceptance(answer), SECRETS.backer),
      });
      const settle = { backing: f.gold, demandHash: d.hash, nonce: 1n };
      f.venue.publishOp(f.gold.name, {
        kind: "release",
        demandHash: d.hash,
        nonce: settle.nonce,
        signature: ed25519.sign(encodeRelease(settle), SECRETS.alice),
      });
    }
    const served = { snapshots: f.sequencer.snapshot(), commitment: f.venue.latestFor(KEYS.operator)! };
    // The verifier: one redemption, the open demand's.
    const redemptions = snapshotRedemptions(f.venue, f.gold, served);
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0]?.demandHash).toEqual(open.hash);
    // The operator, returning at 40: the same, at the stamp the publications carried.
    advanceWitnessedIndex(f.venue, 40n);
    f.sequencer.commit();
    expect(f.sequencer.openDemands(f.gold)).toHaveLength(0);
    expect(f.sequencer.balance(f.gold, KEYS.backer)).toBe(40n);
    expect(f.sequencer.balance(f.gold, KEYS.alice)).toBe(160n);
  });
});

describe("§C3: re-prepare reads the record first, and the window's last index", () => {
  it("a head the venue ended while the operator was dark is not a demand to re-prepare for", () => {
    // Found reviewing the slice, twice: submitLeg read the demand record without
    // first adopting the demanded backing, which never appears among its own
    // items — every other door has the demanded backing as an item and so asks
    // `ready` of it. A head withdrawal published in the gap ended the demand at
    // the venue; the leg backing had been adopted (the holder's own leg
    // withdrawal went through it), the demanded one had not, and a lock was
    // co-signed for a set the record had already ended.
    const { venue, sequencer, eur, gold } = gapPair();
    const { hash } = file(sequencer, venue, eur, gold, 40n);
    accept(sequencer, eur, hash, 50n);
    sequencer.commit();
    advanceWitnessedIndex(venue, 60n);
    // The acceptance expired at 50: the head withdrawal is lawful, and a gap leg.
    const head = { backing: eur, demandHash: hash, nonce: 1n };
    venue.publishOp(eur.name, {
      kind: "withdrawal",
      demandHash: hash,
      nonce: head.nonce,
      signature: ed25519.sign(encodeWithdrawal(head), SECRETS.alice),
    });
    venue.advance(1n);
    // The operator returns. The leg's own withdrawal adopts GOLD — and only GOLD.
    withdrawLeg(sequencer, gold, hash);
    expect(() => relock(sequencer, eur, gold, hash, 95n)).toThrow(/no demand stands/);
    expect(sequencer.openDemands(eur)).toHaveLength(0);
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(200n);
  });

  it("a slot a stranger took under a predicted hash refuses the filing with the remedy, for a leg as for the payout", () => {
    // Slice 26 named the remedy for the paying slot; the leg slot's twin refused
    // with the law's bare "already has a lock" (found reviewing this slice). One
    // loop over every slot the set takes.
    const { venue, sequencer, eur, gold } = setup();
    const demand: DemandOp = { backing: eur, holder: KEYS.alice, quantity: 40n, instant: 0n, deadline: 100n, nonce: 0n };
    const hash = demandHash(demand);
    const squat: LockOp = {
      backing: gold,
      attemptId: hash,
      holder: KEYS.alice,
      beneficiary: KEYS.bob,
      quantity: 1n,
      timeout: 500n,
      decisionVenue: venue.id,
      parties: [KEYS.alice],
      nonce: sequencer.nextNonce(KEYS.alice, gold),
    };
    sequencer.submitLock(squat, ed25519.sign(encodeLock(squat), SECRETS.alice));
    const lock: LockOp = { ...squat, beneficiary: KEYS.backer, quantity: 80n, timeout: 40n, decisionVenue: NO_DECISION_VENUE, nonce: sequencer.nextNonce(KEYS.alice, gold) };
    expect(() =>
      sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice), [
        { op: lock, signature: ed25519.sign(encodeLock(lock), SECRETS.alice) },
      ]),
    ).toThrow(/re-file with a fresh nonce/);
    expect(sequencer.openDemands(eur)).toHaveLength(0);
  });

  it("at the window's last index the law's strictly-ahead timeout leaves no timeout inside it", () => {
    // Recorded, not patched: a backer answering at the holder's own deadline (100,
    // acceptance deadline 100) leaves the holder re-preparing with a timeout of
    // at least 101, so if the release does not land at 100 the exit is at 102 —
    // the acceptance rule alone already puts it at 101. The one cost outside the
    // holder's window, one index wide, and declinable: the holder who does not
    // re-prepare withdraws the head at 101.
    const { venue, sequencer, eur, gold } = setup();
    const { hash } = file(sequencer, venue, eur, gold, 40n);
    advanceWitnessedIndex(venue, 100n);
    accept(sequencer, eur, hash, 100n);
    withdrawLeg(sequencer, gold, hash);
    expect(() => relock(sequencer, eur, gold, hash, 100n)).toThrow(/timeout/);
    relock(sequencer, eur, gold, hash, 101n);
    venue.advance(1n);
    expect(() => releaseSet(sequencer, eur, gold, hash)).toThrow(/acceptance/);
    expect(() => withdrawSet(sequencer, eur, gold, hash)).toThrow(/not expired/);
    venue.advance(1n);
    withdrawSet(sequencer, eur, gold, hash);
    expect(sequencer.openDemands(eur)).toHaveLength(0);
  });
});
