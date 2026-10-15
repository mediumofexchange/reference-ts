// The exhaustion circuits proved end to end at full size (succinct-read §4.3): their keys derived on bb.js's bundled
// native `bb`, two consecutive periods of a synthetic chain proved leaf by leaf, joined by nodes, folded by a first and
// a next fold, and the last fold taken by the reader's §4.3 rules (`checkFold`) under the derived fold keys on the
// pinned WebAssembly verifier; hostile recursion (a node whose children do not join, a tree under another node key-hash
// input, next folds that do not continue their previous fold) is not proved or does not verify, and the reader refuses
// hostile fold inputs. Each proof's time is recorded with the host's CPU.
//
//   NARGO=<nargo 1.0.0-beta.26> node scripts/venue/exhaustion-prove.mjs [--sizes CT,CM,E] [--report <file>]
//
// Run after `npm run build` and `node scripts/pool/prepare-crs.mjs`, with the leading 2^22 G1 points in
// scratch/exhaustion-crs (CRS_PATH); about 16 GB of memory at full size. The keys are a test set's: no set is adopted.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Noir } from "@noir-lang/noir_js";
import { BB, build, CRS, EXHAUSTION_SPECIFICATION, root, sourceHashes } from "./exhaustion-build.mjs";
import { syntheticPeriod } from "./exhaustion-periods.mjs";
import { Chain, plainOutput, transaction } from "../../dist/ergo-synthetic.js";
import { checkFold, EMPTY_SUBTREES, SubjectMap } from "../../dist/ergo-exhaustion.js";
import { foldStateInputs, periodLeaves, stateEnd } from "../../dist/ergo-exhaustion-prover.js";
import { limbsOf } from "../../dist/pool/field.js";
import { keyedVerifier, startBackend } from "../../dist/pool/proof-verifier.js";
import { readParameters } from "../pool/prepare-crs.mjs";

const argv = process.argv.slice(2);
const option = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const [CT, CM, E] = (option("--sizes") ?? "167,380,746").split(",").map(Number);
const SIZES = { t: CT, m: CM, u: E };
const cpu = os.cpus()[0]?.model ?? "unknown";
const started = Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { specification: EXHAUSTION_SPECIFICATION, sources: sourceHashes(), sizes: SIZES, cpu, cores: os.cpus().length, memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1), circuits: {}, proofs: [], checks: [] };
let failed = 0;
const fail = message => { failed++; console.error(`FAIL ${message}`); };
const check = (name, ok, detail) => { report.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) }); if (!ok) fail(name); else log(`ok ${name}`); };

const emptyRoot = "0x" + EMPTY_SUBTREES[32].toString(16).padStart(64, "0");
const built = await build({ CT, CM, E }, { keys: true, withGates: true, emptyRoot, log: line => log(line.slice(0, 160)) });
for (const [name, c] of Object.entries(built.circuits)) report.circuits[name] = { gates: c.gates, bytecodeSha256: c.bytecodeSha256, vkSha256: c.sha256, keyHash: c.hash, compileSeconds: c.compileSeconds };
const dir = built.directory, out = path.join(dir, "proofs");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const program = name => JSON.parse(readFileSync(path.join(dir, name, "program.json"), "utf8"));
const circuits = Object.fromEntries(Object.keys(built.circuits).map(name => [name, { program: program(name), key: built.circuits[name] }]));
const fieldsOf = bytes => Array.from({ length: bytes.length / 32 }, (_, i) => "0x" + bytes.subarray(32 * i, 32 * i + 32).toString("hex"));

let serial = 0;
/** Execute `name` on `inputs` (noir_js), prove natively under its key and read the proof and its public inputs. */
async function prove(name, inputs, label = name) {
  const { program: p, key } = circuits[name];
  const d = path.join(out, `${String(serial++).padStart(3, "0")}-${label}`);
  mkdirSync(d, { recursive: true });
  const t0 = Date.now();
  const { witness } = await new Noir(p).execute(inputs);
  const executed = (Date.now() - t0) / 1000;
  writeFileSync(path.join(d, "witness.gz"), witness);
  const t1 = Date.now();
  execFileSync(BB, ["prove", "-b", path.join(dir, name, "program.json"), "-w", path.join(d, "witness.gz"), "-k", path.join(dir, name, "vk/vk"), "-o", d, "-t", "noir-recursive"],
    { env: { ...process.env, CRS_PATH: CRS }, stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 26 });
  const proved = (Date.now() - t1) / 1000;
  const proof = readFileSync(path.join(d, "proof")), publicInputs = fieldsOf(readFileSync(path.join(d, "public_inputs")));
  report.proofs.push({ circuit: name, label, executeSeconds: executed, proveSeconds: proved, proofBytes: proof.length });
  log(`${label}: executed in ${executed.toFixed(1)} s, proved in ${proved.toFixed(1)} s`);
  if (proof.length !== 458 * 32) throw new Error(`${label}: a proof of ${proof.length} bytes`);
  return { name, dir: d, proof, proofFields: fieldsOf(proof), publicInputs, key: key.fields, keyHash: key.hash };
}
const nativeVerify = (name, p) => {
  try {
    execFileSync(BB, ["verify", "-p", path.join(p.dir, "proof"), "-k", path.join(dir, name, "vk/vk"), "-i", path.join(p.dir, "public_inputs"), "-t", "noir-recursive"],
      { env: { ...process.env, CRS_PATH: CRS }, stdio: "ignore" });
    return true;
  } catch { return false; }
};

