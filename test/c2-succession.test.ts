import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { signCommitment, stateRoot } from "../src/commitment.js";
import {
  isAnOperator,
  operatorAt,
  operatorsOf,
  replacementHash,
  replacementMessage,
  ROLE_OPERATOR,
  type Replacement,
} from "../src/replacement.js";
import { isRewrittenHistory } from "../src/fault.js";
import { encodeIssuanceMessage, encodeTransferMessage } from "../src/messages.js";
import { receiptStatus } from "../src/receipt.js";
import { gapLegsFor, isOverdue, isSilent, snapshotRedemptions, stateIsAuthentic } from "../src/recovery.js";
import { demandHash, encodeAcceptance, encodeDemand, encodeLock, encodeRelease, encodeWithdrawal, NO_DECISION_VENUE } from "../src/presentation.js";
import { Sequencer, SequencerError } from "../src/sequencer.js";
import { LocalVenue, VenueError, type Venue } from "../src/venue.js";
import { KEYS, pub, SECRETS } from "./support.js";

// §C2, succession: "A replacement is itself a witnessed object. It is signed by
// whoever E's rule names, the backer by default, states the role, the successor
// and the effective index... Each replacement names its predecessor, so the
// chain from the original terms is walkable. Its effective index is no earlier
// than the index at which it is itself witnessed, and it takes effect only from
// the first index at which it has published its own commitment... Until then the
// predecessor's last commitment governs... From the effective index the old
// attester's co-signatures stop counting, which is why a wallet verifies the
// chain rather than the key it remembers."
//
// E's operator sits inside the name and invariant 1 forbids an edit, so a
// replacement does not change it — it supersedes it on a record anyone can walk.
// That is how the venue and the operator "move only under its replacement rule"
// while both stay inside the hash.
//
// **What this slice does NOT do:** let the successor serve. Registering,
// co-signing and adopting the predecessor's log are the successor's side of the
// handover, and they need the tail the predecessor left. The chain is declared,
// walkable, and read by the verifiers that ask who is in force; Sequencer still
// serves only the key E names. See DECISIONS.md.

const SILENCE = { noCommitmentDuration: 10n, challengeWindow: 5n };
const SUCCESSOR_SECRET = new Uint8Array(32).fill(0x0b);
const SUCCESSOR = pub(SUCCESSOR_SECRET);
const THIRD_SECRET = new Uint8Array(32).fill(0x0c);
const THIRD = pub(THIRD_SECRET);

/** A backing whose replacement rule is the backer's own key — §C2's default. */
function setup(replaceable = true) {
  const venue = new LocalVenue();
  const backing = makeBacking({
    obligor: KEYS.backer,
    payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
    reliance: [],
    evidence: {
      setting: "transparent",
      operator: KEYS.operator,
      silence: SILENCE,
      ...(replaceable ? { replacementRule: KEYS.backer } : {}),
    },
  });
  return { venue, backing };
}

function replacementBy(
  backing: Backing,
  ruleSecret: Uint8Array,
  successor: Uint8Array,
  predecessor: Uint8Array,
  effective: bigint,
): Replacement {
  const unsigned = {
    role: ROLE_OPERATOR,
    successor,
    predecessor,
    effective,
    signature: new Uint8Array(64),
  };
  const signature = ed25519.sign(replacementMessage(backing.name, unsigned), ruleSecret);
  return { ...unsigned, signature };
}

/** Put a commitment from `secret` at the venue — what gives a successor force. */
function commitAs(venue: LocalVenue, secret: Uint8Array): void {
  const operator = ed25519.getPublicKey(secret);
  venue.publish(signCommitment(secret, venue.nextSequenceFor(operator), stateRoot([])));
}

function at(venue: LocalVenue, index: bigint): void {
  const now = venue.witnessedIndex();
  if (index > now) venue.advance(index - now);
}

