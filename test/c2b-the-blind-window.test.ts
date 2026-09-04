import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { compareBytes } from "../src/bytes.js";
import { signCommitment, stateRoot, type Commitment } from "../src/commitment.js";
import { encodeIssuanceMessage, encodeTransferMessage } from "../src/messages.js";
import { receiptStatus } from "../src/receipt.js";
import { eraIndex } from "../src/recovery.js";
import { Sequencer, SequencerError } from "../src/sequencer.js";
import { LocalVenue, type Venue } from "../src/venue.js";
import { chainAt, LaggingView } from "./lagging-view.js";
import { KEYS, SECRETS } from "./support.js";

// §C2, slice 39: **an operator serves the book its own signature put the
// record on.**
//
// On a venue that reads behind its chain — every venue this repository ships
// for production — a commitment is signed at one clock and witnessed the
// venue's lag later. Before this slice `commit` moved the seat's pin to that
// commitment and `serves` compared the pin against the record, so the operator
// went dark for the whole lag after every commit: measured on Ergo at depth 3,
// ten minutes in every sixteen, with every grade reading healthy and the
// refusal a payer got telling a stranger to call `takeOver`. A transaction the
// chain never took made it dark for ever, on the same signal a superseded twin
// gives — §C2b's "one detectable condition rather than three silent ones",
// covering four, one of them benign.
//
//   - **The pin carries what it stands ON.** `serves` is the pin against the
//     record's last, or the pin against this operator's own published-and-
//     unread commitment while the record has not moved off what that
//     commitment stood on. A book the operator itself committed to is not
//     "behind the record" — §C2's phrase for what serves nothing — it is one
//     ahead of it.
//   - **One commitment in flight**, which replaces the rule that one went per
//     witnessed index: the next waits until the record shows this one, or
//     until the venue's lag has passed without it, which is what turns a
//     dropped transaction into a stale seat one `takeOver` from repair.
//   - **The sequence is the operator's own count**, never below the record's.
//   - **A process commits nothing until the lag has passed since it
//     registered**, so a restart cannot sign over a sequence its own
//     pre-crash commitment already carries.
//
// The era half is `c2b-receipt-era`: a receipt names the commitment its
// operator signed rather than the index that commitment was witnessed at, and
// without it every act co-signed in the window would read as a lie about the
// operator's own log. See DECISIONS.md, "Panel: the blind window".

const SILENCE = { noCommitmentDuration: 1000n, challengeWindow: 5n };

function backingFor(venue: Venue, thing = "EUR"): Backing {
  return makeBacking({
    obligor: KEYS.backer,
    payout: { thing, quantumExponent: -2, perUnit: 100n },
    reliance: [],
    evidence: {
      setting: "transparent",
      operator: KEYS.operator,
      silence: SILENCE,
      witnessing: { venue: venue.id, interval: 5n },
    },
  });
}

/**
 * Move the CHAIN until the VIEW's clock has advanced by `by`. The two differ
 * while the chain is shallower than the depth, where the clock floors at zero.
 */
function advanceClock(chain: LocalVenue, view: Venue, by: bigint): void {
  const start = view.witnessedIndex();
  while (view.witnessedIndex() < start + by) chainAt(chain, chain.witnessedIndex() + 1n);
}

