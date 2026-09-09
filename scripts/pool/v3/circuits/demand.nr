mod notes;
mod poseidon2;
use std::hash::poseidon2_permutation;

// Successor candidate demand: exactly sixteen public fields in §2.6 order.
// Candidate evidence only; not pool-v2 normative source or a final configuration.
fn main(domain: pub [u128; 2], segment: pub [u128; 2], scope: pub Field,
        backing: pub [u128; 2], quantity: pub u64,
        anchors: pub [Field; 2], tags: pub [Field; 2],
        presenter: pub [u128; 2], instant: pub u64, deadline: pub u64,
        inputs: [notes::Note; 2], secrets: [Field; 2],
        siblings: [[Field; 32]; 2], right: [[bool; 32]; 2],
        link: [u128; 2], scope_siblings: [Field; 16], scope_right: [bool; 16]) {
    // The segment and the notice fields are bound as public inputs and read
    // by nothing in-circuit: the notice is the statement's own public inputs.
    let _ = segment;
    let _ = presenter;
    let _ = instant;
    let _ = deadline;
    // Every note names the public backing, so one scope path covers them all.
    notes::scoped(scope, backing, link, scope_siblings, scope_right);
    let mut nfs: [Field; 2] = [0; 2];
    for i in 0..2 {
        assert(inputs[i].backing == backing);
        // C3.2: padding has the canonical zero anchor.
        assert((inputs[i].value > 0) | (anchors[i] == 0));
        nfs[i] = notes::holding(domain, inputs[i], secrets[i], siblings[i], right[i], anchors[i]);
        // A real position publishes its tag; padding publishes zero.
        let expected = if inputs[i].value > 0 { notes::tag(nfs[i]) } else { 0 };
        assert(tags[i] == expected);
    }
    // A5: one note cannot fill both positions.
    assert(nfs[0] != nfs[1]);
    assert(quantity > 0);
    assert(inputs[0].value as u128 + inputs[1].value as u128 == quantity as u128);
}
