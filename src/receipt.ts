// Operator co-signed receipts (§C2).
//
// A sequencer co-signs each accepted operation: the operator signs
// (backing name, operation hash, position). The position is the operation's
// index in that backing's operation log — the same log the commitment commits
// to (invariant 23) — so a receipt is verifiable against a committed state:
// reconstruct the operation at that position from the committed log entry,
// hash it, and check it equals the receipt's op hash. On a replay the
// sequencer returns the identical prior receipt (invariant 26).
//
// This holds for all seven operation kinds, presentation included: a demand, an
// acceptance, a release and a withdrawal each take a position and get a receipt,
// so an operator cannot deny having accepted one even though none of them moves
// value.

import { ed25519 } from "@noble/curves/ed25519.js";
import type { Backing } from "./backing.js";
import { ByteWriter, compareBytes, copyBytes } from "./bytes.js";
import { committedLogFor, type ServedState } from "./commitment.js";
import { eraIndex, eraLapsed } from "./recovery.js";
import { isAnOperator, successionOf } from "./replacement.js";
import { answering, type Venue } from "./venue.js";
import { RECEIPT_CONTEXT } from "./contexts.js";
import { verifySignatureStrict } from "./keys.js";
import type { BackingSnapshot } from "./ledger.js";
import { opHashOfEntry, type OpLogEntry, type PublishedOp } from "./oplog.js";

export interface Receipt {
  readonly backingName: Uint8Array;
  readonly opHash: Uint8Array;
  /** The operation's position in the backing's operation log. */
  readonly position: bigint;
  /**
   * The era the receipt was signed in: one MORE than the sequence of the last
   * commitment the operator had SIGNED when it co-signed, 0 where it had
   * signed none. Which book the operator's signature stood on — what lets a
   * reader tell a tail that died with a gap or a handover (`lapsed`) from a
   * lie about the log (`contradicted`), where a position alone cannot (slice
   * 28b; the receipt records an operation and a position and never when it was
   * signed).
   *
   * **The commitment, not the index it was witnessed at** (slice 39). On a
   * venue that reads behind its chain the operator co-signs between signing a
   * commitment and reading it, and that commitment's index does not exist yet;
   * naming the previous one made every such receipt a stranger-checkable lie
   * about the operator's own log the moment the commitment landed, and
   * predicting the index made one slow block void the receipt for ever.
   * `eraIndex` puts it back on the record. 0 is a sentinel and says only that
   * the operator had committed nothing; the readers treat it conservatively —
   * a missed fault, never a wrong one.
   */
  readonly after: bigint;
  readonly operator: Uint8Array;
  readonly signature: Uint8Array;
}

/**
 * A snapshot of a receipt's bytes. `readonly` is erased at runtime, so anything
 * that stores or serves a receipt copies it (docs/PROTOCOL_RULES.md: copy on the way in, copy
 * on the way out). Without it whoever holds a receipt can mutate the one the
 * sequencer kept, and invariant 26's "identical prior response" stops being
 * something the operator controls.
 */
export function copyReceipt(receipt: Receipt): Receipt {
  return {
    backingName: copyBytes(receipt.backingName),
    opHash: copyBytes(receipt.opHash),
    position: receipt.position,
    after: receipt.after,
    operator: copyBytes(receipt.operator),
    signature: copyBytes(receipt.signature),
  };
}

/** Both 32-byte fields are asserted, so one signature covers one receipt. */
function receiptMessage(
  backingName: Uint8Array,
  opHash: Uint8Array,
  position: bigint,
  after: bigint,
): Uint8Array {
  const w = new ByteWriter();
  w.context(RECEIPT_CONTEXT);
  w.key32(backingName, "backing name");
  w.key32(opHash, "op hash");
  w.u64(position);
  w.u64(after);
  return w.finish();
}

export function signReceipt(
  operatorSecret: Uint8Array,
  backingName: Uint8Array,
  opHash: Uint8Array,
  position: bigint,
  after: bigint,
): Receipt {
  const operator = ed25519.getPublicKey(operatorSecret);
  const signature = ed25519.sign(receiptMessage(backingName, opHash, position, after), operatorSecret);
  // The receipt owns its bytes: it is handed a backing name and an op hash the
  // caller still holds, and what the operator co-signed must not be rewritable.
  return {
    backingName: copyBytes(backingName),
    opHash: copyBytes(opHash),
    position,
    after,
    operator,
    signature,
  };
}

/** Valid iff the operator signed exactly (backing name, op hash, position, era). */
export function verifyReceipt(receipt: Receipt): boolean {
  try {
    const message = receiptMessage(receipt.backingName, receipt.opHash, receipt.position, receipt.after);
    return verifySignatureStrict(receipt.signature, message, receipt.operator);
  } catch {
    return false;
  }
}

