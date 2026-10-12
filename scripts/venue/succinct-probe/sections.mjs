// Blake2b-256 work a day of Ergo mainnet needs: the compressions a reader's §13.2 check of each section
// against its header's transactions root performs (transaction ids over unsigned bytes, the Merkle tree
// over ids and witness ids) and an Autolykos v2 check of each header. Read-only, public node.
// Usage: node sections.mjs [blocks]
import { supplyBlock, supplyHeader, parseNodeJson } from '../../../dist/ergo-supplier.js';

const N = Number(process.argv[2] ?? 720);
const node = 'https://node.ergo.watch';
const text = async (path) => {
  for (let i = 0; i < 5; i++) {
    try { const r = await fetch(node + path, { signal: AbortSignal.timeout(30_000) }); if (r.ok) return r.text(); } catch {}
    await new Promise((s) => setTimeout(s, 1000 * 2 ** i));
  }
  throw new Error(`failed ${path}`);
};
const blocksOf = (bytes) => Math.max(1, Math.ceil(bytes / 128));
const tip = Number(parseNodeJson(await text('/info')).get('fullHeight'));
const low = tip - N + 1;
const headers = [];
for (let h = low; h <= tip; h += 100) {
  const slice = parseNodeJson(await text(`/blocks/chainSlice?fromHeight=${h - 1}&toHeight=${Math.min(tip, h + 99)}`));
  for (const s of slice) { const height = Number(s.get('height')); if (height >= low && height <= tip && !headers.some(x => x.height === height)) headers.push({ height, id: s.get('id'), ts: Number(s.get('timestamp')), hdr: supplyHeader(s) }); }
}
headers.sort((a, b) => a.height - b.height);
const rows = [];
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < headers.length) {
    const h = headers[next++];
    const { supplied } = supplyBlock(await text(`/blocks/${h.id}/transactions`));
    if (supplied.some((t) => t === undefined)) throw new Error(`unsupplied transaction at ${h.height}`);
    const n = supplied.length, leaves = 2 * n;
    let internal = 0;
    let w = leaves;
    do { w = Math.ceil(w / 2); internal += w; } while (w > 1);
    rows.push({
      height: h.height, transactions: n,
      unsigned: supplied.reduce((s, t) => s + t.unsigned.length, 0),
      signed: supplied.reduce((s, t) => s + t.signedBytes, 0),
      idCompressions: supplied.reduce((s, t) => s + blocksOf(t.unsigned.length), 0),
      merkleCompressions: leaves + internal,
      headerBytes: h.hdr?.bytes.length ?? 0,
    });
  }
}));
const days = (headers.at(-1).ts - headers[0].ts) / 864e5;
const perDay = (k) => Math.round(rows.reduce((s, r) => s + r[k], 0) / days);
// Autolykos v2 (src/ergo-headers.ts autolykosHit): H(withoutPow), H(msg|nonce), H(i|h|M), H(seed), 32 × H(j|h|M), H(sum),
// and the header id H(header); M is 8,192 bytes, so H(·|h|M) is ceil(8200/128) = 65 compressions.
const autolykos = 2 + 1 + 65 + 1 + 32 * 65 + 1 + 2;
console.log(JSON.stringify({
  measured: new Date().toISOString(), node, window: { heights: [low, tip], blocks: rows.length, days: +days.toFixed(3) },
  perDay: {
    blocks: +(rows.length / days).toFixed(1), transactions: perDay('transactions'), unsignedBytes: perDay('unsigned'), signedBytes: perDay('signed'),
    idCompressions: perDay('idCompressions'), merkleCompressions: perDay('merkleCompressions'),
    autolykosCompressions: Math.round(rows.length / days * autolykos),
  },
  autolykosPerHeader: autolykos,
  maxBlock: rows.reduce((m, r) => r.idCompressions + r.merkleCompressions > m.c ? { c: r.idCompressions + r.merkleCompressions, height: r.height, transactions: r.transactions } : m, { c: 0 }),
}, null, 1));
