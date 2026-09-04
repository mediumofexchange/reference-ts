import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { signBacking, type Backing } from "../src/backing.js";
import { compareBytes } from "../src/bytes.js";
import { signCommitment, stateRoot, type ServedState } from "../src/commitment.js";
import { isRewrittenHistory } from "../src/fault.js";
import { encodeIssuanceMessage, encodeTransferMessage } from "../src/messages.js";
import { type OpLogEntry, type PublishedOp } from "../src/oplog.js";
import { receiptStatus, type Receipt } from "../src/receipt.js";
import { Sequencer } from "../src/sequencer.js";
import { LocalVenue, type Venue } from "../src/venue.js";
import { KEYS, makeTransparentBacking, SECRETS } from "./support.js";

// §C2's receipts, and invariant 22, from the holder's side.
//
// CLAUDE.md now carries the rule this file makes usable: **a payment is final
// when witnessed, not when co-signed.** §C2: "Finality means witnessed rather
// than co-signed"; §C3 applies it to the release, "a release nobody witnessed
// did not happen". A payee holding a receipt therefore has a question to ask,
// and it has more than two answers:
//
//   witnessed     the committed log holds this operation at this position.
//   pending       the record has not reached it: the era the receipt names is
//                 still open, or this state predates its end.
//   lapsed        the era ended in a return or a handover, so the operation
//                 died unwitnessed with the tail it sat in (28b; the era tests
//                 live in c2b-receipt-era).
//   contradicted  the record is past the era's end, or already held the
//                 position otherwise: a lie about the operator's own log.
//   dropped       the operator's committed state carries no log for this
//                 backing at all (see c2-dropped-backing).
//   unrelated     not this backing's operator's receipt, not its state, or an
//                 era its record never had.
//
// "Unrelated" exists because a proof that accuses must not accuse the wrong
// party — the finding slice 9 made twice. Answering "contradicted" for a
// stranger's receipt is exactly that bug.
//
// Since 28b the receipt names its era — since slice 39, one more than the
// sequence of the operator's last SIGNED commitment — so a stale restore — a
// SHORTER log committed at
// an era's ordinary end — is caught by the receipt on one state, where before
// only isRewrittenHistory's pair of commitments could see it.

function setup() {
  const venue = new LocalVenue();
  const sequencer = new Sequencer(SECRETS.operator, venue);
  const backing = makeTransparentBacking(SECRETS.backer);
  sequencer.register(backing, signBacking(SECRETS.backer, backing));
  return { venue, sequencer, backing };
}

/** Issue 100 to Alice (position 0), then move 40 to Bob (position 1). */
function twoOperations(sequencer: Sequencer, backing: Backing) {
  const issue = { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n };
  const issueReceipt = sequencer.submitIssue(
    issue,
    ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
  );
  const move = { backing, from: KEYS.alice, to: KEYS.bob, quantity: 40n, nonce: 0n };
  const moveReceipt = sequencer.submitTransfer(
    move,
    ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, KEYS.bob, 40n, 0n), SECRETS.alice),
  );
  return { issueReceipt, moveReceipt };
}

/**
 * A state this operator really committed: whatever log we hand it, rooted and
 * signed with its own key. Not published — these predicates read served states
 * rather than the venue, and the venue would refuse a sequence that does not
 * extend, which is a rule about publishing rather than about the fault.
 */
function commitLog(
  backing: Backing,
  opLog: readonly OpLogEntry[],
  sequence: bigint,
): ServedState {
  const snapshots = [{ name: backing.name, opLog }];
  return { snapshots, commitment: signCommitment(SECRETS.operator, sequence, stateRoot(snapshots)) };
}

/** A transfer of `quantity` to Carol, as an entry that could sit at `position`. */
function otherEntry(backing: Backing, position: number, nonce: bigint): OpLogEntry {
  const op: PublishedOp = {
    kind: "transfer",
    from: KEYS.alice,
    to: KEYS.carol,
    quantity: 10n,
    nonce,
    signature: ed25519.sign(
      encodeTransferMessage(backing.name, KEYS.alice, KEYS.carol, 10n, nonce),
      SECRETS.alice,
    ),
  };
  return { ...op, position };
}

