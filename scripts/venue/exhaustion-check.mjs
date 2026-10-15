// The exhaustion circuits' execution check (succinct-read §4.3), over the circuits compiled at small slot counts from
// the same sources as the full-size set: every leaf of synthetic periods and of recorded mainnet blocks executes, the
// leaves join end to start, a period ends where a fold requires with the map's root equal to src/ergo-exhaustion.ts'
// SubjectMap; and hostile witnesses, each otherwise consistent with the state hashes, are refused by the named check.
// Folds are executed with placeholder proofs and key hashes: execution checks every constraint but the recursive
// verifications, which the proving check (exhaustion-prove.mjs) covers.
//
//   node scripts/venue/exhaustion-check.mjs [--mainnet <recorded blocks.json>] [--report <file>]
//
// Run after `npm run build`. With NARGO set it also compares nargo's bytecode with the pinned noir_wasm's.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { blake2b } from "@noble/hashes/blake2b.js";
import { Noir } from "@noir-lang/noir_js";
import { build, compile, EXHAUSTION_SPECIFICATION, root, sourceHashes } from "./exhaustion-build.mjs";
import { foldFirst, foldNext, node as nodeSource } from "./exhaustion-sources.mjs";
import { craftedTransactions, recordedPeriod, syntheticPeriod } from "./exhaustion-periods.mjs";
import { scanTransaction } from "../../dist/ergo-scan.js";
import { EMPTY_SUBTREES, SubjectMap } from "../../dist/ergo-exhaustion.js";
import { foldStateInputs, isPeriodEnd, mapUpdateLeaf, periodLeaves, periodStreams, startState, stateEnd, transactionLeaf, treeLeaf }
  from "../../dist/ergo-exhaustion-prover.js";
import { identifierOf, limbsOf } from "../../dist/pool/field.js";

const argv = process.argv.slice(2);
const option = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const SIZES = { t: 6, m: 12, u: 6 };
const KEYS = { t: "0x01", m: "0x02", u: "0x03", n: "0x04" }, FOLD_KEY = 5n, FIRST_KEY = "0x06";
const report = { specification: EXHAUSTION_SPECIFICATION, sources: sourceHashes(), sizes: SIZES, periods: [], hostile: [], folds: [] };
let failed = 0;
const fail = message => { failed++; console.error(`FAIL ${message}`); };

const built = await build({ CT: SIZES.t, CM: SIZES.m, E: SIZES.u }, { directory: path.join(root, "scratch/exhaustion/check"), log: () => {} });
if (process.env.NARGO) {
  for (const name of ["leaf-t", "leaf-m", "leaf-u"]) {
    const project = path.join(built.directory, name);
    const wasm = JSON.parse(readFileSync(path.join(project, "program.json"), "utf8")).bytecode;
    execFileSync(process.env.NARGO, ["compile", "--program-dir", project], { stdio: "ignore" });
    const native = JSON.parse(readFileSync(path.join(project, "target", `moe_succinct_exhaustion_${name.replaceAll("-", "_")}.json`), "utf8")).bytecode;
    report.nargoEqualsWasm = (report.nargoEqualsWasm ?? true) && native === wasm;
    if (native !== wasm) fail(`${name}: nargo's bytecode differs from noir_wasm's`);
  }
}
const load = name => new Noir(JSON.parse(readFileSync(path.join(built.directory, name, "program.json"), "utf8")));
const leaf = { t: load("leaf-t"), m: load("leaf-m"), u: load("leaf-u") };
const emptyRoot = "0x" + EMPTY_SUBTREES[32].toString(16);
const first = new Noir(await compile(built.directory, "fold-first", foldFirst(KEYS, emptyRoot)));
const next = new Noir(await compile(built.directory, "fold-next", foldNext(KEYS, FIRST_KEY)));

