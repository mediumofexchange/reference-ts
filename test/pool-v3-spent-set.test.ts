import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RadixSpentSet } from "../src/pool/v3/spent-set.js";

// pool-spent C1.2.8–9 at 78f8a8c, checked against an independent batch oracle.
const hash = (...bytes: Uint8Array[]): Uint8Array => new Uint8Array(createHash("sha256").update(Buffer.concat(bytes)).digest());
const domain = (name: string): Uint8Array => Buffer.from(`moe/pool/v3/spent/${name}`, "utf8");
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const key = (n: bigint): Uint8Array => new Uint8Array(Buffer.from(n.toString(16).padStart(64, "0"), "hex"));
const randomKey = (n: number): Uint8Array => hash(Buffer.from(`A22/key/${n}`));
const bit = (k: Uint8Array, b: number): number => k[b >> 3]! & (128 >> (b & 7));

// Independent batch definition: sort once, split by the extrema's first
// differing bit, recurse over slices. No incremental candidate helpers.
function oracle(input: readonly Uint8Array[]): Uint8Array {
  const keys = [...new Map(input.map(k => [hex(k), k])).values()].sort(Buffer.compare);
  const root = (keys: Uint8Array[]): Uint8Array => {
    if (keys.length === 0) return hash(domain("empty"));
    if (keys.length === 1) return hash(domain("leaf"), keys[0]!);
    let b = 0;
    while (bit(keys[0]!, b) === bit(keys.at(-1)!, b)) b++;
    const pivot = keys.findIndex(k => bit(k, b) !== 0);
    expect(pivot > 0 && b < 256).toBe(true);
    return hash(domain("node"), Uint8Array.of(b >> 8, b & 255), root(keys.slice(0, pivot)), root(keys.slice(pivot)));
  };
  return root(keys);
}
const build = (keys: readonly Uint8Array[]): RadixSpentSet => {
  const set = new RadixSpentSet();
  for (const k of keys) set.insert(k);
  return set;
};

