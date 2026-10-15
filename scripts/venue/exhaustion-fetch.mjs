// Records consecutive Ergo mainnet blocks for the exhaustion checks: each header's bytes and id, and its section
// (unsigned bytes and witness id), with the first block's parent. Read-only, from a public node; nothing here is
// trusted: the check recomputes every id and root from the bytes.
//
//   node scripts/venue/exhaustion-fetch.mjs <blocks> <out.json> [tip height]
import { writeFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2b.js";
import { parseNodeJson, supplyBlock, supplyHeader } from "../../dist/ergo-supplier.js";
import { sectionMatchesRoot } from "../../dist/ergo-profile.js";

const count = Number(process.argv[2] ?? 8), file = process.argv[3], node = process.env.ERGO_NODE ?? "https://node.ergo.watch";
if (!Number.isSafeInteger(count) || count < 1 || !file) throw new Error("usage: exhaustion-fetch.mjs <blocks> <out.json> [tip]");
const text = async p => {
  for (let i = 0; i < 6; i++) {
    try { const r = await fetch(node + p, { signal: AbortSignal.timeout(30_000) }); if (r.ok) return r.text(); } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** i));
  }
  throw new Error(`failed ${p}`);
};
const hex = bytes => Buffer.from(bytes).toString("hex");
const tip = Number(process.argv[4] ?? parseNodeJson(await text("/info")).get("fullHeight"));
const low = tip - count + 1, headers = new Map();
for (let h = low - 1; h <= tip; h += 50) {
  for (const s of parseNodeJson(await text(`/blocks/chainSlice?fromHeight=${h - 1}&toHeight=${Math.min(tip, h + 49)}`))) {
    const height = Number(s.get("height")), header = supplyHeader(s);
    if (!header) throw new Error(`unsupplied header at ${height}`);
    if (height >= low - 1 && height <= tip) headers.set(height, { height, id: hex(header.id), bytes: hex(header.bytes) });
  }
}
const blocks = [];
for (let h = low; h <= tip; h++) {
  const header = headers.get(h), parent = headers.get(h - 1);
  if (header.bytes.slice(2, 66) !== parent.id) throw new Error(`header ${h} does not name its parent`);
  const { supplied } = supplyBlock(await text(`/blocks/${header.id}/transactions`));
  if (supplied.some(t => t === undefined)) throw new Error(`unsupplied transaction at ${h}`);
  const read = supplied.map(t => ({ id: blake2b(t.unsigned, { dkLen: 32 }), witnessId: t.witnessId }));
  if (!sectionMatchesRoot(read, Buffer.from(header.bytes, "hex").subarray(65, 97))) throw new Error(`section ${h} does not reproduce its root`);
  blocks.push({ ...header, txs: supplied.map(t => ({ u: hex(t.unsigned), w: hex(t.witnessId) })) });
}
writeFileSync(file, JSON.stringify({ parent: headers.get(low - 1), blocks }));
console.log(`${blocks.length} blocks to ${tip}, ${blocks.reduce((n, b) => n + b.txs.length, 0)} transactions, ${blocks.reduce((n, b) => n + b.txs.reduce((m, x) => m + x.u.length / 2, 0), 0)} unsigned bytes`);
