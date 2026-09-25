import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { encodeCommitment, signCommitment, type Commitment } from "../src/commitment.js";
import { DEFAULT_ERGO_DEPTH, ergoAnchorContext, ergoProfile, ErgoVenue, type ErgoReaderPolicy } from "../src/ergo.js";
import { ergoProfileIdentity, ergoRangeVerifier, type ErgoTransactionView } from "../src/ergo-profile.js";
import { decodeRangeAnswer, type RangeRequest, type RecordKind } from "../src/record-range.js";
import { isSilent, quietFor } from "../src/recovery.js";
import { encodeReplacement, operatorAt, replacementMessage, ROLE_OPERATOR, type Replacement } from "../src/replacement.js";
import { encodeRevocation, signRevocation } from "../src/revocation.js";
import { answering, VenueError } from "../src/venue.js";
import { PoolAuthorityView } from "../src/pool/authority.js";
import {
  ANCHOR_HEIGHT, BranchSupplier, Chain, hex, plainOutput, rawOutput, recordOutput, SCRIPTS, transaction, type Block, type Output,
} from "./ergo-chain.js";
import { CONFIG, DOMAIN } from "./pool-support.js";
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
// in index; reads see only a complete snapshot; the seam takes the existing
// predicates. And the ones this view adds: no supplier is trusted, a missing
// section stops the clock rather than reading as silence, the heaviest chain
// is followed within the depth and a reorganization past it fails the venue.

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
    expect(ergoProfile(PROFILE.anchor, SCRIPTS).depth).toBe(DEFAULT_ERGO_DEPTH);
    expect(DEFAULT_ERGO_DEPTH).toBe(10n);
  });

  it("refuses an anchor context that does not end at the profile's anchor", () => {
    expect(() => new ErgoVenue(PROFILE, chain.context.slice(0, -1))).toThrow(VenueError);
    expect(() => new ErgoVenue({ ...PROFILE, anchor: new Uint8Array(32).fill(1) }, chain.context)).toThrow(VenueError);
  });

  it("takes the anchor context from any supplier, authenticated by linkage alone", async () => {
    const context = await ergoAnchorContext(serving(branch(1)), PROFILE.anchor, ANCHOR_HEIGHT);
    expect(context.map(hex)).toEqual(chain.context.map(hex));
    await expect(ergoAnchorContext(serving(branch(1)), new Uint8Array(32).fill(2), ANCHOR_HEIGHT)).rejects.toThrow(VenueError);
  });

  it("the lag is the depth plus one, answered unsynced", () => {
    expect(venue().lag()).toBe(DEPTH + 1n);
  });

  it("the clock is nothing an unsynced view can answer, nor one whose chain has not reached the depth", async () => {
    const v = venue();
    expect(() => v.witnessedIndex()).toThrow(VenueError);
    const short = branch(3);
    const report = await v.sync([serving(short)]);
    expect(report.witnessedIndex).toBeUndefined();
    expect(() => v.witnessedIndex()).toThrow(VenueError);
    await v.sync([serving([...short, ...branch(1, {}, short.at(-1)!)])]);
    expect(v.witnessedIndex()).toBe(0n);
  });
});

describe("the witnessed index is the block that included the transaction", () => {
  it("reads a commitment at its block's index, whatever creation height its box claims", async () => {
    const early = commitment(1n, 0xaa);
    const v = venue(), blocks = chain.extend(chain.anchor, 12, i => i === 7 ? [transaction([committed(early)], 0n)] : []);
    await v.sync([serving(blocks)]);
    expect(v.witnessedAtFor(KEYS.operator)).toBe(7n);
    expect(v.latestFor(KEYS.operator)).toEqual(early);
  });

  it("reads nothing inside the finality depth", async () => {
    const blocks = branch(12, { 9: [[committed(commitment(1n, 0xaa))]] });
    const v = venue();
    await v.sync([serving(blocks)]);
    expect(v.witnessedIndex()).toBe(8n);
    expect(v.latestFor(KEYS.operator)).toBeUndefined();
    const more = [...blocks, ...branch(1, {}, blocks.at(-1)!)];
    await v.sync([serving(more)]);
    expect(v.witnessedIndex()).toBe(9n);
    expect(v.latestFor(KEYS.operator)?.sequence).toBe(1n);
  });

  it("answers about the past, which is what four of the nine reads need", async () => {
    const { v } = await synced(16, { 2: [[committed(commitment(1n, 0xaa))]], 9: [[committed(commitment(2n, 0xbb))]] });
    expect(v.latestFor(KEYS.operator)?.sequence).toBe(2n);
    expect(v.latestFor(KEYS.operator, 8n)?.sequence).toBe(1n);
    expect(v.witnessedAtFor(KEYS.operator, 8n)).toBe(2n);
    expect(v.latestFor(KEYS.operator, 1n)).toBeUndefined();
    expect(v.firstCommitmentFor(KEYS.operator)).toBe(2n);
    expect(v.firstCommitmentFor(KEYS.operator, 3n)).toBe(9n);
    expect(v.nextSequenceFor(KEYS.operator)).toBe(3n);
  });
});

