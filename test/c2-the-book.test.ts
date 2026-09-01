import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { signCommitment, stateRoot, type ServedState } from "../src/commitment.js";
import { isRewrittenHistory } from "../src/fault.js";
import { encodeIssuanceMessage, encodeTransferMessage } from "../src/messages.js";
import {
  encodeAcceptanceMessage,
  encodeDemandMessage,
  encodeReleaseMessage,
} from "../src/presentation.js";
import { gapOpen, stateIsAuthentic } from "../src/recovery.js";
import {
  replacementHash,
  replacementMessage,
  ROLE_OPERATOR,
  type Replacement,
} from "../src/replacement.js";
import { Sequencer, SequencerError } from "../src/sequencer.js";
import { LocalVenue } from "../src/venue.js";
import { KEYS, pub, SECRETS } from "./support.js";

// §C2, slice 35d: **the book is a possession with a provenance, and it only
// grows.** Under the retired rule a takeover had one reachable moment — inside
// a lead time §C2 does not guarantee exists, onto an empty log, from an
// incumbent that had to have a latest commitment. Each of those three
// assumptions was a defect with a probe: zero lead time locked the heir out
// forever, a re-appointed operator could not resume without manufacturing a
// fault against itself, and one never-committing link made the backing
// permanently unrescuable. This file is those probes, as the slice's tests.
//
//   - The predecessor comes from the CHAIN, not the clock, so takeOver answers
//     identically before and after the effective index.
//   - The target is a fixed object: the backing's last commitment witnessed
//     strictly before the effective index (§C2; in the ordinary case the
//     predecessor's own). Once the index arrives, nothing anybody publishes
//     moves it.
//   - The move is a fast-forward: the book grows by the delta between what is
//     held and what is taken on, re-syncing is ordinary, rewinding is refused.
//   - The book is seated FOR A LINK, so a stale seat detects itself instead of
//     asserting itself.
//
// See DECISIONS.md: "Panel: the book is a possession with a provenance, and it
// only grows."

const SILENCE = { noCommitmentDuration: 20n, challengeWindow: 5n };
const HEIR_SECRET = new Uint8Array(32).fill(0x0b);
const HEIR = pub(HEIR_SECRET);
const RESCUER_SECRET = new Uint8Array(32).fill(0x0c);
const RESCUER = pub(RESCUER_SECRET);

function backingFor(venue: LocalVenue, thing = "EUR"): Backing {
  return makeBacking({
    obligor: KEYS.backer,
    payout: { thing, quantumExponent: -2, perUnit: 100n },
    reliance: [],
    evidence: {
      setting: "transparent",
      operator: KEYS.operator,
      silence: SILENCE,
      witnessing: { venue: venue.id, interval: 5n },
      replacementRule: KEYS.backer,
    },
  });
}

/** A replacement co-signed by the rule-holder and the successor, over one message. */
function replacementBy(
  backing: Backing,
  successorSecret: Uint8Array,
  effective: bigint,
  predecessor: Uint8Array = backing.name,
): Replacement {
  const unsigned = {
    role: ROLE_OPERATOR,
    successor: ed25519.getPublicKey(successorSecret),
    predecessor,
    effective,
    signature: new Uint8Array(64),
    successorSignature: new Uint8Array(64),
  };
  const message = replacementMessage(backing.name, unsigned);
  return {
    ...unsigned,
    signature: ed25519.sign(message, SECRETS.backer),
    successorSignature: ed25519.sign(message, successorSecret),
  };
}

function at(venue: LocalVenue, index: bigint): void {
  const now = venue.witnessedIndex();
  if (index > now) venue.advance(index - now);
}

/** The incumbent serving `backing`, with one issuance to Alice, committed. */
function serving(venue: LocalVenue, backing: Backing) {
  const sequencer = new Sequencer(SECRETS.operator, venue);
  sequencer.register(backing, signBacking(SECRETS.backer, backing));
  sequencer.submitIssue(
    { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n },
    ed25519.sign(encodeIssuanceMessage(backing.name, KEYS.alice, 100n, 0n), SECRETS.backer),
  );
  const { commitment } = sequencer.commit();
  const state: ServedState = { snapshots: sequencer.snapshot(), commitment };
  return { sequencer, state };
}

