import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { EncodingError } from "../src/bytes.js";
import { contextsArePrefixFree } from "../src/contexts.js";
import { Pool, type AcceptedStatement } from "../src/pool/pool.js";
import {
  copyPoolReceipt, poolReceiptAttestsEvidence, poolReceiptBytes, poolReceiptCovers,
  poolReceiptInHistory, signPoolReceipt, verifyPoolReceipt, type PoolReceipt, type PoolReceiptFields,
} from "../src/pool/receipt.js";
import { configurationHash, copyConfiguration, type PoolConfiguration, type Statement } from "../src/pool/statement.js";
import {
  CONFIG, CONFIG_HASH, Oracle, burnStatement, issueStatement, signedPoolBacking, spendStatement,
} from "./pool-support.js";
import { KEYS, SECRETS } from "./support.js";

const fill = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const accepted: AcceptedStatement = {
  sequence: 1n, statementHash: fill(0x21), historyHash: fill(0x32), noteRoot: 1n,
  spentRoot: fill(0x43), proofHash: fill(0x54), obligorSignatureHash: fill(0x65),
};
const signed = (after = 0n): PoolReceipt => signPoolReceipt(SECRETS.operator, CONFIG, accepted, after);
const resign = (receipt: PoolReceipt): PoolReceipt => ({
  ...receipt, signature: ed25519.sign(poolReceiptBytes(receipt), SECRETS.operator),
});

async function history() {
  const oracle = new Oracle();
  const pool = new Pool(CONFIG, oracle);
  const { backing, signature } = signedPoolBacking(SECRETS.backer);
  pool.register(backing, signature);
  const issue = oracle.accept(issueStatement(backing.name, 100n, 11n, SECRETS.backer));
  const issued = await pool.admit(issue);
  const spend = oracle.accept(spendStatement(pool.noteRoot(), [21n, 22n], [31n, 32n]));
  const spent = await pool.admit(spend);
  const burn = oracle.accept(burnStatement(backing.name, 10n, pool.noteRoot(), [41n, 42n], 51n));
  const burned = await pool.admit(burn);
  return { pool, oracle, statements: [issue, spend, burn], records: [issued, spent, burned] };
}

