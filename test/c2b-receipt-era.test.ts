import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { signCommitment, stateRoot, type ServedState } from "../src/commitment.js";
import { isDoubleAcceptance, isDoublePosition } from "../src/fault.js";
import { encodeIssuanceMessage, encodeTransferMessage } from "../src/messages.js";
import { opHashOfEntry, type OpLogEntry, type PublishedOp } from "../src/oplog.js";
import { encodeDemandMessage } from "../src/presentation.js";
import { receiptStatus, signReceipt } from "../src/receipt.js";
import { eraLapsed } from "../src/recovery.js";
import { replacementMessage, ROLE_OPERATOR, type Replacement } from "../src/replacement.js";
import { Sequencer } from "../src/sequencer.js";
import { LocalVenue } from "../src/venue.js";
import { KEYS, makeTransparentBacking, pub, SECRETS, advanceWitnessedIndex } from "./support.js";

// The receipt names its era (28b): `after`, the witnessed index of the
// operator's last commitment when it co-signed, 0 where it had none. A receipt
// records an operation and a position and never when it was signed, so before
// this a reader could not tell a tail that died with a gap or a handover from a
// lie about the log — and an honest operator returning from silence was
// provably "at fault" to any stranger holding its dead receipt beside its
// record (pinned OPEN in slice 28a; closed here).
//
// The era ends at the operator's next commitment, or at a successor taking
// force, whichever the record shows first (`eraLapsed`), and how it ends is
// what a receipt is worth:
//   - an ordinary commitment — at or inside the backing's declared duration —
//     carries the whole tail, so an attested operation missing from the record
//     is `contradicted`, and a pair of receipts one log cannot hold is a fault;
//   - a return (the next commitment came later than the duration) or a handover
//     dropped the tail with license: the receipt reads `lapsed`, and the fault
//     pair proves nothing — the recorded residual being that an operator can
//     launder a real double acceptance by going silent, at the price of the
//     public aggravated grade.

const SILENCE = { noCommitmentDuration: 10n, challengeWindow: 5n };
const SUCCESSOR_SECRET = new Uint8Array(32).fill(0x0b);
const SUCCESSOR = pub(SUCCESSOR_SECRET);

