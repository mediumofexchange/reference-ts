import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { signBacking } from "../src/backing.js";
import { directoryRoot } from "../src/commitment.js";
import { EMPTY_NOTE_ROOT, NOTE_TREE_CAPACITY, notePathProves } from "../src/pool/note-tree.js";
import { outputsFit, Pool, PoolError, type Trail } from "../src/pool/pool.js";
import { EMPTY_SPENT_ROOT, spentProofProves } from "../src/pool/spent-set.js";
import { fieldToBytes } from "../src/pool/field.js";
import {
  BURN,
  configurationHash,
  genesisHistoryHash,
  ISSUE,
  nextHistoryHash,
  SPEND,
  snapshotDigest,
  statementBytes,
  statementHash,
  type Statement,
} from "../src/pool/statement.js";
import {
  burnStatement, CONFIG, CONFIG_HASH, issueStatement, makePoolBacking, Oracle, signedPoolBacking, spendStatement, walletNote,
} from "./pool-support.js";
import { KEYS, makeTransparentBacking, SECRETS } from "./support.js";

// pool-v1 §6 (admission against one committed view) and §7 (the ordered
// history, the snapshot digest, replay), over the state machine, with the
// proof system stood in for by an oracle that accepts exactly the statements
// a test marks valid. The relation itself is proven by `npm run check:pool`.

async function refused(promise: Promise<unknown>, code: PoolError["code"]): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "PoolError", code });
}

function setup() {
  const oracle = new Oracle();
  const pool = new Pool(CONFIG, oracle);
  const a = signedPoolBacking(SECRETS.backer, "EUR");
  const b = signedPoolBacking(SECRETS.backer2, "USD");
  pool.register(a.backing, a.signature);
  pool.register(b.backing, b.signature);
  return { oracle, pool, a: a.backing, b: b.backing };
}

/** Issue → spend → burn, the pool's three statements, on backing `a`. */
async function history(ctx: ReturnType<typeof setup>, seed = 0n) {
  const { oracle, pool, a } = ctx;
  const alice = walletNote(a.name, 100n, seed + 1n);
  const issue = oracle.accept(issueStatement(a.name, 100n, alice.cm, SECRETS.backer));
  const issued = await pool.admit(issue);
  const padding = walletNote(a.name, 0n, seed + 2n);
  const bob = walletNote(a.name, 40n, seed + 3n);
  const change = walletNote(a.name, 60n, seed + 4n);
  const spend = oracle.accept(spendStatement(issued.noteRoot, [alice.nf, padding.nf], [bob.cm, change.cm]));
  const spent = await pool.admit(spend);
  const padding2 = walletNote(a.name, 0n, seed + 5n);
  const rest = walletNote(a.name, 10n, seed + 6n);
  const burn = oracle.accept(burnStatement(a.name, 30n, spent.noteRoot, [bob.nf, padding2.nf], rest.cm));
  const burned = await pool.admit(burn);
  return { alice, padding, bob, change, padding2, rest, issue, issued, spend, spent, burn, burned };
}

