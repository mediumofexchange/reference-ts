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
import { spawnSync } from "node:child_process";
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
  const bodies = functions.map(f => { const body = [...(f.locals ?? [0x00]), ...f.code]; return [...leb(body.length), ...body]; });
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)), ...section(3, vec(functions.map((_, i) => leb(i)))),
    ...section(4, vec([[EXTERNREF, 0x00, 0x01]])), ...section(5, vec([[0x00, 0x01]])),
    ...section(6, vec([[I32, 0x00, 0x41, 0x00, 0x0b]])),
    ...section(7, vec([...functions.map((f, i) => [...leb(f.name.length), ...Buffer.from(f.name), 0x00, ...leb(i)]),
      [6, ...Buffer.from("memory"), 0x02, 0x00]])),
    ...extra, ...section(10, vec(bodies))]);
}
// Each function's expected charges are counted by hand here, independently of the rewriter's walker. A helper
// charges its own instructions plus ten on entry: copy and fill 18 (a 13-instruction extent charge, three local.get,
// the operation, end), grow 29 (a 13-instruction ceiling test, the extent charge, local.get, memory.grow, end),
// table.grow 30 and table.fill 18.
const CONTROL = [
  // Function region: loop, end (final) = 2. Loop region: br 0, end = 2.
  { name: "spin", params: [], results: [], code: [0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b] },
  // local.get, local.get, i32.add, end = 4.
  { name: "add", params: [I32, I32], results: [I32], code: [0x20, 0, 0x20, 1, 0x6a, 0x0b] },
  // local.get, memory.grow (a helper call once metered), end = 3; with the helper, 13 + 39.
  { name: "grow", params: [I32], results: [I32], code: [0x20, 0, 0x40, 0x00, 0x0b] },
  // Three local.get, the operation, end = 5; with the helper, 15 + 28.
  { name: "copy", params: [I32, I32, I32], results: [], code: [0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 10, 0, 0, 0x0b] },
  { name: "fill", params: [I32, I32, I32], results: [], code: [0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 11, 0, 0x0b] },
  // ref.null, local.get, table.grow, end = 4; with the helper, 14 + 40.
  { name: "tgrow", params: [I32], results: [I32], code: [0xd0, EXTERNREF, 0x20, 0, 0xfc, 15, 0, 0x0b] },
  // local.get, ref.null, local.get, table.fill, end = 5; with the helper, 15 + 28.
  { name: "tfill", params: [I32, I32], results: [], code: [0x20, 0, 0xd0, EXTERNREF, 0x20, 1, 0xfc, 17, 0, 0x0b] },
  // call (1 + 21 around it), end = 23 per frame.
  { name: "recurse", params: [], results: [], code: [0x10, 7, 0x0b] },
  // Function region: block, loop, end, end = 4. Loop region: local.get, i32.eqz, br_if 1, local.get, i32.const 1,
  // i32.sub, local.set, br 0, end = 9; entered n + 1 times.
  { name: "count", params: [I32], results: [], code: [0x02, 0x40, 0x03, 0x40, 0x20, 0, 0x45, 0x0d, 1, 0x20, 0, 0x41, 1, 0x6b, 0x21, 0, 0x0c, 0, 0x0b, 0x0b, 0x0b] },
  // Nested loops with a branch out of an if to the outer loop and a br_table back to the inner one:
  //   block; loop L1: n == 0 ? exit; n -= 1; j = 2; loop L2: if j == 0 { br L1 } else { j -= 1 }; br_table [L2] L2
  // Function region: block, loop, end, end = 4. L1: local.get, i32.eqz, br_if 1, local.get, i32.const, i32.sub,
  // local.set, i32.const, local.set, loop, end = 11. L2: local.get, i32.eqz, if, br 2, else, local.get, i32.const,
  // i32.sub, local.set, end, local.get, br_table, end = 13. L1 is entered n + 1 times and L2 three times per pass.
  { name: "nest", params: [I32], results: [], locals: [0x01, 0x01, I32], code: [0x02, 0x40, 0x03, 0x40,
    0x20, 0, 0x45, 0x0d, 1, 0x20, 0, 0x41, 1, 0x6b, 0x21, 0, 0x41, 2, 0x21, 1,
    0x03, 0x40, 0x20, 1, 0x45, 0x04, 0x40, 0x0c, 2, 0x05, 0x20, 1, 0x41, 1, 0x6b, 0x21, 1, 0x0b, 0x20, 1, 0x0e, 1, 0, 0, 0x0b,
    0x0b, 0x0b, 0x0b] },
];
function controls() {
  const plain = assemble(CONTROL);
  assert(WebAssembly.validate(plain), "the control module validates");
  const { bytes } = meter(plain);
  const module = new WebAssembly.Module(bytes);
  const BIG = 10n ** 9n;
  const fresh = (fuel = BIG, pages = 2n, elements = 4n, depth = 1n << 32n) => {
    const e = new WebAssembly.Instance(module, {}).exports;
    e[METER_EXPORTS.fuel].value = fuel; e[METER_EXPORTS.memoryPages].value = pages; e[METER_EXPORTS.tableElements].value = elements;
    e[METER_EXPORTS.depthLimit].value = depth;
    return e;
  };
  const used = (e, fuel = BIG) => fuel - e[METER_EXPORTS.fuel].value;
  const cost = (name, ...args) => { const e = fresh(); e[name](...args); return used(e); };
  const out = {};
  // Straight line: exactly the region plus the charge, and nothing is left for a second call at that budget.
  let e = fresh(4n + C);
  assert.equal(e.add(2, 3), 5);
  assert.equal(used(e, 4n + C), 4n + C);
  assert.throws(() => e.add(1, 1), WebAssembly.RuntimeError);
  assert(e[METER_EXPORTS.fuel].value < 0n, "exhaustion leaves the fuel negative");
  out.straightLine = { perCall: String(4n + C) };
  // Loops: the function region once and each loop region per entry, exactly.
  for (const n of [0, 1, 1000]) assert.equal(cost("count", n), 4n + C + BigInt(n + 1) * (9n + C), `count(${n})`);
  for (const n of [0, 1, 7]) assert.equal(cost("nest", n), 4n + C + BigInt(n + 1) * (11n + C) + BigInt(3 * n) * (13n + C), `nest(${n})`);
  out.loops = { count: "14 + 19(n + 1)", nest: "14 + 21(n + 1) + 23 * 3n", checked: { count: [0, 1, 1000], nest: [0, 1, 7] } };
  // An infinite loop stops at every budget, with exactly the charges that fit.
  for (const fuel of [0n, 1n, 11n, 12n, 13n, 1000n, 1000000n]) {
    e = fresh(fuel);
    assert.throws(() => e.spin(), WebAssembly.RuntimeError);
    const charges = fuel / 12n + 1n;
    assert.equal(e[METER_EXPORTS.fuel].value, fuel - charges * 12n, `spin at ${fuel}`);
  }
  out.infiniteLoop = { stopsAt: [0, 1, 11, 12, 13, 1000, 1000000], perIteration: String(2n + C) };
  // Growth: allowed up to the ceiling at 8,192 per page; beyond it -1, no growth, the flag, and still the helper's cost.
  assert.equal(cost("grow", 0), 13n + 39n);
  e = fresh(BIG, 2n);
  assert.equal(e.grow(1), 1);
  assert.equal(used(e), 13n + 39n + 8192n);
  assert.equal(e.grow(1), -1);
  assert.equal(used(e), 2n * (13n + 39n) + 8192n, "a refused growth pays the helper, not the extent");
  assert.equal(e.memory.buffer.byteLength, 2 * 65536, "the refused growth left the memory at the ceiling");
  assert.equal(e[METER_EXPORTS.refused].value, REFUSED_MEMORY);
  e = fresh(BIG, 2n);
  assert.equal(e.grow(0xffffffff), -1, "a growth past the ceiling by any amount is refused");
  assert.equal(e[METER_EXPORTS.refused].value, REFUSED_MEMORY);
  out.memoryGrowth = { call: 52, perPage: 8192, refusedFlag: REFUSED_MEMORY };
  // Bulk copy and fill: 43 per call and a unit per 8 bytes, and stopped by fuel one unit short.
  for (const name of ["copy", "fill"]) {
    assert.equal(cost(name, 0, 0, 0), 15n + 28n, `${name} of nothing`);
    assert.equal(cost(name, 0, 0, 65536), 15n + 28n + 8192n, `${name} of 65,536 bytes`);
    e = fresh(15n + 28n + 8191n);
    assert.throws(() => e[name](0, 0, 65536), WebAssembly.RuntimeError, `${name} short of fuel`);
    assert(e[METER_EXPORTS.fuel].value < 0n, `${name} stopped by fuel, not bounds`);
  }
  out.bulk = { call: 43, perEightBytes: 1 };
  // Tables: 54 per growth and one per element, a refusal past the ceiling at the helper's cost; fill 43 and one per
  // element.
  e = fresh(BIG, 2n, 4n);
  assert.equal(e.tgrow(3), 1);
  assert.equal(used(e), 14n + 40n + 3n);
  assert.equal(e.tgrow(1), -1);
  assert.equal(used(e), 2n * (14n + 40n) + 3n);
  assert.equal(e[METER_EXPORTS.refused].value, REFUSED_TABLE);
  e = fresh(BIG, 2n, 4n); e.tgrow(3); const before = e[METER_EXPORTS.fuel].value;
  e.tfill(0, 4);
  assert.equal(before - e[METER_EXPORTS.fuel].value, 15n + 28n + 4n);
  out.tables = { grow: 54, fill: 43, perElement: 1, refusedFlag: REFUSED_TABLE };
  // Recursion stops at the depth ceiling, exactly: frames 0..L entered, 33 fuel each; then by fuel when that is
  // shorter; and only past both, with no ceiling, by the engine's stack.
  for (const limit of [0n, 1n, 100n, 4096n]) {
    e = fresh(BIG, 2n, 4n, limit);
    assert.throws(() => e.recurse(), WebAssembly.RuntimeError);
    assert.equal(e[METER_EXPORTS.depth].value, limit + 1n);
    assert.equal(e[METER_EXPORTS.depthMax].value, limit + 1n);
    assert.equal(used(e), (limit + 1n) * (23n + C), `recursion to ${limit}`);
    assert(e[METER_EXPORTS.fuel].value >= 0n);
  }
  e = fresh(1000n, 2n, 4n, 4096n);
  assert.throws(() => e.recurse(), WebAssembly.RuntimeError);
  assert(e[METER_EXPORTS.fuel].value < 0n);
  e = fresh(10n ** 12n);
  assert.throws(() => e.recurse(), RangeError);
  out.recursion = { perFrame: 33, depthCeilings: [0, 1, 100, 4096], shortOfFuel: "fuel", noCeiling: "engine stack" };
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
// A v0 tree without the size flag: BoolToSigmaProp over `depth` nested LogicalNot over true, spliced into a
// transaction serialized around a short one (the tree carries no length prefix).
const tree = depth => "00d1" + "ef".repeat(depth) + "0101";
const shortHex = Buffer.from(serializeTransaction({ inputs: [{ boxId: "11".repeat(32), spendingProof: { proofBytes: "", extension: {} } }], dataInputs: [],
  outputs: [{ value: 1000000n, ergoTree: tree(3), creationHeight: 1, assets: [], additionalRegisters: {} }] }).toBytes()).toString("hex");
assert.equal(shortHex.split(tree(3)).length, 2);
const nested = depth => Buffer.from(shortHex.replace(tree(3), tree(depth)), "hex");
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
    cases[name] = { bytes: bytes.length, outcome: result.refused ?? "decoded", fuel: String(result.fuel), memoryBytes: result.memoryBytes,
      depth: String(result.depth) };
    return result;
  };
  run("fuel of 1,000", ordinary.bytes, { ...base, fuel: 1000n }, ["fuel"]);
  run("no memory growth", ordinary.bytes, { ...base, memoryPages: 0n }, ["memory"]);
  run("one fuel short of the ordinary transaction's need", ordinary.bytes,
    { ...base, fuel: decodeContained(ordinary.bytes).fuel - 1n }, ["fuel"]);
  run("exactly the ordinary transaction's need", ordinary.bytes, { ...base, fuel: decodeContained(ordinary.bytes).fuel }, ["decoded"]);
  const atCap = run("expression nesting 110 (the node's cap)", nested(110), budgetFor(nested(110).length), ["decoded"]);
  assert(atCap.depth * 4n < budgetFor(0).depth, "the node's cap needs under a quarter of the depth ceiling");
  for (const depth of [2000, 100000, 1000000]) {
    const refused = run(`expression nesting ${depth.toLocaleString("en-US")}`, nested(depth), budgetFor(nested(depth).length), ["depth"]);
    assert.equal(refused.depth, budgetFor(0).depth + 1n, "stopped one frame past the ceiling");
  }
  run("truncated ordinary transaction", ordinary.bytes.subarray(0, ordinary.bytes.length - 1), budgetFor(ordinary.bytes.length - 1),
    ["parse", "import", "trap"]);
  run("ordinary transaction with a trailing byte", Buffer.concat([ordinary.bytes, Buffer.from([0])]), budgetFor(ordinary.bytes.length + 1),
    ["parse", "import", "trap", "noncanonical"]);
  const garbage = Buffer.alloc(65536);
  for (let i = 0, x = 0x9e3779b9; i < garbage.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; garbage[i] = x & 0xff; }
  run("65,536 pseudorandom bytes", garbage, budgetFor(garbage.length), ["parse", "import", "trap", "noncanonical", "fuel", "memory", "depth"]);
  run("input over the byte limit", Buffer.alloc(LIMITS.inputBytes + 1), budgetFor(LIMITS.inputBytes + 1), ["input"]);
  assert.throws(() => decodeContained("00"), TypeError);
  // Shadowed properties change neither what is copied nor the budget, which follow the view's own bytes.
  const shadowed = new Uint8Array(ordinary.bytes);
  Object.defineProperty(shadowed, "length", { value: 1_000_000 });
  shadowed[Symbol.iterator] = function* () { yield 0; };
  assert(isDeepStrictEqual(plainView(decodeContained(shadowed).view), expectedOrdinary), "a shadowed view decodes as its own bytes");
  assert.equal(decodeContained(shadowed, { ...base, fuel: decodeContained(ordinary.bytes).fuel - 1n }).refused, "fuel");
  out.cases = cases;
  out.corpus.maxDepth = String(corpus.reduce((m, { bytes }) => { const d = decodeContained(bytes).depth; return d > m ? d : m; }, 0n));
  // The engine stack the depth ceiling needs: the least --stack-size (KB, to 8) at which a tree nested past the ceiling
  // still refuses as "depth" rather than as an engine overflow, each trial a fresh process with a shallow caller.
  const trial = kb => {
    const r = spawnSync(process.execPath, [`--stack-size=${kb}`, join(here, "contained-check.mjs"), "--headroom-child"], { encoding: "utf8", timeout: 120000, windowsHide: true });
    return r.stdout.trim() || `exit-${r.status}`;
  };
  assert.equal(trial(984), "depth", "the default stack holds the depth ceiling");
  let lo = 64, hi = 984;
  while (hi - lo > 8) { const mid = (lo + hi) >> 1; if (trial(mid) === "depth") hi = mid; else lo = mid; }
  out.depthCeiling = { frames: String(budgetFor(0).depth), leastStackKb: hi, defaultStackKb: 984, nodeCapFrames: String(atCap.depth),
    meaning: "a caller leaving at least this much of V8's stack gets a depth refusal that depends on the bytes alone" };
  return out;
}

