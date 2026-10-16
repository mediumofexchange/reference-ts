import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { blake2b } from "@noble/hashes/blake2b.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it } from "vitest";
import { ExhaustionServer } from "../src/ergo-exhaustion-server.js";
import { transactionsRoot } from "../src/ergo-profile.js";
import { testExhaustionSet } from "../src/ergo-exhaustion.js";
import { exhaustionOver, openView, venueText } from "../src/cli/venue.js";
import type { ExhaustionProver } from "../src/cli/backend.js";
import type { Fold } from "../src/ergo-exhaustion.js";
import { EXHAUSTION_CIRCUITS, ExhaustionPool } from "../src/ergo-exhaustion-pool.js";
import { encodeFold } from "../src/ergo-exhaustion-wire.js";
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
      expect([proved, unsound.busy, existsSync(dir.file("exhaustion-fold.bin")), existsSync(dir.file("exhaustion-fold.disagreement.bin"))])
        .toEqual([1, false, false, true]);
      expect(events.at(-1)).toMatchObject({ code: "DISAGREEMENT" });
      expect(await unsound.source.supplier.fold(1n << 40n)).toBeUndefined();
      expect(await unsound.source.supplier.transaction(A + 1n, 0n)).toBeUndefined();
      view.close();
    } finally { process.stderr.write = write; }
  });
});
