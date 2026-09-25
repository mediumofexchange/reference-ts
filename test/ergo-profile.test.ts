import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { describe, expect, it } from "vitest";
import * as profile from "../src/ergo-profile.js";
import * as range from "../src/record-range.js";
import { EncodingError } from "../src/bytes.js";
import { encodeCommitment, signCommitment } from "../src/commitment.js";
import { encodeReplacement, replacementMessage, ROLE_OPERATOR } from "../src/replacement.js";
import { encodeRevocation, signRevocation } from "../src/revocation.js";

// Synthetic block sections: real signed records inside register constants,
// in transactions written here in the node's unsigned serialization, each
// section read against its own transaction root. No Ergo library or node is
// involved; header authentication and the venue's clock are ErgoVenue's
// (ergo-venue.test.ts), and the supplier tests reproduce real mainnet roots.
const cat = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const sha = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();
const b = (n: number, width = 32): Buffer => Buffer.alloc(width, n);
const tree = (kind: number): Buffer => Buffer.from(`0008cd02${"ab".repeat(31)}0${kind}`, "hex");
const scripts = { 1: tree(1), 2: tree(2), 3: tree(3), 4: tree(4) } as const;
const MINER_FEE = Buffer.from(profile.MINER_FEE_TREE_HEX, "hex");
// SHA-256 of the fee tree as mainnet block 1,876,512's fee output carries it (experiments/ergo-range/fixtures).
const MINER_FEE_SHA256 = "744c727d6a1478912d1e7052957c2ba466bf9a5a89e9347309a58e2032473278";
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

// Outputs and transactions are written here, independently of the framer, in
// the pinned node's unsigned transaction serialization: registers are R4
// onward in order, every input has an empty proof.
interface Output { readonly ergoTree: Uint8Array; readonly registers: readonly Uint8Array[]; readonly tokens?: readonly (readonly [number, bigint])[] }
const output = (ergoTree: Uint8Array, registers: readonly Uint8Array[] = []): Output => ({ ergoTree, registers });
const record = (kind: 1 | 2 | 3 | 4, subject: Uint8Array, bytes: Uint8Array, extra: readonly Uint8Array[] = []): Output =>
  output(scripts[kind], [coll(subject), coll(bytes), ...extra]);
const plain = output(Buffer.from("0008cd03" + "cc".repeat(32), "hex"));
const bigVlq = (n: bigint): Buffer => {
  const out: number[] = [];
  do { let byte = Number(n & 0x7fn); n >>= 7n; if (n > 0n) byte |= 0x80; out.push(byte); } while (n > 0n);
  return Buffer.from(out);
};
interface Shape { readonly extension?: readonly Uint8Array[]; readonly dataInputs?: number; readonly tokenIds?: number; readonly inputs?: number }
function unsignedBytes(outputs: readonly Output[], seed: string, shape: Shape = {}): Buffer {
  const extension = shape.extension ?? [], inputs = shape.inputs ?? 1;
  const input = (i: number): Buffer => cat(sha(Buffer.from(`${seed}-${i}`)), vlq(0), Uint8Array.of(extension.length),
    ...extension.flatMap((value, key) => [Uint8Array.of(key), value]));
  return cat(vlq(inputs), ...Array.from({ length: inputs }, (_x, i) => input(i)),
    vlq(shape.dataInputs ?? 0), ...Array.from({ length: shape.dataInputs ?? 0 }, (_x, i) => sha(Buffer.from(`${seed}-data-${i}`))),
    vlq(shape.tokenIds ?? 0), ...Array.from({ length: shape.tokenIds ?? 0 }, (_x, i) => sha(Buffer.from(`${seed}-token-${i}`))),
    vlq(outputs.length), ...outputs.map(o => cat(bigVlq(1_000_000n), o.ergoTree, vlq(2_000_000), Uint8Array.of((o.tokens ?? []).length),
      ...(o.tokens ?? []).map(([index, amount]) => cat(vlq(index), bigVlq(amount))), Uint8Array.of(o.registers.length), ...o.registers)));
}
let counter = 0;
const transaction = (outputs: readonly Output[], shape: Shape = {}): profile.ErgoTransactionView => {
  const seed = `tx-${counter++}`;
  return { unsigned: unsignedBytes(outputs, seed, shape), witnessId: blake2b(Buffer.from(seed), { dkLen: 32 }).subarray(1) };
};
const committed = (t: profile.ErgoTransactionView): { id: Uint8Array; witnessId: Uint8Array } => ({ id: blake2b(t.unsigned, { dkLen: 32 }), witnessId: t.witnessId });
/** A section's root under `version`'s rule, over its transactions' ids (and, but for version 1, witness ids). */
const rootOf = (transactions: readonly profile.ErgoTransactionView[], version = 3n): Uint8Array =>
  profile.transactionsRoot(version, transactions.map(committed));
