import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { EncodingError } from "../src/bytes.js";
import { utf8Encoder } from "../src/contexts.js";
import { bytesToField, fieldToBytes, fieldToHex, FIELD_MODULUS, hexToField, identifierOf, limbsOf } from "../src/pool/field.js";
import { ScopeTree } from "../src/pool/scope.js";
import {
  BURN,
  configurationBytes,
  configurationHash,
  copySegmentHeader,
  copyStatement,
  decodeSegmentHeader,
  decodeStatement,
  encodeStatement,
  genesisHistoryHash,
  ISSUE,
  isWellFormedHeader,
  isWellFormedStatement,
  MAX_PROOF_BYTES,
  nextHistoryHash,
  parsePublicInputs,
  PUBLIC_INPUT_COUNT,
  segmentAuthority,
  segmentBytes,
  segmentIdentity,
  snapshotDigest,
  SPEND,
  statementBytes,
  statementHash,
  type SegmentHeader,
  type Statement,
} from "../src/pool/statement.js";
import { CONFIG, DOMAIN, headerOf, issueStatement, makePoolBacking, spendStatement, VENUE } from "./pool-support.js";
import { KEYS, SECRETS } from "./support.js";

const u64 = (n: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
};
const u32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const tag = (s: string): Uint8Array => utf8Encoder.encode(s);
const fill = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

const X = makePoolBacking(SECRETS.backer, "EUR");
const Y = makePoolBacking(SECRETS.backer2, "USD");
const [first, second] = [X, Y].sort((a, b) => Buffer.compare(a.name, b.name)) as [typeof X, typeof Y];
const HEADER = headerOf([{ backing: X.name }, { backing: Y.name, link: fill(0x51), opening: { operator: KEYS.carol, sequence: 4n, root: fill(0x52) } }], KEYS.operator, 7n);
const AUTH = segmentAuthority(HEADER);

describe("pool-v2 §1: field encodings", () => {
  it("writes 32 big-endian bytes and 64 lowercase hex digits, and reads nothing else", () => {
    expect(fieldToBytes(1n)).toEqual(new Uint8Array([...new Uint8Array(31), 1]));
    expect(bytesToField(fieldToBytes(FIELD_MODULUS - 1n))).toBe(FIELD_MODULUS - 1n);
    expect(() => fieldToBytes(FIELD_MODULUS)).toThrow(EncodingError);
    expect(() => bytesToField(fieldToBytes(FIELD_MODULUS - 1n).map((b, i) => (i === 0 ? 0x31 : b)))).toThrow(EncodingError);
    expect(() => bytesToField(new Uint8Array(31))).toThrow(EncodingError);
    expect(() => bytesToField(new Uint8Array(33))).toThrow(EncodingError);
    expect(fieldToHex(255n)).toBe("0x" + "0".repeat(62) + "ff");
    expect(hexToField(fieldToHex(FIELD_MODULUS - 1n))).toBe(FIELD_MODULUS - 1n);
    for (const bad of ["0x" + "0".repeat(62) + "FF", "0x" + "f".repeat(64), "0x00", "00".repeat(32), 12, null]) {
      expect(() => hexToField(bad)).toThrow(EncodingError);
    }
  });

  it("splits an identifier into two 128-bit limbs and refuses a limb at 2^128", () => {
    const id = new Uint8Array(32).map((_, i) => i);
    const [hi, lo] = limbsOf(id);
    expect(hi).toBe(BigInt("0x000102030405060708090a0b0c0d0e0f"));
    expect(lo).toBe(BigInt("0x101112131415161718191a1b1c1d1e1f"));
    expect(identifierOf(hi, lo)).toEqual(id);
    expect(() => identifierOf(1n << 128n, 0n)).toThrow(EncodingError);
    expect(() => identifierOf(0n, -1n)).toThrow(EncodingError);
    expect(() => limbsOf(new Uint8Array(16))).toThrow(EncodingError);
  });
});

describe("pool-v2 §2: the configuration is the domain", () => {
  it("frames the configuration exactly, with neither operator nor pool identity, and hashes it", () => {
    const expected = Buffer.concat([
      tag("moe/pool/v2/config"),
      CONFIG.issue.bytecode, CONFIG.issue.vk, CONFIG.spend.bytecode, CONFIG.spend.vk, CONFIG.burn.bytecode, CONFIG.burn.vk,
      CONFIG.helper, new Uint8Array([32, 16, 2, 2]),
    ]);
    expect(configurationBytes(CONFIG)).toEqual(new Uint8Array(expected));
    expect(configurationHash(CONFIG)).toEqual(sha256(expected));
    expect(configurationHash({ ...CONFIG, helper: new Uint8Array(32) })).not.toEqual(DOMAIN);
    expect(configurationHash({ ...CONFIG, spend: CONFIG.burn })).not.toEqual(DOMAIN);
    expect(() => configurationHash({ ...CONFIG, helper: new Uint8Array(31) })).toThrow(EncodingError);
    expect(Object.keys(CONFIG)).toEqual(["issue", "spend", "burn", "helper"]);
  });
});

