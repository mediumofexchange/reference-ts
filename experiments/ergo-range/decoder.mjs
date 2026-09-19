// Candidate decoder boundary shared by the profile probe and local replay.
// Exact existing sigma-rust round trip; neither node equivalence nor hard
// memory containment is established by it.
import { blake2b } from "@noble/hashes/blake2b";
import { Transaction } from "ergo-lib-wasm-nodejs";

const hex = bytes => Buffer.from(bytes).toString("hex");
export const decodeTransaction = bytes => {
  let tx;
  try { tx = Transaction.sigma_parse_bytes(bytes); } catch { return undefined; }
  try {
    if (hex(tx.sigma_serialize_bytes()) !== hex(bytes)) return undefined;
    const js = tx.to_js_eip12();
    const proofs = js.inputs.map(input => Buffer.from(input.spendingProof.proofBytes, "hex"));
    return { id: Buffer.from(js.id, "hex"), witnessId: blake2b(Buffer.concat(proofs), { dkLen: 32 }).subarray(1),
      outputs: js.outputs.map(output => ({ ergoTree: Buffer.from(output.ergoTree, "hex"),
        registers: Object.fromEntries(Object.entries(output.additionalRegisters).map(([name, value]) => [name, Buffer.from(value, "hex")])) })) };
  } finally { tx.free(); }
};
