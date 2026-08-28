// The transparent sequencer (§C2).
//
// A sequencer serves the backings whose E field names its operator key. It is
// the front door to the claim layer: clients submit signed operations, the
// sequencer drives the transparent ledger underneath, and returns an operator
// co-signed receipt bound to the operation's position in the committed log. At
// a declared interval it publishes a commitment over the state it serves.
//
// It never holds funds. Its added value in the transparent setting (where the
// ledger already prevents double-spends) is fourfold:
//   - witnessed order: a receipt binds an operation to its committed position;
//   - idempotent replay (invariant 26): the same operation resubmitted returns
//     the identical prior receipt, and a different operation at an
//     already-spent nonce is declined by the ledger's NonceError — the
//     sequencer "refuses a second spend by declining to sign";
//   - commitments (invariants 22, 23): periodic signed roots over served
//     state, so a third party can verify state without trusting the
//     operator's live word;
//   - a witnessed clock: presentation (§C3) turns on indices, and invariant 21
//     forbids a time a party asserts alone, so the index comes from the venue —
//     which advances whether or not this operator publishes, so a sequencer
//     cannot freeze a deadline by going quiet.
//
// One venue per sequencer, taken at construction. The spec names the venue in E
// beside the operator; E carries only the operator key here, so one venue for
// the operator is the honest simplification — and it means there is exactly one
// clock, where a venue passed per call could give two answers to one predicate.
//
// Boundaries, per the design rules: the sequencer owns routing (is this
// backing mine?) and the clock, and raises SequencerError; the ledger owns the
// law and funds and raises LedgerError/NonceError; malformed fields raise
// EncodingError from the encoder. No layer re-checks or relabels another's
// verdict.
//
// **Coming back from silence.** §C2b: "a sequencer returning from silence adopts
// every nullifier witnessed during the gap before co-signing again", and the gap
// "runs from the first missed commitment until commitments resume". So returning
// IS committing, and it is PER BACKING — the era is the backing's own: while a
// publication on a backing would still have gap force (`gapOpen`, the verifier's
// own predicate read at the door) that backing's doors co-sign nothing — every
// act is refused and names the commit, and only a repeat is answered, from a
// book already restored; where the silence is this operator's own, the backing's
// book is first restored to the last commitment — what was co-signed after it
// was never witnessed, and "a payment is final when witnessed, not when
// co-signed" — then the gap is adopted, and that backing is served again from
// the index after the commitment. **A set is one act and dies as one, so it
// spans one silence clause** (sameDuration): its backings share their last
// commitment under one operator, so equal durations open and close their gaps
// together and a set in the tail is restored whole — which is what lets the
// restore stay per backing, and a receipt's death stay readable from one
// backing's terms (28b; slice 28a restored the whole book at once and DECISIONS
// records why that died). Adoption is enforced structurally rather than by a
// flag: every submit door is caught up before it answers anything, and `commit`
// adopts before it snapshots, so there is no order of calls in which this
// operator co-signs while ignoring what the venue witnessed without it — or
// co-signs onto a book the verifier's fold would contradict. Each adopted
// operation is judged at the index the VENUE stamped it with, so adoption is
// reproducible by anyone holding the same record — the sequencer asserts
// nothing about when. The plain reads (balance, opLog, snapshot, ...) answer
// the live book, which between commitments is always partly unwitnessed; what
// is final is the commitment.
//
// **Two ways to move value, and the parties pick per trade.** §C2: "Two honest
// answers, pick one. Extend §C3's prepare-decide-commit to any multi-sequencer
// transfer, at a round trip per payment. Or let payees accept partial-and-retry
// and price it, as card networks do." `submitTransfer` is the second — one
// sequencer, final on its co-signature, and what every trade with recourse
// wants. `submitLock` and `settle` are the first, for a bundle that must move
// entire or not at all.
//
// NOTE (later slices, see DECISIONS.md): dated instruments and the refusal
// aggregate (m', W') are out of scope.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { makeBacking, paysInClaims, type Backing } from "./backing.js";
import { compareBytes, copyBytes } from "./bytes.js";
import { signCommitment, stateRoot, type Commitment } from "./commitment.js";
import {
  replayLog,
  TransparentLedger,
  type BackingSnapshot,
  type DemandRecord,
} from "./ledger.js";
import {
  encodeBurn,
  encodeIssuance,
  encodeTransfer,
  type BurnOp,
  type IssuanceOp,
  type TransferOp,
} from "./messages.js";
import { opHashOfEntry, type OpLogEntry, type PublishedOp } from "./oplog.js";
import {
  commitMessage,
  demandHash,
  legMismatch,
  NO_DECISION_VENUE,
  type LegTerms,
  type AcceptanceOp,
  type Commit,
  type DemandOp,
  type LockOp,
  type ReleaseOp,
  type WithdrawalOp,
} from "./presentation.js";
import { copyReceipt, signReceipt, type Receipt } from "./receipt.js";
import { committedLogFor, type ServedState } from "./commitment.js";
import { isNamedSuccessor, operatorAt } from "./replacement.js";
import { admittedInGap, committedInTime, gapLegsFor, gapOpen, venueIsDeclared, witnessedCommitFor } from "./recovery.js";
import { withdrawnAgainstCommit } from "./fault.js";
import { revokedAt } from "./revocation.js";
import { type Venue, type WitnessedCommit } from "./venue.js";

/**
 * A lock as the log records it, built field by field rather than cast: a cast
 * here once suppressed the exhaustiveness that catches a field added to the kind
 * and forgotten (24a). One builder for the three doors a lock comes in by.
 */
function lockEntry(op: LockOp, signature: Uint8Array): PublishedOp {
  return {
    kind: "lock",
    attemptId: op.attemptId,
    holder: op.holder,
    beneficiary: op.beneficiary,
    quantity: op.quantity,
    timeout: op.timeout,
    decisionVenue: op.decisionVenue,
    parties: op.parties,
    nonce: op.nonce,
    signature,
  };
}

/** This operator declines to serve you. */
export class SequencerError extends Error {}

export class Sequencer {
  private readonly ledger = new TransparentLedger();
  // opHash (hex) -> the receipt returned when it was first accepted. Retained
  // to make replays idempotent (invariant 26); a later slice prunes entries an
  // eventual commitment has finalized.
  private readonly receipts = new Map<string, Receipt>();

  /**
   * The receipts map is keyed by BACKING and operation hash. For every operation
   * but the commit the backing name is inside the signed message, so the hash
   * alone is per backing already; a commit names no backing, deliberately, and
   * the same bytes are the same operation in every log of an exchange — so
   * under one operator serving several of those backings the hash alone would
   * answer the second backing's settle with the first's receipt and apply
   * nothing (found building slice 25's three-party ring).
   */
  private receiptKey(backing: Backing, opHash: Uint8Array): string {
    return backing.nameHex + ":" + bytesToHex(opHash);
  }

  // Backing name hex -> this sequencer's own copy. Adoption needs the terms —
  // the silence duration in E is what dates a gap — and `commit` needs to reach
  // every backing it serves without the ledger handing out a Backing object,
  // which would be handing out the obligor key that authorises issuance.
  private readonly backings = new Map<string, Backing>();

  private readonly operatorSecret: Uint8Array;
  private readonly operatorKey: Uint8Array;

  constructor(operatorSecret: Uint8Array, private readonly venue: Venue) {
    // The sequencer's own copy of both halves of its identity. Retaining the
    // caller's secret array would let a later mutation split signing from
    // routing: it would keep serving as the operator E names while co-signing as
    // another, so its declared identity would read as having gone quiet.
    this.operatorSecret = copyBytes(operatorSecret);
    this.operatorKey = ed25519.getPublicKey(this.operatorSecret);
  }

  /**
   * This operator's verification key, as a copy. A public Uint8Array field would
   * be a write path into the key this sequencer routes and commits by — and
   * `readonly` is erased at runtime, so it is no boundary at all.
   */
  get operator(): Uint8Array {
    return copyBytes(this.operatorKey);
  }

