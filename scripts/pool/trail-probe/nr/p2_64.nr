fn main(x: [Field; 4]) -> pub [Field; 4] {
    let mut s = x;
    for _ in 0..64 { s = std::hash::poseidon2_permutation(s); }
    s
}
