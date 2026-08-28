import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { signBacking, type Backing } from "../src/backing.js";
import { compareBytes } from "../src/bytes.js";
import { equivocatingSigner, isDoubleAcceptance, isDoublePosition, settledInPart, withdrawnAgainstCommit } from "../src/fault.js";
import { encodeIssuanceMessage, encodeTransferMessage } from "../src/messages.js";
import { opHashOfEntry, type PublishedOp } from "../src/oplog.js";
import { encodeDemandMessage, encodeReleaseMessage } from "../src/presentation.js";
import {
  demandHash,
  encodeAcceptance,
  encodeDemand,
  encodeLock,
  encodeRelease,
  encodeWithdrawal,
  signCommit,
  type AcceptanceOp,
  type DemandOp,
  type LockOp,
  NO_DECISION_VENUE,
} from "../src/presentation.js";
import { makeBacking } from "../src/backing.js";
import { replacementMessage, ROLE_OPERATOR, type Replacement } from "../src/replacement.js";
import { VenueError } from "../src/venue.js";
import { signCommitment, stateRoot, type ServedState } from "../src/commitment.js";
import { type OpLogEntry } from "../src/oplog.js";
import { receiptCovers, signReceipt, type Receipt } from "../src/receipt.js";
import { Sequencer } from "../src/sequencer.js";
import { LocalVenue, type Venue } from "../src/venue.js";
import { KEYS, makeTransparentBacking, pub, SECRETS } from "./support.js";

// What can be proven, against whom, without trusting anybody.
//
// The system's posture everywhere is that misbehaviour is made PROVABLE rather
// than prevented: invariant 22 makes two roots at one sequence an operator's
// provable fault, §C2b grades silence on facts a stranger can check, and §C3
// makes dishonour "publicly checkable... with nobody reporting anything". That
// posture had a hole: it covered the operator and never the holder.
//
// §C2b's challenge window is where it bites. A claimant who has signed her
// holding away and then redeems the stale snapshot has signed TWO operations at
// one point in her own nonce sequence, and the protocol cannot tell which one
// her dark operator accepted — so it cannot always pay the right party. What it
// can do is name the fault, and these are the predicates that do it:
//
//   - a signer authorised two operations at one nonce (the holder's fault)
//   - an operator co-signed both halves of that (the operator's fault, which is
//     the backer's under the backer-run default)
//   - an operator co-signed two operations into one log position
//
// The last two also catch a botched failover, where two live servers hold one
// operator key: the protocol cannot distinguish that from malice, and treats it
// the same way it treats a self-framing commitment equivocation.
//
// Every one is a verifier over adversary-supplied bytes, so none of them throws.

function op(kind: "transfer" | "demand", secret: Uint8Array, backing: Backing, opts: {
  to?: Uint8Array;
  quantity?: bigint;
  nonce: bigint;
}): PublishedOp {
  const quantity = opts.quantity ?? 100n;
  if (kind === "transfer") {
    const to = opts.to as Uint8Array;
    const message = encodeTransferMessage(backing.name, pub(secret), to, quantity, opts.nonce);
    return {
      kind: "transfer",
      from: pub(secret),
      to,
      quantity,
      nonce: opts.nonce,
      signature: ed25519.sign(message, secret),
    };
  }
  const message = encodeDemandMessage(backing.name, pub(secret), quantity, 0n, 40n, opts.nonce);
  return {
    kind: "demand",
    holder: pub(secret),
    quantity,
    instant: 0n,
    deadline: 40n,
    nonce: opts.nonce,
    signature: ed25519.sign(message, secret),
  };
}

function issueOp(backing: Backing, recipient: Uint8Array, quantity: bigint, nonce: bigint): PublishedOp {
  const message = encodeIssuanceMessage(backing.name, recipient, quantity, nonce);
  return { kind: "issue", recipient, quantity, nonce, signature: ed25519.sign(message, SECRETS.backer) };
}

const backing = makeTransparentBacking(SECRETS.backer);

describe("a signer who authorised two operations at one nonce", () => {
  it("names the claimant who redeemed a holding she had signed away", () => {
    // §C2b's case: Alice pays Bob at nonce 0, then files a redemption claim at
    // nonce 0. Bob holds one signature, the venue carries the other.
    const spend = op("transfer", SECRETS.alice, backing, { to: KEYS.bob, nonce: 0n });
    const claim = op("demand", SECRETS.alice, backing, { nonce: 0n });
    const at = equivocatingSigner(backing, spend, claim);
    expect(at).toBeDefined();
    expect(compareBytes(at as Uint8Array, KEYS.alice)).toBe(0);
  });

  it("is not evaded by paying a key made up for the purpose", () => {
    // The proof names the key that SIGNED both, and a fresh payee key changes
    // nothing about that — which is the whole point, since keys are free.
    const alice2 = pub(new Uint8Array(32).fill(0x09));
    const a = op("transfer", SECRETS.alice, backing, { to: alice2, nonce: 0n });
    const b = op("transfer", SECRETS.alice, backing, { to: KEYS.bob, nonce: 0n });
    expect(compareBytes(equivocatingSigner(backing, a, b) as Uint8Array, KEYS.alice)).toBe(0);
  });

  it("names the obligor for two issuances at one nonce", () => {
    // The signer comes from the terms, so the fault is not the holder's alone.
    const a = issueOp(backing, KEYS.alice, 100n, 0n);
    const b = issueOp(backing, KEYS.bob, 100n, 0n);
    expect(compareBytes(equivocatingSigner(backing, a, b) as Uint8Array, KEYS.backer)).toBe(0);
  });

  it("is not a resubmission: the identical operation twice is no fault", () => {
    // Invariant 26 exists so a repeat is safe. Equivocation is two DIFFERENT
    // operations, never one sent twice.
    const spend = op("transfer", SECRETS.alice, backing, { to: KEYS.bob, nonce: 0n });
    expect(equivocatingSigner(backing, spend, { ...spend })).toBeUndefined();
  });

  it("refuses two operations at different nonces", () => {
    const a = op("transfer", SECRETS.alice, backing, { to: KEYS.bob, nonce: 0n });
    const b = op("transfer", SECRETS.alice, backing, { to: KEYS.carol, nonce: 1n });
    expect(equivocatingSigner(backing, a, b)).toBeUndefined();
  });

  it("refuses two operations by different signers at one nonce", () => {
    // Nonces are per (signer, backing), so one nonce shared by two signers is
    // ordinary rather than a fault.
    const a = op("transfer", SECRETS.alice, backing, { to: KEYS.carol, nonce: 0n });
    const b = op("transfer", SECRETS.bob, backing, { to: KEYS.carol, nonce: 0n });
    expect(equivocatingSigner(backing, a, b)).toBeUndefined();
  });

  it("refuses an operation whose signature does not verify", () => {
    // Nobody is framed by bytes anyone could have written.
    const a = op("transfer", SECRETS.alice, backing, { to: KEYS.bob, nonce: 0n });
    const forged = op("demand", SECRETS.mallory, backing, { nonce: 0n });
    const framed: PublishedOp = { ...forged, holder: KEYS.alice } as PublishedOp;
    expect(equivocatingSigner(backing, a, framed)).toBeUndefined();
  });

  it("refuses a release or withdrawal, whose signer is not in the operation", () => {
    // The law reads their signer from the demand they name, so proving one
    // needs that demand too. Asserting the signer instead would let an accuser
    // choose who is at fault.
    const spend = op("transfer", SECRETS.alice, backing, { to: KEYS.bob, nonce: 0n });
    const message = encodeReleaseMessage(backing.name, sha256(new Uint8Array(1)), KEYS.alice, 0n);
    const release: PublishedOp = {
      kind: "release",
      demandHash: sha256(new Uint8Array(1)),
      holder: KEYS.alice,
      nonce: 0n,
      signature: ed25519.sign(message, SECRETS.alice),
    };
    expect(equivocatingSigner(backing, spend, release)).toBeUndefined();
  });

  it("refuses operations naming a different backing", () => {
    const other = makeTransparentBacking(SECRETS.backer, "USD");
    const a = op("transfer", SECRETS.alice, backing, { to: KEYS.bob, nonce: 0n });
    const b = op("transfer", SECRETS.alice, other, { to: KEYS.carol, nonce: 0n });
    expect(equivocatingSigner(backing, a, b)).toBeUndefined();
  });

  it("never throws on malformed operations", () => {
    const spend = op("transfer", SECRETS.alice, backing, { to: KEYS.bob, nonce: 0n });
    const broken = { ...spend, to: new Uint8Array(3) } as PublishedOp;
    expect(() => equivocatingSigner(backing, spend, broken)).not.toThrow();
    expect(equivocatingSigner(backing, spend, broken)).toBeUndefined();
  });
});

