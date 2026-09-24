// Supplier side of the candidate profile: what a reader takes for one transaction, its unsigned bytes and its witness
// id, written by copying the node's JSON statement of the transaction. The reader never runs this: it hashes and
// frames what it is given, and the header's transaction root decides whether that is what the block committed to.
//
// Every field the unsigned bytes carry is in the node's statement as exact bytes (box and token ids, trees, register
// and context-extension constants, in hex) or as an integer (values, amounts, heights), so the bytes are written
// without parsing a single constant: no decoder, and nothing whose cost depends on a constant's type. Two properties
// of the text matter beyond its values: integers above 2^53, read from their source text, and each extension's key
// order, which the node writes in its map's order and a JavaScript object would sort, so the text is read by the small
// order-keeping parser below. A copy that does not hash to the id the node states is unsupplied (undefined), never
// misread; a supplier can only fail to supply.
import { blake2b } from "@noble/hashes/blake2b";

export const WITNESS_ID_BYTES = 31;

/** The node's JSON, strictly: objects as Maps in text order (a repeated key is refused), integers as bigint, strings
 * without escapes (the node's transaction JSON has none). Anything else throws. */
export function parseNodeJson(text) {
  let at = 0;
  const fail = what => { throw new SyntaxError(`node JSON: ${what} at ${at}`); };
  const space = () => { while (at < text.length && (text[at] === " " || text[at] === "\n" || text[at] === "\r" || text[at] === "\t")) at++; };
  const string = () => {
    if (text[at] !== '"') fail("expected a string");
    const end = text.indexOf('"', at + 1);
    if (end < 0) fail("unterminated string");
    const value = text.slice(at + 1, end);
    if (/[\\\u0000-\u001f]/.test(value)) fail("an escape or control character");
    at = end + 1;
    return value;
  };
  const value = depth => {
    if (depth > 64) fail("nesting");
    space();
    const c = text[at];
    if (c === "{") {
      at++;
      const map = new Map();
      space();
      if (text[at] === "}") { at++; return map; }
      for (;;) {
        space();
        const key = string();
        if (map.has(key)) fail(`repeated key ${key}`);
        space();
        if (text[at++] !== ":") fail("expected ':'");
        map.set(key, value(depth + 1));
        space();
        const next = text[at++];
        if (next === "}") return map;
        if (next !== ",") fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      at++;
      const items = [];
      space();
      if (text[at] === "]") { at++; return items; }
      for (;;) {
        items.push(value(depth + 1));
        space();
        const next = text[at++];
        if (next === "]") return items;
        if (next !== ",") fail("expected ',' or ']'");
      }
    }
    if (c === '"') return string();
    const integer = /-?(?:0|[1-9][0-9]*)/y;
    integer.lastIndex = at;
    const match = integer.exec(text);
    if (match !== null) {
      at += match[0].length;
      if (/[.eE]/.test(text[at] ?? "")) fail("a non-integer number");
      return BigInt(match[0]);
    }
    for (const [word, literal] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(word, at)) { at += word.length; return literal; }
    }
    return fail("unexpected character");
  };
  const result = value(0);
  space();
  if (at !== text.length) fail("trailing text");
  return result;
}

const HEX = /^(?:[0-9a-f]{2})*$/;
const MAX_U64 = (1n << 64n) - 1n, MAX_U32 = 0xffff_ffffn, MAX_U16 = 0xffff;
class Unsupplied extends Error {}
const refuse = () => { throw new Unsupplied(); };
const field = (map, key) => (map instanceof Map && map.has(key) ? map.get(key) : refuse());
const list = (map, key) => { const value = field(map, key); return Array.isArray(value) && value.length <= MAX_U16 ? value : refuse(); };
const bytes = (value, width) => typeof value === "string" && HEX.test(value) && (width === undefined || value.length === 2 * width) ? Buffer.from(value, "hex") : refuse();
const integer = (value, max) => typeof value === "bigint" && value >= 0n && value <= max ? value : refuse();
const vlq = n => {
  const out = [];
  do { let byte = Number(n & 0x7fn); n >>= 7n; if (n > 0n) byte |= 0x80; out.push(byte); } while (n > 0n);
  return Buffer.from(out);
};
const count = n => vlq(BigInt(n));

/** `{ unsigned, proofs, signedBytes }` copied from one transaction as the node states it (a Map from
 * `parseNodeJson`), or undefined where the statement is not of the node's shape; its stated id is not consulted. The
 * bytes are the node's transaction serialization with every proof empty: inputs (box id, a zero proof length, the
 * extension's entry count, then each key byte and constant in text order), data inputs, the distinct token ids in
 * order of first appearance, and outputs (value, tree, creation height, tokens as index and amount, then registers
 * R4 onward). `signedBytes` is the length of the same transaction with its proofs, for measurement only. */
