// The holder's read path for a browser engine (slice 39): what the browser bundle (scripts/browser/build.mjs) holds.
// Each module is the library's own, the Node path's; the bundle substitutes node:sqlite, node:crypto, node:fs,
// node:path, node:url and node:module with src/browser/'s modules and gives `Buffer` from the `buffer` package. It runs
// in a dedicated worker: SQLite's WebAssembly build and Barretenberg start there, and the package's assets are read
// beside the bundle by synchronous requests (node-fs.ts).
//
// What runs here (scripts/browser/check.mjs shows it in a browser engine): the one walk over a proof-free trail and
// over a complete one, its replay and evidence stores in memory, proof verification and proving under the adopted
// configuration, the trail check set's covers, and capsules; and once the host mounts the worker's file pool
// (`mountFiles`, slice 40), database files: kept replay files, retained evidence and the wallet's own. What does not,
// yet: the wallet's flows over `fetch`, the Ergo view, the commands and the service.
export { mountFiles, unmountFiles } from "./files.js";
export * as capsules from "../pool/v3/capsules.js";
export * as checkSet from "../pool/v3/check-set.js";
export * as commitments from "../pool/v3/commitments.js";
export * as configuration from "../pool/v3/configuration.js";
export * as evidenceStore from "../pool/v3/evidence-store.js";
export * as headers from "../pool/v3/headers.js";
export * as noteTree from "../pool/note-tree.js";
export * as parameters from "../pool/parameters.js";
export * as proofVerifier from "../pool/proof-verifier.js";
export * as prover from "../pool/v3/prover.js";
export * as records from "../pool/v3/records.js";
export * as replayStore from "../pool/v3/replay-store.js";
export * as scopeReader from "../pool/v3/scope-reader.js";
export * as state from "../pool/v3/state.js";
export * as succinct from "../pool/v3/succinct.js";
export * as terms from "../pool/v3/terms.js";
export * as trail from "../pool/v3/trail.js";
export * as verifier from "../pool/v3/verifier.js";
export * as witness from "../pool/v3/witness.js";
