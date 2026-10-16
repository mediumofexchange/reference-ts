// The exhaustion's agreement corpus (succinct-read §6): named Ergo mainnet days, each recorded from a public node and
// judged three ways. Every header id, parent link and transactions root is recomputed from the bytes (nothing a node
// says is trusted). Every transaction's entries are read by the scan (src/ergo-scan.ts, the tables the circuits
// evaluate) and by the framer (venue-ergo §§5–6): inside the grammar they must be equal, and the day's map root from the
// framer's entries (the scan's outside the grammar, §4.2) must be the SubjectMap's. With `--execute`, the day is cut
// into the replica's periods of 64 blocks and every leaf, node and fold is executed by the pinned nargo over the
// shipped full-size circuits (the programs an adoption names), with placeholder proofs: execution checks every
// constraint but the recursive verifications, which the proving checks cover. The crafted transactions of the
// execution check run through the full-size transaction leaf as well.
//
//   node scripts/venue/exhaustion-corpus.mjs fetch [day ...]
//   node scripts/venue/exhaustion-corpus.mjs fetch <first height> <last height> <out.json>
//   node scripts/venue/exhaustion-corpus.mjs check [--execute <workers>] [--limit <blocks>] [--report <file>] [day ...]
//   node scripts/venue/exhaustion-corpus.mjs scan <first height> <last height>
//
// Days are recorded in scratch/exhaustion-corpus/<day>.json (ERGO_NODE names the node; https://node.ergo.watch by
// default); a stopped fetch resumes from the blocks it kept. Run after `npm run build`; `--execute` needs NARGO (the
// pinned nargo) and compiles the shipped circuits once into scratch/exhaustion-programs (about nine minutes).
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { blake2b } from "@noble/hashes/blake2b.js";
import { craftedTransactions, syntheticPeriod } from "./exhaustion-periods.mjs";
import { parseNodeJson, supplyBlock, supplyHeader } from "../../dist/ergo-supplier.js";
import { sectionMatchesRoot, shapedOutputs } from "../../dist/ergo-profile.js";
import { scanTransaction } from "../../dist/ergo-scan.js";
import { EMPTY_SUBTREES, entryChain, MAP_DEPTH, mapLeaf, mapNode, SubjectMap, subjectKey } from "../../dist/ergo-exhaustion.js";
import { foldStateInputs, isPeriodEnd, periodLeaves, startState, stateEnd, transactionLeaf } from "../../dist/ergo-exhaustion-prover.js";
import { EXHAUSTION_PROOF_BYTES, EXHAUSTION_SET_MANIFEST, exhaustionKeys } from "../../dist/ergo-exhaustion-set.js";
import { exhaustionPrograms, proverToml } from "../../dist/ergo-exhaustion-programs.js";
import { fieldToHex, limbsOf } from "../../dist/pool/field.js";

const root = path.resolve(import.meta.dirname, "../..");
const store = path.join(root, "scratch/exhaustion-corpus");

/** The named days: 720 consecutive blocks each (about a day of Ergo mainnet at two minutes a block), chosen for what
 * they cover. Every day lies above venue-ergo §3's lowest anchor (844,672), where a start header can be. */
export const CORPUS = Object.freeze([
  { name: "v2-to-v3", first: 889496, last: 890215, covers: "header version 2 to 3 (the first version-3 block is 889,856)" },
  { name: "v3-to-v4", first: 1627800, last: 1628519, covers: "header version 3 to 4 (the first version-4 block is 1,628,160)" },
  { name: "slice-43", first: 1893905, last: 1894624, covers: "a heavy version-4 day (13.3 MB unsigned), slice 43's" },
]);
/** The replica's period (src/cli/venue.ts' PERIOD_BLOCKS). */
const PERIOD = 64;

const argv = process.argv.slice(2);
const option = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--")).slice(1);
const hex = bytes => Buffer.from(bytes).toString("hex");
const unhex = x => Uint8Array.from(Buffer.from(x, "hex"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// ---- fetch -------------------------------------------------------------------------------------------------------

const node = process.env.ERGO_NODE ?? "https://node.ergo.watch";
async function text(p) {
  for (let i = 0; i < 7; i++) {
    try { const r = await fetch(node + p, { signal: AbortSignal.timeout(60_000) }); if (r.ok) return await r.text(); } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** i));
  }
  throw new Error(`the node did not answer ${p}`);
}

