// M11b11 probe: a command's view behind by more than one sync's header budget reaches the tip in one
// open. Synthetic node, an operator directory with a synthetic venue, `BLOCKS` blocks mined after it, then
// `openView(...).syncWitnessed()` as every command calls it, with its progress events on stderr.
// Usage: npm run build, then node scripts/pool/v3/catch-up-probe.mjs [blocks]
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDirectory } from "../../../dist/cli/common.js";
import { openView } from "../../../dist/cli/venue.js";

const BLOCKS = Number(process.argv[2] ?? 4500), ROOT = new URL("../../../", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "m11b11-")), OP = join(scratch, "operator");
const node = spawn(process.execPath, [join(ROOT, "scripts/pool/v3/synthetic-node.mjs"), "--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
const url = await new Promise(done => node.stdout.once("data", chunk => done(JSON.parse(chunk.toString()).url)));
const post = async (path, body) => (await fetch(new URL(path, url), { method: "POST", body: JSON.stringify(body) })).json();
const moe = args => {
  const r = spawnSync(process.execPath, [join(ROOT, "dist/cli/moe.js"), ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`moe ${args.join(" ")}: ${r.stderr}`);
  return JSON.parse(r.stdout);
};
try {
  await post("synthetic/mine", { count: 12 });
  moe(["operator", "init", "--dir", OP, "--node", url, "--budget", "1000"]);
  moe(["operator", "venue", "create", "--dir", OP, "--synthetic", "--depth", "10"]);
  for (let left = BLOCKS; left > 0; left -= 500) await post("synthetic/mine", { count: Math.min(500, left) });
  const began = performance.now(), view = openView(openDirectory(OP, "operator"));
  try {
    const synced = await view.syncWitnessed();
    console.log(JSON.stringify({ blocks: BLOCKS, passes: synced.passes, witnessedIndex: String(synced.witnessedIndex),
      tipHeight: String(synced.tipHeight), stopped: synced.suppliers.map(s => s.stopped ?? null), ms: Math.round(performance.now() - began) }));
  } finally { view.close(); }
} finally { node.kill("SIGTERM"); rmSync(scratch, { recursive: true, force: true }); }
