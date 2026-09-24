// Supplier side of the candidate profile: what a reader takes for one transaction, its unsigned bytes and its witness
// id, derived from the signed bytes a node serves. The reader never runs this: it hashes and frames what it is given,
// and the header's transaction root decides whether that is what the block committed to. A supplier needs a parser
// for the signed bytes because a context extension holds arbitrary values; this one uses the pinned sigma-rust
// (decoder.mjs's strict round trip) and so supplies only transactions that library reads. A node's own serializer
// (node-read/NodeRead.java states the unsigned bytes too) supplies every transaction the node reads.
import { blake2b } from "@noble/hashes/blake2b";
import { Transaction } from "ergo-lib-wasm-nodejs";

export const WITNESS_ID_BYTES = 31;
const fatal = error => error instanceof RangeError || error instanceof WebAssembly.RuntimeError;
const vlq = (bytes, at) => {
  let value = 0, shift = 0;
  for (;;) {
    if (at >= bytes.length || shift > 28) throw new Error("truncated VLQ");
    const byte = bytes[at++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, at];
    shift += 7;
  }
};

/** `{ unsigned, witnessId, id }` for signed transaction bytes, or undefined where sigma-rust does not read them
 * exactly. The signed bytes carry each input's proof as a length and its bytes; the unsigned bytes carry a zero
 * length instead, and are otherwise the same bytes. The result's id is checked against the library's. */
export function supplyTransaction(signed) {
  let tx;
  try { tx = Transaction.sigma_parse_bytes(signed); } catch (error) { if (fatal(error)) throw error; return undefined; }
  // A trap leaves the library's instance unusable (decoder.mjs), so it is rethrown and the object is not freed.
  let trapped = false;
  try {
    if (Buffer.compare(Buffer.from(tx.sigma_serialize_bytes()), Buffer.from(signed)) !== 0) return undefined;
    const json = tx.to_js_eip12(), id = Buffer.from(tx.id().to_str(), "hex");
    const parts = [], proofs = [];
    let [count, at] = vlq(signed, 0);
    if (count !== json.inputs.length) throw new Error("input count");
    parts.push(signed.subarray(0, at));
    for (const input of json.inputs) {
      const boxEnd = at + 32;
      parts.push(signed.subarray(at, boxEnd), Uint8Array.of(0));
      const [proofLength, proofStart] = vlq(signed, boxEnd);
      const proof = signed.subarray(proofStart, proofStart + proofLength);
      if (Buffer.from(proof).toString("hex") !== input.spendingProof.proofBytes) throw new Error("proof bytes");
      proofs.push(proof);
      // The extension: an entry count, then each entry's key byte and its serialized constant.
      const entries = Object.values(input.spendingProof.extension ?? {});
      const extensionLength = 1 + entries.reduce((n, value) => n + 1 + value.length / 2, 0);
      const extensionStart = proofStart + proofLength;
      if (signed[extensionStart] !== entries.length) throw new Error("extension count");
      parts.push(signed.subarray(extensionStart, extensionStart + extensionLength));
      at = extensionStart + extensionLength;
    }
    parts.push(signed.subarray(at));
    const unsigned = new Uint8Array(Buffer.concat(parts));
    if (Buffer.compare(Buffer.from(blake2b(unsigned, { dkLen: 32 })), id) !== 0) throw new Error("the unsigned bytes do not hash to the transaction id");
    return { unsigned, witnessId: blake2b(Buffer.concat(proofs), { dkLen: 32 }).subarray(1), id };
  } catch (error) { trapped = fatal(error); throw error; }
  finally { if (!trapped) tx.free(); }
}

/** The adapter's form of one supplied transaction: the witness id, then the unsigned bytes. */
export const packed = ({ unsigned, witnessId }) => new Uint8Array(Buffer.concat([witnessId, unsigned]));
