// C2b.3a/3c's approved snapshot boundary, using the existing authority model.
// This observes note inclusion in canonical finalized state, not redemption
// eligibility: silence, ownership proofs, consent, recovery settlements and
// their venue ordering are deliberately NOT implemented by this test model.
// ProofOracle's immutable notes stand in for authenticated note openings.
import { describe, expect, it } from "vitest";
import { ProofOracle, Service, World, tagOf, type Acceptance, type Binding, type Checkpoint, type Departures, type Id, type Note, type Statement } from "./pool-authority.js";
import { RecoveryWorld, type RecoveryDepartures } from "./pool-recovery.js";

function witness(w: World, checkpoint: Checkpoint): void {
  if (w.now < checkpoint.signedAt + w.lag) w.tick(checkpoint.signedAt + w.lag - w.now);
  expect(w.include(checkpoint)).toBe("final");
}

function fixture(values = [100n]) {
  const w = new World(1n);
  w.register("X", "P");
  const service = w.open("P", ["X"]);
  witness(w, service.commit());
  const notes = values.map(value => {
    const note = w.oracle.note("X", value);
    service.submit(w.oracle.prove(service, "issue", [], [note], [], { backing: "X", quantity: value }));
    return note;
  });
  const base = service.commit();
  witness(w, base);
  return { w, service, notes, base };
}

function spend(w: World, service: Service, inputs: Note[], values: bigint[]) {
  const padded = inputs.length === 1 ? [...inputs, w.oracle.note("X", 0n)] : inputs;
  const roots = service.view().roots;
  const anchors = padded.map(note => {
    if (note.value === 0n) return service.root();
    const found = [...roots].find(([, leaves]) => leaves.includes(note.cm));
    if (!found) throw new Error("fixture has no input anchor");
    return found[0];
  });
  const outputs = values.map(value => w.oracle.note("X", value));
  const statement = w.oracle.prove(service, "spend", padded, outputs, anchors);
  return { statement, outputs };
}

function snapshot(w: World) {
  const id = w.currentFor("X", w.term("X").operator);
  if (id === null) throw new Error("no finalized snapshot");
  return w.import(id);
}

function includedUnspent(w: World, note: Note): boolean {
  const state = snapshot(w);
  return w.oracle.opening(note.cm) === note && note.domain === "D" && note.backing === "X" &&
    note.value > 0n && state.outputs.has(note.cm) && !state.spent.has(note.nf);
}

function quantities(w: World): bigint[] {
  return [...snapshot(w).outputs].map(cm => w.oracle.opening(cm))
    .filter(note => includedUnspent(w, note)).map(note => note.value);
}

