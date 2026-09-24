// Contained candidate decoder: the pinned sigma-rust build, run per transaction in a fresh WebAssembly instance of a
// metered module derived from it (wasm-meter.mjs), under a budget declared as a function of the transaction's length.
//
// Every import traps: the successful path calls none, and a path that would (an error the library turns into a
// JavaScript value, for one) is refused. Fuel exhaustion, a refused memory or table growth, a trap and a stack
// overflow each refuse that one transaction with a reason; its instance is dropped, so nothing it did reaches the next
// call. The decoded view is built from the guest's JSON text after an exact reserialization, with the same fields
// decoder.mjs returns. The budget is the reader's own, calibrated on observed valid transactions: the node's rules do
// not bound a decoder's work per byte, so a node-valid transaction above it is refused like any other, leaving the
// ranges through its block unresolved. Neither node equivalence nor a bound on the host's own memory follows from it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2b";
import { meter, METER_EXPORTS, REFUSED_MEMORY, REFUSED_TABLE } from "./wasm-meter.mjs";

const VENDORED = new URL("vendor/ergo-lib-wasm-nodejs/ergo_lib_wasm_bg.wasm", import.meta.url);
export const VENDORED_SHA256 = "0d20038513c72a9daf859e3ea278735caef43305cde6bc7fb2764e8d933aa28a";
export const DERIVED_SHA256 = "440f97c74acdf6420499228c03bb57ef7db765cb7dd4014c2257bbe056f56523";
const PAGE = 65536;

// The reader's budget for a transaction of `length` bytes, linear so that a short transaction gets a small budget:
// fuel 2^26 + 2^20 per byte, linear memory 8 MiB + 1 KiB per byte (in whole pages), 4,096 elements per table. Over the
// P4 week the costliest valid transaction took 146,669 fuel and about 254 bytes of memory per byte and no transaction
// under 300 bytes took 9 million fuel, so these are at least seven, four and seven times what was observed
// (contained-range.mjs). Inputs above 2 MiB refuse: mainnet's voted maxBlockSize is 1,271,009 bytes on the own node,
// and a vote raising it past this limit would need the limit raised too. Guest JSON above 64 MiB refuses.
export const LIMITS = Object.freeze({ inputBytes: 2 * 1024 * 1024, jsonBytes: 64 * 1024 * 1024 });
export const budgetFor = length => {
  if (!Number.isSafeInteger(length) || length < 0) throw new TypeError("a transaction length");
  const n = BigInt(length);
  return Object.freeze({ fuel: (1n << 26n) + (n << 20n), memoryPages: (8n * 1024n * 1024n + (n << 10n) + BigInt(PAGE) - 1n) / BigInt(PAGE),
    tableElements: 4096n });
};
// Observation ceilings for calibration over valid transactions only: effectively unbounded fuel, wasm32's whole
// address space and a large table, so each transaction shows what it takes.
export const CALIBRATION_BUDGET = Object.freeze({ fuel: 10n ** 13n, memoryPages: 65536n, tableElements: 1n << 20n });

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
let compiled;
const load = () => {
  if (compiled) return compiled;
  const vendored = readFileSync(VENDORED);
  if (sha256(vendored) !== VENDORED_SHA256) throw new Error("the vendored decoder is not the pinned build");
  const { bytes } = meter(vendored);
  if (sha256(bytes) !== DERIVED_SHA256) throw new Error("the metered module is not the pinned derivation");
  const module = new WebAssembly.Module(bytes);
  const imports = {};
  for (const { module: from, name } of WebAssembly.Module.imports(module)) {
    (imports[from] ??= {})[name] = () => { throw new ImportRefused(name); };
  }
  return (compiled = { module, imports });
};
class ImportRefused extends Error {}

