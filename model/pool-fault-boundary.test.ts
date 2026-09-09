// Research evidence for design-review F2, not a candidate recovery rule.
// World models signatures and proofs as ideal object tokens. In particular,
// these tests do not establish authentication of production proof bytes or
// provide a fault certificate a real reader could use to skip a checkpoint.
import { describe, expect, it } from "vitest";
import { ProofOracle, Service, type Checkpoint, type Id, type Recorded, type World } from "./pool-authority.js";
import { RecoveryWorld } from "./pool-recovery.js";

const BACKINGS = ["X", "Y"] as const;
const CLAUSE = { noCommitment: 5n, nonService: { duration: 3n, count: 1n, window: 100n } };

function witness(w: World, checkpoint: Checkpoint): void {
  w.tick(checkpoint.signedAt + w.lag - w.now);
  expect(w.include(checkpoint)).toBe("final");
}

function fixture(w = new RecoveryWorld(1n)) {
  for (const backing of BACKINGS) {
    w.register(backing, "P");
    w.declare(backing, CLAUSE);
  }
  const p = w.open("P", BACKINGS);
  witness(w, p.commit()); // at 1
  const payer = w.oracle.note("X", 100n, "D", "payer");
  const other = w.oracle.note("Y", 80n, "D", "other-holder");
  for (const note of [payer, other]) {
    p.submit(w.oracle.prove(p, "issue", [], [note], [], { backing: note.backing, quantity: note.value }));
  }
  const issuance = p.commit();
  witness(w, issuance); // at 2
  const recipient = w.oracle.note("X", 40n, "D", "recipient");
  const change = w.oracle.note("X", 60n, "D", "payer");
  const padding = w.oracle.note("X", 0n);
  const payment = w.oracle.prove(p, "spend", [payer, padding], [recipient, change], [p.root(), p.root()]);
  const receipt = p.submit(payment);
  const base = p.commit();
  witness(w, base); // at 3: preserve this spend in every later assertion
  for (const note of [recipient, other]) {
    const request = w.oracle.prove(ProofOracle.unbound(), "request", [note], [], [p.root()], { backing: note.backing, quantity: 0n, refresh: 0n });
    expect(w.oracle.verify(request, p.scope, p.view().roots, {})).toBe(true);
    w.publish({ kind: "request", backing: note.backing, statement: request });
  }
  return { w, p, payer, recipient, change, other, issuance, base, payment, receipt };
}
type Fixture = ReturnType<typeof fixture>;

function assertFinalHoldings(f: Fixture): void {
  const state = f.w.import(f.base.id);
  expect(f.w.record(f.base.id).status).toBe("final");
  expect(state.spent.has(f.payer.nf)).toBe(true);
  for (const note of [f.recipient, f.change, f.other]) {
    expect(state.outputs.has(note.cm)).toBe(true);
    expect(state.spent.has(note.nf)).toBe(false);
  }
  expect(state.totals).toEqual(new Map([["X", 100n], ["Y", 80n]]));
}

/** Preserve the signed segment/header, every prior event, and all public
 * fields of one otherwise valid issuance. Only its ideal proof token differs.
 * Using World.sign models the hostile operator, bypassing the honest door. */
function suffix(f: Fixture, forgedProof: boolean): Service {
  const { w, p } = f;
  const note = w.oracle.note("X", 1n);
  const valid = w.oracle.prove(p, "issue", [], [note], [], { backing: "X", quantity: 1n });
  expect(w.oracle.verify(valid, p.scope, p.view().roots, {})).toBe(true);
  const statement = forgedProof ? Object.freeze({ ...valid }) : valid;
  expect(statement).toEqual(valid); // public values, including statement identity, unchanged
  expect(w.oracle.verify(statement, p.scope, p.view().roots, {})).toBe(!forgedProof);
  const hostile = new Service(w, p.id, p.scope, p.openings, p.view());
  hostile.events.push(...p.events, { id: `${p.id}:${p.events.length}`, statement });
  return hostile;
}

