import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { signBacking } from "../src/backing.js";
import { directoryRoot } from "../src/commitment.js";
import { EMPTY_NOTE_ROOT, NOTE_TREE_CAPACITY, notePathProves } from "../src/pool/note-tree.js";
import { outputsFit, PoolError, Segment, type SegmentTrail } from "../src/pool/segment.js";
import { EMPTY_SPENT_ROOT, spentProofProves } from "../src/pool/spent-set.js";
import { fieldToBytes } from "../src/pool/field.js";
import {
  BURN,
  configurationHash,
  genesisHistoryHash,
  ISSUE,
  nextHistoryHash,
  segmentAuthority,
  SPEND,
  snapshotDigest,
  statementBytes,
  statementHash,
  type Statement,
} from "../src/pool/statement.js";
import {
  burnStatement, CONFIG, DOMAIN, genesisHeader, headerOf, issueStatement, makePoolBacking, Oracle, signedPoolBacking, spendStatement, walletNote,
} from "./pool-support.js";
import { KEYS, makeTransparentBacking, SECRETS } from "./support.js";

// pool-v2 §8 (admission against one committed view) and §9 (the ordered
// history, the snapshot digest, the directory, replay), over the state
// machine of one segment opened from the empty book, with the proof system
// stood in for by an oracle that accepts exactly the statements a test marks
// valid. The relation itself is proven by `npm run check:pool`; import and
// replay across segments are `pool-segment.test.ts`.

async function refused(promise: Promise<unknown>, code: PoolError["code"]): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "PoolError", code });
}

function setup() {
  const oracle = new Oracle();
  const a = signedPoolBacking(SECRETS.backer, "EUR");
  const b = signedPoolBacking(SECRETS.backer2, "USD");
  const header = genesisHeader([a.backing, b.backing]);
  const segment = new Segment(CONFIG, header, [], oracle);
  segment.register(a.backing, a.signature);
  segment.register(b.backing, b.signature);
  return { oracle, segment, header, auth: segmentAuthority(header), a: a.backing, b: b.backing };
}

/** Issue → spend → burn, the segment's three statements, on backing `a`. */
async function history(ctx: ReturnType<typeof setup>, seed = 0n) {
  const { oracle, segment, auth, a } = ctx;
  const alice = walletNote(a.name, 100n, seed + 1n);
  const issue = oracle.accept(issueStatement(auth, a.name, 100n, alice.cm, SECRETS.backer));
  const issued = await segment.admit(issue);
  const padding = walletNote(a.name, 0n, seed + 2n);
  const bob = walletNote(a.name, 40n, seed + 3n);
  const change = walletNote(a.name, 60n, seed + 4n);
  const spend = oracle.accept(spendStatement(auth, [issued.noteRoot, EMPTY_NOTE_ROOT], [alice.nf, padding.nf], [bob.cm, change.cm]));
  const spent = await segment.admit(spend);
  const padding2 = walletNote(a.name, 0n, seed + 5n);
  const rest = walletNote(a.name, 10n, seed + 6n);
  const burn = oracle.accept(burnStatement(auth, a.name, 30n, [spent.noteRoot, spent.noteRoot], [bob.nf, padding2.nf], rest.cm));
  const burned = await segment.admit(burn);
  return { alice, padding, bob, change, padding2, rest, issue, issued, spend, spent, burn, burned };
}

