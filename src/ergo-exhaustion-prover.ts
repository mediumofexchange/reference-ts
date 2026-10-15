// The exhaustion's prover side (succinct-read §4.3): a period of authenticated blocks divided into the three leaves'
// slots, each leaf's circuit inputs and its state hashes, computed as the circuits compute them
// (scripts/venue/exhaustion-sources.mjs, exhaustion-circuits/exhaustion.nr). A prover runs the circuits over these
// inputs; nothing here is a reader's check, and no reader trusts it: a fold proves the map a reader recomputes paths
// against (§4.4).
//
// The state is the set's own (§2's last three tags): its layout, packing and order are fixed by the circuits' sources,
// which the set identity binds (§6), and this module mirrors them.
import { blake2b } from "@noble/hashes/blake2b.js";
import { copyBytes, EncodingError } from "./bytes.js";
import { MAP_DEPTH, mapLeaf, mapNode, entryChain, subjectKey, SubjectMap, type MapUpdate } from "./ergo-exhaustion.js";
import { sectionMatchesRoot, transactionsRoot } from "./ergo-profile.js";
import { SCAN_START, scanStep, type ScanState } from "./ergo-scan.js";
import { limbsOf } from "./pool/field.js";
import { poseidon2Hash } from "./pool/poseidon2.js";

export const T_EX_ID = 1013n;
export const T_EX_STATE = 1014n;
export const T_EX_CHALLENGE = 1015n;
/** The tree machine's stack: two sentinel positions below S live entries. */
export const STACK = 18;
/** Entries a transaction slot's list holds (exhaustion-sources.mjs' LIST_PER_SLOT). */
export const LIST_PER_SLOT = 4;
const M64 = (1n << 64n) - 1n, P64 = 1n << 64n, P128 = 1n << 128n;

// Blake2b's compression over 64-bit words, as the circuits' blake2b.nr computes it.
const IV = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
const SIGMA = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0]] as const;
const rotr = (x: bigint, n: bigint): bigint => ((x >> n) | (x << (64n - n))) & M64;
const word = (bytes: Uint8Array, i: number): bigint => {
  let w = 0n;
  for (let j = 7; j >= 0; j--) w = (w << 8n) | BigInt(bytes[i * 8 + j]!);
  return w;
};
export function compress(h: readonly bigint[], block: Uint8Array, counted: bigint, last: boolean): bigint[] {
  const m = Array.from({ length: 16 }, (_, i) => word(block, i));
  const v = [...h, ...IV];
  v[12]! ^= counted;
  if (last) v[14]! ^= M64;
  const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint): void => {
    v[a] = (v[a]! + v[b]! + x) & M64; v[d] = rotr(v[d]! ^ v[a]!, 32n); v[c] = (v[c]! + v[d]!) & M64; v[b] = rotr(v[b]! ^ v[c]!, 24n);
    v[a] = (v[a]! + v[b]! + y) & M64; v[d] = rotr(v[d]! ^ v[a]!, 16n); v[c] = (v[c]! + v[d]!) & M64; v[b] = rotr(v[b]! ^ v[c]!, 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10]!;
    g(0, 4, 8, 12, m[s[0]]!, m[s[1]]!); g(1, 5, 9, 13, m[s[2]]!, m[s[3]]!); g(2, 6, 10, 14, m[s[4]]!, m[s[5]]!); g(3, 7, 11, 15, m[s[6]]!, m[s[7]]!);
    g(0, 5, 10, 15, m[s[8]]!, m[s[9]]!); g(1, 6, 11, 12, m[s[10]]!, m[s[11]]!); g(2, 7, 8, 13, m[s[12]]!, m[s[13]]!); g(3, 4, 9, 14, m[s[14]]!, m[s[15]]!);
  }
  return h.map((x, i) => x ^ v[i]! ^ v[i + 8]!);
}
export const iv0 = (): bigint[] => { const h = [...IV]; h[0]! ^= 0x01010020n; return h; };
/** A 32-byte digest's four little-endian words. */
export const wordsOf = (bytes: Uint8Array): bigint[] => Array.from({ length: 4 }, (_, k) => word(bytes, k));
export const bytesOf = (words: readonly bigint[]): Uint8Array => {
  const out = new Uint8Array(32);
  words.forEach((w, k) => { for (let j = 0; j < 8; j++) out[k * 8 + j] = Number((w >> BigInt(8 * j)) & 0xffn); });
  return out;
};
const digest = (prefix: number, ...parts: Uint8Array[]): bigint[] => {
  const message = new Uint8Array(1 + parts.reduce((n, p) => n + p.length, 0));
  message[0] = prefix;
  let at = 1;
  for (const part of parts) { message.set(part, at); at += part.length; }
  return wordsOf(blake2b(message, { dkLen: 32 }));
};

