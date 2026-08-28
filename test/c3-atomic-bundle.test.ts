import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { encodeIssuanceMessage, encodeTransferMessage } from "../src/messages.js";
import {
  attemptIdOf,
  encodeCommit,
  encodeLock,
  encodeRelease,
  encodeWithdrawal,
  NO_ATTEMPT_SALT,
  signCommit,
  type LockOp,
} from "../src/presentation.js";
import { compareBytes } from "../src/bytes.js";
import { Sequencer, SequencerError } from "../src/sequencer.js";
import { LocalVenue, UNNAMED_VENUE, VenueError } from "../src/venue.js";
import { committedInTime, witnessedCommitFor } from "../src/recovery.js";
import { replayLog, TransparentLedger } from "../src/ledger.js";
import { advanceWitnessedIndex, KEYS, SECRETS } from "./support.js";

// §C3's prepare-decide-commit, generalised to any multi-sequencer transfer.
//
// §C2 poses it and gives two answers: "Extend §C3's prepare-decide-commit to any
// multi-sequencer transfer, at a round trip per payment. Or let payees accept
// partial-and-retry and price it, as card networks do."
//
// **Both are built, and which one is used is the parties' choice per trade.**
// The cheap one is what already existed: independent transfers, each final when
// its own sequencer co-signs, with the receipt as the payer's proof and
// isOverdue as the payee's read on how long finality will take. That covers
// every trade where the two sides have recourse — a grocer will refund, or take
// the rest by other means.
//
// This file is the other branch, for the trade where nobody will make anyone
// whole: **the bundle moves entire or not at all.**
//
// The shape, and why each piece is what it is:
//
//   - **Prepare.** The holder locks at each sequencer. A lock is a reservation,
//     not a transfer, and that is the whole point: invariant 8 makes a transfer
//     irreversible, so handing units over before the outcome is known would
//     destroy §11's "a refusal burns nothing" — the branch §15 prices a holding
//     on. A lock can be taken back; a transfer cannot.
//   - **Commit.** ONE object, signed by the holder over the attempt id, published
//     at a decision venue. §C3: "effective on witnessing rather than delivery, so
//     every sequencer evaluates one predicate against the same object." Delivery
//     is a fact about a message and differs per recipient; witnessing is a fact
//     about the record and is the same for everyone. That is what stops half the
//     bundle committing while the other half aborts.
//   - **No sequencer reads another's backing.** It matches one published object
//     against its own lock. That is why the commit names an attempt rather than
//     a set: knowing who else is in the bundle is the holder's business.
//   - **Abort.** Past the lock's timeout the commit can no longer settle it, and
//     the holder frees it alone.

const TIMEOUT = 50n;

