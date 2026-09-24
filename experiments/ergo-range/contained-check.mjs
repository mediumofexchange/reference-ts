// Contained decoder check. Controls on a small hand-assembled module show that wasm-meter.mjs charges exactly what its
// contract says (a region's instructions plus the charge per function entry and loop iteration, bulk and growth
// extents, refused growth) and refuses instructions it does not know. On the pinned decoder: the corpus decodes under
// the reader's budget with the fields decoder.mjs reads and meters identically twice; reduced budgets refuse with the
// specific reason; synthetic hostile inputs (output trees nested past the node's cap, truncated and garbage bytes)
// refuse, and an ordinary transaction decoded right after each is unaffected. Offline and synthetic apart from the
// corpus; nothing is submitted.
//
// Usage, from the repository root: node experiments/ergo-range/contained-check.mjs
//   [--report <out.json> --ranges <corpus.json>,<week.json>,<retained.json>...]  also writes the retained report,
//   embedding contained-range.mjs summaries that bind these same sources.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { serializeTransaction } from "@fleet-sdk/serializer";
import { budgetFor, decodeContained, DERIVED_SHA256, LIMITS, VENDORED_SHA256 } from "./contained-decoder.mjs";
import { decodeTransaction } from "./decoder.mjs";
import { CHARGE_INSTRUCTIONS, meter, METER_EXPORTS, REFUSED_MEMORY, REFUSED_TABLE } from "./wasm-meter.mjs";

const here = import.meta.dirname, root = resolve(here, "../..");
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const C = CHARGE_INSTRUCTIONS;

