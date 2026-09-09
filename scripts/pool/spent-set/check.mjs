import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RadixSpentSet } from './radix.mjs';

const hash = (...bytes) => new Uint8Array(createHash('sha256').update(Buffer.concat(bytes)).digest());
const domain = name => Buffer.from(`moe/pool/v3/spent/${name}`, 'utf8');
const hex = bytes => Buffer.from(bytes).toString('hex');
export const key = n => new Uint8Array(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'));
export const randomKey = n => hash(Buffer.from(`A22/key/${n}`));

// Independent batch definition: sort once, split by the extrema's first
// differing bit, recurse over slices. No incremental candidate helpers.
export function oracle(input) {
  const keys = [...new Map(input.map(k => [hex(k), k])).values()].sort(Buffer.compare);
  const root = keys => {
    if (keys.length === 0) return hash(domain('empty'));
    if (keys.length === 1) return hash(domain('leaf'), keys[0]);
    let bit = 0;
    while ((keys[0][bit >> 3] & (128 >> (bit & 7))) ===
      (keys.at(-1)[bit >> 3] & (128 >> (bit & 7)))) bit++;
    const pivot = keys.findIndex(k => (k[bit >> 3] & (128 >> (bit & 7))) !== 0);
    assert(pivot > 0 && bit < 256);
    return hash(domain('node'), Buffer.from([bit >> 8, bit & 255]),
      root(keys.slice(0, pivot)), root(keys.slice(pivot)));
  };
  return root(keys);
}

let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`ok ${name}`); };
const build = keys => { const set = new RadixSpentSet(); for (const k of keys) set.insert(k); return set; };

