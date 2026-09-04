import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking } from "../src/backing.js";
import { signCommitment, stateRoot, type Commitment } from "../src/commitment.js";
import {
  commitmentRegisters,
  ErgoVenue,
  ergoVenueId,
  type ErgoAddressing,
  type ErgoBoxView,
  type ErgoNode,
} from "../src/ergo.js";
import { encodePublishedOp } from "../src/oplog.js";
import { encodeTransferMessage } from "../src/messages.js";
import { demandHash, encodeDemand, encodeLock, type DemandOp, type LockOp } from "../src/presentation.js";
import { Sequencer, SequencerError } from "../src/sequencer.js";
import { eraIndex, isSilent, provesHolding, quietFor } from "../src/recovery.js";
import { VenueError } from "../src/venue.js";
import { encodeReplacement, operatorAt, replacementMessage, ROLE_OPERATOR } from "../src/replacement.js";
import { encodeRevocation, signRevocation } from "../src/revocation.js";
import { KEYS, SECRETS } from "./support.js";

// Ergo read as a witness venue. The chain witnesses and adjudicates nothing, so
// there is no contract here and nothing verifies a signature on-chain — a
// commitment is a record in box registers and every judgement is the reader's.
//
// Two properties carry the security of it, and both are tested below:
//
//   - **the witnessed index is the box's inclusionHeight**, which is the block
//     that included the creating transaction. A box's own creationHeight is
//     written by whoever built the transaction and may be set lower, so using it
//     would let an operator backdate a commitment to before a redemption leg it
//     actually followed — the veto slice 8 closed. It is not even modelled here.
//   - **nothing inside the finality depth is read at all**, because
//     inclusionHeight is reorg-sensitive and a venue answering from the tip would
//     change its mind about the past.
//
// And the seam is only real if the existing predicates accept it, so the last
// group runs them against this venue rather than the local one.

const DEPTH = 3n;
const SCRIPT = "publication-script-v1";
const VENUE_ID = ergoVenueId("ergo-testnet", DEPTH, SCRIPT);

const ADDRESSING: ErgoAddressing = {
  commitments: (operator) => `commit:${Buffer.from(operator).toString("hex")}`,
  publications: (backingName) => `publish:${Buffer.from(backingName).toString("hex")}`,
  revocations: (obligor) => `revoke:${Buffer.from(obligor).toString("hex")}`,
};

/** The node, as far as a venue can see it: boxes by address, and a height. */
class FakeNode implements ErgoNode {
  private height = 0n;
  private readonly boxes = new Map<string, ErgoBoxView[]>();

  at(height: bigint): this {
    this.height = height;
    return this;
  }

  put(address: string, box: ErgoBoxView): this {
    const at = this.boxes.get(address) ?? [];
    at.push(box);
    this.boxes.set(address, at);
    return this;
  }

  putCommitment(commitment: Commitment, inclusionHeight: bigint): this {
    return this.put(ADDRESSING.commitments(commitment.operator), {
      inclusionHeight,
      registers: commitmentRegisters(commitment),
    });
  }

  async indexedHeight(): Promise<bigint> {
    return this.height;
  }

  async boxesByAddress(address: string): Promise<ErgoBoxView[]> {
    return this.boxes.get(address) ?? [];
  }
}

const backing = makeBacking({
  obligor: KEYS.backer,
  payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
  reliance: [],
  evidence: {
    setting: "transparent",
    operator: KEYS.operator,
    silence: { noCommitmentDuration: 10n, challengeWindow: 5n },
    witnessing: { venue: VENUE_ID, interval: 5n },
  },
});

function commitment(sequence: bigint, fill: number): Commitment {
  return signCommitment(SECRETS.operator, sequence, new Uint8Array(32).fill(fill));
}