function includeInvalid(f: Fixture, hostile: Service): Checkpoint {
  const { w } = f;
  const bad = w.sign(hostile);
  w.tick(w.lag);
  expect(w.current(bad.scope)).toBe(true);
  expect(bad.carries).toEqual(BACKINGS);
  expect(bad.openings).toEqual(f.base.openings);
  expect(bad.events.slice(0, f.base.events.length)).toEqual(f.base.events);
  expect(bad.sequence).toBeGreaterThan(f.base.sequence);
  for (const backing of BACKINGS) expect(w.gapOpen(backing, w.now)).toBe(false);
  expect(w.include(bad)).toBe("invalid"); // signed, lag-satisfying, live, and complete scope
  expect(w.record(bad.id).state).toBeUndefined();
  return bad;
}

/** Deliberately insufficient, test-local thought experiment: give the reader
 * the model's ideal final/invalid statuses and skip invalid snapshots only.
 * This is not a deployable fault classifier or an approved protocol change. */
class SnapshotOnlySkippingWorld extends RecoveryWorld {
  override snapshot(backing: Id, at: bigint): Recorded | undefined {
    return this.records.filter(r => r.at < at && r.status === "final" &&
      r.checkpoint.carries.includes(backing) && this.term(backing, r.at).operator === r.checkpoint.operator).at(-1);
  }
}

describe("design-review F2: current invalid-checkpoint recovery boundaries", () => {
  it("control: the exact public suffix with a valid proof finalizes, and the aged valid requests count for both backings", () => {
    const f = fixture();
    witness(f.w, f.w.sign(suffix(f, false))); // at 4
    f.w.tick(2n);
    for (const backing of BACKINGS) {
      expect(f.w.count(backing, f.w.now)).toEqual({ count: 1n, fires: true, incumbent: "P", readable: true });
    }
    assertFinalHoldings(f);
    expect(f.w.recoveryViolations()).toEqual([]);
  });

  it("one otherwise valid signed checkpoint with a forged proof blocks snapshot, count, and successor import for both scope backings", () => {
    const f = fixture();
    const bad = includeInvalid(f, suffix(f, true)); // at 4
    f.w.tick(2n); // requests have reached their duration
    for (const backing of BACKINGS) {
      expect(() => f.w.snapshot(backing, f.w.now)).toThrow("invalid snapshot");
      expect(() => f.w.recoveryState(backing, f.w.now)).toThrow("invalid snapshot");
      expect(f.w.count(backing, f.w.now)).toEqual({ count: 0n, fires: false, incumbent: "P", readable: false });
      expect(f.w.currentFor(backing, "P")).toBe(bad.id);
      expect(() => f.w.import(bad.id)).toThrow("not finalized");
      f.w.replace(backing, "Q");
    }
    f.w.tick(3n); // replacement effective; prior invalid history was live at its own index
    for (const backing of BACKINGS) {
      expect(f.w.currentFor(backing, "Q")).toBe(bad.id);
      expect(() => f.w.open("Q", [backing])).toThrow("not finalized");
    }
    assertFinalHoldings(f);
  });

  it("recurring invalid publications before expiry keep resetting the clock; stopping opens a gap but leaves the snapshot blocked", () => {
    const f = fixture();
    const hostile = suffix(f, true);
    let bad = includeInvalid(f, hostile); // at 4
    // After the first bad proof, these continuations also fail the earlier
    // stale-continuation guard. We assert invalid publication, not its cause.
    for (let i = 0; i < 3; i++) {
      f.w.tick(3n);
      for (const backing of BACKINGS) {
        expect(f.w.closing(backing, f.w.now)).toBe(f.w.record(bad.id).at);
        expect(f.w.gapOpen(backing, f.w.now)).toBe(false);
      }
      bad = includeInvalid(f, hostile); // at 8, 12, 16
      for (const backing of BACKINGS) {
        expect(f.w.closing(backing, f.w.now + 1n)).toBe(f.w.now);
        expect(f.w.gapOpen(backing, f.w.now + 5n)).toBe(false);
      }
    }
    f.w.tick(6n);
    for (const backing of BACKINGS) {
      expect(f.w.gapOpen(backing, f.w.now)).toBe(true);
      expect(() => f.w.recoveryState(backing, f.w.now)).toThrow("invalid snapshot");
      expect(f.w.count(backing, f.w.now).readable).toBe(false);
    }
    assertFinalHoldings(f);
  });

  it("even ideal snapshot-only skipping preserves the finalized spend but does not repair the clock or descent", () => {
    const f = fixture(new SnapshotOnlySkippingWorld(1n));
    const hostile = suffix(f, true);
    let bad = includeInvalid(f, hostile);
    for (let i = 0; i < 3; i++) {
      f.w.tick(3n);
      for (const backing of BACKINGS) {
        expect(f.w.snapshot(backing, f.w.now)?.checkpoint.id).toBe(f.base.id);
        expect(f.w.recoveryState(backing, f.w.now).state.spent.has(f.payer.nf)).toBe(true);
        expect(f.w.gapOpen(backing, f.w.now)).toBe(false);
        // C2b.5.2 reads the count against the snapshot's state, so it follows the skip.
        expect(f.w.count(backing, f.w.now).readable).toBe(true);
        expect(f.w.currentFor(backing, "P")).toBe(bad.id);
      }
      bad = includeInvalid(f, hostile);
    }
    assertFinalHoldings(f);
  });
});

