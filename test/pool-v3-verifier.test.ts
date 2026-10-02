import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Barretenberg } from "@aztec/bb.js";
import { adoptedConfiguration, RELATION_KINDS, RELATIONS } from "../src/pool/v3/configuration.js";
import { proofVerifier } from "../src/pool/proof-verifier.js";
import { ProgramError } from "../src/pool/v3/programs.js";
import { openV3Verifier } from "../src/pool/v3/verifier.js";

vi.mock("../src/pool/proof-verifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pool/proof-verifier.js")>();
  return { ...actual, proofVerifier: vi.fn() };
});

/** A stand-in for the backend's verifier, deriving the configuration's identities except where `alter` changes them. */
function derived(alter: (identities: { [name: string]: { bytecode: Uint8Array; vk: Uint8Array; kind: number } }) => void) {
  const configuration = adoptedConfiguration(), identities = Object.fromEntries(RELATIONS.map(name =>
    [name, { ...configuration.circuits[name], kind: RELATION_KINDS[name] }]));
  alter(identities);
  const close = vi.fn(async () => {});
  vi.mocked(proofVerifier).mockResolvedValueOnce({ identities, verify: async () => true, parallel: 1, close });
  return close;
}
const api = {} as Barretenberg;

describe("the verifier over the package's shipped relations, pool-v3 §11.1", () => {
  it("returns the backend's verifier over the shipped relations when every derived key is the configuration's", async () => {
    const close = derived(() => {});
    const verifier = await openV3Verifier(api, { instances: 2 });
    expect(close).not.toHaveBeenCalled();
    const [, table, programs, options] = vi.mocked(proofVerifier).mock.calls.at(-1)!;
    expect(table.circuits.map(c => c.name)).toEqual([...RELATIONS]);
    expect(Object.keys(programs)).toEqual([...RELATIONS]);
    expect(options).toEqual({ instances: 2 });
    expect(verifier.parallel).toBe(1);
  });

  it("closes the verifier and refuses when the backend derives a key or bytecode that is not the configuration's", async () => {
    for (const [name, field] of [["spend", "vk"], ["request", "vk"], ["issue", "bytecode"]] as const) {
      const close = derived(identities => { const changed = Uint8Array.from(identities[name]![field]); changed[0]! ^= 1; identities[name]![field] = changed; });
      const refusal = await openV3Verifier(api).then(() => undefined, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(ProgramError);
      expect(refusal).toMatchObject({ code: "IDENTITY", message: `the ${name} key the backend derives is not the configuration's` });
      expect(close).toHaveBeenCalledTimes(1);
    }
    const close = derived(identities => { delete identities.settle; });
    await expect(openV3Verifier(api)).rejects.toMatchObject({ code: "IDENTITY", message: "the settle key the backend derives is not the configuration's" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("imports nothing from @noir-lang: a verify-only party loads only the backend", () => {
    const seen = new Set<string>(), bare = new Set<string>(), pending = [fileURLToPath(new URL("../src/pool/v3/verifier.ts", import.meta.url))];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const [, specifier] of readFileSync(file, "utf8").matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)) {
        if (specifier!.startsWith(".")) pending.push(resolve(dirname(file), specifier!).replace(/\.js$/, ".ts"));
        else bare.add(specifier!);
      }
    }
    expect(seen.size).toBeGreaterThan(3);
    expect([...bare].filter(name => name.startsWith("@noir-lang/"))).toEqual([]);
    expect(bare.has("@aztec/bb.js")).toBe(true);
  });
});
