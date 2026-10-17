// The exhaustion's agreement corpus (succinct-read §6): named Ergo days, mainnet ones recorded from a public node and
// testnet ones, which carry the reference's publications, from an archive node, each judged three ways. Every header
// id, parent link and transactions root is recomputed from the bytes and each day is pinned by its start and end ids
// (nothing a node says is trusted). Every transaction's entries are read by the scan (src/ergo-scan.ts, the tables the
// circuits evaluate) and by the framer (venue-ergo §§5–6): inside the grammar they must be equal, and the day's map
// root from the framer's entries (the scan's outside the grammar, §4.2) must be the SubjectMap's. With `--execute`, the
// day is cut into the replica's periods of 64 blocks and every leaf, node and fold is executed by the pinned nargo over
// the shipped full-size circuits (the programs an adoption names), with placeholder proofs: execution checks every
// constraint but the recursive verifications, which the proving checks cover. The crafted transactions of the
// execution check run through the full-size transaction leaf as well.
//
//   node scripts/venue/exhaustion-corpus.mjs fetch [day ...]
//   node scripts/venue/exhaustion-corpus.mjs fetch <first height> <last height> <out.json>
//   node scripts/venue/exhaustion-corpus.mjs check [--execute <workers>] [--limit <blocks>] [--report <file>] [day ...]
//   node scripts/venue/exhaustion-corpus.mjs scan <first height> <last height>
//
// Days are recorded in scratch/exhaustion-corpus/<day>.json (ERGO_NODE names the mainnet node, https://node.ergo.watch
// by default; ERGO_TESTNET_NODE the testnet archive node, the own node at http://127.0.0.1:9052 by default); a stopped
// fetch resumes from the blocks it kept. Run after `npm run build`; `--execute` needs NARGO (the
// pinned nargo) and compiles the shipped circuits once into scratch/exhaustion-programs (about nine minutes).
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { blake2b } from "@noble/hashes/blake2b.js";
import { craftedTransactions, syntheticPeriod } from "./exhaustion-periods.mjs";
import { parseNodeJson, supplyBlock, supplyHeader } from "../../dist/ergo-supplier.js";
import { autolykosPowValid, parseErgoHeader } from "../../dist/ergo-headers.js";
import { sectionMatchesRoot, shapedOutputs } from "../../dist/ergo-profile.js";
import { scanTransaction } from "../../dist/ergo-scan.js";
import { EMPTY_SUBTREES, entryChain, MAP_DEPTH, mapLeaf, mapNode, SubjectMap, subjectKey } from "../../dist/ergo-exhaustion.js";
import { foldStateInputs, isPeriodEnd, periodLeaves, startState, stateEnd, transactionLeaf } from "../../dist/ergo-exhaustion-prover.js";
import { EXHAUSTION_PROOF_BYTES, EXHAUSTION_SET_MANIFEST, exhaustionKeys } from "../../dist/ergo-exhaustion-set.js";
import { crateName, exhaustionPrograms, proverToml } from "../../dist/ergo-exhaustion-programs.js";
import { fieldToHex, limbsOf } from "../../dist/pool/field.js";

const root = path.resolve(import.meta.dirname, "../..");
const store = path.join(root, "scratch/exhaustion-corpus");

/** The named days: 720 consecutive blocks each (about a day of Ergo at two minutes a block), chosen for what they cover,
 * each pinned by its start (the parent of its first block) and its last block's id, so a node can only make a day fail,
 * never pass on another chain (a testnet day's headers carry little work: most of a quiet day is at difficulty 1).
 * Every mainnet day lies above venue-ergo §3's lowest anchor (844,672), where a start header can be; these days are
 * §6's corpus. Mainnet holds no output with the shape, so three testnet days add real entries beside it: each is the 720
 * blocks after the anchor of a live drill's reference venue (ERGO_TESTNET_REFERENCE), so its start is the one
 * `venueStart` (src/cli/venue.ts) gives that venue, and its entries are the reference publisher's records. A day
 * with `entries` fails without them. */