const HEX = /^(?:[0-9a-f]{2})*$/;
const isHex = value => typeof value === "string" && HEX.test(value);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
// The fields the verifier reads, from the guest's JSON; any other shape refuses.
const view = json => {
  if (!isObject(json) || !isHex(json.id) || json.id.length !== 64 || !Array.isArray(json.inputs) || !Array.isArray(json.outputs)) return undefined;
  const proofs = [];
  for (const input of json.inputs) {
    if (!isObject(input) || !isObject(input.spendingProof) || !isHex(input.spendingProof.proofBytes)) return undefined;
    proofs.push(Buffer.from(input.spendingProof.proofBytes, "hex"));
  }
  const outputs = [];
  for (const output of json.outputs) {
    if (!isObject(output) || !isHex(output.ergoTree) || !isObject(output.additionalRegisters)) return undefined;
    const registers = {};
    for (const [name, value] of Object.entries(output.additionalRegisters)) {
      if (!/^R[4-9]$/.test(name) || !isHex(value)) return undefined;
      registers[name] = Buffer.from(value, "hex");
    }
    outputs.push({ ergoTree: Buffer.from(output.ergoTree, "hex"), registers });
  }
  return { id: Buffer.from(json.id, "hex"), witnessId: Buffer.from(blake2b(Buffer.concat(proofs), { dkLen: 32 }).subarray(1)), outputs };
};

// One transaction under one budget: { view } when decoded, else { refused }, with the guest work it took.
export function decodeContained(input, budget = budgetFor(input?.length ?? 0)) {
  if (!(input instanceof Uint8Array)) throw new TypeError("transaction bytes must be a Uint8Array");
  const bytes = Uint8Array.from(input);
  if (bytes.length === 0 || bytes.length > LIMITS.inputBytes) return { refused: "input", fuel: 0n, memoryBytes: 0 };
  const { module, imports } = load();
  const exports = new WebAssembly.Instance(module, imports).exports;
  const { memory } = exports;
  exports[METER_EXPORTS.fuel].value = budget.fuel;
  exports[METER_EXPORTS.memoryPages].value = budget.memoryPages;
  exports[METER_EXPORTS.tableElements].value = budget.tableElements;
  const measured = extra => ({ ...extra, fuel: budget.fuel - exports[METER_EXPORTS.fuel].value, memoryBytes: memory.buffer.byteLength });
  const read = (pointer, length, limit) => {
    if (!Number.isSafeInteger(pointer) || !Number.isSafeInteger(length) || pointer < 0 || length < 0 || length > limit ||
      pointer + length > memory.buffer.byteLength) return undefined;
    return Buffer.from(new Uint8Array(memory.buffer, pointer, length));
  };
  try {
    const pointer = exports.__wbindgen_malloc(bytes.length, 1) >>> 0;
    if (pointer + bytes.length > memory.buffer.byteLength) return measured({ refused: "input" });
    new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
    const [tx, , parseFailed] = exports.transaction_sigma_parse_bytes(pointer, bytes.length);
    if (parseFailed) return measured({ refused: "parse" });
    const [serialized, serializedLength, , serializeFailed] = exports.transaction_sigma_serialize_bytes(tx >>> 0);
    const again = serializeFailed ? undefined : read(serialized >>> 0, serializedLength >>> 0, bytes.length);
    if (again === undefined || !again.equals(bytes)) return measured({ refused: "noncanonical" });
    const [text, textLength, , jsonFailed] = exports.transaction_to_json(tx >>> 0);
    const json = jsonFailed ? undefined : read(text >>> 0, textLength >>> 0, LIMITS.jsonBytes);
    if (json === undefined) return measured({ refused: "json" });
    let parsed;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)); } catch { return measured({ refused: "json" }); }
    const decoded = view(parsed);
    return decoded === undefined ? measured({ refused: "json" }) : measured({ view: decoded });
  } catch (error) {
    if (error instanceof ImportRefused) return measured({ refused: "import", import: error.message });
    if (error instanceof RangeError) return measured({ refused: "stack" });
    if (error instanceof WebAssembly.RuntimeError) {
      const refused = exports[METER_EXPORTS.fuel].value < 0n ? "fuel"
        : exports[METER_EXPORTS.refused].value === REFUSED_MEMORY ? "memory"
        : exports[METER_EXPORTS.refused].value === REFUSED_TABLE ? "table" : "trap";
      return measured({ refused });
    }
    throw error;
  }
}

// The interface of decoder.mjs: the view, or undefined for a refusal.
export const decodeTransaction = bytes => decodeContained(bytes).view;