/** Execute; the refusal's message, or undefined where it executes. */
async function refusal(program, inputs) {
  try { await program.execute(inputs); return undefined; } catch (error) {
    const text = String(error?.message ?? error);
    return text.replace(/^.*Circuit execution failed: /s, "").split("\n")[0] || text;
  }
}
const dec = x => x.toString();
function foldInputs(start, end, startOf, map, extra = {}) {
  const [sh, sl] = limbsOf(startOf.id), { id, height } = stateEnd(end), [eh, el] = limbsOf(id);
  return { start_hi: dec(sh), start_lo: dec(sl), start_height: dec(startOf.height), end_hi: dec(eh), end_lo: dec(el), end_height: dec(height),
    map_root: dec(map.root), fold_key_hash: dec(FOLD_KEY), key: Array(115).fill("0"), proof: Array(458).fill("0"), key_hash: KEYS.n,
    ...foldStateInputs(start, "0"), ...foldStateInputs(end, "1"), ...extra };
}

/** A period's honest leaves executed and joined, its end checked against the map, and its fold executed. */
async function period(label, p, periods = 1) {
  const map = new SubjectMap(p.start.id, p.start.height);
  const per = Math.ceil(p.blocks.length / periods);
  let leaves = 0, entries = 0, previousEnd;
  for (let k = 0; k < periods; k++) {
    const blocks = p.blocks.slice(k * per, (k + 1) * per);
    const startOf = map.end;
    const run = periodLeaves(map, blocks, SIZES, BigInt(KEYS.n));
    let joined = run.leaves[0]?.sin;
    for (const [i, l] of run.leaves.entries()) {
      if (l.sin !== joined) fail(`${label}: leaf ${i} does not join`);
      joined = l.sout;
      const why = await refusal(leaf[l.kind], l.inputs);
      if (why !== undefined) fail(`${label}: honest leaf ${i} (${l.kind}) refused: ${why}`);
      if (l.kind === "u") entries += l.inputs.uu.filter(Boolean).length;
    }
    leaves += run.leaves.length;
    if (!isPeriodEnd(run.end)) fail(`${label}: the period does not end at a block boundary`);
    if (run.end.u.root !== map.root) fail(`${label}: the leaves' map root is not the SubjectMap's`);
    if (Buffer.compare(Buffer.from(stateEnd(run.end).id), Buffer.from(blocks.at(-1).id)) !== 0) fail(`${label}: the period ends elsewhere`);
    const why = k === 0
      ? await refusal(first, foldInputs(run.start, run.end, p.start, map))
      : await refusal(next, foldInputs(run.start, run.end, p.start, map, { previous_key: Array(115).fill("0"), previous_proof: Array(458).fill("0"), previous_key_hash: FIRST_KEY }));
    if (why !== undefined) fail(`${label}: honest fold ${k} refused: ${why}`);
    previousEnd = run;
  }
  const transactions = p.blocks.reduce((n, b) => n + b.transactions.length, 0);
  report.periods.push({ label, blocks: p.blocks.length, periods, transactions, leaves, entries });
  console.log(`${label}: ${p.blocks.length} blocks, ${transactions} transactions, ${leaves} leaves, ${entries} entries in ${periods} period(s)`);
  return previousEnd;
}

// Honest periods: synthetic (both root rules, shaped outputs for keys shared and not, an ungrammatical transaction),
// the same as two periods (a next fold), and recorded mainnet blocks.
const synthetic = syntheticPeriod(9);
await period("synthetic", synthetic);
await period("synthetic in two periods", synthetic, 2);
if (option("--mainnet")) await period("mainnet", recordedPeriod(option("--mainnet")));