describe("C2b.3a/3c: shielded recovery does not promote the unwitnessed tail", () => {
  it("keeps the snapshot's 100 despite a receipted split into payment 40 and change 60", () => {
    const { w, service, notes, base } = fixture();
    const pay = spend(w, service, notes, [40n, 60n]);
    const receipt = service.submit(pay.statement);
    service.commit(); // Signed but not witnessed: no new snapshot holding.
    expect(w.classify(receipt, service.scope).status).toBe("pending");
    expect(w.latestFor("X")).toBe(base.id);
    expect(quantities(w)).toEqual([100n]);
    for (const output of pay.outputs) expect(includedUnspent(w, output)).toBe(false);
    expect(service.view().spent.has(notes[0]!.nf)).toBe(true);
    expect(includedUnspent(w, notes[0]!)).toBe(true);
  });

  it("recognizes both finalized split outputs and refuses the consumed 100", () => {
    const { w, service, notes } = fixture();
    const pay = spend(w, service, notes, [40n, 60n]);
    const receipt = service.submit(pay.statement);
    witness(w, service.commit());
    expect(w.classify(receipt, service.scope).status).toBe("final");
    expect(quantities(w)).toEqual([40n, 60n]);
    expect(includedUnspent(w, notes[0]!)).toBe(false);
    expect(quantities(w).reduce((sum, value) => sum + value, 0n)).toBe(100n);
  });

  it("does not assign a merged 110 output to either snapshot input of 100 and 80", () => {
    const { w, service, notes } = fixture([100n, 80n]);
    const pay = spend(w, service, notes, [110n, 70n]);
    service.submit(pay.statement);
    expect(quantities(w)).toEqual([100n, 80n]);
    for (const output of pay.outputs) expect(includedUnspent(w, output)).toBe(false);
    witness(w, service.commit());
    expect(quantities(w)).toEqual([110n, 70n]);
    for (const input of notes) expect(includedUnspent(w, input)).toBe(false);
  });

  it("does not recover descendants of an unwitnessed payment from its receipt chain", () => {
    const { w, service, notes } = fixture();
    const first = spend(w, service, notes, [40n, 60n]);
    service.submit(first.statement);
    const next = spend(w, service, [first.outputs[0]!], [30n, 10n]);
    const receipt = service.submit(next.statement);
    expect(w.classify(receipt, service.scope).status).toBe("pending");
    expect(quantities(w)).toEqual([100n]);
    for (const note of [...first.outputs, ...next.outputs]) expect(includedUnspent(w, note)).toBe(false);
  });

  it("does not let proof validity choose between conflicting unwitnessed recipients", () => {
    const { w, service, notes } = fixture();
    const first = spend(w, service, notes, [40n, 60n]);
    const second = spend(w, service, notes, [70n, 30n]);
    for (const payment of [first, second]) {
      expect(w.oracle.verify(payment.statement, service.scope, service.view().roots, {})).toBe(true);
    }
    service.submit(first.statement);
    expect(() => service.submit(second.statement)).toThrow("spent conflict");
    expect(quantities(w)).toEqual([100n]);
    for (const note of [...first.outputs, ...second.outputs]) expect(includedUnspent(w, note)).toBe(false);
  });

  it("does not mistake arbitrary nullifier absence, forged openings or zero outputs for positive holdings", () => {
    const { w, service, notes } = fixture();
    const absent = w.oracle.note("X", 100n);
    expect(snapshot(w).spent.has(absent.nf)).toBe(false);
    expect(includedUnspent(w, absent)).toBe(false);
    expect(includedUnspent(w, { ...notes[0]!, nf: absent.nf })).toBe(false);
    const pay = spend(w, service, notes, [100n, 0n]);
    service.submit(pay.statement);
    witness(w, service.commit());
    expect(snapshot(w).outputs.has(pay.outputs[1]!.cm)).toBe(true);
    expect(includedUnspent(w, pay.outputs[1]!)).toBe(false);
    expect(quantities(w)).toEqual([100n]);
  });

  it("refuses unavailable latest history instead of restoring the prior payer holding", () => {
    const { w, service, notes } = fixture();
    service.submit(spend(w, service, notes, [40n, 60n]).statement);
    const latest = service.commit();
    witness(w, latest);
    w.withheld.add(latest.id);
    expect(() => includedUnspent(w, notes[0]!)).toThrow("unavailable history");
  });

  it("preserves final inclusion after replacement while a late unfinalized tail lapses", () => {
    const { w, service, notes } = fixture();
    const first = spend(w, service, notes, [40n, 60n]);
    const finalReceipt = service.submit(first.statement);
    witness(w, service.commit());
    const next = spend(w, service, [first.outputs[0]!], [30n, 10n]);
    const pendingReceipt = service.submit(next.statement);
    const late = service.commit();
    w.replace("X", "Q");
    w.tick(3n);
    expect(w.include(late)).toBe("lapsed");
    expect(w.classify(finalReceipt, service.scope).status).toBe("final");
    expect(w.classify(pendingReceipt, service.scope).status).toBe("lapsed");
    expect(quantities(w)).toEqual([40n, 60n]);
    for (const note of next.outputs) expect(includedUnspent(w, note)).toBe(false);
  });
});

// pool-recovery.md over the same ideal cryptography: C3.7–8 at the door,
// C2b.5.2's count, C2b.6.1's clock, C2b.3.1–3 at the venue, C2b.4.1–2's return.
const CLAUSE = { noCommitment: 5n, nonService: { duration: 3n, count: 2n, window: 20n } };