describe("nothing rests on the location alone", () => {
  it("skips a commitment filed under this key that another key signed, one that does not verify, and noise", async () => {
    const stranger = commitment(1n, 0xcc, SECRETS.mallory);
    const torn = { ...commitment(2n, 0xaa), signature: new Uint8Array(64) };
    const { v } = await synced(12, {
      1: [[committed(stranger, KEYS.operator)], [committed(torn)]],
      2: [[rawOutput(SCRIPTS[1], [Uint8Array.of(0x0e, 3, 1, 2, 3), Uint8Array.of(0x0e, 1, 0)])],
        [recordOutput(1, KEYS.operator, new Uint8Array(135))], [plainOutput]],
      3: [[committed(commitment(3n, 0xa2))]],
    });
    expect(v.latestFor(KEYS.operator)?.sequence).toBe(3n);
    expect(v.witnessedAtSequence(KEYS.operator, 1n)).toBeUndefined();
    expect(v.witnessedAtSequence(KEYS.operator, 2n)).toBeUndefined();
    expect(v.firstCommitmentFor(KEYS.operator)).toBe(3n);
    // Absence is proven for every key by exhaustion: no key needs to be named before the sync.
    expect(v.latestFor(KEYS.alice)).toBeUndefined();
  });

  it("reads revocations that name and are signed by the key, and replacements that decode and name the backing", async () => {
    const r = replacement(ruled, KEYS.alice, SECRETS.alice, SECRETS.backer2, 30n);
    const { v } = await synced(12, {
      1: [[revoked(SECRETS.backer, KEYS.backer)], [revoked(SECRETS.mallory, KEYS.backer)]],
      2: [[replaced(ruled, r)], [recordOutput(2, backing.name, encodeReplacement(ruled.name, r))], [recordOutput(2, ruled.name, new Uint8Array(233))]],
    });
    expect(v.revocationsFor(KEYS.backer)).toEqual([{ revocation: signRevocation(SECRETS.backer), at: 1n }]);
    expect(v.revocationsFor(KEYS.mallory)).toEqual([]);
    expect(v.replacementsFor(ruled.name)).toEqual([{ replacement: r, at: 2n }]);
    expect(v.replacementsFor(backing.name)).toEqual([]);
  });

  it("hands out copies: a reader that overwrites what it was given changes nothing", async () => {
    const original = commitment(1n, 0xaa), r = replacement(ruled, KEYS.alice, SECRETS.alice, SECRETS.backer2, 30n);
    const { v } = await synced(12, { 2: [[committed(original), revoked(SECRETS.backer, KEYS.backer), replaced(ruled, r)]] });
    const read = v.latestFor(KEYS.operator)!;
    read.root.fill(0); read.operator.fill(0); read.signature.fill(0);
    const revocation = v.revocationsFor(KEYS.backer)[0]!.revocation;
    revocation.obligor.fill(0); revocation.signature.fill(0);
    const held = v.replacementsFor(ruled.name)[0]!.replacement;
    held.successor.fill(0); held.signature.fill(0);
    expect(v.latestFor(KEYS.operator)).toEqual(original);
    expect(v.revocationsFor(KEYS.backer)).toEqual([{ revocation: signRevocation(SECRETS.backer), at: 2n }]);
    expect(v.replacementsFor(ruled.name)).toEqual([{ replacement: r, at: 2n }]);
  });
});

