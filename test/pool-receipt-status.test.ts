import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import type { PoolCheckpointEvidence } from "../src/pool/checkpoint.js";
import { readPoolReceiptStatus } from "../src/pool/receipt-status.js";
import { poolReceiptBytes, signPoolReceipt, type PoolReceipt } from "../src/pool/receipt.js";
import { Segment, type SignedBacking } from "../src/pool/segment.js";
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
function resign(r: PoolReceipt, patch: Partial<PoolReceipt>): PoolReceipt {
  const changed = { ...r, ...patch };
  return { ...changed, signature: ed25519.sign(poolReceiptBytes(changed), SECRETS.operator) };
}
/** A new segment of this operator opened from `source`, signed at `sequence`. */
async function reopen(f: Fixture, backings: readonly SignedBacking[], sequence: bigint, source = f.base) {
  const parent = await Segment.replay(source.history!.trail, f.oracle);
  const child = open(f.venue, backings, f.oracle, sequence, [{ checkpoint: source, segment: parent }]);
  return { child, checkpoint: evidence(child) };
}
/** A segment of this operator carrying none of the receipt's scope. */
function aside(f: Fixture, sequence: bigint): PoolCheckpointEvidence {
  const passed = evidence(open(f.venue, [terms("GBP")], f.oracle, sequence));
  f.venue.publish(passed.commitment);
  return passed;
}
function status(f: Fixture, supplied: readonly PoolCheckpointEvidence[] = [f.base], receipt = f.receipt, header = f.segment.header, backings = [f.x, f.y]) {
  return readPoolReceiptStatus({ configuration: CONFIG, venue: f.venue, header, receipt, backings, evidence: supplied, verifier: f.oracle });
}
async function empty(f: Fixture, sequence: bigint): Promise<PoolCheckpointEvidence> {
  const omission = evidence(await Segment.replay(f.base.history!.trail, f.oracle), sequence);
  f.venue.publish(omission.commitment);
  return omission;
}
function later(f: Fixture, sequence: bigint): PoolCheckpointEvidence {
  const included = evidence(f.segment, sequence);
  f.venue.publish(included.commitment);
  return included;
}

