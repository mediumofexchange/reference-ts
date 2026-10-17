import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { blake2b } from "@noble/hashes/blake2b.js";
import { EncodingError } from "../src/bytes.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it } from "vitest";
import { ExhaustionServer } from "../src/ergo-exhaustion-server.js";
import { transactionsRoot } from "../src/ergo-profile.js";
import { testExhaustionSet } from "../src/ergo-exhaustion.js";
import { exhaustionOver, openView, readsTrailsSuccinctly, requireVenue, venueStart, venueText } from "../src/cli/venue.js";
import { testSetIdentity } from "../src/succinct-set.js";
import type { ExhaustionProver } from "../src/cli/backend.js";
import { foldPublicInputs, type ExhaustionSupplier, type Fold } from "../src/ergo-exhaustion.js";
import { ExhaustionPool } from "../src/ergo-exhaustion-pool.js";
import { EXHAUSTION_CIRCUITS } from "../src/ergo-exhaustion-set.js";
import { decodeFold, encodeFold } from "../src/ergo-exhaustion-wire.js";
import { POOL_V3, type Construction } from "../src/pool/v3/construction.js";
import { ReplayStore } from "../src/pool/v3/replay-store.js";
import type { Directory } from "../src/cli/common.js";
import { BranchSupplier, Chain, plainOutput, recordOutput, transaction, type Block } from "./ergo-chain.js";

// A succinct directory's view (slice 43) whose exhaustion set disagrees with a transaction (succinct-read §2 rule 7):
// the next view drops the set for the directory, discards the view's file and the answers kept under it, and reads
// without the set.
const directories: string[] = [];
afterEach(() => {
  const scratch = resolve("scratch") + sep;
  for (const path of directories.splice(0)) { if (!resolve(path).startsWith(scratch)) throw new Error("outside scratch"); rmSync(path, { recursive: true, force: true }); }
});
const chain = new Chain(), A = chain.anchor.height, profile = chain.profile(3n), s = new Uint8Array(32).fill(0x61);
const blocks = chain.extend(chain.anchor, 12, i => i === 3 ? [transaction([recordOutput(1, s, new Uint8Array(136).fill(1)), plainOutput, recordOutput(2, s, new Uint8Array(233))])] : []);
const root = (b: Block): Uint8Array => transactionsRoot(2n, b.section.map(x => ({ id: blake2b(x.unsigned, { dkLen: 32 }), witnessId: x.witnessId })));

function directory(succinct = true): Directory {
  mkdirSync(resolve("scratch"), { recursive: true });
  const path = mkdtempSync(resolve("scratch/cli-succinct-")); directories.push(path);
  writeFileSync(join(path, "venue.json"), venueText(profile, A));
  writeFileSync(join(path, "anchor.json"), `${JSON.stringify(chain.context.map(bytesToHex))}\n`);
  return Object.freeze({ path, config: { role: succinct ? "wallet" as const : "reader" as const, nodes: ["http://127.0.0.1:9/"],
    ...(succinct ? { read: "succinct" as const } : {}) }, construction: POOL_V3 as Construction, succinct, file: (name: string) => join(path, name) });
}

