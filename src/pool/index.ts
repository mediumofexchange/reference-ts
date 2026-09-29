// The shielded pool's shared primitives (Construction §C1.2), which pool-v3
// builds on: the field and the in-circuit hash, notes, the note tree, the
// scope and the scope schedule.
//
// pool-v3 itself (`pool/v3/`) is reachable on its own subpaths only, as is
// the proof backend (`pool/proof-verifier.ts`), since it needs `@aztec/bb.js`;
// the package requires Node 24, whose node:sqlite holds every party's replay state.

export * from "./field.js";
export * from "./poseidon2.js";
export * from "./notes.js";
export * from "./note-tree.js";
export * from "./scope.js";
export * from "./schedule.js";
