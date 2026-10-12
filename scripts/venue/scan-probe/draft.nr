// The first draft of slice 22's scan: the grammar as branching Noir over a state struct, about 1,280 gates a byte.
// Replaced by gen.mjs's table-driven machine; kept only for that measurement (draft.mjs).
// venue-ergo §5's grammar and §6's attribution over one transaction's unsigned bytes, one byte a step.
// `bytes[0..n]` is the transaction; bytes at n and above are padding the scan does not read.
// Returns (valid, outputs, commitment): valid is whether the bytes are inside §5's grammar; the
// commitment chains, for every output with §6's shape (R4 a 32-byte Coll[Byte], R5 a Coll[Byte]) and,
// unless GENERIC, at one of the four locations, the entry (kind, output, subject); invalid transactions
// commit nothing. Kinds 1-3's exact lengths and kind 4's runs are left to whoever reads the entry's
// transaction (a superset of §6's objects, so an absent subject is still absent).

global FEE: [u8; 105] = [
    0x10, 0x05, 0x04, 0x00, 0x04, 0x00, 0x0e, 0x36, 0x10, 0x02, 0x04, 0xa0, 0x0b, 0x08, 0xcd, 0x02,
    0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb, 0xac, 0x55, 0xa0, 0x62, 0x95, 0xce, 0x87, 0x0b, 0x07,
    0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28, 0xd9, 0x59, 0xf2, 0x81, 0x5b, 0x16, 0xf8, 0x17, 0x98,
    0xea, 0x02, 0xd1, 0x92, 0xa3, 0x9a, 0x8c, 0xc7, 0xa7, 0x01, 0x73, 0x00, 0x73, 0x01, 0x10, 0x01,
    0x02, 0x04, 0x02, 0xd1, 0x96, 0x83, 0x03, 0x01, 0x93, 0xa3, 0x8c, 0xc7, 0xb2, 0xa5, 0x73, 0x00,
    0x00, 0x01, 0x93, 0xc2, 0xb2, 0xa5, 0x73, 0x01, 0x00, 0x74, 0x73, 0x02, 0x73, 0x03, 0x83, 0x01,
    0x08, 0xcd, 0xee, 0xac, 0x93, 0xb1, 0xa5, 0x73, 0x04,
];

// Modes: the field each byte belongs to.
global VLQ: Field = 0; // a VLQ, finished by `vt`
global SKIP: Field = 1; // bytes nothing reads, finished by `st`
global PROOF: Field = 2; // an input's proof length, exactly 0
global EXTCNT: Field = 3; // an input's extension count, at most 127
global EXTKEY: Field = 4; // an extension entry's key
global CTYPE: Field = 5; // a Coll[Byte] constant's type code 0x0e
global TREE: Field = 6; // a tree's header byte
global PAT: Field = 7; // a fixed tree: pay-to-public-key's prefix and point, or the fee tree
global TOKCNT: Field = 8; // an output's token count
global REGCNT: Field = 9; // an output's register count, at most 6
global END: Field = 10; // after the last output
// VLQ fields (vt): bound class 0 = u16 (3 bytes, last payload <= 3), 1 = u32 (5, <= 15), 2 = u64 (10, <= 1).
global V_IN: Field = 0;
global V_CLEN: Field = 1;
global V_DI: Field = 2;
global V_TOKIDS: Field = 3;
global V_OUT: Field = 4;
global V_VALUE: Field = 5;
global V_TSIZE: Field = 6;
global V_HEIGHT: Field = 7;
global V_TIDX: Field = 8;
global V_TAMT: Field = 9;
// SKIP ends (st).
global S_BOX: Field = 0;
global S_CBODY: Field = 1;
global S_DI: Field = 2;
global S_TOKIDS: Field = 3;
global S_TBODY: Field = 4;

struct St {
    mode: Field, err: bool,
    vt: Field, vacc: Field, vmul: Field, vn: Field, vmax: Field, vcls: Field,
    st: Field, rem: Field,
    cin: Field, cext: Field, cout: Field, ctok: Field, creg: Field,
    ctx: Field, regi: Field, outi: Field,
    pat: Field, ppos: Field,
    intree: bool, tp: Field, m: [bool; 4], loc: Field,
    r4ok: bool, sub: Field, shi: Field, slo: Field, r5: bool,
}

fn start() -> St {
    St {
        mode: VLQ, err: false, vt: V_IN, vacc: 0, vmul: 1, vn: 0, vmax: 2, vcls: 0, st: 0, rem: 0,
        cin: 0, cext: 0, cout: 0, ctok: 0, creg: 0, ctx: 0, regi: 0, outi: 0, pat: 0, ppos: 0,
        intree: false, tp: 0, m: [false; 4], loc: 0, r4ok: false, sub: 0, shi: 0, slo: 0, r5: false,
    }
}