describe("pool-v2 §8: admission changes state as one transition, or not at all", () => {
  it("admits issue, spend and burn in order, positioning, rooting and totalling each", async () => {
    const ctx = setup();
    const { segment, auth, a, b } = ctx;
    expect(segment.length).toBe(0n);
    expect(segment.noteRoot()).toBe(EMPTY_NOTE_ROOT);
    expect(segment.spentRoot()).toEqual(EMPTY_SPENT_ROOT);
    expect(segment.historyHash()).toEqual(genesisHistoryHash(auth.segment));
    expect(segment.isAnchor(EMPTY_NOTE_ROOT)).toBe(true);
    expect(segment.identity).toEqual(auth.segment);
    expect(segment.scopeRoot()).toBe(auth.scopeRoot);
    expect(segment.authority()).toEqual(auth);
    const h = await history(ctx);
    expect(h.issued.position).toBe(1n);
    expect(h.spent.position).toBe(2n);
    expect(h.burned.position).toBe(3n);
    expect(segment.length).toBe(3n);
    expect(segment.leaves()).toEqual([h.alice.cm, h.bob.cm, h.change.cm, h.rest.cm]);
    expect(segment.issued(a.name)).toBe(100n);
    expect(segment.burned(a.name)).toBe(30n);
    expect(segment.outstanding(a.name)).toBe(70n);
    expect(segment.outstanding(b.name)).toBe(0n);
    expect(segment.outstanding(new Uint8Array(32))).toBeUndefined();
    for (const anchor of [EMPTY_NOTE_ROOT, h.issued.noteRoot, h.spent.noteRoot, h.burned.noteRoot]) expect(segment.isAnchor(anchor)).toBe(true);
    expect(segment.isAnchor(1n)).toBe(false);
    for (const nf of [h.alice.nf, h.padding.nf, h.bob.nf, h.padding2.nf]) expect(segment.isSpent(nf)).toBe(true);
    for (const nf of [h.change.nf, h.rest.nf]) expect(segment.isSpent(nf)).toBe(false);
    // The records carry what the receipt is signed over: identity, history, roots, evidence hashes.
    expect(h.issued.statementHash).toEqual(statementHash(DOMAIN, ISSUE, h.issue.publicInputs));
    expect(h.issued.proofHash).toEqual(sha256(h.issue.proof));
    expect(h.issued.obligorSignatureHash).toEqual(sha256(h.issue.obligorSignature as Uint8Array));
    expect(h.spent.obligorSignatureHash).toBeUndefined();
    expect(h.issued.historyHash).toEqual(nextHistoryHash(genesisHistoryHash(auth.segment), h.issued.statementHash, h.issued.noteRoot, h.issued.spentRoot, 1n));
    expect(h.spent.historyHash).toEqual(nextHistoryHash(h.issued.historyHash, h.spent.statementHash, h.spent.noteRoot, h.spent.spentRoot, 2n));
    expect(segment.historyHash()).toEqual(h.burned.historyHash);
    expect(h.burned.noteRoot).toBe(segment.noteRoot());
    expect(h.burned.spentRoot).toEqual(segment.spentRoot());
    // The spent set proves membership of what was spent and absence of what was not, at the current root.
    expect(spentProofProves(segment.spentRoot(), fieldToBytes(h.alice.nf), segment.spentProof(h.alice.nf), true)).toBe(true);
    expect(spentProofProves(segment.spentRoot(), fieldToBytes(h.change.nf), segment.spentProof(h.change.nf), false)).toBe(true);
    // A wallet's own path for its leaf proves against the latest local anchor.
    expect(notePathProves(segment.noteRoot(), h.change.cm, segment.path(2n))).toBe(true);
    expect(segment.leaf(2n)).toBe(h.change.cm);
    // The local events are what a later segment imports.
    const events = segment.events();
    expect(events.map((e) => e.position)).toEqual([1n, 2n, 3n]);
    expect(events[0]?.lit).toEqual({ kind: ISSUE, backing: a.name, quantity: 100n });
    expect(events[1]?.lit).toBeUndefined();
    expect(events[2]?.lit).toEqual({ kind: BURN, backing: a.name, quantity: 30n });
    expect(events[1]?.nullifiers).toEqual([h.alice.nf, h.padding.nf]);
    expect(events[1]?.outputs).toEqual([h.bob.cm, h.change.cm]);
  });

  it("answers an exact resubmission with the prior record, whatever its proof bytes, and changes nothing", async () => {
    const ctx = setup();
    const h = await history(ctx);
    const before = ctx.segment.historyHash();
    expect(await ctx.segment.admit(h.spend)).toEqual(h.spent);
    const otherProof = { ...h.spend, proof: sha256(h.spend.proof) };
    expect(await ctx.segment.admit(otherProof)).toEqual(h.spent);
    expect(await ctx.segment.admit(h.issue)).toEqual(h.issued);
    expect(ctx.segment.length).toBe(3n);
    expect(ctx.segment.historyHash()).toEqual(before);
    expect(ctx.segment.acceptedStatement(h.spent.statementHash)).toEqual(h.spent);
    expect(ctx.segment.acceptedStatement(new Uint8Array(32))).toBeUndefined();
  });

  it("refuses a malformed statement, or one naming another construction, segment or scope, before looking at the proof (check 1)", async () => {
    const { oracle, segment, auth, a, header } = setup();
    const alice = walletNote(a.name, 100n, 1n);
    const issue = oracle.accept(issueStatement(auth, a.name, 100n, alice.cm, SECRETS.backer));
    const calls = oracle.calls;
    await refused(segment.admit({ ...issue, publicInputs: issue.publicInputs.slice(1) }), "MALFORMED");
    await refused(segment.admit({ ...issue, kind: 9 as never }), "MALFORMED");
    await refused(segment.admit({ ...issue, proof: new Uint8Array(0) }), "MALFORMED");
    await refused(segment.admit({ ...issue, obligorSignature: undefined } as unknown as Statement), "MALFORMED");
    const otherDomain = oracle.accept(issueStatement({ ...auth, domain: new Uint8Array(32).fill(3) }, a.name, 100n, alice.cm, SECRETS.backer));
    await refused(segment.admit(otherDomain), "MALFORMED");
    const otherSegment = oracle.accept(issueStatement(segmentAuthority({ ...header, sequence: 2n }), a.name, 100n, alice.cm, SECRETS.backer));
    await refused(segment.admit(otherSegment), "SEGMENT");
    const otherScope = oracle.accept(issueStatement({ ...auth, scopeRoot: auth.scopeRoot + 1n }, a.name, 100n, alice.cm, SECRETS.backer));
    await refused(segment.admit(otherScope), "SEGMENT");
    const wideLimb = oracle.accept({ ...issue, publicInputs: issue.publicInputs.map((v, i) => (i === 5 ? 1n << 128n : v)) });
    await refused(segment.admit(wideLimb), "MALFORMED");
    const bigQuantity = oracle.accept({ ...issue, publicInputs: issue.publicInputs.map((v, i) => (i === 7 ? 1n << 64n : v)) });
    await refused(segment.admit(bigQuantity), "MALFORMED");
    expect(oracle.calls).toBe(calls);
    expect(segment.length).toBe(0n);
  });

  it("refuses a proof the verifier does not accept, leaving no trace (check 2)", async () => {
    const { oracle, segment, auth, a } = setup();
    const alice = walletNote(a.name, 100n, 1n);
    const issue = issueStatement(auth, a.name, 100n, alice.cm, SECRETS.backer);
    await refused(segment.admit(issue), "PROOF");
    oracle.accept(issue);
    const corrupted = { ...issue, proof: issue.proof.map((b, i) => (i === 3 ? b ^ 1 : b)) };
    await refused(segment.admit(corrupted), "PROOF");
    await refused(segment.admit({ ...issue, publicInputs: issue.publicInputs.map((v, i) => (i === 7 ? 101n : v)) }), "PROOF");
    expect(segment.length).toBe(0n);
    expect(segment.historyHash()).toEqual(genesisHistoryHash(auth.segment));
    await segment.admit(issue);
    expect(segment.length).toBe(1n);
  });

  it("issues only for a scoped backing whose terms are held, under K's signature over these bytes, below 2^64 issued (check 3)", async () => {
    const { oracle, segment, auth, a } = setup();
    const stranger = makePoolBacking(SECRETS.carol, "GBP");
    const alice = walletNote(a.name, 100n, 1n);
    await refused(segment.admit(oracle.accept(issueStatement(auth, stranger.name, 100n, alice.cm, SECRETS.carol))), "BACKING");
    const wrongKey = oracle.accept(issueStatement(auth, a.name, 100n, alice.cm, SECRETS.mallory));
    await refused(segment.admit(wrongKey), "SIGNATURE");
    const overTerms = oracle.accept({ ...issueStatement(auth, a.name, 100n, alice.cm, SECRETS.backer), obligorSignature: signBacking(SECRETS.backer, a) });
    await refused(segment.admit(overTerms), "SIGNATURE");
    const otherDomain = oracle.accept({
      ...issueStatement(auth, a.name, 100n, alice.cm, SECRETS.backer),
      obligorSignature: ed25519.sign(statementBytes(new Uint8Array(32), ISSUE, issueStatement(auth, a.name, 100n, alice.cm, SECRETS.backer).publicInputs), SECRETS.backer),
    });
    await refused(segment.admit(otherDomain), "SIGNATURE");
    await refused(segment.admit(oracle.accept(issueStatement(auth, a.name, 0n, alice.cm, SECRETS.backer))), "MALFORMED");
    const max = walletNote(a.name, (1n << 64n) - 1n, 7n);
    await segment.admit(oracle.accept(issueStatement(auth, a.name, (1n << 64n) - 1n, max.cm, SECRETS.backer)));
    expect(segment.issued(a.name)).toBe((1n << 64n) - 1n);
    const one = walletNote(a.name, 1n, 8n);
    await refused(segment.admit(oracle.accept(issueStatement(auth, a.name, 1n, one.cm, SECRETS.backer))), "SUPPLY");
    expect(segment.issued(a.name)).toBe((1n << 64n) - 1n);
    expect(segment.length).toBe(1n);
    // A scoped backing whose terms are not yet held cannot issue: the scope is the header's, the terms are registered.
    const c = signedPoolBacking(SECRETS.carol, "GBP");
    const wider = headerOf([{ backing: a.name }, { backing: c.backing.name }]);
    const partial = new Segment(CONFIG, wider, [], oracle);
    const authWider = segmentAuthority(wider);
    const carol = walletNote(c.backing.name, 5n, 9n);
    await refused(partial.admit(oracle.accept(issueStatement(authWider, c.backing.name, 5n, carol.cm, SECRETS.carol))), "BACKING");
    partial.register(c.backing, c.signature);
    expect((await partial.admit(oracle.accept(issueStatement(authWider, c.backing.name, 5n, carol.cm, SECRETS.carol)))).position).toBe(1n);
  });

  it("burns only a scoped backing's outstanding claims (check 3)", async () => {
    const ctx = setup();
    const { oracle, segment, auth, a, b } = ctx;
    const h = await history(ctx);
    const padding = walletNote(a.name, 0n, 9n);
    const nothing = walletNote(a.name, 0n, 10n);
    const anchors: [bigint, bigint] = [h.burned.noteRoot, h.burned.noteRoot];
    await refused(segment.admit(oracle.accept(burnStatement(auth, a.name, 71n, anchors, [h.change.nf, padding.nf], nothing.cm))), "SUPPLY");
    await refused(segment.admit(oracle.accept(burnStatement(auth, b.name, 1n, anchors, [h.change.nf, padding.nf], nothing.cm))), "SUPPLY");
    const stranger = makePoolBacking(SECRETS.carol, "GBP");
    await refused(segment.admit(oracle.accept(burnStatement(auth, stranger.name, 1n, anchors, [h.change.nf, padding.nf], nothing.cm))), "BACKING");
    expect(segment.outstanding(a.name)).toBe(70n);
    expect(segment.length).toBe(3n);
    const exact = walletNote(a.name, 0n, 11n);
    await segment.admit(oracle.accept(burnStatement(auth, a.name, 70n, anchors, [h.change.nf, padding.nf], exact.cm)));
    expect(segment.outstanding(a.name)).toBe(0n);
  });

  it("refuses an anchor outside the forest in either slot, a spent nullifier under any anchor, and equal nullifiers (check 4)", async () => {
    const ctx = setup();
    const { oracle, segment, auth, a } = ctx;
    const h = await history(ctx);
    const out1 = walletNote(a.name, 30n, 12n);
    const out2 = walletNote(a.name, 30n, 13n);
    const fresh = walletNote(a.name, 0n, 14n);
    const latest = h.burned.noteRoot;
    // A root that verifies a membership proof but never came from this segment's history is refused, in either slot.
    await refused(segment.admit(oracle.accept(spendStatement(auth, [latest + 1n, latest], [h.change.nf, fresh.nf], [out1.cm, out2.cm]))), "ANCHOR");
    await refused(segment.admit(oracle.accept(spendStatement(auth, [latest, latest + 1n], [h.change.nf, fresh.nf], [out1.cm, out2.cm]))), "ANCHOR");
    // Respending under the newest anchor: the nullifier is the note's, not the anchor's.
    await refused(segment.admit(oracle.accept(spendStatement(auth, [latest, latest], [h.alice.nf, fresh.nf], [out1.cm, out2.cm]))), "SPENT");
    await refused(segment.admit(oracle.accept(spendStatement(auth, [h.issued.noteRoot, latest], [h.alice.nf, fresh.nf], [out1.cm, out2.cm]))), "SPENT");
    // A padding nullifier entered the spent set like any other.
    await refused(segment.admit(oracle.accept(spendStatement(auth, [latest, latest], [h.change.nf, h.padding.nf], [out1.cm, out2.cm]))), "SPENT");
    // Across kinds: a burn cannot consume what a spend consumed.
    await refused(segment.admit(oracle.accept(burnStatement(auth, a.name, 1n, [latest, latest], [h.bob.nf, fresh.nf], out1.cm))), "SPENT");
    await refused(segment.admit(oracle.accept(spendStatement(auth, [latest, latest], [h.change.nf, h.change.nf], [out1.cm, out2.cm]))), "SPENT");
    expect(segment.length).toBe(3n);
    // Two different older anchors of this segment are both valid to spend against.
    expect((await segment.admit(oracle.accept(spendStatement(auth, [h.spent.noteRoot, h.issued.noteRoot], [h.change.nf, fresh.nf], [out1.cm, out2.cm])))).position).toBe(4n);
  });

  it("refuses an output that exists, equal outputs, the zero output, and outputs that do not fit (check 5)", async () => {
    const ctx = setup();
    const { oracle, segment, auth, a } = ctx;
    const h = await history(ctx);
    const fresh = walletNote(a.name, 0n, 14n);
    const out = walletNote(a.name, 60n, 15n);
    const anchors: [bigint, bigint] = [h.burned.noteRoot, h.burned.noteRoot];
    await refused(segment.admit(oracle.accept(spendStatement(auth, anchors, [h.change.nf, fresh.nf], [h.bob.cm, out.cm]))), "OUTPUT");
    await refused(segment.admit(oracle.accept(spendStatement(auth, anchors, [h.change.nf, fresh.nf], [out.cm, out.cm]))), "OUTPUT");
    await refused(segment.admit(oracle.accept(spendStatement(auth, anchors, [h.change.nf, fresh.nf], [out.cm, 0n]))), "OUTPUT");
    // Reissuing one commitment must not create two notes with one nullifier.
    const reissue = h.issue.publicInputs.map((v, i) => (i === 7 ? 7n : v));
    await refused(segment.admit(oracle.accept({ ...h.issue, publicInputs: reissue, obligorSignature: ed25519.sign(statementBytes(DOMAIN, ISSUE, reissue), SECRETS.backer) })), "OUTPUT");
    expect(outputsFit(NOTE_TREE_CAPACITY - 2n, 2)).toBe(true);
    expect(outputsFit(NOTE_TREE_CAPACITY - 1n, 2)).toBe(false);
    expect(outputsFit(NOTE_TREE_CAPACITY - 1n, 1)).toBe(true);
    expect(outputsFit(NOTE_TREE_CAPACITY, 1)).toBe(false);
    expect(outputsFit(NOTE_TREE_CAPACITY, 0)).toBe(true);
    expect(outputsFit(-1n, 0)).toBe(false);
    expect(segment.length).toBe(3n);
    expect(segment.historyHash()).toEqual(h.burned.historyHash);
  });

  it("registers only a scoped backing whose E names this construction and domain, with a valid signature; E's operator is not compared", () => {
    const a = signedPoolBacking(SECRETS.backer);
    const segment = new Segment(CONFIG, genesisHeader([a.backing]), [], new Oracle());
    segment.register(a.backing, a.signature);
    segment.register(a.backing, a.signature);
    expect(segment.directory()).toHaveLength(1);
    expect(() => segment.register(a.backing, new Uint8Array(64))).toThrow(PoolError);
    const transparent = makeTransparentBacking(SECRETS.backer);
    expect(() => segment.register(transparent, signBacking(SECRETS.backer, transparent))).toThrow(PoolError);
    const otherConfig = makePoolBacking(SECRETS.backer, "EUR", new Uint8Array(32).fill(1));
    expect(() => segment.register(otherConfig, signBacking(SECRETS.backer, otherConfig))).toThrow(PoolError);
    const unscoped = makePoolBacking(SECRETS.backer2, "USD");
    expect(() => segment.register(unscoped, signBacking(SECRETS.backer2, unscoped))).toThrow(PoolError);
    // A backing whose E names another original operator is served by whoever the record seats: registration reads the scope.
    const otherOperator = makePoolBacking(SECRETS.backer, "EUR", DOMAIN, KEYS.mallory);
    const successor = new Segment(CONFIG, genesisHeader([otherOperator], KEYS.carol), [], new Oracle());
    expect(() => successor.register(otherOperator, signBacking(SECRETS.backer, otherOperator))).not.toThrow();
    expect(segment.backing(a.backing.name)?.backing.name).toEqual(a.backing.name);
    expect(segment.backing(otherConfig.name)).toBeUndefined();
    expect(() => new Segment(CONFIG, { ...genesisHeader([a.backing]), operator: new Uint8Array(32) }, [], new Oracle())).toThrow(PoolError);
    expect(() => new Segment(CONFIG, { ...genesisHeader([a.backing]), domain: new Uint8Array(32).fill(1) }, [], new Oracle())).toThrow(PoolError);
  });

  it("admits one of two concurrent conflicting spends, and both copies of one statement once", async () => {
    const ctx = setup();
    const { oracle, segment, auth, a } = ctx;
    const h = await history(ctx);
    const fresh = walletNote(a.name, 0n, 14n);
    const out1 = walletNote(a.name, 30n, 12n);
    const out2 = walletNote(a.name, 30n, 13n);
    const other1 = walletNote(a.name, 20n, 17n);
    const other2 = walletNote(a.name, 40n, 18n);
    const anchors: [bigint, bigint] = [h.burned.noteRoot, h.burned.noteRoot];
    const first = oracle.accept(spendStatement(auth, anchors, [h.change.nf, fresh.nf], [out1.cm, out2.cm]));
    const second = oracle.accept(spendStatement(auth, anchors, [h.change.nf, fresh.nf], [other1.cm, other2.cm]));
    const outcomes = await Promise.allSettled([segment.admit(first), segment.admit(second), segment.admit(first)]);
    expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect((outcomes[1] as PromiseRejectedResult).reason).toMatchObject({ code: "SPENT" });
    expect((outcomes[0] as PromiseFulfilledResult<unknown>).value).toEqual((outcomes[2] as PromiseFulfilledResult<unknown>).value);
    expect(segment.length).toBe(4n);
    expect(segment.leaves()).toHaveLength(6);
  });
});

