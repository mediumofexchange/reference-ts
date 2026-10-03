// Drill tooling, not shipped: loaded with `node --import` into a `moe` process, it writes the process's peak resident
// set (kilobytes, worker threads included) to the file `MOE_DRILL_RSS` names as the process exits.
import { writeFileSync } from "node:fs";

const file = process.env.MOE_DRILL_RSS;
if (file !== undefined) process.on("exit", () => writeFileSync(file, JSON.stringify({ maxRssKb: process.resourceUsage().maxRSS })));