// Hostile witnesses: each a leaf the prover builds consistently but for one departure, refused by the named check.
async function hostile(name, kind, built, expected) {
  const why = await refusal(leaf[kind], built.leaf.inputs);
  report.hostile.push({ name, kind, refusal: why ?? null, expected });
  if (why === undefined) fail(`hostile ${name}: executes`);
  else if (expected !== undefined && !why.includes(expected)) fail(`hostile ${name}: refused by "${why}", not "${expected}"`);
  else console.log(`hostile ${name}: refused (${why})`);
}
const p = syntheticPeriod(3);
const map0 = new SubjectMap(p.start.id, p.start.height);
const s0 = startState(p.start.id, p.start.height, map0.root);
const { t: tSlots, m: mOps } = periodStreams(p.blocks);
const node = BigInt(KEYS.n);
const firstSlots = tSlots.slice(0, SIZES.t);
const honestT = transactionLeaf(s0, firstSlots, SIZES.t, node);
if (honestT.entries.length < 2) throw new Error("the hostile period's first leaf emits fewer than two entries");
if (await refusal(leaf.t, honestT.leaf.inputs) !== undefined) fail("hostile base: the honest transaction leaf is refused");
const withList = f => transactionLeaf(s0, firstSlots, SIZES.t, node, f);
await hostile("an emitted entry left out of the list", "t", withList(e => e.slice(1)), "list");
await hostile("an entry added to the list", "t", withList(e => [...e, { ...e.at(-1), output: e.at(-1).output + 1n }]), "list");
await hostile("a listed subject changed", "t", withList(e => [{ ...e[0], lo: e[0].lo ^ 1n }, ...e.slice(1)]), "list");
await hostile("a listed output changed", "t", withList(e => [{ ...e[0], output: e[0].output + 1n }, ...e.slice(1)]), "list");
await hostile("a listed height changed", "t", withList(e => [{ ...e[0], height: e[0].height - 1n }, ...e.slice(1)]), "list");
// The order's range check carries no message; it is the only 96-bit check in the leaf, and nothing else changes here.
await hostile("the list reordered", "t", withList(e => [e[1], e[0], ...e.slice(2)]), "assert_max_bit_size");
await hostile("a gap in the list", "t", withList(e => [e[0], { ...e[0], unused: true }, ...e.slice(1)]), "list prefix");
await hostile("a listed position aliased past 32 bits", "t", withList(e => [{ ...e[0], height: e[0].height - 1n, position: e[0].position + (1n << 32n) }, ...e.slice(1)]), "does not match the specified type");
const multi = firstSlots.findIndex(s => !s.start);
if (multi < 1) throw new Error("the hostile period's first leaf has no transaction over one slot");
const slotsWith = (i, change) => firstSlots.map((s, k) => (k === i ? { ...s, ...change } : s));
const lastShort = firstSlots.findIndex(s => s.last && s.bytes.length < 128);
await hostile("a nonzero byte past a transaction", "t", transactionLeaf(s0, slotsWith(lastShort,
  { bytes: Uint8Array.from([...firstSlots[lastShort].bytes, 1]), length: firstSlots[lastShort].bytes.length }), SIZES.t, node), "byte past a slot");
await hostile("a transaction started inside another", "t", transactionLeaf(s0, slotsWith(multi, { start: true }), SIZES.t, node), "start inside a transaction");
await hostile("a transaction ended early", "t", transactionLeaf(s0, slotsWith(multi - 1, { last: true }), SIZES.t, node), "slot outside a transaction");
await hostile("a slot shortened inside a transaction", "t", transactionLeaf(s0, slotsWith(multi - 1, { bytes: firstSlots[multi - 1].bytes.subarray(0, 100) }), SIZES.t, node), "short slot");
await hostile("a block started inside a transaction", "t", transactionLeaf(s0, slotsWith(multi, { newBlock: true }), SIZES.t, node), "block start");

