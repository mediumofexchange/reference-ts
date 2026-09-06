import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import { directoryRoot, signCommitment } from "../src/commitment.js";
import { readPoolReceiptCheckpoint, readPoolReceiptRecord } from "../src/pool/receipt-record.js";
import { copyPoolReceipt, poolReceiptBytes, signPoolReceipt, type PoolReceipt } from "../src/pool/receipt.js";
import { segmentAuthority, type SegmentHeader } from "../src/pool/statement.js";
import { LocalVenue, VenueError } from "../src/venue.js";
import { CONFIG, VENUE } from "./pool-support.js";
import { evidence, fixture, issue, open, replace } from "./pool-record-support.js";
import { KEYS, SECRETS } from "./support.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;
function receipt(f: Fixture, after = 1n): PoolReceipt {
  const hash = f.segment.prefix().events.find(e => e.position === 1n)!.statementHash;
  return signPoolReceipt(SECRETS.operator, f.segment.authority(), f.segment.acceptedStatement(hash)!, after);
}
function record(f: Fixture, r = receipt(f), header = f.segment.header, backings = [f.x, f.y]) {
  return readPoolReceiptRecord({ configuration: CONFIG, venue: f.venue, header, receipt: r, backings });
}
function check(f: Fixture, r = receipt(f), target = f.base, ancestors = [] as typeof f.base[], verifier = f.oracle) {
  return readPoolReceiptCheckpoint({ configuration: CONFIG, venue: f.venue, header: f.segment.header,
    receipt: r, checkpoint: target.commitment, evidence: [target, ...ancestors], verifier });
}
function resign(r: PoolReceipt): PoolReceipt {
  return { ...r, signature: ed25519.sign(poolReceiptBytes(r), SECRETS.operator) };
}

