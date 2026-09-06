import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { directoryRoot, signCommitment } from "../src/commitment.js";
import { EMPTY_NOTE_ROOT } from "../src/pool/note-tree.js";
import { PoolError, Segment, type FinalizedPrefix, type ImportEvidence } from "../src/pool/segment.js";
import { poolReceiptInHistory, signPoolReceipt, verifyPoolReceipt } from "../src/pool/receipt.js";
import { genesisHistoryHash, segmentAuthority, snapshotDigest, type SegmentHeader } from "../src/pool/statement.js";
import {
  burnStatement, checkpointOf, CONFIG, evidenceOf, headerOf, issueStatement, Oracle, openSegment, OPERATOR_Q, signedPoolBacking,
  spendStatement, VENUE, walletNote,
} from "./pool-support.js";
import { KEYS, pub, SECRETS } from "./support.js";

// pool-v2 §10 (import and replay) and C2.10.5–7, over the frames: two
// backings served together, split between two operators after a witnessed
// replacement (the record itself is off-stage: the headers name the links
// and the openings the sequencing rules would derive), and reunited. What
// the record decides — which opening is canonical, whether a checkpoint is
// final, whether a term ended — is the sequencer's; this checks what a
// segment computes from the evidence it is handed, and what it refuses.

const fill = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const Q = pub(OPERATOR_Q);
const LINK_Q = fill(0x51);

async function refused(promise: Promise<unknown>, code: PoolError["code"], message?: RegExp): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "PoolError", code, ...(message ? { message } : {}) });
}

function thrown(body: () => unknown, code: PoolError["code"], message?: RegExp): void {
  let caught: unknown;
  try {
    body();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ name: "PoolError", code, ...(message ? { message } : {}) });
}

/** P serves X and Y from the empty book, issues one note of each, and commits: the shared ancestor. */
async function shared() {
  const oracle = new Oracle();
  const x = signedPoolBacking(SECRETS.backer, "EUR");
  const y = signedPoolBacking(SECRETS.backer2, "USD");
  const s1 = openSegment(headerOf([{ backing: x.backing.name }, { backing: y.backing.name }]), [x, y], [], oracle);
  const xNote = walletNote(x.backing.name, 100n, 1n);
  const yNote = walletNote(y.backing.name, 100n, 2n);
  await s1.segment.admit(oracle.accept(issueStatement(s1.authority, x.backing.name, 100n, xNote.cm, SECRETS.backer)));
  await s1.segment.admit(oracle.accept(issueStatement(s1.authority, y.backing.name, 100n, yNote.cm, SECRETS.backer2)));
  const c1 = checkpointOf(s1.segment, SECRETS.operator, 1n);
  return { oracle, x, y, s1, xNote, yNote, c1 };
}

/** After X is replaced to Q: Q serves X from c1, P serves Y from c1 in a new segment. Each spends its note and commits. */
async function split(f: Awaited<ReturnType<typeof shared>>, seed = 10n) {
  const { oracle, x, y, s1, xNote, yNote, c1 } = f;
  const s2 = openSegment(headerOf([{ backing: x.backing.name, link: LINK_Q, opening: c1.opening }], Q, 1n), [x], [s1.segment.prefix()], oracle);
  const s3 = openSegment(headerOf([{ backing: y.backing.name, opening: c1.opening }], KEYS.operator, 2n), [y], [s1.segment.prefix()], oracle);
  const anchor = s1.segment.noteRoot();
  const xPadding = walletNote(x.backing.name, 0n, seed);
  const xOut = walletNote(x.backing.name, 100n, seed + 1n);
  const xZero = walletNote(x.backing.name, 0n, seed + 2n);
  const xSpend = oracle.accept(spendStatement(s2.authority, [anchor, anchor], [xNote.nf, xPadding.nf], [xOut.cm, xZero.cm]));
  await s2.segment.admit(xSpend);
  const yPadding = walletNote(y.backing.name, 0n, seed + 3n);
  const yOut = walletNote(y.backing.name, 100n, seed + 4n);
  const yZero = walletNote(y.backing.name, 0n, seed + 5n);
  const ySpend = oracle.accept(spendStatement(s3.authority, [anchor, EMPTY_NOTE_ROOT], [yNote.nf, yPadding.nf], [yOut.cm, yZero.cm]));
  await s3.segment.admit(ySpend);
  const c2 = checkpointOf(s2.segment, OPERATOR_Q, 1n);
  const c3 = checkpointOf(s3.segment, SECRETS.operator, 2n);
  return { s2, s3, c2, c3, xOut, yOut, xSpend, ySpend };
}

