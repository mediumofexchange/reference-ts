// §C2b: failure, silence, and recovery — the two facts that open snapshot
// redemption.
//
// "When sequencers go dark, claims go illiquid rather than dead. Value discounts
// until they return, and after the declared silence, redemption against the last
// witnessed snapshot opens without co-signature, with the holder proving the
// claim unspent as of that snapshot."
//
// Two things have to be true, and both are checkable by a stranger against the
// published record — which is what makes the grade something a backer concedes
// rather than argues:
//
//   1. **the grade.** "No commitment past a second declared duration, in any
//      setting: the aggravated grade. It opens snapshot redemption and runs from
//      the first missed commitment until commitments resume." Measured on the
//      venue's clock, never the silent party's own publications, and against the
//      duration the backing itself declares in E.
//   2. **the unspentness proof.** Invariant 23: "The spent set must support
//      non-membership proofs, since §C2b's recovery path proves a claim *not*
//      spent as of the last commitment, which a bare Merkle root cannot do."
//      §C2b names the transparent form: "a signed spend record published at the
//      venue, checked against the last committed balance state, stands in for
//      the nullifier."
//
// Under transparent the whole served state is rehashed against the root, which
// is already how a receipt proves, so **serving everything IS the
// non-membership proof** — the Merkle machinery is what a construction needs
// when it cannot serve everything, and belongs with the shielded ones. See
// DECISIONS.md.
//
// **The payment path is those legs, published somewhere else.** §C2b:
// "Snapshot redemption publishes the claim's nullifier at the witness venue as
// the release leg, after the backer's acceptance." So it is not a second
// protocol beside §C3's demand-accept-release; it is that protocol with the legs
// published at the venue because there is no sequencer to submit them to, and
// under transparent a signed spend record IS an operation-log entry. One law,
// one replay, one nonce sequence — the legs go through the same `applyEntry`,
// and a returning sequencer adopting them is appending them in the order the
// venue witnessed them.
//
// Two things follow, and neither needed a new rule:
//
//   - **a standing demand is continued, not blocked.** Where the holder already
//     filed at the sequencer, the claim leg has happened and only the answer and
//     the release are left, which is §C2b's sentence read literally. Where they
//     had not, the claim leg is an ordinary demand, and a demand needs SPENDABLE
//     units — held minus what open demands commit — so the same units cannot
//     back two claims. Blocking instead would have deadlocked the holder, since
//     ending a demand takes a withdrawal and a withdrawal takes a sequencer.
//   - **the clock is the venue's stamp.** Every leg is judged at the index the
//     venue witnessed it at, which is the venue's word rather than the
//     operator's, so no leg needs an index anybody asserts. See DECISIONS.md.
//
// Everything here is a verifier: it answers questions about state an untrusted
// operator served, so it returns false on any malformed input and never throws —
// with two exceptions: a venue's refusal propagates rather than being answered
// (CLAUDE.md, `answering`; witnessedCommitFor raises one for a record that is
// not the lock's venue), and quietFor refuses a malformed operator key, which
// is the reader's own validated object and never adversary bytes.

import { paysInClaims, type Backing } from "./backing.js";
import {
  applyEntry,
  lockIn,
  lockIsLive,
  redeemable,
  copyState,
  replayLog,
  type DemandRecord,
  type LedgerState,
  type LockRecord,
} from "./ledger.js";
import { compareBytes, copyBytes, EncodingError, isValidQuantity } from "./bytes.js";
import { unknownOpKind, type PublishedOp } from "./oplog.js";
import { committedLogFor, type ServedState } from "./commitment.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { opHashOfEntry } from "./oplog.js";
import { lastCommitmentInForce, operatorAt, operatorIn, successionOf, type Succession } from "./replacement.js";
import { revokedAt } from "./revocation.js";
import { answering, venueIsDeclared, Venue, VenueError, type WitnessedCommit, type WitnessedOp } from "./venue.js";
import { commitSatisfies, NO_DECISION_VENUE } from "./presentation.js";

export type { ServedState };

/**
 * A published operation narrowed to a transfer.
 *
 * A type guard rather than a bare filter, because the reads below sort on a
 * nonce and not every operation kind has one — a commit deliberately does not.
 * The compiler carries that distinction here rather than a cast hiding it.
 */
type WitnessedTransfer = WitnessedOp & { readonly op: Extract<PublishedOp, { kind: "transfer" }> };

function isTransfer(witnessed: WitnessedOp): witnessed is WitnessedTransfer {
  return witnessed.op.kind === "transfer";
}

/**
 * A published operation narrowed to the requests §C2b counts: a transfer, or —
 * "a lock request left unserved is §C2b's non-service object" (§C3) — a bare
 * lock. Both kinds carry the signer's nonce, which the count's fold sorts on.
 */
type WitnessedRequest = WitnessedOp & {
  readonly op: Extract<PublishedOp, { kind: "transfer" | "lock" }>;
};

/**
 * How many witnessed indices this KEY has been quiet, across everything it
 * operates. Measured from its latest commitment, or from the venue's genesis
 * where it has never published. A fact about a key, deliberately: the grades
 * read `quietOn`, the backing's own clock, and a reader that graded a backing
 * on this number would be handing a shared operator's other backings the power
 * to keep this one's clock alive.
 */
export function quietFor(venue: Venue, operator: Uint8Array): bigint {
  // The operator key is the reader's own validated object (a Backing's, or a
  // witnessed replacement's), never adversary bytes: a malformed one is a caller
  // bug, refused by the boundary that owns well-formedness — answering 0 would
  // read as "published just now", the exoneration shape the audit slice removed
  // one file over, and a wrong-length key reading "quiet since genesis" is the
  // accusation shape (found in the last regression pass).
  if (!(operator instanceof Uint8Array) || operator.length !== 32) {
    throw new EncodingError("operator key must be 32 bytes");
  }
  return venue.witnessedIndex() - (venue.witnessedAtFor(operator) ?? 0n);
}

/** The operator in force at the venue's present index. */
function operatorNow(venue: Venue, backing: Backing): Uint8Array {
  return operatorAt(backing, venue, venue.witnessedIndex());
}

/**
 * The index this backing's clock starts at: where its own last commitment was
 * witnessed, and genesis where it has never had one.
 *
 * **The clock is the backing's, not a key's** (§C2b). The rule it replaces read
 * the later of the operator in force's last commitment and the index it took the
 * role — and the index it took the role is a field the RULE-HOLDER writes, which
 * is the backer by default. So a standing grade was cancellable by two published
 * records and no commitment anywhere: hop to a throwaway key the rule-holder
 * generates and co-signs itself, then hop back. Sharper than it looks — hopping
 * to a FRESH key every duration defeats any clock read per key at all, so no
 * amount of making the reset harder could work. This one never asks who is in
 * force now, only what was witnessed from whoever was.
 *
 * **What that does NOT close**, and §C2b already conceded it: "the grade fires on
 * the operator publishing nothing, not on it covering nothing". A rule-holder can
 * still name a key that commits for its own OTHER backings, and that commitment
 * closes this backing's gap while serving it nothing — AND, the other half of
 * the same concession, closing the gap closes the snapshot redemption that was
 * open on it, so the holder's live remedy dies with the grade. The remedy for
 * that party is the non-service grade, read against the last state that did
 * carry the backing — and it is the HOLDER's to arm, by publishing requests the
 * operator must then serve or wear. That is the division of labour §C2b draws,
 * not a hole this opens; it was true of the old clock too, and the cost of it
 * is stated here because the fallback does not fire on its own.
 *
 * Genesis where there is none, or never publishing at all would be the way to
 * read punctual forever.
 */
