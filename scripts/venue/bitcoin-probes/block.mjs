// Bitcoin block parser and verifier for the venue probes (Next 12). Our own code, no library
// decoder: it frames every transaction, recomputes txid and wtxid, checks the header's Merkle
// root (refusing CVE-2012-2459's duplicated-pair mutation), the BIP141 witness commitment, the
// BIP34 height and proof of work. It throws `BlockError` with a named check on any refusal.
import { createHash } from 'node:crypto';

export class BlockError extends Error {
  constructor(check, detail = '') {
    super(`${check}${detail ? `: ${detail}` : ''}`);
    this.check = check;
  }
}

const sha256d = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return createHash('sha256').update(h.digest()).digest();
};

// Probe 3's fee bands (sat/vB, lower bounds) for comparing records with ordinary transactions.
export const BANDS = [0, 1, 2, 3, 5, 10, 20];
export const band = (rate) => { let k = 0; for (let i = 0; i < BANDS.length; i++) if (rate >= BANDS[i]) k = i; return k; };

export const MAX_WEIGHT = 4_000_000n;
export const POW_LIMIT = 0xffffn << 208n;

function reader(buf, check) {
  let at = 0;
  const need = (n) => {
    if (n < 0 || at + n > buf.length) throw new BlockError(check, `truncated at ${at}`);
  };
  return {
    get at() { return at; },
    bytes(n) { need(n); const b = buf.subarray(at, at + n); at += n; return b; },
    u8() { need(1); return buf[at++]; },
    u32() { need(4); const v = buf.readUInt32LE(at); at += 4; return v; },
    u64() { need(8); const v = buf.readBigUInt64LE(at); at += 8; return v; },
    varint() {
      const first = this.u8();
      if (first < 0xfd) return first;
      if (first === 0xfd) { need(2); const v = buf.readUInt16LE(at); at += 2; if (v < 0xfd) throw new BlockError(check, 'non-canonical varint'); return v; }
      if (first === 0xfe) { const v = this.u32(); if (v <= 0xffff) throw new BlockError(check, 'non-canonical varint'); return v; }
      const v = this.u64();
      if (v <= 0xffffffffn || v > BigInt(buf.length)) throw new BlockError(check, 'varint out of range');
      return Number(v);
    },
  };
}

export function bitsToTarget(bits) {
  const exponent = bits >>> 24;
  const mantissa = bits & 0x7fffff;
  if (bits & 0x800000) throw new BlockError('BITS', 'negative target');
  const target = exponent <= 3 ? BigInt(mantissa >>> (8 * (3 - exponent))) : BigInt(mantissa) << BigInt(8 * (exponent - 3));
  if (target === 0n || target > POW_LIMIT) throw new BlockError('BITS', 'target out of range');
  return target;
}

export function targetToBits(target) {
  let size = 0;
  for (let t = target; t > 0n; t >>= 8n) size++;
  let compact = size <= 3 ? Number(target << BigInt(8 * (3 - size))) : Number(target >> BigInt(8 * (size - 3)));
  if (compact & 0x800000) { compact >>>= 8; size++; }
  return (compact | (size << 24)) >>> 0;
}

const leToBigInt = (b) => BigInt(`0x${Buffer.from(b).reverse().toString('hex')}`);

export function parseHeader(raw) {
  if (raw.length !== 80) throw new BlockError('HEADER', 'length');
  const hash = sha256d(raw);
  const bits = raw.readUInt32LE(72);
  const target = bitsToTarget(bits);
  if (leToBigInt(hash) > target) throw new BlockError('POW');
  return {
    hash: Buffer.from(hash).reverse().toString('hex'),
    version: raw.readInt32LE(0),
    prev: Buffer.from(raw.subarray(4, 36)).reverse().toString('hex'),
    merkleRoot: Buffer.from(raw.subarray(36, 68)),
    time: raw.readUInt32LE(68),
    bits,
    target,
    work: (1n << 256n) / (target + 1n),
  };
}

// Bitcoin Core's ComputeMerkleRoot: odd levels duplicate their last hash; an equal adjacent pair
// at an even position means a mutated list (CVE-2012-2459) and is refused.
export function merkleRoot(leaves, check) {
  if (leaves.length === 0) throw new BlockError(check, 'empty');
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      if (i + 1 < level.length && level[i].equals(right)) throw new BlockError(check, 'mutated (duplicated pair)');
      next.push(sha256d(level[i], right));
    }
    level = next;
  }
  return level[0];
}

const ENVELOPE = Buffer.from([0x00, 0x63]); // OP_FALSE OP_IF