describe("§C2: a receipt's fate — witnessed, pending, lapsed, or contradicted", () => {
  it("reads witnessed once the operation is in a committed log", () => {
    const { venue, sequencer, backing } = setup();
    const { moveReceipt } = twoOperations(sequencer, backing);
    const served = sequencer.commit();
    expect(receiptStatus(backing, venue, moveReceipt, served)).toBe("witnessed");
  });

  it("reads pending while the operation is co-signed and not yet committed", () => {
    // The §C2b gap in miniature: the operator accepted it, and nothing outside
    // its own unpublished log says so. This is the state a payee must not read
    // as settled.
    const { venue, sequencer, backing } = setup();
    const served = sequencer.commit();
    const { moveReceipt } = twoOperations(sequencer, backing);
    expect(receiptStatus(backing, venue, moveReceipt, served)).toBe("pending");
  });

  it("stays witnessed against an older commitment, because a log only grows", () => {
    // Unlike provesHolding, "latest" is not load-bearing here: positions are
    // pinned and the log is append-only, so once witnessed, always witnessed.
    // A holding can be spent afterwards; an accepted operation cannot un-happen.
    const { venue, sequencer, backing } = setup();
    const { issueReceipt } = twoOperations(sequencer, backing);
    const early = sequencer.commit();
    venue.advance(1n); // one commitment per witnessed index (28b: eras end legibly)
    const move = { backing, from: KEYS.alice, to: KEYS.carol, quantity: 5n, nonce: 1n };
    sequencer.submitTransfer(
      move,
      ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, KEYS.carol, 5n, 1n), SECRETS.alice),
    );
    const late = sequencer.commit();
    expect(receiptStatus(backing, venue, issueReceipt, early)).toBe("witnessed");
    expect(receiptStatus(backing, venue, issueReceipt, late)).toBe("witnessed");
  });

  it("reads contradicted where the committed log holds something else there", () => {
    // The operator co-signed one operation into position 1 and committed
    // another. One of its two signatures is a lie about its own log, and any
    // stranger holding both can say so.
    const { venue, sequencer, backing } = setup();
    const { issueReceipt, moveReceipt } = twoOperations(sequencer, backing);
    const honest = sequencer.snapshot()[0]!;
    const rewritten = commitLog(backing,
      [honest.opLog[0]!, otherEntry(backing, 1, 0n)],
      0n,
    );
    expect(receiptStatus(backing, venue, issueReceipt, rewritten)).toBe("witnessed");
    expect(receiptStatus(backing, venue, moveReceipt, rewritten)).toBe("contradicted");
  });

  it("reads contradicted where the log was shortened at the era's end: a stale restore turns the operator's own receipt against it", () => {
    // Before 28b this read "pending": a receipt for a position the log never
    // reached could not tell "not yet" from "taken back", and only
    // isRewrittenHistory — needing two states — could. The receipt names its
    // era now, and an era that ends at an ordinary commitment carries the whole
    // tail (only a return or a handover drops one, and both read `lapsed`), so
    // a log that never reaches the position is the operator's own lie about its
    // own book, on one state.
    const { venue, sequencer, backing } = setup();
    const { moveReceipt } = twoOperations(sequencer, backing);
    const honest = sequencer.snapshot()[0]!;
    const shortened = commitLog(backing, [honest.opLog[0]!], 0n);
    expect(receiptStatus(backing, venue, moveReceipt, shortened)).toBe("contradicted");
  });
});

describe("§C2: a receipt that is not this backing's operator's accuses nobody", () => {
  it("reads unrelated for a receipt issued on another backing", () => {
    const { venue, sequencer, backing } = setup();
    const other = makeTransparentBacking(SECRETS.backer2, "USD");
    sequencer.register(other, signBacking(SECRETS.backer2, other));
    const issue = { backing: other, recipient: KEYS.alice, quantity: 100n, nonce: 0n };
    const elsewhere = sequencer.submitIssue(
      issue,
      ed25519.sign(encodeIssuanceMessage(other.name, KEYS.alice, 100n, 0n), SECRETS.backer2),
    );
    twoOperations(sequencer, backing);
    const served = sequencer.commit();
    expect(receiptStatus(backing, venue, elsewhere, served)).toBe("unrelated");
  });

  it("reads unrelated for a receipt a stranger signed", () => {
    const { venue, sequencer, backing } = setup();
    const { moveReceipt } = twoOperations(sequencer, backing);
    const served = sequencer.commit();
    const impostor: Receipt = {
      ...moveReceipt,
      operator: ed25519.getPublicKey(SECRETS.mallory),
      signature: ed25519.sign(new Uint8Array(8), SECRETS.mallory),
    };
    expect(receiptStatus(backing, venue, impostor, served)).toBe("unrelated");
  });

  it("reads unrelated for a state a stranger committed", () => {
    const { venue, sequencer, backing } = setup();
    const { moveReceipt } = twoOperations(sequencer, backing);
    const snapshots = sequencer.snapshot();
    const forged = {
      snapshots,
      commitment: signCommitment(SECRETS.mallory, 0n, stateRoot(snapshots)),
    };
    expect(receiptStatus(backing, venue, moveReceipt, forged)).toBe("unrelated");
  });

  it("answers, rather than throwing, on malformed input", () => {
    const { venue, sequencer, backing } = setup();
    const { moveReceipt } = twoOperations(sequencer, backing);
    const served = sequencer.commit();
    const malformed = [
      { ...moveReceipt, opHash: undefined },
      { ...moveReceipt, position: -1n },
      { ...moveReceipt, position: 1n << 70n },
      undefined,
    ];
    for (const bad of malformed) {
      expect(receiptStatus(backing, venue, bad as unknown as Receipt, served)).toBe("unrelated");
    }
    expect(receiptStatus(backing, venue, moveReceipt, undefined as unknown as ServedState)).toBe(
      "unrelated",
    );
  });
});

