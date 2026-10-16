// Slice 36 acceptance (succinct-read §§2, 3.2, 3.5): the trail check set proved and verified on the pinned backend.
// The six circuits are generated and compiled again and their keys derived (check-set.mjs, which fails where a source
// or a shipped file differs), and the identities it prints must be the ones check-set.ts pins. Over one genuine proof
// of each proved kind (test/fixtures/pool-v3-genuine-proofs.json, each verified natively first), the aggregator proves
// the five leaves and a two-level tree; each cover carries the host's digest and verifies under the pinned key the
// rule names. Hostile covers cover nothing: another kind's leaf key or the node key, a node cover as a leaf, a wrong
// digest, other lengths and a flipped byte, a tree whose node-key input is not the pinned key's hash (the forged-tree
// rule, §2 rules 1-2), a statement proof that fails natively (no leaf), a leaf forced over it, and nodes over a child
// verifying under a key other than its admitted hash's or over a child cover with a flipped byte. A proof the backend
// refuses to make retires the aggregator's instance, and its next proof is made on a fresh one. Times and the peak
// memory are recorded per proof.
//
// With --native (slice 42) the same cases run on the native binary bb.js bundles: each of the six keys and pool-v3's are
// derived on it and must be the pinned ones (in place of check-set.mjs, the WebAssembly run's), every proof is made on
// it and verified on WebAssembly, and one leaf and one node are proved on WebAssembly too, on the same host, for the
// rate. Peak memory then counts the native processes. On a host where bb.js bundles no native backend it records that a
// native start is refused by name, and proves nothing.
//
// Usage: node scripts/pool/v3/check-set-check.mjs [--native] (after npm run build); writes
// docs/pool-v3-check-set-verification.json, or docs/pool-v3-check-set-native-verification.json with --native.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Noir } from "@noir-lang/noir_js";
import { UltraHonkBackend } from "@aztec/bb.js";
import { prepareCheckSetParameters, readCheckSetParameters } from "../../../dist/pool/parameter-files.js";
import { keyedVerifier, mixedPairingObject, nativeRefusal, PROOF_OPTIONS, startCheckSetBackend } from "../../../dist/pool/proof-verifier.js";
import { fieldToHex } from "../../../dist/pool/field.js";
import { adoptedDomain } from "../../../dist/pool/v3/configuration.js";
import { openTrailProver } from "../../../dist/pool/v3/aggregator.js";
import { CHECK_SET_MANIFEST, checkSetIdentity, trailKeys, trailPrograms } from "../../../dist/pool/v3/check-set.js";
import { nodeDigest, statementLeafDigest, SUCCINCT_SPECIFICATION } from "../../../dist/pool/v3/succinct.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { openV3Verifier } from "../../../dist/pool/v3/verifier.js";
import { PARAMETER_DIRECTORY } from "../prepare-crs.mjs";
import { V3_SPECIFICATION, sourceClosure, sourceHashes } from "./provenance.mjs";

const native = process.argv.includes("--native");
if (process.argv.slice(2).some(arg => arg !== "--native")) throw new Error("usage: check-set-check.mjs [--native]");
const here = import.meta.dirname, root = resolve(here, "../../.."),
  report = join(root, `docs/pool-v3-check-set${native ? "-native" : ""}-verification.json`);
const sources = sourceClosure(["scripts/pool/v3/check-set-check.mjs", "scripts/pool/v3/check-set.mjs", "scripts/pool/v3/trail-circuits/trail.nr",
  ...["issue", "spend", "burn", "demand", "settle"].map(name => `scripts/pool/v3/trail-circuits/leaf-${name}.nr`), "scripts/pool/v3/trail-circuits/node.nr",
  "src/pool/circuits/vendor/poseidon2.nr", "src/pool/v3/check-set.json", "src/pool/v3/check-set-programs.json", "test/fixtures/pool-v3-genuine-proofs.json",
  "package-lock.json"]);