describe("pool receipt frame and signature (pool-v1 §7)", () => {
  it("pins every byte and field order independently of ByteWriter", () => {
    const fields: PoolReceiptFields = {
      configHash: fill(0x10), sequence: 0x0102030405060708n,
      statementHash: fill(0x21), historyHash: fill(0x32), proofHash: fill(0x43),
      signatureHash: fill(0x54), after: 0xf1f2f3f4f5f6f7f8n,
    };
    expect(bytesToHex(poolReceiptBytes(fields))).toBe(
      "6d6f652f706f6f6c2f76312f72656365697074" + "10".repeat(32) + "0102030405060708" +
      "21".repeat(32) + "32".repeat(32) + "43".repeat(32) + "54".repeat(32) + "f1f2f3f4f5f6f7f8",
    );
    expect(contextsArePrefixFree()).toBe(true);
  });

  it("signs under the configuration's key and uses after literally, including 0 and maximum u64", () => {
    for (const after of [0n, 1n, 23n, (1n << 64n) - 1n]) {
      const receipt = signed(after);
      expect(receipt.after).toBe(after);
      expect(verifyPoolReceipt(CONFIG, receipt)).toBe(true);
      expect(bytesToHex(poolReceiptBytes(receipt).slice(-8))).toBe(after.toString(16).padStart(16, "0"));
    }
    const maximum = signPoolReceipt(SECRETS.operator, CONFIG, { ...accepted, sequence: (1n << 64n) - 1n }, 0n);
    expect(verifyPoolReceipt(CONFIG, maximum)).toBe(true);
    expect(() => signPoolReceipt(SECRETS.mallory, CONFIG, accepted, 0n)).toThrow(EncodingError);
  });

  it("binds every signed field and refuses a replacement signature or operator", () => {
    const receipt = signed();
    for (const field of ["configHash", "statementHash", "historyHash", "proofHash", "signatureHash", "operator", "signature"] as const) {
      const changed = copyPoolReceipt(receipt);
      changed[field][0] = changed[field][0]! ^ 1;
      expect(verifyPoolReceipt(CONFIG, changed), field).toBe(false);
    }
    for (const field of ["sequence", "after"] as const) {
      expect(verifyPoolReceipt(CONFIG, { ...receipt, [field]: receipt[field] + 1n }), field).toBe(false);
    }
    const stranger = { ...receipt, operator: KEYS.mallory, signature: ed25519.sign(poolReceiptBytes(receipt), SECRETS.mallory) };
    expect(verifyPoolReceipt(CONFIG, stranger)).toBe(false);
    const other = { ...copyConfiguration(CONFIG), helper: fill(0x99) };
    const underOther = signPoolReceipt(SECRETS.operator, other, accepted, 0n);
    expect(verifyPoolReceipt(other, underOther)).toBe(true);
    expect(verifyPoolReceipt(CONFIG, underOther)).toBe(false);
    expect(verifyPoolReceipt(other, receipt)).toBe(false);
  });

  it("refuses signatures over the transparent domain, missing domain and appended bytes", () => {
    const receipt = signed();
    const bytes = poolReceiptBytes(receipt);
    const body = bytes.slice(new TextEncoder().encode("moe/pool/v1/receipt").length);
    for (const message of [body, new Uint8Array([...new TextEncoder().encode("moe/receipt/v3"), ...body]), new Uint8Array([...bytes, 0])]) {
      expect(verifyPoolReceipt(CONFIG, { ...receipt, signature: ed25519.sign(message, SECRETS.operator) })).toBe(false);
    }
  });

  it("refuses malformed widths, runtime types, counters and signature encodings without throwing", () => {
    const receipt = signed();
    for (const field of ["configHash", "statementHash", "historyHash", "proofHash", "signatureHash", "operator", "signature"] as const) {
      for (const value of [undefined, null, "00".repeat(32), Array(32).fill(0), new Uint8Array(31), new Uint8Array(33), new Uint8Array(65)]) {
        expect(verifyPoolReceipt(CONFIG, { ...receipt, [field]: value } as PoolReceipt), field).toBe(false);
      }
    }
    for (const sequence of [0n, -1n, 1n << 64n, 1, "1", undefined]) {
      expect(verifyPoolReceipt(CONFIG, { ...receipt, sequence } as PoolReceipt)).toBe(false);
    }
    for (const after of [-1n, 1n << 64n, 0, "0", undefined]) {
      expect(verifyPoolReceipt(CONFIG, { ...receipt, after } as PoolReceipt)).toBe(false);
    }
    for (const value of [undefined, null, {}, 1, []]) {
      expect(verifyPoolReceipt(CONFIG, value as PoolReceipt)).toBe(false);
      expect(verifyPoolReceipt(value as PoolConfiguration, receipt)).toBe(false);
    }
    // S + the group order has the same group equation, but is not a strict signature.
    const noncanonical = copyPoolReceipt(receipt);
    let carry = ed25519.CURVE.n;
    for (let i = 32; i < 64; i++) {
      carry += BigInt(noncanonical.signature[i]!);
      noncanonical.signature[i] = Number(carry & 255n);
      carry >>= 8n;
    }
    expect(verifyPoolReceipt(CONFIG, noncanonical)).toBe(false);
    const small = new Uint8Array(32); small[0] = 1;
    const smallConfig = { ...CONFIG, operator: small };
    const forgedSignature = new Uint8Array(64); forgedSignature[0] = 1;
    const forged = { ...receipt, configHash: configurationHash(smallConfig), operator: small, signature: forgedSignature };
    expect(ed25519.verify(forgedSignature, poolReceiptBytes(forged), small, { zip215: true })).toBe(true);
    expect(verifyPoolReceipt(smallConfig, forged)).toBe(false);
  });

  it("owns ingested and copied bytes, including Node Buffer views", () => {
    const record = { ...accepted, statementHash: Buffer.from(accepted.statementHash), proofHash: Buffer.from(accepted.proofHash) };
    const config = copyConfiguration(CONFIG);
    const receipt = signPoolReceipt(SECRETS.operator, config, record, 0n);
    record.statementHash.fill(0); record.proofHash.fill(0); config.operator.fill(0); config.pool.fill(0);
    expect(verifyPoolReceipt(CONFIG, receipt)).toBe(true);
    const buffers = Object.fromEntries(Object.entries(receipt).map(([key, value]) => [key, value instanceof Uint8Array ? Buffer.from(value) : value])) as unknown as PoolReceipt;
    const copy = copyPoolReceipt(buffers);
    for (const value of Object.values(buffers)) if (value instanceof Uint8Array) value.fill(0);
    expect(verifyPoolReceipt(CONFIG, copy)).toBe(true);
    expect(poolReceiptBytes(copy)).toEqual(poolReceiptBytes(receipt));
    expect(bytesToHex(copy.signature)).toBe(bytesToHex(receipt.signature));
  });
});

