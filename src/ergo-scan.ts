// The exhaustion's scan (succinct-read §4.2): the deterministic rule that reads every output with venue-ergo §6's
// shape from a transaction's unsigned bytes, inside venue-ergo §5's grammar or not. One table-driven machine, one
// byte a step, which the exhaustion's transaction leaves evaluate in a circuit over the same tables and which a prover
// and a test run here. Over a transaction inside the grammar it reads exactly the outputs with the shape, in output
// order (the framer's reading, `frameTransaction`); outside it, it reads what its own rule reads, which the set
// identity fixes and which a reader passes over after fetching the transaction (§4.2).
//
// The machine carries no validity test: a VLQ's bounds and minimality and the fixed trees' bytes are not checked, and
// it reads a grammatical transaction exactly as the framer does without them. A byte its mode cannot take (a class-3
// byte) moves it to `ERR`, which it never leaves, so a transaction emits nothing after its first such byte. Every value
// is an element of the BN254 scalar field, as in the circuit, so a VLQ longer than any bound wraps exactly as there.
import { copyBytes } from "./bytes.js";
import { FIELD_MODULUS } from "./pool/field.js";

/** The machine's modes; the index of a mode is its number in the tables. */
export const SCAN_MODES = Object.freeze(["V_IN", "S_BOX", "PROOF", "EXTCNT", "E_KEY", "E_CT", "E_CLEN", "E_BODY", "V_DI", "S_DI",
  "V_TOK", "S_TOK", "V_OUT", "V_VALUE", "TREE", "V_TSIZE", "S_TBODY", "PAT_P2PK", "PAT_FEE", "V_HEIGHT", "TOKCNT", "V_TIDX",
  "V_TAMT", "REGCNT", "R4_CT", "R4_CLEN", "R4_HI", "R4_LO", "R4_BODY", "R5_CT", "R5_CLEN", "R5_BODY", "RX_CT", "RX_CLEN",
  "RX_BODY", "END", "ERR"] as const);
type Mode = typeof SCAN_MODES[number];
const M = Object.fromEntries(SCAN_MODES.map((mode, i) => [mode, i])) as Record<Mode, number>;

/** How a mode reads its byte: its byte group. */
const GROUP = { ANY: 0, VLQ: 1, ZERO: 2, EXT: 3, CT: 4, TREE: 5, TOK: 6, REG: 7, END: 8 } as const;
const GROUPS = 9;
const VLQ_MODES: readonly Mode[] = ["V_IN", "E_CLEN", "V_DI", "V_OUT", "R4_CLEN", "R5_CLEN", "RX_CLEN", "V_TOK", "V_TSIZE", "V_HEIGHT",
  "V_TIDX", "V_VALUE", "V_TAMT"];
const groupOf = (mode: Mode): number => VLQ_MODES.includes(mode) ? GROUP.VLQ : ({ PROOF: GROUP.ZERO, EXTCNT: GROUP.EXT, E_CT: GROUP.CT,
  R4_CT: GROUP.CT, R5_CT: GROUP.CT, RX_CT: GROUP.CT, TREE: GROUP.TREE, TOKCNT: GROUP.TOK, REGCNT: GROUP.REG, END: GROUP.END } as Partial<Record<Mode, number>>)[mode] ?? GROUP.ANY;
/** Each mode's byte group. */
export const SCAN_GROUP: readonly number[] = Object.freeze(SCAN_MODES.map(groupOf));

/**
 * `SCAN_BYTE[g * 256 + b]` = `cont + 2 cls`: `cont` is 1 for a VLQ byte with more to come (group VLQ only), `cls` the
 * class the action key reads (0–3; 3 is a byte the mode cannot take).
 * - VLQ: 1 continuing, 0 final.
 * - ZERO (an input's proof length): 0 for zero, else 3.
 * - EXT (an extension count): 0 for none, 1 for 1–127, else 3.
 * - CT (a register or extension constant's type): 0 for `Coll[Byte]` (0x0e), else 3.
 * - TREE (a tree's first byte): 0 sized (bit 3 set, bits 5–7 clear), 1 for 0x00 (pay-to-public-key), 2 for 0x10 (the
 *   fee tree), else 3.
 * - TOK (an output's token count): 0 for none, else 1.
 * - REG (an output's register count): 0 for none, 1 for 1–6, else 3.
 * - END (after the last output): 3.
 */