/** The transaction stream's state (exhaustion.nr's T). */
export interface TState {
  h: bigint[]; t: bigint; inTx: boolean; scan: ScanState; height: bigint; j: bigint; chain: bigint; echain: bigint;
}
/** The tree-and-header stream's state (exhaustion.nr's M). */
export interface MState {
  prev: bigint[]; height: bigint; mh: bigint[]; hc: bigint; inHeader: boolean; j: bigint; stack: bigint[][]; sp: number; chain: bigint;
}
/** The map stream's state (exhaustion.nr's U). */
export interface UState { chain: bigint; root: bigint }
export interface ExhaustionState { readonly t: TState; readonly m: MState; readonly u: UState }

const clone = (s: ExhaustionState): ExhaustionState => ({
  t: { ...s.t, h: [...s.t.h], scan: { ...s.t.scan } },
  m: { ...s.m, prev: [...s.m.prev], mh: [...s.m.mh], stack: s.m.stack.map(w => [...w]) },
  u: { ...s.u },
});
/** A period's start state at the header `id` at `height`, the map at `root` there. */
export function startState(id: Uint8Array, height: bigint, root: bigint): ExhaustionState {
  return {
    t: { h: iv0(), t: 0n, inTx: false, scan: SCAN_START, height, j: 0n, chain: 0n, echain: 0n },
    m: { prev: wordsOf(id), height, mh: iv0(), hc: 0n, inHeader: false, j: 0n, stack: Array.from({ length: STACK + 2 }, () => [0n, 0n, 0n, 0n]), sp: 0, chain: 0n },
    u: { chain: 0n, root },
  };
}
const pack3 = (a: bigint, b: bigint, c: bigint): bigint => a + b * P64 + c * P128;
/** H(T_EX_STATE, ...): exhaustion.nr's state_hash. */
export function stateHash({ t, m, u }: ExhaustionState): bigint {
  const s = t.scan;
  const f = [T_EX_STATE, pack3(t.h[0]!, t.h[1]!, t.h[2]!), pack3(t.h[3]!, t.h[4]!, t.h[5]!), pack3(t.h[6]!, t.h[7]!, t.t),
    t.inTx ? 1n : 0n, BigInt(s.mode), s.r, s.c1, s.c2, s.a, s.p, s.hi, s.lo, s.sh, BigInt(s.outputs), t.height, t.j, t.chain, t.echain,
    pack3(m.prev[0]!, m.prev[1]!, m.prev[2]!), pack3(m.prev[3]!, m.hc, 0n), m.height,
    pack3(m.mh[0]!, m.mh[1]!, m.mh[2]!), pack3(m.mh[3]!, m.mh[4]!, m.mh[5]!), pack3(m.mh[6]!, m.mh[7]!, 0n),
    m.inHeader ? 1n : 0n, m.j, BigInt(m.sp)];
  for (const w of m.stack) f.push(pack3(w[0]!, w[1]!, w[2]!), w[3]!);
  f.push(m.chain, u.chain, u.root);
  return poseidon2Hash(f);
}
export function idChain(previous: bigint, id: readonly bigint[], height: bigint, position: bigint): bigint {
  return poseidon2Hash([T_EX_ID, previous, id[0]! + id[1]! * P64, id[2]! + id[3]! * P64, height, position]);
}
/** The stream's entry chain over every key, in §4.2's T_ENTRY form. */
const streamChain = (previous: bigint, e: Entry): bigint => poseidon2Hash([1010n, previous, e.hi, e.lo, e.height, e.position, e.output]);