function setup(silence: typeof SILENCE | null = SILENCE) {
  const venue = new LocalVenue();
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

/** Committed first, then snapshotted (a return commit restores and adopts before it publishes). */
function served(sequencer: Sequencer): ServedState {
  const commitment = sequencer.commit();
  return { snapshots: sequencer.snapshot(), commitment };
}

function transferOp(backing: Backing, secret: Uint8Array, from: Uint8Array, to: Uint8Array, quantity: bigint, nonce: bigint) {
  const op = { backing, from, to, quantity, nonce };
  const signature = ed25519.sign(encodeTransferMessage(backing.name, from, to, quantity, nonce), secret);
  const published: PublishedOp = { kind: "transfer", from, to, quantity, nonce, signature };
  return { op, signature, published };
}

function demandPublished(backing: Backing, secret: Uint8Array, holder: Uint8Array, quantity: bigint, instant: bigint, deadline: bigint, nonce: bigint) {
  const message = encodeDemandMessage(backing.name, holder, quantity, instant, deadline, nonce);
  const published: PublishedOp = { kind: "demand", holder, quantity, instant, deadline, nonce, signature: ed25519.sign(message, secret) };
  return { published, op: { backing, holder, quantity, instant, deadline, nonce } };
}

/** A state this operator really signed over whatever log it is handed. */
function commitLog(backing: Backing, opLog: readonly OpLogEntry[], sequence: bigint): ServedState {
  const snapshots = [{ name: backing.name, opLog }];
  return { snapshots, commitment: signCommitment(SECRETS.operator, sequence, stateRoot(snapshots)) };
}

function replacementBy(backing: Backing, ruleSecret: Uint8Array, successor: Uint8Array, predecessor: Uint8Array, effective: bigint): Replacement {
  const unsigned = { role: ROLE_OPERATOR, successor, predecessor, effective, signature: new Uint8Array(64) };
  return { ...unsigned, signature: ed25519.sign(replacementMessage(backing.name, unsigned), ruleSecret) };
}

describe("28b: a receipt names its era, and the era is the record's to verify", () => {
  it("carries the witnessed index of the operator's last commitment at signing — 0 where it had none — and one naming an index it never committed at reads unrelated", () => {
    const { venue, sequencer, backing } = setup();
    const before = issue(sequencer, backing, KEYS.alice, 100n, 0n);
    expect(before.after).toBe(0n);
    advanceWitnessedIndex(venue, 3n);
    sequencer.commit(); // at 3
    advanceWitnessedIndex(venue, 4n);
    const spend = transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    const after = sequencer.submitTransfer(spend.op, spend.signature);
    expect(after.after).toBe(3n);
    // A forged era: signed by the true operator, naming an index with no
    // commitment. The record cannot answer for it.
    const state = served(sequencer);
    const forged = signReceipt(SECRETS.operator, backing.name, after.opHash, after.position, 2n);
    expect(receiptStatus(backing, venue, forged, state)).toBe("unrelated");
    expect(receiptStatus(backing, venue, after, state)).toBe("witnessed");
  });

  it("witnessed needs no era: a tail operation resubmitted onto its old position keeps its dead receipt readable as witnessed", () => {
    const { venue, sequencer, backing } = setup();
    issue(sequencer, backing, KEYS.alice, 100n, 0n);
    sequencer.commit(); // at 0
    advanceWitnessedIndex(venue, 1n);
    const spend = transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    const dead = sequencer.submitTransfer(spend.op, spend.signature); // position 1, the tail
    advanceWitnessedIndex(venue, 15n);
    sequencer.commit(); // the return: the tail dies
    advanceWitnessedIndex(venue, 16n);
    // Nothing displaced position 1, so the resubmission lands exactly there.
    const fresh = sequencer.submitTransfer(spend.op, spend.signature);
    expect(fresh.position).toBe(dead.position);
    const state = served(sequencer);
    expect(receiptStatus(backing, venue, dead, state)).toBe("witnessed");
  });

  it("the duration is the boundary: one shortened log reads contradicted committed inside it, lapsed committed past it", () => {
    // The same book, the same drop, two timings. An era that ends at an
    // ordinary commitment carried its whole tail, so the missing operation is
    // the operator's lie; one that ends in a return dropped it with license.
    const early = setup();
    issue(early.sequencer, early.backing, KEYS.alice, 100n, 0n);
    const spendA = transferOp(early.backing, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    const receiptA = early.sequencer.submitTransfer(spendA.op, spendA.signature);
    const logA = early.sequencer.snapshot()[0]!.opLog;
    advanceWitnessedIndex(early.venue, 5n); // inside the duration (10)
    const insideEra = commitLog(early.backing, [logA[0]!], 0n);
    early.venue.publish(insideEra.commitment);
    expect(receiptStatus(early.backing, early.venue, receiptA, insideEra)).toBe("contradicted");
    const late = setup();
    issue(late.sequencer, late.backing, KEYS.alice, 100n, 0n);
    const spendB = transferOp(late.backing, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    const receiptB = late.sequencer.submitTransfer(spendB.op, spendB.signature);
    const logB = late.sequencer.snapshot()[0]!.opLog;
    advanceWitnessedIndex(late.venue, 11n); // past the duration: a return
    const pastEra = commitLog(late.backing, [logB[0]!], 0n);
    late.venue.publish(pastEra.commitment);
    expect(receiptStatus(late.backing, late.venue, receiptB, pastEra)).toBe("lapsed");
    // And the boundary itself: a commitment at exactly the duration is inside
    // it — strictly `>`, the same side gapOpen reads — so the era carried.
    const edge = setup();
    issue(edge.sequencer, edge.backing, KEYS.alice, 100n, 0n);
    const spendC = transferOp(edge.backing, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    const receiptC = edge.sequencer.submitTransfer(spendC.op, spendC.signature);
    const logC = edge.sequencer.snapshot()[0]!.opLog;
    advanceWitnessedIndex(edge.venue, 10n); // exactly the duration
    const atEdge = commitLog(edge.backing, [logC[0]!], 0n);
    edge.venue.publish(atEdge.commitment);
    expect(receiptStatus(edge.backing, edge.venue, receiptC, atEdge)).toBe("contradicted");
  });

  it("the era ends at a handover too: a predecessor's tail receipt reads lapsed against the successor's record", () => {
    const venue = new LocalVenue();
    const eur = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: { setting: "transparent", operator: KEYS.operator, silence: SILENCE, replacementRule: KEYS.backer },
    });
    const incumbent = new Sequencer(SECRETS.operator, venue);
    incumbent.register(eur, signBacking(SECRETS.backer, eur));
    issue(incumbent, eur, KEYS.alice, 100n, 0n);
    const before = served(incumbent); // at 0
    advanceWitnessedIndex(venue, 1n);
    const spend = transferOp(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    const tail = incumbent.submitTransfer(spend.op, spend.signature); // dies at the handover
    advanceWitnessedIndex(venue, 3n);
    venue.publishReplacement(eur.name, replacementBy(eur, SECRETS.backer, SUCCESSOR, eur.name, 3n));
    const successor = new Sequencer(SUCCESSOR_SECRET, venue);
    successor.register(eur, signBacking(SECRETS.backer, eur));
    successor.takeOver(eur, before);
    const theirs = served(successor); // at 3: force, and the record of note
    expect(eraLapsed(venue, eur, KEYS.operator, tail.after)).toBe(true);
    expect(receiptStatus(eur, venue, tail, theirs)).toBe("lapsed");
  });

  it("a fault pair proves inside a live era and nothing across a lapsed one — and silence laundering a real fault is the recorded residual", () => {
    // Live era, genuine double position: the operator receipts a second
    // operation into a position its log already gave away.
    const { venue, sequencer, backing } = setup();
    issue(sequencer, backing, KEYS.alice, 100n, 0n);
    const c0 = sequencer.commit(); // at 0
    const state0 = { snapshots: sequencer.snapshot(), commitment: c0 };
    advanceWitnessedIndex(venue, 1n);
    const spend = transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    const honest = sequencer.submitTransfer(spend.op, spend.signature); // position 1
    const conflicting = transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.carol, 10n, 1n);
    const lie = signReceipt(
      SECRETS.operator,
      backing.name,
      opHashOfEntry(backing.name, conflicting.published),
      honest.position,
      honest.after,
    );
    expect(isDoublePosition(backing, venue, state0, honest, lie)).toBe(true);
    // And the live-era double acceptance: two operations at one nonce, both
    // operator-receipted.
    const equivocation = transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.carol, 10n, 0n);
    const second = signReceipt(
      SECRETS.operator,
      backing.name,
      opHashOfEntry(backing.name, equivocation.published),
      5n,
      honest.after,
    );
    expect(
      isDoubleAcceptance(backing, venue, state0, { op: spend.published, receipt: honest }, { op: equivocation.published, receipt: second }),
    ).toBe(true);
    // The era lapses — the operator goes silent past the duration and returns —
    // and the SAME pairs prove nothing: a lapsed era dropped its tail with
    // license, so either receipt may describe a book the record rightly never
    // held. RECORDED RESIDUAL (DECISIONS, slice 28b): the real fault above is
    // laundered by the silence, at the price of the public aggravated grade;
    // the honest operator this excuse exists for is 28a's, whose dead tail
    // beside its adopted gap otherwise proved isDoublePosition against it.
    advanceWitnessedIndex(venue, 15n);
    const cr = sequencer.commit(); // the return closes the era with a gap
    const after = { snapshots: sequencer.snapshot(), commitment: cr };
    expect(eraLapsed(venue, backing, KEYS.operator, honest.after)).toBe(true);
    expect(isDoublePosition(backing, venue, after, honest, lie)).toBe(false);
    expect(
      isDoubleAcceptance(backing, venue, after, { op: spend.published, receipt: honest }, { op: equivocation.published, receipt: second }),
    ).toBe(false);
  });

  it("28a's honest operator is no longer its own fault proof: the dead tail beside the adopted gap reads as two eras, not one lie (audit B-4's shape)", () => {
    const { venue, sequencer, backing } = setup();
    issue(sequencer, backing, KEYS.alice, 100n, 0n);
    sequencer.commit(); // at 0
    advanceWitnessedIndex(venue, 1n);
    const spend = transferOp(backing, SECRETS.alice, KEYS.alice, KEYS.bob, 100n, 0n);
    const deadTail = sequencer.submitTransfer(spend.op, spend.signature); // nonce 0, dies
    // The gap: Alice demands the same units at the venue — her committed nonce 0.
    const claim = demandPublished(backing, SECRETS.alice, KEYS.alice, 100n, 11n, 70n, 0n);
    advanceWitnessedIndex(venue, 11n);
    venue.publishOp(backing.name, claim.published);
    advanceWitnessedIndex(venue, 15n);
    sequencer.commit(); // the return adopts the demand
    advanceWitnessedIndex(venue, 16n);
    // The adopted demand's receipt, by resubmitting its bytes.
    const adopted = sequencer.submitDemand(claim.op, claim.published.signature);
    // Two operations by one signer at one nonce, both operator-receipted — and
    // no fault: the transfer's era lapsed.
    const record = served(sequencer);
    expect(
      isDoubleAcceptance(backing, venue, record, { op: spend.published, receipt: deadTail }, { op: claim.published, receipt: adopted }),
    ).toBe(false);
    // The dead receipt itself reads lapsed, not contradicted.
    expect(receiptStatus(backing, venue, deadTail, record)).toBe("lapsed");
  });

  it("a carried era's lie is contradicted against the successor's record too: the handover does not launder what the operator's own commitment already owed", () => {
    // The operator co-signs a transfer, commits a log WITHOUT it inside the
    // duration (the era ends carried, the drop unlicensed), and is then
    // replaced. The successor's record is past the era's end, so the receipt
    // still reads contradicted — the era ended at the operator's own ordinary
    // commitment before the handover could excuse anything.
    const venue = new LocalVenue();
    const eur = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: { setting: "transparent", operator: KEYS.operator, silence: SILENCE, replacementRule: KEYS.backer },
    });
    const incumbent = new Sequencer(SECRETS.operator, venue);
    incumbent.register(eur, signBacking(SECRETS.backer, eur));
    issue(incumbent, eur, KEYS.alice, 100n, 0n);
    const spend = transferOp(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    const receipt = incumbent.submitTransfer(spend.op, spend.signature);
    const honest = incumbent.snapshot()[0]!.opLog;
    advanceWitnessedIndex(venue, 5n); // inside the duration: the era ends carried
    const shortened = commitLog(eur, [honest[0]!], 0n);
    venue.publish(shortened.commitment);
    advanceWitnessedIndex(venue, 8n);
    venue.publishReplacement(eur.name, replacementBy(eur, SECRETS.backer, SUCCESSOR, eur.name, 8n));
    const successor = new Sequencer(SUCCESSOR_SECRET, venue);
    successor.register(eur, signBacking(SECRETS.backer, eur));
    successor.takeOver(eur, shortened);
    const theirs = served(successor); // at 8
    expect(eraLapsed(venue, eur, KEYS.operator, receipt.after)).toBe(false);
    expect(receiptStatus(eur, venue, receipt, theirs)).toBe("contradicted");
  });

  it("an adopted gap leg's receipt is no excuse token: its operation carried, so a later lie at its position is still a fault", () => {
    // Found reviewing this slice: the first draft excused a receipt on its ERA
    // alone, and an adopted leg's receipt — signed in the era the return
    // closes, for an operation the return commitment CARRIES — became a
    // permanent excuse for lies at its position. The excuse is the absence:
    // a receipt the record reads witnessed excuses nothing.
    const { venue, sequencer, backing } = setup();
    issue(sequencer, backing, KEYS.alice, 100n, 0n);
    sequencer.commit(); // at 0
    const claim = demandPublished(backing, SECRETS.alice, KEYS.alice, 40n, 11n, 70n, 0n);
    advanceWitnessedIndex(venue, 11n);
    venue.publishOp(backing.name, claim.published);
    advanceWitnessedIndex(venue, 15n);
    const cr = sequencer.commit(); // the return adopts the demand
    const record = { snapshots: sequencer.snapshot(), commitment: cr };
    advanceWitnessedIndex(venue, 16n);
    const adopted = sequencer.submitDemand(claim.op, claim.published.signature); // the repeat: the adoption's receipt
    expect(adopted.after).toBe(0n); // signed in the era the return closed
    expect(receiptStatus(backing, venue, adopted, record)).toBe("witnessed");
    const lie = signReceipt(
      SECRETS.operator,
      backing.name,
      new Uint8Array(32).fill(0x66),
      adopted.position,
      15n, // the live era
    );
    expect(isDoublePosition(backing, venue, record, adopted, lie)).toBe(true);
  });
});
