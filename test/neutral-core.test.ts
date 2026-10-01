import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { EncodingError } from "../src/bytes.js";
import { decodeRangeAnswer, MAX_RANGE_RECORD_BYTES } from "../src/record-range.js";
import { FixtureVenue } from "../src/record-venue.js";
import { VenueError } from "../src/venue-error.js";
import { directoryRoot, isEquivocation, signCommitment, type Commitment, type SnapshotDigest } from "../src/venue-records.js";

// The construction-neutral core (decision "Plan the v3 runtime", M0): what a
// construction after pool-v2 builds on. Its import closure stays inside this
// set, so deleting the transparent path or pool-v2 cannot break it. A module
// joins the set deliberately, by adding it here.
const NEUTRAL = [
  "src/bytes.ts", "src/keys.ts", "src/contexts.ts",
  "src/venue-error.ts", "src/venue-records.ts", "src/record-range.ts", "src/record-venue.ts",
  "src/ergo-profile.ts", "src/ergo-headers.ts", "src/ergo-supplier.ts", "src/ergo-publisher.ts", "src/ergo-synthetic.ts",
  "src/ergo.ts", "src/ergo-store.ts",
  "src/pool/field.ts", "src/pool/poseidon2.ts", "src/pool/notes.ts", "src/pool/note-tree.ts",
  "src/pool/scope.ts", "src/pool/schedule.ts", "src/pool/parameters.ts", "src/pool/proof-verifier.ts",
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
    expect(relativeImports("src/record-range.ts")).toEqual(["src/bytes.ts", "src/contexts.ts", "src/venue-records.ts"]);
    expect(relativeImports("src/commitment.ts")).toEqual(expect.arrayContaining(["src/ledger.ts", "src/venue-records.ts", "src/oplog.ts"]));
  });
});

describe("the venue records read what they judge once", () => {
  it("finds no equivocation in one signed commitment presented twice, however its fields are read", () => {
    const root = new Uint8Array(32).fill(1), signed = signCommitment(new Uint8Array(32).fill(7), 5n, root);
    let reads = 0;
    const flipping = { ...signed, get root() { return reads++ === 0 ? new Uint8Array(32).fill(2) : root; } } as Commitment;
    expect(isEquivocation(flipping, signed)).toBe(false);
    expect(isEquivocation(signed, signCommitment(new Uint8Array(32).fill(7), 5n, new Uint8Array(32).fill(2)))).toBe(true);
  });

  it("hashes a directory only of strictly increasing names, judged on the names it writes", () => {
    const name = (n: number): Uint8Array => new Uint8Array(32).fill(n), digest = new Uint8Array(32).fill(9);
    let reads = 0;
    // A name that repeats the first where it is written and follows it where it is compared.
    const second = { digest, get name() { return reads++ === 0 ? name(1) : name(2); } } as SnapshotDigest;
    expect(() => directoryRoot([{ name: name(1), digest }, second])).toThrow(new EncodingError("directory names must be strictly increasing"));
    expect(directoryRoot([{ name: name(1), digest }, { name: name(2), digest }])).toHaveLength(32);
  });
});

describe("the local reference venue", () => {
  const subject = new Uint8Array(32).fill(5), limits = { maxBytes: 1n << 20n, maxEntries: 100n };
  const read = (venue: FixtureVenue, kind: 1 | 2 | 3 | 4, about = subject) => {
    const request = { venue: venue.id, kind, subject: about, fromIndex: 0n, toIndex: venue.witnessedIndex() };
    return decodeRangeAnswer(venue.range(request, limits)!, request, limits).entries;
  };

  it("takes only records a §13 frame carries, so no record can leave a later answer unencodable", async () => {
    const venue = FixtureVenue.reference(new Uint8Array(32).fill(1), 0n);
    const lying = Object.defineProperty(new Uint8Array(33), "length", { value: 32 });
    const refused: [1 | 2 | 3 | 4, Uint8Array, Uint8Array][] = [[1, subject, new Uint8Array(135)], [3, subject, new Uint8Array(10)],
      [4, subject, new Uint8Array(MAX_RANGE_RECORD_BYTES[4] + 1)], [1, new Uint8Array(31), new Uint8Array(136)], [1, lying, new Uint8Array(136)]];
    for (const [kind, about, record] of refused) {
      await expect(venue.publishRecord(kind, about, record)).rejects.toThrow(new EncodingError("invalid fixture venue record"));
      expect(() => venue.witness(kind, about, 0n, record)).toThrow(new TypeError("invalid fixture venue record"));
    }
    await venue.publishRecord(1, subject, new Uint8Array(136).fill(1));
    expect(read(venue, 1)).toEqual([{ index: 1n, ordinal: 0n, record: new Uint8Array(136).fill(1) }]);
    expect(read(venue, 4)).toEqual([]);
  });

  it("orders kind 4 within an index across every kind and subject, rebuilds it from its data, and refuses an exhausted clock", async () => {
    const venue = new FixtureVenue(new Uint8Array(32).fill(2), 4n), other = new Uint8Array(32).fill(6);
    venue.witness(4, subject, 4n, Uint8Array.of(1));
    venue.witness(3, subject, 4n, new Uint8Array(96));
    venue.witness(4, other, 4n, Uint8Array.of(2));
    venue.witness(4, subject, 4n, Uint8Array.of(3));
    const expected = [{ index: 4n, ordinal: 0n, record: Uint8Array.of(1) }, { index: 4n, ordinal: 3n, record: Uint8Array.of(3) }];
    expect(read(venue, 4)).toEqual(expected);
    expect(read(FixtureVenue.from(venue.export()), 4)).toEqual(expected);
    expect(read(venue, 4, other)).toEqual([{ index: 4n, ordinal: 2n, record: Uint8Array.of(2) }]);
    const full = new FixtureVenue(new Uint8Array(32).fill(3), (1n << 64n) - 1n);
    await expect(full.publishRecord(1, subject, new Uint8Array(136))).rejects.toThrow(new VenueError("a fixture venue's clock is exhausted"));
  });
});
