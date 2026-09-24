// The decoder's stack needs. The npm alpha of sigma-rust 2f840d3 is a debug build (upstream builds its alphas with
// `wasm-pack build --dev`): its parser overflows Node's default stack on a node-valid mainnet transaction (block
// 1,827,841, fixture from the reader's own node) and on constants near the node's nesting cap of 110 (sigmastate
// MaxTreeDepth), traps on ErgoTree expression nesting of 50 at any stack, and after an overflow or trap its one instance
// traps on every call. The experiment pins the vendored release build of the same commit instead. This probe measures,
// each trial in a fresh process, for the pinned build and any control builds (the debug alpha, 0.28.0): the least
// --stack-size (KB) that parses the fixture transaction, an ordinary one and Coll^d[Byte] constants; the deepest
// LogicalNot expression nesting parsed at the largest stack the main thread holds; outcomes at the default stack; that
// an overflow poisons a debug instance; and that decoder.mjs decodes at the default stack and, on an output tree nested
// far beyond the node's cap (which only a dishonest source can present), fails closed and reports its instance poisoned.
// Offline and synthetic apart from the fixture; nothing is submitted; no runtime path reads this.
//
// Usage, from the repository root on Node 24 after the experiment's pinned install:
//   node experiments/ergo-range/stack-check.mjs [--control <dir>[,<dir>...]] [--out <report>]
//     each control directory holds node_modules/ergo-lib-wasm-nodejs (another build of the library).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serializeTransaction } from "@fleet-sdk/serializer";

const here = import.meta.dirname, root = resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const FIXTURE = "experiments/ergo-range/fixtures/mainnet-1827841.json";
const FIXTURE_SHA256 = "b5cccd71438a62a1af7e97ba8688ab7d641420cd0a24d4c61b4e41ca630f47d0", DEEP = 1, NODE_CAP = 110;
const DEPTHS = [25, 50, 75, 110, 150], MAX_KB = 7800, EXPR_MAX = 131072, HOSTILE_DEPTH = 100000;

// Child mode: one trial in this process, printing one word.
if (args[0] === "--child") {
  const [, task, libDir, ...rest] = args;
  const lib = createRequire(join(resolve(libDir), "package.json"))("ergo-lib-wasm-nodejs");
  const outcome = f => { try { f(); return "ok"; } catch (e) { return e instanceof RangeError ? "overflow" : e instanceof WebAssembly.RuntimeError ? "trap" : "error"; } };
  const parse = file => () => { const tx = lib.Transaction.sigma_parse_bytes(readFileSync(file)); tx.to_js_eip12(); tx.free(); };
  if (task === "parse") console.log(outcome(parse(rest[0])));
  // A v0 ErgoTree without constant segregation: BoolToSigmaProp (d1) over d nested LogicalNot (ef) over true (01 01).
  else if (task === "expr") console.log(outcome(() => lib.ErgoTree.from_base16_bytes("00d1" + "ef".repeat(Number(rest[0])) + "0101").free()));
  else if (task === "depth") console.log(outcome(() => lib.Constant.decode_from_base16("0c".repeat(Number(rest[0]) - 1) + "0e" + "01".repeat(Number(rest[0]) - 1) + "00").free()));
  else if (task === "poison") console.log(`${outcome(parse(rest[0]))},${outcome(parse(rest[1]))}`);
  process.exit(0);
}
if (args[0] === "--decoder") {
  // decoder.mjs itself under this process's stack: decode the first transaction, then an ordinary one.
  const [, firstFile, plainFile] = args;
  let decoder;
  try { decoder = await import(pathToFileURL(join(here, "decoder.mjs")).href); } catch { console.log("load-failed"); process.exit(0); }
  const first = (() => { try { return decoder.decodeTransaction(readFileSync(firstFile)) === undefined ? "refused" : "decoded"; }
    catch (e) { return e instanceof RangeError ? "overflow" : e instanceof WebAssembly.RuntimeError ? "trap" : "error"; } })();
  let second;
  try { second = decoder.decodeTransaction(readFileSync(plainFile)) === undefined ? "refused" : "decoded"; } catch (e) { second = /trapped earlier/.test(e.message) ? "poisoned" : "error"; }
  console.log(`loaded,${first},${second}`);
  process.exit(0);
}