describe("invariant 22: a later commitment must extend the earlier one", () => {
  it("names the fault where a returning operator commits a shorter log", () => {
    const { venue, sequencer, backing } = setup();
    twoOperations(sequencer, backing);
    const full = sequencer.commit();
    const restored = commitLog(backing, [full.snapshots[0]!.opLog[0]!], 1n);
    expect(isRewrittenHistory(backing, venue, full, restored)).toBe(true);
  });

  it("names the fault where an earlier entry changed under a longer log", () => {
    const { venue, sequencer, backing } = setup();
    twoOperations(sequencer, backing);
    const full = sequencer.commit();
    const log = full.snapshots[0]!.opLog;
    const diverged = commitLog(backing,
      [log[0]!, otherEntry(backing, 1, 0n), otherEntry(backing, 2, 1n)],
      1n,
    );
    expect(isRewrittenHistory(backing, venue, full, diverged)).toBe(true);
  });

  it("is silent on ordinary growth", () => {
    const { venue, sequencer, backing } = setup();
    twoOperations(sequencer, backing);
    const early = sequencer.commit();
    venue.advance(1n); // one commitment per witnessed index (28b: eras end legibly)
    const move = { backing, from: KEYS.alice, to: KEYS.carol, quantity: 5n, nonce: 1n };
    sequencer.submitTransfer(
      move,
      ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, KEYS.carol, 5n, 1n), SECRETS.alice),
    );
    const late = sequencer.commit();
    expect(isRewrittenHistory(backing, venue, early, late)).toBe(false);
  });

  it("derives which came first from the sequence, not from the argument order", () => {
    // A caller who could label which state is earlier could choose which
    // operator is at fault. Same rule as signerFromTerms: derived, never
    // asserted.
    const { venue, sequencer, backing } = setup();
    twoOperations(sequencer, backing);
    const full = sequencer.commit();
    const restored = commitLog(backing, [full.snapshots[0]!.opLog[0]!], 1n);
    expect(isRewrittenHistory(backing, venue, restored, full)).toBe(true);
    expect(isRewrittenHistory(backing, venue, full, restored)).toBe(true);
  });

  it("is silent on two states at one sequence, which is equivocation's case", () => {
    const { venue, sequencer, backing } = setup();
    twoOperations(sequencer, backing);
    const full = sequencer.commit();
    const sameSequence = commitLog(backing,
      [full.snapshots[0]!.opLog[0]!],
      full.commitment.sequence,
    );
    expect(isRewrittenHistory(backing, venue, full, sameSequence)).toBe(false);
  });

  it("accuses nobody on a stranger's state, or on malformed input", () => {
    const { venue, sequencer, backing } = setup();
    twoOperations(sequencer, backing);
    const full = sequencer.commit();
    const snapshots = [{ name: backing.name, opLog: [full.snapshots[0]!.opLog[0]!] }];
    const stranger = {
      snapshots,
      commitment: signCommitment(SECRETS.mallory, 1n, stateRoot(snapshots)),
    };
    expect(isRewrittenHistory(backing, venue, full, stranger)).toBe(false);
    expect(isRewrittenHistory(backing, venue, full, undefined as unknown as ServedState)).toBe(false);
  });
});

describe("§C2: the operator that dropped the backing instead of shrinking the log", () => {
  it("is the same fault, and the receipt says so rather than saying unrelated", () => {
    // This was an OPEN test, pinning the hole slice 11 found: an operator that
    // restored stale data need not shrink one log to escape, it can stop
    // committing that backing entirely, and committedLogFor answered `undefined`
    // for a state carrying no entry for the backing — the same answer it gives a
    // stranger's state. Every caller inherited that, so every receipt read
    // "unrelated" and no fault was named.
    //
    // It closes here because the layer below stopped merging the two answers,
    // not because a fourth predicate was added: a backing that vanishes is a log
    // that shrank to nothing. The whole case, including the grade that fires and
    // the successor that can now take over, is c2-dropped-backing.
    const { venue, sequencer, backing } = setup();
    const other = makeTransparentBacking(SECRETS.backer2, "USD");
    sequencer.register(other, signBacking(SECRETS.backer2, other));
    const { moveReceipt } = twoOperations(sequencer, backing);
    const honest = sequencer.commit();

    const withoutIt = sequencer.snapshot().filter((s) => compareBytes(s.name, backing.name) !== 0);
    const dropped = {
      snapshots: withoutIt,
      commitment: signCommitment(SECRETS.operator, honest.commitment.sequence + 1n, stateRoot(withoutIt)),
    };

    expect(isRewrittenHistory(backing, venue, honest, dropped)).toBe(true);
    expect(receiptStatus(backing, venue, moveReceipt, dropped)).toBe("dropped");
  });
});
