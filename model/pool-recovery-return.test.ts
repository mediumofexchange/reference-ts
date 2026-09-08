// Unresolved counterexamples to C2b.4.1's return-as-a-new-segment rule.
// A healthy non-carrying commitment closes the current gap, but the readers
// then accept an old segment without adopting earlier publications with force.
// These assertions record the unsafe behavior for a pending protocol repair;
// finalizing the old spend is not the intended safety property.
import { describe, expect, it } from "vitest";
import { Service, type Acceptance, type Checkpoint } from "./pool-authority.js";
import { FaultWorld } from "./pool-fault.js";
import { RecoveryWorld } from "./pool-recovery.js";

const MODELS = [
  { name: "baseline recovery", create: () => new RecoveryWorld(1n) },
  { name: "default fault candidate", create: () => new FaultWorld(1n) },
  { name: "alternative non-carrying clock", create: () => new FaultWorld(1n, { nonCarryingSilenceClosesInterval: true }) },
];

function witness(w: RecoveryWorld, checkpoint: Checkpoint): void {
  w.tick();
  expect(w.include(checkpoint)).toBe("final");
}

/** X-only opening@1, issuance@2 and an admitted unfinalized spend; silence
 * settlement@8, then a valid independent Y-only opening@9. */
function fixture(w: RecoveryWorld) {
  for (const backing of ["X", "Y"]) { w.register(backing, "P"); w.declare(backing, { noCommitment: 5n }); }
  const p = w.open("P", ["X"]), opening = p.commit(); witness(w, opening);
  const note = w.oracle.note("X", 10n, "D", "payer");
  p.submit(w.oracle.prove(p, "issue", [], [note], [], { backing: "X", quantity: 10n }));
  const issued = p.commit(); witness(w, issued);
  expect(w.now).toBe(2n);
  const inputs = [note, w.oracle.note("X", 0n)], anchors = [p.root(), p.root()];
  const payee = w.oracle.note("X", 10n, "D", "payee");
  const spend = w.oracle.prove(p, "spend", inputs, [payee, w.oracle.note("X", 0n)], anchors);
  const receipt = p.submit(spend); // valid admission before the gap, never finalized
  expect(w.oracle.verify(spend, p.scope, p.view().roots, w.departures)).toBe(true);
  expect(w.import(issued.id).spent.has(note.nf)).toBe(false);
  w.tick(6n); // 8 > 2 + 5
  expect(w.gapOpen("X", w.now)).toBe(true);
  const demand = w.oracle.prove(p, "demand", inputs, [], anchors, {
    backing: "X", quantity: 10n, presenter: "holder", instant: 7n, deadline: 28n,
  });
  const acceptance: Acceptance = { demand: demand.id, owner: "backer-owner", deadline: 28n, signedByK: true };
  const returned = w.oracle.note("X", 10n, "D", acceptance.owner);
  const settle = w.oracle.prove(p, "settle", inputs, [returned], anchors, {
    backing: "X", quantity: 10n, presenter: "holder", owner: acceptance.owner, demand: demand.id, acceptance,
  });
  const publishedDemand = w.publish({ kind: "demand", backing: "X", statement: demand });
  w.publish({ kind: "acceptance", backing: "X", acceptance });
  const release = w.publish({ kind: "release", backing: "X", statement: settle });
  const beforeReset = w.recoveryState("X", 9n);
  expect(beforeReset.force).toEqual([publishedDemand, release]);
  expect(beforeReset.state.spent.has(note.nf)).toBe(true);
  expect(beforeReset.state.outputs.has(returned.cm)).toBe(true);
  expect(w.recoveryViolations()).toEqual([]);
  const y = w.open("P", ["Y"]), reset = y.commit(); witness(w, reset); // 9
  expect(reset.carries).toEqual(["Y"]);
  expect(w.now).toBe(9n);
  expect(w.gapOpen("X", 9n)).toBe(true); // c(t) is strictly before t
  expect(w.closing("X", 10n)).toBe(9n);
  expect(w.gapOpen("X", 10n)).toBe(false);
  expect(w.snapshot("X", 10n)?.checkpoint.id).toBe(issued.id);
  expect(w.recoveryState("X", 10n).force).toEqual([publishedDemand, release]);
  return { w, p, note, payee, returned, issued, spend, receipt, publishedDemand, release };
}

