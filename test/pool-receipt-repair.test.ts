import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import { readPoolReceiptRepair } from "../src/pool/receipt-repair.js";
import { readPoolReceiptCheckpoint } from "../src/pool/receipt-record.js";
import { poolReceiptBytes, signPoolReceipt } from "../src/pool/receipt.js";
import { Segment } from "../src/pool/segment.js";
import { LocalVenue, VenueError } from "../src/venue.js";
import { evidence, issue, open, replace, terms } from "./pool-record-support.js";
import { CONFIG, Oracle, VENUE } from "./pool-support.js";
import { SECRETS } from "./support.js";

async function fixture(includedAtAfter = false) {
  const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), y = terms("USD");
  const segment = open(venue, [x, y], oracle);
  let base = evidence(segment);
  await issue(segment, oracle, x, 101n);
  const accepted = segment.acceptedStatement(segment.prefix().events[0]!.statementHash)!;
  const receipt = signPoolReceipt(SECRETS.operator, segment.authority(), accepted, 1n);
  if (includedAtAfter) base = evidence(segment);
  venue.publish(base.commitment);
  return { venue, oracle, x, y, segment, base, receipt };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function repair(f: Fixture, sequence = 3n, source = f.base) {
  const parent = await Segment.replay(source.history!.trail, f.oracle);
  const child = open(f.venue, [f.x, f.y], f.oracle, sequence, [{ checkpoint: source, segment: parent }]);
  return { child, checkpoint: evidence(child) };
}
function args(f: Fixture, checkpoint: ReturnType<typeof evidence>, ancestors = [f.base]) {
  return { configuration: CONFIG, venue: f.venue, header: f.segment.header, receipt: f.receipt,
    backings: [f.x, f.y], repair: checkpoint.commitment, evidence: [...ancestors, checkpoint], verifier: f.oracle };
}

