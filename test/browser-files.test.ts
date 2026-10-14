import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { fieldToBytes } from "../src/pool/field.js";
import { ReplayStore } from "../src/pool/v3/replay-store.js";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { HEADER, isMounted, lookup, mountFiles, poolUse, unmountFiles } from "../src/browser/files.js";

// The browser host's file pool (slice 40, src/browser/files.ts) through node:fs as the bundle substitutes it: runs only
// in a browser engine's worker with the pool mounted (scripts/browser/files.mjs); elsewhere it skips.
const MAIN = "moe-check-files", OTHER = "moe-check-files-remount";
const text = (path: string) => readFileSync(path, "utf8");
type BigStats = { ino: bigint; nlink: bigint; size: bigint };
/** A failure as a browser's storage raises it: a DOMException-like error with a name and no errno. */
const browserFailure = (name: string) => Object.assign(new Error(`${name} from the browser`), { name });
/** Make the next call of `method` on `target` throw `error`, then restore it. */
function failOnce(target: object, method: string, error: Error): void {
  const own = target as Record<string, unknown>, original = own[method] as (...args: unknown[]) => unknown;
  own[method] = () => { own[method] = original; throw error; };
}

/** Mount `name` in place of the suites' pool for `body`, then give the suites' pool back as files.mjs mounted it. */
async function remounted(body: () => Promise<void>): Promise<void> {
  await unmountFiles();
  try { await mountFiles(OTHER); await body(); } finally {
    await unmountFiles();
    await mountFiles(MAIN);
    mkdirSync("/tmp", { recursive: true }); mkdirSync("/scratch", { recursive: true });
  }
}

