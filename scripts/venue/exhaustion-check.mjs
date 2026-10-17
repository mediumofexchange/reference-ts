// The exhaustion circuits' execution check (succinct-read §4.3). By default over the circuits compiled at small slot
// counts from the same sources as the full-size set; with --shipped over the shipped full-size programs an adoption
// names (§6), compiled by the pinned nargo and executed by it, which also computes a prover's witnesses. Either way:
// every leaf of synthetic periods and of recorded mainnet blocks executes, the leaves join end to start, a period ends
// where a fold requires with the map's root equal to src/ergo-exhaustion.ts' SubjectMap; real blocks of every header
// version (1 to 4) execute and each block's tree-and-header leaves are refused with its header's parent or transactions
// root altered; and hostile witnesses, each otherwise consistent with the state hashes, are refused by the named check.
// Folds are executed with placeholder proofs: execution checks every constraint but the recursive verifications. With
// --prove (and --shipped) those are proved: two periods proved and folded as a replica proves them, hostile joins not
// proved or not verifying, and the reader taking the folds under the shipped set and refusing hostile ones.
//
//   node scripts/venue/exhaustion-check.mjs [--mainnet <recorded blocks.json>] [--report <file>]
//   node scripts/venue/exhaustion-check.mjs --shipped [--prove] [--workers <n>] [--report <file>]
//
// Run after `npm run build`. Without --shipped and with NARGO set it also compares nargo's bytecode with the pinned
// noir_wasm's; --shipped needs NARGO (the pinned nargo) and keeps the compiled crates in scratch/exhaustion-programs
// (about ten minutes the first time); --prove proves on the native backend from the leading 2^22 points, kept in
// scratch/exhaustion-crs (fetched where missing), in about a quarter of an hour. The report holds one section per mode;
// writing one keeps the other.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { blake2b } from "@noble/hashes/blake2b.js";
import { Noir } from "@noir-lang/noir_js";
import { build, compile, EXHAUSTION_SPECIFICATION, root, sourceHashes } from "./exhaustion-build.mjs";
import { foldFirst, foldNext, node as nodeSource } from "./exhaustion-sources.mjs";
import { craftedTransactions, recordedPeriod, recordedPeriodOf, syntheticPeriod } from "./exhaustion-periods.mjs";
import { scanTransaction } from "../../dist/ergo-scan.js";
import { checkFold, EMPTY_SUBTREES, SubjectMap } from "../../dist/ergo-exhaustion.js";
import { Chain, plainOutput, transaction } from "../../dist/ergo-synthetic.js";
import { bytesOf, compress, foldStateInputs, isPeriodEnd, iv0, mapUpdateLeaf, periodLeaves, periodStreams, startState, stateEnd, stateHash,
  transactionLeaf, treeLeaf, wordsOf } from "../../dist/ergo-exhaustion-prover.js";
import { EXHAUSTION_CIRCUITS, EXHAUSTION_SET_MANIFEST, exhaustionKeys } from "../../dist/ergo-exhaustion-set.js";
import { shippedExhaustionSet } from "../../dist/succinct-set.js";
import { crateName, exhaustionPrograms, nargoWitness } from "../../dist/ergo-exhaustion-programs.js";
import { fieldToHex, identifierOf, limbsOf } from "../../dist/pool/field.js";
import { prepareExhaustionParameters, readExhaustionParameters } from "../../dist/pool/parameter-files.js";
import { nativeRefusal, startExhaustionBackend } from "../../dist/pool/proof-verifier.js";

const argv = process.argv.slice(2);
const option = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const shipped = argv.includes("--shipped"), prove = argv.includes("--prove");
if (prove && !shipped) throw new Error("--prove goes with --shipped");
const VERSION_BLOCKS = "test/fixtures/ergo-mainnet-version-blocks.json";
const section = {
  sources: sourceHashes(["src/ergo-exhaustion-set.ts", "src/ergo-exhaustion-programs.ts", ...EXHAUSTION_CIRCUITS.map(c => `src/exhaustion-circuits/${c}.nr`),
    VERSION_BLOCKS, ...(prove ? ["src/ergo-exhaustion-pool.ts", "src/pool/parameter-files.ts", "src/pool/parameters.ts"] : [])]),
  periods: [], versions: [], hostile: [], folds: [],
};
let failed = 0;
const fail = message => { failed++; console.error(`FAIL ${message}`); };

