// Research relation only. Domains are fixed to this experiment's first version.
use crate::poseidon2::Poseidon2;

pub struct Note {
    pub asset: [u128; 2],
    pub value: u64,
    pub owner: Field,
    pub rho: Field,
}

pub fn owner(secret: Field) -> Field {
    assert(secret != 0);
    Poseidon2::hash([1001, secret], 2)
}

pub fn commitment(pool: [u128; 2], note: Note) -> Field {
    Poseidon2::hash([
        1002, pool[0] as Field, pool[1] as Field,
        note.asset[0] as Field, note.asset[1] as Field,
        note.value as Field, note.owner, note.rho,
    ], 8)
}

pub fn nullifier(pool: [u128; 2], cm: Field, secret: Field) -> Field {
    // Never include the anchor or Merkle path: one note has one nullifier.
    Poseidon2::hash([1003, pool[0] as Field, pool[1] as Field, cm, secret], 5)
}

pub fn authenticate(
    pool: [u128; 2], note: Note, secret: Field,
    siblings: [Field; 8], right: [bool; 8], anchor: Field, nf: Field,
) {
    assert(note.value > 0);
    assert(note.owner == owner(secret));
    let cm = commitment(pool, note);
    assert(nf == nullifier(pool, cm, secret));
    assert(nf != 0);
    let mut node = cm;
    for level in 0..8 {
        let left = if right[level] { siblings[level] } else { node };
        let other = if right[level] { node } else { siblings[level] };
        node = Poseidon2::hash([1004, level as Field, left, other], 4);
    }
    assert(node == anchor);
}
