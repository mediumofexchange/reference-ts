import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ErgoVenue, syncCaughtUp } from "../src/ergo.js";
import { subjectKey, testExhaustionSet, type ExhaustionSupplier, type Fold } from "../src/ergo-exhaustion.js";
import { ExhaustionServer, type ServedBlock } from "../src/ergo-exhaustion-server.js";
import { ergoProfileIdentity, transactionsRoot, type ErgoTransactionView } from "../src/ergo-profile.js";
import type { ErgoVenueJournal as Journal } from "../src/ergo-store.js";
import { MAX_RANGE_RECORD_BYTES, type RecordKind } from "../src/record-range.js";
import { VenueError } from "../src/venue-error.js";
import { decodeFold, decodeIncluded, decodeKeyAnswer, encodeFold, encodeIncluded, encodeKeyAnswer } from "../src/ergo-exhaustion-wire.js";
import { createV3EvidenceService } from "../src/pool/v3/service-http.js";
import { exhaustionClient } from "../src/pool/v3/service-client.js";
import { EncodingError } from "../src/bytes.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { BranchSupplier, Chain, plainOutput, recordOutput, transaction, type Block, type Output } from "./ergo-chain.js";

// A succinct view (succinct-read §4) against the complete view over one synthetic chain: below a fold's end it reads
// the subjects it follows from an exhaustion supplier's fold, paths, entries and included transactions, and sections
// natively above. Fold proofs come from a test set (hashes anyone computes), which exercises the reader's rules and
// attests nothing.
let ErgoVenueJournal: typeof import("../src/ergo-store.js").ErgoVenueJournal;
beforeAll(async () => { ({ ErgoVenueJournal } = await import("../src/ergo-store.js")); });
const directories: string[] = [], journals: Journal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  const scratch = resolve("scratch") + sep;
  for (const path of directories.splice(0)) { if (!resolve(path).startsWith(scratch)) throw new Error("outside scratch"); rmSync(path, { recursive: true, force: true }); }
});
function file(): string {
  mkdirSync(resolve("scratch"), { recursive: true });
  const dir = mkdtempSync(resolve("scratch/ergo-succinct-")); directories.push(dir); return join(dir, "venue.sqlite");
}

const chain = new Chain(), anchor = chain.anchor, A = anchor.height, DEPTH = 3n, profile = chain.profile(DEPTH), id = ergoProfileIdentity(profile);
const set = testExhaustionSet("ergo-succinct-view.test", { id: anchor.id, height: A });
const s = sha256(Uint8Array.of(0x61)), t = new Uint8Array(sha256(Uint8Array.of(0x62))), u = sha256(Uint8Array.of(0x63));
t.set(s.subarray(28), 28); // t shares s's key
const subjects = [s, t, u];
const rec = (kind: RecordKind, subject: Uint8Array, fill: number, length = MAX_RANGE_RECORD_BYTES[kind]): Output =>
  recordOutput(kind, subject, new Uint8Array(Math.min(length, 300)).fill(fill));
/** Block i carries records of every kind for s, t and u at varying positions and kind-4 runs. */
function records(i: number): ErgoTransactionView[] {
  const txs = [transaction([plainOutput])];
  if (i % 3 === 0) txs.push(transaction([rec(1, s, i), plainOutput, rec(2, t, i)]));
  if (i % 4 === 1) txs.push(transaction([rec(4, s, i, 30), rec(4, s, i + 1, 30), plainOutput, rec(4, t, i, 9)]));
  if (i % 5 === 2) txs.push(transaction([rec(3, u, 200 - i), rec(3, u, 100 + i), rec(1, u, i)]));
  return txs;
}
const blocks = chain.extend(anchor, 40, records);
const root = (b: Block): Uint8Array => transactionsRoot(2n, b.section.map(x => ({ id: blake2b(x.unsigned, { dkLen: 32 }), witnessId: x.witnessId })));
const served = (b: Block): ServedBlock => ({ id: b.id, transactionsRoot: root(b), section: b.section });
/** A supplier whose folds end at each of `ends` (heights above the anchor, ascending), the latest it has sealed. */
async function server(...ends: number[]): Promise<ExhaustionServer> {
  const x = new ExhaustionServer({ start: { id: anchor.id, height: A }, foldKeyHash: set.foldKeyHash, prove: (first, inputs) => set.prove(first, inputs), name: "exhaustion" });
  let at = 0;
  for (const end of ends) { await x.extend(blocks.slice(at, end).map(served)); at = end; }
  return x;
}
const node = (tip: number): BranchSupplier => new BranchSupplier("node", blocks[tip - 1]!, chain);
const WIDE = { maxBytes: 1n << 30n, maxEntries: 1n << 20n };
const range = (v: ErgoVenue, kind: RecordKind, subject: Uint8Array, fromIndex: bigint, toIndex: bigint): Uint8Array | undefined =>
  v.range({ venue: v.id, kind, subject, fromIndex, toIndex }, WIDE);
