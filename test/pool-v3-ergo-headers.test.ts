import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { describe, expect, it } from "vitest";
import * as headers from "../model/pool-v3-ergo-headers.js";
import * as profile from "../model/pool-v3-ergo-profile.js";

// Real mainnet headers pin the difficulty rule, proof of work, parsing and
// ids; synthetic chains at difficulty 4 to 6, whose proof of work a test can
// find in a few tries, drive the store's refusals and fork choice. The
// experiment (experiments/ergo-range/header-verify.mjs) checks the same
// rules over every EIP-37 recalculation and a contiguous mainnet window.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/ergo-mainnet-recalculation.json", import.meta.url), "utf8")) as
  { headers: { height: number; id: string; bytes: string }[] };
const real = fixture.headers.map(entry => ({ ...entry, bytes: Uint8Array.from(Buffer.from(entry.bytes, "hex")) }));
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const parse = (bytes: Uint8Array): headers.ErgoHeader => {
  const header = headers.parseErgoHeader(bytes);
  if (header === undefined) throw new Error("fixture header does not parse");
  return header;
};

const vlq = (n: bigint): number[] => {
  const out: number[] = [];
  do { let byte = Number(n & 0x7fn); n >>= 7n; if (n > 0n) byte |= 0x80; out.push(byte); } while (n > 0n);
  return out;
};
const GENERATOR = secp256k1.ProjectivePoint.BASE.toRawBytes(true);
interface Fields { version?: number; parentId: Uint8Array; timestamp: bigint; nBits: number; height: bigint; nonce?: bigint; minerKey?: Uint8Array; newFields?: number[] }
/** A header in the node's layout for its version byte: a new-fields length only for versions 2–127 (a signed byte
 * above 1), and for version 1 an Autolykos v1 solution with `w` and `d`. */
function encode(fields: Fields, v1?: { w: Uint8Array; d: bigint }): Uint8Array {
  const version = fields.version ?? 4, signed = version < 128 ? version : version - 256;
  const nBits = [(fields.nBits >>> 24) & 0xff, (fields.nBits >>> 16) & 0xff, (fields.nBits >>> 8) & 0xff, fields.nBits & 0xff];
  const nonce = new Uint8Array(8);
  new DataView(nonce.buffer).setBigUint64(0, fields.nonce ?? 0n);
  const newFields = signed > 1 ? [(fields.newFields ?? []).length, ...(fields.newFields ?? [])] : [];
  const minerKey = fields.minerKey ?? GENERATOR;
  const d = v1 === undefined ? [] : [...Buffer.from(v1.d.toString(16).padStart(v1.d.toString(16).length + (v1.d.toString(16).length % 2), "0"), "hex")];
  const solution = version === 1 ? [...minerKey, ...v1!.w, ...nonce, d.length, ...d] : [...minerKey, ...nonce];
  return Uint8Array.from([version, ...fields.parentId, ...new Uint8Array(32).fill(1), ...new Uint8Array(32).fill(2), ...new Uint8Array(33).fill(3),
    ...vlq(fields.timestamp), ...new Uint8Array(32).fill(4), ...nBits, ...vlq(fields.height), 0, 0, 0, ...newFields, ...solution]);
}
const Q = secp256k1.CURVE.n;
/** A worked version 1 header: with `pk = g^sk` and `w = g^x`, `d = x·f − sk` solves `w^f = g^d · pk`; a nonce whose
 * `d` falls below `q / difficulty` has the work. */
