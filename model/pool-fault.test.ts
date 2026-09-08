// Candidate A of docs/POOL_FAULT_RECOVERY_PROPOSAL.md over model/pool-fault.ts:
// what intrinsic authenticated exclusion repairs, what it costs, and the
// counterexamples its rules 1, 3 and 5 exclude. Research evidence for a
// protocol choice that remains the maintainer's; nothing here is normative.
// Signatures and proofs are ideal tokens; "the bytes" a reader holds or lacks
// are the model's withheld sets, not a fault-certificate format.
import { describe, expect, it } from "vitest";
import { ProofOracle, Service, type Acceptance, type Binding, type Checkpoint, type Id, type Note, type Receipt, type World } from "./pool-authority.js";
import { FaultWorld, type FaultChoices, type FaultDepartures } from "./pool-fault.js";

const BACKINGS = ["X", "Y"] as const;
const CLAUSE = { noCommitment: 5n, nonService: { duration: 3n, count: 1n, window: 100n } };
type Roots = ReadonlyMap<Id, readonly Id[]>;
let serial = 0;

function witness(w: World, checkpoint: Checkpoint): void {
  if (w.now < checkpoint.signedAt + w.lag) w.tick(checkpoint.signedAt + w.lag - w.now);
  expect(w.include(checkpoint)).toBe("final");
}

/** Two backings in one scope; a payment finalized at 3 that every case must
 * preserve; one non-service request per backing, published at 3. */
function fixture(w = new FaultWorld(1n)) {
  for (const backing of BACKINGS) { w.register(backing, "P"); w.declare(backing, CLAUSE); }
  const p = w.open("P", BACKINGS);
  witness(w, p.commit()); // at 1
  const payer = w.oracle.note("X", 100n, "D", "payer");
  const other = w.oracle.note("Y", 80n, "D", "other-holder");
  for (const note of [payer, other]) p.submit(w.oracle.prove(p, "issue", [], [note], [], { backing: note.backing, quantity: note.value }));
  const issued = p.commit();
  witness(w, issued); // at 2
  const recipient = w.oracle.note("X", 40n, "D", "recipient");
  const change = w.oracle.note("X", 60n, "D", "payer");
  const paid = p.submit(w.oracle.prove(p, "spend", [payer, w.oracle.note("X", 0n)], [recipient, change], [p.root(), p.root()]));
  const base = p.commit();
  witness(w, base); // at 3
  for (const note of [recipient, other]) {
    w.publish({ kind: "request", backing: note.backing, statement: w.oracle.prove(ProofOracle.unbound(), "request", [note], [], [p.root()], { backing: note.backing, quantity: 0n }) });
  }
  return { w, p, payer, recipient, change, other, issued, base, paid };
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
  expect(f.w.classify(f.paid, f.p.scope).status).toBe("final");
}

/** The operator receipts one valid issuance, then signs a checkpoint whose
 * copy of that statement carries a proof that does not verify: the header,
 * every prior event and every public field are unchanged. World.sign is the
 * hostile operator's key, bypassing the honest door. */
function forge(f: Fixture, service: Service = f.p): { hostile: Service; receipt: Receipt } {
  const { w } = f;
  const backing = service.scope.entries[0]!.backing;
  const valid = w.oracle.prove(service, "issue", [], [w.oracle.note(backing, 1n)], [], { backing, quantity: 1n });
  const receipt = service.submit(valid);
  const statement = Object.freeze({ ...valid });
  expect(statement).toEqual(valid);
  expect(w.oracle.verify(statement, service.scope, service.view().roots, {})).toBe(false);
  const hostile = new Service(w, service.id, service.scope, service.openings, service.view());
  hostile.events.push(...service.events.slice(0, -1), { id: `${service.id}:${service.events.length - 1}`, statement });
  return { hostile, receipt };
}
function signAndInclude(f: Fixture, hostile: Service): { checkpoint: Checkpoint; status: string } {
  const checkpoint = f.w.sign(hostile);
  f.w.tick(f.w.lag);
  return { checkpoint, status: f.w.include(checkpoint) };
}

