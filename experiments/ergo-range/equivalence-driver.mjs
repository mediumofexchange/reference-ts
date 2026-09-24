// Runs chain-cost.mjs over the own node's retained full blocks in chunks, sequentially; each chunk's report and log go
// to scratch/equivalence/. A chunk whose report exists is skipped, so rerunning the driver resumes.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
const FROM = 1830001, TO = 1879100, CHUNK = 10000, dir = "scratch/equivalence";
mkdirSync(dir, { recursive: true });
for (let from = FROM; from <= TO; from += CHUNK) {
  const count = Math.min(CHUNK, TO - from + 1), out = `${dir}/chunk-${from}.json`;
  if (existsSync(out)) continue;
  const started = Date.now();
  const r = spawnSync(process.execPath, ["experiments/ergo-range/chain-cost.mjs", "--from", String(from), "--count", String(count), "--depth", "10",
    "--sources", "http://127.0.0.1:9053", "--cache", "scratch/ergo-chain-own", "--delay", "0", "--out", out], { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 28 });
  appendFileSync(`${dir}/driver.log`, `${new Date().toISOString()} chunk ${from}+${count} exit ${r.status} ${Math.round((Date.now() - started) / 1000)} s\n${String(r.stderr).slice(-2000)}\n`);
}
appendFileSync(`${dir}/driver.log`, `${new Date().toISOString()} done\n`);
