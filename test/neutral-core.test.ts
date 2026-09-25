import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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

/** Every relative module a source imports or re-exports, type-only ones included. */
function relativeImports(path: string): string[] {
  const source = readFileSync(join(root, path), "utf8");
  const found = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"(\.[^"]+)"/g), ...source.matchAll(/import\(\s*"(\.[^"]+)"\s*\)/g)];
  return found.map(match => relative(root, join(root, dirname(path), match[1]!.replace(/\.js$/, ".ts"))).replace(/\\/g, "/"));
}

describe("the construction-neutral core", () => {
  it("imports only itself", () => {
    const outside: string[] = [];
    for (const module of NEUTRAL) {
      for (const imported of relativeImports(module)) if (!NEUTRAL.includes(imported)) outside.push(`${module} -> ${imported}`);
    }
    expect(outside).toEqual([]);
  });

  it("reads the imports the check depends on", () => {
    // The scanner sees multi-line, type-only and re-export forms, so the check above cannot pass by missing them.
    expect(relativeImports("src/record-range.ts")).toEqual(["src/bytes.ts", "src/venue-records.ts"]);
    expect(relativeImports("src/commitment.ts")).toEqual(expect.arrayContaining(["src/ledger.ts", "src/venue-records.ts", "src/oplog.ts"]));
    expect(relativeImports("src/revocation.ts")).toEqual(expect.arrayContaining(["src/backing.ts", "src/venue.ts"]));
  });
});