/**
 * Whether this receipt is the operator's co-signature over exactly this
 * operation. The pairing is what a holder exhibits when there is no committed
 * state to check against — during a §C2b gap the operator's log is unpublished,
 * and its receipt is the only evidence outside it that the operation was
 * accepted at all.
 *
 * It proves acceptance, and **not a holding**: a payee who was paid and then
 * paid onward still holds the receipt for what they received. Reading it as a
 * holding is how a redemption pays a party that has already spent.
 *
 * A verifier: the receipt and the operation both come from whoever exhibits
 * them, so anything malformed is a pairing that does not hold.
 */
export function receiptCovers(
  backingName: Uint8Array,
  op: PublishedOp,
  receipt: Receipt,
): boolean {
  try {
    if (!verifyReceipt(receipt)) return false;
    // The backing is the caller's to name, not the receipt's to assert. An
    // operation carries no backing name — the name comes from whoever encodes
    // it — so taking it from the receipt would let a receipt issued on ANOTHER
    // backing cover this operation perfectly, and one operator commonly serves
    // many (§C2). It is a parameter for the same reason it is one on
    // opMessageOfEntry: the binding is structural rather than remembered.
    if (compareBytes(receipt.backingName, backingName) !== 0) return false;
    return compareBytes(opHashOfEntry(backingName, op), receipt.opHash) === 0;
  } catch {
    return false;
  }
}

/**
 * Whether a served state contains the operation a receipt attests to: same
 * backing, a log entry at the receipt's position, and that entry reconstructs
 * to the receipt's op hash. Combined with stateProvesCommitment this proves
 * the operation is in committed state. Never throws — the snapshot may come
 * from an untrusted operator, so any malformed field is a failed proof. Does
 * not check the operator signature; call verifyReceipt for that.
 */
export function receiptProvenBy(receipt: Receipt, snapshot: BackingSnapshot): boolean {
  try {
    if (compareBytes(snapshot.name, receipt.backingName) !== 0) return false;
    const entry = entryAt(snapshot.opLog, receipt.position);
    if (entry === undefined) return false;
    return compareBytes(opHashOfEntry(snapshot.name, entry), receipt.opHash) === 0;
  } catch {
    return false;
  }
}

/**
 * The entry a receipt's position names, or undefined if the log does not reach
 * it. The position is pinned to the index by the commitment encoder, and checked
 * again here because a served log comes from whoever serves it.
 */
