import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ErgoVenue, type ErgoReaderPolicy } from "../src/ergo.js";
import { encodeCommitment, signCommitment } from "../src/venue-records.js";
import { ergoProfileIdentity } from "../src/ergo-profile.js";
import { decodeRangeAnswer, heldCommitments } from "../src/record-range.js";
import { BranchSupplier, Chain, MempoolNode, plainBox, recordOutput, transaction, WorkedChain, type Block } from "./ergo-chain.js";
import type { ErgoVenueJournal as Journal } from "../src/ergo-store.js";
import { ErgoPublisher, verifyErgoProof } from "../src/ergo-publisher.js";
import { VenueError } from "../src/venue-error.js";

let ErgoVenueJournal: typeof import("../src/ergo-store.js").ErgoVenueJournal;
beforeAll(async () => { ({ ErgoVenueJournal } = await import("../src/ergo-store.js")); });
const directories: string[] = [], journals: Journal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  const scratch = resolve("scratch") + sep;
  for (const path of directories.splice(0)) { if (!resolve(path).startsWith(scratch)) throw new Error("outside scratch"); rmSync(path, { recursive: true, force: true }); }
});
const chain = new Chain(), profile = chain.profile(2n), id = ergoProfileIdentity(profile);
const secret = new Uint8Array(32).fill(81), first = signCommitment(secret, 1n, new Uint8Array(32).fill(1));
const twin = signCommitment(secret, 1n, new Uint8Array(32).fill(2));
const limits = { maxBytes: 1000000n, maxEntries: 1000n };
function file(): string {
  mkdirSync(resolve("scratch"), { recursive: true });
  const dir = mkdtempSync(resolve("scratch/ergo-store-")); directories.push(dir); return join(dir, "venue.sqlite");
}
function opened(path: string, policy: Partial<ErgoReaderPolicy> = {}) {
  const journal = new ErgoVenueJournal(path, id); journals.push(journal);
  return { journal, venue: new ErgoVenue(profile, chain.context, policy, undefined, journal) };
}
const supplier = (blocks: readonly Block[]) => new BranchSupplier("synthetic", blocks.at(-1)!, chain);
function records() {
  return chain.extend(chain.anchor, 10, i => i === 0 || i === 3
    ? [transaction([recordOutput(1, first.operator, encodeCommitment(i === 0 ? first : twin))])] : []);
}
function answer(venue: ErgoVenue, subject = first.operator, kind: 1 | 4 = 1, toIndex = venue.witnessedIndex()) {
  return venue.range({ venue: venue.id, kind, subject, fromIndex: 0n, toIndex }, limits)!;
}

