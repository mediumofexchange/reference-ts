// The first, branching draft of the scan (draft.nr), kept for its measured cost: node draft.mjs parse <L>, then compile.mjs.
// node draft.mjs <variant> <L>: write scratch/scan-probe/draft_<variant>_<L> with draft.nr as scan.nr and a main for it.
//   test: returns the scan's outputs (for cross-checks); venue: the commitment with §6's four locations;
//   generic: the commitment for every shaped output whatever its tree; parse: the scan's validity alone.
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
export const SL = 40;
export function project(variant, L) {
  const E = Math.floor(L / 6) + 1;
  const dir = path.resolve(import.meta.dirname, '../../../scratch/scan-probe', `draft_${variant}_${L}`);
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'Nargo.toml'), `[package]\nname = "${variant}_${L}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
  copyFileSync(path.join(import.meta.dirname, 'draft.nr'), path.join(dir, 'src/scan.nr'));
  const sig = `bytes: [u8; ${L}], n: u32, scripts: [[u8; ${SL}]; 4], lens: [Field; 4]`;
  const body = {
    test: `fn main(${sig}) -> pub (bool, Field, [Field; ${E}], [Field; ${E}], [Field; ${E}]) {\n    scan::scan::<${L}, ${SL}, ${E}>(bytes, n, scripts, lens, false)\n}\n`,
    venue: `fn main(${sig}) -> pub (bool, Field) {\n    let (valid, outs, f, hi, lo) = scan::scan::<${L}, ${SL}, ${E}>(bytes, n, scripts, lens, false);\n    let _ = outs;\n    (valid, scan::commit(valid, f, hi, lo))\n}\n`,
    generic: `fn main(${sig}) -> pub (bool, Field) {\n    let (valid, outs, f, hi, lo) = scan::scan::<${L}, ${SL}, ${E}>(bytes, n, scripts, lens, true);\n    let _ = outs;\n    (valid, scan::commit(valid, f, hi, lo))\n}\n`,
    parse: `fn main(${sig}) -> pub (bool, Field) {\n    let (valid, outs, f, hi, lo) = scan::scan::<${L}, ${SL}, ${E}>(bytes, n, scripts, lens, true);\n    let _ = (f, hi, lo);\n    (valid, outs)\n}\n`,
  }[variant];
  writeFileSync(path.join(dir, 'src/main.nr'), `mod scan;\n${body}`);
  return { dir, E };
}
if (process.argv[1] === import.meta.filename) console.log(project(process.argv[2], Number(process.argv[3])).dir);
