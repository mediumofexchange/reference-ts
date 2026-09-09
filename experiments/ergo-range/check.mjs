// Offline source-feasibility probe, deliberately not an exported verifier.
// Only hash-pinned local fixtures reach Fleet. Neither JSON serialization nor
// this SDK's deserializer is an untrusted transaction-validation boundary.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2b";
import { deserializeTransaction, serializeTransaction, SigmaByteReader,
  SigmaByteWriter } from "@fleet-sdk/serializer";

const base = new URL("./", import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(readFileSync(new URL("fixtures/manifest.json", base)));
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const bytes = (value) => {
  assert.match(value, /^(?:[0-9a-f]{2})*$/);
  return Buffer.from(value, "hex");
};
const hash = (...parts) => blake2b(Buffer.concat(parts), { dkLen: 32 });
let checks = 0;
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};
const differs = (actual, expected, message) => {
  assert.notDeepEqual(actual, expected, message);
  checks++;
};

// Node 24's source text avoids rounding the emission box's >2^53 amounts.
const parseFixture = (raw) => JSON.parse(raw, (_key, value, context) => {
  if (typeof value !== "number") return value;
  assert.match(context.source, /^-?\d+$/);
  return BigInt(context.source);
});
const sdkIndex = (value) => {
  assert(value >= 0n && value <= 0x7fffffffn);
  return Number(value);
};
const normalize = (tx) => ({
  ...tx,
  outputs: tx.outputs.map((output) => ({ ...output,
    creationHeight: sdkIndex(output.creationHeight), index: sdkIndex(output.index) })),
});
const unsignedBytes = (tx) => serializeTransaction({ ...tx,
  inputs: tx.inputs.map((input) => ({ boxId: input.boxId,
    extension: input.spendingProof.extension })) }).toBytes();
const transactionId = (tx) => hash(unsignedBytes(tx));
const witnessId = (tx) => hash(...tx.inputs.map((input) =>
  bytes(input.spendingProof.proofBytes))).subarray(1);

// scrypto 3.1.1: prefixes 0/1; an absent right sibling is ZERO BYTES.
// Even one leaf gets an internal parent. Do not duplicate an odd last leaf.
const merkleRoot = (leaves) => {
  assert(leaves.length > 0, "a block transaction section must be nonempty");
  let level = leaves.map((leaf) => hash(Buffer.from([0]), leaf));
  do {
    const next = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(hash(Buffer.from([1]), level[i], level[i + 1] ?? Buffer.alloc(0)));
    level = next;
  } while (level.length > 1);
  return hex(level[0]);
};
// Ergo 6.1.5 uses all transaction IDs, followed by all 31-byte witness IDs.
// Version 1 does not commit to the witnesses. Only fixture versions are probed.
const root = (version, ids, witnesses) =>
  merkleRoot(version === 1n ? ids : [...ids, ...witnesses]);

equal(parseFixture('{"amount":9007199254740993}').amount, 9007199254740993n,
  "lossless numeric fixture ingestion");
assert.throws(() => merkleRoot([])); checks++;
// Independent simple expressions exercise the easily missed one/odd-leaf rules.
const a = bytes("ab"), b = bytes("bc"), c = bytes("cd");
const leaf = (x) => hash(Buffer.from([0]), x);
const parent = (...x) => hash(Buffer.from([1]), ...x);
equal(merkleRoot([a]), hex(parent(leaf(a))), "one leaf has a parent");
equal(merkleRoot([a, b, c]), hex(parent(parent(leaf(a), leaf(b)), parent(leaf(c)))),
  "three leaves use an absent zero-byte sibling");

