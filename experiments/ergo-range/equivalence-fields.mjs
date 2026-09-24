// Decoder node equivalence, field by field: an offline post-pass over the chain-cost chunks of the own node's retained
// blocks. chain-cost.mjs checks that each block's bytes reproduce its header's transaction root and that the pinned
// decoder reads them; it never compares what the decoder reads with what the node states. For every transaction of a
// chunk this pass rebuilds the bytes from the node's exact text as chain-cost does, reads them through decoder.mjs, and
// compares the decoder's id, witness id, output count, and every output's ErgoTree bytes, register names and register
// constants with the node's JSON fields. It first recomputes the chunk's cache digest from the cached responses in the
// chunk's read order, so it reads exactly the responses the chunk read, and links the chunk's headers by id from its
// anchor. As a control, mutating each compared field in the node's statement of the chunk's first transaction with
// registers and a proof must show as a difference. No runtime path reads this and no answer selects a decoder or a venue.
//
// Usage, from the repository root, after the chunks (experiments/ergo-range/equivalence-driver.mjs):
//   node experiments/ergo-range/equivalence-fields.mjs [--dir scratch/equivalence]
// Writes fields-<from>.json beside each chunk-<from>.json; a chunk whose fields report binds these same sources is
// skipped, so a rerun resumes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { blake2b } from "@noble/hashes/blake2b";
import { Transaction } from "ergo-lib-wasm-nodejs";
import { decodeTransaction } from "./decoder.mjs";

const here = import.meta.dirname, root = resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const dir = resolve(root, option("--dir", "scratch/equivalence"));
const SAMPLE = 40;

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const hex = bytes => Buffer.from(bytes).toString("hex");
// The lockfile links the vendored package without an integrity, so its JavaScript glue, which builds every object the
// comparison reads, is bound here and checked against the vendored checksums together with the WASM.
const vendor = "experiments/ergo-range/vendor/ergo-lib-wasm-nodejs";
const files = Object.fromEntries(["experiments/ergo-range/equivalence-fields.mjs", "experiments/ergo-range/decoder.mjs", "experiments/ergo-range/package.json",
  "experiments/ergo-range/package-lock.json", `${vendor}/package.json`, `${vendor}/ergo_lib_wasm.js`, `${vendor}/SHA256SUMS`].map(file => [file, sha256(readFileSync(join(root, file)))]));
const require = createRequire(join(here, "package.json"));
const loaded = realpathSync(dirname(require.resolve("ergo-lib-wasm-nodejs/package.json")));
assert.equal(loaded, realpathSync(join(root, vendor)), "the decoder loads the vendored package");
for (const line of readFileSync(join(root, vendor, "SHA256SUMS"), "utf8").trim().split("\n")) {
  const [digest, file] = line.trim().split(/\s+/);
  assert.equal(sha256(readFileSync(join(loaded, file))), digest, `the vendored ${file} matches its checksum`);
}
const decoder = { version: require("ergo-lib-wasm-nodejs/package.json").version,
  wasmSha256: sha256(readFileSync(join(loaded, "ergo_lib_wasm_bg.wasm"))) };

// As in chain-cost.mjs: cache names carry no ":", and each transaction's bytes come from its exact text in the node's
// response, whose spending-proof extension key order a parsed and re-emitted object would sort.
const hostOf = url => new URL(url).host.replace(/:/g, "-");
const elementTexts = (text, key) => {
  const start = text.indexOf(`"${key}"`);
  assert(start >= 0, `no "${key}" in the response`);
  let depth = 0, inString = false, from = -1;
  const out = [];
  for (let i = text.indexOf("[", start) + 1; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (c === "\\") i++; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === "{") { if (depth === 0) from = i; depth++; }
    else if (c === "}") { depth--; if (depth === 0) out.push(text.slice(from, i + 1)); }
    else if (c === "]" && depth === 0) break;
  }
  return out;
};
const witnessOf = tx => hex(blake2b(Buffer.concat(tx.inputs.map(input => Buffer.from(input.spendingProof.proofBytes, "hex"))), { dkLen: 32 }).subarray(1));

