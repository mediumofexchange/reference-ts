import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { EncodingError } from "../src/bytes.js";
import { EXHAUSTION_CIRCUITS, EXHAUSTION_SET_MANIFEST } from "../src/ergo-exhaustion-set.js";
import { CHECK_SET_MANIFEST, TRAIL_CIRCUITS } from "../src/pool/v3/check-set.js";
import {
  SET_CONTEXT, setBytes, shippedExhaustionSet, SUCCINCT_CIRCUITS, SUCCINCT_SET_MANIFEST, TEST_SET_CONTEXT, testSetIdentity, type SetManifest,
} from "../src/succinct-set.js";

// The set identity's frame (succinct-read §6) over the twelve circuits the package ships, and its sources.
const start = { id: sha256(Uint8Array.of(7)), height: 1_234_567n };
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const file = (path: string): string => hex(sha256(readFileSync(new URL(`../${path}`, import.meta.url))));
const identity = (manifest: SetManifest, at = start, context = SET_CONTEXT): string => hex(sha256(setBytes(manifest, at, context)));
/** The shipped manifest with one circuit's field replaced. */
const withCircuit = (name: typeof SUCCINCT_CIRCUITS[number], change: object): SetManifest =>
  ({ ...SUCCINCT_SET_MANIFEST, circuits: { ...SUCCINCT_SET_MANIFEST.circuits, [name]: { ...SUCCINCT_SET_MANIFEST.circuits[name], ...change } } });

