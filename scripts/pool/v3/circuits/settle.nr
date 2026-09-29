mod notes;
mod poseidon2;
// The vendored Poseidon2 helper calls crate::poseidon2_permutation.
use std::hash::poseidon2_permutation;

// Settle, kind 6: exactly the seventeen public inputs of pool-v3 §3.5, in
// order, with rho_out public: pool-recovery C3.5's settlement statement.
fn main(domain: pub [u128; 2], segment: pub [u128; 2], scope: pub Field,
        backing: pub [u128; 2], quantity: pub u64, owner: pub Field, rho_out: pub Field,
        anchors: pub [Field; 2], nullifiers: pub [Field; 2], cm_out: pub Field,
        demand: pub [u128; 2],
        inputs: [notes::Note; 2], secrets: [Field; 2],
        siblings: [[Field; 32]; 2], right: [[bool; 32]; 2],
        link: [u128; 2], scope_siblings: [Field; 16], scope_right: [bool; 16]) {
    // The segment and the demand identity are bound as public inputs; the
    // reader checks the demand's tags, acceptance, release, locks, time and
    // spentness in the clear (pool-v3 §3.5).
    let _ = segment;
    let _ = demand;
    // Every note names the public backing, so one scope path covers them all.
    notes::scoped(scope, backing, link, scope_siblings, scope_right);
    for i in 0..2 {
        notes::authenticate(domain, inputs[i], secrets[i], siblings[i], right[i], anchors[i], nullifiers[i]);
        assert(inputs[i].backing == backing);
    }
    assert(nullifiers[0] != nullifiers[1]);
    assert(quantity > 0);
    assert(inputs[0].value as u128 + inputs[1].value as u128 == quantity as u128);
    // The whole quantity settles to the public owner, which the reader ties to
    // the acceptance (pool-recovery C3.4); commitment() refuses a zero owner,
    // rho or commitment.
    assert(cm_out == notes::commitment(domain,
        notes::Note { backing, value: quantity, owner, rho: rho_out }));
}