describe("durable independently replayed Ergo view", () => {
  it("keeps its clock when a heavier but shorter chain keeps the block it stands on, live and on reopening, and publishes once it regrows (venue-ergo §2)", async () => {
    // The anchor two below an epoch's end: index 0 is the trunk, and each branch's first block ends the epoch.
    const worked = new WorkedChain(4n, 900_094n), trunk = worked.mine(worked.anchor);
    const edgeA = worked.mine(trunk, trunk.header.timestamp + 1_000_000_000n), edgeB = worked.mine(trunk);
    const a = worked.extend(edgeA, 3), b = worked.extend(edgeB, 2);
    // A far-future timestamp at A's edge halves its next epoch's difficulty: B outscores A (4 + 2·4 > 4 + 3·2) a block shorter.
    expect([a[0]!.difficulty, b[0]!.difficulty]).toEqual([2n, 4n]);
    const profile = worked.profile(4n), path = file();
    const mempool = new MempoolNode("mempool", verifyErgoProof), publisher = new ErgoPublisher({ secretKey: new Uint8Array(32).fill(9), suppliers: [mempool] });
    mempool.fund(plainBox(publisher.tree, 10_000_000n, worked.anchor.height));
    const durable = () => { const journal = new ErgoVenueJournal(path, ergoProfileIdentity(profile)); journals.push(journal); return journal; };
    const journal = durable(), view = new ErgoVenue(profile, worked.context, {}, publisher, journal);
    expect((await view.sync([worked.supplier("A", a.at(-1)!)])).witnessedIndex).toBe(0n);
    const report = await view.sync([worked.supplier("B", b.at(-1)!)]);
    // The chain alone no longer makes index 0 final, but the block the clock stands on is on it: the clock stays.
    expect([report.witnessedIndex, report.chainWitnessedIndex, report.tipHeight]).toEqual([0n, undefined, b.at(-1)!.height]);
    expect(bytesToHex(report.witnessedHeaderId!)).toBe(bytesToHex(trunk.id));
    // B's next block would fall inside the lag of the clock a record is signed at: nothing goes out until B regrows.
    const record = encodeCommitment(first);
    await expect(view.publishRecord(1, first.operator, record)).rejects.toThrow(new VenueError("the best chain is shorter than the clock's depth; publish once it grows"));
    expect(mempool.submitted).toEqual([]);
    journal.close();
    const reopened = new ErgoVenue(profile, worked.context, {}, undefined, durable());
    expect(reopened.witnessedIndex()).toBe(0n);
    reopened.attachPublisher(publisher);
    await reopened.sync([worked.supplier("B", worked.mine(b.at(-1)!))]);
    await reopened.publishRecord(1, first.operator, record);
    expect(mempool.submitted).toHaveLength(1);
  });

  it("reopens offline with byte-identical ranges, empty answers and non-held twins, then continues only new sections", async () => {
    const path = file(), blocks = records(), old = opened(path);
    await old.venue.sync([supplier(blocks)]);
    const clock = old.venue.witnessedIndex(), bytes = answer(old.venue), empty = answer(old.venue, new Uint8Array(32), 4);
    const decoded = decodeRangeAnswer(bytes, { venue: id, kind: 1, subject: first.operator, fromIndex: 0n, toIndex: clock }, limits);
    expect(decoded.entries).toHaveLength(2); expect(heldCommitments(decoded).held).toHaveLength(1);
    old.journal.close();
    const next = opened(path);
    expect(next.venue.witnessedIndex()).toBe(clock); expect(answer(next.venue)).toEqual(bytes);
    expect(answer(next.venue, new Uint8Array(32), 4)).toEqual(empty);
    const more = chain.extend(blocks.at(-1)!, 3), source = supplier(more);
    expect((await next.venue.sync([source])).sectionsRead).toBe(3);
    expect(next.venue.witnessedIndex()).toBe(clock + 3n); expect(answer(next.venue, first.operator, 1, clock)).toEqual(bytes);
  });

  it("keeps the old durable view during interrupted section ingestion and fences the abandoned owner", async () => {
    const path = file(), blocks = records(), old = opened(path);
    await old.venue.sync([supplier(blocks)]); const before = answer(old.venue), clock = old.venue.witnessedIndex();
    const more = chain.extend(blocks.at(-1)!, 3), source = supplier(more);
    let entered!: () => void, resume!: () => void;
    const waiting = new Promise<void>(r => { entered = r; }), blocked = new Promise<void>(r => { resume = r; });
    source.before = async call => { if (call === "section") { entered(); await blocked; } };
    const sync = old.venue.sync([source]); await waiting;
    expect(answer(old.venue)).toEqual(before);
    const next = opened(path); expect(next.venue.witnessedIndex()).toBe(clock); expect(answer(next.venue)).toEqual(before);
    resume(); await expect(sync).rejects.toThrow(/fenced/);
    expect(() => old.venue.witnessedIndex()).toThrow(/fenced/);
    await next.venue.sync([supplier(more)]); expect(next.venue.witnessedIndex()).toBe(clock + 3n);
  });

  it("poisons uncertain commits and reopens either the prior or the committed complete snapshot", async () => {
    for (const committed of [false, true]) {
      const path = file(), blocks = records(), old = opened(path);
      await old.venue.sync([supplier(blocks)]); const clock = old.venue.witnessedIndex();
      const commit = old.journal.commit.bind(old.journal);
      old.journal.commit = state => { if (committed) commit(state); throw new Error("injected storage interruption"); };
      await expect(old.venue.sync([supplier(chain.extend(blocks.at(-1)!, 2))])).rejects.toThrow("injected storage interruption");
      expect(() => old.venue.witnessedIndex()).toThrow(/reopen/); old.journal.close();
      expect(opened(path).venue.witnessedIndex()).toBe(clock + (committed ? 2n : 0n));
    }
  });

  it("keeps incomplete deep forks across pruning, restart and withholding until heavier work durably fails the venue", async () => {
    const path = file(), main = chain.extend(chain.anchor, 12), old = opened(path);
    await old.venue.sync([supplier(main)]); old.journal.close();
    const fork = chain.extend(main[0]!, 15, () => [], 19), source = supplier(fork);
    let current = opened(path, { headersPerSupplier: 4, headersPerRequest: 4 });
    const firstPass = await current.venue.sync([source]); expect(firstPass.suppliers[0]!.stopped).toBe("header budget");
    current.journal.close(); current = opened(path, { headersPerSupplier: 4, headersPerRequest: 4 });
    await current.venue.sync([]); // withholding is no reason to erase the retained prefix
    let failed = false;
    for (let i = 0; i < 5; i++) {
      try { await current.venue.sync([source]); } catch (error) { expect(String(error)).toMatch(/best chain left/); failed = true; break; }
    }
    expect(failed).toBe(true); current.journal.close();
    const terminal = opened(path); expect(() => terminal.venue.witnessedIndex()).toThrow(/best chain left/);
    await expect(terminal.venue.sync([supplier(main)])).rejects.toThrow(/best chain left/);
  });

  it("prunes completed inferior deep branches and still rediscovers a later heavier continuation", async () => {
    const path = file(), main = chain.extend(chain.anchor, 10), old = opened(path);
    await old.venue.sync([supplier(main)]);
    const fork = chain.extend(main[0]!, 3, () => [], 31);
    // The branch is kept while it is among the last four paths its supplier reached, and pruned once four others
    // displace it; a path its supplier extends replaces the one it extends.
    await old.venue.sync([supplier(fork)]);
    await old.venue.sync([supplier(chain.extend(fork.at(-1)!, 1, () => [], 31))]);
    const others = [32, 33, 34, 35].map(salt => chain.extend(main[0]!, 1, () => [], salt));
    for (const other of others) await old.venue.sync([supplier(other)]);
    old.journal.close();
    const { DatabaseSync } = await import("node:sqlite"), db = new DatabaseSync(path);
    expect(db.prepare("SELECT count(*) AS n FROM headers").get()!.n).toBe(main.length + others.length);
    expect(db.prepare("SELECT count(*) AS n FROM protected").get()!.n).toBe(4); db.close();
    const next = opened(path), extension = chain.extend(fork.at(-1)!, 10, () => [], 31);
    await expect(next.venue.sync([supplier(extension)])).rejects.toThrow(/best chain left/);
  });

  it("protects partial fork progress when repeated known headers exhaust the fetch budget", async () => {
    const path = file(), main = chain.extend(chain.anchor, 12), old = opened(path);
    await old.venue.sync([supplier(main)]); old.journal.close();
    const fork = chain.extend(main[0]!, 2, () => [], 51), next = opened(path, { headersPerSupplier: 4, headersPerRequest: 500 });
    let firstBatch = true;
    const noisy = {
      name: "repeated known headers", tipHeight: async () => chain.anchor.height + 5000n,
      headers: async (from: bigint, to: bigint) => {
        const batch = Array.from({ length: Number(to - from + 1n) }, () => fork[1]!.bytes);
        if (firstBatch) { batch[0] = fork[0]!.bytes; firstBatch = false; } return batch;
      }, section: async () => undefined,
    };
    expect((await next.venue.sync([noisy])).suppliers[0]!.stopped).toBe("fetch budget");
    next.journal.close(); const again = opened(path); await again.venue.sync([]); again.journal.close();
    const { DatabaseSync } = await import("node:sqlite"), db = new DatabaseSync(path);
    const protectedIds = db.prepare("SELECT id FROM protected").all().map(row => bytesToHex(row.id as Uint8Array));
    expect(protectedIds).toContain(bytesToHex(fork[1]!.id)); expect(db.prepare("SELECT count(*) AS n FROM headers").get()!.n).toBe(14); db.close();
  });

  it("protects no anchor or context header a supplier repeats until the fetch budget, so the view reopens", async () => {
    const path = file(), main = chain.extend(chain.anchor, 12), first = opened(path);
    const repeated = [chain.anchor.bytes, chain.context[0]!];
    for (const bytes of repeated) {
      const noisy = {
        name: "repeated anchor context", tipHeight: async () => chain.anchor.height + 100_000n,
        headers: async (from: bigint, to: bigint) => Array.from({ length: Number(to - from + 1n) }, () => bytes),
        section: async () => undefined,
      };
      const report = await first.venue.sync([supplier(main), noisy]);
      expect(report.suppliers[1]).toEqual({ name: "repeated anchor context", headersAdded: 0, stopped: "fetch budget" });
      expect(report.witnessedIndex).toBe(9n);
    }
    first.journal.close();
    expect(opened(path).venue.witnessedIndex()).toBe(9n);
  });

  it("replays original equal-work precedence when withheld sections initially prevent witnessing the fork", async () => {
    const path = file(), main = records(), alternate = chain.extend(main[0]!, 9, () => [], 71);
    const source = supplier(main); source.withheld.add(bytesToHex(main[1]!.id));
    const old = opened(path); await old.venue.sync([source, supplier(alternate)]);
    expect(old.venue.witnessedIndex()).toBe(0n); old.journal.close();
    const restarted = opened(path), memory = new ErgoVenue(profile, chain.context);
    await memory.sync([supplier(main), supplier(alternate)]);
    await restarted.venue.sync([supplier(main), supplier(alternate)]);
    expect(answer(restarted.venue)).toEqual(answer(memory));
  });

  it("preserves the retained budget stop across restart and resumes with a larger budget", async () => {
    const path = file(), blocks = records(), old = opened(path, { retainedBytes: 232 });
    expect((await old.venue.sync([supplier(blocks)])).unresolvedReason).toBe("retained budget");
    expect(old.venue.witnessedIndex()).toBe(2n); old.journal.close();
    const next = opened(path, { retainedBytes: 232 }); expect(next.venue.witnessedIndex()).toBe(2n);
    expect((await next.venue.sync([supplier(blocks)])).unresolvedReason).toBe("retained budget"); next.journal.close();
    const larger = opened(path); await larger.venue.sync([supplier(blocks)]); expect(larger.venue.witnessedIndex()).toBe(7n);
    larger.journal.close(); expect(() => opened(path, { retainedBytes: 232 })).toThrow(/retained budget/);
  });

  it("refuses missing or corrupt rows, a moved pin, an unburied clock, a foreign identity and the old checkpoint format on restore", async () => {
    const refusals = { pin: /invalid stored Ergo view/, section: /invalid stored Ergo view/, header: /does not reproduce/, bytes: /does not reproduce/,
      best: /does not reproduce/, protection: /does not reproduce/, unburied: /does not reproduce/, tip: /does not reproduce/ };
    for (const change of Object.keys(refusals) as (keyof typeof refusals)[]) {
      const path = file(), old = opened(path), blocks = records(); await old.venue.sync([supplier(blocks)]); old.journal.close();
      const { DatabaseSync } = await import("node:sqlite"), db = new DatabaseSync(path);
      const pin = db.prepare("SELECT pin, witnessed FROM meta").get()!, pinHeight = chain.anchor.height + 1n + BigInt(pin.witnessed as number);
      if (change === "pin") db.prepare("UPDATE meta SET pin=?").run(new Uint8Array(32));
      if (change === "section") db.prepare("DELETE FROM sections WHERE idx=?").run(pin.witnessed as number);
      if (change === "header") db.prepare("DELETE FROM headers WHERE id=?").run(pin.pin as Uint8Array);
      if (change === "bytes") db.prepare("UPDATE headers SET bytes=? WHERE id=?").run(blocks[0]!.bytes, pin.pin as Uint8Array);
      if (change === "best") db.prepare("UPDATE best SET id=? WHERE height=?").run(blocks[0]!.id, pinHeight);
      if (change === "protection") db.prepare("INSERT INTO protected VALUES('synthetic',?,0)").run(new Uint8Array(32));
      // The chain cut back to below the clock's depth: no kept header buries its block.
      if (change === "unburied") for (const table of ["best", "headers"]) db.prepare(`DELETE FROM ${table} WHERE height>=?`).run(pinHeight + profile.depth);
      if (change === "tip") db.prepare("DELETE FROM headers WHERE id=?").run(blocks.at(-1)!.id);
      db.close();
      expect(() => opened(path), change).toThrow(refusals[change]);
    }
    const path = file(), old = opened(path); old.journal.close();
    expect(() => new ErgoVenueJournal(path, new Uint8Array(32).fill(9))).toThrow("invalid stored Ergo view");
    const { DatabaseSync } = await import("node:sqlite"), legacy = file(), db = new DatabaseSync(legacy);
    db.exec("CREATE TABLE ergo_checkpoint (id INTEGER PRIMARY KEY)"); db.close();
    expect(() => new ErgoVenueJournal(legacy, id)).toThrow("older format");
  });

  it("audits every row again: linkage, difficulty and score, work, roots and objects, and names the first that does not reproduce", async () => {
    const healthy = opened(file()), blocks = records(); await healthy.venue.sync([supplier(blocks)]);
    expect(healthy.venue.audit({ work: true })).toEqual({ headers: 10, sections: 8n, objects: 2n });
    const audits = {
      gap: [/section 4 is not the best chain's next/, "DELETE FROM sections WHERE idx=3"],
      object: [/section 3's objects are not those it attributes/, "DELETE FROM objects WHERE idx=3"],
      record: [/section 0's objects are not those it attributes/, "UPDATE objects SET record=zeroblob(length(record)) WHERE idx=0"],
      root: [/section 1 does not reproduce its header's root/, "UPDATE sections SET views=(SELECT views FROM sections WHERE idx=0) WHERE idx=1"],
      extra: [/objects are kept beyond the sections/, "INSERT INTO objects SELECT 99, position, kind, subject, ordinal, record, key FROM objects WHERE idx=0"],
      score: [/height \d+: its difficulty or score is wrong/, "UPDATE headers SET score='12345' WHERE height=(SELECT max(height) FROM best)"],
      link: [/height \d+: it does not link to the best chain below it/, "UPDATE headers SET parent=zeroblob(32) WHERE height=(SELECT min(height) FROM best)"],
    } as const;
    for (const [name, [refusal, sql]] of Object.entries(audits)) {
      const path = file(), old = opened(path); await old.venue.sync([supplier(blocks)]); old.journal.close();
      const { DatabaseSync } = await import("node:sqlite"), db = new DatabaseSync(path); db.exec(sql); db.close();
      expect(() => opened(path).venue.audit(), name).toThrow(refusal);
    }
  });

  it("audits a view copied from another file before any read, and refuses one whose rows do not reproduce (slice 13 M13e)", async () => {
    const { copyFileSync, existsSync } = await import("node:fs"), { DatabaseSync } = await import("node:sqlite");
    const source = file(), old = opened(source), blocks = records(); await old.venue.sync([supplier(blocks)]); old.journal.close();
    const copy = (to: string) => { for (const suffix of ["", "-wal"]) if (existsSync(source + suffix)) copyFileSync(source + suffix, to + suffix); return to; };
    // A faithful copy is audited once, as it opens, and is then the view's own file.
    const faithful = copy(file()), first = opened(faithful);
    expect(first.journal.copied()).toBe(false);
    expect(first.venue.witnessedIndex()).toBe(7n);
    first.journal.close();
    expect(opened(faithful).journal.copied()).toBe(false);
    // A copy whose rows another hand changed, with no work redone, opens nowhere.
    const changed = copy(file()), db = new DatabaseSync(changed);
    db.exec("UPDATE objects SET record=zeroblob(length(record)) WHERE idx=0"); db.close();
    expect(() => opened(changed)).toThrow(/a copied or restored view does not reproduce: .*section 0's objects .* sync again from the anchor/);
    // The same change in the view's own file passes reopening, which checks only what is cheap; `audit` finds it.
    const own = new DatabaseSync(source); own.exec("UPDATE objects SET record=zeroblob(length(record)) WHERE idx=0"); own.close();
    expect(() => opened(source).venue.audit()).toThrow(/section 0's objects are not those it attributes/);
  });

  it("keeps a copied view's venue failure, and names a damaged header row of a copy that never settled (M13e review)", async () => {
    const { copyFileSync, existsSync } = await import("node:fs"), { DatabaseSync } = await import("node:sqlite");
    const { FAILURE } = await import("../src/ergo-store.js");
    const copy = (source: string) => { const to = file(); for (const s of ["", "-wal"]) if (existsSync(source + s)) copyFileSync(source + s, to + s); return to; };
    // A view that failed: its copy opens, audited, and still refuses with the failure, the only evidence finality broke.
    const failed = file(), old = opened(failed); await old.venue.sync([supplier(records())]); old.journal.close();
    const db = new DatabaseSync(failed); db.prepare("UPDATE meta SET failure=?").run(FAILURE); db.close();
    const kept = opened(copy(failed));
    expect(kept.journal.copied()).toBe(false);
    expect(() => kept.venue.witnessedIndex()).toThrow(FAILURE);
    // A view whose clock never settled: a damaged header row in its copy is a named refusal, not an unexpected error.
    const young = file(), first = opened(young); await first.venue.sync([supplier(chain.extend(chain.anchor, 1))]); first.journal.close();
    for (const damage of ["UPDATE headers SET score='999999'", "UPDATE headers SET parent=zeroblob(32)"]) {
      const damaged = copy(young), changed = new DatabaseSync(damaged); changed.exec(damage); changed.close();
      expect(() => opened(damaged), damage).toThrow(VenueError);
      expect(() => opened(damaged), damage).toThrow(/a copied or restored view does not reproduce: Ergo view audit/);
    }
  });

  it("keeps each supplier's side-branch charge by name across a restart, so a new process grants no fresh quota", async () => {
    const path = file(), main = chain.extend(chain.anchor, 12), policy = { sideHeadersPerSupplier: 2 };
    const old = opened(path, policy); await old.venue.sync([supplier(main)]);
    const side = new BranchSupplier("side", chain.extend(main[2]!, 6, () => [], 61).at(-1)!, chain);
    expect((await old.venue.sync([supplier(main), side])).suppliers[1]).toEqual({ name: "side", headersAdded: 6 });
    old.journal.close();
    const next = opened(path, policy), again = new BranchSupplier("side", chain.extend(main[3]!, 3, () => [], 62).at(-1)!, chain);
    expect((await next.venue.sync([supplier(main), again])).suppliers[1]).toEqual({ name: "side", headersAdded: 0, stopped: "side-branch quota" });
  });

  it("protects what a failing supplier reached, so a heavier deep fork it serves in pieces still fails the venue, durable or not", async () => {
    for (const durable of [true, false]) {
      const path = file(), main = chain.extend(chain.anchor, 12), policy = { headersPerRequest: 4 };
      const view = durable ? opened(path, policy).venue : new ErgoVenue(profile, chain.context, policy);
      await view.sync([supplier(main)]);
      // Each pass steps back to where the fork meets the chain, reads one request and then fails: no pass reaches the
      // fork's tip and none is stopped by its budget, so only protection carries its progress to the next sync.
      const source = supplier(chain.extend(main[0]!, 15, () => [], 63));
      let calls = 0;
      source.before = async call => { calls = call === "tip" ? 0 : calls + 1; if (calls === 5) throw new Error("gone"); };
      let failed = false;
      for (let i = 0; i < 12 && !failed; i++) {
        try { await view.sync([source]); } catch (error) { expect(String(error)).toMatch(/best chain left/); failed = true; }
      }
      expect(failed, durable ? "durable" : "memory").toBe(true);
    }
  });

  it("refuses a range past the reader's budget while reading the rows, and a view kept under other rules", async () => {
    const path = file(), old = opened(path), blocks = records(); await old.venue.sync([supplier(blocks)]);
    const { RangeLimitError } = await import("../src/record-range.js");
    expect(() => old.venue.range({ venue: old.venue.id, kind: 1, subject: first.operator, fromIndex: 0n, toIndex: 7n }, { maxBytes: 1000000n, maxEntries: 1n }))
      .toThrow(RangeLimitError);
    expect(() => old.venue.range({ venue: old.venue.id, kind: 1, subject: first.operator, fromIndex: 0n, toIndex: 7n }, { maxBytes: 100n, maxEntries: 10n }))
      .toThrow(RangeLimitError);
    old.journal.close();
    const { DatabaseSync } = await import("node:sqlite"), db = new DatabaseSync(path); db.exec("UPDATE meta SET rules='moe/ergo-view-rules/0'"); db.close();
    expect(() => opened(path)).toThrow("other view rules");
  });

  it("reads a supplier past its quota for headers extending the best tip, so its charge is forgiven and the clock moves, across a restart", async () => {
    const path = file(), policy = { sideHeadersPerSupplier: 2 }, main = chain.extend(chain.anchor, 12);
    const old = opened(path, policy), only = new BranchSupplier("only", main.at(-1)!, chain);
    await old.venue.sync([only]);
    only.tip = chain.extend(main[0]!, 3, () => [], 64).at(-1)!;
    await old.venue.sync([only]); old.journal.close();
    // Its stale branch spent the quota; its next answers extend the best tip and are read, the side branch still is not.
    const next = opened(path, policy);
    only.tip = chain.extend(main[5]!, 2, () => [], 65).at(-1)!;
    expect((await next.venue.sync([only])).suppliers[0]).toEqual({ name: "only", headersAdded: 0, stopped: "side-branch quota" });
    only.tip = chain.extend(main.at(-1)!, 40).at(-1)!;
    let report = await next.venue.sync([only]);
    expect(report.suppliers[0]).toEqual({ name: "only", headersAdded: 40, stopped: "side-branch quota" });
    report = await next.venue.sync([only]);
    expect(report.suppliers[0]).toEqual({ name: "only", headersAdded: 0 });
    expect(next.venue.witnessedIndex()).toBe(49n);
  });

  it("audits chain selection and stray header rows, keys objects by a 32-byte subject, and refuses a malformed supplier name", async () => {
    const blocks = records();
    for (const [name, sql, refusal] of [
      ["selection", `DELETE FROM best WHERE height>${chain.anchor.height + 4n}; INSERT INTO side SELECT id FROM headers WHERE height>${chain.anchor.height + 4n};
        DELETE FROM sections WHERE idx>1; DELETE FROM objects WHERE idx>1`, /it outscores the best chain/],
      ["stray", "INSERT INTO headers SELECT zeroblob(32), height, parent, score, bytes FROM headers LIMIT 1", /neither the best chain nor a side branch/],
    ] as const) {
      const path = file(), old = opened(path); await old.venue.sync([supplier(blocks)]); old.journal.close();
      const { DatabaseSync } = await import("node:sqlite"), db = new DatabaseSync(path); db.exec(sql);
      // The stored best chain cut to a prefix of the heavier headers kept as side headers, with a clock it buries.
      if (name === "selection") db.prepare("UPDATE meta SET witnessed=1, pin=?, buried=?, retained=?").run(blocks[1]!.id, blocks[3]!.id, 0);
      db.close();
      expect(() => opened(path).venue.audit(), name).toThrow(refusal);
    }
    const view = opened(file()).venue; await view.sync([supplier(blocks)]);
    const record = encodeCommitment(first);
    expect(view.witnessedAt(1, first.operator, record)).toBe(0n);
    expect(view.witnessedAt(1, Uint8Array.of(...first.operator, record[0]!), record.subarray(1))).toBeUndefined();
    expect(view.witnessedAt(1, new Uint8Array(0), Uint8Array.of(...first.operator, ...record))).toBeUndefined();
    await expect(view.sync([new BranchSupplier("\ud800", blocks.at(-1)!, chain)])).rejects.toThrow(new TypeError("a supplier's name is not well-formed text"));
    expect(view.witnessedIndex()).toBe(7n);
  });

  it("judges every argument before attaching its journal, so a corrected retry opens it", () => {
    const journal = new ErgoVenueJournal(file(), id); journals.push(journal);
    expect(() => new ErgoVenue(profile, chain.context, { headersPerSupplier: 0 }, undefined, journal)).toThrow(TypeError);
    expect(() => new ErgoVenue(profile, chain.context.slice(1), {}, undefined, journal)).toThrow(/does not authenticate/);
    expect(() => new ErgoVenue(profile, chain.context, {}, undefined, journal)).not.toThrow();
  });
});
