import { ed25519 } from "@noble/curves/ed25519.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeBacking, type Backing } from "../src/backing.js";
import { encodeCommitment, signCommitment, type Commitment } from "../src/commitment.js";
import { DEFAULT_ERGO_DEPTH, ergoAnchorContext, ergoProfile, ErgoVenue, type ErgoReaderPolicy } from "../src/ergo.js";
import { decodeCompactBits, INITIAL_DIFFICULTY, parseErgoHeader } from "../src/ergo-headers.js";
import { ERGO_TESTNET_REFERENCE, ergoProfileIdentity, type ErgoTransactionView } from "../src/ergo-profile.js";
import {
  admittedReplacements, decodeRangeAnswer, heldCommitments, RangeLimitError, revocationIndex,
  type HeldCommitment, type RangeAnswer, type RangeRequest, type RecordKind,
} from "../src/record-range.js";
import { encodeReplacement, replacementMessage, ROLE_OPERATOR, type Replacement } from "../src/replacement.js";
import { encodeRevocation, signRevocation } from "../src/revocation.js";
import { referenceVenue, requireReferenceVenue } from "../src/pool/v3/guard.js";
import { VenueError } from "../src/venue-error.js";
import {
  ANCHOR_HEIGHT, BranchSupplier, Chain, hex, plainOutput, rawOutput, recordOutput, SCRIPTS, transaction, type Block, type Output,
} from "./ergo-chain.js";
import { KEYS, SECRETS } from "./support.js";

// Ergo read as a witness venue under the selected profile (venue-ergo.md),
// over a synthetic chain whose headers the reader verifies under the real
// mainnet rules (at difficulty 1) from a synthetic anchor. Index `i` is the
// block `i + 1` above the anchor, so a branch of `n` blocks with depth 3
// witnesses indices 0 to `n - 4`.
//
// The properties carried over from the node-index view it replaces: the
// witnessed index is the block that included the transaction, never a box's
// creation height; nothing inside the depth is read; a record rests on its
// signature, not its location; a key's record rises in sequence as it rises
// in index; reads see only a complete snapshot. And the ones this view adds:
// no supplier is trusted, a missing section stops the clock rather than
// reading as silence, the heaviest chain is followed within the depth and a
// reorganization past it fails the venue.
//
// The view answers pool-v3 §13's ranges and judges nothing; the tests read it
// as a v3 reader does, deriving held commitments, revocations and admitted
// replacements from its answers with `record-range.ts`.

const chain = new Chain();
const DEPTH = 3n;
const PROFILE = chain.profile(DEPTH);
const VENUE_ID = ergoProfileIdentity(PROFILE);
const venue = (policy?: Partial<ErgoReaderPolicy>): ErgoVenue => new ErgoVenue(PROFILE, chain.context, policy);
type Records = Readonly<Record<number, readonly (readonly Output[])[]>>;
/** `count` blocks from `parent` (index 0 on the anchor); `at[i]` are the transactions of the i-th block's outputs. */
const branch = (count: number, at: Records = {}, parent: Block = chain.anchor, salt = 0): Block[] =>
  chain.extend(parent, count, i => (at[i] ?? []).map(outputs => transaction(outputs)), salt);
const serving = (blocks: readonly Block[], name = "node"): BranchSupplier => new BranchSupplier(name, blocks.at(-1)!, chain);
async function synced(count: number, at: Records = {}, policy?: Partial<ErgoReaderPolicy>): Promise<{ v: ErgoVenue; blocks: Block[] }> {
  const v = venue(policy), blocks = branch(count, at);
  await v.sync([serving(blocks)]);
  return { v, blocks };
}

const WIDE = { maxBytes: 1n << 30n, maxEntries: 1n << 20n };
/** The view's §13 answer for one subject over [0, toIndex], the clock by default. */
function answer(v: ErgoVenue, kind: RecordKind, subject: Uint8Array, toIndex = v.witnessedIndex()): RangeAnswer {
  const request: RangeRequest = { venue: VENUE_ID, kind, subject, fromIndex: 0n, toIndex };
  return decodeRangeAnswer(v.range(request, WIDE)!, request, WIDE);
}
/** A key's held commitments through `asOf` (the clock by default), as a v3 reader derives them (C2.3.3). */
const held = (v: ErgoVenue, key: Uint8Array, asOf?: bigint): readonly HeldCommitment[] => heldCommitments(answer(v, 1, key, asOf)).held;
const sequences = (v: ErgoVenue, key: Uint8Array, asOf?: bigint): [bigint, bigint][] =>
  held(v, key, asOf).map(h => [h.index, h.commitment.sequence]);

const commitment = (sequence: bigint, fill: number, secret = SECRETS.operator): Commitment =>
  signCommitment(secret, sequence, new Uint8Array(32).fill(fill));
