// Builds the exhaustion circuits (succinct-read §4.3) from exhaustion-sources.mjs under the pinned compiler, and
// derives gate counts and keys on bb.js's bundled native `bb` under pool-v3 §4's target. A library for
// exhaustion-check.mjs and a command:
//
//   node scripts/venue/exhaustion-build.mjs <CT> <CM> <E> [--keys] [--gates] [--dir <scratch directory>]
//
// It writes each circuit's project, `program.json` and (with --keys) its key under the directory (default
// scratch/exhaustion/<CT>-<CM>-<E>), the node and folds generated from the leaves' key hashes, and prints a summary.
// Keys need the leading G1 points in CRS_PATH (default scratch/exhaustion-crs, prepared by exhaustion-crs.mjs).
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { compile_program, createFileManager } from "@noir-lang/noir_wasm";
import { foldFirst, foldNext, leafM, leafT, leafU, node } from "./exhaustion-sources.mjs";

export const root = path.resolve(import.meta.dirname, "../..");
const shared = path.join(import.meta.dirname, "exhaustion-circuits");
const sponge = path.join(root, "src/pool/circuits/vendor/poseidon2.nr");
export const BB = path.join(root, `node_modules/@aztec/bb.js/build/${process.arch === "arm64" ? "arm64" : "amd64"}-${process.platform === "darwin" ? "macos" : "linux"}/bb`);
export const CRS = process.env.CRS_PATH ?? path.join(root, "scratch/exhaustion-crs");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

/** Compile `main` with the shared modules into `directory/name`; returns the program (warnings refused). The pinned
 * compiler is noir_wasm; at the leaves' full size it exceeds WebAssembly's memory, so NARGO may name the native nargo
 * of the same version, whose bytecode equals noir_wasm's (exhaustion-check.mjs compares them at small sizes). */
export async function compile(directory, name, main) {
  const project = path.join(directory, name);
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "Nargo.toml"), `[package]\nname = "moe_succinct_exhaustion_${name.replaceAll("-", "_")}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
  writeFileSync(path.join(project, "src/main.nr"), main);
  for (const file of ["exhaustion.nr", "blake2b.nr"]) copyFileSync(path.join(shared, file), path.join(project, "src", file));
  copyFileSync(sponge, path.join(project, "src/poseidon2.nr"));
  let program;
  if (process.env.NARGO) {
    const version = execFileSync(process.env.NARGO, ["--version"], { encoding: "utf8" });
    if (!version.includes("noirc version = 1.0.0-beta.26+")) throw new Error(`${name}: NARGO is not the pinned compiler's version`);
    const run = spawnSync(process.env.NARGO, ["compile", "--program-dir", project], { encoding: "utf8", maxBuffer: 1 << 26 });
    const out = `${run.stdout}${run.stderr}`;
    if (run.status !== 0) throw new Error(`${name}: nargo failed: ${out.slice(0, 2000)}`);
    if (/warning/i.test(out)) throw new Error(`${name}: compiler warnings require review: ${out.slice(0, 2000)}`);
    program = JSON.parse(readFileSync(path.join(project, "target", `moe_succinct_exhaustion_${name.replaceAll("-", "_")}.json`), "utf8"));
  } else {
    const compiled = await compile_program(createFileManager(project), undefined, () => {}, () => {});
    if (compiled.warnings.length) throw new Error(`${name}: compiler warnings require review: ${JSON.stringify(compiled.warnings).slice(0, 2000)}`);
    program = compiled.program;
  }
  writeFileSync(path.join(project, "program.json"), JSON.stringify(program));
  return program;
}
export function gates(directory, name) {
  const out = JSON.parse(execFileSync(BB, ["gates", "-b", path.join(directory, name, "program.json")], { encoding: "utf8", maxBuffer: 1 << 26 }));
  return out.functions[0].circuit_size;
}
/** The circuit's key under pool-v3 §4's target: its fields and hash. */
export function key(directory, name) {
  const project = path.join(directory, name);
  mkdirSync(path.join(project, "vk"), { recursive: true });
  execFileSync(BB, ["write_vk", "-b", path.join(project, "program.json"), "-o", path.join(project, "vk"), "-t", "noir-recursive"],
    { env: { ...process.env, CRS_PATH: CRS }, stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 26 });
  const bytes = readFileSync(path.join(project, "vk/vk"));
  const hash = "0x" + readFileSync(path.join(project, "vk/vk_hash")).toString("hex");
  if (bytes.length !== 115 * 32) throw new Error(`${name}: a key of ${bytes.length} bytes`);
  const fields = Array.from({ length: 115 }, (_, i) => "0x" + bytes.subarray(32 * i, 32 * i + 32).toString("hex"));
  return { fields, hash, sha256: sha(bytes) };
}

