// Summarizes probe 3 (fetch3.mjs) into one JSON report. Usage: node summary3.mjs <out dir>
// Groups follow probe 1: the pools on AntPool's templates exclude records, OCEAN and Braiins include
// some, the rest include them. A record is a transaction with an OP_RETURN over 83 B or several
// OP_RETURN outputs (block.mjs). "Ordinary" is every other non-coinbase transaction.
import { readFileSync } from 'node:fs';
import { BANDS, band } from './block.mjs';

const out = process.argv[2];
const blocks = readFileSync(`${out}/probe3.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).sort((a, b) => a.height - b.height);
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
for (const b of blocks) {
  const G = g[group(b.pool)];
  G.blocks++;
  for (const r of b.records) {
    G.records++;
    if (r.unseen) G.recordsUnseen++;
    if (r.added) G.recordsAdded++;
    if (r.accelerated) G.recordsAccelerated++;
    if (r.inTemplate) { G.recordsInTemplate++; G.recordInTemplateBands[band(r.rate)]++; }
  }
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
const blocksWaited = seenRecords.map((r) => times.filter((t, i) => blocks[i].height < r.height && t > r.firstSeen).length);
const missesPerRecord = (G) => seenRecords.map((r) => r.misses.filter((x) => x === G).length);
const mean = (xs) => (xs.length ? +(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(3) : null);
const dist = (xs, cap = 6) => { const d = Array(cap + 1).fill(0); for (const x of xs) d[Math.min(cap, x)]++; return d; };

const bySize = {};
for (const r of records.values()) {
  const c = (bySize[sizeClass(r)] ??= { records: 0, unseen: 0, seen: 0, inTemplate: 0, misses: 0, missesAntpoolTemplates: 0 });
  c.records++;
  if (r.unseen) c.unseen++; else c.seen++;
  if (r.inTemplate) c.inTemplate++;
  c.misses += r.misses.length;
  c.missesAntpoolTemplates += r.misses.filter((x) => x === 'antpoolTemplates').length;
}

console.log(JSON.stringify({
  window: { start: START, end: END, days: +((blocks.at(-1).time - blocks[0].time) / 86400).toFixed(3) },
  host: readFileSync('/proc/cpuinfo', 'utf8').match(/model name\s*:\s*(.*)/)?.[1] ?? null, node: process.version,
  suppliers: { rawBlocks: 'blockstream.info (verified by block.mjs)', auditAndSummary: 'mempool.space (summary txids checked against the parsed block)' },
  templateAlgorithms: [...new Set(blocks.map((b) => b.templateAlgorithm))],
  summaryWithoutTimes: blocks.filter((b) => b.summaryTimes * 2 < b.txCount).length,
  records: records.size, recordsSeen: seenRecords.length, bySize,
  groups: Object.fromEntries(GROUPS.map((k) => {
    const G = g[k];
    return [k, {
      blocks: G.blocks, records: G.records, recordsUnseen: G.recordsUnseen, recordsUnseenShare: ratio(G.recordsUnseen, G.records),
      ordinaryUnseenShare: ratio(G.ordinaryUnseen, G.ordinary), recordsAdded: G.recordsAdded, recordsAccelerated: G.recordsAccelerated,
      recordsInTemplate: G.recordsInTemplate, recordMisses: G.recordMisses, skip: skip(G),
    }];
  })),
  misses: {
    meanPerSeenRecord: Object.fromEntries(GROUPS.map((k) => [k, mean(missesPerRecord(k))])),
    distributionAntpoolTemplates: dist(missesPerRecord('antpoolTemplates')),
    distributionIncluding: dist(missesPerRecord('including')),
  },
  blocksWaited: { mean: mean(blocksWaited), distribution: dist(blocksWaited, 10) },
  latency,
}, null, 1));
