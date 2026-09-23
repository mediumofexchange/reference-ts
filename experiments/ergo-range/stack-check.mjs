// The pinned decoder's stack budget. The pinned sigma-rust build (0.29.0-alpha-2f840d3) is a debug build whose parser
// recurses with far larger frames than a release build; a stack overflow inside its WASM leaves the module's one
// instance unusable, and every later call traps. This probe measures, each trial in a fresh process: the least
// --stack-size (KB) at which the pinned build (and optionally a control build) parses a real mainnet transaction that
// overflows Node's default stack (block 1,827,841, fixture from the reader's own node), and a constant nested to depth d
// (Coll^d[Byte]) for depths around the node's nesting cap of 110 (sigmastate MaxTreeDepth); the deepest ErgoTree
// expression nesting each build parses at the largest stack the main thread holds (the pinned build fails at a fixed
// depth below the cap whatever the V8 stack); that an overflow poisons the instance; that decoder.mjs refuses to load
// below its budget; and that under its budget an overflow inside it is fatal and poisons it rather than reading as a
// refusal. Offline and synthetic apart from the fixture; nothing is submitted; no runtime path reads this.
//
// Usage, from the repository root on Node 24 after the experiment's pinned install:
//   node --stack-size=4000 experiments/ergo-range/stack-check.mjs [--control <dir with another ergo-lib-wasm-nodejs>] [--out <report>]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname, root = resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const FIXTURE = "experiments/ergo-range/fixtures/mainnet-1827841.json";
const FIXTURE_SHA256 = "b5cccd71438a62a1af7e97ba8688ab7d641420cd0a24d4c61b4e41ca630f47d0", DEEP = 1, NODE_CAP = 110;
const DEPTHS = [25, 50, 75, 110, 150], MAX_KB = 7800;

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
  // decoder.mjs itself: load under whatever stack this process has; optionally burn JS stack before decoding the deep
  // transaction so the overflow happens inside the module, then decode an ordinary transaction.
  const [, burnArg, deepFile, plainFile] = args;
  let decoder;
  try { decoder = await import(pathToFileURL(join(here, "decoder.mjs")).href); } catch (e) { console.log(`load-refused:${/stack-size/.test(e.message)}`); process.exit(0); }
  const first = (() => { const burn = n => n === 0 ? decoder.decodeTransaction(readFileSync(deepFile)) : [burn(n - 1)][0];
    try { return burn(Number(burnArg)) === undefined ? "refused" : "decoded"; } catch (e) { return e instanceof RangeError ? "overflow" : e instanceof WebAssembly.RuntimeError ? "trap" : "error"; } })();
  let second;
  try { second = decoder.decodeTransaction(readFileSync(plainFile)) === undefined ? "refused" : "decoded"; } catch (e) { second = /trapped earlier/.test(e.message) ? "poisoned" : "error"; }
  console.log(`loaded,${first},${second}`);
  process.exit(0);
}

