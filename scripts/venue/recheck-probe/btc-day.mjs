// A day of Bitcoin mainnet for the venue recheck (Next 12): the 144 blocks below tip−6, each fetched raw from
// mempool.space and verified by block.mjs (txids, Merkle root, witness commitment, BIP34 height, proof of work),
// with the SHA-256 compressions a relation proving §13.2's exhaustion over them pays. Resumable: one line a block in
// <out>/btc.jsonl. Usage: node btc-day.mjs <out dir>
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyBlock } from './block.mjs';

const API = 'https://mempool.space/api';
const DAY = 144;
const [out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

async function get(url, kind) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url);
      if (r.ok) return kind === 'raw' ? Buffer.from(await r.arrayBuffer()) : r.text();
      if (attempt >= 5 || (r.status < 500 && r.status !== 429)) throw new Error(`${r.status} ${url}`);
    } catch (e) {
      if (attempt >= 5) throw e;
    }
    await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
  }
}

const windowFile = `${out}/btc-window.json`;
if (!existsSync(windowFile)) {
  const tip = Number(await get(`${API}/blocks/tip/height`));
  writeFileSync(windowFile, JSON.stringify({ tip, start: tip - 6 - DAY + 1, end: tip - 6, fixedAt: new Date().toISOString() }));
}
const window = JSON.parse(readFileSync(windowFile, 'utf8'));
const file = `${out}/btc.jsonl`;
const seen = new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).height) : []);
const heights = [];
for (let h = window.start; h <= window.end; h++) if (!seen.has(h)) heights.push(h);
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < heights.length) {
    const height = heights[next++];
    const hash = (await get(`${API}/block-height/${height}`)).trim();
    const raw = await get(`${API}/block/${hash}/raw`, 'raw');
    const t0 = performance.now();
    const v = verifyBlock(raw, height);
    const verifyMs = +(performance.now() - t0).toFixed(1);
    if (v.header.hash !== hash) throw new Error(`${height}: served ${v.header.hash} for ${hash}`);
    const { header, coinbaseScriptSig, ...stats } = v;
    appendFileSync(file, `${JSON.stringify({ height, hash, prev: header.prev, time: header.time, rawSha256: createHash('sha256').update(raw).digest('hex'), verifyMs, ...stats })}\n`);
  }
}));
console.log(JSON.stringify({ window, fetched: heights.length }));
