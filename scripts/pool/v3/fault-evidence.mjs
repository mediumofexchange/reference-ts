// The observer now shares the runtime implementation. Extra legacy codec
// arguments are ignored. Replay's pre-clone allocation bound stays local.
import { EncodingError } from "../../../dist/bytes.js";
import { EvidenceRefusal } from "../../../dist/pool/v3/refusals.js";
import { FAULT_LIMITS } from "../../../dist/pool/v3/fault-observer.js";
export { FAULT_LIMITS, faultObserver } from "../../../dist/pool/v3/fault-observer.js";

// Called before replay's ownership copy. Inspect intrinsic byte widths rather
// than shadowable properties of typed-array subclasses.
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const lengthOf = Object.getOwnPropertyDescriptor(typed, "byteLength").get;
const bufferOf = Object.getOwnPropertyDescriptor(typed, "buffer").get;
const offsetOf = Object.getOwnPropertyDescriptor(typed, "byteOffset").get;
const allocationOf = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
export function boundFaultInputs(faults = []) {
  if (!Array.isArray(faults)) throw new EncodingError("invalid compact evidence inventory");
  const count = faults.length;
  if (!Number.isSafeInteger(count) || count < 0 || BigInt(count) > FAULT_LIMITS.maxItems) throw new EvidenceRefusal("resource-refusal");
  let bytes = 0n;
  const views = [];
  // Indexed reads avoid a caller-supplied iterator, and capture each entry once.
  for (let i = 0; i < count; i++) {
    const payload = faults[i];
    if (!(payload instanceof Uint8Array) || bufferOf.call(payload) instanceof SharedArrayBuffer) {
      throw new EncodingError("invalid compact evidence bytes");
    }
    // Cloning a subview also copies its backing allocation.
    bytes += BigInt(allocationOf.call(bufferOf.call(payload)));
    if (bytes > FAULT_LIMITS.maxBytes || BigInt(lengthOf.call(payload)) > FAULT_LIMITS.maxBytes) {
      throw new EvidenceRefusal("resource-refusal");
    }
    views.push(new Uint8Array(bufferOf.call(payload), offsetOf.call(payload), lengthOf.call(payload)));
  }
  return views.map(view => new Uint8Array(view));
}
