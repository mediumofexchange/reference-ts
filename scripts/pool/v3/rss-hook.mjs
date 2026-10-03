// Drill tooling, not shipped: loaded with `node --import` into a `moe` process, it writes, as the process exits, the
// process's peak resident set (kilobytes, worker threads included) and whether it loaded any `@noir-lang` module
// (M10b item 10: a verify-only process loads none) to the file `MOE_DRILL_RSS` names.
import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";

const file = process.env.MOE_DRILL_RSS;
let noir = false;
registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  if (resolved.url.includes("/@noir-lang/")) noir = true;
  return resolved;
} });
if (file !== undefined) process.on("exit", () => writeFileSync(file, JSON.stringify({ maxRssKb: process.resourceUsage().maxRSS, noir })));