describe("unresolved recovery return counterexample: non-carrying reset revives an old segment", () => {
  it.each(MODELS)("$name currently finalizes the already-settled note's old spend", ({ create }) => {
    const { w, p, note, payee, returned, issued, spend, receipt, release } = fixture(create());
    // The hostile operator retains its signing key and old journal. Copy the
    // original, valid history exactly: no rewritten prefix or forged proof.
    const hostile = new Service(w, p.id, p.scope, p.openings, p.view());
    hostile.events.push(...p.events);
    const continuation = w.sign(hostile);
    expect(continuation.segment).toBe(issued.segment);
    expect(continuation.events.slice(0, issued.events.length)).toEqual(issued.events);
    expect(continuation.events.at(-1)?.statement).toBe(spend);
    witness(w, continuation); // UNSAFE current result: finalized at 10
    expect(w.now).toBe(10n);
    expect(w.classify(receipt, p.scope).status).toBe("final");
    const state = w.import(continuation.id);
    expect(state.spent.has(note.nf)).toBe(true);
    expect(state.outputs.has(payee.cm)).toBe(true);
    expect(state.outputs.has(returned.cm)).toBe(false); // earlier forced settlement was not adopted
    expect(w.recoveryState("X", release.at + 1n).force).toContain(release);
    expect(w.recoveryViolations()).toEqual(["settled note spent again"]);
  });

  it.each(MODELS)("$name's new-segment return adopts the exact force and refuses another spend", ({ create }) => {
    const { w, note, returned, issued, publishedDemand, release } = fixture(create());
    const next = w.open("P", ["X"]), opening = next.commit(); witness(w, opening); // 10
    expect(opening.segment).not.toBe(issued.segment);
    expect(next.openings.get("X")).toBe(issued.id);
    expect(w.block(next.id, next.openings).map(a => a.witnessed)).toEqual([publishedDemand, release]);
    expect(w.adoptGap(next)).toHaveLength(2);
    expect(next.view().spent.has(note.nf)).toBe(true);
    expect(next.view().outputs.has(returned.cm)).toBe(true);
    const roots = next.view().roots;
    const anchor = [...roots].find(([, leaves]) => leaves.includes(note.cm))![0];
    const replay = w.oracle.prove(next, "spend", [note, w.oracle.note("X", 0n)],
      [w.oracle.note("X", 10n, "D", "payee"), w.oracle.note("X", 0n)], [anchor, anchor]);
    expect(w.oracle.verify(replay, next.scope, roots, w.departures)).toBe(true);
    expect(() => next.submit(replay)).toThrow("spent");
    const adopted = next.commit(); witness(w, adopted); // 11
    expect(w.import(adopted.id).outputs.has(returned.cm)).toBe(true);
    expect(w.recoveryViolations()).toEqual([]);
  });

  it.each([false, true])("a silence-lapsed Y reset revives X only under the alternative (alternative=%s)", alternative => {
    const w = new FaultWorld(1n, { nonCarryingSilenceClosesInterval: alternative });
    for (const backing of ["X", "Y"]) { w.register(backing, "P"); w.declare(backing, { noCommitment: 5n }); }
    const p = w.open("P", ["X"]); witness(w, p.commit()); // 1
    const note = w.oracle.note("X", 10n, "D", "payer");
    p.submit(w.oracle.prove(p, "issue", [], [note], [], { backing: "X", quantity: 10n }));
    const issued = p.commit(); witness(w, issued); // 2
    const y = w.open("P", ["Y"]); witness(w, y.commit()); // 3
    const inputs = [note, w.oracle.note("X", 0n)], anchors = [p.root(), p.root()];
    const payee = w.oracle.note("X", 10n, "D", "payee");
    const spend = w.oracle.prove(p, "spend", inputs, [payee, w.oracle.note("X", 0n)], anchors);
    expect(w.oracle.verify(spend, p.scope, p.view().roots, w.departures)).toBe(true);
    w.tick(6n); // 9: X clock was last reset by Y's opening@3
    expect(w.gapOpen("X", 9n)).toBe(true);
    const demand = w.oracle.prove(p, "demand", inputs, [], anchors, {
      backing: "X", quantity: 10n, presenter: "holder", instant: 8n, deadline: 29n,
    });
    const acceptance: Acceptance = { demand: demand.id, owner: "backer-owner", deadline: 29n, signedByK: true };
    const returned = w.oracle.note("X", 10n, "D", acceptance.owner);
    const settle = w.oracle.prove(p, "settle", inputs, [returned], anchors, {
      backing: "X", quantity: 10n, presenter: "holder", owner: acceptance.owner, demand: demand.id, acceptance,
    });
    const publishedDemand = w.publish({ kind: "demand", backing: "X", statement: demand });
    w.publish({ kind: "acceptance", backing: "X", acceptance });
    const release = w.publish({ kind: "release", backing: "X", statement: settle });
    expect(w.recoveryState("X", 10n).force).toEqual([publishedDemand, release]);
    // Y signs a valid local issuance during its gap. The continuation lapses
    // for silence, with neither a forged proof nor an intrinsic segment fault.
    const staleY = new Service(w, y.id, y.scope, y.openings, y.view());
    const yIssue = w.oracle.prove(y, "issue", [], [w.oracle.note("Y", 1n)], [], { backing: "Y", quantity: 1n });
    expect(w.oracle.verify(yIssue, y.scope, y.view().roots, w.departures)).toBe(true);
    staleY.events.push({ id: `${y.id}:0`, statement: yIssue });
    const reset = w.sign(staleY); w.tick(); // 10
    expect(w.include(reset)).toBe("lapsed");
    expect(w.classification(reset.id)).toBe("lapsed");
    expect(w.closing("X", 11n)).toBe(alternative ? 10n : 3n);
    expect(w.gapOpen("X", 11n)).toBe(!alternative);
    const hostile = new Service(w, p.id, p.scope, p.openings, p.view());
    hostile.events.push(...p.events, { id: `${p.id}:${p.events.length}`, statement: spend });
    const continuation = w.sign(hostile); w.tick(); // 11
    expect(continuation.events.slice(0, issued.events.length)).toEqual(issued.events);
    expect(w.include(continuation)).toBe(alternative ? "final" : "lapsed");
    expect(w.recoveryViolations()).toEqual(alternative ? ["settled note spent again"] : []);
    if (alternative) {
      expect(w.import(continuation.id).outputs.has(payee.cm)).toBe(true);
      expect(w.import(continuation.id).outputs.has(returned.cm)).toBe(false);
    } else {
      const recovered = w.recoveryState("X", 12n);
      expect(recovered.state.outputs.has(payee.cm)).toBe(false);
      expect(recovered.state.outputs.has(returned.cm)).toBe(true);
    }
  });
});