describe("an operator that co-signed a history one nonce cannot hold", () => {
  /**
   * Two live servers holding one operator key — a failover with no leader
   * election, which is also exactly what collusion looks like from outside.
   * Each takes one of Alice's two spends at nonce 0 and co-signs it.
   */
  function splitBrain() {
    const venue = new LocalVenue();
    const one = new Sequencer(SECRETS.operator, venue);
    const two = new Sequencer(SECRETS.operator, venue);
    const alice2 = pub(new Uint8Array(32).fill(0x09));
    for (const server of [one, two]) {
      server.register(backing, signBacking(SECRETS.backer, backing));
      server.submitIssue(
        { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
        ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
      );
    }
    const toBob = { backing, from: KEYS.alice, to: KEYS.bob, quantity: 100n, nonce: 0n };
    const toAlice2 = { backing, from: KEYS.alice, to: alice2, quantity: 100n, nonce: 0n };
    return {
      a: {
        op: op("transfer", SECRETS.alice, backing, { to: KEYS.bob, nonce: 0n }),
        receipt: one.submitTransfer(
          toBob,
          ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, KEYS.bob, 100n, 0n), SECRETS.alice),
        ),
      },
      b: {
        op: op("transfer", SECRETS.alice, backing, { to: alice2, nonce: 0n }),
        receipt: two.submitTransfer(
          toAlice2,
          ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, alice2, 100n, 0n), SECRETS.alice),
        ),
      },
      venue,
      // The record the excuse is read against (28b): the fault pairs excuse a
      // receipt exactly where the record reads it lapsed, and this backing has
      // no silence clause and no replacement rule, so nothing here ever lapses.
      served: (() => { const commitment = one.commit(); return { snapshots: one.snapshot(), commitment }; })(),
    };
  }

  it("proves the operator accepted both halves of the claimant's equivocation", () => {
    const { a, b, venue, served } = splitBrain();
    expect(isDoubleAcceptance(backing, venue, served, a, b)).toBe(true);
  });

  it("proves it whichever order the two are exhibited in", () => {
    const { a, b, venue, served } = splitBrain();
    expect(isDoubleAcceptance(backing, venue, served, b, a)).toBe(true);
  });

  it("proves the same servers put two operations at one log position", () => {
    // The narrower fault, and it needs no operations at all: one operator, one
    // backing, one position, two operation hashes.
    const { a, b, venue, served } = splitBrain();
    expect(a.receipt.position).toBe(b.receipt.position);
    expect(isDoublePosition(backing, venue, served, a.receipt, b.receipt)).toBe(true);
  });

  it("proves one operation receipted into two positions — the mirror, and the same lie", () => {
    // Found by the 2026-08-22 audit: a position holds one entry and a nonce
    // admits one operation, so at most one of two receipts for one op at two
    // positions can be true — and both verified, both covered, and the pair read
    // as `pending` with nobody named.
    const { a, venue, served } = splitBrain();
    const twice = signReceipt(SECRETS.operator, backing.name, a.receipt.opHash, a.receipt.position + 5n, a.receipt.after);
    expect(isDoublePosition(backing, venue, served, a.receipt, twice)).toBe(true);
    expect(isDoublePosition(backing, venue, served, twice, a.receipt)).toBe(true);
    // The identical receipt twice is one receipt, not a fault.
    expect(isDoublePosition(backing, venue, served, a.receipt, a.receipt)).toBe(false);
  });

  it("refuses a receipt paired with an operation it does not cover", () => {
    // Or anyone could pin any operator's signature to any operation.
    const { a, b, venue, served } = splitBrain();
    expect(isDoubleAcceptance(backing, venue, served, { op: b.op, receipt: a.receipt }, b)).toBe(false);
  });

  it("refuses receipts the operator issued on another backing", () => {
    // One operator serves many backings (§C2), and an operation object carries
    // no backing name — the name comes from whoever encodes it. So a receipt
    // from a DIFFERENT backing covers the operation just as well, and pairing
    // one with an equivocation here accuses an operator that did nothing.
    const venue = new LocalVenue();
    const server = new Sequencer(SECRETS.operator, venue);
    const other = makeTransparentBacking(SECRETS.backer, "USD");
    for (const b of [backing, other]) {
      server.register(b, signBacking(SECRETS.backer, b));
      server.submitIssue(
        { backing: b, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
        ed25519.sign(encodeIssuanceMessage(b.name, KEYS.alice, 100n, 0n), SECRETS.backer),
      );
    }
    const alice2 = pub(new Uint8Array(32).fill(0x09));
    // Alice equivocates on `backing`; the operator correctly takes only one.
    const toBob = op("transfer", SECRETS.alice, backing, { to: KEYS.bob, nonce: 0n });
    const toAlice2 = op("transfer", SECRETS.alice, backing, { to: alice2, nonce: 0n });
    const here = server.submitTransfer(
      { backing, from: KEYS.alice, to: KEYS.bob, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, KEYS.bob, 100n, 0n), SECRETS.alice),
    );
    // And makes an ordinary, honest payment on the other backing.
    const elsewhere = server.submitTransfer(
      { backing: other, from: KEYS.alice, to: alice2, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeTransferMessage(other.name, KEYS.alice, alice2, 100n, 0n), SECRETS.alice),
    );

    expect(equivocatingSigner(backing, toBob, toAlice2)).toBeDefined();
    const commitment = server.commit();
    const served = { snapshots: server.snapshot(), commitment };
    expect(
      isDoubleAcceptance(backing, venue, served, { op: toBob, receipt: here }, { op: toAlice2, receipt: elsewhere }),
    ).toBe(false);
  });

  it("refuses receipts signed by a key E does not name as the operator", () => {
    // "The operator is at fault" is what a caller reads off these, so the key
    // has to be the one the backing declares. A stranger co-signing both halves
    // of a real equivocation has framed nobody but themselves, and must not
    // read as a fault against the operator of this backing.
    const { venue, served } = splitBrain();
    const alice2 = pub(new Uint8Array(32).fill(0x09));
    const a = op("transfer", SECRETS.alice, backing, { to: KEYS.bob, nonce: 0n });
    const b = op("transfer", SECRETS.alice, backing, { to: alice2, nonce: 0n });
    const ra = signReceipt(SECRETS.mallory, backing.name, opHashOfEntry(backing.name, a), 1n, 0n);
    const rb = signReceipt(SECRETS.mallory, backing.name, opHashOfEntry(backing.name, b), 1n, 0n);

    expect(equivocatingSigner(backing, a, b)).toBeDefined();
    expect(isDoubleAcceptance(backing, venue, served, { op: a, receipt: ra }, { op: b, receipt: rb })).toBe(false);
    expect(isDoublePosition(backing, venue, served, ra, rb)).toBe(false);
  });

  it("refuses two receipts by different operators", () => {
    const { a, b, venue, served } = splitBrain();
    const stranger = signReceipt(SECRETS.mallory, backing.name, b.receipt.opHash, b.receipt.position, b.receipt.after);
    expect(isDoubleAcceptance(backing, venue, served, a, { op: b.op, receipt: stranger })).toBe(false);
    expect(isDoublePosition(backing, venue, served, a.receipt, stranger)).toBe(false);
  });

  it("refuses operations that are not an equivocation", () => {
    // An honest operator co-signs many operations; only a conflicting pair is
    // a fault, and that judgement is the signer predicate's, not a second one.
    const venue = new LocalVenue();
    const server = new Sequencer(SECRETS.operator, venue);
    server.register(backing, signBacking(SECRETS.backer, backing));
    const issue = { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n };
    const first = server.submitIssue(
      issue,
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    const transfer = { backing, from: KEYS.alice, to: KEYS.bob, quantity: 30n, nonce: 0n };
    const second = server.submitTransfer(
      transfer,
      ed25519.sign(encodeTransferMessage(backing.name, KEYS.alice, KEYS.bob, 30n, 0n), SECRETS.alice),
    );
    const a = { op: issueOp(backing, KEYS.alice, 100n, 0n), receipt: first };
    const b = { op: op("transfer", SECRETS.alice, backing, { to: KEYS.bob, quantity: 30n, nonce: 0n }), receipt: second };
    const commitment = server.commit();
    const served = { snapshots: server.snapshot(), commitment };
    expect(isDoubleAcceptance(backing, venue, served, a, b)).toBe(false);
    expect(isDoublePosition(backing, venue, served, a.receipt, b.receipt)).toBe(false);
  });

  it("refuses a receipt whose signature does not verify", () => {
    const { a, b, venue, served } = splitBrain();
    const torn: Receipt = { ...b.receipt, signature: new Uint8Array(64) };
    expect(isDoubleAcceptance(backing, venue, served, a, { op: b.op, receipt: torn })).toBe(false);
    expect(isDoublePosition(backing, venue, served, a.receipt, torn)).toBe(false);
  });

  it("refuses one receipt exhibited against itself", () => {
    const { a, venue, served } = splitBrain();
    expect(isDoubleAcceptance(backing, venue, served, a, { ...a })).toBe(false);
    expect(isDoublePosition(backing, venue, served, a.receipt, { ...a.receipt })).toBe(false);
  });

  it("never throws on malformed receipts", () => {
    const { a, b, venue, served } = splitBrain();
    const broken: Receipt = { ...b.receipt, opHash: new Uint8Array(2) };
    expect(() => isDoubleAcceptance(backing, venue, served, a, { op: b.op, receipt: broken })).not.toThrow();
    expect(() => isDoublePosition(backing, venue, served, a.receipt, broken)).not.toThrow();
    expect(isDoublePosition(backing, venue, served, a.receipt, broken)).toBe(false);
  });
});