/** An entry as the circuits carry it: the subject's limbs and its place. A hostile list may hold a row marked unused. */
export interface Entry {
  readonly hi: bigint; readonly lo: bigint; readonly height: bigint; readonly position: bigint; readonly output: bigint; readonly unused?: boolean;
}

/** An authenticated block: its header's bytes and its section, in order. */
export interface ExhaustionBlock {
  readonly header: Uint8Array;
  readonly transactions: readonly { readonly unsigned: Uint8Array; readonly witnessId: Uint8Array }[];
}
/** A transaction slot: up to 128 bytes, the length the slot claims (the bytes' own by default; a hostile witness may
 * claim fewer than it carries), and whether it starts a transaction, a block, or ends a transaction. */
export interface TSlot { readonly bytes: Uint8Array; readonly length?: number; readonly start: boolean; readonly newBlock: boolean; readonly last: boolean }
/** A tree-and-header operation. A hostile witness may push an id claiming another than the one hashed or hashed under
 * another prefix, or lift with bytes after the entry. */
export type MOp = { readonly op: "id"; readonly id: Uint8Array; readonly claim?: Uint8Array; readonly prefix?: number }
  | { readonly op: "wid"; readonly witnessId: Uint8Array } | { readonly op: "mrg" } | { readonly op: "lift"; readonly extra?: Uint8Array }
  | { readonly op: "hdr"; readonly bytes: Uint8Array; readonly last: boolean };

/** venue-ergo §4's tree over `leaves` as the stack machine builds it: each leaf pushed, equal levels merged eagerly, a
 * lone child lifted. */
function treeOps(leaves: readonly MOp[]): MOp[] {
  const ops: MOp[] = [], levels: number[] = [];
  const merge = (): void => {
    while (levels.length >= 2 && levels.at(-1) === levels.at(-2)) { levels.pop(); levels[levels.length - 1]! += 1; ops.push({ op: "mrg" }); }
  };
  for (const leaf of leaves) { ops.push(leaf); levels.push(0); merge(); }
  while (levels.length > 1 || levels[0] === 0) { ops.push({ op: "lift" }); levels[levels.length - 1]! += 1; merge(); }
  return ops;
}
/** A period's streams: its transactions' slots and its trees' and headers' operations. Each section must reproduce its
 * header's root (the caller authenticated it). */
export function periodStreams(blocks: readonly ExhaustionBlock[]): { readonly t: readonly TSlot[]; readonly m: readonly MOp[] } {
  const t: TSlot[] = [], m: MOp[] = [];
  for (const block of blocks) {
    if (block.transactions.length === 0) throw new EncodingError("an exhaustion block has an empty section");
    block.transactions.forEach(({ unsigned }, j) => {
      const n = Math.max(1, Math.ceil(unsigned.length / 128));
      for (let k = 0; k < n; k++) t.push({ bytes: copyBytes(unsigned.subarray(k * 128, (k + 1) * 128)), start: k === 0, newBlock: k === 0 && j === 0, last: k === n - 1 });
    });
    const read = block.transactions.map(x => ({ id: blake2b(x.unsigned, { dkLen: 32 }), witnessId: copyBytes(x.witnessId) }));
    const root = block.header.subarray(65, 97);
    if (!sectionMatchesRoot(read, root)) throw new EncodingError("a section does not reproduce its header's root");
    const ids: MOp[] = read.map(x => ({ op: "id", id: x.id }));
    const witness = Buffer.from(transactionsRoot(2n, read)).equals(Buffer.from(root));
    m.push(...treeOps(witness ? [...ids, ...read.map(x => ({ op: "wid" as const, witnessId: x.witnessId }))] : ids));
    for (let k = 0; k * 128 < block.header.length; k++) m.push({ op: "hdr", bytes: copyBytes(block.header.subarray(k * 128, (k + 1) * 128)), last: (k + 1) * 128 >= block.header.length });
  }
  return { t, m };
}

/** One leaf: its kind, its circuit's inputs (noir_js' map) and its two state hashes. */
export interface ExhaustionLeaf { readonly kind: "t" | "m" | "u"; readonly inputs: Record<string, unknown>; readonly sin: bigint; readonly sout: bigint }
export interface LeafSizes { readonly t: number; readonly m: number; readonly u: number }