export const CORPUS = Object.freeze([
  { name: "v2-to-v3", network: "mainnet", first: 889496, last: 890215, covers: "header version 2 to 3 (the first version-3 block is 889,856)",
    start: "936a24c51a2fb70513f60dd2811c624f13d197f4f22576cef670d341004a2e98", end: "3c998f3593bdb6b35a5a7c3257f646e206a22584c893a3d41db0d9136479da53" },
  { name: "v3-to-v4", network: "mainnet", first: 1627800, last: 1628519, covers: "header version 3 to 4 (the first version-4 block is 1,628,160)",
    start: "adcb43d542e44bf5b84d42d9192d13115d682dbb33e029d6d02e7d5784d1206b", end: "f9bfe5c4c508301295a0bc93820e43dc4c22cf81e3516bb7a59e50d0a7636bdf" },
  { name: "slice-43", network: "mainnet", first: 1893905, last: 1894624, covers: "a heavy version-4 day (13.3 MB unsigned), slice 43's",
    start: "57f2fdb9399bb450b9fd8062dbc1531fe52579270302fa010792aa3dfc886a43", end: "28126b658dc707da6f5d17ba678806c91e2f3a1074825c1ab6ebf77c150b98b3" },
  // The scope drill's report names its anchor's id (8ca96cd); the command drills' name only its height, so their starts
  // are the own node's headers there, read when the days were recorded.
  { name: "testnet-scope", network: "testnet", first: 574971, last: 575690, entries: true, covers: "the live two-backing scope drill's venue (anchor 574,970, slice 8)",
    start: "c20575d503ba816ce83c29ee918cd37710cb88ad407714b3462fcb556ee063e7", end: "9aa72db2d8a54277e001b6ce219a5342a1f912826f1a7dca4d13c761a9814c15" },
  { name: "testnet-commands-1", network: "testnet", first: 583357, last: 584076, entries: true, covers: "the first live command drill's venue (anchor 583,356, M10d)",
    start: "3bdec1406fd83a7b407c35e221f95d1b765e85624c1e6d14160b2578be14331e", end: "c58987649a67fb8e463fdbf0264badb87c17601876499a72f80b9b6a529fd74e" },
  { name: "testnet-commands-2", network: "testnet", first: 596571, last: 597290, entries: true, covers: "the live command drill's venue at 05337cf (anchor 596,570)",
    start: "9e513e93f67f453fcdaf8a3cda5c3ad258ed5ccd458591d132599f868ac71b8f", end: "4e98f4fa2772c2b9e1dd1bd5d701a49de35457cea42347122eb63d42cf9836b7" },
]);
/** The replica's period (src/cli/venue.ts' PERIOD_BLOCKS). */
const PERIOD = 64;

const argv = process.argv.slice(2);
const option = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
/** A count option: absent, or a positive integer. */
const count = name => {
  const value = option(name);
  if (value === undefined && !argv.includes(name)) return undefined;
  if (!/^[1-9]\d*$/.test(value ?? "")) throw new Error(`${name} takes a positive integer`);
  return Number(value);
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--")).slice(1);
/** The named days asked for (all where none is named); a name outside the corpus is refused. */
const namedDays = () => {
  for (const name of positional) if (!CORPUS.some(d => d.name === name)) throw new Error(`${name} is not a corpus day`);
  for (const d of CORPUS) if (!Object.hasOwn(nodes, d.network)) throw new Error(`${d.name}: no network ${d.network}`);
  return CORPUS.filter(d => positional.length === 0 || positional.includes(d.name));
};
/** A `.part` file's kept lines; a last line cut off mid-write is dropped (its block is fetched again). */
const partLines = file => {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean), out = [];
  lines.forEach((line, i) => {
    try { out.push(JSON.parse(line)); } catch (error) { if (i !== lines.length - 1) throw error; }
  });
  return out;
};
const hex = bytes => Buffer.from(bytes).toString("hex");
const unhex = x => Uint8Array.from(Buffer.from(x, "hex"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// ---- fetch -------------------------------------------------------------------------------------------------------

const nodes = { mainnet: process.env.ERGO_NODE ?? "https://node.ergo.watch", testnet: process.env.ERGO_TESTNET_NODE ?? "http://127.0.0.1:9052" };
const node = nodes.mainnet;
async function fetchText(p, base = node) {
  for (let i = 0; i < 7; i++) {
    try { const r = await fetch(base + p, { signal: AbortSignal.timeout(60_000) }); if (r.ok) return await r.text(); } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** i));
  }
  throw new Error(`the node did not answer ${p}`);
}

/** Records heights `first`–`last` and the parent of the first into `file`, from the node `base`: each header's bytes
 * and id, and its section (unsigned bytes and witness ids). A transaction the node states with bytes that do not hash
 * to its id (Next 4 (cd)) is recorded by id under `unsupplied`, and its block without a section. Kept blocks go to
 * `file.part` as they come. */
