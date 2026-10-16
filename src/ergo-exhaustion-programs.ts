// The exhaustion circuits' programs for a prover (succinct-read §§4.3, 6; slice 43). Each leaf's program is tens of
// megabytes, so the package ships the circuits' sources (`exhaustion-circuits/`: each circuit's generated `main.nr`,
// the shared modules and the vendored sponge) rather than their programs; a prover compiles them once with the pinned
// native compiler (`nargo`, whose WebAssembly build runs out of memory at the leaves' size) into a directory of its own
// and runs a program only where its bytecode is the manifest's (`EXHAUSTION_SET_MANIFEST`). The keys are the shipped,
// pinned ones: a prover derives none, and a program whose key differed would make proofs that do not verify under them,
// which the pool refuses before keeping any.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { EXHAUSTION_CIRCUITS, EXHAUSTION_SET_MANIFEST, exhaustionKeys, ExhaustionSetError, type BuiltCircuit, type ExhaustionCircuit,
  type ExhaustionCircuits } from "./ergo-exhaustion-set.js";
import type { CompiledProgram } from "./pool/proof-verifier.js";

/** The shipped sources, beside this module, and the vendored sponge they share. */
const SOURCES = fileURLToPath(new URL("./exhaustion-circuits/", import.meta.url));
const SPONGE = fileURLToPath(new URL("./pool/circuits/vendor/poseidon2.nr", import.meta.url));
/** The shared modules every circuit's crate holds beside its `main.nr`, by where each is read from. */
const SHARED_SOURCES: readonly (readonly [string, string])[] = Object.freeze([["exhaustion.nr", join(SOURCES, "exhaustion.nr")],
  ["blake2b.nr", join(SOURCES, "blake2b.nr")], ["poseidon2.nr", SPONGE]]);
/** A circuit's crate name, as the build names it. */
export const crateName = (name: ExhaustionCircuit): string => `moe_succinct_exhaustion_${name.replaceAll("-", "_")}`;

/** The compiler is not the pinned one, or it failed or warned: a prover's setup fault. */
export class ExhaustionCompileError extends Error {
  constructor(readonly code: "COMPILER" | "COMPILE", message: string) { super(message); this.name = "ExhaustionCompileError"; }
}

const bytecodeIdentity = (bytecode: string): string => bytesToHex(sha256(Buffer.from(bytecode, "base64")));

/** A kept program, where it reads as the manifest's. */
function kept(file: string, name: ExhaustionCircuit): CompiledProgram | undefined {
  try {
    const program = JSON.parse(readFileSync(file, "utf8")) as { noir_version?: unknown; abi?: unknown; bytecode?: unknown };
    if (typeof program.bytecode !== "string" || bytecodeIdentity(program.bytecode) !== EXHAUSTION_SET_MANIFEST.circuits[name].bytecode ||
        program.abi === null || typeof program.abi !== "object") return undefined;
    return program as unknown as CompiledProgram;
  } catch { return undefined; }
}

/**
 * The six circuits as a prover runs them: each program kept in `directory` where its bytecode is the manifest's, or
 * compiled there from the shipped sources with `nargo` (which must report the manifest's compiler) and kept only where it
 * is; with the pinned keys and the manifest's sizes. A compiled program that is not the manifest's refuses `IDENTITY`.
 */
export function exhaustionPrograms(options: { readonly nargo: string; readonly directory: string; readonly log?: (line: string) => void }): ExhaustionCircuits {
  const { nargo, directory, log } = options, keys = exhaustionKeys();
  mkdirSync(directory, { recursive: true });
  // What a compile stopped part-way left (its crate, a program not yet renamed into place) is never read; it goes.
  for (const name of readdirSync(directory)) if (/^build-|\.tmp$/.test(name)) rmSync(join(directory, name), { recursive: true, force: true });
  let checked = false;
  const circuits = {} as Record<ExhaustionCircuit, BuiltCircuit>;
  for (const name of EXHAUSTION_CIRCUITS) {
    const file = join(directory, `${name}.json`);
    let program = kept(file, name);
    if (program === undefined) {
      if (!checked) {
        let version: string;
        try { version = execFileSync(nargo, ["--version"], { encoding: "utf8" }); } catch (error) {
          throw new ExhaustionCompileError("COMPILER", `${nargo} does not run: ${(error as Error).message.split("\n")[0]}`);
        }
        const pinned = EXHAUSTION_SET_MANIFEST.compiler.split(" ")[1]!;
        if (!version.includes(`noirc version = ${pinned}`)) throw new ExhaustionCompileError("COMPILER", `${nargo} is not nargo ${pinned}`);
        checked = true;
      }
      const project = join(directory, `build-${randomUUID()}`);
      try {
        mkdirSync(join(project, "src"), { recursive: true });
        writeFileSync(join(project, "Nargo.toml"), `[package]\nname = "${crateName(name)}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
        copyFileSync(join(SOURCES, `${name}.nr`), join(project, "src", "main.nr"));
        for (const [name, from] of SHARED_SOURCES) copyFileSync(from, join(project, "src", name));
        const started = Date.now();
        const run = spawnSync(nargo, ["compile", "--program-dir", project], { encoding: "utf8", maxBuffer: 1 << 26 });
        const out = `${run.stdout}${run.stderr}`;
        if (run.status !== 0) throw new ExhaustionCompileError("COMPILE", `${name}: nargo failed: ${out.slice(0, 2000)}`);
        if (/warning/i.test(out)) throw new ExhaustionCompileError("COMPILE", `${name}: the compiler warned: ${out.slice(0, 2000)}`);
        const built = JSON.parse(readFileSync(join(project, "target", `${crateName(name)}.json`), "utf8")) as { noir_version: string; abi: object; bytecode: string };
        if (bytecodeIdentity(built.bytecode) !== EXHAUSTION_SET_MANIFEST.circuits[name].bytecode) {
          throw new ExhaustionSetError("IDENTITY", `${name}: the compiled bytecode is not the manifest's`);
        }
        const temporary = `${file}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify({ noir_version: built.noir_version, abi: built.abi, bytecode: built.bytecode }));
        renameSync(temporary, file);
        log?.(`${name}: compiled in ${((Date.now() - started) / 1000).toFixed(0)} s`);
        program = kept(file, name)!;
      } finally { rmSync(project, { recursive: true, force: true }); }
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
  return Object.freeze({ sizes, circuits: Object.freeze(circuits) });
}