const dec = (x: bigint | number): string => x.toString();
const words = (w: readonly bigint[]): string[] => w.map(dec);
function stateInputs({ t, m, u }: ExhaustionState): Record<string, unknown> {
  const s = t.scan;
  return {
    t: { h: words(t.h), t: dec(t.t), in_tx: t.inTx, mode: dec(s.mode), r: dec(s.r), c1: dec(s.c1), c2: dec(s.c2), a: dec(s.a), p: dec(s.p), hi: dec(s.hi),
      lo: dec(s.lo), sh: dec(s.sh), outi: dec(s.outputs), height: dec(t.height), j: dec(t.j), chain: dec(t.chain), echain: dec(t.echain) },
    m: { prev: words(m.prev), height: dec(m.height), mh: words(m.mh), hc: dec(m.hc), in_hdr: m.inHeader, j: dec(m.j), stack: m.stack.map(words),
      sp: dec(m.sp), chain: dec(m.chain) },
    u: { chain: dec(u.chain), root: dec(u.root) },
  };
}
/** The state names a leaf's circuit gives the stream it advances and the two it carries. */
function leafInputs(kind: "t" | "m" | "u", before: ExhaustionState, after: ExhaustionState, nodeKeyHash: bigint, own: Record<string, unknown>): ExhaustionLeaf {
  const state = stateInputs(before);
  const sin = stateHash(before), sout = stateHash(after);
  const named = { t: kind === "t" ? "t0" : "t", m: kind === "m" ? "m0" : "m", u: kind === "u" ? "u0" : "u" };
  return { kind, sin, sout, inputs: { sin: dec(sin), sout: dec(sout), node_key_hash: dec(nodeKeyHash), [named.t]: state.t, [named.m]: state.m, [named.u]: state.u, ...own } };
}

/** The transaction leaf over `slots` from `state`: the state after and the entries it emitted, in order. `list` is the
 * list the prover gives the circuit, the emitted entries by default (a hostile witness may give another). */
export function transactionLeaf(state: ExhaustionState, slots: readonly TSlot[], size: number, nodeKeyHash: bigint,
    list: (emitted: readonly Entry[]) => readonly Entry[] = e => e): { leaf: ExhaustionLeaf; after: ExhaustionState; entries: Entry[] } {
  const after = clone(state), t = after.t, emitted: Entry[] = [];
  for (const slot of slots) {
    const block = new Uint8Array(128);
    block.set(slot.bytes);
    const length = slot.length ?? slot.bytes.length;
    const counted = (slot.start ? 0n : t.t) + BigInt(length);
    const d = compress(slot.start ? iv0() : t.h, block, counted, slot.last);
    t.h = d; t.t = counted; t.inTx = !slot.last;
    if (slot.newBlock) { t.height += 1n; t.j = 0n; } else if (slot.start) t.j += 1n;
    if (slot.start) t.scan = SCAN_START;
    for (let j = 0; j < 128; j++) {
      const before = t.scan, step = scanStep(before, block[j]!), act = j < length;
      t.scan = act ? step.state : { ...step.state, outputs: before.outputs };
      if (act && step.shaped) {
        emitted.push({ hi: step.state.hi, lo: step.state.lo, height: t.height, position: t.j, output: BigInt(before.outputs) });
      }
    }
    if (slot.last) t.chain = idChain(t.chain, d.slice(0, 4), t.height, t.j);
  }
  const entries = [...list(emitted)];
  if (entries.length > LIST_PER_SLOT * size) throw new EncodingError("a transaction leaf's list overflows");
  for (const e of entries) if (e.unused !== true) t.echain = streamChain(t.echain, e);
  const pad = <X>(xs: readonly X[], n: number, zero: X): X[] => [...xs, ...Array<X>(n - xs.length).fill(zero)];
  const tb = pad(slots.map(s => { const b = new Uint8Array(128); b.set(s.bytes); return [...b].map(String); }), size, Array<string>(128).fill("0"));
  const rows = pad(entries, LIST_PER_SLOT * size, { hi: 0n, lo: 0n, height: 0n, position: 0n, output: 0n });
  const own = {
    tb, tlen: pad(slots.map(s => String(s.length ?? s.bytes.length)), size, "0"), tstart: pad(slots.map(s => s.start), size, false),
    tnew: pad(slots.map(s => s.newBlock), size, false), tlast: pad(slots.map(s => s.last), size, false),
    lu: rows.map((e, k) => k < entries.length && e.unused !== true), lhi: rows.map(e => dec(e.hi)), llo: rows.map(e => dec(e.lo)), lheight: rows.map(e => dec(e.height)),
    lposition: rows.map(e => dec(e.position)), loutput: rows.map(e => dec(e.output)),
  };
  return { leaf: leafInputs("t", state, after, nodeKeyHash, own), after, entries: emitted };
}