async function record(first, last, file, base = node) {
  const text = p => fetchText(p, base);
  const part = `${file}.part`, kept = new Map(partLines(part).map(b => [b.height, b]));
  const headers = new Map();
  for (let h = first - 1; h <= last; h += 100) {
    for (const s of parseNodeJson(await text(`/blocks/chainSlice?fromHeight=${h - 1}&toHeight=${Math.min(last, h + 99)}`))) {
      const height = Number(s.get("height")), header = supplyHeader(s);
      if (!header) throw new Error(`unsupplied header at ${height}`);
      if (height >= first - 1 && height <= last) headers.set(height, { height, id: hex(header.id), bytes: hex(header.bytes) });
    }
  }
  for (let h = first; h <= last; h++) {
    if (!headers.has(h) || headers.get(h).bytes.slice(2, 66) !== headers.get(h - 1)?.id) throw new Error(`header ${h} does not name its parent`);
    if (kept.has(h) && kept.get(h).id !== headers.get(h).id) throw new Error(`kept block ${h} is not on the node's chain`);
  }
  const todo = [];
  for (let h = first; h <= last; h++) if (!kept.has(h)) todo.push(h);
  let done = 0;
  const work = async () => {
    while (todo.length) {
      const h = todo.shift(), header = headers.get(h);
      const { statements, supplied } = supplyBlock(await text(`/blocks/${header.id}/transactions`));
      const block = { ...header };
      const missing = supplied.flatMap((t, i) => (t === undefined ? [String(statements[i].get?.("id") ?? `#${i}`)] : []));
      if (missing.length) block.unsupplied = missing;
      else {
        const read = supplied.map(t => ({ id: blake2b(t.unsigned, { dkLen: 32 }), witnessId: t.witnessId }));
        if (!sectionMatchesRoot(read, unhex(header.bytes).subarray(65, 97))) throw new Error(`section ${h} does not reproduce its root`);
        block.txs = supplied.map(t => ({ u: hex(t.unsigned), w: hex(t.witnessId) }));
      }
      appendFileSync(part, `${JSON.stringify(block)}\n`);
      kept.set(h, block);
      if (++done % 100 === 0) console.log(`${path.basename(file)}: ${kept.size} of ${last - first + 1} blocks`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, work));
  const blocks = Array.from({ length: last - first + 1 }, (_, i) => kept.get(first + i));
  const unsupplied = blocks.flatMap(b => (b.unsupplied ?? []).map(id => ({ height: b.height, id })));
  writeFileSync(`${file}.tmp`, JSON.stringify({ node: base, parent: headers.get(first - 1), blocks, unsupplied }));
  renameSync(`${file}.tmp`, file);
  rmSync(part, { force: true });
  const txs = blocks.reduce((n, b) => n + (b.txs?.length ?? 0), 0);
  console.log(`${path.basename(file)}: ${blocks.length} blocks ${first}–${last}, ${txs} transactions, ${unsupplied.length} unsupplied`);
}

/** Next 4 (cd)'s scan: every block `first`–`last` on the node's best chain, its section copied from the node's JSON
 * and its root reproduced, keeping only counts and any transaction stated with bytes that do not hash to its id. Kept
 * lines (`file.part`) resume a stopped scan; the summary goes to `file`. */
async function scan(first, last, file) {
  const part = `${file}.part`, kept = new Map(partLines(part).map(b => [b.height, b]));
  const todo = [];
  for (let h = first; h <= last; h++) if (!kept.has(h)) todo.push(h);
  const ids = new Map();
  let done = 0;
  const started = Date.now();
  const work = async () => {
    while (todo.length) {
      const h = todo.shift();
      if (!ids.has(h)) {
        const from = h - (h - first) % 100;
        for (const s of parseNodeJson(await fetchText(`/blocks/chainSlice?fromHeight=${from - 1}&toHeight=${Math.min(last, from + 99)}`))) {
          const header = supplyHeader(s);
          if (!header) throw new Error(`unsupplied header at ${s.get("height")}`);
          ids.set(Number(s.get("height")), header);
        }
      }
      const header = ids.get(h);
      const { statements, supplied } = supplyBlock(await fetchText(`/blocks/${hex(header.id)}/transactions`));
      const line = { height: h, id: hex(header.id), parent: hex(header.bytes.subarray(1, 33)), version: header.bytes[0], txs: supplied.length };
      const missing = supplied.flatMap((t, i) => (t === undefined ? [String(statements[i].get?.("id") ?? `#${i}`)] : []));
      if (missing.length) line.unsupplied = missing;
      else if (!sectionMatchesRoot(supplied.map(t => ({ id: blake2b(t.unsigned, { dkLen: 32 }), witnessId: t.witnessId })), header.bytes.subarray(65, 97))) {
        line.rootMismatch = true;
      }
      appendFileSync(part, `${JSON.stringify(line)}\n`);
      kept.set(h, line);
      ids.delete(h - 300);
      if (++done % 2000 === 0) console.log(`scan: ${kept.size} of ${last - first + 1} blocks, ${((Date.now() - started) / 60000).toFixed(0)} min`);
    }
  };
  // Workers take heights in order; at a batch's first heights two may read the same batch (a cost, not a gap: the parent
  // links below are checked over every line).
  await Promise.all(Array.from({ length: 3 }, work));
  const lines = Array.from({ length: last - first + 1 }, (_, i) => kept.get(first + i));
  lines.forEach((l, i) => { if (i > 0 && l.parent !== lines[i - 1].id) throw new Error(`block ${l.height} does not follow the scanned ${l.height - 1}: scan again`); });
  const summary = {
    node, first, last, blocks: lines.length, transactions: lines.reduce((n, l) => n + l.txs, 0),
    versions: lines.reduce((v, l) => ({ ...v, [l.version]: (v[l.version] ?? 0) + 1 }), {}),
    unsupplied: lines.flatMap(l => (l.unsupplied ?? []).map(id => ({ height: l.height, id }))),
    rootMismatches: lines.filter(l => l.rootMismatch).map(l => l.height),
    lines: sha256(lines.map(l => JSON.stringify(l)).join("\n")),
  };
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`scan ${first}–${last}: ${summary.blocks} blocks, ${summary.transactions} transactions, ${summary.unsupplied.length} unsupplied, ${summary.rootMismatches.length} root mismatches`);
}

