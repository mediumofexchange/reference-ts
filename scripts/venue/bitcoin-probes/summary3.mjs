// Summarizes probe 3 (fetch3.mjs) into one JSON report. Usage: node summary3.mjs <out dir>
// Groups follow probe 1: the pools on AntPool's templates exclude records, OCEAN and Braiins include
// some, the rest include them. A record is a transaction with an OP_RETURN over 83 B or several
// OP_RETURN outputs (block.mjs). "Ordinary" is every other non-coinbase transaction. A "skip" is an
// entry of the audit's missingTxs: mempool.space's "censored" list, which leaves out transactions under
// 1 sat/vB, ones first seen within 180 s, replaced ones, and the template's low-fee tail when the block
// carried other weight. A thin block (under half its template's transactions; empty blocks among them)
// is counted apart from every skip statistic, since its audit lists all or none of its template.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BANDS, band } from './block.mjs';

const out = process.argv[2];
const input = readFileSync(`${out}/probe3.jsonl`);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sources = Object.fromEntries(['block.mjs', 'fetch3.mjs', 'summary3.mjs'].map((f) => [f, sha256(readFileSync(new URL(f, import.meta.url)))]));
const blocks = input.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).sort((a, b) => a.height - b.height);
const START = 969497;
const END = 970504;
if (blocks.length !== END - START + 1 || blocks[0].height !== START) throw new Error(`incomplete: ${blocks.length} blocks`);

const EXCLUDING = new Set(['AntPool', 'SECPOOL', 'Luxor', 'BTC.com', 'Binance Pool', 'WhitePool', 'Poolin', 'ULTIMUSPOOL']);
const group = (pool) => (EXCLUDING.has(pool) ? 'antpoolTemplates' : pool === 'OCEAN' ? 'ocean' : pool === 'Braiins Pool' ? 'braiins' : 'including');
const GROUPS = ['including', 'antpoolTemplates', 'ocean', 'braiins'];
const zeros = () => BANDS.map(() => 0);
const sizeClass = (r) => (r.largest >= 1000 ? 'atLeast1000' : r.largest >= 139 ? '139to999' : r.largest > 83 ? '84to138' : 'multiSmall');

// Every record, where it was mined, and every mined txid (12 hex digits) in the week.
const records = new Map();
const mined = new Set();
for (const b of blocks) {
  for (let i = 0; i < b.mined.length; i += 12) mined.add(b.mined.slice(i, i + 12));
  for (const r of b.records) records.set(r.txid, { ...r, height: b.height, time: b.time, pool: b.pool, group: group(b.pool), misses: [] });
}

const g = Object.fromEntries(GROUPS.map((k) => [k, {
  blocks: 0, records: 0, recordsUnseen: 0, recordsAdded: 0, recordsAccelerated: 0, recordsInTemplate: 0, recordMisses: 0,
  ordinary: 0, ordinaryUnseen: 0, ordinaryInTemplate: zeros(), ordinaryMisses: zeros(), recordInTemplateBands: zeros(), recordMissBands: zeros(),
  ordinaryAges: BANDS.map(() => ({})),
}]));
// Per pool: blocks, records mined from its template, and records it left out of its template.
// A full skip: a block (not thin) that left out at least one record and mined none from its template.
const thin = (b) => b.txCount * 2 < b.templateSize;
const perPool = {};
const thinBlocks = [];
let unminedMissing = 0;
let allMissing = 0;
for (const b of blocks) {
  const G = g[group(b.pool)];
  const P = (perPool[b.pool] ??= { blocks: 0, thinBlocks: 0, recordsMined: 0, recordsInTemplate: 0, recordMisses: 0, fullSkipBlocks: 0 });
  P.blocks++;
  P.recordsMined += b.records.length;
  G.blocks++;
  for (const r of b.records) {
    G.records++;
    if (r.unseen) G.recordsUnseen++;
    if (r.added) G.recordsAdded++;
    if (r.accelerated) G.recordsAccelerated++;
  }
  for (const m of b.missing) { allMissing++; if (!mined.has(m.txid.slice(0, 12))) unminedMissing++; }
  const recordMisses = b.missing.filter((m) => records.has(m.txid)).length;
  const recordsInTemplate = b.records.filter((r) => r.inTemplate).length;
  if (thin(b)) {
    P.thinBlocks++;
    thinBlocks.push({ height: b.height, pool: b.pool, txCount: b.txCount, templateSize: b.templateSize, missing: b.missing.length, recordMisses });
    G.ordinary += b.ordinary.reduce((n, o) => n + o.n, 0);
    G.ordinaryUnseen += b.ordinary.reduce((n, o) => n + o.unseen, 0);
    b.ordinary.forEach((o, k) => { for (const [m, c] of Object.entries(o.ages)) G.ordinaryAges[k][m] = (G.ordinaryAges[k][m] ?? 0) + c; });
    continue;
  }
  P.recordsInTemplate += recordsInTemplate;
  P.recordMisses += recordMisses;
  if (recordMisses > 0 && recordsInTemplate === 0) P.fullSkipBlocks++;
  if (recordMisses > 0 || recordsInTemplate > 0) P.informativeBlocks = (P.informativeBlocks ?? 0) + 1;
  for (const r of b.records) if (r.inTemplate) { G.recordsInTemplate++; G.recordInTemplateBands[band(r.rate)]++; }
  b.ordinary.forEach((o, k) => {
    G.ordinary += o.n;
    G.ordinaryUnseen += o.unseen;
    G.ordinaryInTemplate[k] += o.inTemplate;
    for (const [m, c] of Object.entries(o.ages)) G.ordinaryAges[k][m] = (G.ordinaryAges[k][m] ?? 0) + c;
  });
  for (const m of b.missing) {
    const r = records.get(m.txid);
    if (r) { G.recordMisses++; G.recordMissBands[band(m.rate ?? r.rate)]++; r.misses.push(group(b.pool)); }
    else if (mined.has(m.txid.slice(0, 12)) && m.rate != null) G.ordinaryMisses[band(m.rate)]++;
  }
}

