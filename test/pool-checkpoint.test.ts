import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import { makeBacking, signBacking } from "../src/backing.js";
import { directoryRoot, signCommitment } from "../src/commitment.js";
import { PoolAuthorityView } from "../src/pool/authority.js";
import { readPoolCheckpoint, type PoolCheckpointEvidence } from "../src/pool/checkpoint.js";
import { PoolError, Segment, type SignedBacking, type StatementVerifier } from "../src/pool/segment.js";
import { genesisHistoryHash, segmentIdentity, snapshotDigest, type SegmentHeader, type Statement } from "../src/pool/statement.js";
import { replacementMessage, ROLE_OPERATOR } from "../src/replacement.js";
import { LocalVenue, VenueError } from "../src/venue.js";
import { CONFIG, DOMAIN, issueStatement, Oracle, VENUE } from "./pool-support.js";
import { KEYS, pub, SECRETS } from "./support.js";

function terms(thing: string): SignedBacking {
  const backing = makeBacking({ obligor: KEYS.backer, payout: { thing, quantumExponent: -2, perUnit: 100n }, reliance: [],
    evidence: { setting: "pool", operator: KEYS.operator, construction: "moe/pool/v2", configuration: DOMAIN,
      witnessing: { venue: VENUE, interval: 1n }, replacementRule: KEYS.backer } });
  return { backing, signature: signBacking(SECRETS.backer, backing) };
}
function open(venue: LocalVenue, backings: readonly SignedBacking[], oracle: Oracle, sequence = 1n,
  parents: readonly { checkpoint: PoolCheckpointEvidence; segment: Segment }[] = [], operator = KEYS.operator): Segment {
  const scope = new PoolAuthorityView(CONFIG, venue, backings).scope(operator)!;
  const entries = scope.map(e => {
    const parent = parents.find(p => p.checkpoint.directory.some(d => Buffer.from(d.name).equals(e.backing)));
    return { ...e, ...(parent === undefined ? {} : { opening: parent.checkpoint.commitment }) };
  });
  const segment = new Segment(CONFIG, { domain: DOMAIN, venue: venue.id, operator, sequence, entries }, parents.map(p => p.segment.prefix()), oracle);
  for (const b of backings) segment.register(b.backing, b.signature);
  return segment;
}
function evidence(segment: Segment, sequence = segment.header.sequence, secret = SECRETS.operator): PoolCheckpointEvidence {
  const directory = segment.directory(), trail = segment.trail();
  return { commitment: signCommitment(secret, sequence, directoryRoot(directory)), directory,
    snapshots: trail.header.entries.map(e => ({ backing: e.backing, header: trail.header, historyHash: segment.historyHash(),
      issued: segment.issued(e.backing)!, burned: segment.burned(e.backing)!, backings: trail.backings })),
    history: { trail, length: segment.length } };
}
function read(venue: LocalVenue, target: PoolCheckpointEvidence, ancestors: readonly PoolCheckpointEvidence[] = [], verifier: StatementVerifier = new Oracle()) {
  return readPoolCheckpoint({ configuration: CONFIG, venue, checkpoint: target.commitment, evidence: [target, ...ancestors], verifier });
}
async function issue(segment: Segment, oracle: Oracle, backing: SignedBacking, output: bigint) {
  await segment.admit(oracle.accept(issueStatement(segment.authority(), backing.backing.name, 10n, output, SECRETS.backer)));
}
function replace(venue: LocalVenue, backing: SignedBacking, secret: Uint8Array, effective: bigint) {
  const predecessor = new PoolAuthorityView(CONFIG, venue, [backing]).term(backing.backing.name)!.link;
  const fields = { role: ROLE_OPERATOR, successor: pub(secret), predecessor, effective,
    signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
  const message = replacementMessage(backing.backing.name, fields);
  venue.publishReplacement(backing.backing.name, { ...fields, signature: ed25519.sign(message, SECRETS.backer),
    successorSignature: ed25519.sign(message, secret) });
}
async function fixture() {
  const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), y = terms("USD");
  const segment = open(venue, [x, y], oracle);
  await issue(segment, oracle, x, 101n); await issue(segment, oracle, y, 102n);
  const base = evidence(segment); venue.publish(base.commitment);
  return { venue, oracle, x, y, segment, base };
}