function parseTx(r, buf, index) {
  const start = r.at;
  r.u32();
  const afterVersion = r.at;
  let segwit = false;
  if (buf[r.at] === 0x00) {
    r.u8();
    if (r.u8() !== 0x01) throw new BlockError('TX', `${index}: witness flag`);
    segwit = true;
  }
  const ioStart = r.at;
  const nIn = r.varint();
  if (nIn === 0) throw new BlockError('TX', `${index}: no inputs`);
  const inputs = [];
  for (let i = 0; i < nIn; i++) {
    const prevout = r.bytes(36);
    const scriptSig = r.bytes(r.varint());
    r.u32();
    inputs.push({ prevout, scriptSig });
  }
  const nOut = r.varint();
  if (nOut === 0) throw new BlockError('TX', `${index}: no outputs`);
  const outputs = [];
  for (let i = 0; i < nOut; i++) {
    const value = r.u64();
    outputs.push({ value, script: r.bytes(r.varint()) });
  }
  const ioEnd = r.at;
  let witnessBytes = 0;
  let anyWitness = false;
  const witnesses = [];
  if (segwit) {
    const wStart = r.at;
    for (let i = 0; i < nIn; i++) {
      const items = [];
      const n = r.varint();
      for (let k = 0; k < n; k++) items.push(r.bytes(r.varint()));
      if (n > 0) anyWitness = true;
      witnesses.push(items);
    }
    witnessBytes = r.at - wStart;
    if (!anyWitness) throw new BlockError('TX', `${index}: superfluous witness`);
  }
  const lockStart = r.at;
  r.u32();
  const end = r.at;
  const txid = sha256d(buf.subarray(start, afterVersion), buf.subarray(ioStart, ioEnd), buf.subarray(lockStart, end));
  const wtxid = segwit ? sha256d(buf.subarray(start, end)) : txid;
  const stripped = (afterVersion - start) + (ioEnd - ioStart) + 4;
  return { txid, wtxid, size: end - start, stripped, inputs, outputs, witnesses, segwit, witnessBytes };
}

function envelopeInput(items) {
  let n = items.length;
  if (n >= 2 && items[n - 1].length > 0 && items[n - 1][0] === 0x50) n--; // annex
  if (n < 2) return null;
  const control = items[n - 1];
  if (control.length < 33 || (control.length - 33) % 32 !== 0 || (control[0] & 0xfe) !== 0xc0) return null;
  const script = items[n - 2];
  return script.indexOf(ENVELOPE) >= 0 ? script.length : null;
}

function bip34Height(scriptSig) {
  const len = scriptSig[0];
  if (!(len >= 1 && len <= 8) || scriptSig.length < 1 + len) throw new BlockError('BIP34', 'no height push');
  return Number(leToBigInt(scriptSig.subarray(1, 1 + len)));
}

/**
 * Parses and verifies one raw block. Returns its header and the probe's statistics; throws
 * `BlockError` on any refusal. `height` is the height the caller expects (BIP34 binds it).
 */