const digests = sourceHashes(sources);
const checks = [], proofs = [];
const check = label => { checks.push(label); console.log(`passed: ${label}`); };

// The peak resident memory, sampled: the backend's WebAssembly workers live in this process; native instances are
// child processes (`bb`), whose resident memory is added (ps reports KiB on Linux and macOS).
const children = () => {
  if (!native) return [];
  const listed = spawnSync("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="], { encoding: "utf8" }).stdout ?? "";
  return listed.split("\n").map(line => line.trim().split(/\s+/)).filter(([, ppid, , comm]) => Number(ppid) === process.pid && /(^|\/)bb$/.test(comm ?? ""))
    .map(([pid, , rss]) => ({ pid: Number(pid), rss: Number(rss) * 1024 }));
};
/** Whether every process in `pids` has ended, waiting up to 30 s. */
const ended = async pids => {
  for (let i = 0; i < 150 && children().some(child => pids.includes(child.pid)); i++) await new Promise(done => setTimeout(done, 200));
  return !children().some(child => pids.includes(child.pid));
};
let peak = 0;
const sample = () => { peak = Math.max(peak, process.memoryUsage().rss + children().reduce((sum, child) => sum + child.rss, 0)); };
const sampler = setInterval(sample, 200);
const timed = async (label, run) => {
  peak = 0; sample();
  const started = performance.now(), value = await run();
  sample();
  const entry = { label, seconds: Number(((performance.now() - started) / 1000).toFixed(1)), peakMiB: Math.round(peak / 2 ** 20) };
  proofs.push(entry); console.log(`proved: ${label} in ${entry.seconds} s, peak ${entry.peakMiB} MiB`);
  return value;
};

