// The exhaustion circuit set the package ships (succinct-read §§4.3, 6; slice 43): builds the six circuits at the
// manifest's leaf sizes (exhaustion-build.mjs, with NARGO the pinned native compiler and keys from the leading 2^22
// points) and checks what the package ships against them: each circuit's generated source in src/exhaustion-circuits/
// (the shared modules beside them are the build's own inputs), each key and key hash in src/exhaustion-set.json, and
// each identity in EXHAUSTION_SET_MANIFEST (src/ergo-exhaustion-set.ts). With --write it writes the sources and the
// keys, and prints the identities for the manifest; without, it fails where any differs.
//
//   NARGO=<nargo 1.0.0-beta.26> node scripts/venue/exhaustion-set.mjs [--write] [--dir <build directory>]
//
// Run after `npm run build`. A build directory already holding the circuits with keys (exhaustion-build.mjs --keys at
// the same sizes) is read without building again: the build takes about ten minutes and 4 GB.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { build, root } from "./exhaustion-build.mjs";
import { EMPTY_SUBTREES } from "../../dist/ergo-exhaustion.js";
import { circuitIdentities, EXHAUSTION_CIRCUITS, EXHAUSTION_KEY_BYTES, EXHAUSTION_SET_MANIFEST } from "../../dist/ergo-exhaustion-set.js";

/** The circuits as exhaustion-build.mjs writes them: `<name>/program.json`, `<name>/vk/vk` and `<name>/vk/vk_hash`
 * under `directory`, with the leaves' slot counts read from their programs' parameters. */
function readBuilt(directory) {
  const circuits = Object.fromEntries(EXHAUSTION_CIRCUITS.map(name => {
    const program = JSON.parse(readFileSync(path.join(directory, name, "program.json"), "utf8"));
    const vk = new Uint8Array(readFileSync(path.join(directory, name, "vk", "vk")));
    const hash = readFileSync(path.join(directory, name, "vk", "vk_hash"));
    if (typeof program?.bytecode !== "string" || vk.length !== EXHAUSTION_KEY_BYTES || hash.length !== 32) throw new Error(`a malformed ${name} build`);
    return [name, { program, vk, keyHash: BigInt(`0x${hash.toString("hex")}`) }];
  }));
  const length = (circuit, parameter) => circuits[circuit].program.abi?.parameters?.find(p => p.name === parameter)?.type.length;
  return { sizes: { t: length("leaf-t", "tb"), m: length("leaf-m", "mb"), u: length("leaf-u", "uu") }, circuits };
}

const argv = process.argv.slice(2), write = argv.includes("--write");
const { t, m, u } = EXHAUSTION_SET_MANIFEST.sizes;
const directory = path.resolve(argv.includes("--dir") ? argv[argv.indexOf("--dir") + 1] : path.join(root, "scratch/exhaustion", `${t}-${m}-${u}`));
if (!existsSync(path.join(directory, "fold-next", "vk", "vk_hash"))) {
  await build({ CT: t, CM: m, E: u }, { keys: true, directory, emptyRoot: "0x" + EMPTY_SUBTREES[32].toString(16).padStart(64, "0") });
}
const circuits = readBuilt(directory);
let failed = false;
const compare = (file, expected) => {
  const at = path.join(root, file), held = existsSync(at) ? readFileSync(at, "utf8") : undefined;
  if (held === expected) return;
  if (write) { writeFileSync(at, expected); console.log(`wrote ${file}`); return; }
  console.error(`${file} is not what the build generates; run with --write`);
  failed = true;
};
for (const name of EXHAUSTION_CIRCUITS) compare(`src/exhaustion-circuits/${name}.nr`, readFileSync(path.join(directory, name, "src", "main.nr"), "utf8"));
const keys = Object.fromEntries(EXHAUSTION_CIRCUITS.map(name => [name, {
  vk: Buffer.from(circuits.circuits[name].vk).toString("base64"), keyHash: "0x" + circuits.circuits[name].keyHash.toString(16).padStart(64, "0") }]));
compare("src/exhaustion-set.json", `${JSON.stringify(keys, null, 2)}\n`);
const sizes = circuits.sizes;
if (sizes.t !== t || sizes.m !== m || sizes.u !== u) { console.error(`the build's sizes ${JSON.stringify(sizes)} are not the manifest's`); failed = true; }
// Each circuit's identities with its generated main.nr's SHA-256, as the manifest pins them (succinct-read §6).
const identities = Object.fromEntries(Object.entries(circuitIdentities(circuits)).map(([name, ids]) => [name, {
  source: createHash("sha256").update(readFileSync(path.join(directory, name, "src", "main.nr"))).digest("hex"), ...ids }]));
for (const name of EXHAUSTION_CIRCUITS) {
  const pinned = EXHAUSTION_SET_MANIFEST.circuits[name], built = identities[name];
  if (pinned.source !== built.source || pinned.bytecode !== built.bytecode || pinned.vk !== built.vk || pinned.keyHash !== built.keyHash) {
    console.error(`${name}: the manifest pins ${JSON.stringify(pinned)}, the build gives ${JSON.stringify(built)}`);
    failed = true;
  }
}
console.log(JSON.stringify(identities, null, 2));
console.log(failed ? "exhaustion-set: differs" : "exhaustion-set: the shipped sources, keys and identities are what the build gives");
process.exitCode = failed ? 1 : 0;
