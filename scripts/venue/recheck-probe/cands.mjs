// The venue recheck's candidates (Next 12), one read-only snapshot: a day of blocks (count, bytes, transactions) and
// who mined them, for Litecoin, Dogecoin, Nervos CKB, Alephium and Ethereum Classic, plus crypto51's rental cost for
// all listed chains. Every response is hashed into the result. Usage: node cands.mjs <out json>
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const hashes = [];
const [out] = process.argv.slice(2);
async function get(url, { body, raw } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: url.includes('nervos') ? { accept: 'application/vnd.api+json', 'content-type': 'application/vnd.api+json' } : {} });
      if (r.ok) {
        const text = await r.text();
        // Blockchair answers a rate limit with 200 and null data: wait and ask again.
        if (!raw && url.includes('blockchair') && JSON.parse(text).data === null && attempt < 8) { await new Promise((res) => setTimeout(res, 30000 * (attempt + 1))); continue; }
        hashes.push(createHash('sha256').update(text).digest('hex'));
        return raw ? text : JSON.parse(text);
      }
      if (attempt >= 5 || (r.status < 500 && r.status !== 429)) throw new Error(`${r.status} ${url}`);
    } catch (e) {
      if (attempt >= 5) throw e;
    }
    await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));
  }
}
const shares = (names) => {
  const c = {};
  for (const n of names) c[n] = (c[n] ?? 0) + 1;
  const sorted = Object.entries(c).sort((a, b) => b[1] - a[1]);
  let acc = 0, forMajority = 0;
  for (const [, k] of sorted) { if (acc * 2 > names.length) break; acc += k; forMajority++; }
  return { blocks: names.length, top: sorted.slice(0, 4).map(([n, k]) => [n, +(100 * k / names.length).toFixed(1)]), forMajority };
};
const perDay = (blocks, spanS, x) => +(x * 86400 / spanS).toFixed(0);
const result = { fixedAt: new Date().toISOString() };

// crypto51: one-hour rental cost and rentable share, every listed chain.
{
  const html = await get('https://crypto51.app/', { raw: true });
  result.crypto51 = {};
  for (const row of html.split('<tr').slice(1)) {
    const c = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    if (c.length >= 8) result.crypto51[c[2]] = { algorithm: c[4], hashrate: c[5], hourCost: c[6], rentable: c[7] };
  }
}

// Litecoin: the 576 blocks below tip−6 (litecoinspace, coinbase attribution).
{
  const tip = Number(await get('https://litecoinspace.org/api/blocks/tip/height', { raw: true }));
  const blocks = [];
  for (let h = tip - 6; blocks.length < 576; h -= 15) blocks.push(...(await get(`https://litecoinspace.org/api/v1/blocks/${h}`)));
  const day = blocks.slice(0, 576);
  const span = day[0].timestamp - day[575].timestamp;
  const size = day.reduce((s, b) => s + b.size, 0), weight = day.reduce((s, b) => s + b.weight, 0);
  result.LTC = { heights: [day[575].height, day[0].height], spanH: +(span / 3600).toFixed(2), txs: perDay(576, span, day.reduce((s, b) => s + b.tx_count, 0)),
    bytesFull: perDay(576, span, size), bytesStripped: perDay(576, span, (weight - size) / 3), headerBytes: perDay(576, span, 80 * 576), pools: shares(day.map((b) => b.extras?.pool?.name ?? 'unknown')) };
}

// Dogecoin: the latest 1,440 blocks (Blockchair), and 8 raw blocks to size the AuxPoW a header carries.
{
  const pause = () => new Promise((r) => setTimeout(r, 4000));
  const byId = new Map();
  for (let o = 0; o < 1500; o += 100) { for (const b of (await get(`https://api.blockchair.com/dogecoin/blocks?limit=100&offset=${o}`)).data) byId.set(b.id, b); await pause(); }
  // A block found while paging shifts the pages: keep each height once, the latest 1,440 (1,439 intervals).
  const blocks = [...byId.values()].sort((a, b) => b.id - a.id).slice(0, 1440);
  const t = (b) => Date.parse(`${b.time.replace(' ', 'T')}Z`) / 1000;
  const span = t(blocks[0]) - t(blocks[1439]);
  const newer = blocks.slice(0, 1439); // the blocks the span covers
  // AuxPoW after the 80-byte header: the parent's coinbase transaction, its hash, two Merkle branches, the parent header.
  const aux = [];
  for (let k = 0; k < 8; k++) {
    let rawHex = null;
    for (let attempt = 0; !rawHex && attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 30000));
      rawHex = Object.values((await get(`https://api.blockchair.com/dogecoin/raw/block/${blocks[k * 150].hash}`)).data ?? {})[0]?.raw_block ?? null;
      await pause();
    }
    if (!rawHex) continue; // not served: fewer samples
    const hex = Buffer.from(rawHex, 'hex');
    let at = 80;
    const varint = () => { const f = hex[at++]; if (f < 0xfd) return f; if (f === 0xfd) { at += 2; return hex.readUInt16LE(at - 2); } at += 4; return hex.readUInt32LE(at - 4); };
    const skip = (n) => { at += n; }; // the length is read before the offset moves
    skip(4); const nIn = varint(); for (let i = 0; i < nIn; i++) { skip(36); skip(varint()); skip(4); }
    const nOut = varint(); for (let i = 0; i < nOut; i++) { skip(8); skip(varint()); } skip(4);
    skip(32); skip(32 * varint() + 4); skip(32 * varint() + 4); skip(80);
    aux.push(at);
  }
  const auxMedian = [...aux].sort((a, b) => a - b)[Math.floor(aux.length / 2)];
  const bytes = newer.reduce((s, b) => s + b.size, 0);
  result.DOGE = { heights: [blocks[1439].id, blocks[0].id], spanH: +(span / 3600).toFixed(2), txs: perDay(1439, span, newer.reduce((s, b) => s + b.transaction_count, 0)),
    bytesFull: perDay(1439, span, bytes), headerWithAuxpowBytes: aux, headerBytes: perDay(1439, span, auxMedian * 1439),
    // Exhaustion reads the transactions: the block bytes less each header at the sampled median.
    bytesTransactions: perDay(1439, span, bytes - auxMedian * 1439),
    pools: shares(newer.map((b) => b.guessed_miner || 'unknown')) };
}

