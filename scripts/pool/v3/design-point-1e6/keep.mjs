// 10⁶ design-point probe tooling, disposable: keeps driver.mjs running until its report is done. A failed driver (for
// instance a connection lost across the laptop's sleep) is started again after a minute and resumes from the journal's
// count; after a shutdown, the Startup entry (moe-dp6.vbs, launch.cmd) starts this again at the next logon. One keeper at
// a time: a second exits while the first lives. Gives up after 10 failures in a row that each came within 5 minutes of
// starting. When the report is done it writes exit.txt and removes the Startup entry.
// Usage: node keep.mjs <driver arguments>   Environment: DPR_RUN, DPR_LOG (default ./driver.log), DPR_STARTUP.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants, setPriority, uptime } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = process.env.DPR_RUN ?? join(HERE, "run"), LOG = process.env.DPR_LOG ?? join(HERE, "driver.log");
const PIDFILE = `${LOG}.keep.pid`, EXIT = join(dirname(LOG), "exit.txt"), STARTUP = process.env.DPR_STARTUP;
const note = message => appendFileSync(LOG, `${new Date().toISOString()} keep: ${message}\n`);
const pause = ms => new Promise(done => setTimeout(done, ms));
const alive = pid => /^"node\.exe"/i.test((spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }).stdout ?? "").trim());

if (existsSync(PIDFILE) && statSync(PIDFILE).mtimeMs > Date.now() - uptime() * 1000) {
  const pid = Number(readFileSync(PIDFILE, "utf8"));
  if (pid !== process.pid && alive(pid)) { note(`another keeper (${pid}) runs; this one exits`); process.exit(0); }
}
writeFileSync(PIDFILE, String(process.pid));
try { setPriority(process.pid, constants.priority.PRIORITY_ABOVE_NORMAL); } catch { /* keeps normal priority */ }
rmSync(EXIT, { force: true });

const done = () => { try { return JSON.parse(readFileSync(join(RUN, "report.json"), "utf8")).done === true; } catch { return false; } };
let failures = 0;
for (;;) {
  const began = Date.now(), out = openSync(LOG, "a");
  note(`starting the driver ${process.argv.slice(2).join(" ")}`);
  const child = spawn(process.execPath, [join(HERE, "driver.mjs"), ...process.argv.slice(2)], { cwd: HERE, stdio: ["ignore", out, out], env: process.env });
  const status = await new Promise(resolve => { child.on("error", () => resolve(-1)); child.on("close", code => resolve(code ?? -1)); });
  closeSync(out);
  if (done()) {
    writeFileSync(EXIT, "0 done\n"); note("the report is done");
    if (STARTUP !== undefined) rmSync(STARTUP, { force: true });
    break;
  }
  if (status === 0) { writeFileSync(EXIT, "0 stopped\n"); note("the driver stopped before the report was done"); break; }
  failures = Date.now() - began < 300_000 ? failures + 1 : 1;
  note(`the driver exited ${status}; failure ${failures} in a row`);
  if (failures >= 10) { writeFileSync(EXIT, `${status} gave up after ${failures} quick failures\n`); break; }
  await pause(60_000);
}
rmSync(PIDFILE, { force: true });
