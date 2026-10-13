// Child of test/pool-v3-check-set.test.ts: trail.nr's own word constraints (`words_of`) driven with chosen words. The
// circuit is trail.nr as shipped, with the hint lifted into an input: `words_of` calls `words_of_given` over the same
// constraint body, which a probe's main takes words for. Prints each case's outcome as JSON. Run in its own process,
// since Noir needs POSIX paths and this patches the path module.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compile_program, createFileManager } from "@noir-lang/noir_wasm";
import { Noir } from "@noir-lang/noir_js";

const root = path.resolve(import.meta.dirname, "..");
const source = readFileSync(path.join(root, "scripts/pool/v3/trail-circuits/trail.nr"), "utf8").replace(/\r\n/g, "\n");
const hinted = "    // Safety: every word is a u32 and the words are constrained below p and to x.\n    let words = unsafe { word_hint(x) };\n";
if (!source.includes(`fn words_of(x: Field) -> [u32; 8] {\n${hinted}`)) throw new Error("trail.nr's words_of changed");
const lifted = source.replace(`fn words_of(x: Field) -> [u32; 8] {\n${hinted}`,
  `fn words_of(x: Field) -> [u32; 8] {\n    // Safety: words_of_given constrains them.\n    words_of_given(x, unsafe { word_hint(x) })\n}\n\npub fn words_of_given(x: Field, words: [u32; 8]) -> [u32; 8] {\n`);
for (const name of ["join", "resolve", "normalize", "dirname"]) {
  const native = path[name];
  path[name] = (...args) => native(...args).replaceAll("\\", "/");
}
const project = mkdtempSync(path.join(tmpdir(), "moe-words-"));
try {
  mkdirSync(path.join(project, "src"));
  writeFileSync(path.join(project, "Nargo.toml"), `[package]\nname = "words_probe"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
  writeFileSync(path.join(project, "src/trail.nr"), lifted);
  writeFileSync(path.join(project, "src/poseidon2.nr"), readFileSync(path.join(root, "src/pool/circuits/vendor/poseidon2.nr")));
  writeFileSync(path.join(project, "src/main.nr"), "mod poseidon2;\nmod trail;\nuse std::hash::poseidon2_permutation;\n\n" +
    "fn main(x: Field, words: [u32; 8]) -> pub [u32; 8] {\n    trail::words_of_given(x, words)\n}\n");
  const manager = createFileManager(project);
  const readDirectory = manager.readdir.bind(manager);
  manager.readdir = async (...args) => (await readDirectory(...args)).map(entry => entry.replaceAll("\\", "/"));
  const { program } = await compile_program(manager, undefined, () => {}, () => {});
  const noir = new Noir(program), cases = JSON.parse(process.argv[2]), out = [];
  for (const { x, words } of cases) {
    out.push(await noir.execute({ x, words }).then(() => "accepted", error => String(error?.message ?? error)));
  }
  process.stdout.write(JSON.stringify(out));
} finally { rmSync(project, { recursive: true, force: true }); }
