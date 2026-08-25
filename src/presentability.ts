// Presentability (invariant 13): a holding is presentable at b for q iff it
// contains q units of b and q·cᵢ units of each (bᵢ, cᵢ) in R(b).
//
// Units, never claims, so the answer cannot depend on packing. One level, no
// traversal: a reliance target's own reliance is that target's presentation
// problem (invariant 17 keeps the unaccompanied claim inert, never invalid).
//
// **presentableFor is the condition on a HOLDING**, and nothing in src calls it:
// the sequencer enforces the same thing per leg when a demand is filed (slice
// 22), and pre-checking it there would re-check what the locks check anyway.
// accompanimentOf below is the other question — whether a demand already filed
// really has its legs reserved — which is read out of a committed state rather
// than out of a holding. See DECISIONS.md.

import { bytesToHex } from "@noble/hashes/utils.js";
import { paysInClaims, backingName, type Backing } from "./backing.js";
import { legMismatch } from "./presentation.js";
import { acceptanceIsLive, isDishonoured, lockIsLive, replayLog } from "./ledger.js";
import { compareBytes, isValidQuantity } from "./bytes.js";
import { type Terms } from "./closure.js";
import { committedLogFor, type ServedState } from "./commitment.js";
import { replayServedState } from "./recovery.js";
import { answering, type Venue } from "./venue.js";

/** Units held against a backing name. Unknown names hold zero. */
export type HoldingView = (name: Uint8Array) => bigint;

export function presentableFor(view: HoldingView, backing: Backing, quantity: bigint): boolean {
  // A verifier: a non-quantity is "not presentable", not a TypeError, and a
  // backing whose fields do not re-encode (backingName recomputes the hash) is
  // not presentable either rather than a throw (found by the 2026-08-22 audit,
  // and reviewing its slice).
  return answering(() => {
    if (!isValidQuantity(quantity)) return false;
    if (view(backingName(backing)) < quantity) return false;
    for (const entry of backing.reliance) {
      if (view(entry.target) < quantity * entry.count) return false;
    }
    return true;
  }, false);
}

/**
 * Whether a standing demand's reliance legs are actually reserved for it
 * (invariant 13), read out of a committed state.
 *
 *   - `accompanied`  every leg holds a lock for this demand, for q·cᵢ units,
 *                    committing the demanding holder and paying the demanded
 *                    backing's obligor.
 *   - `unaccompanied` one does not. Invariant 13's condition is not met, so a
 *                    backer answering this demand would take in a set it cannot
 *                    unwind.
 *   - `unreadable`   this reader cannot establish either: the state is not this
 *                    backing's operator's, the demand is not standing in it, or
 *                    the legs' own terms are not to hand.
 *
 * **Why it exists.** The law is per backing: `applyEntry` sees one state, and a
 * leg's q·cᵢ units live in another, so a log carrying an unaccompanied demand
 * replays perfectly well and `stateIsAuthentic` — which folds one backing — says
 * yes. Slice 22 enforces the set at the sequencer, where it is filed; this is the
 * same condition read afterwards, by somebody who did not have to trust the
 * operator.
 *
 * **The backer is who asks.** §C3 makes the acceptance the backer's own
 * signature, and it is the party that loses by an unaccompanied demand, so it is
 * the one with both the motive and the moment to check.
 *
 * **The terms come from a resolver**, because R names its targets by hash, and
 * every answer is checked against the name asked for — the same rule closure.ts
 * follows, and for the same reason: what a store hands back is never taken on
 * its word.
 *
 * A verifier: the served state comes from an operator with a motive, so anything
 * malformed is a question that cannot be answered rather than a throw. A venue
 * declining to answer still propagates (venue.ts).
 */
export type Accompaniment = "accompanied" | "unaccompanied" | "unreadable";