describe("§C2.3.3: a key's record rises in sequence as it rises in index (pool-v3 §13.3)", () => {
  it("skips a replay of an earlier commitment, so bytes anybody can copy off the chain do not move the record's last", async () => {
    const one = commitment(1n, 0xa0);
    const { v } = await synced(14, {
      1: [[committed(one)]], 2: [[committed(commitment(2n, 0xa1))]], 3: [[committed(commitment(3n, 0xa2))]], 4: [[committed(one)]],
    });
    expect(v.latestFor(KEYS.operator)?.sequence).toBe(3n);
    expect(v.witnessedAtFor(KEYS.operator)).toBe(3n);
    expect(v.nextSequenceFor(KEYS.operator)).toBe(4n);
    expect(v.witnessedAtSequence(KEYS.operator, 1n)).toBe(1n);
  });

  it("holds one sequence once: a later root at a held sequence is skipped, two at one index keep the lesser bytes", async () => {
    const a = commitment(2n, 0xc1), b = commitment(2n, 0xc9);
    const lesser = Buffer.compare(encodeCommitment(a), encodeCommitment(b)) < 0 ? a : b;
    const { v } = await synced(14, { 1: [[committed(commitment(1n, 0xc0))]], 2: [[committed(b)], [committed(a)]], 3: [[committed(commitment(2n, 0xcc))]] });
    expect(v.latestFor(KEYS.operator)).toEqual(lesser);
    expect(v.witnessedAtFor(KEYS.operator)).toBe(2n);
  });

  it("reads two commitments of one key in one block the same way whatever their order in it", async () => {
    const two = commitment(2n, 0xb1), three = commitment(3n, 0xb2);
    const forward = await synced(12, { 1: [[committed(commitment(1n, 0xb0))]], 2: [[committed(two)], [committed(three)]] });
    const backward = await synced(12, { 1: [[committed(commitment(1n, 0xb0))]], 2: [[committed(three), committed(two)]] });
    for (const { v } of [forward, backward]) {
      expect(v.latestFor(KEYS.operator)?.sequence).toBe(3n);
      expect(v.witnessedAtSequence(KEYS.operator, 1n)).toBe(1n);
      expect(v.witnessedAtSequence(KEYS.operator, 2n)).toBe(2n);
      expect(v.witnessedAtSequence(KEYS.operator, 3n)).toBe(2n);
      expect(v.previousFor(KEYS.operator, 3n)).toEqual(two);
    }
  });
});