const nodeKeyHash = BigInt(circuits.node.key.hash);
const chain = syntheticPeriod(6);
const periods = [chain.blocks.slice(0, 3), chain.blocks.slice(3)];
const map = new SubjectMap(chain.start.id, chain.start.height);
const dec = x => x.toString();
const nodeInputs = (a, b, key = nodeKeyHash) => ({ sin: a.publicInputs[0], sout: b.publicInputs[1], node_key_hash: dec(key), keys: [a.key, b.key],
  proofs: [a.proofFields, b.proofFields], key_hashes: [a.keyHash, b.keyHash], middle: a.publicInputs[1] });
/** A period's leaves proved, then joined pairwise by nodes carrying `key` as their key-hash input: the leaf proofs and the root. */
async function tree(leaves, key = nodeKeyHash, label = "") {
  let level = [];
  for (const l of leaves) level.push(await prove(`leaf-${l.kind}`, l.inputs, `${label}leaf-${l.kind}`));
  const proved = [...level];
  while (level.length > 1) {
    const up = [];
    for (let i = 0; i + 1 < level.length; i += 2) up.push(await prove("node", nodeInputs(level[i], level[i + 1], key), `${label}node`));
    if (level.length % 2) up.push(level.at(-1));
    level = up;
  }
  return { leaves: proved, root: level[0] };
}
const done = [];
let previous, last;
for (const [k, blocks] of periods.entries()) {
  const startOf = map.end;
  const run = periodLeaves(map, blocks, SIZES, nodeKeyHash);
  log(`period ${k}: ${blocks.length} blocks, leaves ${run.leaves.map(l => l.kind).join("")}`);
  const { leaves: leafProofs, root: rootProof } = await tree(run.leaves);
  const [sh, sl] = limbsOf(chain.start.id), endOf = stateEnd(run.end), [eh, el] = limbsOf(endOf.id);
  const inputs = { start_hi: dec(sh), start_lo: dec(sl), start_height: dec(chain.start.height), end_hi: dec(eh), end_lo: dec(el), end_height: dec(endOf.height),
    map_root: dec(map.root), fold_key_hash: circuits["fold-next"].key.hash, key: rootProof.key, proof: rootProof.proofFields, key_hash: rootProof.keyHash,
    ...foldStateInputs(run.start, "0"), ...foldStateInputs(run.end, "1") };
  const fold = k === 0 ? await prove("fold-first", inputs)
    : await prove("fold-next", { ...inputs, previous_key: previous.key, previous_proof: previous.proofFields, previous_key_hash: previous.keyHash });
  check(`period ${k}: the fold verifies natively`, nativeVerify(fold.name, fold));
  check(`period ${k}: the fold's public inputs are §4.3's, ending at the period's last header with the map's root`,
    JSON.stringify(fold.publicInputs.slice(0, 8).map(BigInt).map(String)) === JSON.stringify([sh, sl, chain.start.height, eh, el, endOf.height, map.root, BigInt(circuits["fold-next"].key.hash)].map(String)));
  check(`period ${k}: it starts where the previous ended`, startOf.height === (k === 0 ? chain.start.height : periods[k - 1].at(-1).height));
  done.push({ run, blocks, leafProofs, inputs, fold, mapRoot: map.root });
  previous = fold;
  last = { fold, end: endOf };
}