// The tree-and-header leaf over the first block: its tree, then its header's chunks.
const firstHeader = mOps.findIndex(o => o.op === "hdr");
const blockOps = mOps.slice(0, mOps.findIndex(o => o.op === "hdr" && o.last) + 1);
if (blockOps.length > SIZES.m || blockOps.filter(o => o.op === "hdr").length < 2) throw new Error("the hostile block does not fit one tree leaf with a two-chunk header");
if (await refusal(leaf.m, treeLeaf(s0, blockOps, SIZES.m, node).leaf.inputs) !== undefined) fail("hostile base: the honest tree leaf is refused");
const opsWith = (i, op) => blockOps.map((o, k) => (k === i ? op : o));
const flip = (bytes, at) => { const b = Uint8Array.from(bytes); b[at] ^= 1; return b; };
const headerOp = blockOps[firstHeader];
await hostile("a header's transactions root altered", "m", treeLeaf(s0, opsWith(firstHeader, { ...headerOp, bytes: flip(headerOp.bytes, 70) }), SIZES.m, node), "transactions root");
await hostile("a header's parent altered", "m", treeLeaf(s0, opsWith(firstHeader, { ...headerOp, bytes: flip(headerOp.bytes, 5) }), SIZES.m, node), "parent id");
await hostile("a pushed id other than the bytes hashed", "m", treeLeaf(s0, opsWith(0, { ...blockOps[0], claim: flip(blockOps[0].id, 0) }), SIZES.m, node), "pushed id");
await hostile("a merge into the stack's sentinel", "m", treeLeaf(s0, [blockOps[0], { op: "mrg" }], SIZES.m, node), "merge into a sentinel");
await hostile("a lift over the empty stack", "m", treeLeaf(s0, [{ op: "lift" }], SIZES.m, node), "lift over an empty stack");
await hostile("an id leaf hashed under the node prefix", "m", treeLeaf(s0, opsWith(0, { ...blockOps[0], prefix: 1 }), SIZES.m, node), "leaf prefix");
await hostile("a witness id of 32 bytes", "m", treeLeaf(s0, [{ op: "wid", witnessId: blockOps[0].id }], SIZES.m, node), "witness id length");
await hostile("a lift carrying a right child", "m", treeLeaf(s0, [blockOps[0], { op: "lift", extra: blockOps[0].id }], SIZES.m, node), "lift length");
const extra = { op: "id", id: blake2b(Uint8Array.of(9), { dkLen: 32 }) };
await hostile("a leaf below a block's tree", "m", treeLeaf(s0, [extra, ...blockOps], SIZES.m, node), "one root");
await hostile("a tree step inside a header", "m", treeLeaf(s0, [...blockOps.slice(0, firstHeader + 1), extra, ...blockOps.slice(firstHeader + 1)], SIZES.m, node), "tree inside a header");

// The map-update leaf over the period's first updates.
const mapU = new SubjectMap(p.start.id, p.start.height);
const updates = p.blocks.flatMap(b => mapU.appendBlock(b.id, b.transactions.map(x => x.unsigned)));
const someUpdates = updates.slice(0, SIZES.u);
const repeated = someUpdates.findIndex(x => x.before.count > 0n);
if (repeated < 0) throw new Error("the hostile period's first updates never repeat a key");
if (await refusal(leaf.u, mapUpdateLeaf(s0, someUpdates, SIZES.u, node).leaf.inputs) !== undefined) fail("hostile base: the honest map-update leaf is refused");
const updatesWith = (i, before) => someUpdates.map((x, k) => (k === i ? { ...x, before: { ...x.before, ...before } } : x));
const sibs = someUpdates[0].before.siblings;
await hostile("a wrong map sibling", "u", mapUpdateLeaf(s0, updatesWith(0, { siblings: [sibs[0] + 1n, ...sibs.slice(1)] }), SIZES.u, node), "map path");
await hostile("a wrong prior count", "u", mapUpdateLeaf(s0, updatesWith(repeated, { count: someUpdates[repeated].before.count + 1n }), SIZES.u, node), "map path");
await hostile("a wrong prior chain", "u", mapUpdateLeaf(s0, updatesWith(repeated, { chain: someUpdates[repeated].before.chain + 1n }), SIZES.u, node), "map path");
await hostile("a chain at count zero", "u", mapUpdateLeaf(s0, updatesWith(0, { chain: 5n }), SIZES.u, node), "empty leaf");
await hostile("a key's entry shifted to another key", "u", mapUpdateLeaf(s0, someUpdates.map((x, k) => (k === 0 ? { ...x, entry: { ...x.entry, subject: flip(x.entry.subject, 31) } } : x)), SIZES.u, node), "map path");

