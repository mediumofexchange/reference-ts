// Regressions from decisions/archive/2026-09-08-pool-fault-review.md.
// Evidence belongs to the reader; witnessing does not certify validation.
// C2.10.12–13 preserve valid-prefix continuity and receipt precedence.
import { describe, expect, it } from "vitest";
import { Service, type Checkpoint, type Id } from "./pool-authority.js";
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
  witness(w, opening); // 1
  return { w, p, opening };
}

function issue(w: FaultWorld, p: Service, backing: Id = "X") {
  const note = w.oracle.note(backing, 1n);
  const statement = w.oracle.prove(p, "issue", [], [note], [], { backing, quantity: 1n });
  return { note, statement, receipt: p.submit(statement) };
}

/** A valid issuance's public fields with an invalid ideal proof token. */
function badProof(w: FaultWorld, p: Service): Checkpoint {
  const backing = p.scope.entries[0]!.backing;
  const valid = w.oracle.prove(p, "issue", [], [w.oracle.note(backing, 1n)], [], { backing, quantity: 1n });
  const invalid = Object.freeze({ ...valid });
  expect(w.oracle.verify(valid, p.scope, p.view().roots, {})).toBe(true);
  expect(w.oracle.verify(invalid, p.scope, p.view().roots, {})).toBe(false);
  const hostile = new Service(w, p.id, p.scope, p.openings, p.view());
  hostile.events.push(...p.events, { id: `${p.id}:${p.events.length}`, statement: invalid });
  const c = w.sign(hostile);
  witness(w, c, "invalid");
  expect(w.classification(c.id)).toBe("excluded");
  return c;
}

let hostileSerial = 0;
/** The operator's key may abandon its admitted tail even though the honest
 * service door refuses. Supply a canonical opening and exercise the receipt
 * reader against the resulting signed record, without weakening that door. */
function hostileOpening(w: FaultWorld, prior: Service): Service {
  const id = `hostile-opening-${++hostileSerial}`;
  const scope = Object.freeze({ ...prior.scope, root: `${id}:scope` });
  const openings = new Map(scope.entries.map(e => [e.backing, w.currentFor(e.backing, scope.operator)]));
  return new Service(w, id, scope, openings, w.merge(openings));
}