describe("C2.10.9b receipt verdicts at the present index", () => {
  it("is pending while the held reference is the record's latest and the scope is live", async () => {
    const f = await fixture();
    expect(await status(f)).toEqual({ kind: "status", status: "pending", witnessedIndex: 0n, scope: "live",
      sequence: { kind: "held", at: 0n, commitment: f.base.commitment }, includedAt: [], contradictedAt: [] });
  });

  it("is final when the after checkpoint or a later segment checkpoint includes it", async () => {
    const f = await fixture(true);
    expect(await status(f)).toMatchObject({ status: "final", includedAt: [{ commitment: f.base.commitment, at: 0n }], contradictedAt: [] });
    const g = await fixture(), included = later(g, 2n);
    // Absence at after is not a contradiction; inclusion afterwards is final.
    expect(await status(g, [g.base, included])).toMatchObject({ status: "final", includedAt: [{ commitment: included.commitment }], contradictedAt: [] });
  });

  it("keeps an omission after a held reference as a contradiction beside later inclusion", async () => {
    const f = await fixture(), omission = await empty(f, 2n);
    expect(await status(f, [f.base, omission])).toMatchObject({ status: "contradicted", contradictedAt: [{ commitment: omission.commitment }] });
    const included = later(f, 3n);
    expect(await status(f, [f.base, omission, included])).toMatchObject({ status: "final",
      includedAt: [{ commitment: included.commitment }], contradictedAt: [{ commitment: omission.commitment }] });
  });

  it.each(["statementHash", "historyHash"] as const)("contradicts a receipt whose after position is occupied otherwise (%s)", async field => {
    const f = await fixture(true), receipt = resign(f.receipt, { [field]: new Uint8Array(32) });
    expect(await status(f, [f.base], receipt)).toMatchObject({ status: "contradicted", includedAt: [], contradictedAt: [{ commitment: f.base.commitment }] });
  });

  it("lapses at a proven failed-publication repair", async () => {
    const f = await fixture(), r = await reopen(f, [f.x, f.y], 3n); f.venue.publish(r.checkpoint.commitment);
    expect(await status(f, [f.base, r.checkpoint])).toMatchObject({ status: "lapsed",
      lapse: { kind: "repair", boundary: { commitment: r.checkpoint.commitment, at: 0n } }, includedAt: [], contradictedAt: [] });
  });

  it("passes over checkpoints carrying none of the scope: occupied sequences, not holes, directory evidence only", async () => {
    const f = await fixture(), passed = aside(f, 3n), directoryOnly = { commitment: passed.commitment, directory: passed.directory };
    expect(await status(f, [f.base, directoryOnly])).toMatchObject({ status: "pending" });
    const included = later(f, 4n);
    expect(await status(f, [f.base, directoryOnly, included])).toMatchObject({ status: "final", includedAt: [{ commitment: included.commitment }] });
    const g = await fixture(), passedG = aside(g, 3n), r = await reopen(g, [g.x, g.y], 4n); g.venue.publish(r.checkpoint.commitment);
    expect(await status(g, [g.base, { commitment: passedG.commitment, directory: passedG.directory }, r.checkpoint]))
      .toMatchObject({ status: "lapsed", lapse: { kind: "repair", boundary: { commitment: r.checkpoint.commitment } } });
    const h = await fixture(), filled = aside(h, 2n), s = await reopen(h, [h.x, h.y], 3n); h.venue.publish(s.checkpoint.commitment);
    expect(await status(h, [h.base, filled, s.checkpoint])).toMatchObject({ status: "abandoned", abandonedAt: { commitment: s.checkpoint.commitment } });
  });

  it("reports an elective carrying scope change that did not first witness the receipt as abandoned", async () => {
    const f = await fixture(), r = await reopen(f, [f.x, f.y], 2n); f.venue.publish(r.checkpoint.commitment);
    expect(await status(f, [f.base, r.checkpoint])).toMatchObject({ status: "abandoned", abandonedAt: { commitment: r.checkpoint.commitment, at: 0n },
      includedAt: [], contradictedAt: [] });
    expect((await status(f, [f.base, r.checkpoint]) as { lapse?: unknown }).lapse).toBeUndefined();
    const g = await fixture(), dropped = await reopen(g, [g.x], 2n); g.venue.publish(dropped.checkpoint.commitment);
    expect(await status(g, [g.base, dropped.checkpoint])).toMatchObject({ status: "abandoned" });
    // A hole before a transition that is not an empty opening is not repair either.
    const h = await fixture(), busy = await reopen(h, [h.x, h.y], 3n); await issue(busy.child, h.oracle, h.y, 102n);
    const nonempty = evidence(busy.child); h.venue.publish(nonempty.commitment);
    expect(await status(h, [h.base, nonempty])).toMatchObject({ status: "abandoned", abandonedAt: { commitment: nonempty.commitment } });
  });

  it("treats a scope change after inclusion as an ordinary one", async () => {
    const f = await fixture(true), r = await reopen(f, [f.x], 2n); f.venue.publish(r.checkpoint.commitment);
    const result = await status(f, [f.base, r.checkpoint]);
    expect(result).toMatchObject({ status: "final", includedAt: [{ commitment: f.base.commitment }] });
    expect((result as { abandonedAt?: unknown }).abandonedAt).toBeUndefined();
    const g = await fixture(), omission = await empty(g, 2n), s = await reopen(g, [g.x, g.y], 3n, omission); g.venue.publish(s.checkpoint.commitment);
    // A proven contradiction decides before the transition, which is then not replayed.
    const { history: _s, ...withheldS } = s.checkpoint;
    const contradicted = await status(g, [g.base, omission, withheldS]);
    expect(contradicted).toMatchObject({ status: "contradicted", contradictedAt: [{ commitment: omission.commitment }] });
    expect((contradicted as { abandonedAt?: unknown }).abandonedAt).toBeUndefined();
  });

  it("lapses a moved-past reference unless a later segment checkpoint includes it, without contradictions", async () => {
    const f = await fixture(), receipt = resign(f.receipt, { after: 2n });
    const omission = await empty(f, 3n);
    expect(await status(f, [f.base, omission], receipt)).toMatchObject({ status: "lapsed", lapse: { kind: "moved-past" },
      sequence: { kind: "moved-past" }, includedAt: [], contradictedAt: [] });
    const included = later(f, 4n);
    expect(await status(f, [f.base, omission, included], receipt)).toMatchObject({ status: "final", includedAt: [{ commitment: included.commitment }], contradictedAt: [] });
    const g = await fixture(), r = await reopen(g, [g.x, g.y], 3n); g.venue.publish(r.checkpoint.commitment);
    expect(await status(g, [g.base, r.checkpoint], resign(g.receipt, { after: 2n }))).toMatchObject({ status: "lapsed", lapse: { kind: "moved-past" } });
  });

  it("reads inclusion below a moved-past reference and a position occupied otherwise there", async () => {
    const f = await fixture(true), hostile = resign(f.receipt, { after: 3n }), continued = later(f, 4n);
    expect(await status(f, [f.base, continued], hostile)).toMatchObject({ status: "final", includedAt: [{ commitment: f.base.commitment }] });
    const lie = resign(hostile, { statementHash: new Uint8Array(32) });
    expect(await status(f, [f.base, continued], lie)).toMatchObject({ status: "contradicted", contradictedAt: [{ commitment: f.base.commitment }] });
  });

  it("is pending while the reference is not reached and the scope is live, lapsed once a term has ended", async () => {
    const f = await fixture(), receipt = resign(f.receipt, { after: 5n });
    expect(await status(f, [f.base], receipt)).toMatchObject({ status: "pending", sequence: { kind: "not-reached" } });
    // The segment's latest live checkpoint below the reference is read first.
    const g = await fixture(true);
    expect(await status(g, [g.base], resign(g.receipt, { after: 5n }))).toMatchObject({ status: "final", includedAt: [{ commitment: g.base.commitment }] });
    expect(await status(g, [g.base], resign(g.receipt, { after: 5n, historyHash: new Uint8Array(32) }))).toMatchObject({ status: "contradicted" });
    replace(f.venue, f.x, SECRETS.carol, 1n); f.venue.advance();
    expect(await status(f, [f.base], receipt)).toMatchObject({ status: "lapsed", scope: "ended", boundary: 1n, lapse: { kind: "scope-boundary", at: 1n } });
    expect(await status(f, [], receipt)).toMatchObject({ kind: "unavailable", evidence: "directory" });
  });

  it("lapses at the actual scope boundary and ignores checkpoints witnessed from it on", async () => {
    const f = await fixture(); replace(f.venue, f.x, SECRETS.carol, 1n); f.venue.advance();
    expect(await status(f)).toMatchObject({ status: "lapsed", boundary: 1n, lapse: { kind: "scope-boundary", at: 1n } });
    const late = later(f, 2n);
    expect(await status(f, [f.base, late])).toMatchObject({ status: "lapsed", includedAt: [], contradictedAt: [] });
    // A reference held from the boundary on is itself lapsed; inclusion before it is read first.
    expect(await status(f, [f.base, late], resign(f.receipt, { after: 2n }))).toMatchObject({ status: "lapsed", sequence: { kind: "held", at: 1n } });
    const g = await fixture(true); replace(g.venue, g.x, SECRETS.carol, 1n); g.venue.advance();
    const lateG = later(g, 2n);
    expect(await status(g, [g.base, lateG], resign(g.receipt, { after: 2n }))).toMatchObject({ status: "final", includedAt: [{ commitment: g.base.commitment }] });
    expect(await status(g, [g.base, lateG])).toMatchObject({ status: "final" });
  });

  it("reads the segment's latest live checkpoint below a reference above an elective transition", async () => {
    const f = await fixture(true), r = await reopen(f, [f.x, f.y], 2n); f.venue.publish(r.checkpoint.commitment);
    const directoryOnly = { commitment: r.checkpoint.commitment, directory: r.checkpoint.directory, snapshots: r.checkpoint.snapshots! };
    expect(await status(f, [f.base, directoryOnly], resign(f.receipt, { after: 3n }))).toMatchObject({ status: "final", sequence: { kind: "not-reached" } });
    const passed = aside(f, 4n), passedDirectory = { commitment: passed.commitment, directory: passed.directory };
    expect(await status(f, [f.base, directoryOnly, passedDirectory], resign(f.receipt, { after: 3n })))
      .toMatchObject({ status: "final", sequence: { kind: "moved-past" } });
    expect(await status(f, [f.base, directoryOnly, passedDirectory], resign(f.receipt, { after: 3n, statementHash: new Uint8Array(32) })))
      .toMatchObject({ status: "contradicted" });
  });

  it("keeps a proven inclusion or contradiction when later evidence cannot be related or validated", async () => {
    const f = await fixture(true), continued = later(f, 2n);
    const { history: _history, ...withheld } = continued;
    expect(await status(f, [f.base, withheld])).toMatchObject({ status: "final", includedAt: [{ commitment: f.base.commitment }] });
    // Nothing above the reference is even related once it proves inclusion.
    expect(await status(f, [f.base])).toMatchObject({ status: "final" });
    aside(f, 3n);
    expect(await status(f, [f.base])).toMatchObject({ status: "final" });
    const corrupt = structuredClone(continued); corrupt.history!.trail.statements[0]!.proof.fill(99);
    expect(await status(f, [f.base, corrupt])).toMatchObject({ status: "final" });
    const g = await fixture(), omission = await empty(g, 2n), next = later(g, 3n), { history: _next, ...withheldNext } = next;
    expect(await status(g, [g.base, omission, withheldNext])).toMatchObject({ kind: "unavailable", evidence: "history",
      commitment: next.commitment, contradictedAt: [{ commitment: omission.commitment }] });
    expect(await status(g, [g.base, omission])).toMatchObject({ kind: "unavailable", evidence: "directory",
      commitment: next.commitment, contradictedAt: [{ commitment: omission.commitment }] });
    const h = await fixture(), included = later(h, 2n); aside(h, 3n);
    expect(await status(h, [h.base, included])).toMatchObject({ status: "final", includedAt: [{ commitment: included.commitment }] });
  });

  it("does not replay a transition that cannot decide the verdict", async () => {
    const f = await fixture(), r = await reopen(f, [f.x, f.y], 3n); f.venue.publish(r.checkpoint.commitment);
    const { history: _history, ...withheld } = r.checkpoint;
    expect(await status(f, [f.base, withheld], resign(f.receipt, { after: 2n }))).toMatchObject({ status: "lapsed", lapse: { kind: "moved-past" } });
    expect(await status(f, [f.base, withheld])).toMatchObject({ kind: "unavailable", evidence: "history" });
    const g = await fixture(true), s = await reopen(g, [g.x], 2n); g.venue.publish(s.checkpoint.commitment);
    const { history: _s, ...withheldS } = s.checkpoint;
    expect(await status(g, [g.base, withheldS])).toMatchObject({ status: "final" });
  });

  it("authenticates a held reference witnessed from the boundary on", async () => {
    const f = await fixture(); replace(f.venue, f.x, SECRETS.carol, 1n); f.venue.advance();
    const r = await reopen(f, [f.y], 2n); f.venue.publish(r.checkpoint.commitment);
    expect(await status(f, [f.base, r.checkpoint], resign(f.receipt, { after: 2n }))).toMatchObject({ kind: "invalid", reason: /another segment/ });
  });

  it("returns unavailable for missing history, scope or directory evidence instead of a verdict", async () => {
    const f = await fixture(), { history: _history, ...withoutHistory } = f.base, { snapshots: _snapshots, ...withoutScope } = f.base;
    expect(await status(f, [withoutHistory])).toMatchObject({ kind: "unavailable", evidence: "history" });
    expect(await status(f, [withoutScope])).toMatchObject({ kind: "unavailable", evidence: "scope" });
    expect(await status(f, [])).toMatchObject({ kind: "unavailable", evidence: "directory" });
    const r = await reopen(f, [f.x, f.y], 3n); f.venue.publish(r.checkpoint.commitment);
    expect(await status(f, [f.base, { commitment: r.checkpoint.commitment, directory: r.checkpoint.directory }])).toMatchObject({ kind: "unavailable", evidence: "scope" });
  });

  it("rejects a reference of another segment, invalid evidence and malformed input", async () => {
    const f = await fixture(), other = open(new LocalVenue(VENUE), [f.x], f.oracle); await issue(other, f.oracle, f.x, 103n);
    const accepted = other.acceptedStatement(other.prefix().events[0]!.statementHash)!;
    expect(await status(f, [f.base], signPoolReceipt(SECRETS.operator, other.authority(), accepted, 1n), other.header, [f.x]))
      .toMatchObject({ kind: "invalid", reason: /another segment/ });
    expect(await status(f, [{ ...f.base, directory: [] }])).toMatchObject({ kind: "invalid" });
    expect(await status(f, [f.base, f.base])).toMatchObject({ kind: "invalid", reason: /duplicate/ });
    const g = await fixture(true), corrupt = structuredClone(g.base); corrupt.history!.trail.statements[0]!.proof.fill(99);
    expect(await status(g, [corrupt])).toMatchObject({ kind: "invalid", reason: /proof/ });
    expect(await readPoolReceiptStatus(null as never)).toMatchObject({ kind: "invalid" });
  });

  it("bounds record reads by held commitments rather than sequence distance", async () => {
    const f = await fixture(), r = await reopen(f, [f.x, f.y], (1n << 64n) - 1n); f.venue.publish(r.checkpoint.commitment);
    const spy = vi.spyOn(f.venue, "previousFor");
    expect(await status(f, [f.base, r.checkpoint])).toMatchObject({ status: "lapsed", lapse: { kind: "repair" } });
    expect(spy.mock.calls.length).toBeLessThan(40);
  });

  it("owns external bytes and captured references before venue and verifier callbacks", async () => {
    const f = await fixture(true), r = await reopen(f, [f.x], 2n); f.venue.publish(r.checkpoint.commitment);
    const input = structuredClone({ configuration: CONFIG, header: f.segment.header, receipt: f.receipt, backings: [f.x, f.y], evidence: [f.base, r.checkpoint] });
    const original = f.venue.previousFor.bind(f.venue), verify = vi.spyOn(f.oracle, "verify");
    const args = { ...input, venue: f.venue, verifier: f.oracle };
    vi.spyOn(f.venue, "previousFor").mockImplementation((...values) => {
      input.receipt.statementHash.fill(0); input.evidence[0]!.history!.trail.header.operator.fill(0); input.header.entries[0]!.link.fill(0);
      args.venue = new LocalVenue(VENUE); args.verifier = new Oracle();
      return original(...values);
    });
    expect(await readPoolReceiptStatus(args)).toMatchObject({ status: "final" });
    expect(verify).toHaveBeenCalled();
  });

  it("propagates venue refusals, changed views and verifier programming failures", async () => {
    const f = await fixture(true);
    vi.spyOn(f.venue, "previousFor").mockImplementation(() => { throw new VenueError("offline"); });
    await expect(status(f)).rejects.toThrow("offline"); vi.restoreAllMocks();
    await expect(readPoolReceiptStatus({ configuration: CONFIG, venue: f.venue, header: f.segment.header, receipt: f.receipt, backings: [f.x, f.y],
      evidence: [f.base], verifier: { verify: async () => { throw new TypeError("backend"); } } })).rejects.toThrow("backend");
    await expect(readPoolReceiptStatus({ configuration: CONFIG, venue: f.venue, header: f.segment.header, receipt: f.receipt, backings: [f.x, f.y],
      evidence: [f.base], verifier: { verify: async (...values) => { f.venue.advance(); return f.oracle.verify(...values); } } })).rejects.toThrow(VenueError);
    const g = await fixture(), latest = g.venue.latestFor.bind(g.venue);
    vi.spyOn(g.venue, "latestFor").mockImplementation((...values) => { replace(g.venue, g.x, SECRETS.carol, 1n); return latest(...values); });
    await expect(status(g)).rejects.toThrow(VenueError);
  });
});