  /**
   * Take on a backing whose E names this operator. Rejects a backing served by
   * a different operator, and (via the ledger) one without a valid obligor
   * signature over its name.
   */
  register(backing: Backing, backingSignature: Uint8Array): void {
    // makeBacking has already established that the operator key is a valid
    // non-small-order point; the only question left here is whether it is mine.
    // In force, or named to take over. §C2 gives a successor force only from
    // its own first commitment, and it cannot commit a state it was never
    // allowed to take on — so being named is what lets it serve, and being in
    // force is what lets it co-sign (submit, below).
    if (
      compareBytes(operatorAt(backing, this.venue, this.venue.witnessedIndex()), this.operatorKey) !==
        0 &&
      !isNamedSuccessor(backing, this.venue, this.operatorKey)
    ) {
      throw new SequencerError("this sequencer does not serve that backing");
    }
    // The second half of the same routing question. A backing declaring a venue
    // this sequencer does not publish at would have its commitments witnessed
    // somewhere its own terms do not name, so nobody reading correctly could
    // find them — and the operator would look permanently silent to everyone.
    if (!venueIsDeclared(this.venue, backing)) {
      throw new SequencerError("this sequencer does not publish at that backing's venue");
    }
    this.ledger.register(backing, backingSignature);
    this.backings.set(backing.nameHex, makeBacking(backing));
  }

  /**
   * Whether this operator is the one in force for this backing right now — the
   * question §C2 answers with "until then the predecessor's last commitment
   * governs, no new co-signatures issue".
   */
  private isInForce(backing: Backing): boolean {
    return (
      compareBytes(
        operatorAt(backing, this.venue, this.venue.witnessedIndex()),
        this.operatorKey,
      ) === 0
    );
  }

  /**
   * The era a receipt this operator signs right now names: the witnessed index
   * of its last commitment, 0 where it has none (receipt.ts, `after`).
   */
  private era(): bigint {
    return this.venue.witnessedAtFor(this.operatorKey) ?? 0n;
  }

  /**
   * Take on the state a predecessor committed, so that this operator can commit
   * it as its own and thereby take force (§C2: a replacement "takes effect only
   * from the first index at which it has published its own commitment over a
   * spent set it serves in full").
   *
   * **The whole committed log, replayed through the same law.** Every entry goes
   * through the one door `apply`, so a state that could not have happened is
   * refused here rather than adopted, and the positions come out identical
   * because they are the log's own append indices.
   *
   * The clock is undefined, which is the boundary a replay always has: a served
   * log does not record the index each operation was accepted at. It is the same
   * weakness `replayLog` has and for the same reason.
   *
   * What is NOT taken on is the predecessor's uncommitted tail. That is not a
   * transparent problem and is not rescued: a payment is final when witnessed
   * rather than co-signed, and an operation the predecessor accepted and never
   * committed died with it in every construction (CLAUDE.md).
   *
   * **`incumbentLatest` is evidence, and it is needed in exactly one case.**
   * Normally the state taken on must be the incumbent's latest, or an older one
   * would silently drop everything committed since. But an incumbent that has
   * dropped this backing from its commitments has no latest state carrying it,
   * and refusing on that ground made §C2b's own remedy unexecutable: the
   * non-service grade fires, opens E's replacement rule, and the successor
   * could take nothing. So an earlier state is licensed by exhibiting the
   * incumbent's latest and showing it carries no log for this backing.
   *
   * **Bounded rather than checked**, which is the same limit slice 13 recorded.
   * WHICH state was the last to carry the backing is not readable from a root,
   * so a successor could take an earlier one than it should. That is not
   * licensed here, it is provable: any holder of the later state shows it with
   * isRewrittenHistory, against the successor, which is exactly why slice 14
   * extended that predicate across a handover.
   */
  takeOver(backing: Backing, served: ServedState, incumbentLatest?: ServedState): void {
    this.requireServed(backing);
    const held = this.backings.get(backing.nameHex) as Backing;
    if (this.isInForce(held)) {
      throw new SequencerError("this sequencer is already in force for that backing");
    }
    // Onto an empty log, or it is not a takeover. Applying a second time would
    // meet its own spent nonces and refuse in the ledger's voice, which names
    // the wrong boundary for what is a sequencer's own precondition.
    if (this.ledger.opLog(held).length > 0) {
      throw new SequencerError("this sequencer has already taken over that backing");
    }
    const committed = committedLogFor(held, this.venue, served);
    if (committed === undefined || committed.kind === "dropped") {
      throw new SequencerError("that is not a state this backing's operator committed");
    }
    // The predecessor's LAST commitment, and the predecessor is whoever is in
    // force. Taking on an older one would drop everything committed since.
    const incumbent = operatorAt(held, this.venue, this.venue.witnessedIndex());
    const latest = this.venue.latestFor(incumbent);
    if (latest === undefined || compareBytes(served.commitment.operator, incumbent) !== 0) {
      throw new SequencerError("that is not the incumbent's latest committed state");
    }
    if (compareBytes(served.commitment.root, latest.root) !== 0) {
      this.requireDroppedBy(held, incumbentLatest, latest);
      // And it must really precede that latest. A state at or past it is not an
      // earlier one this evidence excuses; it is a state the incumbent never
      // published, and one signed at a sequence it did publish is equivocation
      // that isEquivocation names on its own.
      if (committed.sequence >= latest.sequence) {
        throw new SequencerError("that state does not precede the incumbent's latest");
      }
    }
    // All or nothing. committedLogFor checks the root and the signature and
    // deliberately does not replay the law, so a well-rooted log that is not a
    // history that could have happened would otherwise apply until one entry
    // was refused — leaving a truncated state this operator would then commit,
    // which is the very fault isRewrittenHistory watches a handover for. The
    // ledger is atomic per operation; this is the one place that applies many.
    const replayed = replayLog(held, committed.opLog);
    if (replayed === undefined) {
      throw new SequencerError("that committed state is not a history that could have happened");
    }
    // A withdrawal the shared record refutes is the predecessor's provable
    // fault (withdrawnAgainstCommit), and this door is what keeps that proof
    // attributable: an heir that applied the entry would root it under its own
    // key, carrying its predecessor's artefact with no way to shed it —
    // dropping the entry later is isRewrittenHistory (found reviewing this
    // slice: the heir's only other exit was refusing the backing entirely).
    if (withdrawnAgainstCommit(held, this.venue, served) !== undefined) {
      throw new SequencerError(
        "that log carries a withdrawal the record refutes: the fault is its signer's to keep",
      );
    }
    // And every venue-naming lock in it must name the venue this operator
    // watches: the gate asks that of every lock it prepares, and this is the one
    // other path that applies many operations. Taken over, such a lock made the
    // successor refuse at every door forever — ready adopts, adoption asks the
    // record, and the record is not the lock's (found reviewing the audit
    // slice). Refused in this sequencer's own voice, as an unreplayable state is.
    for (const lock of replayed.locks.values()) {
      if (compareBytes(lock.decisionVenue, NO_DECISION_VENUE) !== 0 && compareBytes(lock.decisionVenue, this.venue.id) !== 0) {
        throw new SequencerError("that state carries a lock on a decision venue this sequencer does not watch: take it over on the record the lock names, or not at all");
      }
    }
    for (const entry of committed.opLog) this.ledger.apply(held, entry, undefined);
    // The predecessor's commitment is the last one this book has: what was taken
    // on is committed, and nothing past it is — and a restore of this operator's
    // own book (its own silence on another backing) must leave it whole.
    this.ledger.markCommitted(held);
  }

  /**
   * The evidence that licenses taking on an earlier state: the incumbent's
   * latest committed state, carrying no log for this backing.
   *
   * It has to be the **latest**, not merely one the incumbent once signed. A
   * superseded state that dropped the backing says nothing about what the
   * incumbent serves now — it may have picked it up again in the next
   * commitment — so pinning the evidence to the venue's own latest record is
   * what keeps the exception as narrow as the case that forced it.
   */
  private requireDroppedBy(
    backing: Backing,
    evidence: ServedState | undefined,
    latest: Commitment,
  ): void {
    if (evidence === undefined) {
      throw new SequencerError("that is not the incumbent's latest committed state");
    }
    if (
      evidence.commitment.sequence !== latest.sequence ||
      compareBytes(evidence.commitment.root, latest.root) !== 0 ||
      compareBytes(evidence.commitment.operator, latest.operator) !== 0
    ) {
      throw new SequencerError("that evidence is not the incumbent's latest committed state");
    }
    // committedLogFor re-roots the evidence against its own commitment, so a
    // state that merely claims the latest root does not pass.
    if (committedLogFor(backing, this.venue, evidence)?.kind !== "dropped") {
      throw new SequencerError("the incumbent's latest commitment still carries this backing");
    }
  }

