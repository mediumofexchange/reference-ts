fn main(blocks: [[u32; 16]; 64], iv: [u32; 8]) -> pub [u32; 8] {
    let mut s = iv;
    for i in 0..64 { s = std::hash::sha256_compression(blocks[i], s); }
    s
}