/** Records heights `first`–`last` and the parent of the first into `file`: each header's bytes and id, and its section
 * (unsigned bytes and witness ids). A transaction the node states with bytes that do not hash to its id (Next 4 (cd))
 * is recorded by id under `unsupplied`, and its block without a section. Kept blocks go to `file.part` as they come. */
async function record(first, last, file) {
  const part = `${file}.part`, kept = new Map();
  if (existsSync(part)) for (const line of readFileSync(part, "utf8").split("\n")) if (line) { const b = JSON.parse(line); kept.set(b.height, b); }
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
  writeFileSync(`${file}.tmp`, JSON.stringify({ node, parent: headers.get(first - 1), blocks, unsupplied }));
  renameSync(`${file}.tmp`, file);
  rmSync(part, { force: true });
  const txs = blocks.reduce((n, b) => n + (b.txs?.length ?? 0), 0);
  console.log(`${path.basename(file)}: ${blocks.length} blocks ${first}–${last}, ${txs} transactions, ${unsupplied.length} unsupplied`);
}

/** Next 4 (cd)'s scan: every block `first`–`last` on the node's best chain, its section copied from the node's JSON
 * and its root reproduced, keeping only counts and any transaction stated with bytes that do not hash to its id. Kept
 * lines (`file.part`) resume a stopped scan; the summary goes to `file`. */
async function scan(first, last, file) {
  const part = `${file}.part`, kept = new Map();
  if (existsSync(part)) for (const line of readFileSync(part, "utf8").split("\n")) if (line) { const b = JSON.parse(line); kept.set(b.height, b); }
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
        for (const s of parseNodeJson(await text(`/blocks/chainSlice?fromHeight=${from - 1}&toHeight=${Math.min(last, from + 99)}`))) {
          const header = supplyHeader(s);
          if (!header) throw new Error(`unsupplied header at ${s.get("height")}`);
          ids.set(Number(s.get("height")), header);
        }
      }
      const header = ids.get(h);
      const { statements, supplied } = supplyBlock(await text(`/blocks/${hex(header.id)}/transactions`));
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
  // Workers take heights in order and in chunks of the header batch, so each batch is read once.
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

