mod notes;
mod poseidon2;
use std::hash::poseidon2_permutation;

// pool-v1 §5.1: exactly six public fields, in this order.
fn main(pool: pub [u128; 2], backing: pub [u128; 2], quantity: pub u64,
        cm: pub Field, owner: Field, rho: Field) {
    assert(quantity > 0);
    assert(cm == notes::commitment(pool,
        notes::Note { backing, value: quantity, owner, rho }));
    // Admission separately verifies K's signature over statementBytes (§6).
}
