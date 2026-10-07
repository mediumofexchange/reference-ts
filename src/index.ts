// The public surface of @mediumofexchange/reference.
//
// A reference implementation earns its name by being readable, so nothing is
// hidden: every module is re-exported whole, and each is also reachable on its
// own subpath (`@mediumofexchange/reference/pool/notes`) for callers who want to
// take a narrow dependency rather than the lot.
//
// The order below is the order the system is built in: bytes and keys
// underneath, then the venue records every construction reads, then the
// shielded pool's shared primitives.

// Primitives: canonical encoding, quantities, keys, and every domain tag.
export * from "./bytes.js";
export * from "./keys.js";
export * from "./contexts.js";

// The venue records of kinds 1–3 every construction reads: commitments and
// their directory, replacements and revocations.
export * from "./venue-records.js";

// The core claim layer's shared primitives: the shielded pool's field, hash,
// notes, trees and scope. pool-v3 and its proof backend are on their own
// subpaths (`pool/v3/…`, `pool/proof-verifier`), since the backend needs
// `@aztec/bb.js`. The lit construction (lit-v1, adopted) is on
// its own subpaths (`lit/…`) too.
export * from "./pool/index.js";

// The Ergo venue (venue-ergo.md) is not part of the root surface: its reader,
// header store, profile, suppliers and pool-v3 §13 answers are on their own
// subpaths (`@mediumofexchange/reference/ergo`, `/ergo-headers`,
// `/ergo-profile`, `/ergo-supplier`, `/record-range`).
