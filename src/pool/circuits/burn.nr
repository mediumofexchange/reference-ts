mod notes;
mod poseidon2;
use std::hash::poseidon2_permutation;

// pool-v1 §5.3: exactly nine public fields, in this order.
fn main(pool: pub [u128; 2], backing: pub [u128; 2], quantity: pub u64,
        anchor: pub Field, nullifiers: pub [Field; 2], cm_change: pub Field,
        inputs: [notes::Note; 2], secrets: [Field; 2],
        siblings: [[Field; 32]; 2], right: [[bool; 32]; 2], change: notes::Note) {
    for i in 0..2 {
        notes::authenticate(pool, inputs[i], secrets[i], siblings[i], right[i], anchor, nullifiers[i]);
        assert(inputs[i].backing == backing);
    }
    assert(nullifiers[0] != nullifiers[1]);
    assert(quantity > 0);
    assert(change.backing == backing);
    assert(inputs[0].value as u128 + inputs[1].value as u128 == quantity as u128 + change.value as u128);
    assert(cm_change == notes::commitment(pool, change));
}