const OPS = ["id", "wid", "mrg", "lift", "hdr"] as const;
/** The tree-and-header leaf over `ops` from `state`. */
export function treeLeaf(state: ExhaustionState, ops: readonly MOp[], size: number, nodeKeyHash: bigint): { leaf: ExhaustionLeaf; after: ExhaustionState } {
  const after = clone(state), m = after.m;
  const slots: { bytes: Uint8Array; len: number; op: MOp["op"]; last: boolean; id: bigint[] }[] = [];
  for (const op of ops) {
    const block = new Uint8Array(128);
    const sp = m.sp, top = m.stack[sp + 1]!, below = m.stack[sp]!;
    let len: number, id = [0n, 0n, 0n, 0n], last = false;
    if (op.op === "id" || op.op === "wid") {
      const leaf = op.op === "id" ? op.id : op.witnessId, prefix = op.op === "id" ? op.prefix ?? 0 : 0;
      block[0] = prefix; block.set(leaf, 1); len = 1 + leaf.length;
      m.stack[sp + 2] = digest(prefix, leaf); m.sp = sp + 1;
      if (op.op === "id") { id = wordsOf(op.claim ?? op.id); m.chain = idChain(m.chain, id, m.height + 1n, m.j); m.j += 1n; }
    } else if (op.op === "mrg") {
      block[0] = 1; block.set(bytesOf(below), 1); block.set(bytesOf(top), 33); len = 65;
      m.stack[sp] = digest(1, bytesOf(below), bytesOf(top)); m.sp = sp - 1;
    } else if (op.op === "lift") {
      const extra = op.extra ?? new Uint8Array(0);
      block[0] = 1; block.set(bytesOf(top), 1); block.set(extra, 33); len = 33 + extra.length;
      m.stack[sp + 1] = digest(1, bytesOf(top), extra);
    } else {
      block.set(op.bytes); len = op.bytes.length; last = op.last;
      const counted = (m.inHeader ? m.hc : 0n) + BigInt(len);
      const d = compress(m.inHeader ? m.mh : iv0(), block, counted, op.last);
      m.mh = d; m.hc = counted; m.inHeader = !op.last;
      if (op.last) { m.prev = d.slice(0, 4); m.height += 1n; m.j = 0n; m.sp = 0; }
    }
    slots.push({ bytes: block, len, op: op.op, last, id });
  }
  const empty = { bytes: new Uint8Array(128), len: 0, op: undefined, last: false, id: [0n, 0n, 0n, 0n] };
  const all = [...slots, ...Array(size - slots.length).fill(empty)] as typeof slots;
  const own = {
    mb: all.map(s => [...s.bytes].map(String)), mlen: all.map(s => String(s.len)), mop: all.map(s => OPS.map(o => o === s.op)),
    mlast: all.map(s => s.last), mid: all.map(s => words(s.id)),
  };
  return { leaf: leafInputs("m", state, after, nodeKeyHash, own), after };
}

