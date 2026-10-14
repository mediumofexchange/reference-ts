// Whether Barretenberg would run the binary the pinned package ships (slice 39). Under Node it does: poseidon2.ts
// names the file by path, and the verifier refuses BB_WASM_PATH (proof-verifier.ts). In the browser bundle, bb.js's
// browser build loads a binary it carries: where shared memory is available (SharedArrayBuffer on a cross-origin
// isolated page), the threaded one, byte for byte the file Node's package ships; otherwise a single-threaded one,
// which no check here has run (its malformed-proof messages, keys and hashes unshown). A bundle therefore starts
// Barretenberg only where bb.js's own test for shared memory (`getSharedMemoryAvailable`) passes, read as it reads it.
export const PACKAGED_BINARY_REFUSAL = "a browser host starts Barretenberg only cross-origin isolated with shared memory, where it loads the binary the package ships";

/** False only in the browser bundle where bb.js would not take its threaded binary. */
export function packagedBinary(): boolean {
  if (typeof MOE_BROWSER_CODE !== "string") return true;
  const own = globalThis as unknown as { window?: unknown };
  const scope = (typeof own.window !== "undefined" ? own.window : globalThis) as
    { crossOriginIsolated?: unknown };
  return typeof SharedArrayBuffer === "function" && scope.crossOriginIsolated === true;
}
