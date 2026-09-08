// Historical rejected rules only: price the transitive and historical dependencies of both
// rejected fault clocks after the C2b.4.1 historical-silence repair.
import { expect, it } from "vitest";
import { Service, type Checkpoint } from "./pool-authority.js";
import { HistoricalFaultWorld as FaultWorld } from "./pool-fault-historical.js";

function witness(w: FaultWorld, c: Checkpoint, status = "final"): void {
  w.tick(c.signedAt + w.lag - w.now);
  expect(w.include(c)).toBe(status);
}

function fixture(alternative: boolean) {
  const w = new FaultWorld(1n, { nonCarryingSilenceClosesInterval: alternative });
  for (const backing of ["X", "Y", "Z"]) {
    w.register(backing, "P");
    w.declare(backing, { noCommitment: 5n });
  }
  const x = w.open("P", ["X"]); witness(w, x.commit()); // X@1
  const y = w.open("P", ["Y"]); witness(w, y.commit()); // Y@2
  w.tick();
  const z = w.open("P", ["Z"]); witness(w, z.commit()); // Z@4
  const valid = w.oracle.prove(z, "issue", [], [w.oracle.note("Z", 1n)], [], { backing: "Z", quantity: 1n });
  const invalid = Object.freeze({ ...valid });
  expect(w.oracle.verify(valid, z.scope, z.view().roots, {})).toBe(true);
  expect(w.oracle.verify(invalid, z.scope, z.view().roots, {})).toBe(false);
  const hostile = new Service(w, z.id, z.scope, z.openings, z.view());
  hostile.events.push({ id: `${z.id}:0`, statement: invalid });
  const fault = w.sign(hostile); witness(w, fault, "invalid"); // bad Z@5
  expect(w.classification(fault.id)).toBe("excluded");
  w.tick(4n);
  const zLater = w.sign(z); witness(w, zLater, "lapsed"); // Z@10
  return { w, y, fault };
}

it.each([false, true])("fresh unrelated openings suppress X silence under either clock (alternative=%s)", alternative => {
  const w = new FaultWorld(1n, { nonCarryingSilenceClosesInterval: alternative });
  for (const backing of ["X", "Y"]) {
    w.register(backing, "P"); w.declare(backing, { noCommitment: 5n });
  }
  witness(w, w.open("P", ["X"]).commit());
  witness(w, w.open("P", ["Y"]).commit());
  for (const at of [4n, 7n, 10n, 13n]) {
    w.tick(at - w.now - w.lag);
    witness(w, w.open("P", ["Y"]).commit());
    expect(w.closing("X", at + 1n)).toBe(at);
    expect(w.gapOpen("X", at + 1n)).toBe(false);
  }
  expect(w.recoveryViolations()).toEqual([]);
});

it.each([false, true])("an X clock passes Y lapse through Z's fault with three disjoint scopes (alternative=%s)", alternative => {
  const { w, y, fault } = fixture(alternative);
  const yLater = w.sign(y); witness(w, yLater, alternative ? "final" : "lapsed"); // Y@11
  const reader = w.reader();
  expect(reader.closing("X", 12n)).toBe(alternative ? 11n : 5n);
  reader.withheld.add(fault.id);
  if (alternative) expect(reader.closing("X", 12n)).toBe(11n);
  else expect(() => reader.closing("X", 12n)).toThrow("unresolved clock");
  reader.withheld.delete(fault.id);
  expect(reader.gapOpen("X", 12n)).toBe(!alternative);
  expect(w.recoveryViolations()).toEqual([]);
});

it.each([false, true])("a later reset does not erase evidence needed to pass Y's historical lapse (alternative=%s)", alternative => {
  const { w, y, fault } = fixture(alternative);
  w.tick();
  const zRepair = w.open("P", ["Z"]); witness(w, zRepair.commit()); // fresh Z@12
  const before = w.reader(); before.withheld.add(fault.id);
  // The non-carrying opening itself needs no Z event history for this clock.
  expect(before.closing("X", 13n)).toBe(12n);
  const yLater = w.sign(y); witness(w, yLater, alternative ? "final" : "lapsed"); // Y@13
  expect(w.gapOpen("Y", 13n)).toBe(false);
  const reader = w.reader();
  expect(reader.closing("X", 14n)).toBe(alternative ? 13n : 12n);
  reader.withheld.add(fault.id);
  if (alternative) expect(reader.closing("X", 14n)).toBe(13n);
  else expect(() => reader.closing("X", 14n)).toThrow("unresolved clock");
  reader.withheld.delete(fault.id);
  expect(reader.closing("X", 14n)).toBe(alternative ? 13n : 12n);
  expect(w.recoveryViolations()).toEqual([]);
});