describe("§C2: the chain from the original terms is walkable", () => {
  it("starts at the key E names, and stays there with no replacement", () => {
    const { venue, backing } = setup();
    expect(operatorsOf(backing, venue)).toHaveLength(1);
    expect(operatorAt(backing, venue, 0n)).toEqual(KEYS.operator);
    expect(operatorAt(backing, venue, 10_000n)).toEqual(KEYS.operator);
  });

  it("hands over at the later of the effective index and the successor's first commitment", () => {
    // §C2's two-stage rule. Declaring an index does not hand anything over; the
    // successor must have published a commitment of its own.
    const { venue, backing } = setup();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR, backing.name, 10n));
    at(venue, 10n);
    // Effective index reached, but the successor has committed nothing.
    expect(operatorAt(backing, venue, 10n)).toEqual(KEYS.operator);
    at(venue, 20n);
    commitAs(venue, SUCCESSOR_SECRET);
    expect(operatorAt(backing, venue, 19n)).toEqual(KEYS.operator);
    expect(operatorAt(backing, venue, 20n)).toEqual(SUCCESSOR);
  });

  it("ignores a successor commitment made before anyone named it", () => {
    // Otherwise the second stage means nothing for a successor that already
    // operates something else: it would arrive already in force.
    const { venue, backing } = setup();
    commitAs(venue, SUCCESSOR_SECRET);
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR, backing.name, 10n));
    at(venue, 10n);
    expect(operatorAt(backing, venue, 10n)).toEqual(KEYS.operator);
    // A fresh one, after the handover was witnessed, is the one §C2 asks for.
    commitAs(venue, SUCCESSOR_SECRET);
    expect(operatorAt(backing, venue, 10n)).toEqual(SUCCESSOR);
  });

  it("walks a chain of two handovers", () => {
    const { venue, backing } = setup();
    const first = replacementBy(backing, SECRETS.backer, SUCCESSOR, backing.name, 5n);
    at(venue, 5n);
    venue.publishReplacement(backing.name, first);
    commitAs(venue, SUCCESSOR_SECRET);
    at(venue, 20n);
    venue.publishReplacement(
      backing.name,
      replacementBy(backing, SECRETS.backer, THIRD, replacementHash(backing.name, first), 20n),
    );
    commitAs(venue, THIRD_SECRET);

    expect(operatorsOf(backing, venue)).toHaveLength(3);
    expect(operatorAt(backing, venue, 4n)).toEqual(KEYS.operator);
    expect(operatorAt(backing, venue, 19n)).toEqual(SUCCESSOR);
    expect(operatorAt(backing, venue, 20n)).toEqual(THIRD);
    expect(isAnOperator(backing, venue, KEYS.operator)).toBe(true);
    expect(isAnOperator(backing, venue, THIRD)).toBe(true);
    expect(isAnOperator(backing, venue, KEYS.mallory)).toBe(false);
  });
});

describe("§C2: a replacement counts only on the terms E set", () => {
  it("counts nothing where E declares no replacement rule", () => {
    // §C2b: "Whether a sequencer can be replaced at all is answered in E."
    const { venue, backing } = setup(false);
    const replaceable = setup(true).backing;
    // Signed correctly for the OTHER backing's rule, and published here.
    venue.publishReplacement(
      backing.name,
      replacementBy(replaceable, SECRETS.backer, SUCCESSOR, replaceable.name, 0n),
    );
    commitAs(venue, SUCCESSOR_SECRET);
    at(venue, 10n);
    expect(operatorAt(backing, venue, 10n)).toEqual(KEYS.operator);
  });

  it("ignores a replacement signed by anyone but the rule's key", () => {
    const { venue, backing } = setup();
    venue.publishReplacement(
      backing.name,
      replacementBy(backing, SECRETS.mallory, SUCCESSOR, backing.name, 0n),
    );
    commitAs(venue, SUCCESSOR_SECRET);
    at(venue, 10n);
    expect(operatorAt(backing, venue, 10n)).toEqual(KEYS.operator);
  });

  it("ignores a replacement that names the wrong predecessor", () => {
    // The chain is hash-linked, so a link that attaches to nothing is not a
    // link. Walking backwards from any replacement reaches the original terms
    // or nothing at all.
    const { venue, backing } = setup();
    venue.publishReplacement(
      backing.name,
      replacementBy(backing, SECRETS.backer, SUCCESSOR, new Uint8Array(32).fill(0xee), 0n),
    );
    commitAs(venue, SUCCESSOR_SECRET);
    at(venue, 10n);
    expect(operatorAt(backing, venue, 10n)).toEqual(KEYS.operator);
  });

  it("refuses a replacement effective before it was itself witnessed", () => {
    // §C2: "Its effective index is no earlier than the index at which it is
    // itself witnessed." The rule-holder does not get to backdate a handover,
    // which would put two operators in force at one past index.
    const { venue, backing } = setup();
    at(venue, 50n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR, backing.name, 49n));
    commitAs(venue, SUCCESSOR_SECRET);
    at(venue, 60n);
    expect(operatorAt(backing, venue, 60n)).toEqual(KEYS.operator);
  });

  it("refuses a handover to the incumbent itself", () => {
    const { venue, backing } = setup();
    at(venue, 5n);
    venue.publishReplacement(
      backing.name,
      replacementBy(backing, SECRETS.backer, KEYS.operator, backing.name, 5n),
    );
    commitAs(venue, SECRETS.operator);
    at(venue, 10n);
    expect(operatorsOf(backing, venue)).toHaveLength(1);
  });

  it("takes the earliest witnessed where the rule-holder signed two successors", () => {
    // Two replacements naming one predecessor are the rule-holder choosing
    // twice, and the one it published first is the one it chose first —
    // witnessing pins order (§C2), the rule two requests at one nonce follow.
    const { venue, backing } = setup();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR, backing.name, 5n));
    at(venue, 6n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, THIRD, backing.name, 6n));
    commitAs(venue, SUCCESSOR_SECRET);
    commitAs(venue, THIRD_SECRET);
    at(venue, 20n);
    expect(operatorAt(backing, venue, 20n)).toEqual(SUCCESSOR);
  });
});

