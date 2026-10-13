import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { committedLog, PageDigest } from "../src/pool/v3/replay-store.js";

// SQLite never writes the page holding byte 2^30 (its lock-byte page), so no write-ahead log carries it: a kept file's
// digest takes a constant for it on both sides. The 10⁶ design-point run's journal reads stopped at the first keep point
// past 1 GiB (slice 18). These cases move the lock byte lower so the files stay small, keeping the page first in its
// group of 256 as it is at 2^30 for every page size.
const directory = mkdtempSync(join(tmpdir(), "moe-kept-lock-page-"));
afterAll(() => { rmSync(directory, { recursive: true, force: true }); });
const pageHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();

/** Overwrite the lock-byte page of a closed file: its bytes are none of the state. */
function scribble(path: string, size: number, lockByte: number): void {
  if (statSync(path).size < lockByte + size) return;
  const fd = openSync(path, "r+");
  try { writeSync(fd, Buffer.alloc(size, 0xee), 0, size, lockByte); } finally { closeSync(fd); }
}

describe("a kept file's digest across SQLite's lock-byte page", () => {
  it("places the lock-byte page at 2^30 / page size + 1, first in its group, for every page size SQLite allows", () => {
    for (let size = 512; size <= 65536; size *= 2) {
      const { lockPage } = new PageDigest(size);
      expect(lockPage).toBe(2 ** 30 / size + 1);
      expect((lockPage - 1) % 256).toBe(0);
    }
  });

  for (const size of [512, 1024, 4096]) {
    it(`keeps a real write-ahead log's digest equal to the closed file's across the page, at page size ${size}`, () => {
      const lockByte = 2 * 256 * size, lockPage = lockByte / size + 1, path = join(directory, `db-${size}`);
      const db = new DatabaseSync(path);
      db.exec(`PRAGMA page_size=${size}; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=OFF;
        CREATE TABLE t(k INTEGER PRIMARY KEY, v BLOB);`);
      let digest = new PageDigest(size, lockByte);
      // A keep point: the log's commits applied, the log checkpointed, the file's own digest equal, and reopening from it.
      const keep = (label: string): void => {
        const log = committedLog(`${path}-wal`, size);
        if (log !== undefined) digest.apply(log);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        scribble(path, size, lockByte);
        const opened = PageDigest.of(path, size, lockByte);
        expect(opened.root(), label).toBe(digest.root());
        digest = opened;
      };
      const insert = db.prepare("INSERT INTO t(v) VALUES (randomblob(?))"), pages = () => statSync(path).size / size;
      keep("empty");
      for (let k = 0; pages() < lockPage + 300; k++) {
        for (let c = 0; c < 3; c++) { db.exec("BEGIN"); for (let i = 0; i < 20; i++) insert.run(Math.floor(size * 1.7)); db.exec("COMMIT"); }
        keep(`grown ${k}`);
      }
      db.exec("DELETE FROM t WHERE k > 5"); keep("deleted");
      db.exec("VACUUM"); keep("vacuumed");
      expect(pages()).toBeLessThan(lockPage);
      // Grown past the page in one commit, shrunk and grown again, all in one log.
      db.exec("BEGIN"); for (let i = 0; i < 400; i++) insert.run(size); db.exec("COMMIT");
      db.exec("DELETE FROM t WHERE k > 5"); db.exec("VACUUM");
      db.exec("BEGIN"); for (let i = 0; i < 600; i++) insert.run(size); db.exec("COMMIT");
      keep("shrunk and grown in one log");
      expect(pages()).toBeGreaterThan(lockPage);
      db.exec("DELETE FROM t WHERE k > 5"); db.exec("VACUUM");
      db.exec("BEGIN"); for (let i = 0; i < 3; i++) insert.run(size); db.exec("COMMIT");
      keep("shrunk below in one log");
      db.close();
    });
  }

  it("still refuses a log lacking any other page its commit adds, or ending the file on the lock-byte page", () => {
    const size = 512, lockByte = 256 * size, lock = 257;
    const images = (from: number, to: number, skip: number[] = []) =>
      new Map(Array.from({ length: to - from + 1 }, (_, i) => from + i).filter(n => !skip.includes(n)).map(n => [n, pageHash(Buffer.from(String(n)))] as const));
    const digest = new PageDigest(size, lockByte);
    digest.apply({ pages: images(1, 10), count: 10 });
    const before = digest.root();
    expect(() => digest.apply({ pages: images(11, 300, [lock, 280]), count: 300 })).toThrow("the write-ahead log lacks a page its commit adds");
    expect(() => digest.apply({ pages: images(11, 256), count: lock })).toThrow("ending on SQLite's lock-byte page");
    expect(digest.root()).toBe(before);
    // Without them, the commit crosses the page and a later log naming the page changes nothing.
    digest.apply({ pages: images(11, 300, [lock]), count: 300 });
    const crossed = digest.root();
    digest.apply({ pages: new Map([[lock, pageHash(Buffer.from("named"))]]), count: 300 });
    expect(digest.root()).toBe(crossed);
  });

  it("reads around the page alone in the last group, whatever the file's tail", () => {
    const size = 512, lockByte = 256 * size, lock = 257;
    for (const extra of [size + 1, 2 * size, 2 * size + 7, 3 * size]) {
      const body = Buffer.alloc(256 * size + extra);
      for (let i = 0; i < body.length; i++) body[i] = (i * 7) & 255;
      const path = join(directory, `tail-${extra}`);
      writeFileSync(path, body);
      const count = Math.ceil(body.length / size), maintained = new PageDigest(size, lockByte);
      maintained.apply({ pages: new Map(Array.from({ length: count }, (_, i) => i + 1).filter(n => n !== lock)
        .map(n => [n, pageHash(body.subarray((n - 1) * size, Math.min(n * size, body.length)))] as const)), count });
      expect(PageDigest.of(path, size, lockByte).root(), `tail ${extra}`).toBe(maintained.root());
    }
  });
});