/** Two backings, two operators, one venue they both publish at. */
function setup() {
  const venue = new LocalVenue();
  const mk = (thing: string, operator: Uint8Array) =>
    makeBacking({
      obligor: KEYS.backer,
      payout: { thing, quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: {
        setting: "transparent",
        operator,
        witnessing: { venue: venue.id, interval: 5n },
      },
    });
  const eur = mk("EUR", KEYS.operator);
  const gold = mk("GOLD", KEYS.carol);
  const one = new Sequencer(SECRETS.operator, venue);
  const two = new Sequencer(SECRETS.carol, venue);
  one.register(eur, signBacking(SECRETS.backer, eur));
  two.register(gold, signBacking(SECRETS.backer, gold));
  for (const [sequencer, backing] of [
    [one, eur],
    [two, gold],
  ] as const) {
    // Mallory holds units of her own, so a test about two holders reusing one
    // attempt id is about the id rather than about an empty balance.
    for (const holder of [KEYS.alice, KEYS.mallory]) {
      const nonce = sequencer.nextNonce(KEYS.backer, backing);
      sequencer.submitIssue(
        { backing, recipient: holder, quantity: 200n, nonce },
        ed25519.sign(encodeIssuanceMessage(backing.name, holder, 200n, nonce), SECRETS.backer),
      );
    }
  }
  return { venue, one, two, eur, gold };
}

// An attempt id is its terms' hash now, so a fixture picks a SALT and derives.
// Every LocalVenue here is the unnamed one, and every bundle lock in this file
// is Alice's alone at TIMEOUT, so the default id is a constant like before.
const ATTEMPT_SALT = new Uint8Array(32).fill(0xa7);
const ATTEMPT = attemptIdOf(ATTEMPT_SALT, UNNAMED_VENUE, TIMEOUT, [KEYS.alice]);

function lockFor(
  sequencer: Sequencer,
  backing: Backing,
  venue: LocalVenue,
  quantity: bigint,
  salt = ATTEMPT_SALT,
  timeout = TIMEOUT,
): LockOp {
  return {
    backing,
    // Derived, never supplied: the id IS these terms, so a lock cannot carry a
    // timeout its id does not name.
    attemptId: attemptIdOf(salt, venue.id, timeout, [KEYS.alice]),
    salt,
    holder: KEYS.alice,
    beneficiary: KEYS.bob,
    quantity,
    timeout,
    decisionVenue: venue.id,
    parties: [KEYS.alice],
    nonce: sequencer.nextNonce(KEYS.alice, backing),
  };
}

/** Alice reserves both halves of the bundle for Bob. */
function prepare(venue: LocalVenue, one: Sequencer, two: Sequencer, eur: Backing, gold: Backing) {
  const eurLock = lockFor(one, eur, venue, 40n);
  const goldLock = lockFor(two, gold, venue, 90n);
  one.submitLock(eurLock, ed25519.sign(encodeLock(eurLock), SECRETS.alice));
  two.submitLock(goldLock, ed25519.sign(encodeLock(goldLock), SECRETS.alice));
  return { eurLock, goldLock };
}

/** The holder frees its own reservation under `attempt` at that sequencer. */
function withdrawLock(sequencer: Sequencer, backing: Backing, attempt: Uint8Array) {
  const op = { backing, demandHash: attempt, holder: KEYS.alice, nonce: sequencer.nextNonce(KEYS.alice, backing) };
  return sequencer.submitWithdrawal(op, ed25519.sign(encodeWithdrawal(op), SECRETS.alice));
}

describe("§C3: prepare reserves without moving", () => {
  it("locks at each sequencer, and neither has moved anything", () => {
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    expect(one.balance(eur, KEYS.alice)).toBe(200n);
    expect(two.balance(gold, KEYS.alice)).toBe(200n);
    expect(one.availableBalance(eur, KEYS.alice)).toBe(160n);
    expect(two.availableBalance(gold, KEYS.alice)).toBe(110n);
    expect(one.balance(eur, KEYS.bob)).toBe(0n);
  });

  it("a sequencer refuses to prepare against a venue it does not watch", () => {
    // §C3: "A sequencer unwilling to watch it refuses to prepare, which is an
    // abort rather than a fork." Refusing is the safe answer — a fork would be
    // reading the timeout on a clock nobody else reads.
    const { venue, one, eur } = setup();
    const elsewhere = new LocalVenue(new Uint8Array(32).fill(9));
    const lock = lockFor(one, eur, elsewhere, 40n);
    expect(() => one.submitLock(lock, ed25519.sign(encodeLock(lock), SECRETS.alice))).toThrow(
      SequencerError,
    );
  });
});

describe("§C3: one witnessed object commits the whole bundle", () => {
  it("each sequencer settles its own half against the same object", () => {
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);

    // ONE signature, published once. Neither sequencer hears from the other.
    venue.advance(3n);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));

    one.settle(eur, ATTEMPT);
    two.settle(gold, ATTEMPT);

    expect(one.balance(eur, KEYS.bob)).toBe(40n);
    expect(two.balance(gold, KEYS.bob)).toBe(90n);
    expect(one.balance(eur, KEYS.alice)).toBe(160n);
    expect(two.balance(gold, KEYS.alice)).toBe(110n);
  });

  it("and the object is the same bytes for every backing in the bundle", () => {
    // Deliberately not naming a backing: the same signed object has to be valid
    // in every log in the set, which is what makes it one object rather than n.
    const commit = signCommit(SECRETS.alice, ATTEMPT);
    expect(encodeCommit(commit)).toEqual(encodeCommit(signCommit(SECRETS.alice, ATTEMPT)));
    // Attempt, count, then each signer with its signature: one party here, and
    // 96 bytes more for each further party to the exchange (slice 25).
    expect(encodeCommit(commit)).toHaveLength(32 + 1 + 32 + 64);
  });

  it("refuses to settle before the commit is witnessed", () => {
    // "Publication is not optional, since a release nobody witnessed did not
    // happen." A commit held privately settles nothing.
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    expect(() => one.settle(eur, ATTEMPT)).toThrow(SequencerError);
    expect(one.balance(eur, KEYS.bob)).toBe(0n);
  });

  it("refuses a commit signed by anyone but the holder who locked", () => {
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    venue.advance(3n);
    venue.publishCommit(signCommit(SECRETS.mallory, ATTEMPT));
    expect(() => one.settle(eur, ATTEMPT)).toThrow();
    expect(one.balance(eur, KEYS.bob)).toBe(0n);
  });

  it("refuses to settle a commit witnessed past the timeout", () => {
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    venue.advance(TIMEOUT + 1n);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    expect(() => one.settle(eur, ATTEMPT)).toThrow();
    expect(one.balance(eur, KEYS.bob)).toBe(0n);
  });

  it("the earliest witnessing is the one that counts", () => {
    // Published twice, once in time and once late: the attempt committed when
    // the record first showed it, and a later copy cannot un-commit it.
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    venue.advance(3n);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    venue.advance(TIMEOUT + 10n);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    one.settle(eur, ATTEMPT);
    expect(one.balance(eur, KEYS.bob)).toBe(40n);
  });
});

