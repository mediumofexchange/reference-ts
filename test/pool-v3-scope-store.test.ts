import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes } from "../src/bytes.js";
import { NoteTree } from "../src/pool/note-tree.js";
import { prepareExactOutput } from "../src/pool/v3/capsules.js";
import { decodeReceipt } from "../src/pool/v3/commitments.js";
import { configurationHash, RELATIONS, type CandidateConfiguration } from "../src/pool/v3/configuration.js";
import { decodeSegmentHeader } from "../src/pool/v3/headers.js";
import { readPackage } from "../src/pool/v3/package-reader.js";
import { decodeEvidencePackage, encodeEvidencePackage } from "../src/pool/v3/package.js";
import { mergeFinalizedPrefixes } from "../src/pool/v3/scope-reader.js";
import { encodePublication, encodeRecord, statementHash, type Record } from "../src/pool/v3/records.js";
import type { ServedPackage, V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import { decodeTrail } from "../src/pool/v3/trail.js";
import { authorizeIssue, demandTask, issueTask, spendTask, type NoteInput, type ProofTask, type SegmentContext } from "../src/pool/v3/witness.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { encodeReplacement, replacementHash, replacementMessage, type Replacement } from "../src/venue-records.js";

// Slice 7 M2: the journal opens, serves, splits and rejoins a two-backing scope
// (the story of scripts/pool/v3/scope-check.mjs) and an independent reader
// agrees per backing. Proof bytes are explicit stand-ins; real-key acceptance
// is a separate gate.
const b = (n: number) => new Uint8Array(32).fill(n), supported = Number(process.versions.node.split(".")[0]) >= 24;
const configuration: CandidateConfiguration = { helper: hexToBytes("44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8"),
  circuits: Object.fromEntries(RELATIONS.map((name, i) => [name, { bytecode: b(40 + i), vk: b(50 + i) }])) as CandidateConfiguration["circuits"] };
const domain = configurationHash(configuration), aSecret = b(16), bSecret = b(17), ruleSecret = b(19);
const issuerX = b(14), issuerY = b(15), aKey = ed25519.getPublicKey(aSecret), bKey = ed25519.getPublicKey(bSecret);
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const verifier = { verify: (kind: number, _inputs: readonly bigint[], proof: Uint8Array) => proof[0] === kind };
const record = (task: ProofTask): Record => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
  proof: new Uint8Array(32).fill(task.kind), authorization: new Uint8Array(), capsules: task.capsules });
const same = (a: Uint8Array, z: Uint8Array) => compareBytes(a, z) === 0;