function mineV1(fields: Fields): Uint8Array {
  const sk = 7n, x = 11n, pk = secp256k1.ProjectivePoint.BASE.multiply(sk).toRawBytes(true), w = secp256k1.ProjectivePoint.BASE.multiply(x).toRawBytes(true);
  const target = Q / headers.decodeCompactBits(fields.nBits);
  for (let nonce = 0n; ; nonce++) {
    const draft = parse(encode({ ...fields, version: 1, nonce, minerKey: pk }, { w, d: 0n }));
    const f = headers.autolykosV1Exponent(draft.withoutPow, draft.nonce, pk, w);
    const d = ((x * f - sk) % Q + Q) % Q;
    if (d < target) return encode({ ...fields, version: 1, nonce, minerKey: pk }, { w, d });
  }
}
/** The first nonce from `start` whose proof of work holds (or, with `valid` false, fails) at the header's difficulty. */
function mine(fields: Fields, valid = true, start = 0n): Uint8Array {
  for (let nonce = start; ; nonce++) {
    const bytes = encode({ ...fields, nonce });
    if (headers.autolykosPowValid(parse(bytes)) === valid) return bytes;
  }
}
const v1Fixture = JSON.parse(readFileSync(new URL("./fixtures/ergo-mainnet-v1-headers.json", import.meta.url), "utf8")) as
  { headers: { height: number; version: number; id: string; bytes: string }[] };
const D4 = 0x0104_0000, D6 = 0x0106_0000;
const MINUTE = 60_000n, T0 = 1_700_000_000_000n;
/** 1,024 headers below an anchor at `anchorHeight`, then the anchor, `spacing` apart at difficulty 4. */
function context(anchorHeight: bigint, spacing = 2n * MINUTE, length = headers.ANCHOR_CONTEXT + 1): Uint8Array[] {
  const out: Uint8Array[] = [];
  let parentId: Uint8Array = new Uint8Array(32).fill(9);
  for (let i = 0; i < length; i++) {
    const height = anchorHeight - BigInt(length - 1 - i);
    const bytes = encode({ parentId, timestamp: T0 + BigInt(i) * spacing, nBits: D4, height, nonce: BigInt(i) });
    out.push(bytes);
    parentId = blake2b(bytes, { dkLen: 32 });
  }
  return out;
}
// The anchor sits at a boundary, so its child is a recalculation.
const ANCHOR_HEIGHT = 128n * 6602n;
const baseContext = context(ANCHOR_HEIGHT);
const anchor = parse(baseContext.at(-1)!);
const child = (parent: headers.ErgoHeader, overrides: Partial<Fields> = {}): Fields =>
  ({ parentId: parent.id, timestamp: parent.timestamp + 2n * MINUTE, nBits: D4, height: parent.height + 1n, ...overrides });
const store = (bytes = baseContext): headers.ErgoHeaderStore => {
  const built = headers.ergoHeaderStore(anchor.id, bytes);
  if (built === undefined) throw new Error("store not built");
  return built;
};