// Hostile recursion: each is refused where proving fails or the proof does not verify natively.
async function refusedProof(name, circuit, inputs) {
  let outcome;
  try { outcome = nativeVerify(circuit, await prove(circuit, inputs, `hostile-${circuit}`)) ? "verifies" : "does not verify"; }
  catch (error) { outcome = `not proved (${String(error.message ?? error).split("\n")[0].slice(0, 120)})`; }
  check(`hostile: ${name}`, outcome !== "verifies", outcome);
}
{
  const [p0, p1] = done;
  if (p1.leafProofs.length < 3) throw new Error("the second period has fewer than three leaves");
  await refusedProof("a node over children that do not join", "node", nodeInputs(p1.leafProofs[0], p1.leafProofs[2]));
  // §2 rule 1: a period whose node carries another key-hash input than the node's own key's (here 7) is not the fold's.
  // A one-block period of two leaves under one node, folded with the genuine input and with 7.
  const mini = new Chain(), block = mini.mine(mini.anchor, [transaction([plainOutput])]);
  for (const key of [nodeKeyHash, 7n]) {
    const m = new SubjectMap(mini.anchor.id, mini.anchor.height);
    const run = periodLeaves(m, [{ header: block.bytes, transactions: block.section }], SIZES, key);
    if (run.leaves.length !== 2) throw new Error("the one-block period is not two leaves");
    const { root } = await tree(run.leaves, key, key === nodeKeyHash ? "one-block-" : "other-key-");
    const [sh, sl] = limbsOf(mini.anchor.id), [eh, el] = limbsOf(block.id);
    const inputs = { start_hi: dec(sh), start_lo: dec(sl), start_height: dec(mini.anchor.height), end_hi: dec(eh), end_lo: dec(el), end_height: dec(block.height),
      map_root: dec(m.root), fold_key_hash: circuits["fold-next"].key.hash, key: root.key, proof: root.proofFields, key_hash: root.keyHash,
      ...foldStateInputs(run.start, "0"), ...foldStateInputs(run.end, "1") };
    if (key === nodeKeyHash) check("a one-block period's first fold over one node verifies", nativeVerify("fold-first", await prove("fold-first", inputs, "one-block-fold-first")));
    else await refusedProof("a first fold over a node carrying another node key hash", "fold-first", inputs);
  }
  const nextInputs = { ...p1.inputs, previous_key: p0.fold.key, previous_proof: p0.fold.proofFields, previous_key_hash: p0.fold.keyHash };
  await refusedProof("a next fold naming another foldKeyHash than its previous fold's", "fold-next", { ...nextInputs, fold_key_hash: "7" });
  await refusedProof("a next fold naming another start than its previous fold's", "fold-next", { ...nextInputs, start_height: dec(chain.start.height + 1n) });
  await refusedProof("a next fold whose previous fold is its own period's", "fold-next", { ...nextInputs, previous_key: p1.fold.key, previous_proof: p1.fold.proofFields, previous_key_hash: p1.fold.keyHash });
}

// The reader's §4.3 rules over the last fold, under the derived fold keys on the pinned WebAssembly verifier.
const api = await startBackend(await readParameters(path.join(root, "scratch/private-payment-crs")), { threads: 4 });
try {
  const raw = name => readFileSync(path.join(dir, name, "vk/vk"));
  const verifier = keyedVerifier(api, [{ kind: 1, vk: raw("fold-first"), publicInputs: 8 }, { kind: 2, vk: raw("fold-next"), publicInputs: 8 }], 458 * 32);
  const set = { identity: new Uint8Array(32), test: true, start: chain.start, foldKeyHash: BigInt(circuits["fold-next"].key.hash),
    verifyFold: (first, inputs, proof) => verifier.verify(first ? 1 : 2, inputs, proof) };
  const at = new Map(chain.blocks.map(b => [b.height, b]));
  const readerChain = { at: h => { const b = at.get(h); return b && { id: b.id, transactionsRoot: b.header.subarray(65, 97) }; }, tipHeight: chain.blocks.at(-1).height };
  const fold = (first, change = {}) => ({ first, proof: last.fold.proof, inputs: { startId: chain.start.id, startHeight: chain.start.height, endId: last.end.id,
    endHeight: last.end.height, mapRoot: map.root, foldKeyHash: set.foldKeyHash, ...change } });
  const accepted = await checkFold(set, fold(false), readerChain, 0n);
  check("the reader takes the last fold (checkFold)", "inputs" in accepted && accepted.inputs.mapRoot === map.root);
  const refused = async (name, f, depth, expected) => {
    const r = await checkFold(set, f, readerChain, depth);
    check(`the reader refuses ${name}`, r.refused === expected, r.refused ?? "accepted");
  };
  await refused("a fold with another map root", fold(false, { mapRoot: map.root + 1n }), 0n, "fold-proof");
  await refused("the next fold's proof under the first fold's key", fold(true), 0n, "fold-proof");
  await refused("a fold ending at another header", fold(false, { endId: chain.blocks[2].id }), 0n, "fold-end");
  await refused("a fold above the depth", fold(false), 1n, "fold-depth");
  await refused("a fold from another start", fold(false, { startHeight: chain.start.height + 1n }), 0n, "fold-start");
  await verifier.close();
} finally {
  await api.destroy();
}

report.result = failed === 0 ? "pass" : `${failed} failures`;
report.minutes = +((Date.now() - started) / 60000).toFixed(1);
if (option("--report")) writeFileSync(option("--report"), `${JSON.stringify(report, null, 2)}\n`);
log(failed === 0 ? "exhaustion-prove: pass" : `exhaustion-prove: ${failed} failures`);
if (failed) process.exitCode = 1;
