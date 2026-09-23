// Finite offline experiment only. Never accepts network bytes or file arguments.
// Fleet constructs bytes only from hash-pinned fixtures. Output fields come
// solely from sigma-rust's binary parser, after an exact canonical round trip.
// Every case runs through this file's reference wrapper and through the
// decodeTransaction boundary that the profile probe and local replay use.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2b";
import { serializeTransaction, SigmaByteWriter } from "@fleet-sdk/serializer";
import { Transaction } from "ergo-lib-wasm-nodejs";
import { decodeTransaction } from "./decoder.mjs";

const base = new URL("./", import.meta.url);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const hex = (b) => Buffer.from(b).toString("hex");
const manifestBytes = readFileSync(new URL("fixtures/manifest.json", base));
const manifest = JSON.parse(manifestBytes);
const maxTransactionBytes = 64 * 1024;
let checks = 0;
const equal = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
// A rejection is an ordinary error: an overflow or trap would leave the instance unusable and must fail the case.
const rejects = (f, message) => {
  assert.throws(f, error => !(error instanceof RangeError || error instanceof WebAssembly.RuntimeError), message); checks++;
};
// decoder.mjs refuses with undefined; an overflow or trap would throw and fail the corpus.
let boundaryRefusals = 0;
const refuses = (bytes, message) => { equal(decodeTransaction(bytes), undefined, `decoder.mjs: ${message}`); boundaryRefusals++; };
// The boundary's fields against the node's own JSON: the binary-derived id, the witness id over the
// inputs' proof bytes (blake2b256, first byte dropped), and each output's tree and registers.
const boundaryFields = decoded => ({ id: hex(decoded.id), witnessId: hex(decoded.witnessId),
  outputs: decoded.outputs.map(o => ({ ergoTree: hex(o.ergoTree),
    registers: Object.fromEntries(Object.entries(o.registers).map(([name, value]) => [name, hex(value)])) })) });
const nodeFields = tx => ({ id: tx.id,
  witnessId: hex(blake2b(Buffer.concat(tx.inputs.map(i => Buffer.from(i.spendingProof.proofBytes, "hex"))), { dkLen: 32 }).subarray(1)),
  outputs: tx.outputs.map(o => ({ ergoTree: o.ergoTree, registers: o.additionalRegisters })) });
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
// The fields a tree rewrite leaves untouched: ids embed the transaction's bytes, so they move.
const committed = (o) => { const { boxId: _b, transactionId: _t, ...rest } = fields(o); return rest; };
const vlqLength = (bytes, at) => { let n = 1; while (bytes[at + n - 1] & 0x80) n++; return n; };
// The vendored release build of sigma-rust 2f840d3 (vendor/ergo-lib-wasm-nodejs, reproduced by sigma-release-build.sh).
const pinnedVersion = "0.28.0-2f840d3.release";
const pinnedWasmSha256 = "0d20038513c72a9daf859e3ea278735caef43305cde6bc7fb2764e8d933aa28a";
equal(JSON.parse(readFileSync(new URL("node_modules/ergo-lib-wasm-nodejs/package.json", base))).version,
  pinnedVersion, "the corpus runs on the experiment's pinned build");
const wasmSha256 = sha256(readFileSync(new URL("node_modules/ergo-lib-wasm-nodejs/ergo_lib_wasm_bg.wasm", base)));
equal(wasmSha256, pinnedWasmSha256, "the installed WASM is the pinned artifact");
// Every installed file of the package, the JS glue included, against the vendored SHA256SUMS, itself pinned here.
const sums = readFileSync(new URL("vendor/ergo-lib-wasm-nodejs/SHA256SUMS", base));
equal(sha256(sums), "8404d891c6f2ee14f8671c89f8f96682d8d4193b262631251963247db9b88272", "the vendored SHA256SUMS is the pinned list");
for (const line of sums.toString().trim().split("\n")) {
  const [digest, name] = line.split(/\s+/);
  equal(sha256(readFileSync(new URL(`node_modules/ergo-lib-wasm-nodejs/${name}`, base))), digest, `the installed ${name} is the vendored file`);
}

