import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { EncodingError } from "../src/bytes.js";
import { litConfigHash } from "../src/lit/configuration.js";
import * as terms from "../src/lit/terms.js";
import * as transport from "../src/lit/transport.js";
import * as v3Terms from "../src/pool/v3/terms.js";
import * as v3Headers from "../src/pool/v3/headers.js";

// lit-v1 §§6, 9 frames against a Buffer/node:crypto oracle: the header, trail
// and package are pool-v3's under lit contexts and bounds, and the terms the
// MOEB frame with construction `moe/lit/v1` and the tag-6 silence clause.
const ascii = (s: string): Buffer => Buffer.from(s, "ascii");
const join = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const int = (v: bigint | number, bytes: number): Buffer => Buffer.from(BigInt(v).toString(16).padStart(bytes * 2, "0"), "hex");
const hash = (...b: Uint8Array[]): Buffer => createHash("sha256").update(join(...b)).digest();
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const id = (n: number): Buffer => Buffer.alloc(32, n);
const keyOf = (n: number): Uint8Array => ed25519.getPublicKey(hash(ascii("lit transport"), int(n, 1)));
const reason = (f: () => unknown): string => {
  try { f(); } catch (error) { expect(error).toBeInstanceOf(EncodingError); return (error as Error).message; }
  throw new Error("expected a refusal");
};

const DOMAIN = litConfigHash();
const header = { domain: DOMAIN, venue: id(3), operator: keyOf(1), sequence: 4n,
  entries: [{ backing: id(10), link: id(11) }, { backing: id(12), link: id(13), opening: { operator: keyOf(2), sequence: 9n, root: id(14) } }] };
const headerOracle = join(ascii("moe/lit/v1/segment"), DOMAIN, id(3), keyOf(1), int(4n, 8), int(2, 4),
  id(10), id(11), Buffer.alloc(72), id(12), id(13), int(9n, 8), keyOf(2), id(14));

describe("lit-v1 §6 segment header", () => {
  it("is pool-v3 §8's layout under the lit context: 126 bytes and 136 per entry", () => {
    const bytes = transport.litSegmentBytes(header);
    expect(hex(bytes)).toBe(hex(headerOracle));
    expect(bytes.length).toBe(126 + 2 * 136);
    expect(hex(transport.litSegmentIdentity(header))).toBe(hex(hash(headerOracle)));
    expect(hex(transport.litSegmentBytes(transport.decodeLitSegmentHeader(bytes)))).toBe(hex(bytes));
    expect(transport.MIN_LIT_HEADER_BYTES).toBe(262);
    expect(transport.MAX_LIT_HEADER_BYTES).toBe(8_913_022);
  });

  it("never reads a pool header as a lit one or the reverse", () => {
    const pool = v3Headers.segmentBytes(header);
    expect(pool.length).toBe(127 + 2 * 136);
    expect(reason(() => transport.decodeLitSegmentHeader(pool))).toBe("wrong segment context");
    expect(reason(() => v3Headers.decodeSegmentHeader(headerOracle))).toBe("wrong segment context");
    const lookalike = join(ascii("moe/pool/v3/segmen"), headerOracle.subarray(18));
    expect(reason(() => transport.decodeLitSegmentHeader(lookalike))).toBe("wrong segment context");
  });
});

describe("lit-v1 §6 trail and package", () => {
  const scoped = [{ terms: Uint8Array.of(1, 2, 3), signature: new Uint8Array(64).fill(7) }, { terms: new Uint8Array(0), signature: new Uint8Array(64) }];
  const records = [Uint8Array.of(9), new Uint8Array(8200).fill(5)];
  const trail = { header: headerOracle, terms: scoped, records };
  it("frames a trail in 28 fixed bytes and bounds each record at 8200", () => {
    const bytes = transport.encodeLitTrail(trail);
    const oracle = join(ascii("moe/lit/v1/trail"), int(headerOracle.length, 4), headerOracle,
      int(3, 4), scoped[0]!.terms, scoped[0]!.signature, int(0, 4), scoped[1]!.signature, int(2n, 8),
      int(1, 4), records[0]!, int(8200, 4), records[1]!);
    expect(hex(bytes)).toBe(hex(oracle));
    expect(bytes.length).toBe(28 + headerOracle.length + 68 * 2 + 3 + 4 * 2 + 1 + 8200);
    const decoded = transport.decodeLitTrail(bytes);
    expect(hex(transport.encodeLitTrail(decoded))).toBe(hex(bytes));
    expect(reason(() => transport.encodeLitTrail({ ...trail, records: [new Uint8Array(8201)] }))).toBe("trail record too long");
    const long = join(oracle.subarray(0, oracle.length - 8204), int(8201, 4), new Uint8Array(8201));
    expect(reason(() => transport.decodeLitTrail(long))).toBe("trail field byte bound");
    expect(reason(() => transport.encodeLitTrail({ ...trail, header: v3Headers.segmentBytes(header) }))).toBe("wrong trail context");
  });

  it("frames a package in 22 fixed bytes with pool-v3 §12's kinds and order", () => {
    const items = [{ kind: 1, payload: Uint8Array.of(1) }, { kind: 6, payload: Uint8Array.of(2, 3) }];
    const bytes = transport.encodeLitPackage(items);
    expect(hex(bytes)).toBe(hex(join(ascii("moe/lit/v1/package"), int(2, 4), int(1, 1), int(1n, 8), Uint8Array.of(1),
      int(6, 1), int(2n, 8), Uint8Array.of(2, 3))));
    expect(transport.decodeLitPackage(bytes).map(i => i.kind)).toEqual([1, 6]);
    expect(reason(() => transport.decodeLitPackage(join(ascii("moe/pool/v3/package"), int(0, 4))))).toBe("wrong package context");
    expect(reason(() => transport.encodeLitPackage([...items].reverse()))).toBe("evidence items must be strictly ordered");
  });
});