describe("pool readers see only a complete Ergo snapshot", () => {
  const x = makeBacking({ ...backing, evidence: { setting: "pool", operator: KEYS.operator,
    construction: "moe/pool/v2", configuration: DOMAIN, replacementRule: KEYS.backer,
    witnessing: { venue: VENUE_ID, interval: 1n } } });
  const signed = { backing: x, signature: signBacking(SECRETS.backer, x) };
  const r = replacement(x, KEYS.bob, SECRETS.bob, SECRETS.backer, 21n);
  const first = commitment(1n, 1), second = commitment(2n, 2);
  // Twelve blocks witness 0..8; twenty-six witness 0..22, adding the replacement witnessed at 12 (in force at
  // 21, its floor of twice the lag plus one), the second commitment and a revocation.
  const old = branch(12, { 2: [[committed(first)]] });
  const grown = [...old, ...branch(14, { 0: [[replaced(x, r)]], 3: [[committed(second), revoked(SECRETS.backer, KEYS.backer)]] }, old.at(-1)!)];
  for (const initial of [true, false]) {
    for (const fail of [true, false]) {
      it.each(["headers", "section"] as const)(`${initial ? "first sync" : "refresh"} ${fail ? "failure" : "success"} at %s exposes no partial records`, async phase => {
        const v = venue(), entered = signal(), resume = signal();
        if (!initial) {
          await v.sync([serving(old)]);
          // Prime the memo that must survive failure and be invalidated on success.
          expect(new PoolAuthorityView(CONFIG, v, [signed]).term(x.name)?.operator).toEqual(KEYS.operator);
        }
        const supplier = serving(grown);
        let paused = false;
        supplier.before = async call => {
          if (call !== phase || paused) return;
          paused = true; entered.resolve(); await resume.promise;
          if (fail) throw new Error("offline");
        };
        const pending = v.sync([supplier]);
        await entered.promise;
        const reads = [
          () => v.witnessedIndex(), () => v.latestFor(KEYS.operator),
          () => v.previousFor(KEYS.operator, 3n), () => v.witnessedAtFor(KEYS.operator),
          () => v.witnessedAtSequence(KEYS.operator, 1n), () => v.firstCommitmentFor(KEYS.operator),
          () => v.nextSequenceFor(KEYS.operator), () => v.replacementsFor(x.name), () => v.revocationsFor(x.obligor),
          () => new PoolAuthorityView(CONFIG, v, [signed]),
        ];
        try {
          // Mid-sync, reads answer from the previous snapshot, or refuse where there is none.
          if (initial) for (const read of reads) expect(read).toThrow(VenueError);
          else {
            expect(v.witnessedIndex()).toBe(8n);
            expect(v.latestFor(KEYS.operator)).toEqual(first);
            expect(v.replacementsFor(x.name)).toHaveLength(0);
            expect(new PoolAuthorityView(CONFIG, v, [signed]).term(x.name)?.operator).toEqual(KEYS.operator);
          }
          expect(v.id).toEqual(VENUE_ID); expect(v.lag()).toBe(4n);
        } finally { resume.resolve(); }
        const report = await pending;
        expect(report.suppliers[0]!.stopped !== undefined || report.unresolvedIndex !== undefined).toBe(fail);
        if (fail && initial) {
          for (const read of reads) expect(read).toThrow(VenueError);
        } else {
          expect(v.witnessedIndex()).toBe(fail ? 8n : 22n);
          expect(v.latestFor(KEYS.operator)).toEqual(fail ? first : second);
          expect(v.witnessedAtSequence(KEYS.operator, 2n)).toBe(fail ? undefined : 15n);
          expect(v.replacementsFor(x.name)).toHaveLength(fail ? 0 : 1);
          expect(v.revocationsFor(x.obligor)).toHaveLength(fail ? 0 : 1);
          expect(new PoolAuthorityView(CONFIG, v, [signed]).term(x.name)?.operator).toEqual(fail ? KEYS.operator : KEYS.bob);
        }
        if (fail) {
          await v.sync([serving(grown)]);
          expect(v.witnessedIndex()).toBe(22n);
          expect(new PoolAuthorityView(CONFIG, v, [signed]).term(x.name)?.operator).toEqual(KEYS.bob);
        }
      });
    }
  }

  it("refuses a concurrent sync without disturbing the one running", async () => {
    const v = venue(), supplier = serving(old), entered = signal(), resume = signal();
    supplier.before = async call => { if (call === "tip") { entered.resolve(); await resume.promise; } };
    const pending = v.sync([supplier]);
    await entered.promise;
    await expect(v.sync([serving(old)])).rejects.toThrow(VenueError);
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
    expect(v.witnessedAtFor(KEYS.operator)).toBe(2n);
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
    expect(v.latestFor(KEYS.operator)).toBeUndefined();
    await v.sync([withholding, serving(blocks, "other")]);
    expect(v.witnessedIndex()).toBe(8n);
    expect(v.witnessedAtFor(KEYS.operator)).toBe(6n);
  });

  it("a section that does not reproduce its header's root is passed over", async () => {
    const blocks = branch(12, { 3: [[committed(commitment(1n, 0xaa))]] });
    const lying = serving(blocks, "lying");
    lying.substituted.set(hex(blocks[3]!.id), [transaction([plainOutput])]);
    const v = venue();
    expect((await v.sync([lying])).unresolvedIndex).toBe(3n);
    expect(v.witnessedIndex()).toBe(2n);
    await v.sync([lying, serving(blocks, "honest")]);
    expect(v.witnessedAtFor(KEYS.operator)).toBe(3n);
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
    expect(v.latestFor(KEYS.operator)?.root).toEqual(new Uint8Array(32).fill(0xbb));
  });

  it("a reorganization past the depth fails the venue: every read and every later sync refuses", async () => {
    const trunk = branch(4);
    const first = [...trunk, ...branch(8, { 1: [[committed(commitment(1n, 0xaa))]] }, trunk.at(-1)!, 1)];
    const deeper = [...trunk, ...branch(12, {}, trunk.at(-1)!, 2)];
    const v = venue();
    await v.sync([serving(first)]);
    expect(v.witnessedAtFor(KEYS.operator)).toBe(5n);
    await expect(v.sync([serving(deeper, "heavier fork")])).rejects.toThrow(/venue failure/);
    expect(() => v.witnessedIndex()).toThrow(/venue failure/);
    expect(() => v.latestFor(KEYS.operator)).toThrow(VenueError);
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
    expect(v.witnessedAtFor(KEYS.operator)).toBe(9n);
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
    expect(v.witnessedAtFor(KEYS.operator)).toBe(14n);
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
    expect(v.latestFor(KEYS.operator)?.root).toEqual(new Uint8Array(32).fill(0xbb));
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
    expect(v.witnessedAtFor(KEYS.operator)).toBe(9n);
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
});

describe("its answers are §13's", () => {
  const wide = { maxBytes: 1n << 30n, maxEntries: 1n << 20n };
  it("equal the evidence verifier's over the same blocks, for every kind, and refuse what the view cannot answer", async () => {
    const pieces = (n: number) => recordOutput(4, backing.name, new Uint8Array(40).fill(n));
    const at: Records = {
      1: [[committed(commitment(1n, 0xaa))], [pieces(1), pieces(2), plainOutput, pieces(3)]],
      3: [[revoked(SECRETS.backer, KEYS.backer), committed(commitment(2n, 0xab))]],
      4: [[replaced(ruled, replacement(ruled, KEYS.alice, SECRETS.alice, SECRETS.backer2, 30n))]],
    };
    const { v, blocks } = await synced(12, at);
    const views = blocks.map(block => ({ id: block.id, parentId: block.parent?.id ?? chain.anchor.id, height: block.height, version: 3n,
      transactionsRoot: block.bytes.subarray(65, 97) }));
    const verifier = ergoRangeVerifier(PROFILE, { headers: views, blocks: blocks.map(block => ({ headerId: block.id, transactions: block.section })) })!;
    expect(verifier.witnessedIndex()).toBe(v.witnessedIndex());
    const cases: [RecordKind, Uint8Array][] = [[1, KEYS.operator], [2, ruled.name], [3, KEYS.backer], [4, backing.name], [1, KEYS.alice]];
    for (const [kind, subject] of cases) {
      const request: RangeRequest = { venue: VENUE_ID, kind, subject, fromIndex: 0n, toIndex: 8n };
      const answer = v.range(request, wide);
      expect(answer).toEqual(verifier.range(request, wide));
      expect(decodeRangeAnswer(answer!, request, wide).entries.length).toBe(kind === 4 ? 2 : subject === KEYS.alice ? 0 : kind === 1 ? 2 : 1);
    }
    const request: RangeRequest = { venue: VENUE_ID, kind: 1, subject: KEYS.operator, fromIndex: 0n, toIndex: 8n };
    expect(v.range({ ...request, toIndex: 9n }, wide)).toBeUndefined();
    expect(v.range({ ...request, venue: new Uint8Array(32) }, wide)).toBeUndefined();
    expect(v.range(request, { maxBytes: 200n, maxEntries: 10n })).toBeUndefined();
  });
});

describe("this view reads; publishing is a wallet handed to it", () => {
  it("refuses to publish without a publisher, and refuses the records the profile does not carry rather than answering empty", async () => {
    const { v } = await synced(5);
    for (const call of [() => v.publishOp(), () => v.publishCommit(), () => v.publishedOpsFor(), () => v.commitsFor()]) expect(call).toThrow(VenueError);
    await expect(v.publish(commitment(1n, 0xaa))).rejects.toThrow(/no publisher/);
    await expect(v.publishRevocation(signRevocation(SECRETS.backer))).rejects.toThrow(/no publisher/);
    await expect(v.publishReplacement(ruled.name, replacement(ruled, KEYS.carol, SECRETS.carol, SECRETS.backer2, 5n))).rejects.toThrow(/no publisher/);
  });
});

describe("the seam is real: the existing predicates take this venue", () => {
  it("grades silence off the chain's own indices", async () => {
    const blocks = branch(26, { 4: [[committed(commitment(1n, 0xaa))]] });
    const v = venue();
    await v.sync([serving(blocks)]);
    expect(quietFor(v, KEYS.operator)).toBe(18n);
    expect(isSilent(v, backing)).toBe(true);
    await v.sync([serving([...blocks, ...branch(1, { 0: [[committed(commitment(2n, 0xbb))]] }, blocks.at(-1)!)])]);
    expect(v.witnessedIndex()).toBe(23n);
    // The commitment at index 26 is inside the depth; the clock moved one, and the grade is unchanged.
    expect(isSilent(v, backing)).toBe(true);
  });

  it("a record witnessed at 4 takes force at 13 and not at 12: the lead is floored at twice the lag plus one", async () => {
    const at = (effective: bigint): Records => ({ 1: [[committed(commitment(1n, 0xaa))]],
      4: [[replaced(ruled, replacement(ruled, KEYS.alice, SECRETS.alice, SECRETS.backer2, effective))]] });
    const short = await synced(18, at(12n));
    expect(operatorAt(ruled, short.v, short.v.witnessedIndex())).toEqual(KEYS.operator);
    const enough = await synced(18, at(13n));
    expect(operatorAt(ruled, enough.v, enough.v.witnessedIndex())).toEqual(KEYS.alice);
  });
});

describe("C2.7.2 bounded held-record descent on this venue", () => {
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
  it("matches record selection across inclusive indices and exclusive sparse sequence bounds, and visits every held predecessor", async () => {
    const { v } = await synced(13, at);
    expect(v.witnessedIndex()).toBe(9n);
    for (const asOf of [undefined, 0n, 2n, 3n, 7n, 8n, 9n, 100n]) {
      for (const bound of [0n, 1n, 5n, 6n, SPARSE, SPARSE + 1n, MAX, MAX + 1n]) {
        const expected = records.filter(r => BigInt(r.at) <= (asOf ?? 9n) && r.commitment.sequence < bound).at(-1);
        expect(v.previousFor(KEYS.operator, bound, asOf)).toEqual(expected?.commitment);
      }
    }
    const seen: bigint[] = [];
    for (let current = v.latestFor(KEYS.operator); current !== undefined; current = v.previousFor(KEYS.operator, current.sequence)) {
      seen.push(current.sequence);
    }
    expect(seen).toEqual([MAX, SPARSE, 5n, 1n]);
    expect(v.previousFor(KEYS.alice, MAX)).toEqual(other);
    expect(v.previousFor(KEYS.backer, MAX)).toBeUndefined();
    for (const record of records) expect(v.witnessedAtSequence(KEYS.operator, record.commitment.sequence)).toBe(BigInt(record.at));
    for (const hole of [0n, 2n, 6n, SPARSE - 1n, MAX - 1n]) expect(v.witnessedAtSequence(KEYS.operator, hole)).toBeUndefined();
  });

  it("uses only held, verified, witnessed records", async () => {
    const signed = (sequence: bigint) => signCommitment(SECRETS.operator, sequence, new Uint8Array(32).fill(6));
    const invalid = signed(4n); invalid.signature.fill(0);
    const { v } = await synced(14, { 1: [[committed(signed(1n))]], 2: [[committed(invalid)]], 3: [[committed(signed(5n))]],
      5: [[committed(signed(2n))]], 11: [[committed(signed(6n))]] });
    expect(v.witnessedIndex()).toBe(10n);
    expect(v.previousFor(KEYS.operator, 7n, 100n)?.sequence).toBe(5n);
    expect(v.previousFor(KEYS.operator, 5n)?.sequence).toBe(1n);
    for (const sequence of [2n, 4n, 6n]) expect(v.witnessedAtSequence(KEYS.operator, sequence)).toBeUndefined();
  });

  it("keeps unavailable reads VenueError, even for an empty sequence range, and a failed refresh keeps the snapshot", async () => {
    const v = venue(), read = () => answering(() => v.previousFor(KEYS.operator, 0n), undefined);
    expect(read).toThrow(VenueError);
    const blocks = branch(8);
    await v.sync([serving(blocks)]);
    expect(read()).toBeUndefined();
    const offline = serving([...blocks, ...branch(4, {}, blocks.at(-1)!)]);
    offline.before = async () => { throw new Error("offline"); };
    expect((await v.sync([offline])).suppliers[0]!.stopped).toBe("failed: offline");
    expect(read()).toBeUndefined();
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
});
