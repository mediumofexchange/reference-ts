// moe/pool/v1 §§1, 3–4. Integer types constrain limbs and quantities.
use crate::poseidon2::Poseidon2;

pub struct Note {
    pub backing: [u128; 2],
    pub value: u64,
    pub owner: Field,
    pub rho: Field,
}

pub fn owner(secret: Field) -> Field {
    assert(secret != 0);
    Poseidon2::hash([1001, secret], 2)
}

pub fn commitment(pool: [u128; 2], note: Note) -> Field {
    assert(note.owner != 0);
    assert(note.rho != 0);
    let cm = Poseidon2::hash([
        1002, pool[0] as Field, pool[1] as Field,
        note.backing[0] as Field, note.backing[1] as Field,
        note.value as Field, note.owner, note.rho,
    ], 8);
    assert(cm != 0);
    cm
}

pub fn nullifier(pool: [u128; 2], cm: Field, secret: Field) -> Field {
    // §3: neither the anchor nor the path enters this immutable identity.
    Poseidon2::hash([1003, pool[0] as Field, pool[1] as Field, cm, secret], 5)
}

pub fn authenticate(
    pool: [u128; 2], note: Note, secret: Field,
    siblings: [Field; 32], right: [bool; 32], anchor: Field, nf: Field,
) {
    assert(note.owner == owner(secret));
    let cm = commitment(pool, note);
    assert(nf == nullifier(pool, cm, secret));
    assert(nf != 0);
    let mut node = cm;
    for level in 0..32 {
        let left = if right[level] { siblings[level] } else { node };
        let other = if right[level] { node } else { siblings[level] };
        node = Poseidon2::hash([1004, level as Field, left, other], 4);
    }
    // §5.2: zero-value padding still proves ownership and its nullifier.
    assert((note.value == 0) | (node == anchor));
}
