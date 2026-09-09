import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import * as codec from "../model/pool-v3-records.js";
import { EncodingError } from "../src/bytes.js";
import * as contexts from "../src/contexts.js";
import { FIELD_MODULUS } from "../src/pool/field.js";
import { verifySignatureStrict } from "../src/keys.js";
import { decodeStatement as decodeV2 } from "../src/pool/statement.js";

// Independent byte oracle: Node Buffer and node:crypto, no ByteWriter, field
// encoder or production digest helper. Synthetic domains and shape-only proof
// bytes do not claim circuit validity, acceptance, finality or decryption.
const ascii = (s: string): Buffer => Buffer.from(s, "ascii");
const join = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const integer = (v: bigint, bytes: number): Buffer => Buffer.from(v.toString(16).padStart(bytes * 2, "0"), "hex");
const u32 = (n: number): Buffer => integer(BigInt(n), 4);
const hash = (b: Uint8Array): Buffer => createHash("sha256").update(b).digest();
const id = (n: number): Buffer => Buffer.alloc(32, n);
// Buffer is a valid byte input/subclass; compare byte values, not subclasses.
function values(value: unknown): unknown {
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(values);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, values(v)]));
  return value;
}
const domain = id(17), backing = id(31), segment = id(19), demand = id(37);
const limbPair = (b: Uint8Array): [bigint, bigint] => [BigInt(`0x${Buffer.from(b.slice(0, 16)).toString("hex")}`), BigInt(`0x${Buffer.from(b.slice(16)).toString("hex")}`)];
const kinds = [1, 2, 3, 4, 5, 6, 7] as const;
const prefix = [...limbPair(domain), ...limbPair(segment), 101n];
const capsule = (n: number): Uint8Array => Uint8Array.from([1, ...Array(88).fill(n)]);
const outputIndices = { 1: [8], 2: [9, 10, 11, 12], 3: [12] } as const;
function rawDelivery(s: codec.Record): Buffer {
  const indices = outputIndices[s.kind as 1 | 2 | 3];
  return hash(join(ascii("moe/pool/v3/delivery"), s.domain, u32(indices.length),
    ...indices.flatMap((i, j) => [integer(s.publicInputs[i]!, 32), s.capsules[j]!])));
}
function rawStatement(s: codec.Statement): Buffer {
  return join(ascii("moe/pool/v3/statement"), s.domain, Uint8Array.of(s.kind), u32(s.publicInputs.length),
    ...s.publicInputs.map(p => integer(p, 32)));
}
function rawRecord(s: codec.Record): Buffer {
  return join(rawStatement(s), u32(s.proof.length), s.proof, u32(s.authorization.length), s.authorization,
    u32(s.capsules.length), ...s.capsules);
}
function rawAcceptance(a: codec.Acceptance): Buffer {
  return join(ascii("moe/pool/v3/acceptance"), a.domain, a.demand, integer(a.owner, 32), integer(a.deadline, 8));
}
function rawPublication(p: codec.Publication): Buffer {
  const body = p.kind === 2 ? join(rawAcceptance(p.acceptance), p.acceptance.signature) : rawRecord(p.record);
  return join(ascii("moe/pool/v3/publication"), p.domain, p.backing, Uint8Array.of(p.kind), u32(body.length), body);
}
function fixture(kind: codec.Kind): codec.Record {
  const pi = {
    1: [...prefix, ...limbPair(backing), 100n, 103n, 0n, 0n],
    2: [...prefix, 103n, 107n, 109n, 113n, 127n, 131n, 137n, 139n, 0n, 0n],
    3: [...prefix, ...limbPair(backing), 100n, 103n, 107n, 109n, 113n, 127n, 0n, 0n],
    4: [...prefix, ...limbPair(backing), 100n, 103n, 107n, 109n, 113n, ...limbPair(id(41)), 10n, 20n],
    5: [...prefix, ...limbPair(demand)],
    6: [...prefix, ...limbPair(backing), 100n, 103n, 107n, 109n, 113n, 127n, 131n, 137n, ...limbPair(demand)],
    7: [...limbPair(domain), ...limbPair(backing), 103n, 107n, 0n],
  }[kind];
  const s: codec.Record = { domain: Uint8Array.from(domain), kind, publicInputs: pi,
    proof: new Uint8Array(kind === 5 ? 0 : 32).fill(7),
    authorization: new Uint8Array(kind === 1 || kind === 5 ? 64 : kind === 6 ? 136 : 0).fill(9),
    capsules: Array.from({ length: kind === 2 ? 4 : kind === 1 || kind === 3 ? 1 : 0 }, (_, i) => capsule(i + 2)) };
  if (kind <= 3) pi.splice(pi.length - 2, 2, ...limbPair(rawDelivery(s)));
  return s;
}
function publication(kind: codec.Publication["kind"]): codec.Publication {
  if (kind === 2) return { domain, backing, kind, acceptance: { domain, demand, owner: 103n, deadline: 20n, signature: new Uint8Array(64).fill(9) } };
  return { domain, backing, kind, record: fixture(({ 1: 4, 3: 6, 4: 5, 5: 7 } as const)[kind]) };
}
function changedInput(s: codec.Record, index: number, value: bigint): codec.Record {
  const p = [...s.publicInputs]; p[index] = value; return { ...s, publicInputs: p };
}
function mutate32(b: Uint8Array, offset: number, n: number): Buffer {
  const copy = Buffer.from(b); copy.set(u32(n), offset); return copy;
}