export function accompanimentOf(
  backing: Backing,
  venue: Venue,
  terms: Terms,
  served: ServedState,
  demandHash: Uint8Array,
): Accompaniment {
  return answering(() => {
    const head = replayServedState(backing, venue, served);
    if (head === undefined) return "unreadable";
    const demand = head.demands.get(bytesToHex(demandHash));
    if (demand === undefined) return "unreadable";
    // Past the demand's own deadline no acceptance can be live again, so there
    // is no set to answer (found regression-reviewing slice 27). The clock is the
    // venue's, as every index here is.
    const now = venue.witnessedIndex();
    if (now > demand.deadline) return "unaccompanied";

    for (const entry of backing.reliance) {
      const leg = terms(entry.target);
      if (leg === undefined) return "unreadable";
      if (compareBytes(backingName(leg), entry.target) !== 0) return "unreadable";
      const legState = replayServedState(leg, venue, served);
      if (legState === undefined) return "unreadable";

      const lock = legState.locks.get(bytesToHex(demandHash));
      if (lock === undefined) return "unaccompanied";
      // The set's terms for this leg, the one definition the sequencer took it by:
      // q times c of the target, the demanding holder's own units, to the obligor.
      const want = { quantity: demand.quantity * entry.count, holder: demand.holder, beneficiary: backing.obligor, converter: demand.holder };
      if (legMismatch(lock, want) !== undefined) return "unaccompanied";
      // And live: a leg past its timeout can no longer settle, so a backer
      // answering it now would answer a set the holder has to re-prepare first
      // (slice 27). Read on the venue's clock, as every index here is.
      if (!lockIsLive(lock, now)) return "unaccompanied";
    }
    return "accompanied";
  }, "unreadable");
}

/**
 * Whether a standing demand's payout is reserved inside the claim layer: the
 * backer's lock on the backing P names, q times per-unit units, to the demand
 * holder, convertible by the holder alone. The holder asks before it releases,
 * as the backer asks `accompanimentOf` before it accepts — the two sides of
 * §C3's "neither party can write the other's outcome".
 *
 *   - `reserved`     the paying lock stands with the set's terms.
 *   - `unreserved`   the demand stands and the payout does not.
 *   - `outside`      P pays outside the claim layer; nothing here to reserve.
 *   - `unreadable`   the served state does not let the question be answered.
 */
export type PayoutStanding = "reserved" | "unreserved" | "outside" | "unreadable";

export function payoutOf(
  backing: Backing,
  venue: Venue,
  terms: Terms,
  served: ServedState,
  demandHash: Uint8Array,
): PayoutStanding {
  return answering(() => {
    if (!paysInClaims(backing.payout)) return "outside";
    const head = replayServedState(backing, venue, served);
    if (head === undefined) return "unreadable";
    const demand = head.demands.get(bytesToHex(demandHash));
    if (demand === undefined) return "unreadable";
    const paying = terms(backing.payout.backing);
    if (paying === undefined) return "unreadable";
    if (compareBytes(backingName(paying), backing.payout.backing) !== 0) return "unreadable";
    const payingState = replayServedState(paying, venue, served);
    if (payingState === undefined) return "unreadable";
    const lock = payingState.locks.get(bytesToHex(demandHash));
    if (lock === undefined) return "unreserved";
    const want = { quantity: demand.quantity * backing.payout.perUnit, holder: backing.obligor, beneficiary: demand.holder, converter: demand.holder };
    if (legMismatch(lock, want) !== undefined) return "unreserved";
    // The predicate the release asks: a live acceptance. The paying lock outlasts
    // the acceptance by the door's own rule, so its liveness alone could never
    // fire while the answer stood — and the holder was told "reserved" while the
    // law refused the release (found regression-reviewing slice 27). Both, on
    // the venue's clock: the acceptance for what the release needs, the lock as
    // the guard against a state no door built.
    const now = venue.witnessedIndex();
    if (!acceptanceIsLive(demand, now) || !lockIsLive(lock, now)) return "unreserved";
    return "reserved";
  }, "unreadable");
}