function entryAt(
  opLog: readonly OpLogEntry[],
  position: bigint,
): OpLogEntry | undefined {
  if (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const entry = opLog[Number(position)];
  if (entry === undefined) return undefined;
  if (!Number.isSafeInteger(entry.position) || BigInt(entry.position) !== position) {
    return undefined;
  }
  return entry;
}

/**
 * Whether this receipt is a valid co-signature by a key that has **served this
 * backing**, over this backing.
 *
 * Both halves matter and neither is enough. Without the backing name, a receipt
 * the operator issued perfectly correctly on another backing covers an operation
 * here, since an operation carries no name of its own. Without the operator key,
 * a stranger signs both halves of somebody's real equivocation and it reads as a
 * fault by the operator of this backing — which is what a caller takes these
 * predicates to mean, and under §C2's backer-run default names the party that
 * owes the money.
 *
 * **Any key in the chain, not only the key E names.** A receipt records an
 * operation and a position and never when it was signed, so "was this key in
 * force then" is not a question it can answer — but a retired operator's
 * co-signature over an operation its own log really held is still evidence of
 * what it accepted while it served, and a successor's receipts have to count at
 * all. What stops a retired key mattering is that the state of record is the
 * operator in force now, and a receipt is read against that log.
 */
export function isOperatorReceipt(backing: Backing, venue: Venue, receipt: Receipt): boolean {
  return answering(() => {
    return (
      compareBytes(receipt.backingName, backing.name) === 0 &&
      isAnOperator(backing, venue, receipt.operator) &&
      verifyReceipt(receipt)
    );
  }, false);
}

/**
 * What a committed state says about a receipt — the question behind docs/PROTOCOL_RULES.md's
 * rule that **a payment is final when witnessed, not when co-signed** (§C2:
 * "Finality means witnessed rather than co-signed").
 *
 *   - `witnessed`    the committed log holds this operation at this position.
 *   - `pending`      the record has not reached it: the era the receipt names
 *                    is still open, or this state predates its end.
 *   - `lapsed`       the era ended in a return or a handover (eraLapsed), so
 *                    the operation died unwitnessed with the tail it sat in —
 *                    a fact about the operator's silence, not a lie, and the
 *                    signed request is resubmittable (docs/PROTOCOL_RULES.md's payee rule).
 *   - `contradicted` the record is past the era's end, or already held the
 *                    position otherwise, so one of the operator's two
 *                    signatures is a lie about its own log.
 *   - `dropped`      this IS the operator's committed state, and it carries no
 *                    log for this backing at all, so it answers nothing.
 *   - `unrelated`    not this backing's operator's receipt, not its state, or
 *                    an era the operator's record can never answer for — a
 *                    commitment it never signed, or more than the one it may
 *                    have in flight.
 *
 * **`dropped` is not an accusation, and is not `unrelated` either.** A commitment
 * made before this backing was registered carries no log for it innocently, and a
 * receipt records an operation and a position and never when it was signed
 * (slice 13) — so the two cannot be ordered, and nothing here can say which
 * happened. What it must not do is answer `unrelated`, which means "you asked the
 * wrong party": a holder reads that as having asked the wrong question, when in
 * fact their own operator's state has nothing in it for them. Ordering two states
 * and naming the fault is isRewrittenHistory's job.
 *
 * **`witnessed` does not need the latest commitment.** Positions are pinned and
 * the log is append-only, so once witnessed, always witnessed — unlike
 * provesHolding, where "last" is load-bearing because a holding can be spent
 * afterwards and an accepted operation cannot un-happen.
 *
 * **`unrelated` exists so that a proof never accuses the wrong party**, which is
 * the finding slice 9 made twice. Reading a stranger's receipt as contradicted
 * would name this backing's operator — the party that owes the money under the
 * backer-run default — for something it did not do.
 *
 * The log is not replayed. Whether the operator committed a lawful history is a
 * different question (stateIsAuthentic); what is asked here is only what the
 * operator put its own signature to, twice.
 *
 * A verifier: everything here comes from whoever exhibits it.
 */
export type ReceiptStatus =
  | "witnessed"
  | "pending"
  | "lapsed"
  | "contradicted"
  | "dropped"
  | "unrelated";

export function receiptStatus(
  backing: Backing,
  venue: Venue,
  receipt: Receipt,
  served: ServedState,
): ReceiptStatus {
  return answering(() => {
    if (!isOperatorReceipt(backing, venue, receipt)) return "unrelated";
    // The era the receipt names must be real: `after` names the last
    // commitment this operator had signed, and one naming a commitment it
    // never signed — or more than the single commitment it may have in flight
    // — is not a receipt its record can answer for.
    if (typeof receipt.after !== "bigint" || receipt.after < 0n) return "unrelated";
    const era = eraIndex(venue, receipt.operator, receipt.after);
    if (era === undefined) return "unrelated";
    // The genesis era (after = 0) is not further verifiable: the doors are open
    // from the venue's genesis through the declared duration, so honest
    // receipts carry it — and so can a lie stamped by an operator that arrived
    // late, which no reader can tell apart (a first fix here refused every
    // late-first-commitment genesis era and called 28a's own honest
    // first-commit-wipe receipts forged). What answers the stamp is the
    // payee's freshness rule (docs/PROTOCOL_RULES.md): a receipt naming anything but the
    // operator's latest commitment at payment time is stale on its face.
    const committed = committedLogFor(backing, venue, served);
    if (committed === undefined) return "unrelated";
    if (committed.kind === "dropped") return "dropped";
    // Once witnessed, always witnessed: positions are pinned and the log is
    // append-only, so this needs no view on the era — a tail operation
    // resubmitted onto its old position included.
    const entry = entryAt(committed.opLog, receipt.position);
    if (entry !== undefined && compareBytes(opHashOfEntry(backing.name, entry), receipt.opHash) === 0) {
      return "witnessed";
    }
    // The era's own commitment is signed and published and the venue has not
    // shown it: nothing has ended this era, and the operation it attests is
    // still on its way to a commitment. Read past this, every arm below would
    // measure an era that has not begun on the record (slice 39).
    if (era === "ahead") return "pending";
    // Or the venue never took it, and the era ended with it — the tail died
    // with license, exactly as a return from silence kills one. BELOW the
    // witnessed check above, deliberately: an operation a later commitment
    // carried is witnessed whatever became of the commitment its receipt was
    // signed under (the fix panel's inventory angle, whose mutation of this
    // ordering is what pins it).
    if (era === "died") return "lapsed";
    // Not carried here, so the era decides what that means. An era that ended
    // in a return or a handover dropped its tail with license: the receipt
    // attests an act that died unwitnessed, and accuses nobody.
    if (eraLapsed(venue, backing, receipt.operator, receipt.after)) return "lapsed";
    // The era is open, or ended at an ordinary commitment that carries the
    // whole tail. Past its end — this operator's own later commitment, or a
    // successor's record — an operation not at its position is the operator's
    // lie about its own log; before it, a position the record already holds
    // otherwise was fixed before the receipt was signed (the log is
    // append-only), and one it does not reach yet is simply not there yet.
    const sameOperator = compareBytes(served.commitment.operator, receipt.operator) === 0;
    const past = sameOperator
      ? served.commitment.sequence > (venue.latestFor(receipt.operator, era)?.sequence ?? -1n)
      : successionOf(backing, venue).some(
          (link) =>
            link.from > era && compareBytes(link.operator, served.commitment.operator) === 0,
        );
    if (past) return "contradicted";
    return entry === undefined ? "pending" : "contradicted";
  }, "unrelated");
}