describe("pool-v1 §6: admission changes state as one transition, or not at all", () => {
  it("admits issue, spend and burn in order, numbering, rooting and totalling each", async () => {
    const ctx = setup();
    const { pool, a, b } = ctx;
    expect(pool.length).toBe(0n);
    expect(pool.noteRoot()).toBe(EMPTY_NOTE_ROOT);
    expect(pool.spentRoot()).toEqual(EMPTY_SPENT_ROOT);
    expect(pool.historyHash()).toEqual(genesisHistoryHash(CONFIG_HASH));
    expect(pool.isAnchor(EMPTY_NOTE_ROOT)).toBe(true);
    const h = await history(ctx);
    expect(h.issued.sequence).toBe(1n);
    expect(h.spent.sequence).toBe(2n);
    expect(h.burned.sequence).toBe(3n);
    expect(pool.length).toBe(3n);
    expect(pool.leaves()).toEqual([h.alice.cm, h.bob.cm, h.change.cm, h.rest.cm]);
    expect(pool.issued(a.name)).toBe(100n);
    expect(pool.burned(a.name)).toBe(30n);
    expect(pool.outstanding(a.name)).toBe(70n);
    expect(pool.outstanding(b.name)).toBe(0n);
    expect(pool.outstanding(new Uint8Array(32))).toBeUndefined();
    for (const anchor of [EMPTY_NOTE_ROOT, h.issued.noteRoot, h.spent.noteRoot, h.burned.noteRoot]) expect(pool.isAnchor(anchor)).toBe(true);
    expect(pool.isAnchor(1n)).toBe(false);
    for (const nf of [h.alice.nf, h.padding.nf, h.bob.nf, h.padding2.nf]) expect(pool.isSpent(nf)).toBe(true);
    for (const nf of [h.change.nf, h.rest.nf]) expect(pool.isSpent(nf)).toBe(false);
    // The records carry what the receipt is signed over: identity, history, roots, evidence hashes.
    expect(h.issued.statementHash).toEqual(statementHash(CONFIG_HASH, ISSUE, h.issue.publicInputs));
    expect(h.issued.proofHash).toEqual(sha256(h.issue.proof));
    expect(h.issued.obligorSignatureHash).toEqual(sha256(h.issue.obligorSignature as Uint8Array));
    expect(h.spent.obligorSignatureHash).toBeUndefined();
    expect(h.issued.historyHash).toEqual(nextHistoryHash(genesisHistoryHash(CONFIG_HASH), h.issued.statementHash, h.issued.noteRoot, h.issued.spentRoot, 1n));
    expect(h.spent.historyHash).toEqual(nextHistoryHash(h.issued.historyHash, h.spent.statementHash, h.spent.noteRoot, h.spent.spentRoot, 2n));
    expect(pool.historyHash()).toEqual(h.burned.historyHash);
    expect(h.burned.noteRoot).toBe(pool.noteRoot());
    expect(h.burned.spentRoot).toEqual(pool.spentRoot());
    // The spent set proves membership of what was spent and absence of what was not, at the current root.
    expect(spentProofProves(pool.spentRoot(), fieldToBytes(h.alice.nf), pool.spentProof(h.alice.nf), true)).toBe(true);
    expect(spentProofProves(pool.spentRoot(), fieldToBytes(h.change.nf), pool.spentProof(h.change.nf), false)).toBe(true);
    // A wallet's own path for its leaf proves against the latest anchor.
    expect(notePathProves(pool.noteRoot(), h.change.cm, pool.path(2n))).toBe(true);
    expect(pool.leaf(2n)).toBe(h.change.cm);
  });

  it("answers an exact resubmission with the prior record, whatever its proof bytes, and changes nothing", async () => {
    const ctx = setup();
    const h = await history(ctx);
    const before = ctx.pool.historyHash();
    expect(await ctx.pool.admit(h.spend)).toEqual(h.spent);
    const otherProof = { ...h.spend, proof: sha256(h.spend.proof) };
    expect(await ctx.pool.admit(otherProof)).toEqual(h.spent);
    expect(await ctx.pool.admit(h.issue)).toEqual(h.issued);
    expect(ctx.pool.length).toBe(3n);
    expect(ctx.pool.historyHash()).toEqual(before);
    expect(ctx.pool.acceptedStatement(h.spent.statementHash)).toEqual(h.spent);
    expect(ctx.pool.acceptedStatement(new Uint8Array(32))).toBeUndefined();
  });

  it("refuses a malformed statement or one naming another pool before looking at the proof (check 1)", async () => {
    const { oracle, pool, a } = setup();
    const alice = walletNote(a.name, 100n, 1n);
    const issue = oracle.accept(issueStatement(a.name, 100n, alice.cm, SECRETS.backer));
    const calls = oracle.calls;
    await refused(pool.admit({ ...issue, publicInputs: issue.publicInputs.slice(1) }), "MALFORMED");
    await refused(pool.admit({ ...issue, kind: 9 as never }), "MALFORMED");
    await refused(pool.admit({ ...issue, proof: new Uint8Array(0) }), "MALFORMED");
    await refused(pool.admit({ ...issue, obligorSignature: undefined } as unknown as Statement), "MALFORMED");
    const foreign = oracle.accept(issueStatement(a.name, 100n, alice.cm, SECRETS.backer, CONFIG_HASH, new Uint8Array(32).fill(3)));
    await refused(pool.admit(foreign), "MALFORMED");
    const wideLimb = oracle.accept({ ...issue, publicInputs: issue.publicInputs.map((v, i) => (i === 2 ? 1n << 128n : v)) });
    await refused(pool.admit(wideLimb), "MALFORMED");
    const bigQuantity = oracle.accept({ ...issue, publicInputs: issue.publicInputs.map((v, i) => (i === 4 ? 1n << 64n : v)) });
    await refused(pool.admit(bigQuantity), "MALFORMED");
    expect(oracle.calls).toBe(calls);
    expect(pool.length).toBe(0n);
  });

  it("refuses a proof the verifier does not accept, leaving no trace (check 2)", async () => {
    const { oracle, pool, a } = setup();
    const alice = walletNote(a.name, 100n, 1n);
    const issue = issueStatement(a.name, 100n, alice.cm, SECRETS.backer);
    await refused(pool.admit(issue), "PROOF");
    oracle.accept(issue);
    const corrupted = { ...issue, proof: issue.proof.map((b, i) => (i === 3 ? b ^ 1 : b)) };
    await refused(pool.admit(corrupted), "PROOF");
    // The oracle binds public inputs as a proof does: a changed field is another statement, unproven.
    await refused(pool.admit({ ...issue, publicInputs: issue.publicInputs.map((v, i) => (i === 4 ? 101n : v)) }), "PROOF");
    expect(pool.length).toBe(0n);
    expect(pool.historyHash()).toEqual(genesisHistoryHash(CONFIG_HASH));
    await pool.admit(issue);
    expect(pool.length).toBe(1n);
  });

  it("issues only for a served backing, under K's signature over these bytes, below 2^64 issued (check 3)", async () => {
    const { oracle, pool, a } = setup();
    const stranger = makePoolBacking(SECRETS.carol, "GBP");
    const alice = walletNote(a.name, 100n, 1n);
    await refused(pool.admit(oracle.accept(issueStatement(stranger.name, 100n, alice.cm, SECRETS.carol))), "BACKING");
    const wrongKey = oracle.accept(issueStatement(a.name, 100n, alice.cm, SECRETS.mallory));
    await refused(pool.admit(wrongKey), "SIGNATURE");
    const overTerms = oracle.accept({ ...issueStatement(a.name, 100n, alice.cm, SECRETS.backer), obligorSignature: signBacking(SECRETS.backer, a) });
    await refused(pool.admit(overTerms), "SIGNATURE");
    const otherConfiguration = oracle.accept({
      ...issueStatement(a.name, 100n, alice.cm, SECRETS.backer),
      obligorSignature: ed25519.sign(statementBytes(new Uint8Array(32), ISSUE, issueStatement(a.name, 100n, alice.cm, SECRETS.backer).publicInputs), SECRETS.backer),
    });
    await refused(pool.admit(otherConfiguration), "SIGNATURE");
    // A zero quantity is malformed on the host as in the circuit (§5.1), before the proof is read.
    await refused(pool.admit(oracle.accept(issueStatement(a.name, 0n, alice.cm, SECRETS.backer))), "MALFORMED");
    const max = walletNote(a.name, (1n << 64n) - 1n, 7n);
    await pool.admit(oracle.accept(issueStatement(a.name, (1n << 64n) - 1n, max.cm, SECRETS.backer)));
    expect(pool.issued(a.name)).toBe((1n << 64n) - 1n);
    const one = walletNote(a.name, 1n, 8n);
    await refused(pool.admit(oracle.accept(issueStatement(a.name, 1n, one.cm, SECRETS.backer))), "SUPPLY");
    expect(pool.issued(a.name)).toBe((1n << 64n) - 1n);
    expect(pool.length).toBe(1n);
  });

  it("burns only a served backing's outstanding claims (check 3)", async () => {
    const ctx = setup();
    const { oracle, pool, a, b } = ctx;
    const h = await history(ctx);
    const padding = walletNote(a.name, 0n, 9n);
    const nothing = walletNote(a.name, 0n, 10n);
    await refused(pool.admit(oracle.accept(burnStatement(a.name, 71n, h.burned.noteRoot, [h.change.nf, padding.nf], nothing.cm))), "SUPPLY");
    await refused(pool.admit(oracle.accept(burnStatement(b.name, 1n, h.burned.noteRoot, [h.change.nf, padding.nf], nothing.cm))), "SUPPLY");
    const stranger = makePoolBacking(SECRETS.carol, "GBP");
    await refused(pool.admit(oracle.accept(burnStatement(stranger.name, 1n, h.burned.noteRoot, [h.change.nf, padding.nf], nothing.cm))), "BACKING");
    expect(pool.outstanding(a.name)).toBe(70n);
    expect(pool.length).toBe(3n);
    const exact = walletNote(a.name, 0n, 11n);
    await pool.admit(oracle.accept(burnStatement(a.name, 70n, h.burned.noteRoot, [h.change.nf, padding.nf], exact.cm)));
    expect(pool.outstanding(a.name)).toBe(0n);
  });

  it("refuses an anchor that is not this pool's, a spent nullifier under any anchor, and equal nullifiers (check 4)", async () => {
    const ctx = setup();
    const { oracle, pool, a } = ctx;
    const h = await history(ctx);
    const out1 = walletNote(a.name, 30n, 12n);
    const out2 = walletNote(a.name, 30n, 13n);
    const fresh = walletNote(a.name, 0n, 14n);
    // A root that verifies a membership proof but never came from this pool's history is refused.
    await refused(pool.admit(oracle.accept(spendStatement(h.burned.noteRoot + 1n, [h.change.nf, fresh.nf], [out1.cm, out2.cm]))), "ANCHOR");
    // Respending under the newest anchor: the nullifier is the note's, not the anchor's.
    await refused(pool.admit(oracle.accept(spendStatement(h.burned.noteRoot, [h.alice.nf, fresh.nf], [out1.cm, out2.cm]))), "SPENT");
    await refused(pool.admit(oracle.accept(spendStatement(h.issued.noteRoot, [h.alice.nf, fresh.nf], [out1.cm, out2.cm]))), "SPENT");
    // A padding nullifier entered the spent set like any other.
    await refused(pool.admit(oracle.accept(spendStatement(h.burned.noteRoot, [h.change.nf, h.padding.nf], [out1.cm, out2.cm]))), "SPENT");
    // Across kinds: a burn cannot consume what a spend consumed.
    await refused(pool.admit(oracle.accept(burnStatement(a.name, 1n, h.burned.noteRoot, [h.bob.nf, fresh.nf], out1.cm))), "SPENT");
    await refused(pool.admit(oracle.accept(spendStatement(h.burned.noteRoot, [h.change.nf, h.change.nf], [out1.cm, out2.cm]))), "SPENT");
    expect(pool.length).toBe(3n);
    // An older anchor of this pool is still valid to spend against.
    expect((await pool.admit(oracle.accept(spendStatement(h.spent.noteRoot, [h.change.nf, fresh.nf], [out1.cm, out2.cm])))).sequence).toBe(4n);
  });

  it("refuses an output that exists, equal outputs, the zero output, and outputs that do not fit (check 5)", async () => {
    const ctx = setup();
    const { oracle, pool, a } = ctx;
    const h = await history(ctx);
    const fresh = walletNote(a.name, 0n, 14n);
    const out = walletNote(a.name, 60n, 15n);
    await refused(pool.admit(oracle.accept(spendStatement(h.burned.noteRoot, [h.change.nf, fresh.nf], [h.bob.cm, out.cm]))), "OUTPUT");
    await refused(pool.admit(oracle.accept(spendStatement(h.burned.noteRoot, [h.change.nf, fresh.nf], [out.cm, out.cm]))), "OUTPUT");
    await refused(pool.admit(oracle.accept(spendStatement(h.burned.noteRoot, [h.change.nf, fresh.nf], [out.cm, 0n]))), "OUTPUT");
    // Reissuing one commitment must not create two notes with one nullifier.
    await refused(pool.admit(oracle.accept({ ...h.issue, publicInputs: h.issue.publicInputs.map((v, i) => (i === 4 ? 7n : v)), obligorSignature: ed25519.sign(statementBytes(CONFIG_HASH, ISSUE, h.issue.publicInputs.map((v, i) => (i === 4 ? 7n : v))), SECRETS.backer) })), "OUTPUT");
    // The capacity bound, at the boundary (§4, §6 check 5): two outputs fit
    // with two leaves free and not with one. The accumulator is not reachable
    // from outside, so the predicate admission calls is what is tested.
    expect(outputsFit(NOTE_TREE_CAPACITY - 2n, 2)).toBe(true);
    expect(outputsFit(NOTE_TREE_CAPACITY - 1n, 2)).toBe(false);
    expect(outputsFit(NOTE_TREE_CAPACITY - 1n, 1)).toBe(true);
    expect(outputsFit(NOTE_TREE_CAPACITY, 1)).toBe(false);
    expect(outputsFit(NOTE_TREE_CAPACITY, 0)).toBe(true);
    expect(outputsFit(-1n, 0)).toBe(false);
    expect(pool.length).toBe(3n);
    expect(pool.historyHash()).toEqual(h.burned.historyHash);
  });

  it("registers only a backing whose E names this operator and configuration, with a valid signature", () => {
    const pool = new Pool(CONFIG, new Oracle());
    const a = signedPoolBacking(SECRETS.backer);
    pool.register(a.backing, a.signature);
    pool.register(a.backing, a.signature);
    expect(pool.directory()).toHaveLength(1);
    expect(() => pool.register(a.backing, new Uint8Array(64))).toThrow(PoolError);
    const transparent = makeTransparentBacking(SECRETS.backer);
    expect(() => pool.register(transparent, signBacking(SECRETS.backer, transparent))).toThrow(PoolError);
    const otherConfig = makePoolBacking(SECRETS.backer, "EUR", new Uint8Array(32).fill(1));
    expect(() => pool.register(otherConfig, signBacking(SECRETS.backer, otherConfig))).toThrow(PoolError);
    const otherOperator = makePoolBacking(SECRETS.backer, "EUR", CONFIG_HASH, KEYS.mallory);
    expect(() => pool.register(otherOperator, signBacking(SECRETS.backer, otherOperator))).toThrow(PoolError);
    expect(pool.backing(a.backing.name)?.backing.name).toEqual(a.backing.name);
    expect(pool.backing(otherConfig.name)).toBeUndefined();
    expect(() => new Pool({ ...CONFIG, operator: new Uint8Array(32) }, new Oracle())).toThrow(PoolError);
  });

  it("admits one of two concurrent conflicting spends, and both copies of one statement once", async () => {
    const ctx = setup();
    const { oracle, pool, a } = ctx;
    const h = await history(ctx);
    const fresh = walletNote(a.name, 0n, 14n);
    const out1 = walletNote(a.name, 30n, 12n);
    const out2 = walletNote(a.name, 30n, 13n);
    const other1 = walletNote(a.name, 20n, 17n);
    const other2 = walletNote(a.name, 40n, 18n);
    const first = oracle.accept(spendStatement(h.burned.noteRoot, [h.change.nf, fresh.nf], [out1.cm, out2.cm]));
    const second = oracle.accept(spendStatement(h.burned.noteRoot, [h.change.nf, fresh.nf], [other1.cm, other2.cm]));
    const outcomes = await Promise.allSettled([pool.admit(first), pool.admit(second), pool.admit(first)]);
    expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect((outcomes[1] as PromiseRejectedResult).reason).toMatchObject({ code: "SPENT" });
    expect((outcomes[0] as PromiseFulfilledResult<unknown>).value).toEqual((outcomes[2] as PromiseFulfilledResult<unknown>).value);
    expect(pool.length).toBe(4n);
    expect(pool.leaves()).toHaveLength(6);
  });
});

