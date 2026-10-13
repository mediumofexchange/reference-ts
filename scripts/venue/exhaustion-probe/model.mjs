// The exhaustion leaf's model: the streams a period of blocks gives, their split into leaves, each leaf's
// witness for the circuit (gen-leaf.mjs), and its state hashes, computed as the circuit computes them.
import { blake2b } from '@noble/hashes/blake2b.js';
import { poseidon2Permutation } from '../../../dist/pool/poseidon2.js';
import { MODES, BSEL, BYTEV, ACT, ACTIONS, M as MODE } from './machine.mjs';
import { S, D, TAG, EL_PER_SLOT } from './gen-leaf.mjs';

/** The node key a leaf carries (set by the caller once the node circuit's key is known). */
export const KEY_NODE = { value: 0n };
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const md = (x) => ((x % P) + P) % P;
const M64 = (1n << 64n) - 1n, P32 = 1n << 32n, P64 = 1n << 64n, P128 = 1n << 128n;
export const perm3 = (a, b, c, tag) => poseidon2Permutation([md(a), md(b), md(c), BigInt(tag)])[0];

// Blake2b compression over BigInt words.
const IV = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
const SIGMA = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0]];
const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & M64;
export function compress(h, block, t, last) {
  const m = Array.from({ length: 16 }, (_, i) => { let w = 0n; for (let j = 7; j >= 0; j--) w = (w << 8n) | BigInt(block[i * 8 + j]); return w; });
  const v = [...h, ...IV];
  v[12] ^= t; if (last) v[14] ^= M64;
  const g = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) & M64; v[d] = rotr(v[d] ^ v[a], 32n); v[c] = (v[c] + v[d]) & M64; v[b] = rotr(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & M64; v[d] = rotr(v[d] ^ v[a], 16n); v[c] = (v[c] + v[d]) & M64; v[b] = rotr(v[b] ^ v[c], 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    g(0, 4, 8, 12, m[s[0]], m[s[1]]); g(1, 5, 9, 13, m[s[2]], m[s[3]]); g(2, 6, 10, 14, m[s[4]], m[s[5]]); g(3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(0, 5, 10, 15, m[s[8]], m[s[9]]); g(1, 6, 11, 12, m[s[10]], m[s[11]]); g(2, 7, 8, 13, m[s[12]], m[s[13]]); g(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  return h.map((x, i) => x ^ v[i] ^ v[i + 8]);
}
export const iv0 = () => { const h = [...IV]; h[0] ^= 0x01010020n; return h; };
export const wordsOf = (bytes) => Array.from({ length: 4 }, (_, k) => { let w = 0n; for (let j = 7; j >= 0; j--) w = (w << 8n) | BigInt(bytes[k * 8 + j]); return w; });
export const bytesOf = (words) => { const b = new Uint8Array(32); words.forEach((w, k) => { for (let j = 0; j < 8; j++) b[k * 8 + j] = Number((w >> BigInt(8 * j)) & 0xffn); }); return b; };
const idFields = (d) => [d[0] + d[1] * P64, d[2] + d[3] * P64];

// The scan, as the circuit steps it: one byte, and the entry it emits (subject hi, lo, output) if any.
const BYTEV2 = BYTEV.map(v => (v & 1) + 2 * (v >> 3));
export function scanStep(st, byte, act) {
  const v = BYTEV2[BSEL[st.mode] * 256 + byte];
  const cont = v & 1, cls = v >> 1;
  const bf = BigInt(byte);
  const low = bf - 128n * BigInt(cont);
  const vv = md(st.a + low * st.p);
  const z = (x) => (md(x) === 0n ? 1 : 0);
  const key = st.mode * 128 + cls * 32 + z(st.rr - 1n) * 16 + z(vv) * 8 + z(vv - 32n) * 4 + z(st.c1 - 1n) * 2 + z(st.c2 - 1n);
  const a = ACTIONS[ACT[key]];
  const B = BigInt;
  st.rr = md(B(a.RK) * st.rr + B(a.RC) + B(a.RV) * vv);
  st.c1 = md(B(a.C1K) * st.c1 + B(a.C1C) + B(a.C1V) * vv);
  st.c2 = md(B(a.C2K) * st.c2 + B(a.C2C) + B(a.C2B) * bf);
  st.a = a.VK ? vv : 0n; st.p = a.VK ? md(128n * st.p) : 1n;
  st.hi = md(B(a.HM) * st.hi + B(a.HB) * bf);
  st.lo = md(B(a.LM) * st.lo + B(a.LB) * bf);
  st.sh = md(B(a.SHM) * st.sh + B(a.SHC));
  let entry;
  const oend = a.OEND && act;
  if (oend && st.sh === 2n) entry = { hi: st.hi, lo: st.lo, out: st.outi };
  if (oend) st.outi += 1n;
  st.mode = a.NEXT;
  return entry;
}

export function initialState(parent, root) {
  const t = { h: iv0(), t: 0n, in_tx: false, mode: 0, rr: 0n, c1: 0n, c2: 0n, a: 0n, p: 1n, hi: 0n, lo: 0n, sh: 0n, outi: 0n, height: BigInt(parent.height), j: 0n, chain: 0n, echain: 0n };
  const m = { prev: wordsOf(Buffer.from(parent.id, 'hex')), height: BigInt(parent.height), mh: iv0(), hc: 0n, in_hdr: false, j: 0n,
    stack: Array.from({ length: S + 2 }, () => [0n, 0n, 0n, 0n]), sp: 0, chain: 0n };
  return { t, m, u: { chain: 0n, root } };
}
const clone = (x) => structuredClone(x);
const pack3 = (w) => w[0] + w[1] * P64 + w[2] * P128;
export function stateHash({ t, m, u }) {
  const f = [pack3([t.h[0], t.h[1], t.h[2]]), pack3([t.h[3], t.h[4], t.h[5]]), pack3([t.h[6], t.h[7], t.t]),
    t.in_tx ? 1n : 0n, BigInt(t.mode), t.rr, t.c1, t.c2, t.a, t.p, t.hi, t.lo, t.sh, t.outi, t.height, t.j, t.chain, u.root,
    pack3([m.prev[0], m.prev[1], m.prev[2]]), pack3([m.prev[3], m.hc, 0n]), m.height,
    pack3([m.mh[0], m.mh[1], m.mh[2]]), pack3([m.mh[3], m.mh[4], m.mh[5]]), pack3([m.mh[6], m.mh[7], 0n]),
    m.in_hdr ? 1n : 0n, m.j, BigInt(m.sp), m.chain, u.chain];
  for (const w of m.stack) f.push(pack3([w[0], w[1], w[2]]), w[3], 0n);
  f.push(t.echain);
  let x = 0n;
  for (let i = 0; i < f.length / 2; i++) x = perm3(x, f[2 * i], f[2 * i + 1], TAG.STATE);
  return x;
}

// The sparse Merkle tree of subjects: key = the subject's last four bytes; leaf = (count, chain) hashed.
export class SubjectMap {
  constructor() {
    this.z = [0n];
    for (let l = 0; l < D; l++) this.z.push(perm3(this.z[l], this.z[l], 0n, TAG.NODE));
    this.nodes = new Map(); this.leaves = new Map();
  }
  get root() { return this.node(D, 0n); }
  node(level, i) { return this.nodes.get(`${level}:${i}`) ?? this.z[level]; }
  path(key) { const s = []; let i = key; for (let l = 0; l < D; l++) { s.push(this.node(l, i ^ 1n)); i >>= 1n; } return s; }
  append(hi, lo, pack) {
    const key = lo % P32;
    const old = this.leaves.get(key) ?? { cnt: 0n, chain: 0n };
    const sib = this.path(key);
    const chain = perm3(old.chain, hi + pack * P128, lo, TAG.ENTRY);
    const cnt = old.cnt + 1n;
    this.leaves.set(key, { cnt, chain });
    let v = perm3(cnt, chain, 0n, TAG.LEAF), i = key;
    this.nodes.set(`0:${i}`, v);
    for (let l = 0; l < D; l++) {
      v = (i & 1n) ? perm3(sib[l], v, 0n, TAG.NODE) : perm3(v, sib[l], 0n, TAG.NODE);
      i >>= 1n; this.nodes.set(`${l + 1}:${i}`, v);
    }
    return { cnt: old.cnt, chain: old.chain, sib };
  }
}

// The streams of a period: T slots (transactions in block order), M slots (each block's tree, then its header)
// and each T slot's entries.
export function streams(blocks, { rule = 'auto' } = {}) {
  const T = [], Mops = [];
  for (const b of blocks) {
    b.txs.forEach((tx, j) => {
      const u = Buffer.from(tx.u, 'hex');
      const n = Math.max(1, Math.ceil(u.length / 128));
      for (let k = 0; k < n; k++) {
        const chunk = u.subarray(k * 128, (k + 1) * 128);
        T.push({ bytes: chunk, len: chunk.length, start: k === 0, nw: k === 0 && j === 0, last: k === n - 1 });
      }
    });
    const ids = b.txs.map(tx => blake2b(Buffer.from(tx.u, 'hex'), { dkLen: 32 }));
    const wids = b.txs.map(tx => Buffer.from(tx.w, 'hex'));
    const hb = Buffer.from(b.bytes, 'hex');
    const root = hb.subarray(65, 97);
    // The tree, eagerly merged: levels of the stack's entries.
    const leaves = [...ids.map(id => ({ op: 'id', v: id }))];
    const withW = [...leaves, ...wids.map(w => ({ op: 'wid', v: w }))];
    const build = (ls) => {
      const ops = [], lv = [], dg = [];
      const h = (pre, ...parts) => blake2b(Buffer.concat([Buffer.of(pre), ...parts]), { dkLen: 32 });
      for (const l of ls) {
        ops.push({ op: l.op, v: l.v }); lv.push(0); dg.push(h(0, l.v));
        while (lv.length >= 2 && lv.at(-1) === lv.at(-2)) { const r = dg.pop(), L = dg.pop(); lv.pop(); const x = lv.pop(); ops.push({ op: 'mrg' }); lv.push(x + 1); dg.push(h(1, L, r)); }
      }
      while (lv.length > 1 || lv[0] === 0) {
        ops.push({ op: 'lift' }); lv[lv.length - 1] += 1; dg[dg.length - 1] = h(1, dg.at(-1));
        while (lv.length >= 2 && lv.at(-1) === lv.at(-2)) { const r = dg.pop(), L = dg.pop(); lv.pop(); const x = lv.pop(); ops.push({ op: 'mrg' }); lv.push(x + 1); dg.push(h(1, L, r)); }
      }
      return { ops, root: Buffer.from(dg[0]) };
    };
    let tr = build(withW);
    if (!tr.root.equals(root)) tr = build(leaves);
    if (!tr.root.equals(root) && rule !== 'any') throw new Error(`no tree reproduces the root at ${b.height}`);
    Mops.push(...tr.ops);
    for (let k = 0; k * 128 < hb.length; k++) Mops.push({ op: 'hdr', bytes: hb.subarray(k * 128, (k + 1) * 128), last: (k + 1) * 128 >= hb.length });
  }
  return { T, M: Mops };
}

// Runs one leaf over the next T and M slots from state st; returns the witness and the state after.
export function runLeaf(st0, T, M, map, { CT, CM, E }, queue = []) {
  const st = clone(st0);
  const { t, m, u } = st;
  const tin = [], min = [], ents = [], uin = [];
  // T slots: as many as fit, keeping the leaf's entries within E.
  for (const slot of T) {
    if (tin.length === CT) break;
    // Dry-run the slot's scan for its entries.
    const probe = clone(t);
    if (slot.start) { probe.mode = 0; probe.a = 0n; probe.p = 1n; probe.outi = 0n; if (slot.nw) { probe.height += 1n; probe.j = 0n; } else probe.j += 1n; }
    const found = [];
    for (let j = 0; j < 128; j++) { const e = scanStep(probe, slot.bytes[j] ?? 0, j < slot.len); if (e) found.push(e); }
    if (ents.length + found.length > EL_PER_SLOT * CT) throw new Error('list overflow');
    // Apply it.
    const hIn = slot.start ? iv0() : t.h, tt = slot.start ? 0n : t.t, tNew = tt + BigInt(slot.len);
    const block = new Uint8Array(128); block.set(slot.bytes);
    const d = compress(hIn, block, tNew, slot.last);
    t.h = d; t.t = tNew; t.in_tx = !slot.last;
    Object.assign(t, { mode: probe.mode, rr: probe.rr, c1: probe.c1, c2: probe.c2, a: probe.a, p: probe.p, hi: probe.hi, lo: probe.lo, sh: probe.sh, outi: probe.outi, height: probe.height, j: probe.j });
    const hj = t.height * P32 + t.j;
    for (const e of found) { const x = { hi: e.hi, lo: e.lo, pack: hj * P32 + e.out }; ents.push(x); queue.push(x); t.echain = perm3(t.echain, x.hi + x.pack * P128, x.lo, TAG.ENTRY); }
    if (slot.last) { const [lo, hi] = idFields(d.slice(0, 4)); t.chain = perm3(t.chain, hi, lo + hj * P128, TAG.TX); }
    tin.push({ bytes: block, len: slot.len, start: slot.start, nw: slot.nw, last: slot.last });
  }
  // M slots.
  const hh = (pre, ...parts) => wordsOf(blake2b(Buffer.concat([Buffer.of(pre), ...parts]), { dkLen: 32 }));
  for (const op of M) {
    if (min.length === CM) break;
    const block = new Uint8Array(128);
    const sp = m.sp, top = m.stack[sp + 1], below = m.stack[sp];
    const rec = { op: op.op, id: [0n, 0n, 0n, 0n], last: false };
    let d, len;
    if (op.op === 'id' || op.op === 'wid') {
      block.set(op.v, 1); len = 1 + op.v.length; d = hh(0, op.v);
      m.stack[sp + 2] = d; m.sp = sp + 1;
      if (op.op === 'id') { rec.id = wordsOf(op.v); const [lo, hi] = idFields(rec.id); m.chain = perm3(m.chain, hi, lo + ((m.height + 1n) * P32 + m.j) * P128, TAG.TX); m.j += 1n; }
    } else if (op.op === 'mrg') {
      block[0] = 1; block.set(bytesOf(below), 1); block.set(bytesOf(top), 33); len = 65; d = hh(1, bytesOf(below), bytesOf(top));
      m.stack[sp] = d; m.sp = sp - 1;
    } else if (op.op === 'lift') {
      block[0] = 1; block.set(bytesOf(top), 1); len = 33; d = hh(1, bytesOf(top));
      m.stack[sp + 1] = d;
    } else {
      block.set(op.bytes); len = op.bytes.length;
      const first = !m.in_hdr;
      const hIn = first ? iv0() : m.mh, tNew = (first ? 0n : m.hc) + BigInt(len);
      d = compress(hIn, block, tNew, op.last);
      m.mh = d; m.hc = tNew; m.in_hdr = !op.last; rec.last = op.last;
      if (op.last) { m.prev = d.slice(0, 4); m.height += 1n; m.j = 0n; m.sp = 0; }
    }
    rec.bytes = block; rec.len = len;
    min.push(rec);
  }
  // U slots: the queued entries, applied to the map in order.
  while (uin.length < E && queue.length) {
    const x = queue.shift();
    uin.push({ ...x, ...map.append(x.hi, x.lo, x.pack) });
    u.chain = perm3(u.chain, x.hi + x.pack * P128, x.lo, TAG.ENTRY);
  }
  u.root = map.root;
  return { st, tin, min, ents, uin, usedT: tin.length, usedM: min.length, usedU: uin.length, ew: uin };
}

const S_ = (x) => x.toString();
const words = (w) => w.map(S_);
export const tJson = (t) => ({ h: words(t.h), t: S_(t.t), in_tx: t.in_tx, mode: S_(t.mode), rr: S_(t.rr), c1: S_(t.c1), c2: S_(t.c2), a: S_(t.a), p: S_(t.p),
  hi: S_(t.hi), lo: S_(t.lo), sh: S_(t.sh), outi: S_(t.outi), height: S_(t.height), j: S_(t.j), chain: S_(t.chain) });
export const mJson = (m) => ({ prev: words(m.prev), height: S_(m.height), mh: words(m.mh), hc: S_(m.hc), in_hdr: m.in_hdr, j: S_(m.j),
  stack: m.stack.map(words), sp: S_(m.sp), chain: S_(m.chain) });
const OPS = ['id', 'wid', 'mrg', 'lift', 'hdr'];
const tJsonV = (t) => ({ ...tJson(t), echain: S_(t.echain) });
const uJson = (u) => ({ chain: S_(u.chain), root: S_(u.root) });
/** The circuit's inputs for one leaf of the given sizes (a section of size zero is left out). */
export function inputs(st0, leaf, { CT, CM, E }) {
  const x = { sin: S_(stateHash(st0)), sout: S_(stateHash(leaf.st)), key_node: S_(KEY_NODE.value), t0: tJsonV(st0.t), m0: mJson(st0.m), u0: uJson(st0.u) };
  if (CT > 0) {
    const tz = { bytes: new Uint8Array(128), len: 0, start: false, nw: false, last: false };
    const T = [...leaf.tin, ...Array(CT - leaf.tin.length).fill(tz)];
    const EL = EL_PER_SLOT * CT, lz = { hi: 0n, lo: 0n, pack: 0n };
    const L = [...leaf.ents, ...Array(EL - leaf.ents.length).fill(lz)];
    Object.assign(x, { tb: T.map(s => [...s.bytes].map(String)), tlen: T.map(s => String(s.len)), tstart: T.map(s => s.start), tnew: T.map(s => s.nw), tlast: T.map(s => s.last),
      lu: L.map((e, k) => k < leaf.ents.length), lhi: L.map(e => S_(e.hi)), llo: L.map(e => S_(e.lo)), lpack: L.map(e => S_(e.pack)) });
  }
  if (CM > 0) {
    const mz = { op: 'nop', bytes: new Uint8Array(128), len: 0, last: false, id: [0n, 0n, 0n, 0n] };
    const Mm = [...leaf.min, ...Array(CM - leaf.min.length).fill(mz)];
    Object.assign(x, { mb: Mm.map(s => [...s.bytes].map(String)), mlen: Mm.map(s => String(s.len)), mop: Mm.map(s => OPS.map(o => o === s.op)), mlast: Mm.map(s => s.last), mid: Mm.map(s => words(s.id)) });
  }
  if (E > 0) {
    const ez = { hi: 0n, lo: 0n, pack: 0n, cnt: 0n, chain: 0n, sib: Array(D).fill(0n) };
    const U = [...leaf.uin, ...Array(E - leaf.uin.length).fill(ez)];
    Object.assign(x, { uu: U.map((e, k) => k < leaf.uin.length), uhi: U.map(e => S_(e.hi)), ulo: U.map(e => S_(e.lo)), upack: U.map(e => S_(e.pack)),
      ucnt: U.map(e => S_(e.cnt)), uchain: U.map(e => S_(e.chain)), usib: U.map(e => e.sib.map(S_)) });
  }
  return x;
}
export const kindInputs = inputs;

/** The period's top check, as the fold makes it over the first and last states: the three streams end together, at
 * a block boundary, with one chain of ids and one of entries. */
export function topCheck(final) {
  const { t, m, u } = final;
  return t.chain === m.chain && t.echain === u.chain && !t.in_tx && !m.in_hdr && m.sp === 0 && t.height === m.height;
}
export const endId = (final) => Buffer.from(bytesOf(final.m.prev)).toString('hex');

/** A period as three leaf kinds over one state: T-leaves (CT slots), M-leaves (CM slots) and U-leaves (EU slots),
 * the T and M streams interleaved by progress, and a U-leaf whenever EU entries wait (and at the end). */
export function periodKinds(data, { CT, CM, EU }, map = new SubjectMap()) {
  const { T, M } = streams(data.blocks);
  let st = initialState(data.parent, map.root);
  const leaves = [], queue = [];
  let ti = 0, mi = 0;
  const run = (kind, params, tSlots, mSlots) => {
    const leaf = runLeaf(st, tSlots, mSlots, map, params, queue);
    leaves.push({ kind, params, st0: st, leaf });
    st = leaf.st; return leaf;
  };
  while (ti < T.length || mi < M.length || queue.length) {
    if (queue.length >= EU || (ti >= T.length && queue.length)) { run('U', { CT: 0, CM: 0, E: EU }, [], []); continue; }
    const doT = ti < T.length && (mi >= M.length || ti / T.length <= mi / M.length);
    const leaf = doT ? run('T', { CT, CM: 0, E: 0 }, T.slice(ti, ti + CT), []) : run('M', { CT: 0, CM, E: 0 }, [], M.slice(mi, mi + CM));
    ti += leaf.usedT; mi += leaf.usedM;
  }
  return { leaves, final: st, T: T.length, M: M.length, map };
}
