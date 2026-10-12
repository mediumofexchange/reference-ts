// Slice 20 probe (read-only): what an Ergo reader fetches to prove §13.2 absence today (exhaustion of
// transaction sections) and what a state-root range source would fetch instead (a NiPoPoW suffix proof
// and UTXO lookup proofs). GET/POST to public services only. Usage: node ergo.mjs [blocks] > ergo.json
const N = Number(process.argv[2] ?? 1440);
const explorer = 'https://api.ergoplatform.com/api/v1';
const node = 'https://node.ergo.watch';
const json = async (u, init) => {
  for (let i = 0; i < 4; i++) {
    try { const r = await fetch(u, init); if (r.ok) return r.json(); } catch {}
    await new Promise((s) => setTimeout(s, 1000 * 2 ** i));
  }
  throw new Error(`failed ${u}`);
};
const hexBytes = (v) => typeof v === 'string' && /^([0-9a-f]{2}){4,}$/i.test(v) ? v.length / 2
  : Array.isArray(v) ? v.reduce((s, x) => s + hexBytes(x), 0)
  : v && typeof v === 'object' ? Object.values(v).reduce((s, x) => s + hexBytes(x), 0) : 0;

// 1. Section bytes per day over the last N blocks: the node's own section sizes.
const list = [];
for (let offset = 0; offset < N; offset += 100) {
  const j = await json(`${explorer}/blocks?offset=${offset}&limit=100&sortBy=height&sortDirection=desc`);
  for (const b of j.items) list.push({ id: b.id, h: b.height, t: b.timestamp });
}
let next = 0;
const blocks = [];
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < list.length) {
    const b = list[next++];
    const blk = await json(`${node}/blocks/${b.id}`);
    blocks.push({ ...b, header: blk.header.size, transactions: blk.blockTransactions.size, adProofs: blk.adProofs?.size ?? 0 });
  }
}));
blocks.sort((a, b) => a.h - b.h);
const days = (blocks.at(-1).t - blocks[0].t) / 864e5;
const perDay = (k) => Math.round(blocks.reduce((s, b) => s + b[k], 0) / days);

// 2. A NiPoPoW suffix proof (m = 6, k = 10) from genesis to the tip: bytes of its binary fields.
const nipo = await json(`${node}/nipopow/proof/6/10`);
const links = [...nipo.prefix, nipo.suffixHead];
const nipopow = {
  m: nipo.m, k: nipo.k, prefixHeaders: nipo.prefix.length, suffixHeaders: nipo.suffixTail.length + 1,
  headerBytes: links.reduce((s, p) => s + hexBytes(p.header), 0) + hexBytes(nipo.suffixTail),
  interlinkBytes: links.reduce((s, p) => s + hexBytes(p.interlinks) + hexBytes(p.interlinksProof), 0),
  tipHeight: nipo.suffixTail.at(-1).height,
};
nipopow.totalBytes = nipopow.headerBytes + nipopow.interlinkBytes;

// 3. UTXO-set lookup proofs against the state root for 1 and 4 boxes of a recent block.
const [recent] = await json(`${node}/blocks/at/${blocks.at(-1).h - 2}`);
const outs = (await json(`${node}/blocks/${recent}/transactions`)).transactions.flatMap((t) => t.outputs.map((o) => o.boxId));
const proof = async (ids) => (await json(`${node}/utxo/getBoxesBinaryProof`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ids) })).length / 2;
const utxoProof = { boxes1: await proof(outs.slice(0, 1)), boxes4: outs.length >= 4 ? await proof(outs.slice(0, 4)) : null };

console.log(JSON.stringify({
  measured: new Date().toISOString(), node: (await json(`${node}/info`)).appVersion,
  window: { heights: [blocks[0].h, blocks.at(-1).h], blocks: blocks.length, days: +days.toFixed(3),
    from: new Date(blocks[0].t).toISOString(), to: new Date(blocks.at(-1).t).toISOString() },
  perDay: { blocks: +(blocks.length / days).toFixed(1), headers: perDay('header'), transactions: perDay('transactions'),
    adProofs: perDay('adProofs') },
  nipopow, utxoProof,
}, null, 1));
