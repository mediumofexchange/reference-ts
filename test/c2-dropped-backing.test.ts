import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { compareBytes } from "../src/bytes.js";
import {
  committedLogFor,
  signCommitment,
  stateRoot,
  type ServedState,
} from "../src/commitment.js";
import { isRewrittenHistory } from "../src/fault.js";
import { encodeIssuanceMessage, encodeTransferMessage } from "../src/messages.js";
import { type PublishedOp } from "../src/oplog.js";
import { receiptStatus } from "../src/receipt.js";
import { isNonServing, isSilent, provesHolding, unservedRequests } from "../src/recovery.js";
import { replacementMessage, ROLE_OPERATOR, type Replacement } from "../src/replacement.js";
import { Sequencer, SequencerError } from "../src/sequencer.js";
import { LocalVenue } from "../src/venue.js";
import { KEYS, SECRETS } from "./support.js";

// **An operator that drops one backing from its committed state.**
//
// §C2 has a shared operator batching: "The fee is per backing per interval,
// which forces batching. A shared operator publishes one transaction over a root
// of its backings' commitments." So a commitment omitting one backing is not a
// commitment FOR that backing — and a stranger reading the venue sees only a
// root, so it cannot tell.
//
// Slice 11 found the hole and recorded it; slices 13 and 14 both re-flagged it
// and deferred. What nobody had run was the whole of it, and it is worse than
// recorded: the aggravated grade is blind (the operator publishes), the rewrite
// fault is silent (the log did not shrink, it vanished), a receipt reads
// "unrelated", and no holding proves. The non-service grade DOES fire — but only
// against the last state that carried the backing — and the remedy it opens,
// §C2's replacement rule, could not be taken: takeOver refused the incumbent's
// latest (no log for the backing) and refused the last state carrying it (not
// the incumbent's latest). The grade fired, named the remedy, and the remedy
// could not be executed.
//
// The cause is one layer down. committedLogFor asks three questions that always
// travel together and merged two different answers into one `undefined`: "this
// is not your operator's state", and "this IS your operator's state, and it
// carries no log for your backing". The second is the accusation, reported as
// the first, and every caller inherited the blindness.

const SILENCE = { noCommitmentDuration: 20n, challengeWindow: 5n };
const NON_SERVICE = { duration: 10n, count: 2n, window: 100n };

