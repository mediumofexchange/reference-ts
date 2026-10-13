// venue-ergo §5's grammar as a table-driven machine, one byte a step: the tables the circuit reads and a
// simulator over the same tables. Each step reads its byte under the mode's byte group (BYTEV), forms a
// key from the mode, the byte's class and five zero tests, and applies the action the key names.
export const MINER_FEE = Buffer.from('1005040004000e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a7017300730110010204' +
  '02d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304', 'hex');
if (MINER_FEE.length !== 105) throw new Error('fee tree');

export const MODES = ['V_IN', 'S_BOX', 'PROOF', 'EXTCNT', 'E_KEY', 'E_CT', 'E_CLEN', 'E_BODY', 'V_DI', 'S_DI', 'V_TOK', 'S_TOK',
  'V_OUT', 'V_VALUE', 'TREE', 'V_TSIZE', 'S_TBODY', 'PAT_P2PK', 'PAT_FEE', 'V_HEIGHT', 'TOKCNT', 'V_TIDX', 'V_TAMT', 'REGCNT',
  'R4_CT', 'R4_CLEN', 'R4_HI', 'R4_LO', 'R4_BODY', 'R5_CT', 'R5_CLEN', 'R5_BODY', 'RX_CT', 'RX_CLEN', 'RX_BODY', 'END', 'ERR'];
export const M = Object.fromEntries(MODES.map((m, i) => [m, i]));
// Byte groups: how a mode reads its byte.
const G = { ANY: 0, U16: 1, U32: 2, U64: 3, ZERO: 4, EXT: 5, CT: 6, TREE: 7, TOK: 8, REG: 9, END: 10 };
const GROUPS = 11;
const group = {
  V_IN: 'U16', E_CLEN: 'U16', V_DI: 'U16', V_OUT: 'U16', R4_CLEN: 'U16', R5_CLEN: 'U16', RX_CLEN: 'U16',
  V_TOK: 'U32', V_TSIZE: 'U32', V_HEIGHT: 'U32', V_TIDX: 'U32', V_VALUE: 'U64', V_TAMT: 'U64',
  PROOF: 'ZERO', EXTCNT: 'EXT', E_CT: 'CT', R4_CT: 'CT', R5_CT: 'CT', RX_CT: 'CT', TREE: 'TREE', TOKCNT: 'TOK', REGCNT: 'REG', END: 'END',
};
export const BSEL = MODES.map(m => G[group[m] ?? 'ANY']);
// The index of a VLQ's last allowed byte (u16 3 bytes, u32 5, u64 10); 99 for other modes, which N never reaches.
export const VMAX = MODES.map(m => ({ U16: 2, U32: 4, U64: 9 })[group[m]] ?? 99);
// Tree bytes: TREE starts the fingerprint, the size, body and fixed trees continue it.
export const T_IN = MODES.map(m => ['TREE', 'V_TSIZE', 'S_TBODY', 'PAT_P2PK', 'PAT_FEE'].includes(m) ? 1 : 0);
export const T_FIRST = MODES.map(m => m === 'TREE' ? 1 : 0);
// Fixed trees: the expected byte at index PBC + R (R the bytes left before this one), else index 0 (no check).
export const PBM = MODES.map(m => m === 'PAT_P2PK' || m === 'PAT_FEE' ? 1 : 0);
export const PBC = MODES.map(m => m === 'PAT_P2PK' ? 1 : m === 'PAT_FEE' ? 1 + 36 : 0);
export const PATB = new Array(1 + 36 + 105).fill(0);
// P2PK: R = 35 at its byte 1 (0x08), 34 at byte 2 (0xcd), then 33 free point bytes.
PATB[1 + 35] = 0x08 + 256; PATB[1 + 34] = 0xcd + 256;
for (let R = 1; R <= 104; R++) PATB[1 + 36 + R] = MINER_FEE[105 - R] + 256;

