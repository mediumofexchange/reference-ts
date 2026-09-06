import { describe, expect, it, vi } from "vitest";
import { makeBacking, signBacking } from "../src/backing.js";
import { readPoolCheckpoint } from "../src/pool/checkpoint.js";
import { preparePoolOpening } from "../src/pool/opening.js";
import { readPoolReceiptCheckpoint } from "../src/pool/receipt-record.js";
import { signPoolReceipt } from "../src/pool/receipt.js";
import { signRevocation } from "../src/revocation.js";
import { LocalVenue, VenueError } from "../src/venue.js";
import { burnStatement, CONFIG, issueStatement, Oracle, spendStatement, VENUE } from "./pool-support.js";
import { evidence, fixture, issue, open, read, replace, terms } from "./pool-record-support.js";
import { KEYS, SECRETS } from "./support.js";

describe("C2b.1: canonical checkpoint replay preserves prospective revocation", () => {
  it.each([0n, 1n])("rejects an unwitnessed signed batch included %s indices after revocation", async delay => {
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), segment = open(venue, [x], oracle);
    await issue(segment, oracle, x, 101n); const signed = evidence(segment);
    venue.advance(); venue.publishRevocation(signRevocation(SECRETS.backer));
    if (delay > 0n) venue.advance(delay); venue.publish(signed.commitment);
    expect(await read(venue, signed, [], oracle)).toMatchObject({ kind: "invalid", reason: /revocation/ });
  });

  it("a revocation at the checkpoint's index invalidates its first issuance regardless of append order", async () => {
    const f = await fixture();
    expect(await read(f.venue, f.base, [], f.oracle)).toMatchObject({ kind: "final" });
    f.venue.publishRevocation(signRevocation(SECRETS.backer));
    expect(await read(f.venue, f.base, [], f.oracle)).toMatchObject({ kind: "invalid", reason: /revocation/ });
  });

  it("preserves earlier issuance through later checkpoints and replacement imports", async () => {
    const f = await fixture(); f.venue.advance(); f.venue.publishRevocation(signRevocation(SECRETS.backer));
    const later = evidence(f.segment, 2n); f.venue.publish(later.commitment);
    expect(await read(f.venue, later, [f.base], f.oracle)).toMatchObject({ kind: "final", prefix: f.segment.prefix() });
    replace(f.venue, f.x, SECRETS.carol, 2n); f.venue.advance();
    const child = open(f.venue, [f.x], f.oracle, 1n, [{ checkpoint: later, segment: f.segment }], KEYS.carol);
    const target = evidence(child, 1n, SECRETS.carol); f.venue.publish(target.commitment);
    expect(await read(f.venue, target, [f.base, later], f.oracle)).toMatchObject({ kind: "final", prefix: child.prefix() });
  });

  it("preserves spending and burning finalized value after revocation", async () => {
    const f = await fixture(); f.venue.advance(); f.venue.publishRevocation(signRevocation(SECRETS.backer));
    const root = f.segment.noteRoot();
    await f.segment.admit(f.oracle.accept(spendStatement(f.segment.authority(), [root, root], [201n, 202n], [301n, 302n])));
    const spent = evidence(f.segment, 2n); f.venue.publish(spent.commitment);
    const anchor = f.segment.noteRoot();
    await f.segment.admit(f.oracle.accept(burnStatement(f.segment.authority(), f.x.backing.name, 5n, [anchor, anchor], [203n, 204n], 303n)));
    const burned = evidence(f.segment, 3n); f.venue.publish(burned.commitment);
    expect(await read(f.venue, burned, [f.base, spent], f.oracle)).toMatchObject({ kind: "final", prefix: f.segment.prefix() });
    expect(f.segment.issued(f.x.backing.name)).toBe(10n); expect(f.segment.burned(f.x.backing.name)).toBe(5n);
  });

  it("checks only newly appended issuance while requiring the old prefix to match", async () => {
    const f = await fixture(); f.venue.advance(); f.venue.publishRevocation(signRevocation(SECRETS.backer));
    await issue(f.segment, f.oracle, f.x, 103n); const late = evidence(f.segment, 2n); f.venue.publish(late.commitment);
    expect(await read(f.venue, late, [f.base], f.oracle)).toMatchObject({ kind: "invalid", reason: /revocation/ });
  });

  it("does not launder rewritten issuance through a same-length earlier checkpoint", async () => {
    const f = await fixture(), twin = open(f.venue, [f.x, f.y], f.oracle);
    await issue(twin, f.oracle, f.x, 201n); await issue(twin, f.oracle, f.y, 202n);
    f.venue.advance(); f.venue.publishRevocation(signRevocation(SECRETS.backer));
    const rewrite = evidence(twin, 2n); f.venue.publish(rewrite.commitment);
    expect(await read(f.venue, rewrite, [f.base], f.oracle)).toMatchObject({ kind: "invalid", reason: /rewrites/ });
  });

  it("same-index predecessors before revocation retain their exact finality", async () => {
    const f = await fixture(), sameIndex = evidence(f.segment, 2n); f.venue.publish(sameIndex.commitment);
    f.venue.advance(); f.venue.publishRevocation(signRevocation(SECRETS.backer));
    const latest = evidence(f.segment, 3n); f.venue.publish(latest.commitment);
    expect(await read(f.venue, latest, [f.base, sameIndex], f.oracle)).toMatchObject({ kind: "final" });
  });

  it("a lower sequence at the revocation index cannot rescue a later same-index checkpoint", async () => {
    const f = await fixture(); f.venue.publishRevocation(signRevocation(SECRETS.backer));
    const later = evidence(f.segment, 2n); f.venue.publish(later.commitment);
    expect(await read(f.venue, later, [f.base], f.oracle)).toMatchObject({ kind: "invalid", reason: /revocation/ });
  });

  it.each(["directory", "history"])("requires earlier %s evidence, rather than assuming a pre-revocation prefix", async missing => {
    const f = await fixture(); f.venue.advance(); f.venue.publishRevocation(signRevocation(SECRETS.backer));
    const later = evidence(f.segment, 2n); f.venue.publish(later.commitment);
    const { history: _history, ...withoutHistory } = f.base;
    expect(await read(f.venue, later, missing === "directory" ? [] : [withoutHistory], f.oracle))
      .toMatchObject({ kind: "unavailable", evidence: missing });
  });

  it("checks revoked issuance in required ancestry outside the child's scope", async () => {
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), y = terms("USD");
    const source = open(venue, [x, y], oracle); await issue(source, oracle, y, 101n);
    const base = evidence(source); venue.advance(); venue.publishRevocation(signRevocation(SECRETS.backer)); venue.publish(base.commitment);
    replace(venue, x, SECRETS.carol, 2n); venue.advance();
    const child = open(venue, [x], oracle, 1n, [{ checkpoint: base, segment: source }], KEYS.carol);
    const target = evidence(child, 1n, SECRETS.carol); venue.publish(target.commitment);
    expect(await read(venue, target, [base], oracle)).toMatchObject({ kind: "invalid", reason: /revocation/ });
  });

  it("does not fall back past an invalid live checkpoint to manufacture a canonical opening", async () => {
    const f = await fixture(); f.venue.advance(); f.venue.publishRevocation(signRevocation(SECRETS.backer));
    await issue(f.segment, f.oracle, f.x, 103n); const late = evidence(f.segment, 2n); f.venue.publish(late.commitment);
    expect(await preparePoolOpening({ configuration: CONFIG, venue: f.venue, operator: KEYS.operator,
      highestSignedSequence: 2n, backings: [f.x, f.y], evidence: [f.base, late], verifier: f.oracle }))
      .toMatchObject({ kind: "invalid", reason: /revocation/ });
  });

  it("receipt inclusion cannot call late issuance included, while historical valid receipts survive", async () => {
    const f = await fixture(), accepted = f.segment.acceptedStatement(f.segment.prefix().events[0]!.statementHash)!;
    const receipt = signPoolReceipt(SECRETS.operator, f.segment.authority(), accepted, 1n);
    const args = { configuration: CONFIG, venue: f.venue, header: f.segment.header, receipt,
      checkpoint: f.base.commitment, evidence: [f.base], verifier: f.oracle };
    f.venue.advance(); f.venue.publishRevocation(signRevocation(SECRETS.backer));
    expect(await readPoolReceiptCheckpoint(args)).toMatchObject({ kind: "included" });
    const tied = await fixture(); tied.venue.publishRevocation(signRevocation(SECRETS.backer));
    expect(await readPoolReceiptCheckpoint({ ...args, venue: tied.venue })).toMatchObject({ kind: "invalid", reason: /revocation/ });
  });

  it("a key revocation applies to its several backings without revoking another obligor", async () => {
    const f = await fixture(), other = makeBacking({ ...f.y.backing, obligor: KEYS.alice });
    const z = { backing: other, signature: signBacking(SECRETS.alice, other) };
    const independent = open(f.venue, [z], f.oracle, 2n);
    await independent.admit(f.oracle.accept(issueStatement(independent.authority(), z.backing.name, 10n, 201n, SECRETS.alice)));
    f.venue.advance(); f.venue.publishRevocation(signRevocation(SECRETS.backer));
    const good = evidence(independent); f.venue.publish(good.commitment);
    // The older operator checkpoint omits z: its authenticated directory is enough.
    expect(await read(f.venue, good, [f.base], f.oracle)).toMatchObject({ kind: "final" });
    await issue(f.segment, f.oracle, f.y, 103n); const bad = evidence(f.segment, 3n); f.venue.publish(bad.commitment);
    expect(await read(f.venue, bad, [f.base, good], f.oracle)).toMatchObject({ kind: "invalid", reason: /revocation/ });
  });

  it.each([true, false])("detects same-index revocation during proof callbacks (proof result %s)", async valid => {
    const f = await fixture(), original = f.oracle.verify.bind(f.oracle); let once = true;
    vi.spyOn(f.oracle, "verify").mockImplementation(async (...args) => {
      if (once) { once = false; f.venue.publishRevocation(signRevocation(SECRETS.backer)); }
      return valid && await original(...args);
    });
    await expect(read(f.venue, f.base, [], f.oracle)).rejects.toThrow(VenueError);
  });

  it("propagates revocation lookup failures, including programming errors during final stability checks", async () => {
    for (const failure of [new VenueError("offline"), new TypeError("adapter bug")]) {
      const f = await fixture(); vi.spyOn(f.venue, "revocationsFor").mockImplementation(() => { throw failure; });
      await expect(read(f.venue, f.base, [], f.oracle)).rejects.toBe(failure);
    }
    const f = await fixture(), original = f.oracle.verify.bind(f.oracle), failure = new TypeError("final read bug");
    vi.spyOn(f.oracle, "verify").mockImplementation(async (...args) => {
      vi.spyOn(f.venue, "revocationsFor").mockImplementation(() => { throw failure; }); return original(...args);
    });
    await expect(read(f.venue, f.base, [], f.oracle)).rejects.toBe(failure);
  });

  it("refuses impossible revocation indices supplied by an inconsistent adapter", async () => {
    for (const at of [-1n, 1n]) {
      const f = await fixture(); vi.spyOn(f.venue, "revocationsFor").mockReturnValue([{ revocation: signRevocation(SECRETS.backer), at }]);
      await expect(readPoolCheckpoint({ configuration: CONFIG, venue: f.venue, checkpoint: f.base.commitment,
        evidence: [f.base], verifier: f.oracle })).rejects.toThrow(VenueError);
    }
  });

  it("checks venue identity and lag again after revocation callbacks", async () => {
    for (const changed of ["id", "lag"]) {
      const f = await fixture(), original = f.venue.revocationsFor.bind(f.venue); let count = 0;
      vi.spyOn(f.venue, "revocationsFor").mockImplementation((...args) => {
        if (++count === 3) {
          if (changed === "id") vi.spyOn(f.venue, "id", "get").mockReturnValue(new Uint8Array(32));
          else vi.spyOn(f.venue, "lag").mockReturnValue(1n);
        }
        return original(...args);
      });
      await expect(read(f.venue, f.base, [], f.oracle)).rejects.toThrow(VenueError);
    }
  });
});