function transferBy(
  backing: Backing,
  secret: Uint8Array,
  from: Uint8Array,
  to: Uint8Array,
  quantity: bigint,
  nonce: bigint,
) {
  return {
    op: { backing, from, to, quantity, nonce },
    signature: ed25519.sign(
      encodeTransferMessage(backing.name, from, to, quantity, nonce),
      secret,
    ),
  };
}

/** A redemption's three legs, published at the venue at consecutive indices. */
function demandAt(venue: LocalVenue, backing: Backing, index: bigint, quantity: bigint, holderNonce: bigint) {
  at(venue, index);
  const message = encodeDemandMessage(backing.name, KEYS.alice, quantity, index, index + 60n, holderNonce);
  venue.publishOp(backing.name, {
    kind: "demand", holder: KEYS.alice, quantity, instant: index, deadline: index + 60n,
    nonce: holderNonce, signature: ed25519.sign(message, SECRETS.alice),
  });
  return { hash: sha256(message), instant: index, deadline: index + 60n };
}

function acceptAt(
  venue: LocalVenue,
  backing: Backing,
  index: bigint,
  claim: { hash: Uint8Array; instant: bigint; deadline: bigint },
  backerNonce: bigint,
) {
  at(venue, index);
  venue.publishOp(backing.name, {
    kind: "acceptance", demandHash: claim.hash, instant: claim.instant, deadline: claim.deadline,
    nonce: backerNonce,
    signature: ed25519.sign(
      encodeAcceptanceMessage(backing.name, claim.hash, claim.instant, claim.deadline, backerNonce),
      SECRETS.backer,
    ),
  });
}

function releaseAt(
  venue: LocalVenue,
  backing: Backing,
  index: bigint,
  claim: { hash: Uint8Array },
  holderNonce: bigint,
) {
  at(venue, index);
  venue.publishOp(backing.name, {
    kind: "release", demandHash: claim.hash, holder: KEYS.alice, nonce: holderNonce,
    signature: ed25519.sign(encodeReleaseMessage(backing.name, claim.hash, KEYS.alice, holderNonce), SECRETS.alice),
  });
}

describe("§C2b: a dark heir does not brick the backing", () => {
  it("a second heir takes over the last state that carried it, past a link that never committed", () => {
    // One never-committing link used to make the backing permanently
    // unrescuable: the remedy chain completed and broke at the last step,
    // because takeOver asked for the incumbent's LATEST commitment and the
    // incumbent had none. §C2b's own answer is the walk-back: "a chain whose
    // middle operator never committed reaches past it to the last that did."
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { state } = serving(venue, eur);

    at(venue, 10n);
    const first = replacementBy(eur, HEIR_SECRET, 20n);
    venue.publishReplacement(eur.name, first);
    // The heir is seated at 20 and never registers, never takes over, never
    // commits. The rule-holder names a rescuer at the heir's own link.
    at(venue, 25n);
    venue.publishReplacement(
      eur.name,
      replacementBy(eur, RESCUER_SECRET, 40n, replacementHash(eur.name, first)),
    );

    at(venue, 40n);
    const rescuer = new Sequencer(RESCUER_SECRET, venue);
    rescuer.register(eur, signBacking(SECRETS.backer, eur));
    rescuer.takeOver(eur, state);
    rescuer.commit();
    // The backing was genuinely silent, so this is a return from silence: the
    // rescuer serves from the index after its own return commitment (28a).
    at(venue, 41n);

    expect(rescuer.outstanding(eur)).toBe(100n);
    const move = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    expect(rescuer.submitTransfer(move.op, move.signature).position).toBe(1n);
  });
});

describe("§C2: zero lead time hands over late, never locked out", () => {
  it("the heir takes the pinned state on at or after the effective index", () => {
    // A replacement leaving no lead time hands over to an operator that is
    // LATE, which is graded — not to one that is locked out, which is
    // terminal. Under the retired rule the in-force guard fired here and the
    // heir's one move, an empty commitment, killed the holder's redemption.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { state } = serving(venue, eur);

    at(venue, 10n);
    // Effective the index it is witnessed at: zero lead time — and the heir
    // acts AT that index, which is the boundary the name claims.
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 10n));

    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, state);
    heir.commit();

    expect(heir.outstanding(eur)).toBe(100n);
    expect(heir.balance(eur, KEYS.alice)).toBe(100n);
    const move = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    expect(heir.submitTransfer(move.op, move.signature).position).toBe(1n);
  });
});