// Nervos CKB: a day's count and transactions from the explorer, block bytes from 288 blocks spread over the day
// (RPC, serialized), miners of the latest 2,000 blocks (explorer).
{
  const stat = (await get('https://mainnet-api.explorer.nervos.org/api/v1/statistics')).data.attributes;
  const tip = Number(stat.tip_block_number) - 6, perDayBlocks = Math.round(86400000 / Number(stat.average_block_time));
  let bytes = 0, header = 0;
  for (let k = 0; k < 288; k++) {
    const n = tip - Math.floor(k * perDayBlocks / 288);
    bytes += (await get('https://mainnet.ckb.dev/rpc', { body: { id: 1, jsonrpc: '2.0', method: 'get_block_by_number', params: [`0x${n.toString(16)}`, '0x0'] } })).result.length / 2 - 1;
    if (k === 0) header = (await get('https://mainnet.ckb.dev/rpc', { body: { id: 1, jsonrpc: '2.0', method: 'get_header_by_number', params: [`0x${n.toString(16)}`, '0x0'] } })).result.length / 2 - 1;
  }
  const miners = [];
  for (let p = 1; p <= 20; p++) miners.push(...(await get(`https://mainnet-api.explorer.nervos.org/api/v1/blocks?page=${p}&page_size=100`)).data.map((b) => b.attributes.miner_hash));
  result.CKB = { averageBlockS: +(Number(stat.average_block_time) / 1000).toFixed(2), blocks: perDayBlocks, txs: Number(stat.transactions_last_24hrs), headerBytesEach: header,
    bytesFull: Math.round(bytes / 288 * perDayBlocks), headerBytes: header * perDayBlocks, pools: shares(miners) };
}

// Alephium: the rate over the latest 1,000 blocks (16 chains), bytes from 200 of them (node, serialized).
{
  const list = [];
  for (let p = 1; p <= 10; p++) list.push(...(await get(`https://backend.mainnet.alephium.org/blocks?page=${p}&limit=100`)).blocks);
  const span = (list[0].timestamp - list[list.length - 1].timestamp) / 1000;
  let bytes = 0, smallest = Infinity;
  for (let k = 0; k < 200; k++) {
    const n = (await get(`https://node.mainnet.alephium.org/blockflow/raw-blocks/${list[k * 5].hash}`)).value.length / 2;
    bytes += n; smallest = Math.min(smallest, n);
  }
  const blocks = perDay(list.length, span, list.length);
  result.ALPH = { chains: new Set(list.map((b) => `${b.chainFrom}-${b.chainTo}`)).size, blocks, txs: perDay(list.length, span, list.reduce((s, b) => s + b.txNumber, 0)),
    bytesFull: Math.round(bytes / 200 * blocks), smallestBlock: smallest, headerBytesUpper: smallest * blocks };
}

// Ethereum Classic: the latest day of blocks (Blockscout, 50 a page).
{
  const blocks = [];
  let next = '';
  while (true) {
    const page = await get(`https://etc.blockscout.com/api/v2/blocks?type=block${next}`);
    blocks.push(...page.items);
    const span = (Date.parse(blocks[0].timestamp) - Date.parse(blocks[blocks.length - 1].timestamp)) / 1000;
    if (span >= 86400 || !page.next_page_params) break;
    next = '&' + new URLSearchParams(page.next_page_params).toString();
  }
  const span = (Date.parse(blocks[0].timestamp) - Date.parse(blocks[blocks.length - 1].timestamp)) / 1000;
  result.ETC = { heights: [blocks[blocks.length - 1].height, blocks[0].height], spanH: +(span / 3600).toFixed(2), blocks: blocks.length,
    txs: perDay(blocks.length, span, blocks.reduce((s, b) => s + (b.transaction_count ?? b.transactions_count ?? 0), 0)),
    bytesFull: perDay(blocks.length, span, blocks.reduce((s, b) => s + b.size, 0)), smallestBlock: Math.min(...blocks.map((b) => b.size)),
    gasUsedShare: +(blocks.reduce((s, b) => s + Number(b.gas_used), 0) / blocks.reduce((s, b) => s + Number(b.gas_limit), 0) * 100).toFixed(2),
    pools: shares(blocks.map((b) => b.miner?.name ?? b.miner?.hash ?? 'unknown')) };
}

result.responsesSha256 = createHash('sha256').update(hashes.join('')).digest('hex');
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
