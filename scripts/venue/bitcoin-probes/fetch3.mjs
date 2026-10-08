// Probe 3, read-only (Next 12): over probe 2's week, finds every record candidate (an OP_RETURN over
// 83 B or several OP_RETURN outputs) with our own parser, and joins mempool.space's block audit (its
// projected template with first-seen times, the unseen and missing lists) and per-transaction summary
// (fee rate, first-seen time). Raw blocks come from supplier B and are verified; A's summary must list
// exactly the parsed txids in order. Resumable: one line per block in out/probe3.jsonl.
// Usage: node fetch3.mjs <out dir> [at most this many blocks]
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { verifyBlock, BANDS, band } from './block.mjs';

const A = 'https://mempool.space/api';
const B = 'https://blockstream.info/api';
const START = 969497; // probe 2's week (VENUE_ALTERNATIVES.md, results of probes 1 and 2)
const END = 970504;
const CONCURRENCY = 3;

const [out, limit] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const file = `${out}/probe3.jsonl`;

async function get(url, kind) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url);
      if (r.ok) return kind === 'raw' ? Buffer.from(await r.arrayBuffer()) : kind === 'json' ? r.json() : r.text();
      if (attempt >= 6 || (r.status < 500 && r.status !== 429)) throw new Error(`${r.status} ${url}`);
    } catch (e) {
      if (attempt >= 6) throw e;
    }
    await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
  }
}

const poolsFile = `${out}/pools3.json`;
if (!existsSync(poolsFile)) {
  const pools = {};
  for (let h = END; h >= START; h -= 15) {
    for (const b of await get(`${A}/v1/blocks/${h}`, 'json')) {
      if (b.height >= START && b.height <= END) pools[b.height] = { hash: b.id, pool: b.extras?.pool?.name ?? 'unknown' };
    }
  }
  writeFileSync(poolsFile, JSON.stringify(pools));
}
const pools = JSON.parse(readFileSync(poolsFile, 'utf8'));

const seen = new Set();
if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n')) if (line) seen.add(JSON.parse(line).height);
const heights = [];
for (let h = START; h <= END; h++) if (!seen.has(h)) heights.push(h);
if (limit) heights.splice(Number(limit));

async function one(height) {
  const { hash, pool } = pools[height];
  const raw = await get(`${B}/block/${hash}/raw`, 'raw');
  const v = verifyBlock(raw, height);
  if (v.header.hash !== hash) throw new Error(`${height}: B served ${v.header.hash} for ${hash}`);
  // Some of A's backends serve the summary without first-seen times: ask again (up to three times).
  let summary;
  for (let k = 0; k < 3; k++) {
    summary = await get(`${A}/v1/block/${hash}/summary`, 'json');
    if (summary.filter((t) => t.time != null).length * 2 >= summary.length) break;
  }
  if (summary.length !== v.txids.length || summary.some((t, i) => t.txid !== v.txids[i])) throw new Error(`${height}: A's summary differs from the parsed block`);
  const audit = await get(`${A}/v1/block/${hash}/audit-summary`, 'json');
  if (audit.id !== hash || audit.height !== height) throw new Error(`${height}: audit names another block`);
  const template = new Map(audit.template.map((t) => [t.txid, t]));
  const sets = Object.fromEntries(['unseenTxs', 'addedTxs', 'freshTxs', 'acceleratedTxs', 'prioritizedTxs'].map((k) => [k, new Set(audit[k] ?? [])]));
  const recordIds = new Set(v.records.map((r) => r.txid));
  // First sight: the template's time where the transaction was in it, else the summary's.
  const firstSeen = (s) => template.get(s.txid)?.time ?? s.time ?? null;
  const records = v.records.map((r) => {
    const s = summary[r.index];
    return {
      ...r, rate: s.rate, vsize: s.vsize, fee: s.fee, firstSeen: firstSeen(s), inTemplate: template.has(r.txid),
      unseen: sets.unseenTxs.has(r.txid), added: sets.addedTxs.has(r.txid), fresh: sets.freshTxs.has(r.txid),
      accelerated: sets.acceleratedTxs.has(r.txid), prioritized: sets.prioritizedTxs.has(r.txid),
    };
  });
  // Ordinary transactions (not coinbase, not record candidates) by fee band: how many, how many unseen,
  // and the minutes from first sight to this block's timestamp.
  const ordinary = BANDS.map(() => ({ n: 0, unseen: 0, inTemplate: 0, ages: {} }));
  for (let i = 1; i < summary.length; i++) {
    const s = summary[i];
    if (recordIds.has(s.txid)) continue;
    const o = ordinary[band(s.rate)];
    o.n++;
    if (sets.unseenTxs.has(s.txid)) o.unseen++;
    if (template.has(s.txid)) o.inTemplate++;
    const t = firstSeen(s);
    if (t != null) { const m = Math.floor((v.header.time - t) / 60); o.ages[m] = (o.ages[m] ?? 0) + 1; }
  }
  // The template's entries by band, and every entry the block left out (missing).
  const templateBands = BANDS.map(() => 0);
  for (const t of audit.template) templateBands[band(t.rate)]++;
  const missing = (audit.missingTxs ?? []).map((id) => { const t = template.get(id); return { txid: id, rate: t?.rate ?? null, firstSeen: t?.time ?? null }; });
  appendFileSync(file, `${JSON.stringify({
    height, hash, pool, time: v.header.time, txCount: v.txCount, matchRate: audit.matchRate, templateAlgorithm: audit.templateAlgorithm,
    templateSize: audit.template.length, summaryTimes: summary.filter((t) => t.time != null).length, unseen: sets.unseenTxs.size, added: sets.addedTxs.size, opReturnOver83: v.opReturnOver83,
    records, missing, templateBands, ordinary,
    mined: v.txids.slice(1).map((t) => t.slice(0, 12)).join(''),
  })}\n`);
}

let next = 0;
let failed = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < heights.length) {
    const h = heights[next++];
    try { await one(h); } catch (e) { failed++; console.error(`${h}: ${e.message}`); }
  }
}));
console.log(`probe 3: ${heights.length - failed} of ${heights.length} blocks written, ${failed} failed`);
if (failed) process.exit(1);
