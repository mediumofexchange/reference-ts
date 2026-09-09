mod notes;
mod poseidon2;
use std::hash::poseidon2_permutation;

// Successor candidate spend: exactly fifteen public fields in §2.6 order.
// Candidate evidence only; not pool-v2 normative source or a final configuration.
fn main(domain: pub [u128; 2], segment: pub [u128; 2], scope: pub Field,
        anchors: pub [Field; 2], nullifiers: pub [Field; 2], outputs: pub [Field; 4],
        delivery: pub [u128; 2],
        inputs: [notes::Note; 2], secrets: [Field; 2],
        siblings: [[Field; 32]; 2], right: [[bool; 32]; 2],
        links: [[u128; 2]; 2], scope_siblings: [[Field; 16]; 2], scope_right: [[bool; 16]; 2],
        output_notes: [notes::Note; 4]) {
    // §7: a proof is for one segment. The identity is bound as a public
    // input; nothing is computed from it.
    let _ = segment;
    let _ = delivery;
    for i in 0..2 {
        // Each input against its own anchor; padding proves ownership, its
        // nullifier and its scope membership, and nothing about the tree.
        notes::authenticate(domain, inputs[i], secrets[i], siblings[i], right[i], anchors[i], nullifiers[i]);
        notes::scoped(scope, inputs[i].backing, links[i], scope_siblings[i], scope_right[i]);
        assert((inputs[i].value > 0) | (inputs[i].backing == inputs[1 - i].backing));
    }
    for i in 0..4 {
        // Every output is ordinary: it names an input backing and binds its commitment.
        assert((output_notes[i].backing == inputs[0].backing) | (output_notes[i].backing == inputs[1].backing));
        assert(outputs[i] == notes::commitment(domain, output_notes[i]));
    }
    assert(nullifiers[0] != nullifiers[1]);
    assert(outputs[0] != outputs[1]);
    assert(outputs[0] != outputs[2]);
    assert(outputs[0] != outputs[3]);
    assert(outputs[1] != outputs[2]);
    assert(outputs[1] != outputs[3]);
    assert(outputs[2] != outputs[3]);
    assert(inputs[0].value as u128 + inputs[1].value as u128 > 0);
    // Conserve each input backing separately, widening before every addition.
    for i in 0..2 {
        let backing = inputs[i].backing;
        let mut incoming: u128 = 0;
        let mut outgoing: u128 = 0;
        for j in 0..2 {
            incoming += if inputs[j].backing == backing { inputs[j].value as u128 } else { 0 };
        }
        for j in 0..4 {
            outgoing += if output_notes[j].backing == backing { output_notes[j].value as u128 } else { 0 };
        }
        assert(incoming == outgoing);
    }
}
