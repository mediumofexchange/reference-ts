// The helpers shared by pool-v3's six relations (pool-v3 §2): notes, owners,
// nullifiers and paths as pool-v2 §§1, 3–5, plus the claim tag
// (pool-recovery C3.1) and the holding proof, which keeps the nullifier
// private (C3.2).
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

pub fn commitment(domain: [u128; 2], note: Note) -> Field {
    assert(note.owner != 0);
    assert(note.rho != 0);
    let cm = Poseidon2::hash([
        1002, domain[0] as Field, domain[1] as Field,
        note.backing[0] as Field, note.backing[1] as Field,
        note.value as Field, note.owner, note.rho,
    ], 8);
    assert(cm != 0);
    cm
}

pub fn nullifier(domain: [u128; 2], cm: Field, secret: Field) -> Field {
    // pool-v2 §3: neither operator, segment, anchor nor path enters this
    // immutable identity.
    Poseidon2::hash([1003, domain[0] as Field, domain[1] as Field, cm, secret], 5)
}

// pool-recovery C3.1: a claim's public name is the hash of its nullifier.
pub fn tag(nf: Field) -> Field {
    Poseidon2::hash([1007, nf], 2)
}

// The holding proof with the nullifier returned rather than public
// (pool-recovery C3.2): ownership, the nullifier, and membership at the
// anchor where the value is positive. Padding proves ownership and its
// nullifier only.
pub fn holding(
    domain: [u128; 2], note: Note, secret: Field,
    siblings: [Field; 32], right: [bool; 32], anchor: Field,
) -> Field {
    assert(note.owner == owner(secret));
    let cm = commitment(domain, note);
    let nf = nullifier(domain, cm, secret);
    assert(nf != 0);
    let mut node = cm;
    for level in 0..32 {
        let left = if right[level] { siblings[level] } else { node };
        let other = if right[level] { node } else { siblings[level] };
        node = Poseidon2::hash([1004, level as Field, left, other], 4);
    }
    // pool-v2 §7.2: zero-value padding still proves ownership and its nullifier.
    assert((note.value == 0) | (node == anchor));
    nf
}

pub fn authenticate(
    domain: [u128; 2], note: Note, secret: Field,
    siblings: [Field; 32], right: [bool; 32], anchor: Field, nf: Field,
) {
    assert(nf == holding(domain, note, secret, siblings, right, anchor));
}

// pool-v2 §5: the backing is an entry of the scope whose root the statement
// names, under the link the operator holds it by; which entry stays private.
pub fn scoped(
    root: Field, backing: [u128; 2], link: [u128; 2],
    siblings: [Field; 16], right: [bool; 16],
) {
    let leaf = Poseidon2::hash([
        1005, backing[0] as Field, backing[1] as Field, link[0] as Field, link[1] as Field,
    ], 5);
    assert(leaf != 0);
    let mut node = leaf;
    for level in 0..16 {
        let left = if right[level] { siblings[level] } else { node };
        let other = if right[level] { node } else { siblings[level] };
        node = Poseidon2::hash([1006, level as Field, left, other], 4);
    }
    assert(node == root);
}