describe("§C2: the target is a fixed object once the index arrives", () => {
  it("what the predecessor publishes at or past the effective index does not move it", () => {
    // "The predecessor governs until then and its commitments up to then move
    // the target, but past it nothing anybody publishes does." A predecessor
    // that commits a grown log after losing force is publishing a record, not
    // moving the handover.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { sequencer: incumbent } = serving(venue, eur);

    // The incumbent's last commitment strictly before the effective index.
    at(venue, 12n);
    const move = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 40n, 0n);
    incumbent.submitTransfer(move.op, move.signature);
    at(venue, 13n);
    const { commitment } = incumbent.commit();
    const pinned: ServedState = { snapshots: incumbent.snapshot(), commitment };

    at(venue, 15n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 20n));
    at(venue, 20n);

    // AT the effective index — the boundary itself, since the pin is what was
    // witnessed STRICTLY before it — the predecessor signs and publishes a
    // grown log: the pinned state plus one more perfectly valid transfer.
    const extra = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.carol, 10n, 1n);
    const grownLog = [
      ...pinned.snapshots[0]!.opLog,
      {
        kind: "transfer" as const,
        from: KEYS.alice,
        to: KEYS.carol,
        quantity: 10n,
        nonce: 1n,
        position: 2,
        signature: extra.signature,
      },
    ];
    const grown = [{ name: eur.name, opLog: grownLog }];
    const moved: ServedState = {
      snapshots: grown,
      commitment: signCommitment(
        SECRETS.operator,
        venue.nextSequenceFor(KEYS.operator),
        stateRoot(grown),
      ),
    };
    venue.publish(moved.commitment);

    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    // The moved target is refused, the pinned one is taken on.
    expect(() => heir.takeOver(eur, moved)).toThrow(SequencerError);
    heir.takeOver(eur, pinned);
    heir.commit();
    expect(heir.balance(eur, KEYS.bob)).toBe(40n);
    expect(heir.balance(eur, KEYS.carol)).toBe(0n);
  });
});