describe("pool receipt record facts (C2.3.4, C2.10.8–9, C2b.4)", () => {
  it("holds a lower exact sequence when several share one index", async () => {
    const f = await fixture(); f.venue.publish(evidence(f.segment, 2n).commitment);
    expect(record(f)).toMatchObject({ kind: "record", witnessedIndex: 0n, scope: "live",
      sequence: { kind: "held", at: 0n, commitment: f.base.commitment } });
  });

  it("does not bound the distance to an unreached signed sequence", async () => {
    const f = await fixture();
    for (const after of [2n, 1000n, (1n << 64n) - 1n]) {
      expect(record(f, receipt(f, after))).toMatchObject({ kind: "record", sequence: { kind: "not-reached" } });
    }
  });

  it("resolves missing moved-past and maximum held sequences without scanning holes", async () => {
    const f = await fixture(), maximum = (1n << 64n) - 1n;
    f.venue.publish(evidence(f.segment, maximum).commitment);
    const previous = vi.spyOn(f.venue, "previousFor");
    expect(record(f, receipt(f, 2n))).toMatchObject({ sequence: { kind: "moved-past" } });
    expect(record(f, receipt(f, maximum))).toMatchObject({ sequence: { kind: "held", at: 0n } });
    expect(previous).toHaveBeenCalledTimes(2);
  });

  it("leaves an unheld opening sequence unreached", async () => {
    const f = await fixture(); f.venue = new LocalVenue(VENUE);
    expect(record(f)).toMatchObject({ sequence: { kind: "not-reached" }, scope: "live" });
  });

  it("does not treat a held sequence as proof that it carries the receipt's segment", async () => {
    const f = await fixture();
    f.venue.publish(signCommitment(SECRETS.operator, 2n, directoryRoot([])));
    expect(record(f, receipt(f, 2n))).toMatchObject({ kind: "record", sequence: { kind: "held" } });
  });

  it("keeps all old scope links until the actual earliest effective boundary", async () => {
    const f = await fixture(); f.venue.advance(); replace(f.venue, f.x, SECRETS.carol, 3n);
    f.venue.advance();
    expect(record(f)).toMatchObject({ scope: "live" });
    f.venue.advance();
    expect(record(f)).toMatchObject({ scope: "ended", sequence: { kind: "held" } });
    replace(f.venue, f.x, SECRETS.operator, 4n); f.venue.advance();
    expect(record(f)).toMatchObject({ scope: "ended" });
  });

  it("distinguishes announced authority from a scope that has started", async () => {
    const f = await fixture(); f.venue.advance(); replace(f.venue, f.x, SECRETS.carol, 3n);
    f.venue.advance(2n);
    const child = open(f.venue, [f.x], f.oracle, 1n, [{ checkpoint: f.base, segment: f.segment }], KEYS.carol);
    // Reuse the signed replacement record in a view strictly before effectiveness.
    vi.spyOn(f.venue, "witnessedIndex").mockReturnValue(2n);
    const r = signPoolReceipt(SECRETS.carol, child.authority(), f.segment.acceptedStatement(receipt(f).statementHash)!, 1n);
    expect(record(f, r, child.header, [f.x])).toMatchObject({ scope: "not-started" });
  });

  it.each(["signature", "segment", "domain", "scopeRoot", "operator"] as const)("rejects changed receipt %s", async field => {
    const f = await fixture(), r = receipt(f);
    const changed = field === "scopeRoot" ? { ...r, scopeRoot: r.scopeRoot + 1n } : { ...r, [field]: new Uint8Array(r[field].length) };
    expect(record(f, changed)).toMatchObject({ kind: "invalid" });
  });

  it("requires complete signed terms and known links under the expected domain and venue", async () => {
    const f = await fixture(), r = receipt(f);
    expect(record(f, r, f.segment.header, [f.x])).toMatchObject({ kind: "invalid" });
    expect(record(f, r, f.segment.header, [f.x, f.x])).toMatchObject({ kind: "invalid" });
    expect(record(f, r, f.segment.header, [f.x, { ...f.y, signature: new Uint8Array(64) }])).toMatchObject({ kind: "invalid" });
    const header: SegmentHeader = { ...f.segment.header, entries: f.segment.header.entries.map(e => ({ ...e, link: new Uint8Array(32) })) };
    const unknown = signPoolReceipt(SECRETS.operator, segmentAuthority(header), f.segment.acceptedStatement(r.statementHash)!, 1n);
    expect(record(f, unknown, header)).toMatchObject({ kind: "invalid", reason: /link/ });
    expect(readPoolReceiptRecord({ configuration: { ...CONFIG, helper: new Uint8Array(32) },
      venue: f.venue, header: f.segment.header, receipt: r, backings: [f.x, f.y] })).toMatchObject({ kind: "invalid" });
    f.venue = new LocalVenue(new Uint8Array(32));
    expect(record(f, r)).toMatchObject({ kind: "invalid", reason: /venue/ });
  });

  it("refuses pre-opening sequences and malformed external data", async () => {
    const f = await fixture();
    expect(record(f, receipt(f, 0n))).toMatchObject({ kind: "invalid", reason: /opening/ });
    expect(record(f, null as never)).toMatchObject({ kind: "invalid" });
  });

  it("owns receipt and scope bytes across venue callbacks and on return", async () => {
    const f = await fixture(), r = receipt(f), h = f.segment.header;
    const original = f.venue.previousFor.bind(f.venue);
    vi.spyOn(f.venue, "previousFor").mockImplementation((...args) => {
      r.operator.fill(0); h.entries[0]!.link.fill(0); return original(...args);
    });
    const result = record(f, r, h);
    expect(result).toMatchObject({ kind: "record", sequence: { kind: "held" } });
    if (result.kind === "record") {
      result.terms[0]!.operator.fill(0);
      if (result.sequence.kind === "held") result.sequence.commitment.root.fill(0);
    }
    vi.restoreAllMocks();
    expect(record(f)).toMatchObject({ kind: "record", sequence: { commitment: f.base.commitment } });
  });

  it("propagates venue refusal, inconsistent exact lookup and moving views", async () => {
    const f = await fixture();
    vi.spyOn(f.venue, "previousFor").mockImplementation(() => { throw new VenueError("offline"); });
    expect(() => record(f)).toThrow(VenueError); vi.restoreAllMocks();
    vi.spyOn(f.venue, "witnessedAtSequence").mockReturnValue(undefined);
    expect(() => record(f)).toThrow(VenueError); vi.restoreAllMocks();
    const original = f.venue.previousFor.bind(f.venue);
    vi.spyOn(f.venue, "previousFor").mockImplementation((...args) => { f.venue.advance(); return original(...args); });
    expect(() => record(f)).toThrow(VenueError);
  });
});