describe("§C3: abort, and what each side can do alone", () => {
  it("past the timeout the holder frees its own reservation", () => {
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    venue.advance(TIMEOUT + 1n);
    withdrawLock(one, eur, ATTEMPT);
    expect(one.availableBalance(eur, KEYS.alice)).toBe(200n);
    expect(one.balance(eur, KEYS.bob)).toBe(0n);
  });

  it("and a freed half cannot be settled afterwards", () => {
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    venue.advance(TIMEOUT + 1n);
    withdrawLock(one, eur, ATTEMPT);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    expect(() => one.settle(eur, ATTEMPT)).toThrow();
  });

  it("the reserved units cannot be spent while the attempt stands", () => {
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    const nonce = one.nextNonce(KEYS.alice, eur);
    expect(() =>
      one.submitTransfer(
        { backing: eur, from: KEYS.alice, to: KEYS.carol, quantity: 170n, nonce },
        ed25519.sign(
          encodeTransferMessage(eur.name, KEYS.alice, KEYS.carol, 170n, nonce),
          SECRETS.alice,
        ),
      ),
    ).toThrow(/insufficient/);
  });

  it("but everything outside the bundle keeps moving", () => {
    // The cheap path is untouched by any of this: a transfer of units no lock
    // reaches is one sequencer co-signing, as it always was.
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    const nonce = one.nextNonce(KEYS.alice, eur);
    one.submitTransfer(
      { backing: eur, from: KEYS.alice, to: KEYS.carol, quantity: 160n, nonce },
      ed25519.sign(
        encodeTransferMessage(eur.name, KEYS.alice, KEYS.carol, 160n, nonce),
        SECRETS.alice,
      ),
    );
    expect(one.balance(eur, KEYS.carol)).toBe(160n);
  });
});

describe("§C3: half a bundle is still not a bundle", () => {
  it("one half committing does not move the other", () => {
    // The failure the whole mechanism exists to prevent, from the other side:
    // settling at one sequencer tells the other nothing, so nothing there moves
    // until it reads the same object for itself.
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    venue.advance(3n);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    one.settle(eur, ATTEMPT);
    expect(one.balance(eur, KEYS.bob)).toBe(40n);
    expect(two.balance(gold, KEYS.bob)).toBe(0n);
    // And the second half is still there to be settled, on the same object.
    two.settle(gold, ATTEMPT);
    expect(two.balance(gold, KEYS.bob)).toBe(90n);
  });

  it("settling twice is idempotent, not a second payment", () => {
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    venue.advance(3n);
    const object = signCommit(SECRETS.alice, ATTEMPT);
    venue.publishCommit(object);
    const first = one.settle(eur, ATTEMPT);
    // The repeat names the object it is asking about: this door takes an attempt
    // but the act is an object, and the receipt is the object's.
    const again = one.settle(eur, ATTEMPT, object);
    expect(again.opHash).toEqual(first.opHash);
    expect(one.balance(eur, KEYS.bob)).toBe(40n);
  });

  it("repeating an accepted lock after its commit is witnessed returns the prior receipt", () => {
    // Invariant 26 reaches the gate that refuses a lock under a committed
    // attempt: a lock this operator already co-signed is answered as every
    // repeat is, whatever the record shows since — partition recovery simply
    // repeats the request. Found regression-reviewing the gate, which sat
    // before the idempotency lookup.
    const { venue, one, eur } = setup();
    const lock = lockFor(one, eur, venue, 40n);
    const signature = ed25519.sign(encodeLock(lock), SECRETS.alice);
    const first = one.submitLock(lock, signature);
    venue.advance(2n);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    expect(one.submitLock(lock, signature)).toEqual(first);
    one.settle(eur, ATTEMPT);
    expect(one.submitLock(lock, signature)).toEqual(first);
  });
});