describe.skipIf(!supported)("v3 journal over a multi-backing scope", () => {
  let V3OperatorJournal: typeof import("../src/pool/v3/store.js").V3OperatorJournal;
  const journals: Journal[] = [], directories: string[] = [], scratch = resolve("scratch");
  beforeAll(async () => { ({ V3OperatorJournal } = await import("../src/pool/v3/store.js")); });
  afterEach(() => {
    for (const j of journals.splice(0)) j.close();
    for (const directory of directories.splice(0)) {
      if (!resolve(directory).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function fixture(silence = false) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "v3-scope-journal-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const backingOf = (thing: string, issuer: Uint8Array, operator = aKey, silenced = silence) => {
      const terms = encodeRootTerms({ obligor: ed25519.getPublicKey(issuer), operator, replacementRule: ed25519.getPublicKey(ruleSecret),
        configuration: domain, venue: venue.id, interval: 30n, payout: { thing, quantumExponent: 0, perUnit: 1n },
        ...(silenced ? { silence: { noCommitmentDuration: 4n, challengeWindow: 5n } } : {}) });
      return { name: rootTermsName(terms), issuer, signed: { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuer) } };
    };
    const x = backingOf("scope journal x", issuerX), y = backingOf("scope journal y", issuerY);
    const create = (secret = aSecret, name = "a"): Journal => {
      const j = new V3OperatorJournal(join(directory, `${name}.db`), { configuration, secret, venue, reference, verifier });
      journals.push(j); return j;
    };
    /** Appoint `secret` to x after `predecessor`, effective after the lag. */
    const replace = async (secret: Uint8Array, predecessor: Uint8Array) => {
      const effective = venue.witnessedIndex() + 2n * lag + 2n;
      const unsigned: Replacement = { role: 1, successor: ed25519.getPublicKey(secret), predecessor, effective,
        signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
      const message = replacementMessage(x.name, unsigned);
      const replacement = { ...unsigned, signature: ed25519.sign(message, ruleSecret), successorSignature: ed25519.sign(message, secret) };
      await venue.publishRecord(2, x.name, encodeReplacement(x.name, replacement));
      return { link: replacementHash(x.name, replacement), effective };
    };
    const output = (backing: Uint8Array, id: number, value: bigint, seed = b(21)) => prepareExactOutput(seed, domain, b(id), backing, value);
    const issue = (ctx: SegmentContext, out: ReturnType<typeof output>, issuer: Uint8Array) =>
      encodeRecord(authorizeIssue(record(issueTask(ctx, out)), issuer));
    const spend = (ctx: SegmentContext, inputs: readonly NoteInput[], outputs: readonly ReturnType<typeof output>[]) =>
      encodeRecord(record(spendTask(ctx, inputs, outputs)));
    const input = (note: ReturnType<typeof output>, tree: NoteTree, leaf: bigint): NoteInput => ({ note, anchor: tree.root(), path: tree.path(leaf) });
    /** The independent reader's verdict for `backing` at the venue's current index. */
    const read = async (served: ServedPackage, backing: Uint8Array) => {
      const result = await readPackage(served.package, { ...served.selection, backing, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" },
        { configuration, verifier, venue, reference });
      if (result.state === undefined) throw new Error("unexpected receipt verdict");
      return result;
    };
    /** The operator's newest segment header, as served. */
    const context = async (j: Journal): Promise<SegmentContext> => {
      const headers = decodeEvidencePackage((await j.package()).package).filter(item => item.kind === 6)
        .map(item => decodeSegmentHeader(decodeTrail(item.payload).header))
        .filter(h => same(h.operator, j.operatorKey)).sort((p, q) => p.sequence > q.sequence ? -1 : p.sequence < q.sequence ? 1 : 0);
      return { domain, header: headers[0]! };
    };
    return { venue, x, y, create, replace, output, issue, spend, input, read, context, backingOf };
  }

  /** A opens {x, y}, issues 10 x and 20 y into one shared history, and publishes. */
  async function shared(silence = false) {
    const f = fixture(silence), a = f.create();
    await a.open("genesis", [f.x.signed, f.y.signed]); await a.publish();
    const ctx = await f.context(a);
    const fundedX = f.output(f.x.name, 31, 10n), fundedY = f.output(f.y.name, 32, 20n);
    await a.submit(f.issue(ctx, fundedX, f.x.issuer)); await a.submit(f.issue(ctx, fundedY, f.y.issuer));
    await a.commit("issued"); await a.publish();
    const tree = new NoteTree(); tree.appendAll([fundedX.cm, fundedY.cm]);
    return { ...f, a, ctx, fundedX, fundedY, tree, held: await a.package() };
  }

  it("opens one segment over two backings whose directory carries both snapshots of one history", async () => {
    const f = await shared();
    expect(f.ctx.header.entries.map(entry => entry.backing)).toEqual([f.x.name, f.y.name].sort(compareBytes));
    const [readX, readY] = [await f.read(f.held, f.x.name), await f.read(f.held, f.y.name)];
    expect([readX.state.issued, readY.state.issued]).toEqual([10n, 20n]);
    expect(readX.state.history).toEqual(readY.state.history);
    expect(readX.state.position).toBe(2n);
    expect(readX.carrying.map(item => [item.sequence, item.class])).toEqual([["1", "valid"], ["2", "valid"]]);
    // The served selection names the holder's backing; the bytes are the same package.
    const forY = await f.a.package(f.y.name);
    expect(forY.selection.backing).toEqual(f.y.name); expect(forY.package).toEqual(f.held.package);
    await expect(f.a.package(b(99))).rejects.toMatchObject({ code: "REFUSED", check: "SCOPE" });
  });

  it("splits at x's term end, rejoins after the tail is witnessed, and spends across both backings", async () => {
    const f = await shared(), toB = await f.replace(bSecret, f.x.name);
    f.venue.advance(toB.effective);
    await expect(f.a.submit(f.issue(f.ctx, f.output(f.y.name, 33, 1n), f.y.issuer))).rejects.toMatchObject({ code: "STALE" });
    // B takes x from A's shared checkpoint; A continues y alone from the same checkpoint.
    const bj = f.create(bSecret, "b");
    expect((await bj.takeover("take-x", f.x.signed, f.held.package)).sequence).toBe(1n);
    await expect(f.a.rescope("keep-ended", { keep: [f.x.name, f.y.name] })).rejects.toMatchObject({ code: "STALE" });
    // The split opening imports its parent's finalized prefix (C2.10.6).
    const parent = await f.read(await f.a.package(f.y.name), f.y.name);
    const merged = mergeFinalizedPrefixes(parent.state.store, [{ state: parent.state }]);
    expect((await f.a.rescope("split", { keep: [f.y.name] })).sequence).toBe(3n);
    await expect(f.a.submit(f.issue(await f.context(f.a), f.output(f.y.name, 33, 1n), f.y.issuer))).rejects.toMatchObject({ code: "STALE" });
    for (const j of [bj, f.a]) { await j.publish(); expect(await j.adopt()).toEqual([]); }
    const split = await f.read(await f.a.package(f.y.name), f.y.name);
    // The split segment's reader imports exactly the parent's prefix.
    expect(split.state.imports()).toEqual(new Map([...merged.frontier.segments].map(([name, entry]) => [name, { ns: split.state.imports().get(name)!.ns, upto: entry.upto }])));
    expect(split.state.eventCount()).toBe(parent.state.eventCount());
    const [ctxB, ctxA] = [await f.context(bj), await f.context(f.a)];
    expect(ctxB.header.entries).toEqual([{ backing: f.x.name, link: toB.link, opening: { operator: aKey, sequence: 2n, root: f.held.selection.root } }]);
    expect(ctxA.header.entries).toEqual([{ backing: f.y.name, link: f.y.name, opening: { operator: aKey, sequence: 2n, root: f.held.selection.root } }]);
    // Each side spends its own note under the shared checkpoint's root.
    const paidX = [10n, 0n, 0n, 0n].map((value, i) => f.output(f.x.name, 60 + i, value, b(22)));
    const paidY = [20n, 0n, 0n, 0n].map((value, i) => f.output(f.y.name, 70 + i, value, b(22)));
    const padX = f.output(f.x.name, 34, 0n), padY = f.output(f.y.name, 35, 0n);
    await bj.submit(f.spend(ctxB, [f.input(f.fundedX, f.tree, 0n), f.input(padX, f.tree, 0n)], paidX));
    await f.a.submit(f.spend(ctxA, [f.input(f.fundedY, f.tree, 1n), f.input(padY, f.tree, 1n)], paidY));
    for (const j of [bj, f.a]) { await j.commit("spent"); await j.publish(); }
    const [servedB, servedA] = [await bj.package(), await f.a.package()];
    expect((await f.read(servedB, f.x.name)).state.issued).toBe(10n);
    expect((await f.read(servedA, f.y.name)).state.issued).toBe(20n);
    const treeX = new NoteTree(), treeY = new NoteTree(); treeX.appendAll(paidX.map(o => o.cm)); treeY.appendAll(paidY.map(o => o.cm));

    // x returns to A. An elective change of A's live {y} scope first witnesses its whole tail.
    const toA = await f.replace(aSecret, toB.link); f.venue.advance(toA.effective);
    await f.a.submit(f.issue(ctxA, f.output(f.y.name, 36, 5n), f.y.issuer));
    const rejoin = { take: [f.x.signed], keep: [f.y.name], evidence: servedB.package };
    await expect(f.a.rescope("rejoin", rejoin)).rejects.toMatchObject({ code: "STALE", check: "TAIL" });
    await f.a.commit("issued-y"); await f.a.publish();
    const servedY = await f.a.package();
    const opening = await f.a.rescope("rejoin", rejoin);
    expect(await f.a.rescope("rejoin", rejoin)).toEqual(opening);
    await f.a.publish(); expect(await f.a.adopt()).toEqual([]);
    const joined = await f.context(f.a);
    const [openX, openY] = [f.x.name, f.y.name].map(name => joined.header.entries.find(entry => same(entry.backing, name))!);
    expect(openX).toMatchObject({ link: toA.link, opening: { operator: bKey, sequence: 2n, root: servedB.selection.root } });
    expect(openY).toMatchObject({ link: f.y.name, opening: { operator: aKey, sequence: 5n, root: servedY.selection.root } });

    // One statement spends an x note and a y note under distinct imported roots.
    const mixed = [7n, 15n, 3n, 5n].map((value, i) => f.output(i % 2 === 0 ? f.x.name : f.y.name, 80 + i, value, b(23)));
    const receipt = decodeReceipt(await f.a.submit(f.spend(joined, [f.input(paidX[0]!, treeX, 0n), f.input(paidY[0]!, treeY, 0n)], mixed)));
    expect(receipt.position).toBe(1n);
    await f.a.commit("mixed"); await f.a.publish();
    const served = await f.a.package();
    const [readX, readY] = [await f.read(served, f.x.name), await f.read(served, f.y.name)];
    expect([readX.state.issued, readY.state.issued]).toEqual([10n, 25n]);
    expect(readX.state.history).toEqual(readY.state.history);
    for (const note of [paidX[0]!, paidY[0]!, f.fundedX, f.fundedY]) expect(readX.state.hasNullifier(note.nf)).toBe(true);
    expect(readY.carrying.filter(item => item.class !== "valid")).toEqual([]);

    // A fresh process derives the same journal from its command log.
    f.a.close(); journals.splice(journals.indexOf(f.a), 1);
    const reopened = f.create(aSecret, "a");
    expect(await reopened.package()).toEqual(served);
    expect(await reopened.rescope("rejoin", rejoin)).toEqual(opening);
  });

  it("returns the whole scope after silence and adopts one backing's forced demand into the shared history", async () => {
    const f = await shared(true);
    f.venue.advance(5n);
    await expect(f.a.submit(f.issue(f.ctx, f.output(f.y.name, 33, 1n), f.y.issuer))).rejects.toMatchObject({ code: "SCHEDULE", check: "SILENCE" });
    await expect(f.a.return("too-early")).rejects.toMatchObject({ code: "STALE" });
    f.venue.advance(7n);
    const pad = f.output(f.y.name, 34, 0n);
    const demand = record(demandTask(f.ctx, [f.input(f.fundedY, f.tree, 1n), f.input(pad, f.tree, 1n)],
      { backing: f.y.name, quantity: 20n, presenter: ed25519.getPublicKey(b(18)), instant: 6n, deadline: 20n }));
    await f.venue.publishRecord(4, f.y.name, encodePublication({ domain, backing: f.y.name, kind: 1, record: demand }));
    const opening = await f.a.return("returned");
    expect(await f.a.return("returned")).toEqual(opening);
    await f.a.publish();
    const receipts = await f.a.adopt();
    expect(receipts.map(bytes => decodeReceipt(bytes).statementHash)).toEqual([statementHash(demand)]);
    const returned = await f.context(f.a);
    expect(returned.header.entries.map(entry => entry.opening)).toEqual([0, 1].map(() => ({ operator: aKey, sequence: 2n, root: f.held.selection.root })));
    await f.a.commit("adopted"); await f.a.publish();
    const served = await f.a.package();
    for (const [name, issued] of [[f.x.name, 10n], [f.y.name, 20n]] as const) {
      const read = await f.read(served, name);
      expect([read.state.issued, read.state.position, read.state.demands().length]).toEqual([issued, 1n, 1]);
      // The continuation resumes after the opening's adopted block for every scoped backing.
      const openedAt = BigInt(read.carrying.find(item => item.sequence === "3")!.index);
      expect([...read.state.adoptionIndices.values()]).toEqual([openedAt, openedAt]);
    }
  });

  it("refuses a duplicate or foreign scope, and a scope change naming nothing it may keep or take", async () => {
    const f = fixture(), a = f.create();
    await expect(a.open("dup", [f.x.signed, f.x.signed])).rejects.toMatchObject({ code: "REFUSED", check: "SCOPE" });
    const foreign = f.backingOf("scope journal z", issuerY, bKey);
    await expect(a.open("foreign", [f.x.signed, foreign.signed])).rejects.toMatchObject({ code: "REFUSED" });
    // C2.10.2: one clock per scope; a reader would exclude mixed silence durations.
    const silenced = f.backingOf("scope journal w", issuerY, aKey, true);
    await expect(a.open("mixed-clock", [f.x.signed, silenced.signed])).rejects.toMatchObject({ code: "REFUSED", check: "SCOPE" });
    await a.open("genesis", [f.x.signed, f.y.signed]); await a.publish();
    await expect(a.rescope("nothing", {})).rejects.toMatchObject({ code: "REFUSED", check: "SCOPE" });
    await expect(a.rescope("outside", { keep: [foreign.name] })).rejects.toMatchObject({ code: "REFUSED", check: "SCOPE" });
    await expect(a.rescope("stray-evidence", { keep: [f.y.name], evidence: encodeEvidencePackage([]) }))
      .rejects.toMatchObject({ code: "REFUSED", check: "SCOPE" });
    // Dropping a live backing is elective: allowed once the whole tail is witnessed.
    await a.submit(f.issue(await f.context(a), f.output(f.x.name, 31, 10n), f.x.issuer));
    await expect(a.rescope("drop-x", { keep: [f.y.name] })).rejects.toMatchObject({ code: "STALE", check: "TAIL" });
    await a.commit("issued");
    await expect(a.rescope("drop-x", { keep: [f.y.name] })).rejects.toMatchObject({ code: "STALE", check: "TAIL" });
    await a.publish();
    expect((await a.rescope("drop-x", { keep: [f.y.name] })).sequence).toBe(3n);
    await a.publish(); await a.adopt();
    expect((await f.read(await a.package(), f.y.name)).state.issued).toBe(0n);
  });
});