function venue(): ErgoVenue {
  return new ErgoVenue("ergo-testnet", DEPTH, SCRIPT, ADDRESSING);
}

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("a refresh owns its clock and records until it settles", () => {
  it.each(["height", "publications"] as const)("copies the requested backing set before awaiting %s", async pauseAt => {
    const v = venue(), entered = signal(), resume = signal();
    const input = makeBacking(backing), requested = [input];
    const publicationAddress = ADDRESSING.publications(backing.name);
    const op = { kind: "transfer" as const, from: KEYS.alice, to: KEYS.bob,
      quantity: 1n, nonce: 0n, signature: new Uint8Array(64).fill(0xab) };
    class Pauses extends FakeNode {
      override async indexedHeight() {
        if (pauseAt === "height") { entered.resolve(); await resume.promise; }
        return super.indexedHeight();
      }
      override async boxesByAddress(address: string) {
        if (pauseAt === "publications" && address === publicationAddress) {
          entered.resolve(); await resume.promise;
        }
        return super.boxesByAddress(address);
      }
    }
    const node = new Pauses().at(100n).putCommitment(commitment(0n, 0xaa), 95n)
      .put(publicationAddress, { inclusionHeight: 90n,
        registers: { R5: encodePublishedOp(backing.name, op) } });
    const refresh = v.sync(node, requested);
    await entered.promise;
    try {
      input.name.fill(0);
      input.obligor.set(KEYS.mallory);
      input.evidence.operator.set(KEYS.bob);
      requested.length = 0;
    } finally {
      resume.resolve();
      await refresh;
    }
    expect(v.publishedOpsFor(backing.name)).toEqual([{ op, at: 90n }]);
    expect(v.revocationsFor(KEYS.backer)).toEqual([]);
    expect(v.latestFor(KEYS.operator)?.sequence).toBe(0n);
    expect(isSilent(v, backing)).toBe(false);
  });

  it.each(["height", "commitments"] as const)("rejects overlap during %s without changing either view", async (pauseAt) => {
    const v = venue();
    await v.sync(new FakeNode().at(100n).putCommitment(commitment(0n, 0xaa), 95n), [backing]);
    const entered = signal();
    const resume = signal();
    class Pauses extends FakeNode {
      override async indexedHeight() {
        if (pauseAt === "height") {
          entered.resolve();
          await resume.promise;
        }
        return super.indexedHeight();
      }
      override async boxesByAddress(address: string) {
        if (pauseAt === "commitments" && address === ADDRESSING.commitments(KEYS.operator)) {
          entered.resolve();
          await resume.promise;
        }
        return super.boxesByAddress(address);
      }
    }
    const refresh = v.sync(new Pauses().at(110n).putCommitment(commitment(1n, 0xbb), 105n), [backing]);
    await entered.promise;
    const newer = new FakeNode().at(200n).putCommitment(commitment(2n, 0xcc), 195n);
    try {
      if (pauseAt === "height") {
        expect(v.witnessedIndex()).toBe(97n);
        expect(isSilent(v, backing)).toBe(false);
      } else {
        expect(() => isSilent(v, backing)).toThrow(VenueError);
      }
      await expect(v.sync(newer, [backing])).rejects.toThrow("a sync is already in progress");
      // A rejected overlap must not release the first caller's guard.
      await expect(v.sync(newer, [backing])).rejects.toThrow(VenueError);
    } finally {
      resume.resolve();
      await refresh;
    }
    expect(v.witnessedIndex()).toBe(107n);
    expect(v.latestFor(KEYS.operator)?.sequence).toBe(1n);
    expect(isSilent(v, backing)).toBe(false);
    await v.sync(newer, [backing]);
    expect(v.witnessedIndex()).toBe(197n);
    expect(v.latestFor(KEYS.operator)?.sequence).toBe(2n);
    expect(isSilent(v, backing)).toBe(false);
  });

  it.each(["height", "commitments"] as const)("allows retry after a failed %s fetch", async (failAt) => {
    const v = venue();
    await v.sync(new FakeNode().at(100n).putCommitment(commitment(0n, 0xaa), 95n), [backing]);
    class Fails extends FakeNode {
      override async indexedHeight() {
        if (failAt === "height") throw new Error("node offline");
        return super.indexedHeight();
      }
      override async boxesByAddress(address: string) {
        if (failAt === "commitments" && address === ADDRESSING.commitments(KEYS.operator)) {
          throw new Error("node offline");
        }
        return super.boxesByAddress(address);
      }
    }
    await expect(v.sync(new Fails().at(110n), [backing])).rejects.toThrow("node offline");
    if (failAt === "height") {
      expect(v.witnessedIndex()).toBe(97n);
      expect(isSilent(v, backing)).toBe(false);
    } else {
      expect(() => v.witnessedIndex()).toThrow(VenueError);
      expect(() => isSilent(v, backing)).toThrow(VenueError);
    }
    await v.sync(new FakeNode().at(110n).putCommitment(commitment(1n, 0xbb), 105n), [backing]);
    expect(v.witnessedIndex()).toBe(107n);
    expect(isSilent(v, backing)).toBe(false);
  });
});

describe("a reader cannot mutate the stored venue evidence", () => {
  it("copies commitment keys, roots and signatures", async () => {
    const v = venue();
    const original = commitment(0n, 0xaa);
    await v.sync(new FakeNode().at(100n).putCommitment(original, 95n), [backing]);
    const read = v.latestFor(KEYS.operator)!;
    read.root.fill(0);
    read.operator.fill(0);
    read.signature.fill(0);
    expect(v.latestFor(KEYS.operator)).toEqual(original);
    expect(v.latestFor(KEYS.operator, 95n)).toEqual(original);
  });

  it("copies signed revocations", async () => {
    const v = venue();
    const original = signRevocation(SECRETS.backer);
    await v.sync(new FakeNode().at(100n).put(ADDRESSING.revocations(KEYS.backer), {
      inclusionHeight: 20n,
      registers: { R5: encodeRevocation(original) },
    }), [backing]);
    const read = v.revocationsFor(KEYS.backer)[0]!.revocation;
    read.obligor.fill(0);
    read.signature.fill(0);
    expect(v.revocationsFor(KEYS.backer)).toEqual([{ revocation: original, at: 20n }]);
  });

  it("copies nested publication bytes, including lock parties", async () => {
    const v = venue();
    const original = {
      kind: "lock" as const,
      attemptId: new Uint8Array(32).fill(0xe7),
      salt: new Uint8Array(32).fill(0xe8),
      holder: KEYS.alice,
      beneficiary: KEYS.bob,
      quantity: 1n,
      timeout: 100n,
      decisionVenue: VENUE_ID,
      parties: [KEYS.alice],
      nonce: 0n,
      signature: new Uint8Array(64).fill(0xab),
    };
    await v.sync(new FakeNode().at(100n).put(ADDRESSING.publications(backing.name), {
      inclusionHeight: 20n,
      registers: { R5: encodePublishedOp(backing.name, original) },
    }), [backing]);
    const read = v.publishedOpsFor(backing.name)[0]!.op;
    expect(read.kind).toBe("lock");
    if (read.kind !== "lock") throw new Error("expected a lock publication");
    for (const bytes of [read.attemptId, read.salt, read.holder, read.beneficiary,
      read.decisionVenue, read.signature, ...read.parties]) bytes.fill(0);
    expect(v.publishedOpsFor(backing.name)).toEqual([{ op: original, at: 20n }]);
  });
});

