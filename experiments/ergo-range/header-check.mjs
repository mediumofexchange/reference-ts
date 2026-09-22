// The profile's header source from a node the reader runs (ERGO_VENUE_PROFILE "Before selection"). The reader's own
// mainnet node (nodes.mjs) downloaded the header chain from genesis, not a NiPoPoW proof, and checked every header's
// proof of work, difficulty and linkage and chose the best chain itself. This check reads that node's best chain and
// asks whether the evidence retained so far stands on it: the pinned fixtures' headers, and the chain-cost probe's
// window from its anchor to its tip (5,050 headers read from two public nodes), header by header. A header id commits to
// the header's transaction root and, through its parent id, to its whole ancestry, so every section the chain-cost probe
// reproduced against those roots is then bound to headers this reader validated. GET only, against 127.0.0.1 and,
// for a comparison at the current tip, the two public nodes; no runtime path reads this and no answer selects a venue.
//
// Usage, from the repository root on Node 24, once the node's headers pass the window:
//   node experiments/ergo-range/header-check.mjs [--node http://127.0.0.1:9053]
//     [--compare https://node.ergo.watch,http://213.239.193.208:9053] [--cache scratch/ergo-chain] [--out <report>]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const here = import.meta.dirname, root = resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const nodeUrl = option("--node", "http://127.0.0.1:9053").replace(/\/$/, "");
const compare = option("--compare", "https://node.ergo.watch,http://213.239.193.208:9053").split(",").map(u => u.replace(/\/$/, ""));
const cache = resolve(root, option("--cache", "scratch/ergo-chain")), out = option("--out");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const files = Object.fromEntries(["experiments/ergo-range/header-check.mjs", "experiments/ergo-range/nodes.mjs", "experiments/ergo-range/fixtures/manifest.json",
  "docs/ergo-chain-cost-verification.json"].map(file => [file, sha256(readFileSync(join(root, file)))]));
const FIELDS = ["id", "parentId", "height", "version", "transactionsRoot"];