// A trial that does not finish in time is its own outcome, never a success.
const TRIAL_TIMEOUT_MS = 120_000;
const run = (stackKb, childArgs) => {
  const r = spawnSync(process.execPath, [`--stack-size=${stackKb}`, join(here, "stack-check.mjs"), ...childArgs],
    { encoding: "utf8", timeout: TRIAL_TIMEOUT_MS, windowsHide: true });
  if (r.error?.code === "ETIMEDOUT") return "timeout";
  if (r.error !== undefined) throw r.error;
  return (r.stdout.trim().split("\n").at(-1) ?? "").trim() || `exit-${r.status}`;
};
// The least stack (KB, to 8) at which a trial succeeds, or null above MAX_KB.
const least = childArgs => {
  if (run(MAX_KB, childArgs) !== "ok") return null;
  let lo = 64, hi = MAX_KB;
  while (hi - lo > 8) { const m = (lo + hi) >> 1; if (run(m, childArgs) === "ok") hi = m; else lo = m; }
  return hi;
};

const text = readFileSync(join(root, FIXTURE));
assert.equal(sha256(text), FIXTURE_SHA256, "the fixture is the pinned block");
const block = JSON.parse(text), pinnedDir = here, controlDirs = (option("--control") ?? "").split(",").filter(Boolean).map(dir => resolve(root, dir));
const libOf = dir => createRequire(join(dir, "package.json"));
const pinnedLib = libOf(pinnedDir)("ergo-lib-wasm-nodejs");
const library = dir => ({ version: libOf(dir)("ergo-lib-wasm-nodejs/package.json").version,
  wasmSha256: sha256(readFileSync(libOf(dir).resolve("ergo-lib-wasm-nodejs/ergo_lib_wasm_bg.wasm"))),
  wasmBytes: readFileSync(libOf(dir).resolve("ergo-lib-wasm-nodejs/ergo_lib_wasm_bg.wasm")).length });

