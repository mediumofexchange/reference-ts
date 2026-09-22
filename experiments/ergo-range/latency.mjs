// A10: inclusion latency on the Ergo mainnet, observed passively. GET-only reads of a
// public node's mempool and blocks: each transaction first seen in the pool is timed
// against the node's full height at that sighting and the height of the block that
// includes it. Nothing is submitted, no key is read, no runtime path reads this and no
// answer selects the profile or its depth. The node is a trust input: it decides what
// its pool holds and which chain it follows; a second node's headers are compared at
// the end, proof of work and chain selection are not checked.
//
// C3.3's window (pool-recovery.md): a demand authorized at tip T with its instant at the
// latest witnessed index lands at index instant + depth + k when included at height
// T + k, so it has force for 1 <= k <= depth + 2. This measures k's distribution for
// the population of mainnet transactions, not for a kind-4 publication's shape.
//
// Usage, from the repository root on Node 24:
//   node experiments/ergo-range/latency.mjs [--node http://213.239.193.208:9053]
//     [--compare https://node.ergo.watch] [--hours 24] [--tail-minutes 60] [--poll 10]
//     [--delay 250] [--state scratch/ergo-latency/run.json] [--resume] [--out <report>]
//   node experiments/ergo-range/latency.mjs --report-only [--state ...] [--out <report>]
//     recomputes the report from a recorded state without the network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const here = import.meta.dirname, root = resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const nodeUrl = option("--node", "http://213.239.193.208:9053").replace(/\/$/, "");
const compareUrl = option("--compare", "https://node.ergo.watch").replace(/\/$/, "");
const hours = Number(option("--hours", "24")), tailMinutes = Number(option("--tail-minutes", "60"));
const pollSeconds = Number(option("--poll", "10")), delayMs = Number(option("--delay", "250"));
const stateFile = resolve(root, option("--state", "scratch/ergo-latency/run.json")), out = option("--out");
const resume = args.includes("--resume"), reportOnly = args.includes("--report-only");
assert(hours > 0 && tailMinutes >= 0 && pollSeconds > 0 && delayMs >= 0, "usage: [--hours h] [--tail-minutes m] [--poll s] [--delay ms]");

// The miner-fee proposition (the same tree on every network); a transaction's fee is the sum of its outputs to it.
const FEE_TREE = "1005040004000e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a701730073011001020402d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304";
// Blocks re-read below the tip on every new height, so a short reorganization replaces what was recorded there.
const REORG_WINDOW = 6;
const DEPTHS = Array.from({ length: 21 }, (_, d) => d);

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const files = { "experiments/ergo-range/latency.mjs": sha256(readFileSync(join(root, "experiments/ergo-range/latency.mjs"))) };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let requests = 0, failures = 0;
async function get(base, path) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      requests++;
      await sleep(delayMs);
      if (!response.ok) { const error = new Error(`HTTP ${response.status} GET ${path}: ${text.slice(0, 200)}`); error.status = response.status; throw error; }
      return JSON.parse(text);
    } catch (error) {
      if (error.status !== undefined || attempt >= 3) throw error;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

const load = () => JSON.parse(readFileSync(stateFile, "utf8"));
const save = state => { mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(`${stateFile}.tmp`, JSON.stringify(state)); renameSync(`${stateFile}.tmp`, stateFile); };

// One transaction's timing. kLow counts from the node's height at the first round that saw it; kHigh from the height at
// the previous successful round, when it was not yet seen: a submission to this node between the two rounds has its k in
// [kLow, kHigh]. Sightings present in the first round, or after a gap in the rounds, have no bracket and are excluded.
function timing(tx, block) {
  return { k: block.height - tx.tip, kHigh: block.height - tx.previousTip, seconds: (block.timestamp - tx.firstSeen) / 1000 };
}

const quantiles = values => {
  const v = [...values].sort((a, b) => a - b), q = p => v.length === 0 ? null : v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, min: v[0] ?? null, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: v.at(-1) ?? null };
};
const histogram = values => { const h = {}; for (const v of values) h[v] = (h[v] ?? 0) + 1; return h; };
// The fraction of sightings that would have had force at each depth: included with k <= depth + 2. "all" counts every
// timed sighting, so a dropped or still-pending transaction counts as a miss; "included" conditions on inclusion.
function withinWindow(rows) {
  const all = rows.length, included = rows.filter(r => r.k !== undefined);
  return Object.fromEntries(DEPTHS.map(d => {
    const low = included.filter(r => r.k <= d + 2).length, high = included.filter(r => r.kHigh <= d + 2).length;
    return [d, { all: all === 0 ? null : +(low / all).toFixed(4), included: included.length === 0 ? null : +(low / included.length).toFixed(4),
      includedUpper: included.length === 0 ? null : +(high / included.length).toFixed(4) }];
  }));
}
const sizeBucket = size => size < 1024 ? "<1KiB" : size < 4096 ? "1-4KiB" : size < 16384 ? "4-16KiB" : ">=16KiB";
const rateBucket = rate => rate < 100 ? "<100" : rate < 1000 ? "100-999" : ">=1000";

