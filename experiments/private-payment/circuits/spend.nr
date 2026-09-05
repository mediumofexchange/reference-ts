mod notes;
mod poseidon2;
use std::hash::poseidon2_permutation;

fn main(pool: pub [u128; 2], anchor: pub Field, nf: pub Field, outputs: pub [Field; 2],
        input: notes::Note, secret: Field, siblings: [Field; 8], right: [bool; 8],
        payment: notes::Note, change: notes::Note) {
    notes::authenticate(pool, input, secret, siblings, right, anchor, nf);
    assert(payment.asset == input.asset);
    assert(change.asset == input.asset);
    assert(payment.value > 0);
    // Widen before adding. Field arithmetic must never substitute for quantities.
    assert(input.value as u128 == payment.value as u128 + change.value as u128);
    assert(payment.owner != 0);
    assert(change.owner != 0);
    assert(payment.rho != 0);
    assert(change.rho != 0);
    assert(outputs[0] == notes::commitment(pool, payment));
    assert(outputs[1] == notes::commitment(pool, change));
    assert(outputs[0] != 0);
    assert(outputs[1] != 0);
    assert(outputs[0] != outputs[1]);
}
