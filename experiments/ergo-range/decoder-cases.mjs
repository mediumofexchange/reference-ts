// Finite offline experiment only. Never accepts network bytes or file arguments.
// Fleet constructs bytes only from hash-pinned fixtures. Output fields come
// solely from sigma-rust's binary parser, after an exact canonical round trip.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { serializeTransaction, SigmaByteWriter } from "@fleet-sdk/serializer";
import { Transaction } from "ergo-lib-wasm-nodejs";

const base = new URL("./", import.meta.url);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const hex = (b) => Buffer.from(b).toString("hex");
const manifestBytes = readFileSync(new URL("fixtures/manifest.json", base));
const manifest = JSON.parse(manifestBytes);
const maxTransactionBytes = 64 * 1024;
let checks = 0;
const equal = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const rejects = (f, message) => { assert.throws(f, undefined, message); checks++; };
const parseLossless = (raw) => JSON.parse(raw, (_key, value, context) => {
  if (typeof value !== "number") return value;
  assert.match(context.source, /^-?\d+$/);
  return BigInt(context.source);
});
const sdkIndex = (n) => {
  assert(n >= 0n && n <= 0x7fffffffn);
  return Number(n);
};
const normalize = (tx) => ({ ...tx, outputs: tx.outputs.map((o) => ({ ...o,
  creationHeight: sdkIndex(o.creationHeight), index: sdkIndex(o.index) })) });
const signedBytes = (tx) => serializeTransaction(tx).toBytes();
// This is a necessary canonicality check, not proof of node-equivalent parsing.
// No claimed JSON fields are returned, and failed parsing yields no outputs.
const decode = (bytes) => {
  assert(bytes instanceof Uint8Array && bytes.length > 0 &&
    bytes.length <= maxTransactionBytes, "experimental transaction byte budget");
  const tx = Transaction.sigma_parse_bytes(bytes);
  try {
    assert.equal(hex(tx.sigma_serialize_bytes()), hex(bytes), "noncanonical transaction bytes");
    return tx.to_js_eip12();
  } finally { tx.free(); }
};
const fields = (o) => ({ boxId: o.boxId, value: BigInt(o.value), ergoTree: o.ergoTree,
  assets: o.assets.map((a) => ({ tokenId: a.tokenId, amount: BigInt(a.amount) })),
  additionalRegisters: o.additionalRegisters, creationHeight: BigInt(o.creationHeight),
  transactionId: o.transactionId, index: BigInt(o.index) });

const blocks = [];
let prefixes = 0, aliases = 0, trailingAccepted = 0, overlongAccepted = 0;
let largestTransactionBytes = 0;
rejects(() => decode(new Uint8Array()), "empty input");
rejects(() => decode(new Uint8Array(maxTransactionBytes + 1)), "oversized input before WASM");
// Finite malformed count headers; no unbounded fuzzing in this experiment.
for (const b of ["ff", "ffff03", "ffffffffffffffffff02", "00", "0100"])
  rejects(() => decode(Buffer.from(b, "hex")), "malformed/truncated count or input");