function clockStart(venue: Venue, chain: readonly Succession[], asOf?: bigint): bigint {
  return lastCommitmentInForce(chain, venue, asOf)?.at ?? 0n;
}

/** How long this backing has been without a commitment of its own. */
function quietOn(venue: Venue, backing: Backing): bigint {
  const now = venue.witnessedIndex();
  return now - clockStart(venue, successionOf(backing, venue));
}

export { venueIsDeclared };

/**
 * §C2b's aggravated grade for this backing: its operator has published no
 * commitment for longer than the duration the backing declares. A backing whose
 * E declares no silence clause is never silent — snapshot redemption never opens
 * for it and its claims can go illiquid forever, which is a setting the backer
 * chose and the holder read before accepting.
 *
 * **False means this record does not show it, never that the operator is fine.**
 * A record from a venue the backing does not declare answers false however dark
 * the operator has gone, because a grade is read on the declared venue and this
 * is not it. Ask venueIsDeclared first to tell the two apart — as provesHolding
 * already asks callers to read its false as "this state does not prove it".
 *
 * **And there is one operator it does not reach, which the spec now says.** §C2b:
 * "A shared operator batches, and what a venue witnesses is a root, so whether a
 * commitment carries any particular backing is unreadable from it: the grade
 * fires on the operator publishing nothing, not on it covering nothing." So an
 * operator that drops THIS backing and commits the rest on time is not silent,
 * and this is faithful rather than blind. What reaches that operator is the
 * non-service grade, read against the last state that did carry the backing, and
 * the fault is isRewrittenHistory. See DECISIONS.md.
 */
export function isSilent(venue: Venue, backing: Backing): boolean {
  const clause = backing.evidence.silence;
  if (clause === undefined) return false;
  if (!venueIsDeclared(venue, backing)) return false;
  // The operator in force now, not the key E names: §C2's "a wallet verifies the
  // chain rather than the key it remembers". Accrual against a replaced
  // incumbent stops at the handover, and the successor's own clock starts at the
  // index it took the role — which used to be the same thing as its first
  // commitment, and is not any more (`clockStart`).
  return quietOn(venue, backing) > clause.noCommitmentDuration;
}

/**
 * Whether this operator is late against the schedule its backing declares (§C2:
 * "At the declared interval each publishes a small commitment").
 *
 * **A fact, not a grade.** §C2b declares two grades and this is neither: nothing
 * fires, nothing opens, and no remedy follows. It is what a payee reads to
 * decide whether to wait, because a payment is final when witnessed rather than
 * co-signed — so "is the next commitment merely due, or overdue" has to be
 * answerable, and §C2 makes the interval "a signed field rather than operational
 * discretion" for exactly that reason.
 *
 * Quiet for exactly the interval is on time; one index more is late. Counted
 * from the venue's genesis where the operator has never published, or never
 * publishing at all would be the way to look punctual forever.
 *
 * **False means this record does not show it**, on the same terms as isSilent: a
 * backing that declared no schedule cannot be late against one, and a record
 * from a venue it does not declare says nothing either way.
 */
export function isOverdue(venue: Venue, backing: Backing): boolean {
  const terms = backing.evidence.witnessing;
  if (terms === undefined) return false;
  if (!venueIsDeclared(venue, backing)) return false;
  // On this backing's clock, which starts where this operator took the role.
  return quietOn(venue, backing) > terms.interval;
}

/**
 * The requests standing unserved against this BACKING, as §C2b counts them: "a
 * signed transfer request, published where demands are, left unserved past the
 * declared duration and counted only while still unserved."
 *
 * The backing's, not an operator's — the count stands through a handover, a
 * successor inherits the standing requests and clears them by serving them
 * (served requests leave the count through `servedAlready`, whoever serves).
 * Scoped to a term instead, the count was resettable: a term boundary is the
 * rule-holder's to draw for one publication and a key it generates itself, and
 * a boundary drawn through a count of absences makes every piece smaller than
 * *m*. WHO the standing count grades is `nonServingOperator`'s question, not
 * this one's.
 *
 * This is the grade **measured on service rather than publication**, and it is
 * the one that reaches the party the aggravated grade cannot: "A stalling
 * backer-run sequencer publishes on time, and the stall shows only as a spent
 * set that stops growing."
 *
 * Four things make a request count, and each is a sentence of the clause:
 *
 *   - **It is a transfer or a bare lock request published at the venue.** The
 *     transfer is §C3's demand shape without the backer; the lock is §C3's "a
 *     lock request left unserved is §C2b's non-service object". A lock counts
 *     only where the operator was OBLIGED to serve it, which is the door's own
 *     three refusals mirrored: it names this decision venue (one naming none
 *     is a leg and comes only with its set; one naming another venue is not
 *     watched here), its attempt is not already committed at the venue (the
 *     record itself answered that one), and its timeout is not spent — at its
 *     witnessing (the law's TIME rule, asked at the one index the operator was
 *     first handed it) NOR by the reading index, since a door with a live
 *     clock refuses an expired lock at every index in the counting band too,
 *     and a one-sided gate let m short-timeout locks fire the grade against an
 *     operator with no lawful move. Both venue-and-timeout exclusions are
 *     asked after the law's fold accepts the entry, so unsigned noise dies at
 *     the signature check and never reaches the venue. The refusal aggregate
 *     (m', W') is NOT this count: its object is a signed refusal to prepare,
 *     and prepare-decide-commit is an extension (see DECISIONS, slice 28).
 *   - **It is not in the committed log.** Served means served, and a request the
 *     operator took stops counting the moment it commits it.
 *   - **Its age is past the declared duration and inside the window W.** Below
 *     the duration it has not been left unserved yet; past the window it is no
 *     longer standing.
 *   - **The committed state could have served them.** "Faking a request means
 *     holding a real claim, so the count is checkable" - so they are put to the
 *     law against the state the operator actually committed, which is the test
 *     the challenge window needed when a request the snapshot could never have
 *     served counted as a spend.
 *
 * **Served as a sequence, not one at a time.** The paper's own case for m is one
 * holder: "one holder can split a holding into m claims and file as many
 * requests... no request is fake, though one holder can supply all m of them."
 * Under transparent those m requests occupy consecutive nonces, so tested
 * independently against the committed state every one after the first is refused
 * as ahead of the signer's next - and the clause could never fire for the
 * scenario it was written for. They are folded onto one working state in nonce
 * order instead, which is what "the operator could have served these" means: it
 * could have served them in the order they were signed.
 *
 * Chains across holders - Alice pays Bob, Bob spends onward, both unserved - are
 * out of scope here for the reason they are in the challenge window: "a spend by
 * the payee is a different signer's sequence".
 *
 * Distinct by the operation each request is, so republishing one is not two. Two
 * requests at one nonce are one holder equivocating, and the second finds its
 * nonce spent by the first, so the fold counts one without needing a rule.
 *
 * A verifier: the state comes from an operator with a motive and the venue from
 * anyone at all.
 */
