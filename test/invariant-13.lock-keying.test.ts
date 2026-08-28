import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { compareBytes } from "../src/bytes.js";
import { LedgerError } from "../src/ledger.js";
import { encodeIssuanceMessage } from "../src/messages.js";
import {
  attemptIdOf,
  countersignCommit,
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
import { Sequencer, SequencerError } from "../src/sequencer.js";
import { LocalVenue, UNNAMED_VENUE } from "../src/venue.js";
import { advanceWitnessedIndex, KEYS, SECRETS } from "./support.js";

// **A lock is keyed by the attempt AND the holder whose units it reserves.**
//
// Invariant 13's reservation lives in the leg's own log, and until this slice it
// occupied a slot named by the attempt id alone. One slot per id per backing
// meant the first party to name an id owned it, and every party who needed it
// afterwards — the demand's own holder included — was refused. That is the squat
// family, and it was fought at six doors over slices 24c, 26, 27 and 28: two
// refusals in the law, three in the sequencer, and one holder comparison inside
// the release's leg walk. Each was added by a review narrowing the last.
//
// Keying by (attempt, holder) ends it at the source. A stranger's lock is a
// record about the stranger's own units, in a slot the honest holder never
// wanted, and it is invisible to every question the honest holder asks. Nothing
// has to refuse it, because nothing collides with it.
//
// Two things follow, and both are law rather than door:
//
//   - **A release or a withdrawal names the record it ends.** The law resolves
//     the signer before it can check a signature, and under this key the lookup
//     needs a holder — which for a withdrawal is the signer itself. The op
//     carries it, signed: naming a key you do not control is refused for free at
//     the signature check. The record's holder, not the signer's key, because a
//     backer's paying lock is held by the obligor and released by the demand
//     holder (§C3: "void only on the holder's release").
//   - **A commit converts every lock under its attempt whose parties it
//     satisfies.** It cannot name a holder: §C3's commit is one object valid in
//     every log of an exchange at once, and each leg of an n-party exchange has
//     a different holder. So the match is by attempt and parties, and §C1's "all
//     sign" bounds it — a venue-naming lock names its own holder among its
//     parties, so a commit only ever converts locks whose holders signed it.

const TIMEOUT = 50n;
const DEADLINE = 100n;
// A fixture picks the salt; the id is what the salt and the terms hash to. The
// default is Alice's solo attempt at TIMEOUT on the unnamed venue.
const ATTEMPT_SALT = new Uint8Array(32).fill(0xa7);
const ATTEMPT = attemptIdOf(ATTEMPT_SALT, UNNAMED_VENUE, TIMEOUT, [KEYS.alice]);

/** Parties on the wire are a strictly ascending set (validateKeySet). */
function keySet(...keys: Uint8Array[]): Uint8Array[] {
  return [...keys].sort(compareBytes);
}

/**
 * One operator, one venue, EUR relying on GOLD. Alice is the honest holder,
 * Mallory the squatter, and both hold units of both backings so that a test
 * about a slot is about the slot rather than about an empty balance.
 */
function setup() {
  const venue = new LocalVenue();
  const mk = (thing: string, reliance: { target: Uint8Array; count: bigint }[] = []) =>
    makeBacking({
      obligor: KEYS.backer,
      payout: { thing, quantumExponent: -2, perUnit: 100n },
      reliance,
      evidence: {
        setting: "transparent",
        operator: KEYS.operator,
        witnessing: { venue: venue.id, interval: 5n },
      },
    });
  const gold = mk("GOLD");
  const eur = mk("EUR", [{ target: gold.name, count: 2n }]);
  const sequencer = new Sequencer(SECRETS.operator, venue);
  for (const backing of [gold, eur]) {
    sequencer.register(backing, signBacking(SECRETS.backer, backing));
    for (const holder of [KEYS.alice, KEYS.mallory]) {
      const nonce = sequencer.nextNonce(KEYS.backer, backing);
      sequencer.submitIssue(
        { backing, recipient: holder, quantity: 200n, nonce },
        ed25519.sign(encodeIssuanceMessage(backing.name, holder, 200n, nonce), SECRETS.backer),
      );
    }
  }
  return { venue, sequencer, eur, gold };
}

/**
 * The other fixture: EUR pays 2 GOLD per unit, so the backer's acceptance
 * reserves the payout in its OWN units. That lock is the one record in the
 * system whose holder is not the party who converts it.
 */
function payoutSetup() {
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
  return { venue, sequencer, eur, gold };
}

/**
 * A venue-naming (bundle) lock: settles on a witnessed commit, or times out.
 *
 * Its id is derived, not chosen — so two holders share an attempt only by
 * sharing its terms, which for a venue-naming lock means sharing the party set.
 * That is §C1's exchange, and it is now the only way into one.
 */
function bundleLock(
  sequencer: Sequencer,
  backing: Backing,
  venue: LocalVenue,
  holder: keyof typeof SECRETS,
  quantity: bigint,
  salt: Uint8Array = ATTEMPT_SALT,
  parties?: Uint8Array[],
): LockOp {
  const key = KEYS[holder];
  const set = parties ?? [key];
  return {
    backing,
    attemptId: attemptIdOf(salt, venue.id, TIMEOUT, set),
    salt,
    holder: key,
    beneficiary: KEYS.bob,
    quantity,
    timeout: TIMEOUT,
    decisionVenue: venue.id,
    parties: set,
    nonce: sequencer.nextNonce(key, backing),
  };
}

function lock(sequencer: Sequencer, op: LockOp, holder: keyof typeof SECRETS) {
  return sequencer.submitLock(op, ed25519.sign(encodeLock(op), SECRETS[holder]));
}

/** Alice's demand for `quantity` of EUR, and the GOLD leg it needs. */
function present(sequencer: Sequencer, eur: Backing, gold: Backing, quantity: bigint) {
  const demand: DemandOp = {
    backing: eur,
    holder: KEYS.alice,
    quantity,
    instant: 0n,
    deadline: DEADLINE,
    nonce: sequencer.nextNonce(KEYS.alice, eur),
  };
  const hash = demandHash(demand);
  const leg: LockOp = {
    backing: gold,
    attemptId: hash,
    holder: KEYS.alice,
    beneficiary: KEYS.backer,
    quantity: quantity * 2n,
    timeout: TIMEOUT,
    decisionVenue: NO_DECISION_VENUE,
    parties: [KEYS.alice],
    nonce: sequencer.nextNonce(KEYS.alice, gold),
  };
  return {
    demand,
    hash,
    leg,
    signature: ed25519.sign(encodeDemand(demand), SECRETS.alice),
    legSignature: ed25519.sign(encodeLock(leg), SECRETS.alice),
  };
}

function file(sequencer: Sequencer, eur: Backing, gold: Backing, quantity: bigint) {
  const p = present(sequencer, eur, gold, quantity);
  return { ...p, receipt: sequencer.submitDemand(p.demand, p.signature, [{ op: p.leg, signature: p.legSignature }]) };
}

/**
 * A demand on GOLD, which has no reliance — so it has no legs and its exits are
 * one operation. What the release and withdrawal tests want is the law's own
 * resolution, and a set's shape is a door rule that would answer first.
 */
function plainDemand(sequencer: Sequencer, gold: Backing, quantity: bigint) {
  const demand: DemandOp = {
    backing: gold,
    holder: KEYS.alice,
    quantity,
    instant: 0n,
    deadline: DEADLINE,
    nonce: sequencer.nextNonce(KEYS.alice, gold),
  };
  sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice));
  return demandHash(demand);
}