const blocks = [];
let prefixes = 0, aliases = 0, trailingAccepted = 0, overlongAccepted = 0;
let largestTransactionBytes = 0, sizedTrees = 0, ambiguousTrees = 0, versionRewrites = 0, unparsedBodies = 0;
const treeVersionsRead = {};
rejects(() => decode(new Uint8Array()), "empty input");
refuses(new Uint8Array(), "empty input");
rejects(() => decode(new Uint8Array(maxTransactionBytes + 1)), "oversized input before WASM");
// Finite malformed count headers; no unbounded fuzzing in this experiment.
for (const b of ["ff", "ffff03", "ffffffffffffffffff02", "00", "0100"]) {
  rejects(() => decode(Buffer.from(b, "hex")), "malformed/truncated count or input");
  refuses(Buffer.from(b, "hex"), "malformed/truncated count or input");
}

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
    const boundary = decodeTransaction(bytes);
    assert.notEqual(boundary, undefined, "decoder.mjs decodes every fixture transaction");
    equal(boundaryFields(boundary), nodeFields(tx), "decoder.mjs: id, witness id, trees and registers");
    outputs += decoded.outputs.length;

    // All proper prefixes, not just EOF at the last field. An accepted prefix
    // cannot silently become a shorter transaction under the strict wrapper.
    for (let end = 0; end < bytes.length; end++) {
      rejects(() => decode(bytes.subarray(0, end)), "proper prefix cannot yield outputs");
      refuses(bytes.subarray(0, end), "proper prefix");
      prefixes++;
    }
    const trailing = Buffer.concat([bytes, Buffer.from([0])]);
    const permissive = Transaction.sigma_parse_bytes(trailing);
    try {
      equal(hex(permissive.sigma_serialize_bytes()), hex(bytes), "raw parser ignores trailing byte");
      trailingAccepted++;
    } finally { permissive.free(); }
    rejects(() => decode(trailing), "strict wrapper rejects trailing byte");
    refuses(trailing, "trailing byte");

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
    refuses(overlong, "nonminimal count");

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
    equal(boundaryFields(decodeTransaction(signedBytes(forged))), boundaryFields(boundary), "decoder.mjs: claimed IDs are ignored");

    // A sized tree is exact bytes whatever its header version or body: for every output whose
    // tree carries the size flag, rewrite the version bits to each of 0..7, with the real body and
    // with the body zeroed under the same size. The strict wrapper must read each as the exact
    // slice, every other committed field unchanged, and never refuse. A tree of version 1 or above
    // without the size flag is not node-valid (sigma's CheckHeaderSizeBit), so no case covers it.
    for (let i = 0; i < tx.outputs.length; i++) {
      const tree = Buffer.from(tx.outputs[i].ergoTree, "hex");
      const version = tree[0] & 7;
      treeVersionsRead[version] = (treeVersionsRead[version] ?? 0) + 1;
      if (!(tree[0] & 8)) continue;
      // Outputs to one address share a tree, so the slice is located as the n-th occurrence among
      // the outputs carrying it; a tree whose bytes also occur elsewhere is left alone as ambiguous.
      const sharing = tx.outputs.filter((o) => o.ergoTree === tx.outputs[i].ergoTree).length;
      const signed = Buffer.from(bytes), positions = [];
      for (let p = signed.indexOf(tree); p >= 0; p = signed.indexOf(tree, p + 1)) positions.push(p);
      if (positions.length !== sharing) { ambiguousTrees++; continue; }
      sizedTrees++;
      const at = positions[tx.outputs.slice(0, i).filter((o) => o.ergoTree === tx.outputs[i].ergoTree).length];
      const bodyAt = at + 1 + vlqLength(tree, 1), end = at + tree.length;
      const expectSlice = (mutated, label) => {
        const read = decode(mutated).outputs;
        equal(read[i].ergoTree, hex(mutated.subarray(at, end)), `${label}: the tree is the exact slice`);
        equal(hex(decodeTransaction(mutated).outputs[i].ergoTree), hex(mutated.subarray(at, end)), `decoder.mjs ${label}: the tree is the exact slice`);
        equal(read.map((o, j) => j === i ? { ...committed(o), ergoTree: null } : committed(o)),
          decoded.outputs.map((o, j) => j === i ? { ...committed(o), ergoTree: null } : committed(o)),
          `${label}: every other committed field is unchanged`);
      };
      for (let v = 0; v < 8; v++) {
        const rewritten = Buffer.from(bytes);
        rewritten[at] = (tree[0] & 0xf8) | v;
        expectSlice(rewritten, `sized tree rewritten to header version ${v}`);
        versionRewrites++;
        const zeroed = Buffer.from(rewritten);
        zeroed.fill(0, bodyAt, end);
        expectSlice(zeroed, `sized tree of header version ${v} with an unparseable body`);
        unparsedBodies++;
      }
    }
  }
  blocks.push({ height: fixture.height, version: fixture.version, transactions: String(transactions.length), outputs: String(outputs) });
}
// The corpus's sized-tree coverage is pinned, so a fixture or search regression cannot pass silently.
equal({ treeVersionsRead, sizedTrees, ambiguousTrees, versionRewrites, unparsedBodies },
  { treeVersionsRead: { 0: 72, 1: 3, 3: 2 }, sizedTrees: 5, ambiguousTrees: 0, versionRewrites: 40, unparsedBodies: 40 },
  "the corpus reads real Ergo 6.0 trees (header version 3) and every sized tree is located");
