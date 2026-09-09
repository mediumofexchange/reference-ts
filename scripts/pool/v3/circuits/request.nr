mod notes;
mod poseidon2;
use std::hash::poseidon2_permutation;

// Successor candidate request: exactly seven public fields in §2.6 order.
// Candidate evidence only; not pool-v2 normative source or a final configuration.
fn main(domain: pub [u128; 2], backing: pub [u128; 2], anchor: pub Field, tag: pub Field,
        refresh: pub u64,
        note: notes::Note, secret: Field, siblings: [Field; 32], right: [bool; 32]) {
    // Refresh is proof-bound but does not enter ownership, tag, or membership.
    let _ = refresh;
    // One real note, its size hidden (C2b.5.1).
    assert(note.value > 0);
    assert(note.backing == backing);
    let nf = notes::holding(domain, note, secret, siblings, right, anchor);
    assert(tag == notes::tag(nf));
}
