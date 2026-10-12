fn main(bytes: [u8; 4096], iv: [u32; 8]) -> pub [u32; 8] {
    let mut s = iv;
    for i in 0..64 {
        let mut w = [0 as u32; 16];
        for j in 0..16 { w[j] = ((bytes[i*64+4*j] as u32) << 24) + ((bytes[i*64+4*j+1] as u32) << 16) + ((bytes[i*64+4*j+2] as u32) << 8) + (bytes[i*64+4*j+3] as u32); }
        s = std::hash::sha256_compression(w, s);
    }
    s
}
