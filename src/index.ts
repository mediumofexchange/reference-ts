// The public surface of @mediumofexchange/reference.
//
// A reference implementation earns its name by being readable, so nothing is
// hidden: every module is re-exported whole, and each is also reachable on its
// own subpath (`@mediumofexchange/reference/backing`) for callers who want to
// take a narrow dependency rather than the lot.
//
// The order below is the order the system is built in, not alphabetical:
// bytes and keys underneath, then the object, then what moves it, then
// sequencing, then failure and recovery. Reading top to bottom is a tour.

// Primitives: canonical encoding, quantities, keys, and every domain tag.
export * from "./bytes.js";
export * from "./keys.js";
export * from "./contexts.js";

// The object itself: B = (K, P, R, E), its canonical bytes, its name.
export * from "./backing.js";

// What is said about it, and what comes back signed.
export * from "./messages.js";
export * from "./receipt.js";
export * from "./oplog.js";

// Holdings and the arithmetic the law constrains.
export * from "./ledger.js";

// Ordering and witnessing.
export * from "./venue.js";
export * from "./commitment.js";
export * from "./sequencer.js";
export * from "./closure.js";

// Presentation, and refusal recorded without a trusted recorder.
export * from "./presentability.js";
export * from "./presentation.js";

// Failure: silence, succession, revocation, recovery, provable fault.
export * from "./replacement.js";
export * from "./revocation.js";
export * from "./recovery.js";
export * from "./fault.js";

// The Ergo read-only venue adapter is not part of the root surface. It is the
// venue direction, kept until the commitment format is final, and reachable on
// its own subpath: `@mediumofexchange/reference/ergo`.