describe("pool receipt evidence and replay", () => {
  it("covers issue, spend and burn, with a signature hash only for issuance", async () => {
    const { pool, statements, records } = await history();
    for (let i = 0; i < records.length; i++) {
      const receipt = signPoolReceipt(SECRETS.operator, CONFIG, records[i]!, 0n);
      expect(poolReceiptCovers(CONFIG, statements[i]!, receipt)).toBe(true);
      expect(poolReceiptAttestsEvidence(CONFIG, statements[i]!, receipt)).toBe(true);
      expect(poolReceiptInHistory(pool, receipt)).toBe(true);
      expect(receipt.signatureHash).toEqual(i === 0 ? sha256(statements[0]!.obligorSignature!) : new Uint8Array(32));
      expect(poolReceiptCovers(CONFIG, statements[(i + 1) % 3]!, receipt)).toBe(false);
    }
  });

  it("keeps identity and the originally admitted evidence on a re-proven retry", async () => {
    const { pool, oracle, statements, records } = await history();
    const statement = statements[1]!;
    const receipt = signPoolReceipt(SECRETS.operator, CONFIG, records[1]!, 0n);
    const reproven = oracle.accept({ ...statement, proof: fill(0xe1) });
    const prior = await pool.admit(reproven);
    expect(signPoolReceipt(SECRETS.operator, CONFIG, prior, receipt.after)).toEqual(receipt);
    expect(poolReceiptCovers(CONFIG, reproven, receipt)).toBe(true);
    expect(poolReceiptAttestsEvidence(CONFIG, reproven, receipt)).toBe(false);
    const trail = pool.trail();
    const replayed = await Pool.replay({ ...trail, statements: [statements[0]!, reproven, statements[2]!] }, oracle);
    expect(poolReceiptInHistory(replayed, receipt)).toBe(true);
  });

  it("distinguishes replica corruption from exact bad bytes attested by an operator", async () => {
    const { statements, records } = await history();
    const statement = statements[0]!;
    const receipt = signPoolReceipt(SECRETS.operator, CONFIG, records[0]!, 0n);
    for (const changed of [{ ...statement, proof: new Uint8Array(0) }, { ...statement, obligorSignature: new Uint8Array(1) }]) {
      expect(poolReceiptCovers(CONFIG, changed, receipt)).toBe(true);
      expect(poolReceiptAttestsEvidence(CONFIG, changed, receipt)).toBe(false);
      const attested = resign({ ...receipt, proofHash: sha256(changed.proof), signatureHash: sha256(changed.obligorSignature!) });
      expect(poolReceiptAttestsEvidence(CONFIG, changed, attested)).toBe(true);
    }
    const spendReceipt = signPoolReceipt(SECRETS.operator, CONFIG, records[1]!, 0n);
    expect(poolReceiptAttestsEvidence(CONFIG, { ...statements[1]!, obligorSignature: new Uint8Array(0) }, spendReceipt)).toBe(false);
    expect(poolReceiptAttestsEvidence(CONFIG, statements[1]!, resign({ ...spendReceipt, signatureHash: fill(1) }))).toBe(false);
  });

  it("checks position and history, refuses missing prefixes, and does not resolve after", async () => {
    const { pool, oracle, records } = await history();
    const receipt = signPoolReceipt(SECRETS.operator, CONFIG, records[1]!, 999n);
    const replayed = await Pool.replay(pool.trail(), oracle);
    expect(poolReceiptInHistory(replayed, receipt)).toBe(true);
    const trail = pool.trail();
    const prefix = await Pool.replay({ ...trail, statements: trail.statements.slice(0, 1) }, oracle);
    expect(poolReceiptInHistory(prefix, receipt)).toBe(false);
    expect(poolReceiptInHistory(replayed, resign({ ...receipt, sequence: 1n }))).toBe(false);
    expect(poolReceiptInHistory(replayed, resign({ ...receipt, historyHash: fill(0xee) }))).toBe(false);
    expect(poolReceiptInHistory(replayed, resign({ ...receipt, statementHash: fill(0xef) }))).toBe(false);
    expect(poolReceiptInHistory(new Pool({ ...CONFIG, helper: fill(1) }, oracle), receipt)).toBe(false);
  });

  it("answers false for malformed external pairings", async () => {
    const { pool, statements, records } = await history();
    const receipt = signPoolReceipt(SECRETS.operator, CONFIG, records[0]!, 0n);
    for (const value of [undefined, null, {}, [], { kind: 7 }, { ...statements[0], publicInputs: Array(6) }]) {
      expect(poolReceiptCovers(CONFIG, value as Statement, receipt)).toBe(false);
      expect(poolReceiptAttestsEvidence(CONFIG, value as Statement, receipt)).toBe(false);
      expect(poolReceiptInHistory(pool, value as PoolReceipt)).toBe(false);
    }
    expect(poolReceiptAttestsEvidence(CONFIG, { ...statements[0]!, proof: "00" as unknown as Uint8Array }, receipt)).toBe(false);
    expect(poolReceiptCovers({ ...CONFIG, pool: fill(1) }, statements[0]!, receipt)).toBe(false);
    expect(receipt.configHash).toEqual(CONFIG_HASH);
  });
});
