// Fixed offline cost diagnostics only. Exit 2 preserves unresolved acceptance.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
assert(process.argv.length === 3, "Usage: node cost-check.mjs <python executable>");
const result = spawnSync(process.argv[2], ["-I", "-B", fileURLToPath(new URL("cost-check.py", import.meta.url)), process.execPath],
  { encoding: "utf8", timeout: 30000, maxBuffer: 1048576, windowsHide: true });
if (result.error || result.status !== 2) {
  process.stderr.write(result.error?.message ?? result.stderr ?? "cost probe failed");
  process.exit(1);
}
const report = JSON.parse(result.stdout);
assert.equal(report.status, "offline-decoder-cost-profile-only");
assert.equal(report.acceptanceBudgetUnchanged, true);
report.node = process.version;
report.runner = { timeoutMs: 30000, capturedOutputBytes: 1048576, processTreeContainment: false };
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(2);