export function unservedRequests(
  venue: Venue,
  backing: Backing,
  served: ServedState,
): WitnessedOp[] {
  return answering(() => {
    const terms = backing.evidence.nonService;
    if (terms === undefined) return [];
    if (!venueIsDeclared(venue, backing)) return [];
    const committed = committedLogFor(backing, venue, served);
    // A state that carries no log for this backing has nothing to fold the
    // requests onto, so the count is zero and honestly so. **What a holder must
    // know is which state to ask**: an operator that has dropped the backing is
    // graded against the last state that DID carry it, and that is the state
    // this grade — the only one that reaches a dropped backing at all — fires
    // against. See DECISIONS.md.
    if (committed === undefined || committed.kind === "dropped") return [];
    const state = replayLog(backing, committed.opLog);
    if (state === undefined) return [];

    const servedAlready = new Set(
      committed.opLog.map((entry) => bytesToHex(opHashOfEntry(backing.name, entry))),
    );
    const now = venue.witnessedIndex();
    // Applied to the sequence, which is not the same as counted toward the
    // grade: a request outside the band still advances the fold. `standing` is
    // the count.
    const applied = new Set<string>();
    const standing: WitnessedOp[] = [];
    // In nonce order, then witnessed order: a signer's own requests must be
    // folded in the order they were signed, and the witnessed index is the only
    // thing that separates two signed at one nonce (§C2, witnessing pins order).
    const isRequest = (w: WitnessedOp): w is WitnessedRequest =>
      w.op.kind === "transfer" ||
      (w.op.kind === "lock" && compareBytes(w.op.decisionVenue, venue.id) === 0);
    const candidates = venue
      .publishedOpsFor(backing.name)
      .filter(isRequest)
      .sort((a, b) =>
        a.op.nonce !== b.op.nonce
          ? a.op.nonce < b.op.nonce
            ? -1
            : 1
          : a.at < b.at
            ? -1
            : a.at > b.at
              ? 1
              : 0,
      );
    const working = copyState(state);
    for (const witnessed of candidates) {
      const hash = bytesToHex(opHashOfEntry(backing.name, witnessed.op));
      // Already in the committed log, so the state below already has it, and
      // applying it again would only meet its own spent nonce.
      if (servedAlready.has(hash) || applied.has(hash)) continue;
      try {
        // A lock's clock is its own witnessing index — "could have served"
        // needs an index at which a door would have; a transfer has no TIME
        // term and folds as before.
        applyEntry(working, backing, witnessed.op, witnessed.op.kind === "lock" ? witnessed.at : undefined);
      } catch {
        continue;
      }
      applied.add(hash);
      // **Applied, then counted — not the other way round.** A request outside
      // the counting band is still one the operator was handed and did not
      // serve, so it advances the sequence even though it no longer stands: a
      // request too young to count today is what tomorrow's depends on, and one
      // that has aged out is what a still-standing later request sits behind.
      // Filtering before the fold would silently refuse every request behind
      // them, which is the same mistake as testing them one at a time.
      const age = now - witnessed.at;
      if (age <= terms.duration || age > terms.window) continue;
      if (witnessed.op.kind === "lock") {
        // Applied, and then two exclusions the transfer arm has no analogue
        // of — both asked here, after the law, so unsigned junk died at the
        // signature check and never reached the venue's commit read (found
        // reviewing this slice: a commits-refusing view threw on noise).
        //
        // A timeout spent by the reading index: the door refuses this lock at
        // EVERY index in the counting band, not only at its witnessing — the
        // gate at the fold's clock is one-sided without this (found reviewing
        // this slice: m one-unit locks with short timeouts fired the grade
        // against an operator with no lawful move). The holder's own declared
        // term bounds the accusation, as a demand's deadline does — and the
        // consequence, accepted knowingly: an operator that stalls a lock past
        // its own timeout escapes this count for that request.
        if (witnessed.op.timeout <= now) continue;
        // An attempt the venue's record already answered: the door's own
        // "a lock needs a fresh id".
        if (witnessedCommitFor(venue, witnessed.op) !== undefined) continue;
      }
      standing.push(witnessed);
    }
    return standing;
  }, []);
}

/**
 * §C2b's non-service grade, and WHO it names: the operator in force at the
 * reading index, where at least *m* distinct requests stand unserved within the
 * window the backing declares. Undefined where the record does not show it.
 *
 * **The count stands against the backing; the grade names the incumbent.** The
 * count never asks who was in force when a request landed — a boundary the
 * rule-holder draws must not partition a count of absences — and the party
 * graded is never read off the served state, which is evidence and not a
 * subject: a retired operator's honest state folds tomorrow's requests exactly
 * as it folded yesterday's, and reading its signer as the accused let a holder
 * acting alone grade a party whose duty had ended (found reviewing this
 * slice, live on main). §C2 already says whose the accrual is — "accrual
 * against the incumbent continues... and stops there" — and the co-signature is
 * what makes naming the incumbent fair: no key holds the role without having
 * signed for it. Signed for the ROLE, with its obligations running: the
 * standing requests were in view, and ones published between its consent and
 * its force were not — those it inherits sight unseen, exactly as it inherits
 * the remainder of the silence window, and for the same reason (a boundary the
 * rule-holder draws must not shed either).
 *
 * A key, not a boolean, for the same reason `equivocatingSigner` returns one:
 * naming the party is what the answer is for, and a bare boolean is how a
 * reader came to supply the wrong one.
 *
 * **What firing does here, and what it deliberately does not.** §C2b says it
 * outright now: "Firing makes the case for E's replacement rule, which stands
 * whether or not a grade has fired." So the grade unlocks nothing - it is a fact
 * a stranger checks, exactly like silence and dishonour. Slice 16 read it that
 * way while the word was "opens" and flagged the choice rather than taking it
 * silently; the paper settled it.
 *
 * The remedy "is inert wherever that rule names the backer, and absent wherever
 * E names no rule at all" - the second of those is the OPEN case pinned in
 * c2-dropped-backing. See DECISIONS.md.
 */
export function nonServingOperator(
  venue: Venue,
  backing: Backing,
  served: ServedState,
): Uint8Array | undefined {
  const terms = backing.evidence.nonService;
  if (terms === undefined) return undefined;
  if (BigInt(unservedRequests(venue, backing, served).length) < terms.count) return undefined;
  return operatorNow(venue, backing);
}

/** The same grade as a fact rather than a name, for a reader that has one. */
export function isNonServing(venue: Venue, backing: Backing, served: ServedState): boolean {
  return nonServingOperator(venue, backing, served) !== undefined;
}

/**
 * The one check on served state, and what everything else here rests on: it is
 * the state this backing's operator committed to, and its operation log replays
 * under the law.
 *
 * Two properties, because a committed log is the whole of what is served: what
 * the operator asserts, and whether it could have happened. Balances, totals and
 * standing demands are not compared against anything, because they are not
 * asserted separately — they are what the replay returns.
 *
 * A verifier: the state comes from an operator with a motive, so any malformed
 * field is a failed check rather than a crash.
 */
export function stateIsAuthentic(backing: Backing, venue: Venue, served: ServedState): boolean {
  return replayServedState(backing, venue, served) !== undefined;
}

/**
 * The state a served snapshot replays to, or undefined if it is not this
 * backing's committed state or not a history that could have happened. The
 * shared body behind stateIsAuthentic and provesHolding, so a caller that needs
 * the numbers does not verify twice.
 */
export function replayServedState(
  backing: Backing,
  venue: Venue,
  served: ServedState,
): LedgerState | undefined {
  return answering(() => {
    // committedLogFor asks the three questions that always travel together: is
    // this signed by a key that served this backing, is this the state it
    // commits to, and does it carry this backing. What is left here is the law.
    // A state that carries no log for the backing replays to nothing: there is
    // no history of it here to be authentic or to hold a balance.
    const committed = committedLogFor(backing, venue, served);
    if (committed === undefined || committed.kind === "dropped") return undefined;
    return replayLog(backing, committed.opLog);
  }, undefined);
}