describe("§C2: the move is a fast-forward", () => {
  /**
   * The full round trip: the operator serves and commits, hands over to the
   * heir, the heir grows the book and commits, and the rule-holder then
   * re-appoints the original operator at the heir's link.
   */
  function reappointed() {
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { sequencer: original, state } = serving(venue, eur);

    at(venue, 10n);
    const first = replacementBy(eur, HEIR_SECRET, 12n);
    venue.publishReplacement(eur.name, first);
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, state);
    at(venue, 12n);
    const move = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 40n, 0n);
    heir.submitTransfer(move.op, move.signature);
    at(venue, 13n);
    const { commitment } = heir.commit();
    const theirs: ServedState = { snapshots: heir.snapshot(), commitment };

    at(venue, 20n);
    venue.publishReplacement(
      eur.name,
      replacementBy(eur, SECRETS.operator, 25n, replacementHash(eur.name, first)),
    );
    at(venue, 25n);
    return { venue, eur, original, heir, state, theirs };
  }

  it("a re-appointed operator resumes: the book it held grows by its successor's delta", () => {
    // Resuming honestly used to be impossible: the door refused a non-empty
    // log, and the operator's own next commitment then rooted its stale book —
    // a shrink, which is the permanent stranger-checkable fault, manufactured
    // by consenting to a rescue.
    const { venue, eur, original, theirs } = reappointed();

    original.takeOver(eur, theirs);
    const { commitment } = original.commit();
    const resumed: ServedState = { snapshots: original.snapshot(), commitment };

    expect(original.balance(eur, KEYS.bob)).toBe(40n);
    expect(original.outstanding(eur)).toBe(100n);
    // Resuming proves nothing against anybody, in either order.
    expect(isRewrittenHistory(eur, venue, theirs, resumed)).toBe(false);
    expect(isRewrittenHistory(eur, venue, resumed, theirs)).toBe(false);
    // And it serves, on the state its successor left.
    const move = transferBy(eur, SECRETS.bob, KEYS.bob, KEYS.carol, 5n, 0n);
    expect(original.submitTransfer(move.op, move.signature).position).toBe(2n);
  });

  it("re-taking the state already held is a no-op, because re-syncing is ordinary", () => {
    // The retired one-shot rule made a second takeOver an error. A fast-forward
    // with nothing to apply is not a fault; it is a book already current —
    // before the effective index and after it alike.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { state } = serving(venue, eur);

    at(venue, 10n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 12n));
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, state);
    const before = heir.opLog(eur).length;
    // Once in the lead time, once in force, once past its own commitment.
    heir.takeOver(eur, state);
    expect(heir.opLog(eur)).toHaveLength(before);
    at(venue, 12n);
    heir.takeOver(eur, state);
    expect(heir.opLog(eur)).toHaveLength(before);
    heir.commit();
    heir.takeOver(eur, state);
    expect(heir.opLog(eur)).toHaveLength(before);
    expect(heir.outstanding(eur)).toBe(100n);
  });

  it("a pinned target that rewrites the book held is refused: the poisoned book is not carried", () => {
    // The sharpest case: the heir's ONLY commitment is a law-valid rewrite of
    // what the original operator itself committed — so the rewrite IS the
    // pinned target, and nothing upstream of the prefix comparison can refuse
    // it. Taking it would rewind this operator's own committed entries, and
    // its next commitment would then prove a rewrite against ITSELF; the
    // heir's fault stays the heir's (isRewrittenHistory already names it),
    // and this book does not carry it.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { sequencer: original, state } = serving(venue, eur);

    at(venue, 10n);
    const first = replacementBy(eur, HEIR_SECRET, 12n);
    venue.publishReplacement(eur.name, first);
    at(venue, 13n);
    // The heir never takes over; it signs a DIFFERENT law-valid history —
    // the same issuance to Bob instead of Alice — and commits only that.
    const rewritten = [
      {
        name: eur.name,
        opLog: [
          {
            kind: "issue" as const,
            recipient: KEYS.bob,
            quantity: 100n,
            nonce: 0n,
            position: 0,
            signature: ed25519.sign(
              encodeIssuanceMessage(eur.name, KEYS.bob, 100n, 0n),
              SECRETS.backer,
            ),
          },
        ],
      },
    ];
    const poisoned: ServedState = {
      snapshots: rewritten,
      commitment: signCommitment(HEIR_SECRET, 0n, stateRoot(rewritten)),
    };
    venue.publish(poisoned.commitment);

    at(venue, 20n);
    venue.publishReplacement(
      eur.name,
      replacementBy(eur, SECRETS.operator, 25n, replacementHash(eur.name, first)),
    );
    at(venue, 25n);
    const held = original.opLog(eur).length;
    expect(() => original.takeOver(eur, poisoned)).toThrow(/extension|rewinding/);
    expect(original.opLog(eur)).toHaveLength(held);
    expect(original.balance(eur, KEYS.alice)).toBe(100n);
  });

  // A "not an extension" test that offered a state the PIN had already refused
  // stood here and was deleted by the 35d round: it was a second, weaker copy
  // of the poisoned-pin test above, which is the one fixture where the prefix
  // rule alone stands between the operator and the rewrite.

  it("a re-sync does not mark an uncommitted live tail as committed", () => {
    // The fast-forward marks only what the offered commitment covers. Marked
    // unconditionally, a re-sync would launder this term's own uncommitted
    // tail into committed state — proven by what a restore then does: the
    // committed book must survive, the tail must not.
    const { venue, eur, original, theirs } = reappointed();
    original.takeOver(eur, theirs);
    at(venue, 26n);
    original.commit();
    // A live tail this term co-signed and has NOT committed.
    const tail = transferBy(eur, SECRETS.bob, KEYS.bob, KEYS.carol, 5n, 0n);
    original.submitTransfer(tail.op, tail.signature);
    expect(original.opLog(eur)).toHaveLength(3);
    // The re-sync against the older target must leave the tail a TAIL.
    original.takeOver(eur, theirs);
    at(venue, 60n); // the operator's own silence opens a gap
    original.commit(); // returning from silence restores to the mark first
    expect(original.opLog(eur)).toHaveLength(2);
  });
});