const sectionsAsked = (supplier: BranchSupplier): number => supplier.calls.filter(c => c.startsWith("section")).length;

function opened(path?: string, succinct: boolean = true): { journal?: Journal; venue: ErgoVenue } {
  const journal = path === undefined ? undefined : new ErgoVenueJournal(path, id);
  if (journal !== undefined) journals.push(journal);
  return { ...(journal === undefined ? {} : { journal }), venue: new ErgoVenue(profile, chain.context, {}, undefined, journal, succinct ? { set } : undefined) };
}
/** The complete view at the same tip, which every succinct answer must equal. */
async function complete(tip: number): Promise<ErgoVenue> {
  const v = new ErgoVenue(profile, chain.context);
  await v.sync([node(tip)]);
  return v;
}
function expectSame(succinct: ErgoVenue, full: ErgoVenue, followed: readonly Uint8Array[]): number {
  let nonempty = 0;
  const clock = succinct.witnessedIndex();
  expect(clock).toBe(full.witnessedIndex());
  for (const subject of followed) for (const kind of [1, 2, 3, 4] as const) {
    for (const [from, to] of [[0n, clock], [2n, 9n], [clock - 4n, clock], [5n, 5n]] as const) {
      const got = range(succinct, kind, subject, from, to), want = range(full, kind, subject, from, to);
      expect(got, `kind ${kind}, ${from}..${to}`).toEqual(want);
      if (want!.length > 92) nonempty++;
    }
  }
  return nonempty;
}