const committed = (c: Commitment, subject = c.operator): Output => recordOutput(1, subject, encodeCommitment(c));
function replacement(backing: Backing, successor: Uint8Array, successorSecret: Uint8Array, ruleSecret: Uint8Array, effective: bigint): Replacement {
  const unsigned = { role: ROLE_OPERATOR, successor, predecessor: backing.name, effective,
    signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
  const message = replacementMessage(backing.name, unsigned);
  return { ...unsigned, signature: ed25519.sign(message, ruleSecret), successorSignature: ed25519.sign(message, successorSecret) };
}
const replaced = (backing: Backing, r: Replacement): Output => recordOutput(2, backing.name, encodeReplacement(backing.name, r));
const revoked = (secret: Uint8Array, key: Uint8Array): Output => recordOutput(3, key, encodeRevocation(signRevocation(secret)));

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

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("a venue's identity is the profile's", () => {
  it("commits to the anchor, the depth and the locations, and the view derives it", () => {
    expect(venue().id).toEqual(VENUE_ID);
    expect(ergoProfileIdentity(chain.profile(4n))).not.toEqual(VENUE_ID);
    expect(ergoProfileIdentity({ ...PROFILE, scripts: { ...SCRIPTS, 4: SCRIPTS[1], 1: SCRIPTS[4] } })).not.toEqual(VENUE_ID);
    expect(new ErgoVenue(chain.profile(0n), chain.context).id).not.toEqual(VENUE_ID);
    // The synthetic chain is a reference venue: the same profile under venue-ergo's context is another venue.
    const { reference, ...mainnetContext } = PROFILE;
    expect(reference).toBe("moe/venue/ergo-synthetic/reference");
    expect(new ErgoVenue(mainnetContext, chain.context).id).not.toEqual(VENUE_ID);
    // It reads only a chain of minimal work: over an anchor of any other difficulty (mainnet's began near 1.2e12) it refuses,
    // while venue-ergo's context takes the same anchor.
    for (const bits of [0x0102_0000, 0x0601_1765]) {
      const other = chain.reanchored(bits);
      expect(() => new ErgoVenue({ ...PROFILE, anchor: other.anchorId }, other.context)).toThrow(
        new VenueError("the synthetic reference context reads only a chain whose anchor has difficulty 1"));
      expect(new ErgoVenue({ ...mainnetContext, anchor: other.anchorId }, other.context).id).toHaveLength(32);
    }
    expect(Buffer.from(chain.reanchored(0x0101_0000).anchorId)).toEqual(Buffer.from(chain.anchor.id));
    expect(ergoProfile(PROFILE.anchor, SCRIPTS).depth).toBe(DEFAULT_ERGO_DEPTH);
    expect(DEFAULT_ERGO_DEPTH).toBe(10n);
  });

  it("reads the testnet reference context only above an anchor below mainnet's initial difficulty", () => {
    // The anchor's difficulty is the one varied input: each profile passes the guard and each context authenticates
    // its anchor at testnet height. Mid-epoch the testnet rules require the parent's difficulty, so without the bound
    // a mainnet anchor's chain would be followed, with its real work, up to the next epoch boundary.
    const nBits = (file: string): number[] => (JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8")) as
      { headers: { bytes: string }[] }).headers.map(entry => parseErgoHeader(Uint8Array.from(Buffer.from(entry.bytes, "hex")))!.nBits);
    const testnet = (bits: number) => {
      const other = chain.reanchored(bits), profile = { ...PROFILE, reference: ERGO_TESTNET_REFERENCE, anchor: other.anchorId } as const;
      return { reference: { context: ERGO_TESTNET_REFERENCE, profile } as const, read: () => new ErgoVenue(profile, other.context) };
    };
    const refusal = new VenueError("the testnet reference context reads only a chain whose anchor is below mainnet's initial difficulty");
    // Every real mainnet header in the fixtures, from genesis (at that difficulty) to height 1,873,409, is refused.
    const mainnet = [...nBits("ergo-mainnet-v1-headers.json"), ...nBits("ergo-mainnet-recalculation.json")];
    expect(mainnet.length).toBeGreaterThan(0);
    for (const bits of [...mainnet, 0x0601_1765]) {
      const { reference, read } = testnet(bits);
      expect(referenceVenue(reference).lag).toBe(PROFILE.depth + 1n);
      expect(read).toThrow(refusal);
    }
    // Every real testnet header in the fixtures, and the difficulty just below the bound, is read and passes the guard.
    expect(decodeCompactBits(0x0601_1765)).toBe(INITIAL_DIFFICULTY);
    for (const bits of [...nBits("ergo-testnet-recalculation.json"), 0x0601_1764]) {
      const { reference, read } = testnet(bits), view = read();
      expect(requireReferenceVenue(reference, view)).toEqual(view.id);
    }
  });

  it("refuses an anchor context that does not end at the profile's anchor", () => {
    const unauthenticated = new VenueError("the anchor context does not authenticate the profile's anchor");
    expect(() => new ErgoVenue(PROFILE, chain.context.slice(0, -1))).toThrow(unauthenticated);
    expect(() => new ErgoVenue({ ...PROFILE, anchor: new Uint8Array(32).fill(1) }, chain.context)).toThrow(unauthenticated);
  });

  it("takes the anchor context from any supplier, authenticated by linkage alone", async () => {
    const context = await ergoAnchorContext(serving(branch(1)), PROFILE.anchor, ANCHOR_HEIGHT);
    expect(context.map(hex)).toEqual(chain.context.map(hex));
    const unsupplied = new VenueError("the supplier did not supply the anchor's context");
    await expect(ergoAnchorContext(serving(branch(1)), new Uint8Array(32).fill(2), ANCHOR_HEIGHT)).rejects.toThrow(unsupplied);
    // A supplier that fails, or answers what is not a list of headers, supplied nothing.
    const failing = serving(branch(1)), nonsense = serving(branch(1));
    failing.headers = async () => { throw new Error("offline"); };
    nonsense.headers = async () => 7 as never;
    for (const supplier of [failing, nonsense]) await expect(ergoAnchorContext(supplier, PROFILE.anchor, ANCHOR_HEIGHT)).rejects.toThrow(unsupplied);
    for (const timeout of [0, 1.5, 2 ** 31]) {
      await expect(ergoAnchorContext(serving(branch(1)), PROFILE.anchor, ANCHOR_HEIGHT, timeout)).rejects.toThrow(new TypeError("invalid anchor context timeout"));
    }
  });

  it("the lag is the depth plus one, answered unsynced", () => {
    expect(venue().lag()).toBe(DEPTH + 1n);
  });

  it("the clock is nothing an unsynced view can answer, nor one whose chain has not reached the depth", async () => {
    const v = venue();
    expect(() => v.witnessedIndex()).toThrow(new VenueError("this view has no settled snapshot"));
    const short = branch(3);
    const report = await v.sync([serving(short)]);
    expect(report.witnessedIndex).toBeUndefined();
    expect(() => v.witnessedIndex()).toThrow(new VenueError("this view has no settled snapshot"));
    await v.sync([serving([...short, ...branch(1, {}, short.at(-1)!)])]);
    expect(v.witnessedIndex()).toBe(0n);
  });
});

describe("the witnessed index is the block that included the transaction", () => {
  it("reads a commitment at its block's index, whatever creation height its box claims", async () => {
    const early = commitment(1n, 0xaa);
    const v = venue(), blocks = chain.extend(chain.anchor, 12, i => i === 7 ? [transaction([committed(early)], 0n)] : []);
    await v.sync([serving(blocks)]);
    expect(held(v, KEYS.operator)).toEqual([{ index: 7n, commitment: early }]);
  });

  it("reads nothing inside the finality depth", async () => {
    const blocks = branch(12, { 9: [[committed(commitment(1n, 0xaa))]] });
    const v = venue();
    await v.sync([serving(blocks)]);
    expect(v.witnessedIndex()).toBe(8n);
    expect(held(v, KEYS.operator)).toEqual([]);
    const more = [...blocks, ...branch(1, {}, blocks.at(-1)!)];
    await v.sync([serving(more)]);
    expect(v.witnessedIndex()).toBe(9n);
    expect(sequences(v, KEYS.operator)).toEqual([[9n, 1n]]);
  });

  it("answers about the past: a range ending before the clock holds what was held then", async () => {
    const { v } = await synced(16, { 2: [[committed(commitment(1n, 0xaa))]], 9: [[committed(commitment(2n, 0xbb))]] });
    expect(sequences(v, KEYS.operator)).toEqual([[2n, 1n], [9n, 2n]]);
    expect(sequences(v, KEYS.operator, 8n)).toEqual([[2n, 1n]]);
    expect(sequences(v, KEYS.operator, 1n)).toEqual([]);
  });
});

describe("nothing rests on the location alone", () => {
  it("carries a commitment filed under this key that another key signed, one that does not verify, and noise; none is held", async () => {
    const stranger = commitment(1n, 0xcc, SECRETS.mallory);
    const torn = { ...commitment(2n, 0xaa), signature: new Uint8Array(64) };
    const { v } = await synced(12, {
      1: [[committed(stranger, KEYS.operator)], [committed(torn)]],
      2: [[rawOutput(SCRIPTS[1], [Uint8Array.of(0x0e, 3, 1, 2, 3), Uint8Array.of(0x0e, 1, 0)])],
        [recordOutput(1, KEYS.operator, new Uint8Array(135))], [plainOutput]],
      3: [[committed(commitment(3n, 0xa2))]],
    });
    // The view judges nothing: both well-sized records at index 1 are answered, and the reader skips them.
    expect(answer(v, 1, KEYS.operator).entries.map(e => e.index)).toEqual([1n, 1n, 3n]);
    expect(sequences(v, KEYS.operator)).toEqual([[3n, 3n]]);
    // Absence is proven for every key by exhaustion: no key needs to be named before the sync.
    expect(answer(v, 1, KEYS.alice).entries).toEqual([]);
  });

  it("carries every revocation and replacement filed under a subject; the reader counts only those that name it and verify", async () => {
    const r = replacement(ruled, KEYS.alice, SECRETS.alice, SECRETS.backer2, 30n);
    const { v } = await synced(12, {
      1: [[revoked(SECRETS.mallory, KEYS.backer)], [revoked(SECRETS.backer, KEYS.backer)]],
      2: [[replaced(ruled, r)], [recordOutput(2, backing.name, encodeReplacement(ruled.name, r))], [recordOutput(2, ruled.name, new Uint8Array(233))]],
    });
    expect(answer(v, 3, KEYS.backer).entries).toHaveLength(2);
    expect(revocationIndex(answer(v, 3, KEYS.backer))).toBe(1n);
    expect(revocationIndex(answer(v, 3, KEYS.mallory))).toBeUndefined();
    expect(answer(v, 2, ruled.name).entries).toHaveLength(2);
    expect(admittedReplacements(answer(v, 2, ruled.name), KEYS.backer2).map(a => [a.index, a.replacement])).toEqual([[2n, r]]);
    expect(answer(v, 2, backing.name).entries).toHaveLength(1);
    expect(admittedReplacements(answer(v, 2, backing.name), KEYS.backer2)).toEqual([]);
  });

  it("hands out copies: a reader that overwrites an answer changes nothing", async () => {
    const original = commitment(1n, 0xaa);
    const { v } = await synced(12, { 2: [[committed(original), revoked(SECRETS.backer, KEYS.backer)]] });
    const request: RangeRequest = { venue: VENUE_ID, kind: 1, subject: KEYS.operator, fromIndex: 0n, toIndex: v.witnessedIndex() };
    const bytes = v.range(request, WIDE)!, first = Uint8Array.from(bytes);
    bytes.fill(0);
    const decoded = answer(v, 1, KEYS.operator);
    decoded.entries[0]!.record.fill(0);
    expect(v.range(request, WIDE)).toEqual(first);
    expect(held(v, KEYS.operator)).toEqual([{ index: 2n, commitment: original }]);
  });
});

describe("§C2.3.3: a key's record rises in sequence as it rises in index (pool-v3 §13.3)", () => {
  it("skips a replay of an earlier commitment, so bytes anybody can copy off the chain do not move the record's last", async () => {
    const one = commitment(1n, 0xa0);
    const { v } = await synced(14, {
      1: [[committed(one)]], 2: [[committed(commitment(2n, 0xa1))]], 3: [[committed(commitment(3n, 0xa2))]], 4: [[committed(one)]],
    });
    expect(sequences(v, KEYS.operator)).toEqual([[1n, 1n], [2n, 2n], [3n, 3n]]);
  });

  it("holds one sequence once: a later root at a held sequence is skipped, two at one index keep the lesser bytes", async () => {
    const a = commitment(2n, 0xc1), b = commitment(2n, 0xc9);
    const lesser = Buffer.compare(encodeCommitment(a), encodeCommitment(b)) < 0 ? a : b;
    const { v } = await synced(14, { 1: [[committed(commitment(1n, 0xc0))]], 2: [[committed(b)], [committed(a)]], 3: [[committed(commitment(2n, 0xcc))]] });
    expect(held(v, KEYS.operator).at(-1)).toEqual({ index: 2n, commitment: lesser });
    expect(held(v, KEYS.operator)).toHaveLength(2);
  });

  it("reads two commitments of one key in one block the same way whatever their order in it", async () => {
    const two = commitment(2n, 0xb1), three = commitment(3n, 0xb2);
    const forward = await synced(12, { 1: [[committed(commitment(1n, 0xb0))]], 2: [[committed(two)], [committed(three)]] });
    const backward = await synced(12, { 1: [[committed(commitment(1n, 0xb0))]], 2: [[committed(three), committed(two)]] });
    for (const { v } of [forward, backward]) {
      expect(sequences(v, KEYS.operator)).toEqual([[1n, 1n], [2n, 2n], [2n, 3n]]);
      expect(held(v, KEYS.operator)[1]!.commitment).toEqual(two);
    }
  });
});

describe("readers see only a complete Ergo snapshot", () => {
  const r = replacement(backing, KEYS.bob, SECRETS.bob, SECRETS.backer, 21n);
  const first = commitment(1n, 1), second = commitment(2n, 2);
  // Twelve blocks witness 0..8; twenty-six witness 0..22, adding the replacement witnessed at 12,
  // the second commitment and a revocation, both at 15.
  const old = branch(12, { 2: [[committed(first)]] });
  const grown = [...old, ...branch(14, { 0: [[replaced(backing, r)]], 3: [[committed(second), revoked(SECRETS.backer, KEYS.backer)]] }, old.at(-1)!)];
  const replacements = (v: ErgoVenue) => admittedReplacements(answer(v, 2, backing.name), KEYS.backer).length;
  const revokedAt = (v: ErgoVenue) => revocationIndex(answer(v, 3, KEYS.backer));
  for (const initial of [true, false]) {
    for (const fail of [true, false]) {
      it.each(["headers", "section"] as const)(`${initial ? "first sync" : "refresh"} ${fail ? "failure" : "success"} at %s exposes no partial records`, async phase => {
        const v = venue(), entered = signal(), resume = signal();
        if (!initial) await v.sync([serving(old)]);
        const supplier = serving(grown);
        let paused = false;
        supplier.before = async call => {
          if (call !== phase || paused) return;
          paused = true; entered.resolve(); await resume.promise;
          if (fail) throw new Error("offline");
        };
        const pending = v.sync([supplier]);
        await entered.promise;
        const request: RangeRequest = { venue: VENUE_ID, kind: 1, subject: KEYS.operator, fromIndex: 0n, toIndex: 0n };
        const reads = [() => v.witnessedIndex(), () => v.range(request, WIDE)];
        try {
          // Mid-sync, reads answer from the previous snapshot, or refuse where there is none.
          if (initial) for (const read of reads) expect(read).toThrow(new VenueError("this view has no settled snapshot"));
          else {
            expect(v.witnessedIndex()).toBe(8n);
            expect(held(v, KEYS.operator)).toEqual([{ index: 2n, commitment: first }]);
            expect(replacements(v)).toBe(0);
            expect(v.range({ ...request, toIndex: 9n }, WIDE)).toBeUndefined();
          }
          expect(v.id).toEqual(VENUE_ID); expect(v.lag()).toBe(4n);
        } finally { resume.resolve(); }
        const report = await pending;
        expect(report.suppliers[0]!.stopped !== undefined || report.unresolvedIndex !== undefined).toBe(fail);
        if (fail && initial) {
          for (const read of reads) expect(read).toThrow(new VenueError("this view has no settled snapshot"));
        } else {
          expect(v.witnessedIndex()).toBe(fail ? 8n : 22n);
          expect(sequences(v, KEYS.operator)).toEqual(fail ? [[2n, 1n]] : [[2n, 1n], [15n, 2n]]);
          expect(replacements(v)).toBe(fail ? 0 : 1);
          expect(revokedAt(v)).toBe(fail ? undefined : 15n);
        }
        if (fail) {
          await v.sync([serving(grown)]);
          expect(v.witnessedIndex()).toBe(22n);
          expect(replacements(v)).toBe(1);
        }
      });
    }
  }

  it("refuses a concurrent sync without disturbing the one running", async () => {
    const v = venue(), supplier = serving(old), entered = signal(), resume = signal();
    supplier.before = async call => { if (call === "tip") { entered.resolve(); await resume.promise; } };
    const pending = v.sync([supplier]);
    await entered.promise;
    await expect(v.sync([serving(old)])).rejects.toThrow(new VenueError("a sync is already in progress"));
    resume.resolve();
    await pending;
    expect(v.witnessedIndex()).toBe(8n);
  });
});

describe("no supplier is trusted", () => {
  it("a supplier serving a header without its difficulty is stopped there, and another supplier's chain is read", async () => {
    const honest = branch(12, { 2: [[committed(commitment(1n, 0xaa))]] });
    const forged = serving(honest, "forger");
    // The forger doubles one header's difficulty (nBits' mantissa): the store refuses it and every header after it.
    const original = forged.headers.bind(forged);
    forged.headers = async (from, to) => (await original(from, to)).map((bytes, i) => {
      if (from + BigInt(i) !== ANCHOR_HEIGHT + 5n) return bytes;
      const copy = new Uint8Array(bytes); copy[copy.length - 51] = 2; return copy;
    });
    const v = venue();
    const report = await v.sync([forged, serving(honest, "honest")]);
    expect(report.suppliers.map(s => [s.name, s.headersAdded, s.stopped])).toEqual([
      ["forger", 4, "refused header: difficulty"], ["honest", 8, undefined]]);
    expect(v.witnessedIndex()).toBe(8n);
    expect(held(v, KEYS.operator).at(-1)?.index).toBe(2n);
  });

  it("a withheld section stops the clock before it; another supplier's section, or a later sync, resumes it", async () => {
    const blocks = branch(12, { 6: [[committed(commitment(1n, 0xaa))]] });
    const withholding = serving(blocks, "withholding");
    withholding.withheld.add(hex(blocks[4]!.id));
    const v = venue();
    const report = await v.sync([withholding]);
    expect(report.unresolvedIndex).toBe(4n);
    expect(v.witnessedIndex()).toBe(3n);
    // Stale, never empty: the record before the missing section stands, and the clock does not pass it.
    expect(held(v, KEYS.operator)).toEqual([]);
    await v.sync([withholding, serving(blocks, "other")]);
    expect(v.witnessedIndex()).toBe(8n);
    expect(held(v, KEYS.operator).at(-1)?.index).toBe(6n);
  });

  it("a section that does not reproduce its header's root is passed over", async () => {
    const blocks = branch(12, { 3: [[committed(commitment(1n, 0xaa))]] });
    const lying = serving(blocks, "lying");
    lying.substituted.set(hex(blocks[3]!.id), [transaction([plainOutput])]);
    const v = venue();
    expect((await v.sync([lying])).unresolvedIndex).toBe(3n);
    expect(v.witnessedIndex()).toBe(2n);
    await v.sync([lying, serving(blocks, "honest")]);
    expect(held(v, KEYS.operator).at(-1)?.index).toBe(3n);
  });

  it("follows the heaviest chain inside the depth, reading only its blocks", async () => {
    const trunk = branch(8);
    const light = [...trunk, ...branch(3, { 0: [[committed(commitment(1n, 0xaa))]] }, trunk.at(-1)!, 1)];
    const heavy = [...trunk, ...branch(5, { 0: [[committed(commitment(1n, 0xbb))]] }, trunk.at(-1)!, 2)];
    const v = venue();
    await v.sync([serving(light, "light")]);
    expect(v.witnessedIndex()).toBe(7n);
    await v.sync([serving(light, "light"), serving(heavy, "heavy")]);
    expect(v.witnessedIndex()).toBe(9n);
    expect(held(v, KEYS.operator).at(-1)?.commitment?.root).toEqual(new Uint8Array(32).fill(0xbb));
  });

  it("a reorganization past the depth fails the venue: every read and every later sync refuses", async () => {
    const trunk = branch(4);
    const first = [...trunk, ...branch(8, { 1: [[committed(commitment(1n, 0xaa))]] }, trunk.at(-1)!, 1)];
    const deeper = [...trunk, ...branch(12, {}, trunk.at(-1)!, 2)];
    const v = venue();
    await v.sync([serving(first)]);
    expect(held(v, KEYS.operator).at(-1)?.index).toBe(5n);
    await expect(v.sync([serving(deeper, "heavier fork")])).rejects.toThrow(/venue failure/);
    expect(() => v.witnessedIndex()).toThrow(/venue failure/);
    expect(() => v.range({ venue: VENUE_ID, kind: 1, subject: KEYS.operator, fromIndex: 0n, toIndex: 0n }, WIDE)).toThrow(/venue failure/);
    await expect(v.sync([serving(first)])).rejects.toThrow(/venue failure/);
  });

  it("a supplier's budget bounds the work it can cost and never refuses the heaviest chain", async () => {
    const policy = { headersPerSupplier: 5, sectionBytesPerSync: 1 << 20, retainedBytes: 1 << 20 };
    const blocks = branch(14, { 9: [[committed(commitment(1n, 0xaa))]] });
    // A side branch from the anchor that ends lighter: its supplier spends its own budget, not the honest one's.
    const side = branch(9, {}, chain.anchor, 3);
    const v = venue(policy);
    let report = await v.sync([serving(side, "side"), serving(blocks, "honest")]);
    expect(report.suppliers.map(s => [s.headersAdded, s.stopped])).toEqual([[5, "header budget"], [5, "header budget"]]);
    for (let i = 0; i < 3 && report.witnessedIndex !== 10n; i++) report = await v.sync([serving(side, "side"), serving(blocks, "honest")]);
    expect(v.witnessedIndex()).toBe(10n);
    expect(held(v, KEYS.operator).at(-1)?.index).toBe(9n);
  });

  // Serving the known headers from the anchor's child (below the clock) or from the clock's own height (above it).
  it.each([1n, 9n])("a supplier that walks the reader back with forged parents to height %s past the anchor, serves known headers, then fails, cannot hold the clock back", async knownFrom => {
    const blocks = branch(20, { 14: [[committed(commitment(1n, 0xaa))]] });
    const policy = { headersPerRequest: 4 };
    const v = venue(policy);
    await v.sync([serving(blocks.slice(0, 12))]);
    expect(v.witnessedIndex()).toBe(8n);
    // Listed first, claiming a far tip: a parseable header with an unknown parent at every `from` above the
    // anchor's child (no work checked), then a full batch of headers the reader holds, then a failure. Costs nothing.
    const stalling = serving(blocks, "stalling"), original = stalling.headers.bind(stalling);
    let servedKnown = false;
    stalling.tipHeight = async () => ANCHOR_HEIGHT + 1_000_000n;
    stalling.headers = async (from, to) => {
      if (from > ANCHOR_HEIGHT + knownFrom) {
        const orphan: Block = { id: new Uint8Array(32).fill(0x5a), height: from - 1n, bytes: new Uint8Array(0), parent: undefined, section: [] };
        return [chain.mine(orphan).bytes];
      }
      if (servedKnown) throw new Error("gone");
      servedKnown = true;
      return original(from, to);
    };
    const report = await v.sync([stalling, serving(blocks, "honest")]);
    expect(servedKnown).toBe(true);
    expect(report.suppliers.map(s => [s.headersAdded, s.stopped])).toEqual([[0, "failed: gone"], [8, undefined]]);
    expect(v.witnessedIndex()).toBe(16n);
    expect(held(v, KEYS.operator).at(-1)?.index).toBe(14n);
  });

  it("a supplier whose budget stops it on a heavier fork above the clock holds the clock at the fork until the fork arrives", async () => {
    const trunk = branch(10);
    const light = [...trunk, ...branch(8, { 0: [[committed(commitment(1n, 0xaa))]] }, trunk.at(-1)!, 1)];
    const heavy = [...trunk, ...branch(12, { 0: [[committed(commitment(1n, 0xbb))]] }, trunk.at(-1)!, 2)];
    const v = venue({ headersPerSupplier: 6 });
    await v.sync([serving(trunk)]);
    // The trunk's supplier was stopped by its budget at six blocks, which held the clock at its last header's
    // final index; the rest arrives in the next sync.
    expect(v.witnessedIndex()).toBe(2n);
    await v.sync([serving(trunk)]);
    expect(v.witnessedIndex()).toBe(6n);
    // Both stop on their budget at six blocks past the trunk; the light branch was accepted first, so it leads,
    // and without the bound the clock would pass the trunk on it.
    const first = await v.sync([serving(light, "light"), serving(heavy, "heavy")]);
    expect(first.chainWitnessedIndex).toBe(12n);
    expect(v.witnessedIndex()).toBe(9n);
    await v.sync([serving(light, "light"), serving(heavy, "heavy")]);
    expect(v.witnessedIndex()).toBe(18n);
    expect(held(v, KEYS.operator).at(-1)?.commitment?.root).toEqual(new Uint8Array(32).fill(0xbb));
  });

  it("a supplier whose chain keeps ending off the best chain spends its side-branch quota and then withholds", async () => {
    const policy = { headersPerSupplier: 5, sideHeadersPerSupplier: 10 };
    const honest = branch(14, { 9: [[committed(commitment(1n, 0xaa))]] });
    // A branch from the anchor, longer than the honest chain, that the supplier serves a budget at a time.
    const side = branch(40, {}, chain.anchor, 3);
    const v = venue(policy);
    const suppliers = () => [serving(honest, "honest"), sideSupplier];
    const sideSupplier = serving(side, "side");
    expect((await v.sync(suppliers())).witnessedIndex).toBeUndefined();
    const second = await v.sync(suppliers());
    expect(second.suppliers.map(s => [s.headersAdded, s.stopped])).toEqual([[5, "header budget"], [5, "header budget"]]);
    expect(v.witnessedIndex()).toBe(6n);
    const third = await v.sync(suppliers());
    expect(third.suppliers[1]!.stopped).toBe("side-branch quota");
    expect(v.witnessedIndex()).toBe(10n);
    expect(held(v, KEYS.operator).at(-1)?.index).toBe(9n);
  });

  it("a branch that briefly leads with two mined blocks each sync charges an honest supplier only its headers past the fork", async () => {
    const honest = branch(60), policy = { headersPerSupplier: 10, sideHeadersPerSupplier: 30 };
    const v = venue(policy), h = serving(honest, "honest"), m = serving(honest.slice(0, 1), "miner");
    for (let k = 1; k <= 5; k++) {
      // After the honest supplier's k-th budget, its last header is at height 10k; the miner forks at its parent
      // (height 10k - 1) and mines two blocks, so its branch leads and the honest last header is off the best chain.
      m.tip = chain.extend(honest[10 * k - 2]!, 2, () => [], 100 + k).at(-1)!;
      const report = await v.sync([h, m]);
      expect(report.suppliers[0]!.stopped).toBe("header budget");
    }
    let report = await v.sync([h]);
    for (let i = 0; i < 3 && report.suppliers[0]!.stopped !== undefined; i++) report = await v.sync([h]);
    expect(report.suppliers[0]!.stopped).toBeUndefined();
    expect(v.witnessedIndex()).toBe(56n);
  });

  it("a lighter branch revealed below the budget each sync still spends its supplier's side-branch quota", async () => {
    const honest = branch(40), side = branch(30, {}, honest[4]!, 7);
    const v = venue({ headersPerSupplier: 10, sideHeadersPerSupplier: 30 });
    await v.sync([serving(honest, "honest")]);
    const s = serving(side.slice(0, 9), "side");
    const stopped: (string | undefined)[] = [];
    for (let k = 1; k <= 5; k++) {
      s.tip = side[Math.min(9 * k, 30) - 1]!;
      stopped.push((await v.sync([serving(honest, "honest"), s])).suppliers[1]!.stopped);
    }
    expect(stopped).toEqual([undefined, undefined, undefined, undefined, "side-branch quota"]);
    expect(v.witnessedIndex()).toBe(36n);
  });

  it("a section over the sync's byte budget waits for the next sync, and a retained-bytes budget stops the clock", async () => {
    const blocks = branch(10, { 2: [[committed(commitment(1n, 0xaa))]] });
    const v = venue({ headersPerSupplier: 100, sectionBytesPerSync: 150, retainedBytes: 1 << 20 });
    const report = await v.sync([serving(blocks)]);
    expect(report.witnessedIndex).toBeLessThan(6n);
    for (let i = 0; i < 10 && v.witnessedIndex() < 6n; i++) await v.sync([serving(blocks)]);
    expect(v.witnessedIndex()).toBe(6n);
    const full = venue({ headersPerSupplier: 100, sectionBytesPerSync: 1 << 20, retainedBytes: 100 });
    const stopped = await full.sync([serving(blocks)]);
    expect([stopped.unresolvedIndex, stopped.unresolvedReason]).toEqual([2n, "retained budget"]);
    expect(full.witnessedIndex()).toBe(1n);
  });

  it("reads a section answer by its own length, never its iterator", async () => {
    const blocks = branch(6), junk = serving(blocks, "junk");
    let yielded = 0;
    // An empty list whose iterator yields ten thousand transactions: none is read, and the section is not this one.
    junk.section = async () => Object.assign([], { *[Symbol.iterator]() { for (; yielded < 10_000; yielded++) yield transaction([plainOutput]); } });
    const v = venue();
    await v.sync([junk, serving(blocks, "honest")]);
    expect(yielded).toBe(0);
    expect(v.witnessedIndex()).toBe(2n);
  });

  it("asks first the supplier that supplied the last section, so one serving junk costs nothing while it supplies", async () => {
    const blocks = branch(8), junk = serving(blocks, "junk"), honest = serving(blocks, "honest");
    let asked = 0;
    junk.section = async () => { asked++; return [transaction([plainOutput])]; };
    const v = venue();
    await v.sync([junk, honest]);
    expect(asked).toBe(1); // passed over for the rest of that sync
    junk.tip = honest.tip = branch(3, {}, blocks.at(-1)!).at(-1)!;
    await v.sync([junk, honest]);
    expect(asked).toBe(1); // the honest supplier supplied the last section: it is asked first
    expect(v.witnessedIndex()).toBe(7n);
  });

  it("fails closed when its own sync throws, rather than answer from a state no sync completed", async () => {
    const blocks = branch(8), v = venue();
    await v.sync([serving(blocks.slice(0, 6))]);
    expect(v.witnessedIndex()).toBe(2n);
    // An unexpected failure of the view's own after it read a section past its clock.
    let reads = 0;
    const own = v as unknown as { hold: (index: bigint, objects: unknown) => void };
    const hold = own.hold.bind(v);
    own.hold = (index, objects) => { if (reads++ > 0) throw new RangeError("out of memory"); hold(index, objects); };
    await expect(v.sync([serving(blocks)])).rejects.toThrow(RangeError);
    const failed = new VenueError("Ergo sync failed; open a new view");
    expect(() => v.witnessedIndex()).toThrow(failed);
    await expect(v.sync([serving(blocks)])).rejects.toThrow(failed);
  });

  it("takes a reader policy of its own budgets only, each a positive count the runtime can honour", () => {
    for (const policy of [{ headerPerSupplier: 5 }, { supplierTimeoutMs: 2 ** 31 }, { retainedBytes: 0 }, { sectionBytesPerSync: 1.5 }]) {
      expect(() => venue(policy as Partial<ErgoReaderPolicy>)).toThrow(new TypeError("invalid Ergo reader policy"));
    }
    expect(venue({ supplierTimeoutMs: 2 ** 31 - 1 }).lag()).toBe(DEPTH + 1n);
  });
});

describe("its answers are §13's", () => {
  const wide = { maxBytes: 1n << 30n, maxEntries: 1n << 20n };
  it("answer every kind from the verified sections, refuse what the view cannot answer and throw past the reader's budget", async () => {
    const pieces = (n: number) => recordOutput(4, backing.name, new Uint8Array(40).fill(n));
    const at: Records = {
      1: [[committed(commitment(1n, 0xaa))], [pieces(1), pieces(2), plainOutput, pieces(3)]],
      3: [[revoked(SECRETS.backer, KEYS.backer), committed(commitment(2n, 0xab))]],
      4: [[replaced(ruled, replacement(ruled, KEYS.alice, SECRETS.alice, SECRETS.backer2, 30n))]],
    };
    const { v } = await synced(12, at);
    expect(v.witnessedIndex()).toBe(8n);
    const entries = (kind: RecordKind, subject: Uint8Array): string[] => {
      const request: RangeRequest = { venue: VENUE_ID, kind, subject, fromIndex: 0n, toIndex: 8n };
      return decodeRangeAnswer(v.range(request, wide)!, request, wide).entries.map(e => `${e.index}/${e.ordinal.toString(16)}/${e.record.length}`);
    };
    // Kinds 1–3 at ordinal zero in ascending bytes; a kind-4 run reassembled at its first output's ordinal, a plain output ending it.
    expect(entries(1, KEYS.operator)).toEqual(["1/0/136", "3/0/136"]);
    expect(entries(2, ruled.name)).toEqual(["4/0/233"]);
    expect(entries(3, KEYS.backer)).toEqual(["3/0/96"]);
    expect(entries(4, backing.name)).toEqual(["1/100000000/80", "1/100000003/40"]);
    expect(entries(1, KEYS.alice)).toEqual([]);
    const request: RangeRequest = { venue: VENUE_ID, kind: 1, subject: KEYS.operator, fromIndex: 0n, toIndex: 8n };
    expect(v.range({ ...request, toIndex: 9n }, wide)).toBeUndefined();
    expect(v.range({ ...request, venue: new Uint8Array(32) }, wide)).toBeUndefined();
    expect(v.range({ ...request, fromIndex: 9n, toIndex: 8n }, wide)).toBeUndefined();
    expect(() => v.range(request, { maxBytes: 200n, maxEntries: 10n })).toThrow(RangeLimitError);
    // A request whose fields change after their single read is answered as first read.
    let subjectReads = 0, toReads = 0;
    const drifting = { venue: VENUE_ID, kind: 1 as const, fromIndex: 0n,
      get subject() { return subjectReads++ === 0 ? KEYS.operator : KEYS.alice; }, get toIndex() { return toReads++ === 0 ? 2n : 8n; } };
    const drifted = decodeRangeAnswer(v.range(drifting, wide)!, { ...request, toIndex: 2n }, wide);
    expect(drifted.entries.map(e => e.index)).toEqual([1n]);
  });
});

describe("this view reads; publishing is a wallet handed to it", () => {
  it("refuses to publish any kind without a publisher", async () => {
    const { v } = await synced(5);
    const records: [RecordKind, Uint8Array, Uint8Array][] = [
      [1, KEYS.operator, encodeCommitment(commitment(1n, 0xaa))],
      [2, ruled.name, encodeReplacement(ruled.name, replacement(ruled, KEYS.carol, SECRETS.carol, SECRETS.backer2, 5n))],
      [3, KEYS.backer, encodeRevocation(signRevocation(SECRETS.backer))],
      [4, backing.name, new Uint8Array(40)],
    ];
    for (const [kind, subject, record] of records) await expect(v.publishRecord(kind, subject, record)).rejects.toThrow(/no publisher/);
  });
});

describe("held records on this venue", () => {
  const MAX = (1n << 64n) - 1n, SPARSE = (1n << 53n) + 7n;
  const records = [
    { at: 0, commitment: signCommitment(SECRETS.operator, 1n, new Uint8Array(32).fill(1)) },
    { at: 3, commitment: signCommitment(SECRETS.operator, 5n, new Uint8Array(32).fill(2)) },
    { at: 3, commitment: signCommitment(SECRETS.operator, SPARSE, new Uint8Array(32).fill(3)) },
    { at: 8, commitment: signCommitment(SECRETS.operator, MAX, new Uint8Array(32).fill(4)) },
  ];
  const other = signCommitment(SECRETS.alice, 2n, new Uint8Array(32).fill(5));
  const at: Records = { 0: [[committed(records[0]!.commitment)]], 3: [[committed(records[2]!.commitment), committed(other)], [committed(records[1]!.commitment)]],
    8: [[committed(records[3]!.commitment)]] };
  it("holds sparse sequences up to 2^64 − 1 at their indices, and each range ending before the clock holds its prefix", async () => {
    const { v } = await synced(13, at);
    expect(v.witnessedIndex()).toBe(9n);
    for (const asOf of [0n, 2n, 3n, 7n, 8n, 9n]) {
      expect(held(v, KEYS.operator, asOf)).toEqual(records.filter(r => BigInt(r.at) <= asOf).map(r => ({ index: BigInt(r.at), commitment: r.commitment })));
    }
    expect(held(v, KEYS.alice)).toEqual([{ index: 3n, commitment: other }]);
    expect(held(v, KEYS.backer)).toEqual([]);
  });

  it("holds only verified records rising in sequence", async () => {
    const signed = (sequence: bigint) => signCommitment(SECRETS.operator, sequence, new Uint8Array(32).fill(6));
    const invalid = signed(4n); invalid.signature.fill(0);
    const { v } = await synced(14, { 1: [[committed(signed(1n))]], 2: [[committed(invalid)]], 3: [[committed(signed(5n))]],
      5: [[committed(signed(2n))]], 11: [[committed(signed(6n))]] });
    expect(v.witnessedIndex()).toBe(10n);
    expect(sequences(v, KEYS.operator)).toEqual([[1n, 1n], [3n, 5n]]);
  });

  it("keeps unavailable reads VenueError, and a failed refresh keeps the snapshot", async () => {
    const v = venue(), request: RangeRequest = { venue: VENUE_ID, kind: 1, subject: KEYS.operator, fromIndex: 0n, toIndex: 0n };
    expect(() => v.range(request, WIDE)).toThrow(new VenueError("this view has no settled snapshot"));
    const blocks = branch(8);
    await v.sync([serving(blocks)]);
    const before = v.range(request, WIDE);
    expect(decodeRangeAnswer(before!, request, WIDE).entries).toEqual([]);
    const offline = serving([...blocks, ...branch(4, {}, blocks.at(-1)!)]);
    offline.before = async () => { throw new Error("offline"); };
    expect((await v.sync([offline])).suppliers[0]!.stopped).toBe("failed: offline");
    expect(v.range(request, WIDE)).toEqual(before);
    expect(v.witnessedIndex()).toBe(4n);
  });
});

// Supplier failures never escape a sync, but the reader's own do; a supplier
// that answers with something other than bytes supplies nothing.
describe("a supplier's malformed answers supply nothing", () => {
  it("non-arrays, non-bytes and throwing getters are passed over", async () => {
    const blocks = branch(8);
    const odd = serving(blocks, "odd");
    odd.headers = async () => [1, "x", null] as unknown as Uint8Array[];
    odd.section = async () => ({ length: 1 }) as unknown as ErgoTransactionView[];
    const throwing = serving(blocks, "throwing");
    Object.defineProperty(throwing, "name", { get: () => { throw new Error("no name"); } });
    throwing.section = async () => [{ get unsigned(): Uint8Array { throw new Error("getter"); }, witnessId: new Uint8Array(31) }];
    throwing.tipHeight = async () => { throw { get message(): string { throw new Error("unreadable"); } }; };
    const hanging = serving(blocks, "hanging");
    hanging.section = () => new Promise<never>(() => {});
    const v = venue({ supplierTimeoutMs: 50 });
    const report = await v.sync([odd, throwing, hanging, serving(blocks, "honest")]);
    expect(report.suppliers.map(s => [s.name, s.stopped])).toEqual([["odd", "refused header: malformed"],
      ["unnamed supplier", "failed: [object Object]"], ["hanging", undefined], ["honest", undefined]]);
    expect(v.witnessedIndex()).toBe(4n);
  });

  it("charges every section received against the sync's budget, whether or not it matches its header", async () => {
    const blocks = branch(10);
    const junk = serving(blocks, "junk");
    let asked = 0;
    junk.section = async () => { asked++; return [transaction([rawOutput(SCRIPTS[4], [Uint8Array.of(0x0e, 0)])]), ...Array.from({ length: 40 }, () => transaction([plainOutput]))]; };
    const v = venue({ sectionBytesPerSync: 2_000 });
    const report = await v.sync([junk, serving(blocks, "honest")]);
    expect(report.unresolvedReason).toBe("section budget");
    // Junk is not asked again after its first miss; the honest sections fill the rest of the budget.
    expect(asked).toBe(1);
    expect(report.witnessedIndex).toBeLessThan(6n);
  });

  it("owns each view by its intrinsic bytes: shadowed lengths, detached or shared storage and later mutation change nothing", async () => {
    const at: Records = { 1: [[committed(commitment(1n, 0xaa))]] };
    const blocks = branch(8, at), index1 = hex(blocks[1]!.id);
    const answer = async (substitute: (views: readonly ErgoTransactionView[]) => ErgoTransactionView[], policy?: Partial<ErgoReaderPolicy>) => {
      const s = serving(blocks);
      s.substituted.set(index1, substitute(blocks[1]!.section));
      const v = venue(policy);
      await v.sync([s]);
      return v;
    };
    const request: RangeRequest = { venue: VENUE_ID, kind: 1, subject: KEYS.operator, fromIndex: 0n, toIndex: 4n };
    const wide = { maxBytes: 1n << 20n, maxEntries: 10n };
    const { v: honest } = await synced(8, at);
    const expected = honest.range(request, wide);
    // A shadowed length of zero is charged by the view's own length: under a budget the section crosses, the sync
    // stops exactly where it stops for the same bytes unshadowed.
    const small = (views: readonly ErgoTransactionView[]) => views.map(t => {
      const unsigned = new Uint8Array(t.unsigned);
      Object.defineProperty(unsigned, "length", { value: 0 });
      return { ...t, unsigned };
    });
    const policy = { sectionBytesPerSync: blocks[0]!.section.reduce((n, t) => n + t.unsigned.length + 31, 0) + 40 };
    const control = (await answer(views => views.map(t => ({ ...t, unsigned: new Uint8Array(t.unsigned) })), policy)).witnessedIndex();
    expect(control).toBeLessThan(4n);
    expect((await answer(small, policy)).witnessedIndex()).toBe(control);
    expect((await answer(small)).range(request, wide)).toEqual(expected);
    // A detached view supplies no section; shared storage, even behind a shadowed buffer, is copied before it is read.
    const detached = (views: readonly ErgoTransactionView[]) => views.map(t => {
      const unsigned = new Uint8Array(t.unsigned);
      structuredClone(unsigned.buffer, { transfer: [unsigned.buffer] });
      return { ...t, unsigned };
    });
    expect((await answer(detached)).witnessedIndex()).toBe(0n);
    const shared = (views: readonly ErgoTransactionView[]) => views.map(t => {
      const unsigned = new Uint8Array(new SharedArrayBuffer(t.unsigned.length));
      unsigned.set(t.unsigned);
      Object.defineProperty(unsigned, "buffer", { value: new ArrayBuffer(0) });
      return { ...t, unsigned };
    });
    const copied = await answer(shared);
    expect(copied.range(request, wide)).toEqual(expected);
    // Views the supplier mutates after the sync change no answer.
    const kept: ErgoTransactionView[] = [];
    const mutable = await answer(views => views.map(t => { const own = { ...t, unsigned: new Uint8Array(t.unsigned) }; kept.push(own); return own; }));
    kept.forEach(t => t.unsigned.fill(0));
    expect(mutable.range(request, wide)).toEqual(expected);
  });

  it("the synthetic supplier stops at parent links that loop or climb rather than following them", async () => {
    const blocks = branch(6);
    const looped = blocks.map(block => ({ ...block }));
    for (let i = 1; i < looped.length; i++) (looped[i] as { parent: Block }).parent = looped[i - 1]!;
    (looped[0] as { parent: Block }).parent = looped.at(-1)!;
    const s = new BranchSupplier("looped", looped.at(-1)!, chain);
    expect(await s.headers(ANCHOR_HEIGHT + 1n, ANCHOR_HEIGHT + 6n)).toHaveLength(6);
    expect(await s.section(new Uint8Array(32))).toBeUndefined();
    expect(await s.headers(ANCHOR_HEIGHT - 1n, ANCHOR_HEIGHT)).toHaveLength(2);
  });
});