describe("§C2: the book is seated for a link", () => {
  it("a re-appointed operator's old seat is stale on its face: it roots nothing until it re-syncs", () => {
    // The one-way latch read "I once held this book" as "I hold it". The seat
    // names the LINK it was taken for, so a second term does not inherit the
    // first term's possession — and the operator's own commitment in between
    // roots nothing for the backing, rather than rooting the stale copy, which
    // was the shrink fault a re-appointment used to manufacture. Rooting
    // NOTHING while in force is still the drop the record already prices
    // (c2-dropped-backing), and honestly so: the operator chose to commit
    // past a stale seat when the fast-forward stood open. The honest order —
    // re-sync, then commit — is the previous test.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { sequencer: original, state } = serving(venue, eur);

    at(venue, 10n);
    const first = replacementBy(eur, HEIR_SECRET, 12n);
    venue.publishReplacement(eur.name, first);
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, state);
    at(venue, 12n);
    const move = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 40n, 0n);
    heir.submitTransfer(move.op, move.signature);
    at(venue, 13n);
    const { commitment } = heir.commit();
    const theirs: ServedState = { snapshots: heir.snapshot(), commitment };

    at(venue, 20n);
    venue.publishReplacement(
      eur.name,
      replacementBy(eur, SECRETS.operator, 25n, replacementHash(eur.name, first)),
    );
    at(venue, 25n);

    // In force again, holding its own first-term copy, NOT re-synced: the
    // stale seat must exclude the backing from what this operator asserts —
    // the stale BOOK is never rooted. What it commits instead is a state that
    // DROPS a backing it is in force for, and that is the ordinary
    // drop-while-in-force fault, not a new excuse: the fast-forward stood
    // open, and it committed past it.
    const committed = original.commit();
    expect(committed.snapshots).toHaveLength(0);
    const resumed: ServedState = { snapshots: [], commitment: committed.commitment };
    expect(isRewrittenHistory(eur, venue, theirs, resumed)).toBe(true);

    // Re-synced, the same operator's next commitment carries the whole book.
    original.takeOver(eur, theirs);
    at(venue, 26n);
    expect(original.commit().snapshots).toHaveLength(1);
    expect(original.balance(eur, KEYS.bob)).toBe(40n);
  });

  it("an heir in force without the book cannot co-sign, and the refusal names the takeover", () => {
    // In force is not custody. An heir that skipped the takeover used to pass
    // every door and co-sign onto an empty log — two live claims on one
    // backing, both operator-attested. The door refuses, and the honest path
    // it names is walked to the end of this test.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { state } = serving(venue, eur);

    at(venue, 10n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 12n));
    at(venue, 12n);
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));

    const move = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    expect(() => heir.submitTransfer(move.op, move.signature)).toThrow(/take|book/);

    heir.takeOver(eur, state);
    expect(heir.submitTransfer(move.op, move.signature).position).toBe(1n);
  });
});