const threads = availableParallelism();
const host = { cpu: cpus()[0]?.model, threads, memoryGiB: Math.round(totalmem() / 2 ** 30), platform: process.platform, arch: process.arch, node: process.version };
const write = result => { writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`); console.log(`check-set: ${checks.length} checks passed; wrote ${report}`); };
const refusal = native ? nativeRefusal() : undefined;
if (refusal !== undefined) {
  // No native backend here: a native start is refused by name before any parameter is read, and nothing is proved.
  await assert.rejects(startCheckSetBackend(null, { native: true }), { name: "ParameterError", code: "BACKEND", message: refusal });
  check(`this host has no native backend: a native start is refused BACKEND (${refusal})`);
  write({ specification: { pool: V3_SPECIFICATION, succinct: SUCCINCT_SPECIFICATION }, sources: digests, backend: "none", host, checks,
    evidence: "no native backend on this host; nothing proved" });
  clearInterval(sampler);
  process.exit(0);
}

await prepareCheckSetParameters(PARAMETER_DIRECTORY, { log: console.log });
// bb fetches points into the directory CRS_PATH names (by default ~/.bb-crs) where it holds too few; a native instance is
// given a private copy of the checked ones instead. An empty sentinel here, and the private copies while instances live,
// show nothing was fetched.
const sentinel = native ? mkdtempSync(join(tmpdir(), "moe-crs-sentinel-")) : undefined;
if (native) process.env.CRS_PATH = sentinel;
// Only this run's: a directory another process or an earlier run left is not this run's evidence.
const earlier = new Set(readdirSync(tmpdir()));
const privateCopies = () => readdirSync(tmpdir()).filter(name => name.startsWith("moe-bb-points-") && !earlier.has(name))
  .map(name => ({ name, files: readdirSync(join(tmpdir(), name)).filter(file => !file.endsWith(".sock")).sort(),
    bytes: statSync(join(tmpdir(), name, "bn254_g1.dat"), { throwIfNoEntry: false })?.size }));
const parameters = await readCheckSetParameters(PARAMETER_DIRECTORY), api = await startCheckSetBackend(parameters, { threads, native });
const keyProcesses = children().map(child => child.pid);
let live = api;
let gates;
if (native) {
  // Each key derived on the native binary is the one check-set.ts pins (the WebAssembly run regenerates the sources).
  const programs = trailPrograms();
  gates = {};
  for (const name of Object.keys(CHECK_SET_MANIFEST.circuits)) {
    const started = performance.now();
    const vk = await new UltraHonkBackend(programs[name].bytecode, api).getVerificationKey(PROOF_OPTIONS);
    assert.equal(Buffer.from(sha256(vk)).toString("hex"), CHECK_SET_MANIFEST.circuits[name].vk, name);
    gates[name] = { keyS: Number(((performance.now() - started) / 1000).toFixed(1)) };
  }
  check("each of the six keys derived on the native binary is the one check-set.ts pins");
} else {
  // The sources and shipped files are what the keys compile to, and their identities the ones check-set.ts pins.
  const generated = execFileSync(process.execPath, [join(here, "check-set.mjs"), "--stats"], { cwd: root, encoding: "utf8",
    env: { ...process.env, CHECK_SET_PARAMETERS: PARAMETER_DIRECTORY }, maxBuffer: 1 << 26 });
  const derived = JSON.parse(generated.slice(generated.indexOf("identities ") + "identities ".length, generated.lastIndexOf("}") + 1));
  assert.deepEqual(derived, CHECK_SET_MANIFEST.circuits);
  gates = Object.fromEntries([...generated.matchAll(/^(\S+): compiled in ([\d.]+) s, key in ([\d.]+) s, (\d+) gates$/gm)]
    .map(([, name, compileS, keyS, count]) => [name, { gates: Number(count), compileS: Number(compileS), keyS: Number(keyS) }]));
  assert.equal(Object.keys(gates).length, 6);
  check("the six sources and the shipped keys and programs are what check-set.mjs generates; every identity is the one check-set.ts pins");
}

let statements, prover;
try {
  // pool-v3's verifier derives its keys on `api` and refuses any that is not the configuration's: natively too.
  statements = await openV3Verifier(api);
  if (native) check("pool-v3's keys derived on the native binary are the adopted configuration's");
  // The keys are derived. Proofs are made on the aggregator's own instance and on fresh ones, so this one ends here and
  // the peaks below are a prover's; verifiers built over it keep only its `[1]_1` and `[x]_2`.
  live = undefined;
  await api.destroy();
  assert(await ended(keyProcesses), "the key-deriving native process did not end");
  prover = await openTrailProver(() => readCheckSetParameters(PARAMETER_DIRECTORY), statements, { native, threads });
  assert.equal(prover.backend, native ? "native" : "wasm");
  const { set } = prover, keys = trailKeys();
  assert.equal(set.test, true);
  assert.deepEqual(set.identity, checkSetIdentity());
  const fixture = JSON.parse(readFileSync(join(root, "test/fixtures/pool-v3-genuine-proofs.json"), "utf8")).proofs;
  const records = Object.fromEntries(Object.entries(fixture).map(([name, g]) => [name, { domain: adoptedDomain(), kind: g.kind,
    publicInputs: g.publicInputs.map(BigInt), proof: new Uint8Array(Buffer.from(g.proof, "base64")), authorization: new Uint8Array(), capsules: [] }]));
  for (const record of Object.values(records)) assert.equal(await statements.verify(record.kind, record.publicInputs, record.proof), true);
  check("one genuine proof of each proved kind verifies natively under the adopted configuration's keys");

  // The five leaves and a two-level tree over four of them.
  const leaves = {};
  for (const [name, record] of Object.entries(records)) {
    const cover = await timed(`leaf-${name}`, () => prover.leaf(record));
    assert.equal(cover.digest, statementLeafDigest(record.kind, record.publicInputs, sha256(record.proof)));
    assert.equal(cover.proof.length, 14656);
    assert.equal(await set.verify(record.kind, cover.digest, cover.proof), true);
    leaves[name] = cover;
  }
  check("each of the five leaves proves over a genuine proof, outputs the host's leaf digest and verifies under its kind's pinned leaf key");
  if (native) {
    const copies = privateCopies();
    assert(copies.length >= 1, "no private copy of the points while a native instance lives");
    for (const copy of copies) {
      assert.deepEqual(copy.files, ["bn254_g1.dat", "crs.lock"], copy.name);
      assert.equal(copy.bytes, parameters.g1.length, copy.name);
    }
  }
  // A child cover whose last byte is flipped: the backend refuses to make the node (bb's assertion on the inner proof),
  // the aggregator retires the instance that refused, and the next node is made on a fresh one.
  const lastFlipped = Uint8Array.from(leaves.spend.proof); lastFlipped[lastFlipped.length - 1] ^= 1;
  const proving = children().map(child => child.pid);
  if (native) assert.equal(proving.length, 1, "one native process proves");
  const thrown = await timed("the aggregator's node over a child cover with its last byte flipped", async () => {
    try { await prover.node({ ...leaves.spend, proof: lastFlipped }, leaves.spend); } catch (error) { return String(error?.message ?? error).split("\n")[0]; }
    return undefined;
  });
  assert.notEqual(thrown, undefined, "the backend made a node over a child it cannot verify");
  assert.doesNotMatch(thrown, /memory|RangeError|out of|closed/i, thrown);
  if (native) assert(await ended(proving), "the refusing native process did not end");
  const left = await timed("node over two leaves", () => prover.node(leaves.issue, leaves.spend));
  if (native) assert.equal(children().filter(child => !proving.includes(child.pid)).length, 1, "a fresh native process proves");
  const right =await timed("node over two leaves (2)", () => prover.node(leaves.burn, leaves.demand));
  const top = await timed("node over two nodes", () => prover.node(left, right));
  assert.equal(top.digest, nodeDigest(nodeDigest(leaves.issue.digest, leaves.spend.digest), nodeDigest(leaves.burn.digest, leaves.demand.digest)));
  for (const cover of [left, right, top]) assert.equal(await set.verify(undefined, cover.digest, cover.proof), true);
  check("the node proves over two leaves and over two nodes, outputs the host's node digests and verifies under the pinned node key");
  check(`a node the backend refuses to make (${thrown}) retires the aggregator's instance${native ? " (its process ended)" : ""}, and its next proofs are made on a fresh one`);

  // A cover verifies only under the key its rule names, for the digest the reader computed, at its exact length.
  const refused = async (kind, digest, proof, label) => { assert.equal(await set.verify(kind, digest, proof), false, label); };
  await refused(3, leaves.spend.digest, leaves.spend.proof, "a spend leaf as a burn leaf");
  await refused(1, leaves.settle.digest, leaves.settle.proof, "a settle leaf as an issue leaf");
  await refused(undefined, leaves.spend.digest, leaves.spend.proof, "a leaf as a node");
  await refused(2, left.digest, left.proof, "a node as a leaf");
  await refused(2, leaves.spend.digest + 1n, leaves.spend.proof, "a wrong digest");
  await refused(undefined, top.digest - 1n, top.proof, "a wrong node digest");
  await refused(5, leaves.spend.digest, leaves.spend.proof, "kind 5 has no leaf");
  await refused(7, leaves.spend.digest, leaves.spend.proof, "kind 7 has no leaf");
  await refused(2, leaves.spend.digest, leaves.spend.proof.subarray(0, 14624), "a word short");
  await refused(2, leaves.spend.digest, Uint8Array.from([...leaves.spend.proof, ...new Uint8Array(32)]), "a word long");
  const flipped = Uint8Array.from(top.proof); flipped[5000] ^= 1;
  await refused(undefined, top.digest, flipped, "a flipped byte");
  check("a cover covers nothing under another kind's leaf key or the node key, for another digest, at another length or with a flipped byte, and kinds 5 and 7 have no leaf");

  // §2 rule 2: a cover publishes the pairing points it defers with neither at infinity (a statement proof, which
  // verifies no proof, publishes both), and a cover whose object has exactly one at infinity is refused before the
  // backend, whose verification would adopt the cover's own opening in its place.
  const atInfinity = (proof, from) => proof.subarray(from, from + 128).every(byte => byte === 0);
  for (const cover of [...Object.values(leaves), left, right, top]) {
    assert(!atInfinity(cover.proof, 0) && !atInfinity(cover.proof, 128), "a genuine cover's pairing points are finite");
  }
  for (const record of Object.values(records)) assert(atInfinity(record.proof, 0) && atInfinity(record.proof, 128), "a statement proof publishes both at infinity");
  for (const from of [0, 128]) {
    const mixed = Uint8Array.from(top.proof); mixed.fill(0, from, from + 128);
    assert(mixedPairingObject(mixed));
    await refused(undefined, top.digest, mixed, `a cover with pairing point ${from / 128} at infinity`);
  }
  check("every genuine cover's pairing-point object has neither point at infinity and every statement proof's both, and a cover with exactly one at infinity covers nothing");

  // §2 rules 1-2: the node-key input is free in every circuit; a tree proved under another value verifies under the
  // pinned node key with that value as its input, and only the reader's comparison refuses it.
  const forged = keys.node.keyHash + 1n, programs = trailPrograms();
  const proveRaw = async (name, inputs, on) => {
    const { witness } = await new Noir(programs[name]).execute(inputs);
    return new UltraHonkBackend(programs[name].bytecode, on).generateProof(witness, PROOF_OPTIONS);
  };
  const fields = bytes => Array.from({ length: bytes.length / 32 }, (_, i) => `0x${Buffer.from(bytes.subarray(32 * i, 32 * i + 32)).toString("hex")}`);
  const forging = await startCheckSetBackend(parameters, { threads, native });
  let forgedLeaf, forgedRoot;
  try {
    forgedLeaf = await timed("leaf-spend under a forged node-key input", () => proveRaw("leaf-spend",
      { proof: fields(records.spend.proof), inputs: records.spend.publicInputs.map(fieldToHex), node_key_hash: fieldToHex(forged) }, forging));
    forgedRoot = await timed("node under a forged node-key input", () => proveRaw("node", {
      keys: [fields(keys["leaf-spend"].vk), fields(keys["leaf-spend"].vk)], proofs: [forgedLeaf.proof, forgedLeaf.proof].map(fields),
      key_hashes: [fieldToHex(keys["leaf-spend"].keyHash), fieldToHex(keys["leaf-spend"].keyHash)],
      digests: [leaves.spend.digest, leaves.spend.digest].map(fieldToHex), node_key_hash: fieldToHex(forged) }, forging));
  } finally { await forging.destroy(); }
  const forgedDigest = nodeDigest(leaves.spend.digest, leaves.spend.digest);
  assert.deepEqual(forgedRoot.publicInputs.map(BigInt), [forged, forgedDigest]);
  const bare = keyedVerifier(api, [{ kind: 0, vk: keys.node.vk, publicInputs: 2 }, { kind: 2, vk: keys["leaf-spend"].vk, publicInputs: 2 }], 14656);
  try {
    assert.equal(await bare.verify(0, [forged, forgedDigest], forgedRoot.proof), true, "the forged tree verifies under the pinned node key with its own input");
    assert.equal(await bare.verify(2, [forged, leaves.spend.digest], forgedLeaf.proof), true);
  } finally { await bare.close(); }
  await refused(undefined, forgedDigest, forgedRoot.proof, "a tree whose node-key input is not the pinned key's hash");
  await refused(2, leaves.spend.digest, forgedLeaf.proof, "a leaf whose node-key input is not the pinned key's hash");
  check("a tree and a leaf proved under another node-key input verify under the pinned keys with that input, and the check set refuses both (§2 rules 1-2)");

  // §3.5: a statement proof that fails natively gets no leaf, and a leaf forced over it fails verification.
  const tampered = Uint8Array.from(records.burn.proof); tampered[14656 - 1] ^= 1;
  assert.equal(await statements.verify(3, records.burn.publicInputs, tampered), false);
  assert.equal(await prover.leaf({ ...records.burn, proof: tampered }), undefined);
  // A proof the backend refuses to make, or one it makes that the check set refuses: the outcome, by its first line.
  // Each attempt proves on an instance of its own: a refusal inside the backend can leave its WebAssembly instance
  // unusable (a later call traps), and the next attempt would then fail for that, not for its witness.
  const attempt = async (name, inputs) => {
    const fresh = await startCheckSetBackend(parameters, { threads, native });
    try { return { proof: await proveRaw(name, inputs, fresh) }; } catch (error) { return { error: String(error?.message ?? error).split("\n")[0] }; }
    finally { await fresh.destroy().catch(() => {}); }
  };
  const outcome = (made, refusedText) => made.proof !== undefined ? refusedText : `is not proved (${made.error})`;
  const forced = await timed("leaf-burn forced over a failing proof", () => attempt("leaf-burn",
    { proof: fields(tampered), inputs: records.burn.publicInputs.map(fieldToHex), node_key_hash: fieldToHex(keys.node.keyHash) }));
  const forcedDigest = statementLeafDigest(3, records.burn.publicInputs, sha256(tampered));
  if (forced.proof !== undefined) {
    assert.deepEqual(forced.proof.publicInputs.map(BigInt), [keys.node.keyHash, forcedDigest]);
    await refused(3, forcedDigest, forced.proof.proof, "a leaf forced over a failing statement proof");
  }
  check(`a statement proof that fails natively gets no leaf, and a leaf forced over it ${outcome(forced, "is proved but fails verification")}`);

  // The node admits a child by its key hash; the backend binds the key it verifies under to that hash (its recursive
  // verifier asserts the key's hash equal to the given one). A child under another key presented with an admitted hash,
  // and a child cover with a flipped byte, give no node cover.
  const nodeOver = (children, label) => timed(label, () => attempt("node", {
    keys: children.map(c => fields(c.vk)), proofs: children.map(c => fields(c.proof)), key_hashes: children.map(c => fieldToHex(c.keyHash)),
    digests: children.map(c => fieldToHex(c.digest)), node_key_hash: fieldToHex(keys.node.keyHash) }));
  const spendChild = { vk: keys["leaf-spend"].vk, keyHash: keys["leaf-spend"].keyHash, proof: leaves.spend.proof, digest: leaves.spend.digest };
  // A burn cover that verifies under the burn key it is given, presented with the spend leaf's (admitted) hash: were the
  // given hash not bound to the key, this node would be proved and verify.
  const burnUnderSpendHash = { vk: keys["leaf-burn"].vk, keyHash: keys["leaf-spend"].keyHash, proof: leaves.burn.proof, digest: leaves.burn.digest };
  const misKeyed = await nodeOver([burnUnderSpendHash, spendChild], "node over a child whose key is not its admitted hash's");
  // A flip in the last byte keeps every element well formed, so the in-circuit verification itself refuses; one inside
  // a commitment limb may be refused while the proof is read.
  const flips = [14656 - 1, 5000].map(at => { const proof = Uint8Array.from(leaves.spend.proof); proof[at] ^= 1; return proof; });
  const misProved = [];
  for (const [i, proof] of flips.entries()) misProved.push(await nodeOver([{ ...spendChild, proof }, spendChild], `node over a child cover with byte ${[14655, 5000][i]} flipped`));
  const made = [[misKeyed, nodeDigest(leaves.burn.digest, leaves.spend.digest)], ...misProved.map(m => [m, nodeDigest(leaves.spend.digest, leaves.spend.digest)])];
  for (const [attempted, digest] of made) {
    // A refusal to prove must be the backend's verdict on the witness, not a resource failure.
    if (attempted.error !== undefined) assert.doesNotMatch(attempted.error, /memory|RangeError|out of|abort/i, attempted.error);
    else await refused(undefined, digest, attempted.proof.proof, "a node over a hostile child");
  }
  check(`a node over a child whose key is not its admitted hash's ${outcome(misKeyed, "is proved but fails verification")}, and over a child cover with its last byte flipped ${outcome(misProved[0], "is proved but fails verification")} or a limb byte flipped ${outcome(misProved[1], "is proved but fails verification")}`);

  if (native) {
    assert.equal(process.env.CRS_PATH, sentinel);
    assert.deepEqual(readdirSync(sentinel), []);
    rmSync(sentinel, { recursive: true });
    check("the native instances proved from private copies of the checked points alone (each held only them and bb's lock), and nothing was fetched");
  }

  // The rate against WebAssembly on this host: one leaf and one node proved there by an aggregator of its own, once the
  // native one has ended, so its peaks are WebAssembly's alone.
  let compared;
  if (native) {
    const ending = prover; prover = undefined;
    await ending.close();
    assert(await ended(children().map(child => child.pid)), "the native prover's process did not end");
    const wasm =await openTrailProver(() => readCheckSetParameters(PARAMETER_DIRECTORY), statements, { threads });
    try {
      const leaf = await timed("leaf-spend on WebAssembly", () => wasm.leaf(records.spend));
      const node = await timed("node over two leaves on WebAssembly", () => wasm.node(leaves.issue, leaves.spend));
      assert.equal(leaf.digest, leaves.spend.digest); assert.equal(node.digest, left.digest);
      const seconds = label => proofs.find(entry => entry.label === label).seconds;
      compared = { leaf: { native: seconds("leaf-spend"), wasm: seconds("leaf-spend on WebAssembly") },
        node: { native: seconds("node over two leaves"), wasm: seconds("node over two leaves on WebAssembly") } };
    } finally { await wasm.close(); }
    assert.deepEqual(privateCopies().map(copy => copy.name), [], "a destroyed native instance left its directory");
    check(`on this host a leaf takes ${compared.leaf.native} s natively against ${compared.leaf.wasm} s on WebAssembly, a node ${compared.node.native} s against ${compared.node.wasm} s`);
  }

  const result = {
    specification: { pool: V3_SPECIFICATION, succinct: SUCCINCT_SPECIFICATION }, sources: digests, backend: native ? "native" : "wasm",
    evidence: native ? "real check proofs on the native binary the pinned bb.js bundles, verified on the pinned WebAssembly backend, over genuine statement proofs; a test-labelled set, not adopted (succinct-read §§1, 6)"
      : "real check proofs on the pinned WebAssembly backend over genuine statement proofs; a test-labelled set, not adopted (succinct-read §§1, 6)",
    host,
    setIdentity: Buffer.from(set.identity).toString("hex"), circuits: Object.fromEntries(Object.entries(gates).map(([name, g]) =>
      [name, { ...g, ...CHECK_SET_MANIFEST.circuits[name] }])),
    proofs, ...native ? { compared } : {}, checks,
    limits: ["one genuine proof per kind here; a served trail read with real covers is the recovery check's",
      "one run on one runner", "bb's in-circuit limb and curve constraints and key-hash binding are read from source by review, not proved (adoption evidence, §6)",
      ...native ? ["the native binary is bb.js's own build, run as shipped; its source is the WebAssembly build's, not shown equal beyond the keys and proofs here"] : []],
  };
  write(result);
} finally {
  clearInterval(sampler);
  await prover?.close();
  await statements?.close();
  await live?.destroy();
}
