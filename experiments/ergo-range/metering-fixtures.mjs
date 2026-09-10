// Trusted, fixed fixture preparation only. This never invokes the WASM decoder.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { serializeTransaction } from "@fleet-sdk/serializer";

const base = new URL("./", import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifestBytes = readFileSync(new URL("fixtures/manifest.json", base));
assert.equal(hash(manifestBytes), "00976f84cf1e311d5f10ec6edeb58290aadb43a83856529b453da1c56907620e");
const transactions = [];
for (const fixture of JSON.parse(manifestBytes).fixtures) {
  const path = new URL(fixture.file, base);
  assert(statSync(path).size <= 262144);
  const raw = readFileSync(path);
  assert.equal(hash(raw), fixture.sha256);
  const block = JSON.parse(raw.toString("utf8"), (_key, value, context) => {
    if (typeof value !== "number") return value;
    assert.match(context.source, /^-?\d+$/);
    return BigInt(context.source);
  });
  const index = (n) => { assert(n >= 0n && n <= 0x7fffffffn); return Number(n); };
  for (const original of block.blockTransactions.transactions) {
    const tx = { ...original, outputs: original.outputs.map((o) => ({ ...o,
      creationHeight: index(o.creationHeight), index: index(o.index) })) };
    const bytes = serializeTransaction(tx).toBytes();
    assert(bytes.length > 0 && bytes.length <= 65536);
    transactions.push({ bytes: Buffer.from(bytes).toString("hex"), expected: tx });
  }
}
assert.equal(transactions.length, 24);
process.stdout.write(JSON.stringify({ transactions }, (_key, v) => typeof v === "bigint" ? v.toString() : v));
