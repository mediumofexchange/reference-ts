// Slice 36 acceptance (succinct-read §§2, 3.2, 3.5): the trail check set proved and verified on the pinned backend.
// The six circuits are generated and compiled again and their keys derived (check-set.mjs, which fails where a source
// or a shipped file differs), and the identities it prints must be the ones check-set.ts pins. Over one genuine proof
// of each proved kind (test/fixtures/pool-v3-genuine-proofs.json, each verified natively first), the aggregator proves
// the five leaves and a two-level tree; each cover carries the host's digest and verifies under the pinned key the
// rule names. Hostile covers cover nothing: another kind's leaf key or the node key, a node cover as a leaf, a wrong
// digest, other lengths and a flipped byte, a tree whose node-key input is not the pinned key's hash (the forged-tree
// rule, §2 rules 1-2), a statement proof that fails natively (no leaf), a leaf forced over it, and nodes over a child
// verifying under a key other than its admitted hash's or over a child cover with a flipped byte. Times and the
// process's peak memory are recorded per proof.
//
// Usage: node scripts/pool/v3/check-set-check.mjs (after npm run build); writes docs/pool-v3-check-set-verification.json.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Noir } from "@noir-lang/noir_js";
import { UltraHonkBackend } from "@aztec/bb.js";
import { prepareCheckSetParameters, readCheckSetParameters } from "../../../dist/pool/parameter-files.js";
import { keyedVerifier, PROOF_OPTIONS, startCheckSetBackend } from "../../../dist/pool/proof-verifier.js";
import { fieldToHex } from "../../../dist/pool/field.js";
import { adoptedDomain } from "../../../dist/pool/v3/configuration.js";
import { openTrailProver } from "../../../dist/pool/v3/aggregator.js";
import { CHECK_SET_MANIFEST, checkSetIdentity, trailKeys, trailPrograms } from "../../../dist/pool/v3/check-set.js";
import { nodeDigest, statementLeafDigest, SUCCINCT_SPECIFICATION } from "../../../dist/pool/v3/succinct.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { openV3Verifier } from "../../../dist/pool/v3/verifier.js";
import { PARAMETER_DIRECTORY } from "../prepare-crs.mjs";
import { V3_SPECIFICATION, sourceClosure, sourceHashes } from "./provenance.mjs";

const here = import.meta.dirname, root = resolve(here, "../../.."), report = join(root, "docs/pool-v3-check-set-verification.json");
const sources = sourceClosure(["scripts/pool/v3/check-set-check.mjs", "scripts/pool/v3/check-set.mjs", "scripts/pool/v3/trail-circuits/trail.nr",
  ...["issue", "spend", "burn", "demand", "settle"].map(name => `scripts/pool/v3/trail-circuits/leaf-${name}.nr`), "scripts/pool/v3/trail-circuits/node.nr",
  "src/pool/circuits/vendor/poseidon2.nr", "src/pool/v3/check-set.json", "src/pool/v3/check-set-programs.json", "test/fixtures/pool-v3-genuine-proofs.json",
  "package-lock.json"]);
const digests = sourceHashes(sources);
const checks = [], proofs = [];
const check = label => { checks.push(label); console.log(`passed: ${label}`); };

// The process's peak resident memory, sampled: the backend's WebAssembly workers live in this process.
let peak = 0;
const sample = () => { peak = Math.max(peak, process.memoryUsage().rss); };
const sampler = setInterval(sample, 200);
const timed = async (label, run) => {
  peak = 0; sample();
  const started = performance.now(), value = await run();
  sample();
  const entry = { label, seconds: Number(((performance.now() - started) / 1000).toFixed(1)), peakMiB: Math.round(peak / 2 ** 20) };
  proofs.push(entry); console.log(`proved: ${label} in ${entry.seconds} s, peak ${entry.peakMiB} MiB`);
  return value;
};

await prepareCheckSetParameters(PARAMETER_DIRECTORY, { log: console.log });
// The sources and shipped files are what the keys compile to, and their identities the ones check-set.ts pins.
const generated = execFileSync(process.execPath, [join(here, "check-set.mjs"), "--stats"], { cwd: root, encoding: "utf8",
  env: { ...process.env, CHECK_SET_PARAMETERS: PARAMETER_DIRECTORY }, maxBuffer: 1 << 26 });