describe("pool receipt inclusion in one exact checkpoint", () => {
  it("checks position, statement and history identity against replay", async () => {
    const f = await fixture(), r = receipt(f);
    expect(await check(f)).toEqual({ kind: "included", at: 0n, witnessedIndex: 0n });
    for (const patch of [{ position: 2n }, { position: (1n << 64n) - 1n },
      { statementHash: new Uint8Array(32) }, { historyHash: new Uint8Array(32) }]) {
      expect(await check(f, resign({ ...r, ...patch }))).toMatchObject({ kind: "not-included" });
    }
  });

  it("preserves inclusion after replacement, moved-past after, and an unreached after", async () => {
    const f = await fixture(); f.venue.publish(evidence(f.segment, 3n).commitment);
    f.venue.advance(); replace(f.venue, f.x, SECRETS.carol, 2n); f.venue.advance();
    for (const after of [0n, 1n, 2n, 1000n]) {
      expect(await check(f, receipt(f, after))).toMatchObject({ kind: "included" });
    }
  });

  it("does not classify a receipt missing from an earlier checkpoint as lapsed or contradicted", async () => {
    const f = await fixture(); await issue(f.segment, f.oracle, f.x, 103n);
    const r = signPoolReceipt(SECRETS.operator, f.segment.authority(),
      f.segment.acceptedStatement(f.segment.prefix().events.at(-1)!.statementHash)!, 1n);
    expect(await check(f, r)).toMatchObject({ kind: "not-included" });
    const later = evidence(f.segment, 2n); f.venue.publish(later.commitment);
    expect(await check(f, r, later, [f.base])).toMatchObject({ kind: "included" });
  });

  it("accepts alternate valid proof bytes without attributing them to the original receipt", async () => {
    const f = await fixture(), r = receipt(f), changed = evidence(f.segment, 2n);
    changed.history!.trail.statements[0]!.proof.fill(77); f.oracle.accept(changed.history!.trail.statements[0]!);
    f.venue.publish(changed.commitment);
    expect(await check(f, r, changed, [f.base])).toMatchObject({ kind: "included" });
  });

  it("requires the source segment checkpoint, even when another segment imports its event", async () => {
    const f = await fixture(), child = open(f.venue, [f.y], f.oracle, 2n, [{ checkpoint: f.base, segment: f.segment }]);
    const target = evidence(child); f.venue.publish(target.commitment);
    expect(await check(f, receipt(f), target, [f.base])).toMatchObject({ kind: "invalid", reason: /another receipt segment/ });
    expect(await check(f)).toMatchObject({ kind: "included" });
  });

  it("keeps missing history unavailable after scope ending and rejects invalid proof evidence", async () => {
    const f = await fixture(), { history: _history, ...missing } = f.base;
    f.venue.advance(); replace(f.venue, f.x, SECRETS.carol, 2n); f.venue.advance();
    expect(await check(f, receipt(f), missing)).toMatchObject({ kind: "unavailable", evidence: "history" });
    f.base.history!.trail.statements[0]!.proof.fill(99);
    expect(await check(f)).toMatchObject({ kind: "invalid", reason: /proof/ });
  });

  it("rejects an unheld checkpoint or invalid receipt without manufacturing inclusion", async () => {
    const f = await fixture();
    expect(await check(f, receipt(f), evidence(f.segment, 2n))).toMatchObject({ kind: "invalid", reason: /held/ });
    const r = copyPoolReceipt(receipt(f)); r.signature.fill(0); f.oracle.calls = 0;
    expect(await check(f, r)).toMatchObject({ kind: "invalid" }); expect(f.oracle.calls).toBe(0);
    expect(await check(f, null as never)).toMatchObject({ kind: "invalid" });
  });

  it("owns the receipt before asynchronous replay and preserves backend failures", async () => {
    const f = await fixture(), r = receipt(f), original = f.oracle.verify.bind(f.oracle);
    vi.spyOn(f.oracle, "verify").mockImplementation(async (...args) => { r.historyHash.fill(0); return original(...args); });
    expect(await check(f, r)).toMatchObject({ kind: "included" });
    vi.spyOn(f.oracle, "verify").mockRejectedValue(new TypeError("backend bug"));
    await expect(check(f)).rejects.toThrow("backend bug");
  });
});