export function summarize(state) {
  const blocks = Object.values(state.blocks).sort((a, b) => a.height - b.height);
  const includedAt = new Map();
  for (const block of blocks) for (const [position, id] of block.transactions.entries()) if (!includedAt.has(id)) includedAt.set(id, { block, position });
  const seen = Object.entries(state.seen).map(([id, tx]) => ({ id, ...tx }));
  const timed = seen.filter(tx => !tx.presentAtStart && !tx.afterGap && tx.firstSeen <= state.admitUntil);
  const rows = timed.map(tx => {
    const inclusion = includedAt.get(tx.id);
    const row = { id: tx.id, size: tx.size, fee: tx.fee, rate: tx.size ? Math.floor(tx.fee / tx.size) : null };
    if (inclusion === undefined) return { ...row, outcome: state.pool.includes(tx.id) ? "pending" : "dropped" };
    return { ...row, outcome: "included", ...timing(tx, inclusion.block), position: inclusion.position };
  });
  const included = rows.filter(r => r.outcome === "included");
  const firstHeight = blocks[0]?.height, observedIds = new Set(seen.map(tx => tx.id));
  // Transactions in blocks after the first round that the pool never showed: included before a round could see them,
  // or never broadcast to this node (a miner's own). Coinbase-style transactions are among them.
  const unseen = blocks.filter(b => b.height > firstHeight).flatMap(b => b.transactions.filter(id => !observedIds.has(id)));
  const intervals = blocks.slice(1).map((b, i) => (b.timestamp - blocks[i].timestamp) / 1000);
  const strata = (key, bucket) => Object.fromEntries([...new Set(rows.filter(r => r[key] !== null).map(r => bucket(r[key])))].sort().map(name => {
    const group = rows.filter(r => r[key] !== null && bucket(r[key]) === name);
    return [name, { sightings: group.length, included: group.filter(r => r.outcome === "included").length, k: quantiles(group.filter(r => r.k !== undefined).map(r => r.k)),
      withinDepth2: withinWindow(group)[2], withinDepth10: withinWindow(group)[10] }];
  }));
  return {
    rounds: state.rounds, failedRounds: state.failedRounds, maxRoundGapSeconds: state.maxRoundGap / 1000,
    window: { firstHeight, lastHeight: blocks.at(-1)?.height, blocks: blocks.length, startedAt: new Date(state.startedAt).toISOString(),
      admitUntil: new Date(state.admitUntil).toISOString(), endedAt: state.endedAt === undefined ? null : new Date(state.endedAt).toISOString(), reorganizedHeights: state.reorganized },
    blockIntervalSeconds: quantiles(intervals), transactionsPerBlock: quantiles(blocks.map(b => b.transactions.length)),
    blocksWithOnlyOneTransaction: blocks.filter(b => b.transactions.length === 1).length,
    pool: { sizePerRound: quantiles(state.poolSizes) },
    sightings: { total: seen.length, presentAtStart: seen.filter(tx => tx.presentAtStart).length, afterGap: seen.filter(tx => tx.afterGap).length,
      timed: rows.length, included: included.length, dropped: rows.filter(r => r.outcome === "dropped").length, pending: rows.filter(r => r.outcome === "pending").length,
      detailMissing: seen.filter(tx => tx.size === null).length },
    includedUnseen: unseen.length,
    k: { low: quantiles(included.map(r => r.k)), high: quantiles(included.map(r => r.kHigh)), histogram: histogram(included.map(r => r.k)) },
    secondsToBlockTimestamp: quantiles(included.map(r => r.seconds)),
    withinWindowByDepth: withinWindow(rows),
    bySize: strata("size", sizeBucket), byFeePerByte: strata("rate", rateBucket),
    note: "k is the inclusion height less the node's full height at the first round that saw the transaction (kHigh: at the round before); under C3.3 a demand authorized at the tip has force for 1 <= k <= depth + 2. 'all' counts dropped and pending sightings as misses; 'included' conditions on inclusion. Fee per byte is nanoERG per serialized byte.",
  };
}