const ratio = (a, b) => (b ? +(a / b).toFixed(4) : null);
// Probability that a block of the group leaves out a transaction it had in its template: records,
// ordinary transactions per band, and ordinary ones reweighted to the records' band mix.
const skip = (G) => {
  const perBand = BANDS.map((_, k) => ratio(G.ordinaryMisses[k], G.ordinaryMisses[k] + G.ordinaryInTemplate[k]));
  const weights = BANDS.map((_, k) => G.recordMissBands[k] + G.recordInTemplateBands[k]);
  const w = weights.reduce((s, x) => s + x, 0);
  const matched = w ? +(perBand.reduce((s, p, k) => s + (p ?? 0) * weights[k], 0) / w).toFixed(4) : null;
  return { records: ratio(G.recordMisses, G.recordMisses + G.recordsInTemplate), ordinaryBandMatched: matched, ordinaryPerBand: perBand };
};

const quantiles = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null);
  return { n: s.length, p50: q(0.5), p90: q(0.9), p99: q(0.99) };
};
const histQuantiles = (h) => {
  const entries = Object.entries(h).map(([m, c]) => [Number(m), c]).sort((a, b) => a[0] - b[0]);
  const n = entries.reduce((s, [, c]) => s + c, 0);
  const q = (p) => { let acc = 0; for (const [m, c] of entries) { acc += c; if (acc > p * n) return m; } return null; };
  return { n, p50: q(0.5), p90: q(0.9), p99: q(0.99) };
};

