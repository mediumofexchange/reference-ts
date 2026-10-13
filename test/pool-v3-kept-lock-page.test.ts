import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PageDigest } from "../src/pool/v3/replay-store.js";

// SQLite never writes the page holding byte 2^30 (its lock-byte page), so no write-ahead log carries it: a kept file's
// digest takes a constant for it on both sides. The 10⁶ design-point run's journal reads stopped at the first keep point
// past 1 GiB (slice 18). These cases put the lock byte at 16 KiB so the file stays small.
const SIZE = 1024, LOCK_BYTE = 16 * 1024, LOCK_PAGE = LOCK_BYTE / SIZE + 1;
const scratch = join(process.cwd(), "scratch", "test-kept-lock-page");
mkdirSync(scratch, { recursive: true });
const directory = mkdtempSync(join(scratch, "run-"));
afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

const pageHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
/** A file of `count` pages, the lock-byte page filled with `lockFill`. */
function file(name: string, count: number, lockFill = 0): { path: string; pages: Buffer[] } {
  const pages = Array.from({ length: count }, (_, i) => (i + 1 === LOCK_PAGE ? Buffer.alloc(SIZE, lockFill) : randomBytes(SIZE)));
  const path = join(directory, name);
  writeFileSync(path, Buffer.concat(pages));
  return { path, pages };
}
/** The log of a commit at `count` pages carrying `numbers`' images from `pages`. */
const log = (pages: Buffer[], numbers: number[], count: number) => ({ pages: new Map(numbers.map(n => [n, pageHash(pages[n - 1]!)])), count });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("a kept file's digest across SQLite's lock-byte page", () => {
  it("grows past the lock-byte page from a log that lacks it, to the digest of the closed file, whatever its bytes there", () => {
    const { path, pages } = file("grown", 300, 0x5a);
    const kept = PageDigest.of(join(directory, "grown"), SIZE, LOCK_BYTE);
    const grown = new PageDigest(SIZE, LOCK_BYTE);
    grown.apply(log(pages, range(1, 10), 10));
    // One commit adds every page through 300 but the lock-byte page, as SQLite's log does.
    grown.apply(log(pages, range(11, 300).filter(n => n !== LOCK_PAGE), 300));
    expect(grown.root()).toBe(kept.root());
    // The page's bytes are never read: another file differing only there has the same digest.
    const other = file("other", 300, 0xc3);
    for (let n = 1; n <= 300; n++) if (n !== LOCK_PAGE) other.pages[n - 1] = pages[n - 1]!;
    writeFileSync(other.path, Buffer.concat(other.pages));
    expect(PageDigest.of(other.path, SIZE, LOCK_BYTE).root()).toBe(kept.root());
    expect(path).toBe(join(directory, "grown"));
  });

  it("still refuses a log lacking any other page its commit adds, leaving the digest as it was", () => {
    const { pages } = file("refused", 40);
    const digest = new PageDigest(SIZE, LOCK_BYTE);
    digest.apply(log(pages, range(1, 10), 10));
    const before = digest.root();
    expect(() => digest.apply(log(pages, range(11, 40).filter(n => n !== LOCK_PAGE && n !== 30), 40)))
      .toThrow("the write-ahead log lacks a page its commit adds");
    expect(digest.root()).toBe(before);
  });

  it("keeps the constant when a later commit names the lock-byte page, and below the page changes nothing", () => {
    const { path, pages } = file("named", 40);
    const digest = new PageDigest(SIZE, LOCK_BYTE);
    digest.apply(log(pages, range(1, 40).filter(n => n !== LOCK_PAGE), 40));
    digest.apply({ pages: new Map([[LOCK_PAGE, pageHash(randomBytes(SIZE))]]), count: 40 });
    expect(digest.root()).toBe(PageDigest.of(path, SIZE, LOCK_BYTE).root());
    // A file that never reaches the page hashes every page as it lies.
    const small = file("small", LOCK_PAGE - 1), whole = createHash("sha256");
    const group = createHash("sha256").update("v3-kept-page-group");
    for (const page of small.pages) group.update(pageHash(page));
    const frame = Buffer.alloc(16); frame.writeBigUInt64BE(BigInt(SIZE), 0); frame.writeBigUInt64BE(BigInt(LOCK_PAGE - 1), 8);
    expect(PageDigest.of(small.path, SIZE, LOCK_BYTE).root()).toBe(whole.update("v3-kept-file").update(frame).update(group.digest()).digest("hex"));
  });
});
