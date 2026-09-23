// Candidate decoder boundary shared by the profile probe and local replay.
// Exact existing sigma-rust round trip; neither node equivalence nor hard
// memory containment is established by it.
//
// The pinned build is the vendored release build of sigma-rust 2f840d3
// (vendor/ergo-lib-wasm-nodejs). A stack overflow or trap inside the module
// leaves its one instance unusable, so it is fatal here, never a refusal:
// every later call throws and the process must start again. The debug npm
// alpha of the same commit overflowed on node-valid transactions and trapped
// at expression depth 50; see the decoder stack probe.
import { blake2b } from "@noble/hashes/blake2b";
import { Transaction } from "ergo-lib-wasm-nodejs";

// A stack overflow surfaces as RangeError and a trap as WebAssembly.RuntimeError; either leaves the instance's memory
// in an unknown state.
const fatal = error => error instanceof RangeError || error instanceof WebAssembly.RuntimeError;
let poisoned;
const hex = bytes => Buffer.from(bytes).toString("hex");
export const decodeTransaction = bytes => {
  if (poisoned !== undefined) throw new Error("the decoder trapped earlier; its instance cannot be used", { cause: poisoned });
  let tx;
  try { tx = Transaction.sigma_parse_bytes(bytes); } catch (error) { if (fatal(error)) { poisoned = error; throw error; } return undefined; }
  try {
    if (hex(tx.sigma_serialize_bytes()) !== hex(bytes)) return undefined;
    const js = tx.to_js_eip12();
    const proofs = js.inputs.map(input => Buffer.from(input.spendingProof.proofBytes, "hex"));
    return { id: Buffer.from(js.id, "hex"), witnessId: blake2b(Buffer.concat(proofs), { dkLen: 32 }).subarray(1),
      outputs: js.outputs.map(output => ({ ergoTree: Buffer.from(output.ergoTree, "hex"),
        registers: Object.fromEntries(Object.entries(output.additionalRegisters).map(([name, value]) => [name, Buffer.from(value, "hex")])) })) };
  } catch (error) { if (fatal(error)) poisoned = error; throw error; }
  finally { if (poisoned === undefined) tx.free(); }
};