/** A sequencer serving `backing`, past its boot wait, with one issuance. */
function serving(chain: LocalVenue, view: Venue, backing: Backing) {
  const sequencer = new Sequencer(SECRETS.operator, view);
  sequencer.register(backing, signBacking(SECRETS.backer, backing));
  advanceClock(chain, view, view.lag());
  sequencer.submitIssue(
    { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
    ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
  );
  return sequencer;
}

function transferBy(backing: Backing, to: Uint8Array, quantity: bigint, nonce: bigint) {
  return {
    op: { backing, from: KEYS.alice, to, quantity, nonce },
    signature: ed25519.sign(
      encodeTransferMessage(backing.name, KEYS.alice, to, quantity, nonce),
      SECRETS.alice,
    ),
  };
}

/** Whether this operator's co-signing door is open for this backing. */
function doorOpen(sequencer: Sequencer, backing: Backing, nonce: bigint): boolean {
  const move = transferBy(backing, KEYS.bob, 1n, nonce);
  try {
    sequencer.submitTransfer(move.op, move.signature);
    return true;
  } catch {
    return false;
  }
}

describe("§C2: an operator serves across its own commitment", () => {
  it("keeps every door open from the clock it signs a commitment to the clock the venue shows it, and holds the book throughout", () => {
    // The window, walked. Depth 2, so the lag is 3: the commitment is signed
    // at clock c and witnessed at c + 3. Before this slice the operator was
    // refused at every clock in between and `awaitingTakeover` named the
    // backing it had just committed — the boot rule's own checklist, reporting
    // a book the operator itself published as lost.
    const chain = new LocalVenue();
    const view = new LaggingView(chain, 2n);
    const eur = backingFor(view);
    const operator = serving(chain, view, eur);
    const signedAt = view.witnessedIndex();
    operator.commit();

    for (let i = 0n; i < view.lag(); i++) {
      expect(view.witnessedIndex()).toBe(signedAt + i);
      expect(operator.awaitingTakeover()).toHaveLength(0);
      expect(doorOpen(operator, eur, i)).toBe(true);
      chainAt(chain, chain.witnessedIndex() + 1n);
    }
    // And the clock the record shows it: the pin is the record's own now.
    expect(view.witnessedIndex()).toBe(signedAt + view.lag());
    expect(view.latestFor(KEYS.operator)?.sequence).toBe(0n);
    expect(operator.awaitingTakeover()).toHaveLength(0);
    expect(doorOpen(operator, eur, view.lag())).toBe(true);
  });

  it("refuses a second commitment until the venue shows the first, and takes it at the clock it does", () => {
    const chain = new LocalVenue();
    const view = new LaggingView(chain, 2n);
    const eur = backingFor(view);
    const operator = serving(chain, view, eur);
    operator.commit();

    for (let i = 1n; i < view.lag(); i++) {
      chainAt(chain, chain.witnessedIndex() + 1n);
      expect(() => operator.commit()).toThrow(/commitment in flight/);
    }
    chainAt(chain, chain.witnessedIndex() + 1n);
    expect(operator.commit().commitment.sequence).toBe(1n);
  });

  it("on a venue with no lag this is one commitment per witnessed index, the rule it replaces", () => {
    // The deleted guard's own claim, kept: at lag zero the record shows a
    // commitment at the index it was published, so waiting for the record to
    // show the last one IS waiting for the next index.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const operator = new Sequencer(SECRETS.operator, venue);
    operator.register(eur, signBacking(SECRETS.backer, eur));
    expect(venue.lag()).toBe(0n);
    operator.commit();
    // The other arm of the same rule: nothing is ever in flight here, and the
    // record already shows this commitment at the index the next would land.
    expect(() => operator.commit()).toThrow(/at an index before this one would land/);
    venue.advance(1n);
    expect(operator.commit().commitment.sequence).toBe(1n);
  });
});

describe("§C2: what the window does not excuse", () => {
  it("a superseded twin still fails closed, at the index the record moves and not one later — and the writer that published is the one still serving", () => {
    // The force rule's own sentence — "the one writer that keeps writing is
    // the one whose pin keeps up" — read backwards for the whole lag before
    // this slice: the process that published went dark and the superseded twin
    // went on co-signing. Both serve inside the window now, which the
    // one-writer party rule already forbids and which changes neither the
    // count of live writers nor the index the twin is detected at.
    const chain = new LocalVenue();
    const view = new LaggingView(chain, 2n);
    const eur = backingFor(view);
    const publisher = serving(chain, view, eur);
    const state = publisher.commit();

    advanceClock(chain, view, view.lag());
    const twin = new Sequencer(SECRETS.operator, view);
    twin.register(eur, signBacking(SECRETS.backer, eur));
    twin.takeOver(eur, state);
    // The record now shows the publisher's commitment; both are seated on it.
    expect(publisher.awaitingTakeover()).toHaveLength(0);
    expect(twin.awaitingTakeover()).toHaveLength(0);

    // The publisher commits again. Through its own window it serves and the
    // twin does too; the index the record moves is where the twin fails.
    const signedAt = view.witnessedIndex();
    publisher.commit();
    for (let i = 0n; i < view.lag(); i++) {
      expect(publisher.awaitingTakeover()).toHaveLength(0);
      expect(twin.awaitingTakeover()).toHaveLength(0);
      chainAt(chain, chain.witnessedIndex() + 1n);
    }
    expect(view.witnessedIndex()).toBe(signedAt + view.lag());
    expect(publisher.awaitingTakeover()).toHaveLength(0);
    expect(twin.awaitingTakeover().map((b) => b.nameHex)).toEqual([eur.nameHex]);
    expect(doorOpen(twin, eur, 7n)).toBe(false);
  });

  it("a commitment the chain never took expires into a stale seat, one takeOver from repair, rather than a book lost for ever", () => {
    // Inclusion is bounded below by the venue's lag and above by nothing
    // (§C2), so a commitment the chain has not taken by then is one this
    // operator can no longer assume. Before the expiry the pin never matched
    // again: dark for ever, on the signal a superseded twin gives.
    const chain = new LocalVenue();
    class DropsCommitments extends LaggingView {
      override publish(): void {
        /* the chain never took it */
      }
    }
    const view = new DropsCommitments(chain, 2n);
    const eur = backingFor(view);
    const operator = serving(chain, view, eur);
    const lost = operator.commit();
    const signedAt = view.witnessedIndex();

    for (let i = 0n; i < view.lag(); i++) {
      expect(operator.awaitingTakeover()).toHaveLength(0);
      chainAt(chain, chain.witnessedIndex() + 1n);
    }
    // Past the lag with the record still not holding it: the seat is stale, as
    // any other stale seat is, and it says so.
    expect(view.witnessedIndex()).toBe(signedAt + view.lag());
    expect(view.latestFor(KEYS.operator)).toBeUndefined();
    expect(operator.awaitingTakeover().map((b) => b.nameHex)).toEqual([eur.nameHex]);
    expect(doorOpen(operator, eur, 9n)).toBe(false);

    // The repair is one takeOver onto what the record does hold — nothing —
    // and the next commitment does NOT re-use the sequence it signed and lost.
    const genesis = new Sequencer(SECRETS.operator, view);
    expect(lost.commitment.sequence).toBe(0n);
    expect(genesis).toBeDefined();
    operator.takeOver(eur);
    const next = operator.commit();
    expect(next.commitment.sequence).toBe(1n);
  });

  it("a restart commits nothing until the lag has passed, so it never signs over the sequence its own pre-crash commitment carries", () => {
    // Following the boot rule exactly — register, then resume from its own
    // latest committed state — a restart inside its own window resumed on the
    // pre-flight book and signed its next commitment at a sequence the record
    // had already seen: an equivocation against its own key, with no attacker.
    const chain = new LocalVenue();
    const view = new LaggingView(chain, 2n);
    const eur = backingFor(view);
    const first = serving(chain, view, eur);
    const inFlight = first.commit(); // sequence 0, not yet witnessed

    const restart = new Sequencer(SECRETS.operator, view);
    restart.register(eur, signBacking(SECRETS.backer, eur));
    const booted = view.witnessedIndex();
    for (let i = 0n; i < view.lag(); i++) {
      expect(() => restart.commit()).toThrow(/started within the venue's lag/);
      chainAt(chain, chain.witnessedIndex() + 1n);
    }
    // The lag has passed: whatever it published before is readable or gone,
    // and here it is readable.
    expect(view.witnessedIndex()).toBe(booted + view.lag());
    expect(view.latestFor(KEYS.operator)?.sequence).toBe(inFlight.commitment.sequence);
    restart.takeOver(eur, inFlight);
    expect(restart.commit().commitment.sequence).toBe(inFlight.commitment.sequence + 1n);
  });
});

/**
 * A chain whose record is not monotone in sequence: it takes any commitment
 * that verifies, at the index it lands, as `ErgoVenue` does — a record there is
 * any decodable, verifying box at the address, and nothing orders two of them
 * by sequence. `LocalVenue` refuses a sequence that does not extend, which is a
 * courtesy the `Venue` contract does not require of an implementation.
 */
class PermissiveChain extends LocalVenue {
  private readonly taken: { commitment: Commitment; at: bigint }[] = [];

  override publish(commitment: Commitment): void {
    this.taken.push({ commitment, at: this.witnessedIndex() });
  }

  private lastFor(operator: Uint8Array, asOf?: bigint) {
    const limit = asOf ?? this.witnessedIndex();
    for (let i = this.taken.length - 1; i >= 0; i--) {
      const held = this.taken[i]!;
      if (held.at <= limit && compareBytes(held.commitment.operator, operator) === 0) return held;
    }
    return undefined;
  }

  override latestFor(operator: Uint8Array, asOf?: bigint): Commitment | undefined {
    return this.lastFor(operator, asOf)?.commitment;
  }
  override witnessedAtFor(operator: Uint8Array, asOf?: bigint): bigint | undefined {
    return this.lastFor(operator, asOf)?.at;
  }
  override firstCommitmentFor(operator: Uint8Array, notBefore = 0n): bigint | undefined {
    for (const held of this.taken) {
      if (held.at >= notBefore && compareBytes(held.commitment.operator, operator) === 0) return held.at;
    }
    return undefined;
  }
  override nextSequenceFor(operator: Uint8Array): bigint {
    const last = this.lastFor(operator);
    return last === undefined ? 0n : last.commitment.sequence + 1n;
  }
}

describe("§C2: the seat's pin carries what it stands on", () => {
  it("a stale commitment landing late takes the seat of an operator whose own is still in flight, on a record that is not monotone in sequence", () => {
    // What the provenance is for, and the only shape that reaches it: the
    // in-flight arm of `serves` is otherwise cleared the moment the record
    // shows a commitment at or past this operator's own sequence, which on a
    // record ordered by sequence is every way it can move. `ErgoVenue` orders
    // nothing: an old commitment delayed in the mempool, or a twin's replay of
    // one, lands now and IS the record's last. The operator's own commitment
    // is still in flight, so the sequence never rises — and without the
    // provenance it would go on serving a book the record no longer stands on.
    const chain = new PermissiveChain();
    const view = new LaggingView(chain, 2n);
    const eur = backingFor(view);
    const operator = serving(chain, view, eur);
    const first = operator.commit(); // sequence 0
    advanceClock(chain, view, view.lag());
    expect(operator.awaitingTakeover()).toHaveLength(0);

    // A second commitment, in flight: sequence 1, not yet shown.
    operator.commit();
    expect(view.latestFor(KEYS.operator)?.sequence).toBe(first.commitment.sequence);
    expect(operator.awaitingTakeover()).toHaveLength(0);

    // And a stale one — this operator's own sequence 0 over another root —
    // lands under it, in the block the second was signed in. It becomes
    // readable a depth later, which is one clock before the in-flight
    // commitment expires: the window where the record has moved and the
    // operator's own sequence has not risen.
    const stale = signCommitment(SECRETS.operator, 0n, stateRoot([]));
    chain.publish(stale);
    chainAt(chain, chain.witnessedIndex() + 2n); // the depth
    expect(view.latestFor(KEYS.operator)?.root).toEqual(stale.root);
    expect(operator.awaitingTakeover().map((b) => b.nameHex)).toEqual([eur.nameHex]);
    expect(doorOpen(operator, eur, 11n)).toBe(false);
  });
});

describe("§C2b: a receipt co-signed inside the window", () => {
  it("reads pending against the commitment that closed its era, and witnessed once the next one carries it — never contradicted", () => {
    // The coupling all three panel angles found: the blind window's door
    // refusal was what kept receipts checkable. With the door open and the era
    // still named by a witnessed index, this receipt read `contradicted` — a
    // stranger-checkable lie about an honest operator's own log — whenever the
    // in-flight commitment turned out to be its last.
    const chain = new LocalVenue();
    const view = new LaggingView(chain, 2n);
    const eur = backingFor(view);
    const operator = serving(chain, view, eur);
    const closing = operator.commit(); // sequence 0, in flight

    // Co-signed inside the window: the era names the commitment just signed,
    // which is one past what the record shows.
    const paid = transferBy(eur, KEYS.carol, 30n, 0n);
    const receipt = operator.submitTransfer(paid.op, paid.signature);
    expect(receipt.after).toBe(closing.commitment.sequence + 1n);
    expect(eraIndex(view, KEYS.operator, receipt.after)).toBe("ahead");

    advanceClock(chain, view, view.lag());
    // The era's commitment is on the record now and does not carry the act —
    // it was signed before the act was. The era is open, so nobody is accused.
    expect(receiptStatus(eur, view, receipt, closing)).toBe("pending");

    // The next commitment carries it, and the receipt is witnessed against it.
    const carrying = operator.commit();
    advanceClock(chain, view, view.lag());
    expect(receiptStatus(eur, view, receipt, carrying)).toBe("witnessed");
  });
});
