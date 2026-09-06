import { describe, expect, it } from "vitest";
import { World, Service, type Checkpoint, type Departures, type Note } from "./pool-authority.js";

function settle(w: World, c: Checkpoint): void {
  if (w.now < c.signedAt + w.lag) w.tick(c.signedAt + w.lag - w.now);
  expect(w.include(c)).toBe("final");
}
function anchor(s: Service, n: Note): string {
  const root = [...s.view().roots].find(([, leaves]) => leaves.includes(n.cm));
  if (!root) throw new Error("fixture missing note");
  return root[0];
}
function issue(w: World, s: Service, backing: string, value = 100n): Note {
  const n = w.oracle.note(backing, value);
  s.submit(w.oracle.prove(s, "issue", [], [n], [], { backing, quantity: value }));
  return n;
}
function payment(w: World, s: Service, n: Note, root = anchor(s, n), paddingBacking = n.backing) {
  const padding = w.oracle.note(paddingBacking, 0n), out = w.oracle.note(n.backing, n.value);
  const change = w.oracle.note(n.backing, 0n);
  return { out, statement: w.oracle.prove(s, "spend", [n, padding], [out, change], [root, root]) };
}
function fixture(departures: Departures = {}) {
  const w = new World(1n, departures);
  w.register("X", "P"); w.register("Y", "P");
  const p = w.open("P", ["Y", "X"]);
  settle(w, p.commit());
  const x = issue(w, p, "X"), y = issue(w, p, "Y");
  const base = p.commit(); settle(w, base);
  return { w, p, x, y, base };
}

describe("C2b.1 prospective revocation over shared pool history", () => {
  it("retains old issuance through continued spend, burn and replacement", () => {
    const f = fixture(); f.w.tick(); f.w.revoke("X");
    const pay = payment(f.w, f.p, f.x); f.p.submit(pay.statement); settle(f.w, f.p.commit());
    const padding = f.w.oracle.note("X", 0n), change = f.w.oracle.note("X", 60n), root = anchor(f.p, pay.out);
    f.p.submit(f.w.oracle.prove(f.p, "burn", [pay.out, padding], [change], [root, root], { backing: "X", quantity: 40n }));
    const later = f.p.commit(); settle(f.w, later);
    const { q } = split(f);
    expect(q.view().totals.get("X")).toBe(60n);
    expect(f.w.import(later.id).totals.get("X")).toBe(60n);
  });

  it.each([0n, 1n])("refuses a signed batch first witnessed %s indices after revocation", delay => {
    const f = fixture(); issue(f.w, f.p, "X"); const late = f.p.commit();
    f.w.tick(); f.w.revoke("X"); if (delay > 0n) f.w.tick(delay);
    expect(f.w.include(late)).toBe("invalid");
    expect(() => f.w.import(late.id)).toThrow("not finalized");
    expect(() => f.p.change(["X", "Y"])).toThrow();
  });

  it("a higher same-index sequence cannot repair newly revoked issuance", () => {
    const w = new World(0n); w.register("X", "P");
    const p = w.open("P", ["X"]); settle(w, p.commit()); w.tick(); w.revoke("X");
    issue(w, p, "X"); expect(w.include(p.commit())).toBe("invalid");
    // A hostile operator bypasses the honest service's current-evidence gate.
    expect(w.include(w.sign(p))).toBe("invalid");
  });

  it("a revocation appended at the same index changes a fresh historical read", () => {
    const f = fixture(); f.w.revoke("X");
    expect(() => f.w.import(f.base.id)).toThrow("revoked issuance");
  });

  it("revokes all backings of one obligor only on this venue, and never moves the cutoff", () => {
    const w = new World(0n); w.register("X", "P", "D", "K"); w.register("Y", "P", "D", "K");
    const p = w.open("P", ["X", "Y"]); settle(w, p.commit());
    w.tick(); w.revoke("K"); w.tick(); w.revoke("K");
    issue(w, p, "Y"); expect(w.include(p.commit())).toBe("invalid");
    const other = new World(0n); other.register("Y", "P", "D", "K");
    const service = other.open("P", ["Y"]); settle(other, service.commit()); issue(other, service, "Y");
    settle(other, service.commit());
  });

  it("withholding earlier final history blocks import rather than licensing fallback", () => {
    const f = fixture(); f.w.tick(); f.w.revoke("X");
    const later = f.p.commit(); settle(f.w, later); f.w.withheld.add(f.base.id);
    expect(() => f.w.import(later.id)).toThrow("unavailable pre-revocation evidence");
  });

  it("the departure admitting revoked issuance produces a concrete invalid supply", () => {
    const f = fixture({ ignoreRevocation: true }); f.w.tick(); f.w.revoke("X");
    issue(f.w, f.p, "X"); const late = f.p.commit(); settle(f.w, late);
    expect(f.w.import(late.id).totals.get("X")).toBe(200n);
  });
});
function split(f: ReturnType<typeof fixture>) {
  const { w, p } = f;
  w.replace("X", "Q"); w.tick(2n * w.lag + 1n);
  const q = w.open("Q", ["X"]), py = p.change(["Y"]);
  const qc = q.commit(), pc = py.commit(); settle(w, qc); settle(w, pc);
  return { q, py };
}
function reunite(f: ReturnType<typeof fixture>, py: Service, override?: ReadonlyMap<string, string | null>) {
  f.w.replace("X", "P"); f.w.tick(2n * f.w.lag + 1n);
  const pxy = override ? f.w.open("P", ["X", "Y"], "D", override) : py.change(["X", "Y"]);
  settle(f.w, pxy.commit());
  return pxy;
}