// ---- check -------------------------------------------------------------------------------------------------------

/** A recorded day as the prover reads blocks, re-authenticated here: each header parsed in the node's canonical form
 * (venue-ergo §3) with its work, its id from the bytes, its parent and its height read from the bytes, each section's
 * root; a block carries a section or the ids it could not be copied with, never neither. */
function readDay(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const parsed = bytes => {
    const header = parseErgoHeader(bytes);
    if (header === undefined || !autolykosPowValid(header)) throw new Error(`a header that is not canonical or lacks its work: ${hex(bytes).slice(0, 80)}`);
    return header;
  };
  const top = parsed(unhex(data.parent.bytes));
  let parent = { id: top.id, height: top.height };
  if (!same(top.id, unhex(data.parent.id)) || top.height !== BigInt(data.parent.height)) throw new Error("the parent is not its bytes'");
  const start = parent, blocks = [];
  for (const b of data.blocks) {
    const header = unhex(b.bytes), read = parsed(header), id = read.id;
    if (!same(id, unhex(b.id)) || !same(read.parentId, parent.id) || read.height !== parent.height + 1n || BigInt(b.height) !== read.height) {
      throw new Error(`block ${b.height} does not follow its parent`);
    }
    if ((b.txs === undefined) === (b.unsupplied === undefined)) throw new Error(`block ${b.height} has no section and names nothing unsupplied`);
    const transactions = b.txs?.map(x => ({ unsigned: unhex(x.u), witnessId: unhex(x.w) }));
    if (transactions && !sectionMatchesRoot(transactions.map(t => ({ id: blake2b(t.unsigned, { dkLen: 32 }), witnessId: t.witnessId })), header.subarray(65, 97))) {
      throw new Error(`block ${b.height}'s section does not reproduce its root`);
    }
    blocks.push({ header, id, height: BigInt(b.height), version: header[0], transactions, unsupplied: b.unsupplied });
    parent = { id, height: BigInt(b.height) };
  }
  return { start, blocks, node: data.node, digest: sha256(readFileSync(file)) };
}

/** The map's root over `entries` in order (§4.2), computed here apart from SubjectMap. */
function mapRoot(entries) {
  const keys = new Map();
  for (const e of entries) {
    const k = subjectKey(e.subject), at = keys.get(k) ?? { count: 0n, chain: 0n };
    keys.set(k, { count: at.count + 1n, chain: entryChain(at.chain, e) });
  }
  let level = new Map([...keys].map(([k, v]) => [k, mapLeaf(v.count, v.chain)]));
  for (let l = 0; l < MAP_DEPTH; l++) {
    const up = new Map();
    for (const index of level.keys()) {
      const parent = index >> 1n;
      if (up.has(parent)) continue;
      up.set(parent, mapNode(level.get(parent * 2n) ?? EMPTY_SUBTREES[l], level.get(parent * 2n + 1n) ?? EMPTY_SUBTREES[l]));
    }
    level = up;
  }
  return level.get(0n) ?? EMPTY_SUBTREES[MAP_DEPTH];
}

/** The scan against the framer over every transaction of a day, and the map's root both ways. */
function agreement(day) {
  const tally = { transactions: 0, grammatical: 0, framerEntries: 0, ungrammatical: 0, scanEntriesOutside: 0, disagreements: [] };
  const entries = [];
  const versions = {};
  const map = new SubjectMap(day.start.id, day.start.height);
  for (const block of day.blocks) {
    versions[block.version] = (versions[block.version] ?? 0) + 1;
    if (!block.transactions) continue;
    block.transactions.forEach(({ unsigned }, position) => {
      tally.transactions++;
      const scanned = scanTransaction(unsigned), framed = shapedOutputs(unsigned);
      const own = framed ?? scanned;
      if (framed === undefined) { tally.ungrammatical++; tally.scanEntriesOutside += scanned.length; }
      else {
        tally.grammatical++; tally.framerEntries += framed.length;
        const equal = framed.length === scanned.length && framed.every((x, i) => x.output === scanned[i].output && same(x.subject, scanned[i].subject));
        if (!equal) tally.disagreements.push({ height: Number(block.height), position });
      }
      for (const x of own) entries.push({ subject: x.subject, height: block.height, position: BigInt(position), output: BigInt(x.output) });
    });
    map.appendBlock(block.id, block.transactions.map(x => x.unsigned));
  }
  const framerRoot = mapRoot(entries);
  return { ...tally, versions, mapRoot: fieldToHex(map.root), framerRoot: fieldToHex(framerRoot), rootsEqual: framerRoot === map.root };
}

