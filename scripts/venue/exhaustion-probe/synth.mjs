// Synthetic periods for the leaf: blocks of record transactions (shaped outputs), plain and mutated ones,
// under either root rule, with headers that carry the parent id and the transactions root at their offsets.
import { blake2b } from '@noble/hashes/blake2b.js';
import { rng, p2pk, recordTx, mutate, tx } from './txgen.mjs';
import { transactionsRoot, frameTransaction, collBytes } from '../../../dist/ergo-profile.js';

const hex = (b) => Buffer.from(b).toString('hex');
export function synthPeriod(seed, { blocks = 6, maxTxs = 5, height = 1_000_000 } = {}) {
  const r = rng(seed);
  const locations = [0, 1, 2, 3].map(() => p2pk(r));
  const parent = { height, id: hex(Uint8Array.from({ length: 32 }, () => Math.floor(r() * 256))) };
  let prev = parent.id;
  const out = [];
  const pool = [];
  for (let b = 0; b < blocks; b++) {
    const n = 1 + Math.floor(r() * maxTxs);
    const txs = [];
    for (let j = 0; j < n; j++) {
      const kind = r();
      let u;
      if (kind < 0.5) u = recordTx(r, locations);
      else if (kind < 0.7 && pool.length) u = mutate(r, pool[Math.floor(r() * pool.length)]);
      else u = tx(r, [{ tree: p2pk(r), regs: [Uint8Array.from({ length: 32 }, () => Math.floor(r() * 256)), Uint8Array.of(1, 2)] }, { tree: p2pk(r), regs: [] }]);
      if (u.length === 0) u = Uint8Array.of(0);
      pool.push(u);
      txs.push({ u: hex(u), w: hex(Uint8Array.from({ length: 31 }, () => Math.floor(r() * 256))) });
    }
    const version = r() < 0.3 ? 1n : 2n;
    const root = transactionsRoot(version, txs.map(t => ({ id: blake2b(Buffer.from(t.u, 'hex'), { dkLen: 32 }), witnessId: Buffer.from(t.w, 'hex') })));
    const len = 200 + Math.floor(r() * 120);
    const hb = Uint8Array.from({ length: len }, () => Math.floor(r() * 256));
    hb.set(Buffer.from(prev, 'hex'), 1); hb.set(root, 65);
    const id = hex(blake2b(hb, { dkLen: 32 }));
    out.push({ height: height + b + 1, id, bytes: hex(hb), txs });
    prev = id;
  }
  return { parent, blocks: out };
}

/** The shaped outputs of each grammatical transaction: what the leaf's entries must include. */
export function expectedEntries(data) {
  const want = [];
  for (const b of data.blocks) b.txs.forEach((t, j) => {
    const outs = frameTransaction(Buffer.from(t.u, 'hex'));
    if (!outs) return;
    outs.forEach((o, i) => {
      const r4 = o.registers.R4 && collBytes(o.registers.R4), r5 = o.registers.R5 && collBytes(o.registers.R5);
      if (r4?.length === 32 && r5 !== undefined) want.push(`${b.height}:${j}:${i}:${hex(r4)}`);
    });
  });
  return want;
}
