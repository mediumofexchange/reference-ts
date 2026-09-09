// Historical rejected clock rules, not active recovery behavior.
// The alternative removes other-scope silence dependencies by letting their
// stale commitments reset this backing's clock. These cases expose the cost.
import { describe, expect, it } from "vitest";
import { ProofOracle, Service, type Acceptance, type Binding, type Checkpoint, type Id, type Note } from "./pool-authority.js";
import { HistoricalFaultWorld as FaultWorld } from "./pool-fault-historical.js";

const BACKINGS = ["X", "Y"] as const;
const CLAUSE = { noCommitment: 5n, nonService: { duration: 3n, count: 1n, window: 100n } };

function witness(w: FaultWorld, checkpoint: Checkpoint, status = "final"): void {
  if (w.now < checkpoint.signedAt + w.lag) w.tick(checkpoint.signedAt + w.lag - w.now);
  expect(w.include(checkpoint)).toBe(status);
}

function fixture(alternative: boolean) {
  const w = new FaultWorld(1n, { nonCarryingSilenceClosesInterval: alternative });
  for (const backing of BACKINGS) { w.register(backing, "P"); w.declare(backing, CLAUSE); }
  const p = w.open("P", BACKINGS), opening = p.commit(); witness(w, opening);
  return { w, p, opening };
}

function badProof(w: FaultWorld, p: Service): Checkpoint {
  const backing = p.scope.entries[0]!.backing;
  const valid = w.oracle.prove(p, "issue", [], [w.oracle.note(backing, 1n)], [], { backing, quantity: 1n });
  const invalid = Object.freeze({ ...valid });
  expect(w.oracle.verify(valid, p.scope, p.view().roots, {})).toBe(true);
  expect(w.oracle.verify(invalid, p.scope, p.view().roots, {})).toBe(false);
  const hostile = new Service(w, p.id, p.scope, p.openings, p.view());
  hostile.events.push(...p.events, { id: `${p.id}:${p.events.length}`, statement: invalid });
  const bad = w.sign(hostile); witness(w, bad, "invalid");
  expect(w.classification(bad.id)).toBe("excluded");
  return bad;
}

function r1(alternative: boolean) {
  const f = fixture(alternative), { w, p } = f; // XY@1
  const y = p.change(["Y"]), yOpening = y.commit(); witness(w, yOpening); // Y@2
  const bad = badProof(w, y); // badY@3
  w.tick(4n);
  const continuation = w.sign(y); witness(w, continuation, "lapsed"); // Y@8
  return { ...f, y, yOpening, bad, continuation };
}

function redeem(w: FaultWorld, note: Note, binding: Binding, roots: ReadonlyMap<Id, readonly Id[]>) {
  const inputs = [note, w.oracle.note(note.backing, 0n)];
  const anchor = [...roots].find(([, leaves]) => leaves.includes(note.cm))![0];
  const lit = { backing: note.backing, quantity: note.value, presenter: `holder:${note.cm}` };
  const demand = w.oracle.prove(binding, "demand", inputs, [], [anchor, anchor], { ...lit, instant: w.now - 1n, deadline: w.now + 20n });
  const acceptance: Acceptance = { demand: demand.id, owner: "backer-owner", deadline: w.now + 15n, signedByK: true };
  const out = w.oracle.note(note.backing, note.value, "D", acceptance.owner);
  const settle = w.oracle.prove(binding, "settle", inputs, [out], [anchor, anchor], { ...lit, owner: acceptance.owner, demand: demand.id, acceptance });
  const publishedDemand = w.publish({ kind: "demand", backing: note.backing, statement: demand });
  w.publish({ kind: "acceptance", backing: note.backing, acceptance });
  const release = w.publish({ kind: "release", backing: note.backing, statement: settle });
  return { publishedDemand, release, out };
}