describe("§C2: the grade follows the incumbent", () => {
  it("measures silence on the operator in force, not the key E names", () => {
    const { venue, backing } = setup();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR, backing.name, 5n));
    commitAs(venue, SUCCESSOR_SECRET);
    // The genesis operator has published nothing at all and would be silent;
    // the successor just committed, so the backing is not.
    expect(operatorAt(backing, venue, venue.witnessedIndex())).toEqual(SUCCESSOR);
    expect(isSilent(venue, backing)).toBe(false);
    expect(isOverdue(venue, backing)).toBe(false);
  });

  it("grades the successor once IT goes quiet", () => {
    const { venue, backing } = setup();
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR, backing.name, 5n));
    commitAs(venue, SUCCESSOR_SECRET);
    at(venue, 5n + SILENCE.noCommitmentDuration + 1n);
    expect(operatorAt(backing, venue, venue.witnessedIndex())).toEqual(SUCCESSOR);
    expect(isSilent(venue, backing)).toBe(true);
  });
});

describe("§C2: the venue records a replacement and judges nothing", () => {
  it("refuses a replacement whose bytes do not encode", () => {
    const { venue, backing } = setup();
    expect(() =>
      venue.publishReplacement(backing.name, {
        role: ROLE_OPERATOR,
        successor: new Uint8Array(31),
        predecessor: backing.name,
        effective: 0n,
        signature: new Uint8Array(64),
      }),
    ).toThrow(VenueError);
    expect(venue.replacementsFor(backing.name)).toHaveLength(0);
  });

  it("hands out copies, in and out", () => {
    // Its own copy of the key, because this test mutates what it hands over and
    // SUCCESSOR is shared across the file.
    const { venue, backing } = setup();
    const published = replacementBy(backing, SECRETS.backer, Uint8Array.from(SUCCESSOR), backing.name, 0n);
    venue.publishReplacement(backing.name, published);
    published.successor.fill(0xff);
    const first = venue.replacementsFor(backing.name)[0]!.replacement;
    expect(first.successor).toEqual(SUCCESSOR);
    first.successor.fill(0xff);
    expect(venue.replacementsFor(backing.name)[0]!.replacement.successor).toEqual(SUCCESSOR);
  });

  it("leaves a successor that has never committed out of the chain", () => {
    const { venue, backing } = setup();
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR, backing.name, 0n));
    // Published, signed by the rule, effective now — and still not in force,
    // because §C2 gives it force only from its own first commitment.
    expect(venue.replacementsFor(backing.name)).toHaveLength(1);
    expect(operatorAt(backing, venue, 0n)).toEqual(KEYS.operator);
    expect(isAnOperator(backing, venue, SUCCESSOR)).toBe(false);
  });
});