const derived = JSON.parse(generated.slice(generated.indexOf("identities ") + "identities ".length, generated.lastIndexOf("}") + 1));
assert.deepEqual(derived, CHECK_SET_MANIFEST.circuits);
const gates = Object.fromEntries([...generated.matchAll(/^(\S+): compiled in ([\d.]+) s, key in ([\d.]+) s, (\d+) gates$/gm)]
  .map(([, name, compileS, keyS, count]) => [name, { gates: Number(count), compileS: Number(compileS), keyS: Number(keyS) }]));
assert.equal(Object.keys(gates).length, 6);
check("the six sources and the shipped keys and programs are what check-set.mjs generates; every identity is the one check-set.ts pins");

const threads = availableParallelism();
const parameters = await readCheckSetParameters(PARAMETER_DIRECTORY), api = await startCheckSetBackend(parameters, { threads });
let statements, prover;
try {
  statements = await openV3Verifier(api);
  prover = await openTrailProver(api, statements);
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
  const left = await timed("node over two leaves", () => prover.node(leaves.issue, leaves.spend));
  const right = await timed("node over two leaves (2)", () => prover.node(leaves.burn, leaves.demand));
  const top = await timed("node over two nodes", () => prover.node(left, right));
  assert.equal(top.digest, nodeDigest(nodeDigest(leaves.issue.digest, leaves.spend.digest), nodeDigest(leaves.burn.digest, leaves.demand.digest)));
  for (const cover of [left, right, top]) assert.equal(await set.verify(undefined, cover.digest, cover.proof), true);
  check("the node proves over two leaves and over two nodes, outputs the host's node digests and verifies under the pinned node key");

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

  // §2 rules 1-2: the node-key input is free in every circuit; a tree proved under another value verifies under the
  // pinned node key with that value as its input, and only the reader's comparison refuses it.
  const forged = keys.node.keyHash + 1n, programs = trailPrograms();
  const proveRaw = async (name, inputs, on = api) => {
    const { witness } = await new Noir(programs[name]).execute(inputs);
    return new UltraHonkBackend(programs[name].bytecode, on).generateProof(witness, PROOF_OPTIONS);
  };
  const fields = bytes => Array.from({ length: bytes.length / 32 }, (_, i) => `0x${Buffer.from(bytes.subarray(32 * i, 32 * i + 32)).toString("hex")}`);
  const forgedLeaf = await timed("leaf-spend under a forged node-key input", () => proveRaw("leaf-spend",
    { proof: fields(records.spend.proof), inputs: records.spend.publicInputs.map(fieldToHex), node_key_hash: fieldToHex(forged) }));
  const forgedRoot = await timed("node under a forged node-key input", () => proveRaw("node", {
    keys: [fields(keys["leaf-spend"].vk), fields(keys["leaf-spend"].vk)], proofs: [forgedLeaf.proof, forgedLeaf.proof].map(fields),
    key_hashes: [fieldToHex(keys["leaf-spend"].keyHash), fieldToHex(keys["leaf-spend"].keyHash)],
    digests: [leaves.spend.digest, leaves.spend.digest].map(fieldToHex), node_key_hash: fieldToHex(forged) }));
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
    const fresh = await startCheckSetBackend(parameters, { threads });
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

  const result = {
    specification: { pool: V3_SPECIFICATION, succinct: SUCCINCT_SPECIFICATION }, sources: digests,
    evidence: "real check proofs on the pinned WebAssembly backend over genuine statement proofs; a test-labelled set, not adopted (succinct-read §§1, 6)",
    host: { cpu: cpus()[0]?.model, threads, memoryGiB: Math.round(totalmem() / 2 ** 30), platform: process.platform, node: process.version },
    setIdentity: Buffer.from(set.identity).toString("hex"), circuits: Object.fromEntries(Object.entries(gates).map(([name, g]) =>
      [name, { ...g, ...CHECK_SET_MANIFEST.circuits[name] }])),
    proofs, checks,
    limits: ["one genuine proof per kind here; a served trail read with real covers is the recovery check's",
      "one run on one runner", "bb's in-circuit limb and curve constraints and key-hash binding are read from source by review, not proved (adoption evidence, §6)"],
  };
  writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`check-set: ${checks.length} checks passed; wrote ${report}`);
} finally {
  clearInterval(sampler);
  await prover?.close();
  await statements?.close();
  await api.destroy();
}
