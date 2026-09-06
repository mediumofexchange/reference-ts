import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { POOL_STATEMENT_CONTEXT } from "../src/contexts.js";
import { signPoolReceipt, verifyPoolReceipt } from "../src/pool/receipt.js";
import { decodeStoredOpening, decodeStoredReceipt, encodeStoredOpening, encodeStoredReceipt } from "../src/pool/store-codec.js";
import { issueStatement, CONFIG, checkpointOf, evidenceOf } from "./pool-support.js";
import { open, fixture } from "./pool-record-support.js";
import { SECRETS } from "./support.js";

function alter(text: string, change: (value: Record<string, any>) => void): string {
  const value = JSON.parse(text) as Record<string, any>;
  change(value);
  return JSON.stringify(value);
}

describe("local pool store codecs", () => {
  it("roundtrips an opening and an actual checkpoint import through replay", async () => {
    const f = await fixture();
    const parent = { checkpoint: f.base, segment: f.segment };
    const child = open(f.venue, [f.x], f.oracle, 2n, [parent]);
    const statement = f.oracle.accept(issueStatement(child.authority(), f.x.backing.name, 10n, 501n, SECRETS.backer));
    await child.admit(statement);
    const checkpoint = checkpointOf(f.segment, SECRETS.operator, 1n);
    const evidence = evidenceOf(f.segment, checkpoint);
    const encoded = encodeStoredOpening(child.trail(), [evidence]);
    const decoded = decodeStoredOpening(encoded, CONFIG);

    expect(encodeStoredOpening(decoded.trail, decoded.evidence)).toBe(encoded);
    const replayed = await (await import("../src/pool/segment.js")).Segment.replay(decoded.trail, f.oracle, decoded.evidence);
    expect(replayed.length).toBe(child.length);
    expect(replayed.historyHash()).toEqual(child.historyHash());
  });

  it("rejects noncanonical JSON, unknown fields, wrong domains and noncanonical hex or integers", async () => {
    const f = await fixture();
    const child = open(f.venue, [f.x], f.oracle, 2n);
    const statement = f.oracle.accept(issueStatement(child.authority(), f.x.backing.name, 10n, 501n, SECRETS.backer));
    await child.admit(statement);
    const opening = encodeStoredOpening(child.trail(), []);

    expect(() => decodeStoredOpening(` ${opening}`, CONFIG)).toThrow();
    expect(() => decodeStoredOpening(alter(opening, value => { value.extra = 1; }), CONFIG)).toThrow();
    expect(() => decodeStoredOpening(alter(opening, value => { value.trail.configuration = value.trail.configuration.toUpperCase(); }), CONFIG)).toThrow();
    expect(() => decodeStoredOpening(alter(opening, value => { value.trail.configuration = "00"; }), CONFIG)).toThrow();

    const wrongStatementDomain = alter(opening, value => {
      const bytes = Buffer.from(value.trail.statements[0]!, "hex");
      bytes[POOL_STATEMENT_CONTEXT.length] = (bytes[POOL_STATEMENT_CONTEXT.length] ?? 0) ^ 1;
      value.trail.statements[0] = bytesToHex(bytes);
    });
    expect(() => decodeStoredOpening(wrongStatementDomain, CONFIG)).toThrow();
  });

  it("roundtrips receipts, validates framing, and owns byte outputs", async () => {
    const f = await fixture();
    const accepted = await f.segment.admit(f.oracle.accept(issueStatement(f.segment.authority(), f.x.backing.name, 10n, 501n, SECRETS.backer)));
    const receipt = signPoolReceipt(SECRETS.operator, f.segment.authority(), accepted, 7n);
    const mutable = Object.fromEntries(Object.entries(receipt).map(([key, value]) => [
      key,
      value instanceof Uint8Array ? Buffer.from(value) : value,
    ])) as unknown as typeof receipt;
    const encoded = encodeStoredReceipt(mutable);
    const decoded = decodeStoredReceipt(encoded);
    expect(verifyPoolReceipt(f.segment.authority(), decoded)).toBe(true);
    decoded.operator[0] = (decoded.operator[0] ?? 0) ^ 1;
    expect(verifyPoolReceipt(f.segment.authority(), decodeStoredReceipt(encoded))).toBe(true);
    expect(encodeStoredReceipt(decodeStoredReceipt(encoded))).toBe(encoded);
  });

  it("rejects malformed receipt fields and unknown keys", async () => {
    const f = await fixture();
    const accepted = await f.segment.admit(f.oracle.accept(issueStatement(f.segment.authority(), f.x.backing.name, 10n, 501n, SECRETS.backer)));
    const receipt = encodeStoredReceipt(signPoolReceipt(SECRETS.operator, f.segment.authority(), accepted, 0n));
    expect(() => decodeStoredReceipt(alter(receipt, value => { value.extra = true; }))).toThrow();
    expect(() => decodeStoredReceipt(alter(receipt, value => { value.after = "01"; }))).toThrow();
    expect(() => decodeStoredReceipt(alter(receipt, value => { value.domain = value.domain.toUpperCase(); }))).toThrow();
    expect(() => decodeStoredReceipt(alter(receipt, value => { value.position = "0"; }))).toThrow();
  });
});
