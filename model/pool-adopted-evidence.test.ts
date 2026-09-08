// C2b.4.2 and C2.10.10: adoption retains the publication's exact evidence.
// Its statement remains bound to the old scope; receipts name the new segment.
import { describe, expect, it } from "vitest";
import { Service, type Acceptance, type Checkpoint, type Statement } from "./pool-authority.js";
import { evidenceChain, evidenceHashes, statementDigest } from "./pool-evidence.js";
import { FaultWorld } from "./pool-fault.js";

function witness(w: FaultWorld, checkpoint: Checkpoint): void {
  w.tick();
  expect(w.include(checkpoint)).toBe("final");
  expect(w.classification(checkpoint.id)).toBe("valid");
}

function fixture() {
  const w = new FaultWorld(1n);
  w.register("X", "P"); w.declare("X", { noCommitment: 5n });
  const p = w.open("P", ["X"]); witness(w, p.commit());
  const note = w.oracle.note("X", 10n, "D", "holder");
  const untouched = w.oracle.note("X", 4n, "D", "other-holder");
  const issuedReceipts = [note, untouched].map(n =>
    p.submit(w.oracle.prove(p, "issue", [], [n], [], { backing: "X", quantity: n.value })));
  const issued = p.commit(); witness(w, issued); // at 2
  const inputs = [note, w.oracle.note("X", 0n)], anchors = [p.root(), p.root()];
  w.tick(6n); // silence at 8; the publication's force is fixed at that index
  expect(w.gapOpen("X", w.now)).toBe(true);
  const demand = w.oracle.prove(p, "demand", inputs, [], anchors, {
    backing: "X", quantity: 10n, presenter: "holder", instant: 7n, deadline: 28n,
  });
  const acceptance = { demand: demand.id, owner: "backer-owner", deadline: 28n, signedByK: true } satisfies Acceptance;
  const returned = w.oracle.note("X", 10n, "D", acceptance.owner);
  const settle = w.oracle.prove(p, "settle", inputs, [returned], anchors, {
    backing: "X", quantity: 10n, presenter: "holder", owner: acceptance.owner, demand: demand.id, acceptance,
  });
  const originals = [demand, settle].map(s => w.oracle.evidence(s));
  const demandPublication = { kind: "demand" as const, backing: "X", statement: demand };
  const publishedDemand = w.publish(demandPublication);
  w.publish({ kind: "acceptance", backing: "X", acceptance });
  const release = w.publish({ kind: "release", backing: "X", statement: settle });
  const force = [publishedDemand, release];
  expect(w.recoveryState("X", 9n).force).toEqual(force);
  const next = w.open("P", ["X"]), opening = next.commit(); witness(w, opening); // at 9
  expect(next.openings.get("X")).toBe(issued.id);
  expect(w.block(next.id, next.openings).map(a => a.witnessed)).toEqual(force);
  function reprove(s: Statement): Statement {
    return w.oracle.prove(p, s.kind, inputs, s.kind === "settle" ? [returned] : [], anchors, s.lit);
  }
  return { w, p, note, untouched, returned, issued, issuedReceipts, next, opening, demand, settle, acceptance,
    demandPublication, publishedDemand, originals, force, reprove };
}
type Fixture = ReturnType<typeof fixture>;

function assertEarlierForceAndHoldings(f: Fixture): void {
  const { w, issued, note, untouched, returned, p, issuedReceipts, force } = f;
  const earlier = w.import(issued.id);
  for (const n of [note, untouched]) {
    expect(earlier.outputs.has(n.cm)).toBe(true);
    expect(earlier.spent.has(n.nf)).toBe(false);
  }
  for (const receipt of issuedReceipts) expect(w.classify(receipt, p.scope).status).toBe("final");
  const recovered = w.recoveryState("X", 9n);
  expect(recovered.force).toEqual(force);
  expect(recovered.state.spent.has(note.nf)).toBe(true);
  expect(recovered.state.outputs.has(returned.cm)).toBe(true);
  expect(recovered.state.spent.has(untouched.nf)).toBe(false);
  expect(w.recoveryViolations()).toEqual([]);
}