describe("C2.7/C2.10.4 exact directory descent before replay", () => {
  function child(w: World, operator = "P", sequence = 1n << 64n) { return { operator, sequence, at: w.now }; }

  it("retains same-index predecessors and excludes the child and later sequences", () => {
    const w = new World(0n); w.register("X", "P");
    const p = w.open("P", ["X"]), first = p.commit(); settle(w, first);
    const second = p.commit(); settle(w, second);
    expect(w.predecessorFor("X", child(w, "P", second.sequence))).toBe(first.id);
    const later = p.commit(); settle(w, later);
    expect(w.predecessorFor("X", child(w, "P", second.sequence))).toBe(first.id);
    expect(w.predecessorFor("X", child(w, "Q"))).toBeNull();
  });

  it("has a wrong-genesis counterexample if same-index predecessors are skipped", () => {
    const w = new World(0n, { skipSameIndex: true }); w.register("X", "P");
    const p = w.open("P", ["X"]), first = p.commit(); settle(w, first);
    expect(w.latestFor("X")).toBe(first.id);
    expect(w.predecessorFor("X", child(w))).toBeNull();
  });

  it("passes authenticated omission without history but refuses a missing directory", () => {
    const { w, p, base } = fixture();
    const omit = w.sign(p, ["Y"]); w.tick(); expect(w.include(omit)).toBe("invalid");
    w.withheld.add(omit.id); w.withheldScopes.add(omit.id);
    expect(w.predecessorFor("X", child(w))).toBe(base.id);
    w.withheldDirectories.add(omit.id);
    expect(() => w.predecessorFor("X", child(w))).toThrow("unavailable directory");
  });

  it("never substitutes an older valid checkpoint for present invalid or withheld history", () => {
    const { w, p, base } = fixture();
    const invalid = w.sign(p, ["X"]); w.tick(); expect(w.include(invalid)).toBe("invalid");
    w.withheld.add(invalid.id);
    expect(w.predecessorFor("X", child(w))).toBe(invalid.id);
    expect(() => w.import(invalid.id)).toThrow("unavailable history");
    w.withheldScopes.add(invalid.id);
    expect(() => w.predecessorFor("X", child(w))).toThrow("unavailable scope");
    const broken = fixture({ skipLiveInvalid: true });
    const bad = broken.w.sign(broken.p, ["X"]); broken.w.tick(); broken.w.include(bad);
    expect(broken.w.predecessorFor("X", child(broken.w))).toBe(broken.base.id);
    expect(invalid.id).not.toBe(base.id);
  });

  it("passes a whole-scope lapse with authenticated scope even when its statements are withheld", () => {
    const { w, p, base } = fixture();
    const late = p.commit(["Y"]); w.replace("X", "Q"); w.tick(3n);
    expect(w.include(late)).toBe("lapsed"); w.withheld.add(late.id);
    expect(w.predecessorFor("Y", child(w))).toBe(base.id);
    w.withheldScopes.add(late.id);
    expect(() => w.predecessorFor("Y", child(w))).toThrow("unavailable scope");
  });

  it("does not let a substituted old scope manufacture lapse for a live checkpoint", () => {
    for (const trustShownScope of [false, true]) {
      const f = fixture({ trustShownScope }), { w, p, base } = f;
      w.replace("X", "Q"); w.tick(3n);
      const py = p.change(["Y"]), current = py.commit(); settle(w, current);
      w.shownScopes.set(current.id, base.scope);
      if (trustShownScope) expect(w.predecessorFor("Y", child(w))).toBe(base.id);
      else expect(() => w.predecessorFor("Y", child(w))).toThrow("unauthenticated scope");
    }
  });

  it("reaches through never-committing terms and same-key reappointment", () => {
    const f = fixture(), { w, base } = f;
    w.replace("X", "Q"); w.tick(3n);
    w.replace("X", "P"); w.tick(3n);
    expect(w.predecessorFor("X", child(w))).toBe(base.id);
    expect(w.predecessorFor("X", child(w))).toBe(w.latestFor("X"));
  });

  it("exposes an older-state substitution if unavailable steps are silently skipped", () => {
    const f = fixture({ skipUnprovenSteps: true });
    const latest = f.p.commit(); settle(f.w, latest);
    f.w.withheldDirectories.add(latest.id);
    expect(f.w.predecessorFor("X", child(f.w))).toBe(f.base.id);
    expect(f.w.latestFor("X")).toBe(latest.id);
  });
});