if (args[0] === "--headroom-child") {
  process.stdout.write(`${decodeContained(nested(2000)).refused ?? "decoded"}
`);
  process.exit(0);
}

const report = { status: "passed",
  equivalence: "Over the week and the retained blocks the contained decoder's fields equal the node's; the retained blocks' earlier report shows decoder.mjs's equal the node's there, so the two decoders agree transitively. The id comparison binds the rebuilt bytes to the node's statement; the witness id passes through the shared serializer, so its comparison is weaker.", node: process.version, vendoredWasmSha256: VENDORED_SHA256, derivedWasmSha256: DERIVED_SHA256,
  limits: LIMITS, controls: controls(), decoder: decoder() };
const sources = ["contained-check.mjs", "contained-decoder.mjs", "contained-range.mjs", "wasm-meter.mjs", "decoder.mjs",
  "package.json", "package-lock.json", "fixtures/manifest.json", "vendor/ergo-lib-wasm-nodejs/SHA256SUMS", "vendor/ergo-lib-wasm-nodejs/ergo_lib_wasm.js"];
report.files = Object.fromEntries(sources.map(file => [`experiments/ergo-range/${file}`, sha256(readFileSync(join(here, file)))]));
if (option("--report")) {
  report.ranges = option("--ranges").split(",").map(file => {
    const range = JSON.parse(readFileSync(resolve(root, file)));
    assert.equal(range.derivedWasmSha256, DERIVED_SHA256, `${file} ran this derived module`);
    for (const [name, digest] of Object.entries(range.files)) assert.equal(digest, report.files[name] ?? sha256(readFileSync(join(root, name))), `${file} ran this ${name}`);
    assert.equal(range.budget, "reader", `${file} ran under the reader's budget`);
    assert.equal(range.status, "every-transaction-decoded-with-the-nodes-fields", `${file} decoded every transaction with the node's fields`);
    assert(range.counts.refused === 0 && range.counts.differing === 0 && range.counts.transactions > 0, `${file} has no refusal or difference`);
    const { files, ...summary } = range;
    return summary;
  });
  report.totals = { transactions: report.ranges.reduce((sum, r) => sum + r.counts.transactions, 0),
    outputs: report.ranges.reduce((sum, r) => sum + r.counts.outputs, 0), refused: 0, differing: 0,
    leastBudgetMargin: Math.min(...report.ranges.map(r => r.observed.leastBudgetMargin)) };
  report.limitations = [
    "The budget is calibrated on valid transactions with margin; nothing shows that no node-valid transaction exceeds it, and one that does is refused, denying the ranges through its block.",
    "Fuel bounds guest instructions, not CPU seconds; instantiation, copies and JSON parsing are host work outside it.",
    "Linear-memory and table ceilings bound each instance, not the process: a dropped instance's memory stays until V8 collects it.",
    "A depth refusal depends on the bytes alone only where the caller leaves the measured V8 stack; below that an engine overflow refuses as stack.",
    "Valid transactions and synthetic hostile inputs only; node equivalence for hostile inputs is not established, and no decoder, budget or profile is selected.",
  ];
}
const text = JSON.stringify(report, (_k, v) => typeof v === "bigint" ? String(v) : v, 2) + "\n";
if (option("--report")) writeFileSync(resolve(root, option("--report")), text);
process.stdout.write(text);