/**
 * Whether the served state proves this holder held at least `quantity` of this
 * backing as of the operator's LAST witnessed commitment.
 *
 * "Last" is load-bearing rather than decorative: against an older commitment a
 * holder who has since spent the units would still prove the state that shows
 * them.
 *
 * It answers what the holder could redeem: held minus what a LOCK has spoken
 * for. A standing demand of the holder's own is the claim being redeemed and
 * is not subtracted — "a standing demand is continued, not blocked" — where a
 * lock's units belong to an attempt that may yet commit elsewhere (audit slice:
 * the reader once read the raw balance, then spendable, and each was wrong on
 * one side; `redeemable` in ledger.ts is the one definition). See DECISIONS.md.
 */
export function provesHolding(
  venue: Venue,
  backing: Backing,
  served: ServedState,
  holder: Uint8Array,
  quantity: bigint,
): boolean {
  return answering(() => {
    if (!isValidQuantity(quantity)) return false;
    const replay = replayLatestState(venue, backing, served);
    if (replay === undefined) return false;
    return redeemable(replay, holder) >= quantity;
  }, false);
}

/**
 * The state a served snapshot replays to, once it has been established that it
 * IS this operator's last witnessed commitment. Shared by provesHolding and by
 * the redemption walk, which both turn on "last": against an older commitment a
 * holder who has since spent the units still proves the state that shows them.
 */
function replayLatestState(
  venue: Venue,
  backing: Backing,
  served: ServedState,
): LedgerState | undefined {
  if (!venueIsDeclared(venue, backing)) return undefined;
  // **The snapshot is the backing's rather than a key's** (§C2b): the last
  // commitment witnessed from a party that was in force for this backing when
  // it published it. Asked of whoever is in force NOW, one published record
  // naming a key that has committed nothing answered undefined — and the
  // holder's redemption proof, the only checkable remedy §C2b gives against a
  // dark operator, died on a record the rule-holder publishes for free. The
  // rule-holder is the backer by default: the party that owes the money.
  const latest = lastCommitmentInForce(successionOf(backing, venue), venue)?.commitment;
  if (latest === undefined) return undefined;
  // The ROOT is the comparison, not the signer: the root is injective over
  // states (invariant 22), and committedLogFor already refuses a key that is
  // not one of this backing's operators. Requiring the signer to match refused
  // a byte-identical state of record after an orderly handover — an heir that
  // re-commits the predecessor's book verbatim carries the same root at its
  // own key, and the holder keeping the predecessor's copy is following the
  // rule this file tells them to follow (found reviewing this slice).
  if (latest.sequence !== served.commitment.sequence) return undefined;
  if (compareBytes(latest.root, served.commitment.root) !== 0) return undefined;
  return replayServedState(backing, venue, served);
}

/**
 * This backing's outstanding as one of its operators committed it: issued minus
 * burned (invariant 10), out of a served state. Undefined where the state is not
 * one this backing's operator committed, or does not replay under the law.
 *
 * Any committed state, not only the latest — a caller comparing two of them
 * needs both, and which one is current is a question about the commitment rather
 * than about this arithmetic. The verifier had no way to read this number at all
 * before, which is what made a shortfall uncomputable.
 */
export function committedOutstanding(
  backing: Backing,
  venue: Venue,
  served: ServedState,
): bigint | undefined {
  const state = replayServedState(backing, venue, served);
  return state === undefined ? undefined : state.issued - state.burned;
}

/**
 * The outstanding that **stands** against a revoked backing: issued minus burned
 * as of the last commitment witnessed strictly before the revocation. Undefined
 * where the backing is not revoked here, or where `boundary` is not that
 * commitment's state.
 *
 * §C2b: "issuance witnessed before the revocation stands, anything witnessed
 * after is void." An issuance is witnessed when a commitment carrying it is
 * witnessed, and a log entry records no index of its own (slice 13), so the
 * boundary is read between committed states rather than per entry. Strictly
 * before: a commitment witnessed at the revocation's own index is not before it,
 * and the tie goes against the operator for the reason submitIssue's does.
 *
 * **What this is for, and what it is deliberately not.** Subtracting it from
 * committedOutstanding gives one number — how far the committed supply exceeds
 * what stands — and that number is a fact about the BACKING. It is never a
 * verdict about a holding. Which units descend from a void issuance is
 * provenance, which CLAUDE.md rules out rather than defers and which no blinded
 * construction could answer anyway; and allocation was settled in P before
 * anyone accepted, since invariant 19 forbids a payout reading holder identity
 * and §18 excludes "discretion after the fact".
 *
 * **Nothing is unwound, and that is not squeamishness.** Refusing a
 * post-boundary issuance in the replay would make replayLog return undefined, so
 * stateIsAuthentic and provesHolding would answer false for EVERY holder of the
 * backing, including ones whose units predate the theft entirely. Revocation
 * would go from capping a supply to destroying the backing's verifiability. It
 * would also allocate the loss by spend order, which is worse than any declared
 * shape, and it is a reversal in all but name (invariant 8).
 *
 * **This is the count invariant 19's payout reads**, and §C2b now says so: "A
 * payout reading this backing's own outstanding count (invariant 19) reads what
 * stands rather than what was committed, or a revoked thief dilutes every holder
 * by issuing on." Checkable from the published record, so it meets invariant
 * 19's "published" condition, and a thief cannot move it.
 */
export function standingOutstanding(
  backing: Backing,
  venue: Venue,
  boundary: ServedState,
): bigint | undefined {
  return answering(() => {
    const revoked = revokedAt(venue, backing);
    if (revoked === undefined) return undefined;
    const before = revoked - 1n;
    // The backing's last commitment as of just before the boundary — a handover
    // and a revocation are independent axes, and asking the key in force AT that
    // index made the number unreadable after one replacement: a freshly seated
    // heir had committed nothing, and invariant 19's stop-loss number vanished
    // on a record the rule-holder publishes for free.
    const last = lastCommitmentInForce(successionOf(backing, venue), venue, before)?.commitment;
    if (last === undefined) return undefined;
    if (
      boundary.commitment.sequence !== last.sequence ||
      compareBytes(boundary.commitment.root, last.root) !== 0 ||
      compareBytes(boundary.commitment.operator, last.operator) !== 0
    ) {
      return undefined;
    }
    return committedOutstanding(backing, venue, boundary);
  }, undefined);
}

/**
 * Whether snapshot redemption is open to this holder for this quantity: the
 * operator is silent past the declared duration, and the last witnessed snapshot
 * proves the holding. Both, or neither — silence without a proved holding
 * redeems nothing, and a proved holding while the operator is answering belongs
 * at the sequencer, where §C3's presentation already handles it.
 */
export function redemptionIsOpen(
  venue: Venue,
  backing: Backing,
  served: ServedState,
  holder: Uint8Array,
  quantity: bigint,
): boolean {
  return isSilent(venue, backing) && provesHolding(venue, backing, served, holder, quantity);
}

/**
 * The four legs of §C3's presentation, and nothing else. A publication of any
 * other kind is evidence or noise, never an operation on the claim layer:
 *
 *   - an **issue** or **burn** at the venue would let a dark operator's backing
 *     be inflated or destroyed by a party the sequencer never served.
 *   - a **transfer** is read as a challenge (below) and must not be applied, and
 *     the reason is not squeamishness: §C2b promises that claims "go illiquid
 *     rather than dead" while a sequencer is dark, and illiquid means the
 *     transfers stop. Applying them would make the venue a second sequencer
 *     without an operator, order, or a receipt.
 */
