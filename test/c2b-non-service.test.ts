import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { compareBytes } from "../src/bytes.js";
import { encodeIssuanceMessage, encodeTransferMessage } from "../src/messages.js";
import {
  attemptIdOf,
  countersignCommit,
  demandHash,
  encodeDemand,
  encodeLock,
  signCommit,
  type DemandOp,
  type LockOp,
  NO_ATTEMPT_SALT,
  NO_DECISION_VENUE,
} from "../src/presentation.js";
import { type PublishedOp } from "../src/oplog.js";
import { isNonServing, isSilent, unservedRequests } from "../src/recovery.js";
import { VenueError } from "../src/venue.js";
import { Sequencer } from "../src/sequencer.js";
import { LocalVenue } from "../src/venue.js";
import { KEYS, SECRETS } from "./support.js";

// §C2b's other grade, and the one that reaches the party the aggravated grade
// cannot: "The clause is measured on service rather than publication. A stalling
// backer-run sequencer publishes on time, and the stall shows only as a spent
// set that stops growing."
//
//   "**Non-service**: a signed transfer request, published where demands are,
//   left unserved past the declared duration and counted only while still
//   unserved... It fires in the aggregate, and E declares the aggregate: at
//   least m distinct requests, each unserved past the duration, standing within
//   a window W."
//
// The remedy is E's replacement rule, which slice 13 built — so this grade
// finally has somewhere to point. And it is the answer to the hole slice 11
// recorded: an operator that drops a backing from its commitments keeps
// publishing and reads as perfectly live, and this is the grade that counts what
// it stopped doing.

const NON_SERVICE = { duration: 10n, count: 2n, window: 100n };

