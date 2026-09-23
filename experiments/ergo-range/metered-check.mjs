// Fixed offline probe; the Python executable is a local toolchain selection.
// Usage: node metered-check.mjs <python executable> [--week]
// --week also meters the P4 window from the scratch/ergo-chain cache (about 25 minutes).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
const [python, flag] = process.argv.slice(2);
assert(python && (flag === undefined || flag === "--week"), "Usage: node metered-check.mjs <python executable> [--week]");
const frames = fileURLToPath(new URL("../../scratch/metered-week.bin", import.meta.url));
const args = ["-I", "-B", fileURLToPath(new URL("metered-check.py", import.meta.url)), process.execPath, ...(flag ? [frames] : [])];
try {
  const result = spawnSync(python, args, { encoding: "utf8", timeout: flag ? 3600000 : 1200000, maxBuffer: 1 << 22, windowsHide: true });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.error?.message ?? result.stderr ?? "metered probe failed");
    process.exit(1);
  }
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "offline-metered-release-probe");
  report.node = process.version;
  report.runner = { processTreeContainment: false, week: flag === "--week" };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally { rmSync(frames, { force: true }); }