function silence(recovery: RecoveryDepartures = {}, departures: Departures = {}) {
  const w = new RecoveryWorld(1n, recovery, departures);
  w.register("X", "P"); w.declare("X", CLAUSE);
  const p = w.open("P", ["X"]);
  witness(w, p.commit());
  const note = w.oracle.note("X", 100n, "D", "holder");
  p.submit(w.oracle.prove(p, "issue", [], [note], [], { backing: "X", quantity: 100n }));
  const base = p.commit(); witness(w, base); // witnessed at 2: the gap opens at 8
  return { w, p, note, base };
}
interface Silence { readonly w: RecoveryWorld; readonly p: Service; readonly note: Note; readonly base: Checkpoint }
/** Two backings in one scope, one note of X, both declaring the clause. */
function shared(recovery: RecoveryDepartures = {}): Silence {
  const w = new RecoveryWorld(1n, recovery);
  w.register("X", "P"); w.register("Y", "P"); w.declare("X", CLAUSE); w.declare("Y", CLAUSE);
  const p = w.open("P", ["X", "Y"]);
  witness(w, p.commit());
  const note = w.oracle.note("X", 100n, "D", "holder");
  p.submit(w.oracle.prove(p, "issue", [], [note], [], { backing: "X", quantity: 100n }));
  const base = p.commit(); witness(w, base);
  return { w, p, note, base };
}
type Roots = ReadonlyMap<Id, readonly Id[]>;
function anchorIn(roots: Roots, note: Note): Id {
  const found = [...roots].find(([, leaves]) => leaves.includes(note.cm));
  if (!found) throw new Error("fixture has no anchor");
  return found[0];
}
function padded(w: World, roots: Roots, notes: readonly Note[]): { inputs: Note[]; anchors: Id[] } {
  const inputs = notes.length === 1 ? [...notes, w.oracle.note(notes[0]!.backing, 0n)] : [...notes];
  return { inputs, anchors: inputs.map(n => anchorIn(roots, n.value === 0n ? notes[0]! : n)) };
}
function demandFor(w: World, binding: Binding, roots: Roots, notes: readonly Note[], terms: { presenter?: Id; deadline?: bigint; instant?: bigint } = {}): Statement {
  const { inputs, anchors } = padded(w, roots, notes);
  return w.oracle.prove(binding, "demand", inputs, [], anchors, { backing: notes[0]!.backing,
    quantity: notes.reduce((sum, n) => sum + n.value, 0n), presenter: terms.presenter ?? "H", instant: terms.instant ?? w.now - 1n, deadline: terms.deadline ?? 30n });
}
function acceptanceOf(demand: Statement, owner = "backer-owner", deadline = 25n, signedByK = true): Acceptance {
  return { demand: demand.id, owner, deadline, signedByK };
}
function settleFor(w: World, binding: Binding, roots: Roots, notes: readonly Note[], demand: Statement, acceptance: Acceptance, presenter = "H") {
  const { inputs, anchors } = padded(w, roots, notes);
  const quantity = demand.lit!.quantity;
  const out = w.oracle.note(notes[0]!.backing, quantity, "D", acceptance.owner);
  return { out, statement: w.oracle.prove(binding, "settle", inputs, [out], anchors,
    { backing: notes[0]!.backing, quantity, owner: acceptance.owner, demand: demand.id, acceptance, presenter }) };
}
function withdrawFor(w: World, binding: Binding, demand: Statement, presenter = "H"): Statement {
  return w.oracle.prove(binding, "withdraw", [], [], [], { backing: demand.lit!.backing, quantity: 0n, demand: demand.id, presenter });
}
function requestFor(w: World, roots: Roots, note: Note): Statement {
  return w.oracle.prove(ProofOracle.unbound(), "request", [note], [], [anchorIn(roots, note)], { backing: note.backing, quantity: 0n });
}
/** Demand, acceptance and release published at the present index, bound to the given segment. */
function redeem(f: Silence, binding: Binding = f.p, roots: Roots = f.p.view().roots, note = f.note, presenter = "H", acceptanceDeadline = 25n) {
  const demand = demandFor(f.w, binding, roots, [note], { presenter });
  const acceptance = acceptanceOf(demand, "backer-owner", acceptanceDeadline);
  const settled = settleFor(f.w, binding, roots, [note], demand, acceptance, presenter);
  f.w.publish({ kind: "demand", backing: "X", statement: demand });
  f.w.publish({ kind: "acceptance", backing: "X", acceptance });
  const release = f.w.publish({ kind: "release", backing: "X", statement: settled.statement });
  return { demand, acceptance, settled, release };
}
function forged(kind: Statement["kind"], segment: Id, scope: Id, lit: NonNullable<Statement["lit"]>): Statement {
  return { id: `forged:${kind}:${segment}`, segment, scope, domain: "D", anchors: [], nullifiers: [], outputs: [], kind, lit };
}
/** A return: a new segment whose opening the record witnesses, closing the gap. */
function comeBack(f: Silence, operator = "P", names: readonly Id[] = ["X"]) {
  const next = f.w.open(operator, names);
  const opening = next.commit();
  witness(f.w, opening);
  return { next, opening };
}