// Begin a VLQ of field `vt` and bound class `cls`.
fn vlq(mut s: St, vt: Field, cls: Field) -> St {
    s.mode = VLQ; s.vt = vt; s.vacc = 0; s.vmul = 1; s.vn = 0; s.vcls = cls;
    s.vmax = if cls == 0 { 2 } else if cls == 1 { 4 } else { 9 };
    s
}

// Begin a skip of `rem` bytes ending at `st`; zero bytes end it at once.
fn skip(mut s: St, rem: Field, st: Field) -> St {
    s.mode = SKIP; s.rem = rem; s.st = st;
    if rem == 0 { s = skipped(s); }
    s
}

fn next_input(mut s: St) -> St {
    s.cin = s.cin - 1;
    if s.cin == 0 { s = vlq(s, V_DI, 0); } else { s = skip(s, 32, S_BOX); }
    s
}

fn tree_done(mut s: St, kinds: [Field; 4], lens: [Field; 4]) -> St {
    s.intree = false;
    let mut loc = 0;
    for k in 0..4 { if s.m[k] & (lens[k] == s.tp) { loc = kinds[k]; } }
    s.loc = loc;
    vlq(s, V_HEIGHT, 1)
}

fn out_done(mut s: St) -> St {
    s.cout = s.cout - 1;
    s.outi = s.outi + 1;
    if s.cout == 0 { s.mode = END; } else { s = vlq(s, V_VALUE, 2); }
    s
}

fn start_output_regs(mut s: St, count: Field) -> St {
    s.regi = 0; s.creg = count; s.ctx = 1;
    if count == 0 { s = out_done(s); } else { s.mode = CTYPE; }
    s
}

fn coll_done(mut s: St) -> St {
    if s.ctx == 0 {
        s.cext = s.cext - 1;
        if s.cext == 0 { s = next_input(s); } else { s.mode = EXTKEY; }
    } else {
        if s.regi == 1 { s.r5 = true; }
        s.regi = s.regi + 1;
        s.creg = s.creg - 1;
        if s.creg == 0 { s = out_done(s); } else { s.mode = CTYPE; }
    }
    s
}

fn skipped(mut s: St) -> St {
    if s.st == S_BOX { s.mode = PROOF; }
    else if s.st == S_CBODY { s = coll_done(s); }
    else if s.st == S_DI { s = vlq(s, V_TOKIDS, 1); }
    else if s.st == S_TOKIDS { s = vlq(s, V_OUT, 0); }
    s
}