for (const fixture of manifest.fixtures) {
  const path = new URL(fixture.file, base);
  assert(statSync(path).size <= 256 * 1024, "experimental fixture byte budget");
  const raw = readFileSync(path);
  equal(sha256(raw), fixture.sha256, "pin before fixture JSON parsing or serialization");
  const block = parseLossless(raw.toString("utf8"));
  const transactions = block.blockTransactions.transactions.map(normalize);
  equal(String(transactions.length), fixture.transactions, "fixture transaction count");
  let outputs = 0;
  for (const tx of transactions) {
    const bytes = signedBytes(tx);
    largestTransactionBytes = Math.max(largestTransactionBytes, bytes.length);
    const decoded = decode(bytes);
    equal(decoded.id, tx.id, "binary-derived transaction identity");
    equal(decoded.inputs, tx.inputs, "input IDs, proof bytes and extensions");
    equal(decoded.dataInputs, tx.dataInputs, "data input order and identity");
    equal(decoded.outputs.map(fields), tx.outputs.map(fields), "every output field and ID");
    outputs += decoded.outputs.length;

    // All proper prefixes, not just EOF at the last field. An accepted prefix
    // cannot silently become a shorter transaction under the strict wrapper.
    for (let end = 0; end < bytes.length; end++) {
      rejects(() => decode(bytes.subarray(0, end)), "proper prefix cannot yield outputs");
      prefixes++;
    }
    const trailing = Buffer.concat([bytes, Buffer.from([0])]);
    const permissive = Transaction.sigma_parse_bytes(trailing);
    try {
      equal(hex(permissive.sigma_serialize_bytes()), hex(bytes), "raw parser ignores trailing byte");
      trailingAccepted++;
    } finally { permissive.free(); }
    rejects(() => decode(trailing), "strict wrapper rejects trailing byte");

    // Every fixture starts with a one-byte input count. Encode that same count
    // with an extra zero group, preserving all subsequent bytes.
    assert(bytes[0] < 128);
    const overlong = Buffer.concat([Buffer.from([bytes[0] | 128, 0]), bytes.subarray(1)]);
    const nonminimal = Transaction.sigma_parse_bytes(overlong);
    try {
      equal(hex(nonminimal.sigma_serialize_bytes()), hex(bytes), "raw parser accepts overlong input count");
      overlongAccepted++;
    } finally { nonminimal.free(); }
    rejects(() => decode(overlong), "strict wrapper rejects nonminimal count");

    for (let i = 0; i < tx.outputs.length; i++) {
      const alias = structuredClone(tx);
      const o = alias.outputs[i];
      const height = new SigmaByteWriter(8).writeUInt(o.creationHeight).toBytes();
      assert(height.length > 1);
      o.ergoTree += hex(height.subarray(0, 1));
      o.creationHeight = Math.floor(o.creationHeight / 128);
      const aliasedBytes = signedBytes(alias);
      equal(hex(aliasedBytes), hex(bytes), "different claimed script/height, identical signed bytes");
      equal(decode(aliasedBytes).outputs.map(fields), decoded.outputs.map(fields),
        "binary extraction recovers committed fields from every alias");
      assert.notDeepEqual(fields(o), fields(decoded.outputs[i])); checks++;
      aliases++;
    }
    const forged = structuredClone(tx);
    forged.id = "00".repeat(32);
    for (const o of forged.outputs) { o.boxId = "00".repeat(32); o.transactionId = forged.id; }
    equal(decode(signedBytes(forged)), decoded, "claimed IDs are ignored and recomputed from bytes");
  }
  blocks.push({ height: fixture.height, transactions: String(transactions.length), outputs: String(outputs) });
}
console.log(JSON.stringify({ status: "offline-decoder-feasibility-only", node: process.version, checks,
  decoder: { package: "ergo-lib-wasm-nodejs", version: "0.28.0",
    source: "https://github.com/ergoplatform/sigma-rust/tree/635bbaca55a27d6dd6b2c0ee2479b6ed60117780",
    provenance: "npm gitHead metadata; package integrity pinned, build not independently reproduced",
    wasmSha256: sha256(readFileSync(new URL("node_modules/ergo-lib-wasm-nodejs/ergo_lib_wasm_bg.wasm", base))) },
  inputManifestSha256: sha256(manifestBytes),
  files: Object.fromEntries(["decoder-check.mjs", "decoder-cases.mjs", "package.json", "package-lock.json"]
    .map((file) => [file, sha256(readFileSync(new URL(file, base)))])),
  blocks, properPrefixesRejected: prefixes, fieldBoundaryAliasesRecovered: aliases,
  rawParserTrailingBytesAccepted: trailingAccepted, rawParserOverlongCountsAccepted: overlongAccepted,
  strictWrapperRejectedBothForEveryTransaction: true,
  budgets: { fixtureBytes: 262144, transactionBytes: maxTransactionBytes, largestTransactionBytes,
    corpusTimeoutMs: 30000, childOutputBytes: 1048576, hardProcessMemoryLimit: null },
  limitations: ["Finite fixtures and mutations do not prove full node equivalence or parser safety.",
    "No hard process/WASM memory limit; input size and a process deadline alone do not bound allocation.",
    "No hostile depth/allocation exhaustion test or supported production resource policy.",
    "Canonical round trips reject observed aliases but may refuse node-valid noncanonical encodings.",
    "Headers, consensus, finality and contiguous-range completeness remain unauthenticated.",
    "Raw outputs acquire no held-commitment status or publication force.",
    "No runtime API, production decoder selection or current-node version compatibility claim."] }, null, 2));