describe("C3.7–C3.8: presentation under service", () => {
  it("a demand locks its notes, a locked note cannot be spent or demanded again, and a withdrawal frees it", () => {
    const { w, p, note } = silence();
    const demand = demandFor(w, p, p.view().roots, [note]);
    p.submit(demand);
    expect(p.view().locks.get(tagOf(note.nf))).toBe(demand.id);
    const pay = spend(w, p, [note], [40n, 60n]);
    expect(() => p.submit(pay.statement)).toThrow("locked");
    expect(() => p.submit(demandFor(w, p, p.view().roots, [note], { presenter: "H2" }))).toThrow("tag locked or spent");
    const held = p.commit(); witness(w, held);
    expect(w.record(held.id).state!.locks.has(tagOf(note.nf))).toBe(true);
    p.submit(withdrawFor(w, p, demand));
    expect(p.view().locks.size).toBe(0);
    p.submit(pay.statement);
    witness(w, p.commit());
    expect(w.recoveryViolations()).toEqual([]);
  });
  it("settles the demanded notes, whole, to the backer's owner value on acceptance and release, once", () => {
    const { w, p, note } = silence();
    const demand = demandFor(w, p, p.view().roots, [note]);
    p.submit(demand);
    const acceptance = acceptanceOf(demand);
    const { out, statement } = settleFor(w, p, p.view().roots, [note], demand, acceptance);
    const receipt = p.submit(statement);
    expect(p.submit(statement)).toBe(receipt);
    const state = p.view();
    expect(state.spent.has(note.nf)).toBe(true);
    expect(state.outputs.has(out.cm)).toBe(true);
    expect(state.standing.size).toBe(0);
    expect(state.locks.size).toBe(0);
    expect(state.totals.get("X")).toBe(100n);
    expect(w.oracle.opening(out.cm).owner).toBe(acceptance.owner);
    witness(w, p.commit());
    expect(w.recoveryViolations()).toEqual([]);
  });
  it("refuses a settlement of a demand not standing, by another presenter, without K, past the demand's deadline or over other notes", () => {
    const { w, p, note } = silence();
    const roots = p.view().roots;
    const demand = demandFor(w, p, roots, [note]);
    const acceptance = acceptanceOf(demand);
    expect(() => p.submit(settleFor(w, p, roots, [note], demand, acceptance).statement)).toThrow("demand not standing");
    p.submit(demand);
    expect(() => p.submit(settleFor(w, p, roots, [note], demand, acceptance, "H2").statement)).toThrow("settlement terms");
    expect(() => p.submit(settleFor(w, p, roots, [note], demand, acceptanceOf(demand, "backer-owner", 25n, false)).statement)).toThrow("acceptance");
    expect(() => p.submit(settleFor(w, p, roots, [note], demand, acceptanceOf(demand, "backer-owner", 31n)).statement)).toThrow("acceptance");
    const other = w.oracle.note("X", 100n, "D", "holder");
    p.submit(w.oracle.prove(p, "issue", [], [other], [], { backing: "X", quantity: 100n }));
    expect(() => p.submit(settleFor(w, p, p.view().roots, [other], demand, acceptance).statement)).toThrow("settlement tags");
    p.submit(settleFor(w, p, roots, [note], demand, acceptance).statement);
    witness(w, p.commit());
    expect(w.recoveryViolations()).toEqual([]);
  });
  it("reads deadlines where the act would first be witnessed: a demand not strictly ahead and an expired acceptance are refused", () => {
    const { w, p, note } = silence();
    const roots = p.view().roots;
    expect(() => p.submit(demandFor(w, p, roots, [note], { deadline: w.now + w.lag }))).toThrow("deadline not ahead");
    const demand = demandFor(w, p, roots, [note], { deadline: w.now + w.lag + 1n });
    p.submit(demand);
    expect(() => p.submit(settleFor(w, p, roots, [note], demand, acceptanceOf(demand, "backer-owner", w.now + w.lag - 1n)).statement)).toThrow("acceptance expired");
    p.submit(settleFor(w, p, roots, [note], demand, acceptanceOf(demand, "backer-owner", w.now + w.lag)).statement);
    witness(w, p.commit());
    expect(w.recoveryViolations()).toEqual([]);
  });
  it("carries standing demands and locks into an elective new segment, where a re-proved settlement discharges them", () => {
    const { w, p, note } = silence();
    const demand = demandFor(w, p, p.view().roots, [note]);
    p.submit(demand);
    witness(w, p.commit());
    const next = p.change(["X"]);
    witness(w, next.commit());
    expect(next.view().standing.has(demand.id)).toBe(true);
    expect(() => next.submit(spend(w, next, [note], [40n, 60n]).statement)).toThrow("locked");
    next.submit(settleFor(w, next, next.view().roots, [note], demand, acceptanceOf(demand)).statement);
    expect(next.view().standing.size).toBe(0);
    witness(w, next.commit());
    expect(w.recoveryViolations()).toEqual([]);
  });
  it("counterexample: a settlement without K's acceptance pays whomever the holder names", () => {
    const { w, p, note } = silence({}, { ignoreAcceptance: true });
    const demand = demandFor(w, p, p.view().roots, [note]);
    p.submit(demand);
    p.submit(settleFor(w, p, p.view().roots, [note], demand, acceptanceOf(demand, "holder-again", 25n, false)).statement);
    witness(w, p.commit());
    expect(w.recoveryViolations()).toContain("settlement not to the backer");
  });
});