// Exact bytes of the deep transaction and an ordinary one, through the pinned serializer in this process (whose stack
// the usage line sets), checked against the node's ids.
const temp = mkdtempSync(join(tmpdir(), "stack-check-"));
const bytesOf = index => {
  const tx = block.blockTransactions.transactions[index], w = pinnedLib.Transaction.from_json(JSON.stringify(tx));
  try { assert.equal(w.id().to_str(), tx.id, `transaction ${index} serializes to the node's id`); const file = join(temp, `${index}.bin`); writeFileSync(file, w.sigma_serialize_bytes()); return file; }
  finally { w.free(); }
};
try {
  const deepFile = bytesOf(DEEP), plainFile = bytesOf(0);
  const deep = block.blockTransactions.transactions[DEEP];
  // Controls are named by their package version, so several can be measured side by side.
  const builds = { pinned: pinnedDir, ...Object.fromEntries(controlDirs.map(dir => [`control ${libOf(dir)("ergo-lib-wasm-nodejs/package.json").version}`, dir])) };
  const measured = Object.fromEntries(Object.entries(builds).map(([name, dir]) => [name, {
    library: library(dir),
    deepTransactionKb: least(["--child", "parse", dir, deepFile]),
    ordinaryTransactionKb: least(["--child", "parse", dir, plainFile]),
    nestedConstantKb: Object.fromEntries(DEPTHS.map(d => [d, least(["--child", "depth", dir, String(d)])])),
    // The deepest expression nesting that parses at the largest stack the main thread holds, found by bisection.
    expressionNestingMaxDepth: (() => { let lo = 1, hi = EXPR_MAX; if (run(MAX_KB, ["--child", "expr", dir, String(hi)]) === "ok") return `>=${hi}`;
      if (run(MAX_KB, ["--child", "expr", dir, "1"]) !== "ok") return 0;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (run(MAX_KB, ["--child", "expr", dir, String(m)]) === "ok") lo = m; else hi = m; } return lo; })(),
    // The same on the default stack, where the reader runs.
    expressionNestingMaxDepthAtDefault: (() => { let lo = 1, hi = EXPR_MAX; if (run(984, ["--child", "expr", dir, String(hi)]) === "ok") return `>=${hi}`;
      if (run(984, ["--child", "expr", dir, "1"]) !== "ok") return 0;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (run(984, ["--child", "expr", dir, String(m)]) === "ok") lo = m; else hi = m; } return lo; })(),
    expressionAtNodeCap: run(MAX_KB, ["--child", "expr", dir, String(NODE_CAP)]),
    atDefaultStack: { deepTransaction: run(984, ["--child", "parse", dir, deepFile]), nodeCapConstant: run(984, ["--child", "depth", dir, String(NODE_CAP)]) },
  }]));
  const perLevel = build => { const c = build.nestedConstantKb; return c[150] === null || c[25] === null ? null : +((c[150] - c[25]) / 125).toFixed(1); };
  const debug = Object.entries(measured).find(([name]) => /alpha/.test(name));
  // The poisoning of a debug instance: the fixture overflows it at the default stack, then an ordinary transaction traps.
  const poisoning = debug === undefined ? null
    : { build: debug[0], atDefaultStack: run(984, ["--child", "poison", builds[debug[0]], deepFile, plainFile]), note: "fixture then an ordinary transaction in one process" };
  // decoder.mjs at the default stack on the fixture; then on a transaction only a dishonest source could present, an
  // output tree nested HOSTILE_DEPTH levels (far beyond the node's cap), which must fail closed and poison the instance.
  const hostileFile = join(temp, "hostile.bin");
  // Fleet's writer has a fixed buffer, so the deep tree is spliced into bytes serialized around a short one; a v0 tree
  // without the size flag carries no length prefix, so the splice leaves a well-formed transaction.
  const tree = depth => "00d1" + "ef".repeat(depth) + "0101";
  const shortHex = Buffer.from(serializeTransaction({ inputs: [{ boxId: "11".repeat(32), spendingProof: { proofBytes: "", extension: {} } }], dataInputs: [],
    outputs: [{ value: 1000000n, ergoTree: tree(3), creationHeight: 1, assets: [], additionalRegisters: {} }] }).toBytes()).toString("hex");
  assert.equal(shortHex.split(tree(3)).length, 2, "the short tree occurs once in its transaction");
  assert.equal(shortHex.indexOf(tree(3)) % 2, 0, "the short tree starts on a byte boundary");
  writeFileSync(hostileFile, Buffer.from(shortHex.replace(tree(3), tree(HOSTILE_DEPTH)), "hex"));
  const decoderMjs = { atDefaultStack: run(984, ["--decoder", deepFile, plainFile]),
    hostile: { depth: HOSTILE_DEPTH, result: run(984, ["--decoder", hostileFile, plainFile]) } };
  const pinned = measured.pinned;
  const passed = pinned.atDefaultStack.deepTransaction === "ok" && pinned.atDefaultStack.nodeCapConstant === "ok"
    && pinned.expressionAtNodeCap === "ok" && (typeof pinned.expressionNestingMaxDepth === "string" || pinned.expressionNestingMaxDepth >= 256)
    && decoderMjs.atDefaultStack === "loaded,decoded,decoded" && /^loaded,(overflow|trap),poisoned$/.test(decoderMjs.hostile.result)
    && debug !== undefined && debug[1].atDefaultStack.deepTransaction === "overflow" && debug[1].expressionAtNodeCap === "trap"
    && poisoning.atDefaultStack === "overflow,trap";
  const report = {
    status: passed ? "pinned-release-build-reads-past-the-node-nesting-cap" : "unexpected",
    node: process.version, platform: `${process.platform} ${process.arch}`,
    fixture: { file: FIXTURE, sha256: FIXTURE_SHA256, height: block.header.height, headerId: block.header.id, source: "the reader's own mainnet node (v6.0.6), /blocks/{id}",
      transaction: { index: DEEP, id: deep.id, bytes: readFileSync(deepFile).length, outputs: deep.outputs.length, largestTreeBytes: Math.max(...deep.outputs.map(o => o.ergoTree.length / 2)) } },
    nodeNestingCap: { depth: NODE_CAP, source: "sigmastate-interpreter SigmaConstants.MaxTreeDepth, enforced by CoreByteReader for nested value deserialization" },
    builds: measured, perLevelKb: Object.fromEntries(Object.entries(measured).map(([name, build]) => [name, perLevel(build)])), poisoning, decoderMjs,
    defaultStackKb: 984, mainThreadMaxKb: MAX_KB,
    files: Object.fromEntries(["experiments/ergo-range/stack-check.mjs", "experiments/ergo-range/decoder.mjs", "experiments/ergo-range/package-lock.json"].map(f => [f, sha256(readFileSync(join(root, f)))])),
    limitations: [
      "Stack sizes are V8 --stack-size values on one Windows desktop with Node's 8 MB main-thread stack; they bound this build's recursion on these inputs, not every path through the parser.",
      "Two recursion paths were constructed: collection nesting in a constant, and LogicalNot nesting in an ErgoTree, which the debug alpha fails at a fixed depth whatever the V8 stack (consistent with exhausting the module's own linear-memory stack; not proven). Other expression forms were not swept.",
      "No transaction carrying such a tree was submitted to a node; that the node accepts expression nesting to 110 rests on its source (CoreByteReader's depth check). Bytes nested far beyond the cap, which only a dishonest source can present, can still exhaust any build's stack and then fail closed.",
      "No runtime path, decoder selection or profile selection follows from this probe.",
    ],
  };
  const out = option("--out"), textOut = `${JSON.stringify(report, null, 2)}\n`;
  if (out) writeFileSync(resolve(root, out), textOut);
  process.stdout.write(textOut);
  if (!passed) process.exitCode = 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