describe("§C2: a successor serves, and only once it is in force", () => {
  /** The incumbent, holding Alice's 100 with 40 already moved to Bob. */
  function incumbentServing(venue: LocalVenue, backing: Backing) {
    const server = new Sequencer(SECRETS.operator, venue);
    server.register(backing, signBacking(SECRETS.backer, backing));
    const issue = { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n };
    const issued = server.submitIssue(
      issue,
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    server.submitTransfer(
      { backing, from: KEYS.alice, to: KEYS.bob, quantity: 40n, nonce: 0n },
      ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, KEYS.bob, 40n, 0n), SECRETS.alice),
    );
    return { server, issued, served: { snapshots: server.snapshot(), commitment: server.commit() } };
  }

  function handedOver() {
    const { venue, backing } = setup();
    const incumbent = incumbentServing(venue, backing);
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR, backing.name, 5n));
    const successor = new Sequencer(SUCCESSOR_SECRET, venue);
    successor.register(backing, signBacking(SECRETS.backer, backing));
    return { venue, backing, incumbent, successor };
  }

  it("lets a named successor serve before it is in force, and refuses its receipts", () => {
    // §C2's two stages have a gap somebody has to live in: force comes from the
    // successor's own first commitment, and it cannot commit a state it was
    // never allowed to take on. So it may serve, and "no new co-signatures
    // issue" until it is in force.
    const { venue, backing, incumbent, successor } = handedOver();
    expect(operatorAt(backing, venue, venue.witnessedIndex())).toEqual(KEYS.operator);
    successor.takeOver(backing, incumbent.served);
    expect(() =>
      successor.submitTransfer(
        { backing, from: KEYS.alice, to: KEYS.carol, quantity: 10n, nonce: 1n },
        ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, KEYS.carol, 10n, 1n), SECRETS.alice),
      ),
    ).toThrow(SequencerError);
  });

  it("takes force on its own first commitment, carrying the state it took over", () => {
    const { venue, backing, incumbent, successor } = handedOver();
    successor.takeOver(backing, incumbent.served);
    successor.commit();

    expect(operatorAt(backing, venue, venue.witnessedIndex())).toEqual(SUCCESSOR);
    expect(successor.balance(backing, KEYS.alice)).toBe(60n);
    expect(successor.balance(backing, KEYS.bob)).toBe(40n);
    expect(successor.outstanding(backing)).toBe(100n);
    // And it serves: the next operation is the claimant's next nonce, on the
    // state the predecessor left.
    const receipt = successor.submitTransfer(
      { backing, from: KEYS.alice, to: KEYS.carol, quantity: 10n, nonce: 1n },
      ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, KEYS.carol, 10n, 1n), SECRETS.alice),
    );
    expect(receipt.position).toBe(2n);
  });

  it("stops the predecessor co-signing once the handover has happened", () => {
    // "From the effective index the old attester's co-signatures stop counting."
    // Refused at the source as well as discounted by a reader.
    const { venue, backing, incumbent, successor } = handedOver();
    successor.takeOver(backing, incumbent.served);
    successor.commit();
    expect(operatorAt(backing, venue, venue.witnessedIndex())).toEqual(SUCCESSOR);
    expect(() =>
      incumbent.server.submitTransfer(
        { backing, from: KEYS.alice, to: KEYS.carol, quantity: 10n, nonce: 1n },
        ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, KEYS.carol, 10n, 1n), SECRETS.alice),
      ),
    ).toThrow(SequencerError);
  });

  it("keeps the predecessor's receipts good against both committed states", () => {
    // A receipt records an operation and a position and never when it was
    // signed, so a retired operator's co-signature over an operation its own log
    // really held stays evidence of what it accepted. And the successor's log
    // holds the same entries at the same positions, because it took them on.
    const { venue, backing, incumbent, successor } = handedOver();
    successor.takeOver(backing, incumbent.served);
    successor.commit();
    const theirs = { snapshots: successor.snapshot(), commitment: venue.latestFor(SUCCESSOR)! };

    expect(receiptStatus(backing, venue, incumbent.issued, incumbent.served)).toBe("witnessed");
    expect(receiptStatus(backing, venue, incumbent.issued, theirs)).toBe("witnessed");
    expect(stateIsAuthentic(backing, venue, theirs)).toBe(true);
  });

  it("reads an honest handover as no rewritten history", () => {
    // The successor's log starts where the predecessor's committed state left
    // off, so comparing across a handover must not report a takeover as a
    // rewrite — which is why the predicate is about one operator's own history.
    const { venue, backing, incumbent, successor } = handedOver();
    successor.takeOver(backing, incumbent.served);
    successor.commit();
    const theirs = { snapshots: successor.snapshot(), commitment: venue.latestFor(SUCCESSOR)! };
    expect(isRewrittenHistory(backing, venue, incumbent.served, theirs)).toBe(false);
  });

  it("refuses a takeover of anything but the incumbent's latest committed state", () => {
    const { venue, backing, incumbent, successor } = handedOver();
    // A state nobody committed.
    expect(() =>
      successor.takeOver(backing, {
        snapshots: incumbent.served.snapshots,
        commitment: signCommitment(SECRETS.mallory, 0n, stateRoot(incumbent.served.snapshots)),
      }),
    ).toThrow(SequencerError);
    // And once in force, there is nothing left to take over.
    successor.takeOver(backing, incumbent.served);
    successor.commit();
    expect(() => successor.takeOver(backing, incumbent.served)).toThrow(SequencerError);
  });

  it("refuses a sequencer that is neither in force nor named", () => {
    const { venue, backing } = setup();
    const stranger = new Sequencer(THIRD_SECRET, venue);
    expect(() => stranger.register(backing, signBacking(SECRETS.backer, backing))).toThrow(
      SequencerError,
    );
  });
});

