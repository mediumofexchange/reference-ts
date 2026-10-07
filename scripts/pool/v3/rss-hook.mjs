// Drill tooling, not shipped: loaded with `node --import` into a `moe` process, it writes, as the process exits, the
// process's peak resident set (kilobytes, worker threads included), its CPU time (milliseconds, all threads) and whether it loaded any `@noir-lang` module
// (M10b item 10: a verify-only process loads none) to the file `MOE_DRILL_RSS` names. With `MOE_DRILL_INSTALL` (a party's
// install directory as a file URL ending in "/", slice 13 M13c) it also names each module file the process resolved
// outside that install: the drills' machines lie under the checkout, whose node_modules Node's resolution would
// otherwise reach for a dependency the install lacks.
import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";

const file = process.env.MOE_DRILL_RSS, install = process.env.MOE_DRILL_INSTALL, outside = new Set();
// The drills' own tooling (this hook, the lit drill's connection guard) is loaded from the checkout's scripts.
const tooling = new URL("../../", import.meta.url).href;
let noir = false;
registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  if (resolved.url.includes("/@noir-lang/")) noir = true;
  if (install !== undefined && resolved.url.startsWith("file:") && !resolved.url.startsWith(install) &&
    !resolved.url.startsWith(tooling)) outside.add(resolved.url);
  return resolved;
} });
if (file !== undefined) process.on("exit", () => {
  const { maxRSS, userCPUTime, systemCPUTime } = process.resourceUsage();
  writeFileSync(file, JSON.stringify({ maxRssKb: maxRSS, cpuMs: Math.round((userCPUTime + systemCPUTime) / 1000), noir,
    ...(install === undefined ? {} : { outside: [...outside] }) }));
});