// Streams: each case rebuilds the period's leaves over rearranged streams, every transaction leaf, then every tree leaf,
// then every map leaf (the order between kinds is free; the honest streams in that order are the base), executes them,
// and names the first refusal: a leaf's where one refuses, else the fold's.
function rerun(slots, ops, ups) {
  let st = startState(p.start.id, p.start.height, new SubjectMap(p.start.id, p.start.height).root);
  const leaves = [];
  const add = r => { leaves.push(r.leaf); st = r.after; };
  for (let i = 0; i < slots.length; i += SIZES.t) add(transactionLeaf(st, slots.slice(i, i + SIZES.t), SIZES.t, node));
  for (let i = 0; i < ops.length; i += SIZES.m) add(treeLeaf(st, ops.slice(i, i + SIZES.m), SIZES.m, node));
  for (let i = 0; i < ups.length; i += SIZES.u) add(mapUpdateLeaf(st, ups.slice(i, i + SIZES.u), SIZES.u, node));
  return { end: st, leaves };
}
const streamStart = startState(p.start.id, p.start.height, new SubjectMap(p.start.id, p.start.height).root);
async function streamCase(name, { end, leaves }, expected) {
  let why;
  for (const l of leaves) if ((why = await refusal(leaf[l.kind], l.inputs)) !== undefined) { why = `${l.kind} leaf: ${why}`; break; }
  why ??= await refusal(first, foldInputs(streamStart, end, p.start, mapU));
  report.folds.push({ name, refusal: why ?? null, expected: expected ?? null });
  if (expected === undefined) { if (why !== undefined) fail(`stream ${name}: refused by "${why}"`); else console.log(`stream ${name}: the fold executes`); }
  else if (why === undefined) fail(`stream ${name}: the fold executes`);
  else if (!why.includes(expected)) fail(`stream ${name}: refused by "${why}", not "${expected}"`);
  else console.log(`stream ${name}: refused (${why})`);
}
const txs = [];
for (const slot of tSlots) (slot.start ? txs.push([slot]) : txs.at(-1).push(slot));
/** The transactions in `order` (indices), each block's first slot flagged as at its position in `flags`. */
const arranged = (order, flags = txs.map(x => x[0].newBlock)) => order.map((i, k) => txs[i].map((slot, j) => ({ ...slot, newBlock: j === 0 && flags[k] }))).flat();
const all = txs.map((_, i) => i);
await streamCase("the honest streams in kind order", rerun(tSlots, mOps, updates));
await streamCase("a transaction omitted", rerun(arranged(all.filter(i => i !== 1), txs.filter((_, i) => i !== 1).map(x => x[0].newBlock)), mOps, updates), "period end: id chains");
await streamCase("two transactions swapped", rerun(arranged([1, 0, ...all.slice(2)]), mOps, updates), "period end: id chains");
const second = txs.findIndex((x, i) => i > 0 && x[0].newBlock);
await streamCase("a block boundary moved", rerun(arranged(all, txs.map((x, i) => (i === second ? false : i === second + 1 ? true : x[0].newBlock))), mOps, updates), "period end: id chains");
await streamCase("map entries reordered", rerun(tSlots, mOps, [updates[1], updates[0], ...updates.slice(2)]), "map path");
await streamCase("the last map entry left out", rerun(tSlots, mOps, updates.slice(0, -1)), "period end: entry chains");
await streamCase("a map entry applied twice", rerun(tSlots, mOps, [updates[0], ...updates]), "map path");
await streamCase("a header left out", rerun(tSlots, mOps.slice(0, mOps.length - 1), updates), "period end: header open");
const plain = txs.find(x => x.length > 1)[0];
await streamCase("a transaction left open after the last block", rerun([...tSlots, { ...plain, newBlock: false, last: false }], mOps, updates), "period end: transaction open");

// Folds' own checks over the honest period.
{
  const map = new SubjectMap(p.start.id, p.start.height);
  const run = periodLeaves(map, p.blocks, SIZES, node);
  const base = foldInputs(run.start, run.end, p.start, map);
  const cases = [
    ["another start id", first, { start_lo: dec(BigInt(base.start_lo) ^ 1n) }, "start id"],
    ["another start height", first, { start_height: dec(BigInt(base.start_height) + 1n) }, "start height"],
    ["another end id", first, { end_hi: dec(BigInt(base.end_hi) ^ 1n) }, "end id"],
    ["another end height", first, { end_height: dec(BigInt(base.end_height) - 1n) }, "end height"],
    ["another map root", first, { map_root: "7" }, "map root"],
    ["a tree under a key outside the set", first, { key_hash: "0x09" }, "tree key"],
    ["a first map not empty", first, foldStateInputs({ ...run.start, u: { ...run.start.u, root: 7n } }, "0"), "empty map"],
    ["a start with an entry list chain", first, foldStateInputs({ ...run.start, t: { ...run.start.t, echain: 7n } }, "0"), "period start: entry list chain"],
    ["a start with an entry stream", first, foldStateInputs({ ...run.start, u: { ...run.start.u, chain: 7n } }, "0"), "period start: entry stream"],
    ["a start with an id chain", first, foldStateInputs({ ...run.start, m: { ...run.start.m, chain: 7n } }, "0"), "period start: tree id chain"],
    ["a start inside a transaction", first, foldStateInputs({ ...run.start, t: { ...run.start.t, inTx: true } }, "0"), "period start: transaction open"],
    ["an end inside a header", first, foldStateInputs({ ...run.end, m: { ...run.end.m, inHeader: true } }, "1"), "period end: header open"],
    ["a previous fold under another key", next, { previous_key: Array(115).fill("0"), previous_proof: Array(458).fill("0"), previous_key_hash: "0x09" }, "previous fold key"],
  ];
  for (const [name, program, change, expected] of cases) {
    const why = await refusal(program, { ...base, ...change });
    report.folds.push({ name, refusal: why ?? null, expected });
    if (why === undefined) fail(`fold ${name}: executes`);
    else if (!why.includes(expected)) fail(`fold ${name}: refused by "${why}", not "${expected}"`);
    else console.log(`fold ${name}: refused (${why})`);
  }
}