describe("fault reader: evidence arrival and dependency closure (R2–R4)", () => {
  it("requires the imported parent's scope before rejecting its construction domain", () => {
    const w = new FaultWorld(1n);
    w.register("X", "P", "D"); w.register("Y", "P", "E");
    const x = w.open("P", ["X"]), xOpening = x.commit(); witness(w, xOpening);
    const y = w.open("P", ["Y"], "E"), parent = y.commit(); witness(w, parent);
    const hostile = new Service(w, "cross-domain-child", x.scope, new Map([["X", parent.id]]), x.view());
    const child = w.sign(hostile);
    w.withheldScopes.add(parent.id); witness(w, child, "invalid");
    expect(w.classification(child.id)).toBe("unresolved");
    expect(() => w.import(child.id)).toThrow();
    w.withheldScopes.delete(parent.id);
    expect(w.classification(child.id)).toBe("excluded");
    expect(w.record(child.id).reason).toBe("wrong construction domain");
  });

  it("restored finality permits the honest journal to change scope without discarding a live tail", () => {
    const { w, p, opening } = fixture();
    const { note } = issue(w, p), child = p.commit();
    w.withheld.add(opening.id); witness(w, child, "invalid");
    expect(w.classification(child.id)).toBe("unresolved");
    w.withheld.delete(opening.id);
    expect(w.classification(child.id)).toBe("valid");
    expect(p.finalized()).toBe(true);
    const next = p.change(["X"]);
    expect(next.openings.get("X")).toBe(child.id);
    expect(next.view().outputs.has(note.cm)).toBe(true);
    const nextOpening = next.commit(); witness(w, nextOpening);
    expect(w.classification(nextOpening.id)).toBe("valid");
  });

  it("passes an authenticated malformed carrying header but refuses the same step without its scope evidence", () => {
    const { w, p, opening } = fixture();
    const scope = Object.freeze({ ...p.scope, entries: Object.freeze([]) });
    const hostile = new Service(w, "hostile", scope, new Map(), p.view());
    const bad = w.sign(hostile, ["X"]); witness(w, bad, "invalid");
    expect(w.classification(bad.id)).toBe("excluded");
    const reader = w.reader();
    expect(reader.currentFor("X", "P")).toBe(opening.id);
    expect(reader.snapshot("X", 3n)?.checkpoint.id).toBe(opening.id);
    reader.withheldScopes.add(bad.id);
    expect(reader.classification(bad.id)).toBe("unresolved");
    expect(() => reader.currentFor("X", "P")).toThrow();
    expect(() => reader.snapshot("X", 3n)).toThrow();
    reader.withheldScopes.delete(bad.id);
    expect(reader.currentFor("X", "P")).toBe(opening.id);
    expect(reader.snapshot("X", 3n)?.checkpoint.id).toBe(opening.id);
  });

  it("a mismatching supplied predecessor scope leaves its valid descendant unresolved rather than faulted", () => {
    const { w, p, opening } = fixture();
    const { note } = issue(w, p), child = p.commit(); witness(w, child);
    const reader = w.reader();
    reader.shownScopes.set(opening.id, { ...opening.scope, root: "mismatching-scope" });
    expect(reader.classification(opening.id)).toBe("unresolved");
    expect(reader.classification(child.id)).toBe("unresolved");
    expect(() => reader.import(child.id)).toThrow();
    reader.shownScopes.delete(opening.id);
    expect(reader.classification(child.id)).toBe("valid");
    expect(reader.import(child.id).outputs.has(note.cm)).toBe(true);
  });

  it("retains fault evidence per reader when the source later stops supplying it", () => {
    const { w, p } = fixture();
    issue(w, p); witness(w, p.commit()); // 2
    const bad = badProof(w, p); // 3
    const repair = w.open("P", BACKINGS); witness(w, repair.commit()); // 4
    const { note } = issue(w, repair), child = repair.commit(); witness(w, child); // 5
    const retained = w.reader();
    w.withheld.add(bad.id);
    const reduced = w.reader();
    expect(retained.classification(child.id)).toBe("valid");
    expect(retained.import(child.id).outputs.has(note.cm)).toBe(true);
    expect(reduced.classification(child.id)).toBe("unresolved");
    expect(() => reduced.import(child.id)).toThrow();
    reduced.withheld.delete(bad.id);
    expect(reduced.import(child.id)).toEqual(retained.import(child.id));
    expect(w.classification(child.id)).toBe("unresolved"); // evidence restoration was reader-local
  });

  it("uses exact same-index sequence rank and preserves inclusion before a later stale-twin fault", () => {
    const { w, p, opening } = fixture();
    const { note, receipt } = issue(w, p), child = p.commit(); // signed at 1
    w.tick(); // 2: the first signature's lag has elapsed, but it is not held yet
    const stale = new Service(w, p.id, p.scope, p.openings, p.view()), bad = w.sign(stale);
    w.tick(); // 3: witness both signatures at one index, in sequence order
    expect(w.include(child)).toBe("final");
    expect(w.include(bad)).toBe("invalid");
    expect(w.record(bad.id).reason).toBe("rewritten prefix");
    const reader = w.reader();
    expect(reader.predecessorFor("X", { operator: "P", sequence: child.sequence, at: 3n })).toBe(opening.id);
    expect(reader.predecessorFor("X", { operator: "P", sequence: bad.sequence, at: 3n })).toBe(child.id);
    expect(reader.classification(child.id)).toBe("valid");
    expect(reader.classify(receipt, p.scope).status).toBe("final");
    reader.withheld.add(bad.id);
    expect(reader.classification(child.id)).toBe("valid");
    expect(reader.import(child.id).outputs.has(note.cm)).toBe(true);
    expect(reader.classify(receipt, p.scope).status).toBe("final");
    expect(() => reader.currentFor("X", "P")).toThrow();
  });

  it("resolves a checkpoint whose opening evidence was absent when it was first witnessed", () => {
    const { w, p, opening } = fixture();
    const { note } = issue(w, p), child = p.commit();
    w.withheld.add(opening.id);
    witness(w, child, "invalid");
    expect(w.classification(child.id)).toBe("unresolved");
    expect(() => w.import(child.id)).toThrow();
    w.withheld.delete(opening.id);
    expect(w.classification(child.id)).toBe("valid");
    expect(w.record(child.id).status).toBe("final");
    expect(w.import(child.id).outputs.has(note.cm)).toBe(true);
    expect(w.snapshot("X", 3n)?.checkpoint.id).toBe(child.id);
    expect(w.currentFor("X", "P")).toBe(child.id);
  });

  it("two readers resolve the same signed record in different evidence-arrival orders", () => {
    const { w, p, opening } = fixture();
    const { note } = issue(w, p), child = p.commit(); witness(w, child);
    w.withheld.add(opening.id);
    const first = w.reader(), second = w.reader();
    w.withheld.clear(); // each reader retained its own evidence selection
    expect(first.classification(child.id)).toBe("unresolved");
    expect(second.classification(child.id)).toBe("unresolved");
    first.withheld.delete(opening.id);
    second.withheld.add(child.id);
    second.withheld.delete(opening.id);
    expect(first.classification(child.id)).toBe("valid");
    expect(first.import(child.id).outputs.has(note.cm)).toBe(true);
    expect(second.classification(child.id)).toBe("unresolved");
    second.withheld.delete(child.id);
    expect(second.classification(child.id)).toBe("valid");
    expect(second.import(child.id)).toEqual(first.import(child.id));
    expect(w.record(child.id).checkpoint).toBe(child); // proof/signature identities survive copying
  });

  it("fresh import, receipt finality and a later opening all require the crossed fault evidence", () => {
    const { w, p } = fixture();
    issue(w, p); witness(w, p.commit()); // 2
    const bad = badProof(w, p); // 3
    const repair = w.open("P", BACKINGS), repaired = repair.commit(); witness(w, repaired); // 4
    const { note, receipt } = issue(w, repair), child = repair.commit(); witness(w, child); // 5
    const next = w.open("P", BACKINGS), nextOpening = next.commit();
    const reader = w.reader(); reader.withheld.add(bad.id);
    for (const c of [repaired, child]) {
      expect(reader.classification(c.id)).toBe("unresolved");
      expect(() => reader.import(c.id)).toThrow();
    }
    expect(() => reader.classify({ ...receipt, after: child.sequence }, repair.scope)).toThrow();
    w.withheld.add(bad.id); witness(w, nextOpening, "invalid"); // 6
    expect(w.classification(nextOpening.id)).toBe("unresolved");
    w.withheld.delete(bad.id);
    expect(w.classification(nextOpening.id)).toBe("valid");
    reader.withheld.delete(bad.id);
    expect(reader.import(child.id).outputs.has(note.cm)).toBe(true);
    expect(reader.classify({ ...receipt, after: child.sequence }, repair.scope).status).toBe("final");
  });

  it("authenticates a non-carrying directory but does not require its irrelevant history", () => {
    const { w, p, opening } = fixture();
    const y = p.change(["Y"]), yOpening = y.commit(); witness(w, yOpening); // 2
    const reader = w.reader();
    reader.withheld.add(yOpening.id);
    expect(reader.closing("X", 3n)).toBe(1n);
    expect(reader.currentFor("X", "P")).toBe(opening.id);
    reader.withheldDirectories.add(yOpening.id);
    expect(() => reader.closing("X", 3n)).toThrow();
    expect(() => reader.currentFor("X", "P")).toThrow();
    expect(() => reader.snapshot("X", 3n)).toThrow();
    reader.withheldDirectories.delete(yOpening.id);
    expect(reader.closing("X", 3n)).toBe(1n);
    expect(reader.snapshot("X", 3n)?.checkpoint.id).toBe(opening.id);
  });
});

