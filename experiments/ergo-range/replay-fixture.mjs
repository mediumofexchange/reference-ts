// TEST ONLY. Synthetic headers are not authenticated chain evidence, and
// these transactions do not claim node acceptance. No source-neutral package
// chooses this profile. Its fixed genesis precedes all protocol records.
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b";
import { serializeTransaction } from "@fleet-sdk/serializer";
import { Address } from "ergo-lib-wasm-nodejs";

const hex = bytes => Buffer.from(bytes).toString("hex");
const sha256 = bytes => createHash("sha256").update(bytes).digest();
const p2pk = n => {
  const address = Address.from_public_key(secp256k1.getPublicKey(new Uint8Array(32).fill(n), true));
  const tree = address.to_ergo_tree();
  try { return tree.sigma_serialize_bytes(); } finally { tree.free(); address.free(); }
};
const scripts = Object.fromEntries([1, 2, 3, 4].map(n => [n, p2pk(n)])), plainTree = p2pk(5);
const box = (tree, registers = {}) => ({ value: 1_000_000n, ergoTree: hex(tree), creationHeight: 1, assets: [], additionalRegisters: registers });
const tx = (height, ordinal, outputs) => ({
  inputs: [{ boxId: hex(sha256(`moe/test/ergo-replay/input/${height}/${ordinal}`)), spendingProof: { proofBytes: "", extension: {} } }],
  dataInputs: [], outputs,
});
// Independent Fleet unsigned-byte ids and witness/root oracle, from the
// profile probe; never ask the model/decoder what a header should commit to.
const fleetId = transaction => blake2b(serializeTransaction({ ...transaction,
  inputs: transaction.inputs.map(input => ({ boxId: input.boxId, extension: input.spendingProof.extension })) }).toBytes(), { dkLen: 32 });
const fleetWitness = transaction => blake2b(Buffer.concat(transaction.inputs.map(input => Buffer.from(input.spendingProof.proofBytes, "hex"))), { dkLen: 32 }).subarray(1);
const root = transactions => {
  let level = [...transactions.map(fleetId), ...transactions.map(fleetWitness)]
    .map(leaf => blake2b(Buffer.concat([Buffer.from([0]), leaf]), { dkLen: 32 }));
  do {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(blake2b(Buffer.concat([Buffer.from([1]), level[i], level[i + 1] ?? Buffer.alloc(0)]), { dkLen: 32 }));
    level = next;
  } while (level.length > 1);
  return level[0];
};
const header = (height, parentId, transactions) => {
  const transactionsRoot = root(transactions), heightBytes = Buffer.alloc(8);
  heightBytes.writeBigUInt64BE(height);
  return { id: sha256(Buffer.concat([Buffer.from("moe/test/ergo-replay/header/v1"), heightBytes, parentId, transactionsRoot])),
    parentId: new Uint8Array(parentId), height, version: 3n, transactionsRoot };
};
const genesisTx = tx(1n, 0n, [box(plainTree)]);
const genesis = header(1n, new Uint8Array(32), [genesisTx]);
export const profile = Object.freeze({ genesis: new Uint8Array(genesis.id), depth: 0n,
  scripts: Object.freeze(Object.fromEntries(Object.entries(scripts).map(([kind, script]) => [kind, new Uint8Array(script)]))) });
const coll = bytes => {
  let n = bytes.length;
  const length = [];
  do { let byte = n & 0x7f; n = Math.floor(n / 128); if (n > 0) byte |= 0x80; length.push(byte); } while (n > 0);
  return "0e" + hex(Uint8Array.from(length)) + hex(bytes);
};
const recordOutputs = ({ kind, subject, record }) => {
  if (![1, 2, 3, 4].includes(kind) || !(subject instanceof Uint8Array) || subject.length !== 32 || !(record instanceof Uint8Array)) throw new TypeError("invalid fixture record");
  const output = bytes => box(scripts[kind], { R4: coll(subject), R5: coll(bytes) });
  if (kind !== 4 || record.length === 0) return [output(record)];
  const outputs = [];
  for (let offset = 0; offset < record.length; offset += 3981) outputs.push(output(record.subarray(offset, offset + 3981)));
  return outputs;
};

/** Convert a TEST FixtureVenue export. Its records must start at index 1:
 * every record moves by +1, leaving a fixed, record-independent genesis.
 * The resulting tip/witnessed index is fixture.witnessedIndex + 1, lag 1.
 * Each record gets a separate transaction, preserving within-height order
 * and preventing adjacent publication runs from merging. */
export function fixtureEvidence(fixture) {
  const { witnessedIndex, records } = fixture;
  if (typeof witnessedIndex !== "bigint" || witnessedIndex < 0n || witnessedIndex >= 256n || !Array.isArray(records) || records.length > 1024) throw new TypeError("fixture exceeds local Ergo evidence scope");
  const at = new Map();
  for (const record of records) {
    if (typeof record.index !== "bigint" || record.index < 1n || record.index > witnessedIndex) throw new TypeError("fixture record must follow the fixed genesis");
    const height = record.index + 1n, transactions = at.get(height) ?? [];
    transactions.push(tx(height, BigInt(transactions.length), recordOutputs(record)));
    at.set(height, transactions);
  }
  const headers = [], blocks = [];
  let parentId = new Uint8Array(32);
  for (let height = 1n; height <= witnessedIndex + 1n; height++) {
    const transactions = height === 1n ? [genesisTx] : at.get(height) ?? [tx(height, 0n, [box(plainTree)])];
    const current = header(height, parentId, transactions);
    headers.push(current);
    blocks.push({ headerId: new Uint8Array(current.id), transactions: transactions.map(transaction => serializeTransaction(transaction).toBytes()) });
    parentId = current.id;
  }
  return { headers, blocks };
}
