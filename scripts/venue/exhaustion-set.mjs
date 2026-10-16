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
import path from "node:path";
import { build, root } from "./exhaustion-build.mjs";
import { EMPTY_SUBTREES } from "../../dist/ergo-exhaustion.js";
import { circuitIdentities, EXHAUSTION_CIRCUITS, EXHAUSTION_SET_MANIFEST } from "../../dist/ergo-exhaustion-set.js";
import { readExhaustionCircuits } from "../../dist/ergo-exhaustion-pool.js";

const argv = process.argv.slice(2), write = argv.includes("--write");
const { t, m, u } = EXHAUSTION_SET_MANIFEST.sizes;
const directory = path.resolve(argv.includes("--dir") ? argv[argv.indexOf("--dir") + 1] : path.join(root, "scratch/exhaustion", `${t}-${m}-${u}`));
if (!existsSync(path.join(directory, "fold-next", "vk", "vk_hash"))) {
  await build({ CT: t, CM: m, E: u }, { keys: true, directory, emptyRoot: "0x" + EMPTY_SUBTREES[32].toString(16).padStart(64, "0") });
}
const circuits = readExhaustionCircuits(directory);
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
const identities = circuitIdentities(circuits);
for (const name of EXHAUSTION_CIRCUITS) {
  const pinned = EXHAUSTION_SET_MANIFEST.circuits[name], built = identities[name];
  if (pinned.bytecode !== built.bytecode || pinned.vk !== built.vk || pinned.keyHash !== built.keyHash) {
    console.error(`${name}: the manifest pins ${JSON.stringify(pinned)}, the build gives ${JSON.stringify(built)}`);
    failed = true;
  }
}
console.log(JSON.stringify(identities, null, 2));
console.log(failed ? "exhaustion-set: differs" : "exhaustion-set: the shipped sources, keys and identities are what the build gives");
process.exitCode = failed ? 1 : 0;
