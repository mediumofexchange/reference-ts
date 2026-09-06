import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { compareBytes } from "../src/bytes.js";
import { replacementHash, replacementMessage, ROLE_OPERATOR, type Replacement } from "../src/replacement.js";
import { LocalVenue, VenueError } from "../src/venue.js";
import { PoolAuthorityView } from "../src/pool/authority.js";
import { type SignedBacking } from "../src/pool/segment.js";
import { type SegmentHeader } from "../src/pool/statement.js";
import { CONFIG, DOMAIN } from "./pool-support.js";
import { KEYS, pub, SECRETS } from "./support.js";

class ClockVenue extends LocalVenue {
  constructor(private readonly delay = 0n) { super(sha256(new TextEncoder().encode(`pool-test-lag-${delay}`))); }
  override lag(): bigint { return this.delay; }
}
function terms(venue: LocalVenue, thing = "EUR"): SignedBacking {
  const backing = makeBacking({ obligor: KEYS.backer, payout: { thing, quantumExponent: -2, perUnit: 100n }, reliance: [],
    evidence: { setting: "pool", operator: KEYS.operator, construction: "moe/pool/v2", configuration: DOMAIN,
      witnessing: { venue: venue.id, interval: 1n }, replacementRule: KEYS.backer } });
  return { backing, signature: signBacking(SECRETS.backer, backing) };
}
function replacement(b: Backing, successor: Uint8Array, effective: bigint, predecessor = b.name): Replacement {
  const fields = { role: ROLE_OPERATOR, successor: pub(successor), predecessor, effective,
    signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
  const bytes = replacementMessage(b.name, fields);
  return { ...fields, signature: ed25519.sign(bytes, SECRETS.backer), successorSignature: ed25519.sign(bytes, successor) };
}
function view(venue: LocalVenue, backings: readonly SignedBacking[]) { return new PoolAuthorityView(CONFIG, venue, backings); }
function header(v: PoolAuthorityView, venue: LocalVenue, operator = KEYS.operator, sequence = 1n): SegmentHeader {
  const entries = v.scope(operator);
  if (!entries) throw new Error("fixture operator does not hold this scope");
  return { domain: DOMAIN, venue: venue.id, operator, sequence, entries };
}

describe("C2.5/C2.10: scope authority is read from signed terms and the witnessed record", () => {
  it("sorts the full scope and derives the earliest handover deadline without closing on first notice", () => {
    const venue = new ClockVenue(2n), x = terms(venue), y = terms(venue, "USD");
    const v0 = view(venue, [y, x]), h = header(v0, venue);
    expect(v0.authorizes(h)).toBe(true);
    expect(v0.scope(KEYS.carol)).toBeUndefined();
    expect(h.entries.map(e => e.backing)).toEqual([x.backing.name, y.backing.name].sort(compareBytes));
    venue.advance(1n);
    venue.publishReplacement(x.backing.name, replacement(x.backing, SECRETS.carol, 8n));
    venue.publishReplacement(y.backing.name, replacement(y.backing, SECRETS.alice, 12n));
    expect(view(venue, [x, y]).schedule(h)).toMatchObject({ boundary: 8n, lastSigningIndex: 5n, admissionOpen: true });
    venue.advance(4n);
    expect(view(venue, [x, y]).schedule(h)).toMatchObject({ commitNow: true, admissionOpen: true });
    expect(view(venue, [x, y]).schedule(h, { unwitnessedSignedAt: 5n })).toMatchObject({ commitNow: false, admissionOpen: false });
    venue.advance(3n);
    expect(view(venue, [x, y]).authorizes(h)).toBe(false);
    expect(view(venue, [x, y]).schedule(h)).toBeUndefined();
    expect(view(venue, [y]).scope(KEYS.operator)).toHaveLength(1);
  });

  it("requires both signatures and enforces the exact two-lag-plus-one floor", () => {
    for (const lag of [0n, 1n, 3n]) {
      const venue = new ClockVenue(lag), x = terms(venue);
      venue.advance(2n);
      const valid = replacement(x.backing, SECRETS.carol, 3n + 2n * lag);
      const short = replacement(x.backing, SECRETS.alice, 2n + 2n * lag);
      venue.publishReplacement(x.backing.name, short);
      venue.publishReplacement(x.backing.name, { ...valid, successorSignature: new Uint8Array(64) });
      venue.publishReplacement(x.backing.name, { ...valid, signature: new Uint8Array(64) });
      expect(view(venue, [x]).term(x.backing.name)?.until).toBeUndefined();
      venue.publishReplacement(x.backing.name, valid);
      const pending = view(venue, [x]);
      expect(pending.term(x.backing.name)?.until).toBe(valid.effective);
      const successorHeader: SegmentHeader = { domain: DOMAIN, venue: venue.id, operator: KEYS.carol, sequence: 1n,
        entries: [{ backing: x.backing.name, link: replacementHash(x.backing.name, valid) }] };
      expect(pending.authorizes(successorHeader)).toBe(false);
      const announced = pending.termForLink(x.backing.name, successorHeader.entries[0]!.link)!;
      expect(announced).toMatchObject({ from: valid.effective, operator: KEYS.carol });
      announced.operator.fill(0);
      expect(pending.termForLink(x.backing.name, successorHeader.entries[0]!.link)?.operator).toEqual(KEYS.carol);
      expect(pending.termForLink(x.backing.name, new Uint8Array(32))).toBeUndefined();
      venue.advance(valid.effective - venue.witnessedIndex());
      const arrived = view(venue, [x]);
      expect(arrived.term(x.backing.name)?.operator).toEqual(KEYS.carol);
      expect(arrived.authorizes(successorHeader)).toBe(true);
    }
  });

  it("revokes and supersedes only before force, with a stable historical term", () => {
    const venue = new ClockVenue(), x = terms(venue);
    venue.advance();
    const first = replacement(x.backing, SECRETS.carol, 6n);
    venue.publishReplacement(x.backing.name, first);
    venue.advance();
    venue.publishReplacement(x.backing.name, replacement(x.backing, SECRETS.operator, 4n));
    expect(view(venue, [x]).term(x.backing.name)?.until).toBeUndefined();
    venue.advance();
    const chosen = replacement(x.backing, SECRETS.alice, 7n);
    venue.publishReplacement(x.backing.name, chosen);
    venue.advance(4n);
    venue.publishReplacement(x.backing.name, replacement(x.backing, SECRETS.bob, 10n));
    const v = view(venue, [x]);
    expect(v.term(x.backing.name)?.operator).toEqual(KEYS.alice);
    expect(v.term(x.backing.name, 6n)?.operator).toEqual(KEYS.operator);
    expect(v.term(x.backing.name)?.link).toEqual(replacementHash(x.backing.name, chosen));
  });

  it("resolves same-index ties by record hash, independently of arrival order and unsigned twins", () => {
    for (const reversed of [false, true]) {
      const venue = new ClockVenue(), x = terms(venue);
      venue.advance();
      const candidates = [replacement(x.backing, SECRETS.carol, 5n), replacement(x.backing, SECRETS.alice, 6n)];
      const winner = [...candidates].sort((a, b) => compareBytes(replacementHash(x.backing.name, a), replacementHash(x.backing.name, b)))[0]!;
      venue.publishReplacement(x.backing.name, { ...winner, signature: new Uint8Array(64) });
      for (const c of reversed ? candidates.reverse() : candidates) venue.publishReplacement(x.backing.name, c);
      venue.advance(6n);
      expect(view(venue, [x]).term(x.backing.name)?.operator).toEqual(winner.successor);
    }
  });

  it("does not reuse the genesis link when the original key is reappointed", () => {
    const venue = new ClockVenue(), x = terms(venue);
    const old = header(view(venue, [x]), venue);
    venue.advance();
    const first = replacement(x.backing, SECRETS.carol, 3n);
    venue.publishReplacement(x.backing.name, first); venue.advance(2n);
    const second = replacement(x.backing, SECRETS.operator, 5n, replacementHash(x.backing.name, first));
    venue.publishReplacement(x.backing.name, second); venue.advance(2n);
    const v = view(venue, [x]);
    expect(v.term(x.backing.name)?.operator).toEqual(KEYS.operator);
    expect(v.term(x.backing.name)?.link).toEqual(replacementHash(x.backing.name, second));
    expect(v.authorizes(old)).toBe(false);
    expect(v.authorizes(old, 2n)).toBe(true);
    expect(v.authorizes(header(v, venue, KEYS.operator, 2n))).toBe(true);
  });

  it("refuses mismatched domains, undeclared/different venues, missing scope terms and unsigned backings", () => {
    const venue = new ClockVenue(), x = terms(venue), y = terms(venue, "USD"), v = view(venue, [x, y]);
    const h = header(v, venue);
    expect(v.authorizes({ ...h, domain: new Uint8Array(32) })).toBe(false);
    expect(v.authorizes({ ...h, venue: new Uint8Array(32) })).toBe(false);
    expect(v.authorizes({ ...h, entries: h.entries.slice(1) })).toBe(false);
    expect(v.authorizes({ ...h, entries: h.entries.map(e => ({ ...e, link: new Uint8Array(32) })) })).toBe(false);
    expect(() => view(venue, [{ ...x, signature: new Uint8Array(64) }])).toThrow("signature");
    expect(() => view(venue, [x, x])).toThrow("duplicate");
    expect(() => view(new ClockVenue(1n), [x])).toThrow("venue");
    const evidence = x.backing.evidence;
    const { witnessing: ignored, ...undeclared } = evidence;
    const missingVenue = makeBacking({ ...x.backing, evidence: undeclared });
    expect(() => view(venue, [{ backing: missingVenue, signature: signBacking(SECRETS.backer, missingVenue) }])).toThrow("venue");
  });

  it("owns its terms and outputs, bounds historical reads and does not allow signing-state fields to replace the witnessed clock", () => {
    const venue = new ClockVenue(2n), x = terms(venue), v = view(venue, [x]), h = header(v, venue);
    const name = Uint8Array.from(x.backing.name);
    v.term(name)!.operator.fill(0); v.scope(KEYS.operator)![0]!.link.fill(0);
    x.backing.evidence.operator.fill(0); x.signature.fill(0);
    expect(v.authorizes(h)).toBe(true);
    expect(v.term(name)?.operator).toEqual(KEYS.operator);
    expect(v.authorizes(h, 1n)).toBe(false);
    expect(() => v.term(name, 1n)).toThrow("beyond");
    expect(v.schedule(h, { resumedAt: 0n, now: 999n, lag: 0n } as never)?.admissionOpen).toBe(false);
    venue.advance(3n);
    expect(v.witnessedIndex).toBe(0n); // a stable view, not authority for a later index
    expect(v.authorizes(null as never)).toBe(false);
  });

  it("propagates unavailable venue data instead of granting genesis authority", () => {
    const unavailable = new VenueError("record unavailable");
    class Unavailable extends ClockVenue {
      override replacementsFor(): never { throw unavailable; }
    }
    const venue = new Unavailable(), x = terms(venue);
    expect(() => view(venue, [x])).toThrow(unavailable);
  });

  it.each(["index", "lag", "identity"] as const)("classifies a changed %s as unavailable venue data", field => {
    class Moving extends ClockVenue {
      changed = false;
      override lag() { return this.changed && field === "lag" ? 1n : super.lag(); }
      override get id() { return this.changed && field === "identity" ? new Uint8Array(32) : super.id; }
      override replacementsFor(name: Uint8Array) {
        const records = super.replacementsFor(name);
        this.changed = true;
        if (field === "index") this.advance();
        return records;
      }
    }
    const venue = new Moving(), x = terms(venue);
    expect(() => view(venue, [x])).toThrow(VenueError);
  });

  it("checks the clock even when a later scope entry is invalid", () => {
    class Moving extends ClockVenue {
      override replacementsFor(name: Uint8Array) { this.advance(); return super.replacementsFor(name); }
    }
    const venue = new Moving(), x = terms(venue);
    expect(() => view(venue, [x, x])).toThrow(VenueError);
  });

  it.each(["identity", "replacements"] as const)("owns every requested backing before the adapter's %s callback", phase => {
    let mutate = () => {};
    class Mutates extends ClockVenue {
      override get id() { if (phase === "identity") mutate(); return super.id; }
      override replacementsFor(name: Uint8Array) { if (phase === "replacements") mutate(); return super.replacementsFor(name); }
    }
    const venue = new Mutates(), x = terms(venue), y = terms(venue, "USD"), z = terms(venue, "GBP");
    const yName = Uint8Array.from(y.backing.name), requested = [x, { ...y, signature: Buffer.from(y.signature) }];
    mutate = () => {
      requested[1]!.signature.fill(0);
      y.backing.evidence.operator.fill(0);
      requested.splice(1, 1, z);
    };
    const v = view(venue, requested);
    expect(v.term(yName)?.operator).toEqual(KEYS.operator);
    expect(v.term(z.backing.name)).toBeUndefined();
    expect(v.scope(KEYS.operator)).toHaveLength(2);
  });
});