/** A demand, acceptance and release for one whole note, published now. */
function redeem(f: Fixture, note: Note, binding: Binding = f.p, roots: Roots = f.w.import(f.base.id).roots) {
  const { w } = f, presenter = `H${++serial}`;
  const inputs = [note, w.oracle.note(note.backing, 0n)];
  const anchor = [...roots].find(([, leaves]) => leaves.includes(note.cm))![0];
  const lit = { backing: note.backing, quantity: note.value, presenter };
  const demand = w.oracle.prove(binding, "demand", inputs, [], [anchor, anchor], { ...lit, instant: w.now - 1n, deadline: w.now + 20n });
  const acceptance: Acceptance = { demand: demand.id, owner: "backer-owner", deadline: w.now + 15n, signedByK: true };
  const out = w.oracle.note(note.backing, note.value, "D", acceptance.owner);
  const settle = w.oracle.prove(binding, "settle", inputs, [out], [anchor, anchor], { ...lit, owner: acceptance.owner, demand: demand.id, acceptance });
  w.publish({ kind: "demand", backing: note.backing, statement: demand });
  w.publish({ kind: "acceptance", backing: note.backing, acceptance });
  const release = w.publish({ kind: "release", backing: note.backing, statement: settle });
  return { demand, settle, out, release };
}
function issue(w: World, service: Service, backing: Id, quantity: bigint) {
  return w.oracle.prove(service, "issue", [], [w.oracle.note(backing, quantity)], [], { backing, quantity });
}

describe("candidate A, rules 1–2 and 4: exclusion on authenticated evidence", () => {
  it("passes an evidenced invalid checkpoint in the snapshot, the count and descent; the finalized payment and a successor's opening survive", () => {
    const f = fixture(), { w, base } = f;
    const { checkpoint: bad, status } = signAndInclude(f, forge(f).hostile); // at 4
    expect(status).toBe("invalid");
    expect(w.record(bad.id).reason).toBe("proof");
    expect(w.classification(bad.id)).toBe("excluded");
    w.tick(2n); // 6: the requests have aged past the duration
    for (const backing of BACKINGS) {
      expect(w.snapshot(backing, w.now)?.checkpoint.id).toBe(base.id);
      expect(w.count(backing, w.now)).toEqual({ count: 1n, fires: true, incumbent: "P", readable: true });
      expect(w.currentFor(backing, "P")).toBe(base.id);
      expect(w.latestFor(backing)).toBe(base.id);
    }
    expect(() => w.import(bad.id)).toThrow("not finalized");
    for (const backing of BACKINGS) w.replace(backing, "Q"); // effective at 9
    w.tick(3n);
    const q = w.open("Q", BACKINGS);
    for (const backing of BACKINGS) expect(q.openings.get(backing)).toBe(base.id);
    witness(w, q.commit());
    expect(q.view().spent.has(f.payer.nf)).toBe(true);
    assertFinalHoldings(f);
    expect(w.recoveryViolations()).toEqual([]);
  });

  it("without the bytes the checkpoint is unresolved: no read, no count, no descent and no rollback; evidence resolves it later, and until then a withheld preimage blocks a successor too", () => {
    const f = fixture(), { w, base } = f;
    const { checkpoint: bad } = signAndInclude(f, forge(f).hostile); // 4
    w.withheld.add(bad.id);
    w.tick(2n);
    expect(w.classification(bad.id)).toBe("unresolved");
    for (const backing of BACKINGS) {
      expect(() => w.snapshot(backing, w.now)).toThrow("unresolved snapshot");
      expect(() => w.recoveryState(backing, w.now)).toThrow("unresolved snapshot");
      expect(() => w.gapOpen(backing, w.now)).toThrow("unresolved clock");
      expect(w.count(backing, w.now)).toEqual({ count: 0n, fires: false, incumbent: "P", readable: false });
      expect(() => w.currentFor(backing, "P")).toThrow("unresolved checkpoint");
    }
    for (const backing of BACKINGS) w.replace(backing, "Q");
    w.tick(3n); // 9
    expect(() => w.open("Q", BACKINGS)).toThrow("unresolved checkpoint"); // the residue: no rule here resolves a preimage nobody serves
    assertFinalHoldings(f);
    w.withheld.delete(bad.id);
    expect(w.classification(bad.id)).toBe("excluded");
    for (const backing of BACKINGS) expect(w.snapshot(backing, w.now)?.checkpoint.id).toBe(base.id);
    expect(w.gapOpen("X", w.now)).toBe(true);
    witness(w, w.open("Q", BACKINGS).commit());
    expect(w.recoveryViolations()).toEqual([]);
  });

  it("an excluded checkpoint faults its segment: the door refuses, a continuation is excluded, repair is a new segment on the canonical state, and the tail's receipts read abandoned", () => {
    const f = fixture(), { w, p, base, issued } = f;
    const { hostile, receipt: tail } = forge(f);
    const { checkpoint: bad } = signAndInclude(f, hostile); // 4
    expect(() => p.submit(issue(w, p, "Y", 2n))).toThrow("faulted segment");
    const continued = p.commit(); w.tick(); // the honest tail, re-signed under the faulted segment: 5
    expect(w.include(continued)).toBe("invalid");
    expect(w.record(continued.id).reason).toBe("faulted segment");
    expect(w.classification(continued.id)).toBe("excluded");
    for (const parent of [bad.id, issued.id]) { // neither the excluded checkpoint nor an arbitrary older one
      expect(() => w.open("P", BACKINGS, "D", new Map(BACKINGS.map(b => [b, parent])))).toThrow("stale predecessor");
    }
    const next = w.open("P", BACKINGS);
    for (const backing of BACKINGS) expect(next.openings.get(backing)).toBe(base.id);
    witness(w, next.commit()); // 6: an empty opening at the next sequence, no hole
    expect(w.classify(tail, p.scope)).toMatchObject({ status: "abandoned", included: false, contradicted: false });
    next.submit(issue(w, next, "Y", 2n));
    witness(w, next.commit());
    assertFinalHoldings(f);
    expect(w.recoveryViolations()).toEqual([]);
  });
});

