// What can be proven, against whom, on one screen.
//
// The system's posture everywhere is that misbehaviour is made **provable**
// rather than prevented. Invariant 22 makes two roots signed at one sequence an
// operator's provable fault (`isEquivocation`, commitment.ts). §C2b grades
// silence on facts a stranger checks against the published record. §C3 makes
// dishonour "publicly checkable... with nobody reporting anything". Nothing here
// stops a party misbehaving; it makes the misbehaviour undeniable afterwards,
// and §15 prices the key's history accordingly.
//
// That posture had one gap: it covered the operator and never the holder.
//
// §C2b's challenge window is where the gap bites. A claimant who signed her
// holding away and then redeems the last witnessed snapshot has signed **two
// operations at one point in her own nonce sequence**, and the protocol cannot
// tell which of them her dark operator accepted — the evidence for that went
// dark with it. So it cannot always pay the right party. What it can always do
// is name the fault, and these are the predicates that do it:
//
//   - `equivocatingSigner` — one key authorised two operations at one nonce.
//     The holder's fault, and the one that was missing.
//   - `isDoubleAcceptance` — an operator co-signed both halves of that. Under
//     §C2's backer-run default the operator key is the backer's, so this names
//     the party that owes the money.
//   - `isDoublePosition` — an operator co-signed two receipts that cannot both
//     describe one append-only log: two operations at one position, or one
//     operation at two. Either way one of its receipts is a lie about its own log.
//   - `withdrawnAgainstCommit` — an operator co-signed a withdrawal of a lock
//     the shared record shows committed in time. Its own door refuses exactly
//     this ("the attempt committed in time: settle it"), so the pair is the
//     refusal turned into the fault it proves.
//   - `settledInPart` — one commitment carrying half a settlement. One
//     operator's doors apply a set as one act, so half of one is a history no
//     door produced.
//   - `isRewrittenHistory` — an operator committed a log that takes back one it
//     had already committed. An append-only log may grow and may not shrink, and
//     no committed entry may change. This is what restoring from stale data and
//     carrying on produces, and it is the fault ACROSS sequences where
//     isEquivocation is the fault at one.
//
// A fourth reading lives beside the receipt rather than here, because most of
// its answers are ordinary rather than faults: `receiptStatus` (receipt.ts)
// tells a payee whether a committed log holds their operation, has not reached
// it yet, holds something else, or carries nothing for the backing at all. Only
// "holds something else" is this file's business; naming it again there would be
// a second name for one thing.
//
// The two operator faults also catch a **botched failover**: two live servers
// holding one operator key, with no leader election between them, produce
// exactly these artefacts. The protocol cannot distinguish that from malice and
// does not try, which is the same standard it already applies to a self-framing
// commitment equivocation — see docs/PROTOCOL_RULES.md on the one-writer obligation, and on
// why a threshold construction prevents this rather than merely recording it.
//
// **The signer is derived, never asserted.** A caller who could name the signer
// could choose who is at fault, so the signer comes from the law's own rule
// (`signerFromTerms`, ledger.ts) and the signature has to verify under it. The
// price is that a release or a withdrawal cannot be proved by this pair alone:
// the law reads their signer from the demand they name, which is not in the
// operation. They need that demand too, which is a different function's job.
//
// Verifiers, all of them: the bytes come from whoever is exhibiting them, so
// anything malformed is a fault that is not proven rather than a throw.

import { backingName, paysInClaims, type Backing } from "./backing.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type Terms } from "./closure.js";
import { compareBytes, copyBytes } from "./bytes.js";
import { verifySignatureStrict } from "./keys.js";
import { applyEntry, emptyState, lockIn, replayLog, signerFromTerms } from "./ledger.js";
import { demandHash as hashOfDemand, legMismatch, type LegTerms } from "./presentation.js";
import { committedInTime } from "./recovery.js";
import { opIdentityOfEntry, opMessageOfEntry, type PublishedOp } from "./oplog.js";
import { committedLogFor, type ServedState } from "./commitment.js";
import { receiptCovers, receiptStatus, isOperatorReceipt, type Receipt } from "./receipt.js";
import { successionOf, termOf, type Succession } from "./replacement.js";
import { answering, type Venue } from "./venue.js";