describe("lit-v1 §9 root terms", () => {
  const fields: terms.LitRootTerms = { obligor: keyOf(1), payout: { thing: "gram of gold", quantumExponent: -3, perUnit: 5n },
    operator: keyOf(2), configuration: DOMAIN, venue: id(3), interval: 60n, silence: { noCommitmentDuration: 720n },
    replacementRule: keyOf(4), nonService: { duration: 30n, count: 3n, window: 90n } };
  const oracle = join(ascii("MOEB"), int(1, 1), int(1, 1), keyOf(1), int(1, 1), int(12, 4), ascii("gram of gold"), int(0xfd, 1),
    int(1, 4), int(5, 1), int(0, 4), int(5, 1), keyOf(2), int(5, 4),
    int(2, 1), id(3), int(60n, 8), int(3, 1), keyOf(4), int(4, 1), int(30n, 8), int(3, 4), int(90n, 8),
    int(5, 1), int(10, 4), ascii("moe/lit/v1"), DOMAIN, int(6, 1), int(720n, 8));
  it("encodes the tag-6 silence clause after the construction, and names the terms by their hash", () => {
    const bytes = terms.encodeLitTerms(fields);
    expect(hex(bytes)).toBe(hex(oracle));
    expect(hex(terms.litTermsName(bytes))).toBe(hex(hash(oracle)));
    expect(terms.decodeLitTerms(bytes)).toEqual(terms.decodeLitTerms(terms.encodeLitTerms(terms.decodeLitTerms(bytes))));
    expect(hex(terms.encodeLitTerms(terms.decodeLitTerms(bytes)))).toBe(hex(bytes));
    expect(terms.MAX_LIT_TERMS_BYTES).toBe(1296);
    const message = terms.litTermsSignatureMessage(bytes);
    expect(hex(message)).toBe(hex(join(ascii("moe/backing-signature/v1"), hash(oracle))));
    const secret = hash(ascii("lit transport"), int(1, 1));
    expect(terms.verifyLitTermsSignature(bytes, ed25519.sign(message, secret))).toBe(true);
  });

  it("decodes under one construction only, and gives each clause tag one payload", () => {
    const bytes = terms.encodeLitTerms(fields);
    expect(reason(() => v3Terms.decodeRootTerms(bytes))).toBe("unsupported construction");
    const pool = v3Terms.encodeRootTerms({ ...fields, silence: { noCommitmentDuration: 720n, challengeWindow: 10n } });
    expect(reason(() => terms.decodeLitTerms(pool))).toBe("unsupported clause");
    const { silence: _, ...unsilenced } = fields;
    const poolNoSilence = v3Terms.encodeRootTerms(unsilenced);
    expect(reason(() => terms.decodeLitTerms(poolNoSilence))).toBe("field too long");
    // A tag-6 clause in pool terms is refused: rewrite the construction to the pool's and keep tag 6.
    const tagged = join(oracle.subarray(0, oracle.length - 56), int(5, 1), int(11, 4), ascii("moe/pool/v3"), DOMAIN, int(6, 1), int(720n, 8));
    expect(reason(() => v3Terms.decodeRootTerms(tagged)))
      .toBe("unsupported clause");
    expect(reason(() => terms.encodeLitTerms({ ...fields, silence: { noCommitmentDuration: 1n, challengeWindow: 2n } as never })))
      .toBe("invalid challenge window");
    expect(reason(() => terms.decodeLitTerms(join(oracle, int(0, 1))))).toBe("trailing bytes");
  });
});