/** The profile under test; its anchor names no chain here, since sections are read directly. */
const base: profile.ErgoProfile = { anchor: b(99), depth: 2n, scripts };
const identity = profile.ergoProfileIdentity(base);
interface Spec { readonly [index: string]: Output[][] }
/** Indices 0 through `to`; each block's transactions from the spec, else one plain transaction. */
function sections(spec: Spec, to: bigint): profile.ErgoTransactionView[][] {
  const out: profile.ErgoTransactionView[][] = [];
  for (let index = 0n; index <= to; index++) out.push((spec[index.toString()] ?? [[plain]]).map(outputs => transaction(outputs)));
  return out;
}
const request = (kind: range.RecordKind, subject: Uint8Array, fromIndex = 0n, toIndex = 6n): range.RangeRequest =>
  ({ venue: identity, kind, subject, fromIndex, toIndex });
/** §7's answer as a reader holding these sections derives it: each section read against its own root. */
function answer(blocks: readonly profile.ErgoTransactionView[][], kind: range.RecordKind, subject: Uint8Array, fromIndex = 0n, toIndex = 6n): range.RangeAnswer {
  const attributed = blocks.map(transactions => profile.attributeSection(base, transactions, rootOf(transactions)));
  const r = request(kind, subject, fromIndex, toIndex), entries = profile.rangeEntries(i => attributed[Number(i)], r);
  expect(entries).toBeDefined();
  return range.decodeRangeAnswer(range.encodeRangeAnswer({ request: r, entries: entries! }, wide), r, wide);
}

// A record whose bytes are the right length but whose signature is nobody's: carried, never held.
const junkCommitment = cat(commitment(2n).subarray(0, 72), b(0, 64));
const junkCommitmentA = cat(Buffer.from(commitment(2n)).subarray(0, 8), b(1, 32), operator, b(0, 64));
const piece = (n: number, length = 40): Buffer => b(n, length);
const spec: Spec = {
  2: [[plain, record(1, operator, commitment(1n))]],
  3: [[record(2, backing, replacement(30n)), record(1, operator, junkCommitmentA, [coll(b(2, 3))])]],
  4: [[record(1, operator, commitment(3n)), record(1, operator, commitment(2n))], [record(4, backing, piece(1))]],
  5: [[plain], [record(4, backing, piece(2)), record(4, backing, piece(3)), record(4, backing, piece(4)), plain, record(4, backingY, piece(5))]],
  6: [[record(3, obligor, revocation), record(3, obligor, revocation), record(1, other, commitment(7n, otherSecret))]],
  7: [[record(1, operator, commitment(9n))]],
};

