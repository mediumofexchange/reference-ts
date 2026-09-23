// Trusted, fixed case preparation for metered-check.py. The WASM decoder
// runs here only in --week mode, as chain-cost.mjs does, to reserialize the
// cached node text of the P4 window into exact bytes; the probe meters them.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeTransaction } from "@fleet-sdk/serializer";
import { blake2b } from "@noble/hashes/blake2b";

const base = new URL("./", import.meta.url);
const hex = bytes => Buffer.from(bytes).toString("hex");

// The corpus transactions, from the hash-pinned fixtures, serialized as the corpus serializes them.
const manifestBytes = readFileSync(new URL("fixtures/manifest.json", base));
assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), "4ba3120b61dce7621c40e391faa70c46c6765b33a971815b35725da1e2c1d869");
const lossless = raw => JSON.parse(raw, (_k, v, ctx) => typeof v === "number" ? BigInt(ctx.source) : v);
const blocks = JSON.parse(manifestBytes).fixtures.map(fixture => {
  const raw = readFileSync(new URL(fixture.file, base));
  assert.equal(createHash("sha256").update(raw).digest("hex"), fixture.sha256);
  return { file: fixture.file, transactions: lossless(raw.toString("utf8")).blockTransactions.transactions };
});
const normalize = t => ({ ...t, outputs: t.outputs.map(o => ({ ...o, creationHeight: Number(o.creationHeight), index: Number(o.index) })) });
const fixtures = blocks.flatMap(b => b.transactions).map(t => ({ id: t.id, bytes: hex(serializeTransaction(normalize(t)).toBytes()) }));

// The node's JSON split is not bound by the transaction id: moving one byte
// from R5 to the end of R4 in a corpus transaction's node text reserializes
// to the same bytes, so the same id, while the register view differs.
let split;
for (const block of blocks) {
  for (const t of block.transactions) {
    const original = normalize(t);
    const at = original.outputs.findIndex(o => o.additionalRegisters.R4 && o.additionalRegisters.R5?.length > 2);
    if (at < 0) continue;
    const { R4, R5 } = original.outputs[at].additionalRegisters;
    const resliced = { ...original, outputs: original.outputs.map((o, i) => i !== at ? o :
      { ...o, additionalRegisters: { ...o.additionalRegisters, R4: R4 + R5.slice(0, 2), R5: R5.slice(2) } }) };
    const unsigned = t => serializeTransaction({ ...t, inputs: t.inputs.map(i => ({ ...i, spendingProof: { ...i.spendingProof, proofBytes: "" } })) }).toBytes();
    const [a, b] = [serializeTransaction(original).toBytes(), serializeTransaction(resliced).toBytes()];
    split = { fixture: block.file, transaction: original.id, output: at,
      node: { R4, R5 }, resliced: { R4: resliced.outputs[at].additionalRegisters.R4, R5: resliced.outputs[at].additionalRegisters.R5 },
      sameBytes: hex(a) === hex(b), sameId: hex(blake2b(unsigned(original), { dkLen: 32 })) === original.id &&
        hex(blake2b(unsigned(resliced), { dkLen: 32 })) === original.id };
    break;
  }
  if (split) break;
}
assert(split?.sameBytes && split.sameId, "the reslice changed the bytes");

// --week <out>: the P4 window's transactions from the cached node text, each
// framed by its height, position and length (little-endian) and its id.
let week;
const at = process.argv.indexOf("--week");
if (at >= 0) {
  const out = process.argv[at + 1];
  const report = JSON.parse(readFileSync(new URL("../../docs/ergo-decoder-pin-verification.json", base)));
  const { fromHeight, toHeight } = report.window;
  const { Transaction } = await import("ergo-lib-wasm-nodejs");
  const cache = fileURLToPath(new URL("../../scratch/ergo-chain/", base));
  const elementTexts = (text, key) => {
    const start = text.indexOf(`"${key}"`);
    let depth = 0, inString = false, from = -1;
    const found = [];
    for (let i = text.indexOf("[", start) + 1; i < text.length; i++) {
      const c = text[i];
      if (inString) { if (c === "\\") i++; else if (c === '"') inString = false; continue; }
      if (c === '"') inString = true;
      else if (c === "{") { if (depth === 0) from = i; depth++; }
      else if (c === "}") { depth--; if (depth === 0) found.push(text.slice(from, i + 1)); }
      else if (c === "]" && depth === 0) break;
    }
    return found;
  };
  const files = readdirSync(cache).filter(f => f.startsWith("tx-")).map(f => ({ f, h: Number(f.split("-")[1]) }))
    .filter(({ h }) => h >= fromHeight && h <= toHeight).sort((x, y) => x.h - y.h);
  assert.equal(files.length, toHeight - fromHeight + 1, "the cache covers the window");
  const chunks = [];
  let count = 0;
  for (const { f, h } of files) {
    elementTexts(readFileSync(join(cache, f), "utf8"), "transactions").forEach((text, position) => {
      const t = Transaction.from_json(text);
      const bytes = Buffer.from(t.sigma_serialize_bytes());
      const id = JSON.parse(text).id;
      assert.equal(t.id().to_str(), id);
      t.free();
      const head = Buffer.alloc(44);
      head.writeUInt32LE(h, 0); head.writeUInt32LE(position, 4); head.writeUInt32LE(bytes.length, 8);
      head.write(id, 12, "hex");
      chunks.push(head, bytes); count++;
    });
  }
  const frames = Buffer.concat(chunks);
  writeFileSync(out, frames);
  week = { fromHeight, toHeight, blocks: files.length, transactions: count, frameSha256: createHash("sha256").update(frames).digest("hex") };
}

process.stdout.write(JSON.stringify({ fixtures, split, week }));
