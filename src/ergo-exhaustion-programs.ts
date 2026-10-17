// The exhaustion circuits' programs for a prover (succinct-read §§4.3, 6; slice 43). Each leaf's program is tens of
// megabytes, so the package ships the circuits' sources (`exhaustion-circuits/`: each circuit's generated `main.nr`,
// the shared modules and the vendored sponge) rather than their programs; a prover compiles them once with the pinned
// native compiler (`nargo`, whose WebAssembly build runs out of memory at the leaves' size) into a directory of its own
// and runs a program only where its bytecode is the manifest's (`EXHAUSTION_SET_MANIFEST`). The keys are the shipped,
// pinned ones: a prover derives none, and a program whose key differed would make proofs that do not verify under them,
// which the pool refuses before keeping any.
//
// Witnesses are computed by the same compiler (`nargo execute`) over each circuit's kept crate, whose compiled program
// it reuses: in a process of its own, so a replica's listener and rounds go on while a leaf's witness is computed (noir_js
// held the event loop for the whole witness), and in about half noir_js' time, byte for byte the same witness.
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { EXHAUSTION_CIRCUITS, EXHAUSTION_SET_MANIFEST, exhaustionKeys, ExhaustionSetError, type BuiltCircuit, type ExhaustionCircuit,
  type ExhaustionCircuits } from "./ergo-exhaustion-set.js";
import type { CircuitInputs, ExhaustionWitness } from "./ergo-exhaustion-pool.js";
import type { CompiledProgram } from "./pool/proof-verifier.js";

/** The shipped sources, beside this module, and the vendored sponge they share. */
const SOURCES = fileURLToPath(new URL("./exhaustion-circuits/", import.meta.url));
const SPONGE = fileURLToPath(new URL("./pool/circuits/vendor/poseidon2.nr", import.meta.url));
/** Where each shared module is read from. */
const SHARED_SOURCES: Readonly<Record<string, string>> = Object.freeze({ "exhaustion.nr": join(SOURCES, "exhaustion.nr"),
  "blake2b.nr": join(SOURCES, "blake2b.nr"), "poseidon2.nr": SPONGE });
/** A circuit's crate name, as the build names it. */
export const crateName = (name: ExhaustionCircuit): string => `moe_succinct_exhaustion_${name.replaceAll("-", "_")}`;
const manifestOf = (name: ExhaustionCircuit): string => `[package]\nname = "${crateName(name)}"\ntype = "bin"\nauthors = []\n[dependencies]\n`;
/** A crate's files, each with the shipped bytes it must hold: its `main.nr` and the modules it reads, no other. */
const crateFiles = (name: ExhaustionCircuit): readonly (readonly [string, () => Buffer])[] => [
  ["Nargo.toml", () => Buffer.from(manifestOf(name))], [join("src", "main.nr"), () => readFileSync(join(SOURCES, `${name}.nr`))],
  ...EXHAUSTION_SET_MANIFEST.reads[name].map(file => [join("src", file), () => readFileSync(SHARED_SOURCES[file]!)] as const)];

/** The compiler is not the pinned one, or it failed or warned: a prover's setup fault. */
export class ExhaustionCompileError extends Error {
  constructor(readonly code: "COMPILER" | "COMPILE", message: string) { super(message); this.name = "ExhaustionCompileError"; }
}
/** A witness could not be computed: the inputs fail one of the circuit's checks (named where the circuit names it), or
 * the compiler did not run. */
export class ExhaustionWitnessError extends Error {
  constructor(readonly circuit: ExhaustionCircuit, message: string) { super(`${circuit}: ${message}`); this.name = "ExhaustionWitnessError"; }
}

/** The six circuits as a prover runs them, and their witnesses. */
export interface ExhaustionPrograms extends ExhaustionCircuits { readonly witness: ExhaustionWitness }

const bytecodeIdentity = (bytecode: string): string => bytesToHex(sha256(Buffer.from(bytecode, "base64")));

/** A kept crate's program, where its files are exactly the shipped ones (any other source file changes nargo's hash of
 * the program, so `nargo execute` would compile again, unchecked, at the first witness) and its program is the pinned
 * compiler's with the manifest's bytecode. */