function setup(nonService: typeof NON_SERVICE | undefined = NON_SERVICE) {
  const venue = new LocalVenue();
  const backing = makeBacking({
    obligor: KEYS.backer,
    payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
    reliance: [],
    evidence: {
      setting: "transparent",
      operator: KEYS.operator,
      silence: { noCommitmentDuration: 1000n, challengeWindow: 5n },
      ...(nonService === undefined ? {} : { nonService }),
    },
  });
  const sequencer = new Sequencer(SECRETS.operator, venue);
  sequencer.register(backing, signBacking(SECRETS.backer, backing));
  sequencer.submitIssue(
    { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
    ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
  );
  return { venue, sequencer, backing };
}

/** Alice's signed request to move `quantity` to Bob at her nonce `nonce`. */
function request(backing: Backing, quantity: bigint, nonce: bigint): Extract<PublishedOp, { kind: "transfer" }> {
  return {
    kind: "transfer",
    from: KEYS.alice,
    to: KEYS.bob,
    quantity,
    nonce,
    signature: ed25519.sign(
      encodeTransferMessage(backing.name, KEYS.alice, KEYS.bob, quantity, nonce),
      SECRETS.alice,
    ),
  };
}

/**
 * Alice's signed bare lock request at the venue: her own units, naming the
 * decision venue the operator watches — §C3's "a lock request left unserved is
 * §C2b's non-service object".
 */
function lockRequest(
  venue: LocalVenue,
  backing: Backing,
  quantity: bigint,
  nonce: bigint,
  over: Partial<LockOp> = {},
): Extract<PublishedOp, { kind: "lock" }> {
  // A venue-naming lock names its own holder among its parties (the lock-keying
  // slice), and its id is its terms' hash (this one): a request the law would
  // refuse for either reason is not non-service.
  const parties = [KEYS.alice, KEYS.bob].sort(compareBytes);
  const salt = new Uint8Array(32).fill(0x50 + Number(nonce));
  const base: LockOp = {
    backing,
    attemptId: attemptIdOf(salt, venue.id, 10_000n, parties),
    salt,
    holder: KEYS.alice,
    beneficiary: KEYS.bob,
    quantity,
    timeout: 10_000n,
    decisionVenue: venue.id,
    parties,
    nonce,
  };
  // An override of a term re-derives the id, so a fixture cannot accidentally
  // build a lock whose id does not name its own terms — only deliberately, by
  // overriding attemptId itself.
  const merged = { ...base, ...over };
  const op: LockOp = {
    ...merged,
    attemptId:
      over.attemptId ??
      (compareBytes(merged.decisionVenue, NO_DECISION_VENUE) === 0
        ? merged.attemptId
        : attemptIdOf(merged.salt ?? salt, merged.decisionVenue, merged.timeout, merged.parties)),
  };
  return {
    kind: "lock",
    attemptId: op.attemptId,
    holder: op.holder,
    beneficiary: op.beneficiary,
    quantity: op.quantity,
    timeout: op.timeout,
    decisionVenue: op.decisionVenue,
    parties: op.parties,
    nonce: op.nonce,
    salt: op.salt ?? NO_ATTEMPT_SALT,
    signature: ed25519.sign(encodeLock(op), SECRETS.alice),
  };
}

function servedBy(sequencer: Sequencer) {
  // Committed first, then snapshotted: the commit adopts before it publishes.
  const commitment = sequencer.commit();
  return { snapshots: sequencer.snapshot(), commitment };
}

describe("§C2b: non-service is counted on service, not on publication", () => {
  it("fires where m requests stand unserved past the duration", () => {
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    // The operator keeps publishing — it is not silent, and never will be.
    venue.publishOp(backing.name, request(backing, 10n, 0n));
    venue.publishOp(backing.name, request(backing, 20n, 1n));
    venue.advance(NON_SERVICE.duration + 1n);

    expect(isSilent(venue, backing)).toBe(false);
    expect(unservedRequests(venue, backing, served)).toHaveLength(2);
    expect(isNonServing(venue, backing, served)).toBe(true);
  });

  it("a junk lock publication at the venue does not erase the grade", () => {
    // Found by the 2026-08-22 audit: a lock record could not be decoded, so one
    // publication of one — by anyone, the operator being graded included — made
    // every read of the backing's record fail, and behind `answering` the grade
    // read false. The record must stay readable whatever is filed against it.
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    venue.publishOp(backing.name, request(backing, 10n, 0n));
    venue.publishOp(backing.name, request(backing, 20n, 1n));
    const junk = {
      backing,
      attemptId: new Uint8Array(32).fill(0x33),
      holder: KEYS.mallory,
      beneficiary: KEYS.mallory,
      quantity: 1n,
      timeout: 10_000n,
      decisionVenue: venue.id,
      parties: [KEYS.mallory],
      nonce: 0n,
    };
    venue.publishOp(backing.name, {
      kind: "lock",
      attemptId: junk.attemptId,
      holder: junk.holder,
      beneficiary: junk.beneficiary,
      quantity: junk.quantity,
      timeout: junk.timeout,
      decisionVenue: junk.decisionVenue,
      parties: junk.parties,
      nonce: junk.nonce,
      salt: NO_ATTEMPT_SALT,
      signature: new Uint8Array(64),
    });
    venue.advance(NON_SERVICE.duration + 1n);
    expect(venue.publishedOpsFor(backing.name)).toHaveLength(3);
    expect(unservedRequests(venue, backing, served)).toHaveLength(2);
    expect(isNonServing(venue, backing, served)).toBe(true);
  });

  it("does not fire before the duration has passed", () => {
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    venue.publishOp(backing.name, request(backing, 10n, 0n));
    venue.publishOp(backing.name, request(backing, 20n, 1n));
    venue.advance(NON_SERVICE.duration);
    expect(isNonServing(venue, backing, served)).toBe(false);
    venue.advance(1n);
    expect(isNonServing(venue, backing, served)).toBe(true);
  });

  it("does not fire below m, however long they stand", () => {
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    venue.publishOp(backing.name, request(backing, 10n, 0n));
    venue.advance(NON_SERVICE.window - 1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(1);
    expect(isNonServing(venue, backing, served)).toBe(false);
  });

  it("stops counting a request once the operator serves it", () => {
    // "counted only while still unserved". The operator takes one of the two
    // and commits it, and the grade falls back below m.
    const { venue, sequencer, backing } = setup();
    const first = request(backing, 10n, 0n);
    venue.publishOp(backing.name, first);
    venue.publishOp(backing.name, request(backing, 20n, 1n));
    venue.advance(NON_SERVICE.duration + 1n);
    expect(isNonServing(venue, backing, servedBy(sequencer))).toBe(true);

    sequencer.submitTransfer(
      { backing, from: KEYS.alice, to: KEYS.bob, quantity: 10n, nonce: 0n },
      first.signature,
    );
    venue.advance(1n); // one commitment per witnessed index (28b: eras end legibly)
    const after = servedBy(sequencer);
    expect(unservedRequests(venue, backing, after)).toHaveLength(1);
    expect(isNonServing(venue, backing, after)).toBe(false);
  });

  it("stops counting a request that has aged out of the window", () => {
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    venue.publishOp(backing.name, request(backing, 10n, 0n));
    venue.advance(NON_SERVICE.window);
    expect(unservedRequests(venue, backing, served)).toHaveLength(1);
    venue.advance(1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(0);
  });

  it("counts a republished request once", () => {
    // Distinct by the operation, so anyone echoing the venue cannot manufacture
    // a grade out of one request.
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    const only = request(backing, 10n, 0n);
    venue.publishOp(backing.name, only);
    venue.publishOp(backing.name, only);
    venue.publishOp(backing.name, only);
    venue.advance(NON_SERVICE.duration + 1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(1);
    expect(isNonServing(venue, backing, served)).toBe(false);
  });

  it("ignores a request the committed state could never have served", () => {
    // "Faking a request means holding a real claim, so the count is checkable."
    // Without this, anyone with a keypair manufactures the grade for free — the
    // same hole the challenge window had when a request the snapshot could not
    // have served counted as a spend.
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    const beyondHerHolding: PublishedOp = {
      kind: "transfer",
      from: KEYS.alice,
      to: KEYS.bob,
      quantity: 10_000n,
      nonce: 0n,
      signature: ed25519.sign(
        encodeTransferMessage(backing.name, KEYS.alice, KEYS.bob, 10_000n, 0n),
        SECRETS.alice,
      ),
    };
    const byAStranger: PublishedOp = {
      kind: "transfer",
      from: KEYS.mallory,
      to: KEYS.bob,
      quantity: 1n,
      nonce: 0n,
      signature: ed25519.sign(
        encodeTransferMessage(backing.name, KEYS.mallory, KEYS.bob, 1n, 0n),
        SECRETS.mallory,
      ),
    };
    venue.publishOp(backing.name, beyondHerHolding);
    venue.publishOp(backing.name, byAStranger);
    venue.advance(NON_SERVICE.duration + 1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(0);
    expect(isNonServing(venue, backing, served)).toBe(false);
  });

  it("a kind that is no request does not count, published beside one", () => {
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    venue.publishOp(backing.name, request(backing, 10n, 0n));
    venue.publishOp(backing.name, {
      kind: "burn",
      holder: KEYS.alice,
      quantity: 1n,
      nonce: 1n,
      signature: ed25519.sign(new Uint8Array(8), SECRETS.alice),
    } as PublishedOp);
    venue.advance(NON_SERVICE.duration + 1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(1);
  });

  it("never fires where the backing conceded no non-service grade", () => {
    // The same choice tag 0x01 makes about silence: a backer may concede
    // nothing, and the holder reads that before accepting.
    const { venue, sequencer, backing } = setup(undefined);
    const served = servedBy(sequencer);
    venue.publishOp(backing.name, request(backing, 10n, 0n));
    venue.publishOp(backing.name, request(backing, 20n, 1n));
    venue.advance(1000n);
    expect(unservedRequests(venue, backing, served)).toEqual([]);
    expect(isNonServing(venue, backing, served)).toBe(false);
  });

  it("answers, rather than throwing, on a state this operator did not commit", () => {
    const { venue, sequencer, backing } = setup();
    venue.publishOp(backing.name, request(backing, 10n, 0n));
    venue.publishOp(backing.name, request(backing, 20n, 1n));
    venue.advance(NON_SERVICE.duration + 1n);
    const junk = {
      snapshots: sequencer.snapshot(),
      commitment: { sequence: 0n, root: new Uint8Array(32), operator: KEYS.mallory, signature: new Uint8Array(64) },
    };
    expect(isNonServing(venue, backing, junk)).toBe(false);
    expect(unservedRequests(venue, backing, junk)).toEqual([]);
  });
});

describe("§C2b: the fold is a sequence, so a request behind another still counts", () => {
  it("counts a standing request whose predecessor has aged out of the window", () => {
    // Found reviewing the implementation. The age filter used to run before the
    // fold, so a request outside the counting band was skipped entirely — and
    // every later request by the same signer then failed as ahead of a nonce
    // nobody had reached. An operator could have escaped the grade forever by
    // being handed one request early and the rest later.
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    venue.publishOp(backing.name, request(backing, 10n, 0n));
    // Let the first age past the window before the next two arrive.
    venue.advance(NON_SERVICE.window + 1n);
    venue.publishOp(backing.name, request(backing, 20n, 1n));
    venue.publishOp(backing.name, request(backing, 30n, 2n));
    venue.advance(NON_SERVICE.duration + 1n);

    const standing = unservedRequests(venue, backing, served);
    expect(standing.map((w) => w.op.kind === "transfer" && w.op.nonce)).toEqual([1n, 2n]);
    expect(isNonServing(venue, backing, served)).toBe(true);
  });

  it("counts a request too young to stand yet as part of the sequence", () => {
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    venue.publishOp(backing.name, request(backing, 10n, 0n));
    venue.advance(NON_SERVICE.duration + 1n);
    // The second is still inside the duration, so it does not stand — but it
    // must not stop a third behind it from applying.
    venue.publishOp(backing.name, request(backing, 20n, 1n));
    venue.publishOp(backing.name, request(backing, 30n, 2n));
    expect(unservedRequests(venue, backing, served)).toHaveLength(1);
    venue.advance(NON_SERVICE.duration + 1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(3);
  });
});

describe("§C2b: no calibration is policed", () => {
  it("lets a backer concede the grade unconditionally with m = 0", () => {
    // The numbers are the backer's to choose and the holder's to read. m = 0
    // says the grade stands with nothing standing, which is odd and is what it
    // says — the same latitude a zero silence duration has.
    const { venue, sequencer, backing } = setup({ duration: 10n, count: 0n, window: 100n });
    const served = servedBy(sequencer);
    expect(unservedRequests(venue, backing, served)).toEqual([]);
    expect(isNonServing(venue, backing, served)).toBe(true);
  });
});

describe("§C3: a lock request left unserved is §C2b's non-service object", () => {
  // "A request is answered at the index its sequencer publishes a lock or a
  // signed refusal naming it" — this reference has no signed-refusal object
  // (the refusal aggregate m'/W' counts refusals to prepare, and
  // prepare-decide-commit is an extension), so service is the one answer, and
  // the count is the same fold the transfer count is: the law, in signing
  // order, against the state the operator committed.

  it("a lock request left unserved counts beside a transfer, and fires the grade", () => {
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    venue.publishOp(backing.name, request(backing, 10n, 0n));
    venue.publishOp(backing.name, lockRequest(venue, backing, 20n, 1n));
    venue.advance(NON_SERVICE.duration + 1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(2);
    expect(isNonServing(venue, backing, served)).toBe(true);
  });

  it("serving the lock request stops its count", () => {
    const { venue, sequencer, backing } = setup();
    const one = lockRequest(venue, backing, 20n, 0n);
    venue.publishOp(backing.name, one);
    venue.advance(NON_SERVICE.duration + 1n);
    expect(unservedRequests(venue, backing, servedBy(sequencer))).toHaveLength(1);
    const op: LockOp = {
      backing,
      attemptId: one.attemptId,
      holder: one.holder,
      beneficiary: one.beneficiary,
      quantity: one.quantity,
      timeout: one.timeout,
      decisionVenue: one.decisionVenue,
      parties: [...one.parties],
      nonce: one.nonce,
      salt: one.salt,
    };
    sequencer.submitLock(op, one.signature);
    venue.advance(1n); // one commitment per witnessed index (28b: eras end legibly)
    expect(unservedRequests(venue, backing, servedBy(sequencer))).toHaveLength(0);
  });

  it("a leg names no decision venue and is nobody's unserved request: it comes with its set", () => {
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    venue.publishOp(backing.name, lockRequest(venue, backing, 20n, 0n, { decisionVenue: NO_DECISION_VENUE }));
    venue.advance(NON_SERVICE.duration + 1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(0);
  });

  it("a request naming a venue the operator does not watch is not its to serve", () => {
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    venue.publishOp(backing.name, lockRequest(venue, backing, 20n, 0n, { decisionVenue: new Uint8Array(32).fill(0x77) }));
    venue.advance(NON_SERVICE.duration + 1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(0);
  });

  it("a lock that could never have been served does not count: its timeout was spent before its witnessing", () => {
    // The law's own refusal, asked at the one index the operator was first
    // handed the request — a live clock at the door would have refused it at
    // every later index too.
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    venue.advance(50n);
    venue.publishOp(backing.name, lockRequest(venue, backing, 20n, 0n, { timeout: 40n }));
    venue.advance(NON_SERVICE.duration + 1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(0);
  });

  it("a lock whose timeout IS its witnessing index was never servable either: the law's boundary is at-or-before", () => {
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    venue.advance(50n);
    venue.publishOp(backing.name, lockRequest(venue, backing, 20n, 0n, { timeout: 50n }));
    venue.advance(NON_SERVICE.duration + 1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(0);
  });

  it("a lock outlived by the wait stops counting: the door refuses an expired lock at every index in the band", () => {
    // Found reviewing this slice: the TIME gate was asked only at witnessing,
    // so m one-unit locks with short timeouts fired the grade against an
    // operator with no lawful move for the rest of W. The holder's own
    // declared term bounds the accusation, as a demand's deadline does — and
    // the consequence, accepted knowingly: an operator that stalls a lock
    // past its own timeout escapes this count for that request.
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    venue.publishOp(backing.name, lockRequest(venue, backing, 20n, 0n, { timeout: 15n }));
    venue.advance(14n); // in the band (age > 10), one index inside the timeout
    expect(unservedRequests(venue, backing, served)).toHaveLength(1);
    venue.advance(1n); // the timeout's own index: at-or-before is spent
    expect(unservedRequests(venue, backing, served)).toHaveLength(0);
  });

  it("a lock reserves its units in the fold: the transfer behind it is no longer servable", () => {
    // The mirror of "the fold is a sequence" one arm over: tested one at a
    // time the transfer passes (Alice holds 100); folded behind her own lock
    // of 60 it does not.
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    venue.publishOp(backing.name, lockRequest(venue, backing, 60n, 0n));
    venue.publishOp(backing.name, request(backing, 50n, 1n));
    venue.advance(NON_SERVICE.duration + 1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(1);
  });

  it("a demand standing on another backing claims no slot here: the door serves the lock, and the count agrees", () => {
    // Found reviewing this slice: the squat refusal scanned the whole book,
    // so a one-unit demand on X made a bare lock on Y unservable at the door
    // while Y's count — a one-backing reader — counted it: a manufactured
    // grade. The slot a leg or the payout must take exists only on the set's
    // own backings, and the refusal now reaches exactly as far as the set.
    const { venue, sequencer, backing } = setup();
    const other = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "USD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: { setting: "transparent", operator: KEYS.operator },
    });
    sequencer.register(other, signBacking(SECRETS.backer, other));
    sequencer.submitIssue(
      { backing: other, recipient: KEYS.alice, quantity: 10n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(other.name, KEYS.alice, 10n, 0n), SECRETS.backer),
    );
    const demand: DemandOp = {
      backing: other,
      holder: KEYS.alice,
      quantity: 1n,
      instant: 0n,
      deadline: 5_000n,
      nonce: 0n,
    };
    sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice));
    const served = servedBy(sequencer);
    // Its own attempt, as every venue-naming lock now has: the id is its terms'
    // hash, so it could not name the demand's hash even if a squatter wanted to.
    const one = lockRequest(venue, backing, 20n, 0n);
    venue.publishOp(backing.name, one);
    venue.advance(NON_SERVICE.duration + 1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(1);
    const op: LockOp = {
      backing,
      attemptId: one.attemptId,
      holder: one.holder,
      beneficiary: one.beneficiary,
      quantity: one.quantity,
      timeout: one.timeout,
      decisionVenue: one.decisionVenue,
      parties: [...one.parties],
      nonce: one.nonce,
      salt: one.salt,
    };
    sequencer.submitLock(op, one.signature); // the door agrees: no slot here
    venue.advance(1n); // one commitment per witnessed index
    expect(unservedRequests(venue, backing, servedBy(sequencer))).toHaveLength(0);
  });

  it("the venue's commit read sits behind the law: unsigned noise cannot make the count unanswerable on a commits-refusing view", () => {
    // Found reviewing this slice: the commit read ran in the filter, before
    // the signature check, so one unsigned junk lock took the whole count —
    // transfers included — down with a VenueError on a view that does not
    // sync commits (the walkGap residual, made reachable). Behind the law,
    // noise dies at the signature; a LAWFUL lock's commit read still
    // propagates the refusal, as every venue read must.
    class CommitsRefusing extends LocalVenue {
      override commitsFor(): never {
        throw new VenueError("this view does not sync commits");
      }
    }
    const venue = new CommitsRefusing();
    const backing = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: {
        setting: "transparent",
        operator: KEYS.operator,
        silence: { noCommitmentDuration: 1000n, challengeWindow: 5n },
        nonService: NON_SERVICE,
      },
    });
    const sequencer = new Sequencer(SECRETS.operator, venue);
    sequencer.register(backing, signBacking(SECRETS.backer, backing));
    sequencer.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    const served = servedBy(sequencer);
    venue.publishOp(backing.name, request(backing, 10n, 0n));
    venue.publishOp(backing.name, request(backing, 20n, 1n));
    const junk = lockRequest(venue, backing, 20n, 2n);
    venue.publishOp(backing.name, { ...junk, signature: new Uint8Array(64) });
    venue.advance(NON_SERVICE.duration + 1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(2);
    venue.publishOp(backing.name, lockRequest(venue, backing, 20n, 2n));
    venue.advance(NON_SERVICE.duration + 1n); // into the lawful lock's own band
    expect(() => unservedRequests(venue, backing, served)).toThrow(VenueError);
  });

  it("a lock under a standing demand's hash is a request like any other, and counts until served", () => {
    // This was the law's squat refusal ("a lock and a demand never share a
    // hash"), and the fold agreed the door had no lawful move. The lock-keying
    // slice deleted the door and made it the holder's own record beside her own
    // demand, countable like any other. Naming the attempt by its terms goes
    // further: a venue-naming lock CANNOT carry a demand's hash, so the shape is
    // not a request the operator failed to serve — it is one the law refuses, and
    // the fold must not count it against an operator with no lawful move.
    const { venue, sequencer, backing } = setup();
    const demand: DemandOp = {
      backing,
      holder: KEYS.alice,
      quantity: 10n,
      instant: 0n,
      deadline: 5_000n,
      nonce: 0n,
    };
    sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice));
    const served = servedBy(sequencer);
    const squat = lockRequest(venue, backing, 1n, 1n, { attemptId: demandHash(demand) });
    venue.publishOp(backing.name, squat);
    venue.advance(NON_SERVICE.duration + 1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(0);
    // And the door refuses it too, so fold and door agree.
    const op: LockOp = {
      backing,
      attemptId: squat.attemptId,
      holder: squat.holder,
      beneficiary: squat.beneficiary,
      quantity: squat.quantity,
      timeout: squat.timeout,
      decisionVenue: squat.decisionVenue,
      parties: [...squat.parties],
      nonce: squat.nonce,
      salt: squat.salt,
    };
    expect(() => sequencer.submitLock(op, squat.signature)).toThrow(
      /not the hash of this attempt's terms/,
    );
  });

  it("a request the record itself has answered does not count: its attempt is committed at the venue", () => {
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    const one = lockRequest(venue, backing, 20n, 0n);
    venue.publishOp(backing.name, one);
    // The object must satisfy the LOCK's parties — holder included, since a
    // venue-naming lock names its own holder among them (the lock-keying slice).
    venue.publishCommit(countersignCommit(signCommit(SECRETS.bob, one.attemptId), SECRETS.alice));
    venue.advance(NON_SERVICE.duration + 1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(0);
  });

  it("the fold is a sequence: a lock the earlier transfer leaves unfunded is no request the operator could have served", () => {
    // Tested one at a time the lock passes (Alice holds 100); folded behind
    // her own transfer of 60 it does not, and "the operator could have served
    // these" means in the order she signed them.
    const { venue, sequencer, backing } = setup();
    const served = servedBy(sequencer);
    venue.publishOp(backing.name, request(backing, 60n, 0n));
    venue.publishOp(backing.name, lockRequest(venue, backing, 95n, 1n));
    venue.advance(NON_SERVICE.duration + 1n);
    expect(unservedRequests(venue, backing, served)).toHaveLength(1);
  });
});
