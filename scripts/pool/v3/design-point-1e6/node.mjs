// Slice 13 (e) probe tooling, disposable: the synthetic node (scripts/pool/v3/synthetic-node.mjs) as its own process on
// a fixed port, surviving restarts: every request that changed its state (fund, mine, an accepted transaction) is
// appended to a log before it is answered, and a start replays the log in order (the synthetic chain and mempool are
// deterministic), so the chain, mempool and index come back as they were.
// Usage: node node.mjs <worktree> <log> <port>   (prints {"url", "replayed", "height"} once listening)
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [worktree, log, portText] = process.argv.slice(2);
const { SyntheticNode, serveSyntheticNode } = await import(pathToFileURL(join(worktree, "scripts/pool/v3/synthetic-node.mjs")).href);
const node = new SyntheticNode();
let replayed = 0;
if (existsSync(log)) {
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { break; } // a torn last line: its request was never answered
    const [status] = await node.answer(entry.method, new URL(entry.url, "http://node"), entry.body);
    if (status !== 200) throw new Error(`replay of ${line.slice(0, 200)} answered ${status}`);
    replayed++;
  }
}
const changes = path => path === "/synthetic/fund" || path === "/synthetic/mine" || path === "/transactions/bytes";
const answer = node.answer.bind(node);
node.answer = async (method, url, body) => {
  const out = await answer(method, url, body);
  if (method === "POST" && out[0] === 200 && changes(url.pathname)) {
    appendFileSync(log, `${JSON.stringify({ method, url: url.pathname + url.search, body })}\n`);
  }
  return out;
};
const served = await serveSyntheticNode(node, Number(portText));
console.log(JSON.stringify({ url: served.url, replayed, height: node.tip.height.toString() }));
process.on("SIGTERM", () => served.close().then(() => process.exit(0)));
