// The in-browser file suites' pool (slice 40, files.mjs): mounted before any suite is imported (a module's top-level
// await holds back the modules imported after it), with the temporary directory and the scratch directory the suites
// make their files under.
import { mkdirSync } from "node:fs";
import { mountFiles } from "../../src/browser/files.js";

export const mount = await mountFiles("moe-check-files");
mkdirSync("/tmp", { recursive: true });
mkdirSync("/scratch", { recursive: true });