describe("fault reader: silence lapse is evidence-dependent (R1)", () => {
  it.each(["withheldDirectories", "withheldScopes", "shownScopes"] as const)(
    "%s cannot certify either finality or term lapse from an unauthenticated checkpoint header", facet => {
      const { w, p } = fixture();
      const { note } = issue(w, p), final = p.commit(); witness(w, final); // 2
      w.replace("X", "Q"); // effective at 5
      w.tick(2n);
      const ended = w.sign(p); witness(w, ended, "lapsed"); // 5
      const reader = w.reader();
      for (const c of [final, ended]) {
        if (facet === "shownScopes") reader.shownScopes.set(c.id, { ...c.scope });
        else reader[facet].add(c.id);
        expect(reader.classification(c.id)).toBe("unresolved");
        expect(() => reader.import(c.id)).toThrow();
      }
      reader[facet].clear();
      expect(reader.classification(final.id)).toBe("valid");
      expect(reader.import(final.id).outputs.has(note.cm)).toBe(true);
      reader.withheld.add(ended.id);
      expect(reader.classification(ended.id)).toBe("lapsed"); // term lapse needs the header, not its event history
    });

  it("X's clock passes non-carrying Y without its fault or lapse history", () => {
    const { w, p } = fixture(); // XY at 1
    const y = p.change(["Y"]), yOpening = y.commit(); witness(w, yOpening); // Y at 2
    const bad = badProof(w, y); // invalid Y proof at 3
    w.tick(4n); // 7: Y has crossed its silence boundary
    const continuation = w.sign(y); witness(w, continuation, "lapsed"); // 8
    const reader = w.reader();
    expect(reader.classification(continuation.id)).toBe("lapsed");
    expect(reader.closing("X", 9n)).toBe(1n);
    expect(reader.gapOpen("X", 9n)).toBe(true);
    reader.withheld.add(bad.id);
    expect(reader.classification(continuation.id)).toBe("unresolved");
    expect(reader.closing("X", 9n)).toBe(1n);
    expect(reader.gapOpen("X", 9n)).toBe(true);
    reader.withheld.delete(bad.id);
    expect(reader.classification(continuation.id)).toBe("lapsed");
    expect(reader.gapOpen("X", 9n)).toBe(true);
  });

  it("passes a term-ended Y continuation without Y's unavailable fault history", () => {
    const { w, p } = fixture();
    const y = p.change(["Y"]); witness(w, y.commit()); // 2
    const bad = badProof(w, y); // 3
    w.replace("Y", "Q"); // effective at 6, X still belongs to P
    w.tick(2n);
    const continuation = w.sign(y); witness(w, continuation, "lapsed"); // 6
    const reader = w.reader(); reader.withheld.add(bad.id); reader.withheld.add(continuation.id);
    expect(reader.classification(continuation.id)).toBe("lapsed");
    expect(reader.closing("X", 9n)).toBe(1n);
    expect(reader.gapOpen("X", 9n)).toBe(true);
  });
});