  /**
   * Take on everything the venue witnessed against this backing while this
   * operator was dark (§C2b), in the order it was witnessed — restoring the
   * book to the last commitment first where the silence is this operator's own.
   * Each operation is applied at the index the venue stamped it with, never at
   * the index adoption happens to run at: a leg is judged by when it was
   * published, and adoption runs while the gap is still open (the return
   * commitment's own index is inside it).
   *
   * A publication the law refuses is skipped rather than fatal: anyone may
   * publish anything at the venue, so noise there is ordinary and must not stop
   * this operator serving. Idempotent for the same reason a resubmission is —
   * an operation already in the log fails on its own spent nonce — and a
   * restore inside one gap drops and re-adopts the same legs at the same
   * positions.
   */
  adopt(backing: Backing): void {
    this.requireServed(backing);
    const served = this.backings.get(backing.nameHex) as Backing;
    // "No new co-signatures issue" until this operator is in force. Adoption is
    // co-signing, so a successor that has taken over but not yet committed
    // leaves the gap legs for its own first serving moment rather than
    // answering for them now.
    //
    // Asked once rather than per leg: the answer is the same for all of them,
    // and asking walks the chain, which verifies a signature per published
    // replacement — both counts being the adversary's to grow.
    if (!this.isInForce(served)) return;
    this.caughtUp([served]);
  }

  /** The gap's legs for one backing, taken on in the order the venue witnessed them. */
  private adoptLegs(backing: Backing): void {
    for (const witnessed of gapLegsFor(this.venue, backing)) {
      this.adoptOne(backing, witnessed.op, witnessed.at);
    }
  }

  /**
   * One backing's book as of the last commitment — the ERA IS THE BACKING'S
   * OWN. Restored when this backing's own gap is open (`gapOpen` names this
   * operator: it is in force and was in force just before now, and its last
   * commitment is more than THIS backing's declared duration ago), because the
   * tail past the ledger's committed mark was never witnessed and the verifier
   * folds this backing's gap onto the committed state. The tail is dropped from
   * the ledger (restore, the one place a log shrinks, and never below the mark)
   * and from the receipt book, because a receipt of a dropped operation
   * answered as a repeat would apply nothing and tell the holder it had
   * (invariant 26 is about accepted operations, and the gap un-accepted these).
   *
   * Per backing, and readable per backing: whether this book was restored at a
   * commitment is exactly "did that commitment come more than this backing's
   * duration after the one before it" — the fact a receipt's reader must be
   * able to check from this backing's terms alone (28b's `lapsed`). Slice 28a
   * first restored the whole book at once, so that a set the ledger applied as
   * one act could not be torn between a short-duration backing and a long one —
   * and 28b found that made a lapse unreadable, since no stranger can know the
   * operator's shortest duration. What keeps a set whole now is the door: the
   * sequencer takes a set only over backings that declare one silence duration
   * (`sameDuration`), so its backings' gaps open together — one operator means
   * one last commitment — and its halves die together or not at all.
   *
   * A dropped operation is resubmittable by anyone holding the signed request
   * once the operator serves again, and is then a fresh act with a fresh
   * receipt; a backing this operator has handed over keeps its book and its
   * receipt book (a retired operator re-serving a receipt it gave in force is
   * no new co-signature), and one taken over and not yet committed carries no
   * tail of its own.
   */
  private restore(backing: Backing): void {
    const mark = this.ledger.restore(backing);
    const prefix = backing.nameHex + ":";
    for (const [key, receipt] of this.receipts) {
      if (key.startsWith(prefix) && receipt.position >= BigInt(mark)) this.receipts.delete(key);
    }
  }

  /**
   * A set is one act and dies as one, so it spans one silence clause: every
   * backing in it declares the demanded backing's duration, or none where it
   * declares none. Two backings under one operator share their last commitment,
   * so equal durations open and close their gaps together — a set settled into
   * the tail is then restored whole or kept whole, never torn (the reason is
   * `restore`'s doc). Asked at filing of every slot the set takes, at the
   * acceptance of the paying slot, at the re-prepare of a leg, and at the
   * release — the one value-moving door a mixed set can still reach, through a
   * takeOver of a log the law replayed without door rules; the withdrawal is
   * deliberately not asked, since it moves nothing and is the inherited mixed
   * set's one honest exit. Durations only, deliberately: this sequencer has one
   * venue, so the members' gaps are read on one clock either way, and a member
   * declaring no witnessing venue is the recorded "answered by whichever record
   * its reader holds" setting.
   */
  private sameDuration(demanded: Backing, member: Backing): void {
    if (demanded.evidence.silence?.noCommitmentDuration !== member.evidence.silence?.noCommitmentDuration) {
      throw new SequencerError(
        "a set is one act and dies as one: every backing in it declares the demanded backing's silence duration, or none",
      );
    }
  }

  /**
   * One adopted operation, co-signed as if it had been submitted. The holder had
   * to publish it at the venue because this operator was not there to take it,
   * and invariant 26 does not care where a request arrived: it is an accepted
   * operation, so it gets the receipt it would have got.
   */
  /**
   * Whether this operator may take a gap publication on this backing at all.
   *
   * **A demand on a backing with reliance is refused here**, because the legs
   * cannot come with it: invariant 13 wants q·cᵢ units of each target reserved,
   * a lock is not a gap leg (recovery.ts), and the law is per backing so nothing
   * below can see the shortfall. Adopted anyway, a holder settles the set during
   * a gap and keeps the whole accompaniment — 40 units to the backer with none
   * of what must accompany them.
   *
   * Since slice 26 a set neither opens nor settles in a gap (an acceptance that
   * brings nothing with it — P paying outside the claim layer — is the backer's
   * whole act and is taken): the venue holds operations one at a time, never a
   * set, and a paying lock released alone would hand the holder the payout for
   * nothing. Refusing is §C2b's own
   * posture, since claims "go illiquid rather than dead" while the operator is
   * away; the predicate is admittedInGap (recovery.ts), read by the verifier too.
   */
  private mayAdopt(backing: Backing, op: PublishedOp): boolean {
    // The one predicate the verifier's fold of the same gap reads (recovery.ts).
    return admittedInGap(backing, op, (hash, holder) => this.ledger.hasLock(backing, hash, holder));
  }

  private adoptOne(backing: Backing, op: PublishedOp, at: bigint): void {
    if (!this.mayAdopt(backing, op)) return;
    const key = this.receiptKey(backing, opHashOfEntry(backing.name, op));
    if (this.receipts.has(key)) return;
    // Skipped for the reason submit refuses it: the record shows this half
    // committed, and a gap is not a way around the record.
    const lock = op.kind === "withdrawal" ? this.ledger.lockOf(backing, op.demandHash, op.holder) : undefined;
    if (lock !== undefined && committedInTime(this.venue, lock)) return;
    // The era is read BEFORE the apply: it reads the venue, and a venue's
    // refusal after the apply would leave an accepted operation with no
    // receipt, forever — the re-adoption meets its own spent nonce (invariant
    // 26; found reviewing this slice). Refusing here instead applies nothing.
    const era = this.era();
    let entry: OpLogEntry;
    try {
      entry = this.ledger.apply(backing, op, at);
    } catch {
      return;
    }
    this.receipts.set(
      key,
      signReceipt(this.operatorSecret, backing.name, opHashOfEntry(backing.name, op), BigInt(entry.position), era),
    );
  }