describe("invariant 13: a lock's slot is the holder's own", () => {
  it("two holders reserve under one attempt id on one backing, and both stand", () => {
    // The key itself. Before this slice the second lock was refused with "this
    // attempt already has a lock on this backing", and which holder got the slot
    // was a race the id's namer won.
    const { venue, sequencer, gold } = setup();
    const alice = bundleLock(sequencer, gold, venue, "alice", 40n);
    const mallory = bundleLock(sequencer, gold, venue, "mallory", 10n);
    lock(sequencer, alice, "alice");
    lock(sequencer, mallory, "mallory");
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(160n);
    expect(sequencer.availableBalance(gold, KEYS.mallory)).toBe(190n);
  });

  it("and one holder still gets one slot per attempt on one backing", () => {
    // The key narrows the slot; it does not remove it. A holder who wants a
    // second reservation under one attempt names a fresh id, exactly as before.
    const { venue, sequencer, gold } = setup();
    lock(sequencer, bundleLock(sequencer, gold, venue, "alice", 40n), "alice");
    const again = bundleLock(sequencer, gold, venue, "alice", 5n);
    expect(() => lock(sequencer, again, "alice")).toThrow(LedgerError);
  });
});

describe("the squat family, ended at the source", () => {
  it("a stranger's lock on a leg does not block the demand's own leg", () => {
    // The leg-slot squat (24c, recorded open there). Mallory predicts the hash,
    // reserves one unit of GOLD under it, and Alice's leg needed that slot.
    const { venue, sequencer, eur, gold } = setup();
    const p = present(sequencer, eur, gold, 40n);
    const squat = bundleLock(sequencer, gold, venue, "mallory", 1n, p.hash);
    lock(sequencer, squat, "mallory");
    // Alice files anyway: her leg is a different record.
    sequencer.submitDemand(p.demand, p.signature, [{ op: p.leg, signature: p.legSignature }]);
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(120n);
    expect(sequencer.availableBalance(gold, KEYS.mallory)).toBe(199n);
  });

  it("a stranger's lock on the demanded backing does not refuse the demand", () => {
    // The pre-lock demand refusal (24c round four, recorded open). Mallory
    // locks under the predicted hash on EUR itself; the law refused the demand
    // with "a lock already stands under this demand's hash on this backing",
    // and the sequencer refused it earlier with "re-file with a fresh nonce" —
    // a delay bounded by re-filing, and paid by the honest party.
    const { venue, sequencer, eur, gold } = setup();
    const p = present(sequencer, eur, gold, 40n);
    lock(sequencer, bundleLock(sequencer, eur, venue, "mallory", 1n, p.hash), "mallory");
    sequencer.submitDemand(p.demand, p.signature, [{ op: p.leg, signature: p.legSignature }]);
    expect(sequencer.availableBalance(eur, KEYS.alice)).toBe(160n);
  });

  it("and the stranger's lock does not hijack the demand's exits", () => {
    // Why the six doors existed: signerOf resolved a release or withdrawal
    // lock-first, so a stranger's one-unit lock under a standing demand's hash
    // answered for the head. Alice's withdrawal now names her own record and
    // reaches her demand, with Mallory's lock untouched beside it.
    const { venue, sequencer, eur, gold } = setup();
    const p = present(sequencer, eur, gold, 40n);
    lock(sequencer, bundleLock(sequencer, eur, venue, "mallory", 1n, p.hash), "mallory");
    sequencer.submitDemand(p.demand, p.signature, [{ op: p.leg, signature: p.legSignature }]);
    advanceWitnessedIndex(venue, DEADLINE + 1n);
    const head = {
      backing: eur,
      demandHash: p.hash,
      holder: KEYS.alice,
      nonce: sequencer.nextNonce(KEYS.alice, eur),
    };
    const leg = {
      backing: gold,
      demandHash: p.hash,
      holder: KEYS.alice,
      nonce: sequencer.nextNonce(KEYS.alice, gold),
    };
    sequencer.submitWithdrawal(head, ed25519.sign(encodeWithdrawal(head), SECRETS.alice), [
      { op: leg, signature: ed25519.sign(encodeWithdrawal(leg), SECRETS.alice) },
    ]);
    expect(sequencer.availableBalance(eur, KEYS.alice)).toBe(200n);
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(200n);
    // Mallory's own unit is still reserved: it was never part of Alice's set.
    expect(sequencer.availableBalance(gold, KEYS.mallory)).toBe(200n);
    expect(sequencer.availableBalance(eur, KEYS.mallory)).toBe(199n);
  });

  it("a stranger cannot retire an attempt id the honest holder still needs", () => {
    // The retirement squat, newly reachable and closed in the same move: the
    // `retired` set is keyed by (attempt, holder) too. Mallory takes a lock
    // under X, lets it expire and withdraws — retiring X for Mallory alone.
    // Keyed by the id alone, that spent X on this backing for everybody.
    const { venue, sequencer, gold } = setup();
    const hers = bundleLock(sequencer, gold, venue, "mallory", 1n);
    lock(sequencer, hers, "mallory");
    // Her attempt is not Alice's to begin with: the party set is in the id, so
    // a stranger's lock is under a different attempt however she copies the salt.
    expect(compareBytes(hers.attemptId, ATTEMPT)).not.toBe(0);
    advanceWitnessedIndex(venue, TIMEOUT + 1n);
    const free = {
      backing: gold,
      demandHash: hers.attemptId,
      holder: KEYS.mallory,
      nonce: sequencer.nextNonce(KEYS.mallory, gold),
    };
    sequencer.submitWithdrawal(free, ed25519.sign(encodeWithdrawal(free), SECRETS.mallory));
    // Alice's own attempt, at a timeout ahead of where the clock now stands.
    const mine = bundleLock(sequencer, gold, venue, "alice", 40n, ATTEMPT_SALT);
    const later = { ...mine, timeout: TIMEOUT + 100n };
    lock(sequencer, { ...later, attemptId: attemptIdOf(ATTEMPT_SALT, venue.id, TIMEOUT + 100n, [KEYS.alice]) }, "alice");
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(160n);
  });

  it("but a holder still may not reuse an id their own lock has retired", () => {
    // The rule the retired set exists for is untouched: a commit binds its
    // attempt id and nothing else, so an object withheld from one attempt would
    // convert this holder's later lock under the same id and the same parties.
    const { venue, sequencer, gold } = setup();
    lock(sequencer, bundleLock(sequencer, gold, venue, "alice", 40n), "alice");
    advanceWitnessedIndex(venue, TIMEOUT + 1n);
    const free = {
      backing: gold,
      demandHash: ATTEMPT,
      holder: KEYS.alice,
      nonce: sequencer.nextNonce(KEYS.alice, gold),
    };
    sequencer.submitWithdrawal(free, ed25519.sign(encodeWithdrawal(free), SECRETS.alice));
    const again = { ...bundleLock(sequencer, gold, venue, "alice", 40n), timeout: TIMEOUT + 100n };
    expect(() => lock(sequencer, again, "alice")).toThrow(LedgerError);
  });
});