describe("a venue's identity commits to its finality rule", () => {
  it("changes with the depth, so naming the venue agrees the depth", () => {
    // §C2 names a venue together with the depth under which an index counts as
    // witnessed there — "a floor under the interval, or two sequencers answer
    // §C3's release predicate differently". Two backings naming one id cannot
    // disagree about the depth if the id is derived from it.
    const base = ergoVenueId("ergo-testnet", 3n, SCRIPT);
    expect(ergoVenueId("ergo-testnet", 3n, SCRIPT)).toEqual(base);
    expect(ergoVenueId("ergo-testnet", 4n, SCRIPT)).not.toEqual(base);
    expect(ergoVenueId("ergo-mainnet", 3n, SCRIPT)).not.toEqual(base);
    expect(ergoVenueId("ergo-testnet", 3n, "other-script")).not.toEqual(base);
    expect(base).toHaveLength(32);
  });

  it("the view derives its id from the depth it runs, so one declared venue cannot be read on two clocks", async () => {
    // Found by the 2026-08-22 audit, twice: the id and the depth were separate
    // constructor arguments, so two views carrying E's id could answer §C3's
    // release predicate differently. Now the only way to carry the id is to run
    // the depth it commits to.
    expect(venue().id).toEqual(VENUE_ID);
    expect(new ErgoVenue("ergo-testnet", 0n, SCRIPT, ADDRESSING).id).not.toEqual(VENUE_ID);
    const node = new FakeNode().at(100n).putCommitment(commitment(0n, 0xaa), 40n);
    const declared = venue();
    const eager = new ErgoVenue("ergo-testnet", 0n, SCRIPT, ADDRESSING);
    await declared.sync(node, [backing]);
    await eager.sync(node, [backing]);
    expect(declared.witnessedIndex()).toBe(97n);
    expect(eager.witnessedIndex()).toBe(100n);
    // And only one of them is the venue the backing declares.
    expect(declared.id).toEqual(backing.evidence.witnessing?.venue);
    expect(eager.id).not.toEqual(backing.evidence.witnessing?.venue);
  });

  it("the clock is nothing an unsynced view can answer", async () => {
    // The one read that had no guard: it answered 0, so every lock read live and
    // nothing read dishonoured — absence of data as an exoneration.
    const v = venue();
    expect(() => v.witnessedIndex()).toThrow(VenueError);
    await v.sync(new FakeNode().at(100n), [backing]);
    expect(v.witnessedIndex()).toBe(97n);
  });
});

describe("the witnessed index is the block that included the box", () => {
  it("reads a commitment at its inclusion height", async () => {
    const v = venue();
    await v.sync(new FakeNode().at(100n).putCommitment(commitment(0n, 0xaa), 40n), [backing]);
    expect(v.witnessedAtFor(KEYS.operator)).toBe(40n);
    expect(v.latestFor(KEYS.operator)?.sequence).toBe(0n);
  });

  it("reads nothing inside the finality depth", async () => {
    // A box at the tip is not witnessed yet: a reorg would move it, and a venue
    // that changed its mind about the past would unmake settled answers.
    const node = new FakeNode().at(100n).putCommitment(commitment(0n, 0xaa), 98n);
    const v = venue();
    await v.sync(node, [backing]);
    expect(v.witnessedIndex()).toBe(97n);
    expect(v.latestFor(KEYS.operator)).toBeUndefined();

    await v.sync(node.at(101n), [backing]);
    expect(v.witnessedIndex()).toBe(98n);
    expect(v.latestFor(KEYS.operator)?.sequence).toBe(0n);
  });

  it("answers about the past, which is what four of the nine reads need", async () => {
    const v = venue();
    const node = new FakeNode()
      .at(100n)
      .putCommitment(commitment(0n, 0xaa), 10n)
      .putCommitment(commitment(1n, 0xbb), 50n);
    await v.sync(node, [backing]);

    expect(v.latestFor(KEYS.operator)?.sequence).toBe(1n);
    expect(v.latestFor(KEYS.operator, 49n)?.sequence).toBe(0n);
    expect(v.witnessedAtFor(KEYS.operator, 49n)).toBe(10n);
    expect(v.latestFor(KEYS.operator, 9n)).toBeUndefined();
    expect(v.firstCommitmentFor(KEYS.operator)).toBe(10n);
    expect(v.firstCommitmentFor(KEYS.operator, 11n)).toBe(50n);
    expect(v.nextSequenceFor(KEYS.operator)).toBe(2n);
  });

  it("orders by the chain's word, not by the order boxes came back", async () => {
    const v = venue();
    await v.sync(
      new FakeNode()
        .at(100n)
        .putCommitment(commitment(1n, 0xbb), 50n)
        .putCommitment(commitment(0n, 0xaa), 10n),
      [backing],
    );
    expect(v.firstCommitmentFor(KEYS.operator)).toBe(10n);
    expect(v.latestFor(KEYS.operator)?.sequence).toBe(1n);
  });
});

describe("nothing rests on the address alone", () => {
  it("skips a box whose commitment is not this operator's", async () => {
    // Anyone may create a box at an address, so the signature does the deciding.
    const v = venue();
    const stranger = signCommitment(SECRETS.mallory, 0n, new Uint8Array(32).fill(0xcc));
    await v.sync(
      new FakeNode().at(100n).put(ADDRESSING.commitments(KEYS.operator), {
        inclusionHeight: 10n,
        registers: commitmentRegisters(stranger),
      }),
      [backing],
    );
    expect(v.latestFor(KEYS.operator)).toBeUndefined();
  });

  it("skips a box whose signature does not verify", async () => {
    const v = venue();
    const torn = { ...commitment(0n, 0xaa), signature: new Uint8Array(64) };
    await v.sync(
      new FakeNode().at(100n).put(ADDRESSING.commitments(KEYS.operator), {
        inclusionHeight: 10n,
        registers: commitmentRegisters(torn),
      }),
      [backing],
    );
    expect(v.latestFor(KEYS.operator)).toBeUndefined();
  });

  it("skips noise rather than failing on it", async () => {
    const v = venue();
    await v.sync(
      new FakeNode()
        .at(100n)
        .put(ADDRESSING.commitments(KEYS.operator), { inclusionHeight: 5n, registers: {} })
        .put(ADDRESSING.commitments(KEYS.operator), {
          inclusionHeight: 6n,
          registers: { R4: new Uint8Array(3), R5: new Uint8Array(1), R6: new Uint8Array(0), R7: new Uint8Array(2) },
        })
        .putCommitment(commitment(0n, 0xaa), 10n),
      [backing],
    );
    expect(v.latestFor(KEYS.operator)?.sequence).toBe(0n);
  });

  it("reads published operations, and only this backing's", async () => {
    const v = venue();
    const op = {
      kind: "transfer" as const,
      from: KEYS.alice,
      to: KEYS.bob,
      quantity: 40n,
      nonce: 0n,
      signature: ed25519.sign(
        encodeTransferMessage(backing.name, KEYS.alice, KEYS.bob, 40n, 0n),
        SECRETS.alice,
      ),
    };
    await v.sync(
      new FakeNode().at(100n).put(ADDRESSING.publications(backing.name), {
        inclusionHeight: 20n,
        registers: { R4: backing.name, R5: encodePublishedOp(backing.name, op) },
      }),
      [backing],
    );
    const published = v.publishedOpsFor(backing.name);
    expect(published).toHaveLength(1);
    expect(published[0]!.at).toBe(20n);
    expect(published[0]!.op).toEqual(op);
  });
});