export function verifyBlock(buf, height) {
  const header = parseHeader(buf.subarray(0, 80));
  const r = reader(buf, 'TX');
  r.bytes(80);
  const nTx = r.varint();
  if (nTx === 0) throw new BlockError('TX', 'no transactions');
  const txids = [];
  const wtxids = [];
  let stripped = 80 + (r.at - 80);
  let anyWitness = false;
  let coinbase;
  // Probe 3: each transaction carrying an OP_RETURN over 83 B or several OP_RETURN outputs (a record
  // candidate), with its index, largest OP_RETURN script and OP_RETURN count.
  const records = [];
  const stats = {
    opReturnOutputs: 0, opReturnBytes: 0, opReturnOver83: 0, opReturnOver83Bytes: 0,
    opReturnAtLeast139: 0, opReturnAtLeast1000: 0, opReturnMax: 0,
    multiOpReturnTxs: 0, multiOpReturnOver83Txs: 0, envelopeInputs: 0, envelopeBytes: 0, tx64: 0,
  };
  for (let i = 0; i < nTx; i++) {
    const tx = parseTx(r, buf, i);
    const isCoinbase = tx.inputs.length === 1 && tx.inputs[0].prevout.subarray(0, 32).every((b) => b === 0) && tx.inputs[0].prevout.readUInt32LE(32) === 0xffffffff;
    if ((i === 0) !== isCoinbase) throw new BlockError('COINBASE', `${i}`);
    if (i === 0) coinbase = tx;
    txids.push(tx.txid);
    wtxids.push(i === 0 ? Buffer.alloc(32) : tx.wtxid);
    stripped += tx.stripped;
    if (tx.segwit) anyWitness = true;
    if (tx.stripped === 64) stats.tx64++;
    let opr = 0;
    let oprBig = 0;
    for (const o of tx.outputs) {
      if (o.script.length === 0 || o.script[0] !== 0x6a) continue;
      if (i === 0) continue; // the coinbase's commitments are not records
      const n = o.script.length;
      opr++;
      stats.opReturnOutputs++;
      stats.opReturnBytes += n;
      stats.opReturnMax = Math.max(stats.opReturnMax, n);
      if (n > 83) { stats.opReturnOver83++; stats.opReturnOver83Bytes += n; oprBig++; }
      if (n >= 139) stats.opReturnAtLeast139++;
      if (n >= 1000) stats.opReturnAtLeast1000++;
    }
    if (oprBig >= 1 || opr >= 2) records.push({ index: i, txid: Buffer.from(tx.txid).reverse().toString('hex'), largest: Math.max(...tx.outputs.filter((o) => o.script.length > 0 && o.script[0] === 0x6a).map((o) => o.script.length)), opReturns: opr });
    if (opr >= 2) stats.multiOpReturnTxs++;
    if (opr >= 2 && oprBig >= 1) stats.multiOpReturnOver83Txs++;
    if (i > 0) for (const w of tx.witnesses) {
      const e = envelopeInput(w);
      if (e !== null) { stats.envelopeInputs++; stats.envelopeBytes += e; }
    }
  }
  if (r.at !== buf.length) throw new BlockError('TX', 'trailing bytes');
  const size = buf.length;
  const weight = BigInt(stripped) * 3n + BigInt(size);
  if (weight > MAX_WEIGHT) throw new BlockError('WEIGHT', `${weight}`);
  if (!merkleRoot(txids, 'MERKLE').equals(header.merkleRoot)) throw new BlockError('MERKLE', 'root differs');
  if (bip34Height(coinbase.inputs[0].scriptSig) !== height) throw new BlockError('BIP34', 'height differs');
  // BIP141: the last coinbase output whose script starts 6a24aa21a9ed commits to the wtxid root.
  let commitment = null;
  for (const o of coinbase.outputs) {
    if (o.script.length >= 38 && o.script.subarray(0, 6).equals(Buffer.from('6a24aa21a9ed', 'hex'))) commitment = o.script.subarray(6, 38);
  }
  if (commitment) {
    const w = coinbase.witnesses[0];
    if (!w || w.length !== 1 || w[0].length !== 32) throw new BlockError('WITNESS_COMMITMENT', 'coinbase reserved value');
    if (!sha256d(merkleRoot(wtxids, 'WITNESS_MERKLE'), w[0]).equals(commitment)) throw new BlockError('WITNESS_COMMITMENT', 'root differs');
  } else if (anyWitness) {
    throw new BlockError('WITNESS_COMMITMENT', 'witness without commitment');
  }
  return { header, txCount: nTx, size, stripped, weight: Number(weight), segwit: anyWitness, coinbaseScriptSig: coinbase.inputs[0].scriptSig, txids: txids.map((t) => Buffer.from(t).reverse().toString('hex')), records, ...stats };
}

/** Checks one header chain: links, BIP113 median time, constant bits within a period and each retarget. */
export function checkChain(headers) {
  // headers: [{ height, hash, prev, time, bits, target }], ascending and contiguous.
  const T = 14n * 24n * 3600n;
  const byHeight = new Map(headers.map((h) => [h.height, h]));
  let retargets = 0;
  for (let k = 1; k < headers.length; k++) {
    const h = headers[k];
    const p = headers[k - 1];
    if (h.height !== p.height + 1 || h.prev !== p.hash) throw new BlockError('LINK', `${h.height}`);
    if (k >= 11) {
      const times = headers.slice(k - 11, k).map((x) => x.time).sort((a, b) => a - b);
      if (h.time <= times[5]) throw new BlockError('MEDIAN_TIME', `${h.height}`);
    }
    if (h.height % 2016 !== 0) {
      if (h.bits !== p.bits) throw new BlockError('BITS', `${h.height} changed inside a period`);
      continue;
    }
    const first = byHeight.get(h.height - 2016);
    if (!first) continue; // period start outside the fetched range
    let span = BigInt(p.time - first.time);
    if (span < T / 4n) span = T / 4n;
    if (span > T * 4n) span = T * 4n;
    let next = (p.target * span) / T;
    if (next > POW_LIMIT) next = POW_LIMIT;
    if (targetToBits(next) !== h.bits) throw new BlockError('RETARGET', `${h.height}`);
    retargets++;
  }
  return { retargets };
}
