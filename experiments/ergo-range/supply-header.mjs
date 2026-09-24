// Supplier side of the reader's header store: one header's bytes, written by copying the node's JSON statement of it,
// as supply.mjs writes a transaction's. The reader never runs this: its header store (model/pool-v3-ergo-headers.ts)
// parses the bytes, derives the id and checks the work itself. A copy that does not hash to the id the node states is
// unsupplied (undefined), never misread.
import { blake2b } from "@noble/hashes/blake2b";

const HEX = /^(?:[0-9a-f]{2})*$/;
class Unsupplied extends Error {}
const refuse = () => { throw new Unsupplied(); };
const field = (map, key) => (map instanceof Map && map.has(key) ? map.get(key) : refuse());
const bytes = (value, width) => typeof value === "string" && HEX.test(value) && (width === undefined || value.length === 2 * width) ? Buffer.from(value, "hex") : refuse();
const integer = (value, max) => typeof value === "bigint" && value >= 0n && value <= max ? value : refuse();
const vlq = n => {
  const out = [];
  do { let byte = Number(n & 0x7fn); n >>= 7n; if (n > 0n) byte |= 0x80; out.push(byte); } while (n > 0n);
  return Buffer.from(out);
};

/** `{ id, bytes }` for one header as the node states it (a Map from supply.mjs's `parseNodeJson`, as
 * `/blocks/chainSlice` lists them), or undefined where the statement is not of the node's shape or its copy does not
 * hash to the id it states. The bytes are the node's serialization of a version 2–4 header (fixed-width roots, VLQ
 * timestamp and height, big-endian nBits, a zero new-fields length) followed by the Autolykos v2 solution's key and
 * nonce. Nodes before 6.0 omit `unparsedBytes`; where present it must be empty. */
export function supplyHeader(statement) {
  try {
    const version = integer(field(statement, "version"), 255n), solution = field(statement, "powSolutions");
    if (version < 2n || version > 4n || (statement.has("unparsedBytes") && bytes(statement.get("unparsedBytes")).length !== 0)) refuse();
    const nBits = Buffer.alloc(4);
    nBits.writeUInt32BE(Number(integer(field(statement, "nBits"), 0xffff_ffffn)));
    const header = new Uint8Array(Buffer.concat([Buffer.of(Number(version)), bytes(field(statement, "parentId"), 32),
      bytes(field(statement, "adProofsRoot"), 32), bytes(field(statement, "transactionsRoot"), 32), bytes(field(statement, "stateRoot"), 33),
      vlq(integer(field(statement, "timestamp"), (1n << 63n) - 1n)), bytes(field(statement, "extensionHash"), 32), nBits,
      vlq(integer(field(statement, "height"), (1n << 31n) - 1n)), bytes(field(statement, "votes"), 3), Buffer.of(0),
      bytes(field(solution, "pk"), 33), bytes(field(solution, "n"), 8)]));
    const id = blake2b(header, { dkLen: 32 });
    if (field(statement, "id") !== Buffer.from(id).toString("hex")) refuse();
    return { id, bytes: header };
  } catch (error) {
    if (error instanceof Unsupplied) return undefined;
    throw error;
  }
}
