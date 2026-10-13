// The hostile cases, each a proof's bytes and public inputs presented as one kind, and the leaf (relation and variant)
// that takes them. The host's verdict is the reference's verifier on the same bytes (host.mjs); the leaf's is execution,
// proof and verification of that leaf (hostile.mjs). Proof layout under bb 5.2.0 (458 fields): 0–7 the inner
// pairing-point object (zero for the relations), then commitments as four fields each (x low 136 bits, x high, y low,
// y high) and scalars; 450–453 Shplonk's Q and 454–457 KZG's W, the last two commitments.
import { genuine, innerKey } from './lib.mjs';
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const word = (b, i) => BigInt('0x' + b.subarray(32 * i, 32 * i + 32).toString('hex'));
const put = (b, i, v) => { const c = Buffer.from(b); c.set(Buffer.from(v.toString(16).padStart(64, '0'), 'hex'), 32 * i); return c; };
const limbs = v => [v & ((1n << 136n) - 1n), v >> 136n];
// The G1 generator (1, 2), and a second point 2·G for the pairing-point object.
const G = [1n, 2n], G2x = 0x030644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd3n, G2y = 0x15ed738c0e0a7c92e7845f96b2ae9c0a68a6a449e3538fc7ff3ebf7a5a18a2c4n;
const point = (b, at, [x, y]) => { let c = b; [...limbs(x), ...limbs(y)].forEach((v, k) => { c = put(c, at + k, v); }); return c; };

export function cases() {
  const s = genuine('spend'), burn = genuine('burn'), d = genuine('demand');
  const x = word(s.bytes, 454) + (word(s.bytes, 455) << 136n);
  return [
    { id: 'genuine-spend', as: 'spend', leaf: 'spend', ...s },
    { id: 'genuine-burn', as: 'burn', leaf: 'burn', ...burn },
    { id: 'public-input-changed', as: 'spend', leaf: 'spend', bytes: s.bytes, pi: s.pi.map((v, i) => i === 0 ? v + 1n : v) },
    { id: 'scalar-changed', as: 'spend', leaf: 'spend', bytes: put(s.bytes, 300, (word(s.bytes, 300) + 1n) % P), pi: s.pi },
    { id: 'pairing-part-only: KZG W replaced by the generator', as: 'spend', leaf: 'spend', bytes: point(s.bytes, 454, G), pi: s.pi },
    { id: 'pairing-point object set to (G, 2G)', as: 'spend', leaf: 'spend', bytes: point(point(s.bytes, 0, G), 4, [G2x, G2y]), pi: s.pi },
    { id: 'pairing-point object: P0 = G, P1 at infinity', as: 'spend', leaf: 'spend', bytes: point(s.bytes, 0, G), pi: s.pi },
    { id: 'scalar word + p (same value mod p)', as: 'spend', leaf: 'spend', bytes: put(s.bytes, 300, word(s.bytes, 300) + P), pi: s.pi },
    { id: 'commitment limb split non-canonically (same point)', as: 'spend', leaf: 'spend',
      bytes: put(put(s.bytes, 454, word(s.bytes, 454) + (1n << 136n)), 455, word(s.bytes, 455) - 1n), pi: s.pi, note: `x = ${x}` },
    { id: 'commitment off the curve (x low limb + 1)', as: 'spend', leaf: 'spend', bytes: put(s.bytes, 454, word(s.bytes, 454) + 1n), pi: s.pi },
    { id: 'commitment at infinity (KZG W all zero)', as: 'spend', leaf: 'spend', bytes: point(s.bytes, 454, [0n, 0n]), pi: s.pi },
    { id: 'spend proof presented as a burn (keys swapped)', as: 'burn', leaf: 'burn', ...s },
    { id: 'burn proof presented as a spend (keys swapped)', as: 'spend', leaf: 'spend', ...burn },
    { id: 'arbitrary key: burn proof under burn key, leaf taking its key as a witness', as: 'spend', leaf: 'spend', variant: 'free', ...burn,
      extra: () => { const k = innerKey('burn'); return { vk: k.vk, kh: k.kh }; } },
    { id: 'changed key hash: spend key with burn key hash (key pinned, hash a witness)', as: 'spend', leaf: 'spend', variant: 'kh', ...s,
      extra: () => ({ kh: innerKey('burn').kh }) },
    { id: 'key and hash disagree: burn key with spend key hash, burn proof', as: 'spend', leaf: 'spend', variant: 'free', ...burn,
      extra: () => ({ vk: innerKey('burn').vk, kh: innerKey('spend').kh }) },
    { id: 'key and hash disagree: spend key with burn key hash, spend proof', as: 'spend', leaf: 'spend', variant: 'free', ...s,
      extra: () => ({ vk: innerKey('spend').vk, kh: innerKey('burn').kh }) },
    { id: 'demand proof with a demand public input changed', as: 'demand', leaf: 'demand', bytes: d.bytes, pi: d.pi.map((v, i) => i === 3 ? v + 1n : v) },
  ];
}
