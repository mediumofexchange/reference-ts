mod notes;
mod poseidon2;
use std::hash::poseidon2_permutation;

// Successor candidate settle: exactly seventeen public fields in §2.6 order,
// with rho_out public. Candidate evidence only; not pool-v2 normative source
// or a final configuration.
fn main(domain: pub [u128; 2], segment: pub [u128; 2], scope: pub Field,
        backing: pub [u128; 2], quantity: pub u64, owner: pub Field, rho_out: pub Field,
        anchors: pub [Field; 2], nullifiers: pub [Field; 2], cm_out: pub Field,
        demand: pub [u128; 2],
        inputs: [notes::Note; 2], secrets: [Field; 2],
        siblings: [[Field; 32]; 2], right: [[bool; 32]; 2],
        link: [u128; 2], scope_siblings: [Field; 16], scope_right: [bool; 16]) {
    // The segment and the demand identity are bound as public inputs; the
    // host checks the demand's tags, acceptance and release in the clear.
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
    // The whole quantity settles to the backer's owner value; commitment()
    // refuses a zero owner, rho or commitment.
    assert(cm_out == notes::commitment(domain,
        notes::Note { backing, value: quantity, owner, rho: rho_out }));
}