describe("a receipt covers exactly one operation", () => {
  function accepted() {
    const venue = new LocalVenue();
    const server = new Sequencer(SECRETS.operator, venue);
    server.register(backing, signBacking(SECRETS.backer, backing));
    const receipt = server.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
    );
    return { receipt, op: issueOp(backing, KEYS.alice, 100n, 0n) };
  }

  it("holds for the operation the sequencer accepted", () => {
    const { receipt, op: accepted_ } = accepted();
    expect(receiptCovers(backing.name, accepted_, receipt)).toBe(true);
  });

  it("fails for a different operation", () => {
    const { receipt } = accepted();
    expect(receiptCovers(backing.name, issueOp(backing, KEYS.bob, 100n, 0n), receipt)).toBe(false);
  });

  it("fails where the receipt names another backing", () => {
    const { receipt, op: accepted_ } = accepted();
    const other = makeTransparentBacking(SECRETS.backer, "USD");
    const elsewhere = signReceipt(SECRETS.operator, other.name, receipt.opHash, receipt.position, receipt.after);
    expect(receiptCovers(backing.name, accepted_, elsewhere)).toBe(false);
    // And the operation it really does cover is still refused against the
    // backing the caller asked about.
    expect(receiptCovers(other.name, accepted_, elsewhere)).toBe(false);
  });

  it("fails on an invalid operator signature", () => {
    const { receipt, op: accepted_ } = accepted();
    expect(receiptCovers(backing.name, accepted_, { ...receipt, signature: new Uint8Array(64) })).toBe(false);
  });

  it("never throws on malformed input", () => {
    const { receipt } = accepted();
    const broken = { ...receipt, backingName: new Uint8Array(1) };
    expect(() => receiptCovers(backing.name, issueOp(backing, KEYS.alice, 100n, 0n), broken)).not.toThrow();
    expect(receiptCovers(backing.name, issueOp(backing, KEYS.alice, 100n, 0n), broken)).toBe(false);
  });
});

