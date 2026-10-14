// The in-browser suites (slice 39): the library's own primitive, record, trail, succinct-read, scope-reader,
// state-machine and capsule suites, Poseidon2's pinned vectors and independent oracle among them,
// run in a browser engine's worker over the browser bundle's substitutes (scripts/browser/check.mjs builds this
// with "vitest" resolved to vitest-shim.mjs). They keep no file, so they run here as they run under Node.
import { report, finish } from "./worker-report.mjs";
import { run } from "./vitest-shim.mjs";
import "../../test/pool-poseidon2.test.ts";
import "../../test/pool-note-tree.test.ts";
import "../../test/pool-v3-spent-set.test.ts";
import "../../test/pool-v3-records.test.ts";
import "../../test/pool-v3-commitments.test.ts";
import "../../test/pool-v3-trail.test.ts";
import "../../test/pool-v3-succinct.test.ts";
import "../../test/pool-v3-scope-reader.test.ts";
import "../../test/pool-v3-state.test.ts";
import "../../test/pool-v3-capsules.test.ts";

// An assertion left unawaited (an `expect(...).rejects` without await) fails nowhere but here: the run fails with it.
const unhandled = [];
self.addEventListener("unhandledrejection", event => { unhandled.push(String(event.reason?.stack ?? event.reason)); });

const started = performance.now();
const results = await run(result => { if (result.state === "fail") report({ failed: result.name }); });
await new Promise(resolve => setTimeout(resolve, 0));
await finish({
  kind: "suites", ms: Math.round(performance.now() - started), results, unhandled,
  counts: { pass: results.filter(r => r.state === "pass").length, fail: results.filter(r => r.state === "fail").length, skip: results.filter(r => r.state === "skip").length },
});
