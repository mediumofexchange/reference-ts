// Blake2b-256 (RFC 7693) over u64 words, unkeyed, 32-byte digest.
use std::ops::WrappingAdd;

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

fn rotr(x: u64, n: u64) -> u64 {
    (x >> n) | (x << (64 - n))
}

fn g(v: &mut [u64; 16], a: u32, b: u32, c: u32, d: u32, x: u64, y: u64) {
    v[a] = v[a].wrapping_add(v[b]).wrapping_add(x);
    v[d] = rotr(v[d] ^ v[a], 32);
    v[c] = v[c].wrapping_add(v[d]);
    v[b] = rotr(v[b] ^ v[c], 24);
    v[a] = v[a].wrapping_add(v[b]).wrapping_add(y);
    v[d] = rotr(v[d] ^ v[a], 16);
    v[c] = v[c].wrapping_add(v[d]);
    v[b] = rotr(v[b] ^ v[c], 63);
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

fn word(bytes: [u8; 128], i: u32) -> u64 {
    let mut w: u64 = 0;
    for j in 0..8 {
        w = w + ((bytes[i * 8 + j] as u64) << (8 * j as u64));
    }
    w
}

/// Blake2b-256 of a fixed-length message (length known at compile time, at least one byte).
pub fn blake2b256<let L: u32>(msg: [u8; L]) -> [u8; 32] {
    let blocks = (L + 127) / 128;
    let mut h = IV;
    h[0] = h[0] ^ 0x01010020;
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
    let mut out: [u8; 32] = [0; 32];
    for i in 0..4 {
        for j in 0..8 {
            out[i * 8 + j] = (h[i] >> (8 * j as u64)) as u8;
        }
    }
    out
}
