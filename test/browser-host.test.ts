// The browser host's substitutes for node:sqlite, node:crypto, node:fs, node:path and node:url (slice 39, src/browser/),
// held to Node's own modules as oracles in the regular suite. Under the equivalence run (vitest.browser-host.config.ts)
// node:sqlite and node:crypto are the substitutes themselves, so the oracle cases skip there and the stores' own
// refusal of a database file is checked instead.
import * as nodeCrypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { DatabaseSync as NodeDatabase } from "node:sqlite";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import * as browserCrypto from "../src/browser/node-crypto.js";
import * as browserFs from "../src/browser/node-fs.js";
import * as browserPath from "../src/browser/node-path.js";
import { DatabaseSync as BrowserDatabase } from "../src/browser/node-sqlite.js";
import { fileURLToPath } from "../src/browser/node-url.js";
import { EvidenceStore } from "../src/pool/v3/evidence-store.js";
import { ReplayStore } from "../src/pool/v3/replay-store.js";
import { BROWSER_HOST } from "./support.js";

type Database = InstanceType<typeof NodeDatabase>;
const hosts = (): [string, Database][] => [["node", new NodeDatabase(":memory:")], ["browser", new BrowserDatabase(":memory:") as unknown as Database]];
/** What a call gives, or the error's shape where it throws. */
function outcome(run: () => unknown): unknown {
  try { return { value: run() }; } catch (error) {
    const { code, errcode, errstr } = error as { code?: unknown; errcode?: unknown; errstr?: unknown };
    return { name: (error as Error).name, code, errcode, errstr, message: (error as Error).message };
  }
}

