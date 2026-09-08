// C2b.4.1/3 boundary and receipt regressions, with ideal authenticated evidence.
import { describe, expect, it } from "vitest";
import { Service, type Checkpoint } from "./pool-authority.js";
import { FaultWorld } from "./pool-fault.js";
import { RecoveryWorld } from "./pool-recovery.js";

const MODELS = [
  { name: "recovery", create: () => new RecoveryWorld(1n) },
  { name: "fault reader", create: () => new FaultWorld(1n) },
];
function witness(w: RecoveryWorld, c: Checkpoint, status = "final") {
  w.tick(); expect(w.include(c)).toBe(status);
}
function setup(w: RecoveryWorld, backings = ["X"]) {
  for (const b of ["X", "Y"]) { w.register(b, "P"); w.declare(b, { noCommitment: 5n }); }
  const p = w.open("P", backings), opening = p.commit(); witness(w, opening);
  const issue = () => w.oracle.prove(p, "issue", [], [w.oracle.note("X", 1n)], [], { backing: "X", quantity: 1n });
  const finalReceipt = p.submit(issue()), base = p.commit(); witness(w, base);
  const receipt = p.submit(issue());
  return { w, p, opening, base, receipt, finalReceipt };
}
function twin(w: RecoveryWorld, p: Service, events = p.events) {
  const s = new Service(w, p.id, p.scope, p.openings, p.view()); s.events.push(...events); return s;
}