describe("§C2: the fast-forward and the tail — the interleavings, probed before the door opened", () => {
  it("a re-appointment drops the dead tail with its receipts, and the dead request lands again as a fresh act", () => {
    // The operator co-signed a transfer it never committed, handed over, and
    // is re-appointed. What it co-signed died with its era (§C2b, 28b) — so
    // the fast-forward drops it to the mark, receipts included, exactly as a
    // return from silence would, and the held book grows by the successor's
    // delta alone. The dead request is then resubmittable by anyone holding
    // it, as a fresh act with a fresh receipt — answered with the dead one,
    // the holder would be told a position the book gives someone else.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { sequencer: original, state } = serving(venue, eur);
    const dead = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    expect(original.submitTransfer(dead.op, dead.signature).position).toBe(1n);

    at(venue, 10n);
    const first = replacementBy(eur, HEIR_SECRET, 12n);
    venue.publishReplacement(eur.name, first);
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, state);
    at(venue, 12n);
    heir.commit();
    at(venue, 13n);
    // The successor's delta: an issuance, so the dead transfer's nonce stays free.
    heir.submitIssue(
      { backing: eur, recipient: KEYS.carol, quantity: 50n, nonce: 1n },
      ed25519.sign(encodeIssuanceMessage(eur.name, KEYS.carol, 50n, 1n), SECRETS.backer),
    );
    at(venue, 14n);
    const { commitment } = heir.commit();
    const theirs: ServedState = { snapshots: heir.snapshot(), commitment };

    at(venue, 15n);
    venue.publishReplacement(
      eur.name,
      replacementBy(eur, SECRETS.operator, 20n, replacementHash(eur.name, first)),
    );
    at(venue, 20n);
    original.takeOver(eur, theirs);
    expect(original.opLog(eur).map((entry) => entry.kind)).toEqual(["issue", "issue"]);
    expect(original.balance(eur, KEYS.alice)).toBe(100n);
    // The same signed request, accepted afresh at the book's next position.
    expect(original.submitTransfer(dead.op, dead.signature).position).toBe(2n);
    // And the resumed operator's next commitment is clean on the record: no
    // fault in either order, and the fold authenticates it — the assertions
    // that motivated the drop, carried from the probe.
    at(venue, 21n);
    const { commitment: resumedCommitment } = original.commit();
    const resumed: ServedState = { snapshots: original.snapshot(), commitment: resumedCommitment };
    expect(isRewrittenHistory(eur, venue, theirs, resumed)).toBe(false);
    expect(isRewrittenHistory(eur, venue, resumed, theirs)).toBe(false);
    expect(stateIsAuthentic(eur, venue, resumed)).toBe(true);
  });

  it("a taken-on book survives its holder's own slow return: the takeover marks what it applied", () => {
    // A rescuer seated into a long silence takes the book on and dawdles: by
    // its first commit the gap names the RESCUER (it is the party in force),
    // so the return restores the rescuer's own book to the mark first. The
    // takeover marked what it took on as committed — the predecessor's
    // commitment IS this book's last — so the restore keeps the whole book.
    // Unmarked, the restore would silently empty it and the return would root
    // nothing.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { state } = serving(venue, eur);

    at(venue, 25n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 30n));
    at(venue, 30n);
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, state);
    // In force from 30, and slow: by 35 the party the gap names is the heir.
    at(venue, 35n);
    heir.commit();
    at(venue, 36n);
    expect(heir.opLog(eur)).toHaveLength(1);
    expect(heir.outstanding(eur)).toBe(100n);
    const move = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    expect(heir.submitTransfer(move.op, move.signature).position).toBe(1n);
  });

  it("a mid-gap takeover adopts at the return commitment, and a later re-sync keeps its hands off the live tail", () => {
    // The heir takes the book on while the predecessor's gap stands open —
    // the takeover is not a co-signature, so no door refuses it — and the
    // gap's legs are adopted exactly where returning adopts them: at the
    // heir's own return commitment. A re-sync AFTER that finds a book longer
    // than the target, and the adopted tail is the live term's own: hands off.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { state } = serving(venue, eur);
    // The backing goes silent at 0 and a redemption lands inside the gap.
    const claim = demandAt(venue, eur, 25n, 5n, 0n);
    acceptAt(venue, eur, 26n, claim, 1n);
    releaseAt(venue, eur, 27n, claim, 1n);

    at(venue, 28n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 30n));
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    expect(gapOpen(venue, eur)).toBeDefined();
    heir.takeOver(eur, state);
    heir.takeOver(eur, state); // and a mid-gap re-sync is still a no-op
    expect(heir.opLog(eur)).toHaveLength(1);

    at(venue, 30n);
    const { commitment } = heir.commit();
    const returned: ServedState = { snapshots: heir.snapshot(), commitment };
    expect(heir.opLog(eur).map((entry) => entry.kind)).toEqual([
      "issue",
      "demand",
      "acceptance",
      "release",
    ]);
    expect(heir.balance(eur, KEYS.alice)).toBe(95n);
    // Presentation destroys nothing (inv 10): only a burn lowers the count.
    expect(heir.outstanding(eur)).toBe(100n);
    // The verifier's fold reads the same book (carried from the probe).
    expect(stateIsAuthentic(eur, venue, returned)).toBe(true);

    at(venue, 31n);
    expect(gapOpen(venue, eur)).toBeUndefined();
    heir.takeOver(eur, state);
    expect(heir.opLog(eur)).toHaveLength(4);
    expect(heir.balance(eur, KEYS.alice)).toBe(95n);
    // And the heir serves, on the book the return built.
    const move = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 2n);
    expect(heir.submitTransfer(move.op, move.signature).position).toBe(4n);
  });

  it("a gap leg that rode a dead nonce is skipped by the operator and the fold alike, and adopts once its nonce path exists", () => {
    // The compound the panel named: a dead tail, a dark heir, an open gap.
    // The holder signed her redemption at nonce 1 because the operator's
    // unpublished tail held her nonce 0 — and the tail died. Nothing built on
    // an unwitnessed act is final (§C2b), so the return skips the leg, the
    // verifier's fold reads the same restored book and skips it identically,
    // and the leg adopts on its own once the dead request refills the nonce —
    // adoption is re-asked at every door, and the gap's legs stay the gap's.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { sequencer: original, state } = serving(venue, eur);
    const dead = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    original.submitTransfer(dead.op, dead.signature); // then dark

    const claim = demandAt(venue, eur, 25n, 5n, 1n);
    acceptAt(venue, eur, 26n, claim, 1n);
    releaseAt(venue, eur, 27n, claim, 2n);

    at(venue, 28n);
    const first = replacementBy(eur, HEIR_SECRET, 30n);
    venue.publishReplacement(eur.name, first); // the heir stays dark forever
    at(venue, 35n);
    venue.publishReplacement(
      eur.name,
      replacementBy(eur, SECRETS.operator, 40n, replacementHash(eur.name, first)),
    );
    at(venue, 40n);
    expect(gapOpen(venue, eur)).toBeDefined(); // the compound's precondition
    original.takeOver(eur, state); // walk-back past the dark heir, tail dropped
    const { commitment } = original.commit();
    const returned: ServedState = { snapshots: original.snapshot(), commitment };
    expect(original.opLog(eur).map((entry) => entry.kind)).toEqual(["issue"]);
    // "The fold" in this test's name, actually asked: the verifier reads the
    // same restored book, and the return accuses nobody.
    expect(stateIsAuthentic(eur, venue, returned)).toBe(true);
    expect(isRewrittenHistory(eur, venue, state, returned)).toBe(false);

    at(venue, 41n);
    // The dead request refills its nonce as a fresh act...
    expect(original.submitTransfer(dead.op, dead.signature).position).toBe(1n);
    at(venue, 42n);
    // ...and the next door's catch-up takes the whole redemption.
    const move = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.carol, 1n, 3n);
    original.submitTransfer(move.op, move.signature);
    expect(original.opLog(eur).map((entry) => entry.kind)).toEqual([
      "issue",
      "transfer",
      "demand",
      "acceptance",
      "release",
      "transfer",
    ]);
    expect(original.balance(eur, KEYS.alice)).toBe(84n);
  });
});

