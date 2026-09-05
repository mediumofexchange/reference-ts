mod notes;
mod poseidon2;
use std::hash::poseidon2_permutation;

fn main(pool: pub [u128; 2], asset: pub [u128; 2], quantity: pub u64,
        anchor: pub Field, nf: pub Field, output: pub Field,
        input: notes::Note, secret: Field, siblings: [Field; 8], right: [bool; 8], change: notes::Note) {
    notes::authenticate(pool, input, secret, siblings, right, anchor, nf);
    assert(quantity > 0);
    assert(asset == input.asset);
    assert(change.asset == input.asset);
    assert(input.value as u128 == quantity as u128 + change.value as u128);
    assert(change.owner != 0);
    assert(change.rho != 0);
    assert(output != 0);
    assert(output == notes::commitment(pool, change));
}
