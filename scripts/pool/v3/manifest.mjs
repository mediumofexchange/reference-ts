// The runtime's manifest of pool-v3 §11.4's adopted configuration
// (src/pool/v3/configuration.ts), checked against this checkout: the installed
// toolchain, the relation sources and a build's artifacts and keys (§11.1).
// Never selected by IPC or served evidence.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as configurationCodec from "../../../dist/pool/v3/configuration.js";
import * as termsCodec from "../../../dist/pool/v3/terms.js";

export { adoptedConfiguration, adoptedDomain } from "../../../dist/pool/v3/configuration.js";
export const RELATION_KINDS = Object.freeze([[1, "issue"], [2, "spend"], [3, "burn"], [4, "demand"], [6, "settle"], [7, "request"]].map(Object.freeze));
const root = resolve(import.meta.dirname, "../../..");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const requireIdentity = (actual, expected, label) => {
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) throw new Error("manifest identity encoding");
  if (actual !== expected) throw new Error(`manifest identity mismatch: ${label}`);
};

/** A mutable copy of the runtime's manifest, for checks that alter it to see a refusal. */
export function loadManifest() {
  return structuredClone(configurationCodec.POOL_V3_MANIFEST);
}

/** The installed toolchain is the manifest's, and every source file hashes to its identity. */
export function checkSources(manifest) {
  if (manifest.verifierTarget !== "noir-recursive") throw new Error("manifest verifier target");
  for (const [name, version] of Object.entries(manifest.toolchain)) {
    if (JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version !== version) throw new Error("manifest toolchain version");
  }
  const sources = [...RELATION_KINDS.map(([, name]) => `${name}.nr`), "notes.nr", "poseidon2.nr"];
  if (Object.keys(manifest.sources).sort().join() !== [...sources].sort().join()) throw new Error("manifest source set");
  for (const name of sources) {
    const path = name === "poseidon2.nr" ? join(root, "src/pool/circuits/vendor", name) : join(import.meta.dirname, "circuits", name);
    requireIdentity(sha(readFileSync(path)), manifest.sources[name], name);
  }
}

/** All six artifacts and retained key bytes are checked even for an empty or
 * issue-only trail. Returns owned keys, never backend or package references. */
export function readKeys(build, manifest) {
  const keys = new Map();
  for (const [kind, name] of RELATION_KINDS) {
    const artifact = JSON.parse(readFileSync(join(build, `${name}.json`), "utf8"));
    requireIdentity(sha(Buffer.from(artifact.bytecode, "base64")), manifest.circuits[name].bytecode, `${name} bytecode`);
    const key = readFileSync(join(build, `${kind}.vk`));
    requireIdentity(sha(key), manifest.circuits[name].vk, `${name} key`);
    keys.set(kind, new Uint8Array(key));
  }
  return keys;
}

export const configurationCodecs = Object.freeze({ ...configurationCodec, ...termsCodec });
