// Blake2b-256 (RFC 7693) compression over u64 words, with hinted additions and rotations: each sum of
// two or three words is its low 64 bits plus a constrained carry, and each rotation splits its word at
// the rotation point into two range-checked parts.
global IV: [u64; 8] = [
    0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
    0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179,
];
global SIGMA: [[u32; 16]; 10] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
global P64: Field = 18446744073709551616;

unconstrained fn low64(s: Field) -> (u64, Field) {
    let x = s as u128;
    ((x % 18446744073709551616) as u64, (x / 18446744073709551616) as Field)
}
// a + b (+ c) mod 2^64: the low word is range-checked by its type, the carry is 0, 1 or 2.
fn add3(a: u64, b: u64, c: u64) -> u64 {
    let s = a as Field + b as Field + c as Field;
    // Safety: r is range-checked as a u64 and the carry is constrained to {0, 1, 2}, so r = s mod 2^64.
    let (r, q) = unsafe { low64(s) };
    assert(q * (q - 1) * (q - 2) == 0);
    assert(r as Field + q * P64 == s);
    r
}
fn add2(a: u64, b: u64) -> u64 {
    let s = a as Field + b as Field;
    // Safety: r is range-checked as a u64 and the carry is a bit, so r = s mod 2^64.
    let (r, q) = unsafe { low64(s) };
    assert(q * (q - 1) == 0);
    assert(r as Field + q * P64 == s);
    r
}
unconstrained fn split(v: u64, n: u64) -> (Field, Field, u64) {
    let hi = v >> n;
    let lo = v & ((1 << n) - 1);
    (hi as Field, lo as Field, (lo << (64 - n)) | hi)
}
// v rotated right by 32, 24, 16 and 63: v = hi 2^n + lo with hi < 2^(64-n) and lo < 2^n gives lo 2^(64-n) + hi.
fn rotr32(v: u64) -> u64 {
    // Safety: both parts are range-checked and recombine to v; the result is their rotated sum.
    let (hi, lo, r) = unsafe { split(v, 32) };
    hi.assert_max_bit_size::<32>();
    lo.assert_max_bit_size::<32>();
    assert(hi * 4294967296 + lo == v as Field);
    assert(r as Field == lo * 4294967296 + hi);
    r
}
fn rotr24(v: u64) -> u64 {
    // Safety: as rotr32.
    let (hi, lo, r) = unsafe { split(v, 24) };
    hi.assert_max_bit_size::<40>();
    lo.assert_max_bit_size::<24>();
    assert(hi * 16777216 + lo == v as Field);
    assert(r as Field == lo * 1099511627776 + hi);
    r
}
fn rotr16(v: u64) -> u64 {
    // Safety: as rotr32.
    let (hi, lo, r) = unsafe { split(v, 16) };
    hi.assert_max_bit_size::<48>();
    lo.assert_max_bit_size::<16>();
    assert(hi * 65536 + lo == v as Field);
    assert(r as Field == lo * 281474976710656 + hi);
    r
}
fn rotr63(v: u64) -> u64 {
    // Safety: as rotr32.
    let (hi, lo, r) = unsafe { split(v, 63) };
    hi.assert_max_bit_size::<1>();
    lo.assert_max_bit_size::<63>();
    assert(hi * 9223372036854775808 + lo == v as Field);
    assert(r as Field == lo * 2 + hi);
    r
}

fn g(v: &mut [u64; 16], a: u32, b: u32, c: u32, d: u32, x: u64, y: u64) {
    v[a] = add3(v[a], v[b], x);
    v[d] = rotr32(v[d] ^ v[a]);
    v[c] = add2(v[c], v[d]);
    v[b] = rotr24(v[b] ^ v[c]);
    v[a] = add3(v[a], v[b], y);
    v[d] = rotr16(v[d] ^ v[a]);
    v[c] = add2(v[c], v[d]);
    v[b] = rotr63(v[b] ^ v[c]);
}

pub fn compress(h: [u64; 8], m: [u64; 16], t: u64, last: bool) -> [u64; 8] {
    let mut v: [u64; 16] = [0; 16];
    for i in 0..8 {
        v[i] = h[i];
        v[i + 8] = IV[i];
    }
    v[12] = v[12] ^ t;
    if last {
        v[14] = !v[14];
    }
    for r in 0..12 {
        let s = SIGMA[r % 10];
        g(&mut v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
        g(&mut v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
        g(&mut v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
        g(&mut v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
        g(&mut v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
        g(&mut v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
        g(&mut v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
        g(&mut v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    let mut out = h;
    for i in 0..8 {
        out[i] = h[i] ^ v[i] ^ v[i + 8];
    }
    out
}

pub fn iv0() -> [u64; 8] {
    let mut h = IV;
    h[0] = h[0] ^ 0x01010020;
    h
}

// The little-endian word i of a 128-byte block.
pub fn word(bytes: [u8; 128], i: u32) -> u64 {
    let mut w: Field = 0;
    for j in 0..8 {
        w = w * 256 + bytes[i * 8 + 7 - j] as Field;
    }
    // Safety: w is a sum of eight bytes, below 2^64.
    let r = unsafe { as_u64(w) };
    assert(r as Field == w);
    r
}
unconstrained fn as_u64(w: Field) -> u64 { w as u64 }

/// Blake2b-256 of a fixed-length message (length known at compile time, at least one byte), as 32 bytes.
pub fn blake2b256<let L: u32>(msg: [u8; L]) -> [u64; 4] {
    let blocks = (L + 127) / 128;
    let mut h = iv0();
    for b in 0..blocks {
        let mut block: [u8; 128] = [0; 128];
        for j in 0..128 {
            let k = b * 128 + j;
            if k < L {
                block[j] = msg[k];
            }
        }
        let mut m: [u64; 16] = [0; 16];
        for i in 0..16 {
            m[i] = word(block, i);
        }
        let last = b == blocks - 1;
        let t = if last { L as u64 } else { ((b + 1) * 128) as u64 };
        h = compress(h, m, t, last);
    }
    [h[0], h[1], h[2], h[3]]
}
