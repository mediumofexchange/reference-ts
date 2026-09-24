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
//     [--delay 250] [--state scratch/ergo-latency/run.json] [--resume] [--offline] [--out <report>]
//   node experiments/ergo-range/latency.mjs --report-only [--state ...] [--offline] [--out <report>]
//     recomputes the report from a recorded state; only the chain check reads the node, and --offline skips it.
//     --pair <other state> adds, for transactions both observations timed, how much earlier or later this node saw them.
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
const resume = args.includes("--resume"), reportOnly = args.includes("--report-only"), offline = args.includes("--offline");
const pairFile = option("--pair") === undefined ? undefined : resolve(root, option("--pair"));
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
const saveRetrying = state => {
  for (let attempt = 0; ; attempt++) {
    try { return save(state); } catch (error) { if (attempt >= 5) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * 2 ** attempt); }
  }
};
const save = state => { mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(`${stateFile}.tmp`, JSON.stringify(state)); renameSync(`${stateFile}.tmp`, stateFile); };

// One transaction's timing. k counts from the node's height read at the start of the round whose pool read first held
// it; kHigh from the height at the previous successful round, whose pool read did not hold it, so kHigh bounds k from
// above for a submission to this node. k is not a strict lower bound: a block arriving between the round's height read
// and its pool read makes the true k one less. Sightings present in the first round are excluded (their submission is
// unknown); sightings after a gap in the rounds keep a wider bracket and are reported separately.
function timing(tx, block) {
  return { k: block.height - tx.tip, kHigh: block.height - tx.previousTip, seconds: (block.timestamp - tx.firstSeen) / 1000 };
}

// Nearest-rank quantiles at floor(p·n): the upper median for an even count, and p99 is the maximum below 100 values.
const quantiles = values => {
  const v = [...values].sort((a, b) => a - b), q = p => v.length === 0 ? null : v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, min: v[0] ?? null, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: v.at(-1) ?? null };
};
const histogram = values => { const h = {}; for (const v of values) h[v] = (h[v] ?? 0) + 1; return h; };
const ratio = (a, b) => b === 0 ? null : +(a / b).toFixed(4);
// The fraction of sightings that would have had force at each depth: included with 1 <= k <= depth + 2 (C3.3). "all"
// counts every timed sighting, so a dropped transaction counts as a miss; a pending one counts as a miss only once the
// window observed after its sighting passed depth + 2 blocks, and is censored (left out) before. "included" conditions on
// inclusion. The plain fractions use k; the "Pessimistic" ones use kHigh.
function withinWindow(rows, lastHeight) {
  const included = rows.filter(r => r.k !== undefined);
  const inWindow = (r, d, key) => r[key] >= 1 && r[key] <= d + 2;
  return Object.fromEntries(DEPTHS.map(d => {
    const counted = rows.filter(r => r.outcome !== "pending" || lastHeight - r.tip >= d + 2).length;
    const low = included.filter(r => inWindow(r, d, "k")).length, high = included.filter(r => inWindow(r, d, "kHigh")).length;
    return [d, { all: ratio(low, counted), allPessimistic: ratio(high, counted), included: ratio(low, included.length),
      includedPessimistic: ratio(high, included.length), counted }];
  }));
}
const sizeBucket = size => size < 1024 ? "<1KiB" : size < 4096 ? "1-4KiB" : size < 16384 ? "4-16KiB" : ">=16KiB";
// nanoERG per byte; the minimum fee of 1,000,000 nanoERG is about 1,000 a byte at 1 KiB, and a four-piece publication
// at the suggested 1,100,000 fee is about 68 a byte.
const rateBucket = rate => rate === 0 ? "0" : rate < 1000 ? "1-999" : rate < 4000 ? "1000-3999" : ">=4000";