function isLeg(op: PublishedOp): boolean {
  switch (op.kind) {
    case "demand":
    case "acceptance":
    case "release":
    case "withdrawal":
      return true;
    case "issue":
    case "transfer":
    case "burn":
      return false;
    case "commit":
      // Not a gap leg either, and for the same reason as a lock: it settles an
      // attempt that a dark operator would have had to reserve. What §C2b gives
      // a holder when an operator is away is snapshot redemption, not the
      // completion of an atomic bundle nobody is left to hold up their end of.
      return false;
    case "lock":
      // **Deliberately not a gap leg**, and it has to be said rather than left
      // off a list. A lock reserves units for a presentation the dark operator
      // would have to serve, and adopting one alone would commit a holder's
      // accompaniment to an attempt with no counterparty. Filing a reliant
      // presentation during a gap is not built — `adopt` refuses the demand for
      // the same reason — and since slice 26 SETTLING one locked before the gap is
      // refused too (admittedInGap): the venue holds operations one at a time.
      return false;
  }
  // Exhaustive, and asserted rather than assumed: this was an allow-list, so an
  // operation kind added later was silently not a leg and nobody had to decide.
  // That is how the gap path inherited slice 22's relaxed demand rule.
  return unknownOpKind(op);
}

/**
 * **A publication is judged against the record as it stood strictly before its
 * own index**, which is the record it was made against. Both questions asked of
 * one below turn on it: had this operator gone silent, and which snapshot was
 * its last.
 *
 * The venue witnesses a commitment at index t and an operation at index t
 * together, so neither precedes the other — and the tie must not go to the
 * operator. It watches the venue: resolve the tie the other way and a silent
 * operator strips the force from any leg by committing at the index that leg
 * appears, which is a free veto over the whole clause. Silence is not a holder's
 * to manufacture (§C2b), and the end of it is not an operator's to backdate.
 *
 * It costs nothing in the other direction. A leg published at the index an
 * operator returns still has to name a state that was current, and the
 * snapshot check below is what refuses it.
 */
function before(at: bigint): bigint {
  return at - 1n;
}

/**
 * Whether a publication at the PRESENT index would have gap force for this
 * backing — the verifier's own `publishedInGap`, read at the door — and whose
 * silence it is: the operator in force just before the present index, which is
 * the operator the publication is judged against. Undefined where a publication
 * now would have no force.
 *
 * This is the operator's question before it co-signs anything. §C2b: a sequencer
 * "returning from silence adopts every nullifier witnessed during the gap before
 * co-signing again", and the gap "runs from the first missed commitment until
 * commitments resume" — so while this answers, a publication the operator has
 * not yet adopted can still land with force, and anything it co-signs meanwhile
 * is a history the verifier's fold will contradict. It still answers at the
 * very index the return commitment lands, because a publication there is judged
 * strictly before its own index (`before`): the operator serves from the index
 * after. And it names the operator because the silence decides whose book is
 * dead: an incumbent's own silence kills its uncommitted tail (Sequencer.adopt),
 * where a successor at its handover index reads its predecessor's silence —
 * that backing's doors shut for the index, and nothing of the successor's own
 * is unwitnessed for it. One predicate, so the operator's doors and the
 * verifier's fold cannot disagree about which indices belong to the gap (the
 * 2026-08-22 audit's B-2 and B-4, and the return-index probe that followed).
 *
 * A backing with no silence clause never has a gap, a record that is not the
 * backing's declared venue gives nothing force (as every clause reader reads
 * it), and a venue's refusal propagates, as everywhere.
 */
export function gapOpen(
  venue: Venue,
  backing: Backing,
  walked?: readonly Succession[],
): Uint8Array | undefined {
  if (!venueIsDeclared(venue, backing)) return undefined;
  // A pre-walked chain, where the caller has one: the sequencer asks this at
  // every door, and the walk's cost is the adversary's to grow (35d fix round).
  const chain = walked ?? successionOf(backing, venue);
  const now = venue.witnessedIndex();
  if (!publishedInGap(venue, backing, chain, now)) return undefined;
  return copyBytes(operatorIn(chain, before(now)));
}

/** Whether a publication witnessed at `at` landed inside a gap in commitments. */
function publishedInGap(
  venue: Venue,
  backing: Backing,
  chain: readonly Succession[],
  at: bigint,
): boolean {
  const clause = backing.evidence.silence;
  if (clause === undefined) return false;
  // The backing's clock as it stood strictly before the publication landed —
  // `clockStart`, the same rule `isSilent` and `isOverdue` read, in one place
  // rather than three. The chain is walked once by the caller: it is the same
  // chain at every index, and walking it costs a signature verification per
  // published replacement.
  return at - clockStart(venue, chain, before(at)) > clause.noCommitmentDuration;
}

/**
 * The operations a gap gave force to: its presentation legs, in the order the
 * venue witnessed them. This is what a returning sequencer adopts, and what the
 * redemption walk folds — exported so the two read one definition of what a
 * publication can do, rather than two that have to agree.
 */
export function gapLegsFor(
  venue: Venue,
  backing: Backing,
  walked?: readonly Succession[],
): WitnessedOp[] {
  if (!venueIsDeclared(venue, backing)) return [];
  const chain = walked ?? successionOf(backing, venue);
  return venue
    .publishedOpsFor(backing.name)
    .filter((w) => isLeg(w.op) && publishedInGap(venue, backing, chain, w.at));
}

/**
 * **Where the record puts the commitment a receipt's era names**, or the reason
 * it cannot: `"ahead"` for the one commitment the operator may have signed and
 * published without the venue showing it yet (slice 39's in-flight bound),
 * `undefined` for an era the operator's record can never answer for.
 *
 * An era is one MORE than the sequence of the commitment it names, so zero
 * still means "this operator had signed none" — the sentinel every reader
 * already treats conservatively. Naming the commitment rather than the index
 * is what lets an operator co-sign between signing a commitment and reading
 * it: the index does not exist yet, and predicting it makes one slow block
 * void the receipt, since inclusion is bounded below by the venue's lag and
 * above by nothing (§C2).
 *
 * **The fast path is the era a live operator names**, its own latest — one
 * venue read, which is what the door pays. An older era is a stale receipt in
 * a verifier's hands, and costs a binary search over `latestFor`, whose
 * sequence is monotone in `asOf` because the record is append-only. A
 * sequence the record skips answers `undefined` rather than the neighbouring
 * commitment's index: the era named a commitment that is not there.
 *
 * **Three answers, because the record has three things to say** (slice 39's
 * fix panel). It HOLDS the commitment, and the era began where that
 * commitment was witnessed. It has NOT REACHED it — `"ahead"` — and nothing
 * has ended the era, so an operation it attests is still on its way to one.
 * Or it MOVED PAST it without ever holding it — `"died"` — and that
 * commitment is one the venue never took: the era it opened ended with it,
 * exactly as §C2b's return from silence ends one, an expiry being a
 * sub-duration return.
 *
 * **Merging the last two is what the first draft did, and it shut the
 * operator's own door**: `shut` asks `eraLapsed` about the era this operator
 * is stamping right now, and a blanket lapse over both answers made that era
 * lapse from the second dropped commitment onward, refusing every act — the
 * blind window back by another road (the fix panel's inventory angle). The
 * operator's own era is never `"died"`: `era()` is one past what it has
 * signed, so its target is either the record's highest or beyond it.
 *
 * **And `"ahead"` is unbounded.** The first draft allowed one, on the reading
 * that one commitment in flight bounds the gap. It does not: the sequence a
 * commitment carries is one past what the operator SIGNED, so every dropped
 * transaction widens the gap by one, permanently, and an honest operator's own
 * receipts read `unrelated` from the second drop on. No sound bound is
 * available from the record, and an unsound one accuses the honest.
 */
