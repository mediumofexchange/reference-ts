// The browser bundle (slice 39): the library's holder read path (src/browser/holder.ts) for a browser engine's worker,
// built by esbuild with src/browser/'s modules in place of node:sqlite, node:crypto, node:fs, node:path, node:url and
// node:module, and `Buffer` from the `buffer` package. A Node built-in the bundle reaches beyond those is a build
// failure, so nothing Node-only enters a browser build unseen.
//
// The bundle's code name (MOE_BROWSER_CODE, reader.ts `codeName`) is SHA-256 over every source file it holds, by path
// and content, so kept classes a later version reads are discarded as the Node path's are.
//
// Usage: node scripts/browser/build.mjs [--out <directory>]   (default dist-browser/)
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

export const root = resolve(import.meta.dirname, "../..");
const own = path => join(root, path);
const require = createRequire(import.meta.url);

/** The Node built-ins the browser host replaces, by the module that replaces each. */
export const SUBSTITUTES = Object.freeze({
  "node:sqlite": own("src/browser/node-sqlite.ts"),
  "node:crypto": own("src/browser/node-crypto.ts"),
  "node:fs": own("src/browser/node-fs.ts"),
  "node:fs/promises": own("src/browser/node-fs-promises.ts"),
  "node:os": own("src/browser/node-os.ts"),
  "node:path": own("src/browser/node-path.ts"),
  "node:url": own("src/browser/node-url.ts"),
  "node:module": own("src/browser/node-module.ts"),
});

/** The package's own files a bundle reads beside itself (programs.ts, check-set.ts, ergo-exhaustion-set.ts), SQLite's binary and the witness
 * generator's two (noir_js's browser build loads them beside the module that asks). */
export const ASSETS = Object.freeze([
  own("src/pool/v3/programs.json"),
  own("src/pool/v3/check-set.json"),
  own("src/pool/v3/check-set-programs.json"),
  own("src/exhaustion-set.json"),
  join(dirname(require.resolve("@sqlite.org/sqlite-wasm/package.json")), "dist/sqlite3.wasm"),
  join(dirname(require.resolve("@noir-lang/acvm_js/package.json")), "web/acvm_js_bg.wasm"),
  join(dirname(require.resolve("@noir-lang/noirc_abi/package.json")), "web/noirc_abi_wasm_bg.wasm"),
]);

/** The holder's page (slice 41), copied beside the bundle: it reads nothing the library verifies, so it names no code. */
export const PAGES = Object.freeze([own("src/browser/wallet.html")]);

/** Barretenberg's browser build starts its own workers from these modules, beside the module that starts them: a
 * bundle carries them beside itself under the names it asks for. */
const bbBrowser = join(dirname(require.resolve("@aztec/bb.js")), "../browser/barretenberg_wasm");
export const BB_WORKERS = Object.freeze([
  { in: join(bbBrowser, "barretenberg_wasm_main/factory/browser/main.worker.js"), out: "main.worker" },
  { in: join(bbBrowser, "barretenberg_wasm_thread/factory/browser/thread.worker.js"), out: "thread.worker" },
]);

/** The bundle's entries: the holder's read path (slice 39) and one wallet command a worker (slice 41). */
export const ENTRIES = Object.freeze([
  { in: own("src/browser/holder.ts"), out: "holder" },
  { in: own("src/browser/command.ts"), out: "command" },
]);

const substitution = {
  name: "browser-host",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, args => {
      const path = SUBSTITUTES[args.path];
      return path === undefined
        ? { errors: [{ text: `${args.path} has no browser substitute (imported by ${relative(root, args.importer)})` }] }
        : { path };
    });
  },
};

const options = (entryPoints, define, extra) => ({
  entryPoints, bundle: true, format: "esm", platform: "browser", target: "es2022", splitting: false,
  conditions: ["browser"], mainFields: ["browser", "module", "main"], logLevel: "silent", metafile: true,
  // A caller's plugins first, so a test bundle may resolve a test-only module before the substitution refuses it.
  inject: [own("src/browser/globals.ts")], plugins: [...(extra ?? []), substitution],
  // A browser has no process: its platform reads as "browser" (file-identity.ts), and no process id names a file. The
  // members a command reaches are globals.ts' `moeProcess`'s (slice 41), and `process` itself stays undefined.
  define: { MOE_BROWSER_CODE: JSON.stringify(define), "process.platform": "\"browser\"", "process.pid": "0",
    ...Object.fromEntries(["env", "stdout", "stderr", "stdin", "umask"].map(name => [`process.${name}`, `moeProcess.${name}`])) },
  // The package's own assets and SQLite's binary are read beside the bundle at run time, never inlined.
  loader: { ".wasm": "file", ".json": "json" },
});

/** SHA-256 over what makes a build: the bundler's version and options, every source it holds by repository path and
 * content, and the assets copied beside it, each part framed by its length. */
function codeName(metafile, settings) {
  const hash = createHash("sha256").update("moe-browser-code");
  const add = part => { const bytes = typeof part === "string" ? Buffer.from(part) : part; hash.update(`${bytes.length}:`).update(bytes); };
  add(esbuild.version);
  // Paths by repository path, so the same sources name the same code wherever they are checked out.
  const portable = value => typeof value === "string" && resolve(value) === value ? relative(root, value).split(sep).join("/") : value;
  add(JSON.stringify(settings, (key, value) => key === "plugins" ? value.map(plugin => plugin.name) : portable(value)));
  for (const input of Object.keys(metafile.inputs).sort()) { add(input.split(sep).join("/")); add(readFileSync(resolve(root, input))); }
  for (const asset of ASSETS) { add(relative(root, asset).split(sep).join("/")); add(readFileSync(asset)); }
  return hash.digest("hex");
}

/** A directory this script may fill, emptying it first: absent, empty, or holding its marker. */
const MARKER = ".moe-browser-build";
function claim(outdir) {
  if (existsSync(outdir) && readdirSync(outdir).length > 0 && !existsSync(join(outdir, MARKER))) {
    throw new Error(`browser build: ${outdir} holds files this build did not make; name an empty or new directory`);
  }
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  writeFileSync(join(outdir, MARKER), "made by scripts/browser/build.mjs; emptied by its next build\n");
}

/**
 * Build `entries` ({ in, out } each) into `outdir` with the substitutes, the code name, Barretenberg's workers and
 * the assets beside them. `extra` adds esbuild plugins (the in-browser suites' vitest runner). Returns the code name
 * and the output files.
 */
export async function bundle(entries, outdir, extra) {
  const entryPoints = [...entries, ...BB_WORKERS];
  const settings = options(entryPoints, "0".repeat(64), extra);
  const first = await esbuild.build({ ...settings, absWorkingDir: root, write: false, outdir });
  const code = codeName(first.metafile, settings);
  claim(outdir);
  const result = await esbuild.build({ ...options(entryPoints, code, extra), absWorkingDir: root, write: true, outdir });
  for (const asset of [...ASSETS, ...PAGES]) copyFileSync(asset, join(outdir, asset.split(sep).pop().split("/").pop()));
  return { code, outputs: Object.keys(result.metafile.outputs) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const at = process.argv.indexOf("--out"), outdir = at > 0 ? resolve(process.argv[at + 1]) : own("dist-browser");
  const { code, outputs } = await bundle(ENTRIES, outdir);
  console.log(JSON.stringify({ code, outputs: outputs.map(path => relative(root, resolve(root, path)).split(sep).join("/")) }));
}
