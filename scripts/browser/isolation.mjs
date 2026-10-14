// The in-browser isolation check (slice 39): on a page that is not cross-origin isolated, where bb.js's browser build
// would load a binary no check has run, the library's Poseidon2 must refuse to start (packaged-binary.ts).
// scripts/browser/check.mjs serves this page without the isolation headers.
import { finish } from "./worker-report.mjs";
import { PACKAGED_BINARY_REFUSAL } from "../../src/pool/packaged-binary.js";

let outcome;
try {
  await import("../../src/pool/poseidon2.js");
  outcome = { started: true };
} catch (error) {
  outcome = { started: false, refusedByName: error?.message === PACKAGED_BINARY_REFUSAL, message: String(error?.message ?? error) };
}
await finish({ kind: "isolation", isolated: globalThis.crossOriginIsolated === true, ...outcome });