describe("a succinct Ergo view (succinct-read §4)", () => {
  it("answers the subjects it follows as the complete view does, reading no section below the fold's end", async () => {
    const x = await server(20), supplier = node(30), { venue } = opened();
    for (const subject of [s, t]) venue.follow(subject);
    const report = await venue.sync([supplier], [x]);
    // The fold ends at index 19; the clock at index 26 (tip 30, depth 3): seven sections read natively.
    expect(report.succinct).toMatchObject({ foldIndex: 19n, indicesRead: 20, followed: 2 });
    expect(report.witnessedIndex).toBe(26n);
    expect(sectionsAsked(supplier)).toBe(7);
    expect(expectSame(venue, await complete(30), [s, t])).toBeGreaterThan(20);
    // u is not followed: a range touching the succinct span is unresolved and names u; above it, u reads natively.
    expect(range(venue, 3, u, 0n, 26n)).toBeUndefined();
    expect(range(venue, 3, u, 20n, 26n)).toEqual(range(await complete(30), 3, u, 20n, 26n));
    expect(venue.wanted()).toEqual([u]);
  });

  it("reads a subject followed later at every index already read succinctly, and continues each key from its kept tuple", async () => {
    const x = await server(12, 20), { venue } = opened();
    venue.follow(s);
    // Tip 18: the clock at 14; the supplier's latest fold (index 19) is past it and it keeps no earlier one, so the
    // sync reads natively.
    const first = await venue.sync([node(18)], [x]);
    expect(first.succinct).toMatchObject({ indicesRead: 0, followed: 1 });
    expect(first.succinct!.refused).toEqual([{ name: "exhaustion", reason: "no fold" }]);
    // Tip 20: a supplier with the fold at index 11 only cannot serve above the clock (14) either.
    const y = await server(12), second = await venue.sync([node(20)], [y]);
    expect(second.succinct!.refused).toEqual([{ name: "exhaustion", reason: "fold at or below the clock" }]);
    // Tip 26: the clock reaches 22 and the fold at 19 is above the old clock (16).
    const asked: string[] = [];
    const watched: ExhaustionSupplier = { name: "watched", fold: h => x.fold(h), transaction: (h, p) => x.transaction(h, p),
      key: (e, k, f) => { asked.push(`${k}:${f}`); return x.key(e, k, f); } };
    const third = await venue.sync([node(26)], [watched]);
    expect(third.succinct).toMatchObject({ foldIndex: 19n, indicesRead: 3 });
    expect(asked).toEqual([`${subjectKey(s)}:0`]);
    expect(expectSame(venue, await complete(26), [s])).toBeGreaterThan(5);
    expect(range(venue, 1, u, 0n, 16n)).toEqual(range(await complete(26), 1, u, 0n, 16n));
    expect(range(venue, 1, u, 0n, 22n)).toBeUndefined();
    // u and t followed now: each read from the start at the indices read succinctly (17–19), not those held natively.
    venue.follow(u); venue.follow(t);
    const later = await server(12, 20, 30);
    asked.length = 0;
    const watchedLater: ExhaustionSupplier = { name: "later", fold: h => later.fold(h), transaction: (h, p) => later.transaction(h, p),
      key: (e, k, f) => { asked.push(`${k}:${f}`); return later.key(e, k, f); } };
    const fourth = await venue.sync([node(34)], [watchedLater]);
    expect(fourth.succinct).toMatchObject({ foldIndex: 29n, indicesRead: 7, followed: 2 });
    // s continues from its kept count; t shares s's key and reads it from zero; u from zero.
    const keptCount = (await x.key(A + 20n, subjectKey(s), 0n))!.path.count;
    expect(asked.sort()).toEqual([`${subjectKey(s)}:${keptCount}`, `${subjectKey(s)}:0`, `${subjectKey(u)}:0`].sort());
    expect(expectSame(venue, await complete(34), subjects)).toBeGreaterThan(20);
    expect(venue.wanted()).toEqual([]);
  });

  it("reads natively where no supplier serves, and passes over a supplier whose fold, path, entries or transactions do not check", async () => {
    const x = await server(20), full = await complete(30);
    const hostile = (name: string, change: Partial<ExhaustionSupplier>): ExhaustionSupplier =>
      ({ name, fold: h => x.fold(h), key: (e, k, f) => x.key(e, k, f), transaction: (h, p) => x.transaction(h, p), ...change });
    const forged: Fold = { ...(await x.fold(10_000_000n))!, proof: new Uint8Array(32) };
    const cases: [ExhaustionSupplier, string][] = [
      [hostile("forged", { fold: async () => forged }), "fold-proof"],
      [hostile("throws", { fold: async () => { throw new Error("down"); } }), "failed: down"],
      [hostile("none", { fold: async () => undefined }), "no fold"],
      [hostile("path", { key: async (e, k, f) => { const a = (await x.key(e, k, f))!; return { ...a, path: { ...a.path, count: a.path.count + 1n } }; } }), "path"],
      [hostile("entries", { key: async (e, k, f) => { const a = (await x.key(e, k, f))!; return { ...a, entries: a.entries.slice(1) }; } }), "entries"],
      [hostile("withheld", { transaction: async () => undefined }), "transaction"],
      [hostile("swapped", { transaction: async (h, p) => x.transaction(h, p === 0n ? 1n : 0n) }), "transaction"],
      [hostile("getter", { key: async () => ({ get path(): never { throw new Error("getter"); }, entries: [] }) }), "path"],
    ];
    for (const [supplier, reason] of cases) {
      const native = node(30), { venue } = opened();
      venue.follow(s);
      const report = await venue.sync([native], [supplier]);
      expect(report.succinct!.refused, supplier.name).toEqual([{ name: supplier.name, reason }]);
      // The sync read every section natively: the view answers as the complete one, every subject included.
      expect(sectionsAsked(native), supplier.name).toBe(27);
      expect(expectSame(venue, full, subjects)).toBeGreaterThan(20);
    }
    // A hostile supplier first and an honest one after: the honest one serves.
    const { venue } = opened();
    venue.follow(s);
    const report = await venue.sync([node(30)], [cases[3]![0], x]);
    expect(report.succinct).toMatchObject({ supplier: "exhaustion", foldIndex: 19n, refused: [{ name: "path", reason: "path" }] });
    expect(expectSame(venue, full, [s])).toBeGreaterThan(5);
  });

  it("stops using the set, and refuses every read, where an included transaction disagrees with the fold's map (§2 rule 7)", async () => {
    // A map built over an altered block 3: its transaction at position 1 shows one fewer shaped output for s's key.
    const honest = await server(20), altered = blocks.slice(0, 20).map(b => b === blocks[3] ? { ...served(b), section: [b.section[0]!,
      transaction([rec(1, s, 3), plainOutput, plainOutput]), ...b.section.slice(2)] } : served(b));
    const map = new ExhaustionServer({ start: { id: anchor.id, height: A }, foldKeyHash: set.foldKeyHash, prove: (f, i) => set.prove(f, i) });
    await map.extend(altered);
    const unsound: ExhaustionSupplier = { name: "unsound", fold: h => map.fold(h), key: (e, k, f) => map.key(e, k, f), transaction: (h, p) => honest.transaction(h, p) };
    // s is read succinctly at index 3: its entry there is fetched, and the transaction holds t's output as well.
    const path = file(), { venue } = opened(path);
    venue.follow(s);
    await expect(venue.sync([node(30)], [unsound])).rejects.toThrow("the exhaustion set disagreed");
    expect(() => venue.witnessedIndex()).toThrow(VenueError);
    await expect(venue.sync([node(34)], [honest])).rejects.toThrow("the exhaustion set disagreed");
    journals.pop()!.close();
    expect(() => opened(path).venue.witnessedIndex()).toThrow("the exhaustion set disagreed");
  });

  it("holds every transaction a pass fetched against every key it read, not only the key it was fetched for (§2 rule 7)", async () => {
    // A chain of its own whose block 3 holds one transaction with an output for s and one for v, of another key; the
    // unsound map lacks v's. The transaction is fetched for s, and it shows v's entries wrong.
    const own = new Chain(), v = sha256(Uint8Array.of(0x76));
    expect(subjectKey(v)).not.toBe(subjectKey(s));
    const both = transaction([rec(1, s, 1), rec(1, v, 2)]), withoutV = transaction([rec(1, s, 1), plainOutput]);
    const chainBlocks = own.extend(own.anchor, 12, i => i === 3 ? [transaction([plainOutput]), both] : [transaction([plainOutput])]);
    const ownSet = testExhaustionSet("ergo-succinct-view.test rule 7", { id: own.anchor.id, height: own.anchor.height });
    const make = () => new ExhaustionServer({ start: ownSet.start, foldKeyHash: ownSet.foldKeyHash, prove: (f, i) => ownSet.prove(f, i) });
    const honest = make(), map = make();
    await honest.extend(chainBlocks.slice(0, 8).map(served));
    await map.extend(chainBlocks.slice(0, 8).map(b => b === chainBlocks[3] ? { ...served(b), section: [b.section[0]!, withoutV] } : served(b)));
    const venue = new ErgoVenue(own.profile(DEPTH), own.context, {}, undefined, undefined, { set: ownSet });
    venue.follow(s); venue.follow(v);
    await expect(venue.sync([new BranchSupplier("node", chainBlocks[11]!, own)],
      [{ name: "unsound", fold: h => map.fold(h), key: (e, k, f) => map.key(e, k, f), transaction: (h, p) => honest.transaction(h, p) }]))
      .rejects.toThrow("the exhaustion set disagreed");
    expect(venue.disagreed()).toBe(true);
    // The honest map's fold passes the same check.
    const fine = new ErgoVenue(own.profile(DEPTH), own.context, {}, undefined, undefined, { set: ownSet });
    fine.follow(s); fine.follow(v);
    expect((await fine.sync([new BranchSupplier("node", chainBlocks[11]!, own)], [honest])).succinct).toMatchObject({ foldIndex: 7n });
  });

  it("takes the highest fold first, and passes over a supplier whose fold's verification does not run", async () => {
    // A supplier listed first with a genuine fold at index 0, answering its keys and transactions correctly, holds the
    // view to that end no more: the fold at index 29 serves.
    const named = (name: string, x: ExhaustionServer): ExhaustionSupplier =>
      ({ name, fold: h => x.fold(h), key: (e, k, f) => x.key(e, k, f), transaction: (h, p) => x.transaction(h, p) });
    const stale = named("stale", await server(1)), current = named("current", await server(30)), supplier = node(36), { venue } = opened();
    venue.follow(s);
    const report = await venue.sync([supplier], [stale, current]);
    expect(report.succinct).toMatchObject({ supplier: "current", foldIndex: 29n, indicesRead: 30 });
    expect(sectionsAsked(supplier)).toBe(3);
    expect(expectSame(venue, await complete(36), [s])).toBeGreaterThan(10);
    // A fold whose verification throws (a backend that does not start, or a failure it does not name) establishes
    // nothing (§2 rule 3): that supplier is passed over and the next fold serves; the view does not fail.
    const throwing = Object.freeze({ identity: set.identity, test: true, start: set.start, foldKeyHash: set.foldKeyHash,
      verifyFold: (first: boolean, inputs: readonly bigint[], proof: Uint8Array) => {
        if (inputs[5] === A + 30n) throw new Error("backend down");
        return set.verifyFold(first, inputs, proof);
      } });
    const second = new ErgoVenue(profile, chain.context, {}, undefined, undefined, { set: throwing });
    second.follow(s);
    const passed = await second.sync([node(36)], [current, named("older", await server(20))]);
    expect(passed.succinct).toMatchObject({ supplier: "older", foldIndex: 19n, refused: [{ name: "current", reason: "fold not verified: backend down" }] });
    expect(expectSame(second, await complete(36), [s])).toBeGreaterThan(10);
  });

  it("hands out copies of its folds: a caller changing one changes nothing it serves", async () => {
    const x = await server(10), before = encodeFold((await x.fold(1n << 40n))!);
    (await x.fold(1n << 40n))!.proof.fill(0);
    (await x.fold(1n << 40n))!.inputs.endId.fill(0);
    x.latest!.proof.fill(0);
    (await x.extend([])).inputs.startId.fill(0);
    expect(encodeFold((await x.fold(1n << 40n))!)).toEqual(before);
  });

  it("keeps what it read across reopening, under its set only, and audits its rows", async () => {
    const path = file(), x = await server(20, 30);
    let { venue } = opened(path);
    venue.follow(s);
    await venue.sync([node(25)], [await server(20)]);
    journals.pop()!.close();
    ({ venue } = opened(path));
    expect(venue.followed()).toEqual([s]);
    expect(expectSame(venue, await complete(25), [s])).toBeGreaterThan(5);
    expect(range(venue, 1, u, 0n, 21n)).toBeUndefined();
    await venue.sync([node(36)], [x]);
    expect(expectSame(venue, await complete(36), [s])).toBeGreaterThan(5);
    expect(venue.audit({ work: true })).toMatchObject({ sections: 33n });
    journals.pop()!.close();
    // Another set, or no set, is refused; so is a complete view's file opened succinctly.
    const other = testExhaustionSet("another", { id: anchor.id, height: A });
    let journal = new ErgoVenueJournal(path, id); journals.push(journal);
    expect(() => new ErgoVenue(profile, chain.context, {}, undefined, journal, { set: other })).toThrow("another exhaustion set");
    journals.pop()!.close();
    journal = new ErgoVenueJournal(path, id); journals.push(journal);
    expect(() => new ErgoVenue(profile, chain.context, {}, undefined, journal)).toThrow("reads succinctly");
    const completePath = file(), full = opened(completePath, false);
    await full.venue.sync([node(25)]);
    journals.pop()!.close();
    journal = new ErgoVenueJournal(completePath, id); journals.push(journal);
    expect(() => new ErgoVenue(profile, chain.context, {}, undefined, journal, { set })).toThrow("reads every section");
  });

  it("reads the transactions and paths it uses only: a phone's bytes below the fold are its subjects', not the chain's", async () => {
    const x = await server(37), fetched: string[] = [];
    const counting: ExhaustionSupplier = { name: "counting", fold: h => x.fold(h), key: (e, k, f) => x.key(e, k, f),
      transaction: async (h, p) => { fetched.push(`${h}:${p}`); return x.transaction(h, p); } };
    const supplier = node(40), { venue } = opened();
    venue.follow(u);
    await venue.sync([supplier], [counting]);
    // u has entries in blocks 2, 7, 12, ..., 32 (i % 5 === 2): seven transactions below the fold's end, no section.
    expect(fetched.length).toBe(7);
    expect(sectionsAsked(supplier)).toBe(0);
    expect(expectSame(venue, await complete(40), [u])).toBeGreaterThan(3);
  });

  it("travels over a replica's listener: frames round-trip, a malformed one is refused, and a view reads through the client", async () => {
    const x = await server(20), fold = (await x.fold(1n << 40n))!, key = (await x.key(A + 20n, subjectKey(s), 0n))!, tx = (await x.transaction(A + 4n, 1n))!;
    expect(decodeFold(encodeFold(fold))).toEqual(fold);
    expect(decodeKeyAnswer(encodeKeyAnswer(key))).toEqual(key);
    expect(decodeIncluded(encodeIncluded(tx))).toEqual({ unsigned: tx.unsigned, steps: tx.steps });
    expect(() => decodeFold(Uint8Array.of(2, ...encodeFold(fold).subarray(1)))).toThrow(EncodingError);
    expect(() => decodeKeyAnswer(Buffer.concat([encodeKeyAnswer(key), Uint8Array.of(0)]))).toThrow("trailing bytes");
    const listener = createV3EvidenceService({ serve: async () => { throw new Error("no evidence"); }, proof: () => undefined, cover: () => undefined },
      { set: set.identity, supplier: x });
    await new Promise<void>(done => listener.listen(0, "127.0.0.1", done));
    try {
      const url = `http://127.0.0.1:${(listener.address() as { port: number }).port}/`;
      const client = exhaustionClient(url, set.identity), other = exhaustionClient(url, new Uint8Array(32).fill(7));
      expect(await client.fold(A + 20n)).toEqual(fold);
      expect(await client.fold(A + 19n)).toBeUndefined();
      expect(await other.fold(A + 20n)).toBeUndefined();
      expect(await client.key(A + 19n, subjectKey(s), 0n)).toBeUndefined();
      expect(await client.transaction(A + 4n, 1n)).toEqual({ unsigned: tx.unsigned, steps: tx.steps });
      const native = node(30), { venue } = opened();
      venue.follow(s);
      const report = await venue.sync([native], [client]);
      expect(report.succinct).toMatchObject({ supplier: url, foldIndex: 19n, indicesRead: 20 });
      expect(sectionsAsked(native)).toBe(7);
      expect(expectSame(venue, await complete(30), [s])).toBeGreaterThan(5);
    } finally { await new Promise(done => listener.close(done)); }
  });

  it("catches up past a succinct pass that spent the section budget, and answers paths at the latest fold while the next period is being proved", async () => {
    const x = await server(20), journal = undefined;
    const venue = new ErgoVenue(profile, chain.context, { sectionBytesPerSync: 3000 }, undefined, journal, { set });
    venue.follow(s);
    const report = await syncCaughtUp(venue, [node(36)], undefined, [x]);
    expect(report.witnessedIndex).toBe(32n);
    expect(expectSame(venue, await complete(36), [s])).toBeGreaterThan(5);
    // Between a period's blocks and its proof, the key answers at the latest fold, and nothing past it.
    let release!: () => void;
    const held = new Promise<void>(done => { release = done; });
    const slow = new ExhaustionServer({ start: { id: anchor.id, height: A }, foldKeyHash: set.foldKeyHash,
      prove: async (first, inputs) => { if (!first) await held; return set.prove(first, inputs); } });
    await slow.extend(blocks.slice(0, 10).map(served));
    const atTen = new ExhaustionServer({ start: { id: anchor.id, height: A }, foldKeyHash: set.foldKeyHash, prove: (f, i) => set.prove(f, i) });
    await atTen.extend(blocks.slice(0, 10).map(served));
    const sealing = slow.extend(blocks.slice(10, 20).map(served));
    await new Promise(done => setTimeout(done, 10));
    expect(slow.height).toBe(A + 20n);
    expect(await slow.key(A + 10n, subjectKey(s), 0n)).toEqual(await atTen.key(A + 10n, subjectKey(s), 0n));
    expect(await slow.key(A + 20n, subjectKey(s), 0n)).toBeUndefined();
    release(); await sealing;
    expect(await slow.key(A + 20n, subjectKey(s), 0n)).toEqual(await x.key(A + 20n, subjectKey(s), 0n));
  });
});
