// The pool-v3 real-proof checks in one list. `npm run check:pool:v3` runs every script in order (after the build and
// the proving parameters); CI runs one group per job (its matrix is GROUPS, through scripts/real-proof-gate.mjs) and
// collects each group's reports from the job that ran them. Groups are balanced by measured time (decisions/2026-10.md,
// 2026-10-06, parallel real-proof groups), so CI waits for the slowest group; each run prints its scripts' times.
//
// Usage: node scripts/pool/v3/real-proof.mjs [--group <name>] [--ergo] [--collect <directory>]
//        node scripts/pool/v3/real-proof.mjs --expect <directory>...
//   --ergo passes --ergo to local replay (its Ergo adapter pass), as `npm run check:pool:v3 -- --ergo` always did.
//   --collect copies each report the run's scripts wrote into <directory> at its repository path, and fails if one
//   is missing or was not written by this run.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "../../..");
const v3 = "scripts/pool/v3";

/** Every real-proof script in the serial order, its group and the reports it writes (repository paths). */
export const SCRIPTS = Object.freeze([
  { group: "stores", script: `${v3}/testnet.mjs`, args: ["--check"], reports: [] },
  { group: "history", script: `${v3}/check.mjs`, args: [], reports: ["scratch/pool-v3-results.json"] },
  { group: "history", script: `${v3}/store-check.mjs`, args: ["--ergo"], reports: ["scratch/pool-v3-store-results.json"] },
  { group: "history", script: `${v3}/history-store-check.mjs`, args: [], reports: ["docs/pool-v3-history-store-verification.json"] },
  ...["recovery", "succession", "scope", "redemption"].flatMap(name => [
    { group: name === "redemption" ? "redemption" : "stores", script: `${v3}/${name}-store-check.mjs`, args: [],
      reports: [`docs/pool-v3-${name}-store-verification.json`] },
    { group: name === "redemption" ? "redemption" : "stores", script: `${v3}/${name}-store-check.mjs`, args: ["--ergo"],
      reports: [`docs/pool-v3-${name}-store-ergo-verification.json`] },
  ]),
  { group: "drill", script: `${v3}/command-drill.mjs`, args: [], reports: [] },
  { group: "replay", script: `${v3}/local-check.mjs`, args: [], reports: ["scratch/pool-v3-local-replay-results.json"] },
].map(entry => Object.freeze({ ...entry, args: Object.freeze(entry.args), reports: Object.freeze(entry.reports) })));

/** The group names, in order of first appearance. */
export const GROUPS = Object.freeze([...new Set(SCRIPTS.map(entry => entry.group))]);

function parse(argv) {
  const options = { group: undefined, ergo: false, collect: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ergo") options.ergo = true;
    else if ((arg === "--group" || arg === "--collect") && i + 1 < argv.length && options[arg.slice(2)] === undefined) {
      options[arg.slice(2)] = argv[++i];
    } else throw new Error(`real-proof: unknown, repeated or incomplete option ${arg}`);
  }
  if (options.group !== undefined && !GROUPS.includes(options.group)) {
    throw new Error(`real-proof: unknown group ${options.group} (groups: ${GROUPS.join(", ")})`);
  }
  return options;
}

/** The reports every group writes that are missing under `directory` (laid out at repository paths). */
export function missingReports(directory) {
  return SCRIPTS.flatMap(entry => entry.reports).filter(report => !existsSync(join(directory, report)));
}

function run(options) {
  const selected = SCRIPTS.filter(entry => options.group === undefined || entry.group === options.group);
  const timings = [];
  for (const entry of selected) {
    const args = [...entry.args, ...(options.ergo && entry.script.endsWith("/local-check.mjs") ? ["--ergo"] : [])];
    const label = [entry.script, ...args].join(" ");
    console.log(`real-proof: ${label}`);
    const started = Date.now();
    const result = spawnSync(process.execPath, [join(root, entry.script), ...args], { cwd: root, stdio: "inherit", windowsHide: true });
    const seconds = (Date.now() - started) / 1000;
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(`real-proof: ${label} failed (${result.signal ?? `exit ${result.status}`}) after ${seconds.toFixed(1)} s`);
      process.exit(result.status === null ? 1 : result.status);
    }
    timings.push({ label, seconds });
    if (options.collect !== undefined) {
      for (const report of entry.reports) {
        const source = join(root, report);
        if (!existsSync(source)) throw new Error(`real-proof: ${label} wrote no ${report}`);
        // A committed report keeps its checkout time; one this script wrote is newer than its start.
        if (statSync(source).mtimeMs < started) throw new Error(`real-proof: ${report} was not written by ${label}`);
        const target = join(resolve(options.collect), report);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      }
    }
  }
  for (const { label, seconds } of timings) console.log(`real-proof: ${seconds.toFixed(1).padStart(7)} s  ${label}`);
  console.log(`real-proof: ${options.group ?? "all groups"} passed, ${timings.length} scripts`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--expect") {
    // CI's merged artifacts: every report of every group reached each system's artifact.
    const missing = argv.slice(1).flatMap(directory => missingReports(directory).map(report => `${directory}: ${report}`));
    if (argv.length < 2 || missing.length > 0) {
      console.error(argv.length < 2 ? "real-proof: --expect takes directories" : `real-proof: missing reports\n  ${missing.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`real-proof: all ${SCRIPTS.flatMap(entry => entry.reports).length} reports present in ${argv.slice(1).join(", ")}`);
  } else run(parse(argv));
}