export const SCAN_BYTE: readonly number[] = Object.freeze(Array.from({ length: GROUPS * 256 }, (_, i) => {
  const g = Math.floor(i / 256), b = i % 256;
  let cont = 0, cls = 0;
  if (g === GROUP.VLQ) { cont = b >= 128 ? 1 : 0; cls = cont; }
  else if (g === GROUP.ZERO) cls = b === 0 ? 0 : 3;
  else if (g === GROUP.EXT) cls = b === 0 ? 0 : b < 128 ? 1 : 3;
  else if (g === GROUP.CT) cls = b === 0x0e ? 0 : 3;
  else if (g === GROUP.TREE) cls = (b & 0xe0) !== 0 ? 3 : (b & 0x08) !== 0 ? 0 : b === 0 ? 1 : b === 0x10 ? 2 : 3;
  else if (g === GROUP.TOK) cls = b === 0 ? 0 : 1;
  else if (g === GROUP.REG) cls = b === 0 ? 0 : b <= 6 ? 1 : 3;
  else if (g === GROUP.END) cls = 3;
  return cont + 2 * cls;
}));

/**
 * An action: the next mode and the registers' affine updates, with `V` the value of the VLQ ending at this byte and
 * `b` the byte. `R' = RK R + RC + RV V` (bytes left in a run), `C1' = C1K C1 + C1C + C1V V` (inputs or outputs left),
 * `C2' = C2K C2 + C2C + C2B b` (extension entries, tokens or registers left), `VK` (the VLQ continues), `OEND` (an
 * output ends at this byte), `H' = HM H + HB b` and `L' = LM L + LB b` (the subject's high and low limbs, big-endian),
 * `SH' = SHM SH + SHC` (the shape: 0 none, 1 R4 is 32 bytes, 2 and R5 is a `Coll[Byte]`).
 */
export interface ScanAction {
  readonly NEXT: number; readonly RK: number; readonly RC: number; readonly RV: number;
  readonly C1K: number; readonly C1C: number; readonly C1V: number; readonly C2K: number; readonly C2C: number; readonly C2B: number;
  readonly VK: number; readonly OEND: number; readonly HM: number; readonly HB: number; readonly LM: number; readonly LB: number;
  readonly SHM: number; readonly SHC: number;
}
export const SCAN_ACTION_FIELDS = Object.freeze(["NEXT", "RK", "RC", "RV", "C1K", "C1C", "C1V", "C2K", "C2C", "C2B", "VK", "OEND",
  "HM", "HB", "LM", "LB", "SHM", "SHC"] as const);

