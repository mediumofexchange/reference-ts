// The release record (slice 13 M13a): the package's tarball and the install that pins every dependency to the tree this
// checkout tested. `packRelease` packs the built package into a directory and writes beside it a package.json and a
// package-lock.json naming the tarball and, by integrity, each runtime entry of this checkout's lockfile at the place
// it holds there; `npm ci` in that directory installs exactly that tree or refuses. A consumer resolving the package's
// ranges itself installs whatever the registry holds that day (2026-10-07: `pako` 3.0.2 under noir_js, tested 3.0.1),
// and a shipped shrinkwrap did not pin a tarball install (npm 11.19), so the pin travels as this install lock instead.
// The record names the tarball's bytes, the lock, the toolchain and the specification pins the shipped build carries;
// two systems building one commit must record the same tarball and lock (`--compare`).
//
// Usage: node scripts/release.mjs --compare <release-record.json> <release-record.json>
//        (packRelease is called by check-package.mjs and the pool-v3 command drill)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/** npm with `args` in `cwd`, through the npm running this script where there is one. */
function npm(args, cwd) {
  const execpath = process.env.npm_execpath;
  const result = execpath === undefined
    ? spawnSync("npm", args, { cwd, encoding: "utf8", windowsHide: true, shell: process.platform === "win32", timeout: 300_000 })
    : spawnSync(process.execPath, [execpath, ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 300_000 });
  assert.equal(result.status, 0, `npm ${args.join(" ")}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

/** The consumer lock for `tarball`: the checkout's own lock reduced to the package's runtime tree, each entry kept
 * at its path (the package's dependencies sit where they sat beside it), and the package itself as the file. */
export function installLock(lock, manifest, tarball, integrity) {
  assert.equal(lock.lockfileVersion, 3, "the checkout's lockfile is version 3");
  const own = lock.packages[""];
  assert.deepEqual(own.dependencies, manifest.dependencies, "the lockfile was made from this package.json");
  const packages = {
    "": { name: "moe-release", dependencies: { [manifest.name]: `file:${tarball}` } },
    [`node_modules/${manifest.name}`]: { version: manifest.version, resolved: `file:${tarball}`, integrity,
      license: own.license, dependencies: own.dependencies, bin: own.bin, engines: own.engines },
  };
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "" || entry.dev) continue;
    assert(path.startsWith("node_modules/") && !entry.link && !entry.devOptional && entry.integrity !== undefined
      && entry.resolved?.startsWith("https://registry.npmjs.org/"), `runtime entry ${path} is a registry package with integrity`);
    packages[path] = entry;
  }
  return { name: "moe-release", lockfileVersion: 3, requires: true, packages };
}

/** Packs the checkout's built package into `directory` (new or empty), installs it there from the install lock with
 * `npm ci`, checks the installed tree against the lock and writes `release-record.json`. Returns the record, the
 * tarball's file list and the installed `moe` bin. */
export function packRelease(directory) {
  assert.deepEqual(readdirSync(directory), [], "the release directory starts empty");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lockText = readFileSync(join(root, "package-lock.json"));
  const [packed] = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", directory], root));
  const bytes = readFileSync(join(directory, packed.filename));
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(integrity, packed.integrity, "npm and this script read one tarball");
  const lock = installLock(JSON.parse(lockText.toString("utf8")), manifest, packed.filename, integrity);
  const lockOut = `${JSON.stringify(lock, null, 2)}\n`, manifestOut = `${JSON.stringify(lock.packages[""], null, 2)}\n`;
  writeFileSync(join(directory, "package.json"), manifestOut);
  writeFileSync(join(directory, "package-lock.json"), lockOut);
  npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], directory);
  // What npm ci placed, by its own record: every lock entry this system takes, at its version and integrity, and
  // nothing else (an optional entry for another system is absent).
  const installed = JSON.parse(readFileSync(join(directory, "node_modules", ".package-lock.json"), "utf8")).packages;
  for (const [path, entry] of Object.entries(installed)) {
    const pinned = lock.packages[path];
    assert(pinned !== undefined && pinned.version === entry.version && pinned.integrity === entry.integrity,
      `installed ${path} ${entry.version} is not the pinned entry`);
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path !== "" && !entry.optional) assert(installed[path] !== undefined, `pinned ${path} was not installed`);
  }
  const shipped = join(directory, "node_modules", ...manifest.name.split("/"));
  const record = {
    package: manifest.name,
    version: manifest.version,
    tarball: { file: packed.filename, bytes: bytes.length, entries: packed.entryCount, sha256: sha256(bytes), integrity },
    installLock: { sha256: sha256(lockOut), runtimeEntries: Object.keys(lock.packages).length - 2 },
    checkoutLock: sha256(lockText.toString("utf8").replaceAll("\r\n", "\n")),
    specification: specificationPins(shipped),
    toolchain: { node: process.version, npm: npm(["--version"], directory).trim() },
  };
  writeFileSync(join(directory, "release-record.json"), `${JSON.stringify(record, null, 2)}\n`);
  return { record, files: packed.files.map(file => file.path), bin: join(shipped, "dist", "cli", "moe.js") };
}

/** The specification revisions the shipped constructions name (`specification: "<document> <revision>"`). */
function specificationPins(shipped) {
  const pins = {};
  for (const file of ["dist/pool/v3/construction.js", "dist/lit/construction.js"]) {
    for (const [, document, revision] of readFileSync(join(shipped, file), "utf8").matchAll(/specification: "([a-z0-9-]+) ([0-9a-f]{7,40})"/g)) {
      assert(pins[document] === undefined || pins[document] === revision, `one revision for ${document}`);
      pins[document] = revision;
    }
  }
  assert.deepEqual(Object.keys(pins).sort(), ["lit-v1", "pool-v3"], "the shipped constructions name their specifications");
  return pins;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  assert(args.length === 3 && args[0] === "--compare", "usage: node scripts/release.mjs --compare <record> <record>");
  const [a, b] = args.slice(1).map(file => JSON.parse(readFileSync(file, "utf8")));
  for (const field of ["package", "version", "tarball", "installLock", "checkoutLock", "specification"]) {
    assert.deepEqual(a[field], b[field], `the two builds differ in ${field}`);
  }
  console.log(`One release on both systems: ${a.tarball.file} ${a.tarball.integrity}, install lock ${a.installLock.sha256}`);
}