describe("pool-v2 §9: the history, the directory and replay", () => {
  it("serves a directory over the whole scope that a commitment can root, changing with every statement", async () => {
    const ctx = setup();
    const { segment, auth, a, b } = ctx;
    const genesisDirectory = segment.directory();
    expect(genesisDirectory.map((e) => e.name)).toEqual([a.name, b.name].sort((x, y) => Buffer.compare(x, y)));
    expect(genesisDirectory.find((e) => Buffer.compare(e.name, a.name) === 0)?.digest).toEqual(snapshotDigest(a.name, auth.segment, genesisHistoryHash(auth.segment), 0n, 0n));
    expect(() => directoryRoot(genesisDirectory)).not.toThrow();
    const h = await history(ctx);
    expect(segment.snapshot(a.name)).toEqual(snapshotDigest(a.name, auth.segment, h.burned.historyHash, 100n, 30n));
    // Every backing in one segment shares the segment's history hash, so b's digest moved too.
    expect(segment.snapshot(b.name)).toEqual(snapshotDigest(b.name, auth.segment, h.burned.historyHash, 0n, 0n));
    expect(segment.snapshot(b.name)).not.toEqual(genesisDirectory.find((e) => Buffer.compare(e.name, b.name) === 0)?.digest);
    expect(segment.snapshot(new Uint8Array(32))).toBeUndefined();
    // A scoped backing whose terms are not held is still in the directory: the scope is the header's.
    const c = makePoolBacking(SECRETS.carol, "GBP");
    const wider = new Segment(CONFIG, headerOf([{ backing: a.name }, { backing: c.name }]), [], new Oracle());
    expect(wider.directory().map((e) => e.name)).toEqual([a.name, c.name].sort((x, y) => Buffer.compare(x, y)));
  });

  it("replays its own trail to the same history, roots and totals, verifying every proof again", async () => {
    const ctx = setup();
    const h = await history(ctx);
    const trail = ctx.segment.trail();
    expect(trail.statements).toHaveLength(3);
    expect(trail.header).toEqual(ctx.segment.header);
    const verifier = new Oracle();
    for (const statement of trail.statements) verifier.accept(statement);
    const replayed = await Segment.replay(trail, verifier);
    expect(verifier.calls).toBe(3);
    expect(replayed.historyHash()).toEqual(h.burned.historyHash);
    expect(replayed.noteRoot()).toBe(ctx.segment.noteRoot());
    expect(replayed.spentRoot()).toEqual(ctx.segment.spentRoot());
    expect(replayed.outstanding(ctx.a.name)).toBe(70n);
    expect(replayed.directory()).toEqual(ctx.segment.directory());
    expect(replayed.configHash).toEqual(configurationHash(trail.configuration));
    expect(replayed.identity).toEqual(ctx.segment.identity);
    const doubting = new Oracle();
    for (const statement of trail.statements.slice(0, 2)) doubting.accept(statement);
    await expect(Segment.replay(trail, doubting)).rejects.toMatchObject({ code: "PROOF", message: /statement 3/ });
  });

  it("accepts nothing it did not recompute: a prefix proves itself, and a reordered, repeated or unsigned trail fails", async () => {
    const ctx = setup();
    const h = await history(ctx);
    const trail = ctx.segment.trail();
    const verifier = new Oracle();
    for (const statement of trail.statements) verifier.accept(statement);
    const prefix = await Segment.replay({ ...trail, statements: trail.statements.slice(0, 2) }, verifier);
    expect(prefix.historyHash()).toEqual(h.spent.historyHash);
    expect(prefix.historyHash()).not.toEqual(h.burned.historyHash);
    expect(prefix.outstanding(ctx.a.name)).toBe(100n);
    const reordered: SegmentTrail = { ...trail, statements: [trail.statements[1] as Statement, trail.statements[0] as Statement, trail.statements[2] as Statement] };
    await expect(Segment.replay(reordered, verifier)).rejects.toMatchObject({ code: "ANCHOR", message: /statement 1/ });
    const repeated: SegmentTrail = { ...trail, statements: [...trail.statements, trail.statements[0] as Statement] };
    await expect(Segment.replay(repeated, verifier)).rejects.toMatchObject({ code: "MALFORMED", message: /statement 4 repeats statement 1/ });
    await expect(Segment.replay({ ...trail, backings: trail.backings.filter((s) => Buffer.compare(s.backing.name, ctx.a.name) !== 0) }, verifier))
      .rejects.toMatchObject({ code: "BACKING", message: /statement 1/ });
    // Another configuration is another domain: the header names this one.
    await expect(Segment.replay({ ...trail, configuration: { ...trail.configuration, helper: new Uint8Array(32).fill(5) } }, verifier))
      .rejects.toMatchObject({ code: "SEGMENT" });
    // A trail under another header is another segment, and its statements name the first.
    await expect(Segment.replay({ ...trail, header: { ...trail.header, sequence: 2n } }, verifier))
      .rejects.toMatchObject({ code: "SEGMENT", message: /statement 1/ });
    // A statement naming another domain under this header fails at the first of them.
    const otherDomain: SegmentTrail = { ...trail, statements: trail.statements.map((s) => ({ ...s, publicInputs: s.publicInputs.map((v, i) => (i === 0 ? v + 1n : v)) })) };
    for (const statement of otherDomain.statements) verifier.accept(statement);
    await expect(Segment.replay(otherDomain, verifier)).rejects.toMatchObject({ code: "MALFORMED", message: /statement 1/ });
  });

  it("binds the spent set into the history: two histories with equal note roots and different spends differ", async () => {
    const build = async (spendSecond: boolean) => {
      const ctx = setup();
      const { oracle, segment, auth, a } = ctx;
      const first = walletNote(a.name, 50n, 21n);
      const second = walletNote(a.name, 50n, 22n);
      const i1 = await segment.admit(oracle.accept(issueStatement(auth, a.name, 50n, first.cm, SECRETS.backer)));
      const i2 = await segment.admit(oracle.accept(issueStatement(auth, a.name, 50n, second.cm, SECRETS.backer)));
      expect(i1.position).toBe(1n);
      const padding = walletNote(a.name, 0n, 23n);
      const out1 = walletNote(a.name, 20n, 24n);
      const out2 = walletNote(a.name, 30n, 25n);
      const spent = spendSecond ? second : first;
      await segment.admit(oracle.accept(spendStatement(auth, [i2.noteRoot, i2.noteRoot], [spent.nf, padding.nf], [out1.cm, out2.cm])));
      return segment;
    };
    const left = await build(false);
    const right = await build(true);
    expect(left.noteRoot()).toBe(right.noteRoot());
    expect(left.length).toBe(right.length);
    expect(left.spentRoot()).not.toEqual(right.spentRoot());
    expect(left.historyHash()).not.toEqual(right.historyHash());
    expect(left.snapshot(left.directory()[0]?.name as Uint8Array)).not.toEqual(right.snapshot(right.directory()[0]?.name as Uint8Array));
  });

  it("serves a trail that holds no note openings, secrets or paths, and copies of its bytes", async () => {
    const ctx = setup();
    const h = await history(ctx, 1n << 100n);
    const trail = ctx.segment.trail();
    const served = JSON.stringify(trail, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v));
    for (const note of [h.alice, h.bob, h.change, h.rest]) {
      for (const secret of [note.secret, note.opening.rho, note.opening.owner]) {
        expect(secret.toString().length).toBeGreaterThan(30);
        expect(served).not.toContain(secret.toString());
        expect(served).not.toContain(secret.toString(16));
      }
      expect(served).toContain(note.cm.toString());
    }
    const servedProof = trail.statements[0]?.proof as Uint8Array;
    servedProof[0] = (servedProof[0] as number) ^ 1;
    expect(ctx.segment.trail().statements[0]?.proof).toEqual(h.issue.proof);
    const record = ctx.segment.acceptedStatement(h.issued.statementHash) as { historyHash: Uint8Array };
    record.historyHash[0] = (record.historyHash[0] as number) ^ 1;
    expect(ctx.segment.acceptedStatement(h.issued.statementHash)?.historyHash).toEqual(h.issued.historyHash);
    const header = ctx.segment.header;
    header.operator.fill(0);
    expect(ctx.segment.header.operator).toEqual(KEYS.operator);
    (ctx.segment.scope()[0] as { link: Uint8Array }).link.fill(0);
    expect(ctx.segment.scopeRoot()).toBe(ctx.auth.scopeRoot);
    expect(SPEND).toBe(2);
  });
});

