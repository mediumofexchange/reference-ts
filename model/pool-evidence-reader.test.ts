// C2.10.10–13 over explicit evidence bytes. The hash relation is real;
// proof verification and checkpoint/receipt signatures remain ideal oracles.
import { describe, expect, it } from "vitest";
import { Service, type Checkpoint, type Event, type Receipt } from "./pool-authority.js";
import { FaultWorld } from "./pool-fault.js";
import { evidenceChain, evidenceHashes, statementDigest, type Evidence } from "./pool-evidence.js";

function witness(w: FaultWorld, c: Checkpoint, status = "final"): void {
  if (w.now < c.signedAt + w.lag) w.tick(c.signedAt + w.lag - w.now);
  const result = w.include(c);
  expect({ status: result, reason: w.records.at(-1)?.reason }).toMatchObject({ status });
}
function fixture() {
  const w = new FaultWorld();
  w.register("X", "P"); w.register("Y", "P");
  const p = w.open("P", ["X", "Y"]), opening = p.commit(); witness(w, opening);
  const note = w.oracle.note("X", 7n);
  const prove = (signedByK = true) => w.oracle.prove(p, "issue", [], [note], [], { backing: "X", quantity: 7n }, signedByK);
  const original = prove(), alternate = prove(), receipt = p.submit(original);
  const event = p.events[0]!;
  return { w, p, opening, note, original, alternate, receipt, event, prove };
}
function signEvents(w: FaultWorld, p: Service, events: readonly Event[]): Checkpoint {
  const hostile = new Service(w, p.id, p.scope, p.openings, p.view());
  hostile.events.push(...events);
  return w.sign(hostile);
}
function replaceEvidence(event: Event, field: keyof Evidence, bytes: string): Event {
  return { ...event, evidence: { ...event.evidence!, [field]: bytes } };
}
/** These objects represent additional receipts signed by the hostile operator,
 * not a verifier accepting arbitrary edits to an authenticated receipt. */
function signedEvidenceReceipt(receipt: Receipt, evidence: Evidence): Receipt {
  return Object.freeze({ ...receipt, ...evidenceHashes(evidence) });
}
function repairOpening(w: FaultWorld, p: Service): Checkpoint {
  // Signed hostile scope transition: the honest service refuses a live tail.
  const id = `repair-${w.now}`, scope = Object.freeze({ ...p.scope, root: `${id}:scope` });
  const openings = new Map(scope.entries.map(e => [e.backing, w.currentFor(e.backing, scope.operator)]));
  const service = new Service(w, id, scope, openings, w.merge(openings));
  return w.sign(service);
}

