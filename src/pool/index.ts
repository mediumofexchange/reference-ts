// The shielded pool's claim layer (Construction §C1.2; pool-v1), in the
// order it is built: the field and the in-circuit hash, notes, the note
// tree, the spent set, the frames, and admission with replay.
//
// The proof backend (`pool/barretenberg.ts`) is reachable on its own subpath
// only, since it needs `@aztec/bb.js`; the circuits it verifies are the
// pinned sources in `pool/circuits/`.

export * from "./field.js";
export * from "./poseidon2.js";
export * from "./notes.js";
export * from "./note-tree.js";
export * from "./spent-set.js";
export * from "./statement.js";
export * from "./pool.js";
export * from "./receipt.js";