// The runner: `exec(circuit, inputs)` is the refusal's message, or undefined where the circuit executes. The keys are
// the key hashes the node and folds hold as constants (the leaves' own where shipped, placeholders at small sizes).
let SIZES, KEYS, FOLD_KEY, FIRST_KEY, PROGRAMS, exec, finish = () => {};
if (!shipped) {
  SIZES = { t: 6, m: 12, u: 6 };
  KEYS = { t: "0x01", m: "0x02", u: "0x03", n: "0x04" };
  FOLD_KEY = "0x05";
  FIRST_KEY = "0x06";
  const built = await build({ CT: SIZES.t, CM: SIZES.m, E: SIZES.u }, { directory: path.join(root, "scratch/exhaustion/check"), log: () => {} });
  if (process.env.NARGO) {
    for (const name of ["leaf-t", "leaf-m", "leaf-u"]) {
      const project = path.join(built.directory, name);
      const wasm = JSON.parse(readFileSync(path.join(project, "program.json"), "utf8")).bytecode;
      execFileSync(process.env.NARGO, ["compile", "--program-dir", project], { stdio: "ignore" });
      const native = JSON.parse(readFileSync(path.join(project, "target", `moe_succinct_exhaustion_${name.replaceAll("-", "_")}.json`), "utf8")).bytecode;
      section.nargoEqualsWasm = (section.nargoEqualsWasm ?? true) && native === wasm;
      if (native !== wasm) fail(`${name}: nargo's bytecode differs from noir_wasm's`);
    }
  }
  const load = name => new Noir(JSON.parse(readFileSync(path.join(built.directory, name, "program.json"), "utf8")));
  const emptyRoot = "0x" + EMPTY_SUBTREES[32].toString(16);
  const programs = {
    "leaf-t": load("leaf-t"), "leaf-m": load("leaf-m"), "leaf-u": load("leaf-u"),
    node: new Noir(await compile(built.directory, "node", nodeSource({ t: KEYS.t, m: KEYS.m, u: KEYS.u }))),
    "fold-first": new Noir(await compile(built.directory, "fold-first", foldFirst(KEYS, emptyRoot))),
    "fold-next": new Noir(await compile(built.directory, "fold-next", foldNext(KEYS, FIRST_KEY))),
  };
  exec = async (circuit, inputs) => {
    try { await programs[circuit].execute(inputs); return undefined; } catch (error) {
      const text = String(error?.message ?? error);
      return text.replace(/^.*Circuit execution failed: /s, "").split("\n")[0] || text;
    }
  };
} else {
  const nargo = process.env.NARGO;
  // CI installs the pinned nargo on Linux only (its real-proof group runs on Windows too); anywhere else it is required.
  if (!nargo && process.platform === "win32") {
    console.log("exhaustion-check --shipped: no pinned nargo on this Windows host; nothing executed");
    process.exit(0);
  }
  if (!nargo) throw new Error("--shipped needs NARGO, the pinned nargo");
  const keys = exhaustionKeys(), hash = circuit => fieldToHex(keys[circuit].keyHash);
  SIZES = EXHAUSTION_SET_MANIFEST.sizes;
  KEYS = { t: hash("leaf-t"), m: hash("leaf-m"), u: hash("leaf-u"), n: hash("node") };
  FOLD_KEY = hash("fold-next");
  FIRST_KEY = hash("fold-first");
  const directory = path.join(root, "scratch/exhaustion-programs");
  PROGRAMS = exhaustionPrograms({ nargo, directory, log: console.log });
  // nargo holds a lock on a crate's manifest while it executes, so each worker executes in a copy of its own.
  const workers = Number(option("--workers") ?? 4);
  if (!Number.isSafeInteger(workers) || workers < 1) throw new Error("--workers takes a positive integer");
  const copies = path.join(root, "scratch/exhaustion", `crates-${process.pid}`);
  rmSync(copies, { recursive: true, force: true });
  const crate = (w, circuit) => path.join(copies, String(w), circuit);
  const witnesses = Array.from({ length: workers }, (_, w) => {
    cpSync(directory, path.join(copies, String(w)), { recursive: true });
    return nargoWitness(nargo, Object.fromEntries(EXHAUSTION_CIRCUITS.map(circuit => [circuit, crate(w, circuit)])));
  });
  const free = witnesses.map((_, w) => w), waiting = [];
  exec = async (circuit, inputs) => {
    const w = free.length ? free.pop() : await new Promise(resolve => waiting.push(resolve));
    try { await witnesses[w](circuit, inputs); return undefined; } catch (error) {
      if (error?.name !== "ExhaustionWitnessError") throw error;
      return error.message.slice(circuit.length + 2);
    } finally {
      const next = waiting.shift();
      if (next) next(w);
      else free.push(w);
    }
  };
  // Every copy's program must still be the manifest's afterwards: nargo compiles a crate again, unchecked, where it
  // does not take the kept program as its own.
  finish = () => {
    section.programs = Object.fromEntries(EXHAUSTION_CIRCUITS.map(circuit => [circuit, EXHAUSTION_SET_MANIFEST.circuits[circuit].bytecode]));
    section.programsUnchanged = witnesses.every((_, w) => EXHAUSTION_CIRCUITS.every(circuit => {
      const program = JSON.parse(readFileSync(path.join(crate(w, circuit), "target", `${crateName(circuit)}.json`), "utf8"));
      return createHash("sha256").update(Buffer.from(program.bytecode, "base64")).digest("hex") === EXHAUSTION_SET_MANIFEST.circuits[circuit].bytecode;
    }));
    if (!section.programsUnchanged) fail("a crate copy's program is no longer the manifest's");
    rmSync(copies, { recursive: true, force: true });
  };
}
section.sizes = SIZES;
const node = BigInt(KEYS.n);
const leafOf = kind => `leaf-${kind}`;

