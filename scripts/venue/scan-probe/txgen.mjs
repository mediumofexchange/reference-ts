// Synthetic transactions inside §5's grammar, with record-shaped outputs at chosen locations, and mutations of them.
import { MINER_FEE } from './machine.mjs';
export function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; }; }
export const vlq = (v) => { v = BigInt(v); const o = []; do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; o.push(b); } while (v); return o; };
const bytes = (r, n) => Array.from({ length: n }, () => Math.floor(r() * 256));
const coll = (data) => [0x0e, ...vlq(data.length), ...data];
export function p2pk(r) { return [0x00, 0x08, 0xcd, 0x02, ...bytes(r, 32)]; }
// A sized tree with header 0x18; the draw is kept so that the recorded runs' sequences reproduce.
export function sized(r, n) { r(); return [0x18, ...vlq(n), ...bytes(r, n)]; }
/** A transaction: `outs` are { tree, regs: [byte arrays as register contents] }. */
export function tx(r, outs, { inputs = 1 + Math.floor(r() * 3), dataInputs = Math.floor(r() * 2), tokenIds = Math.floor(r() * 2) } = {}) {
  const o = [...vlq(inputs)];
  for (let i = 0; i < inputs; i++) {
    o.push(...bytes(r, 32), 0);
    const ext = Math.floor(r() * 3); o.push(ext);
    for (let e = 0; e < ext; e++) o.push(Math.floor(r() * 256), ...coll(bytes(r, Math.floor(r() * 40))));
  }
  o.push(...vlq(dataInputs)); for (let i = 0; i < dataInputs; i++) o.push(...bytes(r, 32));
  o.push(...vlq(tokenIds)); for (let i = 0; i < tokenIds; i++) o.push(...bytes(r, 32));
  o.push(...vlq(outs.length));
  for (const out of outs) {
    o.push(...vlq(BigInt(Math.floor(r() * 2 ** 40)) * BigInt(1 + Math.floor(r() * 1000))), ...out.tree, ...vlq(1_892_000 + Math.floor(r() * 1000)));
    const toks = out.tokens ?? (tokenIds ? Math.floor(r() * 2) : 0); o.push(toks);
    for (let t = 0; t < toks; t++) o.push(...vlq(Math.floor(r() * tokenIds)), ...vlq(BigInt(Math.floor(r() * 2 ** 50))));
    o.push(out.regs.length); for (const reg of out.regs) o.push(...coll(reg));
  }
  return Uint8Array.from(o);
}
export const fee = () => [...MINER_FEE];
/** A record-carrying transaction: record outputs at `locations`, change to P2PK and the fee. */
export function recordTx(r, locations) {
  const outs = [];
  const k = Math.floor(r() * 4);
  const subject = bytes(r, 32);
  const pieces = 1 + Math.floor(r() * 3);
  for (let i = 0; i < pieces; i++) {
    const regs = [subject, bytes(r, [136, 233, 96, 200 + Math.floor(r() * 3000)][k])];
    if (r() < 0.2) regs.push(bytes(r, 5));
    outs.push({ tree: locations[k], regs, tokens: 0 });
  }
  if (r() < 0.3) outs.push({ tree: locations[(k + 1) % 4], regs: [bytes(r, 31 + Math.floor(r() * 3)), bytes(r, 10)], tokens: 0 });
  if (r() < 0.3) outs.push({ tree: p2pk(r), regs: [subject, bytes(r, 4)], tokens: 0 });
  if (r() < 0.3) outs.push({ tree: sized(r, Math.floor(r() * 60)), regs: [subject], tokens: 0 });
  outs.push({ tree: p2pk(r), regs: [], tokens: 0 }, { tree: fee(), regs: [], tokens: 0 });
  return tx(r, outs, { tokenIds: 0 });
}
/** A mutation: flip, insert, delete or truncate. */
export function mutate(r, t) {
  const a = [...t], at = Math.floor(r() * a.length), kind = Math.floor(r() * 5);
  if (kind === 0) a[at] = Math.floor(r() * 256);
  else if (kind === 1) a.splice(at, 0, Math.floor(r() * 256));
  else if (kind === 2) a.splice(at, 1);
  else if (kind === 3) a.length = at;
  else a[at] ^= 1 << Math.floor(r() * 8);
  return Uint8Array.from(a);
}