describe("fault reader: revocation snapshot and finalized issuance", () => {
  it("later revocation preserves earlier issuance through a later checkpoint but refuses newly finalized issuance", () => {
    const { w, p } = fixture();
    const { note, receipt } = issue(w, p), issued = p.commit(); witness(w, issued); // 2
    const retained = w.reader();
    w.tick(); w.revoke("X"); // 3, strictly later than the issuance
    const preserved = p.commit(); witness(w, preserved); // 4
    expect(w.classification(issued.id)).toBe("valid");
    expect(w.import(preserved.id).outputs.has(note.cm)).toBe(true);
    const additional = issue(w, p), rejected = p.commit(); witness(w, rejected, "invalid"); // 5
    expect(w.record(rejected.id).reason).toBe("revoked issuance");
    expect(w.classification(rejected.id)).toBe("excluded");
    expect(w.classify(receipt, p.scope).status).toBe("final");
    expect(w.import(preserved.id).outputs.has(additional.note.cm)).toBe(false);
    expect(retained.import(issued.id).outputs.has(note.cm)).toBe(true);
    expect(() => retained.record(preserved.id)).toThrow("checkpoint not held");
  });

  it("a same-index revocation invalidates fresh issuance reads while an older reader keeps its explicit prior snapshot", () => {
    const { w, p } = fixture();
    const { note } = issue(w, p), issued = p.commit(); witness(w, issued); // 2
    const beforeRevocation = w.reader();
    w.revoke("X"); // same index: issuance was not finalized strictly before cutoff
    const afterRevocation = w.reader();
    expect(afterRevocation.classification(issued.id)).toBe("excluded");
    expect(() => afterRevocation.import(issued.id)).toThrow("not finalized");
    expect(w.classification(issued.id)).toBe("excluded");
    expect(beforeRevocation.classification(issued.id)).toBe("valid");
    expect(beforeRevocation.import(issued.id).outputs.has(note.cm)).toBe(true);
  });
});

