// The throttled phone estimate (slice 46, direction 2026-10-16 decision 3): the browser checks with the browser's whole
// process tree on one core under a CFS quota of 1/s of that core, for each slowdown s, and under a memory cap, while
// this script and the parties it starts run on the other cores. Every holder workload runs on one thread (the backend
// at one thread, the JavaScript in a worker), so a quota of 1/s stands in for a core s times slower than this host's:
// simulated, not a phone. For each budget of the declared phone (production requirements, Phone holder) it reports the
// largest slowdown at which the budget holds: measured for the commands and the memory cap, arithmetic over the
// measured per-workload rates for a day's sync, a mean day's CPU and a restore.
//
//   node scripts/browser/throttle.mjs [--slowdowns 1,2,3,4,6] [--checks proofs,rates,wallet] [--memory-mib 1024]
//     [--core 0] [--browser <path>] [--report <file>]
//
// Linux as root, with the cpu, cpuset and memory controllers (cgroup v1, or v2 with them enabled). Needs `npm run
// build` and the proving parameters (scripts/pool/prepare-crs.mjs). Each check's own report is kept beside the
// report as scratch/throttle/<check>-s<s>.json.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync, chmodSync } from "node:fs";
import { availableParallelism, cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { root } from "./build.mjs";
import { adoptedConfiguration, configurationHash } from "../../dist/pool/v3/configuration.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const PERIOD = 100_000, out = join(root, "scratch/throttle");

function parse(argv) {
  const options = { slowdowns: [1, 2, 3, 4, 6], checks: ["proofs", "rates", "wallet"], memoryMib: 1024, core: 0,
    browser: process.env.MOE_BROWSER ?? (process.env.PLAYWRIGHT_BROWSERS_PATH && join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium")),
    report: join(out, "throttle.json") };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], value = argv[i + 1];
    if (value === undefined) throw new Error(`throttle: ${arg} needs a value`);
    if (arg === "--slowdowns") options.slowdowns = value.split(",").map(Number);
    else if (arg === "--checks") options.checks = value.split(",");
    else if (arg === "--memory-mib") options.memoryMib = Number(value);
    else if (arg === "--core") options.core = Number(value);
    else if (arg === "--browser" || arg === "--report") options[arg.slice(2)] = resolve(value);
    else throw new Error(`throttle: unknown option ${arg}`);
    i++;
  }
  if (options.slowdowns.some(s => !(s >= 1 && s <= 64))) throw new Error("throttle: --slowdowns are numbers from 1 to 64");
  if (options.checks.some(c => !["proofs", "rates", "wallet"].includes(c))) throw new Error("throttle: --checks are proofs, rates and wallet");
  if (!Number.isSafeInteger(options.memoryMib) || options.memoryMib < 256) throw new Error("throttle: --memory-mib is a whole number from 256");
  if (!Number.isSafeInteger(options.core) || options.core < 0 || options.core >= availableParallelism()) throw new Error("throttle: --core names one of this host's cores");
  if (availableParallelism() < 2) throw new Error("throttle: the parties need a core beside the throttled one");
  if (options.browser === undefined || !existsSync(options.browser)) throw new Error("throttle: name the browser with --browser or MOE_BROWSER");
  return options;
}

