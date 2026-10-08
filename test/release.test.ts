import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The release record's install checks (scripts/release.mjs, slice 13 M13a): `--verify` binds an install to a record
// and to this checkout's lockfile, `verifyInstall` to npm's record of what it placed, `--compare` to clean records.

const release: {
  installLock(lock: unknown, manifest: unknown, tarball: string, integrity: string): { packages: Record<string, unknown> };
  verifyInstall(directory: string): void;
  verifyRelease(directory: string, record: unknown): void;
} = await import(pathToFileURL(resolve("scripts/release.mjs")).href);

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sha512 = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const checkoutLock = readFileSync("package-lock.json", "utf8"), manifest = JSON.parse(readFileSync("package.json", "utf8"));
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const file = "mediumofexchange-reference-0.1.0.tgz";

const directories: string[] = [];
afterEach(() => { for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });
function directory() {
  mkdirSync("scratch", { recursive: true });
  const d = mkdtempSync(join(resolve("scratch"), "release-test-")); directories.push(d); return d;
}
/** A directory holding `tarball` and `lock`, and a record naming them as `record` overrides. */
function install(tarball: Uint8Array, lock: string, record: object = {}) {
  const d = directory();
  writeFileSync(join(d, file), tarball); writeFileSync(join(d, "package-lock.json"), lock);
  return { d, record: { source: { commit: head, clean: true }, checkoutLock: sha256(checkoutLock.replaceAll("\r\n", "\n")),
    tarball: { file, sha256: sha256(tarball), integrity: sha512(tarball) }, installLock: { sha256: sha256(lock) }, ...record } };
}
const lockFor = (integrity: string) => `${JSON.stringify(release.installLock(JSON.parse(checkoutLock), manifest, file, integrity), null, 2)}\n`;

describe("release install checks", () => {
  it("refuses an install whose lock its own tarball names but this checkout's lockfile does not give", () => {
    const tarball = new Uint8Array([1, 2, 3]), integrity = sha512(tarball);
    // Self-consistent: the lock names the tarball by its integrity and pins nothing else, and the record names both.
    const own = `${JSON.stringify({ name: "moe-release", lockfileVersion: 3, requires: true, packages: {
      "": { name: "moe-release", dependencies: { [manifest.name]: `file:${file}` } },
      [`node_modules/${manifest.name}`]: { version: manifest.version, resolved: `file:${file}`, integrity } } }, null, 2)}\n`;
    const { d, record } = install(tarball, own);
    expect(() => release.verifyRelease(d, record)).toThrow("the install lock is the record's, from this checkout's lockfile");
  });

  it("refuses a tarball other than the record's, a record of another commit or of a tree with changes", () => {
    const tarball = new Uint8Array([4, 5, 6]), lock = lockFor(sha512(tarball));
    const other = install(tarball, lock, { tarball: { file, sha256: "f".repeat(64), integrity: sha512(tarball) } });
    expect(() => release.verifyRelease(other.d, other.record)).toThrow("the tarball has the record's bytes");
    const moved = install(tarball, lock, { source: { commit: "a".repeat(40), clean: true } });
    expect(() => release.verifyRelease(moved.d, moved.record)).toThrow("the record names this checkout's commit, built from a clean tree");
    const dirty = install(tarball, lock, { source: { commit: head, clean: false } });
    expect(() => release.verifyRelease(dirty.d, dirty.record)).toThrow("the record names this checkout's commit, built from a clean tree");
    const relocked = install(tarball, lock, { checkoutLock: "0".repeat(64) });
    expect(() => release.verifyRelease(relocked.d, relocked.record)).toThrow("the record names this checkout's lockfile");
  });

  it("refuses an install that dropped an optional entry for this system or placed another entry's bytes", () => {
    const d = directory(), pinned = { version: "1.0.0", integrity: "sha512-a" };
    writeFileSync(join(d, "package-lock.json"), JSON.stringify({ packages: { "": {}, "node_modules/kept": pinned,
      "node_modules/native": { ...pinned, optional: true, os: [process.platform], cpu: [process.arch] },
      "node_modules/elsewhere": { ...pinned, optional: true, os: ["!" + process.platform] } } }));
    const placed = (packages: object) => {
      mkdirSync(join(d, "node_modules"), { recursive: true });
      writeFileSync(join(d, "node_modules", ".package-lock.json"), JSON.stringify({ packages }));
    };
    placed({ "node_modules/kept": pinned });
    expect(() => release.verifyInstall(d)).toThrow("pinned node_modules/native was not installed");
    placed({ "node_modules/kept": pinned, "node_modules/native": { ...pinned, integrity: "sha512-b" } });
    expect(() => release.verifyInstall(d)).toThrow("installed node_modules/native 1.0.0 is not the pinned entry");
    placed({ "node_modules/kept": pinned, "node_modules/native": pinned });
    expect(() => release.verifyInstall(d)).not.toThrow();
  });

  it("compares only records of a clean tree's fresh build", () => {
    const d = directory(), record = (clean: boolean) => ({ package: manifest.name, version: manifest.version, source: { commit: head, clean },
      tarball: {}, installLock: {}, checkoutLock: "", specification: {}, toolchain: {} });
    writeFileSync(join(d, "a.json"), JSON.stringify(record(false))); writeFileSync(join(d, "b.json"), JSON.stringify(record(false)));
    const dirty = spawnSync(process.execPath, ["scripts/release.mjs", "--compare", join(d, "a.json"), join(d, "b.json")], { encoding: "utf8" });
    expect(dirty.status).not.toBe(0);
    expect(dirty.stderr).toContain("both records are of a clean tree's fresh build");
    writeFileSync(join(d, "a.json"), JSON.stringify(record(true))); writeFileSync(join(d, "b.json"), JSON.stringify(record(true)));
    const clean = spawnSync(process.execPath, ["scripts/release.mjs", "--compare", join(d, "a.json"), join(d, "b.json")], { encoding: "utf8" });
    expect(clean.status, clean.stderr).toBe(0);
  });
});
