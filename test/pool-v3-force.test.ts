import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { limbsOf } from "../src/pool/field.js";
import { EMPTY_NOTE_ROOT } from "../src/pool/note-tree.js";
import { commitmentOf } from "../src/pool/notes.js";
import { acceptanceBytes, acceptanceId, decodeRecord, encodeRecord, encodeSettlementAuthorization, releaseBytes,
  statementHash, withdrawalBytes, type Record } from "../src/pool/v3/records.js";
import { tagOf } from "../src/pool/v3/recovery.js";
import { ReplayStore } from "../src/pool/v3/replay-store.js";
import { applyForceRecord, applyRecord, openForceState, openSegmentState, type ForceContext, type ForceState,
  type SegmentReplay } from "../src/pool/v3/state.js";
import type { RootTerms } from "../src/pool/v3/terms.js";

// Synthetic proof verifier isolates transition guards; conformance/replay acceptance uses real proofs.
const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const domain = b(1), segment = b(2), backing = b(3), issuerSecret = b(4), presenterSecret = b(5);
const issuer = ed25519.getPublicKey(issuerSecret), presenter = ed25519.getPublicKey(presenterSecret), scope = 77n;
const prefix = [...limbsOf(domain), ...limbsOf(segment), scope], verifier = { verify: (): boolean => true };
const context = (extra: Partial<ForceContext> = {}): ForceContext =>
  ({ mode: "force", domain, segment, backing, scope, issuer, index: 9n, lag: 2n, verifier, ...extra });
const fresh = () => openSegmentState(new ReplayStore(), segment, b(40), undefined);
const replay = (extra: Partial<SegmentReplay> = {}): SegmentReplay =>
  ({ domain, segment, backing, scope, terms: { obligor: issuer } as RootTerms, index: 9n, lag: 2n, verifier, block: [], ...extra });
function demand(instant = 7n, deadline = 12n, anchor = EMPTY_NOTE_ROOT, nf = 101n): Uint8Array {
  return encodeRecord({ domain, kind: 4, publicInputs: [...prefix, ...limbsOf(backing), 5n, anchor, 0n, tagOf(nf), 0n,
    ...limbsOf(presenter), instant, deadline], proof: b(9), authorization: new Uint8Array(), capsules: [] });
}
function withdrawal(d: Uint8Array, signer = presenterSecret): Uint8Array {
  const record: Record = { domain, kind: 5, publicInputs: [...prefix, ...limbsOf(statementHash(decodeRecord(d)))],
    proof: new Uint8Array(), authorization: new Uint8Array(64), capsules: [] };
  return encodeRecord({ ...record, authorization: ed25519.sign(withdrawalBytes(record), signer) });
}
function settle(d: Uint8Array, deadline = 12n, nf = 101n, output = 301n, signer = presenterSecret, quantity = 5n, padding = 102n,
  acceptor = issuerSecret): Uint8Array {
  const id = statementHash(decodeRecord(d));
  const record: Record = { domain, kind: 6, publicInputs: [...prefix, ...limbsOf(backing), quantity, 88n, 99n,
    EMPTY_NOTE_ROOT, EMPTY_NOTE_ROOT, nf, padding, output, ...limbsOf(id)], proof: b(8), authorization: new Uint8Array(136), capsules: [] };
  const acceptance = { domain, demand: id, owner: 88n, deadline };
  return encodeRecord({ ...record, authorization: encodeSettlementAuthorization(deadline,
    ed25519.sign(acceptanceBytes(acceptance), acceptor),
    ed25519.sign(releaseBytes(domain, id, acceptanceId(acceptance), statementHash(record)), signer)) });
}
function alter(bytes: Uint8Array, at: number, value: bigint): Uint8Array {
  const record = decodeRecord(bytes), publicInputs = [...record.publicInputs]; publicInputs[at] = value;
  return encodeRecord({ ...record, publicInputs });
}
/** What force holds in memory over its snapshot. */
const overlay = (s: ForceState) => ({ nullifiers: [...s.nullifiers], outputs: [...s.outputs], added: [...s.added.keys()], ended: [...s.ended],
  effective: [...s.effective], spentTags: [...s.spentTags] });
