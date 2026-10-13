// The trail check set's six circuits (succinct-read §3.2): five trail leaves, one per proved kind, each holding
// pool-v3 §11.4's key for its kind as a constant, and the trail node, holding the five leaf keys' hashes. Each leaf's
// and the node's `main.nr` is generated here from the keys it holds; `trail.nr` and the vendored sponge are shared.
//
//   node scripts/pool/v3/check-set.mjs [--write] [--stats] [--out <directory>]
//
// Run after `npm run build`, with the check set's parameters cached (prepareCheckSetParameters) in
// scratch/private-payment-crs or the directory CHECK_SET_PARAMETERS names. It derives the five inner keys from the
// shipped relations (each checked against the manifest), generates the leaf sources, compiles them under the pinned
// compiler, derives their keys under the pinned backend, generates the node source from their key hashes, compiles it
// and derives its key. The shipped set is two files: src/pool/v3/check-set.json, each circuit's key and key hash (what
// a reader pins), and src/pool/v3/check-set-programs.json, each circuit's compiler version, ABI and bytecode (what a
// prover runs). Without --write it fails where a source or shipped file differs; --out also writes what it generated
// there. It prints each circuit's identities (SHA-256 of bytecode and key, and key hash) for check-set.ts to pin;
// --stats adds gate counts.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { compile_program, createFileManager } from "@noir-lang/noir_wasm";

const root = path.resolve(import.meta.dirname, "../../..");
const sources = path.join(import.meta.dirname, "trail-circuits");
const sponge = path.join(root, "src/pool/circuits/vendor/poseidon2.nr");
const SHIPPED = { keys: path.join(root, "src/pool/v3/check-set.json"), programs: path.join(root, "src/pool/v3/check-set-programs.json") };
const argv = process.argv.slice(2), write = argv.includes("--write"), stats = argv.includes("--stats");
const out = argv.includes("--out") ? path.resolve(argv[argv.indexOf("--out") + 1]) : undefined;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const hex = bytes => "0x" + Buffer.from(bytes).toString("hex");

const { POOL_V3_MANIFEST } = await import(new URL("../../../dist/pool/v3/configuration.js", import.meta.url));
const { readCheckSetParameters } = await import(new URL("../../../dist/pool/parameter-files.js", import.meta.url));
const { startCheckSetBackend, PROOF_OPTIONS } = await import(new URL("../../../dist/pool/proof-verifier.js", import.meta.url));
const programs = JSON.parse(readFileSync(path.join(root, "src/pool/v3/programs.json"), "utf8"));
/** succinct-read §3.2's five leaves: the relation, its kind and its public-input count. */
const LEAVES = [["issue", 1, 11], ["spend", 2, 15], ["burn", 3, 15], ["demand", 4, 16], ["settle", 6, 17]];
if (PROOF_OPTIONS.verifierTarget !== "noir-recursive") throw new Error("the proof options are not pool-v3 §4's");
// What bb.js 5.2.0 maps the noir-recursive target to (its getProofSettingsFromOptions).
const SETTINGS = { ipaAccumulation: false, oracleHashType: "poseidon2", disableZk: false, optimizedSolidityVerifier: false };

const api = await startCheckSetBackend(await readCheckSetParameters(process.env.CHECK_SET_PARAMETERS ?? path.join(root, "scratch/private-payment-crs")),
  { threads: Number(process.env.THREADS ?? 4) });
/** A circuit's key under pool-v3 §4's target, as the backend derives it: its bytes, its fields and its hash. */
async function key(bytecode) {
  const vk = await api.circuitComputeVk({ circuit: { name: "circuit", bytecode: gunzipSync(Buffer.from(bytecode, "base64")) }, settings: SETTINGS });
  return { bytes: vk.bytes, fields: vk.fields.map(hex), hash: hex(vk.hash) };
}
async function gates(bytecode) {
  const stats = await api.circuitStats({ circuit: { name: "circuit", bytecode: gunzipSync(Buffer.from(bytecode, "base64")), verificationKey: new Uint8Array() },
    includeGatesPerOpcode: false, settings: SETTINGS });
  return stats.numGates;
}