describe("§C3's commit, under a key it cannot name", () => {
  it("converts every lock under its attempt whose parties it satisfies", () => {
    // §C1's n-party exchange on one backing: Alice and Mallory each reserve
    // their own units for the same attempt, each naming both parties, and one
    // object signed by both converts both halves. The commit names no holder —
    // it cannot, being one object valid in every log at once — so the match is
    // by attempt and parties.
    const { venue, sequencer, gold } = setup();
    const both = keySet(KEYS.alice, KEYS.mallory);
    // One attempt because one set of TERMS: same salt, same venue, same timeout,
    // same party set. Sharing an id is now exactly sharing the exchange.
    const shared = attemptIdOf(ATTEMPT_SALT, venue.id, TIMEOUT, both);
    lock(sequencer, bundleLock(sequencer, gold, venue, "alice", 40n, ATTEMPT_SALT, both), "alice");
    lock(sequencer, bundleLock(sequencer, gold, venue, "mallory", 10n, ATTEMPT_SALT, both), "mallory");
    venue.advance(3n);
    venue.publishCommit(countersignCommit(signCommit(SECRETS.alice, shared), SECRETS.mallory));
    sequencer.settle(gold, shared);
    expect(sequencer.balance(gold, KEYS.bob)).toBe(50n);
    expect(sequencer.balance(gold, KEYS.alice)).toBe(160n);
    expect(sequencer.balance(gold, KEYS.mallory)).toBe(190n);
  });

  it("and leaves a lock under the same attempt whose parties it does not", () => {
    // The other half of the same rule, and what keeps a stranger out of the
    // match set: Mallory reserves under Alice's attempt naming only herself, so
    // Alice's object converts Alice's lock and never touches Mallory's units.
    const { venue, sequencer, gold } = setup();
    lock(sequencer, bundleLock(sequencer, gold, venue, "alice", 40n), "alice");
    lock(sequencer, bundleLock(sequencer, gold, venue, "mallory", 10n), "mallory");
    venue.advance(3n);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    sequencer.settle(gold, ATTEMPT);
    expect(sequencer.balance(gold, KEYS.bob)).toBe(40n);
    expect(sequencer.availableBalance(gold, KEYS.mallory)).toBe(190n);
  });

  it("a venue-naming lock names its own holder among its parties", () => {
    // §C1's "all sign", read as the law. Without it a stranger reserves one unit
    // under the victim's attempt naming ONLY the victim, and the victim's own
    // commit drags that lock into its match set — a settlement the victim
    // cannot decline, and one the stranger can arrange to fail (a beneficiary
    // balance at the quantity bound) so that the victim's commit is refused
    // outright. All-or-nothing across the match set is what makes it a hole
    // rather than a nuisance, and the rule closes it where it starts.
    const { venue, sequencer, gold } = setup();
    const notMine = bundleLock(sequencer, gold, venue, "mallory", 1n, ATTEMPT, [KEYS.alice]);
    expect(() => lock(sequencer, notMine, "mallory")).toThrow(LedgerError);
  });

  it("and a set leg does not, because no commit reaches it", () => {
    // The paying lock is the counter-example the rule has to survive: held by
    // the obligor, converted by the demand holder alone, naming no decision
    // venue. Scoping the rule to venue-naming locks is what keeps it lawful.
    const { sequencer, eur, gold } = setup();
    const p = present(sequencer, eur, gold, 40n);
    sequencer.submitDemand(p.demand, p.signature, [{ op: p.leg, signature: p.legSignature }]);
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(120n);
  });
});