let requests = 0;
async function get(base, path) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  requests++;
  if (!response.ok) throw new Error(`HTTP ${response.status} GET ${base}${path}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
// The best chain's headers over (from, to], in chunks; chainSlice's upper bound can fall back to another header, so
// the caller checks linkage and the heights it asked for.
async function bestChain(base, from, to) {
  const headers = [];
  for (let a = from; a < to; a += 100) headers.push(...await get(base, `/blocks/chainSlice?fromHeight=${a}&toHeight=${Math.min(a + 100, to)}`));
  assert.deepEqual(headers.map(h => h.height), Array.from({ length: to - from }, (_, i) => from + 1 + i), `the best chain over (${from}, ${to}] from ${base}`);
  return headers;
}

const info = await get(nodeUrl, "/info");
assert.equal(info.network, "mainnet", "the own node reports the mainnet");
const chainCost = JSON.parse(readFileSync(join(root, "docs/ergo-chain-cost-verification.json"), "utf8")).window;
assert(info.headersHeight >= chainCost.tipHeight, `the own node's headers (${info.headersHeight}) reach the window's tip ${chainCost.tipHeight}`);

// The node's configuration file, without the API key hash.
const confFile = join(root, "scratch/ergo-nodes/mainnet/ergo.conf");
const configuration = existsSync(confFile) ? readFileSync(confFile, "utf8").replace(/apiKeyHash = "[0-9a-f]+"/, 'apiKeyHash = "<omitted>"') : null;
// The configuration is the file as written at check time (nodes.mjs rewrites it on each start); the node's log of its
// first processes, which shows it processing the genesis header itself, is cited in the milestones below.
assert(configuration !== null && /nipopowBootstrap = false/.test(configuration), "the node is configured to sync the header chain from genesis, not from a NiPoPoW proof");

// 1. The pinned fixtures' headers are on the own node's best chain.
const manifest = JSON.parse(readFileSync(join(here, "fixtures/manifest.json"), "utf8"));
// Each fixture's header is compared field by field, not only by id: the fixture file's own header, read as pinned.
const pinned = [...manifest.headers, ...manifest.fixtures].map(f => {
  const json = JSON.parse(readFileSync(join(here, f.file), "utf8"));
  return { file: f.file, height: Number(f.height), id: f.headerId, header: json.header ?? json };
});
const fixtures = [];
for (const f of pinned) {
  const [own] = await bestChain(nodeUrl, f.height - 1, f.height);
  fixtures.push({ file: f.file, height: f.height, id: f.id, onOwnBestChain: own.id === f.id && f.header.id === f.id && FIELDS.every(k => own[k] === f.header[k]) });
}

// 2. The chain-cost window, anchor through tip, header by header against the cached public-node headers.
const own = await bestChain(nodeUrl, chainCost.anchorHeight - 1, chainCost.tipHeight);
const linked = own.slice(1).filter((h, i) => h.parentId === own[i].id).length;
// Only the chain-cost report's named sources; the cache also holds headers under other labels from earlier probes.
const sourceHosts = new Set(JSON.parse(readFileSync(join(root, "docs/ergo-chain-cost-verification.json"), "utf8")).sources.map(s => new URL(s.url).host.replace(":", "-")));
const cachedByHost = {};
for (const name of readdirSync(cache).filter(n => /^headers-.+-\d+-\d+\.json$/.test(n))) {
  const host = name.replace(/^headers-/, "").replace(/-\d+-\d+\.json$/, "");
  if (!sourceHosts.has(host)) continue;
  for (const header of JSON.parse(readFileSync(join(cache, name), "utf8"))) {
    const known = (cachedByHost[host] ??= new Map()).get(header.height);
    assert(known === undefined || FIELDS.every(k => known[k] === header[k]), `one header per height in the ${host} cache`);
    cachedByHost[host].set(header.height, header);
  }
}
const window = { anchorHeight: chainCost.anchorHeight, tipHeight: chainCost.tipHeight, headers: own.length, linked, linkedExpected: own.length - 1,
  anchorId: own[0].id, anchorMatches: own[0].id === chainCost.anchorId, tipId: own.at(-1).id, tipMatches: own.at(-1).id === chainCost.tipId, byCachedSource: {} };
for (const [host, headers] of Object.entries(cachedByHost)) {
  const covered = own.filter(h => headers.has(h.height));
  if (covered.length === 0) continue;
  window.byCachedSource[host] = { compared: covered.length, agree: covered.filter(h => FIELDS.every(k => headers.get(h.height)[k] === h[k])).length };
}

// 3. The own node and the public nodes at one recent height below the tips.
const recent = info.headersHeight - 20, [ownRecent] = await bestChain(nodeUrl, recent - 1, recent);
const current = { height: recent, ownId: ownRecent.id, nodes: [] };
for (const base of compare) {
  try { const [h] = await bestChain(base, recent - 1, recent); current.nodes.push({ node: base, id: h.id, agrees: h.id === ownRecent.id }); }
  catch (error) { current.nodes.push({ node: base, error: String(error.message).slice(0, 160) }); }
}

// 4. What running the node cost to reach this point, from nodes.mjs watch samples.
const samples = existsSync(join(root, "scratch/ergo-nodes/status.jsonl"))
  ? readFileSync(join(root, "scratch/ergo-nodes/status.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).map(s => ({ at: s.at, ...s.nodes.find(n => n.network === "mainnet") }))
  : [];
const reached = samples.find(s => s.headersHeight >= chainCost.tipHeight);
let processStart = null;
try {
  const pid = Number(readFileSync(join(root, "scratch/ergo-nodes/mainnet/pid"), "utf8"));
  processStart = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8", windowsHide: true }).trim();
} catch { /* the node is not running */ }
// The first run's header-sync milestone, extracted from its INFO log (the nodes log at WARN since).
const milestonesFile = join(root, "scratch/ergo-nodes/milestones.json");
const milestones = existsSync(milestonesFile) ? JSON.parse(readFileSync(milestonesFile, "utf8")) : null;
// From the first process's start: the first process was stopped at height 2,492 and the second continued
// on the same data directory ten seconds later.
const headersSyncSeconds = milestones === null ? null
  : (Date.parse(milestones.headersSynced.mainnet.at) - Date.parse(milestones.runs.mainnet[0].start)) / 1000;
const sync = { milestones, headersSyncSeconds, currentProcessStart: processStart, samples: samples.length, firstSample: samples[0] ?? null,
  windowTipReached: reached ?? null, latest: samples.at(-1) ?? null };

// Every named source of the chain-cost report must cover and agree on every header after the anchor.
const passed = fixtures.every(f => f.onOwnBestChain) && window.anchorMatches && window.tipMatches && linked === own.length - 1
  && [...sourceHosts].every(host => window.byCachedSource[host]?.compared === own.length - 1 && window.byCachedSource[host].agree === own.length - 1);
const report = {
  status: passed ? "retained-evidence-on-own-validated-headers" : "mismatch",
  node: process.version, ownNode: { url: nodeUrl, appVersion: info.appVersion, name: info.name, headersHeight: info.headersHeight, fullHeight: info.fullHeight,
    bestHeaderId: info.bestHeaderId, headersScore: info.headersScore, peers: info.peersCount, stateType: info.stateType }, configuration,
  fixtures, window, current, sync, requests, files,
  limitations: [
    "The own node is Ergo's reference client v6.0.6, the implementation most of the network runs; it checks proof of work, difficulty and chain selection as that client does, and no independent implementation re-checks them here.",
    "The node connected out to peers it discovered; an eclipse during sync could present a chain of less work but cannot forge proof of work. Agreement with two public nodes at one recent height is recorded; a shared upstream is not excluded.",
    "Header identity binds each header's transaction root, so the chain-cost probe's section evidence is bound to these headers through equal ids; the sections themselves were not re-read from this node.",
    "The profile's verifier still checks linkage, contiguity and the anchor only; proof of work and chain selection remain the header source's, which is now a node the reader runs rather than a public one.",
    "Sync time and resources are one run on one desktop over one home connection, with a UTXO-set snapshot for state; full-block validation from genesis was not measured.",
    "The recorded configuration is the node's file as written at check time (nodes.mjs rewrites it on each start); the first processes' logs, which show the node processing the genesis header itself and no NiPoPoW proof, are cited in the milestones.",
    "The public nodes' headers are compared as cached under scratch/ by the chain-cost probe; the cache files are not re-checked against that report's response digest here.",
    "The release bundle's JAR is checked against the release digest on every start; its bundled Java runtime is covered only by the release archive's digest checked once at download.",
    "No runtime path, profile selection or specification change follows from this check.",
  ],
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) writeFileSync(resolve(root, out), text);
process.stdout.write(text);
if (!passed) process.exitCode = 1;