describe("Ergo headers from their bytes", () => {
  it("reads real mainnet headers canonically and derives the node's ids", () => {
    for (const entry of real) {
      const header = parse(entry.bytes);
      expect(hex(header.id)).toBe(entry.id);
      expect(header.height).toBe(BigInt(entry.height));
      expect(header.version).toBe(4);
    }
  });

  it("reproduces the node's EIP-37 recalculation and proof of work on real headers", () => {
    const [...previous] = real.slice(0, 9).map(entry => parse(entry.bytes));
    const boundary = parse(real[9]!.bytes);
    expect(hex(boundary.parentId)).toBe(hex(previous[8]!.id));
    const required = headers.eip37Difficulty(previous);
    expect(required).toBe(headers.decodeCompactBits(boundary.nBits));
    // The recalculation moved the difficulty, so the rule is exercised rather than the parent's value copied.
    expect(required).not.toBe(headers.decodeCompactBits(previous[8]!.nBits));
    expect(headers.normalizeDifficulty(required)).toBe(required);
    for (const entry of real) expect(headers.autolykosPowValid(parse(entry.bytes))).toBe(true);
    // Moving one epoch's timestamp moves the result; a changed nonce fails the work.
    const shifted = previous.map((header, i) => i === 4 ? { ...header, timestamp: header.timestamp + 600_000n } : header);
    expect(headers.eip37Difficulty(shifted)).not.toBe(required);
    const nonce = Uint8Array.from(real[9]!.bytes);
    nonce[nonce.length - 1]! ^= 1;
    expect(headers.autolykosPowValid(parse(nonce))).toBe(false);
  });

  it("refuses every non-canonical or unsupported encoding", () => {
    const base = real[9]!.bytes, parsed = parse(base), withoutPow = parsed.withoutPow.length;
    const timestampAt = 1 + 32 + 32 + 32 + 33, timestampLength = vlq(parsed.timestamp).length;
    const edit = (at: number, value: number): Uint8Array => { const copy = Uint8Array.from(base); copy[at] = value; return copy; };
    const splice = (at: number, length: number, replacement: number[]): Uint8Array =>
      Uint8Array.from([...base.slice(0, at), ...replacement, ...base.slice(at + length)]);
    // Version 1 reads a v1 solution, and versions 0 and 128–255 (a signed byte at or below 1) no new-fields length,
    // so this version 4 layout under those bytes is malformed.
    for (const version of [0, 1, 128, 255]) expect(headers.parseErgoHeader(edit(0, version))).toBeUndefined();
    expect(headers.parseErgoHeader(Uint8Array.from([...base, 0]))).toBeUndefined();
    expect(headers.parseErgoHeader(base.slice(0, base.length - 1))).toBeUndefined();
    expect(headers.parseErgoHeader(base.slice(0, withoutPow))).toBeUndefined();
    expect(headers.parseErgoHeader(new Uint8Array(0))).toBeUndefined();
    // Objects that only look like byte arrays are refused before any getter runs.
    expect(headers.parseErgoHeader(Object.create(Uint8Array.prototype) as Uint8Array)).toBeUndefined();
    expect(headers.parseErgoHeader(new Proxy(Uint8Array.from(base), {}))).toBeUndefined();
    expect(headers.ergoHeaderStore(new Proxy(anchor.id, {}), baseContext)).toBeUndefined();
    expect(store().add(Object.create(Uint8Array.prototype) as Uint8Array)).toBe("malformed");
    // A final VLQ byte carried into a zero byte is the same value, non-minimally.
    const last = timestampAt + timestampLength - 1;
    expect(headers.parseErgoHeader(splice(last, 1, [base[last]! | 0x80, 0]))).toBeUndefined();
    const heightAt = timestampAt + timestampLength + 32 + 4, heightLength = vlq(parsed.height).length;
    expect(headers.parseErgoHeader(splice(heightAt + heightLength - 1, 1, [base[heightAt + heightLength - 1]! | 0x80, 0]))).toBeUndefined();
    expect(headers.parseErgoHeader(splice(heightAt, heightLength, vlq(1n << 31n)))).toBeUndefined();
    expect(headers.parseErgoHeader(splice(heightAt, heightLength, vlq((1n << 31n) - 1n)))).toBeDefined();
    // A version 2–4 node skips a nonzero new-fields length and would hash a different serialization.
    expect(headers.parseErgoHeader(edit(withoutPow - 1, 1))).toBeUndefined();
    // The miner key: a compressed point that decodes, or the identity as 33 zero bytes.
    const keyAt = withoutPow;
    expect(headers.parseErgoHeader(edit(keyAt, 4))).toBeUndefined();
    const identity = Uint8Array.from(base);
    identity.fill(0, keyAt, keyAt + 33);
    expect(headers.parseErgoHeader(identity)).toBeDefined();
    identity[keyAt + 32] = 1;
    expect(headers.parseErgoHeader(identity)).toBeUndefined();
    let offCurve: Uint8Array | undefined;
    for (let x = 1; offCurve === undefined; x++) {
      const key = Uint8Array.from([2, ...new Uint8Array(31), x]);
      try { secp256k1.ProjectivePoint.fromHex(key); } catch { offCurve = key; }
    }
    const bad = Uint8Array.from(base);
    bad.set(offCurve, keyAt);
    expect(headers.parseErgoHeader(bad)).toBeUndefined();
    // The id is the hash of the bytes read, so any change of a field is a different header.
    expect(hex(parse(edit(1, base[1]! ^ 1)).id)).not.toBe(hex(parsed.id));
  });

  it("reads a later version's new fields into the id and the work message", () => {
    const base = real[9]!.bytes, parsed = parse(base), withoutPow = parsed.withoutPow.length;
    const later = (version: number, fields: number[]): Uint8Array =>
      Uint8Array.from([version, ...base.slice(1, withoutPow - 1), fields.length, ...fields, ...base.slice(withoutPow)]);
    // Version 5 with no new fields is the same layout under another version byte.
    const five = parse(later(5, []));
    expect(five.version).toBe(5);
    expect(five.height).toBe(parsed.height);
    const fields = [0xaa, 0xbb, 0xcc];
    for (const version of [5, 127]) {
      const bytes = later(version, fields), header = parse(bytes);
      expect(hex(header.id)).toBe(hex(blake2b(bytes, { dkLen: 32 })));
      expect(hex(header.withoutPow)).toBe(hex(bytes.slice(0, withoutPow + fields.length)));
      expect(hex(header.transactionsRoot)).toBe(hex(parsed.transactionsRoot));
    }
    // The fields are read exactly: a length the bytes do not hold, or a byte left over, is malformed.
    const short = later(5, fields);
    expect(headers.parseErgoHeader(short.slice(0, short.length - 1))).toBeUndefined();
    expect(headers.parseErgoHeader(Uint8Array.from([...short, 0]))).toBeUndefined();
    expect(headers.parseErgoHeader(later(4, fields))).toBeUndefined();
    // Versions 0 and 128–255 carry no new-fields length at all.
    const bare = (version: number): Uint8Array => Uint8Array.from([version, ...base.slice(1, withoutPow - 1), ...base.slice(withoutPow)]);
    for (const version of [0, 128, 255]) {
      const header = parse(bare(version));
      expect(header.version).toBe(version);
      expect(hex(header.withoutPow)).toBe(hex(bare(version).slice(0, withoutPow - 1)));
    }
  });

  it("reads real version 1 headers with their Autolykos v1 solution and checks its equation", () => {
    for (const entry of v1Fixture.headers) {
      const bytes = Uint8Array.from(Buffer.from(entry.bytes, "hex")), header = parse(bytes);
      expect(hex(header.id)).toBe(entry.id);
      expect(header.version).toBe(entry.version);
      expect(headers.autolykosPowValid(header)).toBe(true);
    }
    const first = v1Fixture.headers.find(entry => entry.version === 1)!, bytes = Uint8Array.from(Buffer.from(first.bytes, "hex"));
    const header = parse(bytes), dAt = bytes.length - 1 - (bytes.length - header.withoutPow.length - 33 - 33 - 8 - 1);
    expect(bytes[dAt]).toBe(bytes.length - dAt - 1);
    // Any change of the nonce, w or d breaks the equation.
    for (const at of [bytes.length - 1, header.withoutPow.length + 33 + 32 + 8]) {
      const changed = Uint8Array.from(bytes);
      changed[at]! ^= 1;
      const parsed = headers.parseErgoHeader(changed);
      if (parsed !== undefined) expect(headers.autolykosPowValid(parsed)).toBe(false);
    }
    // d is written minimally: a leading zero byte, or no bytes for zero, is another spelling.
    expect(headers.parseErgoHeader(Uint8Array.from([...bytes.slice(0, dAt), bytes[dAt]! + 1, 0, ...bytes.slice(dAt + 1)]))).toBeUndefined();
    expect(headers.parseErgoHeader(Uint8Array.from([...bytes.slice(0, dAt), 0]))).toBeUndefined();
    expect(headers.parseErgoHeader(Uint8Array.from([...bytes.slice(0, dAt), 1, 0]))).toBeDefined();
    // A v1 miner key or w that is the identity parses, as the node's does, but has no work.
    const identityW = Uint8Array.from(bytes);
    identityW.fill(0, header.withoutPow.length + 33, header.withoutPow.length + 66);
    expect(headers.autolykosPowValid(parse(identityW))).toBe(false);
  });

  it("decodes compact difficulty and normalizes as the node does", () => {
    expect(headers.decodeCompactBits(0)).toBe(0n);
    expect(headers.decodeCompactBits(0x0104_0000)).toBe(4n);
    expect(headers.decodeCompactBits(0x0200_8000)).toBe(0x80n);
    expect(headers.decodeCompactBits(0x0180_0000)).toBe(0n);
    expect(headers.decodeCompactBits(0x0181_0000)).toBe(-1n);
    expect(headers.decodeCompactBits(0x0512_3456)).toBe(0x12_3456_0000n);
    expect(headers.normalizeDifficulty(0n)).toBe(0n);
    expect(headers.normalizeDifficulty(0x7f_ffffn)).toBe(0x7f_ffffn);
    // 0x800000 needs a sign byte, so four bytes keep the top three: 0x008000 then one zero byte.
    expect(headers.normalizeDifficulty(0x80_0001n)).toBe(0x80_0000n);
    expect(headers.normalizeDifficulty(0x1_2345_6789n)).toBe(0x1_2345_0000n);
    expect(() => headers.normalizeDifficulty(-1n)).toThrow(RangeError);
    expect(headers.autolykosTableSize(600n * 1024n - 1n)).toBe(1n << 26n);
    expect(headers.autolykosTableSize(600n * 1024n)).toBe((1n << 26n) / 100n * 105n);
    expect(headers.autolykosTableSize(4_198_400n)).toBe(headers.autolykosTableSize(9_000_000n));
    expect(headers.autolykosTableSize(4_198_400n)).toBeLessThan(1n << 31n);
  });
});