export function copyTransaction(statement) {
  try {
    const parts = [], proofs = [];
    const inputs = list(statement, "inputs"), dataInputs = list(statement, "dataInputs"), outputs = list(statement, "outputs");
    parts.push(count(inputs.length));
    let signedBytes = 0;
    for (const input of inputs) {
      const proof = field(input, "spendingProof"), proofBytes = bytes(field(proof, "proofBytes")), extension = field(proof, "extension");
      // The node writes at most 127 entries, each keyed by a nonnegative byte (ContextExtension's serializer).
      if (!(extension instanceof Map) || extension.size > 127) refuse();
      parts.push(bytes(field(input, "boxId"), 32), Buffer.of(0), Buffer.of(extension.size));
      for (const [key, constant] of extension) {
        if (!/^(?:0|[1-9][0-9]{0,2})$/.test(key) || Number(key) > 127) refuse();
        parts.push(Buffer.of(Number(key)), bytes(constant));
      }
      proofs.push(proofBytes);
      signedBytes += count(proofBytes.length).length + proofBytes.length - 1;
    }
    parts.push(count(dataInputs.length));
    for (const dataInput of dataInputs) parts.push(bytes(field(dataInput, "boxId"), 32));
    // Distinct token ids in order of first appearance, each with its index: one map lookup per asset, so the copy
    // stays linear in the statement however many tokens it names.
    const tokenIndex = new Map();
    for (const output of outputs) for (const asset of list(output, "assets")) {
      const tokenId = bytes(field(asset, "tokenId"), 32).toString("hex");
      if (!tokenIndex.has(tokenId)) tokenIndex.set(tokenId, tokenIndex.size);
    }
    parts.push(count(tokenIndex.size));
    for (const tokenId of tokenIndex.keys()) parts.push(Buffer.from(tokenId, "hex"));
    parts.push(count(outputs.length));
    for (const output of outputs) {
      parts.push(vlq(integer(field(output, "value"), MAX_U64)), bytes(field(output, "ergoTree")), vlq(integer(field(output, "creationHeight"), MAX_U32)));
      const assets = list(output, "assets"), registers = field(output, "additionalRegisters");
      if (assets.length > 255 || !(registers instanceof Map) || registers.size > 6) refuse();
      parts.push(Buffer.of(assets.length));
      for (const asset of assets) parts.push(count(tokenIndex.get(field(asset, "tokenId"))), vlq(integer(field(asset, "amount"), MAX_U64)));
      // Registers are written by name, R4 onward, whatever order the text lists them in; they must be contiguous.
      parts.push(Buffer.of(registers.size));
      for (let register = 4; register < 4 + registers.size; register++) parts.push(bytes(field(registers, `R${register}`)));
    }
    const unsigned = new Uint8Array(Buffer.concat(parts));
    return { unsigned, proofs, signedBytes: unsigned.length + signedBytes };
  } catch (error) {
    if (error instanceof Unsupplied) return undefined;
    throw error;
  }
}

/** `{ id, unsigned, witnessId, signedBytes }` for one transaction as the node states it, or undefined where the
 * statement is not of the node's shape or its copy (`copyTransaction`) does not hash to the id it states. */
export function supplyTransaction(statement) {
  const copy = copyTransaction(statement);
  if (copy === undefined) return undefined;
  const stated = statement.get("id"), id = blake2b(copy.unsigned, { dkLen: 32 });
  if (typeof stated !== "string" || stated !== Buffer.from(id).toString("hex")) return undefined;
  return { id, unsigned: copy.unsigned, witnessId: blake2b(Buffer.concat(copy.proofs), { dkLen: 32 }).subarray(1), signedBytes: copy.signedBytes };
}

/** A block's transactions as the node serves them (`/blocks/{id}/transactions`): the header id, each transaction's
 * statement, and what is supplied for it (undefined where unsupplied). Text that is not the node's JSON of a block's
 * transactions throws a SyntaxError for the whole block; a supplier serving many blocks catches it per block. */
export function supplyBlock(text) {
  const block = parseNodeJson(text);
  if (!(block instanceof Map) || typeof block.get("headerId") !== "string" || !Array.isArray(block.get("transactions"))) {
    throw new SyntaxError("node JSON: not a block's transactions");
  }
  const statements = block.get("transactions");
  return { headerId: block.get("headerId"), statements, supplied: statements.map(supplyTransaction) };
}

/** The adapter's form of one supplied transaction: the witness id, then the unsigned bytes. */
export const packed = ({ unsigned, witnessId }) => new Uint8Array(Buffer.concat([witnessId, unsigned]));