// Minutes from first sight to the including block's timestamp, records against ordinary transactions
// of the same band mined by the including group, and blocks waited (window blocks after first sight).
const times = blocks.map((b) => b.time);
const seenRecords = [...records.values()].filter((r) => r.firstSeen != null);
const latency = BANDS.map((lo, k) => {
  const rs = seenRecords.filter((r) => band(r.rate) === k);
  const merged = {};
  for (const G of GROUPS) for (const [m, c] of Object.entries(g[G].ordinaryAges[k])) merged[m] = (merged[m] ?? 0) + c;
  return {
    band: `>=${lo}`, recordMinutes: quantiles(rs.map((r) => Math.floor((r.time - r.firstSeen) / 60))),
    ordinaryMinutes: histQuantiles(merged), ordinaryMinutesIncluding: histQuantiles(g.including.ordinaryAges[k]),
  };
});
// Blocks waited: the week's blocks before the including one whose timestamp follows first sight,
// capped at CAP (a scan back stops two hours of timestamps before first sight). Ordinary ages are
// minute buckets, so their first sight is the bucket's middle. Blocks waited counts only
// transactions mined from the week's (CAP + 1)th block on, so the cap is never cut short by the window's start.
const CAP = 10;
const waited = (i, firstSeen) => {
  let n = 0;
  for (let j = i - 1; j >= 0 && n < CAP && times[j] > firstSeen - 7200; j--) if (times[j] > firstSeen) n++;
  return n;
};
const indexOf = new Map(blocks.map((b, i) => [b.height, i]));
const blocksWaited = seenRecords.map((r) => waited(indexOf.get(r.height), r.firstSeen));
const counted = blocksWaited.filter((_, k) => indexOf.get(seenRecords[k].height) >= CAP);
const recordWaitBands = BANDS.map(() => Array(CAP + 1).fill(0));
seenRecords.forEach((r, k) => { if (indexOf.get(r.height) >= CAP) recordWaitBands[band(r.rate)][blocksWaited[k]]++; });
const ordinaryWaitBands = BANDS.map(() => Array(CAP + 1).fill(0));
blocks.forEach((b, i) => i >= CAP && b.ordinary.forEach((o, k) => {
  for (const [m, c] of Object.entries(o.ages)) ordinaryWaitBands[k][waited(i, b.time - Number(m) * 60 - 30)] += c;
}));
// Share mined within L blocks of first sight (waited < L), the lag C3.3's window must cover.
const LAGS = [1, 2, 3, 6];
const within = (d) => { const n = d.reduce((s, x) => s + x, 0); return Object.fromEntries(LAGS.map((L) => [L, n ? +(d.slice(0, L).reduce((s, x) => s + x, 0) / n).toFixed(4) : null])); };
const withinLag = BANDS.map((lo, k) => ({ band: `>=${lo}`, records: recordWaitBands[k].reduce((s, x) => s + x, 0), recordsWithin: within(recordWaitBands[k]), ordinaryWithin: within(ordinaryWaitBands[k]) }));
const missesPerRecord = (G) => seenRecords.map((r) => r.misses.filter((x) => x === G).length);
// Slice 16's geometric model, like for like: the mean number of excluding blocks before an including
// one is q/(1 - q), with q the share of informative blocks (not thin, holding a record in their template)
// that skipped every record they held.
const informative = Object.values(perPool).reduce((n, P) => n + (P.informativeBlocks ?? 0), 0);
const fullSkip = Object.values(perPool).reduce((n, P) => n + P.fullSkipBlocks, 0);
const qShare = fullSkip / informative;
const totalMisses = seenRecords.map((r) => r.misses.length);
const mean = (xs) => (xs.length ? +(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(3) : null);
const dist = (xs, cap = 6) => { const d = Array(cap + 1).fill(0); for (const x of xs) d[Math.min(cap, x)]++; return d; };

const waitOf = new Map(seenRecords.map((r, k) => [r.txid, indexOf.get(r.height) >= CAP ? blocksWaited[k] : null]));
const bySize = {};
for (const r of records.values()) {
  const c = (bySize[sizeClass(r)] ??= { records: 0, unseen: 0, seen: 0, inTemplate: 0, misses: 0, missesAntpoolTemplates: 0, largest: 0, waits: Array(CAP + 1).fill(0) });
  c.largest = Math.max(c.largest, r.largest);
  if (waitOf.get(r.txid) != null) c.waits[waitOf.get(r.txid)]++;
  c.records++;
  if (r.unseen) c.unseen++; else c.seen++;
  if (r.inTemplate) c.inTemplate++;
  c.misses += r.misses.length;
  c.missesAntpoolTemplates += r.misses.filter((x) => x === 'antpoolTemplates').length;
}

console.log(JSON.stringify({
  window: { start: START, end: END, days: +((blocks.at(-1).time - blocks[0].time) / 86400).toFixed(3) },
  input: { file: 'probe3.jsonl', sha256: sha256(input) }, sources,
  thinBlocks, missingEntries: allMissing, missingNeverMinedInWeek: unminedMissing,
  host: readFileSync('/proc/cpuinfo', 'utf8').match(/model name\s*:\s*(.*)/)?.[1] ?? null, node: process.version,
  suppliers: { rawBlocks: 'blockstream.info (verified by block.mjs)', auditAndSummary: 'mempool.space (summary txids checked against the parsed block)' },
  templateAlgorithms: [...new Set(blocks.map((b) => b.templateAlgorithm))],
  summaryWithoutTimes: blocks.filter((b) => b.summaryTimes * 2 < b.txCount).length,
  records: records.size, recordsSeen: seenRecords.length,
  bySize: Object.fromEntries(Object.entries(bySize).map(([k, { waits, ...c }]) => [k, { ...c, within: within(waits) }])),
  groups: Object.fromEntries(GROUPS.map((k) => {
    const G = g[k];
    return [k, {
      blocks: G.blocks, records: G.records, recordsUnseen: G.recordsUnseen, recordsUnseenShare: ratio(G.recordsUnseen, G.records),
      ordinaryUnseenShare: ratio(G.ordinaryUnseen, G.ordinary), recordsAdded: G.recordsAdded, recordsAccelerated: G.recordsAccelerated,
      recordsInTemplate: G.recordsInTemplate, recordMisses: G.recordMisses, skip: skip(G),
    }];
  })),
  pools: Object.entries(perPool).sort((a, b) => b[1].blocks - a[1].blocks).map(([pool, P]) => ({ pool, ...P, recordSkip: ratio(P.recordMisses, P.recordMisses + P.recordsInTemplate) })),
  misses: {
    meanPerSeenRecord: Object.fromEntries(GROUPS.map((k) => [k, mean(missesPerRecord(k))])),
    meanPerSeenRecordAll: mean(totalMisses),
    model: { informativeBlocks: informative, fullSkipBlocks: fullSkip, q: +qShare.toFixed(4), predictedMean: +(qShare / (1 - qShare)).toFixed(3) },
    distributionAntpoolTemplates: dist(missesPerRecord('antpoolTemplates')),
    distributionIncluding: dist(missesPerRecord('including')),
  },
  blocksWaited: { records: counted.length, mean: mean(counted), distribution: dist(counted, CAP) },
  withinLag,
  latency,
  largestRecords: [...records.values()].filter((r) => r.largest >= 10000).map((r) => ({ height: r.height, pool: r.pool, largest: r.largest, rate: +r.rate.toFixed(2), secondsFromFirstSight: r.firstSeen == null ? null : r.time - r.firstSeen })),
}, null, 1));