describe("§C2: a successor that does not serve the state in full", () => {
  it("is a rewritten history, even though the log is not its own", () => {
    // §C2 gives a successor force only over a state "it serves in full". A
    // successor committing a shorter log than the predecessor's is the same
    // fault by the party the chain just handed the backing to — so the
    // predicate has to reach across a handover, and the chain is what orders
    // the two states, since a sequence is an operator's own count.
    const { venue, backing } = setup();
    const incumbent = new Sequencer(SECRETS.operator, venue);
    incumbent.register(backing, signBacking(SECRETS.backer, backing));
    incumbent.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    const served = { snapshots: incumbent.snapshot(), commitment: incumbent.commit() };

    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR, backing.name, 5n));
    // The successor commits an EMPTY log for this backing rather than the one
    // it was handed, and takes force on it.
    const dropped = [{ name: backing.name, opLog: [] }];
    const theirs = {
      snapshots: dropped,
      commitment: signCommitment(SUCCESSOR_SECRET, 0n, stateRoot(dropped)),
    };
    venue.publish(theirs.commitment);

    expect(operatorAt(backing, venue, venue.witnessedIndex())).toEqual(SUCCESSOR);
    expect(isRewrittenHistory(backing, venue, served, theirs)).toBe(true);
    expect(isRewrittenHistory(backing, venue, theirs, served)).toBe(true);
  });
});

describe("§C2: a takeover is all or nothing", () => {
  it("refuses a committed state that is not a history that could have happened", () => {
    // committedLogFor checks the root and the signature and does not replay the
    // law. Applied entry by entry, a well-rooted log that goes wrong part-way
    // would leave a truncated state this operator then commits — which is the
    // fault isRewrittenHistory watches a handover for, committed by the party
    // that was handed the backing.
    const { venue, backing } = setup();
    const incumbent = new Sequencer(SECRETS.operator, venue);
    incumbent.register(backing, signBacking(SECRETS.backer, backing));
    incumbent.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    const honest = incumbent.snapshot()[0]!;
    // A second entry the law would refuse: Alice spending more than she holds.
    const overspend = {
      kind: "transfer" as const,
      from: KEYS.alice,
      to: KEYS.bob,
      quantity: 500n,
      nonce: 0n,
      position: 1,
      signature: ed25519.sign(
        encodeTransferMessage(backing.name, KEYS.alice, KEYS.bob, 500n, 0n),
        SECRETS.alice,
      ),
    };
    const snapshots = [{ name: backing.name, opLog: [honest.opLog[0]!, overspend] }];
    const rooted = {
      snapshots,
      commitment: signCommitment(SECRETS.operator, venue.nextSequenceFor(KEYS.operator), stateRoot(snapshots)),
    };
    venue.publish(rooted.commitment);

    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR, backing.name, 5n));
    const successor = new Sequencer(SUCCESSOR_SECRET, venue);
    successor.register(backing, signBacking(SECRETS.backer, backing));

    expect(() => successor.takeOver(backing, rooted)).toThrow(SequencerError);
    // And nothing of it stuck, so an honest state can still be taken over.
    expect(successor.opLog(backing)).toHaveLength(0);
  });
});