describe("a succinct directory's view", () => {
  it("drops a set that disagrees, discards its view and kept answers, and reads without it", async () => {
    // A test set in place of the shipped one, whose folds take minutes to prove.
    const dir = directory(), set = testExhaustionSet("cli-succinct-view.test", { id: profile.anchor, height: A }), exhaustion = { exhaustion: set };
    // A map over an altered block 3: one shaped output for s where the real transaction has two.
    const map = new ExhaustionServer({ start: set.start, foldKeyHash: set.foldKeyHash, prove: (f, i) => set.prove(f, i) });
    const honest = new ExhaustionServer({ start: set.start, foldKeyHash: set.foldKeyHash, prove: (f, i) => set.prove(f, i) });
    await honest.extend(blocks.slice(0, 8).map(b => ({ id: b.id, transactionsRoot: root(b), section: b.section })));
    await map.extend(blocks.slice(0, 8).map(b => ({ id: b.id, transactionsRoot: root(b), section: b === blocks[3] ?
      [transaction([recordOutput(1, s, new Uint8Array(136).fill(1)), plainOutput, plainOutput])] : b.section })));
    const kept = new ReplayStore(dir.file("replay.db"), { digest: dir.file("replay.db.sha256") });
    kept.keepAnswer(1, s, () => ({ through: 5n, value: 0n }));
    expect(kept.answersThrough()).toBe(5n);
    kept.close();
    // A copy of the view as it stood with indices read under the set, before the disagreement.
    let view = openView(dir, exhaustion);
    view.venue.follow(s);
    const early = new ExhaustionServer({ start: set.start, foldKeyHash: set.foldKeyHash, prove: (f, i) => set.prove(f, i) });
    await early.extend(blocks.slice(0, 3).map(b => ({ id: b.id, transactionsRoot: root(b), section: b.section })));
    await view.venue.sync([new BranchSupplier("node", blocks[5]!, chain)], [early]);
    expect(view.venue.succinctSummary()!.succinctIndices).toBe(3n);
    view.close();
    copyFileSync(dir.file("succinct-venue.db"), dir.file("before.db"));
    view = openView(dir, exhaustion);
    await expect(view.venue.sync([new BranchSupplier("node", blocks.at(-1)!, chain)],
      [{ name: "unsound", fold: h => map.fold(h), key: (e, k, f) => map.key(e, k, f), transaction: (h, p) => honest.transaction(h, p) }]))
      .rejects.toThrow("the exhaustion set disagreed");
    view.close();
    view = openView(dir, exhaustion);
    try {
      expect(JSON.parse(readFileSync(dir.file("exhaustion.json"), "utf8"))).toEqual({ dropped: [bytesToHex(set.identity)] });
      expect(view.venue.disagreed()).toBe(false);
      expect(() => view.venue.witnessedIndex()).toThrow("no settled snapshot");
      const again = new ReplayStore(dir.file("replay.db"), { digest: dir.file("replay.db.sha256") });
      expect(again.answersThrough()).toBeUndefined();
      again.close();
      // It reads every index natively, every subject included.
      const report = await view.venue.sync([new BranchSupplier("node", blocks.at(-1)!, chain)]);
      expect(report.witnessedIndex).toBe(8n);
      expect(view.venue.range({ venue: view.venue.id, kind: 2, subject: s, fromIndex: 0n, toIndex: 8n }, { maxBytes: 1n << 20n, maxEntries: 100n })).toBeDefined();
    } finally { view.close(); }
    expect(existsSync(dir.file("succinct-venue.db"))).toBe(true);
    // The copy restored after the drop holds indices read under the dropped set: it is dropped again.
    for (const suffix of ["-wal", "-shm"]) rmSync(dir.file(`succinct-venue.db${suffix}`), { force: true });
    copyFileSync(dir.file("before.db"), dir.file("succinct-venue.db"));
    view = openView(dir, exhaustion);
    try { expect(view.venue.succinctSummary()!.succinctIndices).toBe(0n); } finally { view.close(); }
  });

  it("reads trails natively once the set its venue names is dropped: rule 7 stops the set for every read", () => {
    const dir = directory(), file = requireVenue(dir);
    expect(readsTrailsSuccinctly(dir, file)).toBe(true);
    // Another set dropped leaves this one in use.
    writeFileSync(dir.file("exhaustion.json"), `${JSON.stringify({ dropped: ["00".repeat(32)] })}\n`);
    expect(readsTrailsSuccinctly(dir, file)).toBe(true);
    // The set the venue names: its trail covers (succinct-read §3) are used no more, as its folds are not.
    const named = bytesToHex(testSetIdentity(venueStart(file)));
    writeFileSync(dir.file("exhaustion.json"), `${JSON.stringify({ dropped: ["00".repeat(32), named] })}\n`);
    expect(readsTrailsSuccinctly(dir, file)).toBe(false);
    expect(readsTrailsSuccinctly(directory(false), file)).toBe(false);
  });

  it("proves a replica's periods in the background, keeps its fold and serves it again after a restart without a prover", async () => {
    const dir = directory(false), set = testExhaustionSet("cli-succinct-view.test", { id: profile.anchor, height: A }), events: unknown[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { events.push(JSON.parse(chunk)); return true; }) as never;
    try {
      const view = openView(dir);
      await view.venue.sync([new BranchSupplier("node", blocks[5]!, chain)]);
      let release: () => void = () => {}, proved = 0, cleared = 0;
      // The pool's own check of a period (its headers chain from its start, its leaves end at the fold's end with its
      // root) over what the replica hands it, at small leaf sizes.
      const pool = new ExhaustionPool({ circuits: { sizes: { t: 64, m: 64, u: 16 }, circuits: Object.fromEntries(EXHAUSTION_CIRCUITS.map(name =>
        [name, { program: {}, vk: new Uint8Array(115 * 32), keyHash: 7n }])) } as never, backend: {} as never });
      const prover: ExhaustionProver = {
        fold: async (first, inputs, period) => {
          proved++;
          expect(pool.leaves(inputs, period).leaves.length).toBeGreaterThan(0);
          await new Promise<void>(done => { release = done; });
          return set.prove(first, inputs);
        },
        folded: () => { cleared++; }, close: async () => { release(); },
      };
      const replica = exhaustionOver(dir, view, prover, { exhaustion: set }), heard: [Fold, string][] = [];
      await replica.advance((fold, how) => heard.push([fold, how]));
      // The period proves in the background: a round goes on, and a second advance starts none meanwhile.
      expect(replica.busy).toBe(true);
      expect(await replica.source.supplier.fold(1n << 40n)).toBeUndefined();
      await replica.advance(() => {});
      expect(proved).toBe(1);
      release();
      await expect.poll(() => heard.length).toBe(1);
      expect(replica.busy).toBe(false);
      const [fold, how] = heard[0]!;
      expect([how, fold.first, fold.inputs.endHeight, cleared]).toEqual(["proved", true, A + 1n + view.venue.witnessedIndex(), 1]);
      expect(existsSync(dir.file("exhaustion-fold.bin"))).toBe(true);
      await replica.close();
      // Started again without a prover: the kept fold is verified, checked against the map and served again.
      const again = exhaustionOver(dir, view, undefined, { exhaustion: set }), served: [Fold, string][] = [];
      await again.advance((f, h) => served.push([f, h]));
      expect(served).toEqual([[fold, "kept"]]);
      expect(await again.source.supplier.fold(1n << 40n)).toEqual(fold);
      // A kept fold of another set is passed over by name; one that is no fold too.
      const other = exhaustionOver(dir, view, undefined, { exhaustion: testExhaustionSet("another", { id: profile.anchor, height: A }) });
      await other.advance(() => { throw new Error("served"); });
      expect(await other.source.supplier.fold(1n << 40n)).toBeUndefined();
      writeFileSync(dir.file("exhaustion-fold.bin"), new Uint8Array(3));
      await exhaustionOver(dir, view, undefined, { exhaustion: set }).advance(() => { throw new Error("served"); });
      expect(events.map(e => (e as { code?: string }).code)).toEqual(["KEPT", "KEPT"]);
      expect(String((events[0] as { message: string }).message)).toContain("another start or key hash");
      // A kept fold that verifies but ends past the view's rows waits for them, proving nothing meanwhile.
      const far = await (async () => {
        const map = new ExhaustionServer({ start: set.start, foldKeyHash: set.foldKeyHash, prove: (f, i) => set.prove(f, i) });
        return map.extend(blocks.slice(0, 10).map(b => ({ id: b.id, transactionsRoot: root(b), section: b.section })));
      })();
      writeFileSync(dir.file("exhaustion-fold.bin"), encodeFold(far));
      const waiting = exhaustionOver(dir, view, prover, { exhaustion: set });
      await waiting.advance(() => { throw new Error("served"); });
      await waiting.advance(() => { throw new Error("served"); });
      expect([proved, waiting.busy, events.at(-1)]).toEqual([1, false, expect.objectContaining({ code: "WAITING" })]);
      expect(events.filter(e => (e as { code?: string }).code === "WAITING")).toHaveLength(1);
      // A kept fold that verifies over the view's blocks with another map (a set that is unsound, or this map) is kept
      // aside as evidence, and the replica serves that set no more.
      const forged = { ...fold, inputs: { ...fold.inputs, mapRoot: fold.inputs.mapRoot + 1n } };
      writeFileSync(dir.file("exhaustion-fold.bin"), encodeFold({ ...forged, proof: set.prove(true, forged.inputs) }));
      const unsound = exhaustionOver(dir, view, prover, { exhaustion: set });
      await unsound.advance(() => { throw new Error("served"); });
      await unsound.advance(() => { throw new Error("served"); });
      const evidence = () => readdirSync(dir.path).filter(name => name.startsWith(`exhaustion-disagreement-${bytesToHex(set.identity)}-`));
      expect([proved, unsound.busy, existsSync(dir.file("exhaustion-fold.bin")), evidence().length]).toEqual([1, false, false, 1]);
      expect(events.at(-1)).toMatchObject({ code: "DISAGREEMENT" });
      expect(await unsound.source.supplier.fold(1n << 40n)).toBeUndefined();
      expect(await unsound.source.supplier.transaction(A + 1n, 0n)).toBeUndefined();
      // Started again, it still serves and proves the set no more while the evidence is kept.
      const restarted = exhaustionOver(dir, view, prover, { exhaustion: set });
      expect(events.at(-1)).toMatchObject({ code: "DISAGREEMENT", message: expect.stringContaining(evidence()[0]!) });
      await restarted.advance(() => { throw new Error("served"); });
      expect([proved, restarted.busy, await restarted.source.supplier.transaction(A + 1n, 0n)]).toEqual([1, false, undefined]);
      view.close();
    } finally { process.stderr.write = write; }
  });
  it("takes the highest fold a peer replica proved, keeps it, passes over peers whose folds it refuses, and proves on from it", async () => {
    const set = testExhaustionSet("cli-succinct-view.test", { id: profile.anchor, height: A }), events: { code?: string; peer?: string; message?: string }[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { events.push(JSON.parse(chunk)); return true; }) as never;
    const opened: { close(): void }[] = [];
    // A reader directory whose view reads blocks 0–8 (the tip's depth above them).
    const synced = async () => {
      const dir = directory(false), view = openView(dir);
      opened.push(view);
      await view.venue.sync([new BranchSupplier("node", blocks.at(-1)!, chain)]);
      expect(view.venue.witnessedIndex()).toBe(8n);
      return { dir, view };
    };
    // A peer's map over `over`, sealed in one fold, served under `name`; `asked` counts its fold requests.
    const peerOver = async (name: string, over: readonly Block[], options: { readonly set?: typeof set; readonly alter?: (fold: Fold) => Fold } = {}) => {
      const own = options.set ?? set, map = new ExhaustionServer({ start: own.start, foldKeyHash: own.foldKeyHash, prove: (f, i) => own.prove(f, i) });
      const sealed = await map.extend(over.map(b => ({ id: b.id, transactionsRoot: root(b), section: b.section })));
      const fold = options.alter?.(sealed) ?? sealed, peer = { name, asked: 0, fold,
        supplier: { name, fold: async () => { peer.asked++; return fold; }, key: async () => undefined, transaction: async () => undefined } as ExhaustionSupplier };
      return peer;
    };
    try {
      // A replica that proves nothing takes the highest fold offered within its view; a peer that does not answer and one
      // whose bytes are no fold are passed over, and a fold past its view waits.
      const { dir, view } = await synced();
      const short = await peerOver("short", blocks.slice(0, 5)), long = await peerOver("long", blocks.slice(0, 8)), far = await peerOver("far", blocks.slice(0, 11));
      const down = { name: "down", fold: async () => { throw new Error("connection refused"); }, key: async () => undefined, transaction: async () => undefined };
      const malformed = { ...down, name: "malformed", fold: async () => { throw new EncodingError("a fold is first or next"); } };
      const peers: ExhaustionSupplier[] = [down, malformed, short.supplier, long.supplier, far.supplier];
      const replica = exhaustionOver(dir, view, undefined, { exhaustion: set, peers: () => peers }), heard: unknown[][] = [];
      await replica.advance((...args) => heard.push(args));
      expect(heard).toEqual([[long.fold, "taken", "long"]]);
      expect(await replica.source.supplier.fold(1n << 40n)).toEqual(long.fold);
      expect(decodeFold(readFileSync(dir.file("exhaustion-fold.bin")))).toEqual(long.fold);
      expect(events).toEqual([{ event: "exhaustion", code: "PEER", peer: "down", message: expect.stringMatching(/did not answer.*not asked again for 60000 ms/) },
        { event: "exhaustion", code: "PEER", peer: "malformed", message: expect.stringContaining("its fold is malformed") }]);
      // Nothing higher within the view: nothing more is taken, and neither is asked meanwhile.
      await replica.advance((...args) => heard.push(args));
      expect([heard.length, events.length]).toEqual([1, 2]);
      // The key answers and transactions are its own map's at the taken fold.
      expect(await replica.source.supplier.key(long.fold.inputs.endHeight, 0n, 0n)).toBeDefined();
      // Restarted with no peer, it serves the fold it took, kept.
      const again = exhaustionOver(dir, view, undefined, { exhaustion: set }), kept: unknown[][] = [];
      await again.advance((...args) => kept.push(args));
      expect(kept).toEqual([[long.fold, "kept"]]);

      // Folds refused before anything is appended pass their peer over for a doubling wait: one that does not verify,
      // one of another set's start and key hash, one ending at another chain's header.
      const other = await synced(), fork = chain.extend(chain.anchor, 8, () => [], 1);
      const unverified = await peerOver("unverified", blocks.slice(0, 6), { alter: f => ({ ...f, proof: f.proof.map(b => b ^ 1) }) });
      const another = await peerOver("another", blocks.slice(0, 6), { set: testExhaustionSet("another", { id: profile.anchor, height: A }) });
      const forked = await peerOver("forked", fork.slice(0, 6));
      events.length = 0;
      const refusing = exhaustionOver(other.dir, other.view, undefined, { exhaustion: set, peers: () => [unverified.supplier, another.supplier, forked.supplier] });
      await refusing.advance(() => { throw new Error("taken"); });
      expect(events.map(e => [e.code, e.peer])).toEqual([["PEER", "unverified"], ["PEER", "another"], ["PEER", "forked"]]);
      expect(events.find(e => e.peer === "unverified")!.message).toContain("does not verify");
      expect(events.find(e => e.peer === "another")!.message).toContain("another start or key hash");
      expect(events.find(e => e.peer === "forked")!.message).toContain("another header");
      await refusing.advance(() => { throw new Error("taken"); });
      expect([unverified.asked, another.asked, forked.asked, events.length]).toEqual([1, 1, 1, 3]);
      expect(await refusing.source.supplier.fold(1n << 40n)).toBeUndefined();
      expect(existsSync(other.dir.file("exhaustion-fold.bin"))).toBe(false);

      // A fold that verifies while the view's own map has another root is kept as evidence; the set is served no more.
      const unsound = await synced();
      const forged = await peerOver("forged", blocks.slice(0, 6), { alter: f => {
        const inputs = { ...f.inputs, mapRoot: f.inputs.mapRoot + 1n };
        return { ...f, inputs, proof: set.prove(f.first, inputs) };
      } });
      events.length = 0;
      const askedBefore = short.asked;
      const stopped = exhaustionOver(unsound.dir, unsound.view, undefined, { exhaustion: set, peers: () => [forged.supplier, short.supplier] });
      await stopped.advance(() => { throw new Error("taken"); });
      const evidence = readdirSync(unsound.dir.path).filter(name => name.startsWith(`exhaustion-disagreement-${bytesToHex(set.identity)}-`));
      expect(evidence).toHaveLength(1);
      expect(decodeFold(readFileSync(unsound.dir.file(evidence[0]!)))).toEqual(forged.fold);
      expect(events).toEqual([expect.objectContaining({ code: "DISAGREEMENT" })]);
      expect([await stopped.source.supplier.fold(1n << 40n), short.asked - askedBefore]).toEqual([undefined, 1]);
      await stopped.advance(() => { throw new Error("taken"); });
      expect(short.asked - askedBefore).toBe(1);

      // A proving replica takes a peer's fold rather than proving below it, then proves its next period from it.
      const proving = await synced(), periods: { first: boolean; begin: bigint; previous: Fold | undefined }[] = [];
      let cleared = 0;
      const prover: ExhaustionProver = {
        fold: async (first, inputs, period) => { periods.push({ first, begin: period.begin.height, previous: period.previous }); return set.prove(first, inputs); },
        folded: () => { cleared++; }, close: async () => {},
      };
      const continuing = exhaustionOver(proving.dir, proving.view, prover, { exhaustion: set, peers: () => [short.supplier] }), folds: unknown[][] = [];
      await continuing.advance((...args) => folds.push(args));
      expect([folds, periods.length, cleared]).toEqual([[[short.fold, "taken", "short"]], 0, 1]);
      await continuing.advance((...args) => folds.push(args));
      await expect.poll(() => folds.length).toBe(2);
      expect(periods).toEqual([{ first: false, begin: short.fold.inputs.endHeight, previous: short.fold }]);
      const [next, how] = folds[1] as [Fold, string];
      expect([how, next.first, next.inputs.endHeight]).toEqual(["proved", false, A + 9n]);
      expect(set.verifyFold(false, foldPublicInputs(next.inputs)!, next.proof)).toBe(true);

      // A fold whose verification cannot run (a verifier that throws) leaves the next offer to be taken, and its peer is
      // passed over once it recurs KEPT_TRIES times.
      const throwing = await peerOver("throwing", blocks.slice(0, 8), { alter: f => ({ ...f, proof: f.proof.map(b => b ^ 2) }) });
      const hostile = bytesToHex(throwing.fold.proof), throwingSet = { ...set, verifyFold: (first: boolean, inputs: readonly bigint[], proof: Uint8Array) => {
        if (bytesToHex(proof) === hostile) throw new Error("unreachable");
        return set.verifyFold(first, inputs, proof);
      } };
      const fallback = await synced(), taking: unknown[][] = [];
      events.length = 0;
      const falling = exhaustionOver(fallback.dir, fallback.view, undefined, { exhaustion: throwingSet, peers: () => [throwing.supplier, short.supplier] });
      await falling.advance((...args) => taking.push(args));
      expect(taking).toEqual([[short.fold, "taken", "short"]]);
      for (let turn = 1; turn < 6; turn++) await falling.advance((...args) => taking.push(args));
      expect([throwing.asked, taking.length]).toEqual([5, 1]);
      expect(events.at(-1)).toMatchObject({ code: "PEER", peer: "throwing", message: expect.stringContaining("could not be verified in 5 turns") });

      // A proving replica whose period's proof failed takes a peer's fold above the one it serves, on a fresh map in place
      // of the pending period, and proves on from it.
      const failing = await synced(), full = await peerOver("full", blocks.slice(0, 9)), takenOver: unknown[][] = [];
      let offers: ExhaustionSupplier[] = [];
      const broken: ExhaustionProver = { fold: async () => { throw new Error("out of memory"); }, folded: () => {}, close: async () => {} };
      events.length = 0;
      const stuck = exhaustionOver(failing.dir, failing.view, broken, { exhaustion: set, peers: () => offers });
      await stuck.advance(() => { throw new Error("proved"); });
      await expect.poll(() => events.some(e => e.code === "PROVER")).toBe(true);
      await expect.poll(() => stuck.busy).toBe(false);
      expect(await stuck.source.supplier.fold(1n << 40n)).toBeUndefined();
      offers = [long.supplier];
      await stuck.advance((...args) => takenOver.push(args));
      expect([takenOver, await stuck.source.supplier.fold(1n << 40n)]).toEqual([[[long.fold, "taken", "long"]], long.fold]);
      // Its next period, from the taken fold, fails too (no wait left from the old one); a peer's fold above it replaces it.
      offers = [];
      await stuck.advance(() => { throw new Error("proved"); });
      await expect.poll(() => events.filter(e => e.code === "PROVER").length).toBe(2);
      await expect.poll(() => stuck.busy).toBe(false);
      takenOver.length = 0;
      offers = [full.supplier];
      await stuck.advance((...args) => takenOver.push(args));
      expect(takenOver).toEqual([[full.fold, "taken", "full"]]);
      expect(await stuck.source.supplier.fold(1n << 40n)).toEqual(full.fold);
      expect(await stuck.source.supplier.key(full.fold.inputs.endHeight, 0n, 0n)).toBeDefined();
    } finally {
      process.stderr.write = write;
      for (const view of opened) view.close();
    }
  });
});