describe("fault reader: every receipt selection branch respects exclusion (R5)", () => {
  it("the supplied repair reader agrees with the present receipt verdict after an ordinary missing publication", () => {
    const { w, p } = fixture();
    const { receipt } = issue(w, p);
    p.commit(); w.tick(); // sequence 2 is signed and never held
    const repair = w.open("P", BACKINGS), boundary = repair.commit(); witness(w, boundary);
    const reader = w.reader();
    expect(reader.classifyRepair(receipt, p.scope, boundary.id)).toEqual({ included: false, contradicted: false, lapsed: true });
    expect(reader.classify(receipt, p.scope)).toMatchObject({ status: "lapsed", lapse: "repair" });
  });

  it.each([false, true])("excluded transitions occupy their sequences; a supplied repair requires an actual hole (%s)", hole => {
    const { w, p } = fixture();
    const { receipt } = issue(w, p), bad = badProof(w, p); // 2
    const failed = hostileOpening(w, p), excludedOpening = w.sign(failed, ["X"]);
    witness(w, excludedOpening, "invalid"); // 3
    if (hole) { w.sign(failed); w.tick(); } // sequence 4 is absent only in this branch
    const repair = hostileOpening(w, p), boundary = w.sign(repair); witness(w, boundary);
    const reader = w.reader();
    if (hole) {
      expect(reader.classifyRepair(receipt, p.scope, boundary.id)).toEqual({ included: false, contradicted: false, lapsed: true });
      expect(reader.classify(receipt, p.scope)).toMatchObject({ status: "lapsed", lapse: "repair" });
      for (const c of [bad, excludedOpening]) {
        reader.withheld.add(c.id);
        expect(() => reader.classifyRepair(receipt, p.scope, boundary.id)).toThrow();
        expect(() => reader.classify(receipt, p.scope)).toThrow();
        reader.withheld.delete(c.id);
      }
      expect(reader.classifyRepair(receipt, p.scope, boundary.id).lapsed).toBe(true);
    } else {
      expect(() => reader.classifyRepair(receipt, p.scope, boundary.id)).toThrow("missing preceding sequence");
      expect(reader.classify(receipt, p.scope).status).toBe("abandoned");
    }
  });

  it("an excluded after reference retains earlier finalized inclusion in both receipt readers", () => {
    const { w, p } = fixture();
    const { receipt } = issue(w, p); witness(w, p.commit()); // 2: receipt already included
    const bad = badProof(w, p); // 3
    // A supplied, valid-context receipt names the same accepted history after
    // the later signature; no new inclusion is attributed to that signature.
    const laterReference = { ...receipt, after: bad.sequence };
    w.sign(p); w.tick(); // missing sequence 4
    const repair = w.open("P", BACKINGS), boundary = repair.commit(); witness(w, boundary); // 5
    const reader = w.reader();
    expect(reader.classifyRepair(laterReference, p.scope, boundary.id)).toEqual({ included: true, contradicted: false, lapsed: false });
    expect(reader.classify(laterReference, p.scope).status).toBe("final");
  });

  it("passes an excluded after checkpoint and reaches a canonical repair", () => {
    const { w, p } = fixture();
    const bad = p.commit(["X"]); // invalid whole-scope carriage, still in flight
    const { receipt } = issue(w, p);
    expect(receipt.after).toBe(bad.sequence);
    witness(w, bad, "invalid");
    const repair = hostileOpening(w, p); witness(w, w.sign(repair));
    const reader = w.reader(); reader.withheld.add(bad.id);
    expect(() => reader.classify(receipt, p.scope)).toThrow();
    reader.withheld.delete(bad.id);
    expect(reader.classify(receipt, p.scope).status).toBe("abandoned");
  });

  it("passes an excluded different-segment checkpoint without treating its sequence as a hole", () => {
    const { w, p } = fixture();
    const { receipt } = issue(w, p);
    badProof(w, p); // 2
    const failed = hostileOpening(w, p), excludedOpening = w.sign(failed, ["X"]);
    witness(w, excludedOpening, "invalid"); // 3
    const repair = hostileOpening(w, p); witness(w, w.sign(repair)); // 4
    const reader = w.reader(); reader.withheld.add(excludedOpening.id);
    expect(() => reader.classify(receipt, p.scope)).toThrow();
    reader.withheld.delete(excludedOpening.id);
    expect(reader.classify(receipt, p.scope)).toMatchObject({ status: "abandoned", abandoned: true });
  });
});