/** Witnesses by `nargo execute` over copies of the kept crates, `workers` at a time; a refusal is the circuit's message.
 * nargo holds a lock on a crate's manifest while it executes, so each worker runs in a copy of its own (this process's).
 * `programs()` reads every copy's compiled bytecode identity, which must still be the manifest's after the run (nargo
 * compiles a copy again, unchecked, where it does not take the kept program as its own). */
function executor(nargo, directory, workers) {
  const run = promisify(execFile), env = { ...process.env };
  delete env.NOIR_LOG;
  const copies = path.join(store, `crates-${process.pid}`);
  rmSync(copies, { recursive: true, force: true });
  for (let w = 0; w < workers; w++) cpSync(directory, path.join(copies, String(w)), { recursive: true });
  const free = Array.from({ length: workers }, (_, w) => w), waiting = [];
  const execute = async (circuit, inputs) => {
    const toml = proverToml(inputs);
    // A finishing execution hands its copy to the next waiting one, so at most `workers` run.
    const worker = free.length ? free.pop() : await new Promise(resolve => waiting.push(resolve));
    const crate = path.join(copies, String(worker), circuit), name = `corpus-${randomUUID()}`;
    try {
      writeFileSync(path.join(crate, `${name}.toml`), toml);
      await run(nargo, ["execute", "--program-dir", crate, "--prover-name", name, name], { maxBuffer: 1 << 26, env });
      return undefined;
    } catch (error) {
      const out = `${error.stderr ?? ""}${error.stdout ?? ""}`;
      return /Assertion failed: [^\n]*/.exec(out)?.[0] ?? (error.signal ? `stopped by ${error.signal}` : (/^error: [^\n]*/m.exec(out)?.[0] ?? error.message.split("\n")[0]));
    } finally {
      rmSync(path.join(crate, `${name}.toml`), { force: true });
      rmSync(path.join(crate, "target", `${name}.gz`), { force: true });
      const next = waiting.shift();
      if (next) next(worker);
      else free.push(worker);
    }
  };
  execute.programs = () => Array.from({ length: workers }, (_, w) => Object.keys(EXHAUSTION_SET_MANIFEST.circuits).every(circuit => {
    const program = JSON.parse(readFileSync(path.join(copies, String(w), circuit, "target", `${crateName(circuit)}.json`), "utf8"));
    return createHash("sha256").update(Buffer.from(program.bytecode, "base64")).digest("hex") === EXHAUSTION_SET_MANIFEST.circuits[circuit].bytecode;
  })).every(Boolean);
  execute.close = () => rmSync(copies, { recursive: true, force: true });
  return execute;
}

const keys = exhaustionKeys();
const fieldsOf = bytes => Array.from({ length: bytes.length / 32 }, (_, i) => "0x" + hex(bytes.subarray(i * 32, (i + 1) * 32)));
const placeholder = Array(EXHAUSTION_PROOF_BYTES / 32).fill("0");
const keyOf = circuit => ({ fields: fieldsOf(keys[circuit].vk), hash: fieldToHex(keys[circuit].keyHash) });
const leafCircuit = { t: "leaf-t", m: "leaf-m", u: "leaf-u" };

/** Every leaf, node and fold of a day's periods executed; each refusal named. Every input is the prover's own (the
 * nodes' state hashes come from the leaves'), so a period's executions all wait on the worker bound together, and two
 * periods are in flight at once. */