describe("C2b.5.1–2: the non-service request and count", () => {
  function requests(f: Silence) {
    const other = f.w.oracle.note("X", 50n, "D", "holder");
    f.p.submit(f.w.oracle.prove(f.p, "issue", [], [other], [], { backing: "X", quantity: 50n }));
    witness(f.w, f.p.commit()); // at 3
    const roots = f.p.view().roots;
    f.w.publish({ kind: "request", backing: "X", statement: requestFor(f.w, roots, f.note) });
    f.w.publish({ kind: "request", backing: "X", statement: requestFor(f.w, roots, other) });
    return other;
  }
  it("fires on m distinct proven requests unserved past the duration, names the incumbent, and stops when served or aged out", () => {
    const f = silence(), { w, p, note } = f;
    requests(f);
    expect(w.count("X", 3n)).toMatchObject({ count: 0n, fires: false });
    w.tick(3n);
    expect(w.count("X", 6n)).toMatchObject({ count: 2n, fires: true, incumbent: "P" });
    p.submit(spend(w, p, [note], [40n, 60n]).statement);
    witness(w, p.commit());
    expect(w.count("X", w.now)).toMatchObject({ count: 2n, fires: true }); // the checkpoint at t is not strictly before t
    expect(w.count("X", w.now + 1n)).toMatchObject({ count: 1n, fires: false });
    w.tick(17n);
    expect(w.count("X", w.now)).toMatchObject({ count: 0n, fires: false });
  });
  it("counts a tag once, a locked note as served, and an unproven request only under the departure", () => {
    const f = silence(), { w, p, note } = f;
    requests(f);
    w.publish({ kind: "request", backing: "X", statement: requestFor(w, p.view().roots, note) });
    const fake = forged("request", "", "", { backing: "X", quantity: 0n, tag: "tag:unknown" });
    w.publish({ kind: "request", backing: "X", statement: fake });
    w.tick(3n);
    expect(w.count("X", 6n).count).toBe(2n);
    p.submit(demandFor(w, p, p.view().roots, [note]));
    witness(w, p.commit());
    expect(w.count("X", w.now + 1n).count).toBe(1n);
    const g = silence({ countUnproven: true });
    requests(g);
    g.w.publish({ kind: "request", backing: "X", statement: fake });
    g.w.tick(3n);
    expect(g.w.count("X", 6n).count).toBe(3n);
  });
  it("a handover neither resets nor moves the count; the successor clears it by serving, and the departure resets it", () => {
    const f = silence(), { w, note } = f;
    requests(f);
    w.replace("X", "Q"); // effective at 6
    w.tick(3n);
    const q = w.open("Q", ["X"]);
    witness(w, q.commit()); // at 7, before the gap
    expect(w.count("X", 7n)).toMatchObject({ count: 2n, fires: true, incumbent: "Q" });
    q.submit(spend(w, q, [note], [40n, 60n]).statement);
    witness(w, q.commit());
    expect(w.count("X", w.now + 1n)).toMatchObject({ count: 1n, fires: false, incumbent: "Q" });
    const g = silence({ resetOnHandover: true });
    requests(g);
    g.w.replace("X", "Q"); g.w.tick(3n);
    expect(g.w.count("X", 7n)).toMatchObject({ count: 0n, fires: false, incumbent: "Q" });
  });
});

describe("C2b.6.1 and C2b.3.1: the no-commitment clock and the snapshot", () => {
  it("opens after the declared duration from the last commitment by the party in force, and any commitment of that party closes it, carrying or not", () => {
    const { w, p } = silence();
    expect(w.gapOpen("X", 7n)).toBe(false);
    expect(w.gapOpen("X", 8n)).toBe(true);
    w.register("Y", "P");
    expect(p.finalized()).toBe(true);
    const y = w.open("P", ["Y"]);
    witness(w, y.commit()); // at 3, carrying nothing for X
    expect(w.gapOpen("X", 8n)).toBe(false);
    expect(w.gapOpen("X", 9n)).toBe(true);
    expect(w.count("X", 8n).incumbent).toBe("P");
  });
  it("a checkpoint continued through the gap lapses for its scope and closes nothing; the departure lets it close the interval", () => {
    const { w, p } = silence();
    w.tick(6n);
    const late = p.commit(); w.tick();
    expect(w.include(late)).toBe("lapsed");
    expect(w.gapOpen("X", 10n)).toBe(true);
    const g = silence({ lapsedClosesGap: true });
    g.w.tick(6n);
    const closed = g.p.commit(); g.w.tick();
    expect(g.w.include(closed)).toBe("lapsed");
    expect(g.w.gapOpen("X", 10n)).toBe(false);
  });
  it("the snapshot is the backing's last carrying canonical checkpoint, passing lapses, surviving an heir that has not committed, and blocked by invalid live evidence", () => {
    const { w, p, base } = silence();
    w.tick(6n);
    const late = p.commit(); w.tick();
    expect(w.include(late)).toBe("lapsed");
    expect(w.snapshot("X", 10n)?.checkpoint).toBe(base);
    w.replace("X", "Q");
    w.tick(5n);
    expect(w.snapshot("X", w.now)?.checkpoint).toBe(base);
    expect(w.gapOpen("X", w.now)).toBe(true);
    const g = silence();
    const hostile = new Service(g.w, g.p.id, g.p.scope, g.p.openings, g.p.view());
    hostile.events.push(...g.p.events, { id: `${g.p.id}:${g.p.events.length}`, statement: forged("issue", g.p.id, g.p.scope.root, { backing: "X", quantity: 1n }) });
    const bad = g.w.sign(hostile); g.w.tick();
    expect(g.w.include(bad)).toBe("invalid");
    g.w.tick(6n);
    expect(() => g.w.recoveryState("X", g.w.now)).toThrow("invalid snapshot");
    expect(g.w.count("X", g.w.now).readable).toBe(false);
  });
});