describe("this venue reads; publishing is somebody else's wallet", () => {
  it("refuses to publish, and says which boundary refused", async () => {
    const v = venue();
    expect(() => v.publish()).toThrow(VenueError);
    expect(() => v.publishOp()).toThrow(VenueError);
    expect(() => v.publishReplacement()).toThrow(VenueError);
  });
});

describe("the seam is real: the existing predicates take this venue", () => {
  it("grades silence off the chain's own heights", async () => {
    // The point of the whole slice. isSilent, quietFor and provesHolding were
    // written against an in-memory stand-in and are handed an Ergo venue here
    // with nothing changed in them.
    const v = venue();
    const node = new FakeNode().at(100n).putCommitment(commitment(0n, 0xaa), 40n);
    await v.sync(node, [backing]);

    expect(quietFor(v, KEYS.operator)).toBe(57n);
    expect(isSilent(v, backing)).toBe(true);

    // And it stops being silent the moment a later commitment is witnessed.
    await v.sync(node.at(101n).putCommitment(commitment(1n, 0xbb), 95n), [backing]);
    expect(isSilent(v, backing)).toBe(false);
  });

  it("refuses to grade a backing that declares another venue", async () => {
    const elsewhere = makeBacking({
      ...backing,
      evidence: {
        ...backing.evidence,
        witnessing: { venue: ergoVenueId("ergo-mainnet", DEPTH, SCRIPT), interval: 5n },
      },
    });
    const v = venue();
    await v.sync(new FakeNode().at(1000n), [elsewhere]);
    expect(isSilent(v, elsewhere)).toBe(false);
  });

  it("proves a holding against a state the chain witnessed", async () => {
    // The full path: the operator's committed state, anchored by a commitment
    // this venue read out of box registers.
    const snapshots = [{ name: backing.name, opLog: [] }];
    const anchored = signCommitment(SECRETS.operator, 0n, stateRoot(snapshots));
    const v = venue();
    await v.sync(new FakeNode().at(100n).putCommitment(anchored, 40n), [backing]);
    // No issuance in this log, so nobody holds anything — what is being checked
    // is that the served state resolves against a chain-read commitment at all.
    expect(provesHolding(v, backing, { snapshots, commitment: anchored }, KEYS.alice, 1n)).toBe(false);
    expect(v.latestFor(KEYS.operator)?.root).toEqual(anchored.root);
  });
});