describe("fault reader: receipt precedence and valid-prefix continuation", () => {
  it("the semantic observer detects unauthorized issuance after initially missing evidence arrives", () => {
    const w = new FaultWorld(1n, {}, {}, { ignoreScope: true });
    w.register("X", "P"); w.register("Y", "Q");
    const p = w.open("P", ["X"]), opening = p.commit(); witness(w, opening);
    const { note } = issue(w, p, "Y"), child = p.commit();
    w.withheld.add(opening.id); witness(w, child, "invalid");
    expect(w.classification(child.id)).toBe("unresolved");
    w.withheld.delete(opening.id);
    expect(w.classification(child.id)).toBe("valid"); // deliberate authorization departure
    expect(w.import(child.id).outputs.has(note.cm)).toBe(true);
    expect(w.violations()).toContain("unauthorized backing");
  });

  it("R6: a fault leaves the tail pending, and a later actual sequence hole permits repair lapse", () => {
    const { w, p } = fixture();
    const { receipt } = issue(w, p); badProof(w, p); // 2
    expect(w.classify(receipt, p.scope).status).toBe("pending");
    w.sign(p); w.tick(); // sequence 3 is signed and never held
    const repair = hostileOpening(w, p); witness(w, w.sign(repair)); // 4
    expect(w.classify(receipt, p.scope)).toMatchObject({ status: "lapsed", lapse: "repair", abandoned: false });
  });

  it("R6: a later term end gives scope-boundary lapse rather than permanent fault abandonment", () => {
    const { w, p } = fixture();
    const { receipt } = issue(w, p); badProof(w, p); // 2
    expect(w.classify(receipt, p.scope).status).toBe("pending");
    w.replace("X", "Q"); w.tick(3n); // 5
    expect(w.classify(receipt, p.scope)).toMatchObject({ status: "lapsed", lapse: "scope-boundary", abandoned: false });
  });

  it("C2.10.12: a stale twin permits valid future service while the earlier finalized receipt remains final", () => {
    const { w, p } = fixture();
    const { receipt, note } = issue(w, p), final = p.commit(); witness(w, final); // 2
    const stale = new Service(w, p.id, p.scope, p.openings, p.view());
    const bad = w.sign(stale); witness(w, bad, "invalid"); // 3: empty rewritten prefix
    expect(w.record(bad.id).reason).toBe("rewritten prefix");
    const continuation = w.sign(p); witness(w, continuation); // 4
    expect(w.classification(continuation.id)).toBe("valid");
    expect(w.classify(receipt, p.scope).status).toBe("final");
    expect(w.import(final.id).outputs.has(note.cm)).toBe(true);
  });
});