// Every field the decoder's view carries, against the node's statement of it. The node's hex is compared in lower case
// as the node emits it; a difference in case would count.
function differences(view, tx) {
  const found = [];
  if (hex(view.id) !== tx.id) found.push({ field: "id" });
  if (hex(view.witnessId) !== witnessOf(tx)) found.push({ field: "witnessId" });
  if (view.outputs.length !== tx.outputs.length) { found.push({ field: "outputCount", decoder: view.outputs.length, node: tx.outputs.length }); return found; }
  view.outputs.forEach((output, index) => {
    const node = tx.outputs[index];
    if (hex(output.ergoTree) !== node.ergoTree) found.push({ field: "ergoTree", output: index });
    const names = Object.keys(output.registers).sort(), nodeNames = Object.keys(node.additionalRegisters ?? {}).sort();
    if (names.join() !== nodeNames.join()) found.push({ field: "registerNames", output: index, decoder: names, node: nodeNames });
    else for (const name of names) if (hex(output.registers[name]) !== node.additionalRegisters[name]) found.push({ field: "register", output: index, register: name });
  });
  return found;
}

// Controls, so an empty count is not a comparison that cannot fail: each mutation of the node's statement of one real
// transaction must show as a difference in the field it touches.
const flip = text => text.slice(0, -1) + (parseInt(text.at(-1), 16) ^ 1).toString(16);
const MUTATIONS = {
  id: tx => { tx.id = flip(tx.id); },
  witnessId: tx => { const input = tx.inputs.find(i => i.spendingProof.proofBytes.length > 0); input.spendingProof.proofBytes = flip(input.spendingProof.proofBytes); },
  outputCount: tx => { tx.outputs.pop(); },
  ergoTree: tx => { tx.outputs[0].ergoTree = flip(tx.outputs[0].ergoTree); },
  register: tx => { const regs = tx.outputs.find(o => Object.keys(o.additionalRegisters ?? {}).length > 0).additionalRegisters, name = Object.keys(regs)[0]; regs[name] = flip(regs[name]); },
  registerNames: tx => { const regs = tx.outputs.find(o => Object.keys(o.additionalRegisters ?? {}).length > 0).additionalRegisters, name = Object.keys(regs)[0]; delete regs[name]; },
};
const controlsFor = (view, tx) => Object.fromEntries(Object.entries(MUTATIONS).map(([field, mutate]) => {
  const copy = structuredClone(tx);
  mutate(copy);
  return [field, differences(view, copy).some(d => d.field === field)];
}));
const controllable = tx => tx.outputs.some(o => Object.keys(o.additionalRegisters ?? {}).length > 0) && tx.inputs.some(i => i.spendingProof.proofBytes.length > 0);