describe("§C3: what an attempt id is and is not", () => {
  it("a stranger's attempt is a different id, and cannot become yours", () => {
    // This once read "two holders may reuse one id without touching each other's
    // half" — true, and weaker than what the id being its terms' hash now gives.
    // A stranger who wants to stand under YOUR id must carry your venue, your
    // timeout and your party set; carrying anything else is a different attempt,
    // and carrying yours leaves them refused by "names its own holder among its
    // parties" unless you named them. Reuse is bounded to the exchange its
    // parties agreed, which is what §C1's "all sign" always meant.
    const { venue, one, two, eur, gold } = setup();
    const mine = lockFor(one, eur, venue, 40n);
    one.submitLock(mine, ed25519.sign(encodeLock(mine), SECRETS.alice));
    const theirs: LockOp = {
      ...lockFor(two, gold, venue, 90n),
      attemptId: attemptIdOf(ATTEMPT_SALT, venue.id, TIMEOUT, [KEYS.mallory]),
      holder: KEYS.mallory,
      parties: [KEYS.mallory],
      nonce: two.nextNonce(KEYS.mallory, gold),
    };
    two.submitLock(theirs, ed25519.sign(encodeLock(theirs), SECRETS.mallory));
    // Her own party set makes it her own attempt, whatever salt she copied.
    expect(compareBytes(theirs.attemptId, ATTEMPT)).not.toBe(0);
    // And she cannot enter Alice's: those terms name only Alice, so a lock under
    // that id is refused for the holder it does not name.
    const intruder: LockOp = {
      ...lockFor(two, gold, venue, 1n),
      holder: KEYS.mallory,
      nonce: two.nextNonce(KEYS.mallory, gold),
    };
    expect(() =>
      two.submitLock(intruder, ed25519.sign(encodeLock(intruder), SECRETS.mallory)),
    ).toThrow(/names its own holder among its parties/);

    venue.advance(2n);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    one.settle(eur, ATTEMPT);
    expect(one.balance(eur, KEYS.bob)).toBe(40n);
    // Alice's object names an attempt Mallory's lock was never under.
    expect(() => two.settle(gold, ATTEMPT)).toThrow(SequencerError);
    expect(two.balance(gold, KEYS.bob)).toBe(0n);
  });

  it("noise published first under the same id does not win", () => {
    // Earliest VALID, not earliest published. Anyone may publish anything under
    // any attempt id, and a stranger's copy landing first must not become the
    // object this sequencer reads its own timeout against.
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    venue.publishCommit(signCommit(SECRETS.mallory, ATTEMPT));
    venue.advance(2n);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    one.settle(eur, ATTEMPT);
    expect(one.balance(eur, KEYS.bob)).toBe(40n);
  });

  it("a lock under an attempt the venue already shows committed is refused", () => {
    // 24b let a commit witnessed before the lock settle it, as "the holder
    // choosing the order of their own two signatures". Retired in 24c's review:
    // a lock under a committed attempt would settle on a commit adjudicated for
    // an earlier lock — answered by that lock's receipt, so never applied — and
    // could never be withdrawn, since the record shows it committed in time. An
    // attempt the record shows committed is not one a lock can still reserve for;
    // the holder picks a fresh id. Both doors, the same refusal.
    const { venue, one, two, eur, gold } = setup();
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    venue.advance(5n);
    const early = lockFor(one, eur, venue, 40n);
    expect(() => one.submitLock(early, ed25519.sign(encodeLock(early), SECRETS.alice))).toThrow(
      /already committed/,
    );
    expect(two.balance(gold, KEYS.bob)).toBe(0n);
  });

  it("and a relock under a settled attempt is refused by the same rule", () => {
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    venue.advance(3n);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    one.settle(eur, ATTEMPT);
    // The same terms, so genuinely the same attempt: a different timeout would
    // be a different id and so a different attempt entirely.
    const again = lockFor(one, eur, venue, 10n);
    expect(() => one.submitLock(again, ed25519.sign(encodeLock(again), SECRETS.alice))).toThrow(
      /already committed/,
    );
  });
});

