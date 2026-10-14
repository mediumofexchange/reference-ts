// The in-browser file suites (slice 40): the library's Node suites that keep database files (kept replay files,
// retained evidence, wallet files and the operator journals their fixtures run; the HTTP-served kept-wallet suite
// needs a server, which a browser host does not run), unchanged, in a browser engine's worker over the browser
// bundle's substitutes with the worker's file pool mounted (files.ts): the kept-file tests that skip on the
// substitutes without files (BROWSER_HOST) run here. scripts/browser/check.mjs --files builds and runs it.
import "./test-host.mjs";
import { mount } from "./files-mount.mjs";
import { poolUse } from "../../src/browser/files.js";
import { report, finish } from "./worker-report.mjs";
import { run } from "./vitest-shim.mjs";
import "../../test/pool-v3-replay-store.test.ts";
import "../../test/pool-v3-evidence-store.test.ts";
import "../../test/pool-v3-wallet.test.ts";
import "../../test/pool-v3-wallet-backup.test.ts";
// Last: it remounts the pool.
import "../../test/browser-files.test.ts";

const unhandled = [];
self.addEventListener("unhandledrejection", event => { unhandled.push(String(event.reason?.stack ?? event.reason)); });

const started = performance.now();
// Each test leaves no file it made open or named, and the pool's members it took return to the free ones.
let peak = 0;
const results = await run(result => {
  const use = poolUse();
  // The suites' pool's most members in use at once (the last test remounts another pool).
  if (!result.name.startsWith("the browser host's file pool")) peak = Math.max(peak, use.peak);
  if (result.state === "fail") report({ failed: result.name });
  if (use.unnamed !== 0) report({ unnamed: use.unnamed, after: result.name });
});
await new Promise(resolve => setTimeout(resolve, 0));
await finish({
  kind: "files", ms: Math.round(performance.now() - started), results, unhandled, mount, pool: { ...poolUse(), peak },
  counts: { pass: results.filter(r => r.state === "pass").length, fail: results.filter(r => r.state === "fail").length, skip: results.filter(r => r.state === "skip").length },
});
