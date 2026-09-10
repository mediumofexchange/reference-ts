// Fixed offline probe; the Python executable is a local toolchain selection.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
assert(process.argv.length === 3, "Usage: node metering-check.mjs <python executable>");
const result = spawnSync(process.argv[2], ["-I", "-B", fileURLToPath(new URL("metering-check.py", import.meta.url)), process.execPath],
  { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
if (result.error || ![0, 2].includes(result.status)) {
  process.stderr.write(result.error?.message ?? result.stderr ?? "metering probe failed");
  process.exit(1);
}
const report = JSON.parse(result.stdout);
assert.equal(report.status, "offline-metering-feasibility-only");
assert.equal(result.status, report.corpus.status === "complete" ? 0 : 2);
report.node = process.version;
report.runner = { timeoutMs: 30000, capturedOutputBytes: 1048576, processTreeContainment: false };
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(result.status);
