// C2b.3a/3c's approved snapshot boundary, using the existing authority model.
// This observes note inclusion in canonical finalized state, not redemption
// eligibility: silence, ownership proofs, consent, recovery settlements and
// their venue ordering are deliberately NOT implemented by this test model.
// ProofOracle's immutable notes stand in for authenticated note openings.
import { describe, expect, it } from "vitest";
import { World, type Checkpoint, type Note, type Service } from "./pool-authority.js";

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
