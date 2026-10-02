// The six compiled relations the package ships (src/pool/v3/programs.json), checked by compiling the
// sources again: each artifact keeps only what witness generation and key derivation read (the ABI, the
// bytecode and the compiler version), never the debug symbols or file map, which hold this machine's paths.
// The runtime loader (src/pool/v3/verifier.ts) checks each bytecode against the manifest; this check also
// binds the ABI, which no identity covers, to the sources.
//
// Usage: node scripts/pool/v3/programs.mjs [--write]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const here = import.meta.dirname, root = resolve(here, "../../..");
const shipped = join(root, "src/pool/v3/programs.json");
const RELATIONS = ["issue", "spend", "burn", "demand", "settle", "request"];
mkdirSync(join(root, "scratch"), { recursive: true });
const scratch = realpathSync(join(root, "scratch"));
const build = realpathSync(mkdtempSync(join(scratch, "pool-v3-programs-")));
try {
  execFileSync(process.execPath, [join(here, "compile.mjs"), build], { cwd: root, stdio: ["ignore", "ignore", "inherit"], windowsHide: true, timeout: 300_000 });
  const programs = {};
  for (const name of RELATIONS) {
    const { noir_version, abi, bytecode } = JSON.parse(readFileSync(join(build, `${name}.json`), "utf8"));
    programs[name] = { noir_version, abi, bytecode };
  }
  const text = `${JSON.stringify(programs, null, 2)}\n`;
  if (process.argv.includes("--write")) {
    writeFileSync(shipped, text);
    console.log("Wrote src/pool/v3/programs.json from the relation sources");
  } else if (readFileSync(shipped, "utf8").replace(/\r\n/g, "\n") !== text) {
    console.error("src/pool/v3/programs.json is not what the relation sources compile to; run node scripts/pool/v3/programs.mjs --write");
    process.exitCode = 1;
  } else {
    console.log("Shipped programs: the six relations compile to src/pool/v3/programs.json exactly");
  }
} finally {
  if (!build.startsWith(scratch + sep)) throw new Error("unsafe scratch cleanup");
  rmSync(build, { recursive: true, force: true });
}