describe("§C3: a half the record committed cannot be taken back", () => {
  it("a withdrawal before the timeout is refused, so one object settles at every sequencer", () => {
    // Found reviewing 24b. With withdrawal open at any index, Alice could let
    // O2 settle against the witnessed commit, then free her EUR lock at O1 one
    // message ahead of Bob's settle — one witnessed object, two verdicts, and a
    // log that replays as lawful. "Effective on witnessing" has to mean the
    // holder's own lock is past taking back once a commit can still reach it.
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    venue.advance(10n);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    two.settle(gold, ATTEMPT);
    venue.advance(1n);
    expect(() => withdrawLock(one, eur, ATTEMPT)).toThrow(/committed in time/);
    one.settle(eur, ATTEMPT);
    expect(one.balance(eur, KEYS.bob)).toBe(40n);
    expect(two.balance(gold, KEYS.bob)).toBe(90n);
  });

  it("exactly one exit is open at every index, for a lock as for a demand", () => {
    // invariant-27 pins this for a demand on the acceptance; a lock has the
    // same shape on its timeout. Commit and withdrawal are complements: at or
    // before the timeout the commit settles and the withdrawal is refused, one
    // past it the reverse. Never both open, never neither — and each refusal
    // is checked to be THE refusal, not any throw. One world, two fresh locks
    // per probed index, all reserved at index 0: what is under test is the
    // exits, not the fixture.
    const { venue, one, eur } = setup();
    const probes = [TIMEOUT - 1n, TIMEOUT, TIMEOUT + 1n];
    // Distinct SALTS now, since a distinct id is what a distinct salt buys: the
    // terms are identical across all six locks, so only the salt separates them.
    const salts = probes.map((_, i) => ({
      settle: new Uint8Array(32).fill(0x10 + i),
      walk: new Uint8Array(32).fill(0x20 + i),
    }));
    const idOf = (salt: Uint8Array) => attemptIdOf(salt, venue.id, TIMEOUT, [KEYS.alice]);
    for (const pair of salts) {
      for (const salt of [pair.settle, pair.walk]) {
        const lock = lockFor(one, eur, venue, 10n, salt);
        one.submitLock(lock, ed25519.sign(encodeLock(lock), SECRETS.alice));
      }
    }
    probes.forEach((at, i) => {
      const pair = salts[i] as { settle: Uint8Array; walk: Uint8Array };
      advanceWitnessedIndex(venue, at);
      venue.publishCommit(signCommit(SECRETS.alice, idOf(pair.settle)));
      let committed: string | true = true;
      try {
        one.settle(eur, idOf(pair.settle));
      } catch (e) {
        committed = (e as Error).message;
      }
      let withdrew: string | true = true;
      try {
        withdrawLock(one, eur, idOf(pair.walk));
      } catch (e) {
        withdrew = (e as Error).message;
      }
      expect({ at, committed, withdrew }).toEqual({
        at,
        committed: at <= TIMEOUT ? true : expect.stringMatching(/past the lock timeout/),
        withdrew: at > TIMEOUT ? true : expect.stringMatching(/expired/),
      });
    });
  });

  it("a commit witnessed in time is not undone by a withdrawal past the timeout", () => {
    // The other side of the same hole, found reviewing this slice: the law
    // accepts a withdrawal past the timeout, and a commit witnessed in time
    // settles at any later index — so with the law alone both exits stood
    // open at T+1 and execution order decided. The sequencer reads the record
    // before it co-signs a withdrawal: the holder's claim that nothing
    // committed is checked, not taken.
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    advanceWitnessedIndex(venue, TIMEOUT);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    two.settle(gold, ATTEMPT);
    venue.advance(1n);
    expect(() => withdrawLock(one, eur, ATTEMPT)).toThrow(/committed in time/);
    one.settle(eur, ATTEMPT);
    expect(one.balance(eur, KEYS.bob)).toBe(40n);
    expect(two.balance(gold, KEYS.bob)).toBe(90n);
  });
});