describe("unadopted v3 canonical records", () => {
  it.each(kinds)("kind %i agrees with independent bytes and rejects every truncation/trailing byte", kind => {
    const s = fixture(kind), expected = rawRecord(s);
    expect(Buffer.from(codec.statementBytes(s))).toEqual(rawStatement(s));
    expect(Buffer.from(codec.statementHash(s))).toEqual(hash(rawStatement(s)));
    expect(Buffer.from(codec.encodeRecord(s))).toEqual(expected);
    expect(values(codec.decodeRecord(expected))).toEqual(values(s));
    for (let i = 0; i < expected.length; i++) expect(() => codec.decodeRecord(expected.subarray(0, i))).toThrow(EncodingError);
    expect(() => codec.decodeRecord(join(expected, Uint8Array.of(0)))).toThrow(EncodingError);
    expect(() => decodeV2(expected)).toThrow(EncodingError);
    const v2 = Buffer.from(expected); v2[10] = 50;
    expect(() => codec.decodeRecord(v2)).toThrow(EncodingError);
  });

  it.each(kinds)("kind %i validates framing lengths before copying or allocating", kind => {
    const s = fixture(kind), bytes = rawRecord(s), start = rawStatement(s).length;
    for (const offset of [54, start, start + 4 + s.proof.length, start + 8 + s.proof.length + s.authorization.length]) {
      expect(() => codec.decodeRecord(mutate32(bytes, offset, 0xffffffff))).toThrow(EncodingError);
    }
    for (const proof of [new Uint8Array(0), ...(kind === 5 ? [new Uint8Array(32)] : []), new Uint8Array(31), new Uint8Array(33), new Uint8Array(131104)]) {
      if (kind === 5 && proof.length === 0) continue;
      expect(() => codec.encodeRecord({ ...s, proof })).toThrow(EncodingError);
      expect(() => codec.decodeRecord(rawRecord({ ...s, proof }))).toThrow(EncodingError);
    }
    for (const length of [0, 1, 64, 136, 137]) {
      if (length === s.authorization.length) continue;
      const bad = { ...s, authorization: new Uint8Array(length) };
      expect(() => codec.encodeRecord(bad)).toThrow(EncodingError);
      expect(() => codec.decodeRecord(rawRecord(bad))).toThrow(EncodingError);
    }
    if (kind !== 5) expect(codec.decodeRecord(rawRecord({ ...s, proof: new Uint8Array(131072) })).proof.length).toBe(131072);
  });

  it.each(kinds)("kind %i owns mutable input and decoded output arrays", kind => {
    const s = fixture(kind), before = rawRecord(s), encoded = codec.encodeRecord(s);
    s.domain.fill(0); s.proof.fill(0); s.authorization.fill(0); for (const c of s.capsules) c.fill(0);
    expect(Buffer.from(encoded)).toEqual(before);
    const input = Buffer.from(before), a = codec.decodeRecord(input), b = codec.decodeRecord(input);
    input.fill(0); a.domain.fill(0); a.proof.fill(0); a.authorization.fill(0); for (const c of a.capsules) c.fill(0);
    expect(Buffer.from(codec.encodeRecord(b))).toEqual(before);
  });

  it.each(kinds)("kind %i rejects noncanonical fields, wrong outer domain and sparse inputs", kind => {
    const s = fixture(kind);
    const variants = [changedInput(s, 0, 1n << 128n), changedInput(s, 0, s.publicInputs[0]! + 1n),
      changedInput(s, 4, FIELD_MODULUS), changedInput(s, 3, 1n << 128n)];
    for (const bad of variants) {
      expect(() => codec.encodeRecord(bad)).toThrow(EncodingError);
      expect(() => codec.decodeRecord(rawRecord(bad))).toThrow(EncodingError);
    }
    const sparse = [...s.publicInputs]; delete sparse[4];
    expect(() => codec.encodeRecord({ ...s, publicInputs: sparse })).toThrow(EncodingError);
    expect(() => codec.encodeRecord(changedInput(s, 4, -1n))).toThrow(EncodingError);
    expect(() => codec.encodeRecord({ ...s, domain: id(22) })).toThrow(EncodingError);
  });

  it("checks every identifier and u64 position, including upper-bound positive controls", () => {
    const pairs = { 1: [0, 2, 5, 9], 2: [0, 2, 13], 3: [0, 2, 5, 13], 4: [0, 2, 5, 12], 5: [0, 2, 5], 6: [0, 2, 5, 15], 7: [0, 2] };
    const u64s = { 1: [7], 2: [], 3: [7], 4: [7, 14, 15], 5: [], 6: [7], 7: [6] };
    for (const kind of kinds) {
      const s = fixture(kind);
      for (const start of pairs[kind]) for (const i of [start, start + 1]) {
        const bad = changedInput(s, i, 1n << 128n);
        expect(() => codec.statementBytes(bad)).toThrow(EncodingError);
        expect(() => codec.decodeRecord(rawRecord(bad))).toThrow(EncodingError);
        let good = changedInput(s, i, (1n << 128n) - 1n);
        if (start === 0) good = { ...good, domain: join(integer(good.publicInputs[0]!, 16), integer(good.publicInputs[1]!, 16)) };
        expect(() => codec.statementBytes(good)).not.toThrow();
      }
      for (const i of u64s[kind]) {
        expect(() => codec.encodeRecord(changedInput(s, i, 1n << 64n))).toThrow(EncodingError);
        expect(() => codec.decodeRecord(rawRecord(changedInput(s, i, 1n << 64n)))).toThrow(EncodingError);
        expect(() => codec.statementBytes(changedInput(s, i, (1n << 64n) - 1n))).not.toThrow();
        if (i === 7) expect(() => codec.statementBytes(changedInput(s, i, 0n))).toThrow(EncodingError);
        else expect(() => codec.statementBytes(changedInput(s, i, 0n))).not.toThrow();
      }
    }
  });

  it.each([1, 2, 3] as const)("kind %i binds the complete delivery vector, profile, domain and order", kind => {
    const s = fixture(kind);
    const outputs = outputIndices[kind].map(i => s.publicInputs[i]!);
    expect(Buffer.from(codec.deliveryHash(s.domain, outputs, s.capsules))).toEqual(rawDelivery(s));
    const altered = Uint8Array.from(s.capsules[0]!); altered[88] = altered[88]! ^ 1;
    const variants = [ { ...s, capsules: [altered, ...s.capsules.slice(1)] },
      { ...s, capsules: s.capsules.slice(1) }, { ...s, capsules: [...s.capsules, capsule(9)] },
      { ...s, capsules: [new Uint8Array(89), ...s.capsules.slice(1)] },
      { ...s, capsules: [new Uint8Array(88), ...s.capsules.slice(1)] },
      changedInput(s, outputIndices[kind][0], outputs[0]! + 1n) ];
    if (kind === 2) variants.push({ ...s, capsules: [...s.capsules].reverse() });
    for (const bad of variants) {
      expect(() => codec.encodeRecord(bad)).toThrow(EncodingError);
      expect(() => codec.decodeRecord(rawRecord(bad))).toThrow(EncodingError);
    }
    const redigested = variants[0]!;
    const p = [...redigested.publicInputs]; p.splice(p.length - 2, 2, ...limbPair(rawDelivery(redigested)));
    const valid = { ...redigested, publicInputs: p };
    expect(() => codec.encodeRecord(valid)).not.toThrow();
    expect(codec.statementHash(valid)).not.toEqual(codec.statementHash(s));
  });

  it("preserves statement identities across proof/auth variants but binds exact evidence", () => {
    for (const kind of kinds) {
      const s = fixture(kind), before = codec.evidenceHashes(s);
      const variant = { ...s, proof: Uint8Array.from(s.proof, b => b ^ 1), authorization: Uint8Array.from(s.authorization, b => b ^ 1) };
      const after = codec.evidenceHashes(variant);
      expect(after.statementHash).toEqual(before.statementHash);
      expect(before.proofHash).toEqual(kind === 5 ? new Uint8Array(32) : Uint8Array.from(hash(s.proof)));
      expect(before.signatureHash).toEqual(s.authorization.length ? Uint8Array.from(hash(s.authorization)) : new Uint8Array(32));
      if (s.proof.length) expect(after.proofHash).not.toEqual(before.proofHash);
      if (s.authorization.length) expect(after.signatureHash).not.toEqual(before.signatureHash);
    }
    const a = publication(5); if (a.kind === 2) throw new Error();
    const b = { ...a, record: { ...a.record, proof: new Uint8Array(32).fill(8) } };
    expect(codec.publicationId(b)).not.toEqual(codec.publicationId(a));
    expect(codec.statementHash(b.record)).toEqual(codec.statementHash(a.record));
    expect(codec.statementHash(changedInput(a.record, 6, 1n))).not.toEqual(codec.statementHash(a.record));
  });

  it("rejects unknown kinds and runtime type confusion at encoder/decoder boundaries", () => {
    for (const value of [undefined, null, "x", {}, new Uint8ClampedArray(32)]) {
      expect(() => codec.decodeRecord(value as Uint8Array)).toThrow(EncodingError);
      expect(() => codec.decodePublication(value as Uint8Array)).toThrow(EncodingError);
      expect(() => codec.encodeRecord(value as codec.Record)).toThrow(EncodingError);
      expect(() => codec.encodePublication(value as codec.Publication)).toThrow(EncodingError);
      expect(() => codec.acceptanceBytes(value as codec.Acceptance)).toThrow(EncodingError);
    }
    for (const kind of [0, 8, 255, 1.5, "1"]) {
      expect(() => codec.encodeRecord({ ...fixture(1), kind } as codec.Record)).toThrow(EncodingError);
      if (typeof kind === "number" && Number.isInteger(kind)) {
        const b = rawRecord(fixture(1)); b[53] = kind;
        expect(() => codec.decodeRecord(b)).toThrow(EncodingError);
      }
    }
    for (const value of ["x".repeat(32), new Uint8ClampedArray(32), Array(32).fill(0)]) {
      expect(() => codec.encodeRecord({ ...fixture(1), domain: value as unknown as Uint8Array })).toThrow(EncodingError);
    }
  });
});