describe("a view answers only for what it was synced for", () => {
  it("refuses an operator it never fetched, rather than grading it silent", async () => {
    // The finding this group exists for. A venue has one height, because
    // witnessedIndex answers without being asked about a backing — so it must
    // have one coherent set of records to go with it. Refreshing part of the
    // view while the clock moved for all of it graded a punctual operator
    // silent: its records stopped where the last partial sync left them, which
    // opens snapshot redemption against somebody who committed moments ago.
    //
    // Absence of data must not read as an accusation, so the venue refuses
    // instead of answering. VenueError names the boundary: this is a caller
    // asking the wrong object, not adversary input.
    const other = makeBacking({
      obligor: KEYS.backer2,
      payout: { thing: "USD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: {
        setting: "transparent",
        operator: KEYS.mallory,
        silence: { noCommitmentDuration: 10n, challengeWindow: 5n },
        witnessing: { venue: VENUE_ID, interval: 5n },
      },
    });
    const v = venue();
    // Committed two blocks inside the view, so a correct reading is "not silent".
    const node = new FakeNode().at(200n).putCommitment(commitment(0n, 0xaa), 195n);
    await v.sync(node, [other]);

    expect(() => isSilent(v, backing)).toThrow(VenueError);
    expect(() => v.publishedOpsFor(backing.name)).toThrow(VenueError);

    // Synced for it, and the punctual operator reads as punctual.
    await v.sync(node, [other, backing]);
    expect(isSilent(v, backing)).toBe(false);
  });

  it("refuses an unsynced backing whose operator IS fetched, which is the common case", async () => {
    // Found regression-reviewing slice 19, and the guard above passes for a
    // coincidental reason: its unsynced backing has an operator nobody fetched,
    // so the operator-keyed guard fires. §C5 recommends one operator serving
    // many backings, and then syncing backing A fetches that operator — so
    // asking about unsynced backing B sails past both guards.
    //
    // It takes a backing that DECLARES a replacement rule, because that is when
    // the chain is read at all: without one successionOf never reaches the venue,
    // and the answer it gives is right, since an operator's commitments are the
    // operator's and were fetched.
    //
    // What answered instead was successionOf's catch, which turned the venue's
    // refusal into the GENESIS chain: the pre-succession answer slice 14 warned
    // a caller must never get silently. On a backing whose operator had been
    // replaced that reads the RETIRED key as the one in force, so a successor
    // committing on schedule grades as silent and snapshot redemption opens
    // against an honest operator — out of not having looked.
    const sameOperator = makeBacking({
      obligor: KEYS.backer2,
      payout: { thing: "USD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: {
        setting: "transparent",
        operator: KEYS.operator,
        silence: { noCommitmentDuration: 10n, challengeWindow: 5n },
        replacementRule: KEYS.backer2,
        witnessing: { venue: VENUE_ID, interval: 5n },
      },
    });
    const v = venue();
    const node = new FakeNode().at(200n).putCommitment(commitment(0n, 0xaa), 195n);
    await v.sync(node, [backing]);

    // The operator is fetched, so the operator-keyed guard cannot fire.
    expect(() => v.latestFor(KEYS.operator)).not.toThrow();
    expect(() => isSilent(v, sameOperator)).toThrow(VenueError);
    expect(() => operatorAt(sameOperator, v, v.witnessedIndex())).toThrow(VenueError);

    await v.sync(node, [backing, sameOperator]);
    expect(isSilent(v, sameOperator)).toBe(false);
  });

  it("fetches every operator in a covered backing's chain, so succession still reads", async () => {
    // The guard must not break succession: sync widens until the chain stops
    // revealing operators, so operatorAt can never reach one that was not
    // fetched.
    const v = venue();
    await v.sync(new FakeNode().at(100n).putCommitment(commitment(0n, 0xaa), 40n), [backing]);
    expect(() => v.latestFor(KEYS.operator)).not.toThrow();
    expect(v.latestFor(KEYS.operator)?.sequence).toBe(0n);
  });

  it("a FIRST sync of a backing that declares a replacement rule completes, and its chain reads", async () => {
    // The frontier loop walks the chain, the walk reads the clock, and the
    // clock refused on an unsynced view — so the first sync of any backing
    // with a rule threw its own VenueError out of sync(). Every earlier test
    // re-synced a view whose flag was already set by a rule-less backing
    // (found by the slice-37 panel's inventory angle).
    const ruled = makeBacking({
      obligor: KEYS.backer2,
      payout: { thing: "USD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: {
        setting: "transparent",
        operator: KEYS.operator,
        silence: { noCommitmentDuration: 10n, challengeWindow: 5n },
        replacementRule: KEYS.backer2,
        witnessing: { venue: VENUE_ID, interval: 5n },
      },
    });
    const v = venue();
    await v.sync(new FakeNode().at(200n).putCommitment(commitment(0n, 0xaa), 195n), [ruled]);
    expect(operatorAt(ruled, v, v.witnessedIndex())).toEqual(KEYS.operator);
    expect(isSilent(v, ruled)).toBe(false);
  });

  it("a half-fetched operator refuses rather than reading as never having committed: on a node error, and inside the fetch", async () => {
    // The frontier loop marked an operator fetched BEFORE awaiting its fetch,
    // so with the view answering from before that loop, a punctual heir read
    // `latestFor` as nothing — never committed — for the whole round trip,
    // and forever if the node erred: a false silence grade (the slice-37
    // review's blocker). Marked after, the guard refuses in both windows.
    const ruled = makeBacking({
      obligor: KEYS.backer2,
      payout: { thing: "USD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: {
        setting: "transparent",
        operator: KEYS.operator,
        silence: { noCommitmentDuration: 10n, challengeWindow: 5n },
        replacementRule: KEYS.backer2,
        witnessing: { venue: VENUE_ID, interval: 5n },
      },
    });
    const unsigned = {
      role: ROLE_OPERATOR,
      successor: KEYS.alice,
      predecessor: ruled.name,
      effective: 150n,
      signature: new Uint8Array(64),
      successorSignature: new Uint8Array(64),
    };
    const message = replacementMessage(ruled.name, unsigned);
    const replacement = {
      ...unsigned,
      signature: ed25519.sign(message, SECRETS.backer2),
      successorSignature: ed25519.sign(message, SECRETS.alice),
    };
    const heirsBoxes = ADDRESSING.commitments(KEYS.alice);
    const heirs = signCommitment(SECRETS.alice, 0n, stateRoot([]));
    const fill = (node: FakeNode) =>
      node
        .at(200n)
        .putCommitment(commitment(0n, 0xaa), 100n)
        .put(ADDRESSING.publications(ruled.name), {
          inclusionHeight: 140n,
          registers: { R4: ruled.name, R5: encodeReplacement(ruled.name, replacement) },
        })
        .putCommitment(heirs, 190n);
    // (a) the node errs on the heir's commitments: sync rejects, and the heir
    // is refused, not read as silent.
    class Errs extends FakeNode {
      override async boxesByAddress(address: string) {
        if (address === heirsBoxes) throw new Error("node: connection reset");
        return super.boxesByAddress(address);
      }
    }
    const v = venue();
    await expect(v.sync(fill(new Errs()), [ruled])).rejects.toThrow(/connection reset/);
    expect(() => v.witnessedIndex()).toThrow(VenueError); // the view is un-marked again
    expect(() => v.latestFor(KEYS.alice)).toThrow(VenueError);
    expect(() => isSilent(v, ruled)).toThrow(VenueError);
    // (b) the window inside the heir's fetch: a concurrent reader is refused
    // there too, and answered once the fetch has landed.
    const seen: string[] = [];
    const w = venue();
    class Observes extends FakeNode {
      override async boxesByAddress(address: string) {
        if (address === heirsBoxes) {
          try {
            seen.push(String(isSilent(w, ruled)));
          } catch (e) {
            seen.push(e instanceof VenueError ? "refused" : "other");
          }
        }
        return super.boxesByAddress(address);
      }
    }
    await w.sync(fill(new Observes()), [ruled]);
    expect(seen).toEqual(["refused"]);
    expect(isSilent(w, ruled)).toBe(false);
  });

  it("a view being re-gathered refuses even its clock: un-marked as the replacement begins, not only on failure", async () => {
    // Every record read already refuses mid-sync through the per-key guards
    // (covered and fetched are cleared first); the clock had no such guard,
    // so a reader asking only the index got the new height over the old
    // view's absence. Un-marked after the height read — not before it, so a
    // node that cannot answer the height leaves a coherent view answering
    // — the clock refuses from the first record fetch on.
    const v = venue();
    await v.sync(new FakeNode().at(100n).putCommitment(commitment(0n, 0xaa), 95n), [backing]);
    expect(v.witnessedIndex()).toBe(97n);
    const seen: string[] = [];
    class Peeks extends FakeNode {
      private peeked = false;
      override async boxesByAddress(address: string) {
        if (!this.peeked) {
          this.peeked = true;
          try {
            seen.push(String(v.witnessedIndex()));
          } catch (e) {
            seen.push(e instanceof VenueError ? "refused" : "other");
          }
        }
        return super.boxesByAddress(address);
      }
    }
    await v.sync(new Peeks().at(120n).putCommitment(commitment(0n, 0xaa), 95n), [backing]);
    expect(seen).toEqual(["refused"]);
    expect(v.witnessedIndex()).toBe(117n);
  });

  it("a re-gathered view judges its records again: the walk's memo does not survive a sync that replaced them", async () => {
    // The memo is the venue object's, and a re-synced view is the same
    // object over different records at the same count — the one change the
    // memo's positional count cannot see. sync says so (the review's ADV-2).
    const ruled = makeBacking({
      obligor: KEYS.backer2,
      payout: { thing: "USD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: {
        setting: "transparent",
        operator: KEYS.operator,
        silence: { noCommitmentDuration: 1000n, challengeWindow: 5n },
        replacementRule: KEYS.backer2,
        witnessing: { venue: VENUE_ID, interval: 5n },
      },
    });
    const naming = (successor: Uint8Array, successorSecret: Uint8Array) => {
      const unsigned = {
        role: ROLE_OPERATOR,
        successor,
        predecessor: ruled.name,
        effective: 150n,
        signature: new Uint8Array(64),
        successorSignature: new Uint8Array(64),
      };
      const message = replacementMessage(ruled.name, unsigned);
      return {
        ...unsigned,
        signature: ed25519.sign(message, SECRETS.backer2),
        successorSignature: ed25519.sign(message, successorSecret),
      };
    };
    const nodeFor = (r: ReturnType<typeof naming>, secret: Uint8Array) =>
      new FakeNode()
        .at(200n)
        .putCommitment(commitment(0n, 0xaa), 100n)
        .put(ADDRESSING.publications(ruled.name), {
          inclusionHeight: 140n,
          registers: { R4: ruled.name, R5: encodeReplacement(ruled.name, r) },
        })
        .putCommitment(signCommitment(secret, 0n, stateRoot([])), 190n);
    const v = venue();
    await v.sync(nodeFor(naming(KEYS.alice, SECRETS.alice), SECRETS.alice), [ruled]);
    expect(operatorAt(ruled, v, v.witnessedIndex())).toEqual(KEYS.alice);
    await v.sync(nodeFor(naming(KEYS.bob, SECRETS.bob), SECRETS.bob), [ruled]);
    expect(operatorAt(ruled, v, v.witnessedIndex())).toEqual(KEYS.bob);
    expect(isSilent(v, ruled)).toBe(false);
  });

  it("hands out replacement records as copies: a reader that overwrites one does not rewrite succession", async () => {
    // The interface promises copies and LocalVenue keeps it; this view handed
    // out its stored objects, so one reader mutating a field it was given
    // changed who is in force for every later reader in the process (found
    // by the slice-37 panel's inventory angle). The walk's memo retains what
    // the venue hands it, which is what makes this load-bearing now.
    const ruled = makeBacking({
      obligor: KEYS.backer2,
      payout: { thing: "USD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: {
        setting: "transparent",
        operator: KEYS.operator,
        silence: { noCommitmentDuration: 1000n, challengeWindow: 5n },
        replacementRule: KEYS.backer2,
        witnessing: { venue: VENUE_ID, interval: 5n },
      },
    });
    const unsigned = {
      role: ROLE_OPERATOR,
      successor: KEYS.alice,
      predecessor: ruled.name,
      effective: 150n,
      signature: new Uint8Array(64),
      successorSignature: new Uint8Array(64),
    };
    const message = replacementMessage(ruled.name, unsigned);
    const replacement = {
      ...unsigned,
      signature: ed25519.sign(message, SECRETS.backer2),
      successorSignature: ed25519.sign(message, SECRETS.alice),
    };
    const node = new FakeNode()
      .at(200n)
      .putCommitment(commitment(0n, 0xaa), 100n)
      .put(ADDRESSING.publications(ruled.name), {
        inclusionHeight: 140n,
        registers: { R4: ruled.name, R5: encodeReplacement(ruled.name, replacement) },
      });
    const v = venue();
    await v.sync(node, [ruled]);
    const [first] = v.replacementsFor(ruled.name);
    const [second] = v.replacementsFor(ruled.name);
    expect(first!.replacement).not.toBe(second!.replacement);
    expect(operatorAt(ruled, v, v.witnessedIndex())).toEqual(KEYS.alice);
    first!.replacement.successor.fill(0);
    expect(operatorAt(ruled, v, v.witnessedIndex())).toEqual(KEYS.alice);
  });
});

