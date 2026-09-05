mod notes;
mod poseidon2;
use std::hash::poseidon2_permutation;

fn main(pool: pub [u128; 2], asset: pub [u128; 2], quantity: pub u64, output: pub Field,
        recipient: Field, rho: Field) {
    assert(quantity > 0);
    assert(recipient != 0);
    assert(rho != 0);
    assert(output != 0);
    assert(output == notes::commitment(pool,
        notes::Note { asset, value: quantity, owner: recipient, rho }));
    // The host separately requires the obligor's signature over this exact
    // public issuance statement, kind, circuit identity and pool configuration.
}