describe.skipIf(BROWSER_HOST)("the browser host's node:sqlite against node:sqlite", () => {
  it("binds and reads every type as node:sqlite does, numbers as REAL and bigints as INTEGER", () => {
    const seen = hosts().map(([, db]) => {
      db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b ANY, c BLOB, d TEXT) STRICT");
      const insert = db.prepare("INSERT INTO t (b, c, d) VALUES (?, ?, ?)");
      const rows = [
        insert.run(5, new Uint8Array([1, 2, 3]), "x"), insert.run(5.5, new Uint8Array(0), "é∑"), insert.run(5n, null, ""),
        insert.run(9007199254740993n, Uint8Array.of(0), "z"), insert.run(true as never, null, null), insert.run(-1n << 63n, null, null),
      ];
      const typed = db.prepare("SELECT a, b, typeof(b) AS tb, c, typeof(c) AS tc, d FROM t ORDER BY a");
      const plain = outcome(() => typed.all());
      typed.setReadBigInts(true);
      return { rows, plain, big: typed.all(), one: db.prepare("SELECT d FROM t WHERE a = ?").get(2), none: db.prepare("SELECT d FROM t WHERE a = ?").get(99) };
    });
    expect(seen[1]).toEqual(seen[0]);
    expect((seen[0]!.plain as { message: string }).message).toMatch(/too large/);
  });

  it("binds named, anonymous and numbered parameters alike, and refuses what node:sqlite refuses, with its codes and messages", () => {
    const seen = hosts().map(([, db]) => ({
      mixed: outcome(() => db.prepare("SELECT :a AS a, ? AS b, $c AS c, ? AS d").get({ a: 1n, c: "c" }, 2n, 4n)),
      numbered: outcome(() => db.prepare("SELECT ?1 AS x, ?1 + ?2 AS y").get(3n, 4n)),
      repeated: outcome(() => db.prepare("SELECT :k AS a, :k AS b").get({ k: "same" })),
      prefixed: outcome(() => db.prepare("SELECT :a AS a, @b AS b").get({ ":a": 1n, "@b": 2n })),
      conflicting: outcome(() => db.prepare("SELECT :a AS a, $a AS b").get({ a: 1n })),
      conflictingPrefixed: outcome(() => db.prepare("SELECT :a AS a, $a AS b").get({ ":a": 1n, $a: 2n })),
      unknown: outcome(() => db.prepare("SELECT :a AS a").get({ b: 1 })),
      undefinedValue: outcome(() => db.prepare("SELECT ? AS a").get(undefined as never)),
      object: outcome(() => db.prepare("SELECT ? AS a").get(1n, {} as never)),
      tooMany: outcome(() => db.prepare("SELECT ? AS a").get(1n, 2n)),
      empty: outcome(() => db.prepare("")),
      blank: outcome(() => db.prepare("  ;")),
    }));
    expect(seen[1]).toEqual(seen[0]);
  });

  it("reports SQLite's failures with node:sqlite's code, extended result code and message, and leaves the statement usable", () => {
    const seen = hosts().map(([, db]) => {
      db.exec("CREATE TABLE u (k INTEGER PRIMARY KEY, v TEXT NOT NULL UNIQUE)");
      const insert = db.prepare("INSERT INTO u VALUES (?, ?)");
      insert.run(1n, "a");
      return {
        unique: outcome(() => insert.run(2n, "a")), primary: outcome(() => insert.run(1n, "b")), notNull: outcome(() => insert.run(3n, null)),
        after: insert.run(4n, "d"), syntax: outcome(() => db.prepare("SELEKT 1")), table: outcome(() => db.exec("SELECT * FROM missing")),
        foreign: outcome(() => db.exec("CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE ch (p INTEGER REFERENCES p(id)); INSERT INTO ch VALUES (7)")),
      };
    });
    expect(seen[1]).toEqual(seen[0]);
  });

  it("tracks transactions and savepoints, and refuses a closed database and its statements as node:sqlite does", () => {
    const seen = hosts().map(([, db]) => {
      const states = [db.isTransaction];
      db.exec("CREATE TABLE w (n INTEGER); BEGIN; INSERT INTO w VALUES (1); SAVEPOINT s; INSERT INTO w VALUES (2)");
      states.push(db.isTransaction);
      db.exec("ROLLBACK TO s; RELEASE s; COMMIT");
      states.push(db.isTransaction);
      const statement = db.prepare("SELECT 1 AS one");
      db.close();
      return { states, open: db.isOpen, closed: outcome(() => db.exec("SELECT 1")), transaction: outcome(() => db.isTransaction),
        stale: outcome(() => statement.get()), again: outcome(() => db.close()) };
    });
    expect(seen[1]).toEqual(seen[0]);
  });

  it("binds an iteration at once, reads it lazily, and invalidates it when its statement runs again", () => {
    const seen = hosts().map(([, db]) => {
      db.exec("CREATE TABLE v (n INTEGER, b BLOB); INSERT INTO v VALUES (1, x'01'), (2, x'02'), (3, x'03')");
      const statement = db.prepare("SELECT n FROM v WHERE b >= ? ORDER BY n");
      const bound = new Uint8Array([2]), early = statement.iterate(bound);
      bound[0] = 1;
      const first = [early.next(), early.next(), early.next()];
      const stopped = statement.iterate(Uint8Array.of(1));
      const head = stopped.next();
      stopped.return?.(undefined);
      const after = statement.all(Uint8Array.of(3));
      const running = statement.iterate(Uint8Array.of(1));
      const one = running.next();
      const other = statement.get(Uint8Array.of(2));
      const invalidated = outcome(() => running.next());
      const fresh = [...statement.iterate(Uint8Array.of(1))];
      return { first, head, after, one, other, invalidated, fresh };
    });
    expect(seen[1]).toEqual(seen[0]);
  });

  it("steps a run once, as node:sqlite does, so a later row's failure is not reached", () => {
    const seen = hosts().map(([, db]) => outcome(() => db.prepare("SELECT 1 AS x UNION ALL SELECT 9223372036854775807 + 1").run()));
    expect(seen[1]).toEqual(seen[0]);
  });

  it("returns run's counts as numbers, or bigints when reading bigints", () => {
    const counts = hosts().map(([, db]) => {
      db.exec("CREATE TABLE r (n INTEGER PRIMARY KEY)");
      const plain = db.prepare("INSERT INTO r VALUES (NULL)").run();
      const big = db.prepare("INSERT INTO r VALUES (NULL)");
      big.setReadBigInts(true);
      return [plain, big.run(), db.prepare("DELETE FROM r").run()];
    });
    expect(counts[1]).toEqual(counts[0]);
  });
});