describe("C1.2/C2.10 private scope authority and finalized import", () => {
  it("constructs current openings from the latest same-index record before signing a child", () => {
    const w = new World(0n); w.register("X", "P");
    const p = w.open("P", ["X"]), first = p.commit(); settle(w, first);
    const second = p.commit(); settle(w, second);
    expect(w.currentFor("X", "P")).toBe(second.id);
    const next = p.change(["X"]);
    expect(next.openings.get("X")).toBe(second.id);
    w.withheldDirectories.add(second.id);
    expect(() => w.currentFor("X", "P")).toThrow("unavailable directory");
  });

  it("derives deadlines from every current scope term and rejects the old scope after same-key reappointment", () => {
    const { w, p } = fixture();
    expect(w.boundaries(p.scope)).toEqual([]);
    w.replace("X", "Q", w.now + 4n);
    w.replace("Y", "R", w.now + 8n);
    expect(w.boundaries(p.scope)).toEqual([w.now + 4n, w.now + 8n]);
    const oldAt = w.now;
    w.tick(4n);
    expect(w.current(p.scope)).toBe(false);
    expect(w.current(p.scope, oldAt)).toBe(true);
    expect(() => w.boundaries(p.scope)).toThrow("scope term ended");
    w.replace("X", "P"); w.tick(3n);
    expect(w.term("X").operator).toBe("P");
    expect(w.current(p.scope)).toBe(false); // the key returned; the original link did not
    expect(() => w.boundaries(p.scope)).toThrow("scope term ended");
  });

  it("splits and rejoins shared history once, with distinct input anchors and immutable nullifiers", () => {
    const f = fixture(), { w, x, y } = f, { q, py } = split(f);
    const xp = payment(w, q, x), yp = payment(w, py, y);
    q.submit(xp.statement); py.submit(yp.statement);
    settle(w, q.commit()); settle(w, py.commit());
    const p = reunite(f, py);
    expect(p.view().events.size).toBe(4);
    expect([...p.view().totals]).toEqual([["X", 100n], ["Y", 100n]]);
    expect(p.view().spent.has(x.nf)).toBe(true);
    expect(() => p.submit(payment(w, p, x).statement)).toThrow("spent conflict");
    const inputs = [xp.out, yp.out], outputs = [w.oracle.note("X", 100n), w.oracle.note("Y", 100n)];
    const anchors = inputs.map(n => anchor(p, n));
    expect(anchors[0]).not.toBe(anchors[1]);
    const mixed = w.oracle.prove(p, "spend", inputs, outputs, anchors);
    expect(Object.keys(mixed)).not.toContain("backing");
    p.submit(mixed); settle(w, p.commit());
    expect(w.violations()).toEqual([]);
  });

  it("checks every hidden backing, including padding, plus domain and operator authority", () => {
    const f = fixture(), { w, x } = f, { q } = split(f);
    expect(() => w.open("P", ["X"])).toThrow("wrong operator");
    expect(() => q.submit(payment(w, q, x, anchor(q, x), "Y").statement)).toThrow("proof");
    expect(() => q.submit(w.oracle.prove(q, "issue", [], [w.oracle.note("X", 1n, "other")], [], { backing: "X", quantity: 1n }))).toThrow("proof");
    const wrong = new World(); wrong.register("X", "P");
    expect(() => wrong.open("P", ["X"], "other")).toThrow("wrong construction domain");
    const proof = payment(w, q, x).statement;
    expect(() => q.submit({ ...proof })).toThrow("proof");
    expect(() => q.submit(payment(w, f.p, x).statement)).toThrow("wrong segment");
    expect(w.violations()).toEqual([]);
  });

  it("has an otherwise valid unauthorized-backing counterexample when private scope membership is omitted", () => {
    const f = fixture({ ignoreScope: true }), { q } = split(f);
    const foreign = f.w.oracle.note("Y", 1n);
    q.submit(f.w.oracle.prove(q, "issue", [], [foreign], [], { backing: "Y", quantity: 1n }));
    settle(f.w, q.commit());
    expect(f.w.violations()).toContain("unauthorized backing");
  });

  it("expires a delayed checkpoint for the whole scope and keeps finalized roots only", () => {
    const f = fixture(), { w, p, y, base } = f;
    const ghost = payment(w, p, y); p.submit(ghost.statement);
    const abandonedRoot = p.root(), late = p.commit();
    const { q, py } = split(f);
    // The old signed sequence cannot be included after P has published a newer one.
    expect(() => w.include(late)).toThrow("sequence moved past");
    expect(py.view().roots.has(abandonedRoot)).toBe(false);
    expect(() => py.submit(payment(w, py, ghost.out, abandonedRoot).statement)).toThrow("proof");
    expect(q.view().roots.has(anchor(f.p, f.x))).toBe(true);
    expect(w.record(base.id).status).toBe("final");

    const g = fixture(), tail = payment(g.w, g.p, g.x);
    g.p.submit(tail.statement); const c = g.p.commit();
    g.w.replace("X", "Q"); g.w.tick(3n);
    expect(g.w.include(c)).toBe("lapsed");
    expect(g.w.latestFor("X")).toBe(g.base.id);
    expect(g.w.latestFor("Y")).toBe(g.base.id);
    expect(g.w.record(c.id).checkpoint.sequence).toBe(c.sequence);
    expect(g.w.violations()).toEqual([]);
  });

  it("exposes unauthorized finality if a departed backing is selectively removed from carriage", () => {
    const f = fixture({ partialFinality: true }), { w, p, x } = f;
    p.submit(payment(w, p, x).statement); const late = p.commit(["Y"]);
    w.replace("X", "Q"); w.tick(3n);
    expect(w.include(late)).toBe("final");
    expect(w.violations()).toContain("unauthorized backing");
  });

  it("rejects a stale predecessor even when the original operator returns", () => {
    const f = fixture(), { q, py } = split(f);
    q.submit(payment(f.w, q, f.x).statement); settle(f.w, q.commit());
    const stale = new Map([["X", f.base.id], ["Y", f.w.latestFor("Y")]]);
    expect(() => reunite(f, py, stale)).toThrow("stale predecessor");
  });

  it.each(["ignorePredecessor", "forgetSpent"] as const)("finds a cross-term double spend when %s is enabled", departure => {
    const f = fixture({ [departure]: true }), { q, py } = split(f);
    q.submit(payment(f.w, q, f.x).statement); settle(f.w, q.commit());
    const stale = departure === "ignorePredecessor" ? new Map([["X", f.base.id], ["Y", f.w.latestFor("Y")]]) : undefined;
    const p = reunite(f, py, stale);
    p.submit(payment(f.w, p, f.x).statement); settle(f.w, p.commit());
    expect(f.w.violations()).toContain("double spend");
  });

  it("finds duplicated issuance if shared ancestor events are not deduplicated", () => {
    const f = fixture({ countSharedTwice: true }), { py } = split(f);
    const p = reunite(f, py);
    expect(p.view().totals.get("X")).toBe(200n);
    expect(p.view().totals.get("Y")).toBe(200n);
  });

  it("shows the unsatisfiable receipt caused by retaining an abandoned root", () => {
    const f = fixture({ retainAbandoned: true });
    const ghost = payment(f.w, f.p, f.y); f.p.submit(ghost.statement);
    const root = f.p.root();
    const { py } = split(f);
    py.submit(payment(f.w, py, ghost.out, root).statement);
    const c = py.commit(); f.w.tick();
    expect(f.w.include(c)).toBe("invalid");
  });

  it("refuses unavailable transitive history even if a descendant was already verified", () => {
    const f = fixture(), { py } = split(f);
    f.w.withheld.add(f.base.id);
    expect(() => f.w.import(f.w.latestFor("Y")!)).toThrow("unavailable history");
    expect(() => py.change(["Y"])).toThrow("unavailable history");
  });

  it("does not silently skip a live but invalid carrying candidate", () => {
    const f = fixture(), c = f.p.commit(["Y"]); f.w.tick();
    expect(f.w.include(c)).toBe("invalid");
    expect(f.w.latestFor("Y")).toBe(c.id);
    expect(() => f.p.submit(payment(f.w, f.p, f.y).statement)).toThrow("invalid current evidence");
    f.w.replace("Y", "Q"); f.w.tick(3n);
    expect(() => f.w.open("Q", ["Y"])).toThrow("not finalized");
  });

  it("does not treat an invented scope link as proof that a term ended", () => {
    const f = fixture();
    const scope = { ...f.p.scope, entries: f.p.scope.entries.map(e => ({ ...e, link: "invented" })) };
    const forged = new Service(f.w, "forged", scope, new Map(f.p.openings), f.p.view());
    const c = f.w.sign(forged); f.w.tick();
    expect(f.w.include(c)).toBe("invalid");
    expect(f.w.latestFor("X")).toBe(c.id);
  });

  it("cannot borrow another operator's ended term to excuse invalid incumbent evidence", () => {
    const f = fixture(); f.w.register("Z", "Q"); const ended = f.w.term("Z");
    f.w.replace("Z", "P"); f.w.tick(3n);
    const scope = { ...f.p.scope, entries: [...f.p.scope.entries, ended] };
    const forged = new Service(f.w, "forged", scope, new Map([...f.p.openings, ["Z", null]]), f.p.view());
    const c = f.w.sign(forged); f.w.tick();
    expect(f.w.include(c)).toBe("invalid"); expect(f.w.latestFor("Y")).toBe(c.id);
  });

  it("checks the immutable header before allowing a known segment to lapse", () => {
    const f = fixture(); f.w.replace("X", "Q"); f.w.tick(3n);
    const scope = { ...f.p.scope, root: "changed" };
    const forged = new Service(f.w, f.p.id, scope, new Map(f.p.openings), f.p.view());
    const c = f.w.sign(forged); f.w.tick();
    expect(f.w.include(c)).toBe("invalid"); expect(f.w.latestFor("Y")).toBe(c.id);
    expect(f.w.latestFor("X")).toBe(f.base.id); // P no longer speaks for X
  });

  it("allows ordered same-index checkpoints only under one operator", () => {
    const w = new World(0n); w.register("X", "P");
    const p = w.open("P", ["X"]); settle(w, p.commit());
    issue(w, p, "X"); const next = p.commit(); settle(w, next);
    const reset = p.change(["X"]); settle(w, reset.commit());
    expect(w.records.every(r => r.at === 0n)).toBe(true);
    expect(w.records.map(r => r.checkpoint.sequence)).toEqual([1n, 2n, 3n]);
    w.replace("X", "Q"); w.tick();
    const q = w.open("Q", ["X"]); settle(w, q.commit());
    expect(w.violations()).toEqual([]);
  });

  it("refuses elective reset until both receipted tail and latest signed checkpoint are witnessed", () => {
    const f = fixture(), pay = payment(f.w, f.p, f.x);
    f.p.submit(pay.statement);
    expect(() => f.p.change(["Y"])).toThrow("live tail");
    expect(() => f.w.open("P", ["X", "Y"])).toThrow("live tail");
    const dropped = f.p.commit(); f.w.tick();
    expect(() => f.p.change(["Y"])).toThrow("live tail");
    const retry = f.p.commit(); expect(retry.sequence).toBe(dropped.sequence + 1n);
    expect(retry.events).toEqual(dropped.events); settle(f.w, retry);
    expect(f.p.change(["Y"]).view().spent.has(f.x.nf)).toBe(true);
    expect(() => f.w.include(dropped)).toThrow("sequence moved past");
  });

  it("restores live receipts and signed sequence, waits lag, and returns the original receipt on reproof", () => {
    const f = fixture(), pay = payment(f.w, f.p, f.x);
    const receipt = f.p.submit(pay.statement), pending = f.p.commit();
    const resumed = f.p.restart();
    expect(() => resumed.commit()).toThrow("restart lag");
    f.w.tick();
    expect(resumed.submit(pay.statement)).toBe(receipt);
    expect(() => resumed.change(["Y"])).toThrow("live tail");
    const retry = resumed.commit(); expect(retry.sequence).toBe(pending.sequence + 1n);
    settle(f.w, retry); expect(resumed.finalized()).toBe(true);
    const inputs = [f.y, f.w.oracle.note("Y", 0n)], outputs = [f.w.oracle.note("Y", 100n), f.w.oracle.note("Y", 0n)];
    const roots = [anchor(resumed, f.y), anchor(resumed, f.y)];
    const s1 = f.w.oracle.prove(resumed, "spend", inputs, outputs, roots);
    const s2 = f.w.oracle.prove(resumed, "spend", inputs, outputs, roots);
    expect(s1).not.toBe(s2); expect(s1.id).toBe(s2.id);
    expect(resumed.submit(s2)).toBe(resumed.submit(s1));
    expect(() => f.w.open("P", ["Y"])).toThrow("live tail");
  });

  it("retires the old journal on restart and refuses to revive it", () => {
    const f = fixture(), twin = f.p.restart(); f.w.tick();
    twin.submit(payment(f.w, twin, f.x).statement); settle(f.w, twin.commit());
    expect(() => f.p.submit(payment(f.w, f.p, f.y).statement)).toThrow("retired journal");
    expect(() => f.p.restart()).toThrow("retired journal");
  });

  it("retires the prior service immediately on elective scope change", () => {
    const f = fixture(), next = f.p.change(["Y"]), opening = next.commit();
    expect(() => f.p.submit(payment(f.w, f.p, f.x).statement)).toThrow("retired journal");
    expect(() => f.p.commit()).toThrow("retired journal");
    expect(() => f.p.restart()).toThrow("retired journal");
    settle(f.w, opening);
  });

  it("rechecks immutable segment openings against a hostile signed continuation", () => {
    const f = fixture(), next = f.p.change(["X", "Y"]); settle(f.w, next.commit());
    const forged = new Service(f.w, next.id, next.scope, new Map([["X", null], ["Y", null]]), next.view());
    const c = f.w.sign(forged); f.w.tick();
    expect(f.w.include(c)).toBe("invalid");
    expect(() => f.w.import(c.id)).toThrow("not finalized");
  });

  it.each(["domain", "opening shape"])("rechecks %s independently of honest service opening", variant => {
    const f = fixture();
    const scope = variant === "domain" ? Object.freeze({ ...f.p.scope, domain: "other" }) : f.p.scope;
    const openings = variant === "opening shape" ? new Map([["X", f.base.id]]) : new Map(f.base.scope.entries.map(e => [e.backing, f.base.id]));
    const forged = new Service(f.w, "hostile-segment", scope, openings, f.p.view());
    const c = f.w.sign(forged);
    f.w.tick(); expect(f.w.include(c)).toBe("invalid");
  });

  it("independently rejects a same-index cross-operator import", () => {
    // Disable the predecessor check to isolate the causal-rank rule.
    const w = new World(0n, { ignorePredecessor: true });
    w.register("X", "P"); w.register("Y", "P");
    const p = w.open("P", ["X", "Y"]); settle(w, p.commit());
    w.replace("X", "Q"); w.tick();
    const py = p.change(["Y"]), parent = py.commit(); settle(w, parent);
    const q = w.open("Q", ["X"]);
    const forged = new Service(w, q.id, q.scope, new Map([["X", parent.id]]), q.view());
    expect(w.include(w.sign(forged))).toBe("invalid");
  });

  it("binds checkpoint contents as immutable signature tokens", () => {
    const f = fixture(), c = f.p.commit();
    expect(Object.isFrozen(c.openings)).toBe(true);
    expect(Object.isFrozen(c.openings[0])).toBe(true);
    expect(Object.isFrozen(c.scope.entries[0])).toBe(true);
    f.w.tick();
    expect(() => f.w.include({ ...c })).toThrow("not signed");
  });

  it("snapshots hostile mutable scope and event records before signing", () => {
    const f = fixture(), entries = f.p.scope.entries.map(e => ({ ...e }));
    const scope = { ...f.p.scope, entries };
    const forged = new Service(f.w, f.p.id, scope, new Map(f.p.openings), f.p.view());
    const events = f.p.events.map(e => ({ ...e })); forged.events.push(...events);
    const c = f.w.sign(forged);
    entries[0]!.operator = "attacker"; scope.domain = "other"; events[0]!.id = "rewritten";
    settle(f.w, c);
    expect(c.scope.domain).toBe("D");
    expect(c.events[0]!.id).toBe(f.p.events[0]!.id);
    expect(f.w.violations()).toEqual([]);
  });

  it("carries lit burn deltas once through shared imports", () => {
    const f = fixture(), change = f.w.oracle.note("X", 60n), padding = f.w.oracle.note("X", 0n);
    const root = anchor(f.p, f.x);
    f.p.submit(f.w.oracle.prove(f.p, "burn", [f.x, padding], [change], [root, root], { backing: "X", quantity: 40n }));
    settle(f.w, f.p.commit());
    const { py } = split(f), p = reunite(f, py);
    expect(p.view().totals.get("X")).toBe(60n);
    expect(p.view().spent.has(f.x.nf)).toBe(true);
    expect(p.view().roots.has(anchor(p, change))).toBe(true);
    expect(f.w.violations()).toEqual([]);
  });

  it("rejects missing issuance authority, quantity overflow and duplicate notes without changing state", () => {
    const f = fixture(), before = f.p.view();
    const n = f.w.oracle.note("X", 1n);
    expect(() => f.p.submit(f.w.oracle.prove(f.p, "issue", [], [n], [], { backing: "X", quantity: 1n }, false))).toThrow("proof");
    expect(() => issue(f.w, f.p, "X", 1n << 64n)).toThrow("proof");
    expect(() => issue(f.w, f.p, "X", (1n << 64n) - 1n)).toThrow("supply bound");
    const root = anchor(f.p, f.x), n200 = f.w.oracle.note("X", 200n), zero = f.w.oracle.note("X", 0n);
    expect(() => f.p.submit(f.w.oracle.prove(f.p, "spend", [f.x, f.x], [n200, zero], [root, root]))).toThrow("spent conflict");
    expect(f.p.view()).toEqual(before);
  });

  it("conserves supply through repeated split/rejoin histories and alternating spends", () => {
    for (let seed = 0; seed < 16; seed++) {
      const f = fixture(); let p = f.p, x = f.x, y = f.y;
      for (let round = 0; round < 4; round++) {
        const { q, py } = split({ ...f, p });
        for (const [s, n] of ((seed >> round) & 1 ? [[q, x], [py, y]] : [[py, y], [q, x]]) as [Service, Note][]) {
          const pay = payment(f.w, s, n); s.submit(pay.statement); settle(f.w, s.commit());
          if (n.backing === "X") x = pay.out; else y = pay.out;
        }
        p = reunite(f, py);
        expect(p.view().totals.get("X")).toBe(100n);
        expect(p.view().totals.get("Y")).toBe(100n);
        expect(f.w.violations()).toEqual([]);
      }
    }
  });
});
