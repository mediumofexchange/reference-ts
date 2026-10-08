// Slice 13 (e) probe tooling, disposable: loaded with `node --import` into a `moe` process (serve, reader supply, wallet
// sync). It routes `dist/cli/backend.js` to standin-backend.mjs, whose verifier verifies a kept real proof in place of
// each stand-in proof (M11c2's load verifier), and, with MOE_DEPTH_MEM, appends this process's memory every minute
// (garbage-collected first every tenth sample when --expose-gc is on).
import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";

const WRAP = new URL("./standin-backend.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  if (resolved.url.endsWith("/dist/cli/backend.js") && context.parentURL !== WRAP) return { ...resolved, url: WRAP, shortCircuit: true };
  return resolved;
} });

const memFile = process.env.MOE_DEPTH_MEM;
if (memFile !== undefined) {
  let n = 0;
  const sample = () => {
    const collected = n++ % 10 === 0 && typeof globalThis.gc === "function";
    if (collected) globalThis.gc();
    const m = process.memoryUsage();
    appendFileSync(memFile, `${JSON.stringify({ at: Date.now(), collected, rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers })}\n`);
  };
  setInterval(sample, 60_000).unref();
}
