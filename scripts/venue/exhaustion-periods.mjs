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

/** Recorded consecutive mainnet blocks (exhaustion-corpus.mjs fetch): the parent of the first and each block. */
export function recordedPeriod(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const hex = x => Uint8Array.from(Buffer.from(x, "hex"));
  return {
    start: { id: hex(data.parent.id), height: BigInt(data.parent.height) },
    blocks: data.blocks.map(b => ({ header: hex(b.bytes), id: hex(b.id), height: BigInt(b.height),
      transactions: b.txs.map(x => ({ unsigned: hex(x.u), witnessId: hex(x.w) })) })),
  };
}

/** Crafted and mutated unsigned transactions of at most `limit` bytes for the scan's agreement: shaped outputs among
 * tokens, extensions, data inputs, a pay-to-public-key tree and minimal 42-byte shaped outputs, one with a byte past
 * the grammar, and 60 random byte mutations of them (deterministic). */
export function craftedTransactions(limit) {
  let seed = 12345;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const vlq = v => { const o = []; v = BigInt(v); do { let b = Number(v & 127n); v >>= 7n; if (v) b |= 128; o.push(b); } while (v); return o; };
  const bytes = (n, f = 0) => Array.from({ length: n }, (_, i) => (f + i) & 255);
  const shaped = (fill, r5) => [...vlq(1000), 0x08, ...vlq(3), 1, 2, 3, ...vlq(5), 0, 2, 0x0e, 32, ...bytes(32, fill), 0x0e, ...vlq(r5), ...bytes(r5, 9)];
  const minimal = fill => [1, 0x08, 0, 0, 0, 2, 0x0e, 32, ...bytes(32, fill), 0x0e, 0];
  const p2pk = () => [...vlq(5), 0x00, 0x08, 0xcd, ...bytes(33, 7), 1, 0, 0];
  const tokens = fill => [...vlq(77), 0x08, 0, ...vlq(9), 2, ...vlq(0), ...vlq(300), ...vlq(1), ...vlq(5), 3, 0x0e, 32, ...bytes(32, fill), 0x0e, 1, 42, 0x0e, 0];
  const input = ext => [...bytes(32, 1), 0, ext.length, ...ext.flatMap(([k, n]) => [k, 0x0e, ...vlq(n), ...bytes(n, 2)])];
  const tx = (inputs, dataInputs, tokenIds, outputs) => [...vlq(inputs.length), ...inputs.flat(), ...vlq(dataInputs), ...Array(dataInputs).fill(bytes(32, 3)).flat(),
    ...vlq(tokenIds), ...Array(tokenIds).fill(bytes(32, 5)).flat(), ...vlq(outputs.length), ...outputs.flat()];
  const crafted = [
    tx([input([])], 0, 0, [shaped(1, 3)]),
    tx([input([[1, 4], [2, 0]]), input([])], 2, 1, [tokens(10), p2pk(), shaped(11, 0)]),
    tx([], 0, 0, Array.from({ length: 18 }, (_, i) => minimal(i))),
    [...tx([input([])], 0, 0, [shaped(1, 3)]), 0],
    tx([input([])], 0, 0, [shaped(2, 200), shaped(3, 1)]),
  ];
  for (let i = 0; i < 60; i++) {
    const base = [...crafted[rnd(5)]];
    for (let j = 0, k = 1 + rnd(4); j < k; j++) base[rnd(base.length)] = [0, 1, 2, 6, 7, 0x0e, 0x20, 0x80, 0xff, 0x08, 0x10, rnd(256)][rnd(12)];
    crafted.push(base);
  }
  return crafted.filter(t => t.length > 0 && t.length <= limit).map(t => Uint8Array.from(t));
}