const run = (stackKb, childArgs) => {
  const r = spawnSync(process.execPath, [`--stack-size=${stackKb}`, join(here, "stack-check.mjs"), ...childArgs], { encoding: "utf8" });
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
const block = JSON.parse(text), pinnedDir = here, controlDir = option("--control") === undefined ? undefined : resolve(root, option("--control"));
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
  const builds = { pinned: pinnedDir, ...(controlDir ? { control: controlDir } : {}) };
  const measured = Object.fromEntries(Object.entries(builds).map(([name, dir]) => [name, {
    library: library(dir),
    deepTransactionKb: least(["--child", "parse", dir, deepFile]),
    ordinaryTransactionKb: least(["--child", "parse", dir, plainFile]),
    nestedConstantKb: Object.fromEntries(DEPTHS.map(d => [d, least(["--child", "depth", dir, String(d)])])),
    // The deepest expression nesting that parses at the largest stack the main thread holds, found by bisection.
    expressionNestingMaxDepth: (() => { let lo = 1, hi = 256; if (run(MAX_KB, ["--child", "expr", dir, String(hi)]) === "ok") return `>=${hi}`;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (run(MAX_KB, ["--child", "expr", dir, String(m)]) === "ok") lo = m; else hi = m; } return lo; })(),
    expressionAtNodeCap: run(MAX_KB, ["--child", "expr", dir, String(NODE_CAP)]),
    atDefaultStack: { deepTransaction: run(984, ["--child", "parse", dir, deepFile]), nodeCapConstant: run(984, ["--child", "depth", dir, String(NODE_CAP)]) },
  }]));
  const p = measured.pinned.nestedConstantKb, perLevelKb = +((p[150] - p[25]) / 125).toFixed(1);
  const poisoning = { atDefaultStack: run(984, ["--child", "poison", pinnedDir, deepFile, plainFile]), note: "deep transaction then an ordinary one in one process" };
  const decoderMjs = {
    belowBudget: run(3000, ["--decoder", "0", deepFile, plainFile]),
    atBudget: run(4000, ["--decoder", "0", deepFile, plainFile]),
    // Enough JS frames to leave less stack than the deep transaction needs, so the overflow happens inside the module.
    overflowInside: run(4000, ["--decoder", "30000", deepFile, plainFile]),
  };
  const passed = measured.pinned.atDefaultStack.deepTransaction === "overflow" && poisoning.atDefaultStack === "overflow,trap"
    && measured.pinned.expressionAtNodeCap === "trap"
    && decoderMjs.belowBudget === "load-refused:true" && decoderMjs.atBudget === "loaded,decoded,decoded"
    && decoderMjs.overflowInside === "loaded,overflow,poisoned" && measured.pinned.nestedConstantKb[NODE_CAP] < 4000;
  const report = {
    status: passed ? "pinned-decoder-traps-below-the-node-nesting-cap" : "unexpected",
    node: process.version, platform: `${process.platform} ${process.arch}`,
    fixture: { file: FIXTURE, sha256: FIXTURE_SHA256, height: block.header.height, headerId: block.header.id, source: "the reader's own mainnet node (v6.0.6), /blocks/{id}",
      transaction: { index: DEEP, id: deep.id, bytes: readFileSync(deepFile).length, outputs: deep.outputs.length, largestTreeBytes: Math.max(...deep.outputs.map(o => o.ergoTree.length / 2)) } },
    nodeNestingCap: { depth: NODE_CAP, source: "sigmastate-interpreter SigmaConstants.MaxTreeDepth, enforced by CoreByteReader for nested value deserialization" },
    builds: measured, pinnedPerLevelKb: perLevelKb, poisoning, decoderMjs, decoderBudgetKb: 4000, mainThreadMaxKb: MAX_KB,
    files: Object.fromEntries(["experiments/ergo-range/stack-check.mjs", "experiments/ergo-range/decoder.mjs", "experiments/ergo-range/package-lock.json"].map(f => [f, sha256(readFileSync(join(root, f)))])),
    limitations: [
      "Stack sizes are V8 --stack-size values on one Windows desktop with Node's 8 MB main-thread stack; they bound this build's recursion on these inputs, not every path through the parser.",
      "Two recursion paths were constructed: collection nesting in a constant, whose need grows with the V8 stack, and LogicalNot nesting in an ErgoTree, which the pinned build fails at a fixed depth whatever the V8 stack (consistent with exhausting the module's own linear-memory stack; not proven). Other expression forms were not swept.",
      "No transaction carrying such a tree was submitted to a node; that the node accepts expression nesting to 110 rests on its source (CoreByteReader's depth check).",
      "The node's cap of 110 bounds what a node accepts; a source can present bytes nested deeper, which the budget does not cover and which then fail closed as a trap.",
      "No runtime path, decoder selection or profile selection follows from this probe.",
    ],
  };
  const out = option("--out"), textOut = `${JSON.stringify(report, null, 2)}\n`;
  if (out) writeFileSync(resolve(root, out), textOut);
  process.stdout.write(textOut);
  if (!passed) process.exitCode = 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