/** An operation and the operator co-signature that accepted it. */
export interface AcceptedOp {
  readonly op: PublishedOp;
  readonly receipt: Receipt;
}

/**
 * The key proved to have authorised two operations at one point in its own
 * nonce sequence, or undefined if these two do not prove it.
 *
 * A nonce is per (signer, backing) and the law consumes exactly one per
 * operation, so two different operations validly signed by one key at one nonce
 * is a history that cannot exist. Only one of them can ever have been applied,
 * and the signer knew that when it signed the second.
 *
 * It returns the key rather than a boolean because the key is the point: it is
 * derived here, so the caller does not otherwise have it, and naming the party
 * is what the proof is for.
 *
 * Not a fault: the identical operation twice. Invariant 26 exists so that a
 * repeat is safe, so equivocation is two DIFFERENT operations, never one sent
 * twice — which is why the canonical messages are compared rather than the
 * objects.
 */
export function equivocatingSigner(
  backing: Backing,
  a: PublishedOp,
  b: PublishedOp,
): Uint8Array | undefined {
  try {
    // A commit carries no nonce, so it cannot be half of an equivocation at one
    // — there is no point in a sequence for two of them to collide at.
    if (a.kind === "commit" || b.kind === "commit") return undefined;
    if (a.nonce !== b.nonce) return undefined;
    const signer = signerFromTerms(backing, a);
    if (signer === undefined) return undefined;
    if (compareBytes(signer, signerFromTerms(backing, b) ?? new Uint8Array(0)) !== 0) {
      return undefined;
    }
    const messageA = opMessageOfEntry(backing.name, a);
    const messageB = opMessageOfEntry(backing.name, b);
    if (compareBytes(messageA, messageB) === 0) return undefined;
    if (!verifySignatureStrict(a.signature, messageA, signer)) return undefined;
    if (!verifySignatureStrict(b.signature, messageB, signer)) return undefined;
    return copyBytes(signer);
  } catch {
    return undefined;
  }
}

/**
 * Whether one operator co-signed both halves of a signer's equivocation: two
 * operations that one nonce cannot hold, each carrying that operator's receipt.
 *
 * An honest operator refuses the second — "it co-signs, and refuses a second
 * spend by declining to sign" (§C2) — so accepting both is its own fault
 * whatever its reason, and the reasons are collusion with the claimant, or two
 * of its own servers running without a leader.
 *
 * A boolean, where `equivocatingSigner` returns a key: the operator at fault is
 * already in the receipts the caller passed in, so there is nothing to hand back
 * that it does not have.
 *
 * Takes the served state since 28b, because the excuse must show the absence:
 * a receipt the record reads `lapsed` proves nothing, and whether it does is a
 * question about the record — which an accuser fetches anyway, since anything
 * checked against a commitment has to be served (invariant 23).
 */
export function isDoubleAcceptance(
  backing: Backing,
  venue: Venue,
  served: ServedState,
  a: AcceptedOp,
  b: AcceptedOp,
): boolean {
  return answering(() => {
    if (equivocatingSigner(backing, a.op, b.op) === undefined) return false;
    // Both halves by ONE operator, and one that served this backing. Two
    // different operators of the chain accepting one nonce each is the handover
    // going wrong rather than either of them equivocating, and naming one of
    // them for it would be naming the wrong party.
    if (compareBytes(a.receipt.operator, b.receipt.operator) !== 0) return false;
    if (!isOperatorReceipt(backing, venue, a.receipt)) return false;
    if (!isOperatorReceipt(backing, venue, b.receipt)) return false;
    // **The excuse is the absence, not the receipt.** §C2b licenses an era that
    // ended in a return or a handover to drop its TAIL — never to disown an
    // operation the record carried. So a receipt is excused exactly where the
    // record reads it `lapsed`: era ended with license AND the operation absent.
    // Excusing on the era alone made every receipt of an adopted gap leg — a
    // carried operation signed in the era the return closes — a permanent
    // excuse token for later lies at its position (found reviewing this slice).
    // The residuals, recorded in DECISIONS: an operator can stamp a lie with a
    // stale era, which a payee reading the receipt's freshness refuses at
    // hand-over; and a return or an arranged succession still launders a
    // live-era pair whose lying half the record then rightly lacks — priced by
    // the public grade, and by §15's price on the succession.
    if (receiptStatus(backing, venue, a.receipt, served) === "lapsed") return false;
    if (receiptStatus(backing, venue, b.receipt, served) === "lapsed") return false;
    // Each receipt has to cover the operation it is exhibited with, ON THIS
    // BACKING, or an accuser pins any operator's signature to any operation it
    // likes — including a receipt the operator issued perfectly correctly
    // somewhere else, since one operator serves many backings and an operation
    // object carries no backing name.
    return (
      receiptCovers(backing.name, a.op, a.receipt) &&
      receiptCovers(backing.name, b.op, b.receipt)
    );
  }, false);
}

