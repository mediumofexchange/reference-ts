// Fetches and verifies the probes' window (Next 12): the last 2,016 mainnet blocks below tip−6 from
// supplier A (probe 1), the last 1,008 of them also from supplier B (probe 2), and the headers back
// to the period start that the window's first retarget needs. Resumable: each verified block is one
// line in out/<supplier>.jsonl. Usage: node fetch.mjs <out dir> [window|pools|A|B|headers]...
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyBlock, parseHeader } from './block.mjs';

const SUPPLIERS = { A: 'https://mempool.space/api', B: 'https://blockstream.info/api' };
const WINDOW = 2016;
const WEEK = 1008;
const CONCURRENCY = 4;

const [out, ...steps] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const path = (name) => `${out}/${name}`;

async function get(url, kind) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url);
      if (r.ok) return kind === 'raw' ? Buffer.from(await r.arrayBuffer()) : kind === 'json' ? r.json() : r.text();
      if (attempt >= 5 || (r.status < 500 && r.status !== 429)) throw new Error(`${r.status} ${url}`);
    } catch (e) {
      if (attempt >= 5) throw e;
    }
    await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
  }
}

async function pool(items, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

if (steps.includes('window') && !existsSync(path('window.json'))) {
  const tip = Number(await get(`${SUPPLIERS.A}/blocks/tip/height`, 'text'));
  const end = tip - 6;
  writeFileSync(path('window.json'), JSON.stringify({ tip, start: end - WINDOW + 1, end, weekStart: end - WEEK + 1, fixedAt: new Date().toISOString() }, null, 1));
}
const window = JSON.parse(readFileSync(path('window.json'), 'utf8'));

if (steps.includes('pools') && !existsSync(path('pools.json'))) {
  // Supplier A's attribution (its pool tags and coinbase addresses), 15 blocks a request.
  const pools = {};
  for (let h = window.end; h >= window.start; h -= 15) {
    for (const b of await get(`${SUPPLIERS.A}/v1/blocks/${h}`, 'json')) {
      if (b.height >= window.start && b.height <= window.end) pools[b.height] = { hash: b.id, pool: b.extras?.pool?.name ?? 'unknown' };
    }
  }
  writeFileSync(path('pools.json'), JSON.stringify(pools));
}

function done(file) {
  const seen = new Set();
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n')) if (line) seen.add(JSON.parse(line).height);
  return seen;
}

async function blocks(supplier, from) {
  const file = path(`${supplier}.jsonl`);
  const seen = done(file);
  const heights = [];
  for (let h = from; h <= window.end; h++) if (!seen.has(h)) heights.push(h);
  let peakRss = 0;
  await pool(heights, async (height) => {
    const hash = (await get(`${SUPPLIERS[supplier]}/block-height/${height}`, 'text')).trim();
    const t0 = performance.now();
    const raw = await get(`${SUPPLIERS[supplier]}/block/${hash}/raw`, 'raw');
    const t1 = performance.now();
    const v = verifyBlock(raw, height);
    const t2 = performance.now();
    if (v.header.hash !== hash) throw new Error(`${supplier} ${height}: served ${v.header.hash} for ${hash}`);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const { header, coinbaseScriptSig, ...stats } = v;
    appendFileSync(file, `${JSON.stringify({
      height, hash, prev: header.prev, time: header.time, bits: header.bits, version: header.version,
      rawSha256: createHash('sha256').update(raw).digest('hex'), fetchMs: Math.round(t1 - t0), verifyMs: +(t2 - t1).toFixed(2),
      rss: process.memoryUsage().rss, ...stats,
    })}\n`);
  });
  console.log(`${supplier}: ${heights.length} fetched, peak rss ${(peakRss / 2 ** 20).toFixed(0)} MiB`);
}

if (steps.includes('A')) await blocks('A', window.start);
if (steps.includes('B')) await blocks('B', window.weekStart);

if (steps.includes('headers') && !existsSync(path('headers.json'))) {
  // Headers below the window, back to the start of the period whose end the window's first
  // retarget measures. Rebuilt into 80 bytes from the supplier's fields and checked against its id.
  const firstBoundary = Math.ceil(window.start / 2016) * 2016;
  const from = firstBoundary - 2016;
  const headers = [];
  for (let h = window.start - 1; h >= from; h -= 15) {
    for (const b of await get(`${SUPPLIERS.A}/v1/blocks/${h}`, 'json')) {
      if (b.height < from || b.height >= window.start) continue;
      const raw = Buffer.alloc(80);
      raw.writeInt32LE(b.version, 0);
      Buffer.from(b.previousblockhash, 'hex').reverse().copy(raw, 4);
      Buffer.from(b.merkle_root, 'hex').reverse().copy(raw, 36);
      raw.writeUInt32LE(b.timestamp, 68);
      raw.writeUInt32LE(b.bits, 72);
      raw.writeUInt32LE(b.nonce, 76);
      const header = parseHeader(raw);
      if (header.hash !== b.id) throw new Error(`header ${b.height}: rebuilt ${header.hash} for ${b.id}`);
      headers.push({ height: b.height, hash: header.hash, prev: header.prev, time: header.time, bits: header.bits, version: header.version });
    }
  }
  headers.sort((a, b) => a.height - b.height);
  writeFileSync(path('headers.json'), JSON.stringify(headers));
  console.log(`headers: ${headers.length} from ${from}`);
}
