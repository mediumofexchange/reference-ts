mod notes;
mod poseidon2;
// The vendored Poseidon2 helper calls crate::poseidon2_permutation.
use std::hash::poseidon2_permutation;

// Burn, kind 3: exactly the fifteen public inputs of pool-v3 §3.3, in order.
fn main(domain: pub [u128; 2], segment: pub [u128; 2], scope: pub Field,
        backing: pub [u128; 2], quantity: pub u64,
        anchors: pub [Field; 2], nullifiers: pub [Field; 2], cm_change: pub Field,
        delivery: pub [u128; 2],
        inputs: [notes::Note; 2], secrets: [Field; 2],
        siblings: [[Field; 32]; 2], right: [[bool; 32]; 2], change: notes::Note,
        link: [u128; 2], scope_siblings: [Field; 16], scope_right: [bool; 16]) {
    // pool-v2 §7: a proof is for one segment. The identity is bound as a
    // public input; nothing is computed from it.
    let _ = segment;
    // pool-delivery C4.4: the digest is proof-bound here; the host checks
    // the capsules' count, widths, profile, output association and hash.
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