const chunkNames = readdirSync(dir).filter(n => /^chunk-\d+\.json$/.test(n)).sort();
assert(chunkNames.length > 0, `no chunk reports in ${dir}`);
for (const name of chunkNames) {
  const outFile = join(dir, name.replace(/^chunk-/, "fields-"));
  // Resume only over a report of these exact sources; one from other sources is replaced.
  if (existsSync(outFile) && JSON.stringify(JSON.parse(readFileSync(outFile)).files) === JSON.stringify(files)) continue;
  const chunkText = readFileSync(join(dir, name));
  const chunk = JSON.parse(chunkText), { window } = chunk;
  assert.equal(chunk.status, "public-node-window-measured", `${name} measured its window`);
  assert.equal(chunk.decoders.pinned.wasmSha256, decoder.wasmSha256, `${name} ran the decoder build this pass reads with`);
  assert.equal(chunk.files["experiments/ergo-range/decoder.mjs"], files["experiments/ergo-range/decoder.mjs"], `${name} ran this decoder.mjs`);
  const cache = chunk.cache.directory;
  const digest = createHash("sha256");
  const read = file => { const text = readFileSync(join(cache, file), "utf8"); digest.update(`${file}:${sha256(text)}\n`); return text; };

  // Headers and anchors in the chunk's own read order, then the window's sections, so the digest is the chunk's.
  const chains = chunk.sources.map(({ url }) => {
    const host = hostOf(url), headers = [];
    for (let low = window.anchorHeight; low < window.tipHeight; low += 1000) {
      for (const header of JSON.parse(read(`headers-${host}-${low}-${Math.min(low + 1000, window.tipHeight)}.json`))) headers.push(header);
    }
    headers.sort((a, b) => a.height - b.height);
    return { headers, anchor: JSON.parse(read(`at-${host}-${window.anchorHeight}.json`)) };
  });
  const { headers, anchor } = chains[0];
  assert.equal(headers.length, window.tipHeight - window.anchorHeight, `${name}: one header per height above the anchor`);
  assert(anchor.length === 1 && anchor[0] === window.anchorId && headers[0].parentId === window.anchorId, `${name}: the first header's parent is the anchor`);
  headers.forEach((header, i) => {
    assert.equal(header.height, window.anchorHeight + 1 + i);
    if (i > 0) assert.equal(header.parentId, headers[i - 1].id, `${name}: header ${header.height} links to its parent by id`);
  });
  assert.equal(headers.at(-1).id, window.tipId, `${name}: the linked chain ends at the chunk's tip`);

  const counts = { blocks: 0, transactions: 0, outputs: 0, registers: 0, refused: 0, bytesUnavailable: 0, differingTransactions: 0 };
  const byField = {}, sample = [];
  let controls;
  let serializeMs = 0, decodeMs = 0;
  const started = performance.now();
  for (let i = 0; i < window.count; i++) {
    const header = headers[i], text = read(`tx-${header.height}-${header.id}.json`);
    const block = JSON.parse(text), texts = elementTexts(text, "transactions");
    assert.equal(block.headerId, header.id, "the response names the requested block");
    assert.equal(texts.length, block.transactions.length, "one exact text per transaction");
    counts.blocks++;
    for (const [position, tx] of block.transactions.entries()) {
      counts.transactions++;
      counts.outputs += tx.outputs.length;
      for (const output of tx.outputs) counts.registers += Object.keys(output.additionalRegisters ?? {}).length;
      const t0 = performance.now();
      let bytes;
      try { const wasm = Transaction.from_json(texts[position]); try { bytes = wasm.sigma_serialize_bytes(); } finally { wasm.free(); } }
      catch (error) { if (error instanceof RangeError || error instanceof WebAssembly.RuntimeError) throw error; }
      serializeMs += performance.now() - t0;
      const t1 = performance.now();
      const view = bytes === undefined ? undefined : decodeTransaction(bytes);
      decodeMs += performance.now() - t1;
      const found = bytes === undefined ? [{ field: "bytesUnavailable" }] : view === undefined ? [{ field: "refused" }] : differences(view, tx);
      if (bytes === undefined) counts.bytesUnavailable++; else if (view === undefined) counts.refused++;
      if (found.length === 0 && controls === undefined && controllable(tx)) {
        controls = { height: header.height, position, id: tx.id, detected: controlsFor(view, tx) };
        assert(Object.values(controls.detected).every(Boolean), `${name}: every control mutation shows as a difference: ${JSON.stringify(controls)}`);
      }
      if (found.length === 0) continue;
      counts.differingTransactions++;
      for (const { field } of found) byField[field] = (byField[field] ?? 0) + 1;
      if (sample.length < SAMPLE) sample.push({ height: header.height, position, id: tx.id, differences: found });
    }
    if (i % 2000 === 1999) console.error(`  ${name}: ${i + 1}/${window.count} blocks`);
  }
  const cacheDigest = digest.digest("hex");
  assert.equal(cacheDigest, chunk.cache.digest, `${name}: the cached responses are the ones the chunk read`);
  assert.equal(counts.transactions, chunk.totals.transactions, `${name}: the same transactions`);
  assert(controls !== undefined, `${name}: a transaction with registers and a proof served as the control`);

  const report = {
    status: counts.differingTransactions === 0 ? "every-field-agrees" : "fields-differ",
    node: process.version, chunk: { report: name, sha256: sha256(chunkText), cacheDigest },
    window: { anchorHeight: window.anchorHeight, anchorId: window.anchorId, fromHeight: window.fromHeight, toHeight: window.toHeight,
      lastId: headers[window.count - 1].id, tipHeight: window.tipHeight, tipId: window.tipId, headersLinkedById: headers.length },
    decoder, counts, byField, sample, controls,
    compares: "decoder.mjs's id, witness id and output count, and each output's ErgoTree bytes, register names and register constants, against the node's JSON fields for the same transaction; bytes rebuilt from the node's exact text by the pinned serializer, as chain-cost.mjs did",
    timing: { serializeMs: Math.round(serializeMs), decodeMs: Math.round(decodeMs), totalMs: Math.round(performance.now() - started) },
    files,
  };
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`${name}: ${report.status}, ${counts.transactions} transactions, ${counts.differingTransactions} differing`);
}
