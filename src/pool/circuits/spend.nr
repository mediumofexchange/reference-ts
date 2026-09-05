mod notes;
mod poseidon2;
use std::hash::poseidon2_permutation;

// pool-v1 §5.2: exactly seven public fields, in this order.
fn main(pool: pub [u128; 2], anchor: pub Field, nullifiers: pub [Field; 2],
        outputs: pub [Field; 2], inputs: [notes::Note; 2], secrets: [Field; 2],
        siblings: [[Field; 32]; 2], right: [[bool; 32]; 2],
        output_notes: [notes::Note; 2]) {
    for i in 0..2 {
        notes::authenticate(pool, inputs[i], secrets[i], siblings[i], right[i], anchor, nullifiers[i]);
        assert((inputs[i].value > 0) | (inputs[i].backing == inputs[1 - i].backing));
        assert((output_notes[i].backing == inputs[0].backing) | (output_notes[i].backing == inputs[1].backing));
        assert(outputs[i] == notes::commitment(pool, output_notes[i]));
    }
    assert(nullifiers[0] != nullifiers[1]);
    assert(outputs[0] != outputs[1]);
    assert(inputs[0].value as u128 + inputs[1].value as u128 > 0);
    // Conserve each input backing separately, widening before every addition.
    for i in 0..2 {
        let backing = inputs[i].backing;
        let mut incoming: u128 = 0;
        let mut outgoing: u128 = 0;
        for j in 0..2 {
            incoming += if inputs[j].backing == backing { inputs[j].value as u128 } else { 0 };
            outgoing += if output_notes[j].backing == backing { output_notes[j].value as u128 } else { 0 };
        }
        assert(incoming == outgoing);
    }
}
