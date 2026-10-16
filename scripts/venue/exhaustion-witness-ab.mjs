// An A/B on one host for the exhaustion prover's witnesses (slice 43): one full-size leaf proved on the native backend
// under the shipped key, alone and beside a witness of the same leaf, computed either by noir_js in this process (as the
// pool did) or by `nargo execute` in a process of its own over the circuit's kept crate (as `exhaustionPrograms` does),
// in rounds after a warm-up, with the event loop's longest stall and the least free memory in each. Run each way in a
// process of its own: noir_js' WebAssembly memory, once grown, stays.
//
//   node scripts/venue/exhaustion-witness-ab.mjs <crate dir> <circuit> <inputs.json> <rounds> <out.json> <noir_js|nargo> [nargo]
//
// Run after `npm run build`, the exhaustion parameters in scratch/exhaustion-crs, a crate compiled by nargo
// (`exhaustionPrograms` keeps one per circuit) and a leaf's inputs as JSON (`periodLeaves` over recorded blocks).
import { execFile } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Noir } from "@noir-lang/noir_js";
import { EXHAUSTION_CIRCUITS, nativeExhaustionBackend } from "../../dist/ergo-exhaustion-pool.js";
import { crateName, proverToml } from "../../dist/ergo-exhaustion-programs.js";
import { EXHAUSTION_SET_MANIFEST, exhaustionKeys } from "../../dist/ergo-exhaustion-set.js";
import { readExhaustionParameters } from "../../dist/pool/parameter-files.js";

const [crate, circuit, inputsFile, rounds, out, way, nargo = "nargo"] = process.argv.slice(2);
if (!EXHAUSTION_CIRCUITS.includes(circuit) || !["noir_js", "nargo"].includes(way)) throw new Error("usage: see the header");
const inputs = JSON.parse(readFileSync(inputsFile, "utf8"));
const program = JSON.parse(readFileSync(join(crate, "target", `${crateName(circuit)}.json`), "utf8"));
const keys = exhaustionKeys();
const circuits = { sizes: EXHAUSTION_SET_MANIFEST.sizes, circuits: Object.fromEntries(EXHAUSTION_CIRCUITS.map(n => [n, { program, ...keys[n] }])) };
const backend = nativeExhaustionBackend(circuits, () => Promise.reject(new Error("unused")), () => readExhaustionParameters("scratch/exhaustion-crs"),
  { threads: os.cpus().length });
writeFileSync(join(crate, "ab.toml"), proverToml(inputs));
const noir = way === "noir_js" ? new Noir(program) : undefined;
const js = async () => (await noir.execute(inputs)).witness;
const native = async () => {
  await promisify(execFile)(nargo, ["execute", "--program-dir", crate, "--prover-name", "ab", "ab"], { maxBuffer: 1 << 26 });
  return new Uint8Array(readFileSync(join(crate, "target", "ab.gz")));
};
let last = Date.now(), worst = 0, least = os.freemem();
const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; least = Math.min(least, os.freemem()); }, 20);
const timed = async f => { const t = Date.now(); const r = await f(); return { r, s: (Date.now() - t) / 1000 }; };
const witness = (await timed(native)).r;
const report = { cpu: os.cpus()[0]?.model, cores: os.cpus().length, circuit, way, rounds: [] };
if (way === "noir_js") report.witnessesEqual = Buffer.from((await timed(js)).r).equals(Buffer.from(witness));
await backend.prove(circuit, witness); // warm-up: the instance's start and first proof
for (let k = 0; k < Number(rounds); k++) {
  for (const mode of ["alone", way]) {
    worst = 0; last = Date.now(); least = os.freemem();
    const proving = timed(() => backend.prove(circuit, witness));
    const beside = mode === "alone" ? undefined : await timed(mode === "noir_js" ? js : native);
    const proof = await proving;
    report.rounds.push({ round: k, mode, proof: proof.s, witness: beside?.s, worstStallMs: worst, leastFreeGiB: +(least / 2 ** 30).toFixed(1) });
    console.log(JSON.stringify(report.rounds.at(-1)));
  }
  worst = 0; last = Date.now();
  const alone = await timed(way === "noir_js" ? js : native);
  report.rounds.push({ round: k, mode: `${way} witness alone`, witness: alone.s, worstStallMs: worst });
  console.log(JSON.stringify(report.rounds.at(-1)));
  writeFileSync(out, JSON.stringify(report, null, 1));
}
clearInterval(timer);
await backend.close();
rmSync(join(crate, "ab.toml"), { force: true });
rmSync(join(crate, "target", "ab.gz"), { force: true });
