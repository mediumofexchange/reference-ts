import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as terms from "../model/pool-v3-terms.js";
import { decodeBacking } from "../src/backing.js";
import { EncodingError } from "../src/bytes.js";

const b = (n: number): Buffer => Buffer.alloc(32, n);
const cat = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const uint = (n: bigint, width: number): Buffer => Buffer.from(n.toString(16).padStart(width * 2, "0"), "hex");
const lp = (bytes: Uint8Array): Buffer => cat(uint(BigInt(bytes.length), 4), bytes);
const hash = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();
const sk = (seed: Uint8Array) => createPrivateKey({ key: cat(Buffer.from("302e020100300506032b657004220420", "hex"), seed), format: "der", type: "pkcs8" });
const pub = (seed: Uint8Array): Buffer => Buffer.from(createPublicKey(sk(seed)).export({ format: "der", type: "spki" })).subarray(-32);
const secret = b(7), obligor = pub(secret), operator = pub(b(8)), replacement = pub(b(9));
const max64 = (1n << 64n) - 1n, max256 = (1n << 256n) - 1n;
function fields(): terms.RootTerms {
  return { obligor: Buffer.from(obligor), payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
    operator: Buffer.from(operator), configuration: b(3), venue: b(4), interval: 0n };
}
function clauses(x: terms.RootTerms): Buffer[] {
  return [
    ...(x.silence ? [cat(Buffer.of(1), uint(x.silence.noCommitmentDuration, 8), uint(x.silence.challengeWindow, 8))] : []),
    cat(Buffer.of(2), x.venue, uint(x.interval, 8)),
    ...(x.replacementRule ? [cat(Buffer.of(3), x.replacementRule)] : []),
    ...(x.nonService ? [cat(Buffer.of(4), uint(x.nonService.duration, 8), uint(x.nonService.count, 4), uint(x.nonService.window, 8))] : []),
    cat(Buffer.of(5), lp(Buffer.from("moe/pool/v3")), x.configuration),
  ];
}
function prefix(x: terms.RootTerms, thing = Buffer.from(x.payout.thing), quantity?: Buffer): Buffer {
  let h = x.payout.perUnit.toString(16); if (h.length % 2) h = `0${h}`;
  return cat(Buffer.from("MOEB"), Buffer.of(1, 1), x.obligor, Buffer.of(1), lp(thing),
    Buffer.of(x.payout.quantumExponent & 255), lp(quantity ?? Buffer.from(h, "hex")),
    uint(0n, 4), Buffer.of(5), x.operator);
}
function raw(x: terms.RootTerms, cs = clauses(x), p = prefix(x)): Buffer {
  return cat(p, uint(BigInt(cs.length), 4), ...cs);
}
function all(): terms.RootTerms {
  return { ...fields(), interval: max64, silence: { noCommitmentDuration: 0n, challengeWindow: max64 },
    replacementRule: Buffer.from(replacement), nonService: { duration: max64, count: 0xffff_ffffn, window: 0n } };
}