async function execute(day, execute, log) {
  const sizes = EXHAUSTION_SET_MANIFEST.sizes, nodeKey = keyOf("node");
  const map = new SubjectMap(day.start.id, day.start.height);
  const result = { periods: 0, leaves: { t: 0, m: 0, u: 0 }, nodes: 0, folds: 0, controls: [], refusals: [] };
  const started = Date.now(), limit = count("--limit") ?? day.blocks.length;
  const inFlight = new Set();
  let previous, previousEnd;
  for (let at = 0; at < Math.min(limit, day.blocks.length); at += PERIOD) {
    const blocks = day.blocks.slice(at, at + PERIOD);
    const run = periodLeaves(map, blocks, sizes, keys.node.keyHash);
    const label = `${blocks[0].height}–${blocks.at(-1).height}`;
    const refuse = (what, why) => { result.refusals.push({ period: label, what, why }); log(`REFUSED ${label} ${what}: ${why}`); };
    if (!isPeriodEnd(run.end) || run.end.u.root !== map.root || !same(stateEnd(run.end).id, blocks.at(-1).id)) refuse("period", "the leaves do not end at its last block with the map's root");
    // Placeholder proofs check no fold's previous fold, so the join between folds is checked here: a period starts at the
    // header and map root its previous period ended at (its chains start at zero, §4.3).
    if (previousEnd !== undefined && (!same(stateEnd(run.start).id, stateEnd(previousEnd).id) || stateEnd(run.start).height !== stateEnd(previousEnd).height ||
        run.start.u.root !== previousEnd.u.root)) refuse("period", "does not start where the previous period ended");
    previousEnd = run.end;
    // Leaves; each joins the next by its state hashes. A day's first leaf of each kind is also executed under an end state
    // off by one, which its circuit must refuse by name: a control that the executions judge at all, the map-update
    // leaf's included where the day has entries.
    for (const l of run.leaves) {
      if (result.controls.some(c => c.leaf === l.kind)) continue;
      const control = { leaf: l.kind, refusal: (await execute(leafCircuit[l.kind], { ...l.inputs, sout: String(l.sout + 1n) })) ?? null };
      result.controls.push(control);
      if (!/Assertion failed: .*end state/.test(control.refusal ?? "")) refuse(`control (${l.kind})`, `a leaf with another end state: ${control.refusal ?? "executes"}`);
    }
    const work = run.leaves.map((l, i) => {
      result.leaves[l.kind]++;
      if (i > 0 && run.leaves[i - 1].sout !== l.sin) refuse(`leaf ${i}`, "does not join");
      return execute(leafCircuit[l.kind], l.inputs).then(why => why === undefined || refuse(`leaf ${i} (${l.kind})`, why));
    });
    // Nodes pairwise, level by level, as the pool joins them; each child is a leaf's or a node's statement.
    let level = run.leaves.map(l => ({ sin: l.sin, sout: l.sout, key: keyOf(leafCircuit[l.kind]) }));
    while (level.length > 1) {
      const up = [];
      for (let i = 0; i + 1 < level.length; i += 2) {
        const [a, b] = [level[i], level[i + 1]];
        result.nodes++;
        work.push(execute("node", {
          sin: fieldToHex(a.sin), sout: fieldToHex(b.sout), node_key_hash: nodeKey.hash, keys: [a.key.fields, b.key.fields],
          proofs: [placeholder, placeholder], key_hashes: [a.key.hash, b.key.hash], middle: fieldToHex(a.sout),
        }).then(why => why === undefined || refuse(`node over ${a.sin}`, why)));
        up.push({ sin: a.sin, sout: b.sout, key: nodeKey });
      }
      if (level.length % 2) up.push(level.at(-1));
      level = up;
    }
    const [sh, sl] = limbs(day.start.id), [eh, el] = limbs(blocks.at(-1).id);
    const top = level[0];
    const inputs = {
      start_hi: sh, start_lo: sl, start_height: fieldToHex(day.start.height), end_hi: eh, end_lo: el, end_height: fieldToHex(blocks.at(-1).height),
      map_root: fieldToHex(map.root), fold_key_hash: keyOf("fold-next").hash, key: top.key.fields, proof: placeholder, key_hash: top.key.hash,
      ...foldStateInputs(run.start, "0"), ...foldStateInputs(run.end, "1"),
    };
    if (previous !== undefined) Object.assign(inputs, { previous_key: previous.fields, previous_proof: placeholder, previous_key_hash: previous.hash });
    const circuit = previous === undefined ? "fold-first" : "fold-next";
    result.folds++;
    work.push(execute(circuit, inputs).then(why => why === undefined || refuse(circuit, why)));
    previous = keyOf(circuit);
    result.periods++;
    const leaves = run.leaves.length;
    const period = Promise.all(work).then(() => log(`${label}: ${leaves} leaves executed, ${((Date.now() - started) / 60000).toFixed(1)} min`));
    inFlight.add(period);
    period.finally(() => inFlight.delete(period));
    if (inFlight.size >= 2) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);
  result.minutes = Number(((Date.now() - started) / 60000).toFixed(1));
  return result;
}
const limbs = id => limbsOf(id).map(fieldToHex);

/** The crafted transactions, each as one full-size transaction leaf from a fresh state: the prover's entries must be
 * scanTransaction's and the leaf must execute. */