describe("C2b.4.1/3: witnessed silence boundaries", () => {
  it.each(MODELS)("$name lapses a tail at the strict threshold without any recovery publication", ({ create }) => {
    const { w, p, receipt, finalReceipt } = setup(create());
    w.tick(5n); // 7: exactly five since checkpoint@2; horizon@8 is only predicted.
    expect(w.classify(receipt, p.scope).status).toBe("pending");
    expect(() => p.change(["Y"])).toThrow("live tail before scope change");
    expect(() => w.serving(p, p.events.at(-1)!.statement)).toThrow("gap open");
    w.tick(); // 8: actual silence boundary
    expect(w.classify(receipt, p.scope)).toMatchObject({ status: "lapsed", lapse: "silence" });
    expect(w.classify(finalReceipt, p.scope).status).toBe("final");
    expect(w.published).toHaveLength(0);
    const y = p.change(["Y"]); witness(w, y.commit()); // closes X's clock, not retirement
    expect(w.gapOpen("X", 10n)).toBe(false);
    expect(w.classify(receipt, p.scope)).toMatchObject({ status: "lapsed", lapse: "silence" });
    witness(w, w.sign(twin(w, p)), "lapsed");
  });

  it.each(MODELS)("$name does not retire a segment kept continuous exactly at the threshold", ({ create }) => {
    const { w, p, receipt } = setup(create());
    w.tick(4n); const c = w.sign(twin(w, p)); witness(w, c); // 7
    w.tick(4n); witness(w, w.sign(twin(w, p))); // 12
    expect(w.classify(receipt, p.scope).status).toBe("final");
    expect(w.recoveryViolations()).toEqual([]);
  });

  it.each(MODELS)("$name preserves an earlier contradiction through silence and later missing evidence", ({ create }) => {
    const { w, p, receipt, base } = setup(create());
    witness(w, w.sign(twin(w, p, [...base.events]))); // 3, omits accepted second issue
    expect(w.classify(receipt, p.scope).status).toBe("contradicted");
    w.tick(6n); const y = p.change(["Y"]), reset = y.commit(); witness(w, reset);
    w.withheldScopes.add(reset.id);
    expect(w.classify(receipt, p.scope)).toMatchObject({ status: "contradicted", contradicted: true });
  });

  it.each(MODELS)("$name does not excuse abandonment that preceded silence", ({ create }) => {
    const { w, p, receipt, base } = setup(create());
    // A hostile local copy forgets its accepted tail and electively changes scope.
    p.events.splice(0, p.events.length, ...base.events);
    const next = p.change(["X"]); witness(w, next.commit()); // 3
    expect(w.classify(receipt, p.scope).status).toBe("abandoned");
    w.tick(20n);
    expect(w.classify(receipt, p.scope).status).toBe("abandoned");
  });

  it.each(MODELS)("$name does not infer signing time from a post-gap or unheld reference", ({ create }) => {
    const { w, p, receipt, finalReceipt } = setup(create()); w.tick(6n);
    const late = w.sign(twin(w, p)); witness(w, late, "lapsed");
    for (const after of [late.sequence, late.sequence + 10n]) {
      expect(w.classify({ ...receipt, after }, p.scope)).toMatchObject({ status: "lapsed", lapse: "silence" });
      expect(w.classify({ ...finalReceipt, after }, p.scope).status).toBe("final");
    }
  });

  it.each(MODELS)("$name separates silence from a supplied failed-publication repair", ({ create }) => {
    const { w, p, receipt } = setup(create()); p.commit(); // genuine missing sequence
    w.tick(6n); const next = p.change(["X"]), r = next.commit(); witness(w, r);
    expect(() => w.classifyRepair(receipt, p.scope, r.id)).toThrow("receipt silence boundary");
    expect(w.classify(receipt, p.scope)).toMatchObject({ status: "lapsed", lapse: "silence" });
  });

  it.each(MODELS)("$name ends at the earlier scope term and permits replacement to import prior finality", ({ create }) => {
    const { w, p, receipt, finalReceipt } = setup(create(), ["X", "Y"]);
    w.replace("Y", "Q"); w.tick(3n); // 5, before silence@8
    expect(w.classify(receipt, p.scope)).toMatchObject({ status: "lapsed", lapse: "scope-boundary" });
    const q = w.open("Q", ["Y"]); witness(w, q.commit());
    w.tick(20n);
    expect(w.classify(finalReceipt, p.scope).status).toBe("final");
    expect(w.classify(receipt, p.scope)).toMatchObject({ status: "lapsed", lapse: "scope-boundary" });
  });

  it("a gap at the fresh opening index lapses a same-index continuation but not the next-index return", () => {
    const w = new FaultWorld(0n); w.register("X", "P"); w.declare("X", { noCommitment: 5n });
    w.tick(8n); const p = w.open("P", ["X"]), opening = p.commit();
    expect(w.include(opening)).toBe("final");
    expect(w.gapOpen("X", 8n)).toBe(true);
    expect(w.include(w.sign(twin(w, p)))).toBe("lapsed");
    w.tick(); const c = w.sign(twin(w, p)); expect(w.include(c)).toBe("final");
    expect(w.classification(c.id)).toBe("valid");
  });

  it("checks sparse record intervals without enumerating a huge venue-index range", () => {
    const { w, p, receipt } = setup(new FaultWorld(1n)); w.tick(1n << 64n);
    expect(w.classify(receipt, p.scope)).toMatchObject({ status: "lapsed", lapse: "silence" });
  });

  it.each(["withheldDirectories", "withheldScopes", "shownScopes"] as const)(
    "requires historical clock evidence (%s) while preserving earlier final inclusion", facet => {
      const { w, p, receipt, finalReceipt, base } = setup(new FaultWorld(1n));
      p.events.splice(0, p.events.length, ...base.events); // hostile signer drops the unfinalized tail
      const y = p.change(["Y"]), reset = y.commit(); witness(w, reset);
      w.tick(3n); // 6: X is continuous only after evaluating the Y clock reset
      if (facet === "shownScopes") w.shownScopes.set(reset.id, p.scope); else w[facet].add(reset.id);
      expect(w.classify(finalReceipt, p.scope).status).toBe("final");
      expect(() => w.classify(receipt, p.scope)).toThrow();
      if (facet === "shownScopes") w.shownScopes.clear(); else w[facet].clear();
      expect(w.classify(receipt, p.scope).status).toBe("pending");
    });
});