async function refuses(state: ForceState, bytes: Uint8Array, check: string, ctx = context()): Promise<void> {
  const before = overlay(state);
  await expect(applyForceRecord(state, bytes, ctx)).rejects.toMatchObject({ check });
  expect(overlay(state)).toEqual(before);
}

describe("publication force over the snapshot forest", () => {
  it("accumulates demand/settlement effects without changing the snapshot or extending anchors", async () => {
    const source = fresh(), state = openForceState(source), d = demand();
    const sourceHistory = source.history, sourceEvidence = source.evidence;
    await applyForceRecord(state, d, context());
    expect(state.added.size).toBe(1);
    await applyForceRecord(state, settle(d), context({ index: 12n }));
    expect(state.added.size).toBe(0);
    expect([...state.nullifiers]).toEqual([101n, 102n]); expect([...state.outputs]).toEqual([301n]);
    expect(state.spentTags.has(tagOf(101n))).toBe(true);
    expect(state.hasAnchor(EMPTY_NOTE_ROOT)).toBe(true); expect(state.hasAnchor(301n)).toBe(false);
    expect([source.position, source.leaves, source.demands().length, source.nullifiers().length, source.totals().size]).toEqual([0n, 0n, 0, 0, 0]);
    expect(source.history).toEqual(sourceHistory); expect(source.evidence).toEqual(sourceEvidence);
    await refuses(state, demand(10n, 18n, 301n, 201n), "ANCHOR", context({ index: 12n }));
    await refuses(state, settle(d), "REPEATED_STATEMENT", context({ index: 12n }));
  });

  it("judges force at a snapshot's position of a segment that has since moved on", async () => {
    const segmentState = fresh(), d = demand();
    await applyRecord(segmentState, d, replay());
    const snapshot = segmentState.at(1n);
    // The segment's own history later settles the demand, spending the tagged note.
    await applyRecord(segmentState, settle(d), replay({ index: 12n }));
    expect([segmentState.hasNullifier(101n), snapshot.hasNullifier(101n), snapshot.demand(Buffer.from(statementHash(decodeRecord(d))).toString("hex")) !== undefined])
      .toEqual([true, false, true]);
    // At the snapshot the demand still stands and the note is unspent, so the same settlement has force there.
    const atSnapshot = openForceState(snapshot);
    await applyForceRecord(atSnapshot, settle(d), context({ index: 12n }));
    expect([...atSnapshot.nullifiers]).toEqual([101n, 102n]);
    await refuses(openForceState(segmentState.at(2n)), settle(d), "REPEATED_STATEMENT", context({ index: 12n }));
  });

  it("names guard failures in force order and keeps every rejected state unchanged", async () => {
    const state = openForceState(fresh()), d = demand();
    await refuses(state, d, "CONTEXT", context({ domain: b(20) }));
    await refuses(state, d, "CONTEXT", context({ segment: b(20) }));
    await refuses(state, d, "CONTEXT", context({ scope: 78n }));
    await refuses(state, d, "BACKING", context({ backing: b(20) }));
    await refuses(state, d, "PROOF", context({ verifier: { verify: () => false } }));
    await refuses(state, demand(7n, 12n, 123n), "ANCHOR");
    await refuses(state, withdrawal(d), "DEMAND");
    await applyForceRecord(state, d, context());
    await refuses(state, d, "REPEATED_STATEMENT");
    await refuses(state, demand(6n), "LOCKED");
    await refuses(state, withdrawal(d, b(6)), "SIGNATURE");
    // A demand ends only under its own backing: in a scope of several, another backing's exit names no demand.
    await refuses(state, withdrawal(d), "DEMAND", context({ backing: b(20) }));
    await refuses(state, settle(d, 12n, 101n, 301n, b(6)), "SIGNATURE");
    // An acceptance K did not sign, under the presenter's valid release (C3.5).
    await refuses(state, settle(d, 12n, 101n, 301n, presenterSecret, 5n, 102n, b(6)), "SIGNATURE");
    await refuses(state, settle(d, 12n, 201n), "TAGS");
    // A slot the demand tagged 0 carrying value, signed by both parties: the tag check passes
    // it, so only the demand's quantity keeps the settlement to the named claims (C3.5, invariant 27).
    await refuses(state, settle(d, 12n, 101n, 301n, presenterSecret, 6n), "QUANTITY");
    // New nullifiers and outputs are judged last, as in replay: a release failing them and another check names the other.
    const spent = openForceState(state); spent.nullifiers.add(101n);
    await refuses(spent, settle(d, 12n, 101n, 301n, b(6)), "SIGNATURE");
    await refuses(spent, settle(d), "SPENT");
    const output = openForceState(state); output.outputs.add(301n);
    await refuses(output, settle(d, 12n, 101n, 301n, b(6)), "SIGNATURE");
    await refuses(output, settle(d), "OUTPUT");
    await refuses(state, alter(settle(d), 10, 123n), "ANCHOR");
    const broken = new Error("verifier failure"), before = overlay(state);
    await expect(applyForceRecord(state, demand(6n), context({ verifier: { verify: () => { throw broken; } } }))).rejects.toBe(broken);
    expect(overlay(state)).toEqual(before);
    await applyForceRecord(state, withdrawal(d), context({ index: 20n }));
    expect(state.added.size).toBe(0); expect(state.nullifiers.size).toBe(0);
  });

  it("ends a demand by one exit only: a withdrawn demand settles no more, a settled one withdraws no more (C3.6-7, inv 27)", async () => {
    const d = demand(), withdrawn = openForceState(fresh());
    await applyForceRecord(withdrawn, d, context()); await applyForceRecord(withdrawn, withdrawal(d), context());
    await refuses(withdrawn, settle(d), "DEMAND", context({ index: 12n }));
    const settled = openForceState(fresh());
    await applyForceRecord(settled, d, context()); await applyForceRecord(settled, settle(d), context({ index: 12n }));
    await refuses(settled, withdrawal(d), "DEMAND", context({ index: 12n }));
  });

  it("takes a release's output only by a settlement of another demand naming the same owner (C3.8)", async () => {
    // K files a demand over its own snapshot note (nullifier 201) and, under its own acceptance naming the
    // holder's owner 88, settles it to the holder's published rho 99 ahead of the holder's release.
    const state = openForceState(fresh()), held = demand(), own = demand(7n, 12n, EMPTY_NOTE_ROOT, 201n);
    const output = commitmentOf(domain, { backing, value: 5n, owner: 88n, rho: 99n });
    await applyForceRecord(state, held, context()); await applyForceRecord(state, own, context());
    const taking = settle(own, 12n, 201n, output, presenterSecret, 5n, 202n);
    await applyForceRecord(state, taking, context({ index: 11n }));
    const release = settle(held, 12n, 101n, output);
    await refuses(state, release, "TAKEN", context({ index: 12n }));
    // Taken only where every other condition holds: a release past its acceptance's deadline names that.
    await refuses(state, release, "DEADLINE", context({ index: 13n }));
    // The same where the taking settlement is in the snapshot's history rather than forced since its adoption.
    const history = fresh();
    await applyRecord(history, own, replay()); await applyRecord(history, taking, replay({ index: 11n }));
    const snapshot = openForceState(history); await applyForceRecord(snapshot, held, context());
    expect(snapshot.settledFor(output)).toBe(Buffer.from(statementHash(decodeRecord(own))).toString("hex"));
    await refuses(snapshot, release, "TAKEN", context({ index: 12n }));
    // A taken release whose nullifier is also spent names SPENT: taken means every other condition held.
    const both = openForceState(state); both.nullifiers.add(101n);
    await refuses(both, release, "SPENT", context({ index: 12n }));
    // An output a non-settlement created takes no release.
    const spentTo = openForceState(fresh()); await applyForceRecord(spentTo, held, context()); spentTo.outputs.add(output);
    await refuses(spentTo, release, "OUTPUT", context({ index: 12n }));
    // Every other condition holds: without the taking settlement the same release has force.
    const untaken = openForceState(fresh()); await applyForceRecord(untaken, held, context());
    await applyForceRecord(untaken, release, context({ index: 12n }));
    expect(untaken.hasOutput(output)).toBe(true);
    // What C3.8 reads: the earlier settlement is of another demand, and equal outputs name one owner,
    // so K's signature named the holder's owner for both demands.
    const [first, second] = [decodeRecord(taking), decodeRecord(release)];
    expect(first.publicInputs.slice(15)).not.toEqual(second.publicInputs.slice(15));
    expect([first.publicInputs[8], first.publicInputs[14]]).toEqual([second.publicInputs[8], second.publicInputs[14]]);
    expect(state.demand(Buffer.from(statementHash(decodeRecord(held))).toString("hex"))).toBeDefined();
  });

  it("uses inclusive instant/settlement boundaries and a strict demand deadline", async () => {
    for (const instant of [5n, 7n]) await applyForceRecord(openForceState(fresh()), demand(instant), context());
    for (const instant of [4n, 8n]) await refuses(openForceState(fresh()), demand(instant), "DEADLINE");
    await refuses(openForceState(fresh()), demand(7n, 9n), "DEADLINE");
    const d = demand(), state = openForceState(fresh()); await applyForceRecord(state, d, context());
    await refuses(state, settle(d, 13n), "DEADLINE");
    await refuses(state, settle(d, 10n), "DEADLINE", context({ index: 11n }));
    await refuses(state, settle(d), "DEADLINE", context({ index: 13n }));
    await applyForceRecord(state, settle(d), context({ index: 12n }));
  });
});

