// Test periods for the exhaustion circuits: synthetic chains (src/ergo-synthetic.ts) whose blocks carry outputs with
// venue-ergo §6's shape for subjects sharing and not sharing a key, kind-4 runs, transactions longer than one slot, an
// ungrammatical transaction holding a shaped output, blocks under both of venue-ergo §4's root rules; and recorded
// Ergo mainnet blocks. Imported by exhaustion-check.mjs; run after `npm run build`.
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { Chain, plainOutput, recordOutput, transaction } from "../../dist/ergo-synthetic.js";

const cat = (...parts) => Buffer.concat(parts);
const rec = (kind, subject, fill, length) => recordOutput(kind, subject, new Uint8Array(length).fill(fill));
export const s = sha256(Uint8Array.of(0x51)), t = new Uint8Array(sha256(Uint8Array.of(0x52))), u = sha256(Uint8Array.of(0x53));
t.set(s.subarray(28), 28); // t shares s's key

/** A synthetic chain: `count` blocks above its anchor, block i carrying records as the reader's tests do, every third
 * block under the ids rule. */
export function syntheticPeriod(count = 9) {
  const chain = new Chain(), blocks = [];
  let tip = chain.anchor;
  for (let i = 0; i < count; i++) {
    const txs = [transaction([plainOutput])];
    if (i % 3 === 0) txs.push(transaction([rec(1, s, i, 40), plainOutput, rec(2, t, i, 60)]));
    if (i % 4 === 1) txs.push(transaction([rec(4, s, i, 30), rec(4, s, i + 1, 30), plainOutput, rec(4, s, i + 2, 30), rec(4, t, i, 9)]));
    if (i % 5 === 2) txs.push(transaction([rec(3, s, 200 - i, 300), rec(3, u, 100 + i, 0), rec(3, u, i, 1)]));
    if (i === 4) {
      const bad = transaction([rec(1, s, 77, 12)]);
      txs.push({ unsigned: cat(bad.unsigned, Uint8Array.of(0)), witnessId: bad.witnessId });
    }
    tip = chain.mine(tip, txs, 0, i % 3 === 2 ? 1n : 2n);
    blocks.push(tip);
  }
  return { start: { id: chain.anchor.id, height: chain.anchor.height }, blocks: blocks.map(b => ({ header: b.bytes, transactions: b.section, id: b.id, height: b.height })) };
}

/** Recorded consecutive mainnet blocks (exhaustion-fetch.mjs): the parent of the first and each block. */
export function recordedPeriod(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const hex = x => Uint8Array.from(Buffer.from(x, "hex"));
  return {
    start: { id: hex(data.parent.id), height: BigInt(data.parent.height) },
    blocks: data.blocks.map(b => ({ header: hex(b.bytes), id: hex(b.id), height: BigInt(b.height),
      transactions: b.txs.map(x => ({ unsigned: hex(x.u), witnessId: hex(x.w) })) })),
  };
}
