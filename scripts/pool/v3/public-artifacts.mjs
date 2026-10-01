// Public files needed by the fresh reader's unchanged artifact/key checks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RELATION_KINDS, readKeys } from "./manifest.mjs";

export function publicArtifactFiles(build, manifest) {
  const keys = readKeys(build, manifest);
  return RELATION_KINDS.flatMap(([kind, name]) => [
    [`${kind}.vk`, keys.get(kind)],
    [`${name}.json`, Buffer.from(JSON.stringify({
      bytecode: JSON.parse(readFileSync(join(build, `${name}.json`), "utf8")).bytecode,
    }) + "\n")],
  ]);
}