const dec = x => x.toString();
const placeholderKey = () => Array(115).fill("0"), placeholderProof = () => Array(458).fill("0");
function foldInputs(start, end, startOf, map, extra = {}) {
  const [sh, sl] = limbsOf(startOf.id), { id, height } = stateEnd(end), [eh, el] = limbsOf(id);
  return { start_hi: dec(sh), start_lo: dec(sl), start_height: dec(startOf.height), end_hi: dec(eh), end_lo: dec(el), end_height: dec(height),
    map_root: dec(map.root), fold_key_hash: FOLD_KEY, key: placeholderKey(), proof: placeholderProof(), key_hash: KEYS.n,
    ...foldStateInputs(start, "0"), ...foldStateInputs(end, "1"), ...extra };
}
const nextFoldExtra = () => ({ previous_key: placeholderKey(), previous_proof: placeholderProof(), previous_key_hash: FIRST_KEY });

/** A period's honest leaves executed and joined, its end checked against the map, and its fold executed. */
async function period(label, p, periods = 1) {
  const map = new SubjectMap(p.start.id, p.start.height);
  const per = Math.ceil(p.blocks.length / periods);
  let leaves = 0, entries = 0, previousEnd;
  for (let k = 0; k < periods; k++) {
    const blocks = p.blocks.slice(k * per, (k + 1) * per);
    const run = periodLeaves(map, blocks, SIZES, node);
    let joined = run.leaves[0]?.sin;
    const work = run.leaves.map((l, i) => {
      if (l.sin !== joined) fail(`${label}: leaf ${i} does not join`);
      joined = l.sout;
      if (l.kind === "u") entries += l.inputs.uu.filter(Boolean).length;
      return exec(leafOf(l.kind), l.inputs).then(why => why === undefined || fail(`${label}: honest leaf ${i} (${l.kind}) refused: ${why}`));
    });
    leaves += run.leaves.length;
    if (!isPeriodEnd(run.end)) fail(`${label}: the period does not end at a block boundary`);
    if (run.end.u.root !== map.root) fail(`${label}: the leaves' map root is not the SubjectMap's`);
    if (Buffer.compare(Buffer.from(stateEnd(run.end).id), Buffer.from(blocks.at(-1).id)) !== 0) fail(`${label}: the period ends elsewhere`);
    work.push((k === 0 ? exec("fold-first", foldInputs(run.start, run.end, p.start, map)) : exec("fold-next", foldInputs(run.start, run.end, p.start, map, nextFoldExtra())))
      .then(why => why === undefined || fail(`${label}: honest fold ${k} refused: ${why}`)));
    await Promise.all(work);
    previousEnd = run;
  }
  const transactions = p.blocks.reduce((n, b) => n + b.transactions.length, 0);
  section.periods.push({ label, blocks: p.blocks.length, periods, transactions, leaves, entries });
  console.log(`${label}: ${p.blocks.length} blocks, ${transactions} transactions, ${leaves} leaves, ${entries} entries in ${periods} period(s)`);
  return previousEnd;
}

/** One refused case recorded in `list`: refused by the check whose name `expected` is, or a failure. */
function judge(list, name, why, expected, extra = {}) {
  list.push({ name, ...extra, refusal: why ?? null, expected: expected ?? null });
  if (why === undefined) fail(`${name}: executes`);
  else if (expected !== undefined && !why.includes(expected)) fail(`${name}: refused by "${why}", not "${expected}"`);
  else console.log(`${name}: refused (${why})`);
}
const hostile = async (name, kind, built, expected) => judge(section.hostile, `hostile ${name}`, await exec(leafOf(kind), built.leaf.inputs), expected, { kind });

