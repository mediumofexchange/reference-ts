// Independently held candidate artifact identities. Never selected by IPC or
// served evidence. No adoption switch; this module is outside the runtime.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const RELATION_KINDS = Object.freeze([[1, "issue"], [2, "spend"], [3, "burn"], [4, "demand"], [6, "settle"], [7, "request"]].map(Object.freeze));
const root = resolve(import.meta.dirname, "../../..");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const hex = value => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("candidate identity encoding");
  return new Uint8Array(Buffer.from(value, "hex"));
};
const requireIdentity = (actual, expected, label) => {
  hex(expected);
  if (actual !== expected) throw new Error(`candidate identity mismatch: ${label}`);
};

export function loadCandidateManifest() {
  // This fixed repository path is the test verifier's trust input. The
  // manifest records reviewed candidate evidence, not approved deployment keys.
  return JSON.parse(readFileSync(new URL("candidate-manifest.json", import.meta.url), "utf8"));
}

export function checkCandidateSources(manifest) {
  if (manifest.purpose !== "conformance-only" || manifest.verifierTarget !== "noir-recursive") throw new Error("candidate manifest profile");
  const toolchain = { "@aztec/bb.js": "5.2.0", "@noir-lang/noir_js": "1.0.0-beta.26", "@noir-lang/noir_wasm": "1.0.0-beta.26" };
  if (JSON.stringify(manifest.toolchain) !== JSON.stringify(toolchain)) throw new Error("candidate toolchain declaration");
  for (const [name, version] of Object.entries(toolchain)) {
    if (JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version !== version) throw new Error("candidate toolchain version");
  }
  const sources = [...RELATION_KINDS.map(([, name]) => `${name}.nr`), "notes.nr", "poseidon2.nr"];
  if (Object.keys(manifest.sources).sort().join() !== [...sources].sort().join()) throw new Error("candidate source set");
  for (const name of sources) {
    const path = name === "poseidon2.nr" ? join(root, "src/pool/circuits/vendor", name) : join(import.meta.dirname, "circuits", name);
    requireIdentity(sha(readFileSync(path)), manifest.sources[name], name);
  }
}

export function candidateConfiguration(manifest, codec) {
  return codec.decodeConfiguration(codec.configurationBytes({
    circuits: Object.fromEntries(Object.entries(manifest.circuits).map(([name, identity]) => [name, {
      bytecode: hex(identity.bytecode), vk: hex(identity.vk),
    }])), helper: hex(manifest.sources["poseidon2.nr"]),
  }));
}

/** All six artifacts and retained key bytes are checked even for an empty or
 * issue-only trail. Returns owned keys, never backend or package references. */
export function readCandidateKeys(build, manifest) {
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

export async function loadConfigurationCodecs(buildUrl) {
  const [configuration, terms] = await Promise.all([
    import(new URL("model/pool-v3-configuration.js", buildUrl)),
    import(new URL("model/pool-v3-terms.js", buildUrl)),
  ]);
  return { ...configuration, ...terms };
}
