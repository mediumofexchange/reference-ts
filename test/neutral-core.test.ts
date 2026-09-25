import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The construction-neutral core (decision "Plan the v3 runtime", M0): what a
// construction after pool-v2 builds on. Its import closure stays inside this
// set, so deleting the transparent path or pool-v2 cannot break it. A module
// joins the set deliberately, by adding it here.
const NEUTRAL = [
  "src/bytes.ts", "src/keys.ts", "src/contexts.ts",
  "src/venue-error.ts", "src/venue-records.ts", "src/record-range.ts",
  "src/ergo-profile.ts", "src/ergo-headers.ts", "src/ergo-supplier.ts", "src/ergo-publisher.ts",
  "src/pool/field.ts", "src/pool/poseidon2.ts", "src/pool/notes.ts", "src/pool/note-tree.ts",
  "src/pool/scope.ts", "src/pool/schedule.ts", "src/pool/proof-verifier.ts",
];
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The v3 construction (plan decision 2): every module under src/pool/v3/,
// which builds on the neutral core and nothing else.
const V3 = readdirSync(join(root, "src/pool/v3"), { recursive: true, encoding: "utf8" }).filter(name => name.endsWith(".ts"))
  .map(name => `src/pool/v3/${name.replace(/\\/g, "/")}`);

/** Every module specifier a source names, in any form: the compiler's own scan, type-only imports included. */
const specifiers = (source: string): string[] => ts.preProcessFile(source, true, true).importedFiles.map(file => file.fileName);

/** Every relative module a repository source imports or re-exports, as a repository path. */
function relativeImports(path: string): string[] {
  return specifiers(readFileSync(join(root, path), "utf8")).filter(name => name.startsWith("."))
    .map(name => relative(root, join(root, dirname(path), name.replace(/\.js$/, ".ts"))).replace(/\\/g, "/"));
}

describe("the construction-neutral core", () => {
  it("imports only itself", () => {
    const outside: string[] = [];
    for (const module of NEUTRAL) {
      for (const imported of relativeImports(module)) if (!NEUTRAL.includes(imported)) outside.push(`${module} -> ${imported}`);
    }
    expect(outside).toEqual([]);
  });

  it("carries v3, which imports only the neutral core and itself", () => {
    expect(V3).toEqual(expect.arrayContaining(["src/pool/v3/records.ts", "src/pool/v3/capsules.ts", "src/pool/v3/spent-set.ts"]));
    const outside: string[] = [];
    for (const module of V3) {
      for (const imported of relativeImports(module)) if (!NEUTRAL.includes(imported) && !V3.includes(imported)) outside.push(`${module} -> ${imported}`);
    }
    expect(outside).toEqual([]);
  });

  it("reads every import form, so the check cannot pass by missing one", () => {
    expect(specifiers(`import "./a.js";\nimport type { X } from './b.js';\nexport * from "./c.js";\nconst d = await import("./d.js");\n` +
      `import {\n  e,\n} from "./e.js";`)).toEqual(["./a.js", "./b.js", "./c.js", "./d.js", "./e.js"]);
    expect(relativeImports("src/record-range.ts")).toEqual(["src/bytes.ts", "src/venue-records.ts"]);
    expect(relativeImports("src/commitment.ts")).toEqual(expect.arrayContaining(["src/ledger.ts", "src/venue-records.ts", "src/oplog.ts"]));
  });
});
