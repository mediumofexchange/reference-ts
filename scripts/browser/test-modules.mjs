// node:os and node:child_process for the in-browser file suites (slice 40, files.mjs): the suites make their
// directories under the system's temporary directory, which is the mounted pool's /tmp here; no process can be
// started, so a test that needs one skips or fails by name. Resolved only in check.mjs's test bundles.
import { availableParallelism } from "../../src/browser/node-os.ts";

export { availableParallelism };
export const tmpdir = () => "/tmp";
export const platform = () => "browser";
export function spawn() { throw new Error("a browser host starts no processes"); }
export function spawnSync() { throw new Error("a browser host starts no processes"); }
export default { availableParallelism, tmpdir, platform, spawn, spawnSync };
