// Contained decoder over valid retained transactions: for every transaction of a set, the bytes rebuilt from the node's
// exact text by the pinned serializer (as chain-cost.mjs does) are read by contained-decoder.mjs under a budget, and its
// id, witness id, output count and each output's ErgoTree bytes, register names and register constants are compared
// with the node's JSON fields. Records each transaction's length, fuel and linear memory, so the report shows the
// budget's margin over what valid transactions take. A mutation of the node's statement of one transaction per set must
// show as a difference, so an empty count is not a comparison that cannot fail. Offline; no runtime path reads this.
//
// Usage, from the repository root:
//   node experiments/ergo-range/contained-range.mjs corpus
//   node experiments/ergo-range/contained-range.mjs week [--cache scratch/ergo-chain]
//   node experiments/ergo-range/contained-range.mjs retained [--cache scratch/ergo-chain-own] [--from h] [--to h]
//   options: --budget calibration (the observation ceilings) | reader (default); --rows <file> (per-transaction rows)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { blake2b } from "@noble/hashes/blake2b";
import { Transaction } from "ergo-lib-wasm-nodejs";
import { budgetFor, CALIBRATION_BUDGET, decodeContained, DERIVED_SHA256, VENDORED_SHA256 } from "./contained-decoder.mjs";

const here = import.meta.dirname, root = resolve(here, "../..");
const [set, ...args] = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
assert(["corpus", "week", "retained"].includes(set), "usage: contained-range.mjs corpus|week|retained [options]");
const budgetName = option("--budget", "reader");
assert(["reader", "calibration"].includes(budgetName), "--budget reader|calibration");
const budget = length => budgetName === "reader" ? budgetFor(length) : CALIBRATION_BUDGET;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const hex = bytes => Buffer.from(bytes).toString("hex");

// Each element of a top-level array in the node's exact response text, so the proof extension keeps its key order.
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
function differences(view, tx) {
  const found = [];
  if (hex(view.id) !== tx.id) found.push("id");
  if (hex(view.witnessId) !== witnessOf(tx)) found.push("witnessId");
  if (view.outputs.length !== tx.outputs.length) return [...found, "outputCount"];
  view.outputs.forEach((output, index) => {
    const node = tx.outputs[index], regs = node.additionalRegisters ?? {};
    if (hex(output.ergoTree) !== node.ergoTree) found.push("ergoTree");
    const names = Object.keys(output.registers).sort();
    if (names.join() !== Object.keys(regs).sort().join()) found.push("registerNames");
    else if (names.some(name => hex(output.registers[name]) !== regs[name])) found.push("register");
  });
  return found;
}
const flip = text => text.slice(0, -1) + (parseInt(text.at(-1), 16) ^ 1).toString(16);
const MUTATIONS = {
  id: tx => { tx.id = flip(tx.id); },
  witnessId: tx => { const input = tx.inputs.find(i => i.spendingProof.proofBytes.length > 0); input.spendingProof.proofBytes = flip(input.spendingProof.proofBytes); },
  outputCount: tx => { tx.outputs.pop(); },
  ergoTree: tx => { tx.outputs[0].ergoTree = flip(tx.outputs[0].ergoTree); },
  register: tx => { const regs = tx.outputs.find(o => Object.keys(o.additionalRegisters ?? {}).length > 0).additionalRegisters, name = Object.keys(regs)[0]; regs[name] = flip(regs[name]); },
  registerNames: tx => { const regs = tx.outputs.find(o => Object.keys(o.additionalRegisters ?? {}).length > 0).additionalRegisters; delete regs[Object.keys(regs)[0]]; },
};
const controllable = tx => tx.outputs.some(o => Object.keys(o.additionalRegisters ?? {}).length > 0) && tx.inputs.some(i => i.spendingProof.proofBytes.length > 0);