describe("v3 publication and signed-object bytes", () => {
  it("accepts each exact publication body bound and rejects one additional byte", () => {
    const maxima = [131654, 190, 131822, 358, 131366];
    for (const kind of [1, 2, 3, 4, 5] as const) {
      let p = publication(kind);
      if (p.kind !== 2 && p.kind !== 4) p = { ...p, record: { ...p.record, proof: new Uint8Array(131072) } };
      const bytes = rawPublication(p), maximum = maxima[kind - 1]!;
      expect(bytes.length).toBe(92 + maximum);
      expect(Buffer.from(codec.encodePublication(codec.decodePublication(bytes)))).toEqual(bytes);
      const oversized = join(mutate32(bytes, 88, maximum + 1), Uint8Array.of(0));
      expect(() => codec.decodePublication(oversized)).toThrow(EncodingError);
    }
  });
  it.each([1, 2, 3, 4, 5] as const)("publication %i matches independent bytes, bounds and truncations", kind => {
    const p = publication(kind), expected = rawPublication(p);
    expect(Buffer.from(codec.encodePublication(p))).toEqual(expected);
    expect(Buffer.from(codec.publicationId(p))).toEqual(hash(expected));
    expect(values(codec.decodePublication(expected))).toEqual(values(p));
    for (let i = 0; i < expected.length; i++) expect(() => codec.decodePublication(expected.subarray(0, i))).toThrow(EncodingError);
    expect(() => codec.decodePublication(join(expected, Uint8Array.of(0)))).toThrow(EncodingError);
    expect(() => codec.decodePublication(mutate32(expected, 88, 0xffffffff))).toThrow(EncodingError);
    const changedDomain = { ...p, domain: id(23) };
    expect(() => codec.encodePublication(changedDomain)).toThrow(EncodingError);
    expect(() => codec.decodePublication(rawPublication(changedDomain))).toThrow(EncodingError);
    const copy = Buffer.from(expected), decoded = codec.decodePublication(copy); copy.fill(0);
    expect(Buffer.from(codec.encodePublication(decoded))).toEqual(expected);
  });
  it("checks body kind, direct routing, and leaves indirect demand resolution explicit", () => {
    for (const kind of [1, 3, 4, 5] as const) {
      const p = publication(kind); if (p.kind === 2) throw new Error();
      for (const wrong of kinds.filter(k => k !== p.record.kind)) {
        const bad = { ...p, record: fixture(wrong) };
        expect(() => codec.encodePublication(bad)).toThrow(EncodingError);
        expect(() => codec.decodePublication(rawPublication(bad))).toThrow(EncodingError);
      }
    }
    for (const kind of [1, 2, 3, 4, 5] as const) {
      const p = { ...publication(kind), backing: id(67) };
      if (kind === 2 || kind === 4) expect(values(codec.decodePublication(rawPublication(p)))).toEqual(values(p));
      else {
        expect(() => codec.encodePublication(p)).toThrow(EncodingError);
        expect(() => codec.decodePublication(rawPublication(p))).toThrow(EncodingError);
      }
    }
    const unknown = rawPublication(publication(1)); unknown[87] = 6;
    expect(() => codec.decodePublication(unknown)).toThrow(EncodingError);
  });

  it("reconstructs both settlement signatures and refuses every changed bound field", () => {
    const keyK = id(5), keyPresenter = id(7), pkK = ed25519.getPublicKey(keyK), pkPresenter = ed25519.getPublicKey(keyPresenter);
    const s = fixture(6), acceptance: codec.Acceptance = { domain, demand, owner: s.publicInputs[8]!, deadline: 20n };
    const am = rawAcceptance(acceptance), aid = hash(am);
    const rm = join(ascii("moe/pool/v3/release"), domain, demand, aid, hash(rawStatement(s)));
    const authorization = join(integer(20n, 8), ed25519.sign(am, keyK), ed25519.sign(rm, keyPresenter));
    const signed = { ...s, authorization }, messages = codec.settlementAuthorization(signed);
    expect(Buffer.from(codec.acceptanceId(acceptance))).toEqual(aid);
    expect(Buffer.from(messages.acceptanceMessage)).toEqual(am);
    expect(Buffer.from(messages.releaseMessage)).toEqual(rm);
    const verifies = (record: codec.Record): boolean => {
      const m = codec.settlementAuthorization(record);
      return verifySignatureStrict(m.acceptance.signature, m.acceptanceMessage, pkK) && verifySignatureStrict(m.releaseSignature, m.releaseMessage, pkPresenter);
    };
    expect(verifies(signed)).toBe(true);
    for (let i = 0; i < signed.publicInputs.length; i++) {
      let changed = changedInput(signed, i, signed.publicInputs[i]! + 1n);
      if (i < 2) changed = { ...changed, domain: join(integer(changed.publicInputs[0]!, 16), integer(changed.publicInputs[1]!, 16)) };
      expect(verifies(changed)).toBe(false);
    }
    for (const i of [7, 8, 71, 72, 135]) {
      const changed = Uint8Array.from(authorization); changed[i] = changed[i]! ^ 1;
      expect(verifies({ ...signed, authorization: changed })).toBe(false);
    }
    expect(verifySignatureStrict(messages.acceptance.signature, am, pkPresenter)).toBe(false);
    expect(verifySignatureStrict(messages.releaseSignature, rm, pkK)).toBe(false);
    expect(verifySignatureStrict(new Uint8Array(64), am, new Uint8Array(32))).toBe(false);
    expect(() => codec.settlementAuthorization(fixture(4))).toThrow(EncodingError);
  });

  it("issue and withdrawal signatures bind exact statement/domain/segment inputs", () => {
    const key = id(11), pk = ed25519.getPublicKey(key);
    for (const kind of [1, 5] as const) {
      const s = fixture(kind), message = kind === 1 ? rawStatement(s) : join(ascii("moe/pool/v3/withdrawal"), domain, hash(rawStatement(s)));
      const encodeMessage = (v: codec.Record): Uint8Array => kind === 1 ? codec.statementBytes(v) : codec.withdrawalBytes(v);
      expect(Buffer.from(encodeMessage(s))).toEqual(message);
      const signature = ed25519.sign(message, key);
      expect(verifySignatureStrict(signature, encodeMessage(s), pk)).toBe(true);
      for (let i = 0; i < s.publicInputs.length; i++) {
        let changed = changedInput(s, i, s.publicInputs[i]! + 1n);
        if (i < 2) changed = { ...changed, domain: join(integer(changed.publicInputs[0]!, 16), integer(changed.publicInputs[1]!, 16)) };
        expect(verifySignatureStrict(signature, encodeMessage(changed), pk)).toBe(false);
      }
      expect(verifySignatureStrict(signature, codec.statementHash(s), pk)).toBe(false);
    }
    expect(() => codec.withdrawalBytes(fixture(4))).toThrow(EncodingError);
  });

  it("checks acceptance owner/deadline/signature shape and all context separation", () => {
    const p = publication(2); if (p.kind !== 2) throw new Error();
    for (const owner of [0n, FIELD_MODULUS]) {
      const bad = { ...p, acceptance: { ...p.acceptance, owner } };
      expect(() => codec.encodePublication(bad)).toThrow(EncodingError);
      expect(() => codec.decodePublication(rawPublication(bad))).toThrow(EncodingError);
    }
    for (const deadline of [-1n, 1n << 64n, 1 as unknown as bigint]) expect(() => codec.acceptanceBytes({ ...p.acceptance, deadline })).toThrow(EncodingError);
    expect(() => codec.acceptanceBytes({ ...p.acceptance, deadline: (1n << 64n) - 1n })).not.toThrow();
    for (const length of [0, 63, 65]) {
      const bad = { ...p, acceptance: { ...p.acceptance, signature: new Uint8Array(length) } };
      expect(() => codec.encodePublication(bad)).toThrow(EncodingError);
      expect(() => codec.decodePublication(rawPublication(bad))).toThrow(EncodingError);
    }
    const tags = Object.values(contexts).filter((v): v is Uint8Array => v instanceof Uint8Array);
    for (const name of ["statement", "acceptance", "release", "withdrawal", "publication", "delivery"]) tags.push(ascii(`moe/pool/v3/${name}`));
    expect(contexts.contextsArePrefixFree(tags)).toBe(true);
  });
});