describe("C2.10.9a receipt classification at a proven repair boundary", () => {
  it("lapses the unfinalized receipt with held after 1 and canonical repair 3", async () => {
    const f = await fixture(), r = await repair(f); f.venue.publish(r.checkpoint.commitment);
    expect(await readPoolReceiptRepair(args(f, r.checkpoint))).toMatchObject({ kind: "repair", lapsed: true,
      includedAt: [], contradictedAt: [], boundary: { at: 0n, commitment: r.checkpoint.commitment }, witnessedIndex: 0n });
  });

  it("passes over a boundary carrying none of the scope, whose segment can still include the receipt", async () => {
    const f = await fixture(), z = terms("GBP");
    const child = open(f.venue, [z], f.oracle, 3n), boundary = evidence(child);
    f.venue.publish(boundary.commitment);
    // This opening carries none of the old backings, so it changes none of
    // their carrying states: it is not a repair boundary for this receipt.
    const later = evidence(f.segment, 4n); f.venue.publish(later.commitment);
    expect(await readPoolReceiptRepair(args(f, boundary, [f.base, later])))
      .toMatchObject({ kind: "not-applicable", reason: "no-carriage" });
    expect(await readPoolReceiptCheckpoint({ ...args(f, boundary, [f.base, later]), checkpoint: later.commitment }))
      .toMatchObject({ kind: "included" });
  });

  it("counts a passed-over checkpoint as filling no hole, with directory-only evidence", async () => {
    const f = await fixture(), passed = evidence(open(f.venue, [terms("GBP")], f.oracle, 3n));
    f.venue.publish(passed.commitment);
    const r = await repair(f, 4n); f.venue.publish(r.checkpoint.commitment);
    expect(await readPoolReceiptRepair(args(f, r.checkpoint, [f.base, { commitment: passed.commitment, directory: passed.directory }])))
      .toMatchObject({ kind: "repair", lapsed: true, boundary: { commitment: r.checkpoint.commitment } });
    const g = await fixture(), filled = evidence(open(g.venue, [terms("GBP")], g.oracle, 2n));
    g.venue.publish(filled.commitment);
    const s = await repair(g, 3n); g.venue.publish(s.checkpoint.commitment);
    expect(await readPoolReceiptRepair(args(g, s.checkpoint, [g.base, filled]))).toMatchObject({ kind: "not-applicable", reason: "no-gap" });
    expect(await readPoolReceiptRepair(args(g, s.checkpoint, [g.base]))).toMatchObject({ kind: "unavailable", evidence: "directory" });
  });

  it("preserves inclusion already in the after checkpoint", async () => {
    const f = await fixture(true), r = await repair(f); f.venue.publish(r.checkpoint.commitment);
    expect(await readPoolReceiptRepair(args(f, r.checkpoint))).toMatchObject({ kind: "repair", lapsed: false,
      includedAt: [{ commitment: f.base.commitment }], contradictedAt: [] });
  });

  it.each(["statementHash", "historyHash"] as const)("preserves a conflicting occupied after position (%s)", async field => {
    const f = await fixture(true), r = await repair(f); f.venue.publish(r.checkpoint.commitment);
    const changed = { ...f.receipt, [field]: new Uint8Array(32) };
    f.receipt = { ...changed, signature: ed25519.sign(poolReceiptBytes(changed), SECRETS.operator) };
    expect(await readPoolReceiptRepair(args(f, r.checkpoint))).toMatchObject({ kind: "repair", lapsed: false,
      includedAt: [], contradictedAt: [{ commitment: f.base.commitment }] });
  });

  it("preserves omission then inclusion as independent facts, including same-index lower sequences", async () => {
    const f = await fixture(), empty = await Segment.replay(f.base.history!.trail, f.oracle);
    const omission = evidence(empty, 2n), included = evidence(f.segment, 3n);
    f.venue.publish(omission.commitment); f.venue.publish(included.commitment);
    const r = await repair(f, 5n, included); f.venue.publish(r.checkpoint.commitment);
    expect(await readPoolReceiptRepair(args(f, r.checkpoint, [f.base, omission, included]))).toMatchObject({
      kind: "repair", lapsed: false, includedAt: [{ commitment: included.commitment }],
      contradictedAt: [{ commitment: omission.commitment }] });
  });

  it("retains an omission after a gap even when a later repair has its own gap", async () => {
    const f = await fixture(), empty = await Segment.replay(f.base.history!.trail, f.oracle), omission = evidence(empty, 3n);
    f.venue.publish(omission.commitment);
    const r = await repair(f, 5n, omission); f.venue.publish(r.checkpoint.commitment);
    expect(await readPoolReceiptRepair(args(f, r.checkpoint, [f.base, omission]))).toMatchObject({ kind: "repair",
      lapsed: false, contradictedAt: [{ commitment: omission.commitment }] });
  });

  it("does not call a continued old segment a repair", async () => {
    const f = await fixture(), continued = evidence(f.segment, 3n); f.venue.publish(continued.commitment);
    expect(await readPoolReceiptRepair(args(f, continued))).toMatchObject({ kind: "not-applicable", reason: "not-opening" });
  });

  it("requires the immediate predecessor gap, not a hole before a held continuation", async () => {
    const f = await fixture(), continued = evidence(f.segment, 3n); f.venue.publish(continued.commitment);
    const r = await repair(f, 4n, continued); f.venue.publish(r.checkpoint.commitment);
    expect(await readPoolReceiptRepair(args(f, r.checkpoint, [f.base, continued]))).toMatchObject({ kind: "not-applicable", reason: "no-gap" });
  });

  it("requires the actual opening sequence to be held", async () => {
    const f = await fixture(), r = await repair(f), later = evidence(r.child, 4n); f.venue.publish(later.commitment);
    expect(await readPoolReceiptRepair(args(f, later))).toMatchObject({ kind: "not-applicable", reason: "not-opening" });
  });

  it("requires an empty local opening history", async () => {
    const f = await fixture(), r = await repair(f); await issue(r.child, f.oracle, f.y, 102n);
    const nonempty = evidence(r.child); f.venue.publish(nonempty.commitment);
    expect(await readPoolReceiptRepair(args(f, nonempty))).toMatchObject({ kind: "not-applicable", reason: "not-opening" });
  });

  it("requires the first different segment, so a second repair cannot erase the first transition", async () => {
    const f = await fixture(), first = await repair(f); f.venue.publish(first.checkpoint.commitment);
    const second = open(f.venue, [f.x, f.y], f.oracle, 5n, [{ checkpoint: first.checkpoint, segment: first.child }]);
    const later = evidence(second); f.venue.publish(later.commitment);
    expect(await readPoolReceiptRepair(args(f, later, [f.base, first.checkpoint]))).toMatchObject({ kind: "not-applicable", reason: "earlier-transition" });
  });

  it("authenticates the held after segment rather than trusting its sequence", async () => {
    const f = await fixture(), r = await repair(f); f.venue.publish(r.checkpoint.commitment);
    const other = open(new LocalVenue(VENUE), [f.x], f.oracle); await issue(other, f.oracle, f.x, 103n);
    const accepted = other.acceptedStatement(other.prefix().events[0]!.statementHash)!;
    expect(await readPoolReceiptRepair({ ...args(f, r.checkpoint), header: other.header, backings: [f.x],
      receipt: signPoolReceipt(SECRETS.operator, other.authority(), accepted, 1n) }))
      .toMatchObject({ kind: "invalid", reason: /another segment/ });
  });

  it("does not claim a receipt with unheld after falls within this predicate", async () => {
    const f = await fixture(), r = await repair(f); f.venue.publish(r.checkpoint.commitment);
    const changed = { ...f.receipt, after: 2n };
    expect(await readPoolReceiptRepair({ ...args(f, r.checkpoint), receipt: {
      ...changed, signature: ed25519.sign(poolReceiptBytes(changed), SECRETS.operator) } }))
      .toMatchObject({ kind: "not-applicable", reason: "after-not-held" });
  });

  it("leaves a scope ending at the repair index to the scope-boundary rule", async () => {
    const f = await fixture(), r = await repair(f); replace(f.venue, f.x, SECRETS.carol, 1n);
    f.venue.advance(); f.venue.publish(r.checkpoint.commitment);
    expect(await readPoolReceiptRepair(args(f, r.checkpoint))).toMatchObject({ kind: "not-applicable", reason: "scope-boundary" });
  });

  it.each(["directory", "history"] as const)("missing %s cannot excuse a receipt", async missing => {
    const f = await fixture(), r = await repair(f); f.venue.publish(r.checkpoint.commitment);
    const { history: _history, ...withoutHistory } = f.base;
    const base = missing === "directory" ? [] : [withoutHistory];
    expect(await readPoolReceiptRepair(args(f, r.checkpoint, base))).toMatchObject({ kind: "unavailable", evidence: missing });
  });

  it("requires an intervening history even when after already includes the receipt", async () => {
    const f = await fixture(true), continued = evidence(f.segment, 2n); f.venue.publish(continued.commitment);
    const r = await repair(f, 4n, continued); f.venue.publish(r.checkpoint.commitment);
    expect(await readPoolReceiptRepair(args(f, r.checkpoint))).toMatchObject({ kind: "unavailable" });
  });

  it("rejects invalid canonical evidence and malformed external data", async () => {
    const f = await fixture(), r = await repair(f); f.venue.publish(r.checkpoint.commitment);
    expect(await readPoolReceiptRepair({ ...args(f, r.checkpoint), evidence: [f.base, { ...r.checkpoint, directory: [] }] }))
      .toMatchObject({ kind: "invalid" });
    expect(await readPoolReceiptRepair(null as never)).toMatchObject({ kind: "invalid" });
  });

  it("bounds reads by held records rather than enumerating a huge sequence gap", async () => {
    const f = await fixture(), r = await repair(f, (1n << 64n) - 1n); f.venue.publish(r.checkpoint.commitment);
    const spy = vi.spyOn(f.venue, "previousFor");
    expect(await readPoolReceiptRepair(args(f, r.checkpoint))).toMatchObject({ kind: "repair", lapsed: true });
    expect(spy.mock.calls.length).toBeLessThan(40);
  });

  it("owns external bytes before venue and asynchronous verifier callbacks", async () => {
    const f = await fixture(true), r = await repair(f); f.venue.publish(r.checkpoint.commitment);
    const input = structuredClone({ ...args(f, r.checkpoint), venue: undefined, verifier: undefined });
    const original = f.venue.previousFor.bind(f.venue);
    vi.spyOn(f.venue, "previousFor").mockImplementation((...values) => {
      input.receipt.statementHash.fill(0); input.repair.root.fill(0); input.evidence[0]!.history!.trail.header.operator.fill(0);
      return original(...values);
    });
    expect(await readPoolReceiptRepair({ ...input, venue: f.venue, verifier: f.oracle })).toMatchObject({ kind: "repair", lapsed: false });
  });

  it("captures venue and verifier references before a callback can replace them", async () => {
    const f = await fixture(true), r = await repair(f); f.venue.publish(r.checkpoint.commitment);
    const input = args(f, r.checkpoint), verify = vi.spyOn(f.oracle, "verify");
    const original = f.venue.previousFor.bind(f.venue);
    vi.spyOn(f.venue, "previousFor").mockImplementation((...values) => {
      input.venue = new LocalVenue(VENUE); input.verifier = new Oracle();
      return original(...values);
    });
    expect(await readPoolReceiptRepair(input)).toMatchObject({ kind: "repair", lapsed: false });
    expect(verify).toHaveBeenCalled();
  });

  it("propagates venue refusals, changed views and verifier programming failures", async () => {
    const f = await fixture(true), r = await repair(f); f.venue.publish(r.checkpoint.commitment);
    vi.spyOn(f.venue, "previousFor").mockImplementation(() => { throw new VenueError("offline"); });
    await expect(readPoolReceiptRepair(args(f, r.checkpoint))).rejects.toThrow("offline"); vi.restoreAllMocks();
    await expect(readPoolReceiptRepair({ ...args(f, r.checkpoint), verifier: { verify: async () => { throw new TypeError("backend"); } } }))
      .rejects.toThrow("backend");
    await expect(readPoolReceiptRepair({ ...args(f, r.checkpoint), verifier: { verify: async (...values) => {
      f.venue.advance(); return f.oracle.verify(...values);
    } } })).rejects.toThrow(VenueError);
  });
});
