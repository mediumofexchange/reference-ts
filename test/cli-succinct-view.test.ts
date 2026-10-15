import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { blake2b } from "@noble/hashes/blake2b.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it } from "vitest";
import { ExhaustionServer } from "../src/ergo-exhaustion-server.js";
import { transactionsRoot } from "../src/ergo-profile.js";
import { exhaustionSet, openView, venueText } from "../src/cli/venue.js";
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

function directory(): Directory {
  mkdirSync(resolve("scratch"), { recursive: true });
  const path = mkdtempSync(resolve("scratch/cli-succinct-")); directories.push(path);
  writeFileSync(join(path, "venue.json"), venueText(profile, A));
  writeFileSync(join(path, "anchor.json"), `${JSON.stringify(chain.context.map(bytesToHex))}\n`);
  return Object.freeze({ path, config: { role: "wallet", nodes: ["http://127.0.0.1:9/"], read: "succinct" }, construction: POOL_V3 as Construction,
    succinct: true, file: (name: string) => join(path, name) });
}

describe("a succinct directory's view", () => {
  it("drops a set that disagrees, discards its view and kept answers, and reads without it", async () => {
    const dir = directory(), file = { profile, anchorHeight: A, id: new Uint8Array(32), reference: { context: profile.reference, profile } } as never;
    const set = exhaustionSet(file);
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
    let view = openView(dir);
    view.venue.follow(s);
    await expect(view.venue.sync([new BranchSupplier("node", blocks.at(-1)!, chain)],
      [{ name: "unsound", fold: h => map.fold(h), key: (e, k, f) => map.key(e, k, f), transaction: (h, p) => honest.transaction(h, p) }]))
      .rejects.toThrow("the exhaustion set disagreed");
    view.close();
    view = openView(dir);
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
  });
});