describe("the browser host's database files", () => {
  it("opens memory and the anonymous temporary database, and refuses a path as SQLite refuses a file it cannot open", () => {
    expect(new BrowserDatabase(":memory:").isOpen).toBe(true);
    expect(new BrowserDatabase("").isOpen).toBe(true);
    expect(() => new BrowserDatabase("wallet.db")).toThrow(expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 14, message: "a browser host keeps no database files: wallet.db" }));
  });

  it("finalizes a statement no wrapper reaches, as node:sqlite does, so a walk's prepares do not accumulate", async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void, turn = () => new Promise(resolve => setTimeout(resolve, 0));
    const db = new BrowserDatabase(":memory:");
    // SQLite's own count of the connection's prepared statements (the WebAssembly build has the sqlite_stmt table).
    const live = (): number => (db.prepare("SELECT count(*) AS c FROM sqlite_stmt").get() as { c: number }).c;
    const kept = db.prepare("SELECT 7 AS seven");
    for (let i = 0; i < 5000; i++) db.prepare("SELECT ? AS x").get(i);
    expect(live()).toBeGreaterThan(1000);
    for (let round = 0; round < 10 && live() > 10; round++) { gc(); await turn(); }
    expect(live()).toBeLessThan(10);
    expect(kept.get()).toEqual({ seven: 7 });
    db.close();
    expect(() => kept.get()).toThrow(expect.objectContaining({ code: "ERR_INVALID_STATE", message: "statement has been finalized" }));
  });

  it.runIf(BROWSER_HOST)("refuses a kept replay file and a retained evidence file visibly, never as damage to discard", () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-host-"));
    try {
      expect(() => new ReplayStore(join(dir, "kept.db"), { digest: join(dir, "kept.sha256") })).toThrow(expect.objectContaining({ errcode: 14 }));
      expect(() => new EvidenceStore(join(dir, "evidence.db"))).toThrow(expect.objectContaining({ errcode: 14 }));
      expect(new ReplayStore().close()).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe.skipIf(BROWSER_HOST)("the browser host's node:crypto against node:crypto", () => {
  const key = Uint8Array.from({ length: 32 }, (_, i) => i), nonce = new Uint8Array(12).fill(7), aad = new TextEncoder().encode("aad");

  it("hashes, authenticates and derives as node:crypto does", () => {
    for (const data of [new Uint8Array(0), new TextEncoder().encode("abc"), new Uint8Array(1000).fill(9)]) {
      expect(browserCrypto.createHash("sha256").update(data).update("tail").digest("hex"))
        .toBe(nodeCrypto.createHash("sha256").update(data).update("tail").digest("hex"));
      expect(new Uint8Array(browserCrypto.createHash("sha256").update(data).digest() as Buffer)).toEqual(new Uint8Array(nodeCrypto.createHash("sha256").update(data).digest()));
      expect(browserCrypto.hash("sha256", data, "buffer")).toEqual(nodeCrypto.hash("sha256", data, "buffer"));
      expect(new Uint8Array(browserCrypto.createHmac("sha256", key).update(data).digest() as Buffer)).toEqual(new Uint8Array(nodeCrypto.createHmac("sha256", key).update(data).digest()));
      expect(new Uint8Array(browserCrypto.hkdfSync("sha256", key, data, aad, 32))).toEqual(new Uint8Array(nodeCrypto.hkdfSync("sha256", key, data, aad, 32)));
    }
    expect(() => browserCrypto.createHash("sha512")).toThrow(/no sha512 hash/);
  });

  it("seals and opens AES-256-GCM as node:crypto does, and fails a tampered capsule at final", () => {
    for (const plaintext of [new Uint8Array(0), new Uint8Array(72).fill(3)]) {
      const theirs = nodeCrypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      theirs.setAAD(aad);
      const expected = Buffer.concat([theirs.update(plaintext), theirs.final(), theirs.getAuthTag()]);
      const ours = browserCrypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      ours.setAAD(aad);
      expect(Buffer.concat([ours.update(plaintext), ours.final(), ours.getAuthTag()])).toEqual(expected);
      const opened = browserCrypto.createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      opened.setAAD(aad); opened.setAuthTag(expected.subarray(expected.length - 16));
      expect(Buffer.concat([opened.update(expected.subarray(0, expected.length - 16)), opened.final()])).toEqual(Buffer.from(plaintext));
      const tampered = Uint8Array.from(expected); tampered[0]! ^= 1;
      const refused = browserCrypto.createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      refused.setAAD(aad); refused.setAuthTag(tampered.subarray(tampered.length - 16));
      expect(refused.update(tampered.subarray(0, tampered.length - 16)).length).toBe(0);
      expect(() => refused.final()).toThrow("Unsupported state or unable to authenticate data");
    }
    const once = browserCrypto.createCipheriv("aes-256-gcm", key, nonce);
    once.update(new Uint8Array(1));
    expect(() => once.update(new Uint8Array(1))).toThrow(/second AES-GCM update/);
  });

  it("draws random bytes and integers in range, and compares in constant time as node:crypto does", () => {
    expect(browserCrypto.randomBytes(32)).toHaveLength(32);
    for (let i = 0; i < 200; i++) { const n = browserCrypto.randomInt(3, 10); expect(n >= 3 && n < 10).toBe(true); }
    expect(() => browserCrypto.randomInt(2 ** 49)).toThrow(RangeError);
    expect(browserCrypto.randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(browserCrypto.timingSafeEqual(key, Uint8Array.from(key))).toBe(true);
    expect(() => browserCrypto.timingSafeEqual(key, key.subarray(1))).toThrow(expect.objectContaining({ code: "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH" }));
  });
});

describe("the browser host's file system, paths and URLs", () => {
  it("has no files: nothing exists, and every other call fails as a system call the system lacks", () => {
    expect(browserFs.existsSync("/any")).toBe(false);
    expect(() => browserFs.statSync("/any")).toThrow(expect.objectContaining({ code: "ENOSYS", syscall: "stat" }));
    expect(() => browserFs.readFileSync("/any")).toThrow(expect.objectContaining({ code: "ENOSYS", syscall: "open" }));
    expect(() => browserFs.readFileSync(new URL("file:///any"))).toThrow(expect.objectContaining({ code: "ENOSYS" }));
  });

  it("composes POSIX names as node:path does", () => {
    for (const parts of [["a", "b"], ["/a", "../b", "./c"], ["a/", "", "b//c/"], ["..", "a"], [""]]) expect(browserPath.join(...parts)).toBe(posix.join(...parts));
    for (const path of ["/a/b/c", "/a", "a", "a/b/", "/"]) {
      expect(browserPath.dirname(path)).toBe(posix.dirname(path));
      expect(browserPath.basename(path)).toBe(posix.basename(path));
    }
    expect(browserPath.basename("x.db.lock", ".lock")).toBe(posix.basename("x.db.lock", ".lock"));
    expect(browserPath.resolve("/a/b", "../c", "d")).toBe(posix.resolve("/a/b", "../c", "d"));
    expect(browserPath.relative("/a/b/c", "/a/d")).toBe(posix.relative("/a/b/c", "/a/d"));
    expect(fileURLToPath("file:///a/b%20c")).toBe("/a/b c");
    expect(() => fileURLToPath("https://example.org/a")).toThrow(expect.objectContaining({ code: "ERR_INVALID_URL_SCHEME" }));
  });
});