// BYTEV[g * 256 + b] = cont + 2 fz + 4 cb + 8 cls. cont: a VLQ byte with more to come; fz: a final VLQ byte of
// zero (not minimal unless the VLQ's first); cb: bad if this is the VLQ's last allowed byte; cls: the class the key reads.
export const BYTEV = [];
for (let g = 0; g < GROUPS; g++) for (let b = 0; b < 256; b++) {
  let cont = 0, fz = 0, cb = 0, cls = 0;
  const cap = { [G.U16]: 3, [G.U32]: 15, [G.U64]: 1 }[g];
  if (cap !== undefined) {
    cont = b >= 128 ? 1 : 0; fz = b === 0 ? 1 : 0; cb = cont || (b & 0x7f) > cap ? 1 : 0; cls = cont ? 1 : fz ? 2 : 0;
  } else if (g === G.ZERO) cls = b === 0 ? 0 : 3;
  else if (g === G.EXT) cls = b === 0 ? 0 : b < 128 ? 1 : 3;
  else if (g === G.CT) cls = b === 0x0e ? 0 : 3;
  else if (g === G.TREE) cls = (b & 0xe0) ? 3 : (b & 0x08) ? 0 : b === 0 ? 1 : b === 0x10 ? 2 : 3;
  else if (g === G.TOK) cls = b === 0 ? 0 : 1;
  else if (g === G.REG) cls = b === 0 ? 0 : b <= 6 ? 1 : 3;
  else if (g === G.END) cls = 3;
  BYTEV.push(cont + 2 * fz + 4 * cb + 8 * cls);
}