describe("§C3: settle names what is missing", () => {
  // "No commit is witnessed" and "no lock is held here" are two answers, and
  // merging them is the shape this codebase keeps removing: a caller told the
  // commit is missing goes looking at the venue for an object that is there.
  it("no lock held here", () => {
    const { one, eur } = setup();
    expect(() => one.settle(eur, ATTEMPT)).toThrow(/no lock/);
  });

  it("no commit witnessed", () => {
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    expect(() => one.settle(eur, ATTEMPT)).toThrow(/witnessed/);
  });
});

describe("§C3: an attempt id names one attempt on one backing, for the locks a commit can reach", () => {
  // Found by the 2026-08-22 audit. A commit binds its attempt id and nothing
  // else, so a signed object WITHHELD from one attempt converted a later lock
  // under the same id and the same parties: A and B lock under X, both sign, A
  // keeps the object; both withdraw past the timeout; B re-locks under X (24c
  // forbade only an id the VENUE showed committed); A publishes, and B's new
  // lock settles against B's consent to the old attempt. The log is what says an
  // id is spent: once a venue-naming lock under it has settled or withdrawn on
  // a backing, no other stands there, and a retry names a fresh id.
  it("a withheld commit from an aborted attempt converts nothing later: the id is spent on that backing", () => {
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    const withheld = signCommit(SECRETS.alice, ATTEMPT); // signed, never published
    advanceWitnessedIndex(venue, TIMEOUT + 1n);
    withdrawLock(one, eur, ATTEMPT);
    withdrawLock(two, gold, ATTEMPT);
    // The retry under the same id is refused on both backings — and now by the
    // timeout inside the id itself: an attempt whose timeout has passed cannot be
    // locked under again at any index, because its id names that timeout and the
    // law refuses a lock whose timeout is not ahead of the clock. The `retired`
    // set answers the same question one index earlier; this is the id doing it.
    const again = lockFor(two, gold, venue, 90n);
    expect(() => two.submitLock(again, ed25519.sign(encodeLock(again), SECRETS.alice))).toThrow(
      /already used that attempt id on this backing|timeout is not ahead/,
    );
    const againEur = lockFor(one, eur, venue, 40n);
    expect(() => one.submitLock(againEur, ed25519.sign(encodeLock(againEur), SECRETS.alice))).toThrow(
      /already used that attempt id on this backing|timeout is not ahead/,
    );
    // So the withheld object, published now, reaches nothing on either.
    venue.publishCommit(withheld);
    expect(() => two.settle(gold, ATTEMPT)).toThrow(/no lock for that attempt/);
    expect(() => one.settle(eur, ATTEMPT)).toThrow(/no lock for that attempt/);
    expect(two.balance(gold, KEYS.bob)).toBe(0n);
    expect(two.availableBalance(gold, KEYS.alice)).toBe(200n);
    expect(one.availableBalance(eur, KEYS.alice)).toBe(200n);
  });

  it("a fresh id is the retry, and a settled id is spent too", () => {
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    one.settle(eur, ATTEMPT);
    two.settle(gold, ATTEMPT);
    const relock = lockFor(two, gold, venue, 10n);
    // At the sequencer the gate answers first (24c: the venue shows the attempt
    // committed); in the law the retired id answers — pinned through the replay,
    // since the gate stands in front of the door.
    expect(() => two.submitLock(relock, ed25519.sign(encodeLock(relock), SECRETS.alice))).toThrow(
      /already committed at this venue/,
    );
    const entry = {
      kind: "lock" as const,
      attemptId: relock.attemptId,
      holder: relock.holder,
      beneficiary: relock.beneficiary,
      quantity: relock.quantity,
      timeout: relock.timeout,
      decisionVenue: relock.decisionVenue,
      parties: relock.parties,
      nonce: relock.nonce,
      salt: relock.salt ?? NO_ATTEMPT_SALT,
      signature: ed25519.sign(encodeLock(relock), SECRETS.alice),
      position: two.opLog(gold).length,
    };
    expect(replayLog(gold, [...two.opLog(gold), entry])).toBeUndefined();
    const fresh = new Uint8Array(32).fill(0xb8);
    const next = lockFor(two, gold, venue, 10n, fresh, 300n);
    two.submitLock(next, ed25519.sign(encodeLock(next), SECRETS.alice));
    expect(two.availableBalance(gold, KEYS.alice)).toBe(100n);
  });

  it("the replay folds the same rule: a log that carries a second venue-naming lock under a spent id is not a history", () => {
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    advanceWitnessedIndex(venue, TIMEOUT + 1n);
    withdrawLock(two, gold, ATTEMPT);
    // Hand-built, because no door would co-sign it: the same attempt's terms, so
    // the same id, after that id has been spent on this backing.
    const again = lockFor(two, gold, venue, 90n);
    const entry = {
      kind: "lock" as const,
      attemptId: again.attemptId,
      holder: again.holder,
      beneficiary: again.beneficiary,
      quantity: again.quantity,
      timeout: again.timeout,
      decisionVenue: again.decisionVenue,
      parties: again.parties,
      nonce: again.nonce,
      salt: again.salt ?? NO_ATTEMPT_SALT,
      signature: ed25519.sign(encodeLock(again), SECRETS.alice),
      position: two.opLog(gold).length,
    };
    expect(replayLog(gold, [...two.opLog(gold), entry])).toBeUndefined();
  });
});