describe("v3 model constant-root terms", () => {
  it("matches independent Buffer framing, node SHA256 and Ed25519; v2 refuses v3", () => {
    for (const x of [fields(), all()]) {
      const bytes = raw(x), message = cat(Buffer.from("moe/backing-signature/v1"), hash(bytes));
      expect(Buffer.from(terms.encodeRootTerms(x))).toEqual(bytes);
      expect(terms.decodeRootTerms(bytes)).toEqual(x);
      expect(Buffer.from(terms.rootTermsName(bytes))).toEqual(hash(bytes));
      expect(Buffer.from(terms.rootTermsSignatureMessage(bytes))).toEqual(message);
      const signature = sign(null, message, sk(secret));
      expect(verify(null, message, createPublicKey(sk(secret)), signature)).toBe(true);
      expect(terms.verifyRootTermsSignature(bytes, signature)).toBe(true);
      expect(() => decodeBacking(bytes)).toThrow("unsupported construction");
      const v2 = Buffer.from(bytes); v2[v2.indexOf("moe/pool/v3") + 10] = 0x32;
      expect(() => terms.decodeRootTerms(v2)).toThrow(EncodingError);
      expect(terms.verifyRootTermsSignature(v2, signature)).toBe(false);
    }
  });

  it("preserves BOM, Unicode byte distinctions and all optional-clause combinations", () => {
    const full = all();
    for (let mask = 0; mask < 8; mask++) {
      const x = { ...fields(), ...(mask & 1 ? { silence: full.silence! } : {}),
        ...(mask & 2 ? { replacementRule: full.replacementRule! } : {}), ...(mask & 4 ? { nonService: full.nonService! } : {}) };
      expect(terms.decodeRootTerms(raw(x))).toEqual(x);
    }
    for (const thing of ["\uFEFFEUR", "é", "e\u0301", "\0", "😀"]) {
      const x = { ...fields(), payout: { ...fields().payout, thing } };
      expect(terms.decodeRootTerms(raw(x)).payout.thing).toBe(thing);
      expect(Buffer.from(terms.encodeRootTerms(x))).toEqual(raw(x));
    }
    expect(terms.rootTermsName(raw({ ...fields(), payout: { ...fields().payout, thing: "é" } })))
      .not.toEqual(terms.rootTermsName(raw({ ...fields(), payout: { ...fields().payout, thing: "e\u0301" } })));
  });

  it("accepts exact maximum bounds and refuses oversized wire and field inputs", () => {
    const x = { ...all(), payout: { thing: "x".repeat(1024), quantumExponent: 127, perUnit: max256 } };
    const bytes = raw(x);
    expect(bytes.length).toBe(1305); expect(terms.MAX_ROOT_TERMS_BYTES).toBe(bytes.length);
    expect(terms.decodeRootTerms(bytes)).toEqual(x);
    expect(Buffer.from(terms.encodeRootTerms(x))).toEqual(bytes);
    expect(() => terms.decodeRootTerms(cat(bytes, Buffer.of(0)))).toThrow(EncodingError);
    for (const payout of [{ ...x.payout, thing: "x".repeat(1025) }, { ...x.payout, thing: "é".repeat(513) },
      { ...x.payout, perUnit: max256 + 1n }, { ...x.payout, perUnit: 0n }, { ...x.payout, quantumExponent: 128 }]) {
      expect(() => terms.encodeRootTerms({ ...x, payout })).toThrow(EncodingError);
    }
    expect(terms.decodeRootTerms(raw({ ...fields(), payout: { thing: "x", quantumExponent: -128, perUnit: 1n } })).payout.quantumExponent).toBe(-128);
  });

  it("refuses every truncation, trailing byte, unknown tag and malformed framing", () => {
    const x = all(), bytes = raw(x);
    for (let i = 0; i < bytes.length; i++) expect(() => terms.decodeRootTerms(bytes.subarray(0, i))).toThrow(EncodingError);
    expect(() => terms.decodeRootTerms(cat(bytes, Buffer.of(0)))).toThrow(EncodingError);
    for (const offset of [0, 4, 5, 38, prefix(x).length - 33]) {
      const bad = Buffer.from(bytes); bad[offset] = 99;
      expect(() => terms.decodeRootTerms(bad)).toThrow(EncodingError);
    }
    const p = prefix(x); p.writeUInt32BE(1, p.length - 37);
    expect(() => terms.decodeRootTerms(raw(x, clauses(x), p))).toThrow("unsupported reliance");
    for (const count of [0, 1, 6, 0xffff_ffff]) {
      const bad = Buffer.from(bytes); bad.writeUInt32BE(count, prefix(x).length);
      expect(() => terms.decodeRootTerms(bad)).toThrow(EncodingError);
    }
    for (const cs of [clauses(x).reverse(), [clauses(x)[0]!, ...clauses(x).slice(0, 4)],
      [clauses(x)[0]!, clauses(x)[4]!], clauses(x).slice(0, 4), [clauses(x)[1]!, Buffer.of(6)]]) {
      expect(() => terms.decodeRootTerms(raw(x, cs))).toThrow(EncodingError);
    }
    for (const text of ["moe/pool/v2", "moe/pool/v3\0", "moe/pool/V3"]) {
      expect(() => terms.decodeRootTerms(raw(fields(), [clauses(fields())[0]!, cat(Buffer.of(5), lp(Buffer.from(text)), x.configuration)]))).toThrow(EncodingError);
    }
  });

  it("refuses malformed UTF-8, nonminimal quantities and hostile length prefixes", () => {
    const x = fields();
    for (const thing of [Buffer.alloc(0), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xff])]) {
      expect(() => terms.decodeRootTerms(raw(x, clauses(x), prefix(x, thing)))).toThrow(EncodingError);
    }
    for (const q of [Buffer.alloc(0), Buffer.of(0), Buffer.of(0, 1), Buffer.alloc(33, 1)]) {
      expect(() => terms.decodeRootTerms(raw(x, clauses(x), prefix(x, undefined, q)))).toThrow(EncodingError);
    }
    const bad = raw(x); bad.writeUInt32BE(0xffff_ffff, 39);
    expect(() => terms.decodeRootTerms(bad)).toThrow(EncodingError);
    expect(() => terms.encodeRootTerms({ ...x, payout: { ...x.payout, thing: "\ud800" } })).toThrow(EncodingError);
  });

  it("checks canonical non-small-order keys for all authority fields", () => {
    const identity = Buffer.alloc(32); identity[0] = 1;
    for (const invalid of [Buffer.alloc(32), identity, Buffer.alloc(32, 255), Buffer.alloc(31)]) {
      for (const field of ["obligor", "operator", "replacementRule"] as const) {
        const x = { ...all(), [field]: invalid };
        expect(() => terms.encodeRootTerms(x)).toThrow(EncodingError);
        if (invalid.length === 32) expect(() => terms.decodeRootTerms(raw(x))).toThrow(EncodingError);
      }
    }
  });

  it("authenticates every terms field and refuses wrong name/signature encodings", () => {
    const x = all(), bytes = raw(x), signature = sign(null, terms.rootTermsSignatureMessage(bytes), sk(secret));
    const variants: terms.RootTerms[] = [
      ...(["obligor", "operator", "replacementRule"] as const).map(field => ({ ...x, [field]: pub(b(10)) })),
      ...(["configuration", "venue"] as const).map(field => ({ ...x, [field]: b(11) })),
      { ...x, interval: 1n }, { ...x, payout: { ...x.payout, thing: "USD" } },
      { ...x, payout: { ...x.payout, quantumExponent: 0 } }, { ...x, payout: { ...x.payout, perUnit: 101n } },
      { ...x, silence: { noCommitmentDuration: 1n, challengeWindow: max64 } },
      { ...x, silence: { noCommitmentDuration: 0n, challengeWindow: 1n } },
      { ...x, nonService: { duration: 1n, count: 0xffff_ffffn, window: 0n } },
      { ...x, nonService: { duration: max64, count: 1n, window: 0n } },
      { ...x, nonService: { duration: max64, count: 0xffff_ffffn, window: 1n } },
    ];
    for (const v of variants) expect(terms.verifyRootTermsSignature(raw(v), signature)).toBe(false);
    expect(terms.verifyRootTermsSignature(bytes, sign(null, cat(Buffer.from("moe/backing-signature/v1"), b(0)), sk(secret)))).toBe(false);
    for (const sig of [signature.subarray(1), cat(signature, Buffer.of(0)), Buffer.alloc(64),
      cat(Buffer.alloc(32, 255), signature.subarray(32)), cat(signature.subarray(0, 32), Buffer.alloc(32, 255))]) {
      expect(terms.verifyRootTermsSignature(bytes, sig)).toBe(false);
    }
  });

  it("preserves the existing strict rule accepting canonical identity R with a valid equation", () => {
    // Independent RFC8032 scalar expansion and equation fixture with nonce r = 0.
    const l = (1n << 252n) + 27742317777372353535851937790883648493n;
    const little = (v: Uint8Array): bigint => BigInt(`0x${Buffer.from(v).reverse().toString("hex")}`);
    const expanded = createHash("sha512").update(secret).digest().subarray(0, 32);
    expanded[0] = expanded[0]! & 248; expanded[31] = (expanded[31]! & 63) | 64;
    const bytes = raw(fields()), message = cat(Buffer.from("moe/backing-signature/v1"), hash(bytes));
    const r = Buffer.alloc(32); r[0] = 1;
    const k = little(createHash("sha512").update(cat(r, obligor, message)).digest()) % l;
    const signature = cat(r, uint((k * little(expanded)) % l, 32).reverse());
    expect(verify(null, message, createPublicKey(sk(secret)), signature)).toBe(true);
    expect(terms.verifyRootTermsSignature(bytes, signature)).toBe(true);
    const noncanonicalR = Buffer.from(r); noncanonicalR[31] = 128;
    expect(terms.verifyRootTermsSignature(bytes, cat(noncanonicalR, signature.subarray(32)))).toBe(false);
    expect(terms.verifyRootTermsSignature(bytes, cat(r, uint(l, 32).reverse()))).toBe(false);
  });

  it("owns Buffer input/output and rejects SharedArrayBuffer at every bytes boundary", () => {
    const x = all(), encoded = terms.encodeRootTerms(x), reference = Buffer.from(encoded);
    x.obligor.fill(0); x.operator.fill(0); x.configuration.fill(0); x.venue.fill(0); x.replacementRule!.fill(0);
    expect(Buffer.from(encoded)).toEqual(reference);
    const input = raw(all()), decoded = terms.decodeRootTerms(input), before = Buffer.from(input);
    input.fill(0); expect(Buffer.from(terms.encodeRootTerms(decoded))).toEqual(before);
    const second = terms.decodeRootTerms(before); decoded.obligor.fill(0); decoded.configuration.fill(0); decoded.venue.fill(0);
    expect(Buffer.from(terms.encodeRootTerms(second))).toEqual(before);
    const name = terms.rootTermsName(before); name.fill(0); expect(Buffer.from(terms.rootTermsName(before))).toEqual(hash(before));
    const shared = (v: Uint8Array): Uint8Array => { const out = new Uint8Array(new SharedArrayBuffer(v.length)); out.set(v); return out; };
    expect(() => terms.decodeRootTerms(shared(before))).toThrow(EncodingError);
    expect(() => terms.rootTermsName(shared(before))).toThrow(EncodingError);
    expect(() => terms.rootTermsSignatureMessage(shared(before))).toThrow(EncodingError);
    const sig = sign(null, terms.rootTermsSignatureMessage(before), sk(secret));
    expect(terms.verifyRootTermsSignature(shared(before), sig)).toBe(false);
    expect(terms.verifyRootTermsSignature(before, shared(sig))).toBe(false);
    for (const field of ["obligor", "operator", "configuration", "venue", "replacementRule"] as const) {
      const full = all(); expect(() => terms.encodeRootTerms({ ...full, [field]: shared(full[field]!) })).toThrow(EncodingError);
    }
  });

  it("reports malformed encoder values as EncodingError and verification inputs as false", () => {
    for (const bad of [null, undefined, [], "x", {}, { ...fields(), payout: null },
      { ...fields(), payout: { ...fields().payout, backing: b(1) } }, { ...fields(), reliance: [] },
      { ...fields(), interval: 0 }, { ...fields(), silence: null }, { ...fields(), nonService: null },
      { ...fields(), nonService: { duration: 0n, count: 1, window: 0n } },
      { ...fields(), silence: { noCommitmentDuration: -1n, challengeWindow: 0n } },
      { ...fields(), interval: max64 + 1n }, { ...fields(), configuration: "x".repeat(32) }]) {
      expect(() => terms.encodeRootTerms(bad as terms.RootTerms)).toThrow(EncodingError);
    }
    for (const bad of [null, undefined, [], "x", new DataView(new ArrayBuffer(32))]) {
      expect(() => terms.decodeRootTerms(bad as unknown as Uint8Array)).toThrow(EncodingError);
      expect(terms.verifyRootTermsSignature(bad as unknown as Uint8Array, Buffer.alloc(64))).toBe(false);
      expect(terms.verifyRootTermsSignature(raw(fields()), bad as unknown as Uint8Array)).toBe(false);
    }
  });
});
