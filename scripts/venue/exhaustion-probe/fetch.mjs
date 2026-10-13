// node fetch.mjs <blocks> <out.json> [tip]: headers (bytes, id) and sections (unsigned bytes, witness id) of
// consecutive Ergo mainnet blocks up to tip, plus the parent header of the first. Read-only, public node.
import { writeFileSync } from 'node:fs';
import { supplyBlock, supplyHeader, parseNodeJson } from '../../../dist/ergo-supplier.js';
const N = Number(process.argv[2] ?? 30), node = 'https://node.ergo.watch';
const text = async (p) => {
  for (let i = 0; i < 6; i++) {
    try { const r = await fetch(node + p, { signal: AbortSignal.timeout(30_000) }); if (r.ok) return r.text(); } catch {}
    await new Promise(s => setTimeout(s, 1000 * 2 ** i));
  }
  throw new Error(`failed ${p}`);
};
const hex = (b) => Buffer.from(b).toString('hex');
const tip = Number(process.argv[4] ?? parseNodeJson(await text('/info')).get('fullHeight'));
const low = tip - N + 1, headers = new Map();
for (let h = low - 1; h <= tip; h += 50) {
  for (const s of parseNodeJson(await text(`/blocks/chainSlice?fromHeight=${h - 1}&toHeight=${Math.min(tip, h + 49)}`))) {
    const height = Number(s.get('height')), hdr = supplyHeader(s);
    if (!hdr) throw new Error(`unsupplied header ${height}`);
    if (height >= low - 1 && height <= tip) headers.set(height, { height, id: hex(hdr.id), bytes: hex(hdr.bytes) });
  }
}
const blocks = [];
let next = low;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next <= tip) {
    const h = next++, hd = headers.get(h);
    const { supplied } = supplyBlock(await text(`/blocks/${hd.id}/transactions`));
    if (supplied.some(t => t === undefined)) throw new Error(`unsupplied transaction at ${h}`);
    blocks.push({ ...hd, txs: supplied.map(t => ({ u: hex(t.unsigned), w: hex(t.witnessId) })) });
  }
}));
blocks.sort((a, b) => a.height - b.height);
writeFileSync(process.argv[3], JSON.stringify({ parent: headers.get(low - 1), blocks }));
console.log(tip, blocks.length, 'blocks', blocks.reduce((s, b) => s + b.txs.length, 0), 'txs', blocks.reduce((s, b) => s + b.txs.reduce((t, x) => t + x.u.length / 2, 0), 0), 'unsigned bytes');