/** The zero tests a key reads: R = 1, V = 0, V = 32, C1 = 1, C2 = 1. */
interface Tests { readonly zR: number; readonly zV: number; readonly z32: number; readonly zC1: number; readonly zC2: number }
function transition(mode: number, cls: number, e: Tests): ScanAction {
  const a = { NEXT: 0, RK: 1, RC: 0, RV: 0, C1K: 1, C1C: 0, C1V: 0, C2K: 1, C2C: 0, C2B: 0, VK: 0, OEND: 0, HM: 1, HB: 0, LM: 1, LB: 0,
    SHM: 1, SHC: 0 };
  const m = SCAN_MODES[mode]!;
  const go = (next: Mode): void => { a.NEXT = M[next]; };
  const setR = (c: number, v = 0): void => { a.RK = 0; a.RC = c; a.RV = v; };
  const decR = (): void => { a.RK = 1; a.RC = -1; a.RV = 0; };
  const nextInput = (): void => { a.C1K = 1; a.C1C = -1; if (e.zC1) go("V_DI"); else { go("S_BOX"); setR(32); } };
  const extDone = (): void => { a.C2K = 1; a.C2C = -1; if (e.zC2) nextInput(); else go("E_KEY"); };
  const outDone = (): void => { a.OEND = 1; a.C1K = 1; a.C1C = -1; go(e.zC1 ? "END" : "V_VALUE"); };
  const regDone = (nextConstant: Mode): void => { a.C2K = 1; a.C2C = -1; if (e.zC2) outDone(); else go(nextConstant); };
  // A continuing VLQ byte stays in its mode; a byte the mode cannot take ends the scan.
  if (groupOf(m) === GROUP.VLQ && cls === 1) { a.VK = 1; go(m); return a; }
  if (cls === 3) { go("ERR"); return a; }
  switch (m) {
    case "V_IN": a.C1K = 0; a.C1V = 1; if (e.zV) go("V_DI"); else { go("S_BOX"); setR(32); } break;
    case "S_BOX": decR(); go(e.zR ? "PROOF" : m); break;
    case "PROOF": go("EXTCNT"); break;
    case "EXTCNT": if (cls === 0) nextInput(); else { a.C2K = 0; a.C2B = 1; go("E_KEY"); } break;
    case "E_KEY": go("E_CT"); break;
    case "E_CT": go("E_CLEN"); break;
    case "E_CLEN": if (e.zV) extDone(); else { go("E_BODY"); setR(0, 1); } break;
    case "E_BODY": decR(); if (e.zR) extDone(); else go(m); break;
    case "V_DI": if (e.zV) go("V_TOK"); else { go("S_DI"); setR(0, 32); } break;
    case "S_DI": decR(); go(e.zR ? "V_TOK" : m); break;
    case "V_TOK": if (e.zV) go("V_OUT"); else { go("S_TOK"); setR(0, 32); } break;
    case "S_TOK": decR(); go(e.zR ? "V_OUT" : m); break;
    case "V_OUT": a.C1K = 0; a.C1V = 1; go(e.zV ? "END" : "V_VALUE"); break;
    case "V_VALUE": go("TREE"); break;
    case "TREE": if (cls === 0) go("V_TSIZE"); else if (cls === 1) { go("PAT_P2PK"); setR(35); } else { go("PAT_FEE"); setR(104); } break;
    case "V_TSIZE": if (e.zV) go("V_HEIGHT"); else { go("S_TBODY"); setR(0, 1); } break;
    case "S_TBODY": case "PAT_P2PK": case "PAT_FEE": decR(); go(e.zR ? "V_HEIGHT" : m); break;
    case "V_HEIGHT": go("TOKCNT"); break;
    case "TOKCNT": if (cls === 0) go("REGCNT"); else { a.C2K = 0; a.C2B = 1; go("V_TIDX"); } break;
    case "V_TIDX": go("V_TAMT"); break;
    case "V_TAMT": a.C2K = 1; a.C2C = -1; go(e.zC2 ? "REGCNT" : "V_TIDX"); break;
    case "REGCNT": a.SHM = 0; if (cls === 0) outDone(); else { a.C2K = 0; a.C2B = 1; go("R4_CT"); } break;
    case "R4_CT": go("R4_CLEN"); break;
    case "R4_CLEN":
      if (e.zV) regDone("R5_CT");
      else if (e.z32) { go("R4_HI"); setR(16); a.HM = 0; }
      else { go("R4_BODY"); setR(0, 1); }
      break;
    case "R4_HI": a.HM = 256; a.HB = 1; decR(); if (e.zR) { go("R4_LO"); setR(16); a.LM = 0; } else go(m); break;
    case "R4_LO": a.LM = 256; a.LB = 1; decR(); if (e.zR) { a.SHM = 0; a.SHC = 1; regDone("R5_CT"); } else go(m); break;
    case "R4_BODY": decR(); if (e.zR) regDone("R5_CT"); else go(m); break;
    case "R5_CT": go("R5_CLEN"); break;
    case "R5_CLEN": if (e.zV) { a.SHM = 2; regDone("RX_CT"); } else { go("R5_BODY"); setR(0, 1); } break;
    case "R5_BODY": decR(); if (e.zR) { a.SHM = 2; regDone("RX_CT"); } else go(m); break;
    case "RX_CT": go("RX_CLEN"); break;
    case "RX_CLEN": if (e.zV) regDone("RX_CT"); else { go("RX_BODY"); setR(0, 1); } break;
    case "RX_BODY": decR(); if (e.zR) regDone("RX_CT"); else go(m); break;
    case "END": case "ERR": go("ERR"); break;
  }
  return a;
}

/** `SCAN_KEY[mode * 128 + cls * 32 + zR * 16 + zV * 8 + z32 * 4 + zC1 * 2 + zC2]` is the index of its action in
 * `SCAN_ACTIONS`, each distinct action listed once. */