describe("C2b.3.2–3: publications and their force at the venue", () => {
  it("a demand, acceptance and release in the gap settle the snapshot holding to the backer; before the gap they have no force at their index", () => {
    const f = silence(), { w, note } = f;
    const early = redeem(f);
    w.tick(6n);
    expect(w.recoveryState("X", 9n).force).toEqual([]);
    w.publish({ kind: "release", backing: "X", statement: early.settled.statement }); // the same bytes again: still no force, its demand is dated
    expect(w.recoveryState("X", 9n).force).toEqual([]);
    const late = redeem(f); // a fresh demand, its instant inside C3.3's window at 8
    expect(late.demand).not.toBe(early.demand);
    w.publish({ kind: "release", backing: "X", statement: late.settled.statement }); // a duplicate has no second force
    const { state, force } = w.recoveryState("X", 9n);
    expect(force.map(x => x.publication.kind)).toEqual(["demand", "release"]);
    expect(force.at(-1)).toBe(late.release);
    expect(state.spent.has(note.nf)).toBe(true);
    expect(state.outputs.has(late.settled.out.cm)).toBe(true);
    expect(state.standing.size).toBe(0);
    expect(state.totals.get("X")).toBe(100n);
    expect(w.recoveryViolations()).toEqual([]);
  });
  it("gives no force to a release bound to another segment, anchored outside the snapshot, past its acceptance, unsigned by K, or after a withdrawal", () => {
    const f = silence(), { w, p, note } = f;
    const tail = spend(w, p, [note], [40n, 60n]);
    p.submit(tail.statement); // unwitnessed
    w.tick(6n);
    redeem(f, { id: "other", scope: p.scope });
    redeem(f, p, p.view().roots, tail.outputs[0]!, "H1");
    const expired = redeem(f, p, p.view().roots, note, "H2", 7n); // the demand locks, the release is late
    expect(() => w.publish({ kind: "demand", backing: "X", statement: demandFor(w, p, p.view().roots, [note], { presenter: "H3" }) })).not.toThrow();
    w.publish({ kind: "withdrawal", backing: "X", statement: withdrawFor(w, p, expired.demand, "H2") });
    const demand = demandFor(w, p, p.view().roots, [note], { presenter: "H3" });
    w.publish({ kind: "demand", backing: "X", statement: demand });
    w.publish({ kind: "release", backing: "X", statement: settleFor(w, p, p.view().roots, [note], demand, acceptanceOf(demand, "o", 25n, false), "H3").statement });
    w.publish({ kind: "withdrawal", backing: "X", statement: withdrawFor(w, p, demand, "H3") });
    w.publish({ kind: "release", backing: "X", statement: settleFor(w, p, p.view().roots, [note], demand, acceptanceOf(demand), "H3").statement });
    const { state, force } = w.recoveryState("X", 9n);
    expect(force.map(x => x.publication.kind)).toEqual(["demand", "withdrawal", "demand", "withdrawal"]);
    expect(state.spent.has(note.nf)).toBe(false);
    expect(state.locks.size).toBe(0);
    expect(w.recoveryViolations()).toEqual([]);
  });
  it("counterexample: an anchor the snapshot does not certify recovers the unwitnessed tail and breaks supply", () => {
    const f = silence({ anyAnchor: true }), { w, p, note } = f;
    const tail = spend(w, p, [note], [40n, 60n]);
    p.submit(tail.statement);
    w.tick(6n);
    redeem(f, p, p.view().roots, tail.outputs[0]!, "H1");
    expect(w.recoveryState("X", 9n).force.length).toBe(2);
    expect(w.recoveryViolations()).toContain("holdings differ from supply: recovery");
  });
  it("bare nullifiers, acceptances and requests have no force; the counterexample destroys supply", () => {
    const f = silence(), { w, note } = f;
    w.tick(6n);
    w.publish({ kind: "nullifiers", backing: "X", nullifiers: [note.nf] });
    expect(w.recoveryState("X", 9n).force).toEqual([]);
    expect(w.recoveryViolations()).toEqual([]);
    const g = silence({ bareNullifiers: true });
    g.w.tick(6n);
    g.w.publish({ kind: "nullifiers", backing: "X", nullifiers: [g.note.nf] });
    expect(g.w.recoveryState("X", 9n).force.length).toBe(1);
    expect(g.w.recoveryViolations()).toContain("holdings differ from supply: recovery");
  });
  it("counterexample: force outside the gap lets a settlement and an ordinary spend consume one note", () => {
    const f = silence({ forceOutsideGap: true }), { w, p, note } = f;
    redeem(f);
    p.submit(spend(w, p, [note], [40n, 60n]).statement);
    witness(w, p.commit());
    expect(w.recoveryViolations()).toContain("settled note spent again");
  });
  it("a settled note stays settled across a second silence through the adoption index; the counterexample settles it twice", () => {
    for (const recovery of [{}, { settleTwice: true }] as const) {
      const f = silence(recovery), { w, note } = f;
      w.tick(6n);
      redeem(f);
      const { next } = comeBack(f); // opening at 9, nothing adopted yet
      w.tick(6n); // 15: the gap is open again
      const again = redeem(f, next, next.view().roots, note, "H2");
      const { force } = w.recoveryState("X", w.now + 1n);
      expect(force.includes(again.release)).toBe(recovery.settleTwice === true);
      expect(w.recoveryViolations()).toEqual(recovery.settleTwice ? ["note settled twice"] : []);
    }
  });
});