// One byte of the transaction under §5.
fn step<let SL: u32>(mut s: St, b: u8, scripts: [[u8; SL]; 4], lens: [Field; 4]) -> St {
    let kinds: [Field; 4] = [1, 2, 3, 4];
    let bf = b as Field;
    let bits: [bool; 8] = bf.to_le_bits();
    let cont = bits[7];
    let low = bf - 128 * (bits[7] as Field);
    // Tree bytes: compare with each location while it still matches.
    let tree_byte = (s.mode == TREE) | s.intree;
    if tree_byte {
        let first = s.mode == TREE;
        let tp = if first { 0 } else { s.tp };
        let i = tp as u32;
        let inside = i < SL;
        let j = if inside { i } else { 0 };
        for k in 0..4 {
            let same = inside & (scripts[k][j] == b);
            s.m[k] = (first | s.m[k]) & same;
        }
        s.tp = tp + 1;
    }
    if s.mode == VLQ {
        // Minimal, within the class's bytes and its last byte's payload.
        let last = s.vn == s.vmax;
        let cap_ok = if s.vcls == 0 { !(bits[2] | bits[3] | bits[4] | bits[5] | bits[6]) }
            else if s.vcls == 1 { !(bits[4] | bits[5] | bits[6]) }
            else { !(bits[1] | bits[2] | bits[3] | bits[4] | bits[5] | bits[6]) };
        if last & (cont | !cap_ok) { s.err = true; }
        if !cont & (s.vn != 0) & (low == 0) { s.err = true; }
        s.vacc = s.vacc + low * s.vmul;
        s.vmul = s.vmul * 128;
        s.vn = s.vn + 1;
        if !cont {
            let v = s.vacc;
            let vt = s.vt;
            if vt == V_IN {
                s.cin = v;
                if v == 0 { s = vlq(s, V_DI, 0); } else { s = skip(s, 32, S_BOX); }
            } else if vt == V_CLEN {
                if (s.ctx == 1) & (s.regi == 0) { s.r4ok = v == 32; s.sub = 0; s.shi = 0; s.slo = 0; }
                s = skip(s, v, S_CBODY);
            } else if vt == V_DI {
                s = skip(s, 32 * v, S_DI);
            } else if vt == V_TOKIDS {
                s = skip(s, 32 * v, S_TOKIDS);
            } else if vt == V_OUT {
                s.cout = v;
                if v == 0 { s.mode = END; } else { s = vlq(s, V_VALUE, 2); }
            } else if vt == V_VALUE {
                s.mode = TREE;
            } else if vt == V_TSIZE {
                s.rem = v;
                s.mode = SKIP; s.st = S_TBODY;
                if v == 0 { s = tree_done(s, kinds, lens); }
            } else if vt == V_HEIGHT {
                s.mode = TOKCNT;
            } else if vt == V_TIDX {
                s = vlq(s, V_TAMT, 2);
            } else {
                s.ctok = s.ctok - 1;
                if s.ctok == 0 { s.mode = REGCNT; } else { s = vlq(s, V_TIDX, 1); }
            }
        }
    } else if s.mode == SKIP {
        if (s.st == S_CBODY) & (s.ctx == 1) & (s.regi == 0) & s.r4ok {
            if s.sub == 16 { s.slo = s.slo * 256 + bf; } else { s.shi = s.shi * 256 + bf; s.sub = s.sub + 1; }
        }
        s.rem = s.rem - 1;
        if s.rem == 0 {
            if s.st == S_TBODY { s = tree_done(s, kinds, lens); } else { s = skipped(s); }
        }
    } else if s.mode == PROOF {
        if b != 0 { s.err = true; }
        s.mode = EXTCNT;
    } else if s.mode == EXTCNT {
        if bits[7] { s.err = true; }
        s.cext = bf; s.ctx = 0;
        if bf == 0 { s = next_input(s); } else { s.mode = EXTKEY; }
    } else if s.mode == EXTKEY {
        s.mode = CTYPE;
    } else if s.mode == CTYPE {
        if b != 0x0e { s.err = true; }
        s = vlq(s, V_CLEN, 0);
    } else if s.mode == TREE {
        // Header bits 5-7 clear; sized (bit 3) or exactly pay-to-public-key or the fee tree.
        if bits[5] | bits[6] | bits[7] { s.err = true; }
        s.intree = true;
        if bits[3] { s = vlq(s, V_TSIZE, 1); }
        else if b == 0x00 { s.mode = PAT; s.pat = 0; s.ppos = 1; }
        else if b == 0x10 { s.mode = PAT; s.pat = 1; s.ppos = 1; }
        else { s.err = true; s.mode = PAT; }
    } else if s.mode == PAT {
        let p = s.ppos as u32;
        if s.pat == 0 {
            if (p == 1) & (b != 0x08) { s.err = true; }
            if (p == 2) & (b != 0xcd) { s.err = true; }
        } else {
            let at = if p < 105 { p } else { 0 };
            if FEE[at] != b { s.err = true; }
        }
        s.ppos = s.ppos + 1;
        let end = if s.pat == 0 { 36 } else { 105 };
        if s.ppos == end { s = tree_done(s, kinds, lens); }
    } else if s.mode == TOKCNT {
        s.ctok = bf;
        if bf == 0 { s.mode = REGCNT; } else { s = vlq(s, V_TIDX, 1); }
    } else if s.mode == REGCNT {
        if bits[3] | bits[4] | bits[5] | bits[6] | bits[7] | (b == 7) { s.err = true; }
        s.r4ok = false; s.r5 = false;
        s = start_output_regs(s, bf);
    } else {
        // END: a byte after the last output.
        s.err = true;
    }
    s
}

pub fn scan<let L: u32, let SL: u32, let E: u32>(bytes: [u8; L], n: u32, scripts: [[u8; SL]; 4], lens: [Field; 4], generic: bool) -> (bool, Field, [Field; E], [Field; E], [Field; E]) {
    let mut s = start();
    let mut flags: [Field; E] = [0; E];
    let mut his: [Field; E] = [0; E];
    let mut los: [Field; E] = [0; E];
    for i in 0..L {
        if i < n {
            let before = s.outi;
            s = step(s, bytes[i], scripts, lens);
            // The output that ended at this byte is written at its index; later bytes write later indices.
            let ended = s.outi != before;
            let at = if generic { 1 } else { s.loc };
            let flag = if ended & s.r4ok & s.r5 & (at != 0) { at } else { 0 };
            let o = before as u32;
            flags[o] = flag;
            his[o] = s.shi;
            los[o] = s.slo;
        }
    }
    let valid = !s.err & (s.mode == END);
    (valid, s.outi, flags, his, los)
}

// The entries of a valid transaction, chained: (kind or 1 if generic, output, subject halves).
pub fn commit<let E: u32>(valid: bool, flags: [Field; E], his: [Field; E], los: [Field; E]) -> Field {
    let mut h: Field = 0;
    for e in 0..E {
        let live = valid & (flags[e] != 0);
        let entry = if live { [h, flags[e] * 65536 + (e as Field), his[e], los[e]] } else { [h, 0, 0, 0] };
        h = std::hash::poseidon2_permutation(entry)[0];
    }
    h
}