  /**
   * **Refused once this backing's obligor key is revoked** (§C2b: "no further
   * issuance is valid"). Only issuance — transfers, burns and every presentation
   * leg go on, because "existing claims keep their terms", and an operator that
   * stopped serving those would strand the holders the revocation exists to
   * protect.
   *
   * The tie at the revocation's own index goes against this operator, which is
   * the rule slice 8 settled for a publication judged "against the record as it
   * stood strictly before its own index": the operator is the party watching the
   * venue, and the tie must not go to it.
   *
   * **Refusal here, and nothing in the law.** The ledger applies a post-boundary
   * issuance perfectly happily, and that is deliberate — see standingOutstanding
   * (recovery.ts) for why refusing it in the replay would make every holder of
   * the backing unable to prove anything at all.
   */
  submitIssue(op: IssuanceOp, signature: Uint8Array): Receipt {
    const backing = this.served(op.backing);
    const { recipient, quantity, nonce } = op;
    const entry: PublishedOp = { kind: "issue", recipient, quantity, nonce, signature };
    // Caught up, then the repeat — before the revocation refusal: an issuance
    // accepted before the key was revoked is a receipt the operator owes
    // afterwards (invariant 26; found regression-reviewing slice 27).
    this.caughtUp([backing]);
    const prior = this.priorReceipt(backing, entry);
    if (prior !== undefined) return prior;
    if (revokedAt(this.venue, backing) !== undefined) {
      throw new SequencerError("this backing's obligor key is revoked: no further issuance");
    }
    return this.submit([{ backing, op: entry }]);
  }

  submitTransfer(op: TransferOp, signature: Uint8Array): Receipt {
    const backing = this.served(op.backing);
    const { from, to, quantity, nonce } = op;
    return this.submit([
      { backing, op: { kind: "transfer", from, to, quantity, nonce, signature } },
    ]);
  }

  submitBurn(op: BurnOp, signature: Uint8Array): Receipt {
    const backing = this.served(op.backing);
    const { holder, quantity, nonce } = op;
    return this.submit([{ backing, op: { kind: "burn", holder, quantity, nonce, signature } }]);
  }

  /**
   * File a demand, and reserve its reliance legs in the same act.
   *
   * §C3: "Single-phase wherever every lock in the set can be taken in one
   * atomically signed decision... the whole set and the paying leg inside one
   * operator." This operator serves the whole set, so it takes the demand and
   * every lock together or refuses the lot.
   *
   * **The locks are the holder's to sign, and this only checks they are the
   * right ones**: exactly one per entry in R(b), each for q·cᵢ units (invariant
   * 13), each naming this demand and paying the demanded backing's obligor.
   * Building them here instead would be co-signing a commitment of somebody's
   * units they never authorised, which is the path invariant 8 forbids.
   */
  submitDemand(
    op: DemandOp,
    signature: Uint8Array,
    legs: readonly { readonly op: LockOp; readonly signature: Uint8Array }[] = [],
  ): Receipt {
    const backing = this.served(op.backing);
    const { holder, quantity, instant, deadline, nonce } = op;
    const demand: PublishedOp = {
      kind: "demand",
      holder,
      quantity,
      instant,
      deadline,
      nonce,
      signature,
    };
    // Ready for every backing the set touches — the demanded one and each slot
    // this operator serves — and the repeat answered, BEFORE any record is read:
    // the slot check below once read a squat the venue had already freed in a
    // gap, and refused a byte-identical replay of the filing for the slots the
    // filing itself had filled (found regression-reviewing this slice).
    const slots = backing.reliance.map((entry) => entry.target);
    if (paysInClaims(backing.payout)) {
      const paying = backing.payout.backing;
      // §C3's single-phase is "the whole set and the paying leg inside one
      // operator": filed without the paying leg reachable, the demand could never
      // be answered and read as dishonoured against a backer with no path (the
      // 2026-08-22 audit) — an abort rather than a demand nobody can answer. The
      // honest path is filing at an operator that serves both.
      if (!this.backings.has(bytesToHex(paying))) {
        throw new SequencerError("this sequencer does not serve the paying backing: file at an operator that serves both, or the set cannot be taken in one decision");
      }
      // And not one of R(b)'s own targets: locks are keyed by attempt id per
      // backing, so one slot under the demand's hash cannot hold both the
      // holder's leg and the backer's payout, and every acceptance would be
      // refused — the same manufactured dishonour, one input over (found
      // reviewing the audit slice). The (attempt, holder) key recorded open in
      // 24c would lift this.
      if (backing.reliance.some((entry) => compareBytes(entry.target, paying) === 0)) {
        throw new SequencerError("the paying backing is a reliance leg of this demand: one lock slot, two locks — this backing cannot be presented here");
      }
      slots.push(paying);
    }
    const slotBackings = slots.map((slot) => this.backings.get(bytesToHex(slot))).filter((b): b is Backing => b !== undefined);
    // A set spans one silence clause, or a return would tear it (sameDuration).
    for (const slot of slotBackings) this.sameDuration(backing, slot);
    // The companions must be this act's: a repeat carries the legs the set names
    // (one per entry in R(b), each under this demand's hash, the set's terms) —
    // a demand's bytes with other companions is not a repeat of the filing, and
    // legSet asks only of the request (found in the last regression pass).
    const legItems = this.legSet(backing, demandHash(op), op.holder, op.quantity, legs);
    this.caughtUp([backing, ...slotBackings]);
    const prior = this.priorReceipt(backing, demand);
    if (prior !== undefined) return prior;
    // No slot scan. A lock's slot is its holder's own, so a stranger who
    // predicted the hash reserves nothing this set needs: the demand's legs and
    // the backer's payout take slots nobody else can occupy. This door, the
    // law's two hash-sharing refusals and `demandStands` were four mechanisms
    // for that one property, each narrowed by the review after the one before.
    return this.submit([{ backing, op: demand }, ...legItems]);
  }

  /**
   * §C3's **prepare, again, for a standing demand**: "the timeout ends the
   * atomic attempt, the deadline governs evidence, and a demand outlives its
   * locks." A lapsed attempt is re-prepared rather than re-filed — re-filing
   * would cost the demand its instant, which is the value it fixes, and §C3's
   * "Refiling recovers nothing" closes that reading. The holder withdraws the
   * expired leg (theirs alone, past its timeout) and locks again under the
   * demand's hash, through the checks each leg passed at filing: one of R(b)'s
   * targets, this demand, no decision venue, the set's terms. A stranger's lock
   * fails the terms, so slice 26's squat doors stay shut.
   *
   * **One leg per call**, its own reservation, receipt and repeat (invariant
   * 26): nothing here has to hold together, since the demand already stands and
   * a standing leg is the holder's own units — and a call that took several legs
   * and refused one halfway would have discarded the receipts of the ones it
   * applied (found reviewing this slice). Which legs lapsed is the record's to
   * say: the law refuses a slot that stands.
   *
   * **The record first.** The demand is read only once this operator has
   * adopted what the venue witnessed against the demanded backing while it was
   * dark, and — after the repeat — is in force for it — a head withdrawn at the venue is
   * not a demand to re-prepare for, and a backing a successor now serves is not
   * this operator's to speak for. `submit` owes the same to its own items; this
   * is the one reader of a demand record whose item is another backing's, so it
   * asks the same question through the same helper (found reviewing this slice,
   * twice).
   */
  submitLeg(
    backing: Backing,
    hash: Uint8Array,
    leg: { readonly op: LockOp; readonly signature: Uint8Array },
  ): Receipt {
    const demanded = this.served(backing);
    const legBacking = this.served(leg.op.backing);
    // A repeat is a repeat of THIS request: a leg not naming this demand is no
    // repeat of a re-prepare under it, whatever receipt its bytes carry (found
    // regression-reviewing slice 27: a receipt for a lock under demand X was
    // answered to "re-prepare under Y", for a Y never filed).
    if (compareBytes(leg.op.attemptId, hash) !== 0) {
      throw new SequencerError("a lock must name the demand it accompanies");
    }
    // The filing checked this of every slot; this door must not drift from it.
    this.sameDuration(demanded, legBacking);
    const entry = lockEntry(leg.op, leg.signature);
    this.caughtUp([demanded, legBacking]);
    const prior = this.priorReceipt(legBacking, entry);
    if (prior !== undefined) return prior;
    // The lock's legality is decided by the demanded backing's record, so this
    // operator must be in force for it — a handed-over operator reading its stale
    // record took a lock under a demand the successor had ended (found in the
    // last regression pass).
    this.shut([demanded]);
    this.inForce([demanded]);
    const demand = this.ledger.demandOf(demanded, hash);
    if (demand === undefined) throw new SequencerError("no demand stands under that hash on this backing");
    // Past the demand's own deadline no acceptance can be live again, so a leg
    // re-prepared now could never settle — its one effect would be to shut the
    // holder's remaining exit until the timeout it signs (found reviewing this
    // slice). Withdrawal is the exit the refusal leaves open.
    if (this.witnessedIndex() > demand.deadline) {
      throw new SequencerError("the demand's own deadline has passed: nothing can settle it now, withdraw it");
    }
    return this.submit([this.legItem(this.legTerms(demanded, demand.holder, demand.quantity), hash, leg)]);
  }

