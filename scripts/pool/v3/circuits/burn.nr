mod notes;
mod poseidon2;
use std::hash::poseidon2_permutation;

// Successor candidate burn: exactly fifteen public fields in §2.6 order.
// Candidate evidence only; not pool-v2 normative source or a final configuration.
fn main(domain: pub [u128; 2], segment: pub [u128; 2], scope: pub Field,
        backing: pub [u128; 2], quantity: pub u64,
        anchors: pub [Field; 2], nullifiers: pub [Field; 2], cm_change: pub Field,
        delivery: pub [u128; 2],
        inputs: [notes::Note; 2], secrets: [Field; 2],
        siblings: [[Field; 32]; 2], right: [[bool; 32]; 2], change: notes::Note,
        link: [u128; 2], scope_siblings: [Field; 16], scope_right: [bool; 16]) {
    // §7: a proof is for one segment. The identity is bound as a public
    // input; nothing is computed from it.
    let _ = segment;
    // C4.4: the host checks framing and capsule association.
    let _ = delivery;
    // Every note names the public backing, so one scope path covers them all.
    notes::scoped(scope, backing, link, scope_siblings, scope_right);
    for i in 0..2 {
        notes::authenticate(domain, inputs[i], secrets[i], siblings[i], right[i], anchors[i], nullifiers[i]);
        assert(inputs[i].backing == backing);
    }
    assert(nullifiers[0] != nullifiers[1]);
    assert(quantity > 0);
    assert(change.backing == backing);
    assert(inputs[0].value as u128 + inputs[1].value as u128 == quantity as u128 + change.value as u128);
    assert(cm_change == notes::commitment(domain, change));
}
