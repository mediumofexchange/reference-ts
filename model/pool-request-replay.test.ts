import { describe, expect, it } from "vitest";
import { ProofOracle, type Checkpoint, type Note, type Service, type Statement } from "./pool-authority.js";
import { statementDigest } from "./pool-evidence.js";
import { RecoveryWorld } from "./pool-recovery.js";

const CLAUSE = { noCommitment: 50n, nonService: { duration: 2n, count: 1n, window: 5n } };

function witness(w: RecoveryWorld, checkpoint: Checkpoint): void {
  if (w.now < checkpoint.signedAt + w.lag) w.tick(checkpoint.signedAt + w.lag - w.now);
  expect(w.include(checkpoint)).toBe("final");
}

function fixture(backings: readonly string[] = ["X"]): { w: RecoveryWorld; p: Service; note: Note } {
  const w = new RecoveryWorld(1n);
  for (const backing of backings) {
    w.register(backing, "P");
    w.declare(backing, CLAUSE);
  }
  const p = w.open("P", backings);
  witness(w, p.commit());
  const note = w.oracle.note("X", 10n, "D", "holder");
  p.submit(w.oracle.prove(p, "issue", [], [note], [], { backing: "X", quantity: note.value }));
  witness(w, p.commit());
  return { w, p, note };
}

function request(w: RecoveryWorld, p: Service, note: Note, refresh: bigint): Statement {
  return w.oracle.prove(ProofOracle.unbound(), "request", [note], [], [p.root()],
    { backing: note.backing, quantity: 0n, refresh });
}

describe("C2b.5.1–2 request identity, refresh and first witness", () => {
  it("keeps proof variants and exact copies at the identity's first witnessed index", () => {
    const { w, p, note } = fixture();
    const first = request(w, p, note, 0n);
    const variant = request(w, p, note, 0n);
    expect(w.oracle.evidence(variant).proof).not.toBe(w.oracle.evidence(first).proof);
    expect(statementDigest(variant)).toBe(statementDigest(first));

    w.publish({ kind: "request", backing: "X", statement: first }); // at 2
    w.tick(2n);
    const malformed = Object.freeze({ ...first, lit: Object.freeze({ ...first.lit! }) });
    w.publish({ kind: "request", backing: "X", statement: malformed });
    expect(w.count("X", 4n).count).toBe(1n); // a later bad copy does not shadow the valid proof
    w.tick(4n);
    w.publish({ kind: "request", backing: "X", statement: variant }); // at 8
    w.publish({ kind: "request", backing: "X", statement: first });

    expect(w.count("X", 10n)).toMatchObject({ count: 0n, fires: false });
  });

  it("keeps the first identity index but verifies a valid variant witnessed by the judging index", () => {
    const { w, p, note } = fixture();
    const valid = request(w, p, note, 0n);
    const invalid = Object.freeze({ ...valid, lit: Object.freeze({ ...valid.lit! }) });
    w.publish({ kind: "request", backing: "X", statement: invalid }); // at 2
    expect(w.count("X", 4n).count).toBe(0n);

    w.tick(2n);
    w.publish({ kind: "request", backing: "X", statement: valid }); // at 4, same identity
    expect(statementDigest(invalid)).toBe(statementDigest(valid));
    expect(w.count("X", 4n).count).toBe(0n); // proof evidence at the judging index is not in its prefix
    expect(w.count("X", 5n).count).toBe(1n); // identity remains indexed at 2 once proof is available
  });

  it("ignores a malformed request without aborting or suppressing a valid request", () => {
    const { w, p, note } = fixture();
    const valid = request(w, p, note, 0n);
    const malformed = Object.freeze({ ...valid,
      lit: Object.freeze({ ...valid.lit!, refresh: 0 as unknown as bigint }) });
    w.publish({ kind: "request", backing: "X", statement: malformed });
    w.publish({ kind: "request", backing: "X", statement: valid });
    expect(w.count("X", 4n)).toMatchObject({ count: 1n, fires: true });
  });

  it("lets the holder refresh the same note and anchor while still counting its tag once", () => {
    const { w, p, note } = fixture();
    const first = request(w, p, note, 0n);
    w.publish({ kind: "request", backing: "X", statement: first }); // at 2
    w.tick();
    const refreshed = request(w, p, note, 1n);
    w.publish({ kind: "request", backing: "X", statement: refreshed }); // at 3

    expect(refreshed.anchors).toEqual(first.anchors);
    expect(refreshed.lit!.tag).toBe(first.lit!.tag);
    expect(statementDigest(refreshed)).not.toBe(statementDigest(first));
    expect(w.count("X", 5n).count).toBe(1n); // both identities are eligible, one tag
    expect(w.count("X", 8n)).toMatchObject({ count: 1n, fires: true }); // only the refresh remains
  });

  it("does not let old proof bytes authorize a changed refresh", () => {
    const { w, p, note } = fixture();
    const first = request(w, p, note, 0n);
    const changed = Object.freeze({ ...first, lit: Object.freeze({ ...first.lit!, refresh: 1n }) });
    expect(statementDigest(changed)).not.toBe(statementDigest(first));
    expect(w.oracle.verifyEvidence(changed, w.oracle.evidence(first), p.scope, p.view().roots, {})).toBe(false);
    expect(w.oracle.verify(changed, p.scope, p.view().roots, {})).toBe(false);

    w.publish({ kind: "request", backing: "X", statement: changed });
    expect(w.count("X", 4n)).toMatchObject({ count: 0n, fires: false });
  });

  it("accepts refresh endpoints and rejects values outside the unsigned 64-bit range", () => {
    const { w, p, note } = fixture();
    const verifies = (refresh: bigint) => w.oracle.verify(request(w, p, note, refresh), p.scope, p.view().roots, {});
    expect(verifies(0n)).toBe(true);
    expect(verifies((1n << 64n) - 1n)).toBe(true);
    expect(verifies(-1n)).toBe(false);
    expect(verifies(1n << 64n)).toBe(false);
  });

  it("includes both request-window endpoints and excludes the adjacent indices", () => {
    const { w, p, note } = fixture();
    w.publish({ kind: "request", backing: "X", statement: request(w, p, note, 0n) }); // at 2
    expect(w.count("X", 3n).count).toBe(0n);
    expect(w.count("X", 4n).count).toBe(1n);
    expect(w.count("X", 7n).count).toBe(1n);
    expect(w.count("X", 8n).count).toBe(0n);
  });

  it("does not let a wrong routing backing pin the request's correct backing", () => {
    const { w, p, note } = fixture(["X", "Y"]);
    const statement = request(w, p, note, 0n);
    w.publish({ kind: "request", backing: "Y", statement }); // at 2: routing and proof disagree
    w.tick();
    w.publish({ kind: "request", backing: "X", statement }); // at 3: first witness naming X

    expect(w.count("X", 4n).count).toBe(0n);
    expect(w.count("X", 5n).count).toBe(1n);
    expect(w.count("Y", 5n).count).toBe(0n);
  });
});