// An action: next mode, bad, R' = RK R + RC + RV V, C1' = C1K C1 + C1C + C1V V, C2' = C2K C2 + C2C + C2B b,
// VK (VLQ continues), OEND (an output ends), H' = HM H + HB b, L' = LM L + LB b (the subject's halves),
// SH' = SHM SH + SHC (shape: 0 none, 1 R4 is 32 bytes, 2 and R5 is a Coll[Byte]).
const FIELDS = ['NEXT', 'BADT', 'RK', 'RC', 'RV', 'C1K', 'C1C', 'C1V', 'C2K', 'C2C', 'C2B', 'VK', 'OEND', 'HM', 'HB', 'LM', 'LB', 'SHM', 'SHC'];
export { FIELDS };
function base() {
  return { NEXT: 0, BADT: 0, RK: 1, RC: 0, RV: 0, C1K: 1, C1C: 0, C1V: 0, C2K: 1, C2C: 0, C2B: 0, VK: 0, OEND: 0, HM: 1, HB: 0, LM: 1, LB: 0, SHM: 1, SHC: 0 };
}
const isVlq = m => ['U16', 'U32', 'U64'].includes(group[m]);
function transition(mode, cls, e) {
  const a = base();
  const m = MODES[mode];
  const go = (next) => { a.NEXT = M[next]; };
  const setR = (c, v = 0) => { a.RK = 0; a.RC = c; a.RV = v; };
  const decR = () => { a.RK = 1; a.RC = -1; a.RV = 0; };
  const bad = () => { a.BADT = 1; go('ERR'); };
  const nextInput = () => { a.C1K = 1; a.C1C = -1; if (e.zC1) go('V_DI'); else { go('S_BOX'); setR(32); } };
  const extDone = () => { a.C2K = 1; a.C2C = -1; if (e.zC2) nextInput(); else go('E_KEY'); };
  const outDone = () => { a.OEND = 1; a.C1K = 1; a.C1C = -1; if (e.zC1) go('END'); else go('V_VALUE'); };
  const regDone = (nextCt) => { a.C2K = 1; a.C2C = -1; if (e.zC2) outDone(); else go(nextCt); };
  if (isVlq(m) && cls === 1) { a.VK = 1; go(m); return a; } // a continuing VLQ byte
  if (cls === 3) { bad(); return a; }
  switch (m) {
    case 'V_IN': a.C1K = 0; a.C1V = 1; if (e.zV) go('V_DI'); else { go('S_BOX'); setR(32); } break;
    case 'S_BOX': decR(); if (e.zR) go('PROOF'); else go(m); break;
    case 'PROOF': go('EXTCNT'); break;
    case 'EXTCNT': if (cls === 0) nextInput(); else { a.C2K = 0; a.C2B = 1; go('E_KEY'); } break;
    case 'E_KEY': go('E_CT'); break;
    case 'E_CT': go('E_CLEN'); break;
    case 'E_CLEN': if (e.zV) extDone(); else { go('E_BODY'); setR(0, 1); } break;
    case 'E_BODY': decR(); if (e.zR) extDone(); else go(m); break;
    case 'V_DI': if (e.zV) go('V_TOK'); else { go('S_DI'); setR(0, 32); } break;
    case 'S_DI': decR(); go(e.zR ? 'V_TOK' : m); break;
    case 'V_TOK': if (e.zV) go('V_OUT'); else { go('S_TOK'); setR(0, 32); } break;
    case 'S_TOK': decR(); go(e.zR ? 'V_OUT' : m); break;
    case 'V_OUT': a.C1K = 0; a.C1V = 1; go(e.zV ? 'END' : 'V_VALUE'); break;
    case 'V_VALUE': go('TREE'); break;
    case 'TREE': if (cls === 0) go('V_TSIZE'); else if (cls === 1) { go('PAT_P2PK'); setR(35); } else { go('PAT_FEE'); setR(104); } break;
    case 'V_TSIZE': if (e.zV) go('V_HEIGHT'); else { go('S_TBODY'); setR(0, 1); } break;
    case 'S_TBODY': case 'PAT_P2PK': case 'PAT_FEE': decR(); go(e.zR ? 'V_HEIGHT' : m); break;
    case 'V_HEIGHT': go('TOKCNT'); break;
    case 'TOKCNT': if (cls === 0) go('REGCNT'); else { a.C2K = 0; a.C2B = 1; go('V_TIDX'); } break;
    case 'V_TIDX': go('V_TAMT'); break;
    case 'V_TAMT': a.C2K = 1; a.C2C = -1; go(e.zC2 ? 'REGCNT' : 'V_TIDX'); break;
    case 'REGCNT': a.SHM = 0; if (cls === 0) outDone(); else { a.C2K = 0; a.C2B = 1; go('R4_CT'); } break;
    case 'R4_CT': go('R4_CLEN'); break;
    case 'R4_CLEN':
      if (e.zV) regDone('R5_CT');
      else if (e.z32) { go('R4_HI'); setR(16); a.HM = 0; }
      else { go('R4_BODY'); setR(0, 1); }
      break;
    case 'R4_HI': a.HM = 256; a.HB = 1; decR(); if (e.zR) { go('R4_LO'); setR(16); a.LM = 0; } else go(m); break;
    case 'R4_LO': a.LM = 256; a.LB = 1; decR(); if (e.zR) { a.SHM = 0; a.SHC = 1; regDone('R5_CT'); } else go(m); break;
    case 'R4_BODY': decR(); if (e.zR) regDone('R5_CT'); else go(m); break;
    case 'R5_CT': go('R5_CLEN'); break;
    case 'R5_CLEN': if (e.zV) { a.SHM = 2; regDone('RX_CT'); } else { go('R5_BODY'); setR(0, 1); } break;
    case 'R5_BODY': decR(); if (e.zR) { a.SHM = 2; regDone('RX_CT'); } else go(m); break;
    case 'RX_CT': go('RX_CLEN'); break;
    case 'RX_CLEN': if (e.zV) regDone('RX_CT'); else { go('RX_BODY'); setR(0, 1); } break;
    case 'RX_BODY': decR(); if (e.zR) regDone('RX_CT'); else go(m); break;
    case 'END': bad(); break;
    case 'ERR': go('ERR'); break;
    default: throw new Error(m);
  }
  return a;
}
// Key: mode * 128 + cls * 32 + zR * 16 + zV * 8 + z32 * 4 + zC1 * 2 + zC2.
export const ACT = [], ACTIONS = [];
const seen = new Map();
for (let mode = 0; mode < MODES.length; mode++) for (let k = 0; k < 128; k++) {
  const cls = k >> 5, e = { zR: (k >> 4) & 1, zV: (k >> 3) & 1, z32: (k >> 2) & 1, zC1: (k >> 1) & 1, zC2: k & 1 };
  const a = transition(mode, cls, e);
  const id = JSON.stringify(FIELDS.map(f => a[f]));
  if (!seen.has(id)) { seen.set(id, ACTIONS.length); ACTIONS.push(a); }
  ACT.push(seen.get(id));
}

