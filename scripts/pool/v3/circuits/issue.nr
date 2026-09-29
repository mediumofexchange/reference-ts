mod notes;
mod poseidon2;
// The vendored Poseidon2 helper calls crate::poseidon2_permutation.
use std::hash::poseidon2_permutation;

// Issue, kind 1: exactly the eleven public inputs of pool-v3 §3.1, in order.
fn main(domain: pub [u128; 2], segment: pub [u128; 2], scope: pub Field,
        backing: pub [u128; 2], quantity: pub u64, cm: pub Field,
        delivery: pub [u128; 2],
        owner: Field, rho: Field, link: [u128; 2],
        scope_siblings: [Field; 16], scope_right: [bool; 16]) {
    // pool-v2 §7: a proof is for one segment. The identity is bound as a
    // public input; nothing is computed from it.
    let _ = segment;
    // pool-delivery C4.4: the digest is proof-bound here; the host checks
    // the capsules' count, widths, profile, output association and hash.
    let _ = delivery;
    assert(quantity > 0);
    assert(cm == notes::commitment(domain,
        notes::Note { backing, value: quantity, owner, rho }));
    notes::scoped(scope, backing, link, scope_siblings, scope_right);
    // Admission separately verifies K's signature over the whole statement
    // (pool-v3 §3.1).
}