describe("pool-v1 §7: the history, the directory and replay", () => {
  it("serves a directory of snapshot digests that a commitment can root, changing with every statement", async () => {
    const ctx = setup();
    const { pool, a, b } = ctx;
    const genesisDirectory = pool.directory();
    expect(genesisDirectory.map((e) => e.name)).toEqual([a.name, b.name].sort((x, y) => Buffer.compare(x, y)));
    expect(genesisDirectory.find((e) => Buffer.compare(e.name, a.name) === 0)?.digest).toEqual(snapshotDigest(a.name, genesisHistoryHash(CONFIG_HASH), 0n, 0n));
    expect(() => directoryRoot(genesisDirectory)).not.toThrow();
    const h = await history(ctx);
    expect(pool.snapshot(a.name)).toEqual(snapshotDigest(a.name, h.burned.historyHash, 100n, 30n));
    // Every backing in one pool shares the pool's history hash, so b's digest moved too.
    expect(pool.snapshot(b.name)).toEqual(snapshotDigest(b.name, h.burned.historyHash, 0n, 0n));
    expect(pool.snapshot(b.name)).not.toEqual(genesisDirectory.find((e) => Buffer.compare(e.name, b.name) === 0)?.digest);
    expect(pool.snapshot(new Uint8Array(32))).toBeUndefined();
  });

  it("replays its own trail to the same history, roots and totals, verifying every proof again", async () => {
    const ctx = setup();
    const h = await history(ctx);
    const trail = ctx.pool.trail();
    expect(trail.statements).toHaveLength(3);
    const verifier = new Oracle();
    for (const statement of trail.statements) verifier.accept(statement);
    const replayed = await Pool.replay(trail, verifier);
    expect(verifier.calls).toBe(3);
    expect(replayed.historyHash()).toEqual(h.burned.historyHash);
    expect(replayed.noteRoot()).toBe(ctx.pool.noteRoot());
    expect(replayed.spentRoot()).toEqual(ctx.pool.spentRoot());
    expect(replayed.outstanding(ctx.a.name)).toBe(70n);
    expect(replayed.directory()).toEqual(ctx.pool.directory());
    expect(replayed.configHash).toEqual(configurationHash(trail.configuration));
    // A stranger with no oracle for one proof stops at it, with its number.
    const doubting = new Oracle();
    for (const statement of trail.statements.slice(0, 2)) doubting.accept(statement);
    await expect(Pool.replay(trail, doubting)).rejects.toMatchObject({ code: "PROOF", message: /statement 3/ });
  });

  it("accepts nothing it did not recompute: a prefix proves itself, and a reordered, repeated or unsigned trail fails", async () => {
    const ctx = setup();
    const h = await history(ctx);
    const trail = ctx.pool.trail();
    const verifier = new Oracle();
    for (const statement of trail.statements) verifier.accept(statement);
    const prefix = await Pool.replay({ ...trail, statements: trail.statements.slice(0, 2) }, verifier);
    expect(prefix.historyHash()).toEqual(h.spent.historyHash);
    expect(prefix.historyHash()).not.toEqual(h.burned.historyHash);
    expect(prefix.outstanding(ctx.a.name)).toBe(100n);
    const reordered: Trail = { ...trail, statements: [trail.statements[1] as Statement, trail.statements[0] as Statement, trail.statements[2] as Statement] };
    await expect(Pool.replay(reordered, verifier)).rejects.toMatchObject({ code: "ANCHOR", message: /statement 1/ });
    const repeated: Trail = { ...trail, statements: [...trail.statements, trail.statements[0] as Statement] };
    await expect(Pool.replay(repeated, verifier)).rejects.toMatchObject({ code: "MALFORMED", message: /statement 4 repeats statement 1/ });
    // Without a backing's signed terms the issuances naming it cannot be verified, and replay stops there.
    await expect(Pool.replay({ ...trail, backings: trail.backings.filter((s) => Buffer.compare(s.backing.name, ctx.a.name) !== 0) }, verifier))
      .rejects.toMatchObject({ code: "BACKING", message: /statement 1/ });
    // Another configuration is another pool: the served backings name this one, not that one.
    await expect(Pool.replay({ ...trail, configuration: { ...trail.configuration, pool: new Uint8Array(32).fill(5) } }, verifier))
      .rejects.toMatchObject({ code: "BACKING" });
    // And statements naming another pool under this configuration fail at the first of them.
    const otherPool: Trail = { ...trail, statements: trail.statements.map((s) => ({ ...s, publicInputs: s.publicInputs.map((v, i) => (i === 0 ? v + 1n : v)) })) };
    for (const statement of otherPool.statements) verifier.accept(statement);
    await expect(Pool.replay(otherPool, verifier)).rejects.toMatchObject({ code: "MALFORMED", message: /statement 1/ });
  });

  it("binds the spent set into the history: two histories with equal note roots and different spends differ", async () => {
    // Both pools issue two notes of one value to one owner, then spend one of
    // them to the same two outputs. Note roots and lengths agree; the
    // nullifiers do not; the history hashes must not.
    const build = async (spendSecond: boolean) => {
      const ctx = setup();
      const { oracle, pool, a } = ctx;
      const first = walletNote(a.name, 50n, 21n);
      const second = walletNote(a.name, 50n, 22n);
      const i1 = await pool.admit(oracle.accept(issueStatement(a.name, 50n, first.cm, SECRETS.backer)));
      const i2 = await pool.admit(oracle.accept(issueStatement(a.name, 50n, second.cm, SECRETS.backer)));
      expect(i1.sequence).toBe(1n);
      const padding = walletNote(a.name, 0n, 23n);
      const out1 = walletNote(a.name, 20n, 24n);
      const out2 = walletNote(a.name, 30n, 25n);
      const spent = spendSecond ? second : first;
      await pool.admit(oracle.accept(spendStatement(i2.noteRoot, [spent.nf, padding.nf], [out1.cm, out2.cm])));
      return pool;
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
    // Seeds past 2^100, so a secret or rho is a long number that cannot appear by chance.
    const h = await history(ctx, 1n << 100n);
    const trail = ctx.pool.trail();
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
    expect(ctx.pool.trail().statements[0]?.proof).toEqual(h.issue.proof);
    const record = ctx.pool.acceptedStatement(h.issued.statementHash) as { historyHash: Uint8Array };
    record.historyHash[0] = (record.historyHash[0] as number) ^ 1;
    expect(ctx.pool.acceptedStatement(h.issued.statementHash)?.historyHash).toEqual(h.issued.historyHash);
    expect(SPEND).toBe(2);
  });
});

describe("pool-v1 §6: what leaves the pool aliases nothing, and what it trusts is checked", () => {
  it("serves copies of a backing's terms: rewriting a served copy's obligor grants no authority", async () => {
    const { oracle, pool, a } = setup();
    const alice = walletNote(a.name, 100n, 1n);
    const served = pool.backing(a.name) as { backing: { obligor: Uint8Array } };
    served.backing.obligor.set(KEYS.mallory);
    const trail = pool.trail();
    (trail.backings[0]?.backing.obligor as Uint8Array).set(KEYS.mallory);
    (trail.backings[0]?.backing.evidence as { configuration: Uint8Array }).configuration.fill(0);
    await refused(pool.admit(oracle.accept(issueStatement(a.name, 100n, alice.cm, SECRETS.mallory))), "SIGNATURE");
    expect((await pool.admit(oracle.accept(issueStatement(a.name, 100n, alice.cm, SECRETS.backer)))).sequence).toBe(1n);
    expect(pool.backing(a.name)?.backing.obligor).toEqual(KEYS.backer);
    // The configuration and its hash are copies too.
    pool.configuration.pool.fill(0);
    pool.configHash.fill(0);
    expect(pool.configHash).toEqual(CONFIG_HASH);
    expect(pool.configuration).toEqual(CONFIG);
  });

  it("refuses a verifier whose circuits are not the configuration's, where the verifier can say", () => {
    const matching = Object.assign(new Oracle(), { identities: { issue: CONFIG.issue, spend: CONFIG.spend, burn: CONFIG.burn } });
    expect(() => new Pool(CONFIG, matching)).not.toThrow();
    const other = Object.assign(new Oracle(), {
      identities: { issue: CONFIG.issue, spend: CONFIG.spend, burn: { bytecode: CONFIG.burn.bytecode, vk: new Uint8Array(32) } },
    });
    expect(() => new Pool(CONFIG, other)).toThrow(PoolError);
    expect(() => new Pool(CONFIG, other)).toThrow(/burn/);
    expect(() => new Pool(CONFIG, new Oracle())).not.toThrow();
  });

  it("answers a malformed backing or configuration with a PoolError, and numbers a replay's failing statement", async () => {
    const pool = new Pool(CONFIG, new Oracle());
    let caught: unknown;
    try {
      pool.register({} as never, new Uint8Array(64));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: "PoolError", code: "BACKING" });
    try {
      new Pool({ ...CONFIG, pool: new Uint8Array(31) }, new Oracle());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: "PoolError", code: "CONFIGURATION" });
    const ctx = setup();
    await history(ctx);
    const trail = ctx.pool.trail();
    const doubting = new Oracle();
    doubting.accept(trail.statements[0] as Statement);
    await expect(Pool.replay(trail, doubting)).rejects.toMatchObject({ code: "PROOF", sequence: 2n });
    const repeated: Trail = { ...trail, statements: [trail.statements[0] as Statement, trail.statements[0] as Statement] };
    await expect(Pool.replay(repeated, doubting)).rejects.toMatchObject({ code: "MALFORMED", sequence: 2n });
  });

  it("answers a resubmission with its record before reading its evidence, and refuses a signature over other bytes", async () => {
    const ctx = setup();
    const h = await history(ctx);
    expect(await ctx.pool.admit({ ...h.spend, proof: new Uint8Array(0) })).toEqual(h.spent);
    expect(await ctx.pool.admit({ ...h.issue, obligorSignature: undefined } as unknown as Statement)).toEqual(h.issued);
    expect(ctx.pool.length).toBe(3n);
    const alice = walletNote(ctx.a.name, 7n, 30n);
    const issue = issueStatement(ctx.a.name, 7n, alice.cm, SECRETS.backer);
    const otherInputs = issue.publicInputs.map((v, i) => (i === 4 ? 8n : v));
    const overOtherInputs = ctx.oracle.accept({ ...issue, obligorSignature: ed25519.sign(statementBytes(CONFIG_HASH, ISSUE, otherInputs), SECRETS.backer) });
    await refused(ctx.pool.admit(overOtherInputs), "SIGNATURE");
    const burnInputs = [...issue.publicInputs, 1n, 2n, 3n];
    const overOtherKind = ctx.oracle.accept({ ...issue, obligorSignature: ed25519.sign(statementBytes(CONFIG_HASH, BURN, burnInputs), SECRETS.backer) });
    await refused(ctx.pool.admit(overOtherKind), "SIGNATURE");
    // A verifier answering anything but `true` is a refusal.
    const yes = { verify: async () => "yes" as unknown as boolean };
    const trusting = new Pool(CONFIG, yes);
    trusting.register(ctx.a, signBacking(SECRETS.backer, ctx.a));
    await refused(trusting.admit(issue), "PROOF");
  });
});
