// The day model: leaves of each kind for a fetched day (T, M slot counts from the streams, U from its entries),
// nodes of a binary tree over them, one fold a period, times from measured.json. node cost.mjs <day.json>...
import { readFileSync, writeFileSync } from 'node:fs';
import { streams, scanStep, initialState } from './model.mjs';
import { parseErgoHeader } from '../../../dist/ergo-headers.js';
const measured = JSON.parse(readFileSync(new URL('./measured.json', import.meta.url)));
const { leaf, prove } = measured;
const out = { measured, days: [] };
for (const file of process.argv.slice(2)) {
  const data = JSON.parse(readFileSync(file));
  const { T, M } = streams(data.blocks);
  const ts = data.blocks.map(b => Number(parseErgoHeader(Buffer.from(b.bytes, 'hex')).timestamp));
  const days = (ts.at(-1) - ts[0]) / 864e5;
  // Entries: the scan over every slot.
  let entries = 0;
  const st = initialState({ height: 0, id: '00'.repeat(32) }, 0n).t;
  for (const s of T) {
    if (s.start) { st.mode = 0; st.a = 0n; st.p = 1n; st.outi = 0n; }
    for (let j = 0; j < 128; j++) if (scanStep(st, s.bytes[j] ?? 0, j < s.len)) entries++;
  }
  const perDay = (x) => x / days;
  const tL = Math.ceil(perDay(T.length) / leaf.T.slots), mL = Math.ceil(perDay(M.length) / leaf.M.slots), uL = Math.ceil(perDay(entries) / leaf.U.slots);
  const leaves = tL + mL + uL;
  const leafH = (tL * prove.T + mL * prove.M + uL * prove.U) / 3600;
  const nodesH = ((leaves - 1) * prove.node) / 3600;
  const unsigned = data.blocks.reduce((s, b) => s + b.txs.reduce((t, x) => t + x.u.length / 2, 0), 0);
  out.days.push({
    file, heights: [data.blocks[0].height, data.blocks.at(-1).height], days: +days.toFixed(3), unsignedPerDay: Math.round(perDay(unsigned)),
    txsPerDay: Math.round(perDay(data.blocks.reduce((s, b) => s + b.txs.length, 0))), tSlotsPerDay: Math.round(perDay(T.length)), mSlotsPerDay: Math.round(perDay(M.length)),
    entriesPerDay: Math.round(perDay(entries)), leaves: { T: tL, M: mL, U: uL }, nodes: leaves - 1,
    hours: { leaves: +leafH.toFixed(2), nodes: +nodesH.toFixed(2), total: +(leafH + nodesH).toFixed(2) },
    keepsUp: +(24 / (leafH + nodesH)).toFixed(2),
  });
}
// Marginal costs: an extra unsigned MB a day (block-aligned, no entries), and an extra MB of shaped outputs at 42 bytes each.
const mbT = 1e6 / 128 / leaf.T.slots, perLeaf = (p) => (p + prove.node) / 3600;
out.perExtraMB = {
  plain: +(mbT * perLeaf(prove.T)).toFixed(2),
  // 100-byte transactions: a T slot and four M slots each (two tree leaves, about two merges), 10,000 a MB.
  smallTransactions: +((1e4 / leaf.T.slots) * perLeaf(prove.T) + (4e4 / leaf.M.slots) * perLeaf(prove.M)).toFixed(2),
  denseShapedOutputs: +(mbT * perLeaf(prove.T) + (1e6 / 42) / leaf.U.slots * perLeaf(prove.U)).toFixed(2),
};
console.log(JSON.stringify(out, null, 1));
writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(out, null, 1));
