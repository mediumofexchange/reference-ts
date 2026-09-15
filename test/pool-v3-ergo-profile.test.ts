import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { describe, expect, it } from "vitest";
import * as profile from "../model/pool-v3-ergo-profile.js";
import * as range from "../model/pool-v3-range.js";
import { EncodingError } from "../src/bytes.js";
import { encodeCommitment, signCommitment } from "../src/commitment.js";
import { encodeReplacement, replacementMessage, ROLE_OPERATOR } from "../src/replacement.js";
import { encodeRevocation, signRevocation } from "../src/revocation.js";

// Synthetic block views: real signed records inside register constants,
// headers linked by synthetic ids. No Ergo library, node or header
// authentication is involved; the experiment checks the same rules over
// Fleet-serialized, sigma-rust-decoded bytes, the real fixture roots, real
// register constants and the real genesis header.
const cat = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const sha = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();
const b = (n: number, width = 32): Buffer => Buffer.alloc(width, n);
const tree = (kind: number): Buffer => Buffer.from(`0008cd02${"ab".repeat(31)}0${kind}`, "hex");
const scripts = { 1: tree(1), 2: tree(2), 3: tree(3), 4: tree(4) } as const;
const wide = { maxBytes: 1n << 40n, maxEntries: 1n << 20n };
const vlq = (n: number): Buffer => {
  const out: number[] = [];
  do { let byte = n & 0x7f; n = Math.floor(n / 128); if (n > 0) byte |= 0x80; out.push(byte); } while (n > 0);
  return Buffer.from(out);
};
const coll = (bytes: Uint8Array): Buffer => cat(Uint8Array.of(0x0e), vlq(bytes.length), bytes);
const operatorSecret = b(29), operator = ed25519.getPublicKey(operatorSecret);
const otherSecret = b(31), other = ed25519.getPublicKey(otherSecret);
const ruleSecret = b(37), rule = ed25519.getPublicKey(ruleSecret);
const obligorSecret = b(41), obligor = ed25519.getPublicKey(obligorSecret);
const backing = b(17), backingY = b(18);

const commitment = (sequence: bigint, secret = operatorSecret): Uint8Array => encodeCommitment(signCommitment(secret, sequence, b(Number(sequence) + 60)));
function replacement(effective: bigint): Uint8Array {
  const fields = { role: ROLE_OPERATOR, successor: other, predecessor: backing, effective };
  const message = replacementMessage(backing, { ...fields, signature: new Uint8Array(64), successorSignature: new Uint8Array(64) });
  return encodeReplacement(backing, { ...fields, signature: ed25519.sign(message, ruleSecret), successorSignature: ed25519.sign(message, otherSecret) });
}
const revocation = encodeRevocation(signRevocation(obligorSecret));

type Output = profile.ErgoOutputView;
const output = (ergoTree: Uint8Array, registers: Record<string, Uint8Array> = {}): Output => ({ ergoTree, registers });
const record = (kind: 1 | 2 | 3 | 4, subject: Uint8Array, bytes: Uint8Array, extra: Record<string, Uint8Array> = {}): Output =>
  output(scripts[kind], { R4: coll(subject), R5: coll(bytes), ...extra });
const plain = output(Buffer.from("0008cd03" + "cc".repeat(32), "hex"));
let counter = 0;
const transaction = (outputs: Output[]): profile.ErgoTransactionView => {
  const seed = sha(Buffer.from(`tx-${counter++}`));
  return { id: seed, witnessId: blake2b(seed, { dkLen: 32 }).subarray(1), outputs };
};
interface Spec { readonly [height: string]: Output[][] }
/** Heights `from` through `to`; each block's transactions from the spec, else one plain transaction. */
function evidence(spec: Spec, from: bigint, to: bigint, version = 3n): profile.ErgoRangeEvidence {
  const headers: profile.ErgoHeaderView[] = [], blocks: profile.ErgoBlockView[] = [];
  let parentId: Uint8Array = new Uint8Array(32);
  for (let height = from; height <= to; height++) {
    const transactions = (spec[height.toString()] ?? [[plain]]).map(transaction);
    const transactionsRoot = profile.transactionsRoot(version, transactions);
    const id = sha(cat(Buffer.from(height.toString()), transactionsRoot, parentId));
    headers.push({ id, parentId, height, version, transactionsRoot });
    blocks.push({ headerId: id, transactions });
    parentId = id;
  }
  return { headers, blocks };
}
const genesisOf = (chain: profile.ErgoRangeEvidence): Uint8Array => chain.headers[0]!.id;
const profileOf = (chain: profile.ErgoRangeEvidence, depth = 2n): profile.ErgoProfile => ({ genesis: genesisOf(chain), depth, scripts });
const request = (venue: Uint8Array, kind: range.RecordKind, subject: Uint8Array, fromIndex = 0n, toIndex = 6n): range.RangeRequest =>
  ({ venue, kind, subject, fromIndex, toIndex });