  /**
   * §C3's **prepare**, for one backing of an atomic attempt.
   *
   * "The holder locks at *every* sequencer in the set... Any refusal aborts."
   * Each sequencer reserves its own half and knows nothing about the others —
   * which backings are in the bundle is the holder's business, and keeping it so
   * is what lets a sequencer serve one backing at a time (§C2).
   *
   * **The decision venue is checked, and refusing is the safe answer.** §C3: "A
   * cross-operator prepare names a decision venue... so every sequencer evaluates
   * one predicate against one clock. A sequencer unwilling to watch it refuses to
   * prepare, which is an abort rather than a fork." Reading the timeout on a
   * clock nobody else reads is the fork.
   */
  submitLock(op: LockOp, signature: Uint8Array): Receipt {
    const backing = this.served(op.backing);
    const entry = lockEntry(op, signature);
    this.caughtUp([backing]);
    const prior = this.priorReceipt(backing, entry);
    if (prior !== undefined) return prior;
    // A set leg comes only with its set (a demand's legs, an acceptance's paying
    // lock): a bare lock naming no decision venue would be a leg of nothing — and,
    // under a standing demand's hash, a squat the gate would not see (found
    // regression-reviewing slice 26's fixes).
    if (compareBytes(op.decisionVenue, NO_DECISION_VENUE) === 0) {
      throw new SequencerError("a bare lock names a decision venue: set legs come with their set");
    }
    return this.submit([{ backing, op: entry }]);
  }