describe("C2.10.5–7: a segment imports finalized prefixes, deduplicates shared history and refuses conflicts", () => {
  it("owns later statements and all opening evidence before proof verification yields", async () => {
    const f = await shared();
    const { s2, s3, c2, c3 } = await split(f);
    const header = headerOf([
      { backing: f.x.backing.name, opening: c2.opening },
      { backing: f.y.backing.name, opening: c3.opening },
    ], KEYS.operator, 3n);
    const target = openSegment(header, [f.x, f.y], [s2.segment.prefix(), s3.segment.prefix()], f.oracle);
    const trail = target.segment.trail();
    const evidence = [evidenceOf(f.s1.segment, f.c1), evidenceOf(s2.segment, c2), evidenceOf(s3.segment, c3)];
    const replay = Segment.replay(trail, f.oracle, evidence);
    // Replay has entered the first asynchronous proof. Later ancestors,
    // checkpoint signatures, configuration and registered terms are still pending.
    for (const item of evidence) {
      item.checkpoint.commitment.signature.fill(0);
      item.checkpoint.directory[0]!.digest.fill(0);
      item.trail.statements.at(-1)!.proof.fill(0);
      item.trail.header.operator.fill(0);
    }
    trail.configuration.issue.vk.fill(0);
    trail.backings[0]!.signature.fill(0);
    expect((await replay).directory()).toEqual(target.segment.directory());

    const local = f.s1.segment.trail();
    const localReplay = Segment.replay(local, f.oracle);
    local.statements[1]!.proof.fill(0);
    (local.statements as unknown[]).push(local.statements[0]);
    expect((await localReplay).directory()).toEqual(f.s1.segment.directory());
  });

  it("refuses a signed checkpoint before its segment's first commitment sequence", async () => {
    const oracle = new Oracle();
    const x = signedPoolBacking(SECRETS.backer);
    const predecessor = openSegment(headerOf([{ backing: x.backing.name }], KEYS.operator, 5n), [x], [], oracle);
    const early = checkpointOf(predecessor.segment, SECRETS.operator, 4n);
    const header = headerOf([{ backing: x.backing.name, link: LINK_Q, opening: early.opening }], Q);
    thrown(() => openSegment(header, [x], [predecessor.segment.prefix()], oracle), "IMPORT", /predates/);
    await refused(Segment.replay({ configuration: CONFIG, header, backings: [x], statements: [] }, oracle,
      [evidenceOf(predecessor.segment, early)]), "IMPORT", /predates/);
    const first = checkpointOf(predecessor.segment, SECRETS.operator, 5n);
    const valid = openSegment(headerOf([{ backing: x.backing.name, link: LINK_Q, opening: first.opening }], Q), [x], [predecessor.segment.prefix()], oracle);
    expect((await Segment.replay(valid.segment.trail(), oracle, [evidenceOf(predecessor.segment, first)])).directory()).toEqual(valid.segment.directory());
  });

  it("splits and rejoins shared history once, with distinct input anchors and immutable nullifiers", async () => {
    const f = await shared();
    const { oracle, x, y, s1, xNote, c1 } = f;
    const { s2, s3, c2, c3, xOut, yOut } = await split(f);
    // Each split segment holds the shared ancestor's events, roots and spentness, and starts its own tree.
    for (const s of [s2, s3]) {
      expect(s.segment.events().slice(0, 2).map((e) => e.position)).toEqual([1n, 2n]);
      expect(s.segment.isAnchor(s1.segment.noteRoot())).toBe(true);
      expect(s.segment.isAnchor(EMPTY_NOTE_ROOT)).toBe(true);
      expect(s.segment.leaves()).toHaveLength(2);
    }
    expect(s2.segment.outstanding(x.backing.name)).toBe(100n);
    expect(s2.segment.outstanding(y.backing.name)).toBeUndefined();
    expect(s3.segment.outstanding(y.backing.name)).toBe(100n);
    expect(s2.segment.isSpent(xNote.nf)).toBe(true);
    expect(s3.segment.isSpent(xNote.nf)).toBe(false);
    // X returns to P: one segment over both, opened from each backing's latest checkpoint.
    const s4 = openSegment(headerOf([{ backing: x.backing.name, link: fill(0x52), opening: c2.opening }, { backing: y.backing.name, opening: c3.opening }], KEYS.operator, 3n),
      [x, y], [s2.segment.prefix(), s3.segment.prefix()], oracle);
    expect(s4.segment.events()).toHaveLength(4);
    expect(s4.segment.outstanding(x.backing.name)).toBe(100n);
    expect(s4.segment.outstanding(y.backing.name)).toBe(100n);
    expect(s4.segment.isSpent(xNote.nf)).toBe(true);
    expect(s4.segment.isSpent(f.yNote.nf)).toBe(true);
    await refused(s4.segment.admit(oracle.accept(spendStatement(s4.authority, [s1.segment.noteRoot(), s1.segment.noteRoot()], [xNote.nf, walletNote(x.backing.name, 0n, 99n).nf], [walletNote(x.backing.name, 100n, 98n).cm, walletNote(x.backing.name, 0n, 97n).cm]))), "SPENT");
    // A mixed spend of the two outputs against their own histories' roots.
    const anchors: [bigint, bigint] = [s2.segment.noteRoot(), s3.segment.noteRoot()];
    expect(anchors[0]).not.toBe(anchors[1]);
    const outX = walletNote(x.backing.name, 100n, 20n);
    const outY = walletNote(y.backing.name, 100n, 21n);
    const mixed = oracle.accept(spendStatement(s4.authority, anchors, [xOut.nf, yOut.nf], [outX.cm, outY.cm]));
    expect((await s4.segment.admit(mixed)).position).toBe(1n);
    expect(s4.segment.isSpent(xOut.nf) && s4.segment.isSpent(yOut.nf)).toBe(true);
    // The directory carries both backings over the segment's history and cumulative totals.
    const history = s4.segment.historyHash();
    expect(s4.segment.directory().map((e) => e.digest)).toEqual(
      [x.backing.name, y.backing.name].sort((a, b) => Buffer.compare(a, b)).map((name) => snapshotDigest(name, s4.authority.segment, history, 100n, 0n)),
    );
    expect(c1.length).toBe(2n);
  });

  it("replays a reunited segment from trails and checkpoint evidence to the same state, and refuses missing or tampered evidence", async () => {
    const f = await shared();
    const { oracle, x, y, s1 } = f;
    const { s2, s3, c2, c3, xOut, yOut } = await split(f);
    const s4 = openSegment(headerOf([{ backing: x.backing.name, link: fill(0x52), opening: c2.opening }, { backing: y.backing.name, opening: c3.opening }], KEYS.operator, 3n),
      [x, y], [s2.segment.prefix(), s3.segment.prefix()], oracle);
    const mixed = oracle.accept(spendStatement(s4.authority, [s2.segment.noteRoot(), s3.segment.noteRoot()], [xOut.nf, yOut.nf], [walletNote(x.backing.name, 100n, 20n).cm, walletNote(y.backing.name, 100n, 21n).cm]));
    const accepted = await s4.segment.admit(mixed);
    const evidence: ImportEvidence[] = [evidenceOf(s1.segment, f.c1), evidenceOf(s2.segment, c2), evidenceOf(s3.segment, c3)];
    const replayed = await Segment.replay(s4.segment.trail(), oracle, evidence);
    expect(replayed.historyHash()).toEqual(s4.segment.historyHash());
    expect(replayed.directory()).toEqual(s4.segment.directory());
    expect(replayed.spentRoot()).toEqual(s4.segment.spentRoot());
    expect(replayed.events()).toEqual(s4.segment.events());
    const receipt = signPoolReceipt(SECRETS.operator, s4.authority, accepted, 3n);
    expect(poolReceiptInHistory(replayed, receipt)).toBe(true);
    expect(verifyPoolReceipt(s2.authority, receipt)).toBe(false);
    // c1 is only reachable through c2 and c3; without it, their replay stops.
    await refused(Segment.replay(s4.segment.trail(), oracle, evidence.slice(1)), "IMPORT", /no evidence/);
    await refused(Segment.replay(s4.segment.trail(), oracle, evidence.slice(0, 2)), "IMPORT", /no evidence/);
    await refused(Segment.replay(s4.segment.trail(), oracle, []), "IMPORT");
    // A tampered digest, a longer length, another operator's trail, a broken signature, another venue.
    const tampered = c2.checkpoint.directory.map((e) => ({ name: e.name, digest: sha256(e.digest) }));
    const forgedC2 = { commitment: signCommitment(OPERATOR_Q, 1n, directoryRoot(tampered)), directory: tampered };
    await refused(Segment.replay(s4.segment.trail(), oracle, [evidence[0]!, { ...evidence[1]!, checkpoint: forgedC2 }, evidence[2]!]), "IMPORT", /no evidence/);
    await refused(Segment.replay(s4.segment.trail(), oracle, [evidence[0]!, { ...evidence[1]!, checkpoint: { ...c2.checkpoint, directory: tampered } }, evidence[2]!]), "IMPORT", /directory/);
    await refused(Segment.replay(s4.segment.trail(), oracle, [evidence[0]!, { ...evidence[1]!, length: 0n }, evidence[2]!]), "IMPORT", /replayed prefix/);
    await refused(Segment.replay(s4.segment.trail(), oracle, [evidence[0]!, { ...evidence[1]!, length: 5n }, evidence[2]!]), "IMPORT", /length/);
    await refused(Segment.replay(s4.segment.trail(), oracle, [evidence[0]!, { ...evidence[1]!, trail: s3.segment.trail() }, evidence[2]!]), "IMPORT", /operator/);
    const unsigned = { ...c2.checkpoint, commitment: { ...c2.checkpoint.commitment, signature: new Uint8Array(64) } };
    await refused(Segment.replay(s4.segment.trail(), oracle, [evidence[0]!, { ...evidence[1]!, checkpoint: unsigned }, evidence[2]!]), "IMPORT", /verify/);
    const otherVenue = { ...s2.segment.trail(), header: { ...s2.segment.header, venue: fill(0x34) } };
    await refused(Segment.replay(s4.segment.trail(), oracle, [evidence[0]!, { ...evidence[1]!, trail: otherVenue }, evidence[2]!]), "IMPORT", /venue/);
    // An ancestor whose own proof no longer verifies stops the replay, positioned in the imported segment.
    const doubting = new Oracle();
    for (const item of evidence) for (const s of item.trail.statements) doubting.accept(s);
    doubting.accept(mixed);
    const distrusting = new Oracle();
    for (const s of evidence[0]!.trail.statements) distrusting.accept(s);
    for (const s of evidence[2]!.trail.statements) distrusting.accept(s);
    distrusting.accept(mixed);
    expect(await Segment.replay(s4.segment.trail(), doubting, evidence).then((s) => s.length)).toBe(1n);
    await refused(Segment.replay(s4.segment.trail(), distrusting, evidence), "PROOF", /imported segment: statement 1/);
  });

  it("carries lit burn deltas once through shared imports, and counts shared issuance once", async () => {
    const f = await shared();
    const { oracle, x, y, s1, xNote } = f;
    const anchor = s1.segment.noteRoot();
    const change = walletNote(x.backing.name, 60n, 30n);
    await s1.segment.admit(oracle.accept(burnStatement(s1.authority, x.backing.name, 40n, [anchor, anchor], [xNote.nf, walletNote(x.backing.name, 0n, 31n).nf], change.cm)));
    const c1 = checkpointOf(s1.segment, SECRETS.operator, 1n);
    const s2 = openSegment(headerOf([{ backing: x.backing.name, link: LINK_Q, opening: c1.opening }], Q, 1n), [x], [s1.segment.prefix()], oracle);
    const s3 = openSegment(headerOf([{ backing: y.backing.name, opening: c1.opening }], KEYS.operator, 2n), [y], [s1.segment.prefix()], oracle);
    const c2 = checkpointOf(s2.segment, OPERATOR_Q, 1n);
    const c3 = checkpointOf(s3.segment, SECRETS.operator, 2n);
    const s4 = openSegment(headerOf([{ backing: x.backing.name, link: fill(0x52), opening: c2.opening }, { backing: y.backing.name, opening: c3.opening }], KEYS.operator, 3n),
      [x, y], [s2.segment.prefix(), s3.segment.prefix()], oracle);
    expect(s4.segment.events()).toHaveLength(3);
    expect(s4.segment.issued(x.backing.name)).toBe(100n);
    expect(s4.segment.burned(x.backing.name)).toBe(40n);
    expect(s4.segment.outstanding(x.backing.name)).toBe(60n);
    expect(s4.segment.issued(y.backing.name)).toBe(100n);
    expect(s4.segment.isSpent(xNote.nf)).toBe(true);
    expect(s4.segment.isAnchor(s1.segment.noteRoot())).toBe(true);
    // The change note, created in the shared ancestor, spends in the reunited segment against that ancestor's root.
    const out = walletNote(x.backing.name, 60n, 32n);
    expect((await s4.segment.admit(oracle.accept(spendStatement(s4.authority, [s1.segment.noteRoot(), EMPTY_NOTE_ROOT], [change.nf, walletNote(x.backing.name, 0n, 33n).nf], [out.cm, walletNote(x.backing.name, 0n, 34n).cm])))).position).toBe(1n);
    // Two histories importing one closure in either order agree on the opening spent root.
    const forward = openSegment(headerOf([{ backing: x.backing.name, link: fill(0x53), opening: c2.opening }, { backing: y.backing.name, opening: c3.opening }], KEYS.operator, 4n), [], [s2.segment.prefix(), s3.segment.prefix()], oracle);
    const backward = openSegment(headerOf([{ backing: x.backing.name, link: fill(0x53), opening: c2.opening }, { backing: y.backing.name, opening: c3.opening }], KEYS.operator, 4n), [], [s3.segment.prefix(), s2.segment.prefix()], oracle);
    expect(forward.segment.spentRoot()).toEqual(backward.segment.spentRoot());
    expect(forward.segment.historyHash()).toEqual(genesisHistoryHash(forward.authority.segment));
  });

  it("does not carry an unwitnessed tail: its roots are not anchors and its payments are re-proven with unchanged nullifiers", async () => {
    const f = await shared();
    const { oracle, x, s1, xNote, c1 } = f;
    // P's tail after the checkpoint: X's note spent, an output created.
    const anchor = s1.segment.noteRoot();
    const tailOut = walletNote(x.backing.name, 100n, 40n);
    const tail = oracle.accept(spendStatement(s1.authority, [anchor, anchor], [xNote.nf, walletNote(x.backing.name, 0n, 41n).nf], [tailOut.cm, walletNote(x.backing.name, 0n, 42n).cm]));
    await s1.segment.admit(tail);
    const tailRoot = s1.segment.noteRoot();
    // Q opens from the checkpoint at length 2, not from P's held state.
    const s2 = openSegment(headerOf([{ backing: x.backing.name, link: LINK_Q, opening: c1.opening }], Q, 1n), [x], [s1.segment.prefix(2n)], oracle);
    expect(s2.segment.isAnchor(anchor)).toBe(true);
    expect(s2.segment.isAnchor(tailRoot)).toBe(false);
    expect(s2.segment.isSpent(xNote.nf)).toBe(false);
    await refused(s2.segment.admit(oracle.accept(spendStatement(s2.authority, [tailRoot, tailRoot], [tailOut.nf, walletNote(x.backing.name, 0n, 43n).nf], [walletNote(x.backing.name, 100n, 44n).cm, walletNote(x.backing.name, 0n, 45n).cm]))), "ANCHOR");
    // The tail's payment, re-proven under Q's segment: another statement, the same nullifiers and outputs.
    const reproven = oracle.accept(spendStatement(s2.authority, [anchor, anchor], [xNote.nf, walletNote(x.backing.name, 0n, 41n).nf], [tailOut.cm, walletNote(x.backing.name, 0n, 42n).cm]));
    expect(reproven.publicInputs.slice(5)).toEqual(tail.publicInputs.slice(5));
    expect(reproven.publicInputs.slice(2, 5)).not.toEqual(tail.publicInputs.slice(2, 5));
    expect((await s2.segment.admit(reproven)).position).toBe(1n);
    expect(s2.segment.leaves()).toEqual([tailOut.cm, walletNote(x.backing.name, 0n, 42n).cm]);
    // The full-length prefix is not the checkpoint's: its directory differs from what P committed.
    expect(s1.segment.prefix(2n).directory).toEqual(c1.checkpoint.directory);
    expect(s1.segment.prefix().directory).not.toEqual(c1.checkpoint.directory);
    thrown(() => openSegment(headerOf([{ backing: x.backing.name, link: LINK_Q, opening: c1.opening }], Q, 1n), [x], [s1.segment.prefix()], oracle), "IMPORT", /no finalized prefix/);
    expect(() => s1.segment.prefix(4n)).toThrow(PoolError);
  });

  it("refuses conflicting prefixes of one segment, a nullifier or output in two distinct events, and out-of-bound totals", async () => {
    const f = await shared();
    const { oracle, x, y, s1, c1 } = f;
    const prefix = s1.segment.prefix();
    const header = headerOf([{ backing: x.backing.name, link: LINK_Q, opening: c1.opening }], Q, 1n);
    const rewrite = (p: FinalizedPrefix, change: (events: FinalizedPrefix["events"][number][]) => FinalizedPrefix["events"][number][]): FinalizedPrefix => ({ ...p, events: change(p.events.map((e) => ({ ...e }))) });
    // A second prefix of the same segment with another statement, or other effects, at one position: a conflict, not a union.
    const conflicting = rewrite(prefix, (events) => { events[0] = { ...events[0]!, statementHash: fill(0xaa) }; return events; });
    thrown(() => new Segment(CONFIG, header, [prefix, conflicting], oracle), "IMPORT", /conflicting/);
    const otherEffects = rewrite(prefix, (events) => { events[0] = { ...events[0]!, outputs: [fill(0xab).length === 32 ? 0xabn : 0n] }; return events; });
    thrown(() => new Segment(CONFIG, header, [prefix, otherEffects], oracle), "IMPORT", /conflicting/);
    // One nullifier in two distinct events, or one output, is refused however the prefixes are otherwise consistent:
    // Q's segment over X and P's over Y each spend their note; Q's spend forged to name Y's nullifier, or Y's output.
    const other = openSegment(headerOf([{ backing: y.backing.name, opening: c1.opening }], KEYS.operator, 2n), [y], [prefix], oracle);
    const second = openSegment(header, [x], [prefix], oracle);
    const anchor = s1.segment.noteRoot();
    const yOut = walletNote(y.backing.name, 100n, 51n);
    await other.segment.admit(oracle.accept(spendStatement(other.authority, [anchor, anchor], [f.yNote.nf, walletNote(y.backing.name, 0n, 50n).nf], [yOut.cm, walletNote(y.backing.name, 0n, 52n).cm])));
    await second.segment.admit(oracle.accept(spendStatement(second.authority, [anchor, anchor], [f.xNote.nf, walletNote(x.backing.name, 0n, 53n).nf], [walletNote(x.backing.name, 100n, 54n).cm, walletNote(x.backing.name, 0n, 55n).cm])));
    const c2 = checkpointOf(second.segment, OPERATOR_Q, 1n);
    const c3 = checkpointOf(other.segment, SECRETS.operator, 2n);
    const reunited = headerOf([{ backing: x.backing.name, link: fill(0x52), opening: c2.opening }, { backing: y.backing.name, opening: c3.opening }], KEYS.operator, 3n);
    expect(() => new Segment(CONFIG, reunited, [second.segment.prefix(), other.segment.prefix()], oracle)).not.toThrow();
    const forgedNullifier = rewrite(second.segment.prefix(), (events) => { events[2] = { ...events[2]!, nullifiers: [f.yNote.nf, events[2]!.nullifiers[1]!] }; return events; });
    thrown(() => new Segment(CONFIG, reunited, [forgedNullifier, other.segment.prefix()], oracle), "IMPORT", /nullifier/);
    const forgedOut = rewrite(second.segment.prefix(), (events) => { events[2] = { ...events[2]!, outputs: [yOut.cm, events[2]!.outputs[1]!] }; return events; });
    thrown(() => new Segment(CONFIG, reunited, [forgedOut, other.segment.prefix()], oracle), "IMPORT", /output/);
    // A prefix whose directory does not match its own events, or whose local events do not match its length, is malformed.
    thrown(() => new Segment(CONFIG, header, [rewrite(prefix, (events) => events.slice(0, 1))], oracle), "IMPORT", /length/);
    thrown(() => new Segment(CONFIG, header, [{ ...prefix, historyHash: fill(1) }], oracle), "IMPORT", /directory/);
    thrown(() => new Segment(CONFIG, header, [{ ...prefix, length: 1n }], oracle), "IMPORT", /length/);
    thrown(() => new Segment(CONFIG, header, [rewrite(prefix, (events) => { events[0] = { ...events[0]!, lit: { kind: 1, backing: x.backing.name, quantity: (1n << 64n) - 1n } }; return events; })], oracle), "IMPORT");
    thrown(() => new Segment(CONFIG, header, [rewrite(prefix, (events) => { events[0] = { ...events[0]!, lit: { kind: 3, backing: x.backing.name, quantity: 1n } }; return events; })], oracle), "IMPORT");
    // Totals over the closure hold every backing to the bounds, even one outside this scope.
    thrown(() => new Segment(CONFIG, header, [rewrite(prefix, (events) => { events[1] = { ...events[1]!, lit: { kind: 3, backing: y.backing.name, quantity: 1n } }; return events; })], oracle), "IMPORT");
    // A prefix no opening names, an opening with no prefix, and a prefix that does not scope the backing.
    thrown(() => new Segment(CONFIG, header, [prefix, other.segment.prefix()], oracle), "IMPORT", /no opening names/);
    thrown(() => new Segment(CONFIG, header, [], oracle), "IMPORT", /no finalized prefix/);
    thrown(() => new Segment(CONFIG, headerOf([{ backing: x.backing.name, link: LINK_Q, opening: c3.opening }], Q, 1n), [other.segment.prefix()], oracle), "IMPORT", /does not scope/);
    // Another venue or domain, and a malformed prefix.
    thrown(() => new Segment(CONFIG, { ...header, venue: fill(0x34) }, [prefix], oracle), "IMPORT", /venue/);
    thrown(() => new Segment(CONFIG, header, [{ ...prefix, header: { ...prefix.header, domain: fill(1) } }], oracle), "IMPORT");
    thrown(() => new Segment(CONFIG, header, [null as never], oracle), "IMPORT", /malformed/);
    thrown(() => new Segment(CONFIG, header, [{ ...prefix, roots: [1n << 254n] }], oracle), "IMPORT", /malformed/);
    // The same prefix supplied twice is one import.
    expect(() => new Segment(CONFIG, header, [prefix, s1.segment.prefix()], oracle)).not.toThrow();
  });

  it("refuses a header whose opening is this operator's own commitment at or past its sequence, and replays a same-operator chain", async () => {
    const f = await shared();
    const { oracle, x, y, s1, c1 } = f;
    const entries = [{ backing: x.backing.name, opening: c1.opening }, { backing: y.backing.name, opening: c1.opening }];
    thrown(() => new Segment(CONFIG, headerOf(entries, KEYS.operator, 1n), [s1.segment.prefix()], oracle), "SEGMENT");
    const reset = openSegment(headerOf(entries, KEYS.operator, 2n), [x, y], [s1.segment.prefix()], oracle);
    expect(reset.segment.events()).toHaveLength(2);
    const replayed = await Segment.replay(reset.segment.trail(), oracle, [evidenceOf(s1.segment, c1)]);
    expect(replayed.directory()).toEqual(reset.segment.directory());
    // A cycle in supplied evidence is refused rather than followed.
    const c2 = checkpointOf(reset.segment, SECRETS.operator, 2n);
    const cyclic: ImportEvidence = { ...evidenceOf(s1.segment, c1), trail: { ...s1.segment.trail(), header: headerOf(entries.map((e) => ({ ...e, opening: c2.opening })), KEYS.operator, 3n) } };
    await refused(Segment.replay(reset.segment.trail(), oracle, [cyclic, evidenceOf(reset.segment, c2)]), "IMPORT");
    const selfLoop: ImportEvidence = { ...evidenceOf(reset.segment, c2), trail: { ...reset.segment.trail(), header: headerOf(entries.map((e) => ({ ...e, opening: c2.opening })), KEYS.operator, 3n) } };
    await refused(Segment.replay({ ...reset.segment.trail(), header: headerOf(entries.map((e) => ({ ...e, opening: c2.opening })), KEYS.operator, 4n) }, oracle, [selfLoop]), "IMPORT");
  });

  it("serves prefixes at any length up to its own, each with the directory the checkpoint at that length carried", async () => {
    const f = await shared();
    const { s1, c1 } = f;
    const p0 = s1.segment.prefix(0n);
    expect(p0.length).toBe(0n);
    expect(p0.events).toEqual([]);
    expect(p0.roots).toEqual([EMPTY_NOTE_ROOT]);
    expect(p0.historyHash).toEqual(genesisHistoryHash(s1.authority.segment));
    const p1 = s1.segment.prefix(1n);
    expect(p1.events.map((e) => e.position)).toEqual([1n]);
    expect(p1.roots).toHaveLength(2);
    expect(p1.directory).not.toEqual(c1.checkpoint.directory);
    expect(s1.segment.prefix(2n).directory).toEqual(c1.checkpoint.directory);
    expect(s1.segment.prefix()).toEqual(s1.segment.prefix(2n));
    // The prefix owns its bytes and its header is the segment's.
    const p = s1.segment.prefix();
    p.header.operator.fill(0);
    (p.events[0] as { statementHash: Uint8Array }).statementHash.fill(0);
    expect(s1.segment.prefix().header.operator).toEqual(KEYS.operator);
    expect(s1.segment.events()[0]?.statementHash).not.toEqual(new Uint8Array(32));
    expect(segmentAuthority(s1.segment.prefix().header as SegmentHeader)).toEqual(s1.authority);
    expect(VENUE).toHaveLength(32);
  });
});
