// Research regressions for the unselected R6/R7 fault-liability policies.
// These cases characterize the current candidate after historical-silence
// retirement; they do not select normative receipt or segment semantics.
import { describe, expect, it } from "vitest";
import { Service, type Checkpoint, type Id, type Receipt } from "./pool-authority.js";
import { FaultWorld } from "./pool-fault.js";

const BACKINGS = ["X", "Y"] as const;
const CLAUSE = { noCommitment: 5n, nonService: { duration: 3n, count: 1n, window: 100n } };

function witness(w: FaultWorld, c: Checkpoint, status = "final"): void {
  if (w.now < c.signedAt + w.lag) w.tick(c.signedAt + w.lag - w.now);
  expect(w.include(c)).toBe(status);
}

function fixture() {
  const w = new FaultWorld(1n);
  for (const b of BACKINGS) { w.register(b, "P"); w.declare(b, CLAUSE); }
  const p = w.open("P", BACKINGS), opening = p.commit();
  witness(w, opening);
  return { w, p, opening };
}

function issue(w: FaultWorld, p: Service, backing: Id = "X", quantity = 1n) {
  const note = w.oracle.note(backing, quantity);
  const statement = w.oracle.prove(p, "issue", [], [note], [], { backing, quantity });
  return { note, statement, receipt: p.submit(statement) };
}

function badProof(w: FaultWorld, p: Service): Checkpoint {
  const backing = p.scope.entries[0]!.backing;
  const valid = w.oracle.prove(p, "issue", [], [w.oracle.note(backing, 1n)], [], { backing, quantity: 1n });
  const invalid = Object.freeze({ ...valid });
  expect(w.oracle.verify(valid, p.scope, p.view().roots, {})).toBe(true);
  expect(w.oracle.verify(invalid, p.scope, p.view().roots, {})).toBe(false);
  const hostile = new Service(w, p.id, p.scope, p.openings, p.view());
  hostile.events.push(...p.events, { id: `${p.id}:${p.events.length}`, statement: invalid });
  const checkpoint = w.sign(hostile);
  witness(w, checkpoint, "invalid");
  return checkpoint;
}

// Ideal operator-attributed hostile receipt; this model has no receipt signature.
function postFaultReceipt(before: Receipt, statement: Id, after: bigint): Receipt {
  return { ...before, statement, position: before.position + 1n,
    after, history: JSON.stringify([before.statement, statement]) };
}

describe("candidate R6 receipt liability after historical-silence retirement", () => {
  it("keeps an ideal operator-attributed post-fault tail pending until a later boundary decides it", () => {
    const { w, p } = fixture();
    const first = issue(w, p);
    const fault = badProof(w, p); // sequence 2: authenticated fault
    const later = w.oracle.prove(p, "issue", [], [w.oracle.note("X", 1n)], [], { backing: "X", quantity: 1n });
    const receipt = postFaultReceipt(first.receipt, later.id, fault.sequence);
    expect(receipt.after).toBe(fault.sequence);
    expect(w.classify(receipt, p.scope)).toMatchObject({ status: "pending", included: false, contradicted: false, abandoned: false });
  });

  it("preserves earlier finality and contradiction despite a later fault", () => {
    const { w, p } = fixture();
    const finalized = issue(w, p), finalCheckpoint = p.commit(); witness(w, finalCheckpoint);
    const contradicted = { ...finalized.receipt, statement: "other-statement", history: JSON.stringify(["other-statement"]) };
    badProof(w, p); // sequence 3: fault after the finalized prefix
    expect(w.classify(finalized.receipt, p.scope).status).toBe("final");
    expect(w.classify(contradicted, p.scope).status).toBe("contradicted");
  });

  it("lets a real silence boundary lapse the unfinished fault tail while final receipts remain final", () => {
    const { w, p } = fixture();
    const finalized = issue(w, p), finalCheckpoint = p.commit(); witness(w, finalCheckpoint);
    const fault = badProof(w, p);
    const tail = postFaultReceipt(finalized.receipt, "unfinished", fault.sequence);
    expect(tail.after).toBe(fault.sequence);
    w.tick(5n);
    expect(w.classify(finalized.receipt, p.scope).status).toBe("final");
    expect(w.classify(tail, p.scope)).toMatchObject({ status: "lapsed", lapse: "silence", abandoned: false });
  });
});

describe("candidate R7 stale-twin segment liability after historical-silence retirement", () => {
  it("faults future service after a stale twin while preserving every earlier XY prefix and receipt", () => {
    const { w, p, opening } = fixture();
    const x = issue(w, p, "X"), y = issue(w, p, "Y");
    const first = p.commit(); witness(w, first); // prefix with both scoped backings
    const z = issue(w, p, "X");
    const second = p.commit(); witness(w, second);
    const stale = new Service(w, p.id, p.scope, p.openings, p.view());
    const twin = w.sign(stale); witness(w, twin, "invalid");
    expect(w.record(twin.id).reason).toBe("rewritten prefix");
    const continuation = w.sign(p); witness(w, continuation, "invalid");
    expect(w.record(continuation.id).reason).toBe("faulted segment");
    for (const checkpoint of [opening, first, second]) expect(w.import(checkpoint.id)).toBeDefined();
    for (const receipt of [x.receipt, y.receipt, z.receipt]) expect(w.classify(receipt, p.scope).status).toBe("final");
  });
});