  /**
   * §C3's **commit**, applied to this backing's own reservation.
   *
   * The holder publishes one object at the decision venue; this reads it there
   * and settles. **It takes no signature argument**, because the signature is in
   * the published object — and it takes no set, because the whole point of one
   * object is that a sequencer needs to recognise its own lock and nothing else.
   *
   * Applied at the index the VENUE witnessed the commit at, never at the index
   * this happens to run — the rule adoption already follows, and the reason §C3
   * says "effective on witnessing rather than delivery". Two sequencers reading
   * the same record therefore reach the same verdict whenever they get round to
   * it, which is what stops half a bundle settling.
   *
   * **Earliest witnessing wins.** A commit republished later cannot un-commit an
   * attempt the record already showed, and a holder who published in time is not
   * at the mercy of somebody else's copy arriving late.
   */
  settle(backing: Backing, attemptId: Uint8Array): Receipt {
    const held = this.served(backing);
    this.caughtUp([held]);
    const asOp = (commit: Commit): PublishedOp => ({
      kind: "commit",
      attemptId: commit.attemptId,
      signatures: commit.signatures,
    });
    // Every lock under the attempt, not one: a lock's slot is its holder's own,
    // so §C1's n-party exchange can stand as several locks here and the object
    // that settles them is any one of their parties' — the law converts every
    // lock the object satisfies, and this only has to find the object.
    const locks = this.ledger.locksFor(held, attemptId);
    if (locks.length > 0 && locks.every((l) => compareBytes(l.decisionVenue, NO_DECISION_VENUE) === 0)) {
      throw new SequencerError("a set leg settles with its set on the holder's release, not on a commit");
    }
    // No lock stands: this attempt has already resolved here, or never existed.
    // Invariant 26 wants a repeat answered with the identical prior receipt
    // without reading the venue (the 2026-08-22 audit: a commits-refusing view
    // threw before that answer could be given). The mark is keyed by the attempt
    // ALONE — distinct now from any object's own op-hash, which binds the
    // signatures — and holds the FIRST commit settled here, set below. `submit`
    // keys the receipt by the object (its signatures), which this branch cannot
    // reconstruct without the venue, so the venue-free answer needs its own mark.
    const settledMark = this.receiptKey(held, sha256(commitMessage(attemptId)));
    if (locks.length === 0) {
      const prior = this.receipts.get(settledMark);
      if (prior !== undefined) return copyReceipt(prior);
      throw new SequencerError("no lock for that attempt stands here");
    }
    // Earliest witnessing wins, across the locks as within one: a commit
    // republished later cannot un-commit what the record already showed.
    const witnessed = locks
      .map((lock) => witnessedCommitFor(this.venue, lock))
      .filter((w): w is WitnessedCommit => w !== undefined)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))[0];
    if (witnessed === undefined) {
      // Two answers, not one (above and here): a caller told the commit is
      // missing would go to the venue for an object that is there.
      throw new SequencerError("no commit for that attempt is witnessed at this venue");
    }
    const receipt = this.submit([{ backing: held, op: asOp(witnessed.commit) }], witnessed.at);
    if (!this.receipts.has(settledMark)) this.receipts.set(settledMark, receipt);
    return copyReceipt(receipt);
  }

  /**
   * Answer a demand — and, where P pays in claims, reserve the payout in the
   * same act. §C3: "The acceptance names the claims... that will pay, and the
   * release executes as one atomic exchange, surrendered set against paying
   * claims." The backer signs the lock: its units, to the demand holder, q
   * times P's per-unit, under the demand's hash, convertible by the holder alone
   * (parties [holder]) — so the holder's release settles both sides and the
   * backer cannot take the set and not pay. The lock must outlast the
   * acceptance, or the answer could expire with the payout already gone.
   */
  submitAcceptance(
    op: AcceptanceOp,
    signature: Uint8Array,
    paying: readonly { readonly op: LockOp; readonly signature: Uint8Array }[] = [],
  ): Receipt {
    const backing = this.served(op.backing);
    const { demandHash: hash, instant, deadline, nonce } = op;
    const answer: PublishedOp = { kind: "acceptance", demandHash: hash, instant, deadline, nonce, signature };
    this.caughtUp([backing]);
    const demand = this.ledger.demandOf(backing, hash);
    // No demand stands: a repeat of an answer the set has since settled is
    // answered; otherwise the law says so, in its own words, on the acceptance
    // alone.
    if (demand === undefined) {
      const prior = this.priorReceipt(backing, answer);
      if (prior !== undefined) return prior;
      return this.submit([{ backing, op: answer }]);
    }
    const terms = this.payoutTerms(backing, demand.holder, demand.quantity);
    if (terms === undefined) {
      if (paying.length !== 0) throw new SequencerError("this backing's payout settles outside the claim layer");
      return this.submit([{ backing, op: answer }]);
    }
    // The companion must be this act's before the repeat is answered: the
    // answer's bytes with another paying lock is not a repeat of the acceptance
    // (found in the last regression pass).
    const [target, want] = terms;
    // Locks are keyed by attempt id per backing: one slot under the demand's hash
    // cannot hold both the holder's leg and the backer's payout — refused at
    // filing now, and here for a demand filed before that rule.
    if (backing.reliance.some((entry) => bytesToHex(entry.target) === target)) {
      throw new SequencerError("the paying backing is a reliance leg of this demand: one lock slot, two locks");
    }
    const supplied = paying[0];
    if (paying.length !== 1 || supplied === undefined) {
      throw new SequencerError("an acceptance of this backing reserves its payout: exactly one paying lock");
    }
    const payingBacking = this.served(supplied.op.backing);
    if (payingBacking.nameHex !== target) throw new SequencerError("the paying lock is not on the backing P names");
    // For a demand filed before sameDuration was a filing rule.
    this.sameDuration(backing, payingBacking);
    if (compareBytes(supplied.op.attemptId, hash) !== 0) throw new SequencerError("the paying lock must name the demand it pays");
    const why = legMismatch(supplied.op, want);
    if (why !== undefined) throw new SequencerError(why);
    if (supplied.op.timeout < deadline) throw new SequencerError("the paying lock must outlast the acceptance");
    const prior = this.priorReceipt(backing, answer);
    if (prior !== undefined) return prior;
    return this.submit([
      { backing, op: answer },
      { backing: payingBacking, op: lockEntry(supplied.op, supplied.signature) },
    ]);
  }

  /**
   * The paying lock a demand on this backing calls for, where P pays in claims:
   * the target's name hex and the terms (q times per-unit units, the backer's
   * own, to the demand holder). Undefined where the payout settles outside.
   */
  private payoutTerms(backing: Backing, holder: Uint8Array, quantity: bigint): [string, LegTerms] | undefined {
    if (!paysInClaims(backing.payout)) return undefined;
    return [
      bytesToHex(backing.payout.backing),
      { quantity: quantity * backing.payout.perUnit, holder: backing.obligor, beneficiary: holder, converter: holder },
    ];
  }

  /**
   * Settle, set and all. §C3 settles on one release, so every backing in the set
   * resolves its own part: the demanded backing moves the claims, each leg moves
   * the accompaniment to the beneficiary its lock names. All or none, for the
   * reason the demand and its locks were taken that way.
   */
  submitRelease(
    op: ReleaseOp,
    signature: Uint8Array,
    legs: readonly { readonly op: ReleaseOp; readonly signature: Uint8Array }[] = [],
  ): Receipt {
    return this.endDemand("release", op, signature, legs);
  }

  /** The other exit, on the same terms: the demand ends and every lock frees. */
  submitWithdrawal(
    op: WithdrawalOp,
    signature: Uint8Array,
    legs: readonly { readonly op: WithdrawalOp; readonly signature: Uint8Array }[] = [],
  ): Receipt {
    return this.endDemand("withdrawal", op, signature, legs);
  }

  private endDemand(
    kind: "release" | "withdrawal",
    op: ReleaseOp | WithdrawalOp,
    signature: Uint8Array,
    legs: readonly { readonly op: ReleaseOp | WithdrawalOp; readonly signature: Uint8Array }[],
  ): Receipt {
    const backing = this.served(op.backing);
    // **The head of the set, not one of its legs — and only for a release.** A
    // leg's own state resolves a release by the lock it holds, and the law cannot
    // tell a head from a leg, so a leg released on its own would settle its
    // accompaniment with no demand settled and no acceptance needed. That is the
    // whole of what taking the set together prevents.
    //
    // A WITHDRAWAL is the opposite case and must go through: §C3's abort is
    // "expired locks unlock unilaterally", and unilaterally means the holder
    // frees their own reservation without anybody's cooperation — which for a
    // bundle spread over operators is the only exit there is. Freeing a
    // reservation gives nothing away, so nothing needs holding together.
    // "Expired" is the law's to read, and whether the record already shows the
    // half committed is the sequencer's (committedInTime, in submit).
    const head: PublishedOp = { kind, demandHash: op.demandHash, holder: op.holder, nonce: op.nonce, signature };
    // Caught up with the demanded backing and every leg it serves before the
    // record decides which legs stand: a leg the venue freed in a gap, read before
    // adoption, left the head unwithdrawable until a refused call had adopted
    // (found regression-reviewing slice 27).
    this.caughtUp([
      backing,
      ...backing.reliance.map((entry) => this.backings.get(bytesToHex(entry.target))).filter((b): b is Backing => b !== undefined),
      ...(paysInClaims(backing.payout) ? [this.backings.get(bytesToHex(backing.payout.backing))].filter((b): b is Backing => b !== undefined) : []),
    ]);
    // A repeat is answered before the set's shape is read from live state (the
    // leg-not-head refusal below included): once the set applied the demand is
    // gone, so the shape the repeat must carry no longer derives — and a partition-recovering holder was refused the one
    // receipt that proves the settlement (invariant 26; found by the 2026-08-22
    // audit). One lookup, the one `submit` owns.
    const prior = this.priorReceipt(backing, head);
    if (prior !== undefined) return prior;
    // The head of the set, not one of its legs — and only for a release (a leg
    // released alone would settle its accompaniment with no demand settled).
    // Asked of the record this release names, which is what it always meant: a
    // stranger's one-unit lock under a settled demand's hash used to fire it and
    // make the payee's release receipt unobtainable (found in the last
    // regression pass), and now reaches no record of theirs at all.
    // **The head resolves as the law resolves it**: this holder's lock under the
    // hash first, then their demand. A head that is a lock has no set — a bundle
    // lock is withdrawn alone — and reading the demand's shape onto it is the
    // door disagreeing with the law about which record is being ended. That is
    // reachable exactly where a holder names her own demand's hash as her own
    // attempt id on the demanded backing: the residual this slice documents
    // rather than refuses, and it stays harmless only if both agree.
    const headLock = this.ledger.lockOf(backing, op.demandHash, op.holder);
    if (kind === "release" && headLock !== undefined) {
      throw new SequencerError("that backing is a leg of this demand, not the demand it accompanies");
    }
    const items = [{ backing, op: head }];
    // **Which legs the set has.** A release settles the accompaniment, so it
    // needs every leg R(b) names, each carrying the set's terms — the shape
    // legSet checked at filing, checked again here against the lock that
    // actually stands, because a lock under this hash may have been withdrawn
    // past its timeout and relocked by submitLock with any terms at all. A
    // withdrawal frees, so it takes the legs that still stand: a bundle lock on a
    // backing with reliance of its own has none, and a head whose leg was
    // withdrawn alone has none left.
    const demand = headLock === undefined ? this.ledger.demandOf(backing, op.demandHash) : undefined;
    const terms =
      demand === undefined ? undefined : this.legTerms(backing, demand.holder, demand.quantity);
    // And the backer's paying lock, where P pays in claims: released by the holder
    // in the same set (its one party), so surrendered set and payout move together.
    // A release spans the payout slot's clause too (the reliance legs are asked
    // per leg below): an inherited log can carry the acceptance already
    // committed, so the acceptance door's own check may never have run.
    const payout = demand === undefined ? undefined : this.payoutTerms(backing, demand.holder, demand.quantity);
    if (kind === "release" && payout !== undefined) {
      const paying = this.backings.get(payout[0]);
      if (paying !== undefined) this.sameDuration(backing, paying);
    }
    if (terms !== undefined && payout !== undefined) terms.set(payout[0], payout[1]);
    // Standing means the DEMAND HOLDER'S lock under the hash: a stranger's lock
    // there is a squat, not a leg (found reviewing 24c), and a head that is a
    // bundle lock has no legs at all.
    const owner = demand?.holder;
    const standing = (hex: string): boolean => {
      const leg = this.backings.get(hex);
      if (leg === undefined || owner === undefined) return false;
      // The demand holder's own lock, asked for by key. This was a lookup by
      // hash and a holder comparison afterwards — two steps because the slot
      // could hold a stranger's record; now it cannot.
      return this.ledger.lockOf(leg, op.demandHash, owner) !== undefined;
    };
    const targets = backing.reliance.map((entry) => bytesToHex(entry.target));
    if (kind === "release" && payout !== undefined) targets.push(payout[0]);
    const expected = new Set(kind === "release" ? targets : targets.filter(standing));
    if (legs.length !== expected.size) {
      throw new SequencerError(
        kind === "release"
          ? "the set must name every reliance leg, and only those"
          : "a withdrawal must name every leg still standing, and only those",
      );
    }
    for (const leg of legs) {
      const legBacking = this.served(leg.op.backing);
      if (!expected.delete(legBacking.nameHex)) {
        throw new SequencerError("that backing is not a reliance leg of this demand");
      }
      if (compareBytes(leg.op.demandHash, op.demandHash) !== 0) {
        throw new SequencerError("a leg must name the demand being settled");
      }
      // **The leg must end the record the set names**, not merely some record
      // under this hash. The door checks the lock at the set's holder (the
      // demand holder for a reliance leg, the obligor for the payout), but the
      // law settles `leg.op.holder`; under the (attempt, holder) key those are
      // different records, so unbound a decoy lock a stranger placed under this
      // hash is converted while the true leg is left standing and the
      // accompaniment never surrenders (found reviewing slice 31). For a
      // withdrawal the standing legs are the demand holder's own.
      const legHolder =
        kind === "release" && terms !== undefined
          ? (terms.get(legBacking.nameHex) as LegTerms).holder
          : owner;
      if (legHolder !== undefined && compareBytes(leg.op.holder, legHolder) !== 0) {
        throw new SequencerError("a leg must end the record the set names");
      }
      // The release settles value, so the set it settles must be one that dies
      // as one — a mixed set can reach this door through takeOver, since the
      // law knows no door rules and a predecessor's committed log replays
      // (found reviewing this slice). The WITHDRAWAL stays open: it moves
      // nothing, and it is the inherited mixed set's one honest exit — a
      // refusal names the path it leaves open.
      if (kind === "release") this.sameDuration(backing, legBacking);
      if (kind === "release" && terms !== undefined) {
        // The set's terms name the slot's holder — the demanding holder for a
        // reliance leg, the obligor for the payout — so the same definition that
        // says what the lock must carry says which record to read.
        const want = terms.get(legBacking.nameHex) as LegTerms;
        const lock = this.ledger.lockOf(legBacking, op.demandHash, want.holder);
        // No lock: the law refuses the leg itself, and relabelling that here is
        // the pre-check CLAUDE.md forbids.
        if (lock !== undefined) {
          const why = legMismatch(lock, want);
          if (why !== undefined) throw new SequencerError(why);
        }
      }
      const legOp: PublishedOp = {
        kind,
        demandHash: leg.op.demandHash,
        holder: leg.op.holder,
        nonce: leg.op.nonce,
        signature: leg.signature,
      };
      items.push({ backing: legBacking, op: legOp });
    }
    return this.submit(items);
  }

  /** The terms every leg of a set on this backing must carry, by target name hex. */
  private legTerms(backing: Backing, holder: Uint8Array, quantity: bigint): Map<string, LegTerms> {
    return new Map(
      backing.reliance.map((entry) => [
        bytesToHex(entry.target),
        // Invariant 13's arithmetic, and the only place it is applied: q units of
        // the claim need q·c of each target. Where the accompaniment goes: the
        // DEMANDED backing's obligor, who takes in the set and may then present
        // at this leg itself.
        { quantity: quantity * entry.count, holder, beneficiary: backing.obligor, converter: holder },
      ]),
    );
  }

  /**
   * One leg of a set, checked against R(b) rather than taken on the caller's
   * word: served here, one of R(b)'s targets, this demand, no decision venue,
   * the set's terms. Read by filing (the whole set) and by re-prepare (one leg),
   * so the two doors cannot drift.
   */
  private legItem(
    terms: ReadonlyMap<string, LegTerms>,
    hash: Uint8Array,
    supplied: { readonly op: LockOp; readonly signature: Uint8Array },
  ): { backing: Backing; op: PublishedOp } {
    const legBacking = this.served(supplied.op.backing);
    const want = terms.get(legBacking.nameHex);
    if (want === undefined) throw new SequencerError("that backing is not a reliance leg of this demand");
    if (compareBytes(supplied.op.attemptId, hash) !== 0) {
      throw new SequencerError("a lock must name the demand it accompanies");
    }
    const why = legMismatch(supplied.op, want);
    if (why !== undefined) throw new SequencerError(why);
    return { backing: legBacking, op: lockEntry(supplied.op, supplied.signature) };
  }

  /**
   * The locks a demand carries at filing: exactly one per entry in R(b), none
   * twice, each checked by legItem. Returned in name order — the order mapping
   * over the canonical reliance list gave for free, kept now that the caller's
   * list is what is mapped.
   */
  private legSet(
    backing: Backing,
    hash: Uint8Array,
    holder: Uint8Array,
    quantity: bigint,
    legs: readonly { readonly op: LockOp; readonly signature: Uint8Array }[],
  ): { backing: Backing; op: PublishedOp }[] {
    const terms = this.legTerms(backing, holder, quantity);
    if (legs.length !== terms.size) {
      throw new SequencerError("a demand must lock every reliance leg, and only those");
    }
    const seen = new Set<string>();
    return legs
      .map((supplied) => {
        const item = this.legItem(terms, hash, supplied);
        if (seen.has(item.backing.nameHex)) throw new SequencerError("a leg is named twice");
        seen.add(item.backing.nameHex);
        return item;
      })
      .sort((a, b) => compareBytes(a.backing.name, b.backing.name));
  }

  /**
   * Routing is refused before an operation is even encoded, and before any read
   * is answered. "Is this backing mine?" is the sequencer's question, so a
   * client can tell an operator that does not serve them from the law refusing
   * them — the ledger would answer with a LedgerError, which names the wrong
   * boundary.
   */
  private requireServed(backing: Backing): void {
    if (!this.ledger.has(backing)) {
      throw new SequencerError("backing not served by this sequencer");
    }
  }

  /**
   * Routing and the sequencer's own copy in one step. The copy matters: terms
   * reached through it are the ones this operator registered, not whatever the
   * caller handed in beside a matching name.
   */
  private served(backing: Backing): Backing {
    this.requireServed(backing);
    return this.backings.get(backing.nameHex) as Backing;
  }

  /**
   * Publish a commitment over the served state — caught up first: returning
   * from silence, the whole book is restored to the last commitment and the gap
   * adopted, so what this roots is the history the verifier's fold reads
   * (§C2b; the module header). The index comes from the venue's record of this
   * operator, so a failed publish does not burn one.
   */
  commit(): Commitment {
    // One commitment per witnessed index: the venue's clock cannot order two,
    // and the era a receipt names — the index of the operator's last commitment
    // — must name one record, not the earlier of two (found reviewing this
    // slice: eras are keyed by index, and a second commitment at one index is
    // invisible to `firstCommitmentFor(operator, after + 1)`, so a reader's
    // missed era-end reads in the excusing direction — a missed fault). The
    // honest path is the next index: the venue advances on its own.
    if (this.venue.witnessedAtFor(this.operatorKey) === this.venue.witnessedIndex()) {
      throw new SequencerError(
        "this operator already committed at this witnessed index: the next commitment goes at the next",
      );
    }
    this.caughtUp([...this.backings.values()]);
    const commitment = signCommitment(
      this.operatorSecret,
      this.venue.nextSequenceFor(this.operatorKey),
      stateRoot(this.snapshot()),
    );
    this.venue.publish(commitment);
    // Witnessed now: every log this commitment roots is committed to its end,
    // and the tail is empty. Marked on every backing the root carries, which is
    // every registered one; a restore reaches a backing only at its own open
    // gap, in force (caughtUp), so on the others the mark is a record of what
    // this signature rooted and nothing more.
    for (const backing of this.backings.values()) this.ledger.markCommitted(backing);
    return commitment;
  }

  /**
   * The index every time-dependent decision is read at: the venue's, never this
   * operator's own publication history. "Finality means witnessed rather than
   * co-signed" (§C2b) — and a clock an operator could stop by going quiet would
   * hand it every deadline in its book.
   */
  witnessedIndex(): bigint {
    return this.venue.witnessedIndex();
  }

  /** The served state, as it would be published for a verifier (invariant 23). */
  snapshot(): BackingSnapshot[] {
    return this.ledger.snapshotAll();
  }

  outstanding(backing: Backing): bigint {
    this.requireServed(backing);
    return this.ledger.outstanding(backing);
  }

  balance(backing: Backing, holder: Uint8Array): bigint {
    this.requireServed(backing);
    return this.ledger.balance(backing, holder);
  }

  /** Units this holder can still spend: held minus committed by open demands. */
  availableBalance(backing: Backing, holder: Uint8Array): bigint {
    this.requireServed(backing);
    return this.ledger.availableBalance(backing, holder);
  }

  /** The standing demand record (invariant 23), as copies. */
  openDemands(backing: Backing): DemandRecord[] {
    this.requireServed(backing);
    return this.ledger.openDemands(backing);
  }

  /** A copy of the full operation log, all seven kinds. */
  opLog(backing: Backing): OpLogEntry[] {
    this.requireServed(backing);
    return this.ledger.opLog(backing);
  }

  nextNonce(signer: Uint8Array, backing: Backing): bigint {
    this.requireServed(backing);
    return this.ledger.nextNonce(signer, backing);
  }


  /**
   * Caught up with what the venue witnessed against these backings while this
   * operator was dark — adopted, which an operator not in force skips by itself
   * ("no new co-signatures issue"). Done at every door before a repeat is
   * answered: adoption co-signs the gap's legs and writes their receipts, so a
   * holder asking for the receipt of a leg the venue took for her must find it
   * on the first ask, not after a refusal that adopted as a side effect (found
   * regression-reviewing slice 27, round five). And before any record is read:
   * a head the venue ended in a gap is not one to re-prepare for, and the slots
   * a squatter freed there are free (rounds two and four).
   *
   * **A backing whose own gap is open is restored first** — to the last
   * commitment, since its tail was never witnessed (`restore`) — and then
   * adopted, so what the repeat lookup reads next is a receipt book with no
   * dead receipt in it and the gap's legs in it. Per backing: a door touches
   * only the backings it names, and another backing's book is caught up at its
   * own doors and at every commit.
   */
  private caughtUp(backings: readonly Backing[]): void {
    for (const backing of backings) {
      if (!this.isInForce(backing)) continue;
      const silent = gapOpen(this.venue, backing);
      if (silent !== undefined && compareBytes(silent, this.operatorKey) === 0) this.restore(backing);
      this.adoptLegs(backing);
    }
  }

  /**
   * Refuse while a publication now would still have gap force on any of these
   * backings this operator is in force for — against a predecessor's silence
   * at a handover index as much as its own. Asked of the backings an act
   * WRITES (submit's items) and, by the one door that decides an act on a
   * record it only READS, of that backing too: `submitLeg` reads the demanded
   * backing's record and writes the leg's, and a head withdrawn at the venue
   * at that same index still lands with force (found regression-reviewing the
   * review round — the refusal had bounded the written backings and left the
   * read one open).
   */
  private shut(backings: readonly Backing[]): void {
    for (const backing of backings) {
      if (this.isInForce(backing) && gapOpen(this.venue, backing) !== undefined) {
        throw new SequencerError(
          "this operator is returning from silence: it commits first, and serves from the index after its commitment",
        );
      }
    }
  }

  /**
   * §C2: "Until then the predecessor's last commitment governs, no new
   * co-signatures issue" — a successor that has taken over the state but not
   * yet committed it is not the operator yet, and a replaced one is not any
   * more. Asked of every backing an ACT touches, after the repeat is answered:
   * a repeat is a read of the receipt book, not an act, and a retired operator
   * re-serving a receipt it gave in force is no new co-signature — refusing it
   * would deny the payee the one evidence the successor cannot produce. A
   * backing an act merely READS (a filing's paying slot) is not asked this: the
   * operator that handed it over knows its state better than one that never
   * served it, and refusing there refused an honest filing (round five's review).
   */
  private inForce(backings: readonly Backing[]): void {
    for (const backing of backings) {
      if (!this.isInForce(backing)) {
        throw new SequencerError("this sequencer is not yet in force for that backing");
      }
    }
  }

  /**
   * A repeat of an operation this operator already co-signed, answered with its
   * receipt (invariant 26) — asked at every door after the request's own shape
   * is checked (pure: the companions this act names) and after `caughtUp`, and
   * before any refusal that reads the record or the clock. A repeat is a read of the receipt
   * book, not an act: the co-signature happened when it was given, and a
   * retired operator re-serving it is not a new one, while refusing it is the
   * hole slice 26's release repeat had — the payee's only evidence of an act the
   * successor cannot produce. Adoption cannot change the answer either: it only
   * adds receipts. (Slice 27's review first put `ready` ahead of this lookup and
   * then reversed it, for those reasons.)
   */
  private priorReceipt(backing: Backing, op: PublishedOp): Receipt | undefined {
    const prior = this.receipts.get(this.receiptKey(backing, opHashOfEntry(backing.name, op)));
    return prior === undefined ? undefined : copyReceipt(prior);
  }

  /**
   * The shared submit path: routing, then idempotency, then the ledger, then
   * the co-signed receipt. A replay of an accepted operation returns the
   * identical prior receipt without touching the ledger (invariant 26), and a
   * rejected operation records nothing, so a later valid operation at that
   * nonce still succeeds.
   */
  private submit(
    items: readonly { readonly backing: Backing; readonly op: PublishedOp }[],
    at: bigint = this.witnessedIndex(),
  ): Receipt {
    const hashes = items.map((item) => opHashOfEntry(item.backing.name, item.op));
    const touched = items.map((item) => item.backing);
    this.caughtUp(touched);
    // The repeat first — before the gate, before ready: a read of the receipt
    // book, not an act (priorReceipt). Keyed on the FIRST operation, which is the
    // one the caller asked for: a
    // demand and its locks are one act, so a replay of the demand answers for
    // the set exactly as it was accepted (invariant 26).
    const key = this.receiptKey((items[0] as { readonly backing: Backing }).backing, hashes[0] as Uint8Array);
    const existing = this.receipts.get(key);
    // A copy on both paths: the stored receipt is the operator's record of what
    // it co-signed, and a caller that could reach into it would decide what
    // every later replay is answered with.
    if (existing !== undefined) return copyReceipt(existing);
    // **No act is co-signed on a backing while a publication there would still
    // have gap force** — against this operator's own silence (its tail on that
    // backing is dead, and anything co-signed now would be the next tail) and
    // against a predecessor's at a handover index (a leg published now still
    // lands with force, and a co-signature here is what the verifier's fold
    // would contradict) alike. After the repeat, which is a read of the receipt
    // book and not an act. The honest path is the commit, which closes the gap,
    // and that backing's doors open from the index after — the return index
    // itself is inside the gap (the tie rule).
    this.shut(touched);
    this.inForce(touched);
    // **A bundle lock is prepared only where it can later be read, on the clock it
    // names, and only once; a set leg names no venue and needs none.** Each lock
    // item passes this one gate; one naming a venue must name this one
    // (§C3: "a sequencer unwilling to watch it refuses to prepare, which is an
    // abort rather than a fork"; reading the timeout on a clock nobody else
    // reads is the fork), must find a venue that serves commits (one that does
    // not refuses here, VenueError), and must name an attempt the record does
    // not already show committed by this holder: a lock under a committed
    // attempt would settle on a commit adjudicated for an earlier lock — and
    // answered by its receipt — and could never be withdrawn. That retires
    // 24b's "commit before prepare". A lock already co-signed here is answered
    // as every repeat is (invariant 26), whatever the record shows since.
    items.forEach((item, i) => {
      if (item.op.kind !== "lock" || this.receipts.has(this.receiptKey(item.backing, hashes[i] as Uint8Array))) return;
      // A set leg names no venue and settles with its set: nothing here to read.
      if (compareBytes(item.op.decisionVenue, NO_DECISION_VENUE) === 0) return;
      // No squat refusal. It scanned every backing this operator served to
      // protect a slot that is now the holder's own, and each review narrowed
      // it — the last because a one-unit demand on X made a bare lock on Y
      // unservable-but-counted against the operator (slice 28). A lock under a
      // standing demand's hash is served like any other: it reserves the
      // locker's own units and reaches nobody else's record.
      if (compareBytes(item.op.decisionVenue, this.venue.id) !== 0) {
        throw new SequencerError("this sequencer does not watch that decision venue");
      }
      if (witnessedCommitFor(this.venue, item.op) !== undefined) {
        throw new SequencerError("that attempt is already committed at this venue: a lock needs a fresh id");
      }
    });


    // A withdrawal of a lock asserts that its attempt did not commit. The record
    // decides that, not the holder: see committedInTime.
    for (const item of items) {
      const lock = item.op.kind === "withdrawal" ? this.ledger.lockOf(item.backing, item.op.demandHash, item.op.holder) : undefined;
      if (lock !== undefined && committedInTime(this.venue, lock)) {
        throw new SequencerError("the attempt committed in time: settle it");
      }
    }
    // The era is read once, BEFORE the apply — a venue refusal after it would
    // leave an applied act with no obtainable receipt, since the resubmission
    // meets its own spent nonce (invariant 26; found reviewing this slice).
    const era = this.era();
    const entries = this.ledger.applyAll(items, at);
    const receipts = entries.map((entry, i) =>
      signReceipt(
        this.operatorSecret,
        (items[i] as { readonly backing: Backing }).backing.name,
        hashes[i] as Uint8Array,
        BigInt(entry.position),
        era,
      ),
    );
    // Every accepted operation is co-signed, legs included: an operator cannot
    // deny having taken one, and the holder's reservation is as attributable as
    // the demand it accompanies.
    receipts.forEach((receipt, i) =>
      this.receipts.set(
        this.receiptKey((items[i] as { readonly backing: Backing }).backing, hashes[i] as Uint8Array),
        receipt,
      ),
    );
    return copyReceipt(receipts[0] as Receipt);
  }
}