describe("candidate A: the clock, the gap and the return", () => {
  it("an excluded carrying commitment does not close the interval, so the gap opens from the last valid one and a release in it has force; under A′ it closes it and only the count remains", () => {
    const f = fixture(), { w, recipient } = f;
    signAndInclude(f, forge(f).hostile); // 4
    expect(w.gapOpen("X", 8n)).toBe(false);
    expect(w.gapOpen("X", 9n)).toBe(true);
    w.tick(5n); // 9
    const { release, out } = redeem(f, recipient);
    const { state, force } = w.recoveryState("X", 10n);
    expect(force.at(-1)).toBe(release);
    expect(state.spent.has(recipient.nf)).toBe(true);
    expect(state.outputs.has(out.cm)).toBe(true);
    expect(w.recoveryViolations()).toEqual([]);
    const g = fixture(new FaultWorld(1n, { excludedClosesInterval: true }));
    signAndInclude(g, forge(g).hostile); // 4
    expect(g.w.gapOpen("X", 9n)).toBe(false);
    expect(g.w.gapOpen("X", 10n)).toBe(true);
    expect(g.w.count("X", 7n)).toMatchObject({ fires: true, readable: true });
    g.w.tick(5n);
    redeem(g, g.recipient);
    expect(g.w.recoveryState("X", 10n).force).toEqual([]);
  });

  it("a stream of invalid commitments neither closes the gap nor blocks the count; the return is a new segment on the last valid state that adopts the gap's block first", () => {
    const f = fixture(), { w, base, recipient } = f;
    const { hostile } = forge(f);
    expect(signAndInclude(f, hostile).status).toBe("invalid"); // 4: proof
    w.tick(3n);
    const second = signAndInclude(f, hostile); // 8: faulted segment; the gap is still shut (8 − 3 = 5)
    expect(second.status).toBe("invalid");
    expect(w.record(second.checkpoint.id).reason).toBe("faulted segment");
    expect(w.classification(second.checkpoint.id)).toBe("excluded");
    expect(w.gapOpen("X", 9n)).toBe(true);
    w.tick(2n); // 10
    const { release } = redeem(f, recipient);
    expect(w.recoveryState("X", 11n).force.at(-1)).toBe(release);
    expect(w.count("X", 11n)).toMatchObject({ fires: true, readable: true });
    for (let i = 0; i < 2; i++) { // 11 and 15: non-opening checkpoints in the open gap lapse (C2b.4.1)
      expect(signAndInclude(f, hostile).status).toBe("lapsed");
      w.tick(3n);
    }
    const next = w.open("P", BACKINGS); // 18
    for (const backing of BACKINGS) expect(next.openings.get(backing)).toBe(base.id);
    witness(w, next.commit()); // 19
    expect(w.gapOpen("X", 20n)).toBe(false);
    expect(() => next.submit(issue(w, next, "X", 5n))).toThrow("adopt the gap first");
    const receipts = w.adoptGap(next);
    expect(receipts.map(r => r.position)).toEqual([1n, 2n]);
    expect(next.view().spent.has(recipient.nf)).toBe(true);
    witness(w, next.commit());
    assertFinalHoldings(f);
    expect(w.recoveryViolations()).toEqual([]);
  });

  it("a settled note stays settled across a second silence when the checkpoint adopting the first gap's block is excluded", () => {
    const f = fixture(), { w, recipient } = f;
    signAndInclude(f, forge(f).hostile); // 4
    w.tick(5n); // 9
    const first = redeem(f, recipient);
    w.tick(); // 10
    const next = w.open("P", BACKINGS);
    const opening = next.commit(); witness(w, opening); // 11
    expect(w.adoptGap(next).length).toBe(2);
    const { checkpoint: bad } = signAndInclude(f, forge(f, next).hostile); // 12: the adopting checkpoint carries a forged proof
    expect(w.classification(bad.id)).toBe("excluded");
    expect(w.snapshot("X", 13n)?.checkpoint.id).toBe(opening.id);
    const recovered = w.recoveryState("X", 13n);
    expect(recovered.force.at(-1)).toBe(first.release); // the adoption index reaches back through the opening
    expect(recovered.state.spent.has(recipient.nf)).toBe(true);
    expect(w.gapOpen("X", 16n)).toBe(false);
    expect(w.gapOpen("X", 17n)).toBe(true); // 11 + 5
    w.tick(5n); // 17
    const again = redeem(f, recipient, next, w.import(opening.id).roots);
    expect(w.recoveryState("X", 18n).force.includes(again.release)).toBe(false);
    w.tick(); // 18
    const back = w.open("P", BACKINGS);
    for (const backing of BACKINGS) expect(back.openings.get(backing)).toBe(opening.id);
    witness(w, back.commit()); // 19
    expect(w.adoptGap(back).map(r => r.statement)).toEqual([first.demand.id, first.settle.id]);
    witness(w, back.commit());
    assertFinalHoldings(f);
    expect(w.recoveryViolations()).toEqual([]);
  });
});