async function observe(state) {
  const tip = async () => { const info = await get(nodeUrl, "/info"); return { height: info.fullHeight, id: info.bestFullHeaderId, info }; };
  // Reads the node's best chain over (from, to] and every block whose header id changed or was never read.
  const readBlocks = async (from, to) => {
    for (let a = from; a < to; a += 50) {
      const headers = await get(nodeUrl, `/blocks/chainSlice?fromHeight=${a}&toHeight=${Math.min(a + 50, to)}`);
      for (const header of headers) {
        const known = state.blocks[header.height];
        if (known?.id === header.id) continue;
        if (known !== undefined) state.reorganized.push(header.height);
        const body = await get(nodeUrl, `/blocks/${header.id}/transactions`);
        state.blocks[header.height] = { height: header.height, id: header.id, timestamp: header.timestamp, bytes: body.size, transactions: body.transactions.map(t => t.id) };
      }
    }
  };
  const detail = async id => {
    try {
      const tx = await get(nodeUrl, `/transactions/unconfirmed/byTransactionId/${id}`);
      return { size: tx.size, fee: tx.outputs.filter(o => o.ergoTree === FEE_TREE).reduce((a, o) => a + o.value, 0), inputs: tx.inputs.length, outputs: tx.outputs.length };
    } catch (error) { if (error.status === 404 || error.status === 400) return { size: null, fee: null }; throw error; }
  };
  const end = state.admitUntil + tailMinutes * 60000;
  while (Date.now() < end) {
    const started = Date.now();
    try {
      const now = await tip();
      state.node ??= { name: now.info.name, appVersion: now.info.appVersion, network: now.info.network, parameters: now.info.parameters };
      assert.equal(now.info.network, "mainnet", "the node reports the mainnet");
      if (state.lastHeight === undefined) state.lastHeight = now.height - 1;
      if (now.height > state.lastHeight || state.blocks[now.height]?.id !== now.id) {
        await readBlocks(Math.max(state.lastHeight, now.height - REORG_WINDOW), now.height);
        state.lastHeight = now.height;
      }
      const pool = await get(nodeUrl, "/transactions/unconfirmed/transactionIds");
      const admitting = Date.now() <= state.admitUntil, gap = state.lastRoundAt !== undefined && started - state.lastRoundAt > 3 * pollSeconds * 1000;
      for (const id of pool) {
        if (state.seen[id] !== undefined || !admitting) continue;
        state.seen[id] = { firstSeen: Date.now(), tip: now.height, previousTip: state.previousTip ?? now.height, presentAtStart: state.rounds === 0,
          afterGap: gap, ...(await detail(id)) };
      }
      state.pool = pool;
      state.poolSizes.push(pool.length);
      if (state.lastRoundAt !== undefined) state.maxRoundGap = Math.max(state.maxRoundGap, started - state.lastRoundAt);
      state.lastRoundAt = started; state.previousTip = now.height; state.rounds++;
      if (state.rounds % 30 === 0) console.error(`  round ${state.rounds}: height ${now.height}, pool ${pool.length}, sightings ${Object.keys(state.seen).length}`);
    } catch (error) {
      state.failedRounds++; failures++;
      console.error(`  round failed: ${String(error.message ?? error).slice(0, 160)}`);
    }
    save(state);
    await sleep(Math.max(0, pollSeconds * 1000 - (Date.now() - started)));
  }
  state.endedAt = Date.now();
  // Reconcile the whole window against the node's final best chain, then compare its headers with a second node.
  const heights = Object.keys(state.blocks).map(Number);
  await readBlocks(Math.min(...heights) - 1, Math.max(...heights));
  const agreement = { node: compareUrl, heights: 0, agree: 0, disagree: [] };
  try {
    for (let a = Math.min(...heights) - 1; a < Math.max(...heights); a += 50) {
      const headers = await get(compareUrl, `/blocks/chainSlice?fromHeight=${a}&toHeight=${Math.min(a + 50, Math.max(...heights))}`);
      for (const header of headers) {
        if (state.blocks[header.height] === undefined) continue;
        agreement.heights++;
        if (state.blocks[header.height].id === header.id) agreement.agree++; else agreement.disagree.push(header.height);
      }
    }
  } catch (error) { agreement.error = String(error.message ?? error).slice(0, 200); }
  state.agreement = agreement;
  save(state);
}

let state;
if (reportOnly || resume) state = load();
else {
  assert(!existsSync(stateFile), `a state file exists at ${stateFile}; pass --resume or choose another --state`);
  const now = Date.now();
  state = { startedAt: now, admitUntil: now + hours * 3600000, nodeUrl, rounds: 0, failedRounds: 0, maxRoundGap: 0, blocks: {}, seen: {}, pool: [], poolSizes: [], reorganized: [] };
  save(state);
}
if (!reportOnly) await observe(state);

const report = { status: "mainnet-observed-passively", node: process.version, nodeUrl: state.nodeUrl, nodeInfo: state.node, compared: state.agreement ?? null,
  requests: reportOnly ? null : requests, failedRequests: reportOnly ? null : failures, stateSha256: sha256(readFileSync(stateFile)), files,
  settings: { hours, tailMinutes, pollSeconds, delayMs, reorgWindow: REORG_WINDOW }, ...summarize(state),
  limitations: [
    "One public node's pool and chain: a transaction is timed from this node's first sighting, which follows its submission elsewhere by the propagation delay and up to one poll interval; kLow and kHigh bracket k only for a submission to this node.",
    "The population is mainnet transactions of every shape and fee over this window, not a kind-4 publication; a holder's own node, submission path and proving time are not measured.",
    "Dropped means the node's pool stopped holding a transaction that no block in the window included (a double spend, an invalid chain or eviction); a pending transaction was still held when the tail ended. Both count as misses in 'all'.",
    "Headers come from the observing node; one second node's header ids are compared over the window, proof of work and chain selection are not checked.",
    "No runtime path, profile selection, depth choice or specification change follows from this measurement.",
  ] };
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) { writeFileSync(resolve(root, out), text); console.error(`report written to ${out}`); }
process.stdout.write(text);