// Honest periods: synthetic (both root rules, shaped outputs for keys shared and not, an ungrammatical transaction),
// the same as two periods (a next fold), and recorded mainnet blocks.
const synthetic = syntheticPeriod(9);
await period("synthetic", synthetic);
await period("synthetic in two periods", synthetic, 2);
if (option("--mainnet")) await period("mainnet", recordedPeriod(option("--mainnet")));

// Every header version: real mainnet blocks at each version change, every leaf of each period executed, and each
// block's tree-and-header leaves (as many as its operations take) refused with its header's parent id or transactions
// root altered. The circuit reads a header's bytes 1–33 and 65–97, which every version lays out alike (venue-ergo §3),
// and hashes the rest, whatever its length.
const flip = (bytes, at) => { const b = Uint8Array.from(bytes); b[at] ^= 1; return b; };
{
  const recorded = JSON.parse(readFileSync(path.join(root, VERSION_BLOCKS), "utf8"));
  for (const record of recorded.periods) {
    const p = recordedPeriodOf(record);
    await period(`mainnet ${p.blocks[0].height}–${p.blocks.at(-1).height}`, p);
    let state = startState(p.start.id, p.start.height, new SubjectMap(p.start.id, p.start.height).root);
    for (const block of p.blocks) {
      const ops = periodStreams([block]).m, h = ops.findIndex(o => o.op === "hdr");
      /** The block's operations from `state` in leaves of SIZES.m: the first refusal, and the state after. */
      const leaves = async list => {
        let s = state;
        for (let i = 0; i < list.length; i += SIZES.m) {
          const r = treeLeaf(s, list.slice(i, i + SIZES.m), SIZES.m, node);
          const why = await exec("leaf-m", r.leaf.inputs);
          if (why !== undefined) return { why };
          s = r.after;
        }
        return { after: s };
      };
      const version = block.header[0], rule = ops.some(o => o.op === "wid") ? "witness" : "ids";
      const label = `version ${version} header at ${block.height}`;
      const honest = await leaves(ops);
      if (honest.why !== undefined) fail(`${label}: refused: ${honest.why}`);
      const altered = at => ops.map((o, k) => (k === h ? { ...o, bytes: flip(o.bytes, at) } : o));
      const parent = (await leaves(altered(5))).why, transactionsRoot = (await leaves(altered(70))).why;
      judge(section.versions, `${label}, its parent altered`, parent, "parent id", { height: Number(block.height), version, rule, headerBytes: block.header.length, operations: ops.length });
      judge(section.versions, `${label}, its transactions root altered`, transactionsRoot, "transactions root", { height: Number(block.height), version, rule });
      state = honest.after ?? state;
    }
  }
}

