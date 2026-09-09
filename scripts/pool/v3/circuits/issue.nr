mod notes;
mod poseidon2;
use std::hash::poseidon2_permutation;

// Successor candidate issue: exactly eleven public fields in §2.6 order.
// Candidate evidence only; not pool-v2 normative source or a final configuration.
fn main(domain: pub [u128; 2], segment: pub [u128; 2], scope: pub Field,
        backing: pub [u128; 2], quantity: pub u64, cm: pub Field,
        delivery: pub [u128; 2],
        owner: Field, rho: Field, link: [u128; 2],
        scope_siblings: [Field; 16], scope_right: [bool; 16]) {
    // §7: a proof is for one segment. The identity is bound as a public
    // input; nothing is computed from it.
    let _ = segment;
    // C4.4: the host checks framing and capsule association.
    let _ = delivery;
    assert(quantity > 0);
    assert(cm == notes::commitment(domain,
        notes::Note { backing, value: quantity, owner, rho }));
    notes::scoped(scope, backing, link, scope_siblings, scope_right);
    // Admission separately verifies K's signature over statementBytes (§8).
}