const blocks = [];
let aliasDemonstrated = false;
for (const fixture of manifest.fixtures) {
  const raw = readFileSync(new URL(fixture.file, base));
  equal(sha256(raw), fixture.sha256, "fixture pin checked before parsing");
  const block = parseFixture(raw.toString("utf8"));
  const { header } = block;
  equal(header.id, fixture.headerId, "fixture header identity");
  equal(header.height.toString(), fixture.height, "fixture height");
  equal(header.version.toString(), fixture.version, "fixture version");
  equal(block.blockTransactions.headerId, header.id, "section header reference");
  const transactions = block.blockTransactions.transactions.map(normalize);
  equal(transactions.length.toString(), fixture.transactions, "fixture transaction count");
  const ids = transactions.map(transactionId);
  const witnesses = transactions.map(witnessId);
  for (let i = 0; i < transactions.length; i++)
    equal(hex(ids[i]), transactions[i].id, "computed transaction ID equals node fixture");
  equal(root(header.version, ids, witnesses), header.transactionsRoot, "complete block root");

  let signedBytes = 0n, outputs = 0n, decoded = 0n;
  const unsupported = [];
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    const signed = serializeTransaction(tx).toBytes();
    signedBytes += BigInt(signed.length);
    outputs += BigInt(tx.outputs.length);
    let decodedTx;
    try { decodedTx = deserializeTransaction(signed); }
    catch (error) {
      equal(error.message, "ErgoTree parsing without the size flag is not supported.",
        "only the observed unsupported-tree failure is expected");
      unsupported.push({ position: String(i), reason: error.message });
    }
    if (decodedTx) {
      equal(hex(serializeTransaction(decodedTx).toBytes()), hex(signed), "SDK round trip");
      equal(decodedTx.id, tx.id, "SDK decoded transaction identity");
      equal(decodedTx.outputs.map((o) => o.boxId), tx.outputs.map((o) => o.boxId),
        "SDK decoded output IDs equal node fixture");
      decoded++;
    }
    // Test every omission, duplicate and output mutation against the SAME root.
    if (transactions.length > 1) {
      differs(root(header.version, ids.filter((_x, n) => n !== i),
        witnesses.filter((_x, n) => n !== i)), header.transactionsRoot, "transaction omission");
    }
    differs(root(header.version, [...ids.slice(0, i), ids[i], ...ids.slice(i)],
      [...witnesses.slice(0, i), witnesses[i], ...witnesses.slice(i)]),
      header.transactionsRoot, "transaction duplication");
    for (let j = 0; j < tx.outputs.length; j++) {
      const changed = structuredClone(tx);
      changed.outputs[j].value += 1n;
      const changedIds = ids.slice(); changedIds[i] = transactionId(changed);
      differs(root(header.version, changedIds, witnesses), header.transactionsRoot,
        "mutated output value at every output position");
    }
    const changedProof = structuredClone(tx);
    changedProof.inputs[0].spendingProof.proofBytes += "01";
    equal(hex(transactionId(changedProof)), hex(ids[i]), "proof excluded from transaction ID");
    const proofWitnesses = witnesses.slice(); proofWitnesses[i] = witnessId(changedProof);
    differs(hex(proofWitnesses[i]), hex(witnesses[i]), "proof included in witness ID");
    (header.version === 1n ? equal : differs)(root(header.version, ids, proofWitnesses),
      header.transactionsRoot, "mutated proof's version-specific root effect");
    const changedWitnesses = witnesses.map((w) => Uint8Array.from(w));
    changedWitnesses[i][0] ^= 1;
    (header.version === 1n ? equal : differs)(root(header.version, ids, changedWitnesses),
      header.transactionsRoot, "version-specific witness commitment");
    if (i + 1 < transactions.length) {
      const reorderedIds = ids.slice(), reorderedWitnesses = witnesses.slice();
      [reorderedIds[i], reorderedIds[i + 1]] = [reorderedIds[i + 1], reorderedIds[i]];
      [reorderedWitnesses[i], reorderedWitnesses[i + 1]] =
        [reorderedWitnesses[i + 1], reorderedWitnesses[i]];
      differs(root(header.version, reorderedIds, reorderedWitnesses),
        header.transactionsRoot, "adjacent transaction order");
    }
    if (!aliasDemonstrated && tx.outputs[0].creationHeight >= 128) {
      // A server can move one height byte into a claimed raw ErgoTree field.
      // Blind serialization preserves the ID but the claimed fields disagree.
      const alias = structuredClone(tx);
      const heightBytes = new SigmaByteWriter(8).writeUInt(alias.outputs[0].creationHeight).toBytes();
      alias.outputs[0].ergoTree += hex(heightBytes.subarray(0, 1));
      alias.outputs[0].creationHeight = Math.floor(alias.outputs[0].creationHeight / 128);
      equal(hex(unsignedBytes(alias)), hex(unsignedBytes(tx)), "JSON field-boundary alias");
      differs(alias.outputs[0].ergoTree, tx.outputs[0].ergoTree, "aliased claimed script differs");
      differs(alias.outputs[0].creationHeight, tx.outputs[0].creationHeight, "aliased height differs");
      aliasDemonstrated = true;
    }
  }
  equal(unsupported.map((entry) => entry.position), fixture.sdkUnsupportedPositions,
    "SDK coverage is pinned; unexpected failures cannot count as success");
  if (header.version !== 1n) {
    differs(merkleRoot(ids), header.transactionsRoot, "IDs alone omit witnesses");
    differs(merkleRoot(ids.map((id, i) => Buffer.concat([id, witnesses[i]]))),
      header.transactionsRoot, "paired leaves are not the node algorithm");
    const fullWitnesses = transactions.map((tx) => hash(...tx.inputs.map((input) =>
      bytes(input.spendingProof.proofBytes))));
    differs(merkleRoot([...ids, ...fullWitnesses]), header.transactionsRoot, "witness is 31 bytes");
    if (ids.length > 1)
      differs(merkleRoot(ids.flatMap((id, i) => [id, witnesses[i]])),
        header.transactionsRoot, "leaves are not interleaved");
  }
  blocks.push({ height: fixture.height, version: fixture.version, headerId: header.id,
    transactions: fixture.transactions, outputs: String(outputs), jsonBytes: String(raw.length),
    serializedTransactionBytes: String(signedBytes), transactionsRoot: header.transactionsRoot,
    sdkDecodedTransactions: String(decoded), sdkUnsupportedTransactions: unsupported });
}
equal(aliasDemonstrated, true, "retain a concrete field-boundary counterexample");
// Small, finite controls only: no unbounded allocations or hangs are exercised.
const truncated = new SigmaByteReader(Uint8Array.of(1));
equal(truncated.readBytes(2).length, 1, "SDK silently returns a short byte slice");
equal(truncated.cursor, 2, "SDK cursor can pass the buffer end");
equal(new SigmaByteReader(new Uint8Array()).readUInt(), 0, "SDK empty UInt reads as zero");

console.log(JSON.stringify({ status: "offline-feasibility-only", node: process.version, checks,
  sources: manifest.sources, inputManifestSha256: sha256(readFileSync(new URL("fixtures/manifest.json", base))),
  files: Object.fromEntries(["check.mjs", "package.json", "package-lock.json"].map((file) =>
    [file, sha256(readFileSync(new URL(file, base)))])),
  blocks, jsonFieldBoundaryAlias: "same unsigned bytes and ID, different claimed script and height",
  limitations: ["Headers were acquired as fixtures, not independently authenticated.",
    "No consensus, finality, range continuity, venue filtering, record admission or opening verification.",
    "Fleet is used only on pinned fixtures; JSON serialization does not authenticate claimed fields.",
    "The decoder is incomplete and lacks a safe resource boundary for hostile bytes.",
    "Version 1 transaction roots do not authenticate witnesses."] }, null, 2));
