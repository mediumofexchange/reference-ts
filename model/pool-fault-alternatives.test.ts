// Research alternatives to the recorded fault recommendations, priced against
// the default candidate: D, "the clock is the snapshot's" (only a valid
// checkpoint carrying the backing resets its no-commitment clock), and R7′,
// "the segment continues from its last valid checkpoint" (an excluded
// checkpoint is held at its sequence and supplies no state, without ending its
// segment). Neither is normative. The companion repository's pool-fault.md
// proposes them for the maintainer's selection and cites these cases.
import { describe, expect, it } from "vitest";
import { ProofOracle, Service, type Acceptance, type Binding, type Checkpoint, type Id, type Note } from "./pool-authority.js";
import { FaultWorld, type FaultChoices } from "./pool-fault.js";

const CLAUSE = { noCommitment: 5n, nonService: { duration: 3n, count: 1n, window: 100n } };
const CLOCKS = [
  { name: "operator-wide clock (default A″)", choices: {} as FaultChoices, snapshotClock: false },
  { name: "the clock is the snapshot's (D)", choices: { clockIsSnapshot: true } as FaultChoices, snapshotClock: true },
];
const SEGMENTS = [
  { name: "a fault ends the segment (default R7)", choices: {} as FaultChoices, continues: false },
  { name: "the segment continues from its last valid checkpoint (R7′)", choices: { faultContinuesSegment: true } as FaultChoices, continues: true },
];

function witness(w: FaultWorld, c: Checkpoint, status = "final"): void {
  if (w.now < c.signedAt + w.lag) w.tick(c.signedAt + w.lag - w.now);
  expect(w.include(c)).toBe(status);
}

function issue(w: FaultWorld, p: Service, backing: Id, quantity = 1n, owner?: Id) {
  const note = w.oracle.note(backing, quantity, "D", owner);
  const statement = w.oracle.prove(p, "issue", [], [note], [], { backing, quantity });
  return { note, statement, receipt: p.submit(statement) };
}

/** The operator's key signs a checkpoint whose copy of one admitted statement
 * carries a proof that does not verify; every public field is unchanged. */