describe("C2.10.10: authenticated evidence and statement identity", () => {
  it("later proof generation never gives a previously committed invalid byte string validity", () => {
    const { w, p, event, prove } = fixture();
    const guessed = replaceEvidence(event, "proof", "00".repeat(31) + "01");
    const bad = signEvents(w, p, [guessed]); witness(w, bad, "invalid");
    expect(w.classification(bad.id)).toBe("excluded");
    for (let i = 0; i < 4; i++) {
      const next = prove(), bytes = w.oracle.evidence(next);
      expect(bytes.proof).not.toBe(guessed.evidence!.proof);
      expect(w.oracle.evidence(next)).toBe(bytes);
      expect(w.classification(bad.id)).toBe("excluded");
    }
  });

  it("derives event identity from authenticated segment and position, not replica metadata", () => {
    const { w, p, receipt } = fixture();
    const c = p.commit(); witness(w, c);
    const reader = w.reader();
    reader.supplyTrail(c.id, [{ ...c.events[0]!, id: "replica-invented-position" }]);
    expect(reader.classification(c.id)).toBe("valid");
    expect(reader.classify(receipt, p.scope).status).toBe("final");
    expect(reader.import(c.id)).toEqual(w.import(c.id));
    const raw = signEvents(w, p, [{ ...c.events[0]!, id: "operator-invented-position" }]);
    witness(w, raw);
    expect(raw.events[0]!.id).toBe(`${p.id}:0`);
  });

  it("reads the signed opening shape before lapse, never the replica's trail length", () => {
    const w = new FaultWorld(); w.register("X", "P"); w.declare("X", { noCommitment: 2n });
    const first = w.open("P", ["X"]); witness(w, first.commit());
    const note = w.oracle.note("X", 7n);
    first.submit(w.oracle.prove(first, "issue", [], [note], [], { backing: "X", quantity: 7n }));
    const base = first.commit(); witness(w, base);
    w.tick(4n);
    const returned = w.open("P", ["X"]), opening = returned.commit(); witness(w, opening);
    const reader = w.reader(); reader.supplyTrail(opening.id, base.events);
    expect(reader.classification(opening.id)).toBe("unresolved");
    expect(w.classification(opening.id)).toBe("valid");
    reader.supplyTrail(opening.id, []);
    expect(reader.classification(opening.id)).toBe("valid");
  });

  it.each(["proofHash", "signatureHash"] as const)("missing %s refuses both receipt APIs without manufacturing contradiction", field => {
    const { w, p, receipt } = fixture(); const c = p.commit(); witness(w, c);
    const { [field]: _, ...incomplete } = receipt;
    expect(() => w.classify(incomplete, p.scope)).toThrow("unresolved receipt evidence");
    expect(() => w.classifyRepair(incomplete, p.scope, c.id)).toThrow("unresolved receipt evidence");
  });

  it("retains the admitted bytes and receipt through valid reproof, restart and checkpoint replay", () => {
    const { w, p, original, alternate, receipt, event } = fixture();
    const alternateEvidence = w.oracle.evidence(alternate);
    expect(statementDigest(original)).toBe(statementDigest(alternate));
    expect(alternateEvidence).not.toEqual(event.evidence);
    expect(w.oracle.verifyEvidence(alternate, alternateEvidence, p.scope, p.view().roots, {})).toBe(true);
    expect(p.submit(alternate)).toBe(receipt);
    expect(p.events[0]!.evidence).toEqual(event.evidence);
    const c = p.commit(); witness(w, c);
    const resumed = p.restart(); w.tick();
    expect(resumed.submit(alternate)).toBe(receipt);
    expect(w.record(c.id).checkpoint).toBe(c);
    expect(w.classify(receipt, p.scope).status).toBe("final");
    expect(c.evidenceHash).toBe(evidenceChain(p.id, c.events));
    expect(w.recoveryViolations()).toEqual([]);
  });

  it.each(["proof", "signature"] as const)("a replica's substituted %s is unresolved whether the substitute verifies or fails", field => {
    const { w, p, alternate, receipt } = fixture();
    const c = p.commit(); witness(w, c);
    const reader = w.reader();
    for (const bytes of [w.oracle.evidence(alternate)[field], "ff"]) {
      reader.supplyTrail(c.id, [replaceEvidence(c.events[0]!, field, bytes)]);
      expect(reader.classification(c.id)).toBe("unresolved");
      expect(() => reader.import(c.id)).toThrow();
      expect(() => reader.snapshot("X", w.now + 1n)).toThrow();
      expect(() => reader.closing("X", w.now + 1n)).toThrow();
      expect(() => reader.classify(receipt, p.scope)).toThrow();
      expect(w.classification(c.id)).toBe("valid");
    }
    reader.supplyTrail(c.id, c.events);
    expect(reader.classification(c.id)).toBe("valid");
    expect(reader.classify(receipt, p.scope).status).toBe("final");
  });

  it("missing interior evidence, omitted events, wrong-context trails and substituted public fields are unresolved", () => {
    const { w, p, event } = fixture();
    p.submit(w.oracle.prove(p, "issue", [], [w.oracle.note("Y", 2n)], [], { backing: "Y", quantity: 2n }));
    const c = p.commit(); witness(w, c);
    const reader = w.reader();
    const { evidence: _, ...missing } = event;
    const other = new FaultWorld(); other.register("X", "P");
    const q = other.open("P", ["X"]), opening = q.commit(); witness(other, opening);
    q.submit(other.oracle.prove(q, "issue", [], [other.oracle.note("X", 1n)], [], { backing: "X", quantity: 1n }));
    for (const trail of [[], [missing, c.events[1]!], q.events,
      [{ ...event, statement: { ...event.statement, outputs: ["substituted"] } }, c.events[1]!]]) {
      reader.supplyTrail(c.id, trail);
      expect(reader.classification(c.id)).toBe("unresolved");
    }
    reader.supplyTrail(c.id, c.events);
    expect(reader.classification(c.id)).toBe("valid");
  });

  it.each(["proof", "signature"] as const)("committed bad %s is excluded; repair finalizes matching evidence and contradicts the hostile receipt", field => {
    const { w, p, event, receipt, note } = fixture();
    const badEvent = replaceEvidence(event, field, "ff");
    const hostileReceipt = signedEvidenceReceipt(receipt, badEvent.evidence!);
    const bad = signEvents(w, p, [badEvent]); witness(w, bad, "invalid");
    expect(w.record(bad.id).reason).toBe("proof");
    expect(w.classification(bad.id)).toBe("excluded");
    expect(w.classify(hostileReceipt, p.scope).status).toBe("pending");
    expect(() => p.change(["Y"])).toThrow("live tail");
    const repaired = p.commit(); witness(w, repaired);
    expect(w.classify(receipt, p.scope).status).toBe("final");
    expect(w.classify(hostileReceipt, p.scope)).toMatchObject({ status: "contradicted", included: false });
    expect(w.import(repaired.id).outputs.has(note.cm)).toBe(true);
    expect(w.classification(bad.id)).toBe("excluded");
    expect(w.recoveryViolations()).toEqual([]);
  });

  it("separates issue proof validity from the obligor signature and binds both to the public statement", () => {
    const { w, p, original, event, prove } = fixture();
    const unsigned = prove(false), bytes = w.oracle.evidence(unsigned);
    expect(w.oracle.verify(unsigned, p.scope, p.view().roots, {})).toBe(false);
    expect(w.oracle.verifyEvidence(original, { ...bytes, signature: event.evidence!.signature }, p.scope, p.view().roots, {})).toBe(true);
    expect(w.oracle.verifyEvidence(original, bytes, p.scope, p.view().roots, {})).toBe(false);
    expect(w.oracle.verifyEvidence({ ...original, lit: { backing: "X", quantity: 8n } }, event.evidence!, p.scope, p.view().roots, {})).toBe(false);
    const other = w.oracle.prove(p, "issue", [], [w.oracle.note("X", 1n)], [], { backing: "X", quantity: 1n });
    for (const field of ["proof", "signature"] as const) {
      expect(w.oracle.verifyEvidence(original, { ...event.evidence!, [field]: w.oracle.evidence(other)[field] }, p.scope, p.view().roots, {})).toBe(false);
    }
  });

  it.each(["proof", "signature"] as const)("an alternate valid %s cannot rewrite a valid prefix or undo its receipt", field => {
    const { w, p, alternate, event, receipt } = fixture();
    const first = p.commit(); witness(w, first);
    const changed = replaceEvidence(event, field, w.oracle.evidence(alternate)[field]);
    expect(w.oracle.verifyEvidence(changed.statement, changed.evidence!, p.scope, p.view().roots, {})).toBe(true);
    const bad = signEvents(w, p, [changed]); witness(w, bad, "invalid");
    expect(w.record(bad.id).reason).toBe("rewritten evidence prefix");
    const continued = p.commit(); witness(w, continued);
    expect(w.classify(receipt, p.scope).status).toBe("final");
    expect(w.import(continued.id)).toEqual(w.import(first.id));
    w.withheld.add(bad.id);
    expect(w.classify(receipt, p.scope).status).toBe("final");
    expect(() => w.import(continued.id)).toThrow();
  });

  it.each(["proof", "signature"] as const)("the ordinary and supplied repair receipt walks both compare %s digests", field => {
    const { w, p, receipt, event, alternate } = fixture();
    const c = p.commit(); witness(w, c);
    const wrong = signedEvidenceReceipt({ ...receipt, after: c.sequence },
      { ...event.evidence!, [field]: w.oracle.evidence(alternate)[field] });
    w.sign(p); w.tick(); // actual unheld sequence between this segment and repair
    const boundary = repairOpening(w, p); witness(w, boundary);
    expect(w.classifyRepair(wrong, p.scope, boundary.id)).toEqual({ included: false, contradicted: true, lapsed: false });
    expect(w.classify(wrong, p.scope)).toMatchObject({ status: "contradicted", included: false });
    expect(w.classifyRepair({ ...receipt, after: c.sequence }, p.scope, boundary.id)).toEqual({ included: true, contradicted: false, lapsed: false });
  });

  it("withheld imported evidence blocks descendants; independent readers retain copies without observer leakage", () => {
    const { w, p, alternate, note } = fixture();
    const parent = p.commit(); witness(w, parent);
    const y = p.change(["Y"]), child = y.commit(); witness(w, child);
    const reader = w.reader();
    const supplied = [{ ...parent.events[0]!, evidence: { ...parent.events[0]!.evidence! } }];
    reader.supplyTrail(parent.id, supplied);
    supplied[0]!.evidence.proof = "ff";
    expect(reader.import(child.id).outputs.has(note.cm)).toBe(true);
    w.supplyTrail(parent.id, [replaceEvidence(parent.events[0]!, "proof", w.oracle.evidence(alternate).proof)]);
    const later = w.reader();
    expect(later.classification(parent.id)).toBe("unresolved");
    expect(later.classification(child.id)).toBe("unresolved");
    expect(() => later.import(child.id)).toThrow();
    expect(reader.classification(child.id)).toBe("valid");
    expect(w.recoveryViolations()).toEqual([]); // observer has originals, ordinary readers still do not
    expect(later.classification(child.id)).toBe("unresolved");
    later.supplyTrail(parent.id, parent.events);
    expect(later.import(child.id)).toEqual(reader.import(child.id));
  });
});
