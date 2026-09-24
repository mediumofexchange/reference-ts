// Contained candidate decoder: the pinned sigma-rust build, run per transaction in a fresh WebAssembly instance of a
// metered module derived from it (wasm-meter.mjs), under a budget declared as a function of the transaction's length.
//
// Every import traps: the successful path calls none, and a path that would (an error the library turns into a
// JavaScript value, for one) is refused. Fuel exhaustion, a refused memory or table growth, a call depth past the
// ceiling and a trap each refuse that one transaction with a reason; its instance is dropped, so nothing it did
// reaches the next call. These refusals depend only on the bytes and the budget. The engine's own stack is not the
// guest's to spend: the depth ceiling stops guest recursion first where the caller leaves the headroom
// contained-check.mjs measures, and an engine stack overflow inside the guest, reachable only from a caller already
// near its own limit, refuses as "stack", which is host-dependent. The decoded view is built from the guest's JSON
// text after an exact reserialization, with the same fields decoder.mjs returns. The budget is the reader's own,
// calibrated on observed valid transactions: the node's rules do not bound a decoder's work per byte, so a node-valid
// transaction above it is refused like any other, leaving the ranges through its block unresolved. Neither node
// equivalence nor a bound on the host's own memory follows from it: a dropped instance's memory is the host's until
// its collector reclaims it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2b";
import { meter, METER_EXPORTS, REFUSED_MEMORY, REFUSED_TABLE } from "./wasm-meter.mjs";

const VENDORED = new URL("vendor/ergo-lib-wasm-nodejs/ergo_lib_wasm_bg.wasm", import.meta.url);
export const VENDORED_SHA256 = "0d20038513c72a9daf859e3ea278735caef43305cde6bc7fb2764e8d933aa28a";
export const DERIVED_SHA256 = "bd7cfbb5459aa577488ae304f2b5057996b576a285886f6d78b36fe3e91bbec5";
const PAGE = 65536;

// The reader's budget for a transaction of `length` bytes, linear so that a short transaction gets a small budget:
// fuel 2^26 + 2^21 per byte, linear memory 8 MiB + 1 KiB per byte (in whole pages), 4,096 elements per table and a call
// depth of 4,096 frames. Over the P4 week every valid transaction took at most a seventh (7.3) of this fuel and under
// a third (3.6) of this memory, the costliest 287,971 fuel per byte; the deepest corpus transaction reached 86 frames and
// an expression nested to the node's cap of 110 reaches 361 (contained-range.mjs, contained-check.mjs). Inputs above
// 2 MiB refuse: mainnet's voted maxBlockSize is 1,271,009
// bytes on the own node, and a vote raising it past this limit would need the limit raised too. Guest JSON above 64 MiB
// refuses.
export const LIMITS = Object.freeze({ inputBytes: 2 * 1024 * 1024, jsonBytes: 64 * 1024 * 1024 });
export const budgetFor = length => {
  if (!Number.isSafeInteger(length) || length < 0) throw new TypeError("a transaction length");
  const n = BigInt(length);
  return Object.freeze({ fuel: (1n << 26n) + (n << 21n), memoryPages: (8n * 1024n * 1024n + (n << 10n) + BigInt(PAGE) - 1n) / BigInt(PAGE),
    tableElements: 4096n, depth: 4096n });
};
// Observation ceilings for calibration over valid transactions only: effectively unbounded fuel, wasm32's whole
// address space, a large table and a depth the engine's stack stops first, so each transaction shows what it takes.
export const CALIBRATION_BUDGET = Object.freeze({ fuel: 10n ** 13n, memoryPages: 65536n, tableElements: 1n << 20n, depth: 1n << 32n });

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

// Typed-array intrinsics, so a shadowed length or iterator cannot change what is measured or copied.
const brandOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;

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

// One transaction under one budget (by default the reader's for its length): { view } when decoded, else { refused },
// with the guest work it took and the deepest call depth it reached.
export function decodeContained(input, chosen) {
  if (brandOf.call(input) !== "Uint8Array") throw new TypeError("transaction bytes must be a Uint8Array");
  const bytes = new Uint8Array(input);
  const budget = chosen ?? budgetFor(bytes.length);
  if (bytes.length === 0 || bytes.length > LIMITS.inputBytes) return { refused: "input", fuel: 0n, memoryBytes: 0, depth: 0n };
  const { module, imports } = load();
  const exports = new WebAssembly.Instance(module, imports).exports;
  const { memory } = exports;
  const global = key => exports[METER_EXPORTS[key]];
  global("fuel").value = budget.fuel;
  global("memoryPages").value = budget.memoryPages;
  global("tableElements").value = budget.tableElements;
  global("depthLimit").value = budget.depth;
  const measured = extra => ({ ...extra, fuel: budget.fuel - global("fuel").value, memoryBytes: memory.buffer.byteLength,
    depth: global("depthMax").value });
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
      const refused = global("fuel").value < 0n ? "fuel"
        : global("depth").value > budget.depth ? "depth"
        : global("refused").value === REFUSED_MEMORY ? "memory"
        : global("refused").value === REFUSED_TABLE ? "table" : "trap";
      return measured({ refused });
    }
    throw error;
  }
}

// The interface of decoder.mjs: the view, or undefined for a refusal.
export const decodeTransaction = bytes => decodeContained(bytes).view;
