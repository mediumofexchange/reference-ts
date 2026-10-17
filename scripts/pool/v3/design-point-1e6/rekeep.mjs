// 10⁶ design-point probe tooling, disposable: the keeper (keep.mjs) died while its driver ran on. This waits for that
// driver (its process id is the argument) to exit and, unless the report is done, starts the keeper again through
// launch.cmd, which resumes the driver from the journal's count. Starting the keeper while the driver lives would run
// two drivers on one journal.
// Usage: node rekeep.mjs <driver pid>
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), LOG = join(HERE, "driver.log"), pid = Number(process.argv[2]);
const note = message => appendFileSync(LOG, `${new Date().toISOString()} rekeep: ${message}\n`);
const alive = () => /^"node\.exe"/i.test((spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }).stdout ?? "").trim());
const done = () => { try { return JSON.parse(readFileSync(join(HERE, "run", "report.json"), "utf8")).done === true; } catch { return false; } };

if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("usage: node rekeep.mjs <driver pid>");
note(`watching driver ${pid}, whose keeper is gone`);
while (alive()) await new Promise(resolve => setTimeout(resolve, 60_000));
if (done()) note(`driver ${pid} exited with the report done`);
else {
  note(`driver ${pid} exited before the report was done; starting the keeper`);
  spawn("cmd.exe", ["/c", join(HERE, "launch.cmd")], { cwd: HERE, detached: true, stdio: "ignore", windowsHide: true }).unref();
}