export function eraIndex(
  venue: Venue,
  operator: Uint8Array,
  after: bigint,
): bigint | "ahead" | "died" | undefined {
  return answering(() => {
    if (!(operator instanceof Uint8Array) || operator.length !== 32) return undefined;
    if (typeof after !== "bigint" || after < 0n) return undefined;
    // The genesis era names no commitment, and index zero is where every
    // reader already measures it from.
    if (after === 0n) return 0n;
    const target = after - 1n;
    const latest = venue.latestFor(operator);
    const highest = latest === undefined ? -1n : latest.sequence;
    if (target > highest) return "ahead";
    // The live operator's own era: its latest, which is what a fresh receipt
    // names and what the sequencer's own doors ask about.
    if (target === highest) return venue.witnessedAtFor(operator);
    let low = 0n;
    let high = venue.witnessedIndex();
    while (low < high) {
      const mid = low + (high - low) / 2n;
      const at = venue.latestFor(operator, mid);
      if (at !== undefined && at.sequence >= target) high = mid;
      else low = mid + 1n;
    }
    const found = venue.latestFor(operator, low);
    // The record moved past this sequence without ever holding it: the
    // commitment died. Sound only because a venue's record for one key rises
    // in sequence as it rises in index (the `Venue` contract), so a sequence
    // the search steps over is one the record never had.
    if (found === undefined || found.sequence !== target) return "died";
    return venue.witnessedAtFor(operator, low);
  }, undefined);
}

/**
 * Whether the era a receipt was signed in ended without carrying its tail — so
 * that an operation the receipt attests, absent from the record, was dropped
 * with license rather than lied about.
 *
 * A receipt names its era: `after`, one more than the sequence of the last
 * commitment its operator had SIGNED when it co-signed (0 where it had signed
 * none), which `eraIndex` puts on the record. An era whose commitment the
 * venue has not shown yet has not ended — nothing can have ended it — so it
 * answers false, which is also what the operator's own door asks while its
 * commitment is in flight. The era ends at the
 * operator's next commitment, or at a successor taking force, whichever the
 * record shows first — and how it ends decides what the receipt is worth:
 *
 *   - **at an ordinary commitment** (at or inside the backing's declared
 *     duration): the commitment carries the whole tail, so the era CARRIED, and
 *     an attested operation missing from the record is the operator's lie about
 *     its own log (`contradicted`, and the fault pair in fault.ts).
 *   - **at a return** — the next commitment came more than THIS backing's
 *     declared duration after `after` — the book was restored to the mark and
 *     the tail died unwitnessed (§C2b; the sequencer's `restore`): true.
 *   - **at a handover** — a successor took force before the operator committed
 *     again — the successor took over the committed state without the tail
 *     (takeOver): true.
 *
 * Readable from this backing's own terms, which is why the restore is per
 * backing and a set spans one silence clause (DECISIONS, slice 28b). A backing
 * declaring no silence clause has no return to lapse into — only a handover —
 * and a record the backing does not declare shows nothing, as every clause
 * reader answers. A venue's refusal propagates, as everywhere.
 */
export function eraLapsed(
  venue: Venue,
  backing: Backing,
  operator: Uint8Array,
  after: bigint,
  walked?: readonly Succession[],
): boolean {
  return answering(() => {
    if (!(operator instanceof Uint8Array) || operator.length !== 32) return false;
    if (typeof after !== "bigint" || after < 0n) return false;
    if (!venueIsDeclared(venue, backing)) return false;
    // Walking verifies a signature per published record and anyone may publish
    // one for free, so a caller that has already walked passes its chain — the
    // sequencer's doors ask this per submission, and 35d's fix round measured
    // the unthreaded walks at seconds per door call under junk records. The
    // chain must be the FORCE chain, and a pending tip is sliced off rather
    // than trusted away: handed `successionAhead`, this predicate read the
    // pending link as a handover that had already ended the era and answered
    // true for the whole lead time — every door shut (found regression-
    // reviewing the fix round; gapOpen and gapLegsFor are indifferent to the
    // extra link, probed, and this one is not).
    let chain = walked ?? successionOf(backing, venue);
    const now = venue.witnessedIndex();
    while (chain.length > 0 && (chain[chain.length - 1] as Succession).from > now) {
      chain = chain.slice(0, -1);
    }
    // **The era can begin no earlier than the signer took the role.** §C2 seats
    // a successor before it has committed, so its receipts honestly say
    // `after = 0` — measured from index zero, every heir on a venue older than
    // one duration read lapsed, its handover arm found the very handover that
    // seated the heir's predecessor, and a lapsed era is the excuse the fault
    // pair reads: two receipts at one position from a punctual heir, and the
    // equivocation was unprovable (found reviewing this slice). The signer's
    // FIRST term, because `after = 0` says only that it had not committed when
    // it signed, and the earliest index it could have signed in force is the
    // conservative floor. That reads toward the excuse for a key the
    // rule-holder has named twice — a receipt whose `after` predates the
    // key's second seat may have been signed in either term, and the earlier
    // one's ending lapses it — which is this predicate's direction, and the
    // regression review priced it: the excuse holds only while the key stays
    // dark, and `isSilent` names that state for what it is.
    // The era's own commitment, on the record. An era still in flight cannot
    // have ended, and one the record cannot answer for accuses nobody.
    const at = eraIndex(venue, operator, after);
    if (at === "ahead" || at === undefined) return false;
    // A commitment the venue never took ended the era it opened, and took its
    // tail with it — §C2b's return from silence, under the declared duration.
    // The operator's own era never reads this (see `eraIndex`), so this
    // answer belongs to a reader and never shuts a door.
    if (at === "died") return true;
    let from = at;
    for (const link of chain) {
      if (compareBytes(link.operator, operator) !== 0) continue;
      if (link.from > from) from = link.from;
      break;
    }
    // The era's END is measured from where it BEGAN — the same floor. Keyed on
    // `after` alone, a commitment the key made before its seat (for anything
    // else it operates) stood in as "next", both arms went dead, and an era
    // that genuinely died read as live: the accusing direction (found
    // regression-reviewing the fix round).
    const next = venue.firstCommitmentFor(operator, from + 1n);
    // The first force taken after the era began, by anyone else, ends it.
    let handover: bigint | undefined;
    for (const link of chain) {
      if (link.from > from && compareBytes(link.operator, operator) !== 0) {
        handover = link.from;
        break;
      }
    }
    if (handover !== undefined && (next === undefined || handover <= next)) return true;
    const duration = backing.evidence.silence?.noCommitmentDuration;
    return next !== undefined && duration !== undefined && next - from > duration;
  }, false);
}

/** One party the backer pays for one redemption, and how much of it. */
export interface Payment {
  readonly payee: Uint8Array;
  readonly quantity: bigint;
}

/**
 * A redemption the gap settled: the demand it settles, and who is paid for it.
 *
 * A challenge does not void this. §C2b: "On publication the redemption pays the
 * request's presenter instead" — the payee moves, the settlement stands, and the
 * claims are the backer's either way. `payments` always sums to `quantity`.
 */
export interface Redemption {
  /** The demand settled, by the hash of its own canonical encoding. */
  readonly demandHash: Uint8Array;
  /** The holder who filed it. Not necessarily who gets paid. */
  readonly claimant: Uint8Array;
  readonly quantity: bigint;
  /** Who the backer pays, and how much: the claimant, unless challenged. */
  readonly payments: readonly Payment[];
  /** The witnessed index the release leg was published at. */
  readonly releasedAt: bigint;
  /** The last index at which a challenge is still heard. */
  readonly challengeClosesAt: bigint;
  /** Whether the window has closed, so the payee can no longer move. */
  readonly settled: boolean;
}

