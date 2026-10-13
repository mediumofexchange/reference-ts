import { readFileSync } from 'node:fs';
import { blake2b } from '@noble/hashes/blake2b.js';
import { transactionsRoot } from '../../../dist/ergo-profile.js';
const d = JSON.parse(readFileSync(process.argv[2]));
const B = (h) => Buffer.from(h, 'hex');
let prev = d.parent.id, rules = {}, lens = {};
for (const b of d.blocks) {
  const hb = B(b.bytes);
  if (Buffer.from(blake2b(hb, { dkLen: 32 })).toString('hex') !== b.id) throw new Error('id');
  if (hb.subarray(1, 33).toString('hex') !== prev) throw new Error('parent');
  const root = hb.subarray(65, 97).toString('hex');
  const txs = b.txs.map(t => ({ id: blake2b(B(t.u), { dkLen: 32 }), witnessId: B(t.w) }));
  const r1 = Buffer.from(transactionsRoot(1n, txs)).toString('hex'), r2 = Buffer.from(transactionsRoot(2n, txs)).toString('hex');
  const rule = r1 === root ? 'ids' : r2 === root ? 'witness' : 'NONE';
  rules[rule] = (rules[rule] ?? 0) + 1; lens[hb.length] = (lens[hb.length] ?? 0) + 1;
  prev = b.id;
}
console.log(rules, 'header lengths', lens, 'version bytes', [...new Set(d.blocks.map(b => b.bytes.slice(0, 2)))]);
