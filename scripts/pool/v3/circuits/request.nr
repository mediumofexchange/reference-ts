mod notes;
mod poseidon2;
// The vendored Poseidon2 helper calls crate::poseidon2_permutation.
use std::hash::poseidon2_permutation;

// Request, kind 7: exactly the seven public inputs of pool-v3 §3.6, in
// order: pool-recovery C3.2's segment-free holding proof.
fn main(domain: pub [u128; 2], backing: pub [u128; 2], anchor: pub Field, tag: pub Field,
        refresh: pub u64,
        note: notes::Note, secret: Field, siblings: [Field; 32], right: [bool; 32]) {
    // Refresh is proof-bound but does not enter ownership, tag, or membership.
    let _ = refresh;
    // One real note, its size hidden (pool-recovery C2b.5.1).
    assert(note.value > 0);
    assert(note.backing == backing);
    let nf = notes::holding(domain, note, secret, siblings, right, anchor);
    assert(tag == notes::tag(nf));
}