export function summarize(state) {
  const blocks = Object.values(state.blocks).sort((a, b) => a.height - b.height);
  const includedAt = new Map();
  for (const block of blocks) for (const [position, id] of block.transactions.entries()) if (!includedAt.has(id)) includedAt.set(id, { block, position });
  const seen = Object.entries(state.seen).map(([id, tx]) => ({ id, ...tx }));
  const timed = seen.filter(tx => !tx.presentAtStart && tx.firstSeen <= state.admitUntil);
  const rows = timed.map(tx => {
    const inclusion = includedAt.get(tx.id);
    const row = { id: tx.id, tip: tx.tip, afterGap: tx.afterGap, size: tx.size, fee: tx.fee, rate: tx.size ? Math.floor(tx.fee / tx.size) : null };
    if (inclusion === undefined) return { ...row, outcome: state.pool.includes(tx.id) ? "pending" : "dropped" };
    return { ...row, outcome: "included", ...timing(tx, inclusion.block), position: inclusion.position };
  });
  const included = rows.filter(r => r.outcome === "included");
  const firstHeight = blocks[0]?.height, lastHeight = blocks.at(-1)?.height, observedIds = new Set(seen.map(tx => tx.id));
  // Transactions in blocks after the first round that the pool never showed: included before a round could see them,
  // or never broadcast to this node (a miner's own). Coinbase-style transactions are among them.
  const firstTip = Math.min(...seen.filter(tx => tx.presentAtStart).map(tx => tx.tip), ...seen.map(tx => tx.tip));
  const unseen = blocks.filter(b => b.height > firstTip).flatMap(b => b.transactions.filter(id => !observedIds.has(id)));
  // Offline linkage of the recorded blocks where their parent ids were recorded.
  const linked = blocks.slice(1).filter((b, i) => b.parentId !== undefined && b.height === blocks[i].height + 1);
  const recordedLinkage = { pairs: linked.length, broken: linked.filter((b, i) => b.parentId !== state.blocks[b.height - 1].id).map(b => b.height) };
  const intervals = blocks.slice(1).map((b, i) => (b.timestamp - blocks[i].timestamp) / 1000);
  const strata = (key, bucket) => Object.fromEntries([...new Set(rows.filter(r => r[key] !== null).map(r => bucket(r[key])))].sort().map(name => {
    const group = rows.filter(r => r[key] !== null && bucket(r[key]) === name);
    return [name, { sightings: group.length, included: group.filter(r => r.outcome === "included").length, k: quantiles(group.filter(r => r.k !== undefined).map(r => r.k)),
      withinDepth2: withinWindow(group, lastHeight)[2], withinDepth10: withinWindow(group, lastHeight)[10] }];
  }));
  return {
    rounds: state.rounds, failedRounds: state.failedRounds, maxRoundGapSeconds: state.maxRoundGap / 1000,
    window: { firstHeight, lastHeight, blocks: blocks.length, startedAt: new Date(state.startedAt).toISOString(),
      admitUntil: new Date(state.admitUntil).toISOString(), endedAt: state.endedAt === undefined ? null : new Date(state.endedAt).toISOString(), reorganizedHeights: state.reorganized },
    blockIntervalSeconds: quantiles(intervals), transactionsPerBlock: quantiles(blocks.map(b => b.transactions.length)),
    blocksWithOnlyOneTransaction: blocks.filter(b => b.transactions.length === 1).length,
    pool: { sizePerRound: quantiles(state.poolSizes) },
    sightings: { total: seen.length, presentAtStart: seen.filter(tx => tx.presentAtStart).length, afterGap: seen.filter(tx => tx.afterGap).length,
      timed: rows.length, timedAfterGap: rows.filter(r => r.afterGap).length, included: included.length, dropped: rows.filter(r => r.outcome === "dropped").length, pending: rows.filter(r => r.outcome === "pending").length,
      detailMissing: seen.filter(tx => tx.size === null).length, detailMissingIncluded: included.filter(r => r.size === null).length,
      belowWindow: included.filter(r => r.k < 1).length },
    includedUnseen: unseen.length, recordedLinkage,
    k: { low: quantiles(included.map(r => r.k)), high: quantiles(included.map(r => r.kHigh)), histogram: histogram(included.map(r => r.k)) },
    secondsToBlockTimestamp: quantiles(included.map(r => r.seconds)),
    withinWindowByDepth: withinWindow(rows, lastHeight),
    bySize: strata("size", sizeBucket), byFeePerByte: strata("rate", rateBucket),
    note: "k is the inclusion height less the node's full height read at the start of the round whose pool read first held the transaction; kHigh uses the previous round's height and bounds k from above for a submission to this node, while the true k can be one below k when a block arrived within the round. Under C3.3 a demand authorized at the tip has force for 1 <= k <= depth + 2. 'all' counts dropped sightings as misses and pending ones as misses once depth + 2 blocks were observed after the sighting (censored before; 'counted' is the denominator); 'included' conditions on inclusion; 'Pessimistic' fractions use kHigh. Sightings after a gap in the rounds (timedAfterGap) are included; across a gap k is only a lower bound. Quantiles are nearest-rank at floor(p*n). Fee per byte is nanoERG per serialized byte; a sighting whose detail was gone (usually just included) has no size and is left out of the strata.",
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
        state.blocks[header.height] = { height: header.height, id: header.id, parentId: header.parentId, timestamp: header.timestamp, bytes: body.size, transactions: body.transactions.map(t => t.id) };
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
        await readBlocks(Math.min(state.lastHeight, now.height - REORG_WINDOW), now.height);
        state.lastHeight = now.height;
      }
      const pool = await get(nodeUrl, "/transactions/unconfirmed/transactionIds"), poolReadAt = Date.now();
      const admitting = poolReadAt <= state.admitUntil, last = state.lastPoolReadAt ?? state.lastRoundAt, gap = last !== undefined && poolReadAt - last > 3 * pollSeconds * 1000;
      for (const id of pool) {
        if (state.seen[id] !== undefined || !admitting) continue;
        state.seen[id] = { firstSeen: poolReadAt, tip: now.height, previousTip: state.previousTip ?? now.height, presentAtStart: state.rounds === 0,
          afterGap: gap, ...(await detail(id)) };
      }
      state.pool = pool;
      state.poolSizes.push(pool.length);
      if (state.lastRoundAt !== undefined) state.maxRoundGap = Math.max(state.maxRoundGap, started - state.lastRoundAt);
      state.lastRoundAt = started; state.lastPoolReadAt = poolReadAt; state.previousTip = now.height; state.rounds++;
      if (state.rounds % 30 === 0) console.error(`  round ${state.rounds}: height ${now.height}, pool ${pool.length}, sightings ${Object.keys(state.seen).length}`);
    } catch (error) {
      state.failedRounds++; failures++;
      console.error(`  round failed: ${String(error.message ?? error).slice(0, 160)}`);
    }
    saveRetrying(state);
    await sleep(Math.max(0, pollSeconds * 1000 - (Date.now() - started)));
  }
  state.endedAt = Date.now();
  // Reconcile the whole window against the node's final best chain, up to its current tip. A failure here leaves the
  // state resumable: --resume goes straight back to this step.
  const heights = Object.keys(state.blocks).map(Number);
  try { await readBlocks(Math.min(...heights) - 1, Math.max(Math.max(...heights), (await tip()).height)); }
  catch (error) { saveRetrying(state); throw error; }
  saveRetrying(state);
}