// Hostile witnesses: each a leaf the prover builds consistently but for one departure, refused by the named check.
const p = syntheticPeriod(3);
const map0 = new SubjectMap(p.start.id, p.start.height);
const s0 = startState(p.start.id, p.start.height, map0.root);
const { t: tSlots, m: mOps } = periodStreams(p.blocks);
const firstSlots = tSlots.slice(0, SIZES.t);
const honestT = transactionLeaf(s0, firstSlots, SIZES.t, node);
if (honestT.entries.length < 2) throw new Error("the hostile period's first leaf emits fewer than two entries");
if (await exec("leaf-t", honestT.leaf.inputs) !== undefined) fail("hostile base: the honest transaction leaf is refused");
const withList = f => transactionLeaf(s0, firstSlots, SIZES.t, node, f);
await hostile("an emitted entry left out of the list", "t", withList(e => e.slice(1)), "list");
await hostile("an entry added to the list", "t", withList(e => [...e, { ...e.at(-1), output: e.at(-1).output + 1n }]), "list");
await hostile("a listed subject changed", "t", withList(e => [{ ...e[0], lo: e[0].lo ^ 1n }, ...e.slice(1)]), "list");
await hostile("a listed output changed", "t", withList(e => [{ ...e[0], output: e[0].output + 1n }, ...e.slice(1)]), "list");
await hostile("a listed height changed", "t", withList(e => [{ ...e[0], height: e[0].height - 1n }, ...e.slice(1)]), "list");
// The order's range check carries no message; it is the only 96-bit check in the leaf, and nothing else changes here.
await hostile("the list reordered", "t", withList(e => [e[1], e[0], ...e.slice(2)]), "assert_max_bit_size");
await hostile("a gap in the list", "t", withList(e => [e[0], { ...e[0], unused: true }, ...e.slice(1)]), "list prefix");
// noir_js and nargo refuse the u32 parameter as they read it, before execution; a proof's ABI range constraint
// refuses it in the circuit.
await hostile("a listed position aliased past 32 bits", "t", withList(e => [{ ...e[0], height: e[0].height - 1n, position: e[0].position + (1n << 32n) }, ...e.slice(1)]),
  "does not match the specified type");
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
if (await exec("leaf-m", treeLeaf(s0, blockOps, SIZES.m, node).leaf.inputs) !== undefined) fail("hostile base: the honest tree leaf is refused");
const opsWith = (i, op) => blockOps.map((o, k) => (k === i ? op : o));
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
// A merge or lift slot hashing other bytes than the stack's entries, its end state the prover's over those bytes. The
// merge hashes the real root's preimage over two made-up ids, so the leaf reaches the header's root with an id chain
// of made-up ids: with the check removed, a false absence and made-up transactions.
{
  const tree = blockOps.slice(0, firstHeader), headers = blockOps.slice(firstHeader);
  if (tree.at(-1).op !== "mrg") throw new Error("the hostile block's tree does not end in a merge");
  const below = treeLeaf(s0, tree.slice(0, -1), SIZES.m, node).after.m;
  const made = [1, 2].map(k => ({ op: "id", id: blake2b(Uint8Array.of(k), { dkLen: 32 }) }));
  /** The leaf over `ops` with slot `i` hashing `bytes` (its length kept) and writing `entry` at stack position 2. */
  const patched = (ops, i, bytes, entry) => {
    const r = treeLeaf(s0, ops, SIZES.m, node), slot = new Uint8Array(128);
    slot.set(bytes);
    r.leaf.inputs.mb[i] = [...slot].map(String);
    r.after.m.stack[2] = entry;
    r.leaf.inputs.sout = stateHash(r.after).toString();
    return r;
  };
  const merge = Uint8Array.from([1, ...bytesOf(below.stack[below.sp]), ...bytesOf(below.stack[below.sp + 1])]);
  await hostile("a merge hashing the real root's children over made-up ids", "m",
    patched([...made, { op: "mrg" }, ...headers], 2, merge, wordsOf(headerOp.bytes.subarray(65, 97))), "merged entries");
  const lift = Uint8Array.from([1, ...blake2b(Uint8Array.of(3), { dkLen: 32 })]);
  await hostile("a lift hashing another entry", "m", patched([made[0], { op: "lift" }], 1, lift, compress(iv0(), Uint8Array.from({ length: 128 }, (_, i) => lift[i] ?? 0), 33n, true).slice(0, 4)), "lifted entry");
}

// The map-update leaf over the period's first updates.
const mapU = new SubjectMap(p.start.id, p.start.height);
const updates = p.blocks.flatMap(b => mapU.appendBlock(b.id, b.transactions.map(x => x.unsigned)));
const someUpdates = updates.slice(0, SIZES.u);
const repeated = someUpdates.findIndex(x => x.before.count > 0n);
if (repeated < 0) throw new Error("the hostile period's first updates never repeat a key");
if (await exec("leaf-u", mapUpdateLeaf(s0, someUpdates, SIZES.u, node).leaf.inputs) !== undefined) fail("hostile base: the honest map-update leaf is refused");
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
  for (const l of leaves) if ((why = await exec(leafOf(l.kind), l.inputs)) !== undefined) { why = `${l.kind} leaf: ${why}`; break; }
  why ??= await exec("fold-first", foldInputs(streamStart, end, p.start, mapU));
  if (expected !== undefined) return judge(section.folds, `stream ${name}`, why, expected);
  section.folds.push({ name: `stream ${name}`, refusal: why ?? null, expected: null });
  if (why !== undefined) fail(`stream ${name}: refused by "${why}"`);
  else console.log(`stream ${name}: the fold executes`);
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
const lastTree = mOps.findLastIndex(o => o.op !== "hdr");
await streamCase("the last block's tree and transactions without its header", rerun(tSlots, mOps.slice(0, lastTree + 1), updates), "period end: stack");
const plain = txs.find(x => x.length > 1)[0];
await streamCase("a transaction left open after the last block", rerun([...tSlots, { ...plain, newBlock: false, last: false }], mOps, updates), "period end: transaction open");