function badProof(w: FaultWorld, p: Service): Checkpoint {
  const backing = p.scope.entries[0]!.backing;
  const valid = w.oracle.prove(p, "issue", [], [w.oracle.note(backing, 1n)], [], { backing, quantity: 1n });
  const invalid = Object.freeze({ ...valid });
  expect(w.oracle.verify(invalid, p.scope, p.view().roots, {})).toBe(false);
  const hostile = new Service(w, p.id, p.scope, p.openings, p.view());
  hostile.events.push(...p.events, { id: `${p.id}:${p.events.length}`, statement: invalid });
  const bad = w.sign(hostile); witness(w, bad, "invalid");
  expect(w.classification(bad.id)).toBe("excluded");
  return bad;
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

/** XY opening@1, an X note issued@2 with a non-service request for it, then
 * the operator drops X and serves Y alone from @3. */
function dropped(choices: FaultChoices) {
  const w = new FaultWorld(1n, choices);
  for (const b of ["X", "Y"]) { w.register(b, "P"); w.declare(b, CLAUSE); }
  const p = w.open("P", ["X", "Y"]); witness(w, p.commit()); // XY@1
  const { note } = issue(w, p, "X", 100n, "holder");
  const issued = p.commit(); witness(w, issued); // XY@2
  const roots = w.import(issued.id).roots;
  w.publish({ kind: "request", backing: "X", statement: w.oracle.prove(ProofOracle.unbound(), "request", [note], [], [p.root()], { backing: "X", quantity: 0n }) });
  const y = p.change(["Y"]); witness(w, y.commit()); // Y@3: X dropped, Y served on
  return { w, p, y, note, issued, roots };
}

describe("D: the clock is the snapshot's", () => {
  it.each(CLOCKS)("$name: a dropped backing's clock, count and redemption", ({ choices, snapshotClock }) => {
    const { w, p, y, note, issued, roots } = dropped(choices);
    w.tick(2n); witness(w, y.commit()); // Y@6
    for (const t of [4n, 7n, 8n]) expect(w.snapshot("X", t)?.checkpoint.id).toBe(issued.id);
    expect(w.closing("X", 7n)).toBe(snapshotClock ? 2n : 6n);
    expect(w.gapOpen("X", 7n)).toBe(false); // 7 − 2 = 5 does not exceed the duration
    expect(w.gapOpen("X", 8n)).toBe(snapshotClock);
    expect(w.count("X", 6n)).toEqual({ count: 1n, fires: true, incumbent: "P", readable: true }); // C2b.5 reaches the drop under both
    w.tick(2n); // 8: X's gap is open only under D
    const { publishedDemand, release, out } = redeem(w, note, p, roots);
    witness(w, y.commit()); // Y@9
    w.tick(2n); witness(w, y.commit()); // Y@12
    expect(w.gapOpen("Y", 13n)).toBe(false);
    expect(w.closing("X", 13n)).toBe(snapshotClock ? 2n : 12n);
    expect(w.closing("X", 13n)).toBe(snapshotClock ? w.snapshot("X", 13n)!.at : 12n);
    const recovered = w.recoveryState("X", 13n);
    expect(recovered.force).toEqual(snapshotClock ? [publishedDemand, release] : []);
    expect(recovered.state.spent.has(note.nf)).toBe(snapshotClock);
    // The return: a segment carrying X again adopts the gap's block before serving.
    const next = w.open("P", ["X", "Y"]); witness(w, next.commit()); // 13
    expect(next.openings.get("X")).toBe(issued.id);
    expect(w.block(next.id, next.openings).map(a => a.witnessed)).toEqual(snapshotClock ? [publishedDemand, release] : []);
    expect(w.adoptGap(next)).toHaveLength(snapshotClock ? 2 : 0);
    witness(w, next.commit()); // 14
    expect(next.view().spent.has(note.nf)).toBe(snapshotClock);
    expect(next.view().outputs.has(out.cm)).toBe(snapshotClock);
    expect(w.gapOpen("X", 15n)).toBe(false);
    expect(w.closing("X", 15n)).toBe(14n);
    expect(w.recoveryViolations()).toEqual([]);
  });

  it.each(CLOCKS)("$name: fresh valid unrelated openings and a garbage carrying stream", ({ choices, snapshotClock }) => {
    const w = new FaultWorld(1n, choices);
    for (const b of ["X", "Y"]) { w.register(b, "P"); w.declare(b, { noCommitment: 5n }); }
    const x = w.open("P", ["X"]); witness(w, x.commit()); // X@1
    witness(w, w.open("P", ["Y"]).commit()); // Y@2
    const bad = badProof(w, x); // X@3, excluded: resets nothing under either clock
    expect(w.closing("X", 4n)).toBe(snapshotClock ? 1n : 2n);
    for (const at of [5n, 8n, 11n, 14n]) {
      w.tick(at - w.now - w.lag);
      witness(w, w.open("P", ["Y"]).commit());
      expect(w.closing("X", at + 1n)).toBe(snapshotClock ? 1n : at);
      expect(w.gapOpen("X", at + 1n)).toBe(snapshotClock ? at + 1n - 1n > 5n : false);
    }
    // The only other route under the operator-wide clock is the count and E's replacement rule.
    const reader = w.reader();
    reader.withheld.add(bad.id);
    expect(() => reader.snapshot("X", 15n)).toThrow("unresolved snapshot"); // a withheld carrying preimage is the residue under every intrinsic rule
    reader.withheld.delete(bad.id);
    expect(reader.snapshot("X", 15n)?.at).toBe(1n);
    expect(w.recoveryViolations()).toEqual([]);
  });

  it.each(CLOCKS)("$name: X's clock and the evidence of disjoint scopes Y and Z", ({ choices, snapshotClock }) => {
    const w = new FaultWorld(1n, choices);
    for (const b of ["X", "Y", "Z"]) { w.register(b, "P"); w.declare(b, { noCommitment: 5n }); }
    witness(w, w.open("P", ["X"]).commit()); // X@1
    const y = w.open("P", ["Y"]); witness(w, y.commit()); // Y@2
    w.tick();
    const z = w.open("P", ["Z"]); witness(w, z.commit()); // Z@4
    const fault = badProof(w, z); // bad Z@5
    w.tick(4n);
    witness(w, w.sign(z), "lapsed"); // Z@10: Z's own silence
    const yLater = w.sign(y); witness(w, yLater, "lapsed"); // Y@11: Y's own silence
    const reader = w.reader();
    expect(reader.closing("X", 12n)).toBe(snapshotClock ? 1n : 5n);
    reader.withheld.add(fault.id); // Z's fault evidence
    if (snapshotClock) expect(reader.closing("X", 12n)).toBe(1n);
    else expect(() => reader.closing("X", 12n)).toThrow("unresolved clock");
    reader.withheld.clear();
    reader.withheldScopes.add(yLater.id); // Y's scope preimage: needed only to lapse Y@11 for X's clock
    if (snapshotClock) expect(reader.closing("X", 12n)).toBe(1n);
    else expect(() => reader.closing("X", 12n)).toThrow("unresolved clock");
    reader.withheldScopes.clear();
    reader.withheldDirectories.add(yLater.id); // carriage must be authenticated under both
    expect(() => reader.closing("X", 12n)).toThrow("unresolved clock");
    reader.withheldDirectories.clear();
    expect(reader.gapOpen("X", 12n)).toBe(true);
    expect(w.recoveryViolations()).toEqual([]);
  });

  it.each(CLOCKS)("$name: the silence boundary retires the segment and lapses its tail; an unrelated opening closes nothing under D", ({ choices, snapshotClock }) => {
    const w = new FaultWorld(1n, choices);
    for (const b of ["X", "Y"]) { w.register(b, "P"); w.declare(b, { noCommitment: 5n }); }
    const p = w.open("P", ["X"]); witness(w, p.commit()); // X@1
    const { receipt: finalReceipt } = issue(w, p, "X"); const base = p.commit(); witness(w, base); // X@2
    const { receipt: tail } = issue(w, p, "X"); // unfinalized
    w.tick(6n); // 8: the boundary
    expect(w.classify(tail, p.scope)).toMatchObject({ status: "lapsed", lapse: "silence" });
    expect(w.classify(finalReceipt, p.scope).status).toBe("final");
    const y = p.change(["Y"]); witness(w, y.commit()); // Y@9
    expect(w.gapOpen("X", 10n)).toBe(snapshotClock);
    const twin = new Service(w, p.id, p.scope, p.openings, p.view()); twin.events.push(...p.events);
    witness(w, w.sign(twin), "lapsed"); // 10: retired under both
    expect(w.classify(tail, p.scope)).toMatchObject({ status: "lapsed", lapse: "silence" });
    expect(w.snapshot("X", 11n)?.checkpoint.id).toBe(base.id);
    expect(w.recoveryViolations()).toEqual([]);
  });
});

describe("R7′: the segment continues from its last valid checkpoint", () => {
  it.each(SEGMENTS)("$name: an honest process after its stale twin", ({ choices, continues }) => {
    const w = new FaultWorld(1n, choices);
    for (const b of ["X", "Y"]) { w.register(b, "P"); w.declare(b, CLAUSE); }
    const p = w.open("P", ["X", "Y"]); witness(w, p.commit()); // 1
    const first = issue(w, p, "X"); const base = p.commit(); witness(w, base); // 2
    const second = issue(w, p, "Y"); // the live tail
    const stale = new Service(w, p.id, p.scope, p.openings, p.view()); // a restarted twin that lost its book
    const twin = w.sign(stale); witness(w, twin, "invalid"); // 3
    expect(w.record(twin.id).reason).toBe("rewritten prefix");
    expect(w.classification(twin.id)).toBe("excluded");
    expect(w.closing("X", 4n)).toBe(2n); // an excluded carrying checkpoint resets nothing
    const continuation = p.commit(); witness(w, continuation, continues ? "final" : "invalid"); // 4
    if (continues) {
      expect(w.classification(continuation.id)).toBe("valid");
      expect(w.snapshot("X", 5n)?.checkpoint.id).toBe(continuation.id);
      expect(w.classify(second.receipt, p.scope).status).toBe("final");
      const third = issue(w, p, "X"); witness(w, p.commit()); // 5: the door stays open
      expect(w.classify(third.receipt, p.scope).status).toBe("final");
    } else {
      expect(w.record(continuation.id).reason).toBe("faulted segment");
      expect(w.classify(second.receipt, p.scope).status).toBe("pending");
      expect(() => issue(w, p, "X")).toThrow("faulted segment");
    }
    expect(w.classify(first.receipt, p.scope).status).toBe("final");
    expect(w.import(base.id).outputs.has(first.note.cm)).toBe(true);
    expect(w.recoveryViolations()).toEqual([]);
  });

  it.each(SEGMENTS)("$name: an authenticated bad proof, then the honest journal's valid continuation", ({ choices, continues }) => {
    const w = new FaultWorld(1n, choices);
    for (const b of ["X", "Y"]) { w.register(b, "P"); w.declare(b, CLAUSE); }
    const p = w.open("P", ["X", "Y"]); const opening = p.commit(); witness(w, opening); // 1
    const { receipt, note } = issue(w, p, "X");
    const hostile = new Service(w, p.id, p.scope, p.openings, p.view());
    hostile.events.push({ id: `${p.id}:0`, statement: Object.freeze({ ...p.events[0]!.statement }) }); // same statement, a proof that does not verify
    const bad = w.sign(hostile); witness(w, bad, "invalid"); // 2
    expect(w.record(bad.id).reason).toBe("proof");
    expect(w.classification(bad.id)).toBe("excluded");
    expect(w.classify(receipt, p.scope).status).toBe("pending"); // passed, neither included nor contradicted
    const continuation = p.commit(); witness(w, continuation, continues ? "final" : "invalid"); // 3
    expect(w.classify(receipt, p.scope).status).toBe(continues ? "final" : "pending");
    expect(w.closing("X", 3n)).toBe(1n);
    expect(w.closing("X", 4n)).toBe(continues ? 3n : 1n);
    expect(w.snapshot("X", 4n)?.checkpoint.id).toBe(continues ? continuation.id : opening.id); // the excluded pair is passed
    if (continues) expect(w.import(continuation.id).outputs.has(note.cm)).toBe(true);
    expect(w.count("X", 4n).readable).toBe(true);
    expect(w.recoveryViolations()).toEqual([]);
  });

  it("R7′: replacing the faulted statement in the continuation contradicts its receipt", () => {
    const w = new FaultWorld(1n, { faultContinuesSegment: true });
    for (const b of ["X", "Y"]) { w.register(b, "P"); w.declare(b, CLAUSE); }
    const p = w.open("P", ["X", "Y"]); witness(w, p.commit()); // 1
    const { receipt } = issue(w, p, "X");
    const hostile = new Service(w, p.id, p.scope, p.openings, p.view());
    hostile.events.push({ id: `${p.id}:0`, statement: Object.freeze({ ...p.events[0]!.statement }) });
    witness(w, w.sign(hostile), "invalid"); // 2: excluded
    const other = new Service(w, p.id, p.scope, p.openings, w.merge(p.openings));
    other.events.push({ id: `${p.id}:0`, statement: w.oracle.prove(p, "issue", [], [w.oracle.note("Y", 3n)], [], { backing: "Y", quantity: 3n }) });
    const replaced = w.sign(other); witness(w, replaced); // 3: valid, extends the opening's empty prefix with another statement at position 1
    expect(w.classify(receipt, p.scope)).toMatchObject({ status: "contradicted", included: false, contradicted: true });
    expect(w.recoveryViolations()).toEqual([]);
  });
});