/** A settlement seen during the walk: the demand as it stood, and when. */
interface Settlement {
  readonly record: DemandRecord;
  readonly at: bigint;
}

/**
 * Fold the served log, then the gap's legs on top of it, each judged at the
 * index the venue witnessed it at. Returns what the gap settled, together with
 * the transfer requests published against the same backing — the raw material
 * for a challenge.
 *
 * A leg the law refuses is skipped rather than fatal: anyone may publish
 * anything at the venue, so a publication nobody could have accepted is noise,
 * not a corrupt log.
 */
/**
 * The commit a lock would settle on: the earliest witnessed one signed by every
 * party the lock names. Anyone may publish anything under any attempt id, so the set
 * the lock names is what picks a sequencer's own commit out of the noise, and
 * earliest witnessing wins: a commit republished later cannot un-commit an
 * attempt the record already showed.
 */
export function witnessedCommitFor(
  venue: Venue,
  lock: { readonly attemptId: Uint8Array; readonly parties: readonly Uint8Array[]; readonly decisionVenue: Uint8Array },
): WitnessedCommit | undefined {
  return answering(() => {
    // A set leg names no venue: it settles with its set on the holder's release,
    // and no witnessed object reaches it — read here, once, so the sequencer's
    // settle and gate, adoption and the verifier's fold all agree.
    // Adversarial shape first: a record that is not a lock answers nothing,
    // rather than reading as a lock on another venue.
    if (!(lock.decisionVenue instanceof Uint8Array) || lock.decisionVenue.length !== 32) return undefined;
    if (!Array.isArray(lock.parties) || !(lock.attemptId instanceof Uint8Array)) return undefined;
    if (compareBytes(lock.decisionVenue, NO_DECISION_VENUE) === 0) return undefined;
    // And a lock that names a venue is read on THAT venue: handed another
    // record, this reader was not looking — which is a refusal, not "no commit
    // was witnessed" (found by the 2026-08-22 audit: a verifier holding the
    // wrong venue folded a withdrawal the operator, reading the right one,
    // refused).
    if (compareBytes(lock.decisionVenue, venue.id) !== 0) {
      throw new VenueError("this lock names another decision venue: this record does not answer for it");
    }
    return venue
      .commitsFor(lock.attemptId)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .find((w) => commitSatisfies(w.commit, lock.parties));
  }, undefined);
}

/**
 * Whether the record already shows this lock's half of an attempt committed: a
 * valid commit witnessed while the lock was live. §C3's one predicate, read
 * against the venue because the law cannot see it. The sequencer asks before it
 * co-signs a withdrawal of a lock, on its submit path and its gap path alike, and
 * walkGap asks before it folds one — so a verifier's view of a gap and the
 * operator's adoption of it agree (found reviewing 24c: they did not). A venue's
 * refusal propagates, as everywhere.
 */
export function committedInTime(venue: Venue, lock: LockRecord): boolean {
  return answering(() => {
    const witnessed = witnessedCommitFor(venue, lock);
    return witnessed !== undefined && lockIsLive(lock, witnessed.at);
  }, false);
}

/**
 * Whether a gap publication is one the record can take on its own. A set — a
 * presentation on a backing with reliance or a claims payout — is several
 * operations applied as one, and the venue holds operations one at a time; so in
 * a gap a set neither opens (its demand) nor settles (the head's release, any
 * leg's), while a plain presentation flows through. An acceptance is the
 * backer's whole act and is admitted — except where P pays in claims, since it
 * must bring the paying lock with it (slice 26's review: refusing a timely
 * answer on a reliance-only backing recorded a backer that answered as
 * unanswered; while it stands the holder's set waits for the operator, which
 * is the gap's posture for a set). One predicate,
 * read by the operator's adoption and by the verifier's fold of the same gap, so
 * the two never disagree about what happened in it (24c's lesson).
 *
 * Every kind decided, none defaulted: an allow-list is where a new kind goes to
 * be forgotten (24a), and the `default` arm this once had would have admitted
 * the next kind added without anyone deciding about it (found by the 2026-08-22
 * audit). The `commit` arm here and in isLeg is decided and dead: no venue hands
 * a commit to publishedOpsFor (publishOp refuses one; an Ergo sync skips the
 * nameless record).
 */
export function admittedInGap(
  backing: Backing,
  op: PublishedOp,
  /** Whether that holder's lock stands under that hash — a lock's slot is its holder's own. */
  lockStands: (hash: Uint8Array, holder: Uint8Array) => boolean,
): boolean {
  const hasLegs = backing.reliance.length > 0 || paysInClaims(backing.payout);
  switch (op.kind) {
    case "demand":
      return !hasLegs;
    case "acceptance":
      // An answer is the whole act, except where it must bring the payout with it.
      return !paysInClaims(backing.payout);
    case "release":
      return !hasLegs && !lockStands(op.demandHash, op.holder);
    case "withdrawal":
    case "issue":
    case "transfer":
    case "burn":
    case "lock":
    case "commit":
      // Whether a kind is a gap leg at all is isLeg's question; this one only
      // asks whether a leg that is admitted may be taken on its own.
      return true;
  }
  return unknownOpKind(op);
}

function walkGap(
  venue: Venue,
  backing: Backing,
  served: ServedState,
  state: LedgerState,
): Settlement[] {
  const settlements: Settlement[] = [];
  const chain = successionOf(backing, venue);
  // The chain this walk already holds, threaded — walked once here and once
  // inside gapLegsFor, the same record was verified twice per call (found by
  // the slice-37 panel's inventory angle).
  for (const witnessed of gapLegsFor(venue, backing, chain)) {
    // "Redemption against the LAST witnessed snapshot": the snapshot in hand
    // must be the one that was last when this leg was published. Asked about the
    // present instead, an operator that would rather a redemption were
    // unresolvable could make it so by publishing one more commitment — and a
    // backer-run operator is exactly the party with that motive.
    if (!isLatestAt(venue, backing, chain, served, witnessed.at)) continue;
    if (!admittedInGap(backing, witnessed.op, (hash, holder) => lockIn(state, hash, holder) !== undefined)) continue;
    // A release settles the demand and drops it, so the record has to be read
    // before the law applies the leg that removes it.
    // The refusal the sequencer applies on adoption: a withdrawal of a lock the
    // record already shows committed is not a leg that happened, and a verifier
    // that folded it would free what the operator, reading the same record,
    // keeps reserved.
    if (witnessed.op.kind === "withdrawal") {
      const lock = lockIn(state, witnessed.op.demandHash, witnessed.op.holder);
      // A lock naming a venue this reader does not hold is one leg it cannot
      // judge: skipped, the conservative side (a withdrawal folded could free
      // what a commit settled elsewhere), not a refusal of the whole backing —
      // one stranger's bundle lock must not make every other holder's
      // redemption unreadable (found reviewing the audit slice, twice). The
      // operator never holds such a lock: takeOver refuses the log.
      if (
        lock !== undefined &&
        compareBytes(lock.decisionVenue, NO_DECISION_VENUE) !== 0 &&
        compareBytes(lock.decisionVenue, venue.id) !== 0
      ) {
        continue;
      }
      if (lock !== undefined && committedInTime(venue, lock)) continue;
    }
    const settling =
      witnessed.op.kind === "release"
        ? state.demands.get(bytesToHex(witnessed.op.demandHash))
        : undefined;
    try {
      applyEntry(state, backing, witnessed.op, witnessed.at);
    } catch {
      continue;
    }
    if (settling !== undefined) settlements.push({ record: settling, at: witnessed.at });
  }
  return settlements;
}