describe("Ergo venue-profile candidate", () => {
  it("names the venue by anchor, depth and every kind's location", () => {
    expect(identity).toHaveLength(32);
    expect(profile.ergoLag(base)).toBe(3n);
    const variants: profile.ErgoProfile[] = [
      { ...base, anchor: b(5) }, { ...base, depth: 3n },
      ...([1, 2, 3, 4] as const).map(kind => ({ ...base, scripts: { ...scripts, [kind]: tree(kind + 4) } })),
      { ...base, scripts: { ...scripts, 4: Buffer.from("0b03d17301", "hex") } },
    ];
    for (const variant of variants) expect(Buffer.from(profile.ergoProfileIdentity(variant))).not.toEqual(Buffer.from(identity));
    expect(() => profile.ergoProfileIdentity({ ...base, scripts: { ...scripts, 2: scripts[1] } })).toThrow(/one location/);
    // A location is exactly one tree the framer reads: sized, pay-to-public-key or the fee tree, nothing more or less.
    for (const wrong of [new Uint8Array(0), cat(scripts[3], Uint8Array.of(0)), scripts[3].subarray(0, 35), Buffer.from("0b04d17301", "hex"),
      Buffer.from("1005040004000e36", "hex"), Buffer.from("8b03d17301", "hex")]) {
      expect(() => profile.ergoProfileIdentity({ ...base, scripts: { ...scripts, 3: wrong } })).toThrow(EncodingError);
    }
    expect(() => profile.ergoProfileIdentity({ ...base, anchor: b(1, 31) })).toThrow(EncodingError);
    // The all-zero id names no header, so it would name no chain.
    expect(() => profile.ergoProfileIdentity({ ...base, anchor: new Uint8Array(32) })).toThrow(EncodingError);
    expect(() => profile.ergoProfileIdentity({ ...base, depth: (1n << 64n) - 1n })).toThrow(EncodingError);
  });

  it("hashes venue-ergo's context unless the profile names a reference context from the closed set", () => {
    const u32 = (n: number): Buffer => { const out = Buffer.alloc(4); out.writeUInt32BE(n); return out; };
    const u64 = (n: bigint): Buffer => { const out = Buffer.alloc(8); out.writeBigUInt64BE(n); return out; };
    const prefixed = (bytes: Uint8Array): Buffer => cat(u32(bytes.length), bytes);
    const expected = (context: string): Buffer => sha(cat(prefixed(Buffer.from(context, "utf8")), base.anchor, u64(base.depth),
      ...([1, 2, 3, 4] as const).map(kind => prefixed(scripts[kind]))));
    expect(profile.ERGO_PROFILE_CONTEXT).toBe("moe/venue/ergo/v3");
    expect(Buffer.from(profile.ergoProfileIdentity(base))).toEqual(expected("moe/venue/ergo/v3"));
    const synthetic: profile.ErgoProfile = { ...base, reference: profile.ERGO_SYNTHETIC_REFERENCE };
    expect(Buffer.from(profile.ergoProfileIdentity(synthetic))).toEqual(expected("moe/venue/ergo-synthetic/reference"));
    expect(profile.ownErgoProfile(synthetic).reference).toBe(profile.ERGO_SYNTHETIC_REFERENCE);
    expect("reference" in profile.ownErgoProfile(base)).toBe(false);
    // Any other context, venue-ergo's own spelled out included, is not in the set.
    for (const reference of ["moe/venue/ergo/v3", "moe/venue/ergo-testnet/reference", "moe/venue/local/reference", "", null, 1]) {
      expect(() => profile.ergoProfileIdentity({ ...base, reference } as unknown as profile.ErgoProfile)).toThrow(EncodingError);
    }
  });

  it("reads only exact Coll[Byte] constants with minimal lengths", () => {
    const long = b(9, 136);
    expect(Buffer.from(profile.collBytes(coll(long))!)).toEqual(long);
    expect(Buffer.from(coll(long)).subarray(0, 3)).toEqual(Buffer.from("0e8801", "hex"));
    expect(profile.collBytes(coll(new Uint8Array(0)))).toHaveLength(0);
    const constant = coll(long), read = profile.collBytes(constant)!;
    constant.fill(0);
    expect(Buffer.from(read)).toEqual(long);
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
    const transactions = [transaction([plain]), transaction([plain])].map(committed);
    const idsOnly = Buffer.from(profile.merkleRoot(transactions.map(t => t.id)));
    expect(Buffer.from(profile.transactionsRoot(1n, transactions))).toEqual(idsOnly);
    // Every other version byte, 0 and 128–255 included, commits to the witness ids too, as the node reads it.
    const withWitness = Buffer.from(profile.merkleRoot([...transactions.map(t => t.id), ...transactions.map(t => t.witnessId)]));
    for (const version of [0n, 2n, 3n, 5n, 128n, 255n]) expect(Buffer.from(profile.transactionsRoot(version, transactions))).toEqual(withWitness);
  });

  it("attributes by location and shape, reassembles runs and omits nothing else", () => {
    const big = piece(6, 4000), bound = range.MAX_RANGE_RECORD_BYTES[4];
    const exactly = [...Array(32).fill(big), piece(7, bound - 32 * 4000)], over = [...Array(33).fill(big)];
    const objects = profile.attributeBlock(base, [
      transaction([plain, record(1, operator, commitment(1n)), record(1, operator, commitment(1n))]),
      transaction([
        output(scripts[1], [coll(commitment(1n))]),
        record(1, b(1, 31), commitment(1n)),
        output(scripts[1], [coll(operator)]),
        record(1, operator, commitment(1n).subarray(0, 135)),
        record(2, backing, replacement(30n).subarray(0, 232)),
        record(3, obligor, cat(revocation, Uint8Array.of(0))),
        output(Buffer.from("0008cd02" + "ab".repeat(32), "hex"), [coll(operator), coll(commitment(1n))]),
        output(MINER_FEE, [coll(operator), coll(commitment(1n))]),
        record(1, operator, junkCommitment, [coll(b(1)), coll(new Uint8Array(0)), coll(b(2)), coll(b(3))]),
      ], { extension: [coll(b(4)), coll(new Uint8Array(0))], dataInputs: 2, tokenIds: 1, inputs: 3 }),
      transaction([record(4, backing, piece(1)), record(4, backing, piece(2)), record(4, backing, piece(3)), plain,
        record(4, backing, piece(4)), record(4, backingY, piece(5)), record(1, operator, commitment(2n)), record(4, backing, piece(6))]),
      transaction(exactly.map(p => record(4, backing, p))),
      transaction(over.map(p => record(4, backing, p))),
      transaction([record(4, backing, new Uint8Array(0)), record(2, backing, replacement(31n)), record(3, obligor, revocation)]),
      // Outside the framer's grammar (a register of another type), so none of its records is read.
      transaction([record(1, operator, commitment(5n)), record(1, operator, commitment(6n), [Buffer.from("0502", "hex")])]),
      // Sized locations and trees, tokens and a fee output are read like any other.
      transaction([output(Buffer.from("0b03d17301", "hex")), { ...record(1, operator, commitment(7n)), tokens: [[0, 1n], [1, (1n << 64n) - 1n]] },
        output(MINER_FEE)], { tokenIds: 2 }),
    ]);
    const summary = objects.map(o => [o.kind, o.ordinal.toString(16), Buffer.from(o.subject).equals(backingY) ? "Y" : "", o.record.length]);
    expect(summary).toEqual([
      [1, "1", "", 136], [1, "2", "", 136],
      [1, "100000008", "", 136],
      [4, "200000000", "", 120], [4, "200000004", "", 40], [4, "200000005", "Y", 40], [1, "200000006", "", 136], [4, "200000007", "", 40],
      [4, "300000000", "", bound],
      [4, "500000000", "", 0], [2, "500000001", "", 233], [3, "500000002", "", 96],
      [1, "700000001", "", 136],
    ]);
    expect(Buffer.from(objects[3]!.record)).toEqual(cat(piece(1), piece(2), piece(3)));
    expect(Buffer.from(objects[2]!.record)).toEqual(junkCommitment);
    expect(profile.ergoOrdinal(0xffff_ffff, 0xffff_ffff)).toBe((1n << 64n) - 1n);
    expect(() => profile.ergoOrdinal(0x1_0000_0000, 0)).toThrow(EncodingError);
    for (const malformed of [{ unsigned: "00", witnessId: b(1, 31) }, { unsigned: b(1), witnessId: b(1) }, null]) {
      expect(() => profile.attributeBlock(base, [malformed as unknown as profile.ErgoTransactionView])).toThrow(EncodingError);
    }
  });

  it("frames the node's unsigned transaction serialization and nothing else", () => {
    const outputs = [record(1, operator, commitment(1n), [coll(b(5, 200))]), { ...plain, tokens: [[2, 7n]] as const }, output(MINER_FEE),
      output(Buffer.from("0f8101" + "00".repeat(129), "hex"))];
    const shape = { extension: [coll(b(4))], dataInputs: 1, tokenIds: 3, inputs: 2 };
    const bytes = unsignedBytes(outputs, "frame", shape);
    const framed = profile.frameTransaction(bytes)!;
    expect(framed.map(o => [Buffer.from(o.ergoTree).toString("hex"), Object.entries(o.registers).map(([name, v]) => [name, Buffer.from(v).toString("hex")])]))
      .toEqual(outputs.map(o => [Buffer.from(o.ergoTree).toString("hex"), o.registers.map((v, i) => [`R${4 + i}`, Buffer.from(v).toString("hex")])]));
    // Every proper prefix, any suffix and a nonempty proof leave the grammar, and nothing throws.
    for (let n = 0; n < bytes.length; n++) expect(profile.frameTransaction(bytes.subarray(0, n))).toBeUndefined();
    expect(profile.frameTransaction(cat(bytes, Uint8Array.of(0)))).toBeUndefined();
    const withProof = Buffer.from(bytes); withProof[1 + 32] = 1;
    expect(profile.frameTransaction(withProof)).toBeUndefined();
    const reject = (os: readonly Output[], s: Shape = {}): void => expect(profile.frameTransaction(unsignedBytes(os, "reject", s))).toBeUndefined();
    // Values other than Coll[Byte] constants, in a register or an extension; more than six registers; an extension above 127 entries.
    reject([output(plain.ergoTree, [Buffer.from("0400", "hex")])]);
    reject([plain], { extension: [Buffer.from("0400", "hex")] });
    reject([output(plain.ergoTree, Array.from({ length: 7 }, () => coll(b(1))))]);
    reject([plain], { extension: Array.from({ length: 128 }, () => coll(b(1))) });
    expect(profile.frameTransaction(unsignedBytes([plain], "ok", { extension: Array.from({ length: 127 }, () => coll(b(1))) }))).toHaveLength(1);
    // Unsized trees other than pay-to-public-key and the fee tree; reserved header bits; a size past the end.
    for (const tree of ["0008cd02", "10010400d17300", "00d17300", "8b03d17301", "2b03d17301", "4b03d17301"]) reject([output(Buffer.from(tree, "hex"))]);
    const wrongSize = unsignedBytes([output(Buffer.from("0b03d17301", "hex"))], "size");
    wrongSize[wrongSize.indexOf(Buffer.from("0b03d17301", "hex")) + 1] = 0x7f;
    expect(profile.frameTransaction(wrongSize)).toBeUndefined();
    // Nonminimal and overwide VLQs: the input count 2 written as 0x82 0x00, a count past an unsigned short, a VLQ past ten bytes.
    expect(bytes[0]).toBe(2);
    expect(profile.frameTransaction(cat(Buffer.from("8200", "hex"), bytes.subarray(1)))).toBeUndefined();
    expect(profile.frameTransaction(cat(Buffer.from("808004", "hex"), bytes.subarray(1)))).toBeUndefined();
    expect(profile.frameTransaction(Buffer.from("80".repeat(11) + "01", "hex"))).toBeUndefined();
    // A claimed count is never allocated: 65,535 inputs over four bytes, or 2^32 - 1 token ids, fail at the first short read.
    expect(profile.frameTransaction(Buffer.from("ffff0300", "hex"))).toBeUndefined();
    expect(profile.frameTransaction(cat(vlq(0), vlq(0), bigVlq(0xffff_ffffn), b(1, 64)))).toBeUndefined();
    // A u64 value at its bound and one past it.
    const at = (value: bigint): Buffer => cat(vlq(0), vlq(0), vlq(0), vlq(1), bigVlq(value), plain.ergoTree, vlq(1), Uint8Array.of(0, 0));
    expect(profile.frameTransaction(at((1n << 64n) - 1n))).toHaveLength(1);
    expect(profile.frameTransaction(at(1n << 64n))).toBeUndefined();
    for (const garbage of ["x", null, new Uint16Array(4)]) expect(profile.frameTransaction(garbage as unknown as Uint8Array)).toBeUndefined();
    // Unsigned-short widths: a register of 65,535 bytes frames, one of 65,536 does not; so for 65,536 outputs claimed.
    const register = (n: number): Buffer => cat(Uint8Array.of(0x0e), vlq(n), Buffer.alloc(n, 1));
    const withRegister = (n: number): Buffer => cat(vlq(0), vlq(0), vlq(0), vlq(1), bigVlq(1n), plain.ergoTree, vlq(1), Uint8Array.of(0, 1), register(n));
    expect(profile.frameTransaction(withRegister(0xffff))).toHaveLength(1);
    expect(profile.frameTransaction(withRegister(0x10000))).toBeUndefined();
    expect(profile.frameTransaction(cat(vlq(0), vlq(0), vlq(0), vlq(0x10000)))).toBeUndefined();
    // The fee tree is Ergo's miner-fee proposition at minerRewardDelay 720, pinned here by its hash.
    expect(createHash("sha256").update(MINER_FEE).digest("hex")).toBe(MINER_FEE_SHA256);
  });

  it("gives a transaction outside the framer's grammar no record but keeps its block's section", () => {
    const hidden = record(1, operator, commitment(1n), [Buffer.from("0502", "hex")]);
    const blocks = sections({ 0: [[hidden], [record(1, operator, commitment(2n))]], 1: [[hidden]] }, 1n);
    expect(answer(blocks, 1, operator, 0n, 1n).entries.map(e => [e.index, e.ordinal])).toEqual([[0n, 0n]]);
    expect(answer(blocks, 1, operator, 1n, 1n).entries).toHaveLength(0);
    // A section reproduces its root under either rule, so its own serialization, not its header's version, picks the
    // rule: every version supplies its section. The node checks a block's version only at a voting epoch's first
    // block, so any miner can carry any version mid-epoch, and a gate on it would deny every range through the block.
    const transactions = [transaction([record(1, operator, commitment(1n))])];
    const objects = profile.attributeSection(base, transactions, rootOf(transactions))!;
    expect(objects.map(o => [o.kind, o.ordinal])).toEqual([[1, 0n]]);
    for (const version of [0n, 1n, 2n, 4n, 5n, 127n, 128n, 255n]) {
      expect(profile.attributeSection(base, transactions, rootOf(transactions, version))).toEqual(objects);
    }
    // A root over ids and witness ids binds the witness ids; version 1's ids-only root does not.
    const rewitnessed = transactions.map(t => ({ ...t, witnessId: b(9, 31) }));
    expect(profile.attributeSection(base, rewitnessed, rootOf(transactions, 3n))).toBeUndefined();
    expect(profile.attributeSection(base, rewitnessed, rootOf(transactions, 1n))).toEqual(objects);
    // Neither rule over other ids holds.
    expect(profile.attributeSection(base, [transaction([record(1, operator, commitment(1n))])], rootOf(transactions))).toBeUndefined();
  });

  it("answers every kind from the record alone and the reader derives the rules", () => {
    const blocks = sections(spec, 7n);
    expect(profile.ergoLag(base)).toBe(3n);

    const commitments = answer(blocks, 1, operator);
    expect(commitments.entries.map(e => [e.index, e.ordinal])).toEqual([[2n, 0n], [3n, 0n], [4n, 0n], [4n, 0n]]);
    expect(Buffer.compare(commitments.entries[2]!.record, commitments.entries[3]!.record)).toBeLessThan(0);
    const held = range.heldCommitments(commitments);
    expect(held.held.map(h => [h.index, h.commitment.sequence])).toEqual([[2n, 1n], [4n, 2n], [4n, 3n]]);
    expect(held.next).toEqual({ fromIndex: 7n, highest: 3n });

    const replacements = answer(blocks, 2, backing);
    expect(range.admittedReplacements(replacements, rule).map(a => a.index)).toEqual([3n]);
    expect(range.admittedReplacements(replacements, undefined)).toHaveLength(0);

    const revocations = answer(blocks, 3, obligor);
    expect(revocations.entries.map(e => e.index)).toEqual([6n, 6n]);
    expect(range.revocationIndex(revocations)).toBe(6n);
    expect(range.firstWitnessed(revocations)).toHaveLength(1);
    expect(range.revocationIndex(answer(blocks, 3, obligor, 0n, 5n))).toBeUndefined();

    const merged = range.mergeVenueOrder([answer(blocks, 4, backing), answer(blocks, 4, backingY)]);
    expect(merged.map(e => [e.index, e.ordinal.toString(16), e.record.length, Buffer.from(e.subject).equals(backingY)]))
      .toEqual([[4n, "100000000", 40, false], [5n, "100000000", 120, false], [5n, "100000004", 40, true]]);

    const empty = answer(blocks, 1, other, 0n, 5n);
    expect(empty.entries).toHaveLength(0);
    expect(range.encodeRangeAnswer(empty, wide)).toHaveLength(102);
    expect(answer(blocks, 1, other, 5n, 6n).entries.map(e => e.index)).toEqual([6n]);
    expect(range.heldCommitments(answer(blocks, 1, other, 6n, 6n), { fromIndex: 6n, highest: 0n }).held.map(h => h.commitment.sequence)).toEqual([7n]);
  });

  it("answers no range through an index without its section", () => {
    const attributed = sections(spec, 7n).map(transactions => profile.attributeSection(base, transactions, rootOf(transactions)));
    const through = (at: (index: bigint) => readonly profile.AttributedObject[] | undefined, fromIndex: bigint, toIndex: bigint): range.RangeEntry[] | undefined =>
      profile.rangeEntries(at, request(1, operator, fromIndex, toIndex));
    const all = (index: bigint): readonly profile.AttributedObject[] | undefined => attributed[Number(index)];
    expect(through(index => (index === 3n ? undefined : all(index)), 0n, 6n)).toBeUndefined();
    expect(through(index => (index === 3n ? undefined : all(index)), 4n, 6n)!.map(e => e.index)).toEqual([4n, 4n]);
    // Index 0 is a block like any other: without its section the ranges through it are unresolved.
    expect(through(index => (index === 0n ? undefined : all(index)), 0n, 0n)).toBeUndefined();
    expect(through(all, 0n, 0n)).toEqual([]);
    // An answer past the reader's budget is refused, never cut.
    const entries = through(all, 0n, 4n)!;
    expect(() => range.encodeRangeAnswer({ request: request(1, operator, 0n, 4n), entries }, { maxBytes: 200n, maxEntries: 8n })).toThrow(range.RangeLimitError);
  });

  it("reads a section only where it reproduces its header's root", () => {
    const transactions = sections(spec, 7n)[4]!, root = rootOf(transactions), full = profile.attributeSection(base, transactions, root)!;
    expect(full).toHaveLength(3);
    // One flipped unsigned byte, a transaction dropped, the order changed or a foreign root: not this header's section.
    const flipped = transactions.map((t, i) => (i === 0 ? { ...t, unsigned: Uint8Array.from(t.unsigned, (x, j) => (j === 40 ? x ^ 1 : x)) } : t));
    expect(profile.attributeSection(base, flipped, root)).toBeUndefined();
    expect(profile.attributeSection(base, transactions.slice(1), root)).toBeUndefined();
    expect(profile.attributeSection(base, [...transactions].reverse(), root)).toBeUndefined();
    expect(profile.attributeSection(base, transactions, b(0))).toBeUndefined();
    // An empty section, a malformed view, a non-array and a malformed root are no section, and nothing throws.
    expect(profile.attributeSection(base, [], root)).toBeUndefined();
    expect(profile.attributeSection(base, [{ unsigned: transactions[0]!.unsigned, witnessId: b(1) }], root)).toBeUndefined();
    expect(profile.attributeSection(base, null as unknown as profile.ErgoTransactionView[], root)).toBeUndefined();
    expect(profile.attributeSection(base, transactions, b(0, 31))).toBeUndefined();
    expect(profile.attributeSection(base, transactions, root)).toEqual(full);
  });

  it("owns the profile and each transaction view: a later read changes no attribution", () => {
    const transactions = sections(spec, 7n)[4]!, root = rootOf(transactions), expected = profile.attributeSection(base, transactions, root);
    // A profile whose location changes after the first read: the identity and the attribution use the same bytes.
    let reads = 0;
    const shifting: profile.ErgoProfile = { ...base, scripts: { ...scripts, get 1() { return reads++ === 0 ? scripts[1] : tree(9); } } };
    expect(profile.attributeSection(shifting, transactions, root)).toEqual(expected);
    // A transaction view whose fields change after their single read.
    let bytesReads = 0, witnessReads = 0;
    const [first, ...rest] = transactions, otherBytes = unsignedBytes([record(1, operator, commitment(8n))], "other");
    const drifting = { get unsigned() { return bytesReads++ === 0 ? first!.unsigned : otherBytes; },
      get witnessId() { return witnessReads++ === 0 ? first!.witnessId : b(7, 31); } };
    expect(profile.attributeSection(base, [drifting, ...rest], root)).toEqual(expected);
    expect([bytesReads, witnessReads]).toEqual([1, 1]);
    // Views mutated after attribution change no object.
    const copy = transactions.map(t => ({ unsigned: new Uint8Array(t.unsigned), witnessId: new Uint8Array(t.witnessId) }));
    const objects = profile.attributeSection(base, copy, root)!;
    copy.forEach(t => t.unsigned.fill(0));
    expect(objects).toEqual(expected);
  });
});
