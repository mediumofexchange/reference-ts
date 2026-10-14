import { describe, expect, it } from "vitest";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { HEADER, isMounted, lookup, mountFiles, poolUse, unmountFiles } from "../src/browser/files.js";

// The browser host's file pool (slice 40, src/browser/files.ts) through node:fs as the bundle substitutes it: runs only
// in a browser engine's worker with the pool mounted (scripts/browser/files.mjs); elsewhere it skips.
const MAIN = "moe-check-files", OTHER = "moe-check-files-remount";
const text = (path: string) => readFileSync(path, "utf8");
type BigStats = { ino: bigint; nlink: bigint; size: bigint };

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

  it("keeps its files across a remount, a torn header write and a rename stopped between its two header writes", async () => {
    await remounted(async () => {
      expect(await mountFiles(OTHER).catch((error: { code?: string }) => error.code)).toBe("EBUSY");
      mkdirSync("/t");
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
      await unmountFiles();
      const mount = await mountFiles(OTHER);
      // The older copy named the kept file "/t/kept2" (the first rename's); the torn newer one named it "/t/kept".
      expect([existsSync("/t/kept"), text("/t/kept2"), (statSync("/t/kept2", { bigint: true }) as BigStats).ino === identity]).toEqual([false, "kept bytes", true]);
      // The name goes to the member written last: the rename's.
      expect([text("/t/old"), existsSync("/t/new"), mount.files]).toEqual(["new", false, 2]);
      expect(poolUse().unnamed).toBe(0);
    });
  });
});