// Folds' own checks over the honest period.
{
  const map = new SubjectMap(p.start.id, p.start.height);
  const run = periodLeaves(map, p.blocks, SIZES, node);
  const base = foldInputs(run.start, run.end, p.start, map);
  const cases = [
    ["another start id", "fold-first", { start_lo: dec(BigInt(base.start_lo) ^ 1n) }, "start id"],
    ["another start height", "fold-first", { start_height: dec(BigInt(base.start_height) + 1n) }, "start height"],
    ["another end id", "fold-first", { end_hi: dec(BigInt(base.end_hi) ^ 1n) }, "end id"],
    ["another end height", "fold-first", { end_height: dec(BigInt(base.end_height) - 1n) }, "end height"],
    ["another map root", "fold-first", { map_root: "7" }, "map root"],
    ["a tree under a key outside the set", "fold-first", { key_hash: "0x09" }, "tree key"],
    ["a first map not empty", "fold-first", foldStateInputs({ ...run.start, u: { ...run.start.u, root: 7n } }, "0"), "empty map"],
    ["a start with an entry list chain", "fold-first", foldStateInputs({ ...run.start, t: { ...run.start.t, echain: 7n } }, "0"), "period start: entry list chain"],
    ["a start with an entry stream", "fold-first", foldStateInputs({ ...run.start, u: { ...run.start.u, chain: 7n } }, "0"), "period start: entry stream"],
    ["a start with an id chain", "fold-first", foldStateInputs({ ...run.start, m: { ...run.start.m, chain: 7n } }, "0"), "period start: tree id chain"],
    ["a start inside a transaction", "fold-first", foldStateInputs({ ...run.start, t: { ...run.start.t, inTx: true } }, "0"), "period start: transaction open"],
    // A stale live entry at the start: with the check removed, a block's tree merges it in place of its first id,
    // whose transaction then reads as absent.
    ["a start with a live stack entry", "fold-first", foldStateInputs({ ...run.start, m: { ...run.start.m, sp: 1,
      stack: run.start.m.stack.map((w, i) => (i === 2 ? wordsOf(blake2b(Uint8Array.of(0, ...p.blocks[0].id), { dkLen: 32 })) : w)) } }, "0"), "period start: stack"],
    ["a start inside a header", "fold-first", foldStateInputs({ ...run.start, m: { ...run.start.m, inHeader: true } }, "0"), "period start: header open"],
    ["a start at another position", "fold-first", foldStateInputs({ ...run.start, m: { ...run.start.m, j: 1n } }, "0"), "period start: position"],
    ["a start with the streams at two heights", "fold-first", foldStateInputs({ ...run.start, t: { ...run.start.t, height: run.start.t.height + 1n } }, "0"), "period start: heights"],
    ["a start with a transaction id chain", "fold-first", foldStateInputs({ ...run.start, t: { ...run.start.t, chain: 7n } }, "0"), "period start: id chain"],
    ["an end inside a header", "fold-first", foldStateInputs({ ...run.end, m: { ...run.end.m, inHeader: true } }, "1"), "period end: header open"],
    ["a previous fold under another key", "fold-next", { ...nextFoldExtra(), previous_key_hash: "0x09" }, "previous fold key"],
  ];
  for (const [name, circuit, change, expected] of cases) judge(section.folds, `fold ${name}`, await exec(circuit, { ...base, ...change }), expected);
}

// The node's admission, executed with placeholder proofs (its joins are recursive: --prove).
{
  const base = { sin: "1", sout: "2", node_key_hash: KEYS.n, keys: [placeholderKey(), placeholderKey()], proofs: [placeholderProof(), placeholderProof()],
    key_hashes: [KEYS.t, KEYS.n], middle: "3" };
  const honest = await exec("node", base);
  if (honest !== undefined) fail(`node: admitted keys refused: ${honest}`);
  judge(section.folds, "node a child under a key outside the set", await exec("node", { ...base, key_hashes: [KEYS.t, "0x09"] }), "child key");
}

// The scan's agreement beyond the synthetic chain: crafted and mutated transactions (tokens, extensions, data inputs,
// fixed trees, minimal shaped outputs, bytes outside the grammar), each one leaf from a fresh state: the leaf executes
// with the prover's list, which must be scanTransaction's outputs. Small sizes only: exhaustion-corpus.mjs runs them
// through the full-size leaf.
if (!shipped) {
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
    const why = await exec("leaf-t", r.leaf.inputs);
    if (why !== undefined) fail(`crafted transaction ${transactions}: refused: ${why}`);
    transactions++; entries += r.entries.length;
  }
  section.crafted = { transactions, entries };
  console.log(`crafted: ${transactions} transactions, ${entries} entries, each leaf executed`);
}