async function crafted(execute) {
  const size = EXHAUSTION_SET_MANIFEST.sizes.t, s1 = startState(new Uint8Array(32).fill(1), 900000n, 0n);
  const result = { transactions: 0, grammatical: 0, entries: 0, refusals: [] };
  await Promise.all(craftedTransactions(size * 128).map(async (unsigned, index) => {
    const n = Math.max(1, Math.ceil(unsigned.length / 128));
    const slots = Array.from({ length: n }, (_, k) => ({ bytes: unsigned.subarray(k * 128, (k + 1) * 128), start: k === 0, newBlock: k === 0, last: k === n - 1 }));
    const r = transactionLeaf(s1, slots, size, keys.node.keyHash), scanned = scanTransaction(unsigned), framed = shapedOutputs(unsigned);
    const equal = scanned.length === r.entries.length && scanned.every((x, i) => BigInt(x.output) === r.entries[i].output &&
      limbs(x.subject).join() === [r.entries[i].hi, r.entries[i].lo].map(fieldToHex).join());
    const framerEqual = framed === undefined || (framed.length === scanned.length && framed.every((x, i) => x.output === scanned[i].output && same(x.subject, scanned[i].subject)));
    const why = await execute("leaf-t", r.leaf.inputs);
    result.transactions++; result.entries += r.entries.length;
    if (framed !== undefined) result.grammatical++;
    if (!equal) result.refusals.push({ index, why: "the prover's entries are not scanTransaction's" });
    if (!framerEqual) result.refusals.push({ index, why: "the scan's entries are not the framer's" });
    if (why !== undefined) result.refusals.push({ index, why });
  }));
  return result;
}

/** What a verdict here depends on: this tool and its periods, the modules it runs (their built copies in dist/ come from
 * these), the shipped circuit sources and the vendored sponge they share. */
const files = ["scripts/venue/exhaustion-corpus.mjs", "scripts/venue/exhaustion-periods.mjs", "src/ergo-scan.ts", "src/ergo-profile.ts",
  "src/ergo-headers.ts", "src/ergo-exhaustion.ts", "src/ergo-exhaustion-prover.ts", "src/ergo-exhaustion-set.ts", "src/ergo-exhaustion-programs.ts",
  "src/ergo-supplier.ts", "src/ergo-synthetic.ts", "src/pool/poseidon2.ts", "src/pool/field.ts", "src/bytes.ts", "src/record-range.ts",
  "src/contexts.ts", "src/exhaustion-circuits/exhaustion.nr", "src/exhaustion-circuits/blake2b.nr",
  ...["leaf-t", "leaf-m", "leaf-u", "node", "fold-first", "fold-next"].map(c => `src/exhaustion-circuits/${c}.nr`), "src/pool/circuits/vendor/poseidon2.nr"];