/**
 * Whether one operator co-signed two receipts on one backing that cannot both
 * describe one append-only log: two different operations into one position, or
 * one operation into two positions (a nonce and a position each admit one; the
 * mirror read as "pending" with nobody named — the 2026-08-22 audit) of one
 * backing's log. Positions are the log's own append indices, so a position
 * holds one operation and one of these receipts misdescribes the operator's own
 * log — which is what a receipt is for ("witnessed order: a receipt binds an
 * operation to its committed position", §C2).
 *
 * Needs no operations at all: the receipts alone carry backing, position and
 * operation hash, and the operator signed over all three. The backing is passed
 * so that the claim is about THIS backing's declared operator rather than about
 * whichever key the receipts happen to name.
 */
export function isDoublePosition(
  backing: Backing,
  venue: Venue,
  served: ServedState,
  a: Receipt,
  b: Receipt,
): boolean {
  return answering(() => {
    if (compareBytes(a.operator, b.operator) !== 0) return false;
    if (!isOperatorReceipt(backing, venue, a) || !isOperatorReceipt(backing, venue, b)) return false;
    // As in isDoubleAcceptance: the excuse is the absence, not the receipt — a
    // receipt is excused exactly where the record reads it `lapsed`.
    if (receiptStatus(backing, venue, a, served) === "lapsed") return false;
    if (receiptStatus(backing, venue, b, served) === "lapsed") return false;
    // Two receipts by one operator on one backing that cannot both describe one
    // append-only log: one position holding two operations — or, the mirror, one
    // operation receipted into two positions, which a nonce and a position each
    // admit once and which read as "pending" with nobody named for it (found by
    // the 2026-08-22 audit).
    const samePosition = a.position === b.position;
    const sameOp = compareBytes(a.opHash, b.opHash) === 0;
    return samePosition !== sameOp;
  }, false);
}

/**
 * Whether one operator committed a history that takes back a history it had
 * already committed. An operation log is append-only, so a later commitment must
 * have the earlier one's log as a **prefix**: it may grow and it may not shrink,
 * and no entry already committed may change.
 *
 * This is the artefact an operator produces by restoring from stale data and
 * carrying on — it commits an old log at a new sequence, so the log shrinks —
 * and equally the artefact of a quiet rewrite, where the log grows but an
 * earlier entry is not what it was. Neither is reachable by isEquivocation,
 * which is two roots at ONE sequence; this is the fault across sequences.
 *
 * **Which state came first is derived, never taken from the argument order.** A
 * caller who could label them could choose which log is the rewrite, so the two
 * arguments are symmetric. Within one operator that order is its own commitment
 * sequence; across a handover it is the chain, because a sequence is an
 * operator's own count and says nothing about anyone else's. Two states at one
 * sequence of one operator answer false: that is isEquivocation's fault, and
 * naming it twice would let one artefact be reported as two.
 *
 * **It reaches across a handover, and has to.** §C2 gives a successor force only
 * over a state "it serves in full", so a successor committing a shorter log than
 * the predecessor's is the same fault by the party the chain just handed the
 * backing to. Restricting this to one operator's own history would have made
 * exactly the handover unwatched.
 *
 * Compared by canonical message rather than by object, because the message is
 * what the commitment commits to — the signature beside an entry is served, not
 * committed (oplog.ts).
 */