// --- Controls on a hand-assembled module ---
const leb = n => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const vec = items => [...leb(items.length), ...items.flat()];
const section = (id, body) => [id, ...leb(body.length), ...body];
const I32 = 0x7f, EXTERNREF = 0x6f;
function assemble(functions, { extra = [] } = {}) {
  const types = functions.map(f => [0x60, ...vec(f.params.map(p => [p])), ...vec(f.results.map(r => [r]))]);
  const bodies = functions.map(f => { const body = [0x00, ...f.code]; return [...leb(body.length), ...body]; });
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)), ...section(3, vec(functions.map((_, i) => leb(i)))),
    ...section(4, vec([[EXTERNREF, 0x00, 0x01]])), ...section(5, vec([[0x00, 0x01]])),
    ...section(6, vec([[I32, 0x00, 0x41, 0x00, 0x0b]])),
    ...section(7, vec([...functions.map((f, i) => [...leb(f.name.length), ...Buffer.from(f.name), 0x00, ...leb(i)]),
      [6, ...Buffer.from("memory"), 0x02, 0x00]])),
    ...extra, ...section(10, vec(bodies))]);
}
const CONTROL = [
  // Function region: loop, end (final) = 2. Loop region: br 0, end = 2.
  { name: "spin", params: [], results: [], code: [0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b] },
  // local.get, local.get, i32.add, end = 4.
  { name: "add", params: [I32, I32], results: [I32], code: [0x20, 0, 0x20, 1, 0x6a, 0x0b] },
  // local.get, memory.grow (a call once metered), end = 3.
  { name: "grow", params: [I32], results: [I32], code: [0x20, 0, 0x40, 0x00, 0x0b] },
  { name: "copy", params: [I32, I32, I32], results: [], code: [0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 10, 0, 0, 0x0b] },
  { name: "fill", params: [I32, I32, I32], results: [], code: [0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 11, 0, 0x0b] },
  { name: "tgrow", params: [I32], results: [I32], code: [0xd0, EXTERNREF, 0x20, 0, 0xfc, 15, 0, 0x0b] },
  { name: "tfill", params: [I32, I32], results: [], code: [0x20, 0, 0xd0, EXTERNREF, 0x20, 1, 0xfc, 17, 0, 0x0b] },
  { name: "recurse", params: [], results: [], code: [0x10, 7, 0x0b] },
  // Function region: block, loop, end, end = 4. Loop region: local.get, i32.eqz, br_if 1, local.get, i32.const 1,
  // i32.sub, local.set, br 0, end = 9; entered n + 1 times.
  { name: "count", params: [I32], results: [], code: [0x02, 0x40, 0x03, 0x40, 0x20, 0, 0x45, 0x0d, 1, 0x20, 0, 0x41, 1, 0x6b, 0x21, 0, 0x0c, 0, 0x0b, 0x0b, 0x0b] },
];
function controls() {
  const plain = assemble(CONTROL);
  assert(WebAssembly.validate(plain), "the control module validates");
  const { bytes } = meter(plain);
  const module = new WebAssembly.Module(bytes);
  const fresh = (fuel, pages = 2n, elements = 4n) => {
    const e = new WebAssembly.Instance(module, {}).exports;
    e[METER_EXPORTS.fuel].value = fuel; e[METER_EXPORTS.memoryPages].value = pages; e[METER_EXPORTS.tableElements].value = elements;
    return e;
  };
  const used = (e, fuel) => fuel - e[METER_EXPORTS.fuel].value;
  const out = {};
  // Straight line: exactly the region plus the charge, and nothing is left for a second call at that budget.
  let e = fresh(4n + C);
  assert.equal(e.add(2, 3), 5);
  assert.equal(used(e, 4n + C), 4n + C);
  assert.throws(() => e.add(1, 1), WebAssembly.RuntimeError);
  assert(e[METER_EXPORTS.fuel].value < 0n, "exhaustion leaves the fuel negative");
  out.straightLine = { perCall: String(4n + C) };
  // A counted loop: the function region once and the loop region per entry, exactly.
  for (const n of [0, 1, 1000]) {
    e = fresh(10n ** 9n);
    e.count(n);
    assert.equal(used(e, 10n ** 9n), 4n + C + BigInt(n + 1) * (9n + C), `count(${n})`);
  }
  out.countedLoop = { formula: "(4 + 10) + (n + 1) * (9 + 10)", checked: [0, 1, 1000] };
  // An infinite loop stops at every budget, with exactly the charges that fit.
  for (const fuel of [0n, 1n, 11n, 12n, 13n, 1000n, 1000000n]) {
    e = fresh(fuel);
    assert.throws(() => e.spin(), WebAssembly.RuntimeError);
    const charges = fuel < 12n ? 1n : fuel / 12n + 1n;
    assert.equal(e[METER_EXPORTS.fuel].value, fuel - charges * 12n, `spin at ${fuel}`);
  }
  out.infiniteLoop = { stopsAt: [0, 1, 11, 12, 13, 1000, 1000000], perIteration: String(2n + C) };
  // Growth: allowed up to the ceiling, charged 8,192 per page; beyond it -1, no growth, and the refusal flag.
  e = fresh(10n ** 9n, 2n);
  const growZero = (() => { const x = fresh(10n ** 9n, 2n); assert.equal(x.grow(0), 1); return used(x, 10n ** 9n); })();
  assert.equal(e.grow(1), 1);
  assert.equal(used(e, 10n ** 9n), growZero + 8192n, "one page costs 8,192 more than none");
  assert.equal(e.grow(1), -1);
  assert.equal(e.memory.buffer.byteLength, 2 * 65536, "the refused growth left the memory at the ceiling");
  assert.equal(e[METER_EXPORTS.refused].value, REFUSED_MEMORY);
  e = fresh(10n ** 9n, 2n);
  assert.equal(e.grow(0xffffffff), -1, "a growth past the ceiling by any amount is refused");
  assert.equal(e[METER_EXPORTS.refused].value, REFUSED_MEMORY);
  out.memoryGrowth = { ceilingPages: 2, perPage: 8192, refusedFlag: REFUSED_MEMORY };
  // Bulk copy and fill: an extra fuel unit per 8 bytes.
  for (const name of ["copy", "fill"]) {
    const base = (() => { const x = fresh(10n ** 9n); x[name](0, 0, 0); return used(x, 10n ** 9n); })();
    e = fresh(10n ** 9n);
    e[name](0, 0, 65536);
    assert.equal(used(e, 10n ** 9n), base + 8192n, `${name} of 65,536 bytes`);
    e = fresh(base + 8191n);
    assert.throws(() => e[name](0, 0, 65536), WebAssembly.RuntimeError, `${name} short of fuel`);
    assert(e[METER_EXPORTS.fuel].value < 0n, `${name} stopped by fuel, not bounds`);
  }
  out.bulk = { perEightBytes: 1 };
  // Tables: growth past the element ceiling refused with its flag; fill charged per element.
  e = fresh(10n ** 9n, 2n, 4n);
  assert.equal(e.tgrow(3), 1);
  assert.equal(e.tgrow(1), -1);
  assert.equal(e[METER_EXPORTS.refused].value, REFUSED_TABLE);
  const fillBase = (() => { const x = fresh(10n ** 9n, 2n, 4n); x.tfill(0, 0); return used(x, 10n ** 9n); })();
  e = fresh(10n ** 9n, 2n, 4n); e.tgrow(3); const before = e[METER_EXPORTS.fuel].value;
  e.tfill(0, 4);
  assert.equal(before - e[METER_EXPORTS.fuel].value, fillBase + 4n);
  out.tables = { ceilingElements: 4, refusedFlag: REFUSED_TABLE };
  // Unbounded recursion: fuel stops it when short; otherwise the engine's stack does, as a RangeError.
  e = fresh(1000n);
  assert.throws(() => e.recurse(), WebAssembly.RuntimeError);
  assert(e[METER_EXPORTS.fuel].value < 0n);
  e = fresh(10n ** 12n);
  assert.throws(() => e.recurse(), RangeError);
  out.recursion = { shortOfFuel: "fuel", ample: "stack" };
  // The rewriter refuses what it does not know.
  const unknown = (code, pattern) => assert.throws(() => meter(assemble([{ name: "f", params: [], results: [], code }])), pattern);
  unknown([0x12, 0x00, 0x0b], /unsupported instruction 0x12/);
  unknown([0xfd, 0x0c, ...Array(16).fill(0), 0x1a, 0x0b], /unsupported instruction 0xfd/);
  unknown([0x41, 0, 0x41, 0, 0x41, 0, 0xfc, 8, 0, 0, 0x0b], /unsupported instruction 0xfc 8/);
  assert.throws(() => meter(assemble([{ name: "f", params: [], results: [], code: [0x0b] }], { extra: section(8, [0]) })), /start section/);
  out.refusedInputs = ["return_call", "SIMD", "memory.init", "start section"];
  // Deterministic: the same input derives the same bytes.
  assert.equal(sha256(meter(plain).bytes), sha256(bytes));
  return out;
}