describe("pool-v2 §6: the segment header and its identity", () => {
  it("frames the header exactly: domain, venue, operator, sequence, then each sorted entry with its opening or the empty book", () => {
    const zero = new Uint8Array(32);
    const entry = (b: typeof X): Uint8Array => b === X
      ? Buffer.concat([X.name, X.name, u64(0n), zero, zero])
      : Buffer.concat([Y.name, fill(0x51), u64(4n), KEYS.carol, fill(0x52)]);
    const expected = Buffer.concat([tag("moe/pool/v2/segment"), DOMAIN, VENUE, KEYS.operator, u64(7n), u32(2), entry(first), entry(second)]);
    expect(segmentBytes(HEADER)).toEqual(new Uint8Array(expected));
    expect(segmentIdentity(HEADER)).toEqual(sha256(expected));
    expect(decodeSegmentHeader(segmentBytes(HEADER))).toEqual(copySegmentHeader(HEADER));
    expect(segmentBytes(decodeSegmentHeader(segmentBytes(HEADER)))).toEqual(segmentBytes(HEADER));
    // Another sequence, link, opening or scope is another segment.
    for (const other of [
      { ...HEADER, sequence: 8n },
      { ...HEADER, venue: fill(0x34) },
      { ...HEADER, operator: KEYS.mallory },
      headerOf([{ backing: X.name, link: fill(1) }, { backing: Y.name, link: fill(0x51), opening: { operator: KEYS.carol, sequence: 4n, root: fill(0x52) } }], KEYS.operator, 7n),
      headerOf([{ backing: X.name }, { backing: Y.name, link: fill(0x51), opening: { operator: KEYS.carol, sequence: 5n, root: fill(0x52) } }], KEYS.operator, 7n),
      headerOf([{ backing: X.name }, { backing: Y.name, link: fill(0x51) }], KEYS.operator, 7n),
      headerOf([{ backing: X.name }], KEYS.operator, 7n),
    ]) expect(segmentIdentity(other)).not.toEqual(segmentIdentity(HEADER));
  });

  it("is well-formed only with a valid operator, a sequence from one, a canonical scope, and openings below this operator's sequence", () => {
    expect(isWellFormedHeader(HEADER)).toBe(true);
    const unsorted = { ...HEADER, entries: [...HEADER.entries].reverse() };
    const bad: unknown[] = [
      null, {}, { ...HEADER, domain: new Uint8Array(31) }, { ...HEADER, venue: new Uint8Array(33) },
      { ...HEADER, operator: new Uint8Array(32) }, { ...HEADER, sequence: 0n }, { ...HEADER, sequence: 1n << 64n }, { ...HEADER, sequence: 7 },
      { ...HEADER, entries: [] }, unsorted,
      { ...HEADER, entries: [HEADER.entries[0], HEADER.entries[0]] },
      { ...HEADER, entries: HEADER.entries.map((e) => ({ ...e, link: new Uint8Array(31) })) },
      headerOf([{ backing: X.name, opening: { operator: KEYS.operator, sequence: 7n, root: fill(1) } }], KEYS.operator, 7n),
      headerOf([{ backing: X.name, opening: { operator: KEYS.operator, sequence: 9n, root: fill(1) } }], KEYS.operator, 7n),
      headerOf([{ backing: X.name, opening: { operator: KEYS.operator, sequence: 0n, root: fill(1) } }], KEYS.operator, 7n),
      headerOf([{ backing: X.name, opening: { operator: new Uint8Array(32), sequence: 1n, root: fill(1) } }], KEYS.operator, 7n),
      headerOf([{ backing: X.name, opening: { operator: KEYS.carol, sequence: 1n, root: new Uint8Array(31) } }], KEYS.operator, 7n),
    ];
    for (const header of bad) {
      expect(isWellFormedHeader(header), JSON.stringify(header, (_, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 80)).toBe(false);
      expect(() => segmentBytes(header as SegmentHeader)).toThrow(EncodingError);
    }
    // The same operator's earlier commitment may open this segment (C2.10.5); another operator's may be at any sequence.
    expect(isWellFormedHeader(headerOf([{ backing: X.name, opening: { operator: KEYS.operator, sequence: 6n, root: fill(1) } }], KEYS.operator, 7n))).toBe(true);
    expect(isWellFormedHeader(headerOf([{ backing: X.name, opening: { operator: KEYS.carol, sequence: 99n, root: fill(1) } }], KEYS.operator, 7n))).toBe(true);
    // A holey entries array is not a scope.
    const holey = [...HEADER.entries];
    delete holey[1];
    expect(isWellFormedHeader({ ...HEADER, entries: holey })).toBe(false);
  });

  it("decodes only the canonical bytes: an empty book is sequence zero with zero operator and root, and nothing trails", () => {
    const bytes = segmentBytes(HEADER);
    expect(() => decodeSegmentHeader(bytes.subarray(0, bytes.length - 1))).toThrow(EncodingError);
    expect(() => decodeSegmentHeader(new Uint8Array([...bytes, 0]))).toThrow(EncodingError);
    const wrongContext = new Uint8Array(bytes);
    wrongContext[0] = (wrongContext[0] as number) ^ 1;
    expect(() => decodeSegmentHeader(wrongContext)).toThrow(EncodingError);
    // Genesis with a nonzero opening operator is malformed.
    const offset = tag("moe/pool/v2/segment").length + 32 * 3 + 8 + 4 + (first === X ? 0 : 136) + 64 + 8;
    const smuggled = new Uint8Array(bytes);
    smuggled[offset] = 1;
    expect(() => decodeSegmentHeader(smuggled)).toThrow(EncodingError);
    // An opening by this operator at this sequence is refused on decode as on construction.
    const selfOpened = headerOf([{ backing: X.name, opening: { operator: KEYS.operator, sequence: 6n, root: fill(1) } }], KEYS.operator, 7n);
    const selfBytes = segmentBytes(selfOpened);
    const raised = new Uint8Array(selfBytes);
    raised.set(u64(7n), tag("moe/pool/v2/segment").length + 32 * 3 + 8 + 4 + 64);
    expect(() => decodeSegmentHeader(raised)).toThrow(EncodingError);
    for (const notBytes of [null, undefined, 42, "0x00", { length: 100 }]) {
      expect(() => decodeSegmentHeader(notBytes as unknown as Uint8Array)).toThrow(EncodingError);
    }
  });

  it("derives the authority a receipt is verified against: domain, identity, scope root, operator", () => {
    expect(AUTH.domain).toEqual(DOMAIN);
    expect(AUTH.segment).toEqual(segmentIdentity(HEADER));
    expect(AUTH.scopeRoot).toBe(new ScopeTree(HEADER.entries).root());
    expect(AUTH.operator).toEqual(KEYS.operator);
    expect(segmentAuthority({ ...HEADER, sequence: 8n }).scopeRoot).toBe(AUTH.scopeRoot);
    expect(segmentAuthority({ ...HEADER, sequence: 8n }).segment).not.toEqual(AUTH.segment);
    expect(() => segmentAuthority({ ...HEADER, sequence: 0n })).toThrow(EncodingError);
  });
});

describe("pool-v2 §7: statements and their identity", () => {
  it("frames the statement bytes as context, domain, kind, count and fields, with nine, eleven and thirteen fields", () => {
    const inputs = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n];
    const expected = Buffer.concat([tag("moe/pool/v2/statement"), DOMAIN, new Uint8Array([1]), u32(9), ...inputs.map(fieldToBytes)]);
    expect(statementBytes(DOMAIN, ISSUE, inputs)).toEqual(new Uint8Array(expected));
    expect(statementHash(DOMAIN, ISSUE, inputs)).toEqual(sha256(expected));
    expect(() => statementBytes(DOMAIN, SPEND, inputs)).toThrow(EncodingError);
    expect(() => statementBytes(DOMAIN, ISSUE, [...inputs.slice(0, 8), FIELD_MODULUS])).toThrow(EncodingError);
    expect(() => statementBytes(DOMAIN, 4 as never, inputs)).toThrow(EncodingError);
    expect(PUBLIC_INPUT_COUNT).toEqual({ 1: 9, 2: 11, 3: 13 });
  });

  it("recognizes a well-formed statement by kind, count, field canonicity, proof shape and signature presence", () => {
    const issue = issueStatement(AUTH, X.name, 5n, 77n, SECRETS.backer);
    expect(isWellFormedStatement(issue)).toBe(true);
    const spend = spendStatement(AUTH, [1n, 1n], [2n, 3n], [4n, 5n]);
    expect(isWellFormedStatement(spend)).toBe(true);
    const cases: unknown[] = [
      null, {}, { ...issue, kind: 0 }, { ...issue, kind: "1" }, { ...issue, publicInputs: issue.publicInputs.slice(1) },
      { ...issue, publicInputs: [...issue.publicInputs, 0n] }, { ...issue, publicInputs: issue.publicInputs.map((_, i) => (i === 8 ? FIELD_MODULUS : 1n)) },
      { ...issue, publicInputs: issue.publicInputs.map(Number) }, { ...issue, proof: new Uint8Array(0) },
      { ...issue, proof: new Uint8Array(31) }, { ...issue, proof: new Uint8Array(MAX_PROOF_BYTES + 32) },
      { ...issue, obligorSignature: undefined }, { ...issue, obligorSignature: new Uint8Array(63) },
      { ...spend, obligorSignature: new Uint8Array(64) }, { ...spend, kind: BURN },
    ];
    for (const bad of cases) expect(isWellFormedStatement(bad)).toBe(false);
    const holey = [...issue.publicInputs];
    delete holey[5];
    expect(isWellFormedStatement({ ...issue, publicInputs: holey })).toBe(false);
    expect(isWellFormedStatement({ ...issue, proof: new Uint8Array(MAX_PROOF_BYTES) })).toBe(true);
    expect(() => copyStatement({ ...spend, proof: new Uint8Array(33) })).toThrow(EncodingError);
    const copy = copyStatement(issue);
    expect(copy).toEqual(issue);
    copy.proof[0] = (copy.proof[0] as number) ^ 1;
    expect(issue.proof[0]).not.toBe(copy.proof[0]);
  });

  it("reads the public inputs by position: domain, segment and scope root first, then the kind's fields", () => {
    const head = [...limbsOf(DOMAIN), ...limbsOf(AUTH.segment), AUTH.scopeRoot];
    const common = { domain: DOMAIN, segment: AUTH.segment, scopeRoot: AUTH.scopeRoot };
    const issue = parsePublicInputs(ISSUE, [...head, ...limbsOf(X.name), 5n, 77n]);
    expect(issue).toEqual({ kind: ISSUE, ...common, backing: X.name, quantity: 5n, anchors: [], nullifiers: [], outputs: [77n] });
    const spend = parsePublicInputs(SPEND, [...head, 1n, 2n, 3n, 4n, 5n, 6n]);
    expect(spend).toEqual({ kind: SPEND, ...common, anchors: [1n, 2n], nullifiers: [3n, 4n], outputs: [5n, 6n] });
    const burn = parsePublicInputs(BURN, [...head, ...limbsOf(X.name), 6n, 1n, 2n, 3n, 4n, 5n]);
    expect(burn).toEqual({ kind: BURN, ...common, backing: X.name, quantity: 6n, anchors: [1n, 2n], nullifiers: [3n, 4n], outputs: [5n] });
    const nine = (i: number, v: bigint): bigint[] => [...head, ...limbsOf(X.name), 5n, 77n].map((x, j) => (j === i ? v : x));
    expect(() => parsePublicInputs(ISSUE, nine(0, 1n << 128n))).toThrow(EncodingError);
    expect(() => parsePublicInputs(ISSUE, nine(3, 1n << 128n))).toThrow(EncodingError);
    expect(() => parsePublicInputs(ISSUE, nine(6, 1n << 128n))).toThrow(EncodingError);
    expect(() => parsePublicInputs(ISSUE, nine(7, 1n << 64n))).toThrow(EncodingError);
    expect(() => parsePublicInputs(ISSUE, nine(7, 0n))).toThrow(EncodingError);
    expect(() => parsePublicInputs(BURN, [...head, ...limbsOf(X.name), 1n << 64n, 1n, 2n, 3n, 4n, 5n])).toThrow(EncodingError);
    expect(() => parsePublicInputs(BURN, [...head, ...limbsOf(X.name), 0n, 1n, 2n, 3n, 4n, 5n])).toThrow(EncodingError);
    const holey = nine(0, 0n);
    delete holey[5];
    expect(() => parsePublicInputs(ISSUE, holey)).toThrow(EncodingError);
    expect(() => parsePublicInputs(SPEND, [...head, 1n, 2n, 3n, 4n, 5n])).toThrow(EncodingError);
    expect(() => parsePublicInputs(SPEND, [...head, 1n, 2n, 3n, 4n, 5n, FIELD_MODULUS])).toThrow(EncodingError);
  });

  it("encodes a statement record strictly and decodes only the canonical bytes", () => {
    const issue = issueStatement(AUTH, X.name, 5n, 77n, SECRETS.backer);
    const spend = spendStatement(AUTH, [1n, 1n], [2n, 3n], [4n, 5n]);
    for (const statement of [issue, spend]) {
      const bytes = encodeStatement(DOMAIN, statement);
      const decoded = decodeStatement(bytes);
      expect(decoded.domain).toEqual(DOMAIN);
      expect(decoded.statement).toEqual(statement);
      expect(bytes.subarray(0, statementBytes(DOMAIN, statement.kind, statement.publicInputs).length)).toEqual(
        statementBytes(DOMAIN, statement.kind, statement.publicInputs),
      );
      expect(() => decodeStatement(bytes.subarray(0, bytes.length - 1))).toThrow(EncodingError);
      expect(() => decodeStatement(new Uint8Array([...bytes, 0]))).toThrow(EncodingError);
      const wrongContext = new Uint8Array(bytes);
      wrongContext[0] = (wrongContext[0] as number) ^ 1;
      expect(() => decodeStatement(wrongContext)).toThrow(EncodingError);
    }
    const issueBytes = encodeStatement(DOMAIN, issue);
    const unsigned = new Uint8Array(issueBytes.subarray(0, issueBytes.length - 64 - 4));
    expect(() => decodeStatement(new Uint8Array([...unsigned, ...u32(0)]))).toThrow(EncodingError);
    const spendBytes = encodeStatement(DOMAIN, spend);
    expect(() => decodeStatement(new Uint8Array([...spendBytes.subarray(0, spendBytes.length - 4), ...u32(64), ...new Uint8Array(64)]))).toThrow(EncodingError);
    const asBurn = new Uint8Array(spendBytes);
    asBurn[tag("moe/pool/v2/statement").length + 32] = BURN;
    expect(() => decodeStatement(asBurn)).toThrow(EncodingError);
    const offset = tag("moe/pool/v2/statement").length + 32 + 1 + 4;
    const nonCanonical = new Uint8Array(spendBytes);
    nonCanonical.set(fieldToBytes(FIELD_MODULUS - 1n).map((b, i) => (i === 0 ? 0x31 : b)), offset);
    expect(() => decodeStatement(nonCanonical)).toThrow(EncodingError);
    expect(() => encodeStatement(DOMAIN, { ...spend, proof: new Uint8Array(33) } as Statement)).toThrow(EncodingError);
    expect(() => encodeStatement(DOMAIN, { ...spend, proof: new Uint8Array(0) } as Statement)).toThrow(EncodingError);
    for (const notBytes of [null, undefined, 42, "0x00", { length: 100 }]) {
      expect(() => decodeStatement(notBytes as unknown as Uint8Array)).toThrow(EncodingError);
    }
  });
});

