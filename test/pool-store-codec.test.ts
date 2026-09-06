import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { POOL_STATEMENT_CONTEXT } from "../src/contexts.js";
import { signPoolReceipt, verifyPoolReceipt } from "../src/pool/receipt.js";
import { copyPoolCheckpointEvidence, decodeStoredOpening, decodeStoredReceipt, encodeStoredOpening, encodeStoredReceipt } from "../src/pool/store-codec.js";
import { segmentBytes } from "../src/pool/statement.js";
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

  it("retains directory-only, snapshot-only and full validation evidence with owned bytes", async () => {
    const f = await fixture();
    const directoryOnly = { commitment: f.base.commitment, directory: f.base.directory };
    const snapshotOnly = { ...directoryOnly, snapshots: f.base.snapshots! };
    const validation = [directoryOnly, snapshotOnly, f.base];
    const encoded = encodeStoredOpening(f.segment.trail(), [], validation);
    const decoded = decodeStoredOpening(encoded, CONFIG);
    expect(JSON.parse(encoded).version).toBe(2);
    expect(decoded.validation).toEqual(validation);
    expect(Object.keys(decoded.validation![0]!)).toEqual(["commitment", "directory"]);
    expect(decoded.validation![1]!.history).toBeUndefined();
    expect(encodeStoredOpening(decoded.trail, decoded.evidence, decoded.validation)).toBe(encoded);

    const copied = copyPoolCheckpointEvidence(f.base, CONFIG);
    expect(copied).toEqual(f.base);
    copied.commitment.operator.fill(0);
    copied.directory[0]!.digest.fill(0);
    copied.snapshots![0]!.backing.fill(0);
    copied.snapshots![0]!.header.operator.fill(0);
    copied.snapshots![0]!.historyHash.fill(0);
    copied.snapshots![0]!.backings[0]!.signature.fill(0);
    copied.history!.trail.statements[0]!.proof.fill(0);
    copied.history!.trail.backings[0]!.backing.name.fill(0);
    expect(encodeStoredOpening(f.segment.trail(), [], validation)).toBe(encoded);
    expect(decodeStoredOpening(encoded, CONFIG).validation).toEqual(validation);
  });

  it("keeps v1 openings canonical and requires validation exactly for v2", async () => {
    const f = await fixture();
    const legacy = encodeStoredOpening(f.segment.trail(), []);
    expect(JSON.parse(legacy).version).toBe(1);
    expect(decodeStoredOpening(legacy, CONFIG)).not.toHaveProperty("validation");
    const current = encodeStoredOpening(f.segment.trail(), [], []);
    expect(decodeStoredOpening(current, CONFIG).validation).toEqual([]);
    expect(() => decodeStoredOpening(alter(legacy, value => { value.version = 2; }), CONFIG)).toThrow();
    expect(() => decodeStoredOpening(alter(current, value => { value.version = 1; }), CONFIG)).toThrow();
    for (const version of [0, 3, "2", null]) {
      expect(() => decodeStoredOpening(alter(current, value => { value.version = version; }), CONFIG)).toThrow();
    }
  });

  it("rejects malformed validation fields and protocol framing without certifying signatures", async () => {
    const f = await fixture();
    const opening = encodeStoredOpening(f.segment.trail(), [], [f.base]);
    const mutations: ((value: Record<string, any>) => void)[] = [
      value => { value.validation = {}; },
      value => { value.validation[0].extra = 1; },
      value => { value.validation[0].snapshots = null; },
      value => { value.validation[0].history = null; },
      value => { value.validation[0].directory[0].digest = "00"; },
      value => { value.validation[0].history.extra = true; },
      value => { value.validation[0].history.length = "01"; },
      value => { value.validation[0].history.length = 1; },
      value => { value.validation[0].history.length = "-1"; },
      value => { value.validation[0].history.length = "3"; },
      value => { value.validation[0].history.trail.configuration = "00".repeat(32); },
      value => { value.validation[0].snapshots[0].extra = true; },
      value => { value.validation[0].snapshots[0].backing = "00"; },
      value => { value.validation[0].snapshots[0].historyHash = "AA".repeat(32); },
      value => { value.validation[0].snapshots[0].issued = "01"; },
      value => { value.validation[0].snapshots[0].issued = 10; },
      value => { value.validation[0].snapshots[0].burned = (1n << 64n).toString(); },
      value => { value.validation[0].snapshots[0].backings[0].signature = "00"; },
      value => { value.validation[0].snapshots[0].backings[0].extra = true; },
      value => { value.validation[0].snapshots[0].header = bytesToHex(segmentBytes({ ...f.base.snapshots![0]!.header, domain: new Uint8Array(32) })); },
    ];
    for (const mutate of mutations) expect(() => decodeStoredOpening(alter(opening, mutate), CONFIG)).toThrow();
    // Persistence frames signatures; record validation must authenticate them.
    const unsigned = alter(opening, value => { value.validation[0].snapshots[0].backings[0].signature = "00".repeat(64); });
    expect(decodeStoredOpening(unsigned, CONFIG).validation![0]!.snapshots![0]!.backings[0]!.signature).toEqual(new Uint8Array(64));
    expect(() => copyPoolCheckpointEvidence({ ...f.base, snapshots: [{ ...f.base.snapshots![0]!, issued: 1n << 64n }] }, CONFIG)).toThrow();
    expect(() => copyPoolCheckpointEvidence({ ...f.base, history: { ...f.base.history!, length: -1n } }, CONFIG)).toThrow();
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