describe("the succinct set's manifest and identity (succinct-read §6)", () => {
  it("pins every source file each circuit compiles from", () => {
    for (const name of TRAIL_CIRCUITS) expect(file(`scripts/pool/v3/trail-circuits/${name}.nr`)).toBe(CHECK_SET_MANIFEST.circuits[name].source);
    expect(file("scripts/pool/v3/trail-circuits/trail.nr")).toBe(CHECK_SET_MANIFEST.modules["trail.nr"]);
    for (const name of EXHAUSTION_CIRCUITS) expect(file(`src/exhaustion-circuits/${name}.nr`)).toBe(EXHAUSTION_SET_MANIFEST.circuits[name].source);
    for (const module of ["exhaustion.nr", "blake2b.nr"] as const) expect(file(`src/exhaustion-circuits/${module}`)).toBe(EXHAUSTION_SET_MANIFEST.modules[module]);
    const sponge = file("src/pool/circuits/vendor/poseidon2.nr");
    expect(CHECK_SET_MANIFEST.modules["poseidon2.nr"]).toBe(sponge);
    expect(EXHAUSTION_SET_MANIFEST.modules["poseidon2.nr"]).toBe(sponge);
    // Each circuit's sources by their path below its package's `src`: its own main.nr and its half's shared modules.
    expect(Object.keys(SUCCINCT_SET_MANIFEST.circuits)).toEqual([...SUCCINCT_CIRCUITS]);
    expect(Object.keys(SUCCINCT_SET_MANIFEST.circuits["trail-node"].sources).sort()).toEqual(["main.nr", "poseidon2.nr", "trail.nr"]);
    expect(Object.keys(SUCCINCT_SET_MANIFEST.circuits["fold-next"].sources).sort()).toEqual(["blake2b.nr", "exhaustion.nr", "main.nr", "poseidon2.nr"]);
    expect(SUCCINCT_SET_MANIFEST.circuits["exhaustion-tree"].bytecode).toBe(EXHAUSTION_SET_MANIFEST.circuits["leaf-m"].bytecode);
    expect(SUCCINCT_SET_MANIFEST.circuits["trail-settle"].vk).toBe(CHECK_SET_MANIFEST.circuits["leaf-settle"].vk);
    // One compiler: every shipped program names it, as the exhaustion half's native compiler does.
    const programs = JSON.parse(readFileSync(new URL("../src/pool/v3/check-set-programs.json", import.meta.url), "utf8")) as { [name: string]: { noir_version: string } };
    for (const name of TRAIL_CIRCUITS) expect(`noir ${programs[name]!.noir_version}`).toBe(SUCCINCT_SET_MANIFEST.compiler);
    expect(EXHAUSTION_SET_MANIFEST.compiler).toBe(SUCCINCT_SET_MANIFEST.compiler.replace("noir", "nargo"));
    expect(SUCCINCT_SET_MANIFEST.parameters).toEqual({ points: 4194304, g1: EXHAUSTION_SET_MANIFEST.parameters.g1,
      g2: "01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f" });
  });

  it("lays out §6's bytes: the context, twelve circuits in order, the toolchain, the parameters and the start", () => {
    const bytes = setBytes(SUCCINCT_SET_MANIFEST, start), m = SUCCINCT_SET_MANIFEST;
    let at = 0;
    const take = (n: number): Uint8Array => { const out = bytes.subarray(at, at + n); at += n; return out; };
    const u32 = (): number => new DataView(take(4).slice().buffer).getUint32(0);
    const text = (): string => Buffer.from(take(u32())).toString("ascii");
    expect(Buffer.from(take(19)).toString("ascii")).toBe("moe/succinct/v1/set");
    for (const name of SUCCINCT_CIRCUITS) {
      expect(text()).toBe(name);
      const c = m.circuits[name], n = u32(), paths = Object.keys(c.sources).sort();
      expect(n).toBe(paths.length);
      for (const path of paths) { expect(text()).toBe(path); expect(hex(take(32))).toBe(c.sources[path]); }
      expect(hex(take(32))).toBe(c.bytecode);
      expect(hex(take(32))).toBe(c.vk);
      expect(`0x${hex(take(32))}`).toBe(c.keyHash);
    }
    expect([text(), text(), text()]).toEqual([m.compiler, "@aztec/bb.js 5.2.0", "noir-recursive"]);
    expect(u32()).toBe(4194304);
    expect(hex(take(32))).toBe(m.parameters.g1);
    expect(hex(take(32))).toBe(m.parameters.g2);
    expect(take(32)).toEqual(start.id);
    expect(BigInt(u32())).toBe(start.height);
    expect(at).toBe(bytes.length);
  });

  it("changes with every field it holds, and not with the order sources are listed in", () => {
    const base = identity(SUCCINCT_SET_MANIFEST), seen = new Set([base]);
    const differs = (value: string) => { expect(seen.has(value)).toBe(false); seen.add(value); };
    const flip = (h: string) => `${h.slice(0, -1)}${h.endsWith("0") ? "1" : "0"}`;
    for (const name of SUCCINCT_CIRCUITS) {
      const c = SUCCINCT_SET_MANIFEST.circuits[name];
      differs(identity(withCircuit(name, { bytecode: flip(c.bytecode) })));
      differs(identity(withCircuit(name, { vk: flip(c.vk) })));
      differs(identity(withCircuit(name, { keyHash: flip(c.keyHash) })));
      differs(identity(withCircuit(name, { sources: { ...c.sources, "main.nr": flip(c.sources["main.nr"]!) } })));
    }
    // A source added or renamed, and the same sources listed in another order.
    const node = SUCCINCT_SET_MANIFEST.circuits["exhaustion-node"];
    differs(identity(withCircuit("exhaustion-node", { sources: { ...node.sources, "extra.nr": node.sources["main.nr"] } })));
    const { "blake2b.nr": blake, ...rest } = node.sources;
    differs(identity(withCircuit("exhaustion-node", { sources: { ...rest, "blake2c.nr": blake } })));
    expect(identity(withCircuit("exhaustion-node", { sources: Object.fromEntries(Object.entries(node.sources).reverse()) }))).toBe(base);
    for (const change of [{ compiler: "noir 1.0.0-beta.27" }, { backend: "@aztec/bb.js 5.2.1" }, { verifierTarget: "noir-rollup" },
      { parameters: { ...SUCCINCT_SET_MANIFEST.parameters, points: 2097152 } },
      { parameters: { ...SUCCINCT_SET_MANIFEST.parameters, g1: flip(SUCCINCT_SET_MANIFEST.parameters.g1) } },
      { parameters: { ...SUCCINCT_SET_MANIFEST.parameters, g2: flip(SUCCINCT_SET_MANIFEST.parameters.g2) } }]) {
      differs(identity({ ...SUCCINCT_SET_MANIFEST, ...change }));
    }
    differs(identity(SUCCINCT_SET_MANIFEST, { ...start, height: start.height + 1n }));
    differs(identity(SUCCINCT_SET_MANIFEST, { ...start, id: sha256(Uint8Array.of(8)) }));
    // A test identity never equals the adopted frame's over the same values.
    differs(identity(SUCCINCT_SET_MANIFEST, start, TEST_SET_CONTEXT));
    expect(hex(testSetIdentity(start))).toBe(identity(SUCCINCT_SET_MANIFEST, start, TEST_SET_CONTEXT));
  });

  it("holds the shipped test identity at a fixed start", () => {
    // A change to the frame, a circuit, a source or the toolchain moves this value (and every kept state named by it).
    expect(hex(testSetIdentity({ id: new Uint8Array(32), height: 0n }))).toBe("1edfd4f19c82b711190dcafdb2e6d754abd64c6566cd0a7fbe0f8438f7fdd8b2");
  });

  it("refuses a malformed start, hash, key hash or text, and a circuit without sources", () => {
    const refused = (manifest: SetManifest, at = start, message: string) =>
      expect(() => setBytes(manifest, at)).toThrow(new EncodingError(message));
    refused(SUCCINCT_SET_MANIFEST, { ...start, height: 1n << 32n }, "invalid exhaustion start");
    refused(SUCCINCT_SET_MANIFEST, { ...start, height: -1n }, "invalid exhaustion start");
    refused(SUCCINCT_SET_MANIFEST, { ...start, id: new Uint8Array(31) }, "invalid exhaustion start");
    refused(withCircuit("trail-burn", { vk: "AB".repeat(32) }), start, "trail-burn's key is not a SHA-256 in hex");
    refused(withCircuit("fold-first", { keyHash: "0x12" }), start, "fold-first's key hash is not a field element in hex");
    refused(withCircuit("fold-first", { sources: {} }), start, "fold-first has no source");
    refused(withCircuit("exhaustion-map", { sources: { "mäin.nr": "00".repeat(32) } }), start, "a source name of exhaustion-map is not ASCII text");
    refused({ ...SUCCINCT_SET_MANIFEST, compiler: "" }, start, "the compiler is not ASCII text");
    refused({ ...SUCCINCT_SET_MANIFEST, parameters: { ...SUCCINCT_SET_MANIFEST.parameters, points: 2 ** 32 } }, start, "invalid point count");
    const { "fold-next": _, ...eleven } = SUCCINCT_SET_MANIFEST.circuits;
    refused({ ...SUCCINCT_SET_MANIFEST, circuits: eleven as SetManifest["circuits"] }, start, "the manifest has no fold-next");
  });

  it("names the trail and exhaustion halves alike from one start", async () => {
    const set = shippedExhaustionSet(start, async () => { throw new Error("no backend here"); });
    expect(set.identity).toEqual(testSetIdentity(start));
    // The identity handed out is a copy.
    set.identity.fill(0);
    expect(set.identity).toEqual(testSetIdentity(start));
    await set.close();
  });
});