// The report's chain check: the observing node's best chain from below the window to its current tip links by parent id,
// ends at the tip it reports (a chainSlice upper bound can fall back to another header; ERGO_NODE_PREFLIGHT), and holds
// exactly the recorded block ids; then a second node's header ids are compared over the window.
async function slice(base, low, high) {
  const headers = [];
  for (let a = low; a < high; a += 50) headers.push(...await get(base, `/blocks/chainSlice?fromHeight=${a}&toHeight=${Math.min(a + 50, high)}`));
  return headers;
}
async function checkChain(state) {
  const heights = Object.keys(state.blocks).map(Number), low = Math.min(...heights), high = Math.max(...heights), base = state.nodeUrl;
  const info = await get(base, "/info");
  const headers = await slice(base, low - 1, info.fullHeight);
  const unlinked = headers.slice(1).filter((h, i) => h.parentId !== headers[i].id || h.height !== headers[i].height + 1).map(h => h.height);
  const window = headers.filter(h => h.height <= high);
  const mismatched = window.filter(h => state.blocks[h.height]?.id !== h.id).map(h => h.height);
  const check = { node: base, heights: window.length, expected: high - low + 1, mismatched, unlinked,
    toTip: { height: info.fullHeight, endsAtReportedTip: headers.at(-1)?.id === info.bestFullHeaderId } };
  const compared = { node: compareUrl, heights: 0, agree: 0, disagree: [] };
  try {
    for (const header of await slice(compareUrl, low - 1, high)) {
      if (state.blocks[header.height] === undefined) continue;
      compared.heights++;
      if (state.blocks[header.height].id === header.id) compared.agree++; else compared.disagree.push(header.height);
    }
  } catch (error) { compared.error = String(error.message ?? error).slice(0, 200); }
  return { ...check, compared };
}