/** Build every circuit at the given leaf sizes: the three leaves, then (with keys) the node and the folds. */
export async function build({ CT, CM, E }, { keys = false, withGates = false, directory, emptyRoot, log = console.log } = {}) {
  directory ??= path.join(root, "scratch/exhaustion", `${CT}-${CM}-${E}`);
  mkdirSync(directory, { recursive: true });
  directory = realpathSync(directory);
  const result = { directory, circuits: {} };
  const one = async (name, main) => {
    const started = Date.now();
    const program = await compile(directory, name, main);
    const entry = { compileSeconds: (Date.now() - started) / 1000, bytecodeSha256: sha(Buffer.from(program.bytecode, "base64")) };
    if (withGates) entry.gates = gates(directory, name);
    if (keys) Object.assign(entry, key(directory, name));
    result.circuits[name] = entry;
    log(`${name}: ${JSON.stringify({ ...entry, fields: undefined })}`);
    return entry;
  };
  const t = await one("leaf-t", leafT(CT)), m = await one("leaf-m", leafM(CM)), u = await one("leaf-u", leafU(E));
  if (!keys) return result;
  const n = await one("node", node({ t: t.hash, m: m.hash, u: u.hash }));
  const leafKeys = { t: t.hash, m: m.hash, u: u.hash, n: n.hash };
  const first = await one("fold-first", foldFirst(leafKeys, emptyRoot));
  await one("fold-next", foldNext(leafKeys, first.hash));
  return result;
}

if (process.argv[1] === import.meta.filename) {
  const argv = process.argv.slice(2);
  const [CT, CM, E] = argv.slice(0, 3).map(Number);
  const { EMPTY_SUBTREES } = await import("../../dist/ergo-exhaustion.js");
  const directory = argv.includes("--dir") ? path.resolve(argv[argv.indexOf("--dir") + 1]) : undefined;
  if (argv.includes("--keys") && !existsSync(path.join(CRS, "bn254_g1.dat"))) throw new Error(`no points in ${CRS}`);
  const result = await build({ CT, CM, E }, { keys: argv.includes("--keys"), withGates: argv.includes("--gates"), directory,
    emptyRoot: "0x" + EMPTY_SUBTREES[32].toString(16).padStart(64, "0") });
  writeFileSync(path.join(result.directory, "build.json"), JSON.stringify(result, null, 2));
}

/** The specification revision these circuits implement (succinct-read §§2, 4.3; its internal tags). */
export const EXHAUSTION_SPECIFICATION = "succinct-read 282c925";
/** SHA-256 of every source a report's verdict depends on, LF-normalised, by repository path. */
export function sourceHashes() {
  const files = ["scripts/venue/exhaustion-build.mjs", "scripts/venue/exhaustion-sources.mjs", "scripts/venue/exhaustion-periods.mjs",
    "scripts/venue/exhaustion-check.mjs", "scripts/venue/exhaustion-prove.mjs", "scripts/venue/exhaustion-circuits/exhaustion.nr",
    "scripts/venue/exhaustion-circuits/blake2b.nr", "src/pool/circuits/vendor/poseidon2.nr", "src/ergo-exhaustion-prover.ts", "src/ergo-exhaustion.ts",
    "src/ergo-scan.ts", "src/ergo-synthetic.ts", "src/ergo-profile.ts", "src/pool/poseidon2.ts", "src/pool/proof-verifier.ts"];
  return Object.fromEntries(files.map(file => [file, sha(Buffer.from(readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n"), "utf8"))]));
}
