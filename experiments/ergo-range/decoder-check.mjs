// Isolate the finite parser corpus from the caller. These process limits are
// experiment budgets, not a production resource policy or a hard RSS limit.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync(process.execPath,
  [fileURLToPath(new URL("decoder-cases.mjs", import.meta.url))], {
    timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8",
    windowsHide: true,
  });
if (result.error || result.status !== 0) {
  process.stderr.write(result.stderr ?? "");
  throw new Error("Decoder evidence unresolved: corpus failed or exceeded its process budget",
    { cause: result.error });
}
process.stdout.write(result.stdout);