describe("candidate A: what the rules exclude, and what the variants cost", () => {
  it("rules 3 and 5: an unresolved dependency yields no verdict, and evidence resolves it without reversing anything; the departure reads no gap first and a gap afterwards", () => {
    for (const faults of [{}, { unresolvedIsValid: true }] as FaultDepartures[]) {
      const f = fixture(new FaultWorld(1n, {}, faults)), { w, recipient } = f;
      const { checkpoint: bad } = signAndInclude(f, forge(f).hostile); // 4
      w.tick(5n); // 9: the gap is open
      const { release } = redeem(f, recipient);
      w.tick(); // 10
      const next = w.open("P", BACKINGS);
      const opening = next.commit(); witness(w, opening); // 11
      const omit = new Service(w, next.id, next.scope, next.openings, next.view());
      omit.events.push({ id: `${next.id}:0`, statement: issue(w, next, "X", 5n) });
      const child = w.sign(omit); w.tick();
      expect(w.include(child)).toBe("invalid"); // 12: the block was omitted
      expect(w.record(child.id).reason).toBe("adopted block");
      w.withheld.add(bad.id); // a reader without the excluded checkpoint's bytes
      if (faults.unresolvedIsValid) {
        expect(w.gapOpen("X", 9n)).toBe(false); // read as a reset: no gap, so no force, so the child looks right
        // Replaying instead of trusting the old verdict now calls the repair
        // stale against the checkpoint this departure wrongly treats as valid.
        expect(w.classification(opening.id)).toBe("excluded");
      } else {
        expect(() => w.gapOpen("X", 9n)).toThrow("unresolved clock");
        expect(() => w.recoveryState("X", 10n)).toThrow("unresolved snapshot");
        expect(w.classification(opening.id)).toBe("unresolved");
        expect(w.classification(child.id)).toBe("unresolved");
      }
      w.withheld.delete(bad.id);
      expect(w.gapOpen("X", 9n)).toBe(true); // the departure's verdict is reversed; the candidate never gave one
      expect(w.recoveryState("X", 10n).force.at(-1)).toBe(release);
      expect(w.classification(opening.id)).toBe("valid");
      expect(w.classification(child.id)).toBe("excluded");
    }
  });

  it("rule 1: a valid checkpoint the reader cannot obtain is unresolved, not excluded; the departure rolls a finalized spend back and settles the spent note", () => {
    for (const faults of [{}, { unresolvedIsExcluded: true }] as FaultDepartures[]) {
      const f = fixture(new FaultWorld(1n, {}, faults)), { w, p, other, base } = f;
      const paid = w.oracle.note("Y", 50n, "D", "someone"), rest = w.oracle.note("Y", 30n, "D", "other-holder");
      p.submit(w.oracle.prove(p, "spend", [other, w.oracle.note("Y", 0n)], [paid, rest], [p.root(), p.root()]));
      const c4 = p.commit(); witness(w, c4); // 4: `other` is spent, finally
      w.withheld.add(c4.id);
      w.tick(5n); // 9
      if (faults.unresolvedIsExcluded) {
        expect(w.snapshot("Y", 9n)?.checkpoint.id).toBe(base.id); // rolled back to where `other` is unspent
        expect(w.gapOpen("Y", 9n)).toBe(true);
        redeem(f, other);
        expect(w.recoveryState("Y", 10n).force.length).toBe(2);
        expect(w.recoveryViolations()).toContain("settled note spent again");
      } else {
        expect(() => w.snapshot("Y", 9n)).toThrow("unresolved snapshot");
        expect(() => w.gapOpen("Y", 9n)).toThrow("unresolved clock");
        redeem(f, other);
        expect(() => w.recoveryState("Y", 10n)).toThrow("unresolved snapshot");
        expect(w.recoveryViolations()).toEqual([]);
        w.withheld.delete(c4.id);
        expect(w.recoveryState("Y", 10n).force).toEqual([]); // the gap was never open: 4 closed it
      }
      // A fresh read needs the evidence again; the earlier witnessed spend
      // has not been removed from the record by the departure's verdict.
      w.withheld.delete(c4.id);
      expect(w.record(c4.id).status).toBe("final");
    }
  });

  it("a non-carrying commitment with resolved lapse resets X without its event history; the stricter clock requires that history", () => {
    for (const choices of [{}, { classifyNonCarrying: true }] as FaultChoices[]) {
      const f = fixture(new FaultWorld(1n, choices)), { w, p, base, recipient } = f;
      const y = p.change(["Y"]); witness(w, y.commit()); // 4: P drops X and keeps committing for Y
      expect(w.count("X", 6n)).toMatchObject({ count: 1n, fires: true, incumbent: "P", readable: true }); // X's remedy is the non-service grade
      w.tick(3n); // 7
      const { checkpoint: bad, status } = signAndInclude(f, forge(f, y).hostile); // 8: invalid, carrying Y only
      expect(status).toBe("invalid");
      expect(bad.carries).toEqual(["Y"]);
      if (choices.classifyNonCarrying) {
        expect(w.gapOpen("X", 9n)).toBe(false); // 4 closed it
        expect(w.gapOpen("X", 10n)).toBe(true);
        w.withheld.add(bad.id);
        expect(() => w.gapOpen("X", 10n)).toThrow("unresolved clock"); // X's clock needs Y's history
        w.withheld.delete(bad.id);
      } else {
        expect(w.gapOpen("X", 13n)).toBe(false); // 8 closed it
        expect(w.gapOpen("X", 14n)).toBe(true);
        w.withheld.add(bad.id);
        expect(w.gapOpen("X", 14n)).toBe(true);
        w.withheld.delete(bad.id);
      }
      expect(w.snapshot("X", 14n)?.checkpoint.id).toBe(base.id);
      w.tick(3n); // 11
      const { release } = redeem(f, recipient);
      expect(w.recoveryState("X", 12n).force.includes(release)).toBe(choices.classifyNonCarrying === true);
      expect(w.recoveryViolations()).toEqual([]);
      // A valid Y-only commitment resets X's clock under either reading.
      const g = fixture(new FaultWorld(1n, choices)), gy = g.p.change(["Y"]);
      witness(g.w, gy.commit()); // 4
      g.w.tick(3n);
      gy.submit(issue(g.w, gy, "Y", 1n));
      witness(g.w, gy.commit()); // 8, valid
      expect(g.w.gapOpen("X", 13n)).toBe(false);
      expect(g.w.gapOpen("X", 14n)).toBe(true);
    }
  });
});