describe("§C2: a retired operator still answers a repeat, and refuses a new act", () => {
  it("a lock it co-signed before the handover is answered with its receipt afterwards; a fresh lock is refused", () => {
    // A repeat is a read of the receipt book, not an act: the co-signature was
    // given while the operator was in force, and the successor cannot produce
    // it — so refusing to re-serve it would deny the payee the only evidence of
    // what happened (invariant 26; CLAUDE.md's receipt rule). "No new
    // co-signatures issue" is about acts, which `ready` refuses. Slice 27's
    // review first put the in-force check ahead of the repeat and then reversed
    // it, for this reason.
    const { venue, backing } = setup();
    const incumbent = new Sequencer(SECRETS.operator, venue);
    incumbent.register(backing, signBacking(SECRETS.backer, backing));
    incumbent.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    const lock = {
      backing,
      attemptId: new Uint8Array(32).fill(0x4e),
      holder: KEYS.alice,
      beneficiary: KEYS.bob,
      quantity: 10n,
      timeout: 500n,
      decisionVenue: venue.id,
      parties: [KEYS.alice],
      nonce: 0n,
    };
    const signature = ed25519.sign(encodeLock(lock), SECRETS.alice);
    const receipt = incumbent.submitLock(lock, signature);
    const served = { snapshots: incumbent.snapshot(), commitment: incumbent.commit() };
    at(venue, 5n);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR, backing.name, 5n));
    const successor = new Sequencer(SUCCESSOR_SECRET, venue);
    successor.register(backing, signBacking(SECRETS.backer, backing));
    successor.takeOver(backing, served);
    successor.commit();
    expect(operatorAt(backing, venue, venue.witnessedIndex())).toEqual(SUCCESSOR);
    // The repeat: the same receipt, from the retired operator's own book.
    expect(incumbent.submitLock(lock, signature)).toEqual(receipt);
    // A new act: refused.
    const fresh = { ...lock, attemptId: new Uint8Array(32).fill(0x4f), nonce: 1n };
    expect(() => incumbent.submitLock(fresh, ed25519.sign(encodeLock(fresh), SECRETS.alice))).toThrow(/not yet in force/);
  });
});