// The BN254 scalar field, for the simulator's fingerprints.
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const md = (x) => ((x % P) + P) % P;
/** Fingerprint of a tree: 1, then t = t r + b over its bytes. */
export function fingerprint(tree, r) { let t = 1n; for (const b of tree) t = md(t * r + BigInt(b)); return t; }

/** The machine over one transaction, as the circuit computes it. Returns validity and the entries
 * (kind or 1 if generic, output, subject hi, lo). */
export function simulate(bytes, { F = [], r = 0n, generic = true } = {}) {
  let mode = M.V_IN, err = 0, R = 0n, C1 = 0n, C2 = 0n, A = 0n, Pm = 1n, N = 0n, H = 0n, L = 0n, SH = 0n, tf = 0n, outi = 0n;
  const entries = [];
  for (const b of bytes) {
    const v = BYTEV[BSEL[mode] * 256 + b];
    const cont = v & 1, fz = (v >> 1) & 1, cb = (v >> 2) & 1, cls = v >> 3;
    const low = BigInt(b - 128 * cont);
    const V = md(A + low * Pm);
    const zR = R === 1n ? 1 : 0, zV = V === 0n ? 1 : 0, z32 = V === 32n ? 1 : 0, zC1 = C1 === 1n ? 1 : 0, zC2 = C2 === 1n ? 1 : 0;
    const zN = N === 0n, zLast = N === BigInt(VMAX[mode]);
    const kp = PBM[mode] * Number(R) + PBC[mode];
    const pat = PBM[mode] ? PATB[kp] : 0;
    const a = ACTIONS[ACT[mode * 128 + cls * 32 + zR * 16 + zV * 8 + z32 * 4 + zC1 * 2 + zC2]];
    const badPat = (pat >> 8) && (pat & 255) !== b;
    if (a.BADT || (zLast && cb) || (fz && !zN) || badPat) err = 1;
    if (T_IN[mode]) tf = md(BigInt(b) + r * (T_FIRST[mode] ? 1n : tf));
    R = md(BigInt(a.RK) * R + BigInt(a.RC) + BigInt(a.RV) * V);
    C1 = md(BigInt(a.C1K) * C1 + BigInt(a.C1C) + BigInt(a.C1V) * V);
    C2 = md(BigInt(a.C2K) * C2 + BigInt(a.C2C) + BigInt(a.C2B) * BigInt(b));
    A = a.VK ? V : 0n; Pm = a.VK ? md(Pm * 128n) : 1n; N = a.VK ? N + 1n : 0n;
    H = md(BigInt(a.HM) * H + BigInt(a.HB) * BigInt(b));
    L = md(BigInt(a.LM) * L + BigInt(a.LB) * BigInt(b));
    SH = md(BigInt(a.SHM) * SH + BigInt(a.SHC));
    if (a.OEND) {
      const kind = generic ? 1 : F.findIndex(f => f === tf) + 1;
      if (SH === 2n && kind > 0) entries.push({ kind, output: Number(outi), hi: H, lo: L });
      outi++;
    }
    mode = a.NEXT;
  }
  return { valid: !err && mode === M.END, entries, outputs: Number(outi) };
}