describe("a release and a withdrawal name the record they end", () => {
  it("the holder named is the record's, not the signer's", () => {
    // §C3's paying lock is the case that fixes what the field means. It is held
    // by the OBLIGOR — those are the backer's own GOLD units — and converted by
    // the demand holder alone, whose release is the only signature that moves
    // anything. So the release naming it carries the backer's key while Alice
    // signs it. A field naming the signer could not express this record at all.
    const f = payoutSetup();
    const demand: DemandOp = {
      backing: f.eur,
      holder: KEYS.alice,
      quantity: 40n,
      instant: 0n,
      deadline: DEADLINE,
      nonce: f.sequencer.nextNonce(KEYS.alice, f.eur),
    };
    const hash = demandHash(demand);
    f.sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice));
    const answer: AcceptanceOp = {
      backing: f.eur,
      demandHash: hash,
      instant: 0n,
      deadline: 90n,
      nonce: f.sequencer.nextNonce(KEYS.backer, f.eur),
    };
    const paying: LockOp = {
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
    f.sequencer.submitAcceptance(answer, ed25519.sign(encodeAcceptance(answer), SECRETS.backer), [
      { op: paying, signature: ed25519.sign(encodeLock(paying), SECRETS.backer) },
    ]);
    const head = {
      backing: f.eur,
      demandHash: hash,
      holder: KEYS.alice,
      nonce: f.sequencer.nextNonce(KEYS.alice, f.eur),
    };
    const pay = {
      backing: f.gold,
      demandHash: hash,
      // The backer's record, Alice's signature.
      holder: KEYS.backer,
      nonce: f.sequencer.nextNonce(KEYS.alice, f.gold),
    };
    f.sequencer.submitRelease(head, ed25519.sign(encodeRelease(head), SECRETS.alice), [
      { op: pay, signature: ed25519.sign(encodeRelease(pay), SECRETS.alice) },
    ]);
    // Surrendered set and payout moved as one act: 40 EUR to the backer, 80
    // GOLD to Alice.
    expect(f.sequencer.balance(f.eur, KEYS.alice)).toBe(60n);
    expect(f.sequencer.balance(f.gold, KEYS.alice)).toBe(80n);
  });

  it("and naming a record other than the set's is refused at the door", () => {
    // The complement, so the claim above is a claim about the field rather than
    // about the happy path: Alice signs the payout leg naming HERSELF, where the
    // set names the obligor's record. The door binds the leg to the set's own
    // holder (found reviewing slice 31: unbound, the law would settle whatever
    // record `holder` named — a stranger's decoy — while the true leg stood).
    const f = payoutSetup();
    const demand: DemandOp = {
      backing: f.eur,
      holder: KEYS.alice,
      quantity: 40n,
      instant: 0n,
      deadline: DEADLINE,
      nonce: f.sequencer.nextNonce(KEYS.alice, f.eur),
    };
    const hash = demandHash(demand);
    f.sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice));
    const answer: AcceptanceOp = {
      backing: f.eur,
      demandHash: hash,
      instant: 0n,
      deadline: 90n,
      nonce: f.sequencer.nextNonce(KEYS.backer, f.eur),
    };
    const paying: LockOp = {
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
    f.sequencer.submitAcceptance(answer, ed25519.sign(encodeAcceptance(answer), SECRETS.backer), [
      { op: paying, signature: ed25519.sign(encodeLock(paying), SECRETS.backer) },
    ]);
    const head = {
      backing: f.eur,
      demandHash: hash,
      holder: KEYS.alice,
      nonce: f.sequencer.nextNonce(KEYS.alice, f.eur),
    };
    const pay = {
      backing: f.gold,
      demandHash: hash,
      holder: KEYS.alice,
      nonce: f.sequencer.nextNonce(KEYS.alice, f.gold),
    };
    expect(() =>
      f.sequencer.submitRelease(head, ed25519.sign(encodeRelease(head), SECRETS.alice), [
        { op: pay, signature: ed25519.sign(encodeRelease(pay), SECRETS.alice) },
      ]),
    ).toThrow(/a leg must end the record the set names/);
  });

  it("naming a holder with no record under that hash is refused", () => {
    // Alice's demand stands under this hash; Mallory's does not. The field is
    // not a hint the law may ignore — it selects the record, and there is none.
    const { sequencer, gold } = setup();
    const hash = plainDemand(sequencer, gold, 40n);
    const op = {
      backing: gold,
      demandHash: hash,
      holder: KEYS.mallory,
      nonce: sequencer.nextNonce(KEYS.mallory, gold),
    };
    expect(() =>
      sequencer.submitWithdrawal(op, ed25519.sign(encodeWithdrawal(op), SECRETS.mallory)),
    ).toThrow(LedgerError);
  });

  it("and naming another party's record buys nothing: the signature is checked against it", () => {
    // The field is safe because it is signed and the law resolves the signer
    // FROM it: name Alice's record and Mallory's signature no longer verifies.
    const { sequencer, gold } = setup();
    const hash = plainDemand(sequencer, gold, 40n);
    const op = {
      backing: gold,
      demandHash: hash,
      holder: KEYS.alice,
      nonce: sequencer.nextNonce(KEYS.alice, gold),
    };
    expect(() =>
      sequencer.submitWithdrawal(op, ed25519.sign(encodeWithdrawal(op), SECRETS.mallory)),
    ).toThrow(LedgerError);
  });
});