function kept(crate: string, name: ExhaustionCircuit): CompiledProgram | undefined {
  try {
    const files = crateFiles(name);
    for (const [file, shipped] of files) if (!readFileSync(join(crate, file)).equals(shipped())) return undefined;
    const sources = files.map(([file]) => file).filter(file => file !== "Nargo.toml").map(file => file.slice(4)).sort();
    if (readdirSync(join(crate, "src")).sort().join("\n") !== sources.join("\n")) return undefined;
    const program = JSON.parse(readFileSync(join(crate, "target", `${crateName(name)}.json`), "utf8")) as
      { noir_version?: unknown; abi?: unknown; bytecode?: unknown };
    if (typeof program.bytecode !== "string" || bytecodeIdentity(program.bytecode) !== EXHAUSTION_SET_MANIFEST.circuits[name].bytecode ||
        program.noir_version !== EXHAUSTION_SET_MANIFEST.compiler.split(" ")[1] || program.abi === null || typeof program.abi !== "object") return undefined;
    return program as unknown as CompiledProgram;
  } catch { return undefined; }
}

/** A TOML key as nargo reads a parameter or field name. */
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `inputs` as a prover file for `nargo execute`: strings, booleans, safe integers, arrays and tables (structs), nested.
 * Anything else, or a string TOML cannot hold as JSON writes it (DEL, a lone surrogate), is a caller's error. */