describe("a sequencer on this venue refuses to prepare", () => {
  it("because it could not read the commit a lock would settle on", async () => {
    // §C3: "A sequencer unwilling to watch it refuses to prepare, which is an
    // abort rather than a fork." This view does not sync commits (above), so a
    // lock taken here could be neither settled nor, once the record showed it
    // committed, safely released — the sequencer probes the venue before it
    // reserves anything, and the venue's refusal is the answer.
    // A synced view holding one recent commitment by this operator, so it is
    // inside its declared duration and serving (c2b-return-from-silence); the
    // clock and the record answer, and the commits probe is what refuses (the
    // door readies — adopts — before it probes).
    const v = venue();
    // The operator's own recent commitment keeps its clock; its root is the
    // EMPTY state's, so the fresh process can exhibit it and take its seat —
    // the resume rule seats a registering operator only where the record pins
    // nothing of its own, and these tests' subject is the door behaviour
    // beyond the seat.
    const recent = signCommitment(SECRETS.operator, 0n, stateRoot([]));
    await v.sync(new FakeNode().at(100n).putCommitment(recent, 95n), [backing]);
    const sequencer = new Sequencer(SECRETS.operator, v);
    sequencer.register(backing, signBacking(SECRETS.backer, backing));
    sequencer.takeOver(backing, undefined, { snapshots: [], commitment: recent });
    const lock: LockOp = {
      backing,
      attemptId: new Uint8Array(32).fill(0xe7),
      holder: KEYS.alice,
      beneficiary: KEYS.bob,
      quantity: 1n,
      timeout: 100n,
      decisionVenue: VENUE_ID,
      parties: [KEYS.alice],
      nonce: 0n,
    };
    expect(() => sequencer.submitLock(lock, ed25519.sign(encodeLock(lock), SECRETS.alice))).toThrow(
      /does not sync commits/,
    );
    expect(() => sequencer.submitLock(lock, ed25519.sign(encodeLock(lock), SECRETS.alice))).toThrow(
      VenueError,
    );
  });
});

