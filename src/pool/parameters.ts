// The proving parameters the pinned backend loads (pool-v3 §4), one accepted
// layout per input, as SHA-256. Here, beside the backend's loader, without the
// backend: pool-v3's manifest (`v3/configuration.ts`) holds them as its
// parameter identities, and `proof-verifier.ts` checks every copy against them.

/**
 * `g1` is the leading `points` G1 points of Aztec Ignition's transcript00,
 * uncompressed as the backend reads them (each point `x || y`, 32-byte
 * big-endian; the first is `[1]_1`). `points` is the size of the largest
 * relation proved here, pool-v3's spend: the backend refuses to derive a key or
 * prove for a larger circuit. `g2` is `[x]_2`, which the backend's loader also
 * requires.
 */
export const BN254_PARAMETERS = Object.freeze({
  points: 32768,
  g1: "50d2f4e9567be2b8e382cedfd078b96a3428a94597b7e88c4116e105d578ce77",
  g2: "01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f",
});