/**
 * What a standing demand's silence means, read across the served state — the
 * audit's question 3, decided by Bob: where P pays in claims, dishonour is the
 * branch where no acceptance WITH ITS PAYOUT RESERVED answered.
 *
 *   - `dishonoured` the demand is past its deadline with no live answer, and
 *                   no acceptance ever stood with the payout reserved through
 *                   its own window. The backer's visible failure (§C3).
 *   - `lapsed`      an acceptance stood whose payout the record shows
 *                   reserved — a lock under the demand's hash, the set's
 *                   terms, live at that acceptance's own deadline — and no
 *                   release came. The branch the record shows, not a
 *                   conviction: the holder's operator may have refused the
 *                   release (§C2b's non-service grade is that reader), and a
 *                   log's entries carry no witnessed index, so a lying
 *                   operator can bias what cannot be established toward this
 *                   answer — a reservation withdrawn mid-window, or taken
 *                   after it, replays clocklessly all the same. The misses
 *                   fall on the non-accusing side, deliberately; what they
 *                   cost, and whom, is recorded (DECISIONS, slice 30).
 *   - `pending`     the demand is not past its deadline, or a live acceptance
 *                   stands. Nothing has failed yet.
 *   - `unreadable`  the state is not this backing's operator's, the demand is
 *                   not standing in it, or the paying backing's terms or log
 *                   are not to hand.
 *
 * **The law's `isDishonoured` stays blind to legs, deliberately** — it reads
 * one record, and the paying lock lives in another backing's state. Where P
 * pays outside the claim layer there is nothing to reserve, and the record is
 * the whole answer: an expired acceptance is dishonour there, as §C3 reads it.
 * Where P pays in claims, this reader refines the true branch the way
 * `accompanimentOf` refines a demand's standing: across the served state, on
 * the venue's clock, with the paying backing's terms from a resolver whose
 * every answer is checked against the name asked for.
 *
 * **The reservation is read from the paying LOG, not the door.** An honest
 * door only takes an acceptance with its paying lock beside it — but a served
 * log comes from an operator with a motive, and the law replays an acceptance
 * without ever seeing legs. So each logged acceptance counts only if the
 * paying log holds a lock under the demand's hash, with the set's terms, whose
 * timeout reaches that acceptance's own deadline (`payoutOf` at the
 * acceptance's own deadline, as the decision put it).
 *
 * A verifier: anything malformed is a question that cannot be answered rather
 * than a throw, and a venue's refusal propagates.
 */
export type Dishonour = "dishonoured" | "lapsed" | "pending" | "unreadable";

export function dishonourOf(
  backing: Backing,
  venue: Venue,
  terms: Terms,
  served: ServedState,
  demandHash: Uint8Array,
): Dishonour {
  return answering(() => {
    const committed = committedLogFor(backing, venue, served);
    if (committed === undefined || committed.kind === "dropped") return "unreadable";
    const head = replayLog(backing, committed.opLog);
    if (head === undefined) return "unreadable";
    const demand = head.demands.get(bytesToHex(demandHash));
    if (demand === undefined) return "unreadable";
    if (!isDishonoured(demand, venue.witnessedIndex())) return "pending";
    if (!paysInClaims(backing.payout)) return "dishonoured";
    const paying = terms(backing.payout.backing);
    if (paying === undefined) return "unreadable";
    if (compareBytes(backingName(paying), backing.payout.backing) !== 0) return "unreadable";
    const payingLog = committedLogFor(paying, venue, served);
    if (payingLog === undefined || payingLog.kind === "dropped") return "unreadable";
    // The paying log replays under the law, as the head's does: replay is the
    // one bound on what an operator can ADD to a log, and this reader's verdict
    // turns on an added entry (found reviewing this slice — a junk lock nobody
    // signed read as a reservation).
    if (replayLog(paying, payingLog.opLog) === undefined) return "unreadable";
    const want = {
      quantity: demand.quantity * backing.payout.perUnit,
      holder: backing.obligor,
      beneficiary: demand.holder,
      converter: demand.holder,
    };
    const reservedThrough = (deadline: bigint): boolean =>
      payingLog.opLog.some(
        (entry) =>
          entry.kind === "lock" &&
          compareBytes(entry.attemptId, demandHash) === 0 &&
          legMismatch(entry, want) === undefined &&
          // Was the lock live at the acceptance's own deadline — lockIsLive,
          // the one liveness definition, at the one instant the decision names.
          lockIsLive(entry, deadline),
      );
    for (const entry of committed.opLog) {
      if (
        entry.kind === "acceptance" &&
        compareBytes(entry.demandHash, demandHash) === 0 &&
        reservedThrough(entry.deadline)
      ) {
        return "lapsed";
      }
    }
    return "dishonoured";
  }, "unreadable");
}