/**
 * Whether this operator was still in force for the backing when it committed the
 * state at `sequence` — the question that decides whether dropping the backing
 * was a fault or obedience.
 *
 * **It must be stable forever, and asking who is in force NOW is not.** A fault
 * a stranger can check today and not tomorrow is no fault proof at all: the
 * remedy for a dropped backing IS replacement, so reading the current operator
 * would erase the proof at the exact moment the holder used it, and let an
 * operator launder its record by arranging its own succession (§15 prices a
 * key's history, so that is worth something).
 *
 * So it is answered from the venue's own record, both halves of which are fixed
 * once witnessed. A commitment carries no venue index — a sequence is the
 * operator's own count (slice 13) — but the venue refuses a sequence that does
 * not extend, so **publication order is sequence order**, and the last
 * commitment this operator got witnessed before its successor took force pins
 * the boundary. At or below that sequence is before the handover.
 *
 * A state never published at all cannot manufacture an accusation either: its
 * sequence is above that boundary, or it collides with a published one, and a
 * collision is isEquivocation's to name.
 *
 * **A key that appears in the chain twice answers for each term separately.**
 * The rule-holder may re-appoint a former operator, and only succeeding ITSELF is
 * refused. This used to read that key's FIRST term only, which was not the safe
 * direction it was recorded as: it made every re-appointed key exempt from the
 * fault by construction, and a stale pre-handover book re-asserted in a second
 * term read as growth. `termOf` is the per-term sequence window that entry said
 * would cost a lot of arithmetic; it costs one loop, and it is the same read
 * `isRewrittenHistory` needs to ORDER two states, so it is one mechanism serving
 * both rather than two. See DECISIONS.md.
 *
 * A state belonging to no term at all answers false, which is this file's
 * direction when it cannot tell: say nothing rather than accuse. That covers a
 * successor's own commitment inside its lead time, when §C2 forbids it to
 * carry this backing — and, past the first handover, EVERY key's unwitnessed
 * sequences above its witnessed record, because a shared operator's ordinary
 * service while out of force produces signed states that drop this backing
 * honestly, and the record cannot tell those from an in-force key's
 * unwitnessed drop. So an unwitnessed dropped state proves this fault only
 * against a never-replaced genesis operator; everywhere else the witnessed
 * drop and the non-service grade are the reach. Priced in DECISIONS — the
 * regression review of the fix round is where the two policies this replaced
 * were found to be one ambiguity treated two ways.
 */
function committedWhileInForce(
  chain: readonly Succession[],
  venue: Venue,
  operator: Uint8Array,
  sequence: bigint,
): boolean {
  return termOf(chain, venue, operator, sequence) !== undefined;
}