export function proverToml(inputs: CircuitInputs): string {
  const value = (v: unknown): string => {
    if (typeof v === "string") {
      if (/[\x7f\ud800-\udfff]/.test(v)) throw new TypeError("a circuit input string TOML cannot hold");
      return JSON.stringify(v);
    }
    if (typeof v === "boolean") return String(v);
    if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
    if (Array.isArray(v)) return `[${v.map(value).join(", ")}]`;
    if (v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return `{ ${pairs(v as Record<string, unknown>).join(", ")} }`;
    throw new TypeError(`a circuit input nargo cannot read: ${typeof v}`);
  };
  const pairs = (map: Readonly<Record<string, unknown>>): string[] => Object.entries(map).map(([k, v]) => {
    if (!KEY.test(k)) throw new TypeError(`a circuit input named ${JSON.stringify(k)}`);
    return `${k} = ${value(v)}`;
  });
  return `${pairs(inputs).join("\n")}\n`;
}

const run = promisify(execFile);
/** Witnesses by `nargo execute` over each circuit's kept crate (`crates`), whose compiled program it reuses, one at a time
 * (a prover needs one witness ahead of its proof). A failed check refuses with the circuit's message for it. */
export function nargoWitness(nargo: string, crates: Readonly<Record<ExhaustionCircuit, string>>): ExhaustionWitness {
  let queue: Promise<unknown> = Promise.resolve();
  // nargo's own logging stays off: its output is read only for a refusal.
  const env = { ...process.env };
  delete env.NOIR_LOG;
  const execute = async (circuit: ExhaustionCircuit, toml: string): Promise<Uint8Array> => {
    const crate = crates[circuit], name = `witness-${randomUUID()}`;
    const prover = join(crate, `${name}.toml`), witness = join(crate, "target", `${name}.gz`);
    try {
      writeFileSync(prover, toml);
      try {
        await run(nargo, ["execute", "--program-dir", crate, "--prover-name", name, name], { maxBuffer: 1 << 26, env });
      } catch (error) {
        const { stdout, stderr, message, signal } = error as { stdout?: string; stderr?: string; message: string; signal?: string | null };
        const out = `${stderr ?? ""}${stdout ?? ""}`, failed = /Assertion failed: [^\n]*/.exec(out)?.[0];
        if (failed !== undefined) throw new ExhaustionWitnessError(circuit, failed);
        if (signal) throw new ExhaustionWitnessError(circuit, `nargo was stopped by ${signal}`);
        const first = /^error: [^\n]*/m.exec(out)?.[0] ?? (out.trim() || message).split("\n")[0]!;
        throw new ExhaustionWitnessError(circuit, `nargo failed: ${first.slice(0, 500)}`);
      }
      return new Uint8Array(readFileSync(witness));
    } finally {
      rmSync(prover, { force: true });
      rmSync(witness, { force: true });
    }
  };
  return (circuit, inputs) => {
    // The inputs are read at the call, so a refusal comes at once and a later change to them reaches no witness.
    let toml: string;
    try { toml = proverToml(inputs); } catch (error) { return Promise.reject(error); }
    const next = queue.then(() => execute(circuit, toml));
    queue = next.catch(() => {});
    return next;
  };
}

/**
 * The six circuits as a prover runs them: each circuit's crate kept in `directory/<name>/` where its files are the
 * shipped sources and its program's bytecode the manifest's, or compiled there with `nargo` (which must report the
 * manifest's compiler) and kept only where it is; with the pinned keys, the manifest's sizes and witnesses by the same
 * `nargo`. A compiled program that is not the manifest's refuses `IDENTITY`.
 */
export function exhaustionPrograms(options: { readonly nargo: string; readonly directory: string; readonly log?: (line: string) => void }): ExhaustionPrograms {
  const { nargo, directory, log } = options, keys = exhaustionKeys();
  mkdirSync(directory, { recursive: true });
  // What a compile or a witness stopped part-way left (a crate not yet renamed into place, a prover file, a witness) is
  // never read; it goes, as do the programs an earlier layout kept beside the crates.
  for (const name of readdirSync(directory)) {
    if (/^build-|\.tmp$|\.json$/.test(name)) rmSync(join(directory, name), { recursive: true, force: true });
  }
  // nargo runs at every witness, so it must be the pinned compiler whether or not a crate is compiled here.
  let version: string;
  try { version = execFileSync(nargo, ["--version"], { encoding: "utf8" }); } catch (error) {
    throw new ExhaustionCompileError("COMPILER", `${nargo} does not run: ${(error as Error).message.split("\n")[0]}`);
  }
  const pinned = EXHAUSTION_SET_MANIFEST.compiler.split(" ")[1]!;
  if (!version.includes(`noirc version = ${pinned}`)) throw new ExhaustionCompileError("COMPILER", `${nargo} is not nargo ${pinned}`);
  const circuits = {} as Record<ExhaustionCircuit, BuiltCircuit>, crates = {} as Record<ExhaustionCircuit, string>;
  for (const name of EXHAUSTION_CIRCUITS) {
    const crate = crates[name] = join(directory, name);
    let program = kept(crate, name);
    if (program === undefined) {
      const project = join(directory, `build-${randomUUID()}`);
      try {
        mkdirSync(join(project, "src"), { recursive: true });
        for (const [file, shipped] of crateFiles(name)) writeFileSync(join(project, file), shipped());
        const started = Date.now();
        const compiled = spawnSync(nargo, ["compile", "--program-dir", project], { encoding: "utf8", maxBuffer: 1 << 26 });
        const out = `${compiled.stdout}${compiled.stderr}`;
        if (compiled.status !== 0) throw new ExhaustionCompileError("COMPILE", `${name}: nargo failed: ${out.slice(0, 2000)}`);
        if (/warning/i.test(out)) throw new ExhaustionCompileError("COMPILE", `${name}: the compiler warned: ${out.slice(0, 2000)}`);
        if (kept(project, name) === undefined) throw new ExhaustionSetError("IDENTITY", `${name}: the compiled bytecode is not the manifest's`);
        rmSync(crate, { recursive: true, force: true });
        renameSync(project, crate);
        log?.(`${name}: compiled in ${((Date.now() - started) / 1000).toFixed(0)} s`);
        program = kept(crate, name)!;
      } finally { rmSync(project, { recursive: true, force: true }); }
    }
    // A witness a stopped process left in the crate is never read.
    for (const file of [...readdirSync(crate), ...readdirSync(join(crate, "target")).map(f => join("target", f))]) {
      if (/(^|[\\/])witness-[^\\/]*\.(toml|gz)$/.test(file)) rmSync(join(crate, file), { force: true });
    }
    circuits[name] = Object.freeze({ program, ...keys[name] });
  }
  const sizes = EXHAUSTION_SET_MANIFEST.sizes;
  const length = (name: ExhaustionCircuit, parameter: string) =>
    (circuits[name].program as unknown as { abi: { parameters?: { name: string; type: { length?: number } }[] } }).abi.parameters
      ?.find(p => p.name === parameter)?.type.length;
  if (length("leaf-t", "tb") !== sizes.t || length("leaf-m", "mb") !== sizes.m || length("leaf-u", "uu") !== sizes.u) {
    throw new ExhaustionSetError("IDENTITY", "the leaves are not the manifest's sizes");
  }
  return Object.freeze({ sizes, circuits: Object.freeze(circuits), witness: nargoWitness(nargo, Object.freeze(crates)) });
}