function answer(verifier: profile.ErgoRangeVerifier, kind: range.RecordKind, subject: Uint8Array, fromIndex = 0n, toIndex = 6n): range.RangeAnswer {
  const r = request(verifier.identity, kind, subject, fromIndex, toIndex), bytes = verifier.range(r, wide);
  expect(bytes).toBeInstanceOf(Uint8Array);
  return range.decodeRangeAnswer(bytes!, r, wide);
}

// A record whose bytes are the right length but whose signature is nobody's: carried, never held.
const junkCommitment = cat(commitment(2n).subarray(0, 72), b(0, 64));
const junkCommitmentA = cat(Buffer.from(commitment(2n)).subarray(0, 8), b(1, 32), operator, b(0, 64));
const piece = (n: number, length = 40): Buffer => b(n, length);
const spec: Spec = {
  2: [[plain, record(1, operator, commitment(1n))]],
  3: [[record(2, backing, replacement(30n)), record(1, operator, junkCommitmentA, { R6: Buffer.from("0502", "hex") })]],
  4: [[record(1, operator, commitment(3n)), record(1, operator, commitment(2n))], [record(4, backing, piece(1))]],
  5: [[plain], [record(4, backing, piece(2)), record(4, backing, piece(3)), record(4, backing, piece(4)), plain, record(4, backingY, piece(5))]],
  6: [[record(3, obligor, revocation), record(3, obligor, revocation), record(1, other, commitment(7n, otherSecret))]],
  7: [[record(1, operator, commitment(9n))]],
};