// Noir resolves sources by POSIX paths; on Windows every path and directory entry it sees uses forward slashes.
for (const name of ["join", "resolve", "normalize", "dirname"]) {
  const native = path[name];
  path[name] = (...args) => native(...args).replaceAll("\\", "/");
}
mkdirSync(path.join(root, "scratch"), { recursive: true });
const scratch = realpathSync(path.join(root, "scratch"));
const build = realpathSync(mkdtempSync(path.join(scratch, "check-set-")));
async function compile(name, main) {
  const project = path.join(build, name);
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "Nargo.toml"), `[package]\nname = "moe_succinct_trail_${name.replace("-", "_")}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
  writeFileSync(path.join(project, "src/main.nr"), main);
  copyFileSync(path.join(sources, "trail.nr"), path.join(project, "src/trail.nr"));
  copyFileSync(sponge, path.join(project, "src/poseidon2.nr"));
  const manager = createFileManager(project);
  const readDirectory = manager.readdir.bind(manager);
  manager.readdir = async (...args) => (await readDirectory(...args)).map(entry => entry.replaceAll("\\", "/"));
  const { program, warnings } = await compile_program(manager, undefined, () => {}, () => {});
  if (warnings.length) throw new Error(`${name}: compiler warnings require review: ${JSON.stringify(warnings)}`);
  return { noir_version: program.noir_version, abi: program.abi, bytecode: program.bytecode };
}
const list = values => values.map(v => `    ${v},`).join("\n");

const HEADER = "// Generated by scripts/pool/v3/check-set.mjs from the keys this circuit holds; do not edit.\n";
function leafSource(name, kind, m, inner) {
  return `${HEADER}// The trail leaf for pool-v3's ${name} relation, kind ${kind} (succinct-read §3.2): it verifies one proof of 458
// field elements under pool-v3 §11.4's key for kind ${kind}, a constant here, with the ${m} public inputs in pool-v3 §5's
// order, and outputs leafDigest = H(T_CHECK_LEAF, ${kind}, x_1, ..., x_${m}, proofHash.hi, proofHash.lo). Its public
// inputs are (nodeKeyHash, digest); nodeKeyHash is free here and bound by whoever admits the proof (§2 rule 1).
mod poseidon2;
mod trail;
use poseidon2::Poseidon2;
// The vendored sponge calls crate::poseidon2_permutation.
use std::hash::poseidon2_permutation;

global KIND: Field = ${kind};
// pool-v3 §11.4's key for kind ${kind} as the pinned backend derives it from the shipped relation (SHA-256 of its bytes
// ${inner.sha}, the manifest's), and its hash.
global KEY_HASH: Field = ${inner.hash};
global KEY: [Field; trail::KEY_FIELDS] = [
${list(inner.fields)}
];

fn main(proof: [Field; trail::PROOF_FIELDS], inputs: [Field; ${m}], node_key_hash: pub Field) -> pub Field {
    let _ = node_key_hash;
    std::verify_proof_with_type(KEY, proof, inputs, KEY_HASH, trail::HONK_ZK);
    let (high, low) = trail::proof_hash(proof);
    let mut message = [0; ${m + 4}];
    message[0] = trail::T_CHECK_LEAF;
    message[1] = KIND;
    for i in 0..${m} {
        message[2 + i] = inputs[i];
    }
    message[${m + 2}] = high;
    message[${m + 3}] = low;
    Poseidon2::hash(message, ${m + 4})
}
`;
}
function nodeSource(leafHashes) {
  return `${HEADER}// The trail node (succinct-read §3.2): it verifies two children, each a proof of 458 field elements under a key
// whose hash is one of the five trail leaves' (constants here) or the node's own, the public input nodeKeyHash, and
// outputs nodeDigest = H(T_CHECK_NODE, left, right) of the children's digests. Each child's public inputs are
// (nodeKeyHash, its digest), so every proof under a node carries the same nodeKeyHash, which the reader compares with
// the pinned node key's hash (§2 rules 1-2). The backend binds each child's key to the key hash it is verified under:
// bb 5.2.0's recursive verifier asserts the key's hash equal to it (ultra_honk/oink_verifier.cpp,
// receive_vk_hash_and_public_inputs).
mod poseidon2;
mod trail;
// The vendored sponge calls crate::poseidon2_permutation.
use std::hash::poseidon2_permutation;