// The node's admission, executed with placeholder proofs (its joins are recursive: exhaustion-prove.mjs).
{
  const nodeProgram = new Noir(await compile(built.directory, "node", nodeSource({ t: KEYS.t, m: KEYS.m, u: KEYS.u })));
  const base = { sin: "1", sout: "2", node_key_hash: KEYS.n, keys: [Array(115).fill("0"), Array(115).fill("0")], proofs: [Array(458).fill("0"), Array(458).fill("0")],
    key_hashes: [KEYS.t, KEYS.n], middle: "3" };
  const honest = await refusal(nodeProgram, base);
  if (honest !== undefined) fail(`node: admitted keys refused: ${honest}`);
  const why = await refusal(nodeProgram, { ...base, key_hashes: [KEYS.t, "0x09"] });
  report.folds.push({ name: "a node child under a key outside the set", refusal: why ?? null, expected: "child key" });
  if (why === undefined || !why.includes("child key")) fail(`node: a child under a key outside the set: ${why ?? "executes"}`);
  else console.log(`node a child under a key outside the set: refused (${why})`);
}

// The scan's agreement beyond the synthetic chain: crafted and mutated transactions (tokens, extensions, data inputs,
// fixed trees, minimal shaped outputs, bytes outside the grammar), each one leaf from a fresh state: the leaf executes
// with the prover's list, which must be scanTransaction's outputs.
{
  let entries = 0, transactions = 0;
  const s1 = startState(new Uint8Array(32).fill(1), 900000n, 0n);
  for (const unsigned of craftedTransactions(SIZES.t * 128)) {
    const n = Math.max(1, Math.ceil(unsigned.length / 128));
    const slots = Array.from({ length: n }, (_, k) => ({ bytes: unsigned.subarray(k * 128, (k + 1) * 128), start: k === 0, newBlock: k === 0, last: k === n - 1 }));
    const r = transactionLeaf(s1, slots, SIZES.t, node);
    const scanned = scanTransaction(unsigned);
    const same = scanned.length === r.entries.length && scanned.every((x, i) => BigInt(x.output) === r.entries[i].output &&
      Buffer.from(x.subject).equals(Buffer.from(identifierOf(r.entries[i].hi, r.entries[i].lo))));
    if (!same) fail(`crafted transaction ${transactions}: the prover's entries are not scanTransaction's`);
    const why = await refusal(leaf.t, r.leaf.inputs);
    if (why !== undefined) fail(`crafted transaction ${transactions}: refused: ${why}`);
    transactions++; entries += r.entries.length;
  }
  report.crafted = { transactions, entries };
  console.log(`crafted: ${transactions} transactions, ${entries} entries, each leaf executed`);
}

report.result = failed === 0 ? "pass" : `${failed} failures`;
if (option("--report")) writeFileSync(option("--report"), `${JSON.stringify(report, null, 2)}\n`);
console.log(failed === 0 ? "exhaustion-check: pass" : `exhaustion-check: ${failed} failures`);
if (failed) process.exitCode = 1;
