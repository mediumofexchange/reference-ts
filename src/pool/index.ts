// The shielded pool's claim layer (Construction §C1.2; pool-v2), in the
// order it is built: the field and the in-circuit hash, notes, the note
// tree, the spent set, the scope, the frames, the segment with its import,
// admission and replay, and the receipt.
//
// The proof backend (`pool/barretenberg.ts`) is reachable on its own subpath
// only, since it needs `@aztec/bb.js`; the circuits it verifies are the
// pinned sources in `pool/circuits/`.
// `pool/store.ts` is also a separate subpath: its durable SQLite journal
// requires Node 24, while this barrel retains the package's Node 20 floor.

export * from "./field.js";
export * from "./poseidon2.js";
export * from "./notes.js";
export * from "./note-tree.js";
export * from "./spent-set.js";
export * from "./scope.js";
export * from "./statement.js";
export * from "./segment.js";
export * from "./receipt.js";
export * from "./receipt-record.js";
export * from "./schedule.js";
export * from "./authority.js";
export * from "./descent.js";
export * from "./checkpoint.js";
export * from "./opening.js";