/** The throttle group, under cgroup v1's per-controller hierarchies or v2's unified one. */
function group(name, core, memoryBytes) {
  const v2 = existsSync("/sys/fs/cgroup/cgroup.controllers");
  const dirs = v2 ? [join("/sys/fs/cgroup", name)] : ["cpu", "cpuset", "memory"].map(c => join("/sys/fs/cgroup", c, name));
  const at = file => v2 ? join(dirs[0], file) : join(dirs[["cpu", "cpuset", "memory"].indexOf(file.split(".")[0])], file);
  const put = (file, value) => writeFileSync(at(file), String(value));
  const get = file => { try { return readFileSync(at(file), "utf8"); } catch { return undefined; } };
  if (v2) {
    const enabled = readFileSync("/sys/fs/cgroup/cgroup.subtree_control", "utf8");
    for (const c of ["cpu", "cpuset", "memory"]) if (!enabled.split(/\s+/).includes(c)) throw new Error(`throttle: cgroup v2 controller ${c} is not enabled for subgroups`);
  }
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  put("cpuset.cpus", core);
  put("cpuset.mems", v2 ? "" : readFileSync("/sys/fs/cgroup/cpuset/cpuset.mems", "utf8").trim());
  if (v2) put("memory.max", memoryBytes); else put("memory.limit_in_bytes", memoryBytes);
  return {
    version: v2 ? 2 : 1,
    procs: dirs.map(dir => join(dir, "cgroup.procs")),
    slow(s) { const quota = Math.round(PERIOD / s); if (v2) put("cpu.max", `${quota} ${PERIOD}`); else { put("cpu.cfs_period_us", PERIOD); put("cpu.cfs_quota_us", quota); } return quota; },
    resetPeak() { if (!v2) put("memory.max_usage_in_bytes", 0); },
    /** The group's mapped pages, each once: anonymous and file-mapped (shared memory included), the closest the group
     * gives to the sum of its processes' proportional set sizes; unmapped page cache is left out. */
    resident() {
      const stat = Object.fromEntries((get("memory.stat") ?? "").trim().split("\n").map(line => line.split(" ")).map(([k, v]) => [k, Number(v)]));
      return v2 ? stat.anon + stat.file_mapped : stat.total_rss + stat.total_mapped_file;
    },
    /** The group's peak charge (each page once, page cache included), the limit's hits and kills, and its throttling. */
    read() {
      const stat = Object.fromEntries((get("cpu.stat") ?? "").trim().split("\n").map(line => line.split(" ")).map(([k, v]) => [k, Number(v)]));
      if (v2) {
        const events = Object.fromEntries((get("memory.events") ?? "").trim().split("\n").map(line => line.split(" ")).map(([k, v]) => [k, Number(v)]));
        return { peakBytes: Number(get("memory.peak") ?? NaN), limitHits: events.max, oomKills: events.oom_kill, cpu: stat };
      }
      const oom = Object.fromEntries((get("memory.oom_control") ?? "").trim().split("\n").map(line => line.split(" ")).map(([k, v]) => [k, Number(v)]));
      return { peakBytes: Number(get("memory.max_usage_in_bytes")), limitHits: Number(get("memory.failcnt")), oomKills: oom.oom_kill, cpu: stat };
    },
    remove() { for (const dir of dirs) try { rmdirSync(dir); } catch { /* a process still in it */ } },
  };
}

/** One browser check with the browser in the group; this script's own affinity (the other cores) passes to its children. */
function runCheck(check, s, wrapper, groupName, minutes) {
  const report = join(out, `${check}-s${s}.json`);
  return new Promise(done => {
    const began = Date.now();
    const child = spawn(process.execPath, [join(root, "scripts/browser/check.mjs"), `--${check}`, "--browser", wrapper, "--report", report, "--minutes", String(minutes)],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MOE_THROTTLE_GROUP: groupName } });
    let tail = "";
    const keep = chunk => { tail = (tail + chunk).slice(-4000); };
    child.stdout.on("data", keep); child.stderr.on("data", keep);
    child.on("close", status => {
      let result;
      try { result = JSON.parse(readFileSync(report, "utf8")); } catch { result = undefined; }
      done({ status, seconds: (Date.now() - began) / 1000, result, ...(status === 0 ? {} : { tail }) });
    });
  });
}

const fileHash = path => bytesToHex(createHash("sha256").update(readFileSync(join(root, path))).digest());

// The design point (production requirements; direction 2026-10-16): a mean day of 900 statements and 720 Ergo headers,
// a peak day of 10⁴ statements, a restore of 10⁶ statements, about 7.9·10⁵ headers and 4·10⁶ capsules; capsules at
// four outputs a statement on a peak day and 4·10⁶ over three years on a mean one; one cover root verified a day.
const DAY = { statements: 900, headers: 720, capsules: 3650, roots: 1 };
const PEAK = { statements: 10_000, headers: 720, capsules: 40_000, roots: 1 };
const RESTORE = { statements: 1_000_000, headers: 790_000, capsules: 4_000_000, roots: 1 };
const BUDGETS = [
  { name: "a mean day's sync", seconds: 30, work: DAY },
  { name: "a peak day's sync", seconds: 180, work: PEAK },
  { name: "a mean day's CPU", seconds: 120, work: DAY },
  { name: "a seed restore", seconds: 12 * 3600, work: RESTORE },
  { name: "request", seconds: 30, command: "request" },
  { name: "pay with its proof", seconds: 30, command: "pay" },
  { name: "fulfill", seconds: 30, command: "fulfill" },
];

