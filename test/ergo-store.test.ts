import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ErgoVenue, type ErgoReaderPolicy } from "../src/ergo.js";
import { encodeCommitment, signCommitment } from "../src/commitment.js";
import { ergoProfileIdentity } from "../src/ergo-profile.js";
import { decodeRangeAnswer, heldCommitments } from "../src/record-range.js";
import { BranchSupplier, Chain, recordOutput, transaction, WorkedChain, type Block } from "./ergo-chain.js";
import type { ErgoVenueJournal as Journal } from "../src/ergo-store.js";

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
  it("keeps its clock when a heavier but shorter chain keeps the block it stands on, live and on reopening (venue-ergo §2)", async () => {
    // The anchor two below an epoch's end: index 0 is the trunk, and each branch's first block ends the epoch.
    const worked = new WorkedChain(4n, 900_094n), trunk = worked.mine(worked.anchor);
    const edgeA = worked.mine(trunk, trunk.header.timestamp + 1_000_000_000n), edgeB = worked.mine(trunk);
    const a = worked.extend(edgeA, 3), b = worked.extend(edgeB, 2);
    // A far-future timestamp at A's edge halves its next epoch's difficulty: B outscores A (4 + 2·4 > 4 + 3·2) a block shorter.
    expect([a[0]!.difficulty, b[0]!.difficulty]).toEqual([2n, 4n]);
    const profile = worked.profile(4n), path = file();
    const durable = () => { const journal = new ErgoVenueJournal(path, ergoProfileIdentity(profile)); journals.push(journal); return journal; };
    const journal = durable(), view = new ErgoVenue(profile, worked.context, {}, undefined, journal);
    expect((await view.sync([worked.supplier("A", a.at(-1)!)])).witnessedIndex).toBe(0n);
    const report = await view.sync([worked.supplier("B", b.at(-1)!)]);
    // The chain alone no longer makes index 0 final, but the block the clock stands on is on it: the clock stays.
    expect([report.witnessedIndex, report.chainWitnessedIndex, report.tipHeight]).toEqual([0n, undefined, b.at(-1)!.height]);
    expect(bytesToHex(report.witnessedHeaderId!)).toBe(bytesToHex(trunk.id));
    journal.close();
    expect(new ErgoVenue(profile, worked.context, {}, undefined, durable()).witnessedIndex()).toBe(0n);
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
    await old.venue.sync([supplier(fork)]); old.journal.close();
    const { DatabaseSync } = await import("node:sqlite"), db = new DatabaseSync(path);
    const stored = JSON.parse(db.prepare("SELECT payload FROM ergo_checkpoint").get()!.payload as string); db.close();
    expect(stored.headers).toHaveLength(main.length);
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
    const stored = JSON.parse(db.prepare("SELECT payload FROM ergo_checkpoint").get()!.payload as string); db.close();
    expect(stored.protectedHeaders).toContain(bytesToHex(fork[1]!.id)); expect(stored.headers).toHaveLength(14);
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

  it("refuses root-changing omissions, corrupt bytes, missing history and a foreign identity on restore", async () => {
    for (const change of ["digest", "section", "header", "pin", "protection"] as const) {
      const path = file(), old = opened(path); await old.venue.sync([supplier(records())]); old.journal.close();
      const { DatabaseSync } = await import("node:sqlite"), db = new DatabaseSync(path);
      const stored = JSON.parse(db.prepare("SELECT payload FROM ergo_checkpoint").get()!.payload as string);
      if (change === "section") stored.sections[3].views = [];
      if (change === "header") stored.headers.splice(1, 1);
      if (change === "pin") stored.pin = "00".repeat(32);
      if (change === "protection") stored.protectedHeaders = ["00".repeat(32)];
      const payload = JSON.stringify(stored), digest = bytesToHex(sha256(new TextEncoder().encode(payload)));
      db.prepare("UPDATE ergo_checkpoint SET payload=?,digest=?").run(payload, change === "digest" ? "00".repeat(32) : digest); db.close();
      // A payload that is not the one committed is no checkpoint; one that is, but does not reproduce its view, is refused for that.
      expect(() => opened(path)).toThrow(change === "digest" ? "invalid stored Ergo checkpoint" : "stored Ergo evidence does not reproduce its witnessed view");
    }
    const path = file(), old = opened(path); old.journal.close();
    expect(() => new ErgoVenueJournal(path, new Uint8Array(32).fill(9))).toThrow("invalid stored Ergo checkpoint");
  });
});