/** The map-update leaf over the next `updates` from `state`, each proved against its `before` path. */
export function mapUpdateLeaf(state: ExhaustionState, updates: readonly MapUpdate[], size: number, nodeKeyHash: bigint): { leaf: ExhaustionLeaf; after: ExhaustionState } {
  const after = clone(state), u = after.u;
  const rows = updates.map(({ entry, before }) => {
    const [hi, lo] = limbsOf(entry.subject);
    const e: Entry = { hi, lo, height: entry.height, position: entry.position, output: entry.output };
    u.chain = streamChain(u.chain, e);
    let node = mapLeaf(before.count + 1n, entryChain(before.chain, entry)), key = subjectKey(entry.subject);
    for (let l = 0; l < MAP_DEPTH; l++, key >>= 1n) node = key & 1n ? mapNode(before.siblings[l]!, node) : mapNode(node, before.siblings[l]!);
    u.root = node;
    return { e, before };
  });
  const zero = { e: { hi: 0n, lo: 0n, height: 0n, position: 0n, output: 0n }, before: { count: 0n, chain: 0n, siblings: Array<bigint>(MAP_DEPTH).fill(0n) } };
  const all = [...rows, ...Array(size - rows.length).fill(zero)] as typeof rows;
  const own = {
    uu: all.map((_, k) => k < rows.length), uhi: all.map(r => dec(r.e.hi)), ulo: all.map(r => dec(r.e.lo)), uheight: all.map(r => dec(r.e.height)),
    uposition: all.map(r => dec(r.e.position)), uoutput: all.map(r => dec(r.e.output)), ucount: all.map(r => dec(r.before.count)),
    uchain: all.map(r => dec(r.before.chain)), usiblings: all.map(r => r.before.siblings.map(dec)),
  };
  return { leaf: leafInputs("u", state, after, nodeKeyHash, own), after };
}

/** A period's leaves in order, from `map` at the period's start (advanced here to its end) over `blocks`: transaction
 * and tree-and-header leaves interleaved by progress, a map-update leaf whenever a leaf's worth of entries waits and at
 * the end. The leaves join end to start; the last state is the period's end. */
export function periodLeaves(map: SubjectMap, blocks: readonly ExhaustionBlock[], sizes: LeafSizes, nodeKeyHash = 0n):
    { readonly leaves: readonly ExhaustionLeaf[]; readonly start: ExhaustionState; readonly end: ExhaustionState } {
  const begin = map.end;
  const start = startState(begin.id, begin.height, map.root);
  const { t: tSlots, m: mOps } = periodStreams(blocks);
  const updates: MapUpdate[] = [];
  for (const block of blocks) updates.push(...map.appendBlock(blake2b(block.header, { dkLen: 32 }), block.transactions.map(x => x.unsigned)));
  const leaves: ExhaustionLeaf[] = [];
  let state = start, ti = 0, mi = 0, emitted = 0, applied = 0;
  while (ti < tSlots.length || mi < mOps.length || applied < emitted) {
    const waiting = emitted - applied;
    if (waiting >= sizes.u || (ti >= tSlots.length && waiting > 0)) {
      const n = Math.min(waiting, sizes.u), r = mapUpdateLeaf(state, updates.slice(applied, applied + n), sizes.u, nodeKeyHash);
      leaves.push(r.leaf); state = r.after; applied += n;
      continue;
    }
    if (ti < tSlots.length && (mi >= mOps.length || ti / tSlots.length <= mi / mOps.length)) {
      const n = Math.min(sizes.t, tSlots.length - ti), r = transactionLeaf(state, tSlots.slice(ti, ti + n), sizes.t, nodeKeyHash);
      leaves.push(r.leaf); state = r.after; ti += n; emitted += r.entries.length;
    } else {
      const n = Math.min(sizes.m, mOps.length - mi), r = treeLeaf(state, mOps.slice(mi, mi + n), sizes.m, nodeKeyHash);
      leaves.push(r.leaf); state = r.after; mi += n;
    }
  }
  if (emitted !== updates.length) throw new Error("the circuits' scan and the map disagree on a period's entries");
  return { leaves: Object.freeze(leaves), start, end: state };
}

/** The circuits' start state's inputs, for a fold. */
export const foldStateInputs = (state: ExhaustionState, suffix: "0" | "1"): Record<string, unknown> => {
  const s = stateInputs(state);
  return { [`t${suffix}`]: s.t, [`m${suffix}`]: s.m, [`u${suffix}`]: s.u };
};
/** Whether a state is a period's end as a fold requires (exhaustion.nr's assert_end). */
export function isPeriodEnd({ t, m, u }: ExhaustionState): boolean {
  return !t.inTx && !m.inHeader && m.sp === 0 && t.height === m.height && t.chain === m.chain && t.echain === u.chain;
}
export const stateEnd = ({ m }: ExhaustionState): { readonly id: Uint8Array; readonly height: bigint } => ({ id: bytesOf(m.prev), height: m.height });
