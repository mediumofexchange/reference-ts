// Dogecoin's AuxPoW per header (venue recheck, Next 12). A merged-mined header carries the parent's coinbase, its
// hash, the coinbase's Merkle branch, the merged-mining branch and the parent header after its own 80 bytes; cands.mjs
// parsed one block's (Blockchair, which then refused further requests). The parent is a Litecoin candidate block, so
// this sizes the Litecoin coinbases of 48 blocks spread over cands.mjs's Litecoin day (litecoinspace) and estimates the
// AuxPoW as coinbase + 32 + 32·⌈log2 txs⌉ + 4 + 32·3 + 4 + 80 (a merged-mining tree of depth 3 assumed).
// Usage: node doge-aux.mjs <cands result json> <out json>
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [candsFile, out] = process.argv.slice(2);
const cands = JSON.parse(readFileSync(candsFile, 'utf8'));
const [from, to] = cands.LTC.heights;
const hashes = [];
async function get(url) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url);
    if (r.ok) { const t = await r.text(); hashes.push(createHash('sha256').update(t).digest('hex')); return JSON.parse(t); }
    if (attempt >= 5) throw new Error(`${r.status} ${url}`);
    await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
  }
}
const rows = [];
for (let k = 0; k < 48; k++) {
  const h = from + Math.floor(k * (to - from) / 47);
  const [b] = await get(`https://litecoinspace.org/api/v1/blocks/${h}`);
  const [coinbase] = await get(`https://litecoinspace.org/api/block/${b.id}/txs/0`);
  rows.push({ height: h, pool: b.extras?.pool?.name ?? 'unknown', txs: b.tx_count, coinbaseBytes: coinbase.size, auxpowEstimate: coinbase.size + 32 + 32 * Math.ceil(Math.log2(b.tx_count)) + 4 + 96 + 4 + 80 });
}
const est = rows.map((r) => r.auxpowEstimate).sort((a, b) => a - b);
const result = { measuredDogeAuxpowBytes: cands.DOGE.auxpowHeaderBytes, rows, medianAuxpow: est[24], minAuxpow: est[0], maxAuxpow: est[47],
  medianHeaderBytesPerDay: (80 + est[24]) * 1440, responsesSha256: createHash('sha256').update(hashes.join('')).digest('hex') };
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify({ ...result, rows: rows.map((r) => `${r.pool}:${r.coinbaseBytes}`).join(' ') }));