describe("C2b.4.1–2: the return is a new segment that adopts the gap before it serves", () => {
  it("adopts the block in venue order after its opening lands, idempotently, then serves; the tail's receipts read abandoned and the adoption's final", () => {
    const f = silence(), { w, p, note } = f;
    const tail = p.submit(spend(w, p, [note], [40n, 60n]).statement);
    w.tick(6n);
    const { settled } = redeem(f);
    expect(() => p.submit(spend(w, p, [note], [50n, 50n]).statement)).toThrow("gap open");
    const next = w.open("P", ["X"]);
    expect(() => next.adopt(settled.statement)).toThrow("opening not witnessed");
    const opening = next.commit(); w.tick();
    const fresh = w.oracle.prove(next, "issue", [], [w.oracle.note("X", 5n)], [], { backing: "X", quantity: 5n });
    expect(() => next.submit(fresh)).toThrow("adopt the gap first");
    expect(w.include(opening)).toBe("final");
    expect(w.gapOpen("X", w.now + 1n)).toBe(false);
    expect(() => next.submit(fresh)).toThrow("adopt the gap first");
    const receipts = w.adoptGap(next);
    expect(receipts.map(r => r.position)).toEqual([1n, 2n]);
    expect(w.adoptGap(next)).toEqual(receipts);
    expect(next.view().spent.has(note.nf)).toBe(true);
    next.submit(spend(w, next, [settled.out], [40n, 60n]).statement);
    witness(w, next.commit());
    expect(w.classify(tail, p.scope).status).toBe("abandoned");
    expect(w.classify(receipts[1]!, next.scope).status).toBe("final");
    expect(w.recoveryViolations()).toEqual([]);
  });
  it("adopts a publication witnessed at the opening's own index; the counterexample that skips it lets the settled note be spent again", () => {
    for (const recovery of [{}, { skipSameIndex: true }] as const) {
      const f = silence(recovery), { w, note } = f;
      w.tick(6n);
      const next = w.open("P", ["X"]);
      const opening = next.commit(); w.tick();
      redeem(f); // at 9, the index the opening is witnessed at
      expect(w.include(opening)).toBe("final");
      const receipts = w.adoptGap(next);
      expect(receipts.length).toBe(recovery.skipSameIndex ? 0 : 2);
      if (recovery.skipSameIndex) {
        next.submit(spend(w, next, [note], [40n, 60n]).statement);
        witness(w, next.commit());
        expect(w.recoveryViolations()).toContain("settled note spent again");
      } else {
        expect(() => next.submit(spend(w, next, [note], [40n, 60n]).statement)).toThrow("spent conflict");
        witness(w, next.commit());
        expect(w.recoveryViolations()).toEqual([]);
      }
    }
  });
  it("a checkpoint that serves before the block is complete is invalid; the counterexample finalizes a double spend", () => {
    const f = silence(), { w, note } = f;
    w.tick(6n);
    redeem(f);
    const { next } = comeBack(f);
    const hostile = new Service(w, next.id, next.scope, next.openings, next.view());
    hostile.events.push({ id: `${next.id}:0`, statement: spend(w, next, [note], [40n, 60n]).statement });
    const served = w.sign(hostile); w.tick();
    expect(w.include(served)).toBe("invalid");
    const g = silence({ serveBeforeAdoption: true });
    g.w.tick(6n);
    redeem(g);
    const back = comeBack(g).next;
    back.submit(spend(g.w, back, [g.note], [40n, 60n]).statement);
    expect(() => g.w.adoptGap(back)).toThrow(/locked or spent|spent conflict/);
    witness(g.w, back.commit());
    expect(g.w.recoveryViolations()).toContain("settled note spent again");
  });
  it("a continuation through the gap lapses with its tail; the counterexample keeps a tail that spends a settled note", () => {
    for (const recovery of [{}, { continueThroughGap: true }] as const) {
      const f = silence(recovery), { w, p, note } = f;
      p.submit(spend(w, p, [note], [40n, 60n]).statement);
      w.tick(6n);
      redeem(f);
      const continued = p.commit(); w.tick();
      expect(w.include(continued)).toBe(recovery.continueThroughGap ? "final" : "lapsed");
      if (recovery.continueThroughGap) {
        expect(w.recoveryViolations()).toContain("settled note spent again");
      } else {
        expect(w.recoveryViolations()).toEqual([]);
        const { next } = comeBack(f);
        expect(w.adoptGap(next).length).toBe(2);
        expect(w.recoveryViolations()).toEqual([]);
      }
    }
  });
  it("an heir seated during the silence inherits the open gap, closes it with its opening, and adopts a withdrawal of a demand the snapshot held standing", () => {
    const f = silence(), { w, p, note } = f;
    const demand = demandFor(w, p, p.view().roots, [note]);
    p.submit(demand);
    const held = p.commit(); witness(w, held); // at 3: the gap opens at 9
    w.tick(6n);
    w.publish({ kind: "withdrawal", backing: "X", statement: withdrawFor(w, p, demand) });
    w.replace("X", "Q"); // effective at 12
    w.tick(3n);
    expect(w.gapOpen("X", w.now)).toBe(true);
    const q = w.open("Q", ["X"]);
    expect(q.openings.get("X")).toBe(held.id);
    witness(w, q.commit());
    expect(w.gapOpen("X", w.now + 1n)).toBe(false);
    expect(w.adoptGap(q).length).toBe(1);
    expect(q.view().standing.size).toBe(0);
    q.submit(spend(w, q, [note], [40n, 60n]).statement);
    witness(w, q.commit());
    expect(w.recoveryViolations()).toEqual([]);
  });
});

