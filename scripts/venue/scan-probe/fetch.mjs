// node fetch.mjs <blocks> <out.json> [tip]: the unsigned bytes of every transaction in the blocks of Ergo mainnet up to tip (default the node's).
import { writeFileSync } from 'node:fs';
import { supplyBlock, parseNodeJson } from '../../../dist/ergo-supplier.js';
const N = Number(process.argv[2] ?? 50), node = 'https://node.ergo.watch';
const text = async (p) => {
  for (let i = 0; i < 5; i++) {
    try { const r = await fetch(node + p, { signal: AbortSignal.timeout(30_000) }); if (r.ok) return r.text(); } catch {}
    await new Promise(s => setTimeout(s, 1000 * 2 ** i));
  }
  throw new Error(`failed ${p}`);
};
const tip = Number(process.argv[4] ?? parseNodeJson(await text('/info')).get('fullHeight'));
const out = [];
for (let h = tip - N + 1; h <= tip; h++) {
  const [id] = JSON.parse(await text(`/blocks/at/${h}`));
  const { supplied } = supplyBlock(await text(`/blocks/${id}/transactions`));
  out.push({ height: h, txs: supplied.map(t => Buffer.from(t.unsigned).toString('hex')) });
}
writeFileSync(process.argv[3], JSON.stringify(out));
console.log(tip, out.reduce((s, b) => s + b.txs.length, 0), 'txs');