describe("the residual this closes: one holder, one hash, two records", () => {
  it("a venue-naming lock cannot name a demand's hash at all", () => {
    // The (attempt, holder) slice documented this rather than refusing it:
    // nothing stopped a holder naming her own demand's hash as her own attempt
    // id on the demanded backing, so her demand's exits sat behind her lock
    // until it resolved. Refusing it then would have meant keeping the two law
    // doors that slice deleted. The id being its terms' hash refuses it for
    // free — a demand's hash is not H(salt‖venue‖timeout‖parties), and no salt
    // makes it one short of a preimage. Closed, not documented.
    const { venue, sequencer, eur, gold } = setup();
    const base = sequencer.nextNonce(KEYS.alice, eur);
    const demand: DemandOp = {
      backing: eur,
      holder: KEYS.alice,
      quantity: 40n,
      instant: 0n,
      deadline: DEADLINE,
      nonce: base + 1n,
    };
    const mine: LockOp = {
      backing: eur,
      attemptId: demandHash(demand),
      salt: ATTEMPT_SALT,
      holder: KEYS.alice,
      beneficiary: KEYS.bob,
      quantity: 5n,
      timeout: TIMEOUT,
      decisionVenue: venue.id,
      parties: [KEYS.alice],
      nonce: base,
    };
    expect(() => lock(sequencer, mine, "alice")).toThrow(/not the hash of this attempt's terms/);
    // A SET LEG still names its demand's hash, and that is the same rule rather
    // than an exception: an attempt's id is its terms, and a set leg's attempt
    // is its demand, whose hash the demand itself fixes.
    const p = present(sequencer, eur, gold, 40n);
    sequencer.submitDemand(p.demand, p.signature, [{ op: p.leg, signature: p.legSignature }]);
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(120n);
  });

});

describe("the doors this slice deletes leave the honest path open", () => {
  it("a bare lock under a standing demand's hash on an unrelated backing is served", () => {
    // demandStands (sequencer.ts) scanned every backing the operator served and
    // refused a venue-naming lock under any standing demand's hash on the set's
    // own backings. It was narrowed twice by review — the second time because a
    // one-unit demand on X made a bare lock on Y unservable-but-counted against
    // the operator (slice 28). Nothing scans now.
    const { venue, sequencer, eur, gold } = setup();
    const p = file(sequencer, eur, gold, 40n);
    const bare = bundleLock(sequencer, gold, venue, "mallory", 10n, p.hash);
    expect(lock(sequencer, bare, "mallory")).toBeDefined();
  });

  it("and a release still refuses a leg submitted as the head of its own set", () => {
    // What the deleted release door was really for, kept where it belongs: the
    // set's shape is the sequencer's to know. A leg released alone would settle
    // its accompaniment with no demand settled.
    const { sequencer, eur, gold } = setup();
    const p = file(sequencer, eur, gold, 40n);
    const asHead = {
      backing: gold,
      demandHash: p.hash,
      holder: KEYS.alice,
      nonce: sequencer.nextNonce(KEYS.alice, gold),
    };
    expect(() =>
      sequencer.submitRelease(asHead, ed25519.sign(encodeRelease(asHead), SECRETS.alice)),
    ).toThrow(SequencerError);
  });
});

// The regression review of the slice, run on Opus across five angles, found
// three defects the key introduced. Each is pinned here by the exploit it was
// demonstrated with (scratch/review-*.mjs), so the fix is the exploit refused.

describe("regression: a leg release ends the set's OWN record, not a decoy under its hash", () => {
  it("a stranger's decoy lock under the hash cannot be substituted for the true leg", () => {
    // The door checked the lock at the set's holder but submitted the caller's
    // `holder`, and the law settled the latter: a stranger's one-unit decoy at
    // (hash, mallory) was converted while Alice's true 80-GOLD leg stood, the
    // backer taking 40 EUR for no accompaniment (review-leg-holder-substitution).
    const { venue, sequencer, eur, gold } = setup();
    const p = present(sequencer, eur, gold, 40n);
    sequencer.submitDemand(p.demand, p.signature, [{ op: p.leg, signature: p.legSignature }]);
    const answer: AcceptanceOp = {
      backing: eur,
      demandHash: p.hash,
      instant: 0n,
      deadline: 90n,
      nonce: sequencer.nextNonce(KEYS.backer, eur),
    };
    sequencer.submitAcceptance(answer, ed25519.sign(encodeAcceptance(answer), SECRETS.backer));
    // Mallory's own record under the demand's hash on GOLD — served like any other.
    lock(sequencer, bundleLock(sequencer, gold, venue, "mallory", 1n, p.hash), "mallory");
    const head = {
      backing: eur,
      demandHash: p.hash,
      holder: KEYS.alice,
      nonce: sequencer.nextNonce(KEYS.alice, eur),
    };
    const decoyLeg = {
      backing: gold,
      demandHash: p.hash,
      holder: KEYS.mallory, // not the set's record: Alice's leg is at (hash, alice)
      nonce: sequencer.nextNonce(KEYS.alice, gold),
    };
    expect(() =>
      sequencer.submitRelease(head, ed25519.sign(encodeRelease(head), SECRETS.alice), [
        { op: decoyLeg, signature: ed25519.sign(encodeRelease(decoyLeg), SECRETS.alice) },
      ]),
    ).toThrow(/a leg must end the record the set names/);
    // Nothing moved; the honest release naming the set's own leg still settles.
    const trueLeg = {
      backing: gold,
      demandHash: p.hash,
      holder: KEYS.alice,
      nonce: sequencer.nextNonce(KEYS.alice, gold),
    };
    sequencer.submitRelease(head, ed25519.sign(encodeRelease(head), SECRETS.alice), [
      { op: trueLeg, signature: ed25519.sign(encodeRelease(trueLeg), SECRETS.alice) },
    ]);
    expect(sequencer.balance(eur, KEYS.backer)).toBe(40n);
    expect(sequencer.balance(gold, KEYS.backer)).toBe(80n);
    // Mallory's decoy was never part of the set: her own unit, still reserved.
    expect(sequencer.availableBalance(gold, KEYS.mallory)).toBe(199n);
  });
});

describe("one attempt has one object, so a receipt cannot be captured", () => {
  it("two objects cannot settle two locks under one attempt: the terms are the id", () => {
    // The (attempt, holder) slice let two DISJOINT party sets stand under one id,
    // and that was the generator for every receipt defect this file records: a
    // second settlement swallowed by the first's receipt, a stranger's fresh lock
    // hiding an honest receipt, and a one-unit decoy settled first capturing it
    // forever (sec31-q2-receipt-hijack). All three needed locks with different
    // parties under one attempt. The party set is IN the id now, so an attempt
    // has one party set, so any object satisfying one of its locks satisfies all
    // — one attempt, one settling object, and nothing to capture.
    const { venue, sequencer, gold } = setup();
    const mine = bundleLock(sequencer, gold, venue, "alice", 40n);
    lock(sequencer, mine, "alice");
    // Mallory's own party set is her own attempt, whatever salt she copies.
    const hers = bundleLock(sequencer, gold, venue, "mallory", 1n);
    expect(compareBytes(hers.attemptId, mine.attemptId)).not.toBe(0);
    // And she cannot join Alice's: its terms name only Alice.
    const intruder = { ...bundleLock(sequencer, gold, venue, "alice", 1n), holder: KEYS.mallory, nonce: sequencer.nextNonce(KEYS.mallory, gold) };
    expect(() => lock(sequencer, intruder, "mallory")).toThrow(/names its own holder among its parties/);
    venue.advance(3n);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    const first = sequencer.settle(gold, ATTEMPT);
    expect(sequencer.balance(gold, KEYS.bob)).toBe(40n);
    // The one object's receipt, re-obtained by naming it.
    expect(sequencer.settle(gold, ATTEMPT, signCommit(SECRETS.alice, ATTEMPT))).toEqual(first);
  });

  it("and an object naming another attempt is refused, not answered", () => {
    // Slice 27's shape at a new door: a receipt for one attempt handed back to a
    // request naming another is a receipt for an act the caller never asked about.
    const { venue, sequencer, gold } = setup();
    lock(sequencer, bundleLock(sequencer, gold, venue, "alice", 40n), "alice");
    venue.advance(3n);
    venue.publishCommit(signCommit(SECRETS.alice, ATTEMPT));
    sequencer.settle(gold, ATTEMPT);
    const elsewhere = signCommit(SECRETS.alice, new Uint8Array(32).fill(0xbb));
    expect(() => sequencer.settle(gold, ATTEMPT, elsewhere)).toThrow(/names another attempt/);
  });
});

describe("one attempt carries one timeout, because the timeout is IN the attempt", () => {
  it("a lock at another timeout is another attempt, not a refusal", () => {
    // This was a door refusal comparing a new lock's timeout against a standing
    // sibling's — and it held the property only where two locks sat on ONE
    // backing, while creating a denial of service of its own, since its predicate
    // read a record the applicant did not own (a stranger's refunded unit refused
    // the victim's leg). The id being its terms' hash retires it: a different
    // timeout is a different attempt, so there is nothing to compare and nobody
    // to refuse. §C1's "the timeout unlocks everywhere" and §C3 step 4's "one
    // attempt carries one timeout" are now true by construction, across backings
    // and operators alike, which the sibling scan could never reach.
    const { venue, sequencer, gold } = setup();
    const both = keySet(KEYS.alice, KEYS.mallory);
    const shared = attemptIdOf(ATTEMPT_SALT, venue.id, TIMEOUT, both);
    lock(sequencer, bundleLock(sequencer, gold, venue, "alice", 40n, ATTEMPT_SALT, both), "alice");
    // Mallory's shorter timeout: a different id, so it never enters Alice's
    // match set and cannot strand her half.
    const shorter = { ...bundleLock(sequencer, gold, venue, "mallory", 10n, ATTEMPT_SALT, both), timeout: TIMEOUT - 10n };
    expect(() => lock(sequencer, shorter, "mallory")).toThrow(/not the hash of this attempt's terms/);
    // The honest path: the same terms, and the exchange stands.
    const agreed = bundleLock(sequencer, gold, venue, "mallory", 10n, ATTEMPT_SALT, both);
    expect(lock(sequencer, agreed, "mallory")).toBeDefined();
    venue.advance(3n);
    venue.publishCommit(countersignCommit(signCommit(SECRETS.alice, shared), SECRETS.mallory));
    sequencer.settle(gold, shared);
    expect(sequencer.balance(gold, KEYS.bob)).toBe(50n);
  });

  it("and a set leg keeps its own term, because no commit reaches it", () => {
    // Scoped like its sibling rule: the demand's leg names no decision venue and
    // settles with its set, so its timeout is the holder's own to set even where
    // a venue-naming lock stands under the same hash.
    const { venue, sequencer, eur, gold } = setup();
    const p = present(sequencer, eur, gold, 40n);
    lock(sequencer, bundleLock(sequencer, gold, venue, "mallory", 10n, p.hash), "mallory");
    // Alice's leg under the same hash, its own timeout, filed with her demand.
    sequencer.submitDemand(p.demand, p.signature, [{ op: p.leg, signature: p.legSignature }]);
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(120n);
  });
});

describe("a set leg and a venue-naming lock cannot share an attempt at all", () => {
  it("a venue-naming lock under a demand's hash is refused, so the brick is unreachable", () => {
    // A set leg's parties are [holder], so any object that holder signed matched
    // it, and the law threw for the whole entry — bricking a genuine venue-naming
    // lock that shared the attempt id, with no exit at any index
    // (review-match-set). That fix (exclude a set leg from the match set rather
    // than throw) stays as the law's guard on an inherited log, but the shape
    // cannot be built through a door any more: a set leg's id is its demand's
    // hash, a venue-naming lock's is its terms' hash, and one is not the other
    // short of a preimage.
    const { venue, sequencer, eur, gold } = setup();
    const p = present(sequencer, eur, gold, 40n);
    sequencer.submitDemand(p.demand, p.signature, [{ op: p.leg, signature: p.legSignature }]);
    const both = keySet(KEYS.alice, KEYS.mallory);
    const sharing: LockOp = {
      ...bundleLock(sequencer, gold, venue, "mallory", 10n, ATTEMPT_SALT, both),
      attemptId: p.hash, // the set leg's attempt, claimed by a venue-naming lock
    };
    expect(() => lock(sequencer, sharing, "mallory")).toThrow(/not the hash of this attempt's terms/);
    // Alice's leg is untouched, and her demand still stands.
    expect(sequencer.availableBalance(gold, KEYS.alice)).toBe(120n);
    expect(sequencer.openDemands(eur)).toHaveLength(1);
  });
});