describe("the v3 spent root", () => {
  it("pins the empty, singleton and branch frames", () => {
    expect(build([]).root()).toEqual(hash(domain("empty")));
    expect(build([key(0n)]).root()).toEqual(hash(domain("leaf"), key(0n)));
    for (const b of [0n, 1n, 127n, 254n, 255n]) {
      const keys = [key(0n), key(1n << (255n - b))];
      expect(build(keys).root()).toEqual(hash(domain("node"), Uint8Array.of(Number(b >> 8n), Number(b & 255n)),
        hash(domain("leaf"), keys[0]!), hash(domain("leaf"), keys[1]!)));
    }
  });

  it("gives one root under all 120 orders of a boundary set", () => {
    const keys = [key(0n), key(1n), key(2n), key(1n << 255n), key((1n << 256n) - 1n)];
    const expected = oracle(keys);
    let orders = 0;
    const permutations = (remaining: Uint8Array[], prefix: Uint8Array[] = []): void => {
      if (!remaining.length) { expect(build(prefix).root()).toEqual(expected); orders++; return; }
      for (let i = 0; i < remaining.length; i++) permutations(remaining.filter((_, j) => i !== j), [...prefix, remaining[i]!]);
    };
    permutations(keys);
    expect(orders).toBe(120);
  });

  it("matches the oracle on every prefix under four orders", () => {
    const keys = Array.from({ length: 128 }, (_, i) => randomKey(i));
    for (const order of [keys, [...keys].reverse(), [...keys].sort(Buffer.compare),
      [...keys.filter((_, i) => i % 2), ...keys.filter((_, i) => !(i % 2))]]) {
      const set = new RadixSpentSet(), prefix: Uint8Array[] = [];
      for (const k of order) {
        set.insert(k); prefix.push(k);
        expect(set.root()).toEqual(oracle(prefix));
        expect(set.size).toBe(BigInt(prefix.length));
        expect(set.has(k)).toBe(true);
      }
      expect(set.has(randomKey(9999))).toBe(false);
    }
  });

  it("bounds the work at each of 256 split positions and a maximum-depth comb", () => {
    const keys = [key(0n), ...Array.from({ length: 256 }, (_, i) => key(1n << BigInt(i)))];
    for (const order of [keys, [...keys].reverse()]) {
      const set = new RadixSpentSet(), prefix: Uint8Array[] = [];
      for (const k of order) {
        const before = set.hashes;
        set.insert(k); prefix.push(k);
        expect(set.hashes - before <= 257n).toBe(true);
        expect(set.root()).toEqual(oracle(prefix));
      }
      for (const k of keys) expect(set.has(k)).toBe(true);
      expect(set.has(key(3n))).toBe(false);
    }
  });

  it("binds skipped prefixes with full keys, so an absent lookup cannot alias a leaf", () => {
    const a = [key(0n), key(1n)], b = [key(2n), key(3n)];
    expect(build(a).root()).not.toEqual(build(b).root());
    expect(build(a).has(b[0]!)).toBe(false);
    expect(build([key(0n)]).root()).not.toEqual(build([key(1n)]).root());
  });

  it("binds field-boundary keys as bytes", () => {
    const p = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const keys = [key(p - 1n), key(p), key(p + 1n), key((1n << 256n) - 1n)];
    expect(build(keys).root()).toEqual(oracle(keys));
    // The accumulator accepts these bytes; statement admission must still
    // refuse noncanonical field encodings.
    for (const k of keys) expect(build(keys).has(k)).toBe(true);
  });

  it("keeps the non-membership capability across skipped bits", () => {
    const zero = key(0n), one = key(1n), high = key(1n << 255n);
    const leaf = (k: Uint8Array): Uint8Array => hash(domain("leaf"), k);
    const lowRoot = hash(domain("node"), Uint8Array.of(0, 255), leaf(zero), leaf(one));
    const expected = build([zero, one, high]).root();
    const bitOf = (k: Uint8Array, b: number): number => (k[b >> 3]! >> (7 - (b & 7))) & 1;
    // Capability algebra only: no wire encoding or accepted protocol object.
    const fold = (query: Uint8Array, terminal: Uint8Array, path: readonly (readonly [number, Uint8Array])[]): Uint8Array => {
      let previous = -1;
      for (const [b] of path) {
        if (!(Number.isInteger(b) && b > previous && b <= 255)) throw new Error("path order");
        if (bitOf(query, b) !== bitOf(terminal, b)) throw new Error("path direction");
        previous = b;
      }
      let root = leaf(terminal);
      for (const [b, sibling] of [...path].reverse()) {
        const children = bitOf(query, b) ? [sibling, root] : [root, sibling];
        root = hash(domain("node"), Uint8Array.of(b >> 8, b & 255), ...children);
      }
      return root;
    };
    const path = [[0, leaf(high)], [255, leaf(one)]] as const;
    expect(fold(zero, zero, path)).toEqual(expected);
    expect(fold(key(2n), zero, path)).toEqual(expected); // absent in a skipped prefix
    expect(fold(key((1n << 256n) - 1n), high, [[0, lowRoot]])).toEqual(expected);
    expect(() => fold(one, zero, path)).toThrow("path direction");
    expect(() => fold(zero, zero, [...path].reverse())).toThrow("path order");
    expect(() => fold(zero, zero, [[256, leaf(one)]])).toThrow("path order");
    expect(fold(zero, zero, [[0, leaf(one)], [255, leaf(one)]])).not.toEqual(expected);
    expect(fold(key(2n), key(2n), path)).not.toEqual(expected);
  });

  it("keeps the root when imported groups repeat ancestral events", () => {
    // Event validation belongs to the replay; this is the already-validated union.
    const keys = Array.from({ length: 160 }, (_, i) => randomKey(i));
    const ancestors = [keys.slice(0, 80), keys.slice(40, 120), keys.slice(80)];
    const expected = oracle(keys);
    for (const groups of [ancestors, [...ancestors].reverse()]) {
      const set = new RadixSpentSet();
      for (const k of groups.flat()) if (!set.has(k)) set.insert(k);
      expect(set.size).toBe(160n);
      expect(set.root()).toEqual(expected);
    }
  });

  it("leaves root, size and hash count unchanged on duplicate or malformed input", () => {
    const valid = key(7n), set = build([valid]);
    const snapshot = [set.root(), set.size, set.hashes];
    const malformed: unknown[] = [undefined, null, {}, "x", [], new Uint8Array(31), new Uint8Array(33),
      Object.create(Uint8Array.prototype), new Proxy(valid, {}), new Uint16Array(32),
      new DataView(new ArrayBuffer(32)), new Uint8Array(new SharedArrayBuffer(32))];
    for (const length of [0, 31, 33]) malformed.push(Object.defineProperty(new Uint8Array(length), "length", { value: 32 }));
    for (const input of malformed) {
      expect(() => set.insert(input as Uint8Array)).toThrow(TypeError);
      expect(() => set.has(input as Uint8Array)).toThrow(TypeError);
      expect([set.root(), set.size, set.hashes]).toEqual(snapshot);
    }
    expect(() => set.insert(valid)).toThrow(/already/);
    expect([set.root(), set.size, set.hashes]).toEqual(snapshot);
  });

  it("owns its input and output bytes and ignores hostile own properties", () => {
    const ordinary = key(19n), input = Buffer.from(ordinary), set = build([input]);
    input.fill(8); set.root().fill(9);
    expect(set.root()).toEqual(oracle([ordinary]));
    expect(set.has(ordinary)).toBe(true);
    const hostile = Object.defineProperties(key(20n), {
      length: { get() { throw new Error("untrusted length getter"); } },
      buffer: { get() { throw new Error("untrusted buffer getter"); } },
      constructor: { get() { throw new Error("untrusted species"); } },
      [Symbol.iterator]: { value() { throw new Error("untrusted iterator"); } },
    });
    set.insert(hostile);
    expect(set.has(key(20n))).toBe(true);
    expect(set.root()).toEqual(oracle([ordinary, key(20n)]));
  });

  it("forks without sharing later inserts", () => {
    const set = build([key(1n)]), fork = set.fork();
    fork.insert(key(2n));
    expect(set.root()).toEqual(oracle([key(1n)]));
    expect(fork.root()).toEqual(oracle([key(1n), key(2n)]));
    expect([set.size, fork.size]).toEqual([1n, 2n]);
  });
});