/**
 * Who the backer pays for one redemption: §C2b's challenge, generalised to
 * however many spends the operator swallowed.
 *
 * "Anyone may publish at the venue the holder-signed transfer request that spent
 * the named claim... on publication the redemption pays the request's presenter
 * instead." Under transparent a request spent the claim iff the SNAPSHOT could
 * have served it — the operator would have taken it, and went dark instead — so
 * the requests are folded onto a copy of the snapshot in the order the venue
 * witnessed them, and the redemption pays whoever ends up holding the units it
 * claimed. The law does the judging: a forged signature, a nonce already spent,
 * units the claimant never had, all refuse themselves.
 *
 * That gives four properties without four rules. Two conflicting requests at one
 * nonce are the claimant equivocating, and the earlier one wins because the
 * second finds its nonce spent — witnessing pins order (§C2). A chain of the
 * claimant's own spends pays each payee in turn, rather than the first and
 * nobody else. A request for more than was claimed redirects only what the
 * redemption pays. And a demand already standing in the snapshot cannot be
 * challenged at all, because its units were locked and its nonce spent before
 * the darkness — the lock had already done this job.
 *
 * **It pays the payee named in the request, not whoever published it.** The
 * spec's words are "pays the request's presenter", and its next clause explains
 * why they are normally the same party ("the payee already holds that request").
 * Read literally, anyone who merely saw a holder-signed transfer could publish
 * it and take the payment from the party it was made out to. See DECISIONS.md.
 *
 * The window bounds it and nothing else does: a request is evidence rather than
 * an operation, so it is not gated on the gap the legs are gated on. §C2b gives
 * the redemption a DECLARED window, and cutting it short the moment the operator
 * returns would let a prompt return decide how long anyone has to object.
 */
function paymentsFor(
  backing: Backing,
  snapshot: LedgerState,
  record: DemandRecord,
  requests: readonly WitnessedOp[],
  closesAt: bigint,
): Payment[] {
  const state = copyState(snapshot);
  const payments: Payment[] = [];
  let unpaid = record.quantity;
  // In sequence order, then in witnessed order. A chain has to be folded in the
  // order the claimant signed it: read in publication order instead and a payee
  // who reached the venue ahead of the one before them in the chain is passed
  // over and never reconsidered — which is whoever was quickest, deciding who
  // is paid. Witnessed order still settles the case it is for, which is two
  // requests at ONE nonce: that is the claimant equivocating, and the earlier
  // one wins (§C2, witnessing pins order).
  for (const witnessed of inSequenceOrder(requests, record.holder)) {
    const request = witnessed.op;
    if (request.kind !== "transfer") continue;
    if (witnessed.at > closesAt) continue;
    // **The chain starts where the claim leg stands, or not at all.** A spend
    // displaces this claim only by occupying its own point in the claimant's
    // sequence, or by following one that did. Take any spend that merely folds
    // and two of them go wrong: a spend of the claimant's OTHER units — free of
    // the demand's lock, and so nothing to do with the claimed ones — redirects
    // the payment; and where a holder files twice in one gap, one spend is paid
    // for against both claims.
    if (payments.length === 0 && request.nonce !== record.nonce) continue;
    try {
      applyEntry(state, backing, request, undefined);
    } catch {
      continue;
    }
    const quantity = request.quantity < unpaid ? request.quantity : unpaid;
    payments.push({ payee: copyBytes(request.to), quantity });
    unpaid -= quantity;
    if (unpaid === 0n) break;
  }
  if (unpaid > 0n) payments.push({ payee: copyBytes(record.holder), quantity: unpaid });
  return payments;
}

/**
 * This holder's published transfer requests, by nonce and then by the index the
 * venue witnessed them at. Both keys are needed and neither is enough: the nonce
 * is the order the claimant signed in, and the witnessed index is the only thing
 * that separates two requests signed at one nonce.
 */
function inSequenceOrder(requests: readonly WitnessedOp[], holder: Uint8Array): WitnessedOp[] {
  return requests
    .filter(
      (w) =>
        w.op.kind === "transfer" &&
        compareBytes(w.op.from, holder) === 0 &&
        // A request that pays the claimant moved nothing away from them, so it
        // is no evidence that anything was spent.
        //
        // **It is not a defence, and must not be read as one.** It was added
        // as one, against a claimant who pre-empts a genuine request by
        // publishing at the contested nonce first. That is a real attack and
        // this does not stop it: keys are free, so the claimant pays a key
        // generated for the purpose and this check — which asks only whether
        // the payee is the claimant's OWN key — sees an ordinary transfer.
        // Kept because it is a true statement about what evidence is, not
        // because it buys anything. See DECISIONS.md for what would.
        compareBytes(w.op.to, holder) !== 0,
    )
    .filter(isTransfer)
    .sort((a, b) => {
      if (a.op.nonce !== b.op.nonce) return a.op.nonce < b.op.nonce ? -1 : 1;
      return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
    });
}

/** Whether the served state was the backing's latest commitment before `at`. */
function isLatestAt(
  venue: Venue,
  backing: Backing,
  chain: readonly Succession[],
  served: ServedState,
  at: bigint,
): boolean {
  // The backing's, not the party-then-in-force's: an heir seated with nothing
  // published would otherwise make every redemption in its predecessor's gap
  // unresolvable, and being unresolvable is exactly what its operator wants.
  // And the root is the comparison, never the signer — replayLatestState says
  // why, and the two must agree or a leg resolves for one reader and not the
  // other.
  const latest = lastCommitmentInForce(chain, venue, before(at))?.commitment;
  if (latest === undefined) return false;
  if (latest.sequence !== served.commitment.sequence) return false;
  return compareBytes(latest.root, served.commitment.root) === 0;
}

/**
 * Every snapshot redemption this backing's gap settled, in the order the
 * releases were witnessed, and who the backer pays for each.
 *
 * Each leg is judged against the snapshot that was this operator's last when
 * that leg was published — §C2b's "redemption against the last witnessed
 * snapshot", read at the index the leg was witnessed at rather than at the index
 * somebody asks. Against an older snapshot a holder who had since spent the
 * units would still prove the state that shows them, and here they would be paid
 * for it; against "whatever is latest now", one further commitment would make a
 * settled redemption unresolvable, which is a move its operator may well want.
 *
 * A verifier: the state comes from an operator with a motive, and the venue's
 * publications come from anyone at all, so anything malformed is a redemption
 * that does not resolve rather than a throw.
 */
export function snapshotRedemptions(
  venue: Venue,
  backing: Backing,
  served: ServedState,
): Redemption[] {
  return answering(() => {
    const clause = backing.evidence.silence;
    if (clause === undefined) return [];
    if (!venueIsDeclared(venue, backing)) return [];
    const state = replayServedState(backing, venue, served);
    if (state === undefined) return [];

    // The snapshot as it stood before any leg touched it: what a request has to
    // have been servable against to have spent anything.
    const snapshot = copyState(state);
    const requests = venue.publishedOpsFor(backing.name);
    return walkGap(venue, backing, served, state).map(({ record, at }) => {
      const closesAt = at + clause.challengeWindow;
      return {
        payments: paymentsFor(backing, snapshot, record, requests, closesAt),
        demandHash: copyBytes(record.hash),
        claimant: copyBytes(record.holder),
        quantity: record.quantity,
        releasedAt: at,
        challengeClosesAt: closesAt,
        settled: venue.witnessedIndex() > closesAt,
      };
    });
  }, []);
}