// The trail leaves' key hashes: issue, spend, burn, demand, settle.
global LEAF_KEY_HASHES: [Field; 5] = [
${list(leafHashes)}
];

fn main(
    keys: [[Field; trail::KEY_FIELDS]; 2],
    proofs: [[Field; trail::PROOF_FIELDS]; 2],
    key_hashes: [Field; 2],
    digests: [Field; 2],
    node_key_hash: pub Field,
) -> pub Field {
    for i in 0..2 {
        let mut admitted = key_hashes[i] == node_key_hash;
        for j in 0..5 {
            admitted = admitted | (key_hashes[i] == LEAF_KEY_HASHES[j]);
        }
        assert(admitted);
        std::verify_proof_with_type(keys[i], proofs[i], [node_key_hash, digests[i]], key_hashes[i], trail::HONK_ZK);
    }
    trail::node_digest(digests[0], digests[1])
}
`;
}

let failed = false;
const current = file => { try { return readFileSync(file, "utf8").replace(/\r\n/g, "\n"); } catch { return undefined; } };
/** Write `text` at `file` with --write, else fail where it differs; --out keeps a copy under its repository path. */
const settle = (file, text) => {
  if (out !== undefined) {
    const copy = path.join(out, path.relative(root, file));
    mkdirSync(path.dirname(copy), { recursive: true });
    writeFileSync(copy, text);
  }
  if (current(file) === text) return;
  if (write) writeFileSync(file, text);
  else { console.error(`${path.relative(root, file)} is not what check-set.mjs generates; run node scripts/pool/v3/check-set.mjs --write`); failed = true; }
};
const timed = async (label, run) => {
  const started = Date.now(), value = await run();
  return { value, seconds: ((Date.now() - started) / 1000).toFixed(1) };
};
try {
  const keys = {}, shippedPrograms = {}, leafHashes = [], identities = {};
  const circuit = async (name, main, kind) => {
    settle(path.join(sources, `${name}.nr`), main);
    const compiled = await timed("compile", () => compile(name, main));
    const derived = await timed("key", () => key(compiled.value.bytecode));
    const { bytes, hash } = derived.value;
    if (bytes.length !== 115 * 32) throw new Error(`${name}: a key of ${bytes.length} bytes`);
    keys[name] = { ...(kind === undefined ? {} : { kind }), vk: Buffer.from(bytes).toString("base64"), keyHash: hash };
    shippedPrograms[name] = compiled.value;
    identities[name] = { bytecode: sha(gunzipSync(Buffer.from(compiled.value.bytecode, "base64"))), vk: sha(bytes), keyHash: hash };
    console.log(`${name}: compiled in ${compiled.seconds} s, key in ${derived.seconds} s${stats ? `, ${await gates(compiled.value.bytecode)} gates` : ""}`);
    return hash;
  };
  for (const [name, kind, m] of LEAVES) {
    const inner = await key(programs[name].bytecode);
    inner.sha = sha(inner.bytes);
    if (inner.sha !== POOL_V3_MANIFEST.circuits[name].vk) throw new Error(`${name}: the derived key is not the manifest's`);
    if (inner.fields.length !== 115) throw new Error(`${name}: a key of ${inner.fields.length} fields`);
    leafHashes.push(await circuit(`leaf-${name}`, leafSource(name, kind, m, inner), kind));
  }
  await circuit("node", nodeSource(leafHashes));
  settle(SHIPPED.keys, `${JSON.stringify(keys, null, 2)}\n`);
  settle(SHIPPED.programs, `${JSON.stringify(shippedPrograms, null, 2)}\n`);
  console.log(`identities ${JSON.stringify(identities, null, 2)}`);
  console.log(failed ? "check-set: differs" : write ? "check-set: wrote the sources and the shipped set" : "check-set: the sources and the shipped set are what the keys compile to");
} finally {
  await api.destroy();
  if (!build.replaceAll("\\", "/").startsWith(scratch.replaceAll("\\", "/") + "/")) throw new Error("unsafe scratch cleanup");
  rmSync(build, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