describe("Ergo venue-profile candidate", () => {
  it("names the venue by genesis, depth and every kind's location", () => {
    const chain = evidence({}, 1n, 3n), base = profileOf(chain);
    const identity = profile.ergoProfileIdentity(base);
    expect(identity).toHaveLength(32);
    expect(profile.ergoLag(base)).toBe(3n);
    const variants: profile.ErgoProfile[] = [
      { ...base, genesis: b(5) }, { ...base, depth: 3n },
      ...([1, 2, 3, 4] as const).map(kind => ({ ...base, scripts: { ...scripts, [kind]: cat(scripts[kind], Uint8Array.of(0)) } })),
    ];
    for (const variant of variants) expect(Buffer.from(profile.ergoProfileIdentity(variant))).not.toEqual(Buffer.from(identity));
    expect(() => profile.ergoProfileIdentity({ ...base, scripts: { ...scripts, 2: scripts[1] } })).toThrow(/one location/);
    expect(() => profile.ergoProfileIdentity({ ...base, scripts: { ...scripts, 3: new Uint8Array(0) } })).toThrow(EncodingError);
    expect(() => profile.ergoProfileIdentity({ ...base, genesis: b(1, 31) })).toThrow(EncodingError);
    expect(() => profile.ergoProfileIdentity({ ...base, depth: (1n << 64n) - 1n })).toThrow(EncodingError);
  });

  it("reads only exact Coll[Byte] constants with minimal lengths", () => {
    const long = b(9, 136);
    expect(Buffer.from(profile.collBytes(coll(long))!)).toEqual(long);
    expect(Buffer.from(coll(long)).subarray(0, 3)).toEqual(Buffer.from("0e8801", "hex"));
    expect(profile.collBytes(coll(new Uint8Array(0)))).toHaveLength(0);
    for (const wrong of ["0c20" + "00".repeat(32), "0502", "0e", "0e21" + "00".repeat(32), "0e1f" + "00".repeat(32),
      "0e8000", "0e8100" + "00", "0e8080808080" + "00"]) {
      expect(profile.collBytes(Buffer.from(wrong, "hex"))).toBeUndefined();
    }
  });

  it("builds the node's transaction root: prefixes, an absent sibling and a lone leaf", () => {
    const leaf = (x: Uint8Array): Uint8Array => blake2b(cat(Uint8Array.of(0), x), { dkLen: 32 });
    const parent = (...x: Uint8Array[]): Uint8Array => blake2b(cat(Uint8Array.of(1), ...x), { dkLen: 32 });
    const [x, y, z] = [b(1), b(2), b(3)];
    expect(Buffer.from(profile.merkleRoot([x]))).toEqual(Buffer.from(parent(leaf(x))));
    expect(Buffer.from(profile.merkleRoot([x, y, z]))).toEqual(Buffer.from(parent(parent(leaf(x), leaf(y)), parent(leaf(z)))));
    expect(() => profile.merkleRoot([])).toThrow(EncodingError);
    const transactions = [transaction([plain]), transaction([plain])];
    const idsOnly = Buffer.from(profile.merkleRoot(transactions.map(t => t.id)));
    expect(Buffer.from(profile.transactionsRoot(1n, transactions))).toEqual(idsOnly);
    expect(Buffer.from(profile.transactionsRoot(0n, transactions))).toEqual(idsOnly);
    expect(Buffer.from(profile.transactionsRoot(3n, transactions)))
      .toEqual(Buffer.from(profile.merkleRoot([...transactions.map(t => t.id), ...transactions.map(t => t.witnessId)])));
  });

  it("attributes by location and shape, reassembles runs and omits nothing else", () => {
    const base = profileOf(evidence({}, 1n, 1n));
    const big = piece(6, 4000), bound = range.MAX_RANGE_RECORD_BYTES[4];
    const exactly = [...Array(32).fill(big), piece(7, bound - 32 * 4000)], over = [...Array(33).fill(big)];
    const objects = profile.attributeBlock(base, [
      transaction([plain, record(1, operator, commitment(1n)), record(1, operator, commitment(1n))]),
      transaction([
        output(scripts[1], { R5: coll(commitment(1n)) }),
        record(1, operator, commitment(1n), { R4: coll(b(1, 31)) }),
        output(scripts[1], { R4: coll(operator), R5: Buffer.from("05" + "00".repeat(8), "hex") }),
        record(1, operator, commitment(1n).subarray(0, 135)),
        record(2, backing, replacement(30n).subarray(0, 232)),
        record(3, obligor, cat(revocation, Uint8Array.of(0))),
        output(Buffer.from("0008cd02" + "ab".repeat(32), "hex"), { R4: coll(operator), R5: coll(commitment(1n)) }),
        { ergoTree: scripts[1], registers: Object.create({ R4: coll(operator), R5: coll(commitment(1n)) }) as Record<string, Uint8Array> },
        record(1, operator, junkCommitment, { R6: coll(b(1)), R9: Buffer.from("0400", "hex") }),
      ]),
      transaction([record(4, backing, piece(1)), record(4, backing, piece(2)), record(4, backing, piece(3)), plain,
        record(4, backing, piece(4)), record(4, backingY, piece(5)), record(1, operator, commitment(2n)), record(4, backing, piece(6))]),
      transaction(exactly.map(p => record(4, backing, p))),
      transaction(over.map(p => record(4, backing, p))),
      transaction([record(4, backing, new Uint8Array(0)), record(2, backing, replacement(31n)), record(3, obligor, revocation)]),
    ]);
    const summary = objects.map(o => [o.kind, o.ordinal.toString(16), Buffer.from(o.subject).equals(backingY) ? "Y" : "", o.record.length]);
    expect(summary).toEqual([
      [1, "1", "", 136], [1, "2", "", 136],
      [1, "100000008", "", 136],
      [4, "200000000", "", 120], [4, "200000004", "", 40], [4, "200000005", "Y", 40], [1, "200000006", "", 136], [4, "200000007", "", 40],
      [4, "300000000", "", bound],
      [4, "500000000", "", 0], [2, "500000001", "", 233], [3, "500000002", "", 96],
    ]);
    expect(Buffer.from(objects[3]!.record)).toEqual(cat(piece(1), piece(2), piece(3)));
    expect(Buffer.from(objects[2]!.record)).toEqual(junkCommitment);
    expect(profile.ergoOrdinal(0xffff_ffff, 0xffff_ffff)).toBe((1n << 64n) - 1n);
    expect(() => profile.ergoOrdinal(0x1_0000_0000, 0)).toThrow(EncodingError);
    expect(() => profile.attributeBlock(base, [transaction([{ ergoTree: "0008" as unknown as Uint8Array, registers: {} }])])).toThrow(EncodingError);
  });

  it("answers every kind from the record alone and the reader derives the rules", () => {
    const chain = evidence(spec, 1n, 8n), base = profileOf(chain), verifier = profile.ergoRangeVerifier(base, chain)!;
    expect(verifier).toBeDefined();
    expect(verifier.witnessedIndex()).toBe(6n);
    expect(verifier.lag()).toBe(3n);
    expect(Buffer.from(verifier.identity)).toEqual(Buffer.from(profile.ergoProfileIdentity(base)));

    const commitments = answer(verifier, 1, operator);
    expect(commitments.entries.map(e => [e.index, e.ordinal])).toEqual([[2n, 0n], [3n, 0n], [4n, 0n], [4n, 0n]]);
    expect(Buffer.compare(commitments.entries[2]!.record, commitments.entries[3]!.record)).toBeLessThan(0);
    const held = range.heldCommitments(commitments);
    expect(held.held.map(h => [h.index, h.commitment.sequence])).toEqual([[2n, 1n], [4n, 2n], [4n, 3n]]);
    expect(held.next).toEqual({ fromIndex: 7n, highest: 3n });

    const replacements = answer(verifier, 2, backing);
    expect(range.admittedReplacements(replacements, rule).map(a => a.index)).toEqual([3n]);
    expect(range.admittedReplacements(replacements, undefined)).toHaveLength(0);

    const revocations = answer(verifier, 3, obligor);
    expect(revocations.entries.map(e => e.index)).toEqual([6n, 6n]);
    expect(range.revocationIndex(revocations)).toBe(6n);
    expect(range.firstWitnessed(revocations)).toHaveLength(1);
    expect(range.revocationIndex(answer(verifier, 3, obligor, 0n, 5n))).toBeUndefined();

    const merged = range.mergeVenueOrder([answer(verifier, 4, backing), answer(verifier, 4, backingY)]);
    expect(merged.map(e => [e.index, e.ordinal.toString(16), e.record.length, Buffer.from(e.subject).equals(backingY)]))
      .toEqual([[4n, "100000000", 40, false], [5n, "100000000", 120, false], [5n, "100000004", 40, true]]);

    const empty = answer(verifier, 1, other, 0n, 5n);
    expect(empty.entries).toHaveLength(0);
    expect(verifier.range(request(verifier.identity, 1, other, 0n, 5n), wide)).toHaveLength(102);
    expect(answer(verifier, 1, other, 5n, 6n).entries.map(e => e.index)).toEqual([6n]);
    expect(range.heldCommitments(answer(verifier, 1, other, 6n, 6n), { fromIndex: 6n, highest: 0n }).held.map(h => h.commitment.sequence)).toEqual([7n]);
  });

  it("gives no answer where the evidence does not establish the range", () => {
    const chain = evidence(spec, 1n, 8n), base = profileOf(chain), verifier = profile.ergoRangeVerifier(base, chain)!;
    const ask = (r: Partial<range.RangeRequest>): Uint8Array | undefined =>
      verifier.range({ ...request(verifier.identity, 1, operator), ...r }, wide);
    expect(ask({})).toBeInstanceOf(Uint8Array);
    expect(ask({ toIndex: 7n })).toBeUndefined();
    expect(ask({ venue: b(12) })).toBeUndefined();
    expect(ask({ fromIndex: 7n, toIndex: 6n })).toBeUndefined();
    expect(() => verifier.range(request(verifier.identity, 1, operator, 0n, 4n), { maxBytes: 200n, maxEntries: 8n })).toThrow(range.RangeLimitError);

    // Heights below the first header are answered only from a chain anchored at the genesis.
    const suffix = { headers: chain.headers.slice(2), blocks: chain.blocks.slice(2) };
    const partial = profile.ergoRangeVerifier(base, suffix)!;
    expect(partial).toBeDefined();
    expect(partial.range(request(partial.identity, 1, operator, 0n, 6n), wide)).toBeUndefined();
    expect(partial.range(request(partial.identity, 1, operator, 2n, 6n), wide)).toBeUndefined();
    expect(partial.range(request(partial.identity, 1, operator, 3n, 6n), wide)).toBeInstanceOf(Uint8Array);
    expect(verifier.range(request(verifier.identity, 1, operator, 0n, 0n), wide)).toHaveLength(102);

    // A height without its section leaves every range through it unresolved; other ranges answer.
    const missing = { headers: chain.headers, blocks: chain.blocks.filter(block => !Buffer.from(block.headerId).equals(chain.headers[3]!.id)) };
    const gapped = profile.ergoRangeVerifier(base, missing)!;
    expect(gapped.range(request(gapped.identity, 1, operator, 0n, 6n), wide)).toBeUndefined();
    expect(gapped.range(request(gapped.identity, 1, operator, 5n, 6n), wide)).toBeInstanceOf(Uint8Array);
  });

  it("passes over blocks that are not this chain's sections instead of refusing every read", () => {
    const chain = evidence(spec, 1n, 8n), base = profileOf(chain), verifier = profile.ergoRangeVerifier(base, chain)!;
    const full = Buffer.from(verifier.range(request(verifier.identity, 1, operator), wide)!);
    const through = (v: profile.ErgoRangeVerifier, fromIndex: bigint, toIndex: bigint): Uint8Array | undefined =>
      v.range(request(v.identity, 1, operator, fromIndex, toIndex), wide);
    // A block whose root fails its header, here by another transaction id, supplies no section for its height.
    const idSwapped = structuredClone(chain);
    (idSwapped.blocks[3]!.transactions[0] as { id: Uint8Array }).id = b(7);
    const swapped = profile.ergoRangeVerifier(base, idSwapped)!;
    expect(through(swapped, 0n, 6n)).toBeUndefined();
    expect(through(swapped, 5n, 6n)).toBeInstanceOf(Uint8Array);
    // A header whose root matches no block, or a version under which the section computes another root, likewise.
    const header = (i: number, patch: Partial<profile.ErgoHeaderView>): profile.ErgoRangeEvidence =>
      ({ ...chain, headers: chain.headers.map((h, n) => (n === i ? { ...h, ...patch } : h)) });
    for (const damaged of [header(4, { transactionsRoot: b(0) }), header(4, { version: 1n })]) {
      const v = profile.ergoRangeVerifier(base, damaged)!;
      expect(through(v, 0n, 6n)).toBeUndefined();
      expect(through(v, 0n, 4n)).toBeInstanceOf(Uint8Array);
    }
    // A duplicate section, a block of another chain, an empty section and a root-failing twin change no answer.
    const twin = structuredClone(chain.blocks[3]!);
    (twin.transactions[0] as { id: Uint8Array }).id = b(7);
    const noisy = { ...chain, blocks: [twin, { headerId: b(9), transactions: chain.blocks[0]!.transactions },
      { headerId: chain.headers[0]!.id, transactions: [] }, ...chain.blocks, chain.blocks[3]!] };
    expect(Buffer.from(through(profile.ergoRangeVerifier(base, noisy)!, 0n, 6n)!)).toEqual(full);
    expect(Buffer.from(through(profile.ergoRangeVerifier(base, { ...chain, blocks: [...chain.blocks].reverse() })!, 0n, 6n)!)).toEqual(full);
  });

  it("refuses evidence that is not one linked chain anchored at its genesis", () => {
    const chain = evidence(spec, 1n, 8n), base = profileOf(chain);
    const header = (i: number, patch: Partial<profile.ErgoHeaderView>): profile.ErgoRangeEvidence =>
      ({ ...chain, headers: chain.headers.map((h, n) => (n === i ? { ...h, ...patch } : h)) });
    expect(profile.ergoRangeVerifier(base, header(4, { parentId: b(0) }))).toBeUndefined();
    expect(profile.ergoRangeVerifier(base, header(4, { height: 6n }))).toBeUndefined();
    expect(profile.ergoRangeVerifier(base, header(4, { version: 0n }))).toBeUndefined();
    expect(profile.ergoRangeVerifier(base, header(0, { parentId: b(1) }))).toBeUndefined();
    expect(profile.ergoRangeVerifier({ ...base, genesis: b(1) }, chain)).toBeUndefined();
    expect(profile.ergoRangeVerifier(base, { ...chain, headers: [] })).toBeUndefined();
    expect(profile.ergoRangeVerifier(base, { ...chain, headers: [{ ...chain.headers[0]!, height: 0n }] })).toBeUndefined();
    const stranger = { ...chain, headers: [...chain.headers, { ...chain.headers[7]!, id: b(3) }] };
    expect(profile.ergoRangeVerifier(base, stranger)).toBeUndefined();
    // A chain not starting at the genesis is accepted as the header source's word; version 1 blocks commit ids alone.
    const old = evidence(spec, 3n, 8n, 1n);
    expect(profile.ergoRangeVerifier(profileOf(old), old)).toBeDefined();
    for (const garbage of [{ headers: [{ ...chain.headers[0]!, id: "x" }], blocks: [] }, { headers: chain.headers, blocks: [{ headerId: b(1), transactions: [{ id: b(1), witnessId: b(1), outputs: [] }] }] },
      { headers: chain.headers, blocks: [{ headerId: b(1), transactions: [{ id: b(1), witnessId: b(1, 31), outputs: [{ ergoTree: b(1), registers: { R4: "0e" } }] }] }] }]) {
      expect(() => profile.ergoRangeVerifier(base, garbage as unknown as profile.ErgoRangeEvidence)).toThrow(EncodingError);
    }
  });

  it("owns the profile, the evidence and each request: later reads and mutations change no answer", () => {
    const chain = evidence(spec, 1n, 8n), base = profileOf(chain);
    // A profile whose location changes after the first read: the identity and the attribution use the same bytes.
    let reads = 0;
    const shifting: profile.ErgoProfile = { ...base, scripts: { ...scripts, get 1() { return reads++ === 0 ? scripts[1] : tree(9); } } };
    const verifier = profile.ergoRangeVerifier(shifting, chain)!;
    expect(Buffer.from(verifier.identity)).toEqual(Buffer.from(profile.ergoProfileIdentity(base)));
    const before = Buffer.from(verifier.range(request(verifier.identity, 1, operator), wide)!);
    expect(range.decodeRangeAnswer(before, request(verifier.identity, 1, operator), wide).entries).toHaveLength(4);
    // A request whose fields change after their single read answers the request as first read.
    let subjectReads = 0, toReads = 0;
    const drifting = { venue: verifier.identity, kind: 1 as const, fromIndex: 0n,
      get subject() { return subjectReads++ === 0 ? operator : other; }, get toIndex() { return toReads++ === 0 ? 4n : 8n; } };
    const drifted = verifier.range(drifting, wide)!;
    const decoded = range.decodeRangeAnswer(drifted, request(verifier.identity, 1, operator, 0n, 4n), wide);
    expect(decoded.entries.map(e => e.index)).toEqual([2n, 3n, 4n, 4n]);
    // Evidence mutated after construction.
    chain.blocks[1]!.transactions[0]!.outputs[1]!.registers["R5"]!.fill(0);
    (chain.headers[7] as { height: bigint }).height = 100n;
    (chain.blocks as profile.ErgoBlockView[]).length = 0;
    expect(Buffer.from(verifier.range(request(verifier.identity, 1, operator), wide)!)).toEqual(before);
    expect(verifier.witnessedIndex()).toBe(6n);
    const copy = verifier.identity; copy.fill(0);
    expect(Buffer.from(verifier.identity)).not.toEqual(Buffer.from(copy));
  });
});