console.log(JSON.stringify({ status: "offline-decoder-feasibility-only", node: process.version, checks,
  decoder: { package: "ergo-lib-wasm-nodejs", version: pinnedVersion,
    source: "https://github.com/ergoplatform/sigma-rust/tree/2f840d3872367d6181d66d4a168194dbefad77f1",
    provenance: "vendored release build of that commit (vendor/ergo-lib-wasm-nodejs), reproduced from source by sigma-release-build.sh on a Windows host; every installed file checked against the pinned vendor SHA256SUMS",
    wasmSha256 },
  inputManifestSha256: sha256(manifestBytes),
  files: Object.fromEntries(["decoder-check.mjs", "decoder-cases.mjs", "decoder.mjs", "package.json", "package-lock.json"]
    .map((file) => [file, sha256(readFileSync(new URL(file, base)))])),
  blocks, properPrefixesRejected: prefixes, fieldBoundaryAliasesRecovered: aliases,
  rawParserTrailingBytesAccepted: trailingAccepted, rawParserOverlongCountsAccepted: overlongAccepted,
  strictWrapperRejectedBothForEveryTransaction: true,
  decoderMjsRefusals: boundaryRefusals, decoderMjsMatchedNodeFieldsForEveryTransaction: true,
  treeVersionsRead, sizedTrees, sizedTreesLeftAsAmbiguousSlices: ambiguousTrees,
  sizedTreeVersionRewritesReadAsExactSlices: versionRewrites,
  sizedTreeUnparseableBodiesReadAsExactSlices: unparsedBodies,
  budgets: { fixtureBytes: 262144, transactionBytes: maxTransactionBytes, largestTransactionBytes,
    corpusTimeoutMs: 120000, childOutputBytes: 1048576, hardProcessMemoryLimit: null },
  limitations: ["Finite fixtures and mutations do not prove full node equivalence or parser safety.",
    "No hard process/WASM memory limit; input size and a process deadline alone do not bound allocation.",
    "No hostile depth/allocation exhaustion test or supported production resource policy.",
    "Canonical round trips reject observed aliases but may refuse node-valid noncanonical encodings.",
    "A sized tree the library cannot parse is kept as its exact bytes; an unsized tree (header version 0 without the size flag) or a register constant the library cannot parse still refuses the whole transaction.",
    "Headers, consensus, finality and contiguous-range completeness remain unauthenticated.",
    "Raw outputs acquire no held-commitment status or publication force.",
    "No runtime API, production decoder selection or current-node version compatibility claim."] }, null, 2));