// --- The pinned decoder ---
const manifest = readFileSync(join(here, "fixtures/manifest.json"));
assert.equal(sha256(manifest), "4ba3120b61dce7621c40e391faa70c46c6765b33a971815b35725da1e2c1d869");
const lossless = raw => JSON.parse(raw, (_k, v, ctx) => typeof v === "number" ? BigInt(ctx.source) : v);
const normalize = t => ({ ...t, outputs: t.outputs.map(o => ({ ...o, creationHeight: Number(o.creationHeight), index: Number(o.index) })) });
const corpus = JSON.parse(manifest).fixtures.flatMap(fixture => {
  const raw = readFileSync(join(here, "fixtures", fixture.file.replace(/^fixtures\//, "")));
  assert.equal(sha256(raw), fixture.sha256);
  return lossless(raw.toString("utf8")).blockTransactions.transactions.map(t => ({ id: t.id, bytes: Buffer.from(serializeTransaction(normalize(t)).toBytes()) }));
});
const plainView = view => view && { ...view, witnessId: Buffer.from(view.witnessId) };

function decoder() {
  const out = { corpus: { transactions: corpus.length, equalToDecoderMjs: 0, repeatable: 0, maxFuel: 0n, maxMemoryBytes: 0 } };
  for (const { id, bytes } of corpus) {
    const a = decodeContained(bytes), b = decodeContained(bytes);
    assert.equal(a.refused, undefined, `corpus ${id} decodes under the reader's budget`);
    assert.equal(Buffer.from(a.view.id).toString("hex"), id);
    if (isDeepStrictEqual(plainView(a.view), plainView(decodeTransaction(bytes)))) out.corpus.equalToDecoderMjs++;
    if (a.fuel === b.fuel && a.memoryBytes === b.memoryBytes) out.corpus.repeatable++;
    if (a.fuel > out.corpus.maxFuel) out.corpus.maxFuel = a.fuel;
    out.corpus.maxMemoryBytes = Math.max(out.corpus.maxMemoryBytes, a.memoryBytes);
  }
  assert.equal(out.corpus.equalToDecoderMjs, corpus.length, "every corpus view equals decoder.mjs's");
  assert.equal(out.corpus.repeatable, corpus.length, "metering repeats exactly");
  out.corpus.maxFuel = String(out.corpus.maxFuel);

  // Each case, then an ordinary transaction: the case refuses with its reason and the next decodes unaffected.
  const ordinary = corpus.find(c => c.bytes.length > 1000);
  const expectedOrdinary = plainView(decodeContained(ordinary.bytes).view);
  const afterwards = () => isDeepStrictEqual(plainView(decodeContained(ordinary.bytes).view), expectedOrdinary);
  const base = budgetFor(ordinary.bytes.length);
  const cases = {};
  const run = (name, bytes, budget, expect) => {
    const result = decodeContained(bytes, budget);
    assert(expect.includes(result.refused ?? "decoded"), `${name}: ${result.refused ?? "decoded"} is one of ${expect}`);
    assert(afterwards(), `${name}: the next transaction decodes as before`);
    cases[name] = { bytes: bytes.length, outcome: result.refused ?? "decoded", fuel: String(result.fuel), memoryBytes: result.memoryBytes };
  };
  run("fuel of 1,000", ordinary.bytes, { ...base, fuel: 1000n }, ["fuel"]);
  run("no memory growth", ordinary.bytes, { ...base, memoryPages: 0n }, ["memory"]);
  run("one fuel short of the ordinary transaction's need", ordinary.bytes,
    { ...base, fuel: decodeContained(ordinary.bytes).fuel - 1n }, ["fuel"]);
  run("exactly the ordinary transaction's need", ordinary.bytes, { ...base, fuel: decodeContained(ordinary.bytes).fuel }, ["decoded"]);
  // A v0 tree without the size flag: BoolToSigmaProp over `depth` nested LogicalNot over true, spliced into a
  // transaction serialized around a short one (the tree carries no length prefix).
  const tree = depth => "00d1" + "ef".repeat(depth) + "0101";
  const shortHex = Buffer.from(serializeTransaction({ inputs: [{ boxId: "11".repeat(32), spendingProof: { proofBytes: "", extension: {} } }], dataInputs: [],
    outputs: [{ value: 1000000n, ergoTree: tree(3), creationHeight: 1, assets: [], additionalRegisters: {} }] }).toBytes()).toString("hex");
  assert.equal(shortHex.split(tree(3)).length, 2);
  const nested = depth => Buffer.from(shortHex.replace(tree(3), tree(depth)), "hex");
  run("expression nesting 110 (the node's cap)", nested(110), budgetFor(nested(110).length), ["decoded"]);
  run("expression nesting 100,000", nested(100000), budgetFor(nested(100000).length), ["stack", "trap", "fuel", "memory"]);
  run("expression nesting 1,000,000", nested(1000000), budgetFor(nested(1000000).length), ["stack", "trap", "fuel", "memory"]);
  run("truncated ordinary transaction", ordinary.bytes.subarray(0, ordinary.bytes.length - 1), budgetFor(ordinary.bytes.length - 1),
    ["parse", "import", "trap"]);
  run("ordinary transaction with a trailing byte", Buffer.concat([ordinary.bytes, Buffer.from([0])]), budgetFor(ordinary.bytes.length + 1),
    ["parse", "import", "trap", "noncanonical"]);
  const garbage = Buffer.alloc(65536);
  for (let i = 0, x = 0x9e3779b9; i < garbage.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; garbage[i] = x & 0xff; }
  run("65,536 pseudorandom bytes", garbage, budgetFor(garbage.length), ["parse", "import", "trap", "noncanonical", "fuel", "memory", "stack"]);
  run("input over the byte limit", Buffer.alloc(LIMITS.inputBytes + 1), budgetFor(LIMITS.inputBytes + 1), ["input"]);
  assert.throws(() => decodeContained("00"), TypeError);
  out.cases = cases;
  return out;
}

const report = { status: "passed", node: process.version, vendoredWasmSha256: VENDORED_SHA256, derivedWasmSha256: DERIVED_SHA256,
  limits: LIMITS, controls: controls(), decoder: decoder() };
const sources = ["contained-check.mjs", "contained-decoder.mjs", "contained-range.mjs", "wasm-meter.mjs", "decoder.mjs",
  "package.json", "package-lock.json", "fixtures/manifest.json", "vendor/ergo-lib-wasm-nodejs/SHA256SUMS", "vendor/ergo-lib-wasm-nodejs/ergo_lib_wasm.js"];
report.files = Object.fromEntries(sources.map(file => [`experiments/ergo-range/${file}`, sha256(readFileSync(join(here, file)))]));
if (option("--report")) {
  report.ranges = option("--ranges").split(",").map(file => {
    const range = JSON.parse(readFileSync(resolve(root, file)));
    assert.equal(range.derivedWasmSha256, DERIVED_SHA256, `${file} ran this derived module`);
    for (const [name, digest] of Object.entries(range.files)) assert.equal(digest, report.files[name] ?? sha256(readFileSync(join(root, name))), `${file} ran this ${name}`);
    const { files, ...summary } = range;
    return summary;
  });
}
const text = JSON.stringify(report, (_k, v) => typeof v === "bigint" ? String(v) : v, 2) + "\n";
if (option("--report")) writeFileSync(resolve(root, option("--report")), text);
process.stdout.write(text);
