import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import { makeBacking, signBacking } from "../src/backing.js";
import { compareBytes } from "../src/bytes.js";
import { directoryRoot, signCommitment, type Commitment } from "../src/commitment.js";
import { replacementHash, replacementMessage, ROLE_OPERATOR, type Replacement } from "../src/replacement.js";
import { PoolAuthorityView } from "../src/pool/authority.js";
import { readPoolPredecessor, type PoolDirectoryEvidence, type PoolSnapshotEvidence } from "../src/pool/descent.js";
import { Segment, type SignedBacking } from "../src/pool/segment.js";
import { genesisHistoryHash, segmentIdentity, snapshotDigest, type SegmentHeader } from "../src/pool/statement.js";
import { LocalVenue, VenueError } from "../src/venue.js";
import { CONFIG, DOMAIN, Oracle, VENUE } from "./pool-support.js";
import { KEYS, pub, SECRETS } from "./support.js";

function terms(venue: LocalVenue, thing: string): SignedBacking {
  const backing = makeBacking({ obligor: KEYS.backer, payout: { thing, quantumExponent: -2, perUnit: 100n }, reliance: [],
    evidence: { setting: "pool", operator: KEYS.operator, construction: "moe/pool/v2", configuration: DOMAIN,
      witnessing: { venue: venue.id, interval: 1n }, replacementRule: KEYS.backer } });
  return { backing, signature: signBacking(SECRETS.backer, backing) };
}
function header(venue: LocalVenue, backings: readonly SignedBacking[], sequence = 1n, operator = KEYS.operator): SegmentHeader {
  const entries = new PoolAuthorityView(CONFIG, venue, backings).scope(operator);
  if (!entries) throw new Error("fixture scope is not current");
  return { domain: DOMAIN, venue: venue.id, operator, sequence, entries };
}
function checkpoint(h: SegmentHeader, backings: readonly SignedBacking[], target = backings[0]!, sequence = h.sequence,
  carries = h.entries.map(e => e.backing), secret = SECRETS.operator,
  historyHash = genesisHistoryHash(segmentIdentity(h))): PoolDirectoryEvidence {
  const directory = carries.map(name => ({ name, digest: snapshotDigest(name, segmentIdentity(h), historyHash, 0n, 0n) }))
    .sort((a, b) => compareBytes(a.name, b.name));
  return { commitment: signCommitment(secret, sequence, directoryRoot(directory)), directory,
    snapshot: { backing: target.backing.name, header: h, historyHash, issued: 0n, burned: 0n, backings } };
}
function child(venue: LocalVenue, sequence: bigint, secret = SECRETS.operator): Commitment {
  const c = signCommitment(secret, sequence, directoryRoot([])); venue.publish(c); return c;
}
function read(venue: LocalVenue, backing: SignedBacking, c: Commitment, evidence: readonly PoolDirectoryEvidence[]) {
  return readPoolPredecessor({ configuration: CONFIG, venue, backing, child: c, evidence });
}
function held(e: PoolDirectoryEvidence) { return { commitment: e.commitment, directory: e.directory }; }
function replace(venue: LocalVenue, backing: SignedBacking, secret: Uint8Array, effective: bigint): Replacement {
  const predecessor = new PoolAuthorityView(CONFIG, venue, [backing]).term(backing.backing.name)!.link;
  const fields = { role: ROLE_OPERATOR, successor: pub(secret), predecessor, effective,
    signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
  const bytes = replacementMessage(backing.backing.name, fields);
  const replacement: Replacement = { ...fields, signature: ed25519.sign(bytes, SECRETS.backer), successorSignature: ed25519.sign(bytes, secret) };
  venue.publishReplacement(backing.backing.name, replacement);
  return replacement;
}
function fixture() {
  const venue = new LocalVenue(VENUE), x = terms(venue, "EUR"), y = terms(venue, "USD");
  const h = header(venue, [x, y]), base = checkpoint(h, [x, y], y);
  venue.publish(base.commitment);
  return { venue, x, y, h, base };
}

describe("C2.7/C2.10.4 directory descent selects before replay", () => {
  it("selects genesis only after exhausting the eligible held record", () => {
    const venue = new LocalVenue(VENUE), x = terms(venue, "EUR"), c = child(venue, 1n);
    expect(read(venue, x, c, [])).toEqual({ kind: "genesis" });
  });

  it("passes authenticated absence at the same index without inspecting irrelevant scope data", () => {
    const { venue, x, y, h, base } = fixture();
    const omit = checkpoint(h, [x, y], y, 2n, [x.backing.name]); venue.publish(omit.commitment);
    const c = child(venue, 3n);
    const irrelevant = { ...omit, snapshot: {} as PoolSnapshotEvidence };
    expect(read(venue, y, c, [base, irrelevant])).toMatchObject({ kind: "candidate", at: 0n, checkpoint: held(base) });
    child(venue, 4n); // a later same-index commitment cannot rewrite c's predecessor
    expect(read(venue, y, c, [base, irrelevant])).toMatchObject({ kind: "candidate", checkpoint: held(base) });
  });

  it("does not probe enormous sequence holes and still respects the child's exclusive sequence", () => {
    const { venue, x, y, h, base } = fixture(), sparse = (1n << 64n) - 2n;
    const omit = checkpoint(h, [x, y], y, sparse, [x.backing.name]); venue.publish(omit.commitment);
    const c = child(venue, sparse + 1n), reads = vi.spyOn(venue, "previousFor");
    expect(read(venue, y, c, [base, omit])).toMatchObject({ kind: "candidate", checkpoint: held(base) });
    expect(reads.mock.calls.length).toBeLessThan(8);
  });

  it("stops at a missing directory or scope preimage instead of falling back", () => {
    const { venue, x, y, h, base } = fixture();
    const latest = checkpoint(h, [x, y], y, 2n); venue.publish(latest.commitment);
    const c = child(venue, 3n);
    expect(read(venue, y, c, [base])).toMatchObject({ kind: "unavailable", commitment: latest.commitment, evidence: "directory" });
    const { snapshot: _snapshot, ...directoryOnly } = latest;
    expect(read(venue, y, c, [base, directoryOnly])).toMatchObject({ kind: "unavailable", evidence: "scope" });
  });

  it("refuses substituted, noncanonical and duplicate directory evidence", () => {
    const { venue, y, base } = fixture(), c = child(venue, 2n);
    const changed = base.directory.map(d => ({ ...d, digest: new Uint8Array(32) }));
    for (const evidence of [[{ ...base, directory: changed }], [{ ...base, directory: [...base.directory].reverse() }], [base, base]]) {
      expect(read(venue, y, c, evidence).kind).toBe("invalid");
    }
  });

  it("leaves a live candidate selected even when its signed history cannot replay", async () => {
    const { venue, x, y, h, base } = fixture();
    const invalid = checkpoint(h, [x, y], y, 2n, undefined, undefined, new Uint8Array(32).fill(42));
    venue.publish(invalid.commitment); const c = child(venue, 3n);
    expect(read(venue, y, c, [base, invalid])).toMatchObject({ kind: "candidate", checkpoint: held(invalid) });
    // The selected checkpoint fails the next layer. Replay failure is never
    // another directory-descent step back to base.
    const nextHeader: SegmentHeader = { ...h, sequence: 4n, entries: h.entries.map(e => ({ ...e,
      opening: { operator: invalid.commitment.operator, sequence: 2n, root: invalid.commitment.root } })) };
    await expect(Segment.replay({ configuration: CONFIG, header: nextHeader, backings: [x, y], statements: [] }, new Oracle(),
      [{ checkpoint: held(invalid), trail: { configuration: CONFIG, header: h, backings: [x, y], statements: [] }, length: 0n }]))
      .rejects.toThrow("directory is not the replayed prefix");
  });

  it.each([false, true])("passes authenticated whole-scope lapse without statements, selective directory = %s", selective => {
    const { venue, x, y, h, base } = fixture();
    venue.advance(1n); replace(venue, x, SECRETS.carol, 2n); venue.advance(1n);
    const late = checkpoint(h, [x, y], y, 2n, selective ? [y.backing.name] : undefined);
    venue.publish(late.commitment); const c = child(venue, 3n);
    expect(read(venue, y, c, [late, base])).toMatchObject({ kind: "candidate", checkpoint: held(base), at: 0n });
    const { snapshot: _snapshot, ...directoryOnly } = late;
    expect(read(venue, y, c, [directoryOnly, base])).toMatchObject({ kind: "unavailable", evidence: "scope" });
  });

  it("authenticates the snapshot before an attacker can substitute an old lapsed scope", () => {
    const { venue, x, y, h, base } = fixture();
    venue.advance(1n); replace(venue, x, SECRETS.carol, 2n); venue.advance(1n);
    const current = checkpoint(header(venue, [y], 2n), [y]); venue.publish(current.commitment);
    const c = child(venue, 3n);
    const forged = { ...current, snapshot: { ...current.snapshot!, header: h, backings: [x, y] } };
    expect(read(venue, y, c, [forged, base])).toMatchObject({ kind: "invalid", reason: "snapshot does not authenticate the header" });
    expect(read(venue, y, c, [current, base])).toMatchObject({ kind: "candidate", checkpoint: held(current) });
  });

  it.each(["domain", "venue", "operator", "sequence", "unknown link", "wrong-operator link", "unsigned terms", "missing terms"] as const)
    ("rejects authenticated but invalid scope metadata: %s", variant => {
      const { venue, x, y, h, base } = fixture();
      venue.advance(1n); replace(venue, x, SECRETS.carol, 2n); venue.advance(1n);
      const qLink = new PoolAuthorityView(CONFIG, venue, [x]).term(x.backing.name)!.link;
      let altered: SegmentHeader = { ...h, sequence: 2n };
      if (variant === "domain") altered = { ...altered, domain: new Uint8Array(32) };
      if (variant === "venue") altered = { ...altered, venue: new Uint8Array(32) };
      if (variant === "operator") altered = { ...altered, operator: KEYS.carol };
      if (variant === "sequence") altered = { ...altered, sequence: 4n };
      if (variant.endsWith("link")) altered = { ...altered, entries: h.entries.map(e =>
        compareBytes(e.backing, x.backing.name) === 0 ? { ...e, link: variant === "unknown link" ? new Uint8Array(32).fill(99) : qLink } : e) };
      const signed = checkpoint(altered, [x, y], y, 2n);
      const evidence = variant === "unsigned terms" ? { ...signed, snapshot: { ...signed.snapshot!, backings: [x, { ...y, signature: new Uint8Array(64) }] } }
        : variant === "missing terms" ? { ...signed, snapshot: { ...signed.snapshot!, backings: [y] } } : signed;
      venue.publish(signed.commitment); const c = child(venue, 3n);
      expect(read(venue, y, c, [base, evidence]).kind).toBe("invalid");
    });

  it("does not lapse a checkpoint that was witnessed before its scope term ended", () => {
    const { venue, x, y, base } = fixture();
    venue.advance(1n); replace(venue, x, SECRETS.carol, 2n); venue.advance(2n);
    const c = child(venue, 2n);
    expect(read(venue, y, c, [base])).toMatchObject({ kind: "candidate", checkpoint: held(base) });
  });

  it("refuses a known scope link whose term has not yet started", () => {
    const { venue, x, y, h, base } = fixture();
    venue.advance(1n); replace(venue, x, SECRETS.carol, 2n); venue.advance(1n);
    const pending = replace(venue, x, SECRETS.operator, 4n);
    const premature = checkpoint({ ...h, sequence: 2n, entries: h.entries.map(e =>
      compareBytes(e.backing, x.backing.name) === 0 ? { ...e, link: replacementHash(x.backing.name, pending) } : e) }, [x, y], y);
    venue.publish(premature.commitment); const c = child(venue, 3n);
    expect(read(venue, y, c, [premature, base])).toEqual({ kind: "invalid", reason: "scope term has not started" });
  });

  it.each(["backing", "historyHash", "issued", "burned"] as const)("authenticates snapshot preimage field %s", field => {
    const { venue, y, base } = fixture(), c = child(venue, 2n);
    const snapshot = { ...base.snapshot!, [field]: field === "issued" || field === "burned" ? 1n : new Uint8Array(32) };
    expect(read(venue, y, c, [{ ...base, snapshot }]).kind).toBe("invalid");
  });

  it.each([false, true])("reaches through reappointment, intervening term committed = %s", committed => {
    const venue = new LocalVenue(VENUE), x = terms(venue, "EUR"), base = checkpoint(header(venue, [x]), [x]);
    venue.publish(base.commitment); venue.advance(1n); replace(venue, x, SECRETS.carol, 2n); venue.advance(1n);
    const q = checkpoint(header(venue, [x], 1n, KEYS.carol), [x], x, 1n, undefined, SECRETS.carol);
    if (committed) venue.publish(q.commitment);
    venue.advance(1n); replace(venue, x, SECRETS.operator, 4n);
    child(venue, 2n); // old P is not in force here; no directory evidence is needed
    venue.advance(1n); const c = child(venue, 3n);
    expect(read(venue, x, c, [base, q])).toMatchObject({ kind: "candidate", checkpoint: held(committed ? q : base) });
  });

  it("excludes the former operator's same-index publication at the takeover boundary", () => {
    const venue = new LocalVenue(VENUE), x = terms(venue, "EUR"), base = checkpoint(header(venue, [x]), [x]);
    venue.publish(base.commitment); venue.advance(1n); replace(venue, x, SECRETS.carol, 2n); venue.advance(1n);
    child(venue, 2n); // P's same-index record cannot be an edge to Q's checkpoint
    const c = child(venue, 1n, SECRETS.carol);
    expect(read(venue, x, c, [base])).toMatchObject({ kind: "candidate", checkpoint: held(base) });
  });

  it("rejects an unheld or unauthorized child rather than reading an invented rank", () => {
    const { venue, y, base } = fixture();
    const absent = signCommitment(SECRETS.operator, 2n, directoryRoot([]));
    expect(read(venue, y, absent, [base]).kind).toBe("invalid");
    venue.publish(absent);
    expect(read(venue, y, signCommitment(SECRETS.operator, 2n, new Uint8Array(32)), [base]).kind).toBe("invalid");
    expect(read(venue, y, child(venue, 1n, SECRETS.carol), [base]).kind).toBe("invalid");
  });

  it("owns returned evidence and does not mutate the caller's copies", () => {
    const { venue, y, base } = fixture(), c = child(venue, 2n);
    const selected = read(venue, y, c, [base]);
    if (selected.kind !== "candidate") throw new Error("expected candidate");
    selected.checkpoint.directory[0]!.digest.fill(0); selected.checkpoint.commitment.root.fill(0);
    selected.header.entries[0]!.link.fill(0);
    expect(read(venue, y, c, [base])).toMatchObject({ kind: "candidate", checkpoint: held(base) });
  });

  it("propagates venue refusal and programming failures, including changed clocks", () => {
    const { venue, y, base } = fixture(), c = child(venue, 2n);
    const spy = vi.spyOn(venue, "previousFor");
    spy.mockImplementationOnce(() => { throw new VenueError("offline"); });
    expect(() => read(venue, y, c, [base])).toThrow(VenueError);
    spy.mockImplementationOnce(() => { throw new Error("programming bug"); });
    expect(() => read(venue, y, c, [base])).toThrow("programming bug");
    spy.mockRestore();
    const previous = venue.previousFor.bind(venue);
    vi.spyOn(venue, "previousFor").mockImplementation((...args) => { venue.advance(); return previous(...args); });
    expect(() => read(venue, y, c, [base])).toThrow(VenueError);
  });

  it.each([1, 2])("refuses a malformed witnessed index at record read %s", call => {
    const { venue, y, base } = fixture(), c = child(venue, 2n);
    const exact = venue.witnessedAtSequence.bind(venue); let count = 0;
    vi.spyOn(venue, "witnessedAtSequence").mockImplementation((...args) => ++count === call ? 0 as never : exact(...args));
    expect(() => read(venue, y, c, [base])).toThrow(VenueError);
  });
});