describe("recovery admission and replay clocks", () => {
  it("adopts the exact forced records under their old binding and indices without a second door or proof check", async () => {
    const d = demand(), settlement = settle(d), targetSegment = b(30);
    const state = openSegmentState(new ReplayStore(), targetSegment, b(40), undefined);
    const ctx = replay({ segment: targetSegment, scope: 88n, index: 30n, verifier: { verify: () => false },
      block: [{ bytes: d, index: 9n }, { bytes: settlement, index: 12n }] });
    await applyRecord(state, d, ctx); await applyRecord(state, settlement, ctx);
    expect(state.eventIndices()).toEqual([9n, 12n]); expect(state.demands().length).toBe(0);
    expect(state.nullifiers()).toEqual([101n, 102n]); expect(state.leaves).toBe(1n);
  });

  it("replays a settlement under another demand's standing lock as refused, and a withdrawal releases its own demand's lock only (C3.7)", async () => {
    // The first demand's lock lapses after its deadline (12); a second demand over the same tag stands until 16.
    const first = demand(), second = demand(11n, 16n), state = fresh();
    await applyRecord(state, first, replay());
    await expect(applyRecord(state, demand(8n, 16n), replay({ index: 10n }))).rejects.toMatchObject({ check: "LOCKED" });
    await applyRecord(state, second, replay({ index: 13n }));
    await expect(applyRecord(state, settle(first), replay({ index: 13n }))).rejects.toMatchObject({ check: "LOCKED" });
    expect(state.position).toBe(2n);
    await applyRecord(state, withdrawal(first), replay({ index: 13n }));
    await expect(applyRecord(state, demand(12n, 18n), replay({ index: 14n }))).rejects.toMatchObject({ check: "LOCKED" });
    // A settlement is never locked by its own demand.
    await applyRecord(state, settle(second, 16n), replay({ index: 14n }));
    expect([state.position, state.demands().length, state.nullifiers()]).toEqual([4n, 0, [101n, 102n]]);
  });

  it("admits at the horizon and replays a timely admission after its deadline", async () => {
    const d = demand(), admission = replay({ admission: true }), state = fresh();
    await applyRecord(state, d, admission);
    await applyRecord(state, settle(d), { ...admission, index: 12n });
    expect(state.position).toBe(2n); expect(state.leaves).toBe(1n);
    expect(state.total(Buffer.from(backing).toString("hex"))).toEqual({ issued: 0n, burned: 0n });
    const later = fresh(); await applyRecord(later, d, replay({ index: 20n }));
    await applyRecord(later, settle(d), replay({ index: 20n }));
    expect(later.history).toEqual(state.history); expect(later.evidence).toEqual(state.evidence);
    for (const bytes of [demand(4n), demand(8n), demand(7n, 9n)]) {
      await expect(applyRecord(fresh(), bytes, admission)).rejects.toMatchObject({ check: "DEADLINE" });
    }
    const expired = fresh(); await applyRecord(expired, d, admission);
    await expect(applyRecord(expired, settle(d), { ...admission, index: 13n })).rejects.toMatchObject({ check: "DEADLINE" });
    expect(expired.position).toBe(1n);
    await applyRecord(expired, withdrawal(d), { ...admission, index: 20n });
    expect(expired.demands().length).toBe(0);
  });
});