// The blocks of the set, each as { label, text } in height order.
function* blocks() {
  if (set === "corpus") {
    const manifest = readFileSync(join(here, "fixtures/manifest.json"));
    assert.equal(sha256(manifest), "4ba3120b61dce7621c40e391faa70c46c6765b33a971815b35725da1e2c1d869");
    for (const fixture of JSON.parse(manifest).fixtures) {
      const raw = readFileSync(join(here, "fixtures", fixture.file.replace(/^fixtures\//, "")));
      assert.equal(sha256(raw), fixture.sha256, `${fixture.file} matches the manifest`);
      yield { label: fixture.file, text: raw.toString("utf8") };
    }
    return;
  }
  const window = set === "week"
    ? JSON.parse(readFileSync(join(root, "docs/ergo-decoder-pin-verification.json"))).window
    : JSON.parse(readFileSync(join(root, "docs/ergo-decoder-equivalence-verification.json"))).totals;
  const from = Number(option("--from", window.fromHeight)), to = Number(option("--to", window.toHeight));
  assert(from >= window.fromHeight && to <= window.toHeight && from <= to, "the heights lie in the set's window");
  const cache = resolve(root, option("--cache", set === "week" ? "scratch/ergo-chain" : "scratch/ergo-chain-own"));
  const files = readdirSync(cache).filter(f => f.startsWith("tx-")).map(f => ({ f, h: Number(f.split("-")[1]) }))
    .filter(({ h }) => h >= from && h <= to).sort((x, y) => x.h - y.h);
  assert.equal(files.length, to - from + 1, "one cached block per height");
  files.forEach(({ h }, i) => assert.equal(h, from + i, "one cached block per height"));
  for (const { f, h } of files) yield { label: h, text: readFileSync(join(cache, f), "utf8") };
}

const counts = { blocks: 0, transactions: 0, outputs: 0, refused: 0, differing: 0 };
const refusedBy = {}, differingBy = {}, samples = [], rows = [];
let control, largest = 0, maxFuel = 0n, maxMemory = 0, maxFuelPerByte = 0, maxMemoryPerByte = 0, margin = Infinity;
const started = performance.now();
for (const block of blocks()) {
  counts.blocks++;
  const parsed = JSON.parse(block.text), transactions = (parsed.blockTransactions ?? parsed).transactions;
  const texts = elementTexts(block.text, "transactions");
  assert.equal(texts.length, transactions.length, "one exact text per transaction");
  for (const [position, tx] of transactions.entries()) {
    counts.transactions++;
    counts.outputs += tx.outputs.length;
    const wasm = Transaction.from_json(texts[position]);
    let bytes;
    try { bytes = Buffer.from(wasm.sigma_serialize_bytes()); } finally { wasm.free(); }
    const b = budget(bytes.length), result = decodeContained(bytes, b);
    largest = Math.max(largest, bytes.length);
    rows.push(`${block.label}\t${position}\t${bytes.length}\t${result.fuel}\t${result.memoryBytes}\t${result.refused ?? ""}`);
    if (result.refused) {
      counts.refused++;
      refusedBy[result.refused] = (refusedBy[result.refused] ?? 0) + 1;
      if (samples.length < 20) samples.push({ block: block.label, position, id: tx.id, bytes: bytes.length, refused: result.refused });
      continue;
    }
    if (result.fuel > maxFuel) maxFuel = result.fuel;
    maxMemory = Math.max(maxMemory, result.memoryBytes);
    maxFuelPerByte = Math.max(maxFuelPerByte, Number(result.fuel) / bytes.length);
    maxMemoryPerByte = Math.max(maxMemoryPerByte, result.memoryBytes / bytes.length);
    // The least ratio of the budget to what the transaction took, over fuel and memory.
    margin = Math.min(margin, Number(b.fuel) / Number(result.fuel), Number(b.memoryPages) * 65536 / result.memoryBytes);
    const found = differences(result.view, tx);
    if (found.length === 0 && control === undefined && controllable(tx)) {
      control = { block: block.label, position, id: tx.id, detected: Object.fromEntries(Object.entries(MUTATIONS).map(([field, mutate]) => {
        const copy = structuredClone(tx); mutate(copy); return [field, differences(result.view, copy).includes(field)];
      })) };
      assert(Object.values(control.detected).every(Boolean), `every control mutation shows: ${JSON.stringify(control)}`);
    }
    if (found.length === 0) continue;
    counts.differing++;
    for (const field of found) differingBy[field] = (differingBy[field] ?? 0) + 1;
    if (samples.length < 20) samples.push({ block: block.label, position, id: tx.id, differences: found });
  }
  if (counts.blocks % 2000 === 0) console.error(`  ${set}: ${counts.blocks} blocks, ${counts.transactions} transactions`);
}
assert(control !== undefined, "a transaction with registers and a proof served as the control");
if (option("--rows")) writeFileSync(resolve(root, option("--rows")), rows.join("\n") + "\n");
const files = ["contained-range.mjs", "contained-decoder.mjs", "wasm-meter.mjs", "package.json", "package-lock.json",
  "vendor/ergo-lib-wasm-nodejs/SHA256SUMS", "vendor/ergo-lib-wasm-nodejs/ergo_lib_wasm.js"];
process.stdout.write(JSON.stringify({
  status: counts.refused === 0 && counts.differing === 0 ? "every-transaction-decoded-with-the-nodes-fields" : "refusals-or-differences",
  set, budget: budgetName, node: process.version, vendoredWasmSha256: VENDORED_SHA256, derivedWasmSha256: DERIVED_SHA256,
  heights: set === "corpus" ? undefined : { from: Number(option("--from", 0)) || undefined, to: Number(option("--to", 0)) || undefined },
  counts, refusedBy, differingBy, samples, control,
  observed: { largestTransactionBytes: largest, maxFuel: String(maxFuel), maxMemoryBytes: maxMemory,
    maxFuelPerByte: Math.round(maxFuelPerByte), maxMemoryPerByte: Math.round(maxMemoryPerByte),
    leastBudgetMargin: Number.isFinite(margin) ? Number(margin.toFixed(2)) : null },
  seconds: Math.round((performance.now() - started) / 1000),
  rowsSha256: sha256(rows.join("\n") + "\n"),
  files: Object.fromEntries(files.map(file => [`experiments/ergo-range/${file}`, sha256(readFileSync(join(here, file)))])),
}, null, 2) + "\n");