/** The per-workload rates of one slowdown's checks, in milliseconds. */
function rates(runs) {
  const phase = (check, prefix) => runs[check]?.result?.phases?.filter(p => p.name.startsWith(prefix)) ?? [];
  const median = values => values.length === 0 ? undefined : values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const proofs = runs.proofs?.result?.checks;
  const commands = runs.wallet?.result?.commands ?? [];
  return {
    replayPerStatementMs: median(phase("rates", "replay the package").map(p => p.perMs)),
    digestsPerStatementMs: phase("rates", "leaf and node digests")[0]?.perMs,
    headerMs: phase("rates", "check ").at(-1)?.perMs,
    capsuleMs: proofs?.capsuleMs,
    verifyMs: phase("proofs", "verify the spend")[0]?.ms,
    proveSpendMs: phase("proofs", "prove a spend")[0]?.ms,
    keysMs: phase("proofs", "derive and check")[0]?.ms,
    commandMs: Object.fromEntries(["init", "request", "fulfill", "pay", "sync", "restore"].map(name =>
      [name, Math.max(...commands.filter(c => c.command === name && c.code === 0).map(c => c.ms), -Infinity)]).filter(([, ms]) => ms > 0)),
  };
}

/** Seconds of single-thread work for `work` at these rates (arithmetic, not a measured day or restore). */
function workSeconds(r, work) {
  if ([r.replayPerStatementMs, r.digestsPerStatementMs, r.headerMs, r.capsuleMs, r.verifyMs].some(v => v === undefined)) return undefined;
  return (work.statements * (r.replayPerStatementMs + r.digestsPerStatementMs) + work.headers * r.headerMs + work.capsules * r.capsuleMs + work.roots * r.verifyMs) / 1000;
}

/** The largest slowdown at which `cost(s) ≤ budget`: the measured points, and the crossing interpolated linearly between
 * the last point that holds and the first that fails (or extrapolated from the last two when every point holds). */
function breakEven(points, budget) {
  const held = points.filter(p => p.seconds !== undefined && p.seconds <= budget), failed = points.filter(p => p.seconds !== undefined && p.seconds > budget);
  const last = held.at(-1), first = failed[0];
  let crossing;
  if (last !== undefined && first !== undefined) crossing = last.s + (budget - last.seconds) * (first.s - last.s) / (first.seconds - last.seconds);
  else if (last !== undefined && held.length >= 2) { const a = held.at(-2); crossing = last.s + (budget - last.seconds) * (last.s - a.s) / (last.seconds - a.seconds); }
  else if (first !== undefined && first.s === points[0].s) crossing = first.s * budget / first.seconds;
  return { heldUpTo: last?.s, failedFrom: first?.s, slowdown: crossing === undefined ? undefined : Math.round(crossing * 10) / 10,
    basis: last !== undefined && first !== undefined ? "interpolated" : "extrapolated" };
}