describe("§C2: a publication is judged against the record that governed at its index", () => {
  // Found by the 2026-08-22 audit. Both gap readers asked for the operator in
  // force AT the publication's index and then looked strictly BEFORE it — so at
  // the index a successor takes force it had nothing before, the quiet time
  // read from the venue's genesis, and an orderly handover opened one gap index
  // in which the operator adopted legs no verifier could resolve. The operator
  // in force just before the index is whose record governed: "Until then the
  // predecessor's last commitment governs."
  function punctualThenHandedOver(lastCommit: bigint, handoverAt: bigint) {
    const { venue, backing } = setup();
    const incumbent = new Sequencer(SECRETS.operator, venue);
    incumbent.register(backing, signBacking(SECRETS.backer, backing));
    incumbent.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    let served = { snapshots: incumbent.snapshot(), commitment: incumbent.commit() };
    for (let i = 5n; i <= lastCommit; i += 5n) {
      at(venue, i);
      served = { snapshots: incumbent.snapshot(), commitment: incumbent.commit() };
    }
    at(venue, handoverAt);
    venue.publishReplacement(backing.name, replacementBy(backing, SECRETS.backer, SUCCESSOR, backing.name, handoverAt));
    const successor = new Sequencer(SUCCESSOR_SECRET, venue);
    successor.register(backing, signBacking(SECRETS.backer, backing));
    successor.takeOver(backing, served);
    successor.commit();
    expect(operatorAt(backing, venue, handoverAt)).toEqual(SUCCESSOR);
    return { venue, backing, served, successor };
  }
  const legsAt = (venue: LocalVenue, backing: Backing, index: bigint) => {
    const demand = { backing, holder: KEYS.alice, quantity: 40n, instant: index, deadline: index + 50n, nonce: 0n };
    venue.publishOp(backing.name, {
      kind: "demand",
      holder: demand.holder,
      quantity: demand.quantity,
      instant: demand.instant,
      deadline: demand.deadline,
      nonce: demand.nonce,
      signature: ed25519.sign(encodeDemand(demand), SECRETS.alice),
    });
    return demandHash(demand);
  };

  it("an orderly handover from a punctual operator opens no gap at the successor's force index", () => {
    const { venue, backing, successor } = punctualThenHandedOver(30n, 31n);
    legsAt(venue, backing, 31n);
    expect(isSilent(venue, backing)).toBe(false);
    expect(gapLegsFor(venue, backing)).toEqual([]);
    successor.commit();
    expect(successor.openDemands(backing)).toHaveLength(0);
  });

  it("legs published at the force index of a successor to a SILENT predecessor resolve against the predecessor's last snapshot, for the verifier as for the operator", () => {
    const { venue, backing, served, successor } = punctualThenHandedOver(0n, 20n);
    const hash = legsAt(venue, backing, 20n);
    // The backer's nonce 0 went on the issuance; its answer is its next.
    const answer = { backing, demandHash: hash, instant: 20n, deadline: 60n, nonce: 1n };
    venue.publishOp(backing.name, {
      kind: "acceptance",
      demandHash: hash,
      instant: answer.instant,
      deadline: answer.deadline,
      nonce: answer.nonce,
      signature: ed25519.sign(encodeAcceptance(answer), SECRETS.backer),
    });
    const settle = { backing, demandHash: hash, nonce: 1n };
    venue.publishOp(backing.name, {
      kind: "release",
      demandHash: hash,
      nonce: settle.nonce,
      signature: ed25519.sign(encodeRelease(settle), SECRETS.alice),
    });
    // The verifier, against the predecessor's last commitment — the record that governed.
    expect(snapshotRedemptions(venue, backing, served)).toHaveLength(1);
    // The operator, adopting.
    successor.commit();
    expect(successor.balance(backing, KEYS.backer)).toBe(40n);
    expect(successor.openDemands(backing)).toHaveLength(0);
  });
});