describe("non-carrying silence clock alternative: dependency and liveness cost", () => {
  it.each([false, true])("R1 preserves Y lapse but changes X's strict clock (alternative=%s)", alternative => {
    const { w, continuation } = r1(alternative);
    expect(w.classification(continuation.id)).toBe("lapsed");
    expect(w.closing("Y", 9n)).toBe(2n);
    expect(w.gapOpen("Y", 9n)).toBe(true);
    expect(w.closing("X", 8n)).toBe(3n); // same-index commitment is not yet in c(t)
    expect(w.gapOpen("X", 8n)).toBe(false); // equality does not open the gap
    expect(w.closing("X", 9n)).toBe(alternative ? 8n : 3n);
    expect(w.gapOpen("X", 9n)).toBe(!alternative);
    expect(w.gapOpen("X", 13n)).toBe(!alternative);
    expect(w.gapOpen("X", 14n)).toBe(true);
  });

  it.each([false, true])("withheld Y fault history blocks only the default X clock (alternative=%s)", alternative => {
    const { w, bad, continuation } = r1(alternative), reader = w.reader();
    reader.withheld.add(bad.id); reader.withheld.add(continuation.id);
    expect(reader.classification(continuation.id)).toBe("unresolved");
    if (alternative) {
      expect(reader.closing("X", 9n)).toBe(8n);
      expect(reader.gapOpen("X", 9n)).toBe(false);
    } else {
      expect(() => reader.closing("X", 9n)).toThrow("unresolved clock");
      expect(() => reader.gapOpen("X", 9n)).toThrow("unresolved clock");
    }
    reader.withheld.clear();
    expect(reader.classification(continuation.id)).toBe("lapsed");
    expect(reader.closing("X", 9n)).toBe(alternative ? 8n : 3n);
  });

  it.each(["withheldDirectories", "withheldScopes", "shownScopes"] as const)(
    "the alternative still authenticates its non-carrying step's %s", facet => {
      const { w, bad, continuation } = r1(true), reader = w.reader();
      reader.withheld.add(bad.id); // successful recovery cannot rely on this proof
      if (facet === "shownScopes") reader.shownScopes.set(continuation.id, { ...continuation.scope });
      else reader[facet].add(continuation.id);
      expect(() => reader.closing("X", 9n)).toThrow("unresolved clock");
      reader[facet].clear();
      expect(reader.closing("X", 9n)).toBe(8n);
    },
  );

  it.each([false, true])("term lapse still excludes a non-carrying reset without event history (alternative=%s)", alternative => {
    const { w, p } = fixture(alternative);
    const y = p.change(["Y"]); witness(w, y.commit()); // 2
    const bad = badProof(w, y); // 3
    w.replace("Y", "Q"); w.tick(2n);
    const ended = w.sign(y); witness(w, ended, "lapsed"); // 6
    const reader = w.reader(); reader.withheld.add(bad.id); reader.withheld.add(ended.id);
    expect(reader.classification(ended.id)).toBe("lapsed");
    expect(reader.closing("X", 9n)).toBe(3n);
    expect(reader.gapOpen("X", 9n)).toBe(true);
    reader.withheldScopes.add(ended.id);
    expect(() => reader.closing("X", 9n)).toThrow("unresolved clock");
  });

  it.each([false, true])("a stale Y stream delays X redemption only under the alternative; count and independent replacement remain (alternative=%s)", alternative => {
    const { w, p } = fixture(alternative), note = w.oracle.note("X", 100n);
    p.submit(w.oracle.prove(p, "issue", [], [note], [], { backing: "X", quantity: note.value }));
    const issued = p.commit(); witness(w, issued); // 2
    w.publish({ kind: "request", backing: "X", statement: w.oracle.prove(ProofOracle.unbound(), "request", [note], [], [p.root()], { backing: "X", quantity: 0n, refresh: 0n }) });
    const y = p.change(["Y"]); witness(w, y.commit()); // 3
    badProof(w, y); // 4
    for (const at of [9n, 13n, 17n, 21n]) {
      w.tick(at - w.now - 1n);
      const c = w.sign(y); witness(w, c, "lapsed");
      expect(w.closing("X", at + 1n)).toBe(alternative ? at : 4n);
      expect(w.gapOpen("X", at + 1n)).toBe(!alternative);
      expect(w.classification(c.id)).toBe("lapsed");
      expect(w.count("X", at + 1n)).toEqual({ count: 1n, fires: true, incumbent: "P", readable: true });
    }
    w.replace("X", "Q"); w.tick(3n); // independent replacement authority
    const replacement = w.open("Q", ["X"]); witness(w, replacement.commit());
    expect(replacement.openings.get("X")).toBe(issued.id);
    expect(replacement.view().outputs.has(note.cm)).toBe(true);
    expect(w.gapOpen("X", w.now + 1n)).toBe(false);
    expect(w.recoveryViolations()).toEqual([]);
  });

  it.each([false, true])("preserves force before a non-carrying reset and adopts exactly that force across another silence (alternative=%s)", alternative => {
    const { w, p } = fixture(alternative);
    const firstNote = w.oracle.note("X", 40n), secondNote = w.oracle.note("X", 60n), yNote = w.oracle.note("Y", 80n);
    for (const note of [firstNote, secondNote, yNote]) {
      p.submit(w.oracle.prove(p, "issue", [], [note], [], { backing: note.backing, quantity: note.value }));
    }
    const issued = p.commit(); witness(w, issued); // XY issuance@2
    const roots = w.import(issued.id).roots;
    w.publish({ kind: "request", backing: "X", statement: w.oracle.prove(ProofOracle.unbound(), "request", [secondNote], [], [p.root()], { backing: "X", quantity: 0n, refresh: 0n }) });
    const y = p.change(["Y"]); witness(w, y.commit()); // 3
    badProof(w, y); // 4
    w.tick(6n); // 10: X clock=4, a first redemption has force in both models
    expect(w.gapOpen("X", w.now)).toBe(true);
    const first = redeem(w, firstNote, p, roots);
    const reset = w.sign(y); witness(w, reset, "lapsed"); // 11
    w.tick(); // 12: publication after the reset
    const second = redeem(w, secondNote, p, roots);
    const recovered = w.recoveryState("X", 13n);
    const expectedForce = alternative ? [first.publishedDemand, first.release] : [first.publishedDemand, first.release, second.publishedDemand, second.release];
    expect(recovered.force).toEqual(expectedForce);
    expect(recovered.state.spent.has(firstNote.nf)).toBe(true);
    expect(recovered.state.spent.has(secondNote.nf)).toBe(!alternative);
    expect(w.count("X", 13n)).toMatchObject({ count: 1n, fires: true, readable: true });
    w.tick(); // 13
    const next = w.open("P", BACKINGS), opening = next.commit(); witness(w, opening); // 14
    expect(next.openings.get("X")).toBe(issued.id);
    expect(next.view().outputs.has(yNote.cm)).toBe(true);
    expect(w.block(next.id, next.openings).map(a => a.witnessed)).toEqual(expectedForce);
    expect(w.adoptGap(next)).toHaveLength(expectedForce.length);
    witness(w, next.commit()); // 15
    w.tick(6n); // 21: a second silence after the adopting checkpoint
    expect(w.gapOpen("X", w.now)).toBe(true);
    const duplicate = redeem(w, firstNote, next, next.view().roots);
    const last = redeem(w, secondNote, next, next.view().roots);
    const final = w.recoveryState("X", 22n);
    expect(final.force).not.toContain(duplicate.release);
    expect(final.force).toEqual(alternative ? [last.publishedDemand, last.release] : []);
    expect(final.state.spent.has(firstNote.nf)).toBe(true);
    expect(final.state.spent.has(secondNote.nf)).toBe(true);
    expect(final.state.outputs.has(first.out.cm)).toBe(true);
    expect(final.state.outputs.has(duplicate.out.cm)).toBe(false);
    expect(final.state.outputs.has(alternative ? last.out.cm : second.out.cm)).toBe(true);
    expect(final.state.outputs.has(yNote.cm)).toBe(true);
    expect(final.state.spent.has(yNote.nf)).toBe(false);
    expect(w.recoveryViolations()).toEqual([]);
  });
});
