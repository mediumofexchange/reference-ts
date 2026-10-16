import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXHAUSTION_CIRCUITS, type ExhaustionCircuit } from "../src/ergo-exhaustion-set.js";
import { exhaustionPrograms, ExhaustionCompileError, ExhaustionWitnessError, nargoWitness, proverToml } from "../src/ergo-exhaustion-programs.js";

// A prover's witnesses by `nargo execute` (slice 43). Real nargo runs in the succinct drill (CI's `succinct` group, where
// a replica proves its periods); here a stand-in nargo records what it is asked and answers as nargo does.
const root = mkdtempSync(join(tmpdir(), "moe-exhaustion-programs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A stand-in nargo: `--version` as `version` says; `execute` writes its prover file back as the witness, fails a
 * prover file holding "fail" as a failed assertion does, and refuses a second execution while one runs. */
function fakeNargo(version = "1.0.0-beta.26"): string {
  const file = join(root, `nargo-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), a = process.argv.slice(2);
if (a[0] === "--version") { console.log("nargo version = ${version}\\nnoirc version = ${version}+0000"); process.exit(0); }
if (a[0] !== "execute") process.exit(2);
const dir = a[a.indexOf("--program-dir") + 1], name = a[a.indexOf("--prover-name") + 1], busy = path.join(dir, "busy");
const toml = fs.readFileSync(path.join(dir, name + ".toml"), "utf8");
if (fs.existsSync(busy)) { console.error("two executions at once"); process.exit(3); }
fs.writeFileSync(busy, "");
setTimeout(() => {
  fs.rmSync(busy);
  if (toml.includes("fail")) { console.error("error: Assertion failed: the leaf's list is not the scan's\\n  ┌─ src/main.nr:4:5"); process.exit(1); }
  fs.mkdirSync(path.join(dir, "target"), { recursive: true });
  fs.writeFileSync(path.join(dir, "target", a.at(-1) + ".gz"), toml);
}, 30);
`);
  chmodSync(file, 0o755);
  return file;
}
const crates = (): Record<ExhaustionCircuit, string> => {
  const dir = mkdtempSync(join(root, "crates-"));
  return Object.fromEntries(EXHAUSTION_CIRCUITS.map(name => { mkdirSync(join(dir, name, "target"), { recursive: true }); return [name, join(dir, name)]; })) as
    Record<ExhaustionCircuit, string>;
};
const leftovers = (crate: string): string[] => [...readdirSync(crate), ...readdirSync(join(crate, "target"))].filter(f => f.startsWith("witness-"));

describe("a prover's witnesses (succinct-read §4.3, slice 43)", () => {
  it("writes inputs as a prover file nargo reads: strings, booleans, integers, nested arrays and structs", () => {
    expect(proverToml({ sin: "12", b: [true, false], tb: [["1", "2"], ["3"]], t0: { h: ["0x0a"], in_tx: false, j: 3 }, rows: [{ a: "1" }, { a: "2" }] }))
      .toBe('sin = "12"\nb = [true, false]\ntb = [["1", "2"], ["3"]]\nt0 = { h = ["0x0a"], in_tx = false, j = 3 }\nrows = [{ a = "1" }, { a = "2" }]\n');
    for (const bad of [{ x: 1n }, { x: undefined }, { x: null }, { x: 1.5 }, { "a b": "1" }, { x: { "a=b": "1" } }, { x: new Uint8Array(1) }]) {
      expect(() => proverToml(bad as Record<string, unknown>)).toThrow(TypeError);
    }
  });

  it.skipIf(process.platform === "win32")("computes each witness in nargo over the circuit's crate, one at a time, and leaves nothing behind", async () => {
    const at = crates(), witness = nargoWitness(fakeNargo(), at);
    const inputs = (k: number) => ({ sin: String(k), t0: { h: ["1", "2"], in_tx: k % 2 === 0 } });
    // Four at once: the stand-in refuses a second execution while one runs, so all four passing shows they were queued.
    const made = await Promise.all([0, 1, 2, 3].map(k => witness(k < 2 ? "leaf-t" : "node", inputs(k))));
    made.forEach((w, k) => expect(Buffer.from(w).toString()).toBe(proverToml(inputs(k))));
    for (const name of EXHAUSTION_CIRCUITS) expect(leftovers(at[name])).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("refuses a failed check by the circuit's message for it, and the next witness still runs", async () => {
    const at = crates(), witness = nargoWitness(fakeNargo(), at);
    const failed = witness("leaf-t", { sin: "fail" });
    const next = witness("leaf-t", { sin: "1" });
    const error = await failed.then(() => undefined, (e: unknown) => e) as ExhaustionWitnessError;
    expect(error).toBeInstanceOf(ExhaustionWitnessError);
    expect(error.circuit).toBe("leaf-t");
    expect(error.message).toBe("leaf-t: Assertion failed: the leaf's list is not the scan's");
    expect(Buffer.from(await next).toString()).toBe('sin = "1"\n');
    expect(leftovers(at["leaf-t"])).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("refuses an input nargo cannot read before running it", async () => {
    const at = crates(), witness = nargoWitness(fakeNargo(), at);
    await expect(witness("leaf-u", { x: 1n })).rejects.toThrow(TypeError);
    expect(leftovers(at["leaf-u"])).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("refuses a compiler that is not the pinned one, even with every crate kept", () => {
    const directory = mkdtempSync(join(root, "programs-"));
    let error: unknown;
    try { exhaustionPrograms({ nargo: fakeNargo("1.0.0-beta.25"), directory }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(ExhaustionCompileError);
    expect((error as ExhaustionCompileError).code).toBe("COMPILER");
    try { exhaustionPrograms({ nargo: join(root, "no-such-nargo"), directory }); } catch (e) { error = e; }
    expect((error as ExhaustionCompileError).code).toBe("COMPILER");
    expect((error as Error).message).toMatch(/does not run/);
  });

  it.skipIf(process.platform === "win32")("clears what a stopped compile left and the programs an earlier layout kept", () => {
    const directory = mkdtempSync(join(root, "programs-"));
    mkdirSync(join(directory, "build-1234", "src"), { recursive: true });
    writeFileSync(join(directory, "leaf-t.json"), "{}");
    writeFileSync(join(directory, "leaf-t.json.5678.tmp"), "{}");
    // The stand-in compiles nothing, so opening stops at the first crate it cannot compile; what was left is gone first.
    expect(() => exhaustionPrograms({ nargo: fakeNargo(), directory })).toThrow(ExhaustionCompileError);
    expect(existsSync(join(directory, "build-1234"))).toBe(false);
    expect(existsSync(join(directory, "leaf-t.json"))).toBe(false);
    expect(existsSync(join(directory, "leaf-t.json.5678.tmp"))).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });
});