describe("review dispositions: the venue name, the lock's bound, the instant, one clause per scope, and a drop", () => {
  it("reads a publication for the backing its statement names: a stranger's relabelled copy has no force and does not brick the return", () => {
    const f = shared(), { w, note } = f;
    w.tick(6n);
    const { settled, demand } = redeem(f);
    w.publish({ kind: "demand", backing: "Y", statement: demand });
    w.publish({ kind: "release", backing: "Y", statement: settled.statement });
    expect(w.recoveryState("Y", 9n).force).toEqual([]);
    expect(w.recoveryState("X", 9n).force.length).toBe(2);
    const { next } = comeBack(f, "P", ["X", "Y"]);
    expect(w.adoptGap(next).length).toBe(2);
    expect(next.view().spent.has(note.nf)).toBe(true);
    witness(w, next.commit());
    expect(w.recoveryViolations()).toEqual([]);
  });
  it("a lock stands until its demand's deadline and reserves nothing after it, so a refusing operator cannot freeze a note past the holder's own term", () => {
    const { w, p, note } = silence();
    const demand = demandFor(w, p, p.view().roots, [note], { deadline: 6n });
    p.submit(demand);
    w.publish({ kind: "request", backing: "X", statement: requestFor(w, p.view().roots, note) });
    witness(w, p.commit()); // at 3
    const pay = spend(w, p, [note], [40n, 60n]);
    expect(() => p.submit(pay.statement)).toThrow("locked");
    expect(w.count("X", 6n).count).toBe(0n); // locked and standing at 6: served
    expect(w.count("X", 7n).count).toBe(1n); // past the deadline: unserved
    w.tick(3n); // now 6, horizon 7
    p.submit(pay.statement);
    expect(p.view().standing.has(demand.id)).toBe(true); // evidence in the history, reserving nothing
    witness(w, p.commit());
    expect(w.recoveryViolations()).toEqual([]);
  });
  it("refuses a demand whose instant is outside its window, at the door and at the venue", () => {
    const f = silence(), { w, p, note } = f;
    const roots = p.view().roots;
    expect(() => p.submit(demandFor(w, p, roots, [note], { instant: w.now - 2n }))).toThrow("instant outside its window");
    expect(() => p.submit(demandFor(w, p, roots, [note], { instant: w.now + 1n }))).toThrow("instant outside its window");
    w.tick(6n);
    w.publish({ kind: "demand", backing: "X", statement: demandFor(w, p, roots, [note], { instant: w.now }) });
    expect(w.recoveryState("X", 9n).force).toEqual([]);
    w.publish({ kind: "demand", backing: "X", statement: demandFor(w, p, roots, [note], { instant: w.now - 2n }) });
    expect(w.recoveryState("X", 9n).force.length).toBe(1);
  });
  it("one no-commitment duration per scope: a scope mixing clauses, or clause with none, is refused", () => {
    const w = new RecoveryWorld();
    w.register("X", "P"); w.register("Y", "P"); w.register("Z", "P");
    w.declare("X", CLAUSE); w.declare("Y", { noCommitment: 7n });
    expect(() => w.open("P", ["X", "Y"])).toThrow("mixed silence clauses");
    expect(() => w.open("P", ["X", "Z"])).toThrow("mixed silence clauses");
    w.declare("Y", CLAUSE);
    expect(w.open("P", ["X", "Y"]).scope.entries.length).toBe(2);
  });
  it("a commitment carrying nothing for a backing closes its gap but adopts nothing for it; the next segment carrying it reaches back to its adoption index", () => {
    const f = shared(), { w, note } = f;
    w.tick(6n);
    redeem(f);
    const { next: onlyY } = comeBack(f, "P", ["Y"]); // at 9: X's interval closes, X's release waits
    expect(w.gapOpen("X", w.now + 1n)).toBe(false);
    expect(w.adoptGap(onlyY)).toEqual([]);
    expect(w.count("X", w.now + 1n).incumbent).toBe("P");
    const { next: both } = comeBack(f, "P", ["X", "Y"]);
    expect(w.adoptGap(both).length).toBe(2);
    expect(both.view().spent.has(note.nf)).toBe(true);
    witness(w, both.commit());
    expect(w.recoveryViolations()).toEqual([]);
  });
  it("an adopted settlement is judged at its own index: its demand may be past its deadline by the time the opening lands", () => {
    const f = silence(), { w, p, note } = f;
    w.tick(6n);
    const demand = demandFor(w, p, p.view().roots, [note], { deadline: 10n });
    const acceptance = acceptanceOf(demand, "backer-owner", 9n);
    w.publish({ kind: "demand", backing: "X", statement: demand });
    w.publish({ kind: "release", backing: "X", statement: settleFor(w, p, p.view().roots, [note], demand, acceptance).statement });
    w.tick(3n); // 11: both deadlines are behind
    const { next } = comeBack(f);
    expect(w.adoptGap(next).length).toBe(2);
    witness(w, next.commit());
    expect(w.recoveryViolations()).toEqual([]);
  });
});