describe("pool-v2 §9: the ordered history and the snapshot digest", () => {
  it("chains statement, note root, spent root and position from a genesis that names the segment", () => {
    const segment = fill(0x77);
    expect(genesisHistoryHash(segment)).toEqual(sha256(Buffer.concat([tag("moe/pool/v2/genesis"), segment])));
    expect(genesisHistoryHash(segment)).not.toEqual(genesisHistoryHash(fill(0x78)));
    const statement = new Uint8Array(32).fill(1);
    const spentRoot = new Uint8Array(32).fill(2);
    const previous = genesisHistoryHash(segment);
    expect(nextHistoryHash(previous, statement, 3n, spentRoot, 1n)).toEqual(
      sha256(Buffer.concat([tag("moe/pool/v2/history"), previous, statement, fieldToBytes(3n), spentRoot, u64(1n)])),
    );
    expect(nextHistoryHash(previous, statement, 3n, spentRoot, 1n)).not.toEqual(
      nextHistoryHash(previous, statement, 3n, new Uint8Array(32).fill(4), 1n),
    );
    expect(() => nextHistoryHash(previous, statement, 3n, spentRoot, 0n)).toThrow(EncodingError);
    expect(() => nextHistoryHash(previous, statement, FIELD_MODULUS, spentRoot, 1n)).toThrow(EncodingError);
  });

  it("digests a backing's name, the segment, the history hash and its two totals", () => {
    const backing = fill(9);
    const segment = fill(7);
    const history = fill(8);
    expect(snapshotDigest(backing, segment, history, 10n, 3n)).toEqual(
      sha256(Buffer.concat([tag("moe/pool/v2/snapshot"), backing, segment, history, u64(10n), u64(3n)])),
    );
    expect(snapshotDigest(backing, segment, history, 10n, 3n)).not.toEqual(snapshotDigest(backing, fill(6), history, 10n, 3n));
    expect(() => snapshotDigest(backing, segment, history, -1n, 0n)).toThrow(EncodingError);
  });
});