describe("an operator that co-signs a withdrawal where the venue shows an in-time commit", () => {
  // The door's own refusal ("the attempt committed in time: settle it"),
  // turned into the fault it proves when co-signed anyway. Sound with no
  // clock: an honest withdrawal opens only past the timeout, and an in-time
  // commit is witnessed at or before it — witnessing is shared, so the pair
  // cannot happen honestly, whichever order the operator claims.

  const ATTEMPT = new Uint8Array(32).fill(0x5a);

  function world() {
    const venue = new LocalVenue();
    const backing = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "GOLD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: { setting: "transparent", operator: KEYS.operator },
    });
    const sequencer = new Sequencer(SECRETS.operator, venue);
    sequencer.register(backing, signBacking(SECRETS.backer, backing));
    sequencer.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 200n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 200n, 0n), SECRETS.backer),
    );
    return { venue, sequencer, backing };
  }

  function lockedBy(f: ReturnType<typeof world>, over: Partial<LockOp> = {}) {
    const lock: LockOp = {
      backing: f.backing,
      attemptId: ATTEMPT,
      holder: KEYS.alice,
      beneficiary: KEYS.bob,
      quantity: 90n,
      timeout: 40n,
      decisionVenue: f.venue.id,
      parties: [KEYS.alice],
      nonce: 0n,
      ...over,
    };
    return { lock, signature: ed25519.sign(encodeLock(lock), SECRETS.alice) };
  }

  /** The operator's story: the log with a withdrawal of `attempt` appended, committed. */
  function servedWithWithdrawal(f: ReturnType<typeof world>, log: OpLogEntry[], nonce: bigint): ServedState {
    const op = { backing: f.backing, demandHash: ATTEMPT, holder: KEYS.alice, nonce };
    const entry: OpLogEntry = {
      position: log.length,
      kind: "withdrawal",
      demandHash: ATTEMPT,
      holder: KEYS.alice,
      nonce,
      signature: ed25519.sign(encodeWithdrawal(op), SECRETS.alice),
    };
    const snapshots = [{ name: f.backing.name, opLog: [...log, entry] }];
    const commitment = signCommitment(SECRETS.operator, 0n, stateRoot(snapshots));
    f.venue.publish(commitment);
    return { snapshots, commitment };
  }

  it("is proven from the two records, and the proof names the attempt", () => {
    const f = world();
    const { lock, signature } = lockedBy(f);
    f.sequencer.submitLock(lock, signature);
    f.venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT)); // witnessed early: in time
    f.venue.advance(50n); // past the timeout, where a withdrawal even looks lawful
    const served = servedWithWithdrawal(f, f.sequencer.opLog(f.backing), 1n);
    const proven = withdrawnAgainstCommit(f.backing, f.venue, served);
    expect(proven).toBeDefined();
    expect(compareBytes(proven as Uint8Array, ATTEMPT)).toBe(0);
  });

  it("an expiry withdrawal with no commit proves nothing", () => {
    const f = world();
    const { lock, signature } = lockedBy(f);
    f.sequencer.submitLock(lock, signature);
    f.venue.advance(50n);
    const served = servedWithWithdrawal(f, f.sequencer.opLog(f.backing), 1n);
    expect(withdrawnAgainstCommit(f.backing, f.venue, served)).toBeUndefined();
  });

  it("a commit first witnessed past the timeout proves nothing: it was never in time", () => {
    const f = world();
    const { lock, signature } = lockedBy(f);
    f.sequencer.submitLock(lock, signature);
    f.venue.advance(50n);
    f.venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT)); // witnessed at 50 > 40
    const served = servedWithWithdrawal(f, f.sequencer.opLog(f.backing), 1n);
    expect(withdrawnAgainstCommit(f.backing, f.venue, served)).toBeUndefined();
  });

  it("a lock naming another venue is not this record's to judge", () => {
    // No door takes such a lock ("this sequencer does not watch that decision
    // venue"), so the log is a fabrication — but it replays, and this reader
    // holds the wrong record for the verdict: the conservative side, as the
    // gap fold reads it.
    const f = world();
    const { lock, signature } = lockedBy(f, { decisionVenue: new Uint8Array(32).fill(0x77) });
    const entry: OpLogEntry = {
      position: 1,
      kind: "lock",
      attemptId: lock.attemptId,
      holder: lock.holder,
      beneficiary: lock.beneficiary,
      quantity: lock.quantity,
      timeout: lock.timeout,
      decisionVenue: lock.decisionVenue,
      parties: lock.parties,
      nonce: lock.nonce,
      signature,
    };
    f.venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    f.venue.advance(50n);
    const served = servedWithWithdrawal(f, [...f.sequencer.opLog(f.backing), entry], 1n);
    expect(withdrawnAgainstCommit(f.backing, f.venue, served)).toBeUndefined();
  });

  it("a view that does not sync commits refuses rather than acquits", () => {
    // Found reviewing this slice: the fold's catch ate the VenueError, so an
    // Ergo view — whose commitsFor refuses BY DESIGN — read every log as
    // faultless: a fact about a party built out of not having looked.
    class CommitsRefusing extends LocalVenue {
      override commitsFor(): never {
        throw new VenueError("this view does not sync commits");
      }
    }
    const venue = new CommitsRefusing();
    const backing = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "GOLD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: { setting: "transparent", operator: KEYS.operator },
    });
    const sequencer = new Sequencer(SECRETS.operator, venue);
    sequencer.register(backing, signBacking(SECRETS.backer, backing));
    sequencer.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 200n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 200n, 0n), SECRETS.backer),
    );
    // The door itself reads the record before taking a bare lock, so on this
    // view the whole log is built by hand: the reader's behaviour is the claim.
    const lock: LockOp = {
      backing,
      attemptId: ATTEMPT,
      holder: KEYS.alice,
      beneficiary: KEYS.bob,
      quantity: 90n,
      timeout: 40n,
      decisionVenue: venue.id,
      parties: [KEYS.alice],
      nonce: 0n,
    };
    const log = sequencer.opLog(backing);
    const lockEntry: OpLogEntry = {
      position: log.length,
      kind: "lock",
      attemptId: lock.attemptId,
      holder: lock.holder,
      beneficiary: lock.beneficiary,
      quantity: lock.quantity,
      timeout: lock.timeout,
      decisionVenue: lock.decisionVenue,
      parties: lock.parties,
      nonce: 0n,
      signature: ed25519.sign(encodeLock(lock), SECRETS.alice),
    };
    venue.advance(50n);
    const op = { backing, demandHash: ATTEMPT, holder: KEYS.alice, nonce: 1n };
    const entry: OpLogEntry = {
      position: log.length + 1,
      kind: "withdrawal",
      demandHash: ATTEMPT,
      holder: KEYS.alice,
      nonce: 1n,
      signature: ed25519.sign(encodeWithdrawal(op), SECRETS.alice),
    };
    const snapshots = [{ name: backing.name, opLog: [...log, lockEntry, entry] }];
    const commitment = signCommitment(SECRETS.operator, 0n, stateRoot(snapshots));
    venue.publish(commitment);
    expect(() => withdrawnAgainstCommit(backing, venue, { snapshots, commitment })).toThrow(VenueError);
  });

  it("one garbage entry after the withdrawal does not buy the fault back: the proof stands on the lawful prefix", () => {
    // Found reviewing this slice: requiring the whole log to replay priced the
    // dodge at one junk entry — the state went unauthentic, which nothing
    // names, while the fault went unprovable.
    const f = world();
    const { lock, signature } = lockedBy(f);
    f.sequencer.submitLock(lock, signature);
    f.venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    f.venue.advance(50n);
    const log = f.sequencer.opLog(f.backing);
    const op = { backing: f.backing, demandHash: ATTEMPT, holder: KEYS.alice, nonce: 1n };
    const withdrawal: OpLogEntry = {
      position: log.length,
      kind: "withdrawal",
      demandHash: ATTEMPT,
      holder: KEYS.alice,
      nonce: 1n,
      signature: ed25519.sign(encodeWithdrawal(op), SECRETS.alice),
    };
    const junk: OpLogEntry = {
      position: log.length + 1,
      kind: "withdrawal",
      demandHash: new Uint8Array(32).fill(0x66),
      holder: new Uint8Array(32).fill(0x66),
      nonce: 9n,
      signature: new Uint8Array(64),
    };
    const snapshots = [{ name: f.backing.name, opLog: [...log, withdrawal, junk] }];
    const commitment = signCommitment(SECRETS.operator, 0n, stateRoot(snapshots));
    f.venue.publish(commitment);
    const proven = withdrawnAgainstCommit(f.backing, f.venue, { snapshots, commitment });
    expect(proven).toBeDefined();
    expect(compareBytes(proven as Uint8Array, ATTEMPT)).toBe(0);
  });

  it("a stranger's certificate frames nobody: the commit's signatures are the parties' own", () => {
    const f = world();
    const { lock, signature } = lockedBy(f);
    f.sequencer.submitLock(lock, signature);
    f.venue.publishCommit(signCommit(SECRETS.mallory, ATTEMPT)); // not a party
    f.venue.advance(50n);
    const served = servedWithWithdrawal(f, f.sequencer.opLog(f.backing), 1n);
    expect(withdrawnAgainstCommit(f.backing, f.venue, served)).toBeUndefined();
  });

  it("the first proven withdrawal is the one named", () => {
    const f = world();
    const second = new Uint8Array(32).fill(0x6b);
    const { lock, signature } = lockedBy(f);
    f.sequencer.submitLock(lock, signature);
    const other: LockOp = { ...lock, attemptId: second, quantity: 50n, nonce: 1n };
    f.sequencer.submitLock(other, ed25519.sign(encodeLock(other), SECRETS.alice));
    f.venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    f.venue.publishCommit(signCommit(SECRETS.alice, second));
    f.venue.advance(50n);
    const log = f.sequencer.opLog(f.backing);
    const w = (hash: Uint8Array, nonce: bigint, position: number): OpLogEntry => ({
      position,
      kind: "withdrawal",
      demandHash: hash,
      holder: KEYS.alice,
      nonce,
      signature: ed25519.sign(encodeWithdrawal({ backing: f.backing, demandHash: hash, holder: KEYS.alice, nonce }), SECRETS.alice),
    });
    const snapshots = [
      { name: f.backing.name, opLog: [...log, w(second, 2n, log.length), w(ATTEMPT, 3n, log.length + 1)] },
    ];
    const commitment = signCommitment(SECRETS.operator, 0n, stateRoot(snapshots));
    f.venue.publish(commitment);
    const proven = withdrawnAgainstCommit(f.backing, f.venue, { snapshots, commitment });
    expect(compareBytes(proven as Uint8Array, second)).toBe(0);
  });

  it("an heir does not co-sign its predecessor's artefact: takeOver refuses the poisoned log", () => {
    // Found reviewing this slice: takeOver is all-or-nothing, so the heir's
    // only exits were carrying the proof under its own key or refusing the
    // backing entirely. The door is what keeps the proof attributable.
    const venue = new LocalVenue();
    const backing = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "GOLD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: { setting: "transparent", operator: KEYS.operator, replacementRule: KEYS.backer },
    });
    const sequencer = new Sequencer(SECRETS.operator, venue);
    sequencer.register(backing, signBacking(SECRETS.backer, backing));
    sequencer.submitIssue(
      { backing, recipient: KEYS.alice, quantity: 200n, nonce: 0n },
      ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 200n, 0n), SECRETS.backer),
    );
    const lock: LockOp = {
      backing,
      attemptId: ATTEMPT,
      holder: KEYS.alice,
      beneficiary: KEYS.bob,
      quantity: 90n,
      timeout: 40n,
      decisionVenue: venue.id,
      parties: [KEYS.alice],
      nonce: 0n,
    };
    sequencer.submitLock(lock, ed25519.sign(encodeLock(lock), SECRETS.alice));
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    venue.advance(50n);
    const op = { backing, demandHash: ATTEMPT, holder: KEYS.alice, nonce: 1n };
    const entry: OpLogEntry = {
      position: sequencer.opLog(backing).length,
      kind: "withdrawal",
      demandHash: ATTEMPT,
      holder: KEYS.alice,
      nonce: 1n,
      signature: ed25519.sign(encodeWithdrawal(op), SECRETS.alice),
    };
    const snapshots = [{ name: backing.name, opLog: [...sequencer.opLog(backing), entry] }];
    const commitment = signCommitment(SECRETS.operator, 0n, stateRoot(snapshots));
    venue.publish(commitment);
    const poisoned = { snapshots, commitment };
    expect(withdrawnAgainstCommit(backing, venue, poisoned)).toBeDefined();

    const unsigned = {
      role: ROLE_OPERATOR,
      successor: KEYS.carol,
      predecessor: backing.name,
      effective: venue.witnessedIndex(),
      signature: new Uint8Array(64),
    };
    const replacement: Replacement = {
      ...unsigned,
      signature: ed25519.sign(replacementMessage(backing.name, unsigned), SECRETS.backer),
    };
    venue.publishReplacement(backing.name, replacement);
    const heir = new Sequencer(SECRETS.carol, venue);
    heir.register(backing, signBacking(SECRETS.backer, backing));
    expect(() => heir.takeOver(backing, poisoned)).toThrow(/the fault is its signer's to keep/);
  });

  it("a withdrawal of a demand is the holder walking away, not this fault", () => {
    const f = world();
    const demand: DemandOp = {
      backing: f.backing,
      holder: KEYS.alice,
      quantity: 10n,
      instant: 0n,
      deadline: 5n,
      nonce: 0n,
    };
    f.sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice));
    // A commit at the demand's own hash, witnessed early: the record shows an
    // object, but the log's withdrawal names a DEMAND, and no commit reaches one.
    f.venue.publishCommit(signCommit(SECRETS.alice, demandHash(demand)));
    f.venue.advance(50n);
    const hash = demandHash(demand);
    const op = { backing: f.backing, demandHash: hash, holder: KEYS.alice, nonce: 1n };
    const entry: OpLogEntry = {
      position: f.sequencer.opLog(f.backing).length,
      kind: "withdrawal",
      demandHash: hash,
      holder: KEYS.alice,
      nonce: 1n,
      signature: ed25519.sign(encodeWithdrawal(op), SECRETS.alice),
    };
    const snapshots = [{ name: f.backing.name, opLog: [...f.sequencer.opLog(f.backing), entry] }];
    const commitment = signCommitment(SECRETS.operator, 0n, stateRoot(snapshots));
    f.venue.publish(commitment);
    expect(withdrawnAgainstCommit(f.backing, f.venue, { snapshots, commitment })).toBeUndefined();
  });
});