describe("§C2: the mark, the gate, and the walk cache — the round's killers", () => {
  it("a stale seat's book is not restored or adopted onto behind its back", () => {
    // In force with a STALE seat, holding a first-term book with an
    // uncommitted tail, and its own gap open. caughtUp gates on serves, so it
    // must not touch this book: gated on force alone it would restore the
    // backing to the mark — a shrink of a book this operator does not serve,
    // decided by a door the operator never asked for.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { sequencer: original, state } = serving(venue, eur);
    const tail = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    original.submitTransfer(tail.op, tail.signature); // uncommitted

    at(venue, 10n);
    const first = replacementBy(eur, HEIR_SECRET, 12n);
    venue.publishReplacement(eur.name, first);
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, state);
    at(venue, 12n);
    heir.commit();

    at(venue, 20n);
    venue.publishReplacement(
      eur.name,
      replacementBy(eur, SECRETS.operator, 25n, replacementHash(eur.name, first)),
    );
    // In force again on a stale seat, past the backing's silence: its own gap
    // stands open, so a force-gated catch-up would restore this book.
    at(venue, 40n);
    expect(gapOpen(venue, eur)).toBeDefined();
    expect(original.commit().snapshots).toHaveLength(0);
    expect(original.opLog(eur)).toHaveLength(2);
  });

  it("an in-force heir without the book is told to take over, not to commit first", () => {
    // Both doors would refuse this heir: it holds no book (custody) and the
    // predecessor's gap is open (shut). The one that must speak is the
    // takeover — the commit-first advice names the one move that closes the
    // gap and kills the holder's redemption. The honest path is then walked.
    // (The same order stands at submitLeg's door; its killer is owed.)
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { state } = serving(venue, eur); // commits at 0, then dark
    at(venue, 25n);
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 26n));
    at(venue, 26n);
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    expect(gapOpen(venue, eur)).toBeDefined();
    const move = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    expect(() => heir.submitTransfer(move.op, move.signature)).toThrow(/takeOver/);
    heir.takeOver(eur, state);
    heir.commit();
    at(venue, 27n);
    expect(heir.submitTransfer(move.op, move.signature).position).toBe(1n);
  });

  it("a retired operator cannot take the book back without being named again", () => {
    // register() already refuses a stranger, so the only party that reaches
    // the seat check is one the chain has moved PAST. Offered the pinned
    // target itself, nothing downstream can refuse it — only the seat does.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { state } = serving(venue, eur);
    at(venue, 10n);
    const first = replacementBy(eur, HEIR_SECRET, 12n);
    venue.publishReplacement(eur.name, first);
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, state);
    at(venue, 12n);
    const theirs = heir.commit();
    at(venue, 20n);
    venue.publishReplacement(
      eur.name,
      replacementBy(eur, SECRETS.operator, 25n, replacementHash(eur.name, first)),
    );
    at(venue, 25n);
    // The chain has moved past the heir's link: it is neither tip nor pending.
    expect(() => heir.takeOver(eur, theirs)).toThrow(SequencerError);
    expect(heir.opLog(eur)).toHaveLength(1);
  });

  it("a record published without the clock moving is seen at the next door", () => {
    // The walk cache's key is (witnessed index, record count) — BOTH halves.
    // A venue can witness a record without its clock moving, and the door must
    // see it: the count half of the key is what this test kills.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { sequencer: original } = serving(venue, eur);
    const first = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    expect(original.submitTransfer(first.op, first.signature).position).toBe(1n);
    // Seated and effective at THIS index, with the clock unmoved.
    venue.publishReplacement(
      eur.name,
      replacementBy(eur, HEIR_SECRET, venue.witnessedIndex()),
    );
    const second = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 1n);
    expect(() => original.submitTransfer(second.op, second.signature)).toThrow(SequencerError);
  });

  it("a rotation beyond the pending horizon is seen when its index arrives, with no new record published", () => {
    // The other half of the same key: the walk stops at the FIRST pending
    // link, so a rotation queued one level deeper is invisible to a cached
    // chain however fresh its record count — only the CLOCK reveals it. A
    // cache keyed on the count alone would leave the middle operator serving
    // into its successor's term.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { state } = serving(venue, eur);
    at(venue, 5n);
    const first = replacementBy(eur, HEIR_SECRET, 15n);
    venue.publishReplacement(eur.name, first);
    venue.publishReplacement(
      eur.name,
      replacementBy(eur, RESCUER_SECRET, 30n, replacementHash(eur.name, first)),
    );
    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, state); // warms the heir's cache with the deep rotation unwalked
    at(venue, 15n);
    heir.commit(); // keeps the backing's clock alive, so only FORCE decides below
    at(venue, 20n);
    const move = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 0n);
    expect(heir.submitTransfer(move.op, move.signature).position).toBe(1n);
    at(venue, 30n);
    const second = transferBy(eur, SECRETS.alice, KEYS.alice, KEYS.bob, 10n, 1n);
    expect(() => heir.submitTransfer(second.op, second.signature)).toThrow(/not yet in force/);
  });
});