export function isRewrittenHistory(
  backing: Backing,
  venue: Venue,
  a: ServedState,
  b: ServedState,
): boolean {
  return answering(() => {
    const first = committedLogFor(backing, venue, a);
    const second = committedLogFor(backing, venue, b);
    if (first === undefined || second === undefined) return false;

    const chain = successionOf(backing, venue);
    // **One signer needs no ranking at all**: a key's own sequence field is its
    // own assertion of order, so two of its states compare directly, witnessed
    // or not — which is what keeps its unwitnessed rewrite provable however the
    // chain grew after it signed. A first draft ranked same-signer pairs
    // through `termOf` too, and one published replacement then closed the
    // predecessor's term, made its real rewrite unplaceable, and erased a
    // provable fault for one free record (found reviewing this slice).
    //
    // **Across keys, a state ranks by the term the record places it in**, and
    // one the record cannot place ranks nowhere and accuses nobody: an honest
    // operator's served-but-never-published state from before its handover is
    // indistinguishable, by sequence alone, from a state it signed in a later
    // term — ranked there, its OLD serving sorted after its successor's
    // genuinely later state and read as a shrink, a permanent fault the
    // operator armed by consenting to its own re-appointment (same round).
    const sameSigner = compareBytes(a.commitment.operator, b.commitment.operator) === 0;
    const rankA = sameSigner ? 0 : termOf(chain, venue, a.commitment.operator, first.sequence);
    const rankB = sameSigner ? 0 : termOf(chain, venue, b.commitment.operator, second.sequence);
    if (rankA === undefined || rankB === undefined) return false;

    if (rankA === rankB && first.sequence === second.sequence) return false;
    const secondIsEarlier =
      rankA !== rankB ? rankB < rankA : second.sequence < first.sequence;
    const earlier = secondIsEarlier ? second : first;
    const later = secondIsEarlier ? first : second;
    // Kept in step with the swap, because whether a DROP is a fault turns on who
    // signed it. A log comparison does not care.
    // (committedWhileInForce is the read below; settledInPart asks it too.)
    const laterOperator = secondIsEarlier ? a.commitment.operator : b.commitment.operator;

    // **A backing that vanishes is a log that shrank to nothing**, so it is this
    // fault rather than a second one beside it. The other direction is not: an
    // operator that had not yet registered the backing committed states without
    // it, and growing from nothing is growth. Both states dropping it says only
    // that neither ever carried it here.
    if (later.kind === "dropped") {
      if (earlier.kind !== "log") return false;
      // **But only an operator still in force has no excuse for dropping it.**
      // §C2: "From the effective index the old attester's co-signatures stop
      // counting" — a replaced operator is SUPPOSED to stop carrying the
      // backing, and it goes on serving its other ones, so its later commitments
      // drop this one as a matter of obedience. Naming that a fault accuses a
      // retired party for doing what the handover told it to, which is the shape
      // slice 9 found twice and slice 14 once more.
      return committedWhileInForce(chain, venue, laterOperator, later.sequence);
    }
    if (earlier.kind === "dropped") return false;
    if (later.opLog.length < earlier.opLog.length) return true;
    for (let i = 0; i < earlier.opLog.length; i++) {
      // The entry's identity, not merely its message: a commit's signature set
      // decides which locks it converted, so two objects at one position are two
      // different histories and the prefix comparison has to see it (the same
      // reading the root takes — commitment.ts).
      const before = opIdentityOfEntry(backing.name, earlier.opLog[i] as PublishedOp);
      const after = opIdentityOfEntry(backing.name, later.opLog[i] as PublishedOp);
      if (compareBytes(before, after) !== 0) return true;
    }
    return false;
  }, false);
}

/**
 * The operator co-signed a withdrawal of a lock the shared record shows
 * committed in time: the attempt id proven, or undefined if this state does not
 * prove it.
 *
 * Sound with no clock, which is what makes it a fault a stranger can hold. An
 * honest withdrawal opens only past the lock's timeout (24c), and an in-time
 * commit is witnessed at or before that timeout — witnessing is shared and
 * pinned in order (§C2), so by the time any door could lawfully take the
 * withdrawal, the commit was on the record for the operator to read. Its own
 * door reads it ("the attempt committed in time: settle it"); co-signing anyway
 * is either ignoring the record or co-signing before the timeout it was bound
 * to wait out, and both are its own. A commit first witnessed past the timeout
 * proves nothing: it was never in time, and nothing here fires after the fact
 * (a venue witnesses at its current index, so no later publication can become
 * an earlier commitment).
 *
 * Read on the venue the lock names, as every commit read is: a lock naming
 * another venue is one leg this reader cannot judge — the gap fold's own
 * conservative side — and a withdrawal that resolves to a demand is the holder
 * walking away, which no commit reaches.
 *
 * **The proof stands on the lawful prefix.** The entries up to and including
 * the withdrawal are this operator's committed, replayable history; what
 * follows cannot buy the fault back. Requiring the whole log to replay handed
 * the operator a dodge priced at one garbage entry — its state went
 * unauthentic, which nothing names, while the fault went unprovable (found
 * reviewing this slice).
 *
 * **The proof names the operator of the book it stands in**, and the door
 * keeps that honest: takeOver refuses a log carrying this artefact, so an
 * heir never inherits its predecessor's withdrawal unknowingly — one that
 * carries it anyway chose to commit it, and §15 prices the key's history.
 */