describe("and a set leg names no venue at all", () => {
  it("a leg naming this venue is refused: legs settle with their set, never on a commit", async () => {
    // Slice 26: a presentation's legs name no decision venue (NO_DECISION_VENUE), so
    // this view's silence on commits never touches them — and a leg that names a
    // venue anyway is refused where the set is filed.
    const gold = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "GOLD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: {
        setting: "transparent",
        operator: KEYS.operator,
        witnessing: { venue: VENUE_ID, interval: 5n },
      },
    });
    const eur = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
      reliance: [{ target: gold.name, count: 2n }],
      evidence: {
        setting: "transparent",
        operator: KEYS.operator,
        witnessing: { venue: VENUE_ID, interval: 5n },
      },
    });
    // A synced, box-less view: the clock and the record answer, and the commits
    // probe is what refuses (the door readies — adopts — before it probes).
    const v = venue();
    await v.sync(new FakeNode().at(100n), [gold, eur]);
    const sequencer = new Sequencer(SECRETS.operator, v);
    sequencer.register(gold, signBacking(SECRETS.backer, gold));
    sequencer.register(eur, signBacking(SECRETS.backer, eur));
    const demand: DemandOp = {
      backing: eur,
      holder: KEYS.alice,
      quantity: 40n,
      instant: 0n,
      deadline: 100n,
      nonce: 0n,
    };
    const leg: LockOp = {
      backing: gold,
      attemptId: demandHash(demand),
      holder: KEYS.alice,
      beneficiary: KEYS.backer,
      quantity: 80n,
      timeout: 90n,
      decisionVenue: VENUE_ID,
      parties: [KEYS.alice],
      nonce: 0n,
    };
    expect(() =>
      sequencer.submitDemand(demand, ed25519.sign(encodeDemand(demand), SECRETS.alice), [
        { op: leg, signature: ed25519.sign(encodeLock(leg), SECRETS.alice) },
      ]),
    ).toThrow(/names no decision venue/);
  });
});

describe("settle answers in the sequencer's own voice where the venue is not needed", () => {
  it("no lock standing is a SequencerError, not a VenueError, on a venue that refuses commits", async () => {
    // Found by the 2026-08-22 audit: settle read the venue's commits to answer a
    // repeat before it knew whether a lock stood, so a commits-refusing view
    // threw where "no lock for that attempt stands here" was the honest answer
    // — and the receipt a repeat needs is the sequencer's own, no venue required.
    const v = venue();
    // One recent commitment by this operator: it is serving, not returning.
    // The operator's own recent commitment keeps its clock; its root is the
    // EMPTY state's, so the fresh process can exhibit it and take its seat —
    // the resume rule seats a registering operator only where the record pins
    // nothing of its own, and these tests' subject is the door behaviour
    // beyond the seat.
    const recent = signCommitment(SECRETS.operator, 0n, stateRoot([]));
    await v.sync(new FakeNode().at(100n).putCommitment(recent, 95n), [backing]);
    const sequencer = new Sequencer(SECRETS.operator, v);
    sequencer.register(backing, signBacking(SECRETS.backer, backing));
    sequencer.takeOver(backing, undefined, { snapshots: [], commitment: recent });
    expect(() => sequencer.settle(backing, new Uint8Array(32).fill(0xd1))).toThrow(SequencerError);
    expect(() => sequencer.settle(backing, new Uint8Array(32).fill(0xd1))).toThrow(/no lock for that attempt/);
  });
});