describe("§C2: what a door asks of a backing it touches, and of one it only reads", () => {
  it("a filing is not refused for the operator's force on the PAYING backing, which the filing never touches", () => {
    // Found regression-reviewing slice 27: readying every slot backing at filing
    // asked in-force of the paying backing — handed to a successor, and only
    // it — and refused an honest filing the never-served operator would take.
    // The paying lock arrives at the acceptance; the filing only reads the slot.
    const { venue, backing: gold } = setup();
    const eur = makeBacking({
      obligor: KEYS.backer,
      payout: { backing: gold.name, perUnit: 2n },
      reliance: [],
      evidence: { setting: "transparent", operator: KEYS.operator, silence: SILENCE, replacementRule: KEYS.backer },
    });
    const incumbent = new Sequencer(SECRETS.operator, venue);
    for (const b of [gold, eur]) incumbent.register(b, signBacking(SECRETS.backer, b));
    incumbent.submitIssue(
      { backing: eur, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(eur.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    incumbent.commit();
    // GOLD, and only GOLD, goes to a successor that takes force.
    at(venue, 5n);
    venue.publishReplacement(gold.name, replacementBy(gold, SECRETS.backer, SUCCESSOR, gold.name, 5n));
    commitAs(venue, SUCCESSOR_SECRET);
    expect(operatorAt(gold, venue, venue.witnessedIndex())).toEqual(SUCCESSOR);
    expect(operatorAt(eur, venue, venue.witnessedIndex())).toEqual(KEYS.operator);
    const demand = { backing: eur, holder: KEYS.alice, quantity: 40n, instant: 0n, deadline: 100n, nonce: 0n };
    incumbent.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice));
    expect(incumbent.openDemands(eur)).toHaveLength(1);
  });

  it("a successor refuses to take over a state carrying a lock on a decision venue it does not watch", () => {
    // Found reviewing the audit slice: taken over, such a lock made the successor
    // refuse at every door forever — adoption asked a record that was not the
    // lock's. The gate asks this of every lock it prepares; takeOver is the one
    // other path that applies many operations.
    const { venue, backing } = setup();
    const other = new LocalVenue(new Uint8Array(32).fill(0x6c));
    const incumbent = new Sequencer(SECRETS.operator, venue);
    incumbent.register(backing, signBacking(SECRETS.backer, backing));
    incumbent.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    const lock = { backing, attemptId: new Uint8Array(32).fill(0x3a), holder: KEYS.alice, beneficiary: KEYS.bob, quantity: 10n, timeout: 500n, decisionVenue: venue.id, parties: [KEYS.alice], nonce: 0n };
    incumbent.submitLock(lock, ed25519.sign(encodeLock(lock), SECRETS.alice));
    const served = { snapshots: incumbent.snapshot(), commitment: incumbent.commit() };
    other.publish(served.commitment);
    at(venue, 5n); at(other, 5n);
    const replacement = replacementBy(backing, SECRETS.backer, SUCCESSOR, backing.name, 5n);
    venue.publishReplacement(backing.name, replacement);
    other.publishReplacement(backing.name, replacement);
    // On the venue the lock names: fine. On another: refused, in the sequencer's voice.
    const onVenue = new Sequencer(SUCCESSOR_SECRET, venue);
    onVenue.register(backing, signBacking(SECRETS.backer, backing));
    onVenue.takeOver(backing, served);
    const onOther = new Sequencer(SUCCESSOR_SECRET, other);
    onOther.register(backing, signBacking(SECRETS.backer, backing));
    expect(() => onOther.takeOver(backing, served)).toThrow(/does not watch/);
  });
});

describe("§C2: a re-prepare is written against the demanded backing's record, so that record must be this operator's", () => {
  it("a handed-over operator reading its stale record refuses to re-prepare under a demand the successor now holds", () => {
    // Found in the audit slice's last regression pass: caught up but not asked
    // in-force of the demanded backing, the old operator took a lock under a
    // demand the successor had ended, reading its own stale record.
    const { venue, backing: gold } = setup();
    const eur = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
      reliance: [{ target: gold.name, count: 2n }],
      evidence: { setting: "transparent", operator: KEYS.operator, silence: SILENCE, replacementRule: KEYS.backer },
    });
    const old = new Sequencer(SECRETS.operator, venue);
    for (const b of [gold, eur]) {
      old.register(b, signBacking(SECRETS.backer, b));
      old.submitIssue(
        { backing: b, recipient: KEYS.alice, quantity: 200n, nonce: 0n },
        ed25519.sign(encodeIssuanceMessage(b.name, KEYS.alice, 200n, 0n), SECRETS.backer),
      );
    }
    const demand = { backing: eur, holder: KEYS.alice, quantity: 40n, instant: 0n, deadline: 100n, nonce: 0n };
    const hash = demandHash(demand);
    const leg = { backing: gold, attemptId: hash, holder: KEYS.alice, beneficiary: KEYS.backer, quantity: 80n, timeout: 10n, decisionVenue: NO_DECISION_VENUE, parties: [KEYS.alice], nonce: 0n };
    old.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice), [{ op: leg, signature: ed25519.sign(encodeLock(leg), SECRETS.alice) }]);
    old.commit();
    // EUR — and only EUR — goes to a successor, which takes force.
    at(venue, 20n);
    venue.publishReplacement(eur.name, replacementBy(eur, SECRETS.backer, SUCCESSOR, eur.name, 20n));
    commitAs(venue, SUCCESSOR_SECRET);
    expect(operatorAt(eur, venue, venue.witnessedIndex())).toEqual(SUCCESSOR);
    // The lapsed leg is withdrawn at the old operator (still GOLD's).
    const out = { backing: gold, demandHash: hash, nonce: 1n };
    old.submitWithdrawal(out, ed25519.sign(encodeWithdrawal(out), SECRETS.alice));
    // Re-preparing under the demand at the old operator: refused — EUR is not its to read.
    const again = { ...leg, timeout: 500n, nonce: 2n };
    expect(() => old.submitLeg(eur, hash, { op: again, signature: ed25519.sign(encodeLock(again), SECRETS.alice) })).toThrow(/not yet in force/);
    expect(old.availableBalance(gold, KEYS.alice)).toBe(200n);
  });
});