/** A recorded day as the prover reads blocks, re-authenticated here: ids from the bytes, parents, heights, roots. */
function readDay(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  let parent = { id: unhex(data.parent.id), height: BigInt(data.parent.height) };
  if (!same(blake2b(unhex(data.parent.bytes), { dkLen: 32 }), parent.id)) throw new Error("the parent's id is not its bytes'");
  const start = parent, blocks = [];
  for (const b of data.blocks) {
    const header = unhex(b.bytes), id = blake2b(header, { dkLen: 32 });
    if (!same(id, unhex(b.id)) || !same(header.subarray(1, 33), parent.id) || BigInt(b.height) !== parent.height + 1n) {
      throw new Error(`block ${b.height} does not follow its parent`);
    }
    const transactions = b.txs?.map(x => ({ unsigned: unhex(x.u), witnessId: unhex(x.w) }));
    if (transactions && !sectionMatchesRoot(transactions.map(t => ({ id: blake2b(t.unsigned, { dkLen: 32 }), witnessId: t.witnessId })), header.subarray(65, 97))) {
      throw new Error(`block ${b.height}'s section does not reproduce its root`);
    }
    blocks.push({ header, id, height: BigInt(b.height), version: header[0], transactions, unsupplied: b.unsupplied });
    parent = { id, height: BigInt(b.height) };
  }
  return { start, blocks, digest: sha256(readFileSync(file)) };
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
 * nargo holds a lock on a crate's manifest while it executes, so each worker runs in a copy of its own. */
function executor(nargo, directory, workers) {
  const run = promisify(execFile), env = { ...process.env };
  delete env.NOIR_LOG;
  const copies = path.join(store, "crates");
  rmSync(copies, { recursive: true, force: true });
  for (let w = 0; w < workers; w++) cpSync(directory, path.join(copies, String(w)), { recursive: true });
  const free = Array.from({ length: workers }, (_, w) => w), waiting = [];
  return async (circuit, inputs) => {
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
  const result = { periods: 0, leaves: { t: 0, m: 0, u: 0 }, nodes: 0, folds: 0, refusals: [] };
  const started = Date.now(), limit = Number(option("--limit") ?? day.blocks.length);
  const inFlight = new Set();
  let previous;
  for (let at = 0; at < Math.min(limit, day.blocks.length); at += PERIOD) {
    const blocks = day.blocks.slice(at, at + PERIOD);
    const run = periodLeaves(map, blocks, sizes, keys.node.keyHash);
    const label = `${blocks[0].height}–${blocks.at(-1).height}`;
    const refuse = (what, why) => { result.refusals.push({ period: label, what, why }); log(`REFUSED ${label} ${what}: ${why}`); };
    if (!isPeriodEnd(run.end) || run.end.u.root !== map.root || !same(stateEnd(run.end).id, blocks.at(-1).id)) refuse("period", "the leaves do not end at its last block with the map's root");
    // Leaves; each joins the next by its state hashes. A day's first leaf is also executed under an end state off by one,
    // which must be refused: a control that the executions judge at all.
    if (at === 0) {
      const [first] = run.leaves;
      result.control = { leaf: first.kind, refusal: (await execute(leafCircuit[first.kind], { ...first.inputs, sout: String(first.sout + 1n) })) ?? null };
      if (result.control.refusal === null) refuse("control", "a leaf with another end state executes");
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
  const result = { transactions: 0, entries: 0, refusals: [] };
  await Promise.all(craftedTransactions(size * 128).map(async (unsigned, index) => {
    const n = Math.max(1, Math.ceil(unsigned.length / 128));
    const slots = Array.from({ length: n }, (_, k) => ({ bytes: unsigned.subarray(k * 128, (k + 1) * 128), start: k === 0, newBlock: k === 0, last: k === n - 1 }));
    const r = transactionLeaf(s1, slots, size, keys.node.keyHash), scanned = scanTransaction(unsigned);
    const equal = scanned.length === r.entries.length && scanned.every((x, i) => BigInt(x.output) === r.entries[i].output &&
      fieldToHex(BigInt("0x" + hex(x.subject.subarray(0, 16)))) === fieldToHex(r.entries[i].hi) && fieldToHex(BigInt("0x" + hex(x.subject.subarray(16)))) === fieldToHex(r.entries[i].lo));
    const why = await execute("leaf-t", r.leaf.inputs);
    result.transactions++; result.entries += r.entries.length;
    if (!equal) result.refusals.push({ index, why: "the prover's entries are not scanTransaction's" });
    if (why !== undefined) result.refusals.push({ index, why });
  }));
  return result;
}

const files = ["scripts/venue/exhaustion-corpus.mjs", "scripts/venue/exhaustion-periods.mjs", "src/ergo-scan.ts", "src/ergo-profile.ts",
  "src/ergo-exhaustion.ts", "src/ergo-exhaustion-prover.ts", "src/ergo-exhaustion-set.ts", "src/ergo-exhaustion-programs.ts", "src/ergo-supplier.ts"];

const command = argv[0];
if (command === "scan") {
  mkdirSync(store, { recursive: true });
  const [first, last] = positional.map(Number);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) throw new Error("usage: scan <first height> <last height>");
  await scan(first, last, path.join(store, `scan-${first}-${last}.json`));
} else if (command === "fetch") {
  mkdirSync(store, { recursive: true });
  if (positional.length === 3 && /^\d+$/.test(positional[0])) await record(Number(positional[0]), Number(positional[1]), positional[2]);
  else for (const day of CORPUS.filter(d => positional.length === 0 || positional.includes(d.name))) {
    const file = path.join(store, `${day.name}.json`);
    if (existsSync(file)) { console.log(`${day.name}: kept`); continue; }
    await record(day.first, day.last, file);
  }
} else if (command === "check") {
  const workers = option("--execute") === undefined ? 0 : Number(option("--execute"));
  if (!Number.isSafeInteger(workers) || workers < 0) throw new Error("--execute takes a number of workers");
  const report = {
    specification: "succinct-read §6 (agreement corpus); venue-ergo §§3–6", node, host: cpus()[0]?.model,
    sources: Object.fromEntries(files.map(f => [f, sha256(readFileSync(path.join(root, f)))])),
    circuits: workers ? { compiler: EXHAUSTION_SET_MANIFEST.compiler, sizes: EXHAUSTION_SET_MANIFEST.sizes,
      bytecode: Object.fromEntries(Object.entries(EXHAUSTION_SET_MANIFEST.circuits).map(([k, v]) => [k, v.bytecode])) } : undefined,
    days: [],
  };
  let failed = 0;
  const log = line => console.log(line);
  let run;
  if (workers) {
    if (!process.env.NARGO) throw new Error("--execute needs NARGO, the pinned nargo");
    const directory = path.join(root, "scratch/exhaustion-programs");
    exhaustionPrograms({ nargo: process.env.NARGO, directory, log });
    run = executor(process.env.NARGO, directory, workers);
  }
  for (const day of CORPUS.filter(d => positional.length === 0 || positional.includes(d.name))) {
    const file = path.join(store, `${day.name}.json`);
    if (!existsSync(file)) throw new Error(`${day.name} is not recorded: run fetch first`);
    const read = readDay(file);
    const entry = { name: day.name, covers: day.covers, first: day.first, last: day.last, recorded: read.digest,
      start: hex(read.start.id), end: hex(read.blocks.at(-1).id), blocks: read.blocks.length,
      unsignedBytes: read.blocks.reduce((n, b) => n + (b.transactions ?? []).reduce((m, t) => m + t.unsigned.length, 0), 0),
      unsupplied: read.blocks.flatMap(b => (b.unsupplied ?? []).map(id => ({ height: Number(b.height), id }))) };
    if (read.blocks.length !== day.last - day.first + 1 || read.blocks[0].height !== BigInt(day.first)) throw new Error(`${day.name}: not the named heights`);
    entry.agreement = agreement(read);
    if (entry.agreement.disagreements.length || !entry.agreement.rootsEqual) { failed++; console.error(`FAIL ${day.name}: the scan and the framer disagree`); }
    console.log(`${day.name}: ${entry.blocks} blocks, ${entry.agreement.transactions} transactions (${entry.agreement.grammatical} grammatical, ` +
      `${entry.agreement.framerEntries} framer entries; ${entry.agreement.ungrammatical} outside, ${entry.agreement.scanEntriesOutside} scan entries), ` +
      `versions ${JSON.stringify(entry.agreement.versions)}, ${entry.unsupplied.length} unsupplied`);
    if (workers) {
      if (entry.unsupplied.length) { entry.execution = { skipped: "a block without a section (Next 4 (cd))" }; failed++; }
      else {
        entry.execution = await execute(read, run, line => log(`${day.name} ${line}`));
        if (entry.execution.refusals.length) { failed++; console.error(`FAIL ${day.name}: ${entry.execution.refusals.length} refusals`); }
      }
    }
    report.days.push(entry);
  }
  if (workers && positional.length === 0) {
    // The mainnet days hold no output with the shape; the synthetic period does (both root rules, keys shared and not,
    // kind-4 runs, an ungrammatical transaction's shaped output), so its map-update leaves run at full size too.
    const synthetic = syntheticPeriod(9);
    report.synthetic = { agreement: agreement({ ...synthetic, blocks: synthetic.blocks.map(b => ({ ...b, version: b.header[0] })) }) };
    report.synthetic.execution = await execute(synthetic, run, line => log(`synthetic ${line}`));
    if (report.synthetic.execution.refusals.length || !report.synthetic.agreement.rootsEqual || report.synthetic.agreement.disagreements.length) {
      failed++; console.error("FAIL synthetic");
    }
    report.crafted = await crafted(run);
    if (report.crafted.refusals.length) { failed++; console.error(`FAIL crafted: ${JSON.stringify(report.crafted.refusals.slice(0, 5))}`); }
    console.log(`crafted: ${report.crafted.transactions} transactions, ${report.crafted.entries} entries, each a full-size leaf executed`);
  }
  report.result = failed === 0 ? "pass" : `${failed} failures`;
  if (option("--report")) writeFileSync(option("--report"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(failed === 0 ? "exhaustion-corpus: pass" : `exhaustion-corpus: ${failed} failures`);
  if (failed) process.exitCode = 1;
} else {
  throw new Error("usage: exhaustion-corpus.mjs fetch [day ...] | fetch <first> <last> <out.json> | check [--execute <workers>] [--report <file>] [day ...]");
}
