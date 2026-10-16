// The data files `npm run build` copies beside the compiled modules: the pool's programs and the trail check set
// (src/pool/v3), and the exhaustion set's keys and the sources a prover compiles (src/exhaustion-circuits, and the
// vendored sponge they share at its own path). A library for release.mjs's fresh-build check and a command:
//
//   node scripts/build-files.mjs [<out directory>]   (default dist)
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
/** Each copied file: its source and its path under the output directory. */
export const BUILD_FILES = Object.freeze([
  ...["programs.json", "check-set.json", "check-set-programs.json"].map(file => [`src/pool/v3/${file}`, `pool/v3/${file}`]),
  ["src/exhaustion-set.json", "exhaustion-set.json"],
  ...["exhaustion.nr", "blake2b.nr", "leaf-t.nr", "leaf-m.nr", "leaf-u.nr", "node.nr", "fold-first.nr", "fold-next.nr"]
    .map(file => [`src/exhaustion-circuits/${file}`, `exhaustion-circuits/${file}`]),
  ["src/pool/circuits/vendor/poseidon2.nr", "pool/circuits/vendor/poseidon2.nr"],
]);
/** Copy every build file under `out`. */
export function copyBuildFiles(out) {
  for (const [from, to] of BUILD_FILES) {
    mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
    copyFileSync(path.join(root, from), path.join(out, to));
  }
}
if (process.argv[1] === import.meta.filename) copyBuildFiles(path.resolve(root, process.argv[2] ?? "dist"));