describe("C2.10.3–5 whole-scope checkpoint validation", () => {
  it("finalizes the whole scope from genesis and verifies each shared checkpoint once", async () => {
    const f = await fixture();
    const next = open(f.venue, [f.x, f.y], f.oracle, 2n, [{ checkpoint: f.base, segment: f.segment }]);
    const target = evidence(next); f.venue.publish(target.commitment); f.oracle.calls = 0;
    const result = await read(f.venue, target, [f.base], f.oracle);
    expect(result).toMatchObject({ kind: "final", at: 0n, witnessedIndex: 0n, prefix: next.prefix() });
    expect(f.oracle.calls).toBe(2);
  });

  it("allows an unwitnessed first signed sequence and ignores later same-index checkpoints", async () => {
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), segment = open(venue, [x], oracle);
    const target = evidence(segment, 3n); venue.publish(target.commitment);
    const later = evidence(segment, (1n << 64n) - 1n); venue.publish(later.commitment);
    expect(await read(venue, target)).toMatchObject({ kind: "final", at: 0n });
  });

  it("requires an exact held checkpoint with the authentic signature and directory", async () => {
    const f = await fixture(), absent = evidence(f.segment, 2n);
    expect(await read(f.venue, absent)).toMatchObject({ kind: "invalid", reason: /not held/ });
    const wrong = { ...f.base, commitment: { ...f.base.commitment, signature: new Uint8Array(64) } };
    expect(await read(f.venue, wrong)).toMatchObject({ kind: "invalid" });
    expect(await read(f.venue, { ...f.base, directory: [...f.base.directory].reverse() })).toMatchObject({ kind: "invalid" });
    expect(await read(f.venue, f.base, [f.base])).toMatchObject({ kind: "invalid", reason: /duplicate/ });
  });

  it.each(["genesis", "older"])("rejects a stale %s opening before proof verification", async variant => {
    const f = await fixture(), middle = evidence(f.segment, 2n); f.venue.publish(middle.commitment);
    const stale = open(f.venue, [f.x, f.y], f.oracle, 3n, variant === "genesis" ? [] : [{ checkpoint: f.base, segment: f.segment }]);
    const target = evidence(stale); f.venue.publish(target.commitment); f.oracle.calls = 0;
    expect(await read(f.venue, target, [f.base, middle], f.oracle)).toMatchObject({ kind: "invalid", reason: /canonical/ });
    expect(f.oracle.calls).toBe(0);
  });

  it("extends the same segment without changing its openings", async () => {
    const f = await fixture(); await issue(f.segment, f.oracle, f.x, 103n);
    const target = evidence(f.segment, 2n); f.venue.publish(target.commitment);
    expect(await read(f.venue, target, [f.base], f.oracle)).toMatchObject({ kind: "final", prefix: f.segment.prefix() });
  });

  it.each(["rewrite", "truncate"])("rejects a correctly replayed same-segment %s", async variant => {
    const f = await fixture(), twin = open(f.venue, [f.x, f.y], f.oracle);
    if (variant === "rewrite") {
      await issue(twin, f.oracle, f.x, 201n); await issue(twin, f.oracle, f.y, 202n);
    }
    const target = evidence(twin, 2n); f.venue.publish(target.commitment);
    expect(await read(f.venue, target, [f.base], f.oracle)).toMatchObject({ kind: "invalid", reason: /rewrites or truncates/ });
  });

  it("permits different valid proof bytes for unchanged statement identities", async () => {
    const f = await fixture(), target = evidence(f.segment, 2n);
    const statement = target.history!.trail.statements[0]!; statement.proof.fill(77); f.oracle.accept(statement);
    f.venue.publish(target.commitment);
    expect(await read(f.venue, target, [f.base], f.oracle)).toMatchObject({ kind: "final" });
  });

  it("rejects selective carriage even when every supplied statement verifies", async () => {
    const f = await fixture(), directory = f.base.directory.slice(0, 1);
    const target = { ...f.base, directory, commitment: signCommitment(SECRETS.operator, 2n, directoryRoot(directory)) };
    f.venue.publish(target.commitment);
    expect(await read(f.venue, target, [f.base], f.oracle)).toMatchObject({ kind: "invalid", reason: /whole scope/ });
  });

  it("does not import a selectively finalized source through its retained backing", async () => {
    const f = await fixture(), directory = f.base.directory.filter(d => Buffer.from(d.name).equals(f.y.backing.name));
    const partial = { ...f.base, directory, commitment: signCommitment(SECRETS.operator, 2n, directoryRoot(directory)) };
    f.venue.publish(partial.commitment);
    const h: SegmentHeader = { ...f.segment.header, sequence: 3n, entries: [{ backing: f.y.backing.name, link: f.y.backing.name, opening: partial.commitment }] };
    // A hostile serialized history need not pass the trusted local constructor.
    const targetDirectory = [{ name: f.y.backing.name, digest: snapshotDigest(f.y.backing.name, segmentIdentity(h), genesisHistoryHash(segmentIdentity(h)), 10n, 0n) }];
    const target = { commitment: signCommitment(SECRETS.operator, 3n, directoryRoot(targetDirectory)), directory: targetDirectory,
      history: { trail: { configuration: CONFIG, header: h, backings: [f.y], statements: [] }, length: 0n } };
    f.venue.publish(target.commitment);
    expect(await read(f.venue, target, [f.base, partial], f.oracle)).toMatchObject({ kind: "invalid", reason: /whole scope/ });
  });

  it.each(["directory", "scope", "history"])("stops on missing selected %s evidence", async missing => {
    const f = await fixture(), next = evidence(f.segment, 2n); f.venue.publish(next.commitment);
    const { snapshots: _snapshots, ...noScope } = f.base, { history: _history, ...noHistory } = f.base;
    const ancestors = missing === "directory" ? [] : [missing === "scope" ? noScope : noHistory];
    expect(await read(f.venue, next, ancestors, f.oracle)).toMatchObject({ kind: "unavailable", evidence: missing });
  });

  it("does not fall back around invalid live history, including a same-segment predecessor", async () => {
    const f = await fixture(), invalid = evidence(f.segment, 2n);
    invalid.history!.trail.statements[0]!.proof.fill(99); f.venue.publish(invalid.commitment);
    const next = evidence(f.segment, 3n); f.venue.publish(next.commitment);
    expect(await read(f.venue, next, [f.base, invalid], f.oracle)).toMatchObject({ kind: "invalid", reason: /proof/ });
  });

  it("passes authenticated absence without requiring or validating its unrelated history", async () => {
    const f = await fixture(), absent = { commitment: signCommitment(SECRETS.operator, 2n, directoryRoot([])), directory: [], history: {} as never };
    f.venue.publish(absent.commitment); const next = evidence(f.segment, 3n); f.venue.publish(next.commitment);
    expect(await read(f.venue, next, [f.base, absent], f.oracle)).toMatchObject({ kind: "final" });
  });

  it("retains historical finality after replacement and skips whole-scope lapse with no usable history", async () => {
    const f = await fixture(); f.venue.advance(); replace(f.venue, f.x, SECRETS.carol, 2n); f.venue.advance();
    expect(await read(f.venue, f.base, [], f.oracle)).toMatchObject({ kind: "final", at: 0n, witnessedIndex: 2n });
    const late = { ...evidence(f.segment, 2n), history: {} as never }; f.venue.publish(late.commitment);
    const y = open(f.venue, [f.y], f.oracle, 3n, [{ checkpoint: f.base, segment: f.segment }]);
    const next = evidence(y); f.venue.publish(next.commitment);
    expect(await read(f.venue, next, [f.base, late], f.oracle)).toMatchObject({ kind: "final" });
    expect(await read(f.venue, { ...late, history: f.base.history! }, [f.base], f.oracle)).toMatchObject({ kind: "invalid", reason: /not in force/ });
  });

  it("checks the whole scope's signed terms, including backings with no local statement", async () => {
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), y = terms("USD");
    const segment = open(venue, [x, y], oracle), target = evidence(segment); venue.publish(target.commitment);
    const trail = { ...target.history!.trail, backings: [x] };
    expect(await read(venue, { ...target, history: { trail, length: 0n } })).toMatchObject({ kind: "invalid", reason: /not in force/ });
    target.history!.trail.backings[0]!.signature.fill(0);
    expect(await read(venue, target)).toMatchObject({ kind: "invalid", reason: /signature/ });
  });

  it("validates transitive shared imports through split and same-key reappointment", async () => {
    const f = await fixture(); f.venue.advance(); replace(f.venue, f.x, SECRETS.carol, 2n); f.venue.advance();
    const parent = { checkpoint: f.base, segment: f.segment };
    const x = open(f.venue, [f.x], f.oracle, 1n, [parent], KEYS.carol), y = open(f.venue, [f.y], f.oracle, 2n, [parent]);
    await issue(x, f.oracle, f.x, 103n); await issue(y, f.oracle, f.y, 104n);
    const cx = evidence(x, 1n, SECRETS.carol), cy = evidence(y); f.venue.publish(cx.commitment); f.venue.publish(cy.commitment);
    f.venue.advance(); replace(f.venue, f.x, SECRETS.operator, 4n); f.venue.advance();
    const joined = open(f.venue, [f.x, f.y], f.oracle, 3n, [{ checkpoint: cx, segment: x }, { checkpoint: cy, segment: y }]);
    const target = evidence(joined); f.venue.publish(target.commitment); f.oracle.calls = 0;
    const result = await read(f.venue, target, [f.base, cx, cy], f.oracle);
    expect(result).toMatchObject({ kind: "final", prefix: { directory: joined.directory(), historyHash: joined.historyHash() } });
    if (result.kind !== "final") throw new Error("expected final");
    expect(new Set(result.prefix.events)).toEqual(new Set(joined.prefix().events));
    expect(new Set(result.prefix.roots)).toEqual(new Set(joined.prefix().roots));
    expect(f.oracle.calls).toBe(4); // the two shared ancestor events are verified once
    expect(joined.issued(f.x.backing.name)).toBe(20n); expect(joined.issued(f.y.backing.name)).toBe(20n);
    const { history: _history, ...unavailable } = cx;
    expect(await read(f.venue, target, [f.base, unavailable, cy], f.oracle)).toMatchObject({ kind: "unavailable", evidence: "history" });
  });

  it("owns target, ancestor, statement and scope bytes before the first proof yields", async () => {
    const f = await fixture(), next = evidence(f.segment, 2n); f.venue.publish(next.commitment);
    const expected = f.segment.prefix(), promise = read(f.venue, next, [f.base], f.oracle);
    for (const item of [f.base, next]) {
      item.commitment.root.fill(0); item.directory[0]!.digest.fill(0);
      item.history!.trail.header.operator.fill(0); item.history!.trail.backings[0]!.signature.fill(0);
      item.history!.trail.statements.at(-1)!.proof.fill(0);
      item.snapshots![0]!.historyHash.fill(0);
    }
    expect(await promise).toMatchObject({ kind: "final", prefix: expected });
  });

  it("rejects a same-index import from the former operator at takeover", async () => {
    const f = await fixture(); f.venue.advance(); replace(f.venue, f.x, SECRETS.carol, 2n); f.venue.advance();
    const late = evidence(f.segment, 2n); f.venue.publish(late.commitment);
    const stale = open(f.venue, [f.x], f.oracle, 1n, [{ checkpoint: late, segment: f.segment }], KEYS.carol);
    const target = evidence(stale, 1n, SECRETS.carol); f.venue.publish(target.commitment);
    expect(await read(f.venue, target, [f.base, late], f.oracle)).toMatchObject({ kind: "invalid", reason: /canonical/ });
  });

  it("refuses duplicate scope preimages and a substituted snapshot header", async () => {
    const f = await fixture(), next = evidence(f.segment, 2n); f.venue.publish(next.commitment);
    const duplicate = { ...f.base, snapshots: [...f.base.snapshots!, f.base.snapshots![0]!] };
    expect(await read(f.venue, next, [duplicate], f.oracle)).toMatchObject({ kind: "invalid", reason: /duplicate/ });
    const substituted = { ...f.base, snapshots: f.base.snapshots!.map(s => ({ ...s, header: { ...s.header, sequence: 2n } })) };
    expect(await read(f.venue, next, [substituted], f.oracle)).toMatchObject({ kind: "invalid" });
  });

  it.each([-1n, 3n])("refuses checkpoint length %s outside the supplied prefix", async length => {
    const f = await fixture();
    expect(await read(f.venue, { ...f.base, history: { trail: f.base.history!.trail, length } }, [], f.oracle)).toMatchObject({ kind: "invalid", reason: /length/ });
  });

  it("ignores uncheckpointed tails but refuses repeated statements in the prefix", async () => {
    const f = await fixture(), trail = f.base.history!.trail;
    (trail.statements as Statement[]).push({} as Statement);
    expect(await read(f.venue, f.base, [], f.oracle)).toMatchObject({ kind: "final" });
    (trail.statements as Statement[])[2] = trail.statements[0]!;
    expect(await read(f.venue, { ...f.base, history: { trail, length: 3n } }, [], f.oracle)).toMatchObject({ kind: "invalid", reason: /repeats/ });
  });

  it("refuses venue changes during planning and proof verification", async () => {
    const f = await fixture(), pending = read(f.venue, f.base, [], f.oracle); f.venue.advance();
    await expect(pending).rejects.toThrow(VenueError);
    const previous = f.venue.previousFor.bind(f.venue);
    vi.spyOn(f.venue, "previousFor").mockImplementation((...args) => { f.venue.advance(); return previous(...args); });
    await expect(read(f.venue, f.base, [], f.oracle)).rejects.toThrow(VenueError);
  });

  it("propagates venue and unexpected verifier failures", async () => {
    const f = await fixture();
    for (const failure of [new Error("backend failure"), new TypeError("backend type failure"), new RangeError("backend range failure"), new PoolError("PROOF", "backend exception")]) {
      await expect(read(f.venue, f.base, [], { verify: async () => { throw failure; } })).rejects.toBe(failure);
    }
    vi.spyOn(f.venue, "previousFor").mockImplementation(() => { throw new VenueError("offline"); });
    await expect(read(f.venue, f.base, [], f.oracle)).rejects.toThrow("offline");
  });
});