export function withdrawnAgainstCommit(
  backing: Backing,
  venue: Venue,
  served: ServedState,
): Uint8Array | undefined {
  return answering(() => {
    const committed = committedLogFor(backing, venue, served);
    if (committed === undefined || committed.kind === "dropped") return undefined;
    const state = emptyState();
    let proven: Uint8Array | undefined;
    for (const entry of committed.opLog) {
      if (entry.kind === "withdrawal") {
        // Read before the law applies it, since applying is what removes it.
        // One compare carries the venue scoping: a set leg names
        // NO_DECISION_VENUE, which is no venue's id — and witnessedCommitFor
        // answers a leg with undefined besides.
        const lock = lockIn(state, entry.demandHash, entry.holder);
        if (
          proven === undefined &&
          lock !== undefined &&
          compareBytes(lock.decisionVenue, venue.id) === 0 &&
          committedInTime(venue, lock)
        ) {
          proven = copyBytes(lock.attemptId);
        }
      }
      // The catch guards ONLY the law's application, which takes no venue and
      // so can never raise a venue's refusal — the old whole-fold catch ate
      // the one exception `answering` exists to let through, and an Ergo
      // view, whose commitsFor refuses BY DESIGN, read every log as faultless
      // (found reviewing this slice). The law's first refusal ends the
      // readable prefix, and the proof stands on that prefix.
      try {
        applyEntry(state, backing, entry, undefined);
      } catch {
        break;
      }
    }
    return proven;
  }, undefined);
}

/**
 * One commitment carrying half a settlement: the name of the leg backing whose
 * log shows the set's reservation taken and never converted under a settled
 * head — or converted under a head that never settled — or undefined if this
 * state does not prove it.
 *
 * §C3 settles a set as one act: the head's release and every leg's, applied
 * together, co-signed together, committed together. Within one operator's
 * commitment, FOR THE BACKINGS IT HELD THE PEN ON, that is the record's
 * invariant — the doors apply a set atomically, the committed marks advance
 * together at each publication, and `sameDuration` puts a set's backings
 * under one silence clause so a gap restores them together — so such a root
 * showing half a settlement is a history no door produced.
 *
 * **The pen-holder gate is what keeps this a fault of the guilty party.**
 * `commit()` roots every registered backing, in force or not — so a set
 * co-signed into the tail, a partial handover, and the operator's own gap
 * honestly produce a root with one restored half and one handed-over tail
 * (found reviewing this slice: the first draft called that operator at fault).
 * Head and each leg are therefore read only where the committing operator was
 * in force for that backing at this commitment's own sequence
 * (`committedWhileInForce`, the stable-forever read above); a half the pen
 * had left is 28b's strand wearing one root, and proves nothing.
 *
 * **Each half is the set's own act, not a byte under the right hash.** The
 * head must show the demand FILED (its hash recomputed from the entry — a
 * head that merely withdrew it still filed it, so the walk-away no longer
 * covers a taken payout; found reviewing this slice). The leg's half is read
 * through the fold, the way `withdrawnAgainstCommit` reads its lock: the
 * set's reservation is a lock entry under the demand's hash carrying the
 * set's own terms (`legMismatch`), and its conversion is a release whose
 * standing lock, at that point in the law, carried them — a one-unit decoy
 * locked and released under the hash exonerated the first draft. Direction
 * one (head settled, reservation taken, never converted) asks the
 * reservation was SEEN: an heir whose inherited leg log never held the set's
 * lock shows no half to miss, and its empty log is `isRewrittenHistory`'s
 * artefact, not a second name here.
 *
 * What deliberately does NOT fire, each the conservative side:
 *
 *   - **A leg backing absent from the state, or one the operator had handed
 *     over** — the strand, as above.
 *   - **A withdrawal is not half a settlement.** One-sided withdrawal is the
 *     stranded set's lawful exit, so only conversion counts on the leg.
 *   - **Terms not to hand, a lying resolver's answer, a log that does not
 *     replay, a head that never filed the demand.** Both logs must be lawful
 *     WHOLE: this proof needs an absence, and an absence cannot be read off a
 *     prefix — so one garbage entry hides the fault, at the price of a state
 *     nothing can authenticate (`stateIsAuthentic` false, snapshot redemption
 *     gone). Recorded, not patched: the sibling predicate proves a presence
 *     and keeps its prefix.
 */