export const SCAN_KEY: readonly number[] = [];
export const SCAN_ACTIONS: readonly ScanAction[] = [];
{
  const seen = new Map<string, number>(), keys: number[] = [], actions: ScanAction[] = [];
  for (let mode = 0; mode < SCAN_MODES.length; mode++) for (let k = 0; k < 128; k++) {
    const a = transition(mode, k >> 5, { zR: (k >> 4) & 1, zV: (k >> 3) & 1, z32: (k >> 2) & 1, zC1: (k >> 1) & 1, zC2: k & 1 });
    const id = SCAN_ACTION_FIELDS.map(f => a[f]).join();
    if (!seen.has(id)) { seen.set(id, actions.length); actions.push(Object.freeze(a)); }
    keys.push(seen.get(id)!);
  }
  (SCAN_KEY as number[]).push(...keys);
  (SCAN_ACTIONS as ScanAction[]).push(...actions);
  Object.freeze(SCAN_KEY); Object.freeze(SCAN_ACTIONS);
}

/** An output the scan reads as having the shape: its index in the transaction and its subject (`R4`). */
export interface ScannedOutput { readonly output: number; readonly subject: Uint8Array }

const P = FIELD_MODULUS;
const mod = (x: bigint): bigint => ((x % P) + P) % P;

/** The scan's state between bytes, as a leaf carries it across a slot boundary. */
export interface ScanState {
  readonly mode: number; readonly r: bigint; readonly c1: bigint; readonly c2: bigint; readonly a: bigint; readonly p: bigint;
  readonly hi: bigint; readonly lo: bigint; readonly sh: bigint; readonly outputs: number;
}
/** The state at a transaction's first byte. */
export const SCAN_START: ScanState = Object.freeze({ mode: M.V_IN, r: 0n, c1: 0n, c2: 0n, a: 0n, p: 1n, hi: 0n, lo: 0n, sh: 0n, outputs: 0 });

/** One step: the state after `byte`, and whether an output with the shape ends at it. */
export function scanStep(state: ScanState, byte: number): { readonly state: ScanState; readonly shaped: boolean } {
  const v = SCAN_BYTE[SCAN_GROUP[state.mode]! * 256 + byte]!;
  const cont = v & 1, cls = v >> 1;
  const value = mod(state.a + BigInt(byte - 128 * cont) * state.p);
  const key = state.mode * 128 + cls * 32 + (state.r === 1n ? 16 : 0) + (value === 0n ? 8 : 0) + (value === 32n ? 4 : 0) +
    (state.c1 === 1n ? 2 : 0) + (state.c2 === 1n ? 1 : 0);
  const x = SCAN_ACTIONS[SCAN_KEY[key]!]!, b = BigInt(byte);
  const sh = mod(BigInt(x.SHM) * state.sh + BigInt(x.SHC));
  const next: ScanState = {
    mode: x.NEXT,
    r: mod(BigInt(x.RK) * state.r + BigInt(x.RC) + BigInt(x.RV) * value),
    c1: mod(BigInt(x.C1K) * state.c1 + BigInt(x.C1C) + BigInt(x.C1V) * value),
    c2: mod(BigInt(x.C2K) * state.c2 + BigInt(x.C2C) + BigInt(x.C2B) * b),
    a: x.VK ? value : 0n,
    p: x.VK ? mod(state.p * 128n) : 1n,
    hi: mod(BigInt(x.HM) * state.hi + BigInt(x.HB) * b),
    lo: mod(BigInt(x.LM) * state.lo + BigInt(x.LB) * b),
    sh,
    outputs: state.outputs + x.OEND,
  };
  return { state: next, shaped: x.OEND === 1 && sh === 2n };
}

const limbBytes = (limb: bigint): Uint8Array => {
  const out = new Uint8Array(16);
  for (let i = 15, v = limb; i >= 0; i--, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
};

/** Every output the scan reads as having the shape in `unsigned`, in output order. Over a transaction inside venue-ergo
 * §5's grammar these are exactly its outputs whose own R4 is a 32-byte `Coll[Byte]` and R5 a `Coll[Byte]`. */
export function scanTransaction(unsigned: Uint8Array): readonly ScannedOutput[] {
  const bytes = copyBytes(unsigned);
  const found: ScannedOutput[] = [];
  let state = SCAN_START;
  for (const byte of bytes) {
    const before = state.outputs;
    const step = scanStep(state, byte);
    state = step.state;
    if (step.shaped) {
      const subject = new Uint8Array(32);
      subject.set(limbBytes(state.hi), 0);
      subject.set(limbBytes(state.lo), 16);
      found.push(Object.freeze({ output: before, subject }));
    }
    if (state.mode === M.ERR) break;
  }
  return Object.freeze(found);
}