describe("the reader's header store", () => {
  it("is built only from a linked context of eight epochs ending at the anchor, after EIP-37", () => {
    expect(headers.ergoHeaderStore(anchor.id, baseContext)).toBeDefined();
    expect(headers.ergoHeaderStore(anchor.id, baseContext.slice(1))).toBeUndefined();
    expect(headers.ergoHeaderStore(anchor.id, baseContext.slice(0, -1))).toBeUndefined();
    expect(headers.ergoHeaderStore(new Uint8Array(32), baseContext)).toBeUndefined();
    const broken = [...baseContext];
    broken.splice(500, 1, encode({ parentId: new Uint8Array(32), timestamp: 1n, nBits: D4, height: ANCHOR_HEIGHT - 524n }));
    expect(headers.ergoHeaderStore(anchor.id, broken)).toBeUndefined();
    const early = context(headers.EIP37_ACTIVATION_HEIGHT - 2n);
    expect(headers.ergoHeaderStore(parse(early.at(-1)!).id, early)).toBeUndefined();
    const first = context(headers.EIP37_ACTIVATION_HEIGHT - 1n);
    expect(headers.ergoHeaderStore(parse(first.at(-1)!).id, first)).toBeDefined();
  });

  it("accepts a worked child and refuses each rule's violation with its reason", () => {
    const s = store();
    const good = mine(child(anchor));
    expect(s.add(good)).toBe("added");
    expect(s.add(good)).toBe("known");
    const g = parse(good);
    expect(s.best().headers.map(view => hex(view.id))).toEqual([hex(g.id)]);
    expect(s.best().score).toBe(4n);
    const next = child(g);
    expect(s.add(Uint8Array.from([...mine(next), 0]))).toBe("malformed");
    expect(s.add(mine({ ...next, parentId: new Uint8Array(32).fill(7) }))).toBe("unknown-parent");
    expect(s.add(mine({ ...next, parentId: parse(baseContext.at(-2)!).id, height: ANCHOR_HEIGHT }))).toBe("below-anchor");
    expect(s.add(mine({ ...next, height: next.height + 1n }))).toBe("height");
    expect(s.add(mine({ ...next, timestamp: g.timestamp }))).toBe("timestamp");
    expect(s.add(mine({ ...next, nBits: 0x0105_0000 }))).toBe("difficulty");
    // The same value in another compact encoding is the node's required difficulty.
    expect(headers.decodeCompactBits(0x0200_0400)).toBe(4n);
    expect(s.add(mine({ ...next, nBits: 0x0200_0400 }))).toBe("added");
    expect(s.add(mine(next, false))).toBe("pow");
    // Nothing refused entered the store: the tip is the last accepted header.
    expect(s.best().height).toBe(ANCHOR_HEIGHT + 2n);
  });

  it("applies the recalculation at an epoch boundary", () => {
    const fast = context(ANCHOR_HEIGHT, MINUTE);
    const fastAnchor = parse(fast.at(-1)!);
    const previous = fast.filter((_, i) => (fast.length - 1 - i) % 128 === 0).map(parse);
    expect(previous).toHaveLength(9);
    // Blocks at half the interval: classic 8, prediction 8 held to 6, their mean 7 held to 6.
    expect(headers.eip37Difficulty(previous)).toBe(6n);
    const s = headers.ergoHeaderStore(fastAnchor.id, fast)!;
    const next = child(fastAnchor);
    expect(s.add(mine(next))).toBe("difficulty");
    const boundary = mine({ ...next, nBits: D6 });
    expect(s.add(boundary)).toBe("added");
    // Inside the epoch the parent's difficulty is required.
    const inside = child(parse(boundary), { nBits: D6 });
    expect(s.add(mine({ ...inside, nBits: D4 }))).toBe("difficulty");
    expect(s.add(mine(inside))).toBe("added");
    expect(s.best().score).toBe(12n);
  });

  it("keeps the first of equal chains and moves to a heavier one", () => {
    const s = store();
    const a1 = mine(child(anchor)), b1 = mine(child(anchor, { timestamp: anchor.timestamp + MINUTE }));
    expect(s.add(a1)).toBe("added");
    expect(s.add(b1)).toBe("added");
    expect(hex(s.best().tipId)).toBe(hex(parse(a1).id));
    const b2 = mine(child(parse(b1)));
    expect(s.add(b2)).toBe("added");
    const best = s.best();
    expect(best.headers.map(view => hex(view.id))).toEqual([hex(parse(b1).id), hex(parse(b2).id)]);
    expect(best.score).toBe(8n);
    // A later header version takes part in chain choice, so a soft fork moves the best chain with the work.
    const c2 = mine(child(parse(a1), { version: 5, newFields: [1, 2] })), c3 = mine(child(parse(c2), { version: 5 }));
    expect(s.add(c2)).toBe("added");
    expect(hex(s.best().tipId)).toBe(hex(parse(b2).id));
    expect(s.add(c3)).toBe("added");
    expect(s.best().headers.map(view => view.version)).toEqual([4n, 5n, 5n]);
    expect(s.best().score).toBe(12n);
    // The node checks no version inside a voting epoch, so a miner may carry any version byte: each one extends the
    // chain in the node's layout for it, Autolykos v1 included.
    let tip = parse(c3);
    for (const version of [0, 128, 255, 1, 3]) {
      const next = version === 1 ? mineV1(child(tip)) : mine(child(tip, { version }));
      expect(s.add(next)).toBe("added");
      tip = parse(next);
      expect(tip.version).toBe(version);
    }
    expect(hex(s.best().tipId)).toBe(hex(tip.id));
    expect(s.best().headers.map(view => view.version)).toEqual([4n, 5n, 5n, 0n, 128n, 255n, 1n, 3n]);
    // A fork below the anchor is refused however much work it carries.
    const side = mine({ ...child(parse(baseContext.at(-2)!)), timestamp: anchor.timestamp + 1n });
    expect(s.add(side)).toBe("below-anchor");
    // The best chain is the range verifier's header input from the same anchor.
    const tree = (kind: number): Uint8Array => Uint8Array.from(Buffer.from(`0008cd02${"ab".repeat(31)}0${kind}`, "hex"));
    const scripts = { 1: tree(1), 2: tree(2), 3: tree(3), 4: tree(4) };
    const verifier = profile.ergoRangeVerifier({ anchor: anchor.id, depth: 1n, scripts }, { headers: best.headers, blocks: [] });
    expect(verifier?.witnessedIndex()).toBe(0n);
    // Over the mixed-version chain the index advances with every header; the profile tests pin that each version has its section.
    expect(profile.ergoRangeVerifier({ anchor: anchor.id, depth: 1n, scripts }, { headers: s.best().headers, blocks: [] })?.witnessedIndex()).toBe(6n);
    // Views are copies: changing one does not change the store.
    const now = s.best();
    now.headers[0]!.id[0]! ^= 1;
    expect(hex(s.best().headers[0]!.id)).toBe(hex(parse(a1).id));
  });
});