describe("design-review F2: failed replica evidence is not rollback authority", () => {
  it("a corrupt proof copy and unsigned checkpoint replacement do not change the authenticated finalized record", () => {
    const f = fixture();
    const corrupt = Object.freeze({ ...f.payment });
    expect(corrupt).toEqual(f.payment);
    expect(f.w.oracle.verify(corrupt, f.p.scope, f.p.view().roots, {})).toBe(false);
    const substituted = { ...f.base, events: f.base.events.map(event =>
      event.statement === f.payment ? { ...event, statement: corrupt } : event) };
    const count = f.w.records.length;
    expect(() => f.w.include(substituted)).toThrow("not signed");
    expect(f.w.records).toHaveLength(count);
    f.w.tick(6n);
    for (const backing of BACKINGS) {
      expect(f.w.snapshot(backing, f.w.now)?.checkpoint.id).toBe(f.base.id);
      expect(f.w.recoveryState(backing, f.w.now).state.spent.has(f.payer.nf)).toBe(true);
    }
    expect(f.w.classify(f.receipt, f.p.scope).status).toBe("final");
    assertFinalHoldings(f);
  });

  it.each(["withheld", "withheldDirectories", "withheldScopes", "corrupt-scope"] as const)(
    "%s blocks the required read and restoring evidence retains the recipient's finalized holding", unavailable => {
      const f = fixture();
      f.w.tick(6n);
      if (unavailable === "corrupt-scope") {
        f.w.shownScopes.set(f.base.id, { ...f.base.scope });
        expect(() => f.w.currentFor("X", "P")).toThrow("unauthenticated scope");
      } else {
        f.w[unavailable].add(f.base.id);
        if (unavailable === "withheld") {
          expect(f.w.currentFor("X", "P")).toBe(f.base.id);
          expect(() => f.w.recoveryState("X", f.w.now)).toThrow("unavailable history");
        } else {
          expect(() => f.w.currentFor("X", "P")).toThrow(unavailable === "withheldDirectories" ? "unavailable directory" : "unavailable scope");
        }
      }
      expect(f.w.record(f.base.id).status).toBe("final");
      expect(f.w.latestFor("X")).toBe(f.base.id);
      expect(f.w.latestFor("X")).not.toBe(f.issuance.id);
      f.w.withheld.clear(); f.w.withheldDirectories.clear(); f.w.withheldScopes.clear(); f.w.shownScopes.clear();
      expect(f.w.currentFor("X", "P")).toBe(f.base.id);
      expect(f.w.recoveryState("X", f.w.now).state.spent.has(f.payer.nf)).toBe(true);
      assertFinalHoldings(f);
    });
});