describe("C2b.4.2 exact adopted publication evidence", () => {
  it("keeps the empty opening valid before adopting the mandatory publication block", () => {
    const f = fixture(), { w, opening, note, returned } = f;
    expect(opening.events).toEqual([]);
    expect(opening.evidenceHash).toBe(evidenceChain(opening.segment, []));
    expect(w.import(opening.id).outputs.has(note.cm)).toBe(true);
    expect(w.import(opening.id).outputs.has(returned.cm)).toBe(false);
    assertEarlierForceAndHoldings(f);
  });

  it("carries original proof and signature hashes into the new chain and receipts", () => {
    const f = fixture(), { w, p, next, opening, originals, demand, settle, returned, untouched } = f;
    const receipts = w.adoptGap(next);
    expect(receipts).toHaveLength(2);
    expect(next.events.map(e => e.statement.segment)).toEqual([p.id, p.id]);
    for (const [index, original] of originals.entries()) {
      expect(next.events[index]!.evidence).toEqual(original);
      expect(receipts[index]).toMatchObject({ ...evidenceHashes(original), segment: next.id,
        position: BigInt(index) + 1n, after: opening.sequence });
      expect(original.signature).toBe(""); // Neither adopted kind is an issue.
    }
    expect(next.adopt(demand)).toEqual(receipts[0]);
    expect(next.adopt(settle)).toEqual(receipts[1]);
    const adopted = next.commit(); witness(w, adopted);
    expect(adopted.evidenceHash).toBe(evidenceChain(next.id, [
      { statement: demand, evidence: originals[0]! }, { statement: settle, evidence: originals[1]! },
    ]));
    expect(adopted.evidenceHash).not.toBe(evidenceChain(p.id, adopted.events));
    for (const receipt of receipts) expect(w.classify(receipt, next.scope).status).toBe("final");
    const state = w.import(adopted.id);
    expect(state.outputs.has(returned.cm)).toBe(true);
    expect(state.outputs.has(untouched.cm)).toBe(true);
    expect(state.spent.has(untouched.nf)).toBe(false);
    assertEarlierForceAndHoldings(f);
  });

  it("retains finalized settlement evidence when the caller mutates its original acceptance", () => {
    const f = fixture(), { w, next, demand, settle, acceptance } = f;
    const receipts = w.adoptGap(next), adopted = next.commit(); witness(w, adopted);
    const digest = statementDigest(settle);
    const originalAcceptance = { ...acceptance };
    // This is the caller-owned object actually passed to the settlement proof.
    // Its replacement values would invalidate the acceptance relation.
    acceptance.owner = "other-owner"; acceptance.deadline = 0n; acceptance.demand = "other-demand";
    expect(acceptance).not.toEqual(originalAcceptance);
    expect(settle.lit!.acceptance).toEqual(originalAcceptance);
    expect(statementDigest(settle)).toBe(digest);
    expect(Object.isFrozen(settle.lit!.acceptance)).toBe(true);
    expect(Object.isFrozen(demand.lit!.tags)).toBe(true);
    expect(Reflect.set(demand.lit!.tags!, "0", "other-tag")).toBe(false);
    expect(w.classification(adopted.id)).toBe("valid");
    for (const receipt of receipts) expect(w.classify(receipt, next.scope).status).toBe("final");
    expect(w.import(adopted.id).outputs.has(f.returned.cm)).toBe(true);
    assertEarlierForceAndHoldings(f);
  });

  it("retains the witnessed publication when its caller substitutes an alternate proof", () => {
    const f = fixture(), { w, p, next, demand, demandPublication, publishedDemand, reprove } = f;
    const receipts = w.adoptGap(next), adopted = next.commit(); witness(w, adopted);
    const alternate = reprove(demand), alternateEvidence = w.oracle.evidence(alternate);
    expect(alternate.id).toBe(demand.id);
    expect(alternateEvidence.proof).not.toBe(w.oracle.evidence(demand).proof);
    expect(w.oracle.verifyEvidence(alternate, alternateEvidence, p.scope, next.view().roots, w.departures)).toBe(true);
    demandPublication.statement = alternate;
    expect(demandPublication.statement).toBe(alternate);
    expect(publishedDemand.publication).toEqual({ kind: "demand", backing: "X", statement: demand });
    expect(publishedDemand.publication).not.toBe(demandPublication);
    expect(Object.isFrozen(publishedDemand.publication)).toBe(true);
    if (publishedDemand.publication.kind !== "demand") throw new Error("fixture demand");
    expect(publishedDemand.publication.statement).toBe(demand);
    expect(w.classification(adopted.id)).toBe("valid");
    for (const receipt of receipts) expect(w.classify(receipt, next.scope).status).toBe("final");
    assertEarlierForceAndHoldings(f);
  });

  it.each(["demand", "settle"] as const)("excludes a committed valid reproof of the adopted %s", kind => {
    const f = fixture(), { w, p, next, demand, settle, reprove } = f;
    const originals = w.adoptGap(next);
    const original = kind === "demand" ? demand : settle, alternate = reprove(original);
    const alternateEvidence = w.oracle.evidence(alternate);
    expect(alternate.id).toBe(original.id);
    expect(statementDigest(alternate)).toBe(statementDigest(original));
    expect(alternateEvidence.proof).not.toBe(w.oracle.evidence(original).proof);
    expect(w.oracle.verifyEvidence(original, alternateEvidence, p.scope, next.view().roots, w.departures)).toBe(true);
    const hostile = new Service(w, next.id, next.scope, next.openings, next.view());
    hostile.events.push(...next.events.map(event => event.statement.id === original.id ?
      { ...event, evidence: alternateEvidence } : event));
    const bad = w.sign(hostile); w.tick();
    expect(bad.evidenceHash).toBe(evidenceChain(next.id, hostile.events));
    expect(w.include(bad)).toBe("invalid");
    expect(w.classification(bad.id)).toBe("excluded");
    expect(w.record(bad.id).reason).toBe("adopted evidence");
    expect(w.classification(f.opening.id)).toBe("valid");
    assertEarlierForceAndHoldings(f);
    // The excluded positions never finalized: restore the publication bytes.
    const repaired = next.commit(); witness(w, repaired);
    for (const receipt of originals) expect(w.classify(receipt, next.scope).status).toBe("final");
    expect(w.import(repaired.id).outputs.has(f.returned.cm)).toBe(true);
    assertEarlierForceAndHoldings(f);
  });

  it("treats replica-supplied alternate adopted evidence as unresolved until exact bytes return", () => {
    const f = fixture(), { w, p, next, settle, reprove } = f;
    const receipts = w.adoptGap(next), adopted = next.commit(); witness(w, adopted);
    const alternateEvidence = w.oracle.evidence(reprove(settle));
    expect(w.oracle.verifyEvidence(settle, alternateEvidence, p.scope, next.view().roots, w.departures)).toBe(true);
    const reader = w.reader();
    reader.supplyTrail(adopted.id, adopted.events.map(event => event.statement.id === settle.id ?
      { ...event, evidence: alternateEvidence } : event));
    expect(reader.classification(adopted.id)).toBe("unresolved");
    expect(() => reader.classify(receipts[1]!, next.scope)).toThrow("unresolved");
    expect(w.classification(adopted.id)).toBe("valid");
    assertEarlierForceAndHoldings(f);
    reader.supplyTrail(adopted.id, adopted.events);
    expect(reader.classification(adopted.id)).toBe("valid");
    expect(reader.classify(receipts[1]!, next.scope).status).toBe("final");
    expect(reader.import(adopted.id).outputs.has(f.returned.cm)).toBe(true);
  });
});
