// Summarizes the probes' output (fetch.mjs) into one JSON report. Usage: node summary.mjs <out dir>
import { readFileSync } from 'node:fs';
import { checkChain, bitsToTarget } from './block.mjs';

const out = process.argv[2];
const read = (f) => readFileSync(`${out}/${f}`, 'utf8');
const lines = (f) => read(f).split('\n').filter(Boolean).map((l) => JSON.parse(l)).sort((a, b) => a.height - b.height);
const window = JSON.parse(read('window.json'));
const pools = JSON.parse(read('pools.json'));
const A = lines('A.jsonl');
const B = lines('B.jsonl');
const headers = JSON.parse(read('headers.json'));

const expectCount = (rows, from) => { if (rows.length !== window.end - from + 1 || rows[0].height !== from) throw new Error('incomplete'); };
expectCount(A, window.start);
expectCount(B, window.weekStart);
for (const r of A) if (pools[r.height].hash !== r.hash) throw new Error(`pool list hash differs at ${r.height}`);

// Headers: the extension below the window, then the window's own (verified with their blocks).
const chain = [...headers, ...A].map((h) => ({ ...h, target: bitsToTarget(h.bits) }));
const { retargets } = checkChain(chain);

// Binomial lower tail P(X <= k) for n trials at p, summed in log space (p near 1 underflows otherwise).
function lowerTail(k, n, p) {
  if (p <= 0 || k >= n) return 1;
  if (p >= 1) return 0;
  const logs = [n * Math.log1p(-p)];
  for (let i = 0; i < k; i++) logs.push(logs[i] + Math.log((n - i) / (i + 1)) + Math.log(p / (1 - p)));
  const max = Math.max(...logs);
  return Math.min(1, Math.exp(max) * logs.reduce((s, l) => s + Math.exp(l - max), 0));
}

const signals = {
  over83: (r) => r.opReturnOver83 > 0,
  atLeast139: (r) => r.opReturnAtLeast139 > 0,
  multi: (r) => r.multiOpReturnTxs > 0,
  multiOver83: (r) => r.multiOpReturnOver83Txs > 0,
  envelope: (r) => r.envelopeInputs > 0,
};
const sum = (rows, k) => rows.reduce((s, r) => s + r[k], 0);
const byPool = new Map();
for (const r of A) {
  const p = pools[r.height].pool;
  if (!byPool.has(p)) byPool.set(p, []);
  byPool.get(p).push(r);
}
const rates = Object.fromEntries(Object.entries(signals).map(([k, f]) => [k, A.filter(f).length / A.length]));
const poolRows = [...byPool.entries()].sort((a, b) => b[1].length - a[1].length).map(([pool, rows]) => {
  const row = { pool, blocks: rows.length, share: +(rows.length / A.length).toFixed(4) };
  for (const [k, f] of Object.entries(signals)) {
    const obs = rows.filter(f).length;
    row[k] = { blocks: obs, expected: +(rates[k] * rows.length).toFixed(1), pLower: +lowerTail(obs, rows.length, rates[k]).toExponential(2) };
  }
  row.over83Outputs = sum(rows, 'opReturnOver83');
  row.multiTxs = sum(rows, 'multiOpReturnTxs');
  row.multiOver83Txs = sum(rows, 'multiOpReturnOver83Txs');
  row.opReturnMax = Math.max(...rows.map((r) => r.opReturnMax));
  return row;
});

const days = (rows) => (rows.at(-1).time - rows[0].time) / 86400;
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const week = A.filter((r) => r.height >= window.weekStart);
const agree = week.every((r, i) => r.rawSha256 === B[i].rawSha256 && r.hash === B[i].hash);
const supplier = (rows) => ({
  bytes: sum(rows, 'size'), fetchMsMedian: pct(rows.map((r) => r.fetchMs), 0.5),
  verifyMsMedian: pct(rows.map((r) => r.verifyMs), 0.5), verifyMsP99: pct(rows.map((r) => r.verifyMs), 0.99), verifyMsMax: Math.max(...rows.map((r) => r.verifyMs)),
  peakRssMiB: +(Math.max(...rows.map((r) => r.rss)) / 2 ** 20).toFixed(0),
});
const perDay = (rows) => {
  const d = days(rows);
  return {
    days: +d.toFixed(3), blocksPerDay: +(rows.length / d).toFixed(1),
    fullMBPerDay: +(sum(rows, 'size') / d / 1e6).toFixed(1), strippedMBPerDay: +(sum(rows, 'stripped') / d / 1e6).toFixed(1),
    verifyCpuSecondsPerDay: +(sum(rows, 'verifyMs') / d / 1000).toFixed(1),
    txPerDay: Math.round(sum(rows, 'txCount') / d),
  };
};

const totals = Object.fromEntries(['opReturnOutputs', 'opReturnBytes', 'opReturnOver83', 'opReturnOver83Bytes', 'opReturnAtLeast139', 'opReturnAtLeast1000', 'multiOpReturnTxs', 'multiOpReturnOver83Txs', 'envelopeInputs', 'envelopeBytes', 'tx64'].map((k) => [k, sum(A, k)]));
console.log(JSON.stringify({
  window, host: readFileSync('/proc/cpuinfo', 'utf8').match(/model name\s*:\s*(.*)/)?.[1], node: process.version,
  headers: { checked: chain.length, from: chain[0].height, to: chain.at(-1).height, retargets },
  probe1: { blocks: A.length, totals, maxOpReturn: Math.max(...A.map((r) => r.opReturnMax)), blockRates: rates, pools: poolRows },
  probe2: { suppliersAgree: agree, A: supplier(week), B: supplier(B), week: perDay(week), window2016: perDay(A) },
}, null, 1));