async function main() {
  const options = parse(process.argv.slice(2)), name = `moe-throttle-${process.pid}`, memoryBytes = options.memoryMib * 2 ** 20;
  mkdirSync(out, { recursive: true });
  const g = group(name, options.core, memoryBytes), wrapper = join(out, "browser.sh");
  writeFileSync(wrapper, `#!/bin/sh\n# The browser, after joining the throttle group (throttle.mjs).\nfor p in ${g.procs.join(" ")}; do echo $$ > "$p" || exit 97; done\nexec "${options.browser}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  const rest = Array.from({ length: availableParallelism() }, (_, i) => i).filter(i => i !== options.core);
  const pinned = spawn("taskset", ["-a", "-p", "-c", rest.join(","), String(process.pid)], { stdio: "ignore" });
  await new Promise(done => pinned.on("close", done));
  const runs = [];
  try {
    for (const s of options.slowdowns) {
      const quota = g.slow(s), checks = {};
      for (const check of options.checks) {
        g.resetPeak();
        const before = g.read();
        console.log(`throttle: ${check} at slowdown ${s} (quota ${quota}/${PERIOD} µs on core ${options.core})`);
        let mapped = 0;
        const sampler = setInterval(() => { mapped = Math.max(mapped, g.resident() ?? 0); }, 250);
        const run = await runCheck(check, s, wrapper, name, Math.ceil(25 * s)).finally(() => clearInterval(sampler));
        const after = g.read();
        checks[check] = { ...run, memory: { mappedPeakBytes: mapped, peakBytes: after.peakBytes, limitHits: after.limitHits - before.limitHits, oomKills: after.oomKills - before.oomKills },
          throttled: { periods: after.cpu.nr_throttled - before.cpu.nr_throttled, seconds: ((after.cpu.throttled_time ?? after.cpu.throttled_usec * 1000) - (before.cpu.throttled_time ?? before.cpu.throttled_usec * 1000)) / 1e9 } };
        console.log(`throttle: ${check} at ${s}: ${run.status === 0 ? "passed" : `failed (${run.status})`} in ${run.seconds.toFixed(1)} s, mapped peak ${Math.round(mapped / 2 ** 20)} MiB, charged peak ${Math.round(after.peakBytes / 2 ** 20)} MiB`);
      }
      runs.push({ slowdown: s, quotaMicroseconds: quota, checks, rates: rates(checks) });
    }
  } finally { g.remove(); }

  const estimate = BUDGETS.map(budget => {
    const points = runs.map(run => ({ s: run.slowdown, seconds: budget.command !== undefined
      ? (run.rates.commandMs[budget.command] === undefined ? undefined : run.rates.commandMs[budget.command] / 1000) : workSeconds(run.rates, budget.work) }));
    return { budget: budget.name, budgetSeconds: budget.seconds, kind: budget.command !== undefined ? "measured command" : "arithmetic over measured rates",
      points, ...breakEven(points, budget.seconds) };
  });
  const memory = runs.map(run => ({ s: run.slowdown, ...Object.fromEntries(Object.entries(run.checks).map(([check, c]) =>
    [check, { passed: c.status === 0, mappedPeakMiB: Math.round(c.memory.mappedPeakBytes / 2 ** 20), chargedPeakMiB: Math.round(c.memory.peakBytes / 2 ** 20), limitHits: c.memory.limitHits, oomKills: c.memory.oomKills }])) }));
  const configuration = adoptedConfiguration();
  const report = {
    label: "SIMULATED: a desktop core throttled by a CFS quota stands in for a slower core; no phone was measured",
    measuredAt: new Date().toISOString(),
    host: { cpu: cpus()[0]?.model, cores: availableParallelism(), memoryGiB: Math.round(totalmem() / 2 ** 30), node: process.version, cgroup: g.version },
    throttle: { core: options.core, otherCores: rest, periodMicroseconds: PERIOD, memoryCapMiB: options.memoryMib },
    manifest: { revision: spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(), configurationHash: bytesToHex(configurationHash(configuration)),
      programs: fileHash("src/pool/v3/programs.json"), checkSet: fileHash("src/pool/v3/check-set.json"), checkSetPrograms: fileHash("src/pool/v3/check-set-programs.json"),
      bbjs: JSON.parse(readFileSync(join(root, "node_modules/@aztec/bb.js/package.json"), "utf8")).version,
      browser: runs[0]?.checks[options.checks[0]]?.result?.browser },
    workloads: { day: DAY, peak: PEAK, restore: RESTORE },
    estimate, memory, runs,
  };
  writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  for (const e of estimate) console.log(`throttle: ${e.budget} (≤ ${e.budgetSeconds} s): holds to slowdown ${e.heldUpTo ?? "none"}, break-even ${e.slowdown ?? "?"} (${e.basis}; ${e.kind})`);
  console.log(`throttle: report ${options.report}`);
  return runs.every(run => Object.values(run.checks).every(c => c.status === 0)) ? 0 : 1;
}


process.exitCode = await main();