export function settledInPart(
  backing: Backing,
  venue: Venue,
  terms: Terms,
  served: ServedState,
  demandHash: Uint8Array,
): Uint8Array | undefined {
  return answering(() => {
    const committed = committedLogFor(backing, venue, served);
    if (committed === undefined || committed.kind === "dropped") return undefined;
    if (!committedWhileInForce(successionOf(backing, venue), venue, served.commitment.operator, committed.sequence)) {
      return undefined;
    }

    const state = emptyState();
    let filed: { holder: Uint8Array; quantity: bigint } | undefined;
    let headReleased = false;
    try {
      for (const entry of committed.opLog) {
        if (entry.kind === "demand" && filed === undefined) {
          const hash = hashOfDemand({
            backing,
            holder: entry.holder,
            quantity: entry.quantity,
            instant: entry.instant,
            deadline: entry.deadline,
            nonce: entry.nonce,
          });
          if (compareBytes(hash, demandHash) === 0) {
            filed = { holder: entry.holder, quantity: entry.quantity };
          }
        }
        // **The DEMAND's release, not any release under its hash**, read exactly
        // as the law reads it: the record is (hash, holder), and where a lock of
        // that holder's stands here the law resolves lock-first, so the release
        // ends the lock and not the demand. Counting any release under the hash
        // read both directions of this proof wrongly — a hostile operator hid a
        // real half-settlement behind a one-unit decoy lock and its release
        // (direction 2), and an honest heir inheriting such a log was named for a
        // settlement that never happened (direction 1). The demand is always
        // filed before it can be released, so `filed` is set by then.
        if (
          entry.kind === "release" &&
          compareBytes(entry.demandHash, demandHash) === 0 &&
          filed !== undefined &&
          compareBytes(entry.holder, filed.holder) === 0 &&
          lockIn(state, entry.demandHash, entry.holder) === undefined
        ) {
          headReleased = true;
        }
        applyEntry(state, backing, entry, undefined);
      }
    } catch {
      return undefined;
    }
    if (filed === undefined) return undefined;

    const wanted: { name: Uint8Array; want: LegTerms }[] = [
      ...backing.reliance.map((entry) => ({
        name: entry.target,
        // Invariant 13's arithmetic, the sequencer's own legTerms shape.
        want: {
          quantity: filed.quantity * entry.count,
          holder: filed.holder,
          beneficiary: backing.obligor,
          converter: filed.holder,
        },
      })),
      ...(paysInClaims(backing.payout)
        ? [
            {
              name: backing.payout.backing,
              // §C3's payout slot, the sequencer's own payoutTerms shape.
              want: {
                quantity: filed.quantity * backing.payout.perUnit,
                holder: backing.obligor,
                beneficiary: filed.holder,
                converter: filed.holder,
              },
            },
          ]
        : []),
    ];
    for (const { name, want } of wanted) {
      const leg = terms(name);
      if (leg === undefined) continue;
      if (compareBytes(backingName(leg), name) !== 0) continue;
      const legLog = committedLogFor(leg, venue, served);
      if (legLog === undefined || legLog.kind === "dropped") continue;
      if (!committedWhileInForce(successionOf(leg, venue), venue, served.commitment.operator, committed.sequence)) {
        continue;
      }
      const legState = emptyState();
      let taken = false;
      let converted = false;
      let lawful = true;
      try {
        for (const entry of legLog.opLog) {
          if (
            entry.kind === "lock" &&
            compareBytes(entry.attemptId, demandHash) === 0 &&
            legMismatch(entry, want) === undefined
          ) {
            taken = true;
          }
          if (entry.kind === "release" && compareBytes(entry.demandHash, demandHash) === 0) {
            // The lock standing as the law reads it, before applying removes it.
            const lock = lockIn(legState, entry.demandHash, entry.holder);
            if (lock !== undefined && legMismatch(lock, want) === undefined) converted = true;
          }
          applyEntry(legState, leg, entry, undefined);
        }
      } catch {
        lawful = false;
      }
      if (!lawful) continue;
      if (headReleased && taken && !converted) return copyBytes(name);
      if (!headReleased && converted) return copyBytes(name);
    }
    return undefined;
  }, undefined);
}