describe.runIf(isMounted())("the browser host's file pool", () => {
  it("names, links, renames and lists files with Node's refusals", () => {
    const dir = "/tmp/names";
    mkdirSync(dir);
    try {
      writeFileSync(`${dir}/a`, "first");
      expect(() => openSync(`${dir}/a`, "wx")).toThrow(expect.objectContaining({ code: "EEXIST", syscall: "open" }));
      expect(() => readFileSync(`${dir}/missing`)).toThrow(expect.objectContaining({ code: "ENOENT" }));
      expect(() => writeFileSync(`${dir}/nowhere/x`, "")).toThrow(expect.objectContaining({ code: "ENOENT" }));
      expect(() => readFileSync(dir)).toThrow(expect.objectContaining({ code: "EISDIR" }));
      linkSync(`${dir}/a`, `${dir}/b`);
      const a = statSync(`${dir}/a`, { bigint: true }) as BigStats, b = statSync(`${dir}/b`, { bigint: true }) as BigStats;
      expect([a.ino === b.ino, a.nlink, b.nlink]).toEqual([true, 2n, 2n]);
      expect(() => linkSync(`${dir}/a`, `${dir}/b`)).toThrow(expect.objectContaining({ code: "EEXIST", syscall: "link" }));
      rmSync(`${dir}/a`);
      expect([existsSync(`${dir}/a`), text(`${dir}/b`), (statSync(`${dir}/b`, { bigint: true }) as BigStats).nlink]).toEqual([false, "first", 1n]);
      // A rename replaces the file there, which goes with its last name; the moved file keeps its identity.
      writeFileSync(`${dir}/c`, "second");
      const moved = (statSync(`${dir}/c`, { bigint: true }) as BigStats).ino;
      renameSync(`${dir}/c`, `${dir}/b`);
      expect([text(`${dir}/b`), (statSync(`${dir}/b`, { bigint: true }) as BigStats).ino === moved, existsSync(`${dir}/c`)]).toEqual(["second", true, false]);
      // A copy is another file: another identity.
      writeFileSync(`${dir}/d`, readFileSync(`${dir}/b`));
      expect((statSync(`${dir}/d`, { bigint: true }) as BigStats).ino === moved).toBe(false);
      mkdirSync(`${dir}/sub`);
      writeFileSync(`${dir}/sub/e`, "");
      expect(readdirSync(dir)).toEqual(["b", "d", "sub"]);
      expect(() => rmSync(`${dir}/sub`)).toThrow(expect.objectContaining({ code: "ERR_FS_EISDIR" }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps a removed file readable through an open descriptor and frees it at the last close", () => {
    writeFileSync("/tmp/open", "held");
    const before = poolUse(), fd = openSync("/tmp/open", "r");
    rmSync("/tmp/open");
    expect([existsSync("/tmp/open"), poolUse().unnamed]).toEqual([false, before.unnamed + 1]);
    const bytes = Buffer.alloc(4);
    expect([readSync(fd, bytes, 0, 4, 0), bytes.toString()]).toEqual([4, "held"]);
    closeSync(fd);
    expect(poolUse()).toMatchObject({ unnamed: before.unnamed, free: before.free + 1 });
  });

  it("reports a failure of the browser's storage as the system's (EIO), so a kept file is kept, never discarded as damaged", () => {
    const dir = "/tmp/failing", path = `${dir}/replay.sqlite`, digest = `${dir}/replay.sha256`;
    mkdirSync(dir);
    try {
      let store = new ReplayStore(path, { digest });
      const { walk } = store.openWalk(new Uint8Array(32).fill(7));
      const ns = store.open(fieldToBytes(1n), new Uint8Array(32).fill(2), undefined, { history: new Uint8Array(32), evidence: new Uint8Array(32) });
      store.closeWalk(walk);
      store.close();
      failOnce(lookup(path)!.handle, "read", browserFailure("InvalidStateError"));
      expect(() => readFileSync(path)).toThrow(expect.objectContaining({ code: "EIO", errno: -5, syscall: "read" }));
      // The digest check's own reads: the opening fails as the system's, and the file stays.
      failOnce(lookup(path)!.handle, "read", browserFailure("InvalidStateError"));
      expect(() => new ReplayStore(path, { digest })).toThrow(expect.objectContaining({ code: "EIO" }));
      store = new ReplayStore(path, { digest });
      expect(store.hasNamespace(ns)).toBe(true);
      store.close();
      failOnce(lookup(path)!.handle, "write", browserFailure("QuotaExceededError"));
      expect(() => writeFileSync(path, "x", { flag: "r+" })).toThrow(expect.objectContaining({ code: "ENOSPC", errno: -28 }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("closes a connection to a database removed under it without touching the log of a new database by that name", () => {
    const path = "/tmp/moved.db", first = new DatabaseSync(path);
    first.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1)");
    for (const name of [path, `${path}-wal`]) rmSync(name, { force: true });
    const second = new DatabaseSync(path);
    second.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL; CREATE TABLE u (y); INSERT INTO u VALUES (2)");
    first.close();
    expect(existsSync(`${path}-wal`)).toBe(true);
    expect(second.prepare("SELECT y FROM u").all()).toEqual([{ y: 2 }]);
    second.close();
    rmSync(path, { force: true });
  });

  it("keeps its files across a remount, a torn header write and a rename stopped between its two header writes", async () => {
    await remounted(async () => {
      expect(await mountFiles(OTHER).catch((error: { code?: string }) => error.code)).toBe("EBUSY");
      mkdirSync("/t");
      // An empty file is a file at the next mount too.
      closeSync(openSync("/t/empty", "a"));
      writeFileSync("/t/kept", "kept bytes");
      writeFileSync("/t/old", "old");
      writeFileSync("/t/new", "new");
      const identity = (statSync("/t/kept", { bigint: true }) as BigStats).ino;
      // A rename of the kept file and back: its header's newer copy is the second one written. That copy torn by a
      // crash, the older copy names the file.
      renameSync("/t/kept", "/t/kept2"); renameSync("/t/kept2", "/t/kept");
      const kept = lookup("/t/kept")!, newer = kept.copy;
      kept.handle.write(new Uint8Array(64).fill(0xee), { at: newer * (HEADER / 2) + 100 }); kept.handle.flush();
      // A rename of `new` over `old` stopped after its first header write: `old`'s member still claims the name.
      const old = lookup("/t/old")!, saved = new Uint8Array(old.handle.getSize());
      old.handle.read(saved, { at: 0 });
      renameSync("/t/new", "/t/old");
      old.handle.write(saved, { at: 0 }); old.handle.flush();
      // An open file holds the mount.
      const fd = openSync("/t/old", "r");
      expect(await unmountFiles().catch((error: { code?: string }) => error.code)).toBe("EBUSY");
      closeSync(fd);
      await unmountFiles();
      const mount = await mountFiles(OTHER);
      // The older copy named the kept file "/t/kept2" (the first rename's); the torn newer one named it "/t/kept".
      expect([existsSync("/t/kept"), text("/t/kept2"), (statSync("/t/kept2", { bigint: true }) as BigStats).ino === identity]).toEqual([false, "kept bytes", true]);
      // The name goes to the member written last: the rename's.
      expect([text("/t/old"), existsSync("/t/new"), text("/t/empty"), mount.files]).toEqual(["new", false, "", 3]);
      expect(poolUse().unnamed).toBe(0);
      // A header write the browser refuses changes nothing in memory, and may have reached the disk: every later call is
      // refused until a remount, when the headers on disk decide. Here it did not reach it.
      writeFileSync("/t/a", "A"); writeFileSync("/t/b", "B");
      failOnce(lookup("/t/a")!.handle, "write", browserFailure("QuotaExceededError"));
      expect(() => renameSync("/t/a", "/t/b")).toThrow(expect.objectContaining({ code: "ENOSPC", syscall: "rename" }));
      expect(() => readFileSync("/t/a")).toThrow(expect.objectContaining({ code: "EIO" }));
      expect(() => linkSync("/t/a", "/t/c")).toThrow(expect.objectContaining({ code: "EIO" }));
      await unmountFiles();
      await mountFiles(OTHER);
      expect([text("/t/a"), text("/t/b"), existsSync("/t/c")]).toEqual(["A", "B", false]);
    });
  });
});
