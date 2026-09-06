import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { EncodingError } from "../src/bytes.js";
import { utf8Encoder } from "../src/contexts.js";
import {
  decodeSpentProof,
  EMPTY_SPENT_ROOT,
  EMPTY_SPENT_SUBTREE,
  encodeSpentProof,
  SPENT_SET_HEIGHT,
  spentLeaf,
  spentNode,
  spentProofProves,
  SpentSet,
} from "../src/pool/spent-set.js";

// pool-v2 §11: a 256-high sparse Merkle tree over SHA-256, keyed by the
// nullifier's bytes, with membership and non-membership proofs in the clear,
// sent as a 32-byte map of omitted empty siblings plus the rest.

const key = (...bytes: [number, number][]): Uint8Array => {
  const out = new Uint8Array(32);
  for (const [index, value] of bytes) out[index] = value;
  return out;
};

describe("pool-v2 §11: the spent set", () => {
  it("frames its leaves and nodes as specified and builds the empty subtrees", () => {
    const nf = key([31, 1]);
    expect(spentLeaf(nf)).toEqual(sha256(Buffer.concat([utf8Encoder.encode("moe/pool/v2/spent/leaf"), nf])));
    const left = new Uint8Array(32).fill(1);
    const right = new Uint8Array(32).fill(2);
    expect(spentNode(left, right)).toEqual(sha256(Buffer.concat([utf8Encoder.encode("moe/pool/v2/spent/node"), left, right])));
    expect(spentNode(left, right)).not.toEqual(spentNode(right, left));
    expect(EMPTY_SPENT_SUBTREE[0]).toEqual(new Uint8Array(32));
    expect(EMPTY_SPENT_SUBTREE).toHaveLength(SPENT_SET_HEIGHT + 1);
    for (let h = 0; h < SPENT_SET_HEIGHT; h++) {
      const e = EMPTY_SPENT_SUBTREE[h] as Uint8Array;
      expect(EMPTY_SPENT_SUBTREE[h + 1]).toEqual(spentNode(e, e));
    }
    expect(new SpentSet().root()).toEqual(EMPTY_SPENT_ROOT);
    expect(() => spentLeaf(new Uint8Array(31))).toThrow(EncodingError);
  });

  it("proves non-membership of every key in the empty set with a 32-byte proof", () => {
    const empty = new SpentSet();
    for (const nf of [key(), key([0, 0x80]), key([31, 1]), new Uint8Array(32).fill(0xff)]) {
      const proof = empty.proof(nf);
      expect(proof).toHaveLength(32);
      expect(spentProofProves(EMPTY_SPENT_ROOT, nf, proof, false)).toBe(true);
      expect(spentProofProves(EMPTY_SPENT_ROOT, nf, proof, true)).toBe(false);
    }
  });

  it("inserts, then proves membership of members and non-membership of the rest against one root", () => {
    const set = new SpentSet();
    const members = [key([0, 0x80]), key([0, 0x80], [31, 1]), key([31, 1]), key([15, 0x10])];
    const strangers = [key(), key([0, 0x40]), key([31, 2]), new Uint8Array(32).fill(0xff)];
    for (const nf of members) set.insert(nf);
    expect(set.size).toBe(4n);
    const root = set.root();
    expect(root).not.toEqual(EMPTY_SPENT_ROOT);
    for (const nf of members) {
      expect(set.has(nf)).toBe(true);
      const proof = set.proof(nf);
      expect(spentProofProves(root, nf, proof, true)).toBe(true);
      expect(spentProofProves(root, nf, proof, false)).toBe(false);
      expect(spentProofProves(EMPTY_SPENT_ROOT, nf, proof, true)).toBe(false);
    }
    for (const nf of strangers) {
      expect(set.has(nf)).toBe(false);
      const proof = set.proof(nf);
      expect(spentProofProves(root, nf, proof, false)).toBe(true);
      expect(spentProofProves(root, nf, proof, true)).toBe(false);
    }
    // The root binds the whole set: one more member and every proof is stale.
    set.insert(key([31, 2]));
    expect(spentProofProves(set.root(), members[0] as Uint8Array, set.proof(members[0] as Uint8Array), true)).toBe(true);
    expect(spentProofProves(root, key([31, 2]), set.proof(key([31, 2])), true)).toBe(false);
  });

  it("tells keys apart by their most significant bit at the root and least significant at the leaf", () => {
    // Two keys differing only in bit 0 (the MSB) part at the root's children,
    // so each is the other's sibling at height 255; two keys differing only in
    // bit 255 (the LSB) are siblings at height 0.
    const set = new SpentSet();
    const a = key([0, 0x80]);
    const b = key();
    set.insert(a);
    const siblingsOfB = decodeSpentProof(set.proof(b));
    expect(siblingsOfB[255]).not.toEqual(EMPTY_SPENT_SUBTREE[255]);
    expect(siblingsOfB.slice(0, 255).every((s, h) => Buffer.compare(s, EMPTY_SPENT_SUBTREE[h] as Uint8Array) === 0)).toBe(true);
    const set2 = new SpentSet();
    set2.insert(key([31, 1]));
    const siblingsOfZero = decodeSpentProof(set2.proof(key()));
    expect(siblingsOfZero[0]).toEqual(spentLeaf(key([31, 1])));
    expect(siblingsOfZero.slice(1).every((s, h) => Buffer.compare(s, EMPTY_SPENT_SUBTREE[h + 1] as Uint8Array) === 0)).toBe(true);
  });

  it("proves non-membership of a stranger sharing a long prefix with a member, on either side of it", () => {
    const set = new SpentSet();
    const member = key([0, 0xab], [1, 0xcd], [31, 0x01]);
    set.insert(member);
    const root = set.root();
    const strangers = [
      key([0, 0xab], [1, 0xcd], [31, 0x00]), key([0, 0xab], [1, 0xcd], [31, 0x03]),
      key([0, 0xab], [1, 0xcc]), key([0, 0xab], [1, 0xcd], [31, 0x81]), key([0, 0x2b], [1, 0xcd], [31, 0x01]),
    ];
    for (const stranger of strangers) {
      expect(spentProofProves(root, stranger, set.proof(stranger), false)).toBe(true);
      expect(spentProofProves(root, stranger, set.proof(stranger), true)).toBe(false);
    }
    // The strangers join one by one; every member and the rest still prove.
    for (const [i, nf] of strangers.entries()) {
      set.insert(nf);
      for (const joined of [member, ...strangers.slice(0, i + 1)]) {
        expect(spentProofProves(set.root(), joined, set.proof(joined), true)).toBe(true);
        expect(spentProofProves(set.root(), joined, set.proof(joined), false)).toBe(false);
      }
      for (const waiting of strangers.slice(i + 1)) {
        expect(spentProofProves(set.root(), waiting, set.proof(waiting), false)).toBe(true);
      }
    }
    expect(set.size).toBe(6n);
  });

  it("holds hundreds of keys with proofs for every member and for strangers, at a cost that stays flat", () => {
    const set = new SpentSet();
    const keys = Array.from({ length: 300 }, (_, i) => sha256(new Uint8Array([i & 0xff, i >> 8])));
    const start = performance.now();
    for (const nf of keys) set.insert(nf);
    const insertMs = performance.now() - start;
    expect(set.size).toBe(300n);
    const root = set.root();
    for (const nf of keys.filter((_, i) => i % 29 === 0)) {
      expect(set.has(nf)).toBe(true);
      expect(spentProofProves(root, nf, set.proof(nf), true)).toBe(true);
      expect(spentProofProves(root, nf, set.proof(nf), false)).toBe(false);
    }
    for (let i = 300; i < 310; i++) {
      const stranger = sha256(new Uint8Array([i & 0xff, i >> 8]));
      expect(set.has(stranger)).toBe(false);
      expect(spentProofProves(root, stranger, set.proof(stranger), false)).toBe(true);
    }
    // A generous bound, so a regression to hundreds of hashes per key shows.
    expect(insertMs).toBeLessThan(5_000);
  });

  it("hands out copies: a decoded proof and the exported empty subtrees are not its state", () => {
    const set = new SpentSet();
    const nf = key([31, 1]);
    const decoded = decodeSpentProof(set.proof(nf));
    (decoded[5] as Uint8Array)[0] = 0xff;
    expect(spentProofProves(EMPTY_SPENT_ROOT, nf, set.proof(nf), false)).toBe(true);
    const exported = EMPTY_SPENT_SUBTREE[3] as Uint8Array;
    const kept = exported[0] as number;
    exported[0] = kept ^ 0xff;
    expect(spentProofProves(EMPTY_SPENT_ROOT, nf, set.proof(nf), false)).toBe(true);
    exported[0] = kept;
    // The question must be a boolean: any other value is answered false.
    expect(spentProofProves(EMPTY_SPENT_ROOT, nf, set.proof(nf), "false" as unknown as boolean)).toBe(false);
    expect(spentProofProves(EMPTY_SPENT_ROOT, nf, set.proof(nf), 1 as unknown as boolean)).toBe(false);
  });

  it("encodes proofs canonically and refuses a map that disagrees with its siblings", () => {
    const set = new SpentSet();
    set.insert(key([31, 1]));
    const nf = key();
    const proof = set.proof(nf);
    expect(proof).toHaveLength(64);
    const siblings = decodeSpentProof(proof);
    expect(encodeSpentProof(siblings)).toEqual(proof);
    // Height 0's sibling is sent, so the map's bit 0 (the most significant) is clear; all others set.
    expect(proof[0]).toBe(0x7f);
    expect(proof.subarray(1, 32).every((b) => b === 0xff)).toBe(true);
    // Sent but equal to e_0: malformed. Omitted but not empty: the root simply differs.
    const sendsEmpty = new Uint8Array(64);
    sendsEmpty.set(proof.subarray(0, 32));
    expect(() => decodeSpentProof(sendsEmpty)).toThrow(EncodingError);
    expect(spentProofProves(set.root(), nf, sendsEmpty, false)).toBe(false);
    const omitsAll = new Uint8Array(32).fill(0xff);
    expect(spentProofProves(set.root(), nf, omitsAll, false)).toBe(false);
    expect(spentProofProves(EMPTY_SPENT_ROOT, nf, omitsAll, false)).toBe(true);
    // Wrong lengths: short, unaligned, trailing, and a map claiming more siblings than are sent.
    expect(() => decodeSpentProof(proof.subarray(0, 31))).toThrow(EncodingError);
    expect(() => decodeSpentProof(proof.subarray(0, 63))).toThrow(EncodingError);
    expect(() => decodeSpentProof(new Uint8Array([...proof, ...new Uint8Array(32).fill(3)]))).toThrow(EncodingError);
    const claimsTwo = new Uint8Array(proof);
    claimsTwo[0] = 0x3f;
    expect(() => decodeSpentProof(claimsTwo)).toThrow(EncodingError);
    expect(() => encodeSpentProof(siblings.slice(1))).toThrow(EncodingError);
    expect(() => encodeSpentProof(siblings.map((s, i) => (i === 3 ? new Uint8Array(31) : s)))).toThrow(EncodingError);
    // A verifier answers false, never throws, for a malformed proof or key.
    expect(spentProofProves(set.root(), nf, new Uint8Array(0), false)).toBe(false);
    expect(spentProofProves(set.root(), new Uint8Array(31), proof, false)).toBe(false);
    expect(spentProofProves(new Uint8Array(31), nf, proof, false)).toBe(false);
  });

  it("refuses a second insertion of one key and a key of the wrong width", () => {
    const set = new SpentSet();
    set.insert(key([31, 1]));
    expect(() => set.insert(key([31, 1]))).toThrow(EncodingError);
    expect(() => set.insert(new Uint8Array(33))).toThrow(EncodingError);
    expect(() => set.has(new Uint8Array(0))).toThrow(EncodingError);
    expect(set.size).toBe(1n);
    // The root is handed out as a copy.
    const root = set.root();
    root[0] = (root[0] as number) ^ 1;
    expect(set.root()).not.toEqual(root);
  });
});