describe("§C3: the readers of a lock's venue never throw, and never read the wrong record", () => {
  it("a lock naming another decision venue is a refusal for this record, not 'no commit was witnessed'", () => {
    // Found by the 2026-08-22 audit: handed a venue the lock does not name, the
    // reader answered false — and a verifier folded a withdrawal the operator,
    // reading the right venue, refused.
    const { venue, one, two, eur, gold } = setup();
    prepare(venue, one, two, eur, gold);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    const lock = lockFor(two, gold, venue, 1n);
    const record = { ...lock, nonce: 0n };
    expect(committedInTime(venue, record)).toBe(true);
    expect(() => committedInTime(new LocalVenue(new Uint8Array(32).fill(0x55)), record)).toThrow(VenueError);
  });

  it("a malformed lock record is an answer, not a throw", () => {
    const { venue } = setup();
    for (const junk of [undefined, null, {}, { attemptId: 5 }, { attemptId: new Uint8Array(32), parties: "x", decisionVenue: 7 }]) {
      expect(committedInTime(venue, junk as never)).toBe(false);
      expect(witnessedCommitFor(venue, junk as never)).toBeUndefined();
    }
  });
});

describe("§C3: a venue-naming lock retires its id by every exit, the release included", () => {
  it("a one-party venue-naming lock converted by its party's release leaves no reusable id", () => {
    // Found reviewing the audit slice: the retire sat beside two of the three
    // exits, and a lock that left by its party's RELEASE (the ledger's own door)
    // left its id to a withheld object. It lives in settleLock now.
    const { venue, two, gold } = setup();
    const ledger = new TransparentLedger();
    ledger.register(gold, signBacking(SECRETS.backer, gold));
    ledger.issue({ backing: gold, recipient: KEYS.alice, quantity: 100n, nonce: 0n }, ed25519.sign(encodeIssuanceMessage(gold.name, KEYS.alice, 100n, 0n), SECRETS.backer));
    const lock = { ...lockFor(two, gold, venue, 40n, ATTEMPT_SALT, 500n), nonce: 0n };
    const attemptId = lock.attemptId; // its terms' hash, timeout 500 and all
    const entry = (op: LockOp, nonce: bigint) => ({ kind: "lock" as const, attemptId: op.attemptId, holder: op.holder, beneficiary: op.beneficiary, quantity: op.quantity, timeout: op.timeout, decisionVenue: op.decisionVenue, parties: op.parties, nonce, salt: op.salt ?? NO_ATTEMPT_SALT, signature: ed25519.sign(encodeLock({ ...op, nonce }), SECRETS.alice) });
    ledger.apply(gold, entry(lock, 0n), 0n);
    const rel = { backing: gold, demandHash: attemptId, holder: KEYS.alice, nonce: 1n };
    ledger.apply(gold, { kind: "release", demandHash: attemptId, holder: KEYS.alice, nonce: 1n, signature: ed25519.sign(encodeRelease(rel), SECRETS.alice) }, 0n);
    expect(ledger.balance(gold, KEYS.bob)).toBe(40n);
    expect(() => ledger.apply(gold, entry({ ...lock, quantity: 10n }, 2n), 0n)).toThrow(/already used that attempt id/);
    expect(replayLog(gold, [...ledger.opLog(gold), { ...entry({ ...lock, quantity: 10n }, 2n), position: ledger.opLog(gold).length }])).toBeUndefined();
  });
});