describe("§C2b: the emergency handover executes at the effective index", () => {
  it("a successor takes an earlier state on evidence the pinned commitment dropped the backing, with zero lead time", () => {
    // The one remedy §C2b gives a holder against an operator that dropped
    // their backing was gated on a lead time §C2 does not guarantee exists.
    // With the target pinned by index, the evidence path opens at the
    // effective index like everywhere else.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const { state } = serving(venue, eur);

    // The incumbent's next commitment carries nothing for EUR: the drop.
    at(venue, 10n);
    const droppedState: ServedState = {
      snapshots: [],
      commitment: signCommitment(
        SECRETS.operator,
        venue.nextSequenceFor(KEYS.operator),
        stateRoot([]),
      ),
    };
    venue.publish(droppedState.commitment);

    at(venue, 15n);
    // Zero lead time: seated the index it is witnessed — and everything below
    // happens AT that index, which is the boundary the name claims.
    venue.publishReplacement(eur.name, replacementBy(eur, HEIR_SECRET, 15n));

    const heir = new Sequencer(HEIR_SECRET, venue);
    heir.register(eur, signBacking(SECRETS.backer, eur));
    heir.takeOver(eur, state, droppedState);
    heir.commit();
    expect(heir.outstanding(eur)).toBe(100n);
  });
});