describe("pool-v2 §8: what leaves the segment aliases nothing, and what it trusts is checked", () => {
  it("serves copies of a backing's terms: rewriting a served copy's obligor grants no authority", async () => {
    const { oracle, segment, auth, a } = setup();
    const alice = walletNote(a.name, 100n, 1n);
    const served = segment.backing(a.name) as { backing: { obligor: Uint8Array } };
    served.backing.obligor.set(KEYS.mallory);
    const trail = segment.trail();
    (trail.backings[0]?.backing.obligor as Uint8Array).set(KEYS.mallory);
    (trail.backings[0]?.backing.evidence as { configuration: Uint8Array }).configuration.fill(0);
    await refused(segment.admit(oracle.accept(issueStatement(auth, a.name, 100n, alice.cm, SECRETS.mallory))), "SIGNATURE");
    expect((await segment.admit(oracle.accept(issueStatement(auth, a.name, 100n, alice.cm, SECRETS.backer)))).position).toBe(1n);
    expect(segment.backing(a.name)?.backing.obligor).toEqual(KEYS.backer);
    segment.configuration.helper.fill(0);
    segment.configHash.fill(0);
    segment.identity.fill(0);
    expect(segment.configHash).toEqual(DOMAIN);
    expect(segment.configuration).toEqual(CONFIG);
    expect(segment.identity).toEqual(auth.segment);
  });

  it("refuses a verifier whose circuits are not the configuration's, where the verifier can say", () => {
    const a = signedPoolBacking(SECRETS.backer);
    const header = genesisHeader([a.backing]);
    const matching = Object.assign(new Oracle(), { identities: { issue: CONFIG.issue, spend: CONFIG.spend, burn: CONFIG.burn } });
    expect(() => new Segment(CONFIG, header, [], matching)).not.toThrow();
    const other = Object.assign(new Oracle(), {
      identities: { issue: CONFIG.issue, spend: CONFIG.spend, burn: { bytecode: CONFIG.burn.bytecode, vk: new Uint8Array(32) } },
    });
    expect(() => new Segment(CONFIG, header, [], other)).toThrow(PoolError);
    expect(() => new Segment(CONFIG, header, [], other)).toThrow(/burn/);
    expect(() => new Segment(CONFIG, header, [], new Oracle())).not.toThrow();
  });

  it("answers a malformed backing, configuration or header with a PoolError, and positions a replay's failing statement", async () => {
    const a = signedPoolBacking(SECRETS.backer);
    const segment = new Segment(CONFIG, genesisHeader([a.backing]), [], new Oracle());
    let caught: unknown;
    try {
      segment.register({} as never, new Uint8Array(64));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: "PoolError", code: "BACKING" });
    try {
      new Segment({ ...CONFIG, helper: new Uint8Array(31) }, genesisHeader([a.backing]), [], new Oracle());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: "PoolError", code: "CONFIGURATION" });
    try {
      new Segment(CONFIG, { ...genesisHeader([a.backing]), sequence: 0n }, [], new Oracle());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: "PoolError", code: "SEGMENT" });
    try {
      new Segment(CONFIG, genesisHeader([a.backing]), "prefixes" as never, new Oracle());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: "PoolError", code: "IMPORT" });
    const ctx = setup();
    await history(ctx);
    const trail = ctx.segment.trail();
    const doubting = new Oracle();
    doubting.accept(trail.statements[0] as Statement);
    await expect(Segment.replay(trail, doubting)).rejects.toMatchObject({ code: "PROOF", position: 2n });
    const repeated: SegmentTrail = { ...trail, statements: [trail.statements[0] as Statement, trail.statements[0] as Statement] };
    await expect(Segment.replay(repeated, doubting)).rejects.toMatchObject({ code: "MALFORMED", position: 2n });
    await expect(Segment.replay({ ...trail, header: null as never }, doubting)).rejects.toMatchObject({ code: "SEGMENT" });
  });

  it("answers a resubmission with its record before reading its evidence, and refuses a signature over other bytes", async () => {
    const ctx = setup();
    const h = await history(ctx);
    expect(await ctx.segment.admit({ ...h.spend, proof: new Uint8Array(0) })).toEqual(h.spent);
    expect(await ctx.segment.admit({ ...h.issue, obligorSignature: undefined } as unknown as Statement)).toEqual(h.issued);
    expect(ctx.segment.length).toBe(3n);
    const alice = walletNote(ctx.a.name, 7n, 30n);
    const issue = issueStatement(ctx.auth, ctx.a.name, 7n, alice.cm, SECRETS.backer);
    const otherInputs = issue.publicInputs.map((v, i) => (i === 7 ? 8n : v));
    const overOtherInputs = ctx.oracle.accept({ ...issue, obligorSignature: ed25519.sign(statementBytes(DOMAIN, ISSUE, otherInputs), SECRETS.backer) });
    await refused(ctx.segment.admit(overOtherInputs), "SIGNATURE");
    const burnInputs = [...issue.publicInputs, 1n, 2n, 3n, 4n];
    const overOtherKind = ctx.oracle.accept({ ...issue, obligorSignature: ed25519.sign(statementBytes(DOMAIN, BURN, burnInputs), SECRETS.backer) });
    await refused(ctx.segment.admit(overOtherKind), "SIGNATURE");
    const yes = { verify: async () => "yes" as unknown as boolean };
    const trusting = new Segment(CONFIG, ctx.header, [], yes);
    trusting.register(ctx.a, signBacking(SECRETS.backer, ctx.a));
    await refused(trusting.admit(issue), "PROOF");
  });
});