const command = argv[0];
if (command === "scan") {
  mkdirSync(store, { recursive: true });
  const [first, last] = positional.map(Number);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) throw new Error("usage: scan <first height> <last height>");
  await scan(first, last, path.join(store, `scan-${first}-${last}.json`));
} else if (command === "fetch") {
  mkdirSync(store, { recursive: true });
  if (positional.length === 3 && /^\d+$/.test(positional[0])) await record(Number(positional[0]), Number(positional[1]), positional[2]);
  else for (const day of namedDays()) {
    const file = path.join(store, `${day.name}.json`);
    if (existsSync(file)) { console.log(`${day.name}: kept`); continue; }
    await record(day.first, day.last, file, nodes[day.network]);
  }
} else if (command === "check") {
  const workers = count("--execute") ?? 0, limit = count("--limit"), days = namedDays();
  const whole = positional.length === 0 && limit === undefined;
  const report = {
    specification: "succinct-read §6 (agreement corpus); venue-ergo §§3–6", host: cpus()[0]?.model,
    revision: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    run: { days: days.map(d => d.name), workers, limit: limit ?? null, whole },
    sources: Object.fromEntries(files.map(f => [f, sha256(readFileSync(path.join(root, f)))])),
    circuits: workers ? { compiler: EXHAUSTION_SET_MANIFEST.compiler, sizes: EXHAUSTION_SET_MANIFEST.sizes,
      bytecode: Object.fromEntries(Object.entries(EXHAUSTION_SET_MANIFEST.circuits).map(([k, v]) => [k, v.bytecode])) } : undefined,
    days: [],
  };
  let failed = 0;
  const log = line => console.log(line);
  const fail = message => { failed++; console.error(`FAIL ${message}`); };
  let run;
  if (workers) {
    if (!process.env.NARGO) throw new Error("--execute needs NARGO, the pinned nargo");
    const directory = path.join(root, "scratch/exhaustion-programs");
    exhaustionPrograms({ nargo: process.env.NARGO, directory, log });
    run = executor(process.env.NARGO, directory, workers);
  }
  /** An execution that judged nothing, whose controls were not refused by name, or that has entries but no map-update
   * control, fails like a refusal. */
  const judged = (label, execution, entries) => {
    if (execution.periods === 0 || execution.controls.length === 0) fail(`${label}: nothing executed`);
    if (entries > 0 && !execution.controls.some(c => c.leaf === "u")) fail(`${label}: entries without a map-update control`);
    if (execution.refusals.length) fail(`${label}: ${execution.refusals.length} refusals`);
  };
  for (const day of days) {
    const file = path.join(store, `${day.name}.json`);
    if (!existsSync(file)) throw new Error(`${day.name} is not recorded: run fetch first`);
    const read = readDay(file);
    const entry = { name: day.name, network: day.network, node: read.node, covers: day.covers, first: day.first, last: day.last, recorded: read.digest,
      start: hex(read.start.id), end: hex(read.blocks.at(-1).id), blocks: read.blocks.length,
      unsignedBytes: read.blocks.reduce((n, b) => n + (b.transactions ?? []).reduce((m, t) => m + t.unsigned.length, 0), 0),
      unsupplied: read.blocks.flatMap(b => (b.unsupplied ?? []).map(id => ({ height: Number(b.height), id }))) };
    if (read.blocks.length !== day.last - day.first + 1 || read.blocks[0].height !== BigInt(day.first)) throw new Error(`${day.name}: not the named heights`);
    if (entry.start !== day.start || entry.end !== day.end) throw new Error(`${day.name}: not the pinned chain`);
    // A block whose section could not be copied (Next 4 (cd)) is a day not read: it fails whether or not it executes.
    if (entry.unsupplied.length) fail(`${day.name}: ${entry.unsupplied.length} transactions without their bytes`);
    entry.agreement = agreement(read);
    if (entry.agreement.disagreements.length || !entry.agreement.rootsEqual) fail(`${day.name}: the scan and the framer disagree`);
    if (day.entries && entry.agreement.framerEntries === 0) fail(`${day.name}: no entries`);
    console.log(`${day.name}: ${entry.blocks} blocks, ${entry.agreement.transactions} transactions (${entry.agreement.grammatical} grammatical, ` +
      `${entry.agreement.framerEntries} framer entries; ${entry.agreement.ungrammatical} outside, ${entry.agreement.scanEntriesOutside} scan entries), ` +
      `versions ${JSON.stringify(entry.agreement.versions)}, ${entry.unsupplied.length} unsupplied`);
    if (workers && !entry.unsupplied.length) {
      entry.execution = await execute(read, run, line => log(`${day.name} ${line}`));
      judged(day.name, entry.execution, entry.agreement.framerEntries + entry.agreement.scanEntriesOutside);
    }
    report.days.push(entry);
  }
  if (workers && positional.length === 0) {
    // The mainnet days hold no output with the shape and the testnet days only the reference publisher's, in light
    // blocks; the synthetic period adds what neither has (both root rules, two subjects sharing a key, kind-4 runs, an
    // ungrammatical transaction's shaped output), so its map-update leaves run at full size too.
    const synthetic = syntheticPeriod(9);
    report.synthetic = { agreement: agreement({ ...synthetic, blocks: synthetic.blocks.map(b => ({ ...b, version: b.header[0] })) }) };
    report.synthetic.execution = await execute(synthetic, run, line => log(`synthetic ${line}`));
    judged("synthetic", report.synthetic.execution, report.synthetic.agreement.framerEntries + report.synthetic.agreement.scanEntriesOutside);
    if (!report.synthetic.agreement.rootsEqual || report.synthetic.agreement.disagreements.length) fail("synthetic: the scan and the framer disagree");
    report.crafted = await crafted(run);
    if (report.crafted.refusals.length) fail(`crafted: ${JSON.stringify(report.crafted.refusals.slice(0, 5))}`);
    console.log(`crafted: ${report.crafted.transactions} transactions (${report.crafted.grammatical} grammatical), ${report.crafted.entries} entries, each a full-size leaf executed`);
  }
  if (run) {
    report.programsUnchanged = run.programs();
    if (!report.programsUnchanged) fail("a crate copy's program is no longer the manifest's");
    run.close();
  }
  // The (cd) scan, where it has run to its end: kept beside the days, produced by this tool's `scan`.
  for (const name of existsSync(store) ? readdirSync(store).filter(n => /^scan-\d+-\d+\.json$/.test(n)) : []) {
    const summary = JSON.parse(readFileSync(path.join(store, name), "utf8"));
    (report.scans ??= []).push(summary);
    if (summary.unsupplied.length || summary.rootMismatches.length) console.log(`${name}: ${summary.unsupplied.length} unsupplied, ${summary.rootMismatches.length} root mismatches (Next 4 (cd))`);
  }
  report.result = failed !== 0 ? `${failed} failures` : whole ? "pass" : "pass (partial: a limit or named days)";
  if (option("--report")) writeFileSync(option("--report"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`exhaustion-corpus: ${report.result}`);
  if (failed) process.exitCode = 1;
} else {
  throw new Error("usage: exhaustion-corpus.mjs fetch [day ...] | fetch <first> <last> <out.json> | scan <first> <last> | " +
    "check [--execute <workers>] [--limit <blocks>] [--report <file>] [day ...]");
}
