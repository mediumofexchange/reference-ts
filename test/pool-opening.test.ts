import { describe, expect, it, vi } from "vitest";
import { directoryRoot, signCommitment } from "../src/commitment.js";
import { readPoolCheckpoint, readPoolCheckpoints, type PoolCheckpointEvidence } from "../src/pool/checkpoint.js";
import { readPoolCurrent, readPoolPredecessor } from "../src/pool/descent.js";
import { preparePoolOpening } from "../src/pool/opening.js";
import { PoolError, type SignedBacking, type StatementVerifier } from "../src/pool/segment.js";
import { LocalVenue, VenueError } from "../src/venue.js";
import { CONFIG, Oracle, spendStatement, VENUE } from "./pool-support.js";
import { evidence, fixture, issue, open, read, replace, terms } from "./pool-record-support.js";
import { KEYS, SECRETS } from "./support.js";

function prepare(venue: LocalVenue, backings: readonly SignedBacking[], highestSignedSequence: bigint,
  supplied: readonly PoolCheckpointEvidence[] = [], verifier: StatementVerifier = new Oracle(), operator = KEYS.operator) {
  return preparePoolOpening({ configuration: CONFIG, venue, operator, highestSignedSequence, backings, evidence: supplied, verifier });
}

describe("C2.7/C2.10: canonical openings before a child commitment exists", () => {
  it.each([undefined, null, {}, 0])("refuses malformed outer arguments %s across the public readers", async value => {
    expect(readPoolPredecessor(value as never)).toMatchObject({ kind: "invalid" });
    expect(readPoolCurrent(value as never)).toMatchObject({ kind: "invalid" });
    expect(await readPoolCheckpoint(value as never)).toMatchObject({ kind: "invalid" });
    expect(await readPoolCheckpoints(value as never)).toMatchObject({ kind: "invalid" });
    expect(await preparePoolOpening(value as never)).toMatchObject({ kind: "invalid" });
  });
  it("prepares genesis without signing, publishing or inventing a child checkpoint", async () => {
    const venue = new LocalVenue(VENUE), x = terms("EUR"), publish = vi.spyOn(venue, "publish");
    const result = await prepare(venue, [x], 0n);
    expect(result).toMatchObject({ kind: "prepared", witnessedIndex: 0n });
    if (result.kind !== "prepared") throw new Error("expected opening");
    expect(result.segment.header.entries).toEqual([{ backing: x.backing.name, link: x.backing.name }]);
    expect(result.segment.header.sequence).toBe(1n); expect(result.segment.length).toBe(0n);
    expect(result.segment.issued(x.backing.name)).toBe(0n);
    expect(publish).not.toHaveBeenCalled(); expect(venue.latestFor(KEYS.operator)).toBeUndefined();
  });

  it("imports the latest same-index checkpoint and its eventual opening checkpoint passes finality", async () => {
    const f = await fixture(), newer = evidence(f.segment, 2n); f.venue.publish(newer.commitment);
    const result = await prepare(f.venue, [f.y, f.x], 2n, [f.base, newer], f.oracle);
    if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
    expect(result.segment.header.entries.map(e => e.opening?.sequence)).toEqual([2n, 2n]);
    expect(result.segment.header.sequence).toBe(3n);
    expect(result.segment.length).toBe(0n); expect(result.segment.leaves()).toEqual([]);
    expect(result.segment.issued(f.x.backing.name)).toBe(10n);
    const child = evidence(result.segment); f.venue.publish(child.commitment);
    expect(await read(f.venue, child, [f.base, newer], f.oracle)).toMatchObject({ kind: "final", prefix: result.segment.prefix() });
  });

  it("takes sequence from the durable signed counter, including unsuccessful publications", async () => {
    const f = await fixture();
    const declined = evidence(f.segment, 5n); // signed and consumed, never published
    const result = await prepare(f.venue, [f.x], declined.commitment.sequence, [f.base], f.oracle);
    if (result.kind !== "prepared") throw new Error("expected opening");
    expect(result.segment.header.sequence).toBe(6n);
    expect(result.segment.header.entries[0]!.opening?.sequence).toBe(1n);
    expect(f.venue.latestFor(KEYS.operator)?.sequence).toBe(1n);
  });

  it("counts held omitted sequences operator-wide even when they provide no opening state", async () => {
    const f = await fixture(), omitted = { commitment: signCommitment(SECRETS.operator, 7n, directoryRoot([])), directory: [] };
    f.venue.publish(omitted.commitment);
    expect(await prepare(f.venue, [f.x], 6n, [f.base, omitted], f.oracle)).toMatchObject({ kind: "invalid", reason: /behind the record/ });
    const result = await prepare(f.venue, [f.x], 7n, [f.base, omitted], f.oracle);
    if (result.kind !== "prepared") throw new Error("expected opening");
    expect(result.segment.header.sequence).toBe(8n); expect(result.segment.header.entries[0]!.opening?.sequence).toBe(1n);
    const retained = result.evidence.find(e => e.commitment.sequence === 7n)!;
    expect(retained.history).toBeUndefined();
    expect(retained.snapshots).toBeUndefined();
  });

  it.each([-1n, 1n << 64n, (1n << 64n) - 1n, 0 as never])("rejects invalid or exhausted durable counter %s", async highest => {
    const venue = new LocalVenue(VENUE);
    expect(await prepare(venue, [terms("EUR")], highest)).toMatchObject({ kind: "invalid", reason: /sequence counter/ });
  });

  it("permits the last representable new segment sequence without probing sequence holes", async () => {
    const f = await fixture(), reads = vi.spyOn(f.venue, "previousFor");
    const result = await prepare(f.venue, [f.x], (1n << 64n) - 2n, [f.base], f.oracle);
    if (result.kind !== "prepared") throw new Error("expected opening");
    expect(result.segment.header.sequence).toBe((1n << 64n) - 1n);
    expect(reads.mock.calls.length).toBeLessThan(15);
  });

  it.each(["directory", "scope", "history"])("stops on missing %s instead of constructing genesis", async missing => {
    const f = await fixture();
    const { snapshots: _s, ...noScope } = f.base, { history: _h, ...noHistory } = f.base;
    const supplied = missing === "directory" ? [] : [missing === "scope" ? noScope : noHistory];
    expect(await prepare(f.venue, [f.x], 1n, supplied, f.oracle)).toMatchObject({ kind: "unavailable", evidence: missing });
  });

  it("refuses live invalid and selectively carried history before it can become an opening", async () => {
    const f = await fixture(), invalid = evidence(f.segment, 2n); invalid.history!.trail.statements[0]!.proof.fill(91);
    f.venue.publish(invalid.commitment);
    expect(await prepare(f.venue, [f.x], 2n, [f.base, invalid], f.oracle)).toMatchObject({ kind: "invalid", reason: /proof/ });
    const directory = f.base.directory.filter(d => Buffer.from(d.name).equals(f.x.backing.name));
    const partial = { ...evidence(f.segment), directory, commitment: signCommitment(SECRETS.operator, 3n, directoryRoot(directory)) };
    f.venue.publish(partial.commitment);
    expect(await prepare(f.venue, [f.x], 3n, [f.base, invalid, partial], f.oracle)).toMatchObject({ kind: "invalid", reason: /whole scope/ });
  });

  it("rejects unowned, duplicate, empty or incorrectly signed scopes", async () => {
    const f = await fixture();
    expect(await prepare(f.venue, [f.x], 0n, [f.base], f.oracle, KEYS.carol)).toMatchObject({ kind: "invalid", reason: /whole requested scope/ });
    for (const backings of [[], [f.x, f.x], [{ ...f.x, signature: new Uint8Array(64) }]]) {
      expect(await prepare(f.venue, backings, 1n, [f.base], f.oracle)).toMatchObject({ kind: "invalid" });
    }
    expect(await prepare(f.venue, [f.x], 1n, [f.base, f.base], f.oracle)).toMatchObject({ kind: "invalid", reason: /duplicate/ });
  });

  it("waits for actual replacement force and excludes old-operator publications at the boundary", async () => {
    const f = await fixture(); replace(f.venue, f.x, SECRETS.carol, 1n);
    expect(await prepare(f.venue, [f.x], 0n, [f.base], f.oracle, KEYS.carol)).toMatchObject({ kind: "invalid" });
    f.venue.advance();
    const late = evidence(f.segment, 2n); f.venue.publish(late.commitment);
    const result = await prepare(f.venue, [f.x], 0n, [f.base], f.oracle, KEYS.carol);
    if (result.kind !== "prepared") throw new Error("expected opening");
    expect(result.segment.header.entries[0]!.opening?.sequence).toBe(1n);
    expect(result.segment.header.entries[0]!.link).not.toEqual(f.x.backing.name);
  });

  it("skips public whole-scope lapse but still consumes the signed sequence", async () => {
    const f = await fixture(); replace(f.venue, f.x, SECRETS.carol, 1n); f.venue.advance();
    const late = { ...evidence(f.segment, 7n), history: {} as never }; f.venue.publish(late.commitment);
    const result = await prepare(f.venue, [f.y], 7n, [f.base, late], f.oracle);
    if (result.kind !== "prepared") throw new Error("expected opening");
    expect(result.segment.header.sequence).toBe(8n); expect(result.segment.header.entries[0]!.opening?.sequence).toBe(1n);
    const retained = result.evidence.find(e => e.commitment.sequence === 7n)!;
    expect(retained.history).toBeUndefined();
    expect(retained.snapshots).toHaveLength(1);
    expect(retained.snapshots![0]!.backing).toEqual(f.y.backing.name);
  });

  it("does not copy an unfinalized local tail or modify the existing segment", async () => {
    const f = await fixture(); await issue(f.segment, f.oracle, f.x, 501n);
    const length = f.segment.length, result = await prepare(f.venue, [f.x], 1n, [f.base], f.oracle);
    if (result.kind !== "prepared") throw new Error("expected opening");
    expect(result.segment.issued(f.x.backing.name)).toBe(10n); expect(f.segment.issued(f.x.backing.name)).toBe(20n);
    expect(f.segment.length).toBe(length); expect(result.segment.length).toBe(0n);
    // This calculation grants no authority to discard f.segment's live tail.
  });

  it("rejoins through same-key reappointment with all shared spentness and no duplicate proof verification", async () => {
    const f = await fixture(); replace(f.venue, f.x, SECRETS.carol, 1n); f.venue.advance();
    const px = await prepare(f.venue, [f.x], 0n, [f.base], f.oracle, KEYS.carol);
    const py = await prepare(f.venue, [f.y], 1n, [f.base], f.oracle);
    if (px.kind !== "prepared" || py.kind !== "prepared") throw new Error("expected split openings");
    await px.segment.admit(f.oracle.accept(spendStatement(px.segment.authority(), [f.segment.noteRoot(), f.segment.noteRoot()], [401n, 402n], [201n, 202n])));
    await issue(py.segment, f.oracle, f.y, 203n);
    const cx = evidence(px.segment, 1n, SECRETS.carol), cy = evidence(py.segment); f.venue.publish(cx.commitment); f.venue.publish(cy.commitment);
    replace(f.venue, f.x, SECRETS.operator, 2n); f.venue.advance(); f.oracle.calls = 0;
    const result = await prepare(f.venue, [f.y, f.x], 2n, [f.base, cx, cy], f.oracle);
    if (result.kind !== "prepared") throw new Error("expected joined opening");
    expect(f.oracle.calls).toBe(4); expect(result.segment.prefix().events).toHaveLength(4);
    expect(result.segment.isSpent(401n)).toBe(true); expect(result.segment.isSpent(402n)).toBe(true);
    expect(result.segment.isAnchor(px.segment.noteRoot())).toBe(true); expect(result.segment.isAnchor(py.segment.noteRoot())).toBe(true);
    expect(result.segment.issued(f.x.backing.name)).toBe(10n); expect(result.segment.issued(f.y.backing.name)).toBe(20n);
  });

  it("owns every root's required evidence before the first verifier callback", async () => {
    const venue = new LocalVenue(VENUE), x = terms("EUR"), y = terms("USD"), oracle = new Oracle();
    const sx = open(venue, [x], oracle), sy = open(venue, [y], oracle, 2n);
    await issue(sx, oracle, x, 101n); await issue(sy, oracle, y, 102n);
    const cx = evidence(sx), cy = evidence(sy); venue.publish(cx.commitment); venue.publish(cy.commitment);
    const backings = [x, y], supplied = [cx, cy], configuration = structuredClone(CONFIG);
    let attacked = false;
    const verifier: StatementVerifier = { verify: async (...args) => {
      if (!attacked) {
        attacked = true;
        for (const item of supplied) {
          item.history!.trail.statements[0]!.proof.fill(0); item.history!.trail.header.operator.fill(0);
          item.history!.trail.backings[0]!.signature.fill(0); item.directory[0]!.digest.fill(0); item.commitment.signature.fill(0);
        }
        backings[0]!.signature.fill(0); configuration.issue.vk.fill(0);
      }
      return oracle.verify(...args);
    } };
    const result = await preparePoolOpening({ configuration, venue, operator: KEYS.operator, highestSignedSequence: 2n, backings, evidence: supplied, verifier });
    expect(result.kind).toBe("prepared"); expect(attacked).toBe(true);
    if (result.kind !== "prepared") throw new Error("expected opening");
    expect(result.segment.prefix().events).toHaveLength(2);
  });

  it.each(["clock", "same-index publication"])("refuses %s while proofs yield", async change => {
    const f = await fixture();
    let changed = false;
    const verifier: StatementVerifier = { verify: async (...args) => {
      if (!changed) { changed = true; if (change === "clock") f.venue.advance(); else f.venue.publish(evidence(f.segment, 2n).commitment); }
      return f.oracle.verify(...args);
    } };
    await expect(prepare(f.venue, [f.x], 1n, [f.base], verifier)).rejects.toThrow(VenueError);
  });

  it("refuses unsettled venue reads and preserves backend exception identity", async () => {
    const f = await fixture();
    for (const error of [new Error("backend"), new TypeError("backend"), new RangeError("backend"), new PoolError("PROOF", "backend")]) {
      await expect(prepare(f.venue, [f.x], 1n, [f.base], { verify: async () => { throw error; } })).rejects.toBe(error);
    }
    vi.spyOn(f.venue, "previousFor").mockImplementation(() => { throw new VenueError("refresh incomplete"); });
    await expect(prepare(f.venue, [f.x], 1n, [f.base], f.oracle)).rejects.toThrow("refresh incomplete");
  });

  it("current selection cannot use a caller's stale sequence to hide a held record", async () => {
    const f = await fixture(), newer = evidence(f.segment, (1n << 64n) - 1n); f.venue.publish(newer.commitment);
    const result = readPoolCurrent({ configuration: CONFIG, venue: f.venue, operator: KEYS.operator, backing: f.x,
      evidence: [f.base, newer].map(e => ({ ...e, snapshot: e.snapshots!.find(s => Buffer.from(s.backing).equals(f.x.backing.name))! })) });
    expect(result).toMatchObject({ kind: "candidate", checkpoint: { commitment: newer.commitment } });
  });

  it("batch validation preserves request order, deduplicates shared ancestors and rejects duplicate requests", async () => {
    const f = await fixture(), second = evidence(f.segment, 2n); f.venue.publish(second.commitment);
    const args = { configuration: CONFIG, venue: f.venue, evidence: [f.base, second], verifier: f.oracle };
    for (const checkpoints of [[f.base.commitment, second.commitment], [second.commitment, f.base.commitment]]) {
      f.oracle.calls = 0;
      const result = await readPoolCheckpoints({ ...args, checkpoints });
      if (result.kind !== "final") throw new Error("expected final batch");
      expect(result.checkpoints.map(c => c.commitment)).toEqual(checkpoints); expect(f.oracle.calls).toBe(4);
    }
    expect(await readPoolCheckpoints({ ...args, checkpoints: [] })).toMatchObject({ kind: "invalid" });
    expect(await readPoolCheckpoints({ ...args, checkpoints: [f.base.commitment, f.base.commitment] })).toMatchObject({ kind: "invalid" });
  });
});