describe("§C2: the venue's lag, and the floor it puts under a replacement's lead", () => {
  it("is the depth plus one: the clock reads the depth behind the chain, and a transaction is included at the next height", () => {
    // A constant of the id, so it answers before any sync — a reader that
    // walks a chain on an unsynced view is refused by the records, not here.
    expect(venue().lag()).toBe(DEPTH + 1n);
  });

  it("a record witnessed at 140 takes force at 149 and not at 148: the lead is floored at twice the lag plus one", async () => {
    // Slices 38 and 39: the record must reach every party before the last act
    // it can still land in the incumbent's term. On this venue an act signed at
    // clock c lands at c + 4 or later, and the incumbent holds one commitment
    // in flight, so it may wait a lag to be free and then a lag to land: a lead
    // of 8 can leave it no clock at all, and 9 cannot.
    const ruled = makeBacking({
      obligor: KEYS.backer2,
      payout: { thing: "USD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: {
        setting: "transparent",
        operator: KEYS.operator,
        silence: { noCommitmentDuration: 1000n, challengeWindow: 5n },
        replacementRule: KEYS.backer2,
        witnessing: { venue: VENUE_ID, interval: 5n },
      },
    });
    const naming = (effective: bigint) => {
      const unsigned = {
        role: ROLE_OPERATOR,
        successor: KEYS.alice,
        predecessor: ruled.name,
        effective,
        signature: new Uint8Array(64),
        successorSignature: new Uint8Array(64),
      };
      const message = replacementMessage(ruled.name, unsigned);
      return {
        ...unsigned,
        signature: ed25519.sign(message, SECRETS.backer2),
        successorSignature: ed25519.sign(message, SECRETS.alice),
      };
    };
    const nodeFor = (effective: bigint) =>
      new FakeNode()
        .at(200n)
        .putCommitment(commitment(0n, 0xaa), 100n)
        .put(ADDRESSING.publications(ruled.name), {
          inclusionHeight: 140n,
          registers: { R4: ruled.name, R5: encodeReplacement(ruled.name, naming(effective)) },
        });
    const short = venue();
    await short.sync(nodeFor(148n), [ruled]);
    expect(operatorAt(ruled, short, short.witnessedIndex())).toEqual(KEYS.operator);
    const enough = venue();
    await enough.sync(nodeFor(149n), [ruled]);
    expect(operatorAt(ruled, enough, enough.witnessedIndex())).toEqual(KEYS.alice);
  });
});

describe("§C2: a venue's record for one key rises in sequence as it rises in index", () => {
  const ordered = (v: ErgoVenue) => v.latestFor(KEYS.operator)?.sequence;

  it("skips a commitment that does not extend the highest it already holds, so a replay anybody can copy off the chain does not move the record's last", async () => {
    // A chain orders nothing: any decodable box at the address whose signature
    // verifies is a record. An old commitment delayed in the mempool, or a
    // replay of one — bytes already public, no key needed — would otherwise BE
    // the record's last, and the last is what an era resolves against, what a
    // seat pins against, and what the next sequence is taken from. One replay
    // turned a lapsed pair into a fault proof against an honest operator and
    // an honest restart into an equivocation against its own key (slice 39's
    // review, both angles).
    const node = new FakeNode()
      .at(200n)
      .putCommitment(commitment(0n, 0xa0), 10n)
      .putCommitment(commitment(1n, 0xa1), 20n)
      .putCommitment(commitment(2n, 0xa2), 30n)
      .putCommitment(commitment(0n, 0xa0), 40n); // the replay
    const v = venue();
    await v.sync(node, [backing]);
    expect(ordered(v)).toBe(2n);
    expect(v.witnessedAtFor(KEYS.operator)).toBe(30n);
    expect(v.nextSequenceFor(KEYS.operator)).toBe(3n);
  });

  it("skips a second commitment at a sequence it already holds, so one sequence stands at one index", async () => {
    // Strictly extending, not merely non-decreasing: two roots at one sequence
    // is the equivocation invariant 22 forbids, and admitting the second would
    // put one sequence at two indices — which is the shape every era
    // resolution assumes away.
    const node = new FakeNode()
      .at(200n)
      .putCommitment(commitment(0n, 0xc0), 10n)
      .putCommitment(commitment(1n, 0xc1), 20n)
      .putCommitment(commitment(1n, 0xc9), 30n); // the same sequence, another root
    const v = venue();
    await v.sync(node, [backing]);
    expect(ordered(v)).toBe(1n);
    expect(v.witnessedAtFor(KEYS.operator)).toBe(20n);
  });

  it("reads two commitments of one key in one block the same way whatever order the node hands them back", async () => {
    // Otherwise the record is a fact about which node you asked: two honest
    // readers resolve one era two ways, permanently (the fix panel's security
    // angle). Sorted by index and then by sequence before the filter, and each
    // kept sequence remains exactly readable even though both share an index.
    const forward = new FakeNode().at(200n).putCommitment(commitment(0n, 0xb0), 10n);
    const backward = new FakeNode().at(200n).putCommitment(commitment(0n, 0xb0), 10n);
    forward.putCommitment(commitment(1n, 0xb1), 20n).putCommitment(commitment(2n, 0xb2), 20n);
    backward.putCommitment(commitment(2n, 0xb2), 20n).putCommitment(commitment(1n, 0xb1), 20n);
    const a = venue();
    const b = venue();
    await a.sync(forward, [backing]);
    await b.sync(backward, [backing]);
    expect(ordered(a)).toBe(2n);
    expect(ordered(b)).toBe(2n);
    expect(a.witnessedAtFor(KEYS.operator)).toBe(b.witnessedAtFor(KEYS.operator));
    for (const v of [a, b]) {
      expect(v.witnessedAtSequence(KEYS.operator, 0n)).toBe(10n);
      expect(v.witnessedAtSequence(KEYS.operator, 1n)).toBe(20n);
      expect(v.witnessedAtSequence(KEYS.operator, 2n)).toBe(20n);
    }
    for (const era of [1n, 2n, 3n, 4n]) {
      expect(eraIndex(b, KEYS.operator, era)).toEqual(eraIndex(a, KEYS.operator, era));
    }
    // The lower same-index commitment was witnessed, so its era is final at
    // that index; only a sequence the record did not keep may read `died`.
    expect(eraIndex(a, KEYS.operator, 2n)).toBe(20n);
  });
});