function setup(replaceable = true) {
  const venue = new LocalVenue();
  const make = (thing: string) =>
    makeBacking({
      obligor: KEYS.backer,
      payout: { thing, quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: {
        setting: "transparent",
        operator: KEYS.operator,
        silence: SILENCE,
        witnessing: { venue: venue.id, interval: 5n },
        nonService: NON_SERVICE,
        ...(replaceable ? { replacementRule: KEYS.backer } : {}),
      },
    });
  // Two backings under one operator, which is §C5's recommended topology and
  // the whole reason the hole exists: dropping one leaves the other to keep the
  // operator looking punctual.
  const eur = make("EUR");
  const usd = make("USD");
  const sequencer = new Sequencer(SECRETS.operator, venue);
  for (const backing of [eur, usd]) {
    sequencer.register(backing, signBacking(SECRETS.backer, backing));
    sequencer.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
  }
  return { venue, sequencer, eur, usd };
}

/** The state as the operator serves it now, committed and published. */
function commitAll(sequencer: Sequencer): ServedState {
  // Committed first, then snapshotted: the commit adopts before it publishes.
  const { commitment } = sequencer.commit();
  return { snapshots: sequencer.snapshot(), commitment };
}

/**
 * Commit everything EXCEPT `dropped`, and publish it. This is the whole attack:
 * a well-formed commitment, validly signed, over a state that simply has no
 * entry for one of the backings this operator serves.
 */
function commitWithout(
  venue: LocalVenue,
  sequencer: Sequencer,
  dropped: Backing,
): ServedState {
  const snapshots = sequencer
    .snapshot()
    .filter((s) => compareBytes(s.name, dropped.name) !== 0);
  const commitment = signCommitment(
    SECRETS.operator,
    venue.nextSequenceFor(KEYS.operator),
    stateRoot(snapshots),
  );
  venue.publish(commitment);
  return { snapshots, commitment };
}

/** Keep committing everything but `dropped`, on schedule, for `rounds` intervals. */
function keepCommittingWithout(
  venue: LocalVenue,
  sequencer: Sequencer,
  dropped: Backing,
  rounds: number,
): ServedState[] {
  const drops: ServedState[] = [];
  for (let i = 0; i < rounds; i++) {
    venue.advance(5n);
    drops.unshift(commitWithout(venue, sequencer, dropped));
  }
  return drops;
}

/** Alice's signed request to move `quantity` to Bob at her nonce `nonce`. */
function request(backing: Backing, quantity: bigint, nonce: bigint): PublishedOp {
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

function replacementBy(
  backing: Backing,
  ruleSecret: Uint8Array,
  successorSecret: Uint8Array,
  effective: bigint,
): Replacement {
  // Co-signed (§C2): the fixture needs the successor's own key, because a
  // replacement it has not signed is a naming rather than a handover.
  const unsigned = {
    role: ROLE_OPERATOR,
    successor: ed25519.getPublicKey(successorSecret),
    predecessor: backing.name,
    effective,
    signature: new Uint8Array(64),
    successorSignature: new Uint8Array(64),
  };
  const message = replacementMessage(backing.name, unsigned);
  return {
    ...unsigned,
    signature: ed25519.sign(message, ruleSecret),
    successorSignature: ed25519.sign(message, successorSecret),
  };
}

describe("§C2: a committed state that carries no log for this backing", () => {
  it("is told apart from a state that is not this operator's at all", () => {
    // The whole slice in one assertion. Three questions, three answers — where
    // before there were three questions and two.
    const { venue, sequencer, eur, usd } = setup();
    const carried = commitAll(sequencer);
    const dropped = commitWithout(venue, sequencer, eur);

    expect(committedLogFor(eur, venue, carried)?.kind).toBe("log");
    expect(committedLogFor(eur, venue, dropped)?.kind).toBe("dropped");
    // Still carries USD, so the same state answers differently per backing.
    expect(committedLogFor(usd, venue, dropped)?.kind).toBe("log");

    const stranger = {
      snapshots: dropped.snapshots,
      commitment: signCommitment(SECRETS.mallory, 1n, stateRoot(dropped.snapshots)),
    };
    expect(committedLogFor(eur, venue, stranger)).toBeUndefined();
  });

  it("carries the sequence on both answers, because ordering needs it", () => {
    const { venue, sequencer, eur } = setup();
    const carried = commitAll(sequencer);
    const dropped = commitWithout(venue, sequencer, eur);
    expect(committedLogFor(eur, venue, carried)?.sequence).toBe(carried.commitment.sequence);
    expect(committedLogFor(eur, venue, dropped)?.sequence).toBe(dropped.commitment.sequence);
  });
});

describe("§C2b: what the venue alone still cannot see", () => {
  it("the aggravated grade stays blind, and that is the spec's own letter", () => {
    // §C2b: "No commitment past a second declared duration". The operator IS
    // committing — punctually — so it is not silent. The paper now says this in
    // its own words, which is what this pins: "the grade fires on the operator
    // publishing nothing, not on it covering nothing", because a venue witnesses
    // a root and cannot read which backings it carries. Faithful, not blind.
    const { venue, sequencer, eur } = setup();
    commitAll(sequencer);
    keepCommittingWithout(venue, sequencer, eur, 20);
    expect(isSilent(venue, eur)).toBe(false);
  });

  it("no holding proves against a state that dropped the backing", () => {
    const { venue, sequencer, eur } = setup();
    commitAll(sequencer);
    const drops = keepCommittingWithout(venue, sequencer, eur, 20);
    const dropped = drops[0]!;
    expect(provesHolding(venue, eur, dropped, KEYS.alice, 100n)).toBe(false);
  });
});

describe("§C2: the log that vanished is the log that shrank", () => {
  it("a backing dropped from a later state is a rewritten history", () => {
    // The fault isRewrittenHistory was already for: "an append-only log may grow
    // and may not shrink". Dropping is shrinking to nothing, so it is the same
    // fault and needs no second predicate.
    const { venue, sequencer, eur } = setup();
    const carried = commitAll(sequencer);
    const dropped = commitWithout(venue, sequencer, eur);
    expect(isRewrittenHistory(eur, venue, carried, dropped)).toBe(true);
    // Symmetric in its arguments: which came first is read from the sequence.
    expect(isRewrittenHistory(eur, venue, dropped, carried)).toBe(true);
  });

  it("a backing appearing in a later state is not a rewrite", () => {
    // An operator that had not yet registered the backing committed states
    // without it. Growing from nothing is growth, and naming it a fault would
    // accuse every operator of its own first commitment. Both states are
    // hand-rooted: a hand-published root desyncs the live process's seats by
    // design now (the record moved past them — the resume rule), and this
    // test's claim is the VERIFIER's, needing no door.
    const { venue, sequencer, eur } = setup();
    // The carrying snapshots are taken while the process still serves: a
    // hand-published root desyncs its seats (the record moved past them),
    // so taken afterwards `snapshot()` is EMPTY and the "later state"
    // carries nothing — the slice-36 round's Root C, a fixture that had
    // stopped exercising its name. Asserted, so it cannot happen twice.
    const snapshots = sequencer.snapshot();
    expect(snapshots.some((s) => compareBytes(s.name, eur.name) === 0)).toBe(true);
    const before = commitWithout(venue, sequencer, eur);
    venue.advance(1n);
    const after = {
      snapshots,
      commitment: signCommitment(
        SECRETS.operator,
        venue.nextSequenceFor(KEYS.operator),
        stateRoot(snapshots),
      ),
    };
    venue.publish(after.commitment);
    expect(isRewrittenHistory(eur, venue, before, after)).toBe(false);
  });

  it("two states that both drop it are not a rewrite", () => {
    const { venue, sequencer, eur } = setup();
    const first = commitWithout(venue, sequencer, eur);
    venue.advance(1n);
    const second = commitWithout(venue, sequencer, eur);
    expect(isRewrittenHistory(eur, venue, first, second)).toBe(false);
  });

  it("does not accuse a RETIRED operator, which is supposed to stop carrying it", () => {
    // Found reviewing the implementation, and it is the recurring shape: the fix
    // bounded one direction and left the adjacent one open. §C2: "From the
    // effective index the old attester's co-signatures stop counting" — a
    // replaced operator goes on serving its OTHER backings, so its later
    // commitments drop this one as a matter of obedience. Naming that a fault
    // accuses a retired party for doing what the handover told it to.
    const { venue, sequencer, eur, usd } = setup();
    const beforeHandover = commitAll(sequencer);
    venue.advance(1n);
    const effective = venue.witnessedIndex() + 1n;
    venue.publishReplacement(eur.name, replacementBy(eur, SECRETS.backer, SECRETS.carol, effective));
    const heir = new Sequencer(SECRETS.carol, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, beforeHandover);
    venue.advance(2n);
    heir.commit();

    // The retired predecessor carries on with USD alone, exactly as it should.
    venue.advance(5n);
    const usdOnly = sequencer.snapshot().filter((s) => compareBytes(s.name, usd.name) === 0);
    const afterHandover = {
      snapshots: usdOnly,
      commitment: signCommitment(
        SECRETS.operator,
        venue.nextSequenceFor(KEYS.operator),
        stateRoot(usdOnly),
      ),
    };
    venue.publish(afterHandover.commitment);

    expect(isRewrittenHistory(eur, venue, beforeHandover, afterHandover)).toBe(false);
  });

  it("still accuses the operator in force, replacement rule or not", () => {
    // The other side of the same guard: a successor that takes the backing on
    // and then drops it is the fault, because it IS in force.
    const { venue, sequencer, eur } = setup();
    const beforeHandover = commitAll(sequencer);
    venue.advance(1n);
    const effective = venue.witnessedIndex() + 1n;
    venue.publishReplacement(eur.name, replacementBy(eur, SECRETS.backer, SECRETS.carol, effective));
    const heir = new Sequencer(SECRETS.carol, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, beforeHandover);
    venue.advance(2n);
    const inForce = heir.commit();

    const dropped = {
      snapshots: [],
      commitment: signCommitment(
        SECRETS.carol,
        venue.nextSequenceFor(KEYS.carol),
        stateRoot([]),
      ),
    };
    venue.publish(dropped.commitment);
    expect(isRewrittenHistory(eur, venue, inForce, dropped)).toBe(true);
  });

  it("and the proof survives the remedy, which is the point of a proof", () => {
    // Found regression-reviewing the fix above, and it was worse than the bug it
    // fixed. Reading "is this operator in force NOW" made the fault evaporate at
    // the exact moment the holder used it: the remedy for a dropped backing IS
    // replacement, so proving it, getting a successor appointed, and then asking
    // again answered false — and an operator could launder its record by
    // arranging its own succession. A fault proof is checkable by a stranger
    // forever or it is not one.
    const { venue, sequencer, eur } = setup();
    const carried = commitAll(sequencer);
    const drops = keepCommittingWithout(venue, sequencer, eur, 3);
    const dropped = drops[0]!;
    expect(isRewrittenHistory(eur, venue, carried, dropped)).toBe(true);

    // Now the remedy runs: a successor is appointed and takes force.
    const effective = venue.witnessedIndex() + 1n;
    venue.publishReplacement(eur.name, replacementBy(eur, SECRETS.backer, SECRETS.carol, effective));
    const heir = new Sequencer(SECRETS.carol, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, carried, ...drops);
    venue.advance(2n);
    heir.commit();

    expect(isRewrittenHistory(eur, venue, carried, dropped)).toBe(true);
  });

  it("does not accuse this operator on a stranger's state", () => {
    const { venue, sequencer, eur } = setup();
    const carried = commitAll(sequencer);
    const snapshots = carried.snapshots.filter(
      (s) => compareBytes(s.name, eur.name) !== 0,
    );
    const stranger = {
      snapshots,
      commitment: signCommitment(SECRETS.mallory, 99n, stateRoot(snapshots)),
    };
    expect(isRewrittenHistory(eur, venue, carried, stranger)).toBe(false);
  });
});

describe("§C2: a receipt read against a state that dropped the backing", () => {
  it("says dropped rather than unrelated", () => {
    // "unrelated" means "not this backing's operator's receipt, or not its
    // state", and here it is both. Answering it exonerates in the one direction
    // that matters — the holder reads it as having asked the wrong question.
    const { venue, sequencer, eur } = setup();
    const receipt = sequencer.submitTransfer(
      { backing: eur, from: KEYS.alice, to: KEYS.bob, quantity: 40n, nonce: 0n },
      ed25519.sign(
        encodeTransferMessage(eur.name, KEYS.alice, KEYS.bob, 40n, 0n),
        SECRETS.alice,
      ),
    );
    const carried = commitAll(sequencer);
    const dropped = commitWithout(venue, sequencer, eur);

    expect(receiptStatus(eur, venue, receipt, carried)).toBe("witnessed");
    expect(receiptStatus(eur, venue, receipt, dropped)).toBe("dropped");
  });

  it("is not an accusation, because a receipt cannot be placed in time", () => {
    // A receipt names an operation and a position and never when it was signed
    // (slice 13), so a state committed BEFORE the backing existed drops it
    // perfectly innocently. "dropped" says what the state is, not what the
    // operator did — the fault is isRewrittenHistory's to name, and it needs two
    // states to order them.
    const { venue, sequencer, eur } = setup();
    // The receipt first, then the hand-rooted early state: a hand-published
    // root desyncs the live process's seats by design now (the resume rule),
    // and what this test orders is the STATES, not the fixture's calls.
    const receipt = sequencer.submitTransfer(
      { backing: eur, from: KEYS.alice, to: KEYS.bob, quantity: 40n, nonce: 0n },
      ed25519.sign(
        encodeTransferMessage(eur.name, KEYS.alice, KEYS.bob, 40n, 0n),
        SECRETS.alice,
      ),
    );
    // The carrying snapshots BEFORE the hand-published drop, which desyncs
    // the live process's seats (the record moves past them) and would leave
    // `snapshot()` empty — so `carried` really carries (the slice-36 round's
    // Root C). The claim here is the VERIFIER's ordering of two states.
    const snapshots = sequencer.snapshot();
    expect(snapshots.some((s) => compareBytes(s.name, eur.name) === 0)).toBe(true);
    const early = commitWithout(venue, sequencer, eur);
    venue.advance(1n);
    const carried = {
      snapshots,
      commitment: signCommitment(
        SECRETS.operator,
        venue.nextSequenceFor(KEYS.operator),
        stateRoot(snapshots),
      ),
    };
    venue.publish(carried.commitment);
    expect(receiptStatus(eur, venue, receipt, early)).toBe("dropped");
    expect(isRewrittenHistory(eur, venue, early, carried)).toBe(false);
  });

  it("still says unrelated for a state that is not this operator's", () => {
    const { venue, sequencer, eur } = setup();
    const receipt = sequencer.submitTransfer(
      { backing: eur, from: KEYS.alice, to: KEYS.bob, quantity: 40n, nonce: 0n },
      ed25519.sign(
        encodeTransferMessage(eur.name, KEYS.alice, KEYS.bob, 40n, 0n),
        SECRETS.alice,
      ),
    );
    const carried = commitAll(sequencer);
    const snapshots = carried.snapshots.filter(
      (s) => compareBytes(s.name, eur.name) !== 0,
    );
    const stranger = {
      snapshots,
      commitment: signCommitment(SECRETS.mallory, 1n, stateRoot(snapshots)),
    };
    expect(receiptStatus(eur, venue, receipt, stranger)).toBe("unrelated");
  });
});

describe("§C2b: the grade that does fire, and the state it must be asked against", () => {
  it("fires against the last state that carried the backing", () => {
    // Slice 16's test file asserted this in prose. Nothing ran it.
    const { venue, sequencer, eur } = setup();
    const lastGood = commitAll(sequencer);
    keepCommittingWithout(venue, sequencer, eur, 20);

    venue.publishOp(eur.name, request(eur, 10n, 0n));
    venue.publishOp(eur.name, request(eur, 20n, 1n));
    venue.advance(NON_SERVICE.duration + 1n);

    expect(unservedRequests(venue, eur, lastGood)).toHaveLength(2);
    expect(isNonServing(venue, eur, lastGood)).toBe(true);
  });

  it("counts nothing against a state that dropped it, and cannot", () => {
    // There is no committed log to fold the requests onto. The count is honest;
    // what was missing is that a holder handed the operator's LATEST state gets
    // this answer and must know to reach for the last one that carried it.
    const { venue, sequencer, eur } = setup();
    commitAll(sequencer);
    const drops = keepCommittingWithout(venue, sequencer, eur, 20);
    const dropped = drops[0]!;
    venue.publishOp(eur.name, request(eur, 10n, 0n));
    venue.publishOp(eur.name, request(eur, 20n, 1n));
    venue.advance(NON_SERVICE.duration + 1n);

    expect(unservedRequests(venue, eur, dropped)).toHaveLength(0);
    expect(isNonServing(venue, eur, dropped)).toBe(false);
  });
});

describe("§C2: the remedy, and the successor that can now take it", () => {
  /** Fire the grade, appoint a successor, and hand back what it needs. */
  function toHandover(replaceable = true) {
    const { venue, sequencer, eur, usd } = setup(replaceable);
    const lastGood = commitAll(sequencer);
    const drops = keepCommittingWithout(venue, sequencer, eur, 20);
    const droppedLatest = drops[0]!;
    venue.publishOp(eur.name, request(eur, 10n, 0n));
    venue.publishOp(eur.name, request(eur, 20n, 1n));
    venue.advance(NON_SERVICE.duration + 1n);
    return { venue, sequencer, eur, usd, lastGood, droppedLatest, drops };
  }

  /**
   * The heir, named and registered but NOT yet in force: force is the effective
   * index (§C2), and the callers below take the state on in the lead time before
   * it arrives, which is what the lead time is for.
   */
  function appoint(venue: LocalVenue, eur: Backing) {
    const effective = venue.witnessedIndex() + 2n;
    venue.publishReplacement(eur.name, replacementBy(eur, SECRETS.backer, SECRETS.carol, effective));
    venue.advance(1n);
    const heir = new Sequencer(SECRETS.carol, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    return heir;
  }

  it("takes on the last state that carried it, on evidence the latest drops it", () => {
    const { venue, eur, lastGood, drops } = toHandover();
    const heir = appoint(venue, eur);
    heir.takeOver(eur, lastGood, ...drops);
    expect(heir.opLog(eur)).toHaveLength(lastGood.snapshots[0]!.opLog.length);
  });

  it("and once it commits, holdings prove again — the hole closes", () => {
    // The whole point of the slice. §C2b's remedy for the non-service grade is
    // E's replacement rule, not snapshot redemption: the aggravated grade never
    // fired here, so there is no snapshot path to open. What restores the holder
    // is a successor serving.
    const { venue, eur, lastGood, drops } = toHandover();
    const heir = appoint(venue, eur);
    heir.takeOver(eur, lastGood, ...drops);
    venue.advance(1n); // force arrives at the effective index
    const served = heir.commit();
    expect(provesHolding(venue, eur, served, KEYS.alice, 100n)).toBe(true);
  });

  it("refuses an earlier state with no evidence at all — slice 14's rule is intact", () => {
    const { venue, eur, lastGood } = toHandover();
    const heir = appoint(venue, eur);
    expect(() => heir.takeOver(eur, lastGood)).toThrow(SequencerError);
  });

  it("the walk takes every drop newest first — the pinned one, the stale one, the run before them — and refuses a skipped step", () => {
    const { venue, sequencer, eur, lastGood, drops } = toHandover();
    // Named four indices out, so the incumbent commits twice more BEFORE the
    // effective index: its commitments up to then move the target (§C2). The
    // walk starts at the record's last — the pinned drop — and takes each
    // earlier drop in turn; a stale drop offered in the pinned one's place is
    // not the record's next step and is refused by name (the fix panel: the
    // retired door held the exhibit to the pin and let the offer float).
    const effective = venue.witnessedIndex() + 4n;
    venue.publishReplacement(eur.name, replacementBy(eur, SECRETS.backer, SECRETS.carol, effective));
    venue.advance(1n);
    const stale = commitWithout(venue, sequencer, eur);
    const older = { snapshots: stale.snapshots, commitment: stale.commitment };
    venue.advance(1n);
    const pinned = commitWithout(venue, sequencer, eur);
    venue.advance(2n);
    const heir = new Sequencer(SECRETS.carol, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    expect(() => heir.takeOver(eur, lastGood, older)).toThrow(SequencerError);
    // The whole run, newest first, reaches exactly the last carrying state.
    heir.takeOver(eur, lastGood, { snapshots: pinned.snapshots, commitment: pinned.commitment }, older, ...drops);
    expect(heir.awaitingTakeover()).toHaveLength(0);
    expect(heir.opLog(eur)).toHaveLength(lastGood.snapshots[0]!.opLog.length);
  });

  it("refuses evidence that still carries the backing", () => {
    // If the incumbent's latest carries it, there is nothing to license taking
    // an earlier state: take the latest, exactly as before.
    const { venue, sequencer, eur } = setup();
    const first = commitAll(sequencer);
    venue.advance(1n);
    sequencer.submitTransfer(
      { backing: eur, from: KEYS.alice, to: KEYS.bob, quantity: 40n, nonce: 0n },
      ed25519.sign(
        encodeTransferMessage(eur.name, KEYS.alice, KEYS.bob, 40n, 0n),
        SECRETS.alice,
      ),
    );
    const latest = commitAll(sequencer);
    const heir = appoint(venue, eur);
    expect(() => heir.takeOver(eur, first, latest)).toThrow(SequencerError);
  });

  it("refuses a state that never carried the backing either", () => {
    // Offered with no exhibit, the drop IS the commitment the record stands
    // on, so it is refused for what it is: a state carrying no log. (Offered
    // beside itself as an exhibit it would be refused one step down, by
    // identity — a different claim, which the walk's own tests make.)
    const { venue, eur, droppedLatest } = toHandover();
    const heir = appoint(venue, eur);
    expect(() => heir.takeOver(eur, droppedLatest)).toThrow(/carries no log for this backing/);
  });

  /**
   * The incumbent serves a two-entry book, commits it, then commits a state
   * that drops the backing; an heir is seated after that. The pinned target
   * carries no log, so the evidence path licenses an EARLIER state — and each
   * test below offers one only the term-precedence rule can refuse. Every
   * fixture then walks the honest path the refusal leaves open (35d's round:
   * three of these four conditions had no mutation that died).
   */
  function evidenceLicenses() {
    const { venue, sequencer, eur } = setup();
    sequencer.submitTransfer(
      { backing: eur, from: KEYS.alice, to: KEYS.bob, quantity: 40n, nonce: 0n },
      ed25519.sign(encodeTransferMessage(eur.name, KEYS.alice, KEYS.bob, 40n, 0n), SECRETS.alice),
    );
    const carried = commitAll(sequencer); // seq 0 at index 0: EUR [issue, transfer]
    venue.advance(10n);
    const dropped = commitWithout(venue, sequencer, eur); // seq 1 at 10: the pin
    venue.advance(5n);
    venue.publishReplacement(eur.name, replacementBy(eur, SECRETS.backer, SECRETS.carol, 15n));
    venue.advance(1n);
    const heir = new Sequencer(SECRETS.carol, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    const eurLog = carried.snapshots.find((s) => compareBytes(s.name, eur.name) === 0)!.opLog;
    return { venue, eur, heir, carried, dropped, eurLog, drops: [dropped] };
  }

  it("the heir may not license its own commitment as the earlier state", () => {
    // The heir signs, in its OWN term, a law-valid TRUNCATION of the book: the
    // issuance kept, Bob's 40 gone. The drop evidence is genuine, the state
    // roots, the replay is lawful — and the walk refuses it by IDENTITY: the
    // state offered must be the commitment the record stands on at that
    // step, and an unpublished own-signed state is on no step at all (the
    // fix panel retired the term rule that used to hold this line).
    // UNPUBLISHED, deliberately: published, the truncation would BE the
    // record's last commitment and the walk would reach it — the heir's own
    // witnessed fault, resumed onto in one call and provable forever
    // (c2-the-resume).
    const { venue, eur, heir, carried, dropped, eurLog, drops } = evidenceLicenses();
    const truncated = [{ name: eur.name, opLog: [eurLog[0]!] }];
    const ownTerm: ServedState = {
      snapshots: truncated,
      commitment: signCommitment(SECRETS.carol, 0n, stateRoot(truncated)),
    };
    expect(() => heir.takeOver(eur, ownTerm, dropped)).toThrow(SequencerError);
    expect(heir.opLog(eur)).toHaveLength(0);
    // The honest path the door leaves open: the last state that carried it.
    heir.takeOver(eur, carried, ...drops);
    expect(heir.balance(eur, KEYS.bob)).toBe(40n);
  });

  it("a state the predecessor published out of force is not an earlier state", () => {
    // The retired incumbent signs the same truncation AFTER losing force. It
    // is on no step of the walk — the record's in-force commitments are the
    // only steps — so identity refuses it; a state that places nowhere
    // accuses nobody and licenses nothing.
    const { venue, eur, heir, carried, dropped, eurLog, drops } = evidenceLicenses();
    venue.advance(1n);
    const truncated = [{ name: eur.name, opLog: [eurLog[0]!] }];
    const outOfForce: ServedState = {
      snapshots: truncated,
      commitment: signCommitment(
        SECRETS.operator,
        venue.nextSequenceFor(KEYS.operator),
        stateRoot(truncated),
      ),
    };
    venue.publish(outOfForce.commitment);
    expect(() => heir.takeOver(eur, outOfForce, dropped)).toThrow(SequencerError);
    expect(heir.opLog(eur)).toHaveLength(0);
    heir.takeOver(eur, carried, ...drops);
    expect(heir.balance(eur, KEYS.bob)).toBe(40n);
  });

  it("a twin signed at the pinned commitment's own sequence is not an earlier state", () => {
    // The incumbent equivocated: a second state at the sequence it published
    // the drop at, this one carrying the backing. It roots, it is the
    // incumbent's own signature, it places in the incumbent's own term — only
    // identity against the walk's step refuses it (a twin at one sequence has
    // a different root), and taking it would
    // seat the heir on one arm of an equivocation isEquivocation names.
    const { eur, heir, carried, dropped, drops } = evidenceLicenses();
    const twin: ServedState = {
      snapshots: carried.snapshots,
      commitment: signCommitment(
        SECRETS.operator,
        dropped.commitment.sequence,
        stateRoot(carried.snapshots),
      ),
    };
    expect(() => heir.takeOver(eur, twin, dropped)).toThrow(SequencerError);
    expect(heir.opLog(eur)).toHaveLength(0);
    heir.takeOver(eur, carried, ...drops);
    expect(heir.balance(eur, KEYS.bob)).toBe(40n);
  });

  it("still refuses a state that is not the incumbent's", () => {
    const { venue, eur, lastGood, droppedLatest } = toHandover();
    const heir = appoint(venue, eur);
    const snapshots = lastGood.snapshots;
    const forged = {
      snapshots,
      commitment: signCommitment(SECRETS.mallory, 1n, stateRoot(snapshots)),
    };
    expect(() => heir.takeOver(eur, forged, droppedLatest)).toThrow(SequencerError);
  });

  it("a successor cannot take too old a state: the walk reaches exactly one", () => {
    // Which state was the LAST to carry the backing is not readable from a
    // root, so the retired door licensed any earlier state and relied on a
    // fault proof after the fact. The walk reaches exactly one — the drops
    // above the last carrying state are exhibited, and a carrying state
    // cannot be — so the older state is refused by name, and the successor's
    // first commitment is no rewrite of anything.
    const { venue, sequencer, eur } = setup();
    const first = commitAll(sequencer);
    venue.advance(1n);
    sequencer.submitTransfer(
      { backing: eur, from: KEYS.alice, to: KEYS.bob, quantity: 40n, nonce: 0n },
      ed25519.sign(
        encodeTransferMessage(eur.name, KEYS.alice, KEYS.bob, 40n, 0n),
        SECRETS.alice,
      ),
    );
    const second = commitAll(sequencer);
    const drops = keepCommittingWithout(venue, sequencer, eur, 5);
    const droppedLatest = drops[0]!;

    const heir = appoint(venue, eur);
    expect(() => heir.takeOver(eur, first, droppedLatest)).toThrow(SequencerError);
    heir.takeOver(eur, second, ...drops);
    venue.advance(1n); // force arrives at the effective index
    const successorState = heir.commit();
    expect(isRewrittenHistory(eur, venue, second, successorState)).toBe(false);
  });

  it("OPEN: a backing whose E names no replacement rule has no exit", () => {
    // Pinning a hole, not a property. The non-service grade fires and opens a
    // rule that does not exist; the aggravated grade never fires because the
    // operator publishes; so the claims freeze permanently.
    //
    // The paper was asked and answered twice. The aggravated grade is NOT read
    // per backing, because a venue witnesses a root; and §C2b now names this
    // exact case, the remedy being "inert wherever that rule names the backer,
    // and absent wherever E names no rule at all". So it is the setting the
    // holder read rather than a defect, and it stays pinned because a holder
    // reading "silence clause: yes" would reasonably expect an exit, and here
    // there is none.
    const { venue, eur, lastGood } = toHandover(false);
    expect(isNonServing(venue, eur, lastGood)).toBe(true);
    expect(isSilent(venue, eur)).toBe(false);
    const heir = new Sequencer(SECRETS.carol, venue);
    expect(() => heir.register(eur, signBacking(SECRETS.backer, eur))).toThrow(SequencerError);
  });
});