check('empty, singleton and pinned frame vectors', () => {
  const empty = build([]), singleton = build([key(0n)]);
  assert.deepEqual(empty.root(), hash(domain('empty')));
  assert.deepEqual(singleton.root(), hash(domain('leaf'), key(0n)));
  for (const bit of [0n, 1n, 127n, 254n, 255n]) {
    const keys = [key(0n), key(1n << (255n - bit))];
    const expected = hash(domain('node'), Buffer.from([Number(bit >> 8n), Number(bit & 255n)]),
      hash(domain('leaf'), keys[0]), hash(domain('leaf'), keys[1]));
    assert.deepEqual(build(keys).root(), expected);
  }
});
check('all permutations of a small set including boundary splits', () => {
  const keys = [key(0n), key(1n), key(2n), key(1n << 255n), key((1n << 256n) - 1n)];
  const expected = oracle(keys);
  const permutations = (remaining, prefix = []) => {
    if (!remaining.length) { assert.deepEqual(build(prefix).root(), expected); return; }
    for (let i = 0; i < remaining.length; i++) {
      permutations(remaining.filter((_, j) => i !== j), [...prefix, remaining[i]]);
    }
  };
  permutations(keys);
});
check('every prefix matches independent batch oracle under four orders', () => {
  const keys = Array.from({ length: 128 }, (_, i) => randomKey(i));
  for (const order of [keys, [...keys].reverse(), [...keys].sort(Buffer.compare),
    [...keys.filter((_, i) => i % 2), ...keys.filter((_, i) => !(i % 2))]]) {
    const set = new RadixSpentSet(), prefix = [];
    for (const k of order) {
      set.insert(k); prefix.push(k);
      assert.deepEqual(set.root(), oracle(prefix));
      assert.equal(set.size, BigInt(prefix.length));
      assert(set.has(k));
    }
    assert(!set.has(randomKey(9999)));
  }
});
check('each of 256 split positions and maximum-depth hostile comb', () => {
  const keys = [key(0n), ...Array.from({ length: 256 }, (_, i) => key(1n << BigInt(i)))];
  for (const order of [keys, [...keys].reverse()]) {
    const set = new RadixSpentSet(), prefix = [];
    for (const k of order) {
      const before = set.hashes;
      set.insert(k); prefix.push(k);
      assert(set.hashes - before <= 257n);
      assert.deepEqual(set.root(), oracle(prefix));
    }
    for (const k of keys) assert(set.has(k));
    assert(!set.has(key(3n)));
  }
});
check('full keys bind skipped prefixes and absent lookup cannot alias a leaf', () => {
  const a = [key(0n), key(1n)], b = [key(2n), key(3n)];
  assert.notDeepEqual(build(a).root(), build(b).root());
  assert(!build(a).has(b[0]));
  assert.notDeepEqual(build([key(0n)]).root(), build([key(1n)]).root());
});
check('field boundaries remain bound as bytes, without relaxing admission', () => {
  const p = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const keys = [key(p - 1n), key(p), key(p + 1n), key((1n << 256n) - 1n)];
  assert.deepEqual(build(keys).root(), oracle(keys));
  // The accumulator accepts these bytes; v3 statement admission must still
  // refuse noncanonical field encodings. It is not provided by this probe.
  for (const k of keys) assert(build(keys).has(k));
});
check('non-membership capability survives skipped bits without a published proof', () => {
  const zero = key(0n), one = key(1n), high = key(1n << 255n);
  const leaf = k => hash(domain('leaf'), k);
  const lowRoot = hash(domain('node'), Buffer.from([0, 255]), leaf(zero), leaf(one));
  const expected = build([zero, one, high]).root();
  // Capability algebra only: no wire encoding or accepted protocol object.
  const fold = (query, terminal, path) => {
    let previous = -1;
    const bitOf = (k, b) => (k[b >> 3] >> (7 - (b & 7))) & 1;
    for (const [b] of path) {
      assert(Number.isInteger(b) && b > previous && b <= 255);
      assert.equal(bitOf(query, b), bitOf(terminal, b)); previous = b;
    }
    let root = leaf(terminal);
    for (const [b, sibling] of [...path].reverse()) {
      const children = bitOf(query, b) ? [sibling, root] : [root, sibling];
      root = hash(domain('node'), Buffer.from([b >> 8, b & 255]), ...children);
    }
    return root;
  };
  const path = [[0, leaf(high)], [255, leaf(one)]];
  assert.deepEqual(fold(zero, zero, path), expected);
  assert.deepEqual(fold(key(2n), zero, path), expected); // absent in skipped prefix
  assert.deepEqual(fold(key((1n << 256n) - 1n), high, [[0, lowRoot]]), expected);
  assert.throws(() => fold(one, zero, path));
  assert.throws(() => fold(zero, zero, [...path].reverse()));
  assert.throws(() => fold(zero, zero, [[256, leaf(one)]]));
  assert.notDeepEqual(fold(zero, zero, [[0, leaf(one)], [255, leaf(one)]]), expected);
  assert.notDeepEqual(fold(key(2n), key(2n), path), expected);
});
check('import grouping and duplicate ancestral-event dedup preserve the root', () => {
  // Event/closure validation belongs to runtime. This models only the
  // already-validated union, not acceptance of conflicting spend events.
  const keys = Array.from({ length: 160 }, (_, i) => randomKey(i));
  const ancestors = [keys.slice(0, 80), keys.slice(40, 120), keys.slice(80)];
  const expected = oracle(keys);
  for (const groups of [ancestors, [...ancestors].reverse()]) {
    const set = new RadixSpentSet();
    for (const k of groups.flat()) if (!set.has(k)) set.insert(k);
    assert.equal(set.size, 160n); assert.deepEqual(set.root(), expected);
  }
});
check('duplicate and malformed inputs leave root, size and hash counts unchanged', () => {
  const valid = key(7n), set = build([valid]);
  const snapshot = [set.root(), set.size, set.hashes];
  const malformed = [undefined, null, {}, 'x', [], new Uint8Array(31), new Uint8Array(33),
    Object.create(Uint8Array.prototype), new Proxy(valid, {}), new Uint16Array(32),
    new DataView(new ArrayBuffer(32)), new Uint8Array(new SharedArrayBuffer(32))];
  for (const length of [0, 31, 33]) {
    malformed.push(Object.defineProperty(new Uint8Array(length), 'length', { value: 32 }));
  }
  for (const input of malformed) {
    assert.throws(() => set.insert(input)); assert.throws(() => set.has(input));
    assert.deepEqual([set.root(), set.size, set.hashes], snapshot);
  }
  assert.throws(() => set.insert(valid), /already/);
  assert.deepEqual([set.root(), set.size, set.hashes], snapshot);
});
check('input and output aliasing, Buffer views and hostile own properties', () => {
  const ordinary = key(19n), input = Buffer.from(ordinary), set = build([input]);
  input.fill(8); set.root().fill(9);
  assert.deepEqual(set.root(), oracle([ordinary])); assert(set.has(ordinary));
  const hostile = Object.defineProperties(key(20n), {
    length: { get() { throw new Error('untrusted length getter'); } },
    buffer: { get() { throw new Error('untrusted buffer getter'); } },
    constructor: { get() { throw new Error('untrusted species'); } },
    [Symbol.iterator]: { value() { throw new Error('untrusted iterator'); } },
  });
  set.insert(hostile); assert(set.has(key(20n)));
  assert.deepEqual(set.root(), oracle([ordinary, key(20n)]));
});
console.log(`A22: ${checks} groups passed; candidate only, no runtime recovery claim.`);