let state;
if (reportOnly || resume) state = load();
else {
  assert(!existsSync(stateFile), `a state file exists at ${stateFile}; pass --resume or choose another --state`);
  const now = Date.now();
  state = { startedAt: now, admitUntil: now + hours * 3600000, nodeUrl, collector: { files, argv: args }, rounds: 0, failedRounds: 0, maxRoundGap: 0, blocks: {}, seen: {}, pool: [], poolSizes: [], reorganized: [] };
  save(state);
}
if (!reportOnly) await observe(state);
const chain = offline ? null : await checkChain(state);

// Two observations over one period from two nodes: for each transaction both timed (neither present at its start), the
// difference in first sighting (this less the other, seconds, including each node's poll phase) and in k. A positive
// difference means the other node saw it first; the spread bounds how much a single node's sighting lags submission.
function pairWith(other) {
  const mine = Object.entries(state.seen).filter(([, t]) => !t.presentAtStart), theirs = other.seen;
  const both = mine.filter(([id]) => theirs[id] !== undefined && !theirs[id].presentAtStart);
  const seconds = both.map(([id, t]) => (t.firstSeen - theirs[id].firstSeen) / 1000);
  const tips = both.map(([id, t]) => t.tip - theirs[id].tip);
  return { other: { nodeUrl: other.nodeUrl, collector: other.collector ?? null }, timedHere: mine.length, timedThere: Object.values(theirs).filter(t => !t.presentAtStart).length,
    both: both.length, firstSeenDifferenceSeconds: quantiles(seconds), seenFirstHere: seconds.filter(x => x < 0).length,
    tipDifferenceAtSighting: histogram(tips), note: "differences are this observation less the other; each includes the two pollers' phase within one poll interval" };
}
const pair = pairFile === undefined ? null : { stateSha256: sha256(readFileSync(pairFile)), ...pairWith(JSON.parse(readFileSync(pairFile, "utf8"))) };

// The chain check decides the status and exit code: recorded blocks the node's chain does not hold at their
// heights, headers that do not link, a missing height or a slice that stops short of the reported tip each fail it.
const chainFailed = chain !== null && (chain.mismatched.length > 0 || chain.unlinked.length > 0 ||
  chain.heights !== chain.expected || !chain.toTip.endsAtReportedTip);
const report = { status: chainFailed ? "chain-check-failed" : "mainnet-observed-passively", node: process.version, nodeUrl: state.nodeUrl, nodeInfo: state.node,
  chain, pair, requests, failedRequests: failures, stateSha256: sha256(readFileSync(stateFile)), collector: state.collector ?? null, reportedBy: files,
  settings: reportOnly ? null : { hours, tailMinutes, pollSeconds, delayMs, reorgWindow: REORG_WINDOW }, ...summarize(state),
  limitations: [
    "One public node's pool and chain: a transaction is timed from this node's first sighting, which follows its submission elsewhere by the propagation delay and up to one poll interval; kHigh bounds k from above only for a submission to this node, and k can be one too high when a block arrived within the sighting round. The node's own lag behind the network adds error of unknown sign.",
    "Transactions included before any round saw them (includedUnseen) are never timed, and a sighting whose detail was already gone has no size or fee: both remove fast inclusions, so the fractions lean pessimistic on that account.",
    "k counts from the observing node's sighting, not from a holder's authorization: the time a holder spends proving and propagating after fixing the instant uses the same margin and is not measured, so the fractions are optimistic on that account.",
    "Block timestamps are set by miners; seconds are indicative only.",
    "The population is mainnet transactions of every shape and fee over this window, not a kind-4 publication; a holder's own node, submission path and proving time are not measured.",
    "Dropped means the node's pool stopped holding a transaction that no block in the window included (a double spend, an invalid chain or eviction) and counts as a miss in 'all'; a pending transaction was still held when the tail ended and is censored at depths whose window had not passed.",
    "Headers come from the observing node; the chain check covers parent linkage and the recorded ids, and one second node's header ids are compared; proof of work and chain selection are not checked.",
    "One day of one venue's traffic, dominated by automated and chained transactions; no weekly pattern or congestion episode is covered.",
    "No runtime path, profile selection, depth choice or specification change follows from this measurement.",
  ] };
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) { writeFileSync(resolve(root, out), text); console.error(`report written to ${out}`); }
process.stdout.write(text);
if (chainFailed) { console.error("the chain check failed; see report.chain"); process.exitCode = 1; }
