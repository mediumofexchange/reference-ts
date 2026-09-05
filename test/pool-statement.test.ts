import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { EncodingError } from "../src/bytes.js";
import { utf8Encoder } from "../src/contexts.js";
import { bytesToField, fieldToBytes, fieldToHex, FIELD_MODULUS, hexToField, identifierOf, limbsOf } from "../src/pool/field.js";
import {
  BURN,
  configurationBytes,
  configurationHash,
  copyStatement,
  decodeStatement,
  encodeStatement,
  genesisHistoryHash,
  ISSUE,
  isWellFormedStatement,
  MAX_PROOF_BYTES,
  nextHistoryHash,
  parsePublicInputs,
  poolIdentity,
  PUBLIC_INPUT_COUNT,
  snapshotDigest,
  SPEND,
  statementBytes,
  statementHash,
  type Statement,
} from "../src/pool/statement.js";
import { CONFIG, CONFIG_HASH, issueStatement, spendStatement } from "./pool-support.js";
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

describe("pool-v1 §1: field encodings", () => {
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

describe("pool-v1 §2: the configuration and the pool identity", () => {
  it("frames the configuration exactly and hashes it", () => {
    const expected = Buffer.concat([
      tag("moe/pool/v1/config"), CONFIG.pool, CONFIG.operator,
      CONFIG.issue.bytecode, CONFIG.issue.vk, CONFIG.spend.bytecode, CONFIG.spend.vk, CONFIG.burn.bytecode, CONFIG.burn.vk,
      CONFIG.helper, new Uint8Array([32, 2, 2]),
    ]);
    expect(configurationBytes(CONFIG)).toEqual(new Uint8Array(expected));
    expect(configurationHash(CONFIG)).toEqual(sha256(expected));
    expect(configurationHash({ ...CONFIG, helper: new Uint8Array(32) })).not.toEqual(CONFIG_HASH);
    expect(configurationHash({ ...CONFIG, spend: CONFIG.burn })).not.toEqual(CONFIG_HASH);
    expect(() => configurationHash({ ...CONFIG, pool: new Uint8Array(31) })).toThrow(EncodingError);
  });

  it("derives one pool identity per operator and creation index", () => {
    expect(poolIdentity(KEYS.operator, 0n)).toEqual(sha256(Buffer.concat([tag("moe/pool/v1/pool"), KEYS.operator, u64(0n)])));
    expect(poolIdentity(KEYS.operator, 1n)).not.toEqual(poolIdentity(KEYS.operator, 0n));
    expect(poolIdentity(KEYS.backer, 0n)).not.toEqual(poolIdentity(KEYS.operator, 0n));
    expect(() => poolIdentity(new Uint8Array(31), 0n)).toThrow(EncodingError);
  });
});

describe("pool-v1 §5: statements and their identity", () => {
  it("frames the statement bytes as context, configuration, kind, count and fields", () => {
    const inputs = [1n, 2n, 3n, 4n, 5n, 6n];
    const expected = Buffer.concat([tag("moe/pool/v1/statement"), CONFIG_HASH, new Uint8Array([1]), u32(6), ...inputs.map(fieldToBytes)]);
    expect(statementBytes(CONFIG_HASH, ISSUE, inputs)).toEqual(new Uint8Array(expected));
    expect(statementHash(CONFIG_HASH, ISSUE, inputs)).toEqual(sha256(expected));
    expect(() => statementBytes(CONFIG_HASH, SPEND, inputs)).toThrow(EncodingError);
    expect(() => statementBytes(CONFIG_HASH, ISSUE, [...inputs.slice(0, 5), FIELD_MODULUS])).toThrow(EncodingError);
    expect(() => statementBytes(CONFIG_HASH, 4 as never, inputs)).toThrow(EncodingError);
    expect(PUBLIC_INPUT_COUNT).toEqual({ 1: 6, 2: 7, 3: 9 });
  });

  it("recognizes a well-formed statement by kind, count, field canonicity, proof shape and signature presence", () => {
    const issue = issueStatement(new Uint8Array(32).fill(9), 5n, 77n, SECRETS.backer);
    expect(isWellFormedStatement(issue)).toBe(true);
    const spend = spendStatement(1n, [2n, 3n], [4n, 5n]);
    expect(isWellFormedStatement(spend)).toBe(true);
    const cases: unknown[] = [
      null, {}, { ...issue, kind: 0 }, { ...issue, kind: "1" }, { ...issue, publicInputs: issue.publicInputs.slice(1) },
      { ...issue, publicInputs: [...issue.publicInputs, 0n] }, { ...issue, publicInputs: issue.publicInputs.map((_, i) => (i === 5 ? FIELD_MODULUS : 1n)) },
      { ...issue, publicInputs: issue.publicInputs.map(Number) }, { ...issue, proof: new Uint8Array(0) },
      { ...issue, proof: new Uint8Array(31) }, { ...issue, proof: new Uint8Array(MAX_PROOF_BYTES + 32) },
      { ...issue, obligorSignature: undefined }, { ...issue, obligorSignature: new Uint8Array(63) },
      { ...spend, obligorSignature: new Uint8Array(64) }, { ...spend, kind: BURN },
    ];
    for (const bad of cases) expect(isWellFormedStatement(bad)).toBe(false);
    expect(isWellFormedStatement({ ...issue, proof: new Uint8Array(MAX_PROOF_BYTES) })).toBe(true);
    expect(() => copyStatement({ ...spend, proof: new Uint8Array(33) })).toThrow(EncodingError);
    const copy = copyStatement(issue);
    expect(copy).toEqual(issue);
    copy.proof[0] = (copy.proof[0] as number) ^ 1;
    expect(issue.proof[0]).not.toBe(copy.proof[0]);
  });

  it("reads the public inputs by position and refuses limbs and quantities out of range", () => {
    const backing = new Uint8Array(32).fill(9);
    const issue = parsePublicInputs(ISSUE, [...limbsOf(CONFIG.pool), ...limbsOf(backing), 5n, 77n]);
    expect(issue).toEqual({ kind: ISSUE, pool: CONFIG.pool, backing, quantity: 5n, nullifiers: [], outputs: [77n] });
    const spend = parsePublicInputs(SPEND, [...limbsOf(CONFIG.pool), 1n, 2n, 3n, 4n, 5n]);
    expect(spend).toEqual({ kind: SPEND, pool: CONFIG.pool, anchor: 1n, nullifiers: [2n, 3n], outputs: [4n, 5n] });
    const burn = parsePublicInputs(BURN, [...limbsOf(CONFIG.pool), ...limbsOf(backing), 6n, 1n, 2n, 3n, 4n]);
    expect(burn).toEqual({ kind: BURN, pool: CONFIG.pool, backing, quantity: 6n, anchor: 1n, nullifiers: [2n, 3n], outputs: [4n] });
    expect(() => parsePublicInputs(ISSUE, [1n << 128n, 0n, 0n, 0n, 1n, 1n])).toThrow(EncodingError);
    expect(() => parsePublicInputs(ISSUE, [0n, 0n, 0n, 1n << 128n, 1n, 1n])).toThrow(EncodingError);
    expect(() => parsePublicInputs(ISSUE, [0n, 0n, 0n, 0n, 1n << 64n, 1n])).toThrow(EncodingError);
    expect(() => parsePublicInputs(BURN, [0n, 0n, 0n, 0n, 1n << 64n, 1n, 2n, 3n, 4n])).toThrow(EncodingError);
    expect(() => parsePublicInputs(SPEND, [0n, 0n, 1n, 2n, 3n, 4n])).toThrow(EncodingError);
    expect(() => parsePublicInputs(SPEND, [0n, 0n, 1n, 2n, 3n, 4n, FIELD_MODULUS])).toThrow(EncodingError);
  });

  it("encodes a statement record strictly and decodes only the canonical bytes", () => {
    const issue = issueStatement(new Uint8Array(32).fill(9), 5n, 77n, SECRETS.backer);
    const spend = spendStatement(1n, [2n, 3n], [4n, 5n]);
    for (const statement of [issue, spend]) {
      const bytes = encodeStatement(CONFIG_HASH, statement);
      const decoded = decodeStatement(bytes);
      expect(decoded.configHash).toEqual(CONFIG_HASH);
      expect(decoded.statement).toEqual(statement);
      expect(bytes.subarray(0, statementBytes(CONFIG_HASH, statement.kind, statement.publicInputs).length)).toEqual(
        statementBytes(CONFIG_HASH, statement.kind, statement.publicInputs),
      );
      expect(() => decodeStatement(bytes.subarray(0, bytes.length - 1))).toThrow(EncodingError);
      expect(() => decodeStatement(new Uint8Array([...bytes, 0]))).toThrow(EncodingError);
      const wrongContext = new Uint8Array(bytes);
      wrongContext[0] = (wrongContext[0] as number) ^ 1;
      expect(() => decodeStatement(wrongContext)).toThrow(EncodingError);
    }
    // An issuance record carries a 64-byte signature and a spend an empty one; the count matches the kind.
    const issueBytes = encodeStatement(CONFIG_HASH, issue);
    const unsigned = new Uint8Array(issueBytes.subarray(0, issueBytes.length - 64 - 4));
    expect(() => decodeStatement(new Uint8Array([...unsigned, ...u32(0)]))).toThrow(EncodingError);
    const spendBytes = encodeStatement(CONFIG_HASH, spend);
    expect(() => decodeStatement(new Uint8Array([...spendBytes.subarray(0, spendBytes.length - 4), ...u32(64), ...new Uint8Array(64)]))).toThrow(EncodingError);
    const asBurn = new Uint8Array(spendBytes);
    asBurn[tag("moe/pool/v1/statement").length + 32] = BURN;
    expect(() => decodeStatement(asBurn)).toThrow(EncodingError);
    // A field at or above p, and an unaligned or empty proof, are malformed.
    const offset = tag("moe/pool/v1/statement").length + 32 + 1 + 4;
    const nonCanonical = new Uint8Array(spendBytes);
    nonCanonical.set(fieldToBytes(FIELD_MODULUS - 1n).map((b, i) => (i === 0 ? 0x31 : b)), offset);
    expect(() => decodeStatement(nonCanonical)).toThrow(EncodingError);
    expect(() => encodeStatement(CONFIG_HASH, { ...spend, proof: new Uint8Array(33) } as Statement)).toThrow(EncodingError);
    expect(() => encodeStatement(CONFIG_HASH, { ...spend, proof: new Uint8Array(0) } as Statement)).toThrow(EncodingError);
  });
});

describe("pool-v1 §7: the ordered history and the snapshot digest", () => {
  it("chains statement, note root, spent root and sequence from a genesis that names the configuration", () => {
    expect(genesisHistoryHash(CONFIG_HASH)).toEqual(sha256(Buffer.concat([tag("moe/pool/v1/genesis"), CONFIG_HASH])));
    const statement = new Uint8Array(32).fill(1);
    const spentRoot = new Uint8Array(32).fill(2);
    const previous = genesisHistoryHash(CONFIG_HASH);
    expect(nextHistoryHash(previous, statement, 3n, spentRoot, 1n)).toEqual(
      sha256(Buffer.concat([tag("moe/pool/v1/history"), previous, statement, fieldToBytes(3n), spentRoot, u64(1n)])),
    );
    // Equal note roots with different spent roots are different histories (invariant 23).
    expect(nextHistoryHash(previous, statement, 3n, spentRoot, 1n)).not.toEqual(
      nextHistoryHash(previous, statement, 3n, new Uint8Array(32).fill(4), 1n),
    );
    expect(() => nextHistoryHash(previous, statement, 3n, spentRoot, 0n)).toThrow(EncodingError);
    expect(() => nextHistoryHash(previous, statement, FIELD_MODULUS, spentRoot, 1n)).toThrow(EncodingError);
  });

  it("digests a backing's name, the pool's history hash and its two totals", () => {
    const backing = new Uint8Array(32).fill(9);
    const history = new Uint8Array(32).fill(8);
    expect(snapshotDigest(backing, history, 10n, 3n)).toEqual(
      sha256(Buffer.concat([tag("moe/pool/v1/snapshot"), backing, history, u64(10n), u64(3n)])),
    );
    expect(() => snapshotDigest(backing, history, -1n, 0n)).toThrow(EncodingError);
  });
});