describe("a set settled in part is the operator's fault, read across one commitment", () => {
  // One operator's doors apply a set as one act, its committed marks advance
  // together, and sameDuration puts a set's backings under one silence clause
  // — so ONE commitment showing half a settlement is a history no door
  // produced. Across two operators a handover lawfully strands a set
  // (slice 28b), so a leg absent from the state proves nothing.

  function world() {
    const venue = new LocalVenue();
    const evidence = { setting: "transparent" as const, operator: KEYS.operator };
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
    const terms = (name: Uint8Array) => (compareBytes(name, gold.name) === 0 ? gold : undefined);
    return { venue, sequencer, eur, gold, terms };
  }

  function fileAndAccept(f: ReturnType<typeof world>) {
    const demand: DemandOp = {
      backing: f.eur,
      holder: KEYS.alice,
      quantity: 40n,
      instant: 0n,
      deadline: 100n,
      nonce: f.sequencer.nextNonce(KEYS.alice, f.eur),
    };
    f.sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice));
    const hash = demandHash(demand);
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
      quantity: 80n,
      timeout: 95n,
      decisionVenue: NO_DECISION_VENUE,
      parties: [KEYS.alice],
      nonce: f.sequencer.nextNonce(KEYS.backer, f.gold),
    };
    f.sequencer.submitAcceptance(op, ed25519.sign(encodeAcceptance(op), SECRETS.backer), [
      { op: lock, signature: ed25519.sign(encodeLock(lock), SECRETS.backer) },
    ]);
    return hash;
  }

  function releaseEntry(f: ReturnType<typeof world>, backing: Backing, hash: Uint8Array): OpLogEntry {
    const nonce = f.sequencer.nextNonce(KEYS.alice, backing);
    // The record this release ends: Alice's demand on EUR, the backer's paying
    // lock on GOLD. Alice signs both (§C3: void only on the holder's release).
    const holder = compareBytes(backing.name, f.gold.name) === 0 ? KEYS.backer : KEYS.alice;
    const op = { backing, demandHash: hash, holder, nonce };
    return {
      position: f.sequencer.opLog(backing).length,
      kind: "release",
      demandHash: hash,
      holder,
      nonce,
      signature: ed25519.sign(encodeRelease(op), SECRETS.alice),
    };
  }

  function serveBoth(f: ReturnType<typeof world>, eurExtra: OpLogEntry[], goldExtra: OpLogEntry[]): ServedState {
    const snapshots = [
      { name: f.eur.name, opLog: [...f.sequencer.opLog(f.eur), ...eurExtra] },
      { name: f.gold.name, opLog: [...f.sequencer.opLog(f.gold), ...goldExtra] },
    ];
    const commitment = signCommitment(SECRETS.operator, 0n, stateRoot(snapshots));
    f.venue.publish(commitment);
    return { snapshots, commitment };
  }

  it("the head released without the payout's half is the fault, and the proof names the leg", () => {
    const f = world();
    const hash = fileAndAccept(f);
    const served = serveBoth(f, [releaseEntry(f, f.eur, hash)], []);
    const proven = settledInPart(f.eur, f.venue, f.terms, served, hash);
    expect(proven).toBeDefined();
    expect(compareBytes(proven as Uint8Array, f.gold.name)).toBe(0);
  });

  it("the payout released under a standing head demand is the same fault from the other side", () => {
    const f = world();
    const hash = fileAndAccept(f);
    const served = serveBoth(f, [], [releaseEntry(f, f.gold, hash)]);
    const proven = settledInPart(f.eur, f.venue, f.terms, served, hash);
    expect(proven).toBeDefined();
    expect(compareBytes(proven as Uint8Array, f.gold.name)).toBe(0);
  });

  it("an honest settlement shows both halves and proves nothing", () => {
    const f = world();
    const hash = fileAndAccept(f);
    const head = { backing: f.eur, demandHash: hash, holder: KEYS.alice, nonce: f.sequencer.nextNonce(KEYS.alice, f.eur) };
    const pay = { backing: f.gold, demandHash: hash, holder: KEYS.backer, nonce: f.sequencer.nextNonce(KEYS.alice, f.gold) };
    f.sequencer.submitRelease(head, ed25519.sign(encodeRelease(head), SECRETS.alice), [
      { op: pay, signature: ed25519.sign(encodeRelease(pay), SECRETS.alice) },
    ]);
    const commitment = f.sequencer.commit();
    const served = { snapshots: f.sequencer.snapshot(), commitment };
    expect(settledInPart(f.eur, f.venue, f.terms, served, hash)).toBeUndefined();
  });

  it("a leg absent from the state is a strand, not a proof: a handover tears nothing", () => {
    const f = world();
    const hash = fileAndAccept(f);
    const snapshots = [{ name: f.eur.name, opLog: [...f.sequencer.opLog(f.eur), releaseEntry(f, f.eur, hash)] }];
    const commitment = signCommitment(SECRETS.operator, 0n, stateRoot(snapshots));
    f.venue.publish(commitment);
    expect(settledInPart(f.eur, f.venue, f.terms, { snapshots, commitment }, hash)).toBeUndefined();
  });

  it("a leg lawfully withdrawn is not a settlement in part: withdrawal is the stranded set's exit", () => {
    const f = world();
    const hash = fileAndAccept(f);
    // Past the lock's own timeout the backer's withdrawal needs nobody's
    // cooperation; the head demand still stands, and nothing settled anywhere.
    f.venue.advance(96n);
    const op = { backing: f.gold, demandHash: hash, holder: KEYS.backer, nonce: f.sequencer.nextNonce(KEYS.backer, f.gold) };
    f.sequencer.submitWithdrawal(op, ed25519.sign(encodeWithdrawal(op), SECRETS.backer));
    const commitment = f.sequencer.commit();
    const served = { snapshots: f.sequencer.snapshot(), commitment };
    expect(settledInPart(f.eur, f.venue, f.terms, served, hash)).toBeUndefined();
  });

  it("a reliance leg is read the same way: the head released without the accompaniment's half names it", () => {
    // The set's legs are the head's reliance targets AND its claims payout;
    // the first arm gets its own walk here, with the accompaniment locked at
    // filing (invariant 13) and the head's release served without its half.
    const venue = new LocalVenue();
    const evidence = { setting: "transparent" as const, operator: KEYS.operator };
    const gold = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "GOLD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence,
    });
    const eur = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
      reliance: [{ target: gold.name, count: 2n }],
      evidence,
    });
    const sequencer = new Sequencer(SECRETS.operator, venue);
    for (const backing of [gold, eur]) sequencer.register(backing, signBacking(SECRETS.backer, backing));
    for (const [backing, quantity] of [[eur, 100n], [gold, 200n]] as const) {
      const nonce = sequencer.nextNonce(KEYS.backer, backing);
      sequencer.submitIssue(
        { backing, recipient: KEYS.alice, quantity, nonce },
        ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, quantity, nonce), SECRETS.backer),
      );
    }
    const demand: DemandOp = {
      backing: eur,
      holder: KEYS.alice,
      quantity: 40n,
      instant: 0n,
      deadline: 100n,
      nonce: sequencer.nextNonce(KEYS.alice, eur),
    };
    const hash = demandHash(demand);
    const leg: LockOp = {
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
    sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice), [
      { op: leg, signature: ed25519.sign(encodeLock(leg), SECRETS.alice) },
    ]);
    const answer: AcceptanceOp = {
      backing: eur,
      demandHash: hash,
      instant: 0n,
      deadline: 90n,
      nonce: sequencer.nextNonce(KEYS.backer, eur),
    };
    sequencer.submitAcceptance(answer, ed25519.sign(encodeAcceptance(answer), SECRETS.backer), []);
    const headNonce = sequencer.nextNonce(KEYS.alice, eur);
    const headOp = { backing: eur, demandHash: hash, holder: KEYS.alice, nonce: headNonce };
    const headRelease: OpLogEntry = {
      position: sequencer.opLog(eur).length,
      kind: "release",
      demandHash: hash,
      holder: KEYS.alice,
      nonce: headNonce,
      signature: ed25519.sign(encodeRelease(headOp), SECRETS.alice),
    };
    const snapshots = [
      { name: eur.name, opLog: [...sequencer.opLog(eur), headRelease] },
      { name: gold.name, opLog: sequencer.opLog(gold) },
    ];
    const commitment = signCommitment(SECRETS.operator, 0n, stateRoot(snapshots));
    venue.publish(commitment);
    const terms = (name: Uint8Array) => (compareBytes(name, gold.name) === 0 ? gold : undefined);
    const proven = settledInPart(eur, venue, terms, { snapshots, commitment }, hash);
    expect(proven).toBeDefined();
    expect(compareBytes(proven as Uint8Array, gold.name)).toBe(0);
  });

  it("a taken payout under a withdrawn head is settled in part: walking away covers nothing", () => {
    // Found reviewing this slice: the first draft required the head demand to
    // still STAND, so a holder who took the payout without surrendering the
    // set simply withdrew her own demand afterwards — both logs lawful, the
    // backer out the payout, nobody named. A head that withdrew the demand
    // still FILED it, and filing is what makes the set this reader's.
    const f = world();
    const hash = fileAndAccept(f);
    const wNonce = f.sequencer.nextNonce(KEYS.alice, f.eur);
    const wOp = { backing: f.eur, demandHash: hash, holder: KEYS.alice, nonce: wNonce };
    const headWithdrawal: OpLogEntry = {
      position: f.sequencer.opLog(f.eur).length,
      kind: "withdrawal",
      demandHash: hash,
      holder: KEYS.alice,
      nonce: wNonce,
      signature: ed25519.sign(encodeWithdrawal(wOp), SECRETS.alice),
    };
    const served = serveBoth(f, [headWithdrawal], [releaseEntry(f, f.gold, hash)]);
    const proven = settledInPart(f.eur, f.venue, f.terms, served, hash);
    expect(proven).toBeDefined();
    expect(compareBytes(proven as Uint8Array, f.gold.name)).toBe(0);
  });

  it("a one-unit decoy released under the hash is not the conversion: the set's own terms decide", () => {
    // Found reviewing this slice: the first draft matched the leg's half by
    // (kind, hash), so the backer-run operator withdrew its unfulfilled
    // payout lock, locked one unit to itself under the same hash, released
    // that — a lawful history, the holder paid nothing, the fault gone.
    const f = world();
    const hash = fileAndAccept(f);
    const gold = f.gold;
    const wNonce = f.sequencer.nextNonce(KEYS.backer, gold);
    const wOp = { backing: gold, demandHash: hash, holder: KEYS.backer, nonce: wNonce };
    const takeBack: OpLogEntry = {
      position: f.sequencer.opLog(gold).length,
      kind: "withdrawal",
      demandHash: hash,
      holder: KEYS.backer,
      nonce: wNonce,
      signature: ed25519.sign(encodeWithdrawal(wOp), SECRETS.backer),
    };
    const decoyOp: LockOp = {
      backing: gold,
      attemptId: hash,
      holder: KEYS.backer,
      beneficiary: KEYS.backer,
      quantity: 1n,
      timeout: 200n,
      decisionVenue: NO_DECISION_VENUE,
      parties: [KEYS.backer],
      nonce: wNonce + 1n,
    };
    const decoy: OpLogEntry = {
      position: f.sequencer.opLog(gold).length + 1,
      kind: "lock",
      attemptId: hash,
      holder: KEYS.backer,
      beneficiary: KEYS.backer,
      quantity: 1n,
      timeout: 200n,
      decisionVenue: NO_DECISION_VENUE,
      parties: [KEYS.backer],
      nonce: wNonce + 1n,
      signature: ed25519.sign(encodeLock(decoyOp), SECRETS.backer),
    };
    const rNonce = wNonce + 2n;
    const rOp = { backing: gold, demandHash: hash, holder: KEYS.backer, nonce: rNonce };
    const decoyRelease: OpLogEntry = {
      position: f.sequencer.opLog(gold).length + 2,
      kind: "release",
      demandHash: hash,
      holder: KEYS.backer,
      nonce: rNonce,
      signature: ed25519.sign(encodeRelease(rOp), SECRETS.backer),
    };
    const served = serveBoth(f, [releaseEntry(f, f.eur, hash)], [takeBack, decoy, decoyRelease]);
    const proven = settledInPart(f.eur, f.venue, f.terms, served, hash);
    expect(proven).toBeDefined();
    expect(compareBytes(proven as Uint8Array, gold.name)).toBe(0);
  });

  it("a whole set withdrawn through the door is the honest exit, and proves nothing", () => {
    const f = world();
    const hash = fileAndAccept(f);
    f.venue.advance(96n); // past the paying lock's own timeout
    // Each half is its signer's own one-sided exit: the holder walks the
    // demand, the backer takes back its expired reservation.
    const head = { backing: f.eur, demandHash: hash, holder: KEYS.alice, nonce: f.sequencer.nextNonce(KEYS.alice, f.eur) };
    f.sequencer.submitWithdrawal(head, ed25519.sign(encodeWithdrawal(head), SECRETS.alice));
    const leg = { backing: f.gold, demandHash: hash, holder: KEYS.backer, nonce: f.sequencer.nextNonce(KEYS.backer, f.gold) };
    f.sequencer.submitWithdrawal(leg, ed25519.sign(encodeWithdrawal(leg), SECRETS.backer));
    const commitment = f.sequencer.commit();
    const served = { snapshots: f.sequencer.snapshot(), commitment };
    expect(settledInPart(f.eur, f.venue, f.terms, served, hash)).toBeUndefined();
  });

  it("a resolver's wrong backing under the right name proves nothing", () => {
    const f = world();
    const hash = fileAndAccept(f);
    const served = serveBoth(f, [releaseEntry(f, f.eur, hash)], []);
    expect(settledInPart(f.eur, f.venue, f.terms, served, hash)).toBeDefined();
    expect(settledInPart(f.eur, f.venue, () => f.eur, served, hash)).toBeUndefined();
  });

  it("a leg log that is not a history proves nothing: this proof needs an absence, and an absence has no prefix", () => {
    const f = world();
    const hash = fileAndAccept(f);
    const junk: OpLogEntry = {
      position: f.sequencer.opLog(f.gold).length,
      kind: "withdrawal",
      demandHash: new Uint8Array(32).fill(0x71),
      holder: new Uint8Array(32).fill(0x71),
      nonce: 9n,
      signature: new Uint8Array(64),
    };
    const served = serveBoth(f, [releaseEntry(f, f.eur, hash)], [junk]);
    expect(settledInPart(f.eur, f.venue, f.terms, served, hash)).toBeUndefined();
  });

  it("a head log that is not a history proves nothing either", () => {
    const f = world();
    const hash = fileAndAccept(f);
    const one = releaseEntry(f, f.eur, hash);
    const again: OpLogEntry = { ...one, position: one.position + 1 };
    const served = serveBoth(f, [one, again], []);
    expect(settledInPart(f.eur, f.venue, f.terms, served, hash)).toBeUndefined();
  });

  it("a set of three backings names whichever leg is missing its half", () => {
    // reliance on GOLD and a payout in SILVER claims: the legs list walks both.
    const venue = new LocalVenue();
    const evidence = { setting: "transparent" as const, operator: KEYS.operator };
    const mkThing = (thing: string) =>
      makeBacking({
        obligor: KEYS.backer,
        payout: { thing, quantumExponent: -2, perUnit: 100n },
        reliance: [],
        evidence,
      });
    const gold = mkThing("GOLD");
    const silver = mkThing("SILVER");
    const eur = makeBacking({
      obligor: KEYS.backer,
      payout: { backing: silver.name, perUnit: 2n },
      reliance: [{ target: gold.name, count: 1n }],
      evidence,
    });
    const sequencer = new Sequencer(SECRETS.operator, venue);
    for (const b of [gold, silver, eur]) sequencer.register(b, signBacking(SECRETS.backer, b));
    const issue = (backing: Backing, to: Uint8Array, quantity: bigint) => {
      const nonce = sequencer.nextNonce(KEYS.backer, backing);
      sequencer.submitIssue(
        { backing, recipient: to, quantity, nonce },
        ed25519.sign(encodeIssuanceMessage(backing.name, to, quantity, nonce), SECRETS.backer),
      );
    };
    issue(eur, KEYS.alice, 100n);
    issue(gold, KEYS.alice, 100n);
    issue(silver, KEYS.backer, 500n);
    const demand: DemandOp = {
      backing: eur,
      holder: KEYS.alice,
      quantity: 40n,
      instant: 0n,
      deadline: 100n,
      nonce: sequencer.nextNonce(KEYS.alice, eur),
    };
    const hash = demandHash(demand);
    const rely: LockOp = {
      backing: gold,
      attemptId: hash,
      holder: KEYS.alice,
      beneficiary: KEYS.backer,
      quantity: 40n,
      timeout: 95n,
      decisionVenue: NO_DECISION_VENUE,
      parties: [KEYS.alice],
      nonce: sequencer.nextNonce(KEYS.alice, gold),
    };
    sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice), [
      { op: rely, signature: ed25519.sign(encodeLock(rely), SECRETS.alice) },
    ]);
    const answer: AcceptanceOp = {
      backing: eur,
      demandHash: hash,
      instant: 0n,
      deadline: 90n,
      nonce: sequencer.nextNonce(KEYS.backer, eur),
    };
    const paying: LockOp = {
      backing: silver,
      attemptId: hash,
      holder: KEYS.backer,
      beneficiary: KEYS.alice,
      quantity: 80n,
      timeout: 95n,
      decisionVenue: NO_DECISION_VENUE,
      parties: [KEYS.alice],
      nonce: sequencer.nextNonce(KEYS.backer, silver),
    };
    sequencer.submitAcceptance(answer, ed25519.sign(encodeAcceptance(answer), SECRETS.backer), [
      { op: paying, signature: ed25519.sign(encodeLock(paying), SECRETS.backer) },
    ]);
    const terms = (name: Uint8Array) =>
      compareBytes(name, gold.name) === 0 ? gold : compareBytes(name, silver.name) === 0 ? silver : undefined;
    // Every half of this set is alice's to release: the head as its holder,
    // each leg as its converter.
    const release = (backing: Backing): OpLogEntry => {
      const nonce = sequencer.nextNonce(KEYS.alice, backing);
      // The record each half ends: alice's demand and reliance leg, the backer's paying lock.
      const holder = compareBytes(backing.name, silver.name) === 0 ? KEYS.backer : KEYS.alice;
      const op = { backing, demandHash: hash, holder, nonce };
      return {
        position: sequencer.opLog(backing).length,
        kind: "release",
        demandHash: hash,
        holder,
        nonce,
        signature: ed25519.sign(encodeRelease(op), SECRETS.alice),
      };
    };
    const serve = (eurE: OpLogEntry[], goldE: OpLogEntry[], silverE: OpLogEntry[]) => {
      const snapshots = [
        { name: eur.name, opLog: [...sequencer.opLog(eur), ...eurE] },
        { name: gold.name, opLog: [...sequencer.opLog(gold), ...goldE] },
        { name: silver.name, opLog: [...sequencer.opLog(silver), ...silverE] },
      ];
      const commitment = signCommitment(SECRETS.operator, 0n, stateRoot(snapshots));
      venue.publish(commitment);
      return { snapshots, commitment };
    };
    // Head settled, both halves missing: the reliance leg is named first, the
    // canonical order.
    const both = serve([release(eur)], [], []);
    expect(compareBytes(settledInPart(eur, venue, terms, both, hash) as Uint8Array, gold.name)).toBe(0);
  });

  it("a head log that never filed the demand proves nothing against it", () => {
    // The leg's release under a hash this head never saw may be another
    // record's story; without the demand in the head log the set is not this
    // reader's to prove.
    const f = world();
    const hash = fileAndAccept(f);
    const eurIssueOnly = f.sequencer.opLog(f.eur).slice(0, 1);
    const snapshots = [
      { name: f.eur.name, opLog: eurIssueOnly },
      { name: f.gold.name, opLog: [...f.sequencer.opLog(f.gold), releaseEntry(f, f.gold, hash)] },
    ];
    const commitment = signCommitment(SECRETS.operator, 0n, stateRoot(snapshots));
    f.venue.publish(commitment);
    expect(settledInPart(f.eur, f.venue, f.terms, { snapshots, commitment }, hash)).toBeUndefined();
  });

  // The 28b strand, wearing one root — the review round's critical finding:
  // commit() roots every registered backing, in force or not, so a set
  // committed whole, its release co-signed into the tail, a partial handover
  // and the operator's own restore honestly produce a root showing one half
  // of the settlement. The pen-holder gate reads it as the strand it is.

  function replaceableWorld() {
    const venue = new LocalVenue();
    const evidence = {
      setting: "transparent" as const,
      operator: KEYS.operator,
      replacementRule: KEYS.backer,
    };
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
    const terms = (name: Uint8Array) => (compareBytes(name, gold.name) === 0 ? gold : undefined);
    return { venue, sequencer, eur, gold, terms };
  }

  /** The rule-holder hands `backing` to carol; her bare commitment takes force
   * unless the test's heir will take over and commit properly itself. */
  function handToCarol(venue: LocalVenue, backing: Backing, commit = true): void {
    const unsigned = {
      role: ROLE_OPERATOR,
      successor: KEYS.carol,
      predecessor: backing.name,
      effective: venue.witnessedIndex(),
      signature: new Uint8Array(64),
    };
    venue.publishReplacement(backing.name, {
      ...unsigned,
      signature: ed25519.sign(replacementMessage(backing.name, unsigned), SECRETS.backer),
    });
    if (commit) {
      venue.publish(signCommitment(SECRETS.carol, venue.nextSequenceFor(KEYS.carol), stateRoot([])));
    }
  }

  /** The whole set through the doors, its release left in the tail; the committed lengths mark the tear line. */
  function setWithTailRelease(f: ReturnType<typeof replaceableWorld>) {
    const hash = fileAndAccept(f);
    f.sequencer.commit(); // the set committed whole, sequence 0
    const eurCommitted = f.sequencer.opLog(f.eur).length;
    const goldCommitted = f.sequencer.opLog(f.gold).length;
    const head = { backing: f.eur, demandHash: hash, holder: KEYS.alice, nonce: f.sequencer.nextNonce(KEYS.alice, f.eur) };
    const pay = { backing: f.gold, demandHash: hash, holder: KEYS.backer, nonce: f.sequencer.nextNonce(KEYS.alice, f.gold) };
    f.sequencer.submitRelease(head, ed25519.sign(encodeRelease(head), SECRETS.alice), [
      { op: pay, signature: ed25519.sign(encodeRelease(pay), SECRETS.alice) },
    ]); // both halves co-signed, in the tail
    f.venue.advance(1n);
    return { hash, eurCommitted, goldCommitted };
  }

  it("a handed-over head with its tail is the strand, not the operator's tear", () => {
    // The old operator's root carries the head it no longer holds the pen for,
    // release and all, beside the half its own restore rolled back. Exactly a
    // firing shape — but the pen had left the head, and it accuses nobody.
    const f = replaceableWorld();
    const { hash, goldCommitted } = setWithTailRelease(f);
    handToCarol(f.venue, f.eur);
    const snapshots = [
      { name: f.eur.name, opLog: f.sequencer.opLog(f.eur) }, // the tail kept
      { name: f.gold.name, opLog: f.sequencer.opLog(f.gold).slice(0, goldCommitted) }, // restored
    ];
    const commitment = signCommitment(SECRETS.operator, f.venue.nextSequenceFor(KEYS.operator), stateRoot(snapshots));
    f.venue.publish(commitment);
    expect(settledInPart(f.eur, f.venue, f.terms, { snapshots, commitment }, hash)).toBeUndefined();
  });

  it("a handed-over leg with its tail is the strand from the other side", () => {
    const f = replaceableWorld();
    const { hash, eurCommitted } = setWithTailRelease(f);
    handToCarol(f.venue, f.gold);
    const snapshots = [
      { name: f.eur.name, opLog: f.sequencer.opLog(f.eur).slice(0, eurCommitted) }, // restored
      { name: f.gold.name, opLog: f.sequencer.opLog(f.gold) }, // the tail kept: converted
    ];
    const commitment = signCommitment(SECRETS.operator, f.venue.nextSequenceFor(KEYS.operator), stateRoot(snapshots));
    f.venue.publish(commitment);
    expect(settledInPart(f.eur, f.venue, f.terms, { snapshots, commitment }, hash)).toBeUndefined();
  });

  it("an heir whose inherited leg log never held the set's lock shows no half to miss", () => {
    // The successor takes over the head — settled whole by its predecessor —
    // and commits before taking the leg over: its root carries the leg with an
    // empty log. That artefact is isRewrittenHistory's, and naming it here too
    // would let one artefact be reported as two.
    const f = replaceableWorld();
    const hash = fileAndAccept(f);
    const head = { backing: f.eur, demandHash: hash, holder: KEYS.alice, nonce: f.sequencer.nextNonce(KEYS.alice, f.eur) };
    const pay = { backing: f.gold, demandHash: hash, holder: KEYS.backer, nonce: f.sequencer.nextNonce(KEYS.alice, f.gold) };
    f.sequencer.submitRelease(head, ed25519.sign(encodeRelease(head), SECRETS.alice), [
      { op: pay, signature: ed25519.sign(encodeRelease(pay), SECRETS.alice) },
    ]);
    const commitment = f.sequencer.commit(); // the predecessor's honest whole
    const served = { snapshots: f.sequencer.snapshot(), commitment };
    expect(settledInPart(f.eur, f.venue, f.terms, served, hash)).toBeUndefined();

    handToCarol(f.venue, f.eur, false);
    handToCarol(f.venue, f.gold, false);
    const heir = new Sequencer(SECRETS.carol, f.venue);
    for (const backing of [f.eur, f.gold]) heir.register(backing, signBacking(SECRETS.backer, backing));
    heir.takeOver(f.eur, served);
    f.venue.advance(1n);
    const heirCommitment = heir.commit();
    const heirServed = { snapshots: heir.snapshot(), commitment: heirCommitment };
    expect(settledInPart(f.eur, f.venue, f.terms, heirServed, hash)).toBeUndefined();
  });
});