// The recursion (--prove): what the placeholder proofs leave out, on real proofs of the shipped set made as a replica
// makes them (`nativeExhaustionBackend` over nargo's witnesses). Two one-block periods of a synthetic chain, each of
// three leaves, are proved, joined by nodes and folded, first then next; hostile joins are not proved or do not verify
// natively; and the reader takes both folds under the shipped set (`checkFold`) and refuses hostile ones.
if (prove) {
  const refusal = nativeRefusal();
  if (refusal !== undefined) throw new Error(`--prove: ${refusal}`);
  const { nativeExhaustionBackend } = await import("../../dist/ergo-exhaustion-pool.js");
  const crs = path.join(root, "scratch/exhaustion-crs");
  await prepareExhaustionParameters(crs, { log: console.log });
  const parameters = () => readExhaustionParameters(crs);
  const backend = nativeExhaustionBackend(PROGRAMS, parameters, { threads: os.availableParallelism() });
  const recursion = section.recursion = { cpu: os.cpus()[0]?.model ?? "unknown", cores: os.cpus().length, proofs: [], checks: [] };
  const check = (name, ok, detail) => {
    recursion.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    if (!ok) fail(name);
    else console.log(`ok ${name}`);
  };
  const fields = bytes => Array.from({ length: bytes.length / 32 }, (_, i) => `0x${Buffer.from(bytes.subarray(32 * i, 32 * i + 32)).toString("hex")}`);
  /** `circuit` proved over `inputs`: the proof, its public inputs, and the proof and key as a parent circuit takes them. */
  async function proved(circuit, inputs, label) {
    const t0 = Date.now();
    const made = await backend.prove(circuit, await backend.witness(circuit, inputs));
    const seconds = +((Date.now() - t0) / 1000).toFixed(1);
    recursion.proofs.push({ circuit, label, seconds });
    console.log(`${label}: proved in ${seconds} s`);
    return { circuit, proof: made.proof, publicInputs: made.publicInputs, proofFields: fields(made.proof),
      key: fields(PROGRAMS.circuits[circuit].vk), keyHash: fieldToHex(PROGRAMS.circuits[circuit].keyHash) };
  }
  const verifies = p => backend.verify(p.circuit, p.proof, p.publicInputs);
  const nodeInputs = (a, b, key = node) => ({ sin: dec(a.publicInputs[0]), sout: dec(b.publicInputs[1]), node_key_hash: dec(key), keys: [a.key, b.key],
    proofs: [a.proofFields, b.proofFields], key_hashes: [a.keyHash, b.keyHash], middle: dec(a.publicInputs[1]) });
  /** A period's leaves proved and joined pairwise by nodes carrying `key` as their key-hash input: the leaves and the root. */
  async function tree(leaves, key, label) {
    let level = [];
    for (const l of leaves) level.push(await proved(leafOf(l.kind), l.inputs, `${label} leaf-${l.kind}`));
    const leafProofs = [...level];
    while (level.length > 1) {
      const up = [];
      for (let i = 0; i + 1 < level.length; i += 2) up.push(await proved("node", nodeInputs(level[i], level[i + 1], key), `${label} node`));
      if (level.length % 2) up.push(level.at(-1));
      level = up;
    }
    return { leaves: leafProofs, root: level[0] };
  }
  const rootInputs = top => ({ key: top.key, proof: top.proofFields, key_hash: top.keyHash });
  const previousInputs = fold => ({ previous_key: fold.key, previous_proof: fold.proofFields, previous_key_hash: fold.keyHash });
  const refused = async (name, circuit, inputs) => {
    let outcome;
    try { outcome = (await verifies(await proved(circuit, inputs, `hostile ${circuit}`))) ? "verifies" : "does not verify"; }
    catch (error) { outcome = `not proved (${String(error?.message ?? error).split("\n")[0].slice(0, 160)})`; }
    check(`hostile: ${name}`, outcome !== "verifies", outcome);
  };
  try {
    const chain = syntheticPeriod(2), map = new SubjectMap(chain.start.id, chain.start.height), done = [];
    for (const [k, block] of chain.blocks.entries()) {
      const run = periodLeaves(map, [block], SIZES, node);
      if (run.leaves.length !== 3) throw new Error(`period ${k} is not three leaves`);
      const { leaves, root: top } = await tree(run.leaves, node, `period ${k}`);
      const inputs = foldInputs(run.start, run.end, chain.start, map, rootInputs(top));
      const fold = k === 0 ? await proved("fold-first", inputs, "period 0 fold-first")
        : await proved("fold-next", { ...inputs, ...previousInputs(done[0].fold) }, "period 1 fold-next");
      const end = stateEnd(run.end), [sh, sl] = limbsOf(chain.start.id), [eh, el] = limbsOf(end.id);
      const expected = [sh, sl, chain.start.height, eh, el, end.height, map.root, BigInt(FOLD_KEY)];
      check(`period ${k}: its ${k === 0 ? "first" : "next"} fold verifies with §4.3's public inputs, ending at the block with the map's root`,
        (await verifies(fold)) && fold.publicInputs.length === 8 && fold.publicInputs.every((x, i) => x === expected[i]));
      done.push({ inputs, leaves, fold, end, mapRoot: map.root });
    }
    const [p0, p1] = done, next = { ...p1.inputs, ...previousInputs(p0.fold) };
    await refused("a node over children that do not join", "node", nodeInputs(p1.leaves[0], p1.leaves[2]));
    // §2 rule 1: a tree whose nodes carry another key-hash input than the node's own key's (here 7) is not the fold's.
    {
      const mini = new Chain(), block = mini.mine(mini.anchor, [transaction([plainOutput])]);
      const m = new SubjectMap(mini.anchor.id, mini.anchor.height);
      const run = periodLeaves(m, [{ header: block.bytes, transactions: block.section, id: block.id, height: block.height }], SIZES, 7n);
      const { root: top } = await tree(run.leaves, 7n, "another node key");
      await refused("a first fold over a node carrying another node key hash", "fold-first", foldInputs(run.start, run.end, mini.anchor, m, rootInputs(top)));
    }
    await refused("a next fold naming another foldKeyHash than its previous fold's", "fold-next", { ...next, fold_key_hash: "7" });
    await refused("a next fold naming another start than its previous fold's", "fold-next", { ...next, start_height: dec(chain.start.height + 1n) });
    await refused("a next fold whose previous fold is its own period's", "fold-next", { ...next, ...previousInputs(p1.fold) });

    // The reader's §4.3 rules under the shipped set, its verifier instances holding the same points' `[1]_1` and `[x]_2`.
    const set = shippedExhaustionSet(chain.start, async () => startExhaustionBackend(await parameters(), { threads: 1 }));
    try {
      const at = new Map(chain.blocks.map(b => [b.height, b]));
      const readerChain = { at: h => { const b = at.get(h); return b && { id: b.id, transactionsRoot: b.header.subarray(65, 97) }; }, tipHeight: chain.blocks.at(-1).height };
      const folds = done.map((d, k) => ({ first: k === 0, proof: d.fold.proof, inputs: { startId: chain.start.id, startHeight: chain.start.height,
        endId: d.end.id, endHeight: d.end.height, mapRoot: d.mapRoot, foldKeyHash: set.foldKeyHash } }));
      for (const [k, fold] of folds.entries()) {
        const taken = await checkFold(set, fold, readerChain, 0n);
        check(`the reader takes period ${k}'s fold (checkFold)`, "inputs" in taken && taken.inputs.mapRoot === fold.inputs.mapRoot, taken.refused);
      }
      const last = folds[1], with_ = change => ({ ...last, inputs: { ...last.inputs, ...change } });
      const rejects = async (name, fold, expected, depth = 0n) => {
        const r = await checkFold(set, fold, readerChain, depth);
        check(`the reader refuses ${name}`, r.refused === expected, r.refused ?? "accepted");
      };
      await rejects("a fold with another map root", with_({ mapRoot: last.inputs.mapRoot + 1n }), "fold-proof");
      await rejects("a next fold's proof under the first fold's key", { ...last, first: true }, "fold-proof");
      await rejects("the first fold's proof for the next fold's inputs", { ...last, proof: folds[0].proof }, "fold-proof");
      await rejects("a fold ending at another header", with_({ endId: chain.blocks[0].id }), "fold-end");
      await rejects("a fold above the depth", last, "fold-depth", 1n);
      await rejects("a fold from another start", with_({ startHeight: chain.start.height + 1n }), "fold-start");
      await rejects("a fold naming another fold key hash", with_({ foldKeyHash: 7n }), "fold-key");
    } finally {
      await set.close();
    }
  } finally {
    await backend.close();
  }
}

finish();
section.result =failed === 0 ? "pass" : `${failed} failures`;
if (option("--report")) {
  const file = option("--report");
  const kept = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const report = { specification: EXHAUSTION_SPECIFICATION, small: kept.small ?? null, shipped: kept.shipped ?? null };
  report[shipped ? "shipped" : "small"] = { ...section, revision: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(failed === 0 ? "exhaustion-check: pass" : `exhaustion-check: ${failed} failures`);
if (failed) process.exitCode = 1;
